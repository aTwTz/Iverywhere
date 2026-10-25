import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AuditLog } from '../src/audit/auditLog.js';
import { Policy } from '../src/security/policy.js';
import { Journal } from '../src/tx/journal.js';
import { SnapshotStore } from '../src/tx/snapshotStore.js';
import { TransactionManager } from '../src/tx/transactionManager.js';
import { ServiceRegistry } from '../src/services/serviceRegistry.js';
import { VirtualFileSystem } from '../src/vfs/virtualFileSystem.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function setup() {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'iverywhere-vfs-'));
  const registry = new ServiceRegistry({
    dataDir,
    rootDir,
    services: {
      demo: {
        adapter: 'js',
        runtime: { mode: 'module', script: 'test/fixtures/module-service.js', timeoutMs: 500 },
        initialConfig: { greeting: 'initial', failHealth: false },
      },
      hidden: {
        adapter: 'js',
        runtime: { mode: 'module', script: 'test/fixtures/module-service.js', timeoutMs: 500 },
        initialConfig: { greeting: 'hidden', failHealth: false },
      },
    },
  });
  await registry.init();
  const policy = new Policy({
    defaultMount: 'operator',
    mounts: {
      operator: { services: ['demo'], allowWrite: true, maxWriteBytes: 4096 },
      readonly: { services: ['demo'], allowWrite: false },
    },
  });
  const audit = new AuditLog({ dataDir });
  const snapshots = new SnapshotStore({ dataDir });
  const transactions = new TransactionManager({
    registry,
    snapshots,
    journal: new Journal({ dataDir }),
  });
  const vfs = new VirtualFileSystem({ registry, transactions, snapshots, audit, policy });
  return {
    dataDir,
    registry,
    vfs,
    audit,
    policy,
    transactions,
    snapshots,
    cleanup: () => rm(dataDir, { recursive: true, force: true }),
  };
}

test('mount profile only exposes authorized services', async () => {
  const context = await setup();
  try {
    const session = context.policy.attach('operator');
    const services = await context.vfs.list(context.vfs.nodes.get('/svc'), session);
    assert.deepEqual(services.map((node) => node.name), ['demo']);
    await assert.rejects(
      () => context.vfs.lookup('/svc/hidden/status', session),
      /Path not found/,
    );
  } finally {
    await context.cleanup();
  }
});

test('draft and ctl writes update state transactionally', async () => {
  const context = await setup();
  try {
    const session = context.policy.attach('operator');
    const draft = await context.vfs.lookup('/svc/demo/config.draft', session);
    await context.vfs.writeFile(draft, session, Buffer.from(JSON.stringify({ greeting: 'from-vfs', failHealth: false })), { user: 'tester' });
    assert.equal(context.registry.getConfig('demo').greeting, 'initial');

    const ctl = await context.vfs.lookup('/svc/demo/ctl', session);
    await context.vfs.writeFile(ctl, session, Buffer.from(JSON.stringify({ op: 'commit' })), { user: 'tester' });

    const statusNode = await context.vfs.lookup('/svc/demo/status', session);
    const status = JSON.parse((await context.vfs.readFile(statusNode, session)).toString('utf8'));
    assert.equal(status.version, 1);
    assert.equal(status.status, 'healthy');
    assert.equal(status.state.greeting, 'from-vfs');
  } finally {
    await context.cleanup();
  }
});

test('readonly mount rejects writes', async () => {
  const context = await setup();
  try {
    const session = context.policy.attach('readonly');
    const draft = await context.vfs.lookup('/svc/demo/config.draft', session);
    await assert.rejects(
      () => context.vfs.writeFile(draft, session, Buffer.from('{}')),
      /read-only/,
    );
  } finally {
    await context.cleanup();
  }
});

test('write size limit is enforced', async () => {
  const context = await setup();
  try {
    const session = context.policy.attach('operator');
    session.maxWriteBytes = 8;
    const draft = await context.vfs.lookup('/svc/demo/config.draft', session);
    await assert.rejects(
      () => context.vfs.writeFile(draft, session, Buffer.from('{"greeting":"too-large"}')),
      /exceeds 8/,
    );
  } finally {
    await context.cleanup();
  }
});

