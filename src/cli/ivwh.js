import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { P9Client } from '../client/p9Client.js';
import { createReader, decodeStat } from '../server/protocol.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEFAULT_SOCKET = path.join(rootDir, 'run', 'iverywhere.sock');
const MAX_READ = 65536;
const READ_FID = 10;
const WRITE_FID = 11;

const COMMANDS = new Set([
  'help',
  'list',
  'audit',
  'status',
  'get',
  'set-draft',
  'commit',
  'snapshot',
  'rollback',
]);

export async function main(argv = process.argv.slice(2), io = process) {
  try {
    const options = parseArgs(argv);
    if (options.command === 'help') {
      io.stdout.write(buildUsage());
      return 0;
    }
    const output = await execute(options, io);
    if (output !== undefined && output !== '') io.stdout.write(output);
    return 0;
  } catch (error) {
    io.stderr.write(`ivwh: ${error.message}\n`);
    return 1;
  }
}

export function buildUsage() {
  return `Iverywhere control CLI

Usage:
  ivwh [global-options] <command> [arguments]

Global options:
  --socket <path>       Unix socket, default: ${DEFAULT_SOCKET}
  --host <host>         TCP host, default: 127.0.0.1
  --port <port>         TCP port, default: 5640
  --mount <profile>     9P mount profile, default: operator
  --user <name>         Attach user, default: $USER or local

Commands:
  list                         List visible services
  status <service>             Show service status
  get <service> <target>       Read status/config/draft/ctl
  set-draft <service> [file]   Replace config draft; use '-' or omit file for stdin
  commit <service>             Commit draft transactionally
  snapshot <service> [label]   Create a named snapshot
  rollback <service> <snap>    Restore a snapshot
  audit                        Read server audit log
  help                         Show this help

Examples:
  ivwh list
  ivwh status demo
  ivwh get demo config
  ivwh set-draft demo ./demo.json
  ivwh commit demo --expect-version 1
  ivwh snapshot demo before-change
`;
}

function parseArgs(argv) {
  const options = {
    socket: process.env.IVWH_SOCKET || DEFAULT_SOCKET,
    host: process.env.IVWH_HOST,
    port: process.env.IVWH_PORT ? Number(process.env.IVWH_PORT) : undefined,
    mount: process.env.IVWH_MOUNT || 'operator',
    user: process.env.USER || 'local',
    command: '',
    args: [],
  };

  let index = 0;
  while (index < argv.length && argv[index].startsWith('--')) {
    const [flag, inlineValue] = splitOption(argv[index]);
    const readValue = () => {
      if (inlineValue !== undefined) return inlineValue;
      index += 1;
      if (index >= argv.length) throw new Error(`${flag} requires a value`);
      return argv[index];
    };

    if (flag === '--help') {
      options.command = 'help';
      return options;
    }
    if (flag === '--socket') options.socket = readValue();
    else if (flag === '--host') options.host = readValue();
    else if (flag === '--port') options.port = Number(readValue());
    else if (flag === '--mount') options.mount = readValue();
    else if (flag === '--user') options.user = readValue();
    else throw new Error(`Unknown global option: ${flag}`);
    index += 1;
  }

  options.command = argv[index] ?? 'help';
  options.args = argv.slice(index + 1);
  if (!COMMANDS.has(options.command)) throw new Error(`Unknown command: ${options.command}`);
  if (options.port !== undefined && (!Number.isInteger(options.port) || options.port <= 0 || options.port > 65535)) {
    throw new Error(`Invalid TCP port: ${options.port}`);
  }
  return options;
}

async function execute(options, io) {
  const client = new P9Client();
  const connectOptions = options.host || options.port
    ? { host: options.host ?? '127.0.0.1', port: options.port ?? 5640 }
    : { path: options.socket };
  await client.connect(connectOptions);
  try {
    await client.version();
    await client.attach({ fid: 1, aname: options.mount, uname: options.user });
    switch (options.command) {
      case 'list':
        return (await listDirectory(client, '/svc')).join('\n') + '\n';
      case 'audit':
        return (await readPath(client, '/audit')).toString('utf8');
      case 'status':
        return await readJsonPath(client, buildServicePath(requireService(options), 'status'));
      case 'get':
        return await readJsonPath(client, buildServicePath(requireService(options), requireTarget(options)));
      case 'set-draft':
        return await setDraft(client, options, io);
      case 'commit':
        return await commit(client, options);
      case 'snapshot':
        return await snapshot(client, options);
      case 'rollback':
        return await rollback(client, options);
      default:
        throw new Error(`Unsupported command: ${options.command}`);
    }
  } finally {
    client.disconnect();
  }
}

