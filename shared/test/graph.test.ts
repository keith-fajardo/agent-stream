import { describe, expect, it } from 'vitest';
import {
  applyOp,
  descendants,
  emptyGraph,
  nextNodeId,
  reusableNodeIds,
  topoOrder,
  upstream,
  validateRunnable,
  wouldCreateCycle,
} from '../src/graph';
import type { Graph, NodeRunState, Op } from '../src/types';

const T = '2026-10-02T00:00:00.000Z';
const T2 = '2026-10-02T00:00:05.000Z';

function build(ops: Op[], by: 'user' | 'agent' = 'user'): Graph {
  let g = emptyGraph('g', 'G', T);
  for (const op of ops) {
    const r = applyOp(g, op, by, T);
    if (!r.ok) throw new Error(r.error);
    g = r.graph;
  }
  return g;
}
const agent = (title: string, prompt = `do ${title}`): Op => ({ type: 'addNode', node: { title, kind: 'agent', prompt } });
const cmd = (title: string, command: string): Op => ({ type: 'addNode', node: { title, kind: 'command', command } });
const link = (from: string, to: string): Op => ({ type: 'connect', from, to });

function expectError(g: Graph, op: Op, message: string) {
  const r = applyOp(g, op, 'user', T2);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toContain(message);
}

describe('applyOp', () => {
  it('adds nodes with sequential ids and records the author', () => {
    const g = build([agent('a'), cmd('b', 'echo hi')], 'agent');
    expect(g.nodes.map((n) => n.id)).toEqual(['n1', 'n2']);
    expect(g.nodes[0]).toEqual({ id: 'n1', title: 'a', kind: 'agent', prompt: 'do a', createdBy: 'agent', updatedBy: 'agent', updatedAt: T });
    expect(g.nodes[1].command).toBe('echo hi');
    expect(g.nodeSeq).toBe(2);
  });

  it('never reuses an id after the newest node is deleted', () => {
    const g = build([agent('a'), agent('b'), { type: 'deleteNode', id: 'n2' }, agent('c')]);
    expect(g.nodes.map((n) => n.id)).toEqual(['n1', 'n3']);
    expect(nextNodeId(g)).toBe('n4');
  });

  it('rejects duplicate ids, invalid ids and blank titles', () => {
    const g = build([agent('a')]);
    expectError(g, { type: 'addNode', node: { id: 'n1', title: 'x', kind: 'agent' } }, 'already exists');
    expectError(g, { type: 'addNode', node: { id: '../x', title: 'x', kind: 'agent' } }, 'invalid node id');
    expectError(g, { type: 'addNode', node: { title: '   ', kind: 'agent' } }, 'needs a title');
  });

  it('allows empty prompts while drafting', () => {
    const g = build([{ type: 'addNode', node: { title: 'draft', kind: 'agent', prompt: '' } }]);
    expect(g.nodes[0].prompt).toBe('');
  });

  it('updates only the provided fields and records who edited', () => {
    const g = build([agent('a')], 'agent');
    const r = applyOp(g, { type: 'updateNode', id: 'n1', patch: { prompt: 'new', title: undefined } }, 'user', T2);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.graph.nodes[0]).toMatchObject({ title: 'a', prompt: 'new', createdBy: 'agent', updatedBy: 'user', updatedAt: T2 });
    expectError(g, { type: 'updateNode', id: 'n9', patch: { title: 'x' } }, 'does not exist');
    expectError(g, { type: 'updateNode', id: 'n1', patch: { title: ' ' } }, 'needs a title');
  });

  it('deletes a node together with its edges', () => {
    const g = build([agent('a'), agent('b'), agent('c'), link('n1', 'n2'), link('n2', 'n3')]);
    const r = applyOp(g, { type: 'deleteNode', id: 'n2' }, 'user', T2);
    expect(r.ok && r.graph.edges).toEqual([]);
  });

  it('validates connections', () => {
    const g = build([agent('a'), agent('b'), agent('c'), link('n1', 'n2'), link('n2', 'n3')]);
    expect(g.edges.map((e) => e.id)).toEqual(['n1->n2', 'n2->n3']);
    expectError(g, link('n1', 'n1'), 'itself');
    expectError(g, link('n1', 'n2'), 'already exists');
    expectError(g, link('n1', 'n9'), 'does not exist');
    expectError(g, link('n3', 'n1'), 'cycle');
    expectError(g, { type: 'disconnect', from: 'n1', to: 'n3' }, 'does not exist');
    const r = applyOp(g, { type: 'disconnect', from: 'n1', to: 'n2' }, 'user', T2);
    expect(r.ok && r.graph.edges.map((e) => e.id)).toEqual(['n2->n3']);
  });

  it('moves a node without changing who last edited it', () => {
    const g = build([agent('a')], 'agent');
    const r = applyOp(g, { type: 'moveNode', id: 'n1', position: { x: 10, y: 20 } }, 'user', T2);
    expect(r.ok && r.graph.nodes[0]).toMatchObject({ position: { x: 10, y: 20 }, updatedBy: 'agent', updatedAt: T });
  });

  it('sets the goal', () => {
    const r = applyOp(emptyGraph('g', 'G', T), { type: 'setGoal', goal: 'ship it' }, 'agent', T2);
    expect(r.ok && r.graph.goal).toBe('ship it');
  });
});

