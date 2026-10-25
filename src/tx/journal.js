import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

// NOTE: journal 只接受已定义事件类型，未知事件直接拒绝，保证证据链可枚举、可审计。
// NOTE(en): The journal accepts only defined event types; unknown events are rejected so the evidence chain stays enumerable and auditable.
const EVENTS = new Set([
  'commit_begin',
  'commit_success',
  'commit_rolled_back',
  'rollback_begin',
  'rollback_success',
  'rollback_restored',
  'rollback_failed',
  'snapshot_created',
  'snapshot_evicted',
  'snapshot_evict_failed',
]);

export class Journal {
  constructor({ dataDir }) {
    this.filePath = path.join(dataDir, 'journal.jsonl');
  }

  async append(entry) {
    if (!EVENTS.has(entry?.event)) {
      throw new Error(`Unknown journal event: ${entry?.event ?? '(missing)'}`);
    }
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const line = JSON.stringify({ time: new Date().toISOString(), ...entry });
    await appendFile(this.filePath, `${line}\n`, 'utf8');
  }
}
