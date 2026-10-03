import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { inspectCheckout, parseWorktreeList } from '../src/git';
import { missingGit, noGit, repoGit } from './helpers';

const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const tmp = (name: string) => realpathSync(mkdtempSync(join(tmpdir(), `agent-stream-${name}-`)));

describe('inspectCheckout', () => {
  it('describes a main checkout and its other worktrees', async () => {
    const root = tmp('repo');
    const other = join(tmp('wt'), 'app-abc-1');
    const info = await inspectCheckout(root, repoGit({ root, branch: 'main', head: SHA, worktrees: [{ path: other, branch: 'feat/abc-1', head: SHA }] }).exec);
    expect(info).toEqual({
      git: true,
      root,
      linkedWorktree: false,
      branch: 'main',
      head: SHA,
      dirty: false,
      worktrees: [
        { path: root, branch: 'main', head: SHA, current: true },
        { path: other, branch: 'feat/abc-1', head: SHA, current: false },
      ],
    });
  });

  it('describes a linked worktree', async () => {
    const main = tmp('repo');
    const root = tmp('app-abc-1');
    const info = await inspectCheckout(root, repoGit({ root, mainRoot: main, branch: 'feat/abc-1', head: SHA }).exec);
    expect(info).toMatchObject({ git: true, root, linkedWorktree: true, branch: 'feat/abc-1' });
    expect(info.git && info.worktrees.map((w) => [w.path, w.current])).toEqual([
      [main, false],
      [root, true],
    ]);
  });

  it('reports a detached HEAD and modified tracked files', async () => {
    const root = tmp('repo');
    const info = await inspectCheckout(root, repoGit({ root, head: SHA, dirty: true }).exec);
    expect(info).toMatchObject({ git: true, head: SHA, dirty: true });
    expect(info).not.toHaveProperty('branch');
  });

  it('has a branch but no head before the first commit', async () => {
    const root = tmp('repo');
    const info = await inspectCheckout(root, repoGit({ root, branch: 'main' }).exec);
    expect(info).toMatchObject({ git: true, branch: 'main' });
    expect(info).not.toHaveProperty('head');
    expect(info.git && info.worktrees[0]).toEqual({ path: root, branch: 'main', current: true });
  });

  it('reports a folder outside Git by its real path', async () => {
    const folder = tmp('plain');
    expect(await inspectCheckout(folder, noGit)).toEqual({ git: false, root: folder, reason: 'Not a Git repository' });
  });

  it("says when Git isn't available", async () => {
    const folder = tmp('plain');
    expect(await inspectCheckout(folder, missingGit)).toEqual({ git: false, root: folder, reason: "Git isn't available" });
  });

  it('reports the top-level folder as the root of a subfolder (Review Focus 1)', async () => {
    const root = tmp('repo');
    const sub = join(root, 'packages', 'web');
    mkdirSync(sub, { recursive: true });
    const git = repoGit({ root, branch: 'main', head: SHA });
    expect(await inspectCheckout(sub, git.exec)).toMatchObject({ git: true, root, linkedWorktree: false });
    expect(git.calls.every((c) => c.cwd === sub)).toBe(true);
  });

  it('runs exactly the documented git commands', async () => {
    const root = tmp('repo');
    const git = repoGit({ root, branch: 'main', head: SHA });
    await inspectCheckout(root, git.exec);
    expect(git.ran().sort()).toEqual(
      [
        'rev-parse --show-toplevel',
        'rev-parse --absolute-git-dir',
        'rev-parse --git-common-dir',
        'symbolic-ref --quiet --short HEAD',
        'rev-parse --verify --quiet HEAD',
        'status --porcelain --untracked-files=no',
        'worktree list --porcelain',
      ].sort(),
    );
  });
});

describe('parseWorktreeList', () => {
  it('reads paths, heads and branches, and leaves out a detached branch and an unborn head', () => {
    const text = [
      `worktree ${join('/', 'work', 'app')}`,
      `HEAD ${SHA}`,
      'branch refs/heads/main',
      '',
      `worktree ${join('/', 'work', 'app-abc-1')}`,
      `HEAD ${SHA}`,
      'detached',
      '',
      `worktree ${join('/', 'work', 'app-new')}`,
      `HEAD ${'0'.repeat(40)}`,
      'branch refs/heads/feat/new',
      '',
    ].join('\r\n');
    expect(parseWorktreeList(text)).toEqual([
      { path: join('/', 'work', 'app'), head: SHA, branch: 'main' },
      { path: join('/', 'work', 'app-abc-1'), head: SHA },
      { path: join('/', 'work', 'app-new'), branch: 'feat/new' },
    ]);
  });
});
