import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createVariantWorkspaces, pruneWorkspaces, removeWorkspace, variantPath } from '../src/variantWorkspaces';
import { fakeGit } from './helpers';

const SHA = '0123456789abcdef0123456789abcdef01234567';
const RUN = '20261003-101500-abcd';
const tmp = (name: string) => realpathSync(mkdtempSync(join(tmpdir(), `agent-stream-${name}-`)));

describe('variant workspaces', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('puts each worktree under the home folder, keyed by the checkout, the run and the name', () => {
    const home = join(tmpdir(), 'home');
    const root = join(tmpdir(), 'repo');
    const key = createHash('sha256').update(root).digest('hex').slice(0, 16);
    expect(variantPath(home, root, RUN, 'wh_small')).toBe(join(home, '.agent-stream', 'worktrees', key, RUN, 'wh_small'));
  });

  it('adds one detached worktree per name from the checkout root, at the given head', async () => {
    const home = tmp('home');
    const root = tmp('repo');
    const small = variantPath(home, root, RUN, 'wh_small');
    const large = variantPath(home, root, RUN, 'wh_large');
    const git = fakeGit({ [`worktree add --detach ${small} ${SHA}`]: {}, [`worktree add --detach ${large} ${SHA}`]: {} });
    expect(await createVariantWorkspaces({ checkoutRoot: root, runId: RUN, names: ['wh_small', 'wh_large'], head: SHA, git: git.exec, home })).toEqual({
      ok: true,
      workspaces: { wh_small: { path: small, head: SHA }, wh_large: { path: large, head: SHA } },
    });
    expect(git.calls).toEqual([
      { args: ['worktree', 'add', '--detach', small, SHA], cwd: root },
      { args: ['worktree', 'add', '--detach', large, SHA], cwd: root },
    ]);
  });

  it('removes only the worktrees this attempt created when one fails, and says why', async () => {
    const home = tmp('home');
    const root = tmp('repo');
    const a = variantPath(home, root, RUN, 'wh_a');
    const b = variantPath(home, root, RUN, 'wh_b');
    const git = fakeGit({
      [`worktree add --detach ${a} ${SHA}`]: {},
      [`worktree add --detach ${b} ${SHA}`]: { code: 128, stderr: `fatal: '${b}' already exists\n` },
      [`worktree remove --force ${a}`]: {},
    });
    expect(await createVariantWorkspaces({ checkoutRoot: root, runId: RUN, names: ['wh_a', 'wh_b', 'wh_c'], head: SHA, git: git.exec, home })).toEqual({
      ok: false,
      error: `Couldn't create workspace "wh_b": fatal: '${b}' already exists`,
    });
    expect(git.ran()).toEqual([`worktree add --detach ${a} ${SHA}`, `worktree add --detach ${b} ${SHA}`, `worktree remove --force ${a}`]);
  });

  it('says which created worktree it could not remove after a failure, and logs it', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const home = tmp('home');
    const root = tmp('repo');
    const a = variantPath(home, root, RUN, 'wh_a');
    const b = variantPath(home, root, RUN, 'wh_b');
    const c = variantPath(home, root, RUN, 'wh_c');
    const git = fakeGit({
      [`worktree add --detach ${a} ${SHA}`]: {},
      [`worktree add --detach ${b} ${SHA}`]: {},
      [`worktree add --detach ${c} ${SHA}`]: { code: 128, stderr: 'fatal: invalid reference\n' },
      [`worktree remove --force ${a}`]: { code: 128, stderr: `fatal: '${a}' is locked\n` },
      [`worktree remove --force ${b}`]: {},
    });
    expect(await createVariantWorkspaces({ checkoutRoot: root, runId: RUN, names: ['wh_a', 'wh_b', 'wh_c'], head: SHA, git: git.exec, home })).toEqual({
      ok: false,
      error: `Couldn't create workspace "wh_c": fatal: invalid reference; couldn't remove ${a}: fatal: '${a}' is locked`,
    });
    expect(git.ran().slice(3)).toEqual([`worktree remove --force ${a}`, `worktree remove --force ${b}`]);
    expect(logged).toHaveBeenCalledTimes(1);
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('[agent-stream]'), a, `fatal: '${a}' is locked`);
  });

  it('removes a workspace, with --force only when asked, and prunes', async () => {
    const root = tmp('repo');
    const path = join(tmp('home'), 'wt');
    const git = fakeGit({ [`worktree remove ${path}`]: {}, [`worktree remove --force ${path}`]: {}, 'worktree prune': {} });
    expect(await removeWorkspace({ checkoutRoot: root, path, force: false, git: git.exec })).toEqual({ ok: true });
    expect(await removeWorkspace({ checkoutRoot: root, path, force: true, git: git.exec })).toEqual({ ok: true });
    expect(await pruneWorkspaces({ checkoutRoot: root, git: git.exec })).toEqual({ ok: true });
    expect(git.calls).toEqual([
      { args: ['worktree', 'remove', path], cwd: root },
      { args: ['worktree', 'remove', '--force', path], cwd: root },
      { args: ['worktree', 'prune'], cwd: root },
    ]);
    const failing = fakeGit({ [`worktree remove ${path}`]: { code: 128, stderr: "fatal: contains modified or untracked files, use --force to delete it\n" } });
    expect(await removeWorkspace({ checkoutRoot: root, path, force: false, git: failing.exec })).toEqual({
      ok: false,
      error: 'fatal: contains modified or untracked files, use --force to delete it',
    });
  });
});
