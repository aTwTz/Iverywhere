import { encodeStat, QID_DIRECTORY } from '../server/protocol.js';
import { parseJsonObject, toJsonLine, redactKeys, redactPayloadPreview, clone } from '../utils/json.js';

const FIXED_SERVICE_FILES = ['status', 'config', 'config.draft', 'ctl', 'snapshot'];
const WRITABLE_KINDS = new Set(['draft', 'ctl', 'rollback']);

export class VirtualFileSystem {
  constructor({ registry, transactions, snapshots, audit, policy, sensitiveKeys = [] }) {
    this.registry = registry;
    this.transactions = transactions;
    this.snapshots = snapshots;
    this.audit = audit;
    this.policy = policy;
    this.sensitiveKeys = sensitiveKeys;
    this.nextQidPath = 1n;
    this.qids = new Map();
    this.nodes = new Map();
    this.snapshotQids = new Map();

    this.root = this.#createDirNode('/', '');
    this.svc = this.#createDirNode('/svc', 'svc');
    this.auditNode = this.#createFileNode('/audit', 'audit', 'audit');

    for (const serviceId of this.registry.list()) {
      this.#addService(serviceId);
    }
  }

  async lookup(rawPath, session) {
    const path = normalizePath(rawPath);
    if (path === '/') return this.root;
    if (path === '/svc') return this.svc;
    if (path === '/audit') return this.auditNode;

    const parts = splitPath(path);
    if (parts[0] !== 'svc') throw createNotFoundError(path);
    const serviceId = parts[1];
    if (!serviceId || !this.registry.has(serviceId)) throw createNotFoundError(path);
    this.#assertServiceVisible(session, serviceId);

    if (parts.length === 2) return this.nodes.get(path);
    const fileName = parts[2];
    if (parts.length === 3) {
      const fixed = this.nodes.get(path);
      if (!fixed) throw createNotFoundError(path);
      return fixed;
    }

    if (fileName === 'snapshot' && parts.length === 4) {
      const snapshotId = parts[3];
      const record = await this.snapshots.get(serviceId, snapshotId);
      if (!record) throw createNotFoundError(path);
      return this.#createSnapshotDirNode(serviceId, snapshotId);
    }
    if (fileName === 'snapshot' && parts.length === 5 && ['meta', 'rollback'].includes(parts[4])) {
      const snapshotId = parts[3];
      const record = await this.snapshots.get(serviceId, snapshotId);
      if (!record) throw createNotFoundError(path);
      return this.#createSnapshotFileNode(serviceId, snapshotId, parts[4]);
    }
    throw createNotFoundError(path);
  }

