import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Clock } from '../src/clock';
import type { Found } from '../src/platform';
import { ensureDataDirs, projectPaths, type ProjectPaths } from '../src/paths';

/** A found Git Bash, so command steps aren't refused on Windows (ignored elsewhere). */
export const testGitBash: Found = { ok: true, path: 'C:\\Program Files\\Git\\bin\\bash.exe' };

export function tmpProject(): ProjectPaths {
  const paths = projectPaths(mkdtempSync(join(tmpdir(), 'claude-stream-')));
  ensureDataDirs(paths);
  return paths;
}

/** A variable values file in a fresh temp folder (the file itself doesn't exist yet), so no test writes into the real home folder. */
export function tmpValuesFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'claude-stream-values-')), 'values.json');
}

export function fixedClock(start = Date.parse('2026-10-02T00:00:00.000Z')): Clock {
  let t = start;
  return () => new Date((t += 1000)).toISOString();
}
