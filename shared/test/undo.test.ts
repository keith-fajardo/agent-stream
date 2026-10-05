import { describe, expect, it } from 'vitest';
import { applyOp, emptyGraph } from '../src/graph';
import { canonicalGraph } from '../src/graphDoc';
import { deletedLabel, movedLabel, undoLabel, undoOps, undoState } from '../src/undo';
import type { Graph, Op } from '../src/types';
import { FIXTURES, randomGraph } from './graphFixtures';

const T = '2026-10-05T00:00:00.000Z';
function run(g: Graph, ops: Op[]): Graph {
  let out = g;
  for (const op of ops) {
    const r = applyOp(out, op, 'user', T);
    if (!r.ok) throw new Error(`${op.type}: ${r.error}`);
    out = r.graph;
  }
  return canonicalGraph(out);
}

describe('undoOps (spec §6a.2)', () => {
  const g = canonicalGraph(FIXTURES.example);

  it('takes the graph back to before, whatever the action was', () => {
    const actions: Op[][] = [
      [{ type: 'deleteNode', id: 'n2' }],
      [{ type: 'addNode', node: { id: 'n9', title: 'New', kind: 'agent', prompt: 'p', position: { x: 1, y: 2 } } }, { type: 'connect', from: 'n3', to: 'n9' }],
      [{ type: 'updateNode', id: 'n2', patch: { title: 'Run it', prompt: 'Go.', model: { provider: 'claude', id: 'opus' }, effort: 'high' } }],
      [{ type: 'updateNode', id: 'n1', patch: { kind: 'agent', prompt: 'think' } }],
      [{ type: 'disconnect', from: 'n1', to: 'n2' }],
      [{ type: 'moveNode', id: 'n1', position: { x: 50, y: 60 } }, { type: 'moveNode', id: 'n2', position: { x: 70, y: 80 } }],
      [{ type: 'setGoal', goal: 'Other.' }, { type: 'setInstructions', instructions: '' }],
      [{ type: 'deleteVariable', name: 'target_schema' }],
      [{ type: 'setVariableDescription', name: 'target_schema', description: 'Where' }],
    ];
    for (const ops of actions) {
      const after = run(g, ops);
      expect(undoState(after), JSON.stringify(ops)).not.toBe(undoState(g));
      expect(undoState(run(after, undoOps(after, g, ops))), JSON.stringify(ops)).toBe(undoState(g));
    }
  });

  it('puts a step that had no place back on the automatic layout', () => {
    const before = run(emptyGraph('g', 'G', T), [{ type: 'addNode', node: { id: 'n1', title: 'a', kind: 'agent' } }]);
    const after = run(before, [{ type: 'moveNode', id: 'n1', position: { x: 5, y: 5 } }]);
    const ops = undoOps(after, before);
    expect(ops).toEqual([{ type: 'moveNode', id: 'n1', position: null }]);
    expect(run(after, ops).nodes[0]).not.toHaveProperty('position');
  });

  it('renames a renamed variable back, so the steps using it follow', () => {
    const before = run(emptyGraph('g', 'G', T), [{ type: 'addVariable', name: 'a' }]);
    const op: Op = { type: 'renameVariable', name: 'a', newName: 'b' };
    expect(undoOps(run(before, [op]), before, [op])).toEqual([{ type: 'renameVariable', name: 'b', newName: 'a' }]);
  });

  it('works for generated graphs: deleting every step and undoing gives the graph back', () => {
    for (let seed = 1; seed <= 100; seed++) {
      const g0 = canonicalGraph(randomGraph(seed));
      const emptied = run(g0, g0.nodes.map((n): Op => ({ type: 'deleteNode', id: n.id })));
      expect(undoState(run(emptied, undoOps(emptied, g0))), `seed ${seed}`).toBe(undoState(g0));
    }
  });
});

describe('undoState', () => {
  it('ignores order, the name and bookkeeping, and sees content and places', () => {
    const g = canonicalGraph(FIXTURES.example);
    const shuffled: Graph = { ...g, name: 'Renamed', nodeSeq: 99, updatedAt: 'x', nodes: [...g.nodes].reverse().map((n) => ({ ...n, updatedBy: 'agent', updatedAt: 'y' })), edges: [...g.edges].reverse() };
    expect(undoState(shuffled)).toBe(undoState(g));
    expect(undoState(run(g, [{ type: 'moveNode', id: 'n1', position: { x: 9, y: 9 } }]))).not.toBe(undoState(g));
  });
});

describe('undo labels', () => {
  it('name each kind of action', () => {
    expect(undoLabel({ type: 'updateNode', id: 'n3', patch: { effort: 'high' } })).toBe('saved n3');
    expect(undoLabel({ type: 'deleteNode', id: 'n3' })).toBe('deleted n3');
    expect(undoLabel({ type: 'addNode', node: { id: 'n4', title: 'x', kind: 'agent' } })).toBe('added n4');
    expect(undoLabel({ type: 'connect', from: 'n1', to: 'n2' })).toBe('connected n1 → n2');
    expect(undoLabel({ type: 'setGoal', goal: 'g' })).toBe('edited the goal');
    expect(undoLabel({ type: 'renameVariable', name: 'a', newName: 'b' })).toBe('renamed variable a');
    expect(undoLabel({ type: 'acceptChange', target: { kind: 'all' } })).toBeUndefined();
    expect(movedLabel(['n3'])).toBe('moved n3');
    expect(movedLabel(['n1', 'n2'])).toBe('moved 2 steps');
    expect(deletedLabel(['n3'], [])).toBe('deleted n3');
    expect(deletedLabel(['n1', 'n2', 'n3'], [])).toBe('deleted 3 steps');
    expect(deletedLabel([], [{ from: 'n1', to: 'n2' }])).toBe('deleted the connection n1 → n2');
    expect(deletedLabel(['n4', 'n5'], [{ from: 'n1', to: 'n2' }])).toBe('deleted 2 steps and 1 connection');
  });
});
