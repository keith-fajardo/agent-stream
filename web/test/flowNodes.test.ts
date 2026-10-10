import { describe, expect, it } from 'vitest';
import type { Edge as FlowEdge } from '@xyflow/react';
import { applyOp, diffGraphs, emptyGraph, type AgentChange, type Graph, type Op, type Position, type RunMeta } from '@agent-stream/shared';
import { buildFlowEdges, buildFlowNodes } from '../src/flowNodes';
import type { StepFlowNode } from '../src/components/StepNode';

function graphOf(ops: Op[]): Graph {
  let g = emptyGraph('g', 'G', 't');
  for (const op of ops) {
    const r = applyOp(g, op, 'user', 't');
    if (!r.ok) throw new Error(r.error);
    g = r.graph;
  }
  return g;
}
const add = (id: string, position?: Position): Op => ({ type: 'addNode', node: { id, title: id, kind: 'agent', prompt: '', ...(position ? { position } : {}) } });
const base = { approvals: [], selectionChanged: true, current: [] as StepFlowNode[], dragging: new Set<string>(), pendingMoves: new Map<string, Position>() };

describe('buildFlowNodes', () => {
  it('places nodes at server or auto positions and selects selectedId', () => {
    const graph = graphOf([add('n1', { x: 10, y: 20 }), add('n2')]);
    const nodes = buildFlowNodes({ ...base, graph, selectedId: 'n2' });
    expect(nodes[0]!.position).toEqual({ x: 10, y: 20 });
    expect(Number.isFinite(nodes[1]!.position.x)).toBe(true);
    expect(nodes.map((n) => n.selected)).toEqual([false, true]);
  });

  it('keeps the local position and dragging flag of a node being dragged', () => {
    const graph = graphOf([add('n1', { x: 10, y: 20 })]);
    const current = [{ id: 'n1', type: 'step', position: { x: 99, y: 99 }, dragging: true, data: { node: graph.nodes[0]!, waiting: false } }] as StepFlowNode[];
    const [n] = buildFlowNodes({ ...base, graph, current, dragging: new Set(['n1']) });
    expect(n!.position).toEqual({ x: 99, y: 99 });
    expect(n!.dragging).toBe(true);
  });

  it('uses a pending move until the server echoes it, then forgets it', () => {
    const pendingMoves = new Map([['n1', { x: 50, y: 60 }]]);
    const old = graphOf([add('n1', { x: 10, y: 20 })]);
    expect(buildFlowNodes({ ...base, graph: old, pendingMoves })[0]!.position).toEqual({ x: 50, y: 60 });
    expect(pendingMoves.has('n1')).toBe(true);
    const echoed = graphOf([add('n1', { x: 50, y: 60 })]);
    expect(buildFlowNodes({ ...base, graph: echoed, pendingMoves })[0]!.position).toEqual({ x: 50, y: 60 });
    expect(pendingMoves.has('n1')).toBe(false);
  });

  it('preserves local multi-selection unless the selected id changed', () => {
    const graph = graphOf([add('n1', { x: 0, y: 0 }), add('n2', { x: 0, y: 100 })]);
    const first = buildFlowNodes({ ...base, graph });
    const current = first.map((n) => ({ ...n, selected: true }));
    expect(buildFlowNodes({ ...base, graph, current, selectionChanged: false }).map((n) => n.selected)).toEqual([true, true]);
    expect(buildFlowNodes({ ...base, graph, current, selectionChanged: true, selectedId: 'n1' }).map((n) => n.selected)).toEqual([true, false]);
  });

  it('keeps React Flow measurements across rebuilds and clears a finished drag', () => {
    const graph = graphOf([add('n1', { x: 10, y: 20 })]);
    const current = [
      { id: 'n1', type: 'step', position: { x: 10, y: 20 }, measured: { width: 220, height: 70 }, dragging: true, data: { node: graph.nodes[0]!, waiting: false } },
    ] as StepFlowNode[];
    const [n] = buildFlowNodes({ ...base, graph, current });
    expect(n!.measured).toEqual({ width: 220, height: 70 });
    expect(n!.dragging).toBeUndefined();
  });

  it('drops nodes that are no longer in the graph', () => {
    const two = graphOf([add('n1', { x: 0, y: 0 }), add('n2', { x: 0, y: 100 })]);
    const current = buildFlowNodes({ ...base, graph: two });
    const one = graphOf([add('n1', { x: 0, y: 0 })]);
    expect(buildFlowNodes({ ...base, graph: one, current }).map((n) => n.id)).toEqual(['n1']);
  });
});

