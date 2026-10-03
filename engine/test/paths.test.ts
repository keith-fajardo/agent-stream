import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ensureDataDirs, projectPaths } from '../src/paths';

const fresh = () => projectPaths(mkdtempSync(join(tmpdir(), 'paths-')));

describe('ensureDataDirs', () => {
  it('ignores runs and sessions in a new project', () => {
    const p = fresh();
    ensureDataDirs(p);
    expect(readFileSync(join(p.dataDir, '.gitignore'), 'utf8')).toBe('runs/\nsessions/\n');
    expect(existsSync(p.sessionsDir)).toBe(true);
  });

  it('recognises runs/ and sessions/ in an existing .gitignore, including CRLF ones and one without a final newline', () => {
    for (const existing of ['runs/\nsessions/\n', 'runs/\r\nsessions/\r\n', 'sessions/\nruns/', 'runs/\nvariables.local.json\nsessions/\n']) {
      const p = fresh();
      mkdirSync(p.dataDir, { recursive: true });
      writeFileSync(join(p.dataDir, '.gitignore'), existing);
      ensureDataDirs(p);
      expect(readFileSync(join(p.dataDir, '.gitignore'), 'utf8')).toBe(existing);
    }
  });

  it('adds runs/ and sessions/ to an existing .gitignore that lacks them, keeping its lines', () => {
    for (const existing of ['graphs/tmp\n', 'graphs/tmp']) {
      const p = fresh();
      mkdirSync(p.dataDir, { recursive: true });
      writeFileSync(join(p.dataDir, '.gitignore'), existing);
      ensureDataDirs(p);
      expect(readFileSync(join(p.dataDir, '.gitignore'), 'utf8')).toBe('graphs/tmp\nruns/\nsessions/\n');
    }
  });
});
