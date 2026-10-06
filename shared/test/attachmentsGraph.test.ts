import { describe, expect, it } from 'vitest';
import { ONLY_AGENT_STEPS_ATTACH } from '../src/attachments';
import { changedFields, changedFieldText } from '../src/changes';
import { applyOp, contentSignature, emptyGraph, reusableNodeIds } from '../src/graph';
import { canonicalGraph } from '../src/graphDoc';
import { parseGraph, parseWebviewMessage } from '../src/schemas';
import type { Graph, NodeRunState, Op } from '../src/types';

const T = '2026-10-05T00:00:00.000Z';
function run(g: Graph, ops: Op[]): Graph {
  let out = g;
  for (const op of ops) {
    const r = applyOp(out, op, 'user', T);
    if (!r.ok) throw new Error(`${op.type}: ${r.error}`);
    out = r.graph;
  }
  return out;
}
const refused = (g: Graph, op: Op) => {
  const r = applyOp(g, op, 'user', T);
  return r.ok ? 'applied' : r.error;
};
const empty = emptyGraph('g', 'G', T);
const agent = (attachments?: string[]): Op => ({ type: 'addNode', node: { title: 'a', kind: 'agent', prompt: 'p', ...(attachments && { attachments }) } });

describe('step attachments in the data model (spec §6b.3)', () => {
  it('a step keeps its list in order; [] clears it; other edits keep it', () => {
    let g = run(empty, [agent(['b.png', 'a.md'])]);
    expect(g.nodes[0].attachments).toEqual(['b.png', 'a.md']);
    g = run(g, [{ type: 'updateNode', id: 'n1', patch: { title: 'renamed' } }]);
    expect(g.nodes[0].attachments).toEqual(['b.png', 'a.md']);
    g = run(g, [{ type: 'updateNode', id: 'n1', patch: { attachments: ['a.md'] } }]);
    expect(g.nodes[0].attachments).toEqual(['a.md']);
    g = run(g, [{ type: 'updateNode', id: 'n1', patch: { attachments: [] } }]);
    expect(g.nodes[0]).not.toHaveProperty('attachments');
  });

  it('refuses unsafe names, duplicates and attachments on a command step; a switch to command drops them', () => {
    expect(refused(empty, agent(['../x.png']))).toMatch(/isn't a safe attachment name/);
    expect(refused(empty, agent(['a.png', 'A.png']))).toBe('"A.png" is attached twice. Keep one.');
    expect(refused(empty, { type: 'addNode', node: { title: 'c', kind: 'command', command: 'ls', attachments: ['a.md'] } })).toBe(ONLY_AGENT_STEPS_ATTACH);
    const g = run(empty, [agent(['a.md'])]);
    expect(refused(g, { type: 'updateNode', id: 'n1', patch: { kind: 'command', command: 'ls', attachments: ['a.md'] } })).toBe(ONLY_AGENT_STEPS_ATTACH);
    expect(run(g, [{ type: 'updateNode', id: 'n1', patch: { kind: 'command', command: 'ls' } }]).nodes[0]).not.toHaveProperty('attachments');
  });

  it('agent-change review lists them as a changed field, one per line', () => {
    const before = run(empty, [agent()]);
    const after = run(before, [{ type: 'updateNode', id: 'n1', patch: { attachments: ['a.png', 'b.md'] } }]);
    expect(changedFields(before.nodes[0], after.nodes[0])).toEqual(['attachments']);
    expect(changedFieldText(after.nodes[0], 'attachments')).toBe('a.png\nb.md');
  });
});

describe('graph attachments in the data model (spec §6b.3)', () => {
  it('setGraphAttachments sets the whole list, and [] removes it', () => {
    const g = run(empty, [{ type: 'setGraphAttachments', names: ['brief.pdf', 'logo.png'] }]);
    expect(g.attachments).toEqual(['brief.pdf', 'logo.png']);
    expect(run(g, [{ type: 'setGraphAttachments', names: [] }])).not.toHaveProperty('attachments');
    expect(refused(empty, { type: 'setGraphAttachments', names: ['a b/c.png'] })).toMatch(/isn't a safe attachment name/);
  });

  it('canonical form keeps non-empty lists only, and a step’s only on an agent step', () => {
    const g = run(empty, [agent(['a.md']), { type: 'addNode', node: { title: 'c', kind: 'command', command: 'ls' } }]);
    const hidden: Graph = { ...g, attachments: [], nodes: [g.nodes[0], { ...g.nodes[1], attachments: ['x.md'] }] };
    const c = canonicalGraph(hidden);
    expect(c.attachments).toBeUndefined();
    expect(c.nodes[0].attachments).toEqual(['a.md']);
    expect(c.nodes[1]).not.toHaveProperty('attachments');
  });

  it('parseGraph reads both lists and refuses bad ones; clients may send them', () => {
    const node = { id: 'n1', title: 'a', kind: 'agent' as const, prompt: 'p' };
    const ok = parseGraph({ id: 'g', name: 'G', attachments: ['a.png'], nodes: [{ ...node, attachments: ['b.md'] }] });
    expect(ok.ok && ok.graph).toMatchObject({ attachments: ['a.png'], nodes: [{ attachments: ['b.md'] }] });
    expect(parseGraph({ id: 'g', name: 'G', nodes: [{ ...node, kind: 'command', command: 'ls', attachments: ['b.md'] }] })).toEqual({ ok: false, error: `n1: ${ONLY_AGENT_STEPS_ATTACH}` });
    expect(parseGraph({ id: 'g', name: 'G', attachments: ['a.png', 'a.png'], nodes: [] })).toEqual({ ok: false, error: 'graph attachments: "a.png" is attached twice. Keep one.' });
    const msg = { type: 'op', graphId: 'g', op: { type: 'setGraphAttachments', names: ['a.png'] } };
    expect(parseWebviewMessage(msg)).toEqual({ ok: true, kind: 'engine', msg });
    expect(parseWebviewMessage({ type: 'op', graphId: 'g', op: { type: 'setGraphAttachments', names: Array.from({ length: 21 }, (_, i) => `f${i}.md`) } }).ok).toBe(false);
  });

  it('the content signature and re-run reuse follow a step’s list and the graph’s', () => {
    const g = run(empty, [agent(), agent(), { type: 'addNode', node: { title: 'c', kind: 'command', command: 'ls' } }]);
    const allOk = Object.fromEntries(g.nodes.map((n) => [n.id, { status: 'succeeded' as const }])) as Record<string, NodeRunState>;
    const own = run(g, [{ type: 'updateNode', id: 'n2', patch: { attachments: ['a.md'] } }]);
    const shared = run(g, [{ type: 'setGraphAttachments', names: ['brief.pdf'] }]);
    expect(contentSignature(own)).not.toBe(contentSignature(g));
    expect(contentSignature(shared)).not.toBe(contentSignature(g));
    expect(reusableNodeIds(own, { snapshot: g, nodes: allOk })).toEqual(new Set(['n1', 'n3']));
    // Every agent step gets the graph's attachments; a command step gets none.
    expect(reusableNodeIds(shared, { snapshot: g, nodes: allOk })).toEqual(new Set(['n3']));
  });
});

describe('re-run reuse by attachment content (spec §6b.5)', () => {
  it('runs a step again when a file it gets changed under the same name', () => {
    const g = run(empty, [agent(['a.md']), agent(), { type: 'setGraphAttachments', names: ['brief.pdf'] }]);
    const allOk = Object.fromEntries(g.nodes.map((n) => [n.id, { status: 'succeeded' as const }])) as Record<string, NodeRunState>;
    const source = { snapshot: g, nodes: allOk, attachments: [{ name: 'a.md', sha256: '1' }, { name: 'brief.pdf', sha256: '2' }] };
    expect(reusableNodeIds(g, source, undefined, undefined, [{ name: 'a.md', sha256: '1' }, { name: 'brief.pdf', sha256: '2' }])).toEqual(new Set(['n1', 'n2']));
    expect(reusableNodeIds(g, source, undefined, undefined, [{ name: 'a.md', sha256: 'changed' }, { name: 'brief.pdf', sha256: '2' }])).toEqual(new Set(['n2']));
    // A missing file is a change too; the graph's file reaches every agent step.
    expect(reusableNodeIds(g, source, undefined, undefined, [{ name: 'a.md', sha256: '1' }, { name: 'brief.pdf' }])).toEqual(new Set());
    // A run recorded before attachments, or no hashes given: names only.
    expect(reusableNodeIds(g, { snapshot: g, nodes: allOk }, undefined, undefined, [{ name: 'a.md', sha256: 'x' }])).toEqual(new Set(['n1', 'n2']));
  });
});