async function setDraft(client, options, io) {
  const service = requireService(options);
  const [, file] = options.args;
  const source = file === undefined || file === '-'
    ? readFileSync(0, 'utf8')
    : readFileSync(file, 'utf8');
  const written = await writePath(client, buildServicePath(service, 'config.draft'), Buffer.from(source, 'utf8'));
  return `draft updated: service=${service} bytes=${written}\n`;
}

async function commit(client, options) {
  const service = requireService(options);
  const command = { op: 'commit' };
  const expectVersion = getOptionValue(options.args, '--expect-version');
  if (expectVersion !== undefined) command.expectVersion = Number(expectVersion);
  if (!Number.isInteger(command.expectVersion ?? 0)) throw new Error('--expect-version must be an integer');
  await writePath(client, buildServicePath(service, 'ctl'), Buffer.from(JSON.stringify(command), 'utf8'));
  const status = JSON.parse((await readPath(client, buildServicePath(service, 'status'))).toString('utf8'));
  return JSON.stringify({ ok: true, op: 'commit', service, status }, null, 2) + '\n';
}

async function snapshot(client, options) {
  const service = requireService(options);
  const [, label = 'manual'] = options.args;
  assertPlainName(label, 'label');
  const before = new Set(await listDirectory(client, `/svc/${service}/snapshot`));
  await writePath(client, buildServicePath(service, 'ctl'), Buffer.from(JSON.stringify({ op: 'snapshot', label }), 'utf8'));
  const after = await listDirectory(client, `/svc/${service}/snapshot`);
  const created = after.filter((name) => !before.has(name));
  const snapshot = created.at(-1) ?? after.at(-1);
  if (!snapshot) throw new Error(`Snapshot created but not visible for ${service}`);
  const meta = JSON.parse((await readPath(client, `/svc/${service}/snapshot/${snapshot}/meta`)).toString('utf8'));
  return JSON.stringify({ ok: true, op: 'snapshot', service, snapshot, meta }, null, 2) + '\n';
}

async function rollback(client, options) {
  const service = requireService(options);
  const snapshot = options.args[1];
  if (!snapshot) throw new Error('rollback requires snapshot id');
  assertPlainName(snapshot, 'snapshot');
  await writePath(client, buildServicePath(service, 'ctl'), Buffer.from(JSON.stringify({ op: 'rollback', snapshot }), 'utf8'));
  const status = JSON.parse((await readPath(client, buildServicePath(service, 'status'))).toString('utf8'));
  return JSON.stringify({ ok: true, op: 'rollback', service, snapshot, status }, null, 2) + '\n';
}

async function readJsonPath(client, pathName) {
  const text = (await readPath(client, pathName)).toString('utf8');
  try {
    return JSON.stringify(JSON.parse(text), null, 2) + '\n';
  } catch {
    return `${text}\n`;
  }
}

async function readPath(client, pathName) {
  const fid = READ_FID;
  await client.walk({ fid: 1, newfid: fid, names: splitPath(pathName) });
  try {
    await client.open({ fid, mode: 0 });
    return await client.read({ fid, offset: 0, count: MAX_READ });
  } finally {
    await client.clunk({ fid });
  }
}

async function writePath(client, pathName, data) {
  const fid = WRITE_FID;
  await client.walk({ fid: 1, newfid: fid, names: splitPath(pathName) });
  try {
    await client.open({ fid, mode: 1 });
    return await client.write({ fid, offset: 0, data });
  } finally {
    await client.clunk({ fid });
  }
}

async function listDirectory(client, pathName) {
  const data = await readPath(client, pathName);
  const reader = createReader(data);
  const names = [];
  while (reader.remaining() > 0) names.push(decodeStat(reader).name);
  return names;
}

function buildServicePath(service, target) {
  assertPlainName(service, 'service');
  assertPlainName(target, 'target');
  return `/svc/${service}/${target}`;
}

function requireService(options) {
  const service = options.args[0];
  if (!service) throw new Error(`${options.command} requires service`);
  assertPlainName(service, 'service');
  return service;
}

function requireTarget(options) {
  const target = options.args[1] ?? 'status';
  const normalized = { draft: 'config.draft' }[target] ?? target;
  if (!['status', 'config', 'config.draft', 'ctl'].includes(normalized)) {
    throw new Error(`target must be one of status/config/draft/ctl, got ${target}`);
  }
  return normalized;
}

function splitPath(pathName) {
  return pathName.split('/').filter(Boolean);
}

function assertPlainName(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128 || /[/\\\0]/.test(value)) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
}

function splitOption(argument) {
  const equals = argument.indexOf('=');
  if (equals === -1) return [argument, undefined];
  return [argument.slice(0, equals), argument.slice(equals + 1)];
}

function getOptionValue(args, flag) {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  if (index + 1 >= args.length) throw new Error(`${flag} requires a value`);
  return args[index + 1];
}
