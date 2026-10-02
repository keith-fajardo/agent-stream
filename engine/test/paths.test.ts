import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ensureDataDirs, projectPaths } from '../src/paths';

const fresh = () => projectPaths(mkdtempSync(join(tmpdir(), 'paths-')));

describe('ensureDataDirs', () => {
  it('ignores runs in a new project', () => {
    const p = fresh();
    ensureDataDirs(p);
    expect(readFileSync(join(p.dataDir, '.gitignore'), 'utf8')).toBe('runs/\n');
  });

  it('recognises runs/ in an existing .gitignore, including CRLF ones and one without a final newline', () => {
    for (const existing of ['runs/\n', 'runs/\r\n', 'runs/', 'runs/\nvariables.local.json\n']) {
      const p = fresh();
      mkdirSync(p.dataDir, { recursive: true });
      writeFileSync(join(p.dataDir, '.gitignore'), existing);
      ensureDataDirs(p);
      expect(readFileSync(join(p.dataDir, '.gitignore'), 'utf8')).toBe(existing);
    }
  });

  it('adds runs/ to an existing .gitignore that lacks it', () => {
    for (const existing of ['graphs/tmp\n', 'graphs/tmp']) {
      const p = fresh();
      mkdirSync(p.dataDir, { recursive: true });
      writeFileSync(join(p.dataDir, '.gitignore'), existing);
      ensureDataDirs(p);
      expect(readFileSync(join(p.dataDir, '.gitignore'), 'utf8')).toBe('graphs/tmp\nruns/\n');
    }
  });
});
