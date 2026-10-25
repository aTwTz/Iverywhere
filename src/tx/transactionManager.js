import { createAsyncQueue } from '../utils/lock.js';

const ALLOWED_COMMANDS = new Set(['commit', 'snapshot', 'rollback']);
const DEFAULT_DEADLINE_MS = 10000;
const DEFAULT_QUEUE_WAIT_MS = 5000;

// NOTE: 0 表示关闭对应时限；非法值回落到默认值，避免魔法值散落。
// NOTE(en): 0 disables the limit; invalid values fall back to the defaults so no magic numbers leak into call sites.
function toLimitMs(value, fallback) {
  if (value === undefined || value === null) return fallback;
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) return fallback;
  return num;
}

export class TransactionManager {
  constructor({ registry, journal, snapshots, deadlineMs, queueWaitMs }) {
    this.registry = registry;
    this.journal = journal;
    this.snapshots = snapshots;
    this.deadlineMs = toLimitMs(deadlineMs, DEFAULT_DEADLINE_MS);
    this.queueWaitMs = toLimitMs(queueWaitMs, DEFAULT_QUEUE_WAIT_MS);
    this.queues = new Map();
    // NOTE: 进行中事务的 before-image 按服务钉住，保留策略淘汰时必须跳过。
    // NOTE(en): Before-images of in-flight transactions are pinned per service and must be skipped by retention eviction.
    this.pinnedSnapshots = new Map();
  }

