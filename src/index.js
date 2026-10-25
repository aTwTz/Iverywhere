import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson } from './utils/json.js';
import { ServiceRegistry } from './services/serviceRegistry.js';
import { IverywhereServer } from './server/9pServer.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const defaultConfig = existsSync(path.join(rootDir, 'config/server.json'))
    ? 'config/server.json'
    : 'config/default.json';
  const configPath = path.resolve(rootDir, args.config ?? defaultConfig);
  const config = await readJson(configPath);
  config.server = {
    ...config.server,
    ...(args.transport ? { transport: args.transport } : {}),
    ...(args.host ? { host: args.host } : {}),
    ...(args.port ? { port: Number(args.port) } : {}),
    ...(args.socket ? { unixSocket: args.socket } : {}),
  };
  config.server.dataDir = path.resolve(rootDir, args.dataDir ?? config.server.dataDir ?? './data');
  config.registry = new ServiceRegistry({
    services: config.services ?? {},
    dataDir: config.server.dataDir,
    rootDir,
  });

  const server = new IverywhereServer({ config, rootDir });
  await server.start();
  process.stdout.write(`Iverywhere 9P server listening at ${server.address}\n`);

  const shutdown = async () => {
    await server.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === '--config') args.config = argv[++index];
    else if (key === '--transport') args.transport = argv[++index];
    else if (key === '--host') args.host = argv[++index];
    else if (key === '--port') args.port = argv[++index];
    else if (key === '--socket') args.socket = argv[++index];
    else if (key === '--data-dir') args.dataDir = argv[++index];
    else throw new Error(`Unknown argument: ${key}`);
  }
  return args;
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exit(1);
});
