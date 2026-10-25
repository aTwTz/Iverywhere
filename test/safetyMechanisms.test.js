import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Policy } from '../src/security/policy.js';
import { Journal } from '../src/tx/journal.js';
import { SnapshotStore } from '../src/tx/snapshotStore.js';
import { TransactionManager } from '../src/tx/transactionManager.js';
import { ServiceRegistry } from '../src/services/serviceRegistry.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('assertWriteFile_withinBurst_allowsWrites', () => {
  const policy = new Policy({ mounts: { limited: { rateLimit: { writesPerSecond: 5, burst: 2 } } } });
  const session = policy.attach('limited');

  policy.assertWriteFile(session, 16);
  policy.assertWriteFile(session, 16);
  assert.equal(session.tokens, 0);
});

async function setupRegistry({ definition } = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'iverywhere-safety-'));
  const registry = new ServiceRegistry({
    dataDir,
    rootDir,
    services: {
      demo: {
        adapter: 'js',
        runtime: {
          mode: 'module',
          script: 'test/fixtures/module-service.js',
          timeoutMs: 500,
        },
        circuit: { failureThreshold: 2, cooldownMs: 40 },
        initialConfig: { greeting: 'initial', failHealth: false },
        ...definition,
      },
    },
  });
  await registry.init();
  return { dataDir, registry, cleanup: () => rm(dataDir, { recursive: true, force: true }) };
}

test('assertWriteFile_beyondBurst_rejectsWithRateLimit', () => {
  const policy = new Policy({ mounts: { limited: { rateLimit: { writesPerSecond: 1, burst: 1 } } } });
  const session = policy.attach('limited');

  policy.assertWriteFile(session, 16);
  assert.throws(() => policy.assertWriteFile(session, 16), /Write rejected by rate limit/);
});

test('assertWriteFile_afterRefillWindow_allowsAgain', async () => {
  const policy = new Policy({ mounts: { limited: { rateLimit: { writesPerSecond: 1000, burst: 1 } } } });
  const session = policy.attach('limited');

  policy.assertWriteFile(session, 16);
  assert.throws(() => policy.assertWriteFile(session, 16), /rate limit/);

  await sleep(5);
  assert.doesNotThrow(() => policy.assertWriteFile(session, 16));
});

test('markFailure_reachingThreshold_opensCircuit', async () => {
  const { registry, cleanup } = await setupRegistry();
  try {
    await registry.markFailure('demo', new Error('boom-1'));
    assert.equal(registry.getStatus('demo').status, 'unhealthy');

    await registry.markFailure('demo', new Error('boom-2'));
    const service = registry.get('demo');
    assert.equal(service.status, 'circuit_open');
    assert.ok(service.circuitOpenUntil > Date.now());
  } finally {
    await cleanup();
  }
});

test('apply_whileCircuitOpen_rejectsFastWithoutRuntime', async () => {
  const { registry, cleanup } = await setupRegistry();
  try {
    await registry.markFailure('demo', new Error('boom-1'));
    await registry.markFailure('demo', new Error('boom-2'));

    await assert.rejects(() => registry.apply('demo', { greeting: 'x', failHealth: false }), /circuit is open/);
    const service = registry.get('demo');
    assert.equal(service.version, 0);
    assert.equal(service.status, 'circuit_open');
  } finally {
    await cleanup();
  }
});

test('circuit_afterCooldown_halfOpenAllowsTraffic', async () => {
  const { registry, cleanup } = await setupRegistry();
  try {
    await registry.markFailure('demo', new Error('boom-1'));
    await registry.markFailure('demo', new Error('boom-2'));

    await sleep(60);
    await registry.apply('demo', { greeting: 'recovered', failHealth: false });
    const service = registry.get('demo');
    assert.equal(service.status, 'applied');
    assert.equal(service.circuitFailures, 0);
    assert.equal(service.circuitOpenUntil, 0);
  } finally {
    await cleanup();
  }
});

test('circuit_afterSuccessfulHealth_closesAndClearsFailures', async () => {
  const { registry, cleanup } = await setupRegistry();
  try {
    await registry.markFailure('demo', new Error('boom-1'));
    await registry.markFailure('demo', new Error('boom-2'));
    await sleep(60);

    const health = await registry.checkHealth('demo');
    assert.equal(health.ok, true);
    const service = registry.get('demo');
    assert.equal(service.status, 'healthy');
    assert.equal(service.circuitFailures, 0);
    assert.equal(service.lastError, null);
  } finally {
    await cleanup();
  }
});

async function readJournalEvents(dataDir) {
  const raw = await readFile(path.join(dataDir, 'journal.jsonl'), 'utf8');
  return raw.split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

test('commit_withHangingWorker_timesOutAndReplaysBeforeImage', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'iverywhere-safety-worker-'));
  try {
    const registry = new ServiceRegistry({
      dataDir,
      rootDir,
      services: {
        demo: {
          adapter: 'js',
          runtime: {
            mode: 'worker',
            script: 'test/fixtures/hanging-worker.js',
            timeoutMs: 150,
          },
          initialConfig: { greeting: 'initial', hang: false },
        },
      },
    });
    await registry.init();
    const journal = new Journal({ dataDir });
    const snapshots = new SnapshotStore({ dataDir });
    const transactions = new TransactionManager({ registry, journal, snapshots });

    await registry.setDraft('demo', { greeting: 'updated', hang: true });
    await assert.rejects(
      () => transactions.execute('demo', { op: 'commit' }),
      /timed out after 150ms/,
    );

    const service = registry.get('demo');
    assert.equal(service.config.greeting, 'initial');
    assert.equal(service.health.ok, true);

    const events = await readJournalEvents(dataDir);
    const rolledBack = events.find((event) => event.event === 'commit_rolled_back');
    assert.ok(rolledBack, 'commit_rolled_back journal entry must exist');
    assert.match(rolledBack.originalError, /timed out after 150ms/);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
