import { describe, expect, it } from 'vitest';
import { applyOp, changedSinceSource, emptyGraph, onlyRunPlan, reusableNodeIds, runModeProblem, staleNote } from '../src/graph';
import { parseWebviewMessage } from '../src/schemas';
import type { Graph, NodeRunState, Op, RenderedRun } from '../src/types';

const T = '2026-10-02T00:00:00.000Z';
function build(ops: Op[]): Graph {
  let g = emptyGraph('g', 'G', T);
  for (const op of ops) {
    const r = applyOp(g, op, 'user', T);
    if (!r.ok) throw new Error(r.error);
    g = r.graph;
  }
  return g;
}
const agent = (title: string): Op => ({ type: 'addNode', node: { title, kind: 'agent', prompt: `do ${title}` } });
const link = (from: string, to: string): Op => ({ type: 'connect', from, to });
const edit = (g: Graph, id: string, prompt: string): Graph => {
  const r = applyOp(g, { type: 'updateNode', id, patch: { prompt } }, 'user', T);
  if (!r.ok) throw new Error(r.error);
  return r.graph;
};
const ok = (status: NodeRunState['status'] = 'succeeded'): NodeRunState => ({ status });
const rendered = (g: Graph): RenderedRun => ({ goal: g.goal, instructions: g.instructions, nodes: Object.fromEntries(g.nodes.map((n) => [n.id, n.prompt ?? ''])) });

// n1 -> n2 -> n3 -> n4 and n2 -> n5
const wide = build([agent('a'), agent('b'), agent('c'), agent('d'), agent('e'), link('n1', 'n2'), link('n2', 'n3'), link('n3', 'n4'), link('n2', 'n5')]);
const allOk = (g: Graph): Record<string, NodeRunState> => Object.fromEntries(g.nodes.map((n) => [n.id, ok()]));

describe('resume (reusableNodeIds with no step)', () => {
  it('runs the steps that did not finish and everything after them', () => {
    const nodes = { ...allOk(wide), n3: ok('cancelled'), n4: ok('not_run') };
    expect([...reusableNodeIds(wide, { snapshot: wide, nodes, rendered: rendered(wide) }, undefined, rendered(wide))].sort()).toEqual(['n1', 'n2', 'n5']);
  });

  it('runs a stale step as if it had not succeeded, and its descendants', () => {
    const nodes = { ...allOk(wide), n3: { status: 'succeeded' as const, stale: { reason: 'edited' as const, runId: 'r1' } } };
    expect([...reusableNodeIds(wide, { snapshot: wide, nodes }, undefined)].sort()).toEqual(['n1', 'n2', 'n5']);
  });

  it('re-runs a stale step on a from re-run too', () => {
    const nodes = { ...allOk(wide), n5: { status: 'succeeded' as const, stale: { reason: 'upstream' as const, nodeId: 'n2', runId: 'r1' } } };
    expect([...reusableNodeIds(wide, { snapshot: wide, nodes }, 'n3')].sort()).toEqual(['n1', 'n2']);
  });
});

describe('changedSinceSource', () => {
  it('names the steps whose definition or inputs differ, not their descendants', () => {
    const now = edit(wide, 'n3', 'changed');
    expect([...changedSinceSource(now, { snapshot: wide, nodes: allOk(wide) })]).toEqual(['n3']);
  });

  it('counts a step missing from the source as changed', () => {
    const smaller = build([agent('a')]);
    expect([...changedSinceSource(wide, { snapshot: smaller, nodes: { n1: ok() } })].sort()).toEqual(['n2', 'n3', 'n4', 'n5']);
  });
});

