import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IverywhereServer } from '../src/server/9pServer.js';
import { ServiceRegistry } from '../src/services/serviceRegistry.js';
import { readJson } from '../src/utils/json.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function runCli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['bin/ivwh.js', ...args], {
      cwd: rootDir,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`ivwh timed out; stderr=${stderr}`));
    }, 10000);
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', (status, signal) => {
      clearTimeout(timer);
      resolve({ status, signal, stdout, stderr });
    });
  });
}

async function startServer() {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'iverywhere-cli-'));
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
    cleanup: async () => {
      await server.stop();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

test('ivwh CLI lists, updates, commits, snapshots and rolls back', async (t) => {
  const context = await startServer();
  t.after(context.cleanup);
  const base = ['--host', '127.0.0.1', '--port', String(context.server.port), '--mount', 'operator'];

  const listed = await runCli([...base, 'list']);
  assert.equal(listed.status, 0, listed.stderr);
  assert.match(listed.stdout, /demo/);

  const draftPath = path.join(context.server.config.server.dataDir, 'draft.json');
  await writeFile(draftPath, JSON.stringify({ greeting: 'cli-updated', maxItems: 2, failHealth: false }), 'utf8');
  const draft = await runCli([...base, 'set-draft', 'demo', draftPath]);
  assert.equal(draft.status, 0, draft.stderr);
  assert.match(draft.stdout, /draft updated/);

  const committed = await runCli([...base, 'commit', 'demo', '--expect-version', '0']);
  assert.equal(committed.status, 0, committed.stderr);
  assert.match(committed.stdout, /"op": "commit"/);
  assert.match(committed.stdout, /"version": 1/);

  const snapshot = await runCli([...base, 'snapshot', 'demo', 'cli-test']);
  assert.equal(snapshot.status, 0, snapshot.stderr);
  const snapshotResult = JSON.parse(snapshot.stdout);
  assert.equal(snapshotResult.meta.label, 'cli-test');
  assert.ok(snapshotResult.snapshot);

  const rolledBack = await runCli([...base, 'rollback', 'demo', snapshotResult.snapshot]);
  assert.equal(rolledBack.status, 0, rolledBack.stderr);
  assert.match(rolledBack.stdout, /"status": "healthy"/);

  const audit = await runCli([...base, 'audit']);
  assert.equal(audit.status, 0, audit.stderr);
  assert.match(audit.stdout, /commit/);
});

test('Bash wrapper exposes ivwh help', () => {
  const result = spawnSync('bash', ['bin/ivwh', 'help'], {
    cwd: rootDir,
    encoding: 'utf8',
    timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Commands:/);
  assert.match(result.stdout, /commit <service>/);
});
