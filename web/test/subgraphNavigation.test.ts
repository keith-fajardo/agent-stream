// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { emptyGraph, type Graph, type GraphNode, type RunMeta } from '@agent-stream/shared';

vi.mock('../src/bridge', () => ({ send: vi.fn(), sendHost: vi.fn(), post: vi.fn() }));
const { send } = await import('../src/bridge');
const { dispatch, getState } = await import('../src/store');
const { actions } = await import('../src/actions');
const { buildMenus } = await import('../src/menuModel');
const { ScopeBar } = await import('../src/components/ScopeBar');
const { NodePanel } = await import('../src/components/NodePanel');
const { LogsPanel } = await import('../src/components/LogsPanel');
const { ApprovalCard } = await import('../src/components/ApprovalCard');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const step = (id: string, extra: Partial<GraphNode> = {}): GraphNode => ({ id, title: id, kind: 'agent', prompt: 'p', createdBy: 'user', updatedBy: 'user', updatedAt: 't', ...extra });
const sub = (id: string, title: string, graph: string): GraphNode => ({ id, title, kind: 'graph', graph, createdBy: 'user', updatedBy: 'user', updatedAt: 't' });
const deep: Graph = { ...emptyGraph('deep', 'Deep', 't'), nodes: [step('n1', { title: 'Dig' })] };
const research: Graph = { ...emptyGraph('company-research', 'Company research', 't'), nodes: [step('n1', { title: 'Find site' }), step('n2', { title: 'Read news' }), sub('n3', 'Deeper', 'deep')] };
const hunting: Graph = { ...emptyGraph('job-hunting', 'Job hunting', 't'), nodes: [step('n1', { title: 'Plan' }), sub('n4', 'Research the target company', 'company-research')] };
const run: RunMeta = { id: '20261007-100000-abcd', graphId: 'job-hunting', status: 'running', startedAt: 't', snapshot: hunting, nodes: { n1: { status: 'succeeded' }, n4: { status: 'queued' }, 'n4/n2': { status: 'running' }, n2: { status: 'failed' } } };

function open() {
  dispatch({ kind: 'server', msg: { type: 'graphOpened', changes: [], graph: hunting, runs: [{ id: run.id, graphId: 'job-hunting', status: 'running', startedAt: 't' }], run, variableValues: {} } });
  dispatch({ kind: 'server', msg: { type: 'graphs', graphs: [{ id: 'job-hunting', name: 'Job hunting' }, { id: 'company-research', name: 'Company research', usedBy: ['job-hunting', 'weekly-report'] }, { id: 'weekly-report', name: 'Weekly report' }, { id: 'deep', name: 'Deep', usedBy: ['company-research'] }] } });
  dispatch({ kind: 'server', msg: { type: 'subgraphs', graphId: 'job-hunting', graphs: { 'company-research': research, deep }, reviews: { 'company-research': { changes: [] }, deep: { changes: [] } } } });
  dispatch({ kind: 'climbScope', depth: 0 });
}
async function render(el: ReturnType<typeof createElement>) {
  const container = document.createElement('div');
  const root = createRoot(container);
  await act(async () => root.render(el));
  return { container, done: () => act(async () => root.unmount()) };
}

