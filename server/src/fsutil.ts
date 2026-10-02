import { randomBytes } from 'node:crypto';
import { renameSync, writeFileSync } from 'node:fs';

/** Write to a temp file, then rename, so readers never see a half-written file. */
export function writeFileAtomic(path: string, data: string): void {
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}
