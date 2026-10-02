import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

/** Write to a temp file (created with `mode`, if given), then rename, so readers never see a half-written file. */
export function writeFileAtomic(path: string, data: string, mode?: number): void {
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  writeFileSync(tmp, data, mode === undefined ? undefined : { mode });
  renameSync(tmp, path);
}

/**
 * Read a JSON-lines file: [] when it is missing, and lines that do not parse (a torn final
 * write, merge-conflict markers in a committed log) are skipped.
 */
export function readJsonLines<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  const out: T[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      // skip
    }
  }
  return out;
}
