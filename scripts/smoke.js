import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { P9Client } from '../src/client/p9Client.js';
import { IverywhereServer } from '../src/server/9pServer.js';
import { ServiceRegistry } from '../src/services/serviceRegistry.js';
import { readJson } from '../src/utils/json.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'iverywhere-smoke-'));

try {
  const config = await readJson(path.join(rootDir, 'config/default.json'));
  config.server = {
    ...config.server,
    transport: 'tcp',
    host: '127.0.0.1',
    port: 0,
    dataDir,
  };
  config.registry = new ServiceRegistry({ services: config.services, dataDir, rootDir });
  const server = new IverywhereServer({ config, rootDir });
  await server.start();

  const client = new P9Client();
  await client.connect({ host: '127.0.0.1', port: server.port });
  await client.version();
  await client.attach({ fid: 1, aname: 'operator' });

  await client.walk({ fid: 1, newfid: 2, names: ['svc'] });
  await client.walk({ fid: 2, newfid: 3, names: ['demo'] });
  await client.walk({ fid: 3, newfid: 4, names: ['config.draft'] });
  await client.open({ fid: 4, mode: 1 });
  await client.write({
    fid: 4,
    data: JSON.stringify({ greeting: 'smoke test', maxItems: 2, failHealth: false }),
  });
  await client.clunk({ fid: 4 });

  await client.walk({ fid: 3, newfid: 5, names: ['ctl'] });
  await client.open({ fid: 5, mode: 1 });
  await client.write({ fid: 5, data: JSON.stringify({ op: 'commit' }) });
  await client.clunk({ fid: 5 });

  await client.walk({ fid: 3, newfid: 6, names: ['status'] });
  await client.open({ fid: 6, mode: 0 });
  const statusBuffer = await client.read({ fid: 6 });
  await client.clunk({ fid: 6 });
  client.disconnect();
  await server.stop();

  const status = JSON.parse(statusBuffer.toString('utf8'));
  if (status.status !== 'healthy' || status.version !== 1) {
    throw new Error(`Unexpected smoke status: ${statusBuffer.toString('utf8')}`);
  }
  process.stdout.write(`${JSON.stringify({ ok: true, status }, null, 2)}\n`);
} finally {
  await rm(dataDir, { recursive: true, force: true });
}
