import { describe, expect, it } from 'vitest';
import type { Edge as FlowEdge } from '@xyflow/react';
import { applyOp, emptyGraph, type Graph, type Op, type Position, type RunMeta } from '@claude-stream/shared';
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

  it('animates edges into a running node', () => {
    const run = runWith(chain, { n1: { status: 'succeeded' }, n2: { status: 'running' }, n3: { status: 'pending' } });
    expect(buildFlowEdges(chain, run, []).map((e) => e.animated)).toEqual([true, false]);
  });

  it('drops edges that are no longer in the graph', () => {
    const current = buildFlowEdges(chain, undefined, []).map((e) => ({ ...e, selected: true }));
    const unlinked = graphOf([add('n1'), add('n2'), add('n3'), link('n1', 'n2')]);
    expect(buildFlowEdges(unlinked, undefined, current).map((e) => e.id)).toEqual(['n1->n2']);
  });
});
