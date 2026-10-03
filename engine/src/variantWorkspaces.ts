import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { GitExec, GitResult } from './git';
import { leaseKey } from './writeLease';

/** `~/.agent-stream/worktrees/<checkout hash>/<run id>/<name>`: outside the project (spec §2). */
export function variantPath(home: string, checkoutRoot: string, runId: string, name: string): string {
  return join(home, '.agent-stream', 'worktrees', leaseKey(checkoutRoot), runId, name);
}

const gitError = (r: GitResult): string => r.stderr.trim() || r.stdout.trim() || `git exited with code ${r.code}`;

/** Runs git, turning a throw into a failed result. */
async function runGit(git: GitExec, args: string[], cwd: string): Promise<GitResult> {
  try {
    return await git(args, cwd);
  } catch (e) {
    return { code: 1, stdout: '', stderr: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * One detached worktree per name, from the run's start commit, run from the checkout root (spec §4.3a). If one can't be
 * created, the ones this attempt made are removed (they hold nothing yet) and the error names the workspace, and any
 * worktree it couldn't remove.
 */
export async function createVariantWorkspaces(o: {
  checkoutRoot: string;
  runId: string;
  names: string[];
  head: string;
  git: GitExec;
  home: string;
}): Promise<{ ok: true; workspaces: Record<string, { path: string; head: string }> } | { ok: false; error: string }> {
  const workspaces: Record<string, { path: string; head: string }> = {};
  for (const name of o.names) {
    const path = variantPath(o.home, o.checkoutRoot, o.runId, name);
    let r: GitResult | undefined;
    try {
      mkdirSync(dirname(path), { recursive: true });
    } catch (e) {
      r = { code: 1, stdout: '', stderr: e instanceof Error ? e.message : String(e) };
    }
    r ??= await runGit(o.git, ['worktree', 'add', '--detach', path, o.head], o.checkoutRoot);
    if (r.code !== 0) {
      let error = `Couldn't create workspace "${name}": ${gitError(r)}`;
      for (const made of Object.values(workspaces)) {
        const removed = await runGit(o.git, ['worktree', 'remove', '--force', made.path], o.checkoutRoot);
        if (removed.code === 0) continue;
        console.error('[agent-stream] could not remove a worktree after a failed creation', made.path, gitError(removed));
        error += `; couldn't remove ${made.path}: ${gitError(removed)}`;
      }
      return { ok: false, error };
    }
    workspaces[name] = { path, head: o.head };
  }
  return { ok: true, workspaces };
}

/** `git worktree remove [--force] <path>`, run from the checkout root (spec §5.5). */
export async function removeWorkspace(o: { checkoutRoot: string; path: string; force: boolean; git: GitExec }): Promise<{ ok: true } | { ok: false; error: string }> {
  const r = await runGit(o.git, ['worktree', 'remove', ...(o.force ? ['--force'] : []), o.path], o.checkoutRoot);
  return r.code === 0 ? { ok: true } : { ok: false, error: gitError(r) };
}

/** `git worktree prune`: forgets worktrees whose folder was deleted by hand (spec §8). */
export async function pruneWorkspaces(o: { checkoutRoot: string; git: GitExec }): Promise<{ ok: true } | { ok: false; error: string }> {
  const r = await runGit(o.git, ['worktree', 'prune'], o.checkoutRoot);
  return r.code === 0 ? { ok: true } : { ok: false, error: gitError(r) };
}
