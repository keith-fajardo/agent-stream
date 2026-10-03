import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { clipResult, readOnlyTools, toolPath, type LoopTool } from '../src/agentLoop/tools';

const signal = new AbortController().signal;

/** A temp folder holding `files` ('/'-separated relative paths). */
function project(files: Record<string, string | Buffer> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'loop-tools-'));
  for (const [rel, content] of Object.entries(files)) {
    const file = join(root, ...rel.split('/'));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  return root;
}
const find = (tools: LoopTool[], name: string) => tools.find((t) => t.spec.name === name)!;
const run = (cwd: string, name: string, input: unknown) => find(readOnlyTools(cwd), name).run(input, signal);

describe('readOnlyTools', () => {
  it('are Read, Grep and Glob, each gated under its own name, with JSON Schema inputs', () => {
    const tools = readOnlyTools(project());
    expect(tools.map((t) => t.spec.name)).toEqual(['Read', 'Grep', 'Glob']);
    expect(tools.map((t) => t.gateName)).toEqual(['Read', 'Grep', 'Glob']);
    for (const t of tools) expect(t.spec.inputSchema).toMatchObject({ type: 'object' });
  });

  it('expands ~ to the home folder and resolves anything else against the working folder', () => {
    const cwd = project();
    expect(toolPath(cwd, '~/notes.txt')).toBe(join(homedir(), 'notes.txt'));
    expect(toolPath(cwd, 'src/a.ts')).toBe(join(cwd, 'src', 'a.ts'));
  });

  it('returns a bad input as an error with the validation message', async () => {
    const r = await run(project(), 'Read', { file_path: 42 });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('file_path');
  });

  it('keeps the head and tail of a long result (30,000 characters)', async () => {
    expect(clipResult(`${'a'.repeat(10)}${'b'.repeat(10)}`, 10)).toBe('aaaaa\n…[truncated 10 chars]\nbbbbb');
    const cwd = project({ 'long.txt': Array.from({ length: 2000 }, () => 'x'.repeat(20)).join('\n') });
    const r = await run(cwd, 'Read', { file_path: 'long.txt' });
    expect(r.text.startsWith(`     1\t${'x'.repeat(20)}`)).toBe(true);
    expect(r.text).toContain('…[truncated ');
    expect(r.text.endsWith(`  2000\t${'x'.repeat(20)}`)).toBe(true);
  });
});

describe('Read', () => {
  it('numbers the lines from 1', async () => {
    const cwd = project({ 'a.txt': 'alpha\nbeta\ngamma\n' });
    expect(await run(cwd, 'Read', { file_path: 'a.txt' })).toEqual({ text: '     1\talpha\n     2\tbeta\n     3\tgamma' });
  });

  it('starts at offset and reads limit lines, by absolute path too', async () => {
    const cwd = project({ 'a.txt': 'alpha\nbeta\ngamma\n' });
    expect(await run(cwd, 'Read', { file_path: join(cwd, 'a.txt'), offset: 2, limit: 1 })).toEqual({ text: '     2\tbeta' });
    expect(await run(cwd, 'Read', { file_path: 'a.txt', offset: 10 })).toEqual({ text: 'The file has 3 lines; offset 10 is past the end.', isError: true });
  });

  it('reads 2000 lines by default and cuts a line longer than 2000 characters', async () => {
    const cwd = project({ 'many.txt': Array.from({ length: 2500 }, (_, i) => String(i + 1)).join('\n'), 'wide.txt': 'y'.repeat(2100) });
    const many = (await run(cwd, 'Read', { file_path: 'many.txt' })).text.split('\n');
    expect(many).toHaveLength(2000);
    expect(many.at(-1)).toBe('  2000\t2000');
    expect(await run(cwd, 'Read', { file_path: 'wide.txt' })).toEqual({ text: `     1\t${'y'.repeat(2000)}…` });
  });

  it('reports a missing file, a folder and an empty file', async () => {
    const cwd = project({ 'src/a.ts': '', 'empty.txt': '' });
    expect(await run(cwd, 'Read', { file_path: 'nope.txt' })).toEqual({ text: `File not found: ${join(cwd, 'nope.txt')}`, isError: true });
    expect(await run(cwd, 'Read', { file_path: 'src' })).toEqual({ text: `${join(cwd, 'src')} is a folder, not a file. Use Glob to list it.`, isError: true });
    expect(await run(cwd, 'Read', { file_path: 'empty.txt' })).toEqual({ text: '(The file is empty.)' });
  });

  it('refuses a binary file', async () => {
    const cwd = project({ 'logo.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]) });
    expect(await run(cwd, 'Read', { file_path: 'logo.png' })).toEqual({ text: `${join(cwd, 'logo.png')} is a binary file.`, isError: true });
  });
});

describe('Glob', () => {
  it('matches relative paths newest first, skipping .git, node_modules and Agent Stream runs and sessions', async () => {
    const cwd = project({
      'src/old.ts': '',
      'src/new.ts': '',
      'src/deep/mid.ts': '',
      'README.md': '',
      '.git/hooks/x.ts': '',
      'node_modules/pkg/index.ts': '',
      '.agent-stream/runs/r1/out.ts': '',
      '.agent-stream/sessions/default/s.ts': '',
      '.agent-stream/graphs/g.ts': '',
    });
    utimesSync(join(cwd, 'src', 'old.ts'), 1_000, 1_000);
    utimesSync(join(cwd, 'src', 'deep', 'mid.ts'), 2_000, 2_000);
    utimesSync(join(cwd, 'src', 'new.ts'), 3_000, 3_000);
    utimesSync(join(cwd, '.agent-stream', 'graphs', 'g.ts'), 500, 500);
    expect(await run(cwd, 'Glob', { pattern: '**/*.ts' })).toEqual({
      text: [join('src', 'new.ts'), join('src', 'deep', 'mid.ts'), join('src', 'old.ts'), join('.agent-stream', 'graphs', 'g.ts')].join('\n'),
    });
  });

  it('searches under path, still naming files relative to the working folder', async () => {
    const cwd = project({ 'src/a.ts': '', 'src/deep/b.ts': '', 'c.ts': '' });
    utimesSync(join(cwd, 'src', 'a.ts'), 1_000, 1_000);
    expect(await run(cwd, 'Glob', { pattern: '*.ts', path: 'src' })).toEqual({ text: join('src', 'a.ts') });
  });

  it('says when nothing matches or the folder is missing', async () => {
    const cwd = project({ 'a.md': '' });
    expect(await run(cwd, 'Glob', { pattern: '**/*.ts' })).toEqual({ text: 'No files found.' });
    expect(await run(cwd, 'Glob', { pattern: '*', path: 'nope' })).toEqual({ text: `Folder not found: ${join(cwd, 'nope')}`, isError: true });
  });

  it('lists at most 1000 files', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 1003; i++) files[`f/${i}.txt`] = '';
    const lines = (await run(project(files), 'Glob', { pattern: '**/*.txt' })).text.split('\n');
    expect(lines).toHaveLength(1001);
    expect(lines.at(-1)).toBe('(Showing the newest 1000 of 1003 files.)');
  });
});