  async list(node, session) {
    if (!node.dir) throw new Error(`${node.path} is not a directory`);
    if (node === this.root) {
      const entries = [this.svc, this.auditNode];
      return entries;
    }
    if (node === this.svc) {
      return this.registry.list()
        .filter((serviceId) => this.policy.canReadService(session, serviceId))
        .map((serviceId) => this.nodes.get(`/svc/${serviceId}`));
    }
    if (node.kind === 'service') {
      return FIXED_SERVICE_FILES.map((name) => this.nodes.get(`${node.path}/${name}`));
    }
    if (node.kind === 'snapshot-dir') {
      const records = await this.snapshots.list(node.service);
      return records.map((record) => this.#createSnapshotDirNode(node.service, record.id));
    }
    if (node.kind === 'snapshot') {
      return [this.#createSnapshotFileNode(node.service, node.snapshot, 'meta'), this.#createSnapshotFileNode(node.service, node.snapshot, 'rollback')];
    }
    return [];
  }

  // NOTE: 服务端本地授权入口；先写审计再激活授权，审计持久化失败即撤销（故障关闭）。返回值含 token，调用方不得写入 9P 命名空间。
  // NOTE(en): Server-local grant entry point; the audit record is written before activation, and any persistence failure revokes the grant (fail closed). The returned token must never be written into the 9P namespace.
  async grantWrite(mountName, { ttlMs } = {}) {
    const grant = this.policy.grantWrite(mountName, ttlMs);
    try {
      await this.audit.append({
        action: 'grant_issued',
        mount: mountName,
        path: '/svc',
        bytes: 0,
        ttlMs: grant.expiresAt - grant.issuedAt,
        expiresAt: new Date(grant.expiresAt).toISOString(),
      });
    } catch (error) {
      this.policy.revokeWriteGrant(mountName);
      throw new Error(`Write grant revoked because audit persistence failed: ${error.message}`);
    }
    return grant;
  }

  canOpen(node, mode, session) {
    if (node.dir) return (mode & 0x0f) === 0;
    const access = mode & 0x0f;
    if (access === 0) return true;
    if (access === 3) return false;
    if (!WRITABLE_KINDS.has(node.kind)) return false;
    return session.allowWrite || this.policy.hasActiveWriteGrant(session.name);
  }

  async readFile(node, session) {
    switch (node.kind) {
      case 'audit':
        return Buffer.from(await this.audit.readText(), 'utf8');
      case 'status':
        return toTextBuffer(this.registry.getStatus(node.service));
      case 'config':
        return toTextBuffer(this.registry.getConfig(node.service));
      case 'draft':
        return toTextBuffer(this.registry.getDraft(node.service));
      case 'ctl':
        return toTextBuffer({
          service: node.service,
          allowedOps: [
            { op: 'commit', expectVersion: 'optional integer' },
            { op: 'snapshot', label: 'optional string' },
            { op: 'rollback', snapshot: 'required snapshot id' },
          ],
          workflow: ['write config.draft as one JSON object', 'write ctl {"op":"commit"}', 'read status and snapshot metadata'],
        });
      case 'snapshot-meta':
        return toTextBuffer(await this.snapshots.get(node.service, node.snapshot));
      case 'rollback':
        return toTextBuffer({ usage: 'write "rollback" to restore this snapshot' });
      default:
        throw new Error(`Unsupported read target: ${node.path}`);
    }
  }

  async writeFile(node, session, data, context = {}) {
    const payload = data.toString('utf8');
    let auditEvent;
    try {
      this.policy.assertWriteFile(session, data.length);
      // NOTE: 走到这里且 mount 本身只读，说明本次写依赖临时授权，审计必须标记。
      // NOTE(en): Reaching this point on a read-only mount means the write relies on a temporary grant, which the audit must flag.
      const usedWriteGrant = !session.allowWrite;
      if (node.kind === 'draft') {
        const draft = parseJsonObject(payload, 'config.draft');
        await this.registry.setDraft(node.service, draft);
        auditEvent = { op: 'write', target: 'draft', payload: redactKeys(draft, this.sensitiveKeys) };
      } else if (node.kind === 'ctl') {
        const command = parseJsonObject(payload, 'ctl');
        const result = await this.transactions.execute(node.service, command, {
          user: context.user ?? 'unknown',
          mount: session.name,
        });
        auditEvent = { op: 'write', target: 'ctl', command, result };
      } else if (node.kind === 'rollback') {
        if (payload.trim() && payload.trim() !== 'rollback') {
          throw new Error('snapshot rollback file only accepts "rollback"');
        }
        const result = await this.transactions.execute(node.service, {
          op: 'rollback',
          snapshot: node.snapshot,
        }, {
          user: context.user ?? 'unknown',
          mount: session.name,
        });
        auditEvent = { op: 'write', target: 'snapshot-rollback', snapshot: node.snapshot, result };
      } else {
        throw new Error(`Target is read-only: ${node.path}`);
      }
      auditEvent.writeGrant = usedWriteGrant;
      await this.#audit(session, node, 'write', data.length, auditEvent);
      return data.length;
    } catch (error) {
      // NOTE: 写失败路径与成功路径同样按敏感键名脱敏；脱敏失败时丢弃预览，只记字节数，保证明文机密不落审计。
      // NOTE(en): The rejected-write path redacts by sensitive key names just like the success path; if redaction itself fails, drop the preview and keep only the byte count so no plaintext secret reaches the audit log.
      const preview = redactPayloadPreview(payload, this.sensitiveKeys);
      await this.#audit(session, node, 'write_rejected', data.length, {
        error: error.message,
        ...(preview === null ? { payloadPreviewBytes: payload.length } : { payloadPreview: preview }),
      });
      throw error;
    }
  }

  stat(node, session) {
    const now = Math.floor(Date.now() / 1000);
    const canWrite = session.allowWrite || this.policy.hasActiveWriteGrant(session.name);
    const isWritable = WRITABLE_KINDS.has(node.kind) && canWrite;
    return {
      type: 0,
      dev: 0,
      qid: node.qid,
      mode: node.dir ? (QID_DIRECTORY | 0o555) : (isWritable ? 0o222 : 0o444),
      atime: now,
      mtime: now,
      length: node.dir ? 0 : 0,
      name: node.name,
      uid: session.name,
      gid: 'iverywhere',
      muid: session.name,
    };
  }

  async readDirectoryData(node, session) {
    const entries = await this.list(node, session);
    const buffers = [];
    for (const entry of entries) {
      const stat = this.stat(entry, session);
      if (!entry.dir) stat.length = (await this.readFile(entry, session)).length;
      buffers.push(encodeStat(stat));
    }
    return Buffer.concat(buffers);
  }

