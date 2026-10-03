import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, parse, relative, resolve, sep } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { privatePathDenial } from '../src/privatePaths';

// resolve (not join) so the paths carry the current drive on Windows, as the code under test does.
const root = resolve('/', 'work', 'proj');
const values = resolve('/', 'home', 'me', '.claude-stream', 'values', '0123456789abcdef.json');
const reason = "Variable values are private to this machine; claude-stream doesn't let Claude read the variable values file.";

const runReason = "Run records contain variable values; claude-stream doesn't let Claude read .claude-stream/runs/*/run.json or events.jsonl.";

describe('privatePathDenial for searches of run folders', () => {
  it('denies Grep over the runs folder but allows output.md and Glob', () => {
    expect(privatePathDenial(root, 'Grep', { pattern: 'x', path: '.claude-stream/runs' })).toBe(runReason);
    expect(privatePathDenial(root, 'Grep', { pattern: 'x', path: '.claude-stream/runs/20261002-000000-abcd' })).toBe(runReason);
    expect(privatePathDenial(root, 'Grep', { pattern: 'x', path: '.claude-stream/runs/20261002-000000-abcd/nodes/n1/output.md' })).toBeNull();
    expect(privatePathDenial(root, 'Glob', { pattern: '*', path: '.claude-stream/runs' })).toBeNull();
    expect(privatePathDenial(root, 'Grep', { pattern: 'x', path: '.claude-stream/runsx' })).toBeNull();
  });
});

