import { describe, expect, it } from 'vitest';
import { isWriteCapable, parallelWriteSteps, workspaceNameProblem, workspaceOf } from '../src/access';
import { applyOp, emptyGraph } from '../src/graph';
import type { Graph, Op } from '../src/types';

function build(ops: Op[]): Graph {
  let g = emptyGraph('g', 'G', 't');
  for (const op of ops) {
    const r = applyOp(g, op, 'user', 't');
    if (!r.ok) throw new Error(r.error);
    g = r.graph;
  }
  return g;
}
const writer = (title: string, workspace?: string): Op => ({ type: 'addNode', node: { title, kind: 'agent', prompt: 'p', ...(workspace && { workspace }) } });
const reader = (title: string): Op => ({ type: 'addNode', node: { title, kind: 'agent', prompt: 'p', access: 'read' } });
const command = (title: string, workspace?: string): Op => ({ type: 'addNode', node: { title, kind: 'command', command: 'make', ...(workspace && { workspace }) } });
const link = (from: string, to: string): Op => ({ type: 'connect', from, to });

describe('isWriteCapable', () => {
  it('is true for command steps, and for agent steps unless they are read-only', () => {
    expect(isWriteCapable({ kind: 'command' })).toBe(true);
    expect(isWriteCapable({ kind: 'agent' })).toBe(true);
    expect(isWriteCapable({ kind: 'agent', access: 'write' })).toBe(true);
    expect(isWriteCapable({ kind: 'agent', access: 'read' })).toBe(false);
  });
});

describe('workspaceOf', () => {
  it('is the workspace name, or null for the checkout', () => {
    expect(workspaceOf({ workspace: 'wh_small' })).toBe('wh_small');
    expect(workspaceOf({})).toBeNull();
  });
});

describe('workspaceNameProblem', () => {
  it.each(['a', 'wh_small', 'wh-large', 'v2', 'a'.repeat(40)])('accepts %s', (name) => expect(workspaceNameProblem(name)).toBeNull());
  it.each(['', 'Wh', '2v', '_a', '-a', 'a b', 'a/b', '..', 'a'.repeat(41)])('refuses %j', (name) =>
    expect(workspaceNameProblem(name)).toBe('Workspace names use lowercase letters, digits, - and _, starting with a letter.'),
  );
});

describe('parallelWriteSteps', () => {
  it('pairs write-capable steps of one workspace that have no path between them', () => {
    const g = build([writer('a'), writer('b'), reader('c'), command('d'), link('n1', 'n4')]);
    expect(parallelWriteSteps(g)).toEqual([
      ['n1', 'n2'],
      ['n2', 'n4'],
    ]);
  });

  it('treats each variant workspace on its own, and the checkout as one more', () => {
    const g = build([writer('a', 'wh_a'), command('b', 'wh_a'), writer('c', 'wh_b'), writer('d')]);
    expect(parallelWriteSteps(g)).toEqual([['n1', 'n2']]);
  });

  it('finds nothing in a chain', () => {
    expect(parallelWriteSteps(build([writer('a'), writer('b'), writer('c'), link('n1', 'n2'), link('n2', 'n3')]))).toEqual([]);
  });
});
