import { describe, expect, it } from 'vitest';
import { globToRegExp } from '../src/agentLoop/glob';

const matches = (pattern: string, path: string) => globToRegExp(pattern).test(path);

describe('globToRegExp', () => {
  it('matches * and ? within one name only', () => {
    expect(matches('src/*.ts', 'src/a.ts')).toBe(true);
    expect(matches('src/*.ts', 'src/x/a.ts')).toBe(false);
    expect(matches('*.ts', 'a.tsx')).toBe(false);
    expect(matches('?.md', 'a.md')).toBe(true);
    expect(matches('?.md', 'ab.md')).toBe(false);
    expect(matches('?.md', '/.md')).toBe(false);
  });

  it('matches ** across any number of folders, including none', () => {
    expect(matches('**/*.ts', 'a.ts')).toBe(true);
    expect(matches('**/*.ts', 'src/x/y.ts')).toBe(true);
    expect(matches('docs/**/README.md', 'docs/README.md')).toBe(true);
    expect(matches('docs/**/README.md', 'docs/a/b/README.md')).toBe(true);
    expect(matches('src/**', 'src/a/b.ts')).toBe(true);
    expect(matches('**', 'anything/at/all')).toBe(true);
    expect(matches('**/*.ts', 'src/a.js')).toBe(false);
  });

  it('matches {a,b} alternatives, nested globs included', () => {
    expect(matches('*.{ts,tsx}', 'a.ts')).toBe(true);
    expect(matches('*.{ts,tsx}', 'a.tsx')).toBe(true);
    expect(matches('*.{ts,tsx}', 'a.js')).toBe(false);
    expect(matches('{src,test}/**/*.ts', 'test/x/a.ts')).toBe(true);
    expect(matches('{src/*.ts,*.md}', 'README.md')).toBe(true);
  });

  it('matches [abc] and [!abc] classes', () => {
    expect(matches('file[12].txt', 'file1.txt')).toBe(true);
    expect(matches('file[12].txt', 'file3.txt')).toBe(false);
    expect(matches('file[!12].txt', 'file3.txt')).toBe(true);
    expect(matches('file[a-c].txt', 'fileb.txt')).toBe(true);
  });

  it('treats other characters literally', () => {
    expect(matches('a.b', 'aXb')).toBe(false);
    expect(matches('a+(b).ts', 'a+(b).ts')).toBe(true);
    expect(matches('price$.txt', 'price$.txt')).toBe(true);
  });

  it('reads a backslash as a Windows separator', () => {
    expect(matches('src\\**\\*.ts', 'src/a/b.ts')).toBe(true);
    expect(matches('src\\**\\*.ts', 'src/b.ts')).toBe(true);
    expect(matches('src\\*.ts', 'src/a/b.ts')).toBe(false);
  });
});