describe('privatePathDenial', () => {
  it('denies run records with rendered values, but not outputs', () => {
    const run = join(root, '.claude-stream', 'runs', '20261002-000000-abcd');
    expect(privatePathDenial(root, 'Read', { file_path: '.claude-stream/runs/20261002-000000-abcd/run.json' })).toBe(runReason);
    expect(privatePathDenial(root, 'Read', { file_path: join(run, 'nodes', 'n1', 'events.jsonl') })).toBe(runReason);
    expect(privatePathDenial(root, 'Grep', { pattern: 'x', path: join(run, 'run.json') })).toBe(runReason);
    expect(privatePathDenial(root, 'Glob', { pattern: '*', path: join(run, 'nodes', 'n1', 'events.jsonl') })).toBe(runReason);
    expect(privatePathDenial(root, 'Read', { file_path: join(run, 'nodes', 'n1', 'output.md') })).toBeNull();
    expect(privatePathDenial(root, 'Read', { file_path: 'run.json' })).toBeNull();
    expect(privatePathDenial(root, 'Read', { file_path: 'docs/runs/x/run.json' })).toBeNull();
  });

  it('denies reading the values file by absolute, relative or roundabout path', () => {
    expect(privatePathDenial(root, 'Read', { file_path: values }, [values])).toBe(reason);
    expect(privatePathDenial(root, 'Read', { file_path: relative(root, values) }, [values])).toBe(reason);
    expect(privatePathDenial(root, 'Read', { file_path: [dirname(values), '..', 'values', basename(values)].join(sep) }, [values])).toBe(reason);
    if (process.platform === 'win32') expect(privatePathDenial(root, 'Read', { file_path: values.toUpperCase() }, [values])).toBe(reason);
  });
  it('expands ~ to the home folder like Claude Code does', () => {
    const inHome = join(homedir(), '.claude-stream', 'values', '0123456789abcdef.json');
    expect(privatePathDenial(root, 'Read', { file_path: '~/.claude-stream/values/0123456789abcdef.json' }, [inHome])).toBe(reason);
    expect(privatePathDenial(root, 'Read', { file_path: '~other/.claude-stream/values/0123456789abcdef.json' }, [inHome])).toBeNull();
  });
  it('allows the values file when it is not named private, and other files', () => {
    expect(privatePathDenial(root, 'Read', { file_path: values })).toBeNull();
    expect(privatePathDenial(root, 'Read', { file_path: join(dirname(values), 'fedcba9876543210.json') }, [values])).toBeNull();
    expect(privatePathDenial(root, 'Read', { file_path: '.claude-stream/graphs/a.json' }, [values])).toBeNull();
    expect(privatePathDenial(root, 'Read', { file_path: 'models/a.sql' }, [values])).toBeNull();
  });
  it('no longer treats .claude-stream/variables.local.json in the project as special', () => {
    expect(privatePathDenial(root, 'Read', { file_path: '.claude-stream/variables.local.json' }, [values])).toBeNull();
    expect(privatePathDenial(root, 'Read', { file_path: join(root, '.claude-stream', 'variables.local.json') }, [values])).toBeNull();
  });
  it('checks the path of Glob and Grep', () => {
    expect(privatePathDenial(root, 'Grep', { pattern: 'x', path: values }, [values])).toBe(reason);
    expect(privatePathDenial(root, 'Glob', { pattern: '*', path: values }, [values])).toBe(reason);
    expect(privatePathDenial(root, 'Grep', { pattern: 'x', path: '.claude-stream' }, [values])).toBeNull();
    expect(privatePathDenial(root, 'Grep', { pattern: 'x' }, [values])).toBeNull();
  });
  it('denies Grep and Glob over the values folder, anything inside it, and every folder above it', () => {
    const valuesDir = dirname(values);
    for (const path of [valuesDir, join(valuesDir, 'sub'), dirname(valuesDir), resolve('/', 'home', 'me'), parse(values).root, relative(root, valuesDir)]) {
      expect(privatePathDenial(root, 'Grep', { pattern: 'x', path, glob: '*' }, [values])).toBe(reason);
      expect(privatePathDenial(root, 'Glob', { pattern: '**/*', path }, [values])).toBe(reason);
    }
    expect(privatePathDenial(root, 'Grep', { pattern: 'x', path: '..' }, [join(root, '..', 'secret', 'v.json')])).toBe(reason);
  });
  it('denies Grep and Glob over ~, ~/.claude-stream and ~/.claude-stream/values', () => {
    const inHome = join(homedir(), '.claude-stream', 'values', '0123456789abcdef.json');
    for (const path of ['~/.claude-stream/values', '~/.claude-stream', '~', '~/', parse(homedir()).root]) {
      expect(privatePathDenial(root, 'Grep', { pattern: 'x', path }, [inHome])).toBe(reason);
    }
    expect(privatePathDenial(root, 'Glob', { pattern: '**/*.json', path: '~' }, [inHome])).toBe(reason);
  });
  it('allows searches of unrelated folders and reads of other files near the values file', () => {
    const valuesDir = dirname(values);
    for (const path of [join(root, 'src'), 'src', root, `${valuesDir}x`, resolve('/', 'home', 'other'), join(dirname(valuesDir), 'graphs')]) {
      expect(privatePathDenial(root, 'Grep', { pattern: 'x', path }, [values])).toBeNull();
      expect(privatePathDenial(root, 'Glob', { pattern: '*', path }, [values])).toBeNull();
    }
    expect(privatePathDenial(root, 'Grep', { pattern: 'x', glob: '*' }, [values])).toBeNull();
    for (const file_path of [join(valuesDir, 'fedcba9876543210.json'), valuesDir, dirname(valuesDir), '/']) {
      expect(privatePathDenial(root, 'Read', { file_path }, [values])).toBeNull();
    }
  });
  describe('a Grep or Glob without a path searches the project folder', () => {
    const made: string[] = [];
    const tempDir = () => {
      const dir = mkdtempSync(join(tmpdir(), 'cs-private-'));
      made.push(dir);
      return dir;
    };
    afterEach(() => {
      for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
    });

    it('denies it when the project folder holds the values file (a home folder opened as the workspace)', () => {
      const home = tempDir();
      const file = join(home, '.claude-stream', 'values', 'x.json');
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, '{}');
      expect(privatePathDenial(home, 'Grep', { pattern: 'x' }, [file])).toBe(reason);
      expect(privatePathDenial(home, 'Glob', { pattern: '**/*.json' }, [file])).toBe(reason);
      expect(privatePathDenial(home, 'Grep', { pattern: 'x', path: '' }, [file])).toBe(reason);
    });

    it('allows it in an unrelated folder', () => {
      const file = join(tempDir(), '.claude-stream', 'values', 'x.json');
      expect(privatePathDenial(tempDir(), 'Grep', { pattern: 'x' }, [file])).toBeNull();
    });
  });

  it('ignores other tools and odd input', () => {
    expect(privatePathDenial(root, 'Bash', { command: `cat ${values}` }, [values])).toBeNull();
    expect(privatePathDenial(root, 'Read', null, [values])).toBeNull();
    expect(privatePathDenial(root, 'Read', { file_path: 3 }, [values])).toBeNull();
  });
});
