import { describe, expect, it } from 'vitest';
import { isWriteCapable } from '../src/access';
import { changedFields, changedFieldText } from '../src/changes';
import { diffToOps } from '../src/diffToOps';
import { applyOp, contentSignature, emptyGraph, validateRunnable } from '../src/graph';
import { canonicalGraph } from '../src/graphDoc';
import { parseGraph, parseWebviewMessage } from '../src/schemas';
import { GRAPH_ID_RE, isGraphId, ONLY_SUBGRAPH_STEPS_GRAPH, SUBGRAPH_FIELDS_ONLY, SUBGRAPH_NEEDS_GRAPH } from '../src/subgraphStep';
import type { Graph, GraphNode, Op } from '../src/types';
import { graphAsDoc, undoOps } from '../src/undo';
import { build, T0 } from './graphFixtures';

function apply(g: Graph, op: Op): Graph {
  const r = applyOp(g, op, 'user', T0, { rewriteReferences: (text, from, to) => text.replaceAll(`{{ ${from} }}`, `{{ ${to} }}`) });
  if (!r.ok) throw new Error(r.error);
  return r.graph;
}
const refused = (g: Graph, op: Op) => {
  const r = applyOp(g, op, 'user', T0);
  return r.ok ? 'applied' : r.error;
};
const sub = (over: object = {}): Op => ({ type: 'addNode', node: { title: 'Research the target company', kind: 'graph', graph: 'company-research', ...over } });
const agent: Op = { type: 'addNode', node: { title: 'Plan', kind: 'agent', prompt: 'Plan it.' } };
const empty = () => emptyGraph('g', 'G', T0);

describe('graph ids', () => {
  it('moved to shared: lowercase slugs of at most 80 characters', () => {
    expect(GRAPH_ID_RE.source).toBe('^[a-z0-9][a-z0-9-]{0,79}$');
    expect(isGraphId('company-research')).toBe(true);
    for (const bad of ['', 'Company', '-x', 'a/b', 'a'.repeat(81), 'a b']) expect(isGraphId(bad), bad).toBe(false);
  });
});

describe('line breaks in values', () => {
  it('are stored as \\n however they were typed, so a value equals its file form after a reload', () => {
    const added = build('J', [sub({ values: { company: 'Acme\r\nCorp\rInc' } })]);
    expect(added.nodes[0].values).toEqual({ company: 'Acme\nCorp\nInc' });
    const updated = apply(added, { type: 'updateNode', id: 'n1', patch: { values: { company: 'A\r\nB' } } });
    expect(updated.nodes[0].values).toEqual({ company: 'A\nB' });
    // The file's own canonical form agrees with what applyOp stored.
    const crlf: Graph = { ...updated, nodes: [{ ...updated.nodes[0], values: { company: 'A\r\nB' } }] };
    expect(canonicalGraph(crlf).nodes[0].values).toEqual(updated.nodes[0].values);
    expect(contentSignature(canonicalGraph(crlf))).toBe(contentSignature(updated));
  });
});