describe('going inside a sub-graph step (spec §6.1)', () => {
  it('double-click goes inside a sub-graph step, deeper from there, and not into any other step', () => {
    open();
    actions.openStep('n1');
    expect(getState().scope).toEqual([]);
    actions.openStep('n4');
    expect(getState().scope).toEqual(['n4']);
    actions.openStep('n3');
    expect(getState().scope).toEqual(['n4', 'n3']);
  });

  it('the breadcrumb names each level, climbs to any of them, and ↑ Back climbs one', async () => {
    open();
    actions.openStep('n4');
    actions.openStep('n3');
    const r = await render(createElement(ScopeBar));
    expect(r.container.querySelector('.breadcrumb')?.textContent).toBe('↑ BackJob hunting › n4 Research the target company (Company research) › n3 Deeper (Deep)');
    const button = (label: string) => [...r.container.querySelectorAll('button')].find((b) => b.textContent === label) as HTMLButtonElement;
    await act(async () => button('↑ Back').click());
    expect(getState().scope).toEqual(['n4']);
    expect(getState().selectedNodeId).toBe('n3');
    await act(async () => button('Job hunting').click());
    expect(getState().scope).toEqual([]);
    expect(getState().selectedNodeId).toBe('n4');
    await r.done();
  });

  it('inside a graph other graphs use, says so and names them', async () => {
    open();
    actions.openStep('n4');
    const r = await render(createElement(ScopeBar));
    expect(r.container.querySelector('.used-in')?.textContent).toBe('Used in 2 graphs: changes apply to all of them. Job hunting, Weekly report');
    await r.done();
  });

  it('shows the problem when the inner graph is missing or broken, with ↑ Back', async () => {
    open();
    actions.openStep('n4');
    dispatch({ kind: 'server', msg: { type: 'subgraphs', graphId: 'job-hunting', graphs: { 'company-research': { error: 'line 2: bad', reason: 'broken', name: 'Company research' } }, reviews: {} } });
    const r = await render(createElement(ScopeBar));
    expect(r.container.querySelector('.file-errors')?.textContent).toBe('This step uses graph "Company research", whose file has errors: line 2: bad');
    expect([...r.container.querySelectorAll('button')].some((b) => b.textContent === '↑ Back')).toBe(true);
    await r.done();
  });
});

describe('editing inside (spec §6.1)', () => {
  it('sends edits and undo with the inner graph’s id, and the menu names this tab’s undo step there', async () => {
    open();
    actions.openStep('n4');
    dispatch({ kind: 'selectNode', id: 'n1' });
    vi.mocked(send).mockClear();
    actions.deleteSelectedStep();
    expect(send).toHaveBeenLastCalledWith({ type: 'op', graphId: 'company-research', op: { type: 'deleteNode', id: 'n1' } });
    actions.undo();
    expect(send).toHaveBeenLastCalledWith({ type: 'undo', graphId: 'company-research' });
    dispatch({ kind: 'server', msg: { type: 'undoState', graphId: 'company-research', label: 'deleted n1' } });
    const undo = buildMenus(getState()).find((m) => m.id === 'edit')!.items[0];
    expect(undo).toMatchObject({ label: 'Undo deleted n1', enabled: true });
    dispatch({ kind: 'server', msg: { type: 'opRejected', graphId: 'company-research', error: 'nope' } });
    expect(getState().toast).toBe('nope');
  });

  it('the Node panel edits the inner step, and Re-run from uses its expanded id', async () => {
    open();
    actions.openStep('n4');
    dispatch({ kind: 'selectNode', id: 'n2' });
    const r = await render(createElement(NodePanel));
    const title = r.container.querySelector('input') as HTMLInputElement;
    expect(title.value).toBe('Read news');
    vi.mocked(send).mockClear();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(title, 'Read the news');
      title.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => ([...r.container.querySelectorAll('button')].find((b) => b.textContent === 'Save') as HTMLButtonElement).click());
    expect(send).toHaveBeenCalledWith({ type: 'op', graphId: 'company-research', op: { type: 'updateNode', id: 'n2', patch: { title: 'Read the news' } } });
    await r.done();
    dispatch({ kind: 'server', msg: { type: 'run', run: { ...run, status: 'failed' } } });
    dispatch({ kind: 'server', msg: { type: 'runs', graphId: 'job-hunting', runs: [{ id: run.id, graphId: 'job-hunting', status: 'failed', startedAt: 't' }] } });
    actions.rerunFromSelected();
    expect(getState().confirm).toMatchObject({ mode: 'from', fromNodeId: 'n4/n2' });
    dispatch({ kind: 'closeConfirm' });
  });

  it('an unsaved edit of an inner step is not saved onto the outer graph’s step of the same id when climbing', async () => {
    open();
    // Every graph numbers its steps from n1: the inner graph has an n4 too.
    const clash: Graph = { ...research, nodes: [...research.nodes, step('n4', { title: 'Inner four' })] };
    dispatch({ kind: 'server', msg: { type: 'subgraphs', graphId: 'job-hunting', graphs: { 'company-research': clash, deep }, reviews: { 'company-research': { changes: [] }, deep: { changes: [] } } } });
    actions.openStep('n4');
    dispatch({ kind: 'selectNode', id: 'n4' });
    const r = await render(createElement(NodePanel));
    const title = () => r.container.querySelector('input') as HTMLInputElement;
    expect(title().value).toBe('Inner four');
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(title(), 'Edited inside');
      title().dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => actions.climb(0));
    expect(getState()).toMatchObject({ scope: [], selectedNodeId: 'n4' });
    expect(title().value).toBe('Research the target company');
    vi.mocked(send).mockClear();
    await act(async () => actions.save());
    const sent = vi.mocked(send).mock.calls.map((c) => c[0] as { type: string; graphId?: string; op?: { type: string; patch?: { title?: string } } });
    expect(sent.some((m) => m.type === 'op' && m.graphId === 'job-hunting' && m.op?.type === 'updateNode' && m.op.patch?.title === 'Edited inside')).toBe(false);
    expect(sent.some((m) => m.type === 'op' && m.op?.type === 'updateNode')).toBe(false);
    await r.done();
  });

  it('the agent-change items of the Edit menu follow the shown graph’s changes', () => {
    open();
    const accept = () => buildMenus(getState()).find((m) => m.id === 'edit')!.items.find((i) => 'label' in i && i.label === 'Accept all agent changes') as { enabled: boolean };
    expect(accept().enabled).toBe(false);
    dispatch({ kind: 'server', msg: { type: 'subgraphs', graphId: 'job-hunting', graphs: { 'company-research': research, deep }, reviews: { 'company-research': { changes: [{ kind: 'node', change: 'added', id: 'n2', title: 'Read news', at: 't' }] }, deep: { changes: [] } } } });
    expect(accept().enabled).toBe(false);
    actions.openStep('n4');
    expect(accept().enabled).toBe(true);
    actions.climb(0);
    expect(accept().enabled).toBe(false);
  });

  it('the logs of an inner step are its expanded id’s', async () => {
    open();
    actions.openStep('n4');
    dispatch({ kind: 'selectNode', id: 'n2' });
    vi.mocked(send).mockClear();
    const r = await render(createElement(LogsPanel));
    expect(send).toHaveBeenCalledWith({ type: 'getNodeLogs', runId: run.id, nodeId: 'n4/n2' });
    expect(r.container.textContent).toContain('Logs · n4/n2 Read news · Running');
    await r.done();
  });
});

