import path from 'node:path';
import { runJsonProcess } from './jsRuntime.js';

// NOTE: 与 JS worker 同一份 JSON stdin/stdout 合约，进程边界复用 runJsonProcess。
// NOTE(en): Same JSON stdin/stdout contract as the JS worker; the process boundary reuses runJsonProcess.
// NOTE: `gleam run` 必须在 runtime.projectDir 内执行，否则模块解析失败。
// NOTE(en): `gleam run` must execute inside runtime.projectDir or module resolution fails.
// NOTE: 形态决策为进程每阶段替代常驻监督树，不接入常驻 BEAM 节点。
// NOTE(en): Form decision: process-per-phase replaces a resident supervision tree; no resident BEAM node.
export class GleamRuntime {
  constructor({ rootDir }) {
    this.rootDir = rootDir;
  }

  async execute(serviceId, definition, phase, payload) {
    const runtime = definition.runtime ?? {};
    const module = runtime.module;
    if (!module) throw new Error(`Gleam service ${serviceId} is missing runtime.module`);
    const timeoutMs = runtime.timeoutMs ?? definition.healthTimeoutMs ?? 1500;
    const projectDir = path.resolve(this.rootDir, runtime.projectDir ?? 'gleam');
    try {
      return await runJsonProcess({
        command: 'gleam',
        args: ['run', '-m', module, '--', phase],
        input: JSON.stringify(payload),
        timeoutMs,
        cwd: projectDir,
        context: `gleam service ${serviceId}:${phase}`,
      });
    } catch (error) {
      if (error instanceof Error && error.message.includes('ENOENT')) {
        throw new Error(`gleam service ${serviceId}:${phase} requires the Gleam toolchain on PATH; install Gleam or use adapter "js"`);
      }
      throw error;
    }
  }
}
