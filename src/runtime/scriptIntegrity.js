import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

export async function computeScriptSha256(scriptPath) {
  const content = await readFile(scriptPath);
  return createHash('sha256').update(content).digest('hex');
}

// NOTE: 校验失败与计算失败统一按不匹配处理（故障关闭）；错误消息不含脚本路径与 hash 值，因为 lastError 会经 status 进入 9P 命名空间。
// NOTE(en): Verification and computation failures are both treated as mismatch (fail closed); error messages carry no script path or hash values, since lastError reaches the 9P namespace via status.
export async function verifyScriptIntegrity({ serviceId, scriptPath, expectedSha256 }) {
  let actualSha256 = null;
  try {
    actualSha256 = await computeScriptSha256(scriptPath);
  } catch {
    actualSha256 = null;
  }
  if (!actualSha256 || actualSha256 !== expectedSha256) {
    throw new Error(`script integrity check failed for service ${serviceId}`);
  }
}