describe('onlyRunPlan', () => {
  const source = { snapshot: wide, nodes: allOk(wide) };

  it('refuses a missing step', () => {
    expect(onlyRunPlan(wide, source, 'n9')).toEqual({ ok: false, error: 'node n9 does not exist' });
  });

  it('reuses everything else and marks the steps after it stale', () => {
    const plan = onlyRunPlan(wide, source, 'n3');
    if (!plan.ok) throw new Error(plan.error);
    expect([...plan.reuse].sort()).toEqual(['n1', 'n2', 'n4', 'n5']);
    expect([...plan.notRun]).toEqual([]);
    expect(Object.fromEntries(plan.stale)).toEqual({ n4: { reason: 'upstream', nodeId: 'n3' } });
  });

  it('reuses a workspace step that is not the chosen one', () => {
    const g = build([agent('a'), { type: 'addNode', node: { title: 'b', kind: 'agent', prompt: 'do b', workspace: 'w1' } }, agent('c'), link('n1', 'n2'), link('n2', 'n3')]);
    const plan = onlyRunPlan(g, { snapshot: g, nodes: allOk(g) }, 'n3');
    if (!plan.ok) throw new Error(plan.error);
    expect([...plan.reuse].sort()).toEqual(['n1', 'n2']);
  });

  it('runs the chosen step even when it is unchanged and succeeded; a step with no ancestors is always allowed', () => {
    const plan = onlyRunPlan(wide, { snapshot: wide, nodes: { n1: ok('failed') } }, 'n1');
    if (!plan.ok) throw new Error(plan.error);
    expect([...plan.reuse]).toEqual([]);
    expect([...plan.notRun].sort()).toEqual(['n2', 'n3', 'n4', 'n5']);
  });

  it('does not run steps that did not succeed', () => {
    const nodes = { ...allOk(wide), n4: ok('cancelled'), n5: ok('failed') };
    const plan = onlyRunPlan(wide, { snapshot: wide, nodes }, 'n2');
    if (!plan.ok) throw new Error(plan.error);
    expect([...plan.reuse].sort()).toEqual(['n1', 'n3']);
    expect([...plan.notRun].sort()).toEqual(['n4', 'n5']);
    expect(Object.fromEntries(plan.stale)).toEqual({ n3: { reason: 'upstream', nodeId: 'n2' } });
  });

  it('carries a step the source run skipped as skipped, not as not run (R32)', () => {
    const nodes = { ...allOk(wide), n4: { status: 'skipped' as const, error: 'not on the taken branch' }, n5: ok('failed') };
    const plan = onlyRunPlan(wide, { snapshot: wide, nodes }, 'n2');
    if (!plan.ok) throw new Error(plan.error);
    expect([...plan.skipped]).toEqual(['n4']);
    expect([...plan.notRun]).toEqual(['n5']);
    expect(plan.reuse.has('n4')).toBe(false);
  });

  it('marks a reused step that was edited since, and propagates to its descendants', () => {
    const withLeaf = build([agent('a'), agent('b'), agent('c'), link('n1', 'n2'), link('n2', 'n3')]);
    const edited = edit(withLeaf, 'n2', 'edited');
    const plan = onlyRunPlan(edited, { snapshot: withLeaf, nodes: allOk(withLeaf) }, 'n1');
    if (!plan.ok) throw new Error(plan.error);
    // n2 is downstream of n1: stale because of n1; n3 inherits that.
    expect(Object.fromEntries(plan.stale)).toEqual({ n2: { reason: 'upstream', nodeId: 'n1' }, n3: { reason: 'upstream', nodeId: 'n1' } });
    // An edit off the chosen step's path is "edited", and what is built on it inherits the mark and its root.
    const plan2 = onlyRunPlan(edit(wide, 'n3', 'edited'), source, 'n5');
    if (!plan2.ok) throw new Error(plan2.error);
    expect(Object.fromEntries(plan2.stale)).toEqual({ n3: { reason: 'edited', nodeId: 'n3' }, n4: { reason: 'edited', nodeId: 'n3' } });
  });

  it('refuses when an ancestor has no current result, naming the first blocking step', () => {
    const nodes = { ...allOk(wide), n2: ok('failed') };
    expect(onlyRunPlan(wide, { snapshot: wide, nodes }, 'n4')).toEqual({ ok: false, error: 'Run only n4 needs n2 to have a current result: run it first.' });
    const notRun = { ...allOk(wide), n1: ok('not_run') };
    expect(onlyRunPlan(wide, { snapshot: wide, nodes: notRun }, 'n4')).toEqual({ ok: false, error: 'Run only n4 needs n1 to have a current result: run it first.' });
  });

  it('refuses when an ancestor is stale or was edited since', () => {
    const stale = { ...allOk(wide), n2: { status: 'succeeded' as const, stale: { reason: 'edited' as const, runId: 'r1' } } };
    expect(onlyRunPlan(wide, { snapshot: wide, nodes: stale }, 'n3')).toEqual({ ok: false, error: 'Run only n3 needs n2 to have a current result: run it first.' });
    expect(onlyRunPlan(edit(wide, 'n1', 'changed'), source, 'n3')).toEqual({ ok: false, error: 'Run only n3 needs n1 to have a current result: run it first.' });
  });

  it('refuses a step in a workspace when an earlier step shares it, naming the nearest one', () => {
    const inWs = (title: string, workspace: string): Op => ({ type: 'addNode', node: { title, kind: 'agent', prompt: `do ${title}`, workspace } });
    const g = build([inWs('a', 'w1'), inWs('b', 'w1'), agent('c'), inWs('d', 'w1'), link('n1', 'n2'), link('n2', 'n3'), link('n3', 'n4')]);
    const done = { snapshot: g, nodes: allOk(g) };
    expect(onlyRunPlan(g, done, 'n4')).toEqual({ ok: false, error: 'Run only n4 needs the changes n2 made in its workspace: use Re-run from n2 instead.' });
    expect(onlyRunPlan(g, done, 'n2')).toEqual({ ok: false, error: 'Run only n2 needs the changes n1 made in its workspace: use Re-run from n1 instead.' });
    // The first step of the workspace, and a step whose earlier steps are in other workspaces, are allowed.
    expect(onlyRunPlan(g, done, 'n1').ok).toBe(true);
    const other = build([inWs('a', 'w1'), inWs('b', 'w2'), link('n1', 'n2')]);
    expect(onlyRunPlan(other, { snapshot: other, nodes: allOk(other) }, 'n2').ok).toBe(true);
  });

  it('keeps the mark a step already carries', () => {
    const nodes = { ...allOk(wide), n4: { status: 'succeeded' as const, stale: { reason: 'edited' as const, runId: 'r1' } } };
    const plan = onlyRunPlan(wide, { snapshot: wide, nodes }, 'n3');
    if (!plan.ok) throw new Error(plan.error);
    expect(plan.reuse.has('n4')).toBe(true);
    expect(plan.stale.has('n4')).toBe(false);
  });
});

