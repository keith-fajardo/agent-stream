// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyGraph, type CheckoutInfo, type RunMeta, type RunSummary } from '@agent-stream/shared';

vi.mock('../src/bridge', () => ({ send: vi.fn(), sendHost: vi.fn(), post: vi.fn() }));
const { post } = await import('../src/bridge');
const { dispatch } = await import('../src/store');
const { TopBar } = await import('../src/components/TopBar');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
let container: HTMLDivElement;
let root: Root;
const chip = () => container.querySelector('.checkout-chip') as HTMLElement | null;
const checkout = (info: CheckoutInfo) => act(async () => dispatch({ kind: 'server', msg: { type: 'checkout', info } }));

beforeEach(async () => {
  dispatch({ kind: 'server', msg: { type: 'hello', status: { provider: 'claude', ok: true, label: 'Claude Max' }, project: '/work/app', graphs: [{ id: 'g', name: 'G' }, { id: 'billing', name: 'Billing' }], approvals: [] } });
  dispatch({ kind: 'server', msg: { type: 'graphOpened', changes: [], graph: emptyGraph('g', 'G', 't'), runs: [], variableValues: {} } });
  container = document.createElement('div');
  root = createRoot(container);
  await act(async () => root.render(createElement(TopBar)));
});
afterEach(async () => act(async () => root.unmount()));

describe('TopBar checkout chip', () => {
  it('shows the branch, with the root, HEAD and the other worktrees as its tooltip', async () => {
    await checkout(main);
    expect(chip()?.textContent).toBe('⎇ main');
    expect(chip()?.title).toBe(`Root: /work/app\nHEAD: ${SHA}\nOther worktrees:\n  /work/app-abc-1 · feat/abc-1`);
  });

  it('names a linked worktree and a detached HEAD', async () => {
    await checkout({ ...main, root: '/work/app-abc-1', linkedWorktree: true, branch: 'feat/abc-1' });
    expect(chip()?.textContent).toBe('⎇ feat/abc-1 · worktree app-abc-1');
    await checkout({ ...main, branch: undefined });
    expect(chip()?.textContent).toBe('⎇ detached a1b2c3d');
  });

  it('says when the folder is not a Git repository, or Git is missing', async () => {
    await checkout({ git: false, root: '/work/notes', reason: 'Not a Git repository' });
    expect(chip()?.textContent).toBe('Not a Git repository');
    await checkout({ git: false, root: '/work/notes', reason: "Git isn't available" });
    expect(chip()?.textContent).toBe("Git isn't available");
  });
});

describe('TopBar run picker', () => {
  it('says where each run ran, and what a waiting run waits for', async () => {
    const runs: RunSummary[] = [
      { id: '20261003-110000-bbbb', graphId: 'g', status: 'running', startedAt: 't', waitingFor: { runId: '20261003-100000-aaaa', graphId: 'billing', folder: '/work/app' } },
      { id: '20261003-100000-aaaa', graphId: 'g', status: 'succeeded', startedAt: 't', checkout: { root: '/work/app', branch: 'main', head: SHA, linkedWorktree: false } },
    ];
    await act(async () => dispatch({ kind: 'server', msg: { type: 'runs', graphId: 'g', runs } }));
    const options = [...container.querySelectorAll('option')];
    expect(options[0].textContent).toBe('Run 20261003-110000-bbbb · Running · Waiting for run 20261003-100000-aaaa ("Billing") to finish changing files');
    expect(options[1].title).toBe('Ran in /work/app on main at a1b2c3d\nModel: Default · Effort: Default');
  });

  it('names the model and effort each run used', async () => {
    const runs: RunSummary[] = [{ id: '20261003-120000-cccc', graphId: 'g', status: 'succeeded', startedAt: 't', model: 'sonnet', effort: 'high' }];
    await act(async () => dispatch({ kind: 'server', msg: { type: 'runs', graphId: 'g', runs } }));
    expect(container.querySelector('option')?.title).toBe('Model: sonnet · Effort: high');
  });

  it('says effort is not supported for a Copilot run', async () => {
    const runs: RunSummary[] = [{ id: '20261003-130000-dddd', graphId: 'g', status: 'succeeded', startedAt: 't', provider: 'copilot', model: 'auto', effort: 'high' }];
    await act(async () => dispatch({ kind: 'server', msg: { type: 'runs', graphId: 'g', runs } }));
    expect(container.querySelector('option')?.title).toBe('Model: auto · Effort: not supported');
  });
});

describe('TopBar Report button', () => {
  const report = () => [...container.querySelectorAll('button')].find((b) => b.textContent === 'Report') as HTMLButtonElement | undefined;
  const summary: RunSummary = { id: '20261003-140000-eeee', graphId: 'g', status: 'succeeded', startedAt: 't' };

  it('sits next to the run picker, disabled until a run is selected', async () => {
    expect(report()).toBeUndefined();
    await act(async () => dispatch({ kind: 'server', msg: { type: 'runs', graphId: 'g', runs: [summary] } }));
    expect(report()?.disabled).toBe(true);
  });

  it('posts exportRunReport for the selected run', async () => {
    const run: RunMeta = { id: summary.id, graphId: 'g', status: 'succeeded', startedAt: 't', snapshot: emptyGraph('g', 'G', 't'), nodes: {} };
    await act(async () => dispatch({ kind: 'server', msg: { type: 'runs', graphId: 'g', runs: [summary] } }));
    await act(async () => dispatch({ kind: 'server', msg: { type: 'run', run, select: true } }));
    expect(report()?.disabled).toBe(false);
    vi.mocked(post).mockClear();
    await act(async () => report()!.click());
    expect(vi.mocked(post).mock.calls).toEqual([[{ type: 'exportRunReport', runId: summary.id }]]);
  });
});