  #pinSnapshot(serviceId, snapshotId) {
    if (!this.pinnedSnapshots.has(serviceId)) this.pinnedSnapshots.set(serviceId, new Set());
    this.pinnedSnapshots.get(serviceId).add(snapshotId);
  }

  #unpinSnapshot(serviceId, snapshotId) {
    const pins = this.pinnedSnapshots.get(serviceId);
    if (!pins) return;
    pins.delete(snapshotId);
    if (pins.size === 0) this.pinnedSnapshots.delete(serviceId);
  }

  // NOTE: 淘汰审计写 journal；淘汰流程自身失败只记 snapshot_evict_failed，不阻塞已完成的快照创建。
  // NOTE(en): Eviction is audited via the journal; a failure inside eviction only yields snapshot_evict_failed and never blocks the snapshot that was already created.
  async #enforceRetention(serviceId, newSnapshotId) {
    const protectedIds = new Set(this.pinnedSnapshots.get(serviceId) ?? []);
    protectedIds.add(newSnapshotId);
    let result;
    try {
      result = await this.snapshots.enforceRetention(serviceId, { protectedIds });
    } catch (error) {
      await this.journal.append({ event: 'snapshot_evict_failed', service: serviceId, error: error.message });
      return;
    }
    for (const record of result.evicted) {
      await this.journal.append({
        event: 'snapshot_evicted',
        service: serviceId,
        snapshot: record.id,
        createdAt: record.createdAt,
        reason: 'retention_limit',
      });
    }
    for (const failure of result.failures) {
      await this.journal.append({
        event: 'snapshot_evict_failed',
        service: serviceId,
        snapshot: failure.id,
        error: failure.error,
      });
    }
  }

  async execute(serviceId, rawCommand, context = {}) {
    const command = this.#validateCommand(rawCommand);
    const queue = this.#queueFor(serviceId);
    return queue(async () => {
      if (command.op === 'commit') return this.#commit(serviceId, command, context);
      if (command.op === 'snapshot') return this.#snapshot(serviceId, command, context);
      return this.#rollback(serviceId, command, context);
    });
  }

  #queueFor(serviceId) {
    if (!this.queues.has(serviceId)) this.queues.set(serviceId, createAsyncQueue({ maxWaitMs: this.queueWaitMs }));
    return this.queues.get(serviceId);
  }

  // NOTE: 整体 deadline 从 validate 起算，覆盖 validate/apply/health 三段之和；0 表示不限制。
  // NOTE(en): The overall deadline starts at validate and covers validate/apply/health combined; 0 disables it.
  #phaseDeadline() {
    return this.deadlineMs > 0 ? Date.now() + this.deadlineMs : undefined;
  }

  async #awaitPhase(phasePromise, deadlineAt, serviceId, phase) {
    const pending = Promise.resolve(phasePromise);
    if (deadlineAt === undefined) return pending;
    const fail = (when) => new Error(`ctl deadline ${this.deadlineMs}ms exceeded ${when} ${phase} for ${serviceId}`);
    const remaining = deadlineAt - Date.now();
    // NOTE: 超时后底层阶段仍可能迟到落定；吞掉迟到结果，避免未处理拒绝。
    // NOTE(en): The underlying phase may still settle after the deadline fires; swallow the late outcome so it never becomes an unhandled rejection.
    pending.catch(() => undefined);
    if (remaining <= 0) throw fail('before');
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(fail('during')), remaining);
    });
    try {
      return await Promise.race([pending, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  #validateCommand(rawCommand) {
    if (!rawCommand || typeof rawCommand !== 'object' || Array.isArray(rawCommand)) {
      throw new Error('ctl command must be a JSON object');
    }
    const op = rawCommand.op;
    if (!ALLOWED_COMMANDS.has(op)) {
      throw new Error(`Unsupported ctl op ${JSON.stringify(op)}; allowed ops: ${[...ALLOWED_COMMANDS].join(', ')}`);
    }
    if (rawCommand.expectVersion !== undefined && !Number.isInteger(rawCommand.expectVersion)) {
      throw new Error('expectVersion must be an integer');
    }
    if (rawCommand.snapshot !== undefined && typeof rawCommand.snapshot !== 'string') {
      throw new Error('snapshot must be a string');
    }
    if (rawCommand.label !== undefined && typeof rawCommand.label !== 'string') {
      throw new Error('label must be a string');
    }
    return rawCommand;
  }

  async #commit(serviceId, command, context) {
    const service = this.registry.get(serviceId);
    if (command.expectVersion !== undefined && service.version !== command.expectVersion) {
      throw new Error(`Version conflict: expected ${command.expectVersion}, current ${service.version}`);
    }

    const deadlineAt = this.#phaseDeadline();
    const draft = this.registry.getDraft(serviceId);
    await this.#awaitPhase(this.registry.validate(serviceId, draft), deadlineAt, serviceId, 'validate');

    const before = this.registry.snapshotRecord(serviceId);
    const beforeSnapshot = await this.snapshots.save(serviceId, {
      ...before,
      label: command.label ? `before-${command.label}` : `auto-before-v${before.version}`,
      createdBy: context.user ?? 'unknown',
    });
    this.#pinSnapshot(serviceId, beforeSnapshot.id);

    try {
      await this.#enforceRetention(serviceId, beforeSnapshot.id);
      await this.journal.append({
        event: 'commit_begin',
        service: serviceId,
        beforeVersion: before.version,
        beforeSnapshot: beforeSnapshot.id,
        user: context.user ?? 'unknown',
        mount: context.mount ?? 'unknown',
      });

      try {
        await this.#awaitPhase(this.registry.apply(serviceId, draft), deadlineAt, serviceId, 'apply');
        const health = await this.#awaitPhase(this.registry.checkHealth(serviceId), deadlineAt, serviceId, 'health');
        await this.journal.append({
          event: 'commit_success',
          service: serviceId,
          beforeVersion: before.version,
          afterVersion: this.registry.get(serviceId).version,
          beforeSnapshot: beforeSnapshot.id,
          health,
        });
        return {
          ok: true,
          op: 'commit',
          service: serviceId,
          version: this.registry.get(serviceId).version,
          beforeSnapshot: beforeSnapshot.id,
          health,
        };
      } catch (error) {
        await this.#rollbackAfterFailedCommit(serviceId, before, beforeSnapshot, error);
        throw error;
      }
    } finally {
      this.#unpinSnapshot(serviceId, beforeSnapshot.id);
    }
  }

  async #rollbackAfterFailedCommit(serviceId, before, beforeSnapshot, originalError) {
    try {
      await this.registry.apply(serviceId, before.config);
      await this.registry.checkHealth(serviceId);
      await this.journal.append({
        event: 'commit_rolled_back',
        service: serviceId,
        restoredVersion: this.registry.get(serviceId).version,
        beforeSnapshot: beforeSnapshot.id,
        originalError: originalError.message,
      });
    } catch (rollbackError) {
      await this.registry.markFailure(serviceId, originalError, { preserveHealth: true });
      await this.journal.append({
        event: 'rollback_failed',
        service: serviceId,
        beforeSnapshot: beforeSnapshot.id,
        originalError: originalError.message,
        rollbackError: rollbackError.message,
      });
      throw new Error(`Commit failed and rollback also failed: ${rollbackError.message}; original error: ${originalError.message}`);
    }
    await this.registry.markFailure(serviceId, originalError, { preserveHealth: true });
  }

  async #snapshot(serviceId, command, context) {
    const record = this.registry.snapshotRecord(serviceId);
    const saved = await this.snapshots.save(serviceId, {
      ...record,
      label: command.label ?? 'manual',
      createdBy: context.user ?? 'unknown',
    });
    await this.journal.append({
      event: 'snapshot_created',
      service: serviceId,
      snapshot: saved.id,
      version: record.version,
      user: context.user ?? 'unknown',
      mount: context.mount ?? 'unknown',
    });
    await this.#enforceRetention(serviceId, saved.id);
    return { ok: true, op: 'snapshot', service: serviceId, snapshot: saved.id, version: record.version };
  }

  async #rollback(serviceId, command, context) {
    if (!command.snapshot) throw new Error('rollback requires snapshot id');
    const record = await this.snapshots.get(serviceId, command.snapshot);
    if (!record) throw new Error(`Snapshot not found for ${serviceId}: ${command.snapshot}`);
    const before = this.registry.snapshotRecord(serviceId);

    await this.journal.append({
      event: 'rollback_begin',
      service: serviceId,
      serviceVersion: before.version,
      targetSnapshot: record.id,
      targetVersion: record.version,
      user: context.user ?? 'unknown',
      mount: context.mount ?? 'unknown',
    });

    const deadlineAt = this.#phaseDeadline();
    try {
      await this.#awaitPhase(this.registry.apply(serviceId, record.config), deadlineAt, serviceId, 'apply');
      const health = await this.#awaitPhase(this.registry.checkHealth(serviceId), deadlineAt, serviceId, 'health');
      await this.journal.append({
        event: 'rollback_success',
        service: serviceId,
        afterVersion: this.registry.get(serviceId).version,
        targetSnapshot: record.id,
        health,
      });
      return {
        ok: true,
        op: 'rollback',
        service: serviceId,
        version: this.registry.get(serviceId).version,
        snapshot: record.id,
        health,
      };
    } catch (error) {
      await this.#restoreAfterFailedRollback(serviceId, before, record, error);
      throw error;
    }
  }

  // NOTE: 与 commit 失败路径对称：rollback 的 apply/health 失败时自动回放操作前 before-image 并复核健康；回放也失败时记熔断、写 rollback_failed 并抛双重错误，不留无 journal 的中间态；恢复成功写 rollback_restored，仍记一次熔断计数。
  // NOTE(en): Symmetric to the failed-commit path: when rollback's apply/health fails, the pre-op before-image is replayed and health is re-checked; if the replay also fails, the circuit counter is marked, rollback_failed is journaled, and a double error is thrown so no journal-less intermediate state remains; a successful replay is journaled as rollback_restored and still counts one circuit failure.
  async #restoreAfterFailedRollback(serviceId, before, record, originalError) {
    try {
      await this.registry.apply(serviceId, before.config);
      await this.registry.checkHealth(serviceId);
    } catch (restoreError) {
      await this.registry.markFailure(serviceId, originalError);
      await this.journal.append({
        event: 'rollback_failed',
        service: serviceId,
        targetSnapshot: record.id,
        originalError: originalError.message,
        rollbackError: restoreError.message,
      });
      throw new Error(`Rollback failed and before-image replay also failed: ${restoreError.message}; original error: ${originalError.message}`);
    }
    await this.registry.markFailure(serviceId, originalError, { preserveHealth: true });
    await this.journal.append({
      event: 'rollback_restored',
      service: serviceId,
      restoredVersion: this.registry.get(serviceId).version,
      targetSnapshot: record.id,
      originalError: originalError.message,
    });
  }
}
