import { describe, expect, it } from 'vitest';
import { checkoutChip, checkoutTooltip, folderName, ranIn, toRunCheckout, waitingText } from '../src/checkout';
import type { CheckoutInfo } from '../src/types';

const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const main: CheckoutInfo = {
  git: true,
  root: '/work/app',
  linkedWorktree: false,
  branch: 'main',
  head: SHA,
  dirty: false,
  worktrees: [
    { path: '/work/app', branch: 'main', head: SHA, current: true },
    { path: '/work/app-abc-1', branch: 'feat/abc-1', head: SHA, current: false },
  ],
};

describe('checkout texts', () => {
  it('names the branch, a detached head, a linked worktree, or why there is no Git', () => {
    expect(checkoutChip(main)).toBe('⎇ main');
    expect(checkoutChip({ ...main, branch: undefined })).toBe('⎇ detached a1b2c3d');
    expect(checkoutChip({ ...main, root: '/work/app-abc-1', linkedWorktree: true, branch: 'feat/abc-1' })).toBe('⎇ feat/abc-1 · worktree app-abc-1');
    expect(checkoutChip({ git: false, root: '/work/notes', reason: 'Not a Git repository' })).toBe('Not a Git repository');
    expect(checkoutChip({ git: false, root: '/work/notes', reason: "Git isn't available" })).toBe("Git isn't available");
  });

  it('shows the root, the HEAD commit and the other worktrees as the tooltip', () => {
    expect(checkoutTooltip(main)).toBe(`Root: /work/app\nHEAD: ${SHA}\nOther worktrees:\n  /work/app-abc-1 · feat/abc-1`);
    expect(checkoutTooltip({ ...main, head: undefined, worktrees: [] })).toBe('Root: /work/app\nHEAD: no commits yet');
  });

  it('records where a run ran, and says so', () => {
    expect(toRunCheckout(main)).toEqual({ root: '/work/app', branch: 'main', head: SHA, linkedWorktree: false });
    expect(toRunCheckout({ git: false, root: '/work/notes', reason: 'Not a Git repository' })).toEqual({ root: '/work/notes', linkedWorktree: false });
    expect(ranIn(toRunCheckout(main))).toBe('Ran in /work/app on main at a1b2c3d');
    expect(ranIn({ root: '/work/app', head: SHA, linkedWorktree: false })).toBe('Ran in /work/app at a1b2c3d');
    expect(ranIn({ root: '/work/notes', linkedWorktree: false })).toBe('Ran in /work/notes');
  });

  it('says what a waiting run waits for', () => {
    expect(waitingText({ runId: '20261003-101500-abcd', graphId: 'billing', folder: '/work/app' }, 'Billing')).toBe(
      'Waiting for run 20261003-101500-abcd ("Billing") to finish changing files',
    );
  });

  it('takes the last folder of either kind of path', () => {
    expect(folderName('/work/app-abc-1')).toBe('app-abc-1');
    expect(folderName('C:\\work\\app-abc-1\\')).toBe('app-abc-1');
  });
});
