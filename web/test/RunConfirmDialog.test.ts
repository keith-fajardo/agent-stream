// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyGraph, type RunPreview, type ServerMessage } from '@agent-stream/shared';

vi.mock('../src/bridge', () => ({ send: vi.fn(), sendHost: vi.fn(), post: vi.fn() }));
const { post, send } = await import('../src/bridge');
const { dispatch, getState } = await import('../src/store');
const { RunConfirmDialog } = await import('../src/components/RunConfirmDialog');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const preview = (patch: Partial<RunPreview> = {}): RunPreview => ({
  graphId: 'g',
  problems: [],
  warnings: [],
  steps: [
    { id: 'n1', title: 'Build', kind: 'command', text: "dbt build -s 'orders v2'", reused: false },
    { id: 'n2', title: 'Check', kind: 'agent', text: 'Compare orders and orders_v2.', reused: false },
  ],
  variables: [{ name: 'model', value: 'orders v2' }],
  signature: 'sig-1',
  ...patch,
});
let container: HTMLDivElement;
let root: Root;
const lastRequestId = () => {
  const calls = vi.mocked(send).mock.calls.filter(([m]) => m.type === 'previewRun');
  return (calls.at(-1)![0] as { requestId?: string }).requestId;
};
const button = (label: string) => [...container.querySelectorAll('button')].find((b) => b.textContent === label) as HTMLButtonElement;

beforeEach(async () => {
  vi.mocked(send).mockClear();
  vi.mocked(post).mockClear();
  dispatch({ kind: 'closeBlocked' });
  dispatch({ kind: 'server', msg: { type: 'hello', status: { provider: 'claude', ok: true, label: 'Claude Max' }, project: '/p', graphs: [], approvals: [] } });
  dispatch({ kind: 'server', msg: { type: 'graphOpened', changes: [], graph: emptyGraph('g', 'G', 't'), runs: [], variableValues: {} } });
  container = document.createElement('div');
  root = createRoot(container);
  await act(async () => root.render(createElement(RunConfirmDialog)));
});
afterEach(async () => act(async () => root.unmount()));

