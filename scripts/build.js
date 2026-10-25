import { existsSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// NOTE: 根 README.md 是本地说明文件，不随仓库分发，不属于构建必需文件。
// NOTE(en): The root README.md is a local-only document and not distributed with the repo, so it is not a required build file.
const required = [
  'src/index.js',
  'src/server/9pServer.js',
  'src/vfs/virtualFileSystem.js',
  'src/tx/transactionManager.js',
  'config/default.json',
  'tasks/demo-service.js',
  'bin/ivwh.js',
  'bin/ivwh',
  'src/cli/ivwh.js',
];

const missing = required.filter((file) => !existsSync(path.join(rootDir, file)));
if (missing.length) {
  process.stderr.write(`Missing required files: ${missing.join(', ')}\n`);
  process.exit(1);
}

const lint = spawnSync(process.execPath, ['scripts/lint.js'], {
  cwd: rootDir,
  stdio: 'inherit',
});
if (lint.status !== 0) process.exit(lint.status ?? 1);
process.stdout.write('build ok (local package verification)\n');
