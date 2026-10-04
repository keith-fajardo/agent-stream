import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createPlannerGate } from '../src/providers/toolGate';
import { classifyCommand, pathPrivacy, shellWords, type CommandClass } from '../src/providers/codex/readOnlyCommand';
import type { CommandAction } from '../src/providers/codex/protocol';
import { approvalParams } from './codexFake';

// resolve (not join) so the paths carry the current drive on Windows, as the code under test does.
const cwd = resolve('/', 'work', 'proj');
const values = resolve('/', 'h', '.agent-stream', 'values', 'abc.json');
/** The platform whose path rules match this machine's absolute paths (backslashes on Windows). */
const host: NodeJS.Platform = process.platform === 'win32' ? 'win32' : 'linux';
const VALUES_REASON = "Variable values are private to this machine; Agent Stream doesn't let Claude read the variable values file.";
const RUN_REASON = "Run records contain variable values; Agent Stream doesn't let Claude read .agent-stream/runs/*/run.json or events.jsonl.";
const PRIVATE_FOLDER = 'That folder holds Agent Stream run records and sessions, which are private.';

const privacyFor = (dir: string) => pathPrivacy(createPlannerGate({ projectDir: dir, privateFiles: [values], graphToolNames: new Set() }));
const zsh = (script: string) => `/bin/zsh -lc '${script}'`;
const read = (script: string, file = 'notes.txt', dir = cwd): CommandAction[] => [{ type: 'read', command: script, name: file, path: resolve(dir, file) }];
const search = (script: string): CommandAction[] => [{ type: 'search', command: script, query: null, path: null }];

function classify(command: string, actions: CommandAction[] | null, o: { platform?: NodeJS.Platform; kind?: 'command' | 'writeStdin'; extra?: object; dir?: string } = {}): CommandClass {
  const dir = o.dir ?? cwd;
  return classifyCommand(approvalParams({ command, cwd: dir, actions, kind: o.kind, extra: o.extra }), { cwd: dir, platform: o.platform ?? 'linux', privacy: privacyFor(dir) });
}
const kindOf = (script: string, actions: CommandAction[] = read(script)) => classify(zsh(script), actions).kind;

describe('shellWords', () => {
  it('splits words, honouring single and double quotes', () => {
    expect(shellWords(`cat 'a b' "c d" e`, 'linux')).toEqual(['cat', 'a b', 'c d', 'e']);
    expect(shellWords('  ls   -la  ', 'linux')).toEqual(['ls', '-la']);
    expect(shellWords(`cat ''`, 'linux')).toEqual(['cat', '']);
  });

  it('gives up on an unbalanced quote, and on a backslash outside Windows', () => {
    expect(shellWords(`cat 'a`, 'linux')).toBeNull();
    expect(shellWords('cat a\\ b', 'linux')).toBeNull();
    expect(shellWords('cat "a\\"b"', 'linux')).toBeNull();
    expect(shellWords('cat src\\a.txt', 'win32')).toEqual(['cat', 'src\\a.txt']);
  });
});

