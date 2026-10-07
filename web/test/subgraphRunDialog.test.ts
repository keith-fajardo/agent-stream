// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { emptyGraph, type Graph, type GraphNode, type RunMeta, type RunPreview } from '@agent-stream/shared';

vi.mock('../src/bridge', () => ({ send: vi.fn(), sendHost: vi.fn(), post: vi.fn() }));
const { send } = await import('../src/bridge');
const { dispatch, getState } = await import('../src/store');
const { RunConfirmDialog } = await import('../src/components/RunConfirmDialog');
const { VariablesDialog } = await import('../src/components/VariablesDialog');
const { changedSinceRun, onlyAvailability } = await import('../src/retry');
const { liveExpansion } = await import('../src/scope');
const { Canvas } = await import('../src/components/Canvas');
const { NodePanel } = await import('../src/components/NodePanel');
const { ReactFlowProvider } = await import('@xyflow/react');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const step = (id: string, extra: Partial<GraphNode> = {}): GraphNode => ({ id, title: id, kind: 'agent', prompt: 'p', createdBy: 'user', updatedBy: 'user', updatedAt: 't', ...extra });
const research: Graph = { ...emptyGraph('company-research', 'Company research', 't'), variables: [{ name: 'company', description: 'Who to research' }, { name: 'depth', description: 'quick or thorough' }], nodes: [step('n1', { title: 'Find site' }), step('n2', { title: 'Read news' })], edges: [{ id: 'n1->n2', from: 'n1', to: 'n2' }] };
const hunting: Graph = { ...emptyGraph('job-hunting', 'Job hunting', 't'), nodes: [step('n1', { title: 'Plan' }), { ...step('n4', { title: 'Research', kind: 'graph', graph: 'company-research', values: { company: 'Acme' } }), prompt: undefined }, step('n5', { title: 'Letter' })], edges: [{ id: 'n1->n4', from: 'n1', to: 'n4' }, { id: 'n4->n5', from: 'n4', to: 'n5' }] };

function open(run?: RunMeta) {
  dispatch({ kind: 'closeConfirm' });
  dispatch({ kind: 'server', msg: { type: 'graphOpened', changes: [], graph: hunting, runs: run ? [{ id: run.id, graphId: 'job-hunting', status: run.status, startedAt: 't' }] : [], ...(run && { run }), variableValues: { 'n4/depth': 'quick' } } });
  dispatch({ kind: 'server', msg: { type: 'subgraphs', graphId: 'job-hunting', graphs: { 'company-research': research }, reviews: {} } });
}
async function render(el: ReturnType<typeof createElement>) {
  const container = document.createElement('div');
  const root = createRoot(container);
  await act(async () => root.render(el));
  return { container, done: () => act(async () => root.unmount()) };
}
/** A finished run of the expanded live graph, every step succeeded. */
function doneRun(): RunMeta {
  const r = liveExpansion({ graph: hunting, subgraphs: { 'company-research': research } });
  if (!r?.ok) throw new Error('expected an expansion');
  return { id: '20261007-100000-abcd', graphId: 'job-hunting', status: 'succeeded', startedAt: 't', snapshot: r.graph, scopes: r.scopes, nodes: Object.fromEntries(r.graph.nodes.map((n) => [n.id, { status: 'succeeded' as const }])) };
}

describe('the run dialog of a graph with a sub-graph step (spec §5)', () => {
  const preview = (patch: Partial<RunPreview> = {}): RunPreview => ({
    graphId: 'job-hunting',
    problems: [],
    warnings: [],
    steps: [
      { id: 'n1', title: 'Plan', kind: 'agent', text: 'p', reused: false },
      { id: 'n4', title: 'Research', kind: 'graph', text: '', reused: false, subgraph: { graphName: 'Company research', steps: 2 } },
      { id: 'n4/n1', title: 'Find site', kind: 'agent', text: 'p', reused: false, depth: 1 },
      { id: 'n4/n2', title: 'Read news', kind: 'agent', text: 'p', reused: false, depth: 1 },
      { id: 'n5', title: 'Letter', kind: 'agent', text: 'p', reused: false },
    ],
    variables: [{ name: 'n4/depth', value: 'quick', label: 'n4 · depth' }],
    signature: 'sig',
    ...patch,
  });
  async function shown(p: RunPreview) {
    open();
    const r = await render(createElement(RunConfirmDialog));
    await act(async () => dispatch({ kind: 'openConfirm', request: {} }));
    await act(async () => dispatch({ kind: 'server', msg: { type: 'runPreview', preview: p, requestId: getState().previewRequestId } }));
    return r;
  }

  it('lists the steps in run order, inner steps indented under their sub-graph step, and the s · v rows', async () => {
    const r = await shown(preview());
    const items = [...r.container.querySelectorAll('.run-steps li')] as HTMLLIElement[];
    expect(items.map((li) => li.textContent)).toEqual(['n1 · Plan agent', 'n4 · Research (sub-graph "Company research", 2 steps)', 'n4/n1 · Find site agent', 'n4/n2 · Read news agent', 'n5 · Letter agent']);
    expect(items.map((li) => li.style.paddingLeft)).toEqual(['0px', '0px', '16px', '16px', '0px']);
    expect([...r.container.querySelectorAll('.variables-used td')].map((td) => td.textContent)).toEqual(['n4 · depth', 'quick']);
    await r.done();
  });

  it('an expansion problem blocks Start', async () => {
    const r = await shown(preview({ problems: ['Step n4 uses graph "company-research", which isn\'t in this folder.'] }));
    expect(r.container.querySelector('.problems')?.textContent).toContain('Step n4 uses graph "company-research", which isn\'t in this folder.');
    expect(([...r.container.querySelectorAll('button')].find((b) => b.textContent === 'Start run') as HTMLButtonElement).disabled).toBe(true);
    await r.done();
  });
});

