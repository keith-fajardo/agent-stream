import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { builtinTools, clipResult, privateFolderDenial, privateFolderWriteDenial, readOnlyTools, toolPath, type LoopTool } from '../src/agentLoop/tools';
import { createRunShell, type RunShell, type RunShellResult } from '../src/shell';

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

  it('searches one named file up to 5 MB (a text attachment’s limit), though a folder search skips files over 2 MB', async () => {
    const cwd = project({ 'big.txt': `${'x\n'.repeat(1_500_000)}needle\n`, 'huge.txt': `${'x'.repeat(5 * 1024 * 1024)}\nneedle\n` });
    expect(await run(cwd, 'Grep', { pattern: 'needle', path: 'big.txt' })).toEqual({ text: 'big.txt:1500001: needle' });
    expect(await run(cwd, 'Grep', { pattern: 'needle', path: 'huge.txt' })).toEqual({ text: 'No matches found.' });
    expect(await run(cwd, 'Grep', { pattern: 'needle' })).toEqual({ text: 'No matches found.' });
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

describe('private Agent Stream folders', () => {
  const refusal = { text: 'That folder holds Agent Stream run records and sessions, which are private.', isError: true };
  const cwd = project({ '.agent-stream/runs/r1/run.json': 'secret', '.agent-stream/sessions/default/s.json': 'secret', 'src/a.ts': 'secret' });

  it('refuses Grep, Glob and Read there, by relative, absolute and .. paths', async () => {
    for (const path of ['.agent-stream/runs', '.agent-stream/sessions/default', 'src/../.agent-stream/runs/r1', join(cwd, '.agent-stream', 'runs')]) {
      expect(await run(cwd, 'Grep', { pattern: 'secret', path })).toEqual(refusal);
      expect(await run(cwd, 'Glob', { pattern: '**', path })).toEqual(refusal);
    }
    expect(await run(cwd, 'Read', { file_path: '.agent-stream/runs/r1/run.json' })).toEqual(refusal);
    expect(await run(cwd, 'Read', { file_path: 'src/../.agent-stream/sessions/default/s.json' })).toEqual(refusal);
    expect((await run(cwd, 'Read', { file_path: 'src/a.ts' })).isError).toBeUndefined();
  });
});

describe('limits', () => {
  it('refuses to Read a file over 2 MB', async () => {
    const cwd = project({ 'big.txt': 'x'.repeat(2 * 1024 * 1024 + 1) });
    expect(await run(cwd, 'Read', { file_path: 'big.txt' })).toEqual({ text: `${join(cwd, 'big.txt')} is larger than 2 MB; too big to read.`, isError: true });
  });

  it('stops a Grep pattern that backtracks catastrophically, at the deadline', async () => {
    const cwd = project({ 'evil.txt': `${'a'.repeat(40)}b` });
    const started = Date.now();
    const r = await find(readOnlyTools(cwd, { grepTimeoutMs: 200 }), 'Grep').run({ pattern: '(a+)+$' }, signal);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(r.isError).toBe(true);
    expect(r.text).toContain('the pattern may be too slow');
  });

  it('stops a running Grep when the signal aborts', async () => {
    const cwd = project({ 'evil.txt': `${'a'.repeat(40)}b` });
    const ac = new AbortController();
    const pending = find(readOnlyTools(cwd, { grepTimeoutMs: 60_000 }), 'Grep').run({ pattern: '(a+)+$' }, ac.signal);
    setTimeout(() => ac.abort(), 100);
    const started = Date.now();
    expect(await pending).toEqual({ text: 'Cancelled.', isError: true });
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('cancels a Glob whose signal is already aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    expect(await find(readOnlyTools(project({ 'a.ts': '' })), 'Glob').run({ pattern: '**' }, ac.signal)).toEqual({ text: 'Cancelled.', isError: true });
  });
});

describe('Glob walk limits', () => {
  const tree = () => project({ 'a.ts': '', 'b.ts': '', 'c.ts': '', 'd.ts': '', 'sub/e.ts': '' });

  it('sees a Stop that fires while the walk is under way', async () => {
    const ac = new AbortController();
    setImmediate(() => ac.abort());
    const glob = find(readOnlyTools(tree(), { globYieldEvery: 1 }), 'Glob');
    expect(await glob.run({ pattern: '**' }, ac.signal)).toEqual({ text: 'Cancelled.', isError: true });
  });

  it('stops after the entry cap and says so', async () => {
    const glob = find(readOnlyTools(tree(), { globMaxEntries: 3 }), 'Glob');
    const r = await glob.run({ pattern: '**' }, signal);
    const lines = r.text.split('\n');
    expect(lines.at(-1)).toBe('Stopped after visiting 3 entries.');
    expect(lines.length).toBe(4);
  });

  it('uses 200,000 as the default cap', async () => {
    const r = await run(project({ 'a.ts': '' }), 'Glob', { pattern: '**' });
    expect(r.text).not.toContain('Stopped after');
  });
});

describe('private folders: exceptions and edges', () => {
  const refusal = { text: 'That folder holds Agent Stream run records and sessions, which are private.', isError: true };
  const out = '.agent-stream/runs/r1/nodes/n1/output.md';
  const cwd = project({ [out]: 'upstream result', '.agent-stream/runs/r1/run.json': 'x', '.agent-stream/runs/r1/events.jsonl': 'x', '.agent-stream/sessions/default/s.json': 'x' });

  it('lets Read and a single-file Grep open an upstream output.md', async () => {
    expect(await run(cwd, 'Read', { file_path: out })).toEqual({ text: '     1\tupstream result' });
    expect(await run(cwd, 'Grep', { pattern: 'upstream', path: out })).toEqual({ text: `${join(...out.split('/'))}:1: upstream result` });
  });

  it('still refuses run.json, events.jsonl, sessions and search roots inside runs', async () => {
    for (const f of ['.agent-stream/runs/r1/run.json', '.agent-stream/runs/r1/events.jsonl', '.agent-stream/sessions/default/s.json', '.agent-stream/runs/r1/nodes/n1/other.md', '.agent-stream/runs/r1/output.md']) {
      expect(await run(cwd, 'Read', { file_path: f })).toEqual(refusal);
    }
    expect(await run(cwd, 'Grep', { pattern: 'x', path: '.agent-stream/runs/r1/run.json' })).toEqual(refusal);
    expect(await run(cwd, 'Grep', { pattern: 'x', path: '.agent-stream/runs/r1/nodes/n1' })).toEqual(refusal);
    expect(await run(cwd, 'Glob', { pattern: '**', path: '.agent-stream/runs/r1/nodes' })).toEqual(refusal);
  });

  it('refuses a missing private path without saying whether it exists', async () => {
    expect(await run(cwd, 'Read', { file_path: '.agent-stream/runs/nope/run.json' })).toEqual(refusal);
  });

  it.skipIf(process.platform !== 'win32' && process.platform !== 'darwin')('compares case-insensitively where the file system does', async () => {
    expect(await run(cwd, 'Grep', { pattern: 'x', path: '.agent-stream/RUNS' })).toEqual(refusal);
    expect(await run(cwd, 'Glob', { pattern: '**', path: '.Agent-Stream/Sessions' })).toEqual(refusal);
    expect(await run(cwd, 'Read', { file_path: '.agent-stream/RUNS/r1/run.json' })).toEqual(refusal);
  });

  it('does not claim an exact total once Glob stops collecting at 10,000', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 10_050; i++) files[`f/${i}.txt`] = '';
    const lines = (await run(project(files), 'Glob', { pattern: '**/*.txt' })).text.split('\n');
    expect(lines.at(-1)).toBe('(Showing the newest 1000 of more than 10000 files.)');
  }, 30_000);
});

/** A RunShell that records each call and answers `result`. */
function fakeShell(result: RunShellResult) {
  const calls: Parameters<RunShell>[0][] = [];
  const runShell: RunShell = async (o) => {
    calls.push(o);
    return result;
  };
  return { runShell, calls };
}
const all = (cwd: string, runShell: RunShell = fakeShell({ exitCode: 0, output: '' }).runShell) => builtinTools({ cwd, runShell, readOnly: false });
const runTool = (cwd: string, name: string, input: unknown, runShell?: RunShell, s: AbortSignal = signal) => find(all(cwd, runShell), name).run(input, s);

async function waitFor(condition: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('builtinTools', () => {
  it('offers Read, Grep, Glob, Edit, Write and Bash, each gated under its own name', () => {
    const tools = all(project());
    expect(tools.map((t) => t.spec.name)).toEqual(['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash']);
    expect(tools.map((t) => t.gateName)).toEqual(['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash']);
  });

  it('gives a read-only step only the three read tools', () => {
    const tools = builtinTools({ cwd: project(), runShell: fakeShell({ exitCode: 0, output: '' }).runShell, readOnly: true });
    expect(tools.map((t) => t.spec.name)).toEqual(['Read', 'Grep', 'Glob']);
  });
});

describe('Edit', () => {
  it('replaces a unique match, literally', async () => {
    const cwd = project({ 'a.txt': 'a = 1\nb = 2\n' });
    const file = join(cwd, 'a.txt');
    expect(await runTool(cwd, 'Edit', { file_path: 'a.txt', old_string: 'b = 2', new_string: 'b = "$&"' })).toEqual({ text: `Edited ${file} (1 replacement).` });
    expect(readFileSync(file, 'utf8')).toBe('a = 1\nb = "$&"\n');
  });

  it('refuses zero matches, and several without replace_all, saying how many', async () => {
    const cwd = project({ 'x.txt': 'x x x' });
    const file = join(cwd, 'x.txt');
    expect(await runTool(cwd, 'Edit', { file_path: 'x.txt', old_string: 'y', new_string: 'z' })).toEqual({ text: `old_string was not found in ${file}.`, isError: true });
    expect(await runTool(cwd, 'Edit', { file_path: 'x.txt', old_string: 'x', new_string: 'y' })).toEqual({
      text: `old_string was found 3 times in ${file}. Add more surrounding text to make it unique, or set replace_all.`,
      isError: true,
    });
    expect(readFileSync(file, 'utf8')).toBe('x x x');
  });

  it('replaces every match with replace_all', async () => {
    const cwd = project({ 'x.txt': 'x x x' });
    expect(await runTool(cwd, 'Edit', { file_path: 'x.txt', old_string: 'x', new_string: 'y', replace_all: true })).toEqual({ text: `Edited ${join(cwd, 'x.txt')} (3 replacements).` });
    expect(readFileSync(join(cwd, 'x.txt'), 'utf8')).toBe('y y y');
  });

  it('matches an old_string written with \\n in a CRLF file, keeping CRLF', async () => {
    const cwd = project({ 'win.txt': 'one\r\ntwo\r\nthree\r\n' });
    expect(await runTool(cwd, 'Edit', { file_path: 'win.txt', old_string: 'one\ntwo', new_string: 'uno\ndos' })).toEqual({ text: `Edited ${join(cwd, 'win.txt')} (1 replacement).` });
    expect(readFileSync(join(cwd, 'win.txt'), 'utf8')).toBe('uno\r\ndos\r\nthree\r\n');
  });

  it('refuses a missing file and an empty old_string', async () => {
    const cwd = project({ 'a.txt': 'a' });
    expect(await runTool(cwd, 'Edit', { file_path: 'nope.txt', old_string: 'a', new_string: 'b' })).toEqual({ text: `File not found: ${join(cwd, 'nope.txt')}`, isError: true });
    expect(await runTool(cwd, 'Edit', { file_path: 'a.txt', old_string: '', new_string: 'b' })).toEqual({ text: 'old_string is empty; use Write to create or replace a whole file.', isError: true });
  });
});

describe('Write', () => {
  it('creates missing folders, then writes or overwrites the file', async () => {
    const cwd = project();
    const file = join(cwd, 'a', 'b', 'c.txt');
    expect(await runTool(cwd, 'Write', { file_path: 'a/b/c.txt', content: 'hi' })).toEqual({ text: `Wrote ${file} (2 bytes).` });
    expect(readFileSync(file, 'utf8')).toBe('hi');
    await runTool(cwd, 'Write', { file_path: file, content: 'again' });
    expect(readFileSync(file, 'utf8')).toBe('again');
  });
});

describe('Write keeps the mode of an existing file', () => {
  it.skipIf(process.platform === 'win32')('a 0755 file stays 0755 after Write', async () => {
    const cwd = project({ 'run.sh': '#!/bin/sh\n' });
    const file = join(cwd, 'run.sh');
    chmodSync(file, 0o755);
    await runTool(cwd, 'Write', { file_path: 'run.sh', content: 'echo hi\n' });
    expect(readFileSync(file, 'utf8')).toBe('echo hi\n');
    expect(statSync(file).mode & 0o777).toBe(0o755);
  });
});

describe('Bash', () => {
  it('runs the command in the working folder with a 600 s timeout and reports output and exit code', async () => {
    const cwd = project();
    const shell = fakeShell({ exitCode: 2, output: 'boom\n' });
    expect(await runTool(cwd, 'Bash', { command: 'make', description: 'Build' }, shell.runShell)).toEqual({ text: 'boom\nexit code 2' });
    expect(shell.calls[0]).toMatchObject({ command: 'make', cwd, timeoutSec: 600 });
    expect(await runTool(cwd, 'Bash', { command: 'true' }, fakeShell({ exitCode: 0, output: 'ok' }).runShell)).toEqual({ text: 'ok\nexit code 0' });
    expect(await runTool(cwd, 'Bash', { command: 'true' }, fakeShell({ exitCode: 0, output: '' }).runShell)).toEqual({ text: 'exit code 0' });
  });

  it('reports a timeout, a Stop or a missing Git Bash as an error, with the output so far', async () => {
    const shell = fakeShell({ exitCode: null, output: 'partial', error: 'timed out after 600 s' });
    expect(await runTool(project(), 'Bash', { command: 'sleep 999' }, shell.runShell)).toEqual({ text: 'partial\ntimed out after 600 s', isError: true });
  });
});

describe.skipIf(process.platform === 'win32')('Bash through createRunShell', () => {
  const real = createRunShell({ shell: '/bin/sh' });

  it('returns the real output and exit code', async () => {
    expect(await runTool(project(), 'Bash', { command: 'echo hi; exit 3' }, real)).toEqual({ text: 'hi\nexit code 3' });
  });

  it('kills the command and what it started when the step is stopped', async () => {
    const cwd = project();
    const ac = new AbortController();
    const pending = runTool(cwd, 'Bash', { command: 'sleep 30 & echo $! > child.pid; wait' }, real, ac.signal);
    const pidFile = join(cwd, 'child.pid');
    await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim() !== '');
    const childPid = Number(readFileSync(pidFile, 'utf8'));
    ac.abort();
    const r = await pending;
    expect(r.isError).toBe(true);
    expect(r.text.endsWith('cancelled')).toBe(true);
    await waitFor(() => {
      try {
        process.kill(childPid, 0);
        return false;
      } catch {
        return true;
      }
    });
  });
});

describe('private folders: output.md must be a regular file (T2-1)', () => {
  const refusal = { text: 'That folder holds Agent Stream run records and sessions, which are private.', isError: true };
  const cwd = project({ '.agent-stream/runs/r1/run.json': 'secret', '.agent-stream/runs/r1/nodes/n1/z/keep.txt': 'x', '.agent-stream/runs/r1/nodes/n2/output.md/inner.txt': 'secret' });

  it('refuses a directory named output.md for Grep roots and Read', async () => {
    const dir = '.agent-stream/runs/r1/nodes/n2/output.md';
    expect(await run(cwd, 'Grep', { pattern: 'secret', path: dir })).toEqual(refusal);
    expect(await run(cwd, 'Read', { file_path: dir })).toEqual(refusal);
  });

  it('refuses an output.md/.. path that normalises to run.json, and an extra segment', async () => {
    expect(await run(cwd, 'Read', { file_path: '.agent-stream/runs/r1/nodes/n1/output.md/../run.json' })).toEqual(refusal);
    expect(await run(cwd, 'Read', { file_path: '.agent-stream/runs/r1/nodes/n1/z/output.md' })).toEqual(refusal);
  });
});

describe('fix round 1', () => {
  const refusal = { text: 'That folder holds Agent Stream run records and sessions, which are private.', isError: true };

  it.skipIf(process.platform === 'win32')('Edit keeps the file mode', async () => {
    const cwd = project({ 'run.sh': 'echo a\n' });
    chmodSync(join(cwd, 'run.sh'), 0o755);
    await runTool(cwd, 'Edit', { file_path: 'run.sh', old_string: 'a', new_string: 'b' });
    expect(statSync(join(cwd, 'run.sh')).mode & 0o777).toBe(0o755);
  });

  it('keeps CRLF when one line becomes several', async () => {
    const cwd = project({ 'w.txt': 'one\r\ntwo\r\n' });
    await runTool(cwd, 'Edit', { file_path: 'w.txt', old_string: 'one', new_string: 'a\nb' });
    expect(readFileSync(join(cwd, 'w.txt'), 'utf8')).toBe('a\r\nb\r\ntwo\r\n');
  });

  it('Edit and Write refuse private folders without reading or writing', async () => {
    const cwd = project({ '.agent-stream/runs/r1/run.json': 'x x' });
    const f = '.agent-stream/runs/r1/run.json';
    expect(await runTool(cwd, 'Edit', { file_path: f, old_string: 'x', new_string: 'y' })).toEqual(refusal);
    expect(await runTool(cwd, 'Write', { file_path: f, content: 'z' })).toEqual(refusal);
    expect(await runTool(cwd, 'Write', { file_path: '.agent-stream/sessions/new/s.json', content: 'z' })).toEqual(refusal);
    expect(readFileSync(join(cwd, f), 'utf8')).toBe('x x');
    expect(existsSync(join(cwd, '.agent-stream', 'sessions'))).toBe(false);
  });

  it('Edit refuses a binary file', async () => {
    const cwd = project({ 'b.bin': Buffer.from([97, 0, 98]) });
    expect(await runTool(cwd, 'Edit', { file_path: 'b.bin', old_string: 'a', new_string: 'c' })).toEqual({ text: `${join(cwd, 'b.bin')} is a binary file.`, isError: true });
  });

  it.skipIf(process.platform === 'win32')('refuses a symlink named output.md', async () => {
    const cwd = project({ '.agent-stream/runs/r1/run.json': 'secret' });
    const dir = join(cwd, '.agent-stream', 'runs', 'r1', 'nodes', 'n1');
    mkdirSync(dir, { recursive: true });
    symlinkSync(join(cwd, '.agent-stream', 'runs', 'r1', 'run.json'), join(dir, 'output.md'));
    expect(await run(cwd, 'Read', { file_path: '.agent-stream/runs/r1/nodes/n1/output.md' })).toEqual(refusal);
  });
});

describe('privateFolderWriteDenial', () => {
  it('refuses writes to an existing upstream output.md that privateFolderDenial lets a step read', () => {
    const cwd = project({ '.agent-stream/runs/r1/nodes/n1/output.md': 'x' });
    const out = join(cwd, '.agent-stream', 'runs', 'r1', 'nodes', 'n1', 'output.md');
    expect(privateFolderDenial(out)).toBeNull();
    expect(privateFolderWriteDenial(out)).toMatch(/run records and sessions/);
    expect(privateFolderWriteDenial(join(cwd, '.agent-stream', 'sessions', 's1.json'))).not.toBeNull();
    expect(privateFolderWriteDenial(join(cwd, 'src', 'a.ts'))).toBeNull();
  });
});
