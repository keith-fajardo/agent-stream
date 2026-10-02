import { describe, expect, it } from 'vitest';
import { applyOp, emptyGraph, type Graph, type Op, type RunMeta } from '@claude-stream/shared';
import { describeRunPlan } from '../src/runPlan';

function graphOf(ops: Op[]): Graph {
  let g = emptyGraph('g', 'G', 't');
  for (const op of ops) {
    const r = applyOp(g, op, 'user', 't');
    if (!r.ok) throw new Error(r.error);
    g = r.graph;
  }
  return g;
}
const cmd = (title: string, command: string): Op => ({ type: 'addNode', node: { title, kind: 'command', command } });
const link = (from: string, to: string): Op => ({ type: 'connect', from, to });
const g = graphOf([
  cmd('Build old', 'dbt build -s orders --target old'),
  cmd('Build new', 'dbt build -s orders_v2'),
  { type: 'addNode', node: { title: 'Compare', kind: 'agent', prompt: 'compare' } },
  link('n1', 'n3'),
  link('n2', 'n3'),
]);

describe('describeRunPlan', () => {
  it('lists every command and counts agent steps for a full run', () => {
    expect(describeRunPlan(g, {})).toEqual({ problems: [], commands: [g.nodes[0], g.nodes[1]], agentCount: 1, reused: [], exact: true });
  });

  it('shows only what a re-run will execute when the source run is loaded', () => {
    const source: RunMeta = {
      id: 'r1',
      graphId: 'g',
      status: 'failed',
      startedAt: 't',
      snapshot: g,
      nodes: { n1: { status: 'succeeded' }, n2: { status: 'succeeded' }, n3: { status: 'failed' } },
    };
    expect(describeRunPlan(g, { fromNodeId: 'n3', sourceRunId: 'r1' }, source)).toMatchObject({ commands: [], agentCount: 1, reused: ['n1', 'n2'], exact: true });
  });

  it('falls back to listing every command when the source run is not loaded', () => {
    expect(describeRunPlan(g, { fromNodeId: 'n3', sourceRunId: 'r9' })).toMatchObject({ commands: [g.nodes[0], g.nodes[1]], exact: false });
  });

  it('reports why a graph cannot run', () => {
    const draft = graphOf([{ type: 'addNode', node: { title: 'x', kind: 'command' } }]);
    expect(describeRunPlan(draft, {}).problems).toEqual(['n1 "x": a command node needs a command.']);
  });
});
