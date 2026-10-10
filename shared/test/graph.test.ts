import { describe, expect, it } from 'vitest';
import {
  applyOp,
  changedSinceSource,
  contentSignature,
  descendants,
  emptyGraph,
  nextNodeId,
  nodeIdProblem,
  refinable,
  reusableNodeIds,
  seqOf,
  topoOrder,
  upstream,
  validateRunnable,
  wouldCreateCycle,
} from '../src/graph';
import { EXPORT_FORMAT, EXPORT_VERSION, parseExportFile } from '../src/exportFile';
import { canonicalGraph } from '../src/graphDoc';
import { parseGraphMeta } from '../src/graphMeta';
import { parseGraph } from '../src/schemas';
import type { Graph, GraphNode, NodeRunState, Op, RenderedRun } from '../src/types';

const ID_RULE = 'Step ids use letters, digits, - and _ (at most 64), with no "--" and not ending in "-".';
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

  it('counts only n<number> ids whose number is a safe integer, so a huge one never stops new steps', () => {
    const huge = 'n99999999999999999999';
    expect([seqOf('n12'), seqOf('n9007199254740991'), seqOf('n9007199254740992'), seqOf(huge), seqOf('step')]).toEqual([12, 9007199254740991, 0, 0, 0]);
    let g = build([{ type: 'addNode', node: { id: huge, title: 'big', kind: 'agent' } }]);
    expect(g.nodeSeq).toBe(0);
    for (const title of ['a', 'b']) {
      const r = applyOp(g, { type: 'addNode', node: { id: nextNodeId(g), title, kind: 'agent' } }, 'user', T2);
      if (!r.ok) throw new Error(r.error);
      g = r.graph;
    }
    expect(g.nodes.map((n) => n.id)).toEqual([huge, 'n1', 'n2']);
    expect(canonicalGraph({ ...g, nodeSeq: 0 }).nodeSeq).toBe(2);
  });

  it('reads a stored nodeSeq that is not a safe integer as 0', () => {
    const huge = 100000000000000000000;
    expect(parseGraphMeta(`{"version":1,"nodeSeq":${huge}}`)?.nodeSeq).toBe(0);
    const r = parseGraph({ ...emptyGraph('g', 'G', T), nodeSeq: huge });
    expect(r.ok && r.graph.nodeSeq).toBe(0);
    expect(parseGraph({ ...emptyGraph('g', 'G', T), nodeSeq: 1.5 }).ok).toBe(false);
    const file = JSON.stringify({ format: EXPORT_FORMAT, version: EXPORT_VERSION, graph: { name: 'G', nodes: [{ id: 'n99999999999999999999', title: 'big', kind: 'agent' }] } });
    const imported = parseExportFile(file, 'g', T);
    expect(imported.ok && imported.graph.nodeSeq).toBe(0);
  });

  it('rejects duplicate ids, invalid ids and blank titles', () => {
    const g = build([agent('a')]);
    expectError(g, { type: 'addNode', node: { id: 'n1', title: 'x', kind: 'agent' } }, 'already exists');
    expectError(g, { type: 'addNode', node: { id: '../x', title: 'x', kind: 'agent' } }, 'invalid node id');
    expectError(g, { type: 'addNode', node: { title: '   ', kind: 'agent' } }, 'needs a title');
  });

  it('stores a description on add and update', () => {
    let g = build([{ type: 'addNode', node: { title: 'Build', kind: 'agent', prompt: 'p', description: 'Builds the new model.' } }]);
    expect(g.nodes[0].description).toBe('Builds the new model.');
    const r = applyOp(g, { type: 'updateNode', id: 'n1', patch: { description: 'Builds orders_v2 in dev.' } }, 'user', T2);
    if (!r.ok) throw new Error(r.error);
    g = r.graph;
    expect(g.nodes[0].description).toBe('Builds orders_v2 in dev.');
    expect(g.nodes[0].title).toBe('Build');
  });

  it('limits a description to 2000 characters on add and update', () => {
    const msg = 'a description can be at most 2000 characters';
    expectError(emptyGraph('g', 'G', T), { type: 'addNode', node: { title: 'x', kind: 'agent', description: 'x'.repeat(2001) } }, msg);
    const g = build([{ type: 'addNode', node: { title: 'x', kind: 'agent', description: 'x'.repeat(2000) } }]);
    expect(g.nodes[0].description).toHaveLength(2000);
    expectError(g, { type: 'updateNode', id: 'n1', patch: { description: 'x'.repeat(2001) } }, msg);
    const ok = applyOp(g, { type: 'updateNode', id: 'n1', patch: { description: 'y'.repeat(2000) } }, 'user', T2);
    expect(ok.ok).toBe(true);
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

describe('labels in signatures and reuse', () => {
  const branch = (label: 'yes' | 'no'): Graph =>
    build([{ type: 'addNode', node: { title: 'Ready', kind: 'condition' } }, cmd('Ship', 'ship'), { type: 'connect', from: 'n1', to: 'n2', label }]);
  const allOk = (g: Graph): Record<string, NodeRunState> => Object.fromEntries(g.nodes.map((n) => [n.id, { status: 'succeeded' as const }]));

  it('a label change changes the content signature', () => {
    expect(contentSignature(branch('yes'))).not.toBe(contentSignature(branch('no')));
    expect(contentSignature(branch('yes'))).toBe(contentSignature(branch('yes')));
  });

  it('fail-fast on a stop step changes the content signature; missing and false are the same', () => {
    const stop = (failFast?: boolean) => build([{ type: 'addNode', node: { title: 'Halt', kind: 'stop', ...(failFast !== undefined && { failFast }) } }]);
    expect(contentSignature(stop(true))).not.toBe(contentSignature(stop(false)));
    expect(contentSignature(stop(true))).not.toBe(contentSignature(stop()));
    expect(contentSignature(stop(false))).toBe(contentSignature(stop()));
  });

  it('an unlabeled graph keeps its edge signature entry', () => {
    expect(contentSignature(build([agent('a'), agent('b'), link('n1', 'n2')]))).toContain('"edges":["n1->n2"]');
  });

  it('a step whose incoming arrow changed label is not reused', () => {
    const before = branch('yes');
    expect([...changedSinceSource(branch('no'), { snapshot: before, nodes: allOk(before) })]).toEqual(['n2']);
    expect([...changedSinceSource(branch('yes'), { snapshot: before, nodes: allOk(before) })]).toEqual([]);
    expect([...reusableNodeIds(branch('no'), { snapshot: before, nodes: allOk(before) })]).toEqual(['n1']);
  });
});

describe('addNode and fail-fast', () => {
  it('keeps failFast on a stop step, and leaves it undefined when not given', () => {
    expect(build([{ type: 'addNode', node: { title: 'Halt', kind: 'stop', failFast: true } }]).nodes[0].failFast).toBe(true);
    expect(build([{ type: 'addNode', node: { title: 'Halt', kind: 'stop' } }]).nodes[0].failFast).toBeUndefined();
  });
});

describe('reusableNodeIds', () => {
  const chain = build([agent('a'), agent('b'), agent('c'), link('n1', 'n2'), link('n2', 'n3')]);
  const allOk = (g: Graph): Record<string, NodeRunState> =>
    Object.fromEntries(g.nodes.map((n) => [n.id, { status: 'succeeded' as const }]));

  it('re-runs the chosen node and its descendants, reusing the rest', () => {
    expect([...reusableNodeIds(chain, { snapshot: chain, nodes: allOk(chain) }, 'n2')]).toEqual(['n1']);
  });

  it('never reuses a stop step, even when it succeeded last time (R18)', () => {
    const g = build([
      agent('check'),
      { type: 'addNode', node: { title: 'needed?', kind: 'condition' } },
      agent('work'),
      { type: 'addNode', node: { title: 'Halt', kind: 'stop' } },
      link('n1', 'n2'),
      { type: 'connect', from: 'n2', to: 'n3', label: 'yes' },
      { type: 'connect', from: 'n2', to: 'n4', label: 'no' },
    ]);
    expect(validateRunnable(g)).toEqual([]);
    const reuse = reusableNodeIds(g, { snapshot: g, nodes: allOk(g) });
    expect(reuse.has('n4')).toBe(false);
    expect([...reuse].sort()).toEqual(['n1', 'n2', 'n3']);
  });

  // P -> C; C yes -> A, C no -> B; A and B -> J; J -> K (R31).
  const joined = build([
    agent('check'),
    { type: 'addNode', node: { title: 'needed?', kind: 'condition' } },
    agent('a'),
    agent('b'),
    agent('join'),
    agent('after'),
    link('n1', 'n2'),
    { type: 'connect', from: 'n2', to: 'n3', label: 'yes' },
    { type: 'connect', from: 'n2', to: 'n4', label: 'no' },
    link('n3', 'n5'),
    link('n4', 'n5'),
    link('n5', 'n6'),
  ]);
  const yesRun = (): Record<string, NodeRunState> => ({
    n1: { status: 'succeeded' },
    n2: { status: 'succeeded', verdict: 'yes' },
    n3: { status: 'succeeded' },
    n4: { status: 'skipped', error: 'not on the taken branch' },
    n5: { status: 'succeeded' },
    n6: { status: 'failed', error: 'boom' },
  });

  it('a skipped branch runs again alone: the join after it is reused and the failed step re-runs (R31)', () => {
    expect(validateRunnable(joined)).toEqual([]);
    const reuse = reusableNodeIds(joined, { snapshot: joined, nodes: yesRun() });
    expect([...reuse].sort()).toEqual(['n1', 'n2', 'n3', 'n5']);
    // The skipped step is evaluated again (and stays skipped, as the reused verdict is yes); the failed one re-runs.
    expect(reuse.has('n4')).toBe(false);
    expect(reuse.has('n6')).toBe(false);
  });

  it('an edited upstream prompt re-runs the check and everything after it (spec §6)', () => {
    const r = applyOp(joined, { type: 'updateNode', id: 'n1', patch: { prompt: 'check it again' } }, 'user', T2);
    if (!r.ok) throw new Error(r.error);
    expect([...reusableNodeIds(r.graph, { snapshot: joined, nodes: yesRun() })]).toEqual([]);
    // Unedited, the verdict is reused and the check is not spent again.
    expect(reusableNodeIds(joined, { snapshot: joined, nodes: yesRun() }).has('n2')).toBe(true);
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

  it('re-runs an agent step whose own description changed, but not a command step', () => {
    const before = build([agent('a'), cmd('b', 'echo hi')]);
    const now: Graph = {
      ...before,
      nodes: before.nodes.map((n) => ({ ...n, description: 'changed' })),
    };
    const nodes: Record<string, NodeRunState> = { n1: { status: 'succeeded' }, n2: { status: 'succeeded' } };
    const rendered: RenderedRun = { goal: '', instructions: '', nodes: { n1: 'do a', n2: 'echo hi' } };
    const source = { snapshot: before, nodes, rendered };
    expect(reusableNodeIds(now, source, undefined, rendered)).toEqual(new Set(['n2']));
  });

  it('still reuses an agent step when only whitespace around its description changed', () => {
    const before: Graph = { ...build([agent('a')]), nodes: [{ ...build([agent('a')]).nodes[0], description: 'Does a.' }] };
    const now: Graph = { ...before, nodes: [{ ...before.nodes[0], description: '  Does a.\n' }] };
    const nodes: Record<string, NodeRunState> = { n1: { status: 'succeeded' } };
    const rendered: RenderedRun = { goal: '', instructions: '', nodes: { n1: 'do a' } };
    expect(reusableNodeIds(now, { snapshot: before, nodes, rendered }, undefined, rendered)).toEqual(new Set(['n1']));
  });

  it('compares rendered text for reuse when both runs have it', () => {
    const g = build([cmd('build', 'dbt build -s {{ model }}'), agent('check'), link('n1', 'n2')]);
    const nodes: Record<string, NodeRunState> = { n1: { status: 'succeeded' }, n2: { status: 'succeeded' } };
    const before: RenderedRun = { goal: '', instructions: '', nodes: { n1: "dbt build -s 'a'", n2: 'do check' } };
    const source = { snapshot: g, nodes, rendered: before };
    expect([...reusableNodeIds(g, source, 'n2', before)]).toEqual(['n1']);
    const changed: RenderedRun = { ...before, nodes: { ...before.nodes, n1: "dbt build -s 'b'" } };
    expect([...reusableNodeIds(g, source, 'n2', changed)]).toEqual([]);
    // Runs recorded before rendering existed fall back to comparing the templates.
    expect([...reusableNodeIds(g, { snapshot: g, nodes }, 'n2', changed)]).toEqual(['n1']);
  });
});

describe('contentSignature', () => {
  it('changes when a description changes', () => {
    const a = build([agent('T')]);
    const b = { ...a, nodes: [{ ...a.nodes[0], description: 'x' }] };
    expect(contentSignature(a)).not.toBe(contentSignature(b));
  });

  it('changes for edits but not for layout', () => {
    const g = build([agent('a'), cmd('b', 'echo hi'), link('n1', 'n2')]);
    const moved = applyOp(g, { type: 'moveNode', id: 'n1', position: { x: 5, y: 5 } }, 'user', T2);
    const edited = applyOp(g, { type: 'updateNode', id: 'n2', patch: { command: 'echo bye' } }, 'user', T2);
    const regoaled = applyOp(g, { type: 'setGoal', goal: 'other' }, 'user', T2);
    if (!moved.ok || !edited.ok || !regoaled.ok) throw new Error('op failed');
    expect(contentSignature(moved.graph)).toBe(contentSignature(g));
    expect(contentSignature(edited.graph)).not.toBe(contentSignature(g));
    expect(contentSignature(regoaled.graph)).not.toBe(contentSignature(g));
  });

  it('starts graphs without instructions and sets them with an op', () => {
    expect(emptyGraph('g', 'G', T).instructions).toBe('');
    const g = build([agent('a')]);
    const r = applyOp(g, { type: 'setInstructions', instructions: 'Use target dev.' }, 'user', T2);
    expect(r.ok && r.graph.instructions).toBe('Use target dev.');
  });

  it('counts the instructions as run content', () => {
    const g = build([agent('a')]);
    const r = applyOp(g, { type: 'setInstructions', instructions: 'Never touch prod.' }, 'user', T2);
    expect(r.ok && contentSignature(r.graph)).not.toBe(contentSignature(g));
  });

  describe('variables', () => {
    const withVar = () => {
      const g = build([agent('a', 'Use {{ schema }}'), cmd('b', 'dbt build --target {{ schema }}')]);
      const r = applyOp(g, { type: 'addVariable', name: 'schema', description: ' Target schema ' }, 'user', T2);
      if (!r.ok) throw new Error(r.error);
      return r.graph;
    };

    it('starts empty and adds a variable with a trimmed description', () => {
      expect(emptyGraph('g', 'G', T).variables).toEqual([]);
      expect(withVar().variables).toEqual([{ name: 'schema', description: 'Target schema' }]);
    });

    it('refuses invalid or duplicate names', () => {
      const g = withVar();
      expect(applyOp(g, { type: 'addVariable', name: 'schema' }, 'user', T2)).toEqual({ ok: false, error: 'A variable named "schema" already exists.' });
      expect(applyOp(g, { type: 'addVariable', name: 'n1' }, 'user', T2).ok).toBe(false);
      expect(applyOp(g, { type: 'renameVariable', name: 'nope', newName: 'x' }, 'user', T2)).toEqual({ ok: false, error: 'variable nope does not exist' });
    });

    it('renames a variable and rewrites references through the given rewriter', () => {
      const g = { ...withVar(), goal: 'Build in {{ schema }}' };
      const rewrite = (text: string, from: string, to: string) => text.replaceAll(`{{ ${from} }}`, `{{ ${to} }}`);
      const r = applyOp(g, { type: 'renameVariable', name: 'schema', newName: 'target_schema' }, 'agent', T2, { rewriteReferences: rewrite });
      if (!r.ok) throw new Error(r.error);
      expect(r.graph.variables).toEqual([{ name: 'target_schema', description: 'Target schema' }]);
      expect(r.graph.nodes.map((n) => n.prompt ?? n.command)).toEqual(['Use {{ target_schema }}', 'dbt build --target {{ target_schema }}']);
      expect(r.graph.nodes[0]).toMatchObject({ updatedBy: 'agent', updatedAt: T2 });
      expect(r.graph.goal).toBe('Build in {{ target_schema }}');
    });

    it('renames only the definition when no rewriter is given', () => {
      const r = applyOp(withVar(), { type: 'renameVariable', name: 'schema', newName: 'target_schema' }, 'user', T2);
      expect(r.ok && r.graph.nodes[0].prompt).toBe('Use {{ schema }}');
    });

    it('changes descriptions and deletes variables', () => {
      const d = applyOp(withVar(), { type: 'setVariableDescription', name: 'schema', description: 'Where to build' }, 'user', T2);
      expect(d.ok && d.graph.variables[0].description).toBe('Where to build');
      const x = applyOp(withVar(), { type: 'deleteVariable', name: 'schema' }, 'user', T2);
      expect(x.ok && x.graph.variables).toEqual([]);
    });
  });

describe('addNode ids', () => {
  it('rejects ids that are unsafe object keys and accepts normal ones', () => {
    const g = emptyGraph('g', 'G', 't');
    const add = (id: string) => applyOp(g, { type: 'addNode', node: { id, title: 'a', kind: 'agent', prompt: 'p' } }, 'user', 't');
    expect(add('constructor')).toEqual({ ok: false, error: `"constructor" can't be used as a step id.` });
    expect(add('a b')).toEqual({ ok: false, error: `invalid node id "a b". ${ID_RULE}` });
    for (const id of ['n1', 'build_old', 'my-step']) expect(add(id).ok).toBe(true);
  });

  it('rejects ids the Flow could not write: "--" inside, or "-" at the end', () => {
    const g = emptyGraph('g', 'G', 't');
    const add = (id: string) => applyOp(g, { type: 'addNode', node: { id, title: 'a', kind: 'agent', prompt: 'p' } }, 'user', 't');
    for (const id of ['a--b', 'a---b', '--a', 'a-', 'n1-']) expect(add(id)).toEqual({ ok: false, error: `invalid node id "${id}". ${ID_RULE}` });
    for (const id of ['n12', 'step_4', 'a-b', 'a_-_b', '-a', 'a-b-c']) expect(add(id).ok).toBe(true);
    expect(nodeIdProblem('a--b')).toBe(`invalid node id "a--b". ${ID_RULE}`);
    expect(nodeIdProblem('a-b')).toBeNull();
  });
});
});

describe('refinable', () => {
  const node = (patch: Partial<GraphNode>): GraphNode => ({ id: 'n1', title: 'T', kind: 'agent', createdBy: 'user', updatedBy: 'user', updatedAt: 't', ...patch });
  it('is false for a title-only step and true with a description, a prompt or a command', () => {
    expect(refinable(node({}))).toBe(false);
    expect(refinable(node({ description: '  ', prompt: '', command: ' ' }))).toBe(false);
    expect(refinable(node({ description: 'Compare the tables' }))).toBe(true);
    expect(refinable(node({ prompt: 'compare' }))).toBe(true);
    expect(refinable(node({ kind: 'command', command: 'ls' }))).toBe(true);
  });
});

describe('step access and workspace', () => {
  const apply = (g: Graph, op: Op): Graph => {
    const r = applyOp(g, op, 'user', T2);
    if (!r.ok) throw new Error(r.error);
    return r.graph;
  };

  it('stores read-only access and a workspace on add, and stores write as no field', () => {
    const g = build([
      { type: 'addNode', node: { title: 'Read', kind: 'agent', prompt: 'p', access: 'read', workspace: 'wh_small' } },
      { type: 'addNode', node: { title: 'Write', kind: 'agent', prompt: 'p', access: 'write' } },
    ]);
    expect(g.nodes[0]).toMatchObject({ access: 'read', workspace: 'wh_small' });
    expect(g.nodes[1]).not.toHaveProperty('access');
    expect(g.nodes[1]).not.toHaveProperty('workspace');
  });

  it('refuses read-only command steps on add and update', () => {
    const msg = 'Command steps can always change files; only agent steps can be read-only.';
    expectError(emptyGraph('g', 'G', T), { type: 'addNode', node: { title: 'x', kind: 'command', command: 'ls', access: 'read' } }, msg);
    expectError(build([cmd('b', 'ls')]), { type: 'updateNode', id: 'n1', patch: { access: 'read' } }, msg);
    expectError(build([agent('a')]), { type: 'updateNode', id: 'n1', patch: { kind: 'command', command: 'ls', access: 'read' } }, msg);
  });

  it('drops access when a step becomes a command step', () => {
    const g = build([{ type: 'addNode', node: { title: 'a', kind: 'agent', prompt: 'p', access: 'read' } }]);
    const next = apply(g, { type: 'updateNode', id: 'n1', patch: { kind: 'command', command: 'ls' } });
    expect(next.nodes[0].kind).toBe('command');
    expect(next.nodes[0]).not.toHaveProperty('access');
  });

  it('sets, keeps and clears access and workspace on update', () => {
    let g = build([agent('a')]);
    g = apply(g, { type: 'updateNode', id: 'n1', patch: { access: 'read', workspace: 'wh_a' } });
    expect(g.nodes[0]).toMatchObject({ access: 'read', workspace: 'wh_a' });
    g = apply(g, { type: 'updateNode', id: 'n1', patch: { title: 'renamed' } });
    expect(g.nodes[0]).toMatchObject({ title: 'renamed', access: 'read', workspace: 'wh_a' });
    g = apply(g, { type: 'updateNode', id: 'n1', patch: { access: 'write', workspace: '' } });
    expect(g.nodes[0]).not.toHaveProperty('access');
    expect(g.nodes[0]).not.toHaveProperty('workspace');
  });

  it('refuses bad workspace names on add and update', () => {
    const msg = 'Workspace names use lowercase letters, digits, - and _, starting with a letter.';
    expectError(emptyGraph('g', 'G', T), { type: 'addNode', node: { title: 'x', kind: 'agent', workspace: 'Bad Name' } }, msg);
    expectError(build([agent('a')]), { type: 'updateNode', id: 'n1', patch: { workspace: '../x' } }, msg);
  });

  it('changes the content signature with access and with workspace, and not for an explicit write', () => {
    const g = build([agent('a')]);
    expect(contentSignature(apply(g, { type: 'updateNode', id: 'n1', patch: { access: 'read' } }))).not.toBe(contentSignature(g));
    expect(contentSignature(apply(g, { type: 'updateNode', id: 'n1', patch: { workspace: 'wh_a' } }))).not.toBe(contentSignature(g));
    expect(contentSignature({ ...g, nodes: [{ ...g.nodes[0], access: 'write' }] })).toBe(contentSignature(g));
  });

  it('re-executes an agent step whose access or workspace changed, and everything after it', () => {
    const g = build([agent('a'), agent('b'), link('n1', 'n2')]);
    const allOk = Object.fromEntries(g.nodes.map((n) => [n.id, { status: 'succeeded' as const }])) as Record<string, NodeRunState>;
    expect(reusableNodeIds(g, { snapshot: g, nodes: allOk })).toEqual(new Set(['n1', 'n2']));
    expect(reusableNodeIds(apply(g, { type: 'updateNode', id: 'n1', patch: { access: 'read' } }), { snapshot: g, nodes: allOk })).toEqual(new Set());
    expect(reusableNodeIds(apply(g, { type: 'updateNode', id: 'n2', patch: { workspace: 'wh_a' } }), { snapshot: g, nodes: allOk })).toEqual(new Set(['n1']));
  });

  it('never reuses a step that has a workspace', () => {
    const g = build([agent('a'), { type: 'addNode', node: { title: 'b', kind: 'command', command: 'make', workspace: 'wh_a' } }, agent('c'), link('n2', 'n3')]);
    const allOk = Object.fromEntries(g.nodes.map((n) => [n.id, { status: 'succeeded' as const }])) as Record<string, NodeRunState>;
    expect(reusableNodeIds(g, { snapshot: g, nodes: allOk })).toEqual(new Set(['n1']));
  });
});

describe('updateNode timeouts', () => {
  it('sets a timeout, keeps it when the patch has none, and clears it with 0', () => {
    const g = build([cmd('a', 'make')]);
    const set = applyOp(g, { type: 'updateNode', id: 'n1', patch: { timeoutSec: 30 } }, 'user', T2);
    if (!set.ok) throw new Error(set.error);
    expect(set.graph.nodes[0].timeoutSec).toBe(30);
    const kept = applyOp(set.graph, { type: 'updateNode', id: 'n1', patch: { title: 'b' } }, 'user', T2);
    expect(kept.ok && kept.graph.nodes[0].timeoutSec).toBe(30);
    const cleared = applyOp(set.graph, { type: 'updateNode', id: 'n1', patch: { timeoutSec: 0 } }, 'user', T2);
    expect(cleared.ok && 'timeoutSec' in cleared.graph.nodes[0]).toBe(false);
  });
});

describe('legacy ids', () => {
  it('parseGraph still loads old graphs with ids like "fix-" and "a--b"; new ids are strict', () => {
    const node = (id: string) => ({ id, title: id, kind: 'agent' as const, prompt: 'p' });
    const g = { id: 'g', name: 'G', nodes: [node('fix-'), node('a--b')], edges: [{ id: 'e1', from: 'fix-', to: 'a--b' }] };
    expect(parseGraph(g).ok).toBe(true);
    expect(parseGraph({ ...g, nodes: [node('a b')], edges: [] })).toMatchObject({ ok: false });
    const r = applyOp(emptyGraph('g', 'G', 't'), { type: 'addNode', node: node('fix-') }, 'user', 't');
    expect(r).toEqual({ ok: false, error: `invalid node id "fix-". ${ID_RULE}` });
  });
});

describe('condition and stop steps refuse agent and command fields', () => {
  const T = '2026-10-10T00:00:00.000Z';
  it('addNode refuses a timeout on a condition and a workspace on a stop, naming the field and the kind', () => {
    const none = emptyGraph('g', 'G', T);
    const timeout = applyOp(none, { type: 'addNode', node: { title: 'Ready?', kind: 'condition', timeoutSec: 30 } }, 'user', T);
    expect(timeout).toEqual({ ok: false, error: "a condition step can't have timeout. Remove it." });
    const workspace = applyOp(none, { type: 'addNode', node: { title: 'Halt', kind: 'stop', workspace: 'wh_a' } }, 'user', T);
    expect(workspace).toEqual({ ok: false, error: "a stop step can't have workspace. Remove it." });
  });

  it('updateNode refuses a timeout on an existing stop and leaves the graph unchanged', () => {
    const g = build([{ type: 'addNode', node: { title: 'Halt', kind: 'stop', failFast: true } }]);
    expect(applyOp(g, { type: 'updateNode', id: 'n1', patch: { timeoutSec: 30 } }, 'user', T)).toEqual({ ok: false, error: "a stop step can't have timeout. Remove it." });
    expect(g.nodes[0].timeoutSec).toBeUndefined();
  });

  it('addNode refuses a prompt on a condition and a command on a stop, and allows empty ones (R30)', () => {
    const none = emptyGraph('g', 'G', T);
    const prompt = applyOp(none, { type: 'addNode', node: { title: 'Ready?', kind: 'condition', prompt: 'Is it ready?' } }, 'user', T);
    expect(prompt).toEqual({ ok: false, error: "a condition step can't have a prompt. Put the question in the step before it." });
    const command = applyOp(none, { type: 'addNode', node: { title: 'Halt', kind: 'stop', command: 'echo' } }, 'user', T);
    expect(command).toEqual({ ok: false, error: "a stop step can't have a command. Remove it." });
    expect(applyOp(none, { type: 'addNode', node: { title: 'Ready?', kind: 'condition', prompt: '', command: '' } }, 'user', T).ok).toBe(true);
  });

  it('updateNode refuses a prompt on a stop and a command on a condition, and still clears them (R30)', () => {
    const g = build([{ type: 'addNode', node: { title: 'Halt', kind: 'stop' } }, { type: 'addNode', node: { title: 'Ready?', kind: 'condition' } }]);
    expect(applyOp(g, { type: 'updateNode', id: 'n1', patch: { prompt: 'Stop now' } }, 'user', T)).toEqual({ ok: false, error: "a stop step can't have a prompt. Remove it." });
    expect(applyOp(g, { type: 'updateNode', id: 'n2', patch: { command: 'echo' } }, 'user', T)).toEqual({ ok: false, error: "a condition step can't have a command. Put the question in the step before it." });
    expect(applyOp(g, { type: 'updateNode', id: 'n1', patch: { prompt: '', command: '' } }, 'user', T).ok).toBe(true);
  });

  it('updateNode drops the timeout and workspace of a step that becomes a condition, and still clears with 0 or an empty workspace', () => {
    const g = build([{ type: 'addNode', node: { title: 'Check', kind: 'agent', prompt: 'p', timeoutSec: 30, workspace: 'wh_a' } }]);
    const r = applyOp(g, { type: 'updateNode', id: 'n1', patch: { kind: 'condition' } }, 'user', T);
    expect(r.ok && r.graph.nodes[0]).toMatchObject({ kind: 'condition' });
    expect(r.ok && r.graph.nodes[0].timeoutSec).toBeUndefined();
    expect(r.ok && r.graph.nodes[0].workspace).toBeUndefined();
    const cleared = applyOp(r.ok ? r.graph : g, { type: 'updateNode', id: 'n1', patch: { timeoutSec: 0, workspace: '' } }, 'user', T);
    expect(cleared.ok).toBe(true);
  });
});