  #addService(serviceId) {
    const serviceNode = this.#createDirNode(`/svc/${serviceId}`, serviceId, 'service');
    serviceNode.service = serviceId;
    const status = this.#createFileNode(`${serviceNode.path}/status`, 'status', 'status');
    status.service = serviceId;
    const config = this.#createFileNode(`${serviceNode.path}/config`, 'config', 'config');
    config.service = serviceId;
    const draft = this.#createFileNode(`${serviceNode.path}/config.draft`, 'config.draft', 'draft');
    draft.service = serviceId;
    const ctl = this.#createFileNode(`${serviceNode.path}/ctl`, 'ctl', 'ctl');
    ctl.service = serviceId;
    const snapshotDir = this.#createDirNode(`${serviceNode.path}/snapshot`, 'snapshot', 'snapshot-dir');
    snapshotDir.service = serviceId;
  }

  #createDirNode(path, name, kind = 'dir') {
    const node = { path, name, kind, dir: true, qid: this.#resolveQid(QID_DIRECTORY, path) };
    this.nodes.set(path, node);
    return node;
  }

  #createFileNode(path, name, kind) {
    const node = { path, name, kind, dir: false, qid: this.#resolveQid(0, path) };
    this.nodes.set(path, node);
    return node;
  }

  #createSnapshotDirNode(serviceId, snapshotId) {
    const path = `/svc/${serviceId}/snapshot/${snapshotId}`;
    const existing = this.nodes.get(path);
    if (existing) return existing;
    const node = {
      path,
      name: snapshotId,
      kind: 'snapshot',
      dir: true,
      service: serviceId,
      snapshot: snapshotId,
      qid: this.#snapshotQid(serviceId, snapshotId),
    };
    this.nodes.set(path, node);
    return node;
  }

  #createSnapshotFileNode(serviceId, snapshotId, kindName) {
    const path = `/svc/${serviceId}/snapshot/${snapshotId}/${kindName}`;
    const existing = this.nodes.get(path);
    if (existing) return existing;
    const node = {
      path,
      name: kindName,
      kind: kindName === 'meta' ? 'snapshot-meta' : 'rollback',
      dir: false,
      service: serviceId,
      snapshot: snapshotId,
      qid: this.#snapshotQid(serviceId, `${snapshotId}/${kindName}`),
    };
    this.nodes.set(path, node);
    return node;
  }

  #snapshotQid(serviceId, key) {
    const fullKey = `${serviceId}/${key}`;
    if (!this.snapshotQids.has(fullKey)) {
      // NOTE: 快照目录使用目录 qid，meta/rollback 文件使用普通文件 qid。
      // NOTE(en): Snapshot directories use directory qids, while meta/rollback files use regular file qids.
      const type = key.includes('/') ? 0 : QID_DIRECTORY;
      this.snapshotQids.set(fullKey, { type, path: this.#allocateQidPath() });
    }
    const qid = this.snapshotQids.get(fullKey);
    return { type: qid.type, version: 0, path: qid.path };
  }

  #resolveQid(type, key) {
    if (!this.qids.has(key)) {
      this.qids.set(key, { type, version: 0, path: this.#allocateQidPath() });
    }
    return this.qids.get(key);
  }

  #allocateQidPath() {
    const value = this.nextQidPath;
    this.nextQidPath += 1n;
    return value;
  }

  #assertServiceVisible(session, serviceId) {
    if (!this.policy.canReadService(session, serviceId)) throw createNotFoundError(`/svc/${serviceId}`);
  }

  async #audit(session, node, action, bytes, detail) {
    await this.audit.append({
      action,
      mount: session.name,
      path: node.path,
      bytes,
      ...detail,
    });
  }
}

function toTextBuffer(value) {
  return Buffer.from(toJsonLine(value), 'utf8');
}

function normalizePath(rawPath) {
  if (!rawPath || rawPath === '/') return '/';
  if (!rawPath.startsWith('/')) throw createNotFoundError(rawPath);
  const normalized = rawPath.replace(/\/+/g, '/').replace(/\/$/, '');
  return normalized || '/';
}

function splitPath(path) {
  const parts = path.split('/').filter(Boolean);
  if (parts.some((part) => ['.', '..', ''].includes(part))) throw createNotFoundError(path);
  return parts;
}

function createNotFoundError(path) {
  const error = new Error(`Path not found or not visible: ${path}`);
  error.code = 'ENOENT';
  return error;
}
