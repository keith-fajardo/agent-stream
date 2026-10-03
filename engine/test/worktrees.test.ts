import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkSetup, createWorktrees, planWorktrees, ticketSlug, ticketSlugs, worktreeAddArgs, type WorktreeFs, type WorktreePlan } from '../src/worktrees';
import { fakeGit, missingGit, noGit, type GitAnswer } from './helpers';

const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const PARENT = join(tmpdir(), 'work');
const ROOT = join(PARENT, 'app');
const P1 = join(PARENT, 'app-abc-1-fix-login');
const P2 = join(PARENT, 'app-abc-2-add-logout');
function plan(tickets = ['ABC-1 Fix login', 'ABC-2 Add logout'], parent = PARENT): WorktreePlan {
  const r = planWorktrees({ root: ROOT, parent, tickets });
  if (!r.ok) throw new Error(r.error);
  return r.plan;
}
/** A filesystem where only `existing` exist; a path's real path is itself. */
const fsWith = (...existing: string[]): WorktreeFs => ({ exists: (p) => existing.includes(p), realpath: (p) => p });
/** A clean checkout where every check passes, with two untracked files. */
const clean = (over: Record<string, GitAnswer> = {}): Record<string, GitAnswer> => ({
  'rev-parse --show-toplevel': { stdout: `${ROOT}\n` },
  'rev-parse --verify --quiet --end-of-options main^{commit}': { stdout: `${SHA}\n` },
  'status --porcelain --untracked-files=no': { stdout: '' },
  'status --porcelain --untracked-files=normal': { stdout: '?? notes.txt\n?? scratch/\n' },
  'worktree list --porcelain': { stdout: `worktree ${ROOT}\nHEAD ${SHA}\nbranch refs/heads/main\n` },
  'check-ref-format --branch feat/abc-1-fix-login': {},
  'check-ref-format --branch feat/abc-2-add-logout': {},
  'show-ref --verify --quiet refs/heads/feat/abc-1-fix-login': { code: 1 },
  'show-ref --verify --quiet refs/heads/feat/abc-2-add-logout': { code: 1 },
  ...over,
});

describe('ticketSlug', () => {
  it.each([
    ['ABC-123 Fix the login redirect', 'abc-123-fix-the-login-redirect'],
    ['  --Hello,   World!--  ', 'hello-world'],
    ['Ünïcode', 'n-code'],
    [`${'a'.repeat(39)} b`, 'a'.repeat(39)],
    ['x'.repeat(50), 'x'.repeat(40)],
    ['!!!', ''],
  ])('slugs %j as %j', (ticket, slug) => expect(ticketSlug(ticket)).toBe(slug));

  it('refuses a ticket without letters or numbers, by its position', () => {
    expect(ticketSlugs(['ABC-1', '!!!'])).toEqual({ ok: false, error: 'Ticket 2 needs letters or numbers.' });
    expect(ticketSlugs(['ABC-1', 'b'])).toEqual({ ok: true, slugs: ['abc-1', 'b'] });
  });
});

describe('planWorktrees', () => {
  it('names each worktree <repo>-<slug> in the parent folder, on branch feat/<slug>', () => {
    expect(plan()).toEqual({
      root: ROOT,
      parent: PARENT,
      items: [
        { ticket: 'ABC-1 Fix login', slug: 'abc-1-fix-login', branch: 'feat/abc-1-fix-login', path: P1 },
        { ticket: 'ABC-2 Add logout', slug: 'abc-2-add-logout', branch: 'feat/abc-2-add-logout', path: P2 },
      ],
    });
  });

  it('refuses fewer than two and more than twenty tickets', () => {
    expect(planWorktrees({ root: ROOT, parent: PARENT, tickets: ['ABC-1'] })).toEqual({ ok: false, error: 'Add at least two tickets.' });
    const many = Array.from({ length: 21 }, (_, i) => `T-${i + 1}`);
    expect(planWorktrees({ root: ROOT, parent: PARENT, tickets: many })).toEqual({ ok: false, error: 'Add at most 20 tickets.' });
    expect(planWorktrees({ root: ROOT, parent: PARENT, tickets: many.slice(0, 20) }).ok).toBe(true);
  });

  it('refuses tickets that would share a branch, naming both, and tickets without letters or numbers', () => {
    expect(planWorktrees({ root: ROOT, parent: PARENT, tickets: ['ABC-1', 'Other', 'abc 1'] })).toEqual({ ok: false, error: 'Tickets 1 and 3 would both use feat/abc-1.' });
    expect(planWorktrees({ root: ROOT, parent: PARENT, tickets: ['ABC-1', '...'] })).toEqual({ ok: false, error: 'Ticket 2 needs letters or numbers.' });
  });
});

