import { describe, expect, it } from 'vitest';
import { diffGraphs } from '../src/changes';
import { applyOp, emptyGraph, parseWebviewMessage, type Graph, type GraphNode } from '../src';

const node = (id: string, over: Partial<GraphNode> = {}): GraphNode => ({ id, title: id, kind: 'agent', prompt: 'p', createdBy: 'user', updatedBy: 'user', updatedAt: 't', ...over });
const graph = (nodes: GraphNode[], edges: [string, string][] = []): Graph => ({ ...emptyGraph('g', 'G', 't'), nodes, edges: edges.map(([from, to]) => ({ id: `${from}->${to}`, from, to })) });

describe('diffGraphs', () => {
  it('finds added, changed and removed steps, with the changed fields', () => {
    const base = graph([node('n1'), node('n2'), node('n3')]);
    const now = graph([node('n1', { prompt: 'better', description: 'd' }), node('n3'), node('n4')]);
    expect(diffGraphs(base, now)).toEqual([
      { kind: 'node', change: 'changed', id: 'n1', title: 'n1', fields: ['description', 'prompt'] },
      { kind: 'node', change: 'removed', id: 'n2', title: 'n2' },
      { kind: 'node', change: 'added', id: 'n4', title: 'n4' },
    ]);
  });
  it('finds added and removed connections', () => {
    const base = graph([node('n1'), node('n2'), node('n3')], [['n1', 'n2']]);
    const now = graph([node('n1'), node('n2'), node('n3')], [['n1', 'n3']]);
    expect(diffGraphs(base, now)).toEqual([
      { kind: 'edge', change: 'removed', id: 'n1->n2', from: 'n1', to: 'n2' },
      { kind: 'edge', change: 'added', id: 'n1->n3', from: 'n1', to: 'n3' },
    ]);
  });
  it('ignores moves and authorship bookkeeping', () => {
    const base = graph([node('n1', { position: { x: 0, y: 0 } })]);
    const now = graph([node('n1', { position: { x: 50, y: 9 }, updatedBy: 'agent', updatedAt: 'later' })]);
    expect(diffGraphs(base, now)).toEqual([]);
  });
});

describe('review ops', () => {
  it('are accepted from a client, and left to the graph store by applyOp', () => {
    for (const op of [
      { type: 'acceptChange', target: { kind: 'node', id: 'n1' } },
      { type: 'revertChange', target: { kind: 'edge', id: 'n1->n2' } },
      { type: 'acceptChange', target: { kind: 'all' } },
    ] as const) {
      const msg = { type: 'op', graphId: 'g', op };
      expect(parseWebviewMessage(msg)).toEqual({ ok: true, kind: 'engine', msg });
      expect(applyOp(graph([node('n1')]), op, 'user', 't')).toEqual({ ok: false, error: 'acceptChange and revertChange are applied by the graph store' });
    }
    expect(parseWebviewMessage({ type: 'op', graphId: 'g', op: { type: 'revertChange', target: { kind: 'step', id: 'n1' } } }).ok).toBe(false);
  });
});

describe('changed fields for access and workspace', () => {
  it('lists access and workspace changes', () => {
    expect(diffGraphs(graph([node('n1')]), graph([node('n1', { access: 'read', workspace: 'wh_a' })]))).toEqual([
      { kind: 'node', change: 'changed', id: 'n1', title: 'n1', fields: ['access', 'workspace'] },
    ]);
  });
});
