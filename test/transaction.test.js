import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Journal } from '../src/tx/journal.js';
import { SnapshotStore } from '../src/tx/snapshotStore.js';
import { TransactionManager } from '../src/tx/transactionManager.js';
import { ServiceRegistry } from '../src/services/serviceRegistry.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function setup(config = {}, { scriptSha256, retentionLimit } = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'iverywhere-tx-'));
  const registry = new ServiceRegistry({
    dataDir,
    rootDir,
    services: {
      demo: {
        adapter: 'js',
        runtime: {
          mode: 'module',
          script: 'test/fixtures/module-service.js',
          ...(scriptSha256 ? { scriptSha256 } : {}),
          timeoutMs: 500,
        },
        initialConfig: {
          greeting: 'initial',
          failHealth: false,
          ...config,
        },
      },
    },
  });
  await registry.init();
  const journal = new Journal({ dataDir });
  const snapshots = new SnapshotStore({ dataDir, retentionLimit });
  const transactions = new TransactionManager({ registry, journal, snapshots });
  return {
    dataDir,
    registry,
    snapshots,
    transactions,
    cleanup: () => rm(dataDir, { recursive: true, force: true }),
  };
}

test('commit applies draft and creates before snapshot', async () => {
  const context = await setup();
  try {
    await context.registry.setDraft('demo', { greeting: 'updated', failHealth: false });
    const result = await context.transactions.execute('demo', { op: 'commit' }, { user: 'tester' });

    assert.equal(result.ok, true);
    assert.equal(result.version, 1);
    assert.match(result.beforeSnapshot, /^[a-z0-9-]+$/);
    assert.equal(context.registry.getConfig('demo').greeting, 'updated');
    assert.equal(context.registry.getStatus('demo').status, 'healthy');

    const snapshots = await context.snapshots.list('demo');
    assert.equal(snapshots.length, 1);
    assert.equal(snapshots[0].config.greeting, 'initial');
  } finally {
    await context.cleanup();
  }
});

test('failed health check rolls configuration back', async () => {
  const context = await setup();
  try {
    await context.registry.setDraft('demo', { greeting: 'broken', failHealth: true });
    await assert.rejects(
      () => context.transactions.execute('demo', { op: 'commit' }),
      /health failed by fixture config/,
    );

    const service = context.registry.get('demo');
    assert.equal(service.config.greeting, 'initial');
    assert.equal(service.draft.greeting, 'initial');
    assert.equal(service.health.ok, true);
    assert.match(service.lastError, /health failed by fixture config/);
  } finally {
    await context.cleanup();
  }
});

test('rollback restores named snapshot', async () => {
  const context = await setup();
  try {
    await context.registry.setDraft('demo', { greeting: 'version-1', failHealth: false });
    const first = await context.transactions.execute('demo', { op: 'commit' });

    await context.registry.setDraft('demo', { greeting: 'version-2', failHealth: false });
    await context.transactions.execute('demo', { op: 'commit' });
    assert.equal(context.registry.getConfig('demo').greeting, 'version-2');

    const restored = await context.transactions.execute('demo', {
      op: 'rollback',
      snapshot: first.beforeSnapshot,
    });
    assert.equal(restored.ok, true);
    assert.equal(context.registry.getConfig('demo').greeting, 'initial');
    assert.equal(context.registry.getStatus('demo').status, 'healthy');
  } finally {
    await context.cleanup();
  }
});

