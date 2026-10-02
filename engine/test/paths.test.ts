import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ensureDataDirs, projectPaths } from '../src/paths';

const fresh = () => projectPaths(mkdtempSync(join(tmpdir(), 'paths-')));

describe('ensureDataDirs', () => {
  it('ignores runs and local variable values in a new project', () => {
    const p = fresh();
    ensureDataDirs(p);
    expect(readFileSync(join(p.dataDir, '.gitignore'), 'utf8')).toBe('runs/\nvariables.local.json\n');
  });

  it('adds only the missing line to an existing .gitignore, including CRLF ones', () => {
    for (const existing of ['runs/\n', 'runs/\r\n', 'runs/']) {
      const p = fresh();
      mkdirSync(p.dataDir, { recursive: true });
      writeFileSync(join(p.dataDir, '.gitignore'), existing);
      ensureDataDirs(p);
      const sep = existing.endsWith('\n') ? '' : '\n';
      expect(readFileSync(join(p.dataDir, '.gitignore'), 'utf8')).toBe(`${existing}${sep}variables.local.json\n`);
      ensureDataDirs(p);
      expect(readFileSync(join(p.dataDir, '.gitignore'), 'utf8')).toBe(`${existing}${sep}variables.local.json\n`);
    }
  });
});
