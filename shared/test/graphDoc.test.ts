import { describe, expect, it } from 'vitest';
import { emptyGraph } from '../src/graph';
import { legacyGraphForMarkdown } from '../src/graphDoc';
import type { Graph, GraphNode } from '../src/types';

const T = '2026-10-01T00:00:00.000Z';
const node = (id: string, title = id): GraphNode => ({ id, title, kind: 'agent', prompt: 'p', createdBy: 'agent', updatedBy: 'user', updatedAt: T });
function graph(nodes: GraphNode[], edges: [string, string][] = [], over: Partial<Graph> = {}): Graph {
  return { ...emptyGraph('g1', 'G', T), nodes, edges: edges.map(([from, to]) => ({ id: `${from}->${to}`, from, to })), ...over };
}

describe('legacyGraphForMarkdown', () => {
  it('renames step ids the Markdown refuses: runs of "-" collapsed, a trailing "-" dropped, edges following', () => {
    const r = legacyGraphForMarkdown(graph([node('fix-'), node('a--b'), node('ok'), node('x---y--')], [['fix-', 'a--b'], ['a--b', 'ok'], ['ok', 'x---y--']]));
    expect(r.renamed).toEqual([
      { from: 'fix-', to: 'fix' },
      { from: 'a--b', to: 'a-b' },
      { from: 'x---y--', to: 'x-y' },
    ]);
    expect(r.graph.nodes.map((n) => n.id)).toEqual(['fix', 'a-b', 'ok', 'x-y']);
    expect(r.graph.nodes[0]).toEqual({ ...node('fix-'), id: 'fix' });
    expect(r.graph.edges).toEqual([
      { id: 'fix->a-b', from: 'fix', to: 'a-b' },
      { id: 'a-b->ok', from: 'a-b', to: 'ok' },
      { id: 'ok->x-y', from: 'ok', to: 'x-y' },
    ]);
  });

  it('gives the next free n<number> when the shortened id is empty, invalid or already used', () => {
    const r = legacyGraphForMarkdown(graph([node('n2'), node('fix'), node('fix-'), node('-'), node('con-'), node('n4')], [], { nodeSeq: 2 }));
    expect(r.renamed).toEqual([
      { from: 'fix-', to: 'n5' },
      { from: '-', to: 'n6' },
      { from: 'con-', to: 'n7' },
    ]);
    expect(r.graph.nodes.map((n) => n.id)).toEqual(['n2', 'fix', 'n5', 'n6', 'n7', 'n4']);
    expect(r.graph.nodeSeq).toBe(7);
  });

  it('gives an empty name the graph id and an empty title "Untitled step"', () => {
    const r = legacyGraphForMarkdown(graph([node('n1', ''), node('n2', ' \n '), node('n3', 'Kept')], [], { name: '  ' }));
    expect(r.graph.name).toBe('g1');
    expect(r.graph.nodes.map((n) => n.title)).toEqual(['Untitled step', 'Untitled step', 'Kept']);
    expect(r.renamed).toEqual([]);
  });

  it('leaves a graph the Markdown can hold as it is', () => {
    const g = graph([node('n1'), node('build-step')], [['n1', 'build-step']]);
    expect(legacyGraphForMarkdown(g)).toEqual({ graph: g, renamed: [] });
  });

  it('follows renames given (a baseline after its graph) and never gives a reserved id', () => {
    const r = legacyGraphForMarkdown(graph([node('fix-'), node('gone-'), node('n1')], [['fix-', 'n1']]), new Map([['fix-', 'fix']]), ['gone', 'n3']);
    expect(r.graph.nodes.map((n) => n.id)).toEqual(['fix', 'n4', 'n1']);
    expect(r.graph.edges).toEqual([{ id: 'fix->n1', from: 'fix', to: 'n1' }]);
    expect(r.renamed).toEqual([
      { from: 'fix-', to: 'fix' },
      { from: 'gone-', to: 'n4' },
    ]);
  });
});
