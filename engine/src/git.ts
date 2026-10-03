import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import type { CheckoutInfo } from '@agent-stream/shared';

export type GitResult = { code: number; stdout: string; stderr: string };
/** Runs `git <args>` in `cwd`. Unit tests pass a fake; nothing in a test runs real git (spec §4.1). */
export type GitExec = (args: string[], cwd: string) => Promise<GitResult>;

export const GIT_MISSING = "Git isn't available";
export const NOT_A_REPO = 'Not a Git repository';

/** The real git. Never throws: a missing git is `{ code: -1, stderr: 'git not found' }`. */
export const realGit: GitExec = (args, cwd) =>
  new Promise((done) => {
    execFile('git', args, { cwd, timeout: 15_000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = (error as { code?: unknown } | null)?.code;
      if (code === 'ENOENT') return done({ code: -1, stdout: '', stderr: 'git not found' });
      done({ code: !error ? 0 : typeof code === 'number' ? code : 1, stdout: String(stdout), stderr: String(stderr) });
    });
  });

/** The real path of `p`, or `p` resolved when it doesn't exist (a worktree deleted by hand). */
export function realOrResolved(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

export type WorktreeEntry = { path: string; branch?: string; head?: string };

/** `git worktree list --porcelain`: one block per worktree. A detached one has no branch; an unborn one (all-zero HEAD) has no head. */
export function parseWorktreeList(porcelain: string): WorktreeEntry[] {
  const out: WorktreeEntry[] = [];
  let current: WorktreeEntry | undefined;
  for (const raw of porcelain.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (line.startsWith('worktree ')) {
      current = { path: line.slice('worktree '.length) };
      out.push(current);
    } else if (current && line.startsWith('HEAD ')) {
      const sha = line.slice('HEAD '.length);
      if (!/^0+$/.test(sha)) current.head = sha;
    } else if (current && line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
    }
  }
  return out;
}

const text = (r: GitResult): string | undefined => (r.code === 0 && r.stdout.trim() ? r.stdout.trim() : undefined);

/** Where `folder` works (spec §4.1): its Git top-level, branch, HEAD and worktrees; outside Git, its own real path and why. */
export async function inspectCheckout(folder: string, git: GitExec): Promise<CheckoutInfo> {
  const top = await git(['rev-parse', '--show-toplevel'], folder);
  if (top.code !== 0 || !top.stdout.trim()) return { git: false, root: realOrResolved(folder), reason: top.code === -1 ? GIT_MISSING : NOT_A_REPO };
  const root = realOrResolved(top.stdout.trim());
  const [absolute, common, symbolic, head, status, list] = await Promise.all([
    git(['rev-parse', '--absolute-git-dir'], folder),
    git(['rev-parse', '--git-common-dir'], folder),
    git(['symbolic-ref', '--quiet', '--short', 'HEAD'], folder),
    git(['rev-parse', '--verify', '--quiet', 'HEAD'], folder),
    git(['status', '--porcelain', '--untracked-files=no'], folder),
    git(['worktree', 'list', '--porcelain'], folder),
  ]);
  const gitDir = text(absolute);
  const commonDir = text(common);
  // The common dir is printed relative to the folder git ran in.
  const linkedWorktree = !!gitDir && !!commonDir && realOrResolved(gitDir) !== realOrResolved(resolve(folder, commonDir));
  const branch = text(symbolic);
  const sha = text(head);
  const worktrees = parseWorktreeList(list.code === 0 ? list.stdout : '').map((w) => ({ ...w, current: realOrResolved(w.path) === root }));
  return { git: true, root, linkedWorktree, ...(branch && { branch }), ...(sha && { head: sha }), dirty: status.code === 0 && status.stdout.trim() !== '', worktrees };
}