test('snapshot_withExcessOverRetentionLimit_evictsOldestWithAudit', async () => {
  const context = await setup({}, { retentionLimit: 2 });
  try {
    const oldest = await context.transactions.execute('demo', { op: 'snapshot', label: 'oldest' });
    await delay(5);
    await context.transactions.execute('demo', { op: 'snapshot', label: 'middle' });
    await delay(5);
    await context.transactions.execute('demo', { op: 'snapshot', label: 'newest' });

    const remaining = await context.snapshots.list('demo');
    assert.equal(remaining.length, 2);
    assert.deepEqual(remaining.map((record) => record.label), ['middle', 'newest']);
    assert.equal(await context.snapshots.get('demo', oldest.snapshot), undefined);

    const journalText = await readFile(path.join(context.dataDir, 'journal.jsonl'), 'utf8');
    const entries = journalText.trim().split('\n').map((line) => JSON.parse(line));
    const evicted = entries.find((entry) => entry.event === 'snapshot_evicted');
    assert.ok(evicted, 'snapshot_evicted journal entry must exist');
    assert.equal(evicted.snapshot, oldest.snapshot);
    assert.equal(evicted.reason, 'retention_limit');
  } finally {
    await context.cleanup();
  }
});

test('enforceRetention_withProtectedInFlightSnapshot_skipsItAndEvictsNextOldest', async () => {
  const context = await setup({}, { retentionLimit: 2 });
  try {
    const oldest = await context.snapshots.save('demo', { createdAt: '2026-01-01T00:00:00.000Z', label: 'oldest' });
    const middle = await context.snapshots.save('demo', { createdAt: '2026-01-01T00:00:01.000Z', label: 'middle' });
    const newest = await context.snapshots.save('demo', { createdAt: '2026-01-01T00:00:02.000Z', label: 'newest' });

    const { evicted, failures } = await context.snapshots.enforceRetention('demo', {
      protectedIds: new Set([oldest.id]),
    });

    assert.equal(failures.length, 0);
    assert.deepEqual(evicted.map((record) => record.id), [middle.id]);
    const remaining = await context.snapshots.list('demo');
    assert.deepEqual(remaining.map((record) => record.id), [oldest.id, newest.id]);
  } finally {
    await context.cleanup();
  }
});

test('commit_withRetentionLimit_keepsPinnedBeforeImageAndEvictsOlderSnapshot', async () => {
  const context = await setup({}, { retentionLimit: 1 });
  try {
    const manual = await context.transactions.execute('demo', { op: 'snapshot', label: 'manual' });
    await context.registry.setDraft('demo', { greeting: 'updated', failHealth: false });
    const result = await context.transactions.execute('demo', { op: 'commit' });

    assert.equal(result.ok, true);
    assert.equal(await context.snapshots.get('demo', manual.snapshot), undefined);
    const before = await context.snapshots.get('demo', result.beforeSnapshot);
    assert.ok(before, 'pinned before-image must survive retention');
    assert.equal(before.config.greeting, 'initial');
  } finally {
    await context.cleanup();
  }
});

test('rollback_withEvictedSnapshot_rejectsWithExplicitNotFoundError', async () => {
  const context = await setup({}, { retentionLimit: 1 });
  try {
    const stale = await context.transactions.execute('demo', { op: 'snapshot', label: 'stale' });
    await delay(5);
    await context.transactions.execute('demo', { op: 'snapshot', label: 'fresh' });

    await assert.rejects(
      () => context.transactions.execute('demo', { op: 'rollback', snapshot: stale.snapshot }),
      new RegExp(`Snapshot not found for demo: ${stale.snapshot}`),
    );
  } finally {
    await context.cleanup();
  }
});

test('unknown op is rejected', async () => {
  const context = await setup();
  try {
    await assert.rejects(
      () => context.transactions.execute('demo', { op: 'exec' }),
      /Unsupported ctl op/,
    );
  } finally {
    await context.cleanup();
  }
});

