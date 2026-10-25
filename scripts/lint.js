import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = collectFiles(rootDir).filter((file) => !file.includes(`${path.sep}.git${path.sep}`));
let hasFailed = false;

for (const file of files.filter((name) => name.endsWith('.js'))) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) {
    hasFailed = true;
    process.stderr.write(`${path.relative(rootDir, file)}\n${result.stderr}`);
  }
}

for (const file of files.filter((name) => name.endsWith('.json'))) {
  try {
    JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    hasFailed = true;
    process.stderr.write(`${path.relative(rootDir, file)}: ${error.message}\n`);
  }
}

const taggedCommentPattern = /^\s*\/\/\s*(NOTE|WARN|REF|HACK|FIXME|TODO):/;
const bilingualCommentPattern = /^\s*\/\/\s*(NOTE|WARN|REF|HACK|FIXME|TODO)\(en\):/;
for (const file of files.filter((name) => name.endsWith('.js'))) {
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  lines.forEach((line, index) => {
    const match = line.match(taggedCommentPattern);
    if (!match) return;
    const nextLine = lines[index + 1] ?? '';
    const englishMatch = nextLine.match(bilingualCommentPattern);
    if (englishMatch?.[1] !== match[1]) {
      hasFailed = true;
      process.stderr.write(`${path.relative(rootDir, file)}:${index + 1}: ${match[1]} comment must be followed by ${match[1]}(en)\n`);
    }
  });
}

const checkedTextExtensions = new Set(['.js', '.json', '.md', '.yml', '.yaml', '.toml', '.gleam']);
for (const file of files.filter((name) => checkedTextExtensions.has(path.extname(name)))) {
  const text = readFileSync(file, 'utf8');
  const markers = ['【' + '待填', 'TODO' + '(owner)'];
  for (const marker of markers) {
    if (text.includes(marker)) {
      hasFailed = true;
      process.stderr.write(`${path.relative(rootDir, file)}: unresolved placeholder ${marker}\n`);
    }
  }
}

if (hasFailed) process.exit(1);
process.stdout.write(`lint ok (${files.length} files checked)\n`);

function collectFiles(directory) {
  const output = [];
  for (const entry of readdirSync(directory)) {
    if (entry === 'node_modules' || entry === '.git' || entry === 'data' || entry === 'run') continue;
    const fullPath = path.join(directory, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) output.push(...collectFiles(fullPath));
    else output.push(fullPath);
  }
  return output.sort();
}
