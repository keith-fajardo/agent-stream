import { mkdirSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { writeFileAtomic } from '../src/fsutil';

describe('writeFileAtomic', () => {
  it('removes its temp file and rethrows when the rename fails', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fsutil-'));
    const target = join(dir, 'target');
    mkdirSync(target);
    expect(() => writeFileAtomic(target, 'secret', 0o600)).toThrow();
    expect(readdirSync(dir)).toEqual(['target']);
  });
});
