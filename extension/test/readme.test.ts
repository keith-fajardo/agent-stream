import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '../..');
const readmes = [join(root, 'README.md'), join(root, 'extension/README.md')];
const headings = (text: string) => [...text.matchAll(/^## (.+)$/gm)].map((m) => m[1]);

describe('READMEs', () => {
  it('links only to docs that exist, from both READMEs', () => {
    for (const path of readmes) {
      const text = readFileSync(path, 'utf8');
      for (const [, link] of text.matchAll(/\]\((?:https:\/\/github\.com\/keith-fajardo\/agent-stream\/blob\/main\/|\.\.\/|\.\/)?(docs\/[^)#\s]+)\)/g)) {
        expect(existsSync(join(root, link)), `${path} links to ${link}`).toBe(true);
      }
    }
  });

  it('keeps the same top-level sections in both READMEs, apart from Install and Development', () => {
    const [a, b] = readmes.map((p) => headings(readFileSync(p, 'utf8')).filter((h) => !['Install', 'Development'].includes(h)));
    expect(a).toEqual(b);
  });

  it('opens with what Agent Stream is and its use cases', () => {
    const text = readFileSync(readmes[0], 'utf8');
    expect(headings(text).slice(0, 3)).toEqual(['What Agent Stream is', 'Use cases', expect.any(String)]);
  });
});