describe('checkSetup', () => {
  it('passes a clean checkout, resolving the base and counting untracked files, and creates nothing', async () => {
    const git = fakeGit(clean());
    expect(await checkSetup(plan(), 'main', git.exec, fsWith(PARENT))).toEqual({ problems: [], sha: SHA, untracked: 2 });
    expect(git.calls.every((c) => c.cwd === ROOT)).toBe(true);
    expect(git.ran().some((a) => a.startsWith('worktree add'))).toBe(false);
  });

  it("refuses when Git isn't available, or the folder isn't a repository", async () => {
    expect(await checkSetup(plan(), 'main', missingGit, fsWith(PARENT))).toEqual({ problems: ["Git isn't available."], untracked: 0 });
    expect(await checkSetup(plan(), 'main', noGit, fsWith(PARENT))).toEqual({ problems: [`${ROOT} isn't a Git repository.`], untracked: 0 });
  });

  it('refuses a base that starts with - without passing it to git, and a base that does not resolve', async () => {
    const git = fakeGit(clean());
    expect((await checkSetup(plan(), '--upload-pack=x', git.exec, fsWith(PARENT))).problems).toEqual(['"--upload-pack=x" isn\'t a valid base.']);
    expect(git.ran().some((a) => a.includes('--upload-pack'))).toBe(false);
    expect((await checkSetup(plan(), 'nope', git.exec, fsWith(PARENT))).problems).toEqual(['Can\'t find the base "nope".']);
  });

  it('refuses uncommitted changes to tracked files, counting them', async () => {
    const git = fakeGit(clean({ 'status --porcelain --untracked-files=no': { stdout: ' M a.ts\nM  b.ts\n' } }));
    expect((await checkSetup(plan(), 'main', git.exec, fsWith(PARENT))).problems).toEqual([
      "This checkout has uncommitted changes to tracked files (2). Worktrees start from main and won't include them. Commit them yourself, or run this from a clean checkout.",
    ]);
  });

  it("refuses when git status or git worktree list fails, instead of treating the checkout as clean", async () => {
    const status = fakeGit(clean({ 'status --porcelain --untracked-files=no': { code: 128, stderr: 'fatal: timed out\n' } }));
    expect((await checkSetup(plan(), 'main', status.exec, fsWith(PARENT))).problems).toEqual(["Couldn't check this checkout: fatal: timed out"]);
    const list = fakeGit(clean({ 'worktree list --porcelain': { code: 1, stdout: 'worktree list failed\n' } }));
    expect((await checkSetup(plan(), 'main', list.exec, fsWith(PARENT))).problems).toEqual(["Couldn't check this checkout: worktree list failed"]);
  });

  it('refuses a parent folder that is missing, or inside the checkout', async () => {
    expect((await checkSetup(plan(), 'main', fakeGit(clean()).exec, fsWith())).problems).toEqual([`The folder ${PARENT} doesn't exist.`]);
    const trees = join(ROOT, 'trees');
    const inside = plan(['ABC-1', 'ABC-2'], trees);
    const git = fakeGit(
      clean({
        'check-ref-format --branch feat/abc-1': {},
        'check-ref-format --branch feat/abc-2': {},
        'show-ref --verify --quiet refs/heads/feat/abc-1': { code: 1 },
        'show-ref --verify --quiet refs/heads/feat/abc-2': { code: 1 },
      }),
    );
    expect((await checkSetup(inside, 'main', git.exec, fsWith(trees))).problems).toEqual([`${trees} is inside this checkout. Choose a folder outside it.`]);
  });

  it('refuses an invalid branch name, an existing branch, an existing folder and a registered worktree', async () => {
    const branches = fakeGit(clean({ 'check-ref-format --branch feat/abc-1-fix-login': { code: 1 }, 'show-ref --verify --quiet refs/heads/feat/abc-2-add-logout': {} }));
    expect((await checkSetup(plan(), 'main', branches.exec, fsWith(PARENT))).problems).toEqual(["feat/abc-1-fix-login isn't a valid branch name.", 'The branch feat/abc-2-add-logout already exists.']);
    const folders = fakeGit(clean({ 'worktree list --porcelain': { stdout: `worktree ${ROOT}\nHEAD ${SHA}\nbranch refs/heads/main\n\nworktree ${P2}\nHEAD ${SHA}\ndetached\n` } }));
    expect((await checkSetup(plan(), 'main', folders.exec, fsWith(PARENT, P1))).problems).toEqual([`${P1} already exists.`, `${P2} is already a registered worktree.`]);
  });

  it('reports every problem at once', async () => {
    const git = fakeGit(clean({ 'status --porcelain --untracked-files=no': { stdout: ' M a.ts\n' }, 'show-ref --verify --quiet refs/heads/feat/abc-2-add-logout': {} }));
    expect((await checkSetup(plan(), 'nope', git.exec, fsWith())).problems).toEqual([
      'Can\'t find the base "nope".',
      "This checkout has uncommitted changes to tracked files (1). Worktrees start from nope and won't include them. Commit them yourself, or run this from a clean checkout.",
      `The folder ${PARENT} doesn't exist.`,
      'The branch feat/abc-2-add-logout already exists.',
    ]);
  });
});