describe('RunConfirmDialog', () => {
  it('asks the engine for a preview when it opens', async () => {
    await act(async () => dispatch({ kind: 'openConfirm', request: { fromNodeId: 'n2', sourceRunId: 'r1' } }));
    expect(send).toHaveBeenCalledWith({ type: 'previewRun', graphId: 'g', fromNodeId: 'n2', sourceRunId: 'r1', requestId: expect.any(String) });
    expect(container.textContent).toContain('Checking the run…');
    expect(button('Start run').disabled).toBe(true);
  });

  it('shows commands in full, agent prompts folded, the variables used, then starts with the signature', async () => {
    await act(async () => dispatch({ kind: 'openConfirm', request: {} }));
    await act(async () => dispatch({ kind: 'server', msg: { type: 'runPreview', preview: preview(), requestId: lastRequestId() } }));
    expect(container.querySelector('pre.mono')?.textContent).toBe("dbt build -s 'orders v2'");
    expect(container.querySelector('details summary')?.textContent).toBe('n2 · Check');
    expect(container.querySelector('details pre')?.textContent).toBe('Compare orders and orders_v2.');
    expect(container.querySelector('.variables-used')?.textContent).toContain('orders v2');
    await act(async () => button('Start run').click());
    expect(send).toHaveBeenLastCalledWith({ type: 'startRun', graphId: 'g', reviewed: 'sig-1', fromNodeId: undefined, sourceRunId: undefined });
    expect(getState().confirm).toBeUndefined();
  });

  it('names the model and effort agent steps will use', async () => {
    await act(async () => dispatch({ kind: 'openConfirm', request: {} }));
    await act(async () => dispatch({ kind: 'server', msg: { type: 'runPreview', preview: preview({ model: { value: 'sonnet', label: 'Sonnet' }, effort: 'high' }), requestId: lastRequestId() } }));
    expect(container.querySelector('.model-line')?.textContent).toBe('Model: Sonnet · Effort: high');
    await act(async () => dispatch({ kind: 'server', msg: { type: 'runPreview', preview: preview({ signature: 'sig-2' }), requestId: lastRequestId() } }));
    expect(container.querySelector('.model-line')?.textContent).toBe('Model: Default · Effort: Default');
    // Command steps alone use no model.
    const commandsOnly = preview({ signature: 'sig-3', steps: [{ id: 'n1', title: 'Build', kind: 'command', text: 'dbt build', reused: false }] });
    await act(async () => dispatch({ kind: 'server', msg: { type: 'runPreview', preview: commandsOnly, requestId: lastRequestId() } }));
    expect(container.querySelector('.model-line')).toBeNull();
  });

  it('shows each step\u2019s description as an In short line above its prompt or command', async () => {
    const steps: RunPreview['steps'] = [
      { id: 'n1', title: 'Build', kind: 'command', description: 'Builds the model.', text: 'dbt build', reused: false },
      { id: 'n2', title: 'Check', kind: 'agent', description: 'Checks the new model matches.', text: 'Compare orders and orders_v2.', reused: false },
      { id: 'n3', title: 'Plain', kind: 'agent', text: 'Do it.', reused: false },
    ];
    await act(async () => dispatch({ kind: 'openConfirm', request: {} }));
    await act(async () => dispatch({ kind: 'server', msg: { type: 'runPreview', preview: preview({ steps }), requestId: lastRequestId() } }));
    const briefs = [...container.querySelectorAll('.step-brief')].map((p) => p.textContent);
    expect(briefs).toEqual(['In short: Builds the model.', 'In short: Checks the new model matches.']);
    const agentBlock = container.querySelectorAll('details')[0];
    expect(agentBlock.querySelector('.step-brief')?.nextElementSibling?.tagName).toBe('PRE');
    expect(agentBlock.querySelector('pre')?.textContent).toBe('Compare orders and orders_v2.');
    expect(container.querySelectorAll('details')[1].querySelector('.step-brief')).toBeNull();
  });

  it('says when a step will be shown instead of an empty box, but shows an empty command as one', async () => {
    const steps: RunPreview['steps'] = [
      { id: 'n1', title: 'Build', kind: 'command', reused: false },
      { id: 'n2', title: 'Check', kind: 'agent', reused: false },
      { id: 'n3', title: 'Blank', kind: 'command', text: '', reused: false },
    ];
    await act(async () => dispatch({ kind: 'openConfirm', request: {} }));
    await act(async () => dispatch({ kind: 'server', msg: { type: 'runPreview', preview: preview({ problems: ['Set a value for model (Variables menu).'], steps }), requestId: lastRequestId() } }));
    const note = 'Shown here once every variable it uses has a value.';
    expect([...container.querySelectorAll('p.muted')].map((p) => p.textContent)).toEqual([note, note]);
    expect(container.querySelector('details p.muted')?.textContent).toBe(note);
    expect([...container.querySelectorAll('pre')].map((p) => p.textContent)).toEqual(['']);
  });

  it('lists problems first and blocks Start, and shows warnings', async () => {
    await act(async () => dispatch({ kind: 'openConfirm', request: {} }));
    await act(async () =>
      dispatch({ kind: 'server', msg: { type: 'runPreview', preview: preview({ problems: ['Set a value for model (Variables menu).'], warnings: ['n1 inserts a value without quotes (| unquoted). Check its command below.'] }), requestId: lastRequestId() } }),
    );
    const text = container.textContent ?? '';
    expect(text.indexOf('Set a value for model (Variables menu).')).toBeLessThan(text.indexOf('dbt build'));
    expect(text).toContain('⚠ n1 inserts a value without quotes');
    expect(button('Start run').disabled).toBe(true);
  });

  it('goes back to checking when the graph changes, and asks again', async () => {
    await act(async () => dispatch({ kind: 'openConfirm', request: {} }));
    await act(async () => dispatch({ kind: 'server', msg: { type: 'runPreview', preview: preview(), requestId: lastRequestId() } }));
    expect(button('Start run').disabled).toBe(false);
    const first = lastRequestId();
    await act(async () => dispatch({ kind: 'server', msg: { type: 'graph', changes: [], graph: emptyGraph('g', 'G2', 't') } }));
    expect(container.textContent).toContain('Checking the run…');
    expect(button('Start run').disabled).toBe(true);
    expect(lastRequestId()).not.toBe(first);
  });

  it('asks again with a new request id when a variable value changes', async () => {
    await act(async () => dispatch({ kind: 'openConfirm', request: {} }));
    const first = lastRequestId();
    await act(async () => dispatch({ kind: 'server', msg: { type: 'runPreview', preview: preview(), requestId: first } }));
    await act(async () => dispatch({ kind: 'server', msg: { type: 'variableValues', graphId: 'g', values: { model: 'x' } } }));
    expect(container.textContent).toContain('Checking the run…');
    expect(lastRequestId()).not.toBe(first);
    expect(vi.mocked(send).mock.calls.filter(([m]) => m.type === 'previewRun')).toHaveLength(2);
  });

  it('ignores a reply to an older request', async () => {
    await act(async () => dispatch({ kind: 'openConfirm', request: {} }));
    const stale = lastRequestId();
    await act(async () => dispatch({ kind: 'server', msg: { type: 'variableValues', graphId: 'g', values: { model: 'x' } } }));
    await act(async () => dispatch({ kind: 'server', msg: { type: 'runPreview', preview: preview(), requestId: stale } }));
    expect(container.textContent).toContain('Checking the run…');
  });
});

