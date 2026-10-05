import { describe, expect, it } from 'vitest';
import { changedFields, changedFieldText, diffGraphs } from '../src/changes';
import { applyOp, contentSignature, emptyGraph, reusableNodeIds } from '../src/graph';
import { canonicalGraph } from '../src/graphDoc';
import { parseGraph, parseWebviewMessage } from '../src/schemas';
import { ONLY_AGENT_STEPS_MODEL, parseStepModel, stepModelProblem, stepModelText } from '../src/stepModels';
import type { Graph, GraphNode, NodeRunState, Op } from '../src/types';

const T = '2026-10-05T00:00:00.000Z';
function build(ops: Op[]): Graph {
  let g = emptyGraph('g', 'G', T);
  for (const op of ops) {
    const r = applyOp(g, op, 'user', T);
    if (!r.ok) throw new Error(r.error);
    g = r.graph;
  }
  return g;
}
function apply(g: Graph, op: Op): Graph {
  const r = applyOp(g, op, 'user', T);
  if (!r.ok) throw new Error(r.error);
  return r.graph;
}
const refused = (g: Graph, op: Op) => {
  const r = applyOp(g, op, 'user', T);
  return r.ok ? 'applied' : r.error;
};
const opus = { provider: 'claude' as const, id: 'opus' };
const agent = (over: Partial<GraphNode> = {}): Op => ({ type: 'addNode', node: { title: 'a', kind: 'agent', prompt: 'p', ...over } });

describe('step model text', () => {
  it('reads <provider>/<id>: the id is everything after the first /', () => {
    expect(parseStepModel('claude/opus')).toEqual({ ok: true, model: opus });
    expect(parseStepModel('copilot/auto')).toEqual({ ok: true, model: { provider: 'copilot', id: 'auto' } });
    expect(parseStepModel('codex/org/gpt-6-astra')).toEqual({ ok: true, model: { provider: 'codex', id: 'org/gpt-6-astra' } });
    expect(stepModelText({ provider: 'codex', id: 'org/gpt-6-astra' })).toBe('codex/org/gpt-6-astra');
  });

  it('refuses an unknown provider and an empty, spaced or too long id, saying how to write it', () => {
    expect(parseStepModel('gpt/x')).toEqual({ ok: false, error: 'model "gpt/x": the provider must be claude, codex or copilot, as in claude/opus.' });
    expect(parseStepModel('opus')).toEqual({ ok: false, error: 'model "opus": the provider must be claude, codex or copilot, as in claude/opus.' });
    const idRule = 'write the model id after "claude/" (1 to 200 characters, no spaces), as in claude/opus.';
    expect(parseStepModel('claude/')).toEqual({ ok: false, error: `model "claude/": ${idRule}` });
    expect(parseStepModel('claude/my model')).toEqual({ ok: false, error: `model "claude/my model": ${idRule}` });
    expect(parseStepModel(`claude/${'x'.repeat(200)}`).ok).toBe(true);
    expect(parseStepModel(`claude/${'x'.repeat(201)}`).ok).toBe(false);
    expect(stepModelProblem(undefined, 'turbo' as never)).toBe('effort "turbo": use low, medium, high, xhigh, max or ultra.');
    expect(stepModelProblem(opus, 'high')).toBeNull();
  });
});

describe('applyOp: model and effort', () => {
  it('stores a model and an effort on an agent step, as copies', () => {
    const model = { provider: 'claude' as const, id: 'opus' };
    const g = build([agent({ model, effort: 'high' })]);
    expect(g.nodes[0]).toMatchObject({ model: opus, effort: 'high' });
    expect(g.nodes[0].model).not.toBe(model);
  });

  it('refuses them on a command step, on add and on update', () => {
    expect(refused(emptyGraph('g', 'G', T), { type: 'addNode', node: { title: 'c', kind: 'command', command: 'ls', model: opus } })).toBe(ONLY_AGENT_STEPS_MODEL);
    expect(refused(emptyGraph('g', 'G', T), { type: 'addNode', node: { title: 'c', kind: 'command', command: 'ls', effort: 'low' } })).toBe(ONLY_AGENT_STEPS_MODEL);
    const g = build([{ type: 'addNode', node: { title: 'c', kind: 'command', command: 'ls' } }]);
    expect(refused(g, { type: 'updateNode', id: 'n1', patch: { effort: 'high' } })).toBe(ONLY_AGENT_STEPS_MODEL);
    expect(refused(build([agent()]), { type: 'updateNode', id: 'n1', patch: { kind: 'command', command: 'ls', model: opus } })).toBe(ONLY_AGENT_STEPS_MODEL);
    // Clearing on a command step is no change, so it is allowed.
    expect(refused(g, { type: 'updateNode', id: 'n1', patch: { model: null, effort: null } })).toBe('applied');
  });

  it('refuses a malformed model or effort that bypassed a schema', () => {
    expect(refused(emptyGraph('g', 'G', T), agent({ model: { provider: 'gemini' as never, id: 'x' } }))).toBe('model "gemini/x": the provider must be claude, codex or copilot, as in claude/opus.');
    expect(refused(build([agent()]), { type: 'updateNode', id: 'n1', patch: { model: { provider: 'claude', id: '' } } })).toContain('write the model id after "claude/"');
  });

  it('keeps them on other edits, changes them, and clears each with null', () => {
    let g = build([agent({ model: opus, effort: 'high' })]);
    g = apply(g, { type: 'updateNode', id: 'n1', patch: { title: 'renamed' } });
    expect(g.nodes[0]).toMatchObject({ title: 'renamed', model: opus, effort: 'high' });
    g = apply(g, { type: 'updateNode', id: 'n1', patch: { model: { provider: 'codex', id: 'gpt-6-astra' }, effort: 'ultra' } });
    expect(g.nodes[0]).toMatchObject({ model: { provider: 'codex', id: 'gpt-6-astra' }, effort: 'ultra' });
    g = apply(g, { type: 'updateNode', id: 'n1', patch: { model: null } });
    expect(g.nodes[0]).not.toHaveProperty('model');
    expect(g.nodes[0].effort).toBe('ultra');
    g = apply(g, { type: 'updateNode', id: 'n1', patch: { effort: null } });
    expect(g.nodes[0]).not.toHaveProperty('effort');
  });

  it('drops both when the step becomes a command step', () => {
    const g = apply(build([agent({ model: opus, effort: 'max' })]), { type: 'updateNode', id: 'n1', patch: { kind: 'command', command: 'ls' } });
    expect(g.nodes[0].kind).toBe('command');
    expect(g.nodes[0]).not.toHaveProperty('model');
    expect(g.nodes[0]).not.toHaveProperty('effort');
  });
});

