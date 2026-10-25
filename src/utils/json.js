import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

export function toJsonLine(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export async function readJson(filePath, fallback = undefined) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return clone(fallback);
    throw error;
  }
}

export async function writeJsonAtomic(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporaryPath, toJsonLine(value), 'utf8');
  await rename(temporaryPath, filePath);
}

export function parseJsonObject(text, label) {
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} must be valid JSON: ${error.message}`);
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value;
}

const REDACTED_PLACEHOLDER = '[redacted]';

export function redactKeys(value, sensitiveKeys = []) {
  if (!sensitiveKeys.length) return value;
  const blocked = new Set(sensitiveKeys.map((key) => key.toLowerCase()));
  const walk = (input) => {
    if (Array.isArray(input)) return input.map(walk);
    if (input && typeof input === 'object') {
      return Object.fromEntries(Object.entries(input).map(([key, item]) => [
        key,
        blocked.has(key.toLowerCase()) ? REDACTED_PLACEHOLDER : walk(item),
      ]));
    }
    return input;
  };
  return walk(value);
}

// NOTE: 失败路径的负载预览脱敏：可解析时按对象脱敏，否则按 "key": value 文本形式脱敏；任何一步失败返回 null，由调用方降级为只记长度。
// NOTE(en): Redaction for rejected-write payload previews: redact as an object when parseable, otherwise redact "key": value pairs textually; any failure returns null so the caller degrades to recording only the length.
export function redactPayloadPreview(payload, sensitiveKeys = [], maxLength = 512) {
  try {
    if (typeof payload !== 'string') return null;
    const clipped = payload.length > maxLength ? payload.slice(0, maxLength) : payload;
    if (!sensitiveKeys.length) return clipped;
    try {
      return JSON.stringify(redactKeys(JSON.parse(clipped), sensitiveKeys)).slice(0, maxLength);
    } catch {
      return redactSensitivePairs(clipped, sensitiveKeys);
    }
  } catch {
    return null;
  }
}

function redactSensitivePairs(text, sensitiveKeys) {
  let result = text;
  for (const key of sensitiveKeys) {
    const pattern = new RegExp(
      `("${escapeRegExp(key)}"\\s*:\\s*)("(?:\\\\.|[^"\\\\])*"|[^,}\\]\\s]+)`,
      'gi',
    );
    result = result.replace(pattern, `$1"${REDACTED_PLACEHOLDER}"`);
  }
  return result;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