describe('revealing a step inside a sub-graph (spec §6.1)', () => {
  it('an approval for n4/n2 from a notification or the sidebar goes inside n4 and selects n2', () => {
    open();
    dispatch({ kind: 'server', msg: { type: 'revealNode', nodeId: 'n4/n2' } });
    expect(getState()).toMatchObject({ scope: ['n4'], selectedNodeId: 'n2', tab: 'node' });
    dispatch({ kind: 'server', msg: { type: 'revealNode', nodeId: 'n1' } });
    expect(getState()).toMatchObject({ scope: [], selectedNodeId: 'n1' });
    // A path that no longer leads anywhere changes nothing.
    dispatch({ kind: 'server', msg: { type: 'revealNode', nodeId: 'n9/n2' } });
    expect(getState()).toMatchObject({ scope: [], selectedNodeId: 'n1' });
  });

  it('the card’s step button does the same', async () => {
    open();
    const r = await render(createElement(ApprovalCard, { request: { id: 'a1', runId: run.id, graphId: 'job-hunting', nodeId: 'n4/n3/n1', nodeTitle: 'Dig', inGraph: 'Deep', toolName: 'Bash', input: { command: 'ls' }, createdAt: 't' } }));
    await act(async () => ([...r.container.querySelectorAll('button')].find((b) => b.textContent === 'n4/n3/n1 · Dig (in Deep)') as HTMLButtonElement).click());
    expect(getState()).toMatchObject({ scope: ['n4', 'n3'], selectedNodeId: 'n1' });
    await r.done();
  });
});
