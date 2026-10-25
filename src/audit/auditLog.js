import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

export class AuditLog {
  constructor({ dataDir }) {
    this.filePath = path.join(dataDir, 'audit.jsonl');
  }

  async append(entry) {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const line = JSON.stringify({ time: new Date().toISOString(), ...entry });
    await appendFile(this.filePath, `${line}\n`, 'utf8');
  }

  async readText() {
    try {
      return await readFile(this.filePath, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return '';
      throw error;
    }
  }
}