describe('the Variables dialog asks for inner values left empty (spec §3.3)', () => {
  it('shows each as s · v with its description, and Save remembers it under this graph as s/v', async () => {
    open();
    const r = await render(createElement(VariablesDialog));
    await act(async () => dispatch({ kind: 'openVariables' }));
    const input = r.container.querySelector('input[aria-label="Value of n4 · depth"]') as HTMLInputElement;
    expect(input.value).toBe('quick');
    expect(r.container.querySelector('.inner-values')?.textContent).toContain('quick or thorough');
    // company has a value on the step, so it isn't asked.
    expect(r.container.querySelector('input[aria-label="Value of n4 · company"]')).toBeNull();
    vi.mocked(send).mockClear();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'thorough');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => ([...r.container.querySelectorAll('button')].find((b) => b.textContent === 'Save') as HTMLButtonElement).click());
    expect(send).toHaveBeenCalledWith({ type: 'setVariableValue', graphId: 'job-hunting', name: 'n4/depth', value: 'thorough' });
    await r.done();
  });
});

describe('the stale check and Run only on the expanded live graph (spec §6.3)', () => {
  it('a run of the expanded graph is not stale; an edit inside the inner graph makes it stale', () => {
    const run = doneRun();
    expect(changedSinceRun({ run, graph: hunting, subgraphs: { 'company-research': research } })).toBe(false);
    const edited = { ...research, nodes: [research.nodes[0], { ...research.nodes[1], prompt: 'Read more.' }] };
    expect(changedSinceRun({ run, graph: hunting, subgraphs: { 'company-research': edited } })).toBe(true);
  });

  it('Run only is available for a step after a sub-graph step, for the sub-graph step and for a step inside it', () => {
    open(doneRun());
    const s = getState();
    expect(onlyAvailability(s, 'n5').enabled).toBe(true);
    expect(onlyAvailability(s, 'n4').enabled).toBe(true);
    expect(onlyAvailability(s, 'n4/n2').enabled).toBe(true);
  });

  it('inside a sub-graph after a finished, unchanged run: no stale notice, and Run only is enabled for an inner step', async () => {
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
    open(doneRun());
    dispatch({ kind: 'enterScope', stepId: 'n4' });
    dispatch({ kind: 'selectNode', id: 'n2' });
    expect(getState().scope).toEqual(['n4']);
    const canvas = await render(createElement(ReactFlowProvider, null, createElement(Canvas)));
    expect(canvas.container.querySelector('.stale')).toBeNull();
    await canvas.done();
    const panel = await render(createElement(NodePanel));
    const only = [...panel.container.querySelectorAll('button')].find((b) => b.textContent === 'Run only this step') as HTMLButtonElement;
    expect(only.disabled).toBe(false);
    await panel.done();
    // An edit of the inner graph is still a change since the run, inside the scope too.
    const edited = { ...research, nodes: [research.nodes[0], { ...research.nodes[1], prompt: 'Read more.' }] };
    dispatch({ kind: 'server', msg: { type: 'subgraphs', graphId: 'job-hunting', graphs: { 'company-research': edited }, reviews: {} } });
    const again = await render(createElement(ReactFlowProvider, null, createElement(Canvas)));
    expect(again.container.querySelector('.stale')?.textContent).toBe('Graph changed since this run started');
    await again.done();
  });
});