function stubTx({ validateDelayMs = 0, applyDelayMs = 0, applyMutates = true, txOptions = {} } = {}) {
  const events = [];
  const state = { config: { greeting: 'initial' }, version: 0 };
  let applyCalls = 0;
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const registry = {
    get: () => ({ version: state.version, config: state.config }),
    getDraft: () => ({ greeting: 'updated' }),
    validate: async () => {
      if (validateDelayMs > 0) await delay(validateDelayMs);
      return { ok: true };
    },
    snapshotRecord: () => ({ version: state.version, config: { ...state.config }, state: {} }),
    apply: async (serviceId, config) => {
      applyCalls += 1;
      const isSlowFirstCall = applyCalls === 1 && applyDelayMs > 0;
      if (isSlowFirstCall) await delay(applyDelayMs);
      if (!isSlowFirstCall || applyMutates) {
        state.config = { ...config };
        state.version += 1;
      }
    },
    checkHealth: async () => ({ ok: true }),
    markFailure: async () => undefined,
  };
  const journal = {
    append: async (event) => {
      events.push(event);
    },
  };
  const snapshots = {
    save: async () => ({ id: 'snap-1' }),
    get: async () => null,
    list: async () => [],
    enforceRetention: async () => ({ evicted: [], failures: [] }),
  };
  const transactions = new TransactionManager({ registry, journal, snapshots, ...txOptions });
  return { events, state, transactions };
}

test('commit exceeding overall deadline replays before image', async () => {
  const { events, state, transactions } = stubTx({ applyDelayMs: 200, applyMutates: false, txOptions: { deadlineMs: 30 } });

  await assert.rejects(
    () => transactions.execute('demo', { op: 'commit' }),
    /ctl deadline 30ms exceeded during apply/,
  );

  assert.equal(state.config.greeting, 'initial');
  const rolledBack = events.find((event) => event.event === 'commit_rolled_back');
  assert.ok(rolledBack, 'commit_rolled_back journal entry must exist');
  assert.match(rolledBack.originalError, /ctl deadline/);
});

test('deadline during validate fails before commit_begin', async () => {
  const { events, transactions } = stubTx({ validateDelayMs: 200, txOptions: { deadlineMs: 30 } });

  await assert.rejects(
    () => transactions.execute('demo', { op: 'commit' }),
    /ctl deadline 30ms exceeded during validate/,
  );

  assert.equal(events.some((event) => event.event === 'commit_begin'), false);
  assert.equal(events.some((event) => event.event === 'commit_rolled_back'), false);
});

test('queued command beyond wait limit is rejected with explicit error', async () => {
  const { state, transactions } = stubTx({ applyDelayMs: 150, txOptions: { deadlineMs: 0, queueWaitMs: 30 } });

  const first = transactions.execute('demo', { op: 'commit' });
  await assert.rejects(
    () => transactions.execute('demo', { op: 'snapshot' }),
    /queue wait exceeded limit of 30ms/,
  );

  const result = await first;
  assert.equal(result.ok, true);
  assert.equal(state.config.greeting, 'updated');
});

test('commit_withMatchingScriptHash_appliesDraft', async () => {
  const scriptContent = await readFile(path.join(rootDir, 'test/fixtures/module-service.js'));
  const scriptSha256 = createHash('sha256').update(scriptContent).digest('hex');
  const context = await setup({}, { scriptSha256 });
  try {
    await context.registry.setDraft('demo', { greeting: 'pinned', failHealth: false });
    const result = await context.transactions.execute('demo', { op: 'commit' }, { user: 'tester' });

    assert.equal(result.ok, true);
    assert.equal(context.registry.getConfig('demo').greeting, 'pinned');
    assert.equal(context.registry.getStatus('demo').status, 'healthy');
  } finally {
    await context.cleanup();
  }
});

