import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { AuditLog } from '../audit/auditLog.js';
import { createRuntime } from '../runtime/runtimeFactory.js';
import { verifyScriptIntegrity } from '../runtime/scriptIntegrity.js';
import { clone, readJson, writeJsonAtomic } from '../utils/json.js';

export class ServiceRegistry {
  constructor({ services = {}, dataDir, rootDir }) {
    this.dataDir = dataDir;
    this.rootDir = rootDir;
    this.definitions = services;
    this.audit = new AuditLog({ dataDir });
    this.services = new Map();
  }

  async init() {
    await mkdir(path.join(this.dataDir, 'services'), { recursive: true });
    for (const [id, definition] of Object.entries(this.definitions)) {
      const runtime = createRuntime(definition, { rootDir: this.rootDir });
      const stateFile = path.join(this.dataDir, 'services', `${id}.json`);
      const stored = await readJson(stateFile, undefined);
      const initial = stored ?? {
        id,
        config: clone(definition.initialConfig ?? {}),
        draft: clone(definition.initialConfig ?? {}),
        version: 0,
        state: {},
        status: 'idle',
        health: { ok: true, checkedAt: null },
        lastError: null,
        circuitFailures: 0,
      };
      this.services.set(id, {
        id,
        definition,
        runtime,
        stateFile,
        ...initial,
        ...createStoredDefaults(stored),
        ...stored,
      });
      await this.verifyServiceScript(id);
    }
  }

  // NOTE: 启动即校验钉死的脚本 hash；不匹配进入 script_rejected 明确失败态并写审计，不降级为跳过校验；状态与审计只落结论，不落脚本路径与 hash 值。
  // NOTE(en): The pinned script hash is verified at startup; a mismatch enters the explicit script_rejected failure state and is audited, never degraded to skipping the check; status and audit record only the verdict, never the script path or hash values.
  async verifyServiceScript(id) {
    const service = this.services.get(id);
    const expectedSha256 = service.definition.runtime?.scriptSha256;
    if (!expectedSha256) return;
    try {
      const script = service.definition.runtime?.script;
      if (!script) throw new Error(`service ${id} pins scriptSha256 but has no runtime.script`);
      await verifyScriptIntegrity({
        serviceId: id,
        scriptPath: path.resolve(this.rootDir, script),
        expectedSha256,
      });
      service.scriptRejected = false;
      if (service.status === 'script_rejected') {
        service.status = 'idle';
        service.lastError = null;
        await this.save(service);
      }
    } catch (error) {
      service.scriptRejected = true;
      service.status = 'script_rejected';
      service.health = { ok: false, checkedAt: new Date().toISOString(), error: error.message };
      service.lastError = error.message;
      service.updatedAt = new Date().toISOString();
      await this.save(service);
      await this.audit.append({ op: 'script_integrity_rejected', service: id, error: error.message });
    }
  }

  list() {
    return [...this.services.keys()].sort();
  }

  has(id) {
    return this.services.has(id);
  }

  get(id) {
    const service = this.services.get(id);
    if (!service) throw new Error(`Unknown service: ${id}`);
    return service;
  }

  getStatus(id) {
    const service = this.get(id);
    return {
      service: id,
      description: service.definition.description ?? '',
      adapter: service.definition.adapter ?? 'js',
      status: service.status,
      version: service.version,
      health: service.health,
      lastError: service.lastError,
      updatedAt: service.updatedAt ?? null,
      draftEqualsConfig: JSON.stringify(service.draft) === JSON.stringify(service.config),
      state: service.state,
    };
  }

  getConfig(id) {
    return clone(this.get(id).config);
  }

  getDraft(id) {
    return clone(this.get(id).draft);
  }

  async setDraft(id, draft) {
    const service = this.get(id);
    service.draft = clone(draft);
    service.updatedAt = new Date().toISOString();
    await this.save(service);
  }

