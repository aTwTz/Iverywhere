import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { P9Client } from '../src/client/p9Client.js';
import { IverywhereServer } from '../src/server/9pServer.js';
import { ServiceRegistry } from '../src/services/serviceRegistry.js';
import { readJson } from '../src/utils/json.js';
import { createReader } from '../src/server/protocol.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function startTestServer() {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'iverywhere-server-'));
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
  return {
    server,
    dataDir,
    cleanup: async () => {
      await server.stop();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

test('9P client can attach, write draft, commit and read status', async (t) => {
  const context = await startTestServer();
  t.after(context.cleanup);
  const client = new P9Client();
  t.after(() => client.disconnect());
  await client.connect({ host: '127.0.0.1', port: context.server.port });
  await client.version();
  await client.attach({ fid: 1, aname: 'operator' });

  await client.walk({ fid: 1, newfid: 2, names: ['svc'] });
  await client.walk({ fid: 2, newfid: 3, names: ['demo'] });

  await client.walk({ fid: 3, newfid: 4, names: ['config.draft'] });
  await client.open({ fid: 4, mode: 1 });
  await client.write({
    fid: 4,
    data: JSON.stringify({ greeting: 'integration', maxItems: 4, failHealth: false }),
  });
  await client.clunk({ fid: 4 });

  await client.walk({ fid: 3, newfid: 5, names: ['ctl'] });
  await client.open({ fid: 5, mode: 1 });
  await client.write({ fid: 5, data: JSON.stringify({ op: 'commit' }) });
  await client.clunk({ fid: 5 });

  await client.walk({ fid: 3, newfid: 6, names: ['status'] });
  await client.open({ fid: 6, mode: 0 });
  const status = JSON.parse((await client.read({ fid: 6 })).toString('utf8'));
  assert.equal(status.status, 'healthy');
  assert.equal(status.version, 1);
  assert.equal(status.state.message, 'integration');
});

test('hidden service names are not visible through mount profile', async (t) => {
  const context = await startTestServer();
  t.after(context.cleanup);
  const client = new P9Client();
  t.after(() => client.disconnect());
  await client.connect({ host: '127.0.0.1', port: context.server.port });
  await client.version();
  await client.attach({ fid: 1, aname: 'operator' });
  await client.walk({ fid: 1, newfid: 2, names: ['svc'] });
  const directory = await client.read({ fid: 2 });
  assert.match(directory.toString('utf8'), /demo/);
  assert.doesNotMatch(directory.toString('utf8'), /hidden/);
});

test('unknown mount profile returns Rerror', async (t) => {
  const context = await startTestServer();
  t.after(context.cleanup);
  const client = new P9Client();
  t.after(() => client.disconnect());
  await client.connect({ host: '127.0.0.1', port: context.server.port });
  await client.version();
  await assert.rejects(
    () => client.attach({ fid: 1, aname: 'missing' }),
    /Unknown mount profile/,
  );
});

test('whole-file write rule rejects partial updates', async (t) => {
  const context = await startTestServer();
  t.after(context.cleanup);
  const client = new P9Client();
  t.after(() => client.disconnect());
  await client.connect({ host: '127.0.0.1', port: context.server.port });
  await client.version();
  await client.attach({ fid: 1, aname: 'operator' });
  await client.walk({ fid: 1, newfid: 2, names: ['svc', 'demo', 'config.draft'] });
  await client.open({ fid: 2, mode: 1 });
  await assert.rejects(
    () => client.write({ fid: 2, offset: 1, data: '{}' }),
    /offset 0/,
  );
});

test('unix socket transport accepts attach and directory walk', async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'iverywhere-unix-'));
  const socketPath = path.join(dataDir, 'iverywhere.sock');
  const config = await readJson(path.join(rootDir, 'config/default.json'));
  config.server = {
    ...config.server,
    transport: 'unix',
    unixSocket: socketPath,
    dataDir,
  };
  config.registry = new ServiceRegistry({ services: config.services, dataDir, rootDir });
  const server = new IverywhereServer({ config, rootDir });
  await server.start();
  t.after(async () => {
    await server.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  const client = new P9Client();
  t.after(() => client.disconnect());
  await client.connect({ path: socketPath });
  await client.version();
  await client.attach({ fid: 1, aname: 'operator' });
  await client.walk({ fid: 1, newfid: 2, names: ['svc'] });
  const directory = await client.read({ fid: 2 });
  assert.match(directory.toString('utf8'), /demo/);
});
