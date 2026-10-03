import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative } from 'node:path';
import type { ProviderStatus } from '@agent-stream/shared';
import type { Clock } from '../src/clock';
import type { Found } from '../src/platform';
import { ensureDataDirs, projectPaths, type ProjectPaths } from '../src/paths';
import type { GitExec, GitResult, WorktreeEntry } from '../src/git';
import type { AgentProvider } from '../src/providers/types';
import { createWriteLeases, type WriteLeases } from '../src/writeLease';

/** A found Git Bash, so command steps aren't refused on Windows (ignored elsewhere). */
export const testGitBash: Found = { ok: true, path: 'C:\\Program Files\\Git\\bin\\bash.exe' };

export function tmpProject(): ProjectPaths {
  const paths = projectPaths(mkdtempSync(join(tmpdir(), 'agent-stream-')));
  ensureDataDirs(paths);
  return paths;
}

/** A variable values file in a fresh temp folder (the file itself doesn't exist yet), so no test writes into the real home folder. */
export function tmpValuesFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'agent-stream-values-')), 'values.json');
}

export function fixedClock(start = Date.parse('2026-10-02T00:00:00.000Z')): Clock {
  let t = start;
  return () => new Date((t += 1000)).toISOString();
}

export const signedIn: ProviderStatus = { provider: 'claude', ok: true, label: 'Claude Max' };

/** A provider whose steps and planner turns are given by the test. */
export function testProvider(over: Partial<AgentProvider> = {}): AgentProvider {
  return { id: 'claude', name: 'Claude', status: async () => signedIn, runStep: async () => ({ ok: true, output: '' }), planTurn: async () => ({ ok: true }), ...over };
}

/** A promise the test settles by hand. */
export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

export type GitAnswer = Partial<GitResult> | ((cwd: string, args: string[]) => Partial<GitResult>);

/** A fake GitExec: answers by the joined arguments (a key ending in ' *' matches by prefix); anything else exits 1. No test runs real git. */
export function fakeGit(answers: Record<string, GitAnswer> = {}) {
  const calls: { args: string[]; cwd: string }[] = [];
  const exec: GitExec = async (args, cwd) => {
    calls.push({ args, cwd });
    const key = args.join(' ');
    const prefix = Object.keys(answers).find((k) => k.endsWith(' *') && key.startsWith(k.slice(0, -1)));
    const answer = answers[key] ?? (prefix === undefined ? undefined : answers[prefix]);
    const r = typeof answer === 'function' ? answer(cwd, args) : answer;
    return r ? { code: r.code ?? 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '' } : { code: 1, stdout: '', stderr: `unexpected: git ${key}` };
  };
  return { exec, calls, ran: () => calls.map((c) => c.args.join(' ')) };
}

export const noGit: GitExec = async () => ({ code: 128, stdout: '', stderr: 'fatal: not a git repository (or any of the parent directories): .git' });
export const missingGit: GitExec = async () => ({ code: -1, stdout: '', stderr: 'git not found' });

export type RepoOptions = { root: string; branch?: string; head?: string; dirty?: boolean; mainRoot?: string; worktrees?: WorktreeEntry[]; answers?: Record<string, GitAnswer> };

/** What inspectCheckout asks, answered for a checkout at `root` (an existing temp folder). `mainRoot` makes it a linked worktree of that checkout. */
export function repoAnswers(o: RepoOptions): Record<string, GitAnswer> {
  const main = o.mainRoot ?? o.root;
  const entries: WorktreeEntry[] = [
    { path: main, branch: o.mainRoot ? 'main' : o.branch, head: o.head },
    ...(o.mainRoot ? [{ path: o.root, branch: o.branch, head: o.head }] : []),
    ...(o.worktrees ?? []),
  ];
  const list = entries
    .map((w) => [`worktree ${w.path}`, `HEAD ${w.head ?? '0'.repeat(40)}`, w.branch ? `branch refs/heads/${w.branch}` : 'detached'].join('\n'))
    .join('\n\n');
  return {
    'rev-parse --show-toplevel': { stdout: `${o.root}\n` },
    'rev-parse --absolute-git-dir': { stdout: `${o.mainRoot ? join(main, '.git', 'worktrees', basename(o.root)) : join(o.root, '.git')}\n` },
    // Real git prints the common dir relative to the folder it runs in (`.git`, `../../.git`); a linked worktree's is absolute.
    'rev-parse --git-common-dir': (cwd) => ({ stdout: `${o.mainRoot ? join(main, '.git') : relative(cwd, join(o.root, '.git'))}\n` }),
    'symbolic-ref --quiet --short HEAD': o.branch ? { stdout: `${o.branch}\n` } : { code: 1 },
    'rev-parse --verify --quiet HEAD': o.head ? { stdout: `${o.head}\n` } : { code: 1 },
    'status --porcelain --untracked-files=no': { stdout: o.dirty ? ' M src/app.ts\n' : '' },
    'worktree list --porcelain': { stdout: `${list}\n` },
    ...o.answers,
  };
}

export const repoGit = (o: RepoOptions) => fakeGit(repoAnswers(o));

/** Leases with their lock files in a fresh temp folder: no test writes to ~/.agent-stream/locks. */
export function testLeases(o: { pid?: number } = {}): WriteLeases {
  return createWriteLeases({ locksDir: mkdtempSync(join(tmpdir(), 'agent-stream-locks-')), isAlive: () => true, ...o });
}
