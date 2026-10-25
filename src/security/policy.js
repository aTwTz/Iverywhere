import { randomBytes } from 'node:crypto';

const DEFAULT_WRITE_GRANT_MS = 60000;

function normalizeGrantMs(value) {
  const num = Number(value ?? DEFAULT_WRITE_GRANT_MS);
  if (!Number.isFinite(num) || num <= 0) return DEFAULT_WRITE_GRANT_MS;
  return num;
}

export class Policy {
  constructor({ mounts = {}, defaultMount = 'operator', writeGrantMs } = {}) {
    this.mounts = mounts;
    this.defaultMount = defaultMount;
    this.writeGrantMs = normalizeGrantMs(writeGrantMs);
    this.writeGrants = new Map();
  }

  attach(aname = '') {
    const name = aname || this.defaultMount;
    const mount = this.mounts[name];
    if (!mount) throw new Error(`Unknown mount profile: ${name || '(empty)'}`);
    const limit = mount.rateLimit ?? {};
    const rate = Math.max(1, Number(limit.writesPerSecond ?? 5));
    const burst = Math.max(1, Number(limit.burst ?? rate));
    return {
      name,
      services: new Set(mount.services ?? []),
      allowWrite: mount.allowWrite !== false,
      maxWriteBytes: Number(mount.maxWriteBytes ?? 16384),
      tokens: burst,
      burst,
      refillPerMs: rate / 1000,
      lastRefill: Date.now(),
    };
  }

  canReadService(session, serviceId) {
    return session.services.has(serviceId);
  }

  // NOTE: 授权按 mount 名生效于服务端 session；token 只返回给本地调用方，绝不进入 9P 命名空间或审计日志。
  // NOTE(en): Grants apply to server-side sessions by mount name; the token is returned only to the local caller and never enters the 9P namespace or the audit log.
  grantWrite(mountName, ttlMs) {
    if (!this.mounts[mountName]) throw new Error(`Unknown mount profile: ${mountName}`);
    const ttl = ttlMs ?? this.writeGrantMs;
    if (!Number.isFinite(ttl) || ttl <= 0) {
      throw new Error(`Write grant ttl must be a positive number of milliseconds, got ${ttl}`);
    }
    const now = Date.now();
    const grant = { token: randomBytes(16).toString('hex'), mount: mountName, issuedAt: now, expiresAt: now + ttl };
    this.writeGrants.set(mountName, grant);
    return grant;
  }

  revokeWriteGrant(mountName) {
    return this.writeGrants.delete(mountName);
  }

  hasActiveWriteGrant(mountName) {
    return this.#grantState(mountName) === 'active';
  }

  assertWriteFile(session, byteLength) {
    if (!session.allowWrite) {
      const grantState = this.#grantState(session.name);
      if (grantState === 'expired') {
        throw new Error(`Write rejected: temporary write grant for profile ${session.name} has expired`);
      }
      if (grantState !== 'active') throw new Error(`Mount profile ${session.name} is read-only`);
    }
    if (session.maxWriteBytes > 0 && byteLength > session.maxWriteBytes) {
      throw new Error(`Write rejected: ${byteLength} bytes exceeds ${session.maxWriteBytes}`);
    }
    this.#refill(session);
    if (session.tokens < 1) throw new Error(`Write rejected by rate limit for profile ${session.name}`);
    session.tokens -= 1;
  }

  // NOTE: 过期采用惰性检测：写路径先清除过期授权并回落只读，不依赖后台定时器。
  // NOTE(en): Expiry is detected lazily: the write path purges expired grants and falls back to read-only without relying on background timers.
  #grantState(mountName) {
    const grant = this.writeGrants.get(mountName);
    if (!grant) return 'none';
    if (Date.now() >= grant.expiresAt) {
      this.writeGrants.delete(mountName);
      return 'expired';
    }
    return 'active';
  }

  #refill(session) {
    const now = Date.now();
    const elapsed = Math.max(0, now - session.lastRefill);
    session.tokens = Math.min(session.burst, session.tokens + elapsed * session.refillPerMs);
    session.lastRefill = now;
  }
}