describe('RunConfirmDialog and the checkout', () => {
  const MESSAGE = '"G" can\'t start: run 20261003-090000-aaaa of "Billing" is already changing files in this checkout (/work/app). Separate tickets need separate worktrees.';
  const blocked = (canSetUpTickets: boolean): ServerMessage => ({
    type: 'runBlocked',
    graphId: 'g',
    message: MESSAGE,
    holder: { runId: '20261003-090000-aaaa', graphId: 'billing', folder: '/work/app', pid: 1, startedAt: 't' },
    otherWindow: false,
    checkout: canSetUpTickets ? { git: true, root: '/work/app', linkedWorktree: false, dirty: false, worktrees: [] } : { git: false, root: '/work/app', reason: 'Not a Git repository' },
    canSetUpTickets,
  });
  const actionLabels = () => [...container.querySelectorAll('.modal-actions button')].map((b) => b.textContent);
  async function startThenBlock(canSetUpTickets: boolean, sig = 'sig-1', request = { fromNodeId: 'n2', sourceRunId: 'r1' }) {
    await act(async () => dispatch({ kind: 'openConfirm', request }));
    await act(async () => dispatch({ kind: 'server', msg: { type: 'runPreview', preview: preview({ ...request, signature: sig }), requestId: lastRequestId() } }));
    await act(async () => button('Start run').click());
    await act(async () => dispatch({ kind: 'server', msg: blocked(canSetUpTickets) }));
  }

  it('shows the Checkout line and the notes, which never block Start', async () => {
    const checkout = { git: true as const, root: '/work/app', linkedWorktree: false, branch: 'main', head: 'a1b2c3d4e5', dirty: false, worktrees: [] };
    await act(async () => dispatch({ kind: 'openConfirm', request: {} }));
    await act(async () =>
      dispatch({ kind: 'server', msg: { type: 'runPreview', preview: preview({ checkout, notes: ['n1 and n2 can both change files in the same workspace; they will run one at a time.'] }), requestId: lastRequestId() } }),
    );
    expect(container.querySelector('.checkout-line')?.textContent).toBe('Checkout: ⎇ main · /work/app');
    expect(container.querySelector('.run-note')?.textContent).toBe('ℹ n1 and n2 can both change files in the same workspace; they will run one at a time.');
    expect(button('Start run').disabled).toBe(false);
  });

  it('offers Set Up Parallel Tickets, Run after it finishes and Cancel when the run is blocked', async () => {
    await startThenBlock(true);
    expect(container.querySelector('[aria-label="Run blocked"]')?.textContent).toContain(MESSAGE);
    expect(actionLabels()).toEqual(['Cancel', 'Set Up Parallel Tickets', 'Run after it finishes']);
  });

  it('re-sends the reviewed start with sequential when Run after it finishes is chosen', async () => {
    await startThenBlock(true);
    await act(async () => button('Run after it finishes').click());
    expect(send).toHaveBeenLastCalledWith({ type: 'startRun', graphId: 'g', reviewed: 'sig-1', fromNodeId: 'n2', sourceRunId: 'r1', sequential: true });
    expect(getState().blocked).toBeUndefined();
    expect(container.querySelector('[aria-label="Run blocked"]')).toBeNull();
  });

  it('re-sends the signature of the preview just reviewed, never an earlier start', async () => {
    await startThenBlock(true, 'sig-old', { fromNodeId: 'n1', sourceRunId: 'r0' });
    await act(async () => button('Cancel').click());
    await startThenBlock(true, 'sig-new', { fromNodeId: 'n2', sourceRunId: 'r1' });
    await act(async () => button('Run after it finishes').click());
    expect(send).toHaveBeenLastCalledWith({ type: 'startRun', graphId: 'g', reviewed: 'sig-new', fromNodeId: 'n2', sourceRunId: 'r1', sequential: true });
  });

  it('asks the extension to set up parallel tickets, and offers it only in Git checkouts', async () => {
    await startThenBlock(true);
    await act(async () => button('Set Up Parallel Tickets').click());
    expect(post).toHaveBeenCalledWith({ type: 'setUpParallelTickets' });
    expect(getState().blocked).toBeUndefined();
    await startThenBlock(false);
    expect(actionLabels()).toEqual(['Cancel', 'Run after it finishes']);
    vi.mocked(send).mockClear();
    await act(async () => button('Cancel').click());
    expect(getState().blocked).toBeUndefined();
    expect(send).not.toHaveBeenCalled();
  });
});