describe('classifyCommand', () => {
  it('lets plain reads and searches run without asking', () => {
    for (const s of ['cat notes.txt', 'head -n 5 notes.txt', 'tail -n 20 notes.txt', 'wc -l notes.txt', 'nl notes.txt', 'stat notes.txt', 'sed -n 1,20p notes.txt', 'sed -n 3p notes.txt']) {
      expect(kindOf(s), s).toBe('readOnly');
    }
    for (const s of ['ls', 'ls -la src', 'pwd', 'find src -name a.ts', 'rg foo .', 'rg -n foo src', 'grep -n foo notes.txt']) expect(kindOf(s, search(s)), s).toBe('readOnly');
    // Unwrapped, or wrapped by another POSIX shell.
    expect(classify('cat notes.txt', read('cat notes.txt')).kind).toBe('readOnly');
    expect(classify(`/bin/bash -c 'cat notes.txt'`, read('cat notes.txt')).kind).toBe('readOnly');
    expect(classify('cat src\\a.txt', read('cat src\\a.txt', 'src/a.txt'), { platform: 'win32' }).kind).toBe('readOnly');
  });

  it("declines a private path Codex names without asking, whatever the action or the command around it", () => {
    expect(classify(zsh('cat .agent-stream/runs/r1/run.json'), read('cat .agent-stream/runs/r1/run.json', '.agent-stream/runs/r1/run.json'))).toEqual({ kind: 'private', reason: RUN_REASON });
    expect(classify(zsh(`cat ${values} | head`), read(`cat ${values}`, values))).toEqual({ kind: 'private', reason: VALUES_REASON });
    expect(classify(zsh('ls .agent-stream/runs'), [{ type: 'listFiles', command: 'ls .agent-stream/runs', path: '.agent-stream/runs' }])).toEqual({ kind: 'private', reason: RUN_REASON });
    expect(classify(zsh('cat .agent-stream/sessions/s1/session.json'), [{ type: 'unknown', command: 'cat .agent-stream/sessions/s1/session.json' }])).toEqual({ kind: 'private', reason: PRIVATE_FOLDER });
  });

  it("lets a step read its upstream output.md, which is a regular file", () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-ro-'));
    mkdirSync(join(dir, '.agent-stream', 'runs', 'r1', 'nodes', 'n1'), { recursive: true });
    writeFileSync(join(dir, '.agent-stream', 'runs', 'r1', 'nodes', 'n1', 'output.md'), 'done');
    const s = 'cat .agent-stream/runs/r1/nodes/n1/output.md';
    expect(classify(zsh(s), read(s, '.agent-stream/runs/r1/nodes/n1/output.md', dir), { dir }).kind).toBe('readOnly');
  });

  it('checks every operand, not only the parsed path', () => {
    expect(classify(zsh('cat notes.txt .agent-stream/runs/r1/run.json'), read('cat notes.txt .agent-stream/runs/r1/run.json'))).toEqual({ kind: 'private', reason: RUN_REASON });
    expect(classify(zsh(`cat notes.txt ${values}`), read(`cat notes.txt ${values}`), { platform: host })).toEqual({ kind: 'private', reason: VALUES_REASON });
    expect(classify(zsh('rg secret .agent-stream/sessions'), search('rg secret .agent-stream/sessions'))).toEqual({ kind: 'private', reason: PRIVATE_FOLDER });
  });

  it('asks when the shell could open other files than the words say', () => {
    for (const s of [
      'cat $HOME/.agent-stream/values/x.json',
      'cat ~/.agent-stream/values/x.json',
      'cat .agent-stream/run*/r1/run.json',
      'cat .agent-stream/run?/r1/run.json',
      'cat .agent-stream/{runs,x}/r1/run.json',
      'cat .agent-stream/[r]uns/r1/run.json',
      'cat .agent-stream/run\\s/r1/run.json',
      'cat notes.txt(e:x:)',
      'cat notes.txt; cat other.txt',
      'cat notes.txt && cat other.txt',
      'cat notes.txt | head',
      'cat < notes.txt',
      'cat `echo notes.txt`',
      'cat %USERPROFILE%',
      'cat !$',
      'cat notes.txt\ncat other.txt',
      'cat =ls',
      'LD_PRELOAD=x.so cat notes.txt',
      './cat notes.txt',
      '/bin/cat notes.txt',
    ]) {
      expect(kindOf(s), s).toBe('ask');
    }
    expect(classify(`/bin/zsh -lc 'cat "notes.txt'`, read('cat notes.txt')).kind).toBe('ask');
    expect(classify(zsh('cat notes.txt,other.txt'), read('cat notes.txt,other.txt'), { platform: 'win32' }).kind).toBe('ask');
  });

  it('asks for searches that would walk into .agent-stream', () => {
    for (const s of [
      'grep -r secret .',
      'grep -rn secret src',
      'grep -R secret .',
      'grep --recursive secret .',
      'grep --directories=recurse secret .',
      'egrep -d recurse secret .',
      'rg secret .agent-stream',
      'rg secret ./.agent-stream/',
      'rg --hidden foo .',
      'rg -uu foo',
      'rg -. foo',
      'rg --no-ignore foo',
      'rg --no-ignore-vcs foo',
      'rg --unrestricted foo',
    ]) {
      expect(kindOf(s, search(s)), s).toBe('ask');
    }
    expect(kindOf('rg foo .', search('rg foo .'))).toBe('readOnly');
    expect(kindOf('rg foo src', search('rg foo src'))).toBe('readOnly');
  });

  it('asks for read programs called in ways that write or run commands', () => {
    for (const s of [
      'rg --pre sh foo .',
      'rg --pre=sh foo .',
      'rg --pre-glob x foo',
      'rg -z foo .',
      'rg --search-zip foo',
      'find . -delete',
      'find . -exec rm x',
      'find . -fprint out.txt',
      'find . -fls out.txt',
      'find . -okdir ls',
      'sed -n "1e touch x" notes.txt',
      'sed -i s/a/b/ notes.txt',
      'sed s/a/b/ notes.txt',
      'sed -n 1p',
      'tail -f notes.txt',
      'tail -F notes.txt',
      'tail --follow notes.txt',
    ]) {
      expect(kindOf(s, search(s)), s).toBe('ask');
    }
  });

  it('asks for writes, unknown programs, missing actions and extra permissions', () => {
    expect(classify(zsh('printf hi > hello.txt'), [{ type: 'unknown', command: 'printf hi > hello.txt' }]).kind).toBe('ask');
    expect(classify(zsh('touch hello.txt'), [{ type: 'unknown', command: 'touch hello.txt' }]).kind).toBe('ask');
    expect(classify(zsh('python notes.txt'), read('python notes.txt')).kind).toBe('ask');
    expect(classify(zsh('cat notes.txt'), []).kind).toBe('ask');
    expect(classify(zsh('cat notes.txt'), null).kind).toBe('ask');
    expect(classify(zsh('cat notes.txt'), [{ type: 'read', command: 'cat $X', name: 'x', path: resolve(cwd, 'x') }]).kind).toBe('ask');
    expect(classify(zsh('cat notes.txt'), read('cat notes.txt'), { kind: 'writeStdin' }).kind).toBe('ask');
    expect(classify(zsh('cat notes.txt'), read('cat notes.txt'), { extra: { additionalPermissions: { network: { enabled: true } } } }).kind).toBe('ask');
    expect(classify(zsh('cat notes.txt'), read('cat notes.txt'), { extra: { networkApprovalContext: { host: 'example.com' } } }).kind).toBe('ask');
  });

  it('asks for abbreviated and =valued long options, and short flags outside the allowed letters (fix 1: R1a, R1b)', () => {
    for (const s of [
      'grep --recurs SECRET .',
      'grep --dir=recurse SECRET .',
      'grep --deref SECRET .',
      'tail --foll notes.txt',
      'rg --glob=.agent-stream --glob=run.json SECRET',
      'rg --iglob=.agent-stream SECRET',
      'rg --file=.agent-stream/runs/r1/run.json x notes.txt',
      'wc --files0-from=.agent-stream/runs/r1/run.json',
      'rg -g.agent-stream SECRET',
      'grep -f.agent-stream/runs/r1/run.json x notes.txt',
      'rg -e foo notes.txt',
      'cat -v notes.txt',
      'head -q notes.txt',
      'ls -R',
      'find . -newer .agent-stream/worktrees/w1/a',
      'find . -regex x',
      'find -L . -name a',
    ]) {
      expect(kindOf(s, search(s)), s).toBe('ask');
    }
    // A private predicate value is declined, not merely asked.
    expect(classify(zsh('find . -newer .agent-stream/runs/r1/run.json'), search('find')).kind).toBe('private');
    for (const s of ['head -n 20 notes.txt', 'head -n20 notes.txt', 'wc -l notes.txt', 'ls -la', 'grep -n foo notes.txt', 'grep --max-count=5 foo notes.txt', 'rg -m5 -C3 foo src', 'rg --line-number foo src', 'sed -n 1,5p notes.txt', 'find . -name a.ts -type f -maxdepth 2']) {
      expect(kindOf(s, search(s)), s).toBe('readOnly');
    }
  });

  it('asks for non-ASCII words, extended-glob and comment characters, and shell wrappers not at a known path (fix 1: R1c, R1d, R1e)', () => {
    expect(kindOf('cat .agent-\u017Ftream/runs/r1/run.json')).toBe('ask');
    expect(kindOf('cat .agent-stream/^sessions/r1/run.json')).toBe('ask');
    expect(kindOf('cat notes.txt #x')).toBe('ask');
    expect(classify(`./zsh -lc 'cat notes.txt'`, read('cat notes.txt')).kind).toBe('ask');
    expect(classify(`/work/proj/bash -c 'cat notes.txt'`, read('cat notes.txt')).kind).toBe('ask');
    expect(classify(`zsh -lc 'cat notes.txt'`, read('cat notes.txt')).kind).toBe('readOnly');
    expect(classify(`/usr/bin/bash -c 'cat notes.txt'`, read('cat notes.txt')).kind).toBe('readOnly');
  });

  it('does not treat a search pattern as a path (fix 1: R1f)', () => {
    expect(kindOf('grep -n / notes.txt', search('grep -n / notes.txt'))).toBe('readOnly');
    expect(classify(zsh(`grep -n / ${values}`), search('grep')).kind).toBe('private');
  });

  it('asks for any other .agent-stream operand, but not the permitted upstream output.md (fix 1: R1g)', () => {
    const other = resolve('/', 'h', '.agent-stream', 'values', 'other.json');
    expect(kindOf(`cat ${other}`)).toBe('ask');
    expect(kindOf('cat .agent-stream/worktrees/w1/a.txt')).toBe('ask');
    expect(kindOf(`ls ${resolve('/', 'h', '.agent-stream', 'worktrees')}`, search('ls'))).toBe('ask');
  });
});
