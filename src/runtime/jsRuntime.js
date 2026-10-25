import { spawn } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { verifyScriptIntegrity } from './scriptIntegrity.js';

export class JsRuntime {
  constructor({ rootDir }) {
    this.rootDir = rootDir;
  }

  async execute(serviceId, definition, phase, payload) {
    // NOTE: 配置 scriptSha256 时每次阶段执行前都重新校验脚本内容，运行期篡改同样拒绝。
    // NOTE(en): When scriptSha256 is configured the script content is re-verified before every phase execution, so mid-run tampering is rejected too.
    const expectedSha256 = definition.runtime?.scriptSha256;
    if (expectedSha256) {
      const script = definition.runtime?.script;
      if (!script) throw new Error(`JS service ${serviceId} pins scriptSha256 but has no runtime.script`);
      await verifyScriptIntegrity({
        serviceId,
        scriptPath: path.resolve(this.rootDir, script),
        expectedSha256,
      });
    }
    const runtime = definition.runtime ?? {};
    const mode = runtime.mode ?? 'worker';
    if (mode === 'module') return this.executeModule(serviceId, definition, phase, payload);
    if (mode === 'worker') return this.executeWorker(serviceId, definition, phase, payload);
    throw new Error(`Unsupported JS runtime mode for ${serviceId}: ${mode}`);
  }

  async executeWorker(serviceId, definition, phase, payload) {
    const script = definition.runtime?.script;
    if (!script) throw new Error(`JS worker service ${serviceId} is missing runtime.script`);
    const timeoutMs = definition.runtime?.timeoutMs ?? definition.healthTimeoutMs ?? 1000;
    const scriptPath = path.resolve(this.rootDir, script);
    return runJsonProcess({
      command: process.execPath,
      args: [scriptPath, phase],
      input: JSON.stringify(payload),
      timeoutMs,
      context: `js worker ${serviceId}:${phase}`,
    });
  }

  async executeModule(serviceId, definition, phase, payload) {
    const script = definition.runtime?.script;
    if (!script) throw new Error(`JS module service ${serviceId} is missing runtime.script`);
    const timeoutMs = definition.runtime?.timeoutMs ?? definition.healthTimeoutMs ?? 1000;
    const modulePath = path.resolve(this.rootDir, script);
    const module = await import(pathToFileURL(modulePath).href);
    const handler = module[phase];
    if (typeof handler !== 'function') {
      throw new Error(`JS module ${script} does not export ${phase}(payload)`);
    }

    const result = await withTimeout(Promise.resolve().then(() => handler(payload)), timeoutMs, `js module ${serviceId}:${phase}`);
    assertOkResult(result, `js module ${serviceId}:${phase}`);
    return result;
  }
}

export function runJsonProcess({ command, args, input, timeoutMs, context, cwd }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      ...(cwd ? { cwd } : {}),
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${context} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
      if (stdout.length > 1024 * 1024) {
        child.kill('SIGKILL');
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
      if (stderr.length > 1024 * 1024) {
        child.kill('SIGKILL');
      }
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new Error(`${context} failed to start: ${error.message}`));
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`${context} exited ${code ?? signal}: ${stderr.trim() || stdout.trim() || 'no output'}`));
        return;
      }
      const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      const lastLine = lines.at(-1);
      if (!lastLine) {
        reject(new Error(`${context} returned no JSON result`));
        return;
      }
      let result;
      try {
        result = JSON.parse(lastLine);
      } catch (error) {
        reject(new Error(`${context} returned invalid JSON: ${error.message}; output=${lastLine}`));
        return;
      }
      try {
        assertOkResult(result, context);
        resolve(result);
      } catch (error) {
        reject(error);
      }
    });

    child.stdin.on('error', () => undefined);
    child.stdin.write(input);
    child.stdin.end();
  });
}

function assertOkResult(result, context) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new Error(`${context} must return a JSON object`);
  }
  if (result.ok !== true) {
    throw new Error(result.error ? `${context} rejected operation: ${result.error}` : `${context} returned ok=false`);
  }
}

function withTimeout(promise, timeoutMs, context) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${context} timed out after ${timeoutMs}ms`)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