describe('buildFlowEdges', () => {
  const link = (from: string, to: string): Op => ({ type: 'connect', from, to });
  const chain = graphOf([add('n1'), add('n2'), add('n3'), link('n1', 'n2'), link('n2', 'n3')]);
  const runWith = (graph: Graph, nodes: RunMeta['nodes']): RunMeta => ({ id: 'r', graphId: graph.id, status: 'running', startedAt: 't', snapshot: graph, nodes });

  it('builds arrowed edges and keeps local edge selection across rebuilds', () => {
    const first = buildFlowEdges(chain, undefined, []);
    expect(first.map((e) => [e.id, e.source, e.target])).toEqual([
      ['n1->n2', 'n1', 'n2'],
      ['n2->n3', 'n2', 'n3'],
    ]);
    expect(first[0]!.markerEnd).toEqual({ type: 'arrowclosed' });
    expect(first.map((e) => e.selected)).toEqual([false, false]);
    const current: FlowEdge[] = first.map((e) => (e.id === 'n2->n3' ? { ...e, selected: true } : e));
    expect(buildFlowEdges(chain, undefined, current).map((e) => e.selected)).toEqual([false, true]);
  });

  it('carries a label on a labeled edge and none on an unlabeled one', () => {
    const labeled: Graph = { ...chain, edges: chain.edges.map((e) => (e.id === 'n1->n2' ? { ...e, label: 'yes' as const } : e)) };
    const [first, second] = buildFlowEdges(labeled, undefined, []);
    expect(first!.label).toBe('yes');
    expect('label' in second!).toBe(false);
  });

  it('animates edges into a running node', () => {
    const run = runWith(chain, { n1: { status: 'succeeded' }, n2: { status: 'running' }, n3: { status: 'queued' } });
    expect(buildFlowEdges(chain, run, []).map((e) => e.animated)).toEqual([true, false]);
  });

  it('drops edges that are no longer in the graph', () => {
    const current = buildFlowEdges(chain, undefined, []).map((e) => ({ ...e, selected: true }));
    const unlinked = graphOf([add('n1'), add('n2'), add('n3'), link('n1', 'n2')]);
    expect(buildFlowEdges(unlinked, undefined, current).map((e) => e.id)).toEqual(['n1->n2']);
  });
});

describe('agent changes on the canvas', () => {
  const link = (from: string, to: string): Op => ({ type: 'connect', from, to });
  const baseline = graphOf([add('n1', { x: 0, y: 0 }), add('n2', { x: 300, y: 0 }), add('n3', { x: 600, y: 0 }), link('n1', 'n2'), link('n2', 'n3')]);
  // n2 changed, n3 removed (with its edge), n4 added (with an edge from n1).
  const graph = graphOf([
    add('n1', { x: 0, y: 0 }),
    add('n2', { x: 300, y: 0 }),
    add('n4', { x: 300, y: 200 }),
    link('n1', 'n2'),
    link('n1', 'n4'),
    { type: 'updateNode', id: 'n2', patch: { prompt: 'new' } },
  ]);
  const planner = { kind: 'planner' as const };
  const step = { kind: 'step' as const, runId: 'r1', nodeId: 'n2' };
  const changes: AgentChange[] = diffGraphs(baseline, graph).map((c) => {
    if (c.kind === 'node' && c.change === 'added') return { ...c, by: planner };
    if (c.kind === 'node' && c.change === 'changed') return { ...c, by: step };
    return { ...c, by: planner };
  });
  const nodes = buildFlowNodes({ ...base, graph, baseline, changes });
  const byId = (id: string) => nodes.find((n) => n.id === id)!;

  it('marks added and changed steps with who made the change', () => {
    expect(byId('n4').data).toMatchObject({ change: 'added', changeBy: planner });
    expect(byId('n2').data).toMatchObject({ change: 'changed', changeBy: step, changeFields: ['prompt'] });
    expect(byId('n1').data.change).toBeUndefined();
  });

  it('shows a removed step as a ghost at its baseline position that cannot be selected', () => {
    const ghost = byId('ghost:n3');
    expect(ghost.position).toEqual({ x: 600, y: 0 });
    expect(ghost.data).toMatchObject({ ghost: true, change: 'removed', changeBy: planner });
    expect([ghost.selectable, ghost.draggable, ghost.deletable, ghost.connectable]).toEqual([false, false, false, false]);
    expect(ghost.selected).toBe(false);
    expect(nodes.filter((n) => n.data.ghost)).toHaveLength(1);
  });

  it('places a ghost with no baseline position by the baseline layout', () => {
    const unplaced = graphOf([add('n1'), add('n2'), link('n1', 'n2')]);
    const now = graphOf([add('n1')]);
    const ghost = buildFlowNodes({ ...base, graph: now, baseline: unplaced, changes: diffGraphs(unplaced, now) }).find((n) => n.id === 'ghost:n2')!;
    expect(Number.isFinite(ghost.position.x) && Number.isFinite(ghost.position.y)).toBe(true);
  });

  it('shows no marks without changes', () => {
    const plain = buildFlowNodes({ ...base, graph });
    expect(plain.some((n) => n.data.change || n.data.ghost)).toBe(false);
  });

  it('classes an added edge and draws a removed one as a ghost between real or ghost steps', () => {
    const edges = buildFlowEdges(graph, undefined, [], changes);
    expect(edges.find((e) => e.id === 'n1->n4')!.className).toBe('edge-added');
    expect(edges.find((e) => e.id === 'n1->n2')!.className).toBeUndefined();
    const ghost = edges.find((e) => e.id === 'ghost:n2->n3')!;
    expect(ghost).toMatchObject({ source: 'n2', target: 'ghost:n3', className: 'edge-removed', selectable: false, deletable: false });
  });

  it('skips a ghost edge whose end is gone everywhere', () => {
    const orphan: AgentChange[] = [{ kind: 'edge', change: 'removed', id: 'x->y', from: 'x', to: 'y' }];
    expect(buildFlowEdges(graph, undefined, [], orphan).map((e) => e.id)).not.toContain('ghost:x->y');
  });
});