describe('applyOp: sub-graph steps', () => {
  it('adds one with its graph and values, values in name order, and no other fields', () => {
    const g = build('Job hunting', [sub({ description: 'Researches the company.', values: { depth: 'quick', company: '{{ target_company }}' } })]);
    expect(g.nodes[0]).toEqual({
      id: 'n1',
      title: 'Research the target company',
      kind: 'graph',
      description: 'Researches the company.',
      graph: 'company-research',
      values: { company: '{{ target_company }}', depth: 'quick' },
      createdBy: 'user',
      updatedBy: 'user',
      updatedAt: T0,
    });
    expect(Object.keys(g.nodes[0].values!)).toEqual(['company', 'depth']);
    // An empty map is no field; an empty value is kept (it is asked for when the run starts).
    expect(build('J', [sub({ values: {} })]).nodes[0]).not.toHaveProperty('values');
    expect(build('J', [sub({ values: { company: '' } })]).nodes[0].values).toEqual({ company: '' });
  });

  it('refuses one without a graph, with a bad graph id, or with fields only agent and command steps have', () => {
    expect(refused(empty(), { type: 'addNode', node: { title: 'S', kind: 'graph' } })).toBe(SUBGRAPH_NEEDS_GRAPH);
    expect(refused(empty(), sub({ graph: 'Company Research' }))).toBe('"Company Research" isn\'t a graph id: graph ids use lowercase letters, digits and -, starting with a letter or digit (at most 80).');
    for (const extra of [{ prompt: 'p' }, { command: 'ls' }, { timeoutSec: 5 }, { access: 'read' }, { workspace: 'wh_a' }, { model: { provider: 'claude', id: 'opus' } }, { effort: 'low' }, { attachments: ['a.md'] }, { browser: true }]) {
      expect(refused(empty(), sub(extra)), JSON.stringify(extra)).toBe(SUBGRAPH_FIELDS_ONLY);
    }
    // Clearing values are not setting a field.
    expect(refused(empty(), sub({ prompt: '', access: 'write', browser: false, attachments: [] }))).toBe('applied');
  });

  it('refuses bad values: a name that is not a variable name, or a value over 10,000 characters', () => {
    expect(refused(empty(), sub({ values: { 'bad name': 'x' } }))).toBe('"bad name" is not a valid variable name: use letters, digits and _, starting with a letter or _ (at most 64 characters).');
    expect(refused(empty(), sub({ values: { company: 'x'.repeat(10_001) } }))).toBe('The value of company can be at most 10000 characters.');
    expect(refused(empty(), sub({ values: { company: 'x'.repeat(10_000) } }))).toBe('applied');
  });

  it('refuses a graph or values on an agent or command step', () => {
    expect(refused(empty(), { type: 'addNode', node: { title: 'A', kind: 'agent', prompt: 'p', graph: 'x' } })).toBe(ONLY_SUBGRAPH_STEPS_GRAPH);
    expect(refused(build('J', [agent]), { type: 'updateNode', id: 'n1', patch: { values: { a: 'b' } } })).toBe(ONLY_SUBGRAPH_STEPS_GRAPH);
  });

  it('a patch changes the graph, and its values replace the whole map', () => {
    let g = build('J', [sub({ values: { company: 'Acme', depth: 'quick' } })]);
    g = apply(g, { type: 'updateNode', id: 'n1', patch: { graph: 'tailor-cv' } });
    expect(g.nodes[0]).toMatchObject({ graph: 'tailor-cv', values: { company: 'Acme', depth: 'quick' } });
    g = apply(g, { type: 'updateNode', id: 'n1', patch: { values: { role: 'Engineer' } } });
    expect(g.nodes[0].values).toEqual({ role: 'Engineer' });
    g = apply(g, { type: 'updateNode', id: 'n1', patch: { values: {} } });
    expect(g.nodes[0]).not.toHaveProperty('values');
    expect(refused(g, { type: 'updateNode', id: 'n1', patch: { prompt: 'p' } })).toBe(SUBGRAPH_FIELDS_ONLY);
    expect(refused(g, { type: 'updateNode', id: 'n1', patch: { title: 'Again', browser: false, model: null, workspace: '' } })).toBe('applied');
  });

  it('switching to a sub-graph step needs a graph and drops what an agent step had; switching back drops the graph and values', () => {
    const g = build('J', [{ type: 'addNode', node: { title: 'Plan', kind: 'agent', prompt: 'Plan it.', access: 'read', workspace: 'wh_a', effort: 'low', browser: true, attachments: ['a.md'], timeoutSec: 30 } }]);
    expect(refused(g, { type: 'updateNode', id: 'n1', patch: { kind: 'graph' } })).toBe(SUBGRAPH_NEEDS_GRAPH);
    const asSub = apply(g, { type: 'updateNode', id: 'n1', patch: { kind: 'graph', graph: 'company-research', values: { company: 'Acme' } } });
    expect(asSub.nodes[0]).toEqual({ id: 'n1', title: 'Plan', kind: 'graph', graph: 'company-research', values: { company: 'Acme' }, createdBy: 'user', updatedBy: 'user', updatedAt: T0 });
    const back = apply(asSub, { type: 'updateNode', id: 'n1', patch: { kind: 'agent', prompt: 'Again.' } });
    expect(back.nodes[0]).toEqual({ id: 'n1', title: 'Plan', kind: 'agent', prompt: 'Again.', createdBy: 'user', updatedBy: 'user', updatedAt: T0 });
  });

  it('renaming an outer variable rewrites it in sub-graph values too', () => {
    const g = build('J', [{ type: 'addVariable', name: 'target_company' }, sub({ values: { company: 'At {{ target_company }}' } })]);
    const renamed = apply(g, { type: 'renameVariable', name: 'target_company', newName: 'employer' });
    expect(renamed.nodes[0].values).toEqual({ company: 'At {{ employer }}' });
  });
});

