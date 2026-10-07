// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { ReactFlowProvider, type NodeProps } from '@xyflow/react';
import { describe, expect, it } from 'vitest';
import { emptyGraph, type ApprovalRequest, type Graph, type GraphNode, type Position, type RunMeta } from '@agent-stream/shared';
import { StepNode, type StepFlowNode } from '../src/components/StepNode';
import { buildFlowNodes } from '../src/flowNodes';
import { initialState, reduce, type Action } from '../src/state';
import { liveExpansion, scopeProblem, shownGraph } from '../src/scope';
import { changedSinceRun } from '../src/retry';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const step = (id: string, extra: Partial<GraphNode> = {}): GraphNode => ({ id, title: id, kind: 'agent', prompt: 'p', createdBy: 'user', updatedBy: 'user', updatedAt: 't', ...extra });
const research: Graph = { ...emptyGraph('company-research', 'Company research', 't'), nodes: [step('n1'), step('n2')], edges: [{ id: 'n1->n2', from: 'n1', to: 'n2' }] };
const hunting: Graph = { ...emptyGraph('job-hunting', 'Job hunting', 't'), nodes: [step('n1'), step('n4', { title: 'Research the target company', kind: 'graph', graph: 'company-research', prompt: undefined })] };
const base = { selectionChanged: true, current: [] as StepFlowNode[], dragging: new Set<string>(), pendingMoves: new Map<string, Position>() };
const run = (nodes: RunMeta['nodes']): RunMeta => ({ id: 'r1', graphId: 'job-hunting', status: 'running', startedAt: 't', snapshot: hunting, nodes });
const approval = (nodeId: string): ApprovalRequest => ({ id: 'a1', runId: 'r1', graphId: 'job-hunting', nodeId, nodeTitle: 'x', toolName: 'Bash', input: {}, createdAt: 't' });

describe('the web keeps the inner graphs (spec §6.3)', () => {
  const open = (g: Graph): Action => ({ kind: 'server', msg: { type: 'graphOpened', changes: [], graph: g, runs: [], variableValues: {} } });
  it('stores the subgraphs message for the tab’s graph only, keeps them when the same graph opens again, and forgets them for another graph', () => {
    let s = [open(hunting), { kind: 'server', msg: { type: 'subgraphs', graphId: 'job-hunting', graphs: { 'company-research': research }, reviews: {} } } as Action].reduce(reduce, initialState);
    expect(s.subgraphs).toEqual({ 'company-research': research });
    expect(reduce(s, { kind: 'server', msg: { type: 'subgraphs', graphId: 'other', graphs: {}, reviews: {} } }).subgraphs).toEqual({ 'company-research': research });
    // The same graph opening again (a reload of its file, a reopen) must not flash its steps as missing graphs until the engine sends them again.
    s = reduce(s, open(hunting));
    expect(s.subgraphs).toEqual({ 'company-research': research });
    expect(reduce(s, open({ ...emptyGraph('other', 'Other', 't') })).subgraphs).toEqual({});
  });

  it('treats an inner graph the engine has not sent yet as pending, not as missing, and still reports one it says is missing', () => {
    const opened = reduce(initialState, { kind: 'server', msg: { type: 'graphOpened', changes: [], graph: hunting, runs: [], variableValues: {} } });
    // Nothing received yet: no problem on the card, none in the scope bar, and no "changed since run".
    expect(liveExpansion(opened)).toBeUndefined();
    expect(scopeProblem({ ...opened, scope: ['n4'] })).toBeUndefined();
    const [, card] = buildFlowNodes({ ...base, graph: hunting, approvals: [], subgraphs: opened.subgraphs, problems: [] });
    expect(card.data.subgraph).toEqual({ graphName: 'company-research' });
    const finished: RunMeta = { ...run({}), status: 'succeeded', snapshot: { ...hunting, nodes: [...hunting.nodes, step('n4/n1'), step('n4/n2')] } };
    expect(changedSinceRun({ run: finished, graph: hunting, subgraphs: opened.subgraphs })).toBe(false);
    // The engine sends every reachable id, the missing ones with a reason: that is a problem.
    const gone = reduce(opened, { kind: 'server', msg: { type: 'subgraphs', graphId: 'job-hunting', graphs: { 'company-research': { error: 'graph "company-research" not found', reason: 'missing' } }, reviews: {} } });
    const r = liveExpansion(gone);
    expect(r && !r.ok && r.problems[0].message).toBe('Step n4 uses graph "company-research", which isn\'t in this folder.');
    expect(scopeProblem({ ...gone, scope: ['n4'] })).toBe('This step uses graph "company-research", which isn\'t in this folder.');
  });

  it('expands the live graph with them, the same object while nothing changes', () => {
    const s = [open(hunting), { kind: 'server', msg: { type: 'subgraphs', graphId: 'job-hunting', graphs: { 'company-research': research }, reviews: {} } } as Action].reduce(reduce, initialState);
    const r = liveExpansion(s);
    expect(r?.ok && r.graph.nodes.map((n) => n.id)).toEqual(['n1', 'n4', 'n4/n1', 'n4/n2']);
    expect(liveExpansion(s)).toBe(r);
    expect(shownGraph({ ...s, scope: ['n4'] })).toBe(research);
    expect(scopeProblem({ ...s, scope: ['n4'] })).toBeUndefined();
    expect(scopeProblem({ ...s, subgraphs: { 'company-research': { error: 'line 2: bad', reason: 'broken', name: 'Company research' } }, scope: ['n4'] })).toBe('This step uses graph "Company research", whose file has errors: line 2: bad');
  });
});

