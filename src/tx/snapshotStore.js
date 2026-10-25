import { mkdir, readFile, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { writeJsonAtomic } from '../utils/json.js';

// NOTE: 文件名只允许字母数字开头、后续为 [a-z0-9._-] 的 id，拒绝路径分隔符，防止快照 id 路径穿越。
// NOTE(en): File names allow only ids starting alphanumeric followed by [a-z0-9._-]; path separators are rejected to prevent snapshot-id traversal.
const SAFE_ID = /^[a-z0-9][a-z0-9._-]*$/;

const DEFAULT_RETENTION_LIMIT = 50;

// NOTE: 保留上限 0 表示不淘汰；非法值回落默认值，避免魔法值散落。
// NOTE(en): A retention limit of 0 disables eviction; invalid values fall back to the default so no magic numbers leak into call sites.
function toRetentionLimit(value) {
  if (value === undefined || value === null) return DEFAULT_RETENTION_LIMIT;
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) return DEFAULT_RETENTION_LIMIT;
  return Math.floor(num);
}

function assertSafeId(value, label) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) {
    throw new Error(`Unsafe ${label}: ${String(value)}`);
  }
}

export class SnapshotStore {
  constructor({ dataDir, retentionLimit }) {
    this.dir = path.join(dataDir, 'snapshots');
    this.counter = 0;
    this.retentionLimit = toRetentionLimit(retentionLimit);
  }

  #buildFileName(serviceId, snapshotId) {
    assertSafeId(serviceId, 'service id');
    assertSafeId(snapshotId, 'snapshot id');
    return path.join(this.dir, `${serviceId}__${snapshotId}.json`);
  }

  async save(serviceId, snapshot) {
    assertSafeId(serviceId, 'service id');
    this.counter += 1;
    const id = `${Date.now().toString(36)}-${this.counter}-${Math.random().toString(36).slice(2, 8)}`;
    const record = {
      id,
      service: serviceId,
      createdAt: new Date().toISOString(),
      ...snapshot,
    };
    await writeJsonAtomic(this.#buildFileName(serviceId, id), record);
    return record;
  }

  async list(serviceId) {
    assertSafeId(serviceId, 'service id');
    await mkdir(this.dir, { recursive: true });
    const prefix = `${serviceId}__`;
    const files = await readdir(this.dir);
    const records = [];
    for (const file of files.filter((name) => name.startsWith(prefix) && name.endsWith('.json'))) {
      records.push(JSON.parse(await readFile(path.join(this.dir, file), 'utf8')));
    }
    return records.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async get(serviceId, snapshotId) {
    try {
      return JSON.parse(await readFile(this.#buildFileName(serviceId, snapshotId), 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    }
  }

  async remove(serviceId, snapshotId) {
    try {
      await unlink(this.#buildFileName(serviceId, snapshotId));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  // NOTE: 淘汰只针对未受保护的最旧快照；单个文件删除失败时保留该快照并记入 failures，不中断其余淘汰。
  // NOTE(en): Eviction targets only the oldest unprotected snapshots; a per-file delete failure keeps that snapshot, records it in failures, and does not stop the remaining evictions.
  async enforceRetention(serviceId, { protectedIds } = {}) {
    const empty = { evicted: [], failures: [] };
    if (this.retentionLimit === 0) return empty;
    const records = await this.list(serviceId);
    let excess = records.length - this.retentionLimit;
    if (excess <= 0) return empty;
    const protectedSet = protectedIds instanceof Set ? protectedIds : new Set(protectedIds ?? []);
    const evicted = [];
    const failures = [];
    for (const record of records) {
      if (excess <= 0) break;
      if (protectedSet.has(record.id)) continue;
      try {
        await this.remove(serviceId, record.id);
        evicted.push(record);
        excess -= 1;
      } catch (error) {
        failures.push({ id: record.id, error: error.message });
      }
    }
    return { evicted, failures };
  }
}