describe('sub-graph steps in the rest of the data model', () => {
  const g = build('J', [agent, sub({ values: { company: 'Acme' } }), { type: 'connect', from: 'n1', to: 'n2' }]);

  it('parseGraph reads them and checks the graph id and values', () => {
    const json = (node: object) => ({ id: 'j', name: 'J', nodes: [{ id: 'n1', title: 'S', kind: 'graph', ...node }] });
    const ok = parseGraph(json({ graph: 'company-research', values: { company: 'Acme' } }));
    expect(ok.ok && ok.graph.nodes[0]).toMatchObject({ kind: 'graph', graph: 'company-research', values: { company: 'Acme' } });
    expect(parseGraph(json({}))).toEqual({ ok: false, error: `n1: ${SUBGRAPH_NEEDS_GRAPH}` });
    expect(parseGraph(json({ graph: 'x', values: { '1x': 'a' } })).ok).toBe(false);
    expect(parseGraph({ id: 'j', name: 'J', nodes: [{ id: 'n1', title: 'A', kind: 'agent', graph: 'x' }] })).toEqual({ ok: false, error: `n1: ${ONLY_SUBGRAPH_STEPS_GRAPH}` });
  });

  it('a tab may add one and patch its graph and values', () => {
    const add = { type: 'op', graphId: 'g', op: { type: 'addNode', node: { title: 'S', kind: 'graph', graph: 'company-research', values: { company: 'Acme' } } } };
    expect(parseWebviewMessage(add)).toEqual({ ok: true, kind: 'engine', msg: add });
    const patch = { type: 'op', graphId: 'g', op: { type: 'updateNode', id: 'n2', patch: { graph: 'tailor-cv', values: {} } } };
    expect(parseWebviewMessage(patch)).toEqual({ ok: true, kind: 'engine', msg: patch });
    expect(parseWebviewMessage({ type: 'op', graphId: 'g', op: { type: 'updateNode', id: 'n2', patch: { values: { a: 1 } } } }).ok).toBe(false);
  });

  it('canonical form keeps only the fields of its kind', () => {
    const hidden: Graph = { ...g, nodes: [g.nodes[0], { ...g.nodes[1], prompt: 'p', timeoutSec: 3, workspace: 'wh_a', values: { z: '1', a: '2' } }] };
    const c = canonicalGraph(hidden);
    expect(c.nodes[1]).toEqual({ id: 'n2', title: 'Research the target company', kind: 'graph', graph: 'company-research', values: { a: '2', z: '1' }, createdBy: 'user', updatedBy: 'user', updatedAt: T0 });
    expect(canonicalGraph({ ...g, nodes: [{ ...g.nodes[0], graph: 'x', values: { a: 'b' } }, g.nodes[1]] }).nodes[0]).not.toHaveProperty('graph');
  });

  it('agent-change review, diffToOps and undo see graph and values', () => {
    const after = apply(g, { type: 'updateNode', id: 'n2', patch: { graph: 'tailor-cv', values: { company: 'Initech', role: 'Engineer' } } });
    expect(changedFields(g.nodes[1], after.nodes[1])).toEqual(['graph', 'values']);
    expect(changedFieldText(after.nodes[1], 'graph')).toBe('tailor-cv');
    expect(changedFieldText(after.nodes[1], 'values')).toBe('company: Initech\nrole: Engineer');
    expect(changedFieldText(g.nodes[0], 'values')).toBe('');
    expect(diffToOps(g, graphAsDoc(after))).toEqual([{ type: 'updateNode', id: 'n2', patch: { graph: 'tailor-cv', values: { company: 'Initech', role: 'Engineer' } } }]);
    expect(diffToOps(after, graphAsDoc(apply(after, { type: 'updateNode', id: 'n2', patch: { values: {} } })))).toEqual([{ type: 'updateNode', id: 'n2', patch: { values: {} } }]);
    let undone = after;
    for (const op of undoOps(after, g)) undone = apply(undone, op);
    expect(undone.nodes[1]).toMatchObject({ graph: 'company-research', values: { company: 'Acme' } });
  });

  it('the content signature changes with the graph and the values, and a graph step without a graph cannot run', () => {
    expect(contentSignature(apply(g, { type: 'updateNode', id: 'n2', patch: { graph: 'tailor-cv' } }))).not.toBe(contentSignature(g));
    expect(contentSignature(apply(g, { type: 'updateNode', id: 'n2', patch: { values: { company: 'Initech' } } }))).not.toBe(contentSignature(g));
    const noGraph: GraphNode = { ...g.nodes[1], graph: undefined };
    expect(validateRunnable({ ...g, nodes: [g.nodes[0], noGraph] })).toEqual(['n2 "Research the target company": a sub-graph step needs a graph.']);
    expect(validateRunnable(g)).toEqual([]);
  });

  it('a sub-graph step never changes files itself', () => {
    expect(isWriteCapable(g.nodes[1])).toBe(false);
    expect(isWriteCapable(g.nodes[0])).toBe(true);
  });
});