describe('creating ticket worktrees', () => {
  it('adds a worktree on a new branch at the base commit', () => {
    expect(worktreeAddArgs(plan().items[0], SHA)).toEqual(['worktree', 'add', '-b', 'feat/abc-1-fix-login', P1, SHA]);
  });

  it('creates them one at a time from the root, writing each starter graph after its worktree', async () => {
    const order: string[] = [];
    const git = fakeGit({
      [`worktree add -b feat/abc-1-fix-login ${P1} ${SHA}`]: () => (order.push('add 1'), {}),
      [`worktree add -b feat/abc-2-add-logout ${P2} ${SHA}`]: () => (order.push('add 2'), {}),
    });
    expect(await createWorktrees(plan(), SHA, git.exec, (item) => void order.push(`after ${item.slug}`))).toEqual({ created: plan().items });
    expect(order).toEqual(['add 1', 'after abc-1-fix-login', 'add 2', 'after abc-2-add-logout']);
    expect(git.calls.every((c) => c.cwd === ROOT)).toBe(true);
  });

  it('stops at the first failure and never deletes anything', async () => {
    const three = plan(['ABC-1 Fix login', 'ABC-2 Add logout', 'ABC-3']);
    const git = fakeGit({
      [`worktree add -b feat/abc-1-fix-login ${P1} ${SHA}`]: {},
      [`worktree add -b feat/abc-2-add-logout ${P2} ${SHA}`]: { code: 128, stderr: `fatal: could not create work tree dir '${P2}'\n` },
    });
    const after: string[] = [];
    expect(await createWorktrees(three, SHA, git.exec, (item) => void after.push(item.slug))).toEqual({
      created: [three.items[0]],
      failed: { item: three.items[1], error: `fatal: could not create work tree dir '${P2}'` },
    });
    expect(after).toEqual(['abc-1-fix-login']);
    expect(git.ran().filter((a) => !a.startsWith('worktree add'))).toEqual([]);
  });

  it('stops when a starter graph cannot be written, keeping the worktree', async () => {
    const git = fakeGit({ [`worktree add -b feat/abc-1-fix-login ${P1} ${SHA}`]: {} });
    const r = await createWorktrees(plan(), SHA, git.exec, () => {
      throw new Error('ENOSPC: no space left on device');
    });
    expect(r).toEqual({ created: [plan().items[0]], failed: { item: plan().items[0], error: 'ENOSPC: no space left on device' } });
  });
});