describe('graph queries', () => {
  const g = build([agent('a'), agent('b'), agent('c'), agent('d'), link('n1', 'n2'), link('n1', 'n3'), link('n2', 'n4'), link('n3', 'n4')]);

  it('orders nodes topologically', () => {
    const order = topoOrder(g);
    expect(order).toHaveLength(4);
    expect(order.indexOf('n1')).toBeLessThan(order.indexOf('n2'));
    expect(order.indexOf('n3')).toBeLessThan(order.indexOf('n4'));
  });

  it('finds upstream nodes, descendants and would-be cycles', () => {
    expect(upstream(g, 'n4').sort()).toEqual(['n2', 'n3']);
    expect([...descendants(g, 'n1')].sort()).toEqual(['n2', 'n3', 'n4']);
    expect(wouldCreateCycle(g, 'n4', 'n1')).toBe(true);
    expect(wouldCreateCycle(g, 'n2', 'n3')).toBe(false);
  });
});

describe('validateRunnable', () => {
  it('reports what blocks a run', () => {
    expect(validateRunnable(emptyGraph('g', 'G', T))).toEqual(['The graph has no nodes.']);
    const g = build([
      { type: 'addNode', node: { title: 'think', kind: 'agent', prompt: ' ' } },
      { type: 'addNode', node: { title: 'build', kind: 'command' } },
    ]);
    expect(validateRunnable(g)).toEqual(['n1 "think": an agent node needs a prompt.', 'n2 "build": a command node needs a command.']);
    expect(validateRunnable(build([agent('a')]))).toEqual([]);
  });
});

describe('reusableNodeIds', () => {
  const chain = build([agent('a'), agent('b'), agent('c'), link('n1', 'n2'), link('n2', 'n3')]);
  const allOk = (g: Graph): Record<string, NodeRunState> =>
    Object.fromEntries(g.nodes.map((n) => [n.id, { status: 'succeeded' as const }]));

  it('re-runs the chosen node and its descendants, reusing the rest', () => {
    expect([...reusableNodeIds(chain, { snapshot: chain, nodes: allOk(chain) }, 'n2')]).toEqual(['n1']);
  });

  it('re-runs nodes that did not succeed last time', () => {
    const nodes = { ...allOk(chain), n1: { status: 'failed' as const } };
    expect([...reusableNodeIds(chain, { snapshot: chain, nodes }, 'n3')]).toEqual([]);
  });

  it('re-runs nodes whose definition changed, plus their descendants', () => {
    const r = applyOp(chain, { type: 'updateNode', id: 'n1', patch: { prompt: 'changed' } }, 'user', T2);
    if (!r.ok) throw new Error(r.error);
    expect([...reusableNodeIds(r.graph, { snapshot: chain, nodes: allOk(chain) }, 'n3')]).toEqual([]);
  });

  it('re-runs nodes whose inputs changed', () => {
    const wide = build([agent('a'), agent('b'), agent('c'), link('n1', 'n2')]);
    const r = applyOp(wide, link('n1', 'n3'), 'user', T2);
    if (!r.ok) throw new Error(r.error);
    expect([...reusableNodeIds(r.graph, { snapshot: wide, nodes: allOk(wide) }, 'n2')]).toEqual(['n1']);
  });
});