describe('Grep', () => {
  it('reports file:line: text for each matching line', async () => {
    const cwd = project({ 'src/a.ts': 'const x = 1;\nexport const y = 2;\n', 'src/b.js': 'export default 3;\n', 'notes.md': 'nothing' });
    expect(await run(cwd, 'Grep', { pattern: '^export' })).toEqual({
      text: [`${join('src', 'a.ts')}:2: export const y = 2;`, `${join('src', 'b.js')}:1: export default 3;`].join('\n'),
    });
  });

  it('filters files by a name glob or a path glob', async () => {
    const cwd = project({ 'src/a.ts': 'export a', 'src/lib/b.js': 'export b', 'c.ts': 'export c' });
    expect((await run(cwd, 'Grep', { pattern: 'export', glob: '*.ts' })).text).toBe([`${join('c.ts')}:1: export c`, `${join('src', 'a.ts')}:1: export a`].join('\n'));
    expect((await run(cwd, 'Grep', { pattern: 'export', glob: 'src/**/*.js' })).text).toBe(`${join('src', 'lib', 'b.js')}:1: export b`);
  });

  it('skips binary files, files over 2 MB and the skipped folders', async () => {
    const cwd = project({
      'bin.dat': Buffer.concat([Buffer.from('export\n'), Buffer.from([0])]),
      'big.txt': `export\n${'x'.repeat(2 * 1024 * 1024)}`,
      'node_modules/m.ts': 'export',
      '.git/config': 'export',
      '.agent-stream/runs/r1/run.json': 'export',
      'ok.ts': 'export',
    });
    expect(await run(cwd, 'Grep', { pattern: 'export' })).toEqual({ text: 'ok.ts:1: export' });
  });

  it('stops after 500 matches and cuts long lines', async () => {
    const cwd = project({ 'hits.txt': Array.from({ length: 600 }, () => 'hit').join('\n'), 'wide.txt': `hot ${'z'.repeat(600)}` });
    const lines = (await run(cwd, 'Grep', { pattern: 'hit' })).text.split('\n');
    expect(lines).toHaveLength(501);
    expect(lines.at(-1)).toBe('(Stopped after 500 matches.)');
    expect((await run(cwd, 'Grep', { pattern: 'hot' })).text).toBe(`wide.txt:1: hot ${'z'.repeat(496)}…`);
  });

  it('searches one file, and reports no match, a bad pattern and a missing path', async () => {
    const cwd = project({ 'src/a.ts': 'const x = 1;\nexport const y = 2;\n' });
    expect(await run(cwd, 'Grep', { pattern: 'y', path: 'src/a.ts' })).toEqual({ text: `${join('src', 'a.ts')}:2: export const y = 2;` });
    expect(await run(cwd, 'Grep', { pattern: 'nowhere' })).toEqual({ text: 'No matches found.' });
    const bad = await run(cwd, 'Grep', { pattern: '(' });
    expect(bad.isError).toBe(true);
    expect(bad.text.startsWith('Invalid regular expression:')).toBe(true);
    expect(await run(cwd, 'Grep', { pattern: 'x', path: 'nope' })).toEqual({ text: `Not found: ${join(cwd, 'nope')}`, isError: true });
  });
});
