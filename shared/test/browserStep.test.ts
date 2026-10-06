import { describe, expect, it } from 'vitest';
import { ONLY_AGENT_STEPS_BROWSER } from '../src/browser';
import { changedFields, changedFieldText } from '../src/changes';
import { diffToOps } from '../src/diffToOps';
import { applyOp, contentSignature, emptyGraph, reusableNodeIds } from '../src/graph';
import { canonicalGraph, formatFileErrors, type GraphDoc } from '../src/graphDoc';
import { parseGraphMarkdown } from '../src/graphMarkdownParse';
import { serializeGraphMarkdown } from '../src/graphMarkdownWrite';
import { graphFromDoc, parseGraphMeta, serializeGraphMeta } from '../src/graphMeta';
import { parseGraph, parseWebviewMessage } from '../src/schemas';
import type { Graph, NodeRunState, Op } from '../src/types';
import { graphAsDoc } from '../src/undo';
import { build, T0 } from './graphFixtures';

const md = (...lines: string[]) => lines.join('\n');
const FENCE = '```';
function apply(g: Graph, op: Op): Graph {
  const r = applyOp(g, op, 'user', T0);
  if (!r.ok) throw new Error(r.error);
  return r.graph;
}
const refused = (g: Graph, op: Op) => {
  const r = applyOp(g, op, 'user', T0);
  return r.ok ? 'applied' : r.error;
};
function doc(text: string): GraphDoc {
  const r = parseGraphMarkdown(text);
  if (!r.ok) throw new Error(formatFileErrors(r.errors, 10));
  return r.doc;
}
const agent = (over: object = {}): Op => ({ type: 'addNode', node: { title: 'Research', kind: 'agent', prompt: 'Find jobs.', ...over } });
const command: Op = { type: 'addNode', node: { title: 'List', kind: 'command', command: 'ls' } };

describe('applyOp: browser', () => {
  it('stores browser on an agent step, keeps it on other edits, and false turns it off', () => {
    let g = build('B', [agent({ browser: true })]);
    expect(g.nodes[0].browser).toBe(true);
    g = apply(g, { type: 'updateNode', id: 'n1', patch: { title: 'Search' } });
    expect(g.nodes[0]).toMatchObject({ title: 'Search', browser: true });
    g = apply(g, { type: 'updateNode', id: 'n1', patch: { browser: false } });
    expect(g.nodes[0]).not.toHaveProperty('browser');
    g = apply(g, { type: 'updateNode', id: 'n1', patch: { browser: true } });
    expect(g.nodes[0].browser).toBe(true);
    // false is never stored.
    expect(build('B', [agent({ browser: false })]).nodes[0]).not.toHaveProperty('browser');
  });

  it('refuses it on a command step, on add and on update; false there is no change', () => {
    expect(refused(emptyGraph('g', 'G', T0), { type: 'addNode', node: { title: 'c', kind: 'command', command: 'ls', browser: true } })).toBe(ONLY_AGENT_STEPS_BROWSER);
    const g = build('B', [command]);
    expect(refused(g, { type: 'updateNode', id: 'n1', patch: { browser: true } })).toBe(ONLY_AGENT_STEPS_BROWSER);
    expect(refused(build('B', [agent()]), { type: 'updateNode', id: 'n1', patch: { kind: 'command', command: 'ls', browser: true } })).toBe(ONLY_AGENT_STEPS_BROWSER);
    expect(refused(g, { type: 'updateNode', id: 'n1', patch: { browser: false } })).toBe('applied');
  });

  it('drops it when the step becomes a command step', () => {
    const g = apply(build('B', [agent({ browser: true })]), { type: 'updateNode', id: 'n1', patch: { kind: 'command', command: 'ls' } });
    expect(g.nodes[0].kind).toBe('command');
    expect(g.nodes[0]).not.toHaveProperty('browser');
  });
});