// NOTE: rollback 失败路径夹具：apply 按配置内容区分目标快照与 before-image 回放，便于分别注入失败。
// NOTE(en): Fixture for rollback failure paths: apply distinguishes the target snapshot from the before-image replay by config content so failures can be injected separately.
function stubRollbackTx({ failReplayApply = false, failReplayHealth = false } = {}) {
  const events = [];
  const failureMarks = [];
  const state = { config: { greeting: 'current' }, version: 3 };
  const targetRecord = { id: 'snap-target', version: 1, config: { greeting: 'target' }, state: {} };
  const registry = {
    get: () => ({ version: state.version, config: state.config }),
    snapshotRecord: () => ({ version: state.version, config: { ...state.config }, state: {} }),
    apply: async (serviceId, config) => {
      if (config.greeting === 'target') throw new Error('apply target config failed');
      if (failReplayApply) throw new Error('replay before-image failed');
      state.config = { ...config };
      state.version += 1;
    },
    checkHealth: async () => {
      if (failReplayHealth) throw new Error('health after replay failed');
      return { ok: true };
    },
    markFailure: async (serviceId, error, options) => {
      failureMarks.push({ error: error.message, options });
    },
  };
  const journal = {
    append: async (event) => {
      events.push(event);
    },
  };
  const snapshots = {
    get: async () => targetRecord,
  };
  const transactions = new TransactionManager({ registry, journal, snapshots });
  return { events, failureMarks, state, targetRecord, transactions };
}

test('rollback_withFailingTargetApply_replaysBeforeImageAndMarksRecovered', async () => {
  const { events, failureMarks, state, targetRecord, transactions } = stubRollbackTx();

  await assert.rejects(
    () => transactions.execute('demo', { op: 'rollback', snapshot: targetRecord.id }),
    /apply target config failed/,
  );

  assert.equal(state.config.greeting, 'current');
  assert.equal(failureMarks.length, 1);
  assert.deepEqual(failureMarks[0].options, { preserveHealth: true });

  const restored = events.find((event) => event.event === 'rollback_restored');
  assert.ok(restored, 'rollback_restored journal entry must exist');
  assert.equal(restored.targetSnapshot, targetRecord.id);
  assert.equal(restored.restoredVersion, state.version);
  assert.match(restored.originalError, /apply target config failed/);
  assert.equal(events.some((event) => event.event === 'rollback_failed'), false);
});

test('rollback_withFailingReplayHealth_throwsDoubleErrorAndMarksFailure', async () => {
  const { events, failureMarks, state, targetRecord, transactions } = stubRollbackTx({ failReplayHealth: true });

  await assert.rejects(
    () => transactions.execute('demo', { op: 'rollback', snapshot: targetRecord.id }),
    /Rollback failed and before-image replay also failed: health after replay failed; original error: apply target config failed/,
  );

  assert.equal(state.config.greeting, 'current');
  assert.equal(failureMarks.length, 1);
  assert.equal(failureMarks[0].options, undefined);

  const failed = events.find((event) => event.event === 'rollback_failed');
  assert.ok(failed, 'rollback_failed journal entry must exist');
  assert.equal(events.some((event) => event.event === 'rollback_restored'), false);
  assert.match(failed.originalError, /apply target config failed/);
  assert.match(failed.rollbackError, /health after replay failed/);
});

test('commit_withMismatchingScriptHash_rejectsServiceAndAudits', async () => {
  const context = await setup({}, { scriptSha256: '0'.repeat(64) });
  try {
    const status = context.registry.getStatus('demo');
    assert.equal(status.status, 'script_rejected');
    assert.match(status.lastError, /script integrity check failed/);
    assert.equal(status.health.ok, false);

    await context.registry.setDraft('demo', { greeting: 'pinned', failHealth: false });
    await assert.rejects(
      () => context.transactions.execute('demo', { op: 'commit' }),
      /script integrity check failed/,
    );
    assert.equal(context.registry.getConfig('demo').greeting, 'initial');

    const auditText = await readFile(path.join(context.dataDir, 'audit.jsonl'), 'utf8');
    const entries = auditText.trim().split('\n').map((line) => JSON.parse(line));
    const rejection = entries.find((entry) => entry.op === 'script_integrity_rejected');
    assert.ok(rejection, 'script_integrity_rejected audit entry must exist');
    assert.equal(rejection.service, 'demo');
    assert.equal(JSON.stringify(rejection).includes('module-service.js'), false);
  } finally {
    await context.cleanup();
  }
});