test('temporary write grant allows writes on readonly mount until expiry', async () => {
  const context = await setup();
  try {
    const session = context.policy.attach('readonly');
    const draft = await context.vfs.lookup('/svc/demo/config.draft', session);
    await assert.rejects(
      () => context.vfs.writeFile(draft, session, Buffer.from('{}')),
      /read-only/,
    );

    const grant = await context.vfs.grantWrite('readonly', { ttlMs: 5000 });
    assert.ok(grant.token);
    assert.ok(grant.expiresAt > Date.now());

    await context.vfs.writeFile(draft, session, Buffer.from(JSON.stringify({ greeting: 'granted' })), { user: 'tester' });
    assert.equal(context.registry.getDraft('demo').greeting, 'granted');

    const auditText = await context.audit.readText();
    assert.match(auditText, /grant_issued/);
    assert.match(auditText, /"writeGrant":true/);
    assert.doesNotMatch(auditText, new RegExp(grant.token));
  } finally {
    await context.cleanup();
  }
});

test('expired write grant rejects writes with explicit permission error', async () => {
  const context = await setup();
  try {
    const session = context.policy.attach('readonly');
    const draft = await context.vfs.lookup('/svc/demo/config.draft', session);

    await context.vfs.grantWrite('readonly', { ttlMs: 20 });
    await new Promise((resolve) => setTimeout(resolve, 40));

    await assert.rejects(
      () => context.vfs.writeFile(draft, session, Buffer.from(JSON.stringify({ greeting: 'too-late' }))),
      /temporary write grant for profile readonly has expired/,
    );
    assert.equal(context.policy.hasActiveWriteGrant('readonly'), false);

    const auditText = await context.audit.readText();
    assert.match(auditText, /write_rejected/);
    assert.match(auditText, /has expired/);
  } finally {
    await context.cleanup();
  }
});

test('rejected writes redact sensitive keys from the audit payload preview', async () => {
  const context = await setup();
  try {
    const vfs = new VirtualFileSystem({
      registry: context.registry,
      transactions: context.transactions,
      snapshots: context.snapshots,
      audit: context.audit,
      policy: context.policy,
      sensitiveKeys: ['token', 'password'],
    });
    const session = context.policy.attach('operator');

    const draft = await vfs.lookup('/svc/demo/config.draft', session);
    await assert.rejects(
      () => vfs.writeFile(draft, session, Buffer.from('{"token":"dummy-token",')),
      /must be valid JSON/,
    );

    const readonlySession = context.policy.attach('readonly');
    const readonlyDraft = await vfs.lookup('/svc/demo/config.draft', readonlySession);
    await assert.rejects(
      () => vfs.writeFile(readonlyDraft, readonlySession, Buffer.from(JSON.stringify({ password: 'dummy-password' }))),
      /read-only/,
    );

    const auditText = await context.audit.readText();
    assert.match(auditText, /write_rejected/);
    assert.match(auditText, /\[redacted\]/);
    assert.doesNotMatch(auditText, /dummy-token/);
    assert.doesNotMatch(auditText, /dummy-password/);
  } finally {
    await context.cleanup();
  }
});

test('grant issuance fails closed when audit persistence fails', async () => {
  const context = await setup();
  try {
    const failingAudit = { append: async () => { throw new Error('disk full'); }, readText: async () => '' };
    const vfs = new VirtualFileSystem({
      registry: context.registry,
      transactions: context.transactions,
      snapshots: context.snapshots,
      audit: failingAudit,
      policy: context.policy,
    });

    await assert.rejects(
      () => vfs.grantWrite('readonly'),
      /audit persistence failed/,
    );
    assert.equal(context.policy.hasActiveWriteGrant('readonly'), false);

    const session = context.policy.attach('readonly');
    const draft = await context.vfs.lookup('/svc/demo/config.draft', session);
    await assert.rejects(
      () => context.vfs.writeFile(draft, session, Buffer.from('{}')),
      /read-only/,
    );
  } finally {
    await context.cleanup();
  }
});