describe('runModeProblem', () => {
  it('needs a previous run to retry', () => {
    expect(runModeProblem('resume', undefined, undefined)).toBe('There is no previous run to retry.');
    expect(runModeProblem('only', 'n1', undefined)).toBe('There is no previous run to retry.');
  });
  it('takes a step exactly when the mode does', () => {
    expect(runModeProblem('resume', 'n1', 'r')).toBe('Retry from where it stopped takes no step.');
    expect(runModeProblem('only', undefined, 'r')).toBe('Run only needs a step.');
    expect(runModeProblem('from', undefined, 'r')).toBe('Re-run from needs a step.');
    expect(runModeProblem('from', 'n1', undefined)).toBe('There is no previous run to re-run from.');
  });
  it('accepts a complete request', () => {
    expect(runModeProblem('resume', undefined, 'r')).toBeNull();
    expect(runModeProblem('from', 'n1', 'r')).toBeNull();
    expect(runModeProblem('only', 'n1', 'r')).toBeNull();
    expect(runModeProblem(undefined, undefined, undefined)).toBeNull();
  });
});

describe('startRun and previewRun messages', () => {
  it('carry a mode, and refuse one that is not a mode', () => {
    expect(parseWebviewMessage({ type: 'startRun', graphId: 'g', reviewed: 'x', mode: 'resume', sourceRunId: 'r' }).ok).toBe(true);
    expect(parseWebviewMessage({ type: 'previewRun', graphId: 'g', mode: 'only', fromNodeId: 'n1', sourceRunId: 'r' }).ok).toBe(true);
    expect(parseWebviewMessage({ type: 'previewRun', graphId: 'g', fromNodeId: 'n1', sourceRunId: 'r' }).ok).toBe(true);
    expect(parseWebviewMessage({ type: 'startRun', graphId: 'g', reviewed: 'x', mode: 'again' }).ok).toBe(false);
  });
});

describe('staleNote', () => {
  it('says why a kept result is stale', () => {
    expect(staleNote({ reason: 'upstream', nodeId: 'n2' })).toBe('built on an older result of n2');
    expect(staleNote({ reason: 'upstream' })).toBe('built on an older result');
    expect(staleNote({ reason: 'edited', nodeId: 'n3' })).toBe('edited since this result');
    // The edited step itself says so; a step built on it says it was built on its older result.
    expect(staleNote({ reason: 'edited', nodeId: 'n3' }, 'n3')).toBe('edited since this result');
    expect(staleNote({ reason: 'edited', nodeId: 'n3' }, 'n4')).toBe('built on an older result of n3');
    expect(staleNote({ reason: 'upstream', nodeId: 'n2' }, 'n4')).toBe('built on an older result of n2');
  });
});
