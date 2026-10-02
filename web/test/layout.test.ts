import { describe, expect, it } from 'vitest';
import { applyOp, emptyGraph, type Graph, type Op } from '@claude-stream/shared';
import { layoutPositions } from '../src/layout';

function graphOf(ops: Op[]): Graph {
  let g = emptyGraph('g', 'G', 't');
  for (const op of ops) {
    const r = applyOp(g, op, 'user', 't');
    if (!r.ok) throw new Error(r.error);
    g = r.graph;
  }
  return g;
}
const agent = (title: string): Op => ({ type: 'addNode', node: { title, kind: 'agent', prompt: 'p' } });

describe('layoutPositions', () => {
  it('lays out a chain from left to right', () => {
    const p = layoutPositions(graphOf([agent('a'), agent('b'), agent('c'), { type: 'connect', from: 'n1', to: 'n2' }, { type: 'connect', from: 'n2', to: 'n3' }]), false);
    expect(p.get('n1')!.x).toBeLessThan(p.get('n2')!.x);
    expect(p.get('n2')!.x).toBeLessThan(p.get('n3')!.x);
  });

  it('only places nodes without a position when asked', () => {
    const g = graphOf([agent('a'), { type: 'addNode', node: { title: 'b', kind: 'agent', prompt: 'p', position: { x: 500, y: 500 } } }]);
    expect([...layoutPositions(g, true).keys()]).toEqual(['n1']);
  });
});