describe('a sub-graph step’s card (spec §6.2)', () => {
  it('gets the inner graph’s name and step count, the derived status, and the approval mark of a step inside it', () => {
    const [, card] = buildFlowNodes({ ...base, graph: hunting, run: run({ n4: { status: 'queued' }, 'n4/n1': { status: 'waiting_approval' } }), approvals: [approval('n4/n1')], subgraphs: { 'company-research': research } });
    expect(card.data).toMatchObject({ subgraph: { graphName: 'Company research', steps: 2 }, state: { status: 'waiting_approval' }, waiting: true });
  });

  it('shows the expansion problem at or inside it', () => {
    const problems = [{ stepId: 'n4/n7', message: 'Step n4/n7 uses graph "gone", which isn\'t in this folder.' }];
    const [, card] = buildFlowNodes({ ...base, graph: hunting, approvals: [], subgraphs: { 'company-research': research }, problems });
    expect(card.data.subgraph?.problem).toBe(problems[0].message);
  });

  it('inside a sub-graph, reads its steps’ run state under their expanded ids', () => {
    const [first] = buildFlowNodes({ ...base, graph: research, run: run({ 'n4/n1': { status: 'succeeded' }, n1: { status: 'failed' } }), approvals: [approval('n4/n1')], prefix: 'n4/' });
    expect(first.data).toMatchObject({ state: { status: 'succeeded' }, waiting: true });
  });

  it('renders ⧉, the inner graph and its steps, and a problem in the error style with the message as its tooltip', async () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    const props = { id: 'n4', data: { node: hunting.nodes[1], waiting: false, subgraph: { graphName: 'Company research', steps: 3, problem: 'Step n4 uses graph "Company research", which has no steps.' } }, selected: false } as unknown as NodeProps<StepFlowNode>;
    await act(async () => root.render(createElement(ReactFlowProvider, null, createElement(StepNode, props))));
    const card = container.querySelector('.step')!;
    expect(card.classList.contains('kind-graph')).toBe(true);
    expect(card.classList.contains('subgraph-problem')).toBe(true);
    expect(card.querySelector('.kind-icon')?.textContent).toBe('⧉');
    expect(card.querySelector('.subgraph-line')?.textContent).toContain('Company research · 3 steps');
    expect(card.querySelector('.subgraph-line')?.getAttribute('title')).toBe('Step n4 uses graph "Company research", which has no steps.');
    await act(async () => root.unmount());
  });
});