  async apply(id, config) {
    const service = this.get(id);
    this.assertScriptAllowed(service);
    await this.assertCircuitClosed(service);
    service.status = 'applying';
    service.lastError = null;
    const result = await service.runtime.execute(id, service.definition, 'apply', {
      service: id,
      phase: 'apply',
      config: clone(config),
      state: clone(service.state),
    });
    service.config = clone(config);
    service.draft = clone(config);
    service.state = clone(result.state ?? {});
    service.version += 1;
    service.status = 'applied';
    service.updatedAt = new Date().toISOString();
    await this.save(service);
    return clone(service.state);
  }

  async validate(id, config) {
    const service = this.get(id);
    this.assertScriptAllowed(service);
    await service.runtime.execute(id, service.definition, 'validate', {
      service: id,
      phase: 'validate',
      config: clone(config),
      state: clone(service.state),
    });
  }

  async checkHealth(id) {
    const service = this.get(id);
    this.assertScriptAllowed(service);
    await this.assertCircuitClosed(service);
    const result = await service.runtime.execute(id, service.definition, 'health', {
      service: id,
      phase: 'health',
      config: clone(service.config),
      state: clone(service.state),
    });
    service.health = {
      ok: true,
      checkedAt: new Date().toISOString(),
      details: clone(result.details ?? {}),
    };
    service.lastError = null;
    service.status = 'healthy';
    service.circuitFailures = 0;
    service.updatedAt = new Date().toISOString();
    await this.save(service);
    return service.health;
  }

  async markFailure(id, error, { preserveHealth = false } = {}) {
    const service = this.get(id);
    const threshold = service.definition.circuit?.failureThreshold ?? 3;
    const cooldownMs = service.definition.circuit?.cooldownMs ?? 5000;
    service.circuitFailures += 1;
    if (!preserveHealth) {
      service.health = {
        ok: false,
        checkedAt: new Date().toISOString(),
        error: error.message,
      };
    }
    service.lastError = error.message;
    service.status = service.circuitFailures >= threshold ? 'circuit_open' : 'unhealthy';
    if (service.circuitFailures >= threshold) {
      service.circuitOpenUntil = Date.now() + cooldownMs;
    }
    service.updatedAt = new Date().toISOString();
    await this.save(service);
  }

  async restoreRecord(id, record) {
    const service = this.get(id);
    service.config = clone(record.config);
    service.draft = clone(record.config);
    service.state = clone(record.state ?? {});
    service.version += 1;
    service.status = 'restored';
    service.health = {
      ok: true,
      checkedAt: new Date().toISOString(),
      restoredFrom: record.id,
    };
    service.lastError = null;
    service.updatedAt = new Date().toISOString();
    await this.save(service);
  }

  snapshotRecord(id) {
    const service = this.get(id);
    return {
      service: id,
      version: service.version,
      config: clone(service.config),
      state: clone(service.state),
    };
  }

  async save(service) {
    await writeJsonAtomic(service.stateFile, {
      id: service.id,
      config: service.config,
      draft: service.draft,
      version: service.version,
      state: service.state,
      status: service.status,
      health: service.health,
      lastError: service.lastError,
      circuitFailures: service.circuitFailures,
      circuitOpenUntil: service.circuitOpenUntil ?? 0,
      updatedAt: service.updatedAt ?? null,
    });
  }

  assertScriptAllowed(service) {
    if (service.scriptRejected) {
      throw new Error(`Service ${service.id} is blocked: script integrity check failed`);
    }
  }

  async assertCircuitClosed(service) {    if (service.circuitOpenUntil && service.circuitOpenUntil > Date.now()) {
      throw new Error(`Service ${service.id} circuit is open until ${new Date(service.circuitOpenUntil).toISOString()}`);
    }
    if (service.circuitOpenUntil && service.circuitOpenUntil <= Date.now()) {
      service.circuitOpenUntil = 0;
      service.circuitFailures = 0;
      service.status = 'idle';
      await this.save(service);
    }
  }
}

function createStoredDefaults() {
  return {
    status: 'idle',
    health: { ok: true, checkedAt: null },
    lastError: null,
    circuitFailures: 0,
    circuitOpenUntil: 0,
    updatedAt: null,
  };
}
