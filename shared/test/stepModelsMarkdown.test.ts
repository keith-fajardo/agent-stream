import { describe, expect, it } from 'vitest';
import { diffToOps } from '../src/diffToOps';
import { applyOp } from '../src/graph';
import { canonicalGraph, formatFileErrors, type GraphDoc } from '../src/graphDoc';
import { parseGraphMarkdown } from '../src/graphMarkdownParse';
import { serializeGraphMarkdown } from '../src/graphMarkdownWrite';
import { graphFromDoc, parseGraphMeta, serializeGraphMeta } from '../src/graphMeta';
import type { Graph, GraphFileError, Op } from '../src/types';
import { build, T0 } from './graphFixtures';

const md = (...lines: string[]) => lines.join('\n');
const FENCE = '```';
function doc(text: string): GraphDoc {
  const r = parseGraphMarkdown(text);
  if (!r.ok) throw new Error(formatFileErrors(r.errors, 10));
  return r.doc;
}
function errors(text: string): GraphFileError[] {
  const r = parseGraphMarkdown(text);
  if (r.ok) throw new Error('expected errors');
  return r.errors;
}
function applied(graph: Graph, ops: Op[]): Graph {
  let out = graph;
  for (const op of ops) {
    const r = applyOp(out, op, 'user', T0);
    if (!r.ok) throw new Error(`${op.type}: ${r.error}`);
    out = r.graph;
  }
  return out;
}
const opus = { provider: 'claude' as const, id: 'opus' };

/** One agent step with a model and an effort, and a command step. */
const g = build('Models', [
  { type: 'addNode', node: { title: 'Plan', kind: 'agent', prompt: 'Plan it.', timeoutSec: 60, model: opus, effort: 'high' } },
  { type: 'addNode', node: { title: 'Build', kind: 'command', command: 'make' } },
]);
const text = serializeGraphMarkdown(g);

describe('model and effort in the Markdown file', () => {
  it('writes them after timeout, model first, only when set', () => {
    expect(text).toContain(md('## n1 · Plan', '', '- kind: agent', '- timeout: 60', '- model: claude/opus', '- effort: high', '', FENCE + 'prompt'));
    expect(text).toContain(md('## n2 · Build', '', '- kind: command', '', FENCE + 'sh'));
  });

  it('reads them back exactly, the id being everything after the first /', () => {
    expect(doc(text).steps[0]).toMatchObject({ model: opus, effort: 'high' });
    const read = doc(md('# G', '## n1 · A', '- effort: ultra', '- model: codex/org/gpt-6-astra', FENCE + 'prompt', FENCE));
    expect(read.steps[0]).toMatchObject({ model: { provider: 'codex', id: 'org/gpt-6-astra' }, effort: 'ultra' });
    const reload = graphFromDoc(doc(text), parseGraphMeta(serializeGraphMeta(g)), g.id, T0);
    expect(reload).toEqual(canonicalGraph(g));
    expect(serializeGraphMarkdown(reload)).toBe(text);
  });

  it('does not check that the model exists: a graph opens on any machine', () => {
    expect(doc(md('# G', '## n1 · A', '- model: copilot/some-model-from-another-plan', FENCE + 'prompt', FENCE)).steps[0].model).toEqual({ provider: 'copilot', id: 'some-model-from-another-plan' });
  });

  it('reports each bad line with how to fix it', () => {
    const idRule = (p: string) => `write the model id after "${p}/" (1 to 200 characters, no spaces), as in claude/opus.`;
    expect(
      errors(
        md(
          '# G',
          '## n1 · A',
          '- model: gemini/flash',
          '- effort: turbo',
          FENCE + 'prompt',
          FENCE,
          '## n2 · B',
          '- model: claude/',
          FENCE + 'prompt',
          FENCE,
          '## n3 · C',
          '- model: claude/two words',
          FENCE + 'prompt',
          FENCE,
          '## n4 · D',
          '- kind: command',
          '- model: claude/opus',
          '- effort: low',
          FENCE + 'sh',
          FENCE,
          '## n5 · E',
          '- effort: low',
          '- effort: high',
          FENCE + 'prompt',
          FENCE,
        ),
      ),
    ).toEqual([
      { line: 3, message: 'model "gemini/flash": the provider must be claude, codex or copilot, as in claude/opus.' },
      { line: 4, message: 'effort is "turbo"; use low, medium, high, xhigh, max or ultra.' },
      { line: 8, message: `model "claude/": ${idRule('claude')}` },
      { line: 12, message: `model "claude/two words": ${idRule('claude')}` },
      { line: 17, message: "step n4 is a command step, so it can't have a model or effort. Remove this line, or make it an agent step." },
      { line: 18, message: "step n4 is a command step, so it can't have a model or effort. Remove this line, or make it an agent step." },
      { line: 23, message: 'the field effort appears twice in step n5. Keep one.' },
    ]);
  });

  it('a command step by its block alone is a command step too', () => {
    expect(errors(md('# G', '## n1 · A', '- effort: low', FENCE + 'sh', 'ls', FENCE))).toEqual([
      { line: 3, message: "step n1 is a command step, so it can't have a model or effort. Remove this line, or make it an agent step." },
    ]);
  });
});

describe('diffToOps: model and effort', () => {
  const edit = (from: string, to: string) => {
    if (!text.includes(from)) throw new Error(`not in the file: ${from}`);
    return diffToOps(g, doc(text.replace(from, to)));
  };

  it('changes, sets and clears them with null', () => {
    expect(edit('- model: claude/opus', '- model: codex/gpt-6-astra')).toEqual([{ type: 'updateNode', id: 'n1', patch: { model: { provider: 'codex', id: 'gpt-6-astra' } } }]);
    expect(edit('- model: claude/opus\n', '')).toEqual([{ type: 'updateNode', id: 'n1', patch: { model: null } }]);
    expect(edit('- effort: high\n', '')).toEqual([{ type: 'updateNode', id: 'n1', patch: { effort: null } }]);
    expect(edit('- effort: high', '- effort: low')).toEqual([{ type: 'updateNode', id: 'n1', patch: { effort: 'low' } }]);
    const set = edit(md('- kind: command', '', `${FENCE}sh`, 'make'), md('- kind: agent', '- effort: max', '', `${FENCE}prompt`, 'make'));
    expect(set).toEqual([{ type: 'updateNode', id: 'n2', patch: { kind: 'agent', prompt: 'make', effort: 'max' } }]);
    expect(applied(g, set).nodes[1]).toMatchObject({ kind: 'agent', prompt: 'make', effort: 'max' });
  });

  it('a step that becomes a command step loses them without a patch for them', () => {
    const ops = edit(md('- kind: agent', '- timeout: 60', '- model: claude/opus', '- effort: high', '', `${FENCE}prompt`, 'Plan it.'), md('- kind: command', '- timeout: 60', '', `${FENCE}sh`, 'plan'));
    expect(ops).toEqual([{ type: 'updateNode', id: 'n1', patch: { kind: 'command', command: 'plan' } }]);
    const after = applied(g, ops);
    expect(after.nodes[0]).not.toHaveProperty('model');
    expect(after.nodes[0]).not.toHaveProperty('effort');
  });

  it('a new step keeps them', () => {
    const ops = diffToOps(g, doc(`${text}\n## Check\n\n- model: copilot/auto\n- effort: low\n\n${FENCE}prompt\nCheck.\n${FENCE}\n`));
    expect(ops).toEqual([{ type: 'addNode', node: { title: 'Check', kind: 'agent', model: { provider: 'copilot', id: 'auto' }, effort: 'low', prompt: 'Check.' } }]);
  });
});