describe('browser in the rest of the data model', () => {
  it('canonical form keeps it on agent steps only, and old graphs without it load unchanged', () => {
    const g = build('B', [agent({ browser: true }), command]);
    const hidden: Graph = { ...g, nodes: [g.nodes[0], { ...g.nodes[1], browser: true }] };
    const c = canonicalGraph(hidden);
    expect(c.nodes[0].browser).toBe(true);
    expect(c.nodes[1]).not.toHaveProperty('browser');
    const old = parseGraph({ id: 'g', name: 'G', nodes: [{ id: 'n1', title: 'a', kind: 'agent', prompt: 'p' }] });
    expect(old.ok && old.graph.nodes[0]).not.toHaveProperty('browser');
    const withIt = parseGraph({ id: 'g', name: 'G', nodes: [{ id: 'n1', title: 'a', kind: 'agent', prompt: 'p', browser: true }] });
    expect(withIt.ok && withIt.graph.nodes[0].browser).toBe(true);
  });

  it('a client may set it on add and set or clear it on update; anything but a boolean is refused', () => {
    const add = { type: 'op', graphId: 'g', op: { type: 'addNode', node: { title: 'a', kind: 'agent', browser: true } } };
    expect(parseWebviewMessage(add)).toEqual({ ok: true, kind: 'engine', msg: add });
    const off = { type: 'op', graphId: 'g', op: { type: 'updateNode', id: 'n1', patch: { browser: false } } };
    expect(parseWebviewMessage(off)).toEqual({ ok: true, kind: 'engine', msg: off });
    expect(parseWebviewMessage({ type: 'op', graphId: 'g', op: { type: 'updateNode', id: 'n1', patch: { browser: 'on' } } }).ok).toBe(false);
  });

  it('agent-change review lists browser as a changed field', () => {
    const before = build('B', [agent()]);
    const after = apply(before, { type: 'updateNode', id: 'n1', patch: { browser: true } });
    expect(changedFields(before.nodes[0], after.nodes[0])).toEqual(['browser']);
    expect(changedFieldText(after.nodes[0], 'browser')).toBe('on');
    expect(changedFieldText(before.nodes[0], 'browser')).toBe('');
  });

  it('changing it changes the content signature and stops the step (and what follows) being reused', () => {
    const g = build('B', [agent(), agent(), { type: 'connect', from: 'n1', to: 'n2' }]);
    const allOk = Object.fromEntries(g.nodes.map((n) => [n.id, { status: 'succeeded' as const }])) as Record<string, NodeRunState>;
    const on2 = apply(g, { type: 'updateNode', id: 'n2', patch: { browser: true } });
    const on1 = apply(g, { type: 'updateNode', id: 'n1', patch: { browser: true } });
    expect(contentSignature(on2)).not.toBe(contentSignature(g));
    expect(reusableNodeIds(g, { snapshot: g, nodes: allOk })).toEqual(new Set(['n1', 'n2']));
    expect(reusableNodeIds(on2, { snapshot: g, nodes: allOk })).toEqual(new Set(['n1']));
    expect(reusableNodeIds(on1, { snapshot: g, nodes: allOk })).toEqual(new Set());
    // Turning it off again is a change too.
    expect(reusableNodeIds(g, { snapshot: on2, nodes: allOk })).toEqual(new Set(['n1']));
  });
});

describe('the browser line in the Markdown file', () => {
  const g = build('Research', [agent({ browser: true, effort: 'low', attachments: ['brief.md'] }), command]);
  const text = serializeGraphMarkdown(g);

  it('writes "- browser: on" after effort and before attach, only when on', () => {
    expect(text).toContain(md('## n1 · Research', '', '- kind: agent', '- effort: low', '- browser: on', '- attach: brief.md', ''));
    expect(serializeGraphMarkdown(build('R', [agent()]))).not.toContain('browser');
  });

  it('reads it back exactly; off is the same as no line', () => {
    expect(doc(text).steps[0].browser).toBe(true);
    const reload = graphFromDoc(doc(text), parseGraphMeta(serializeGraphMeta(g)), g.id, T0);
    expect(reload).toEqual(canonicalGraph(g));
    expect(serializeGraphMarkdown(reload)).toBe(text);
    expect(doc(md('# G', '## n1 · A', '- browser: off', FENCE + 'prompt', FENCE)).steps[0]).not.toHaveProperty('browser');
  });

  it('reports any other value in the same form as other bad step lines', () => {
    const r = parseGraphMarkdown(md('# G', '## n1 · A', '- browser: yes', FENCE + 'prompt', FENCE));
    expect(r).toEqual({ ok: false, errors: [{ line: 3, message: 'browser is "yes"; use on or off.' }] });
  });

  it('drops it from a command step with a warning, and the file still reads', () => {
    const r = parseGraphMarkdown(md('# G', '## n1 · A', '- kind: command', '- browser: on', FENCE + 'sh', 'ls', FENCE, '## n2 · B', '- browser: off', FENCE + 'sh', 'ls', FENCE));
    if (!r.ok) throw new Error('expected a graph');
    expect(r.doc.steps.map((s) => s.browser)).toEqual([undefined, undefined]);
    expect(r.warnings).toEqual([
      { line: 4, message: "step n1 is a command step, so it can't use the browser. Agent Stream removed this line." },
      { line: 9, message: "step n2 is a command step, so it can't use the browser. Agent Stream removed this line." },
    ]);
    expect(parseGraphMarkdown(text)).not.toHaveProperty('warnings');
  });

  it('a hand edit turns it on and off through diffToOps', () => {
    expect(diffToOps(g, doc(text.replace('- browser: on\n', '')))).toEqual([{ type: 'updateNode', id: 'n1', patch: { browser: false } }]);
    const off = build('Research', [agent({ effort: 'low', attachments: ['brief.md'] }), command]);
    expect(diffToOps(off, doc(text))).toEqual([{ type: 'updateNode', id: 'n1', patch: { browser: true } }]);
  });
});

describe('browser and undo', () => {
  it('graphAsDoc keeps it, so undo does not turn it off', () => {
    const g = build('B', [agent({ browser: true }), agent()]);
    expect(diffToOps(g, graphAsDoc(g))).toEqual([]);
    const off = apply(g, { type: 'updateNode', id: 'n1', patch: { browser: false } });
    expect(diffToOps(off, graphAsDoc(g))).toEqual([{ type: 'updateNode', id: 'n1', patch: { browser: true } }]);
  });
});