describe('model and effort in the rest of the data model', () => {
  it('canonical form keeps them on agent steps only', () => {
    const g = build([agent({ model: opus, effort: 'low' }), { type: 'addNode', node: { title: 'c', kind: 'command', command: 'ls' } }]);
    const hidden: Graph = { ...g, nodes: [g.nodes[0], { ...g.nodes[1], model: opus, effort: 'low' }] };
    const canonical = canonicalGraph(hidden);
    expect(canonical.nodes[0]).toMatchObject({ model: opus, effort: 'low' });
    expect(canonical.nodes[1]).not.toHaveProperty('model');
    expect(canonical.nodes[1]).not.toHaveProperty('effort');
  });

  it('parseGraph reads them, refuses them on a command step, and refuses bad values', () => {
    const node = { id: 'n1', title: 'a', kind: 'agent' as const, prompt: 'p' };
    const ok = parseGraph({ id: 'g', name: 'G', nodes: [{ ...node, model: opus, effort: 'xhigh' }] });
    expect(ok.ok && ok.graph.nodes[0]).toMatchObject({ model: opus, effort: 'xhigh' });
    expect(parseGraph({ id: 'g', name: 'G', nodes: [{ ...node, kind: 'command', command: 'ls', effort: 'low' }] })).toEqual({ ok: false, error: `n1: ${ONLY_AGENT_STEPS_MODEL}` });
    expect(parseGraph({ id: 'g', name: 'G', nodes: [{ ...node, model: { provider: 'claude', id: 'two words' } }] }).ok).toBe(false);
    expect(parseGraph({ id: 'g', name: 'G', nodes: [{ ...node, effort: 'turbo' }] }).ok).toBe(false);
  });

  it('a client may set them on add, and set or clear them (null) on update', () => {
    const add = { type: 'op', graphId: 'g', op: { type: 'addNode', node: { title: 'a', kind: 'agent', model: opus, effort: 'high' } } };
    expect(parseWebviewMessage(add)).toEqual({ ok: true, kind: 'engine', msg: add });
    const clear = { type: 'op', graphId: 'g', op: { type: 'updateNode', id: 'n1', patch: { model: null, effort: null } } };
    expect(parseWebviewMessage(clear)).toEqual({ ok: true, kind: 'engine', msg: clear });
    expect(parseWebviewMessage({ type: 'op', graphId: 'g', op: { type: 'updateNode', id: 'n1', patch: { model: 'claude/opus' } } }).ok).toBe(false);
    expect(parseWebviewMessage({ type: 'op', graphId: 'g', op: { type: 'updateNode', id: 'n1', patch: { effort: 'turbo' } } }).ok).toBe(false);
  });

  it('agent-change review lists model and effort as changed fields, the model as provider/id', () => {
    const before = build([agent()]);
    const after = apply(before, { type: 'updateNode', id: 'n1', patch: { model: opus, effort: 'high' } });
    expect(changedFields(before.nodes[0], after.nodes[0])).toEqual(['model', 'effort']);
    expect(diffGraphs(before, after)).toEqual([{ kind: 'node', change: 'changed', id: 'n1', title: 'a', fields: ['model', 'effort'] }]);
    expect(changedFieldText(after.nodes[0], 'model')).toBe('claude/opus');
    expect(changedFieldText(before.nodes[0], 'model')).toBe('');
    expect(changedFields(after.nodes[0], { ...after.nodes[0], model: { ...opus } })).toEqual([]);
  });

  it('the content signature and re-run reuse follow them', () => {
    const g = build([agent(), agent(), { type: 'connect', from: 'n1', to: 'n2' }]);
    const allOk = Object.fromEntries(g.nodes.map((n) => [n.id, { status: 'succeeded' as const }])) as Record<string, NodeRunState>;
    const withModel = apply(g, { type: 'updateNode', id: 'n2', patch: { model: opus } });
    const withEffort = apply(g, { type: 'updateNode', id: 'n1', patch: { effort: 'low' } });
    expect(contentSignature(withModel)).not.toBe(contentSignature(g));
    expect(contentSignature(withEffort)).not.toBe(contentSignature(g));
    expect(reusableNodeIds(g, { snapshot: g, nodes: allOk })).toEqual(new Set(['n1', 'n2']));
    expect(reusableNodeIds(withModel, { snapshot: g, nodes: allOk })).toEqual(new Set(['n1']));
    expect(reusableNodeIds(withEffort, { snapshot: g, nodes: allOk })).toEqual(new Set());
  });
});
