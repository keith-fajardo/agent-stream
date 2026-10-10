import { describe, expect, it } from 'vitest';
import { diffToOps } from '../src/diffToOps';
import { canonicalGraph, formatFileErrors, type GraphDoc } from '../src/graphDoc';
import { parseGraphMarkdown } from '../src/graphMarkdownParse';
import { serializeGraphMarkdown } from '../src/graphMarkdownWrite';
import { graphFromDoc, parseGraphMeta, serializeGraphMeta } from '../src/graphMeta';
import type { Op } from '../src/types';
import { build, T0 } from './graphFixtures';

const md = (...lines: string[]) => lines.join('\n');
const FENCE = '```';
function doc(text: string): GraphDoc {
  const r = parseGraphMarkdown(text);
  if (!r.ok) throw new Error(formatFileErrors(r.errors, 10));
  return r.doc;
}
const errors = (text: string) => {
  const r = parseGraphMarkdown(text);
  return r.ok ? [] : r.errors;
};
const sub = (over: object = {}): Op => ({ type: 'addNode', node: { title: 'Research the target company', kind: 'graph', graph: 'company-research', ...over } });

describe('a sub-graph step in the Markdown file', () => {
  const g = build('Job hunting', [
    sub({ description: "Researches the company we're applying to.", values: { depth: 'quick', company: '{{ target_company }}\nand its parent' } }),
    { type: 'addNode', node: { title: 'Write the letter', kind: 'agent', prompt: 'Write it.' } },
    { type: 'connect', from: 'n1', to: 'n2' },
  ]);
  const text = serializeGraphMarkdown(g);

  it('writes the kind and graph lines, the description, then one value block per value in name order', () => {
    expect(text).toContain(
      md(
        '## n1 · Research the target company',
        '',
        '- kind: graph',
        '- graph: company-research',
        '',
        "> Researches the company we're applying to.",
        '',
        FENCE + 'value company',
        '{{ target_company }}',
        'and its parent',
        FENCE,
        '',
        FENCE + 'value depth',
        'quick',
        FENCE,
        '',
        '## n2 · Write the letter',
      ),
    );
    expect(text).toContain('  n1["Research the target company"] --> n2["Write the letter"]');
  });

  it('reads back exactly, multi-line values included', () => {
    expect(doc(text).steps[0]).toEqual({
      id: 'n1',
      title: 'Research the target company',
      kind: 'graph',
      graph: 'company-research',
      values: { company: '{{ target_company }}\nand its parent', depth: 'quick' },
      description: "Researches the company we're applying to.",
      line: expect.any(Number),
    });
    const reload = graphFromDoc(doc(text), parseGraphMeta(serializeGraphMeta(g)), g.id, T0);
    expect(reload).toEqual(canonicalGraph(g));
    expect(serializeGraphMarkdown(reload)).toBe(text);
  });

  it('writes no block for a value that is absent, and an empty block for an empty value', () => {
    const bare = serializeGraphMarkdown(build('J', [sub()]));
    expect(bare).toContain(md('- kind: graph', '- graph: company-research', ''));
    expect(bare).not.toContain('value');
    const empty = serializeGraphMarkdown(build('J', [sub({ values: { company: '' } })]));
    expect(empty).toContain(md(FENCE + 'value company', FENCE));
    expect(doc(empty).steps[0].values).toEqual({ company: '' });
  });

  it('keeps a value whose text has a code fence, with a longer fence around it', () => {
    const fenced = build('J', [sub({ values: { notes: 'see\n```\ncode\n```' } })]);
    const out = serializeGraphMarkdown(fenced);
    expect(out).toContain('````value notes');
    expect(doc(out).steps[0].values).toEqual({ notes: 'see\n```\ncode\n```' });
  });

  it('a graph line without a kind line and without a block is a sub-graph step too', () => {
    expect(doc(md('# G', '## n1 · S', '- graph: company-research')).steps[0]).toMatchObject({ kind: 'graph', graph: 'company-research' });
  });

  it('a hand edit changes the graph and the values through diffToOps', () => {
    const edited = text.replace('- graph: company-research', '- graph: tailor-cv').replace(md(FENCE + 'value depth', 'quick', FENCE), md(FENCE + 'value depth', 'thorough', FENCE));
    expect(diffToOps(g, doc(edited))).toEqual([{ type: 'updateNode', id: 'n1', patch: { graph: 'tailor-cv', values: { company: '{{ target_company }}\nand its parent', depth: 'thorough' } } }]);
  });
});

describe('sub-graph step problems, in the form of other bad step lines', () => {
  it('reports a missing or bad graph line', () => {
    expect(errors(md('# G', '## n1 · S', '- kind: graph'))).toEqual([{ line: 2, message: 'step n1 is a sub-graph step, so it needs a "- graph: <graph id>" line.' }]);
    expect(errors(md('# G', '## n1 · S', '- kind: graph', '- graph: Company Research'))).toEqual([
      { line: 4, message: '"Company Research" isn\'t a graph id: graph ids use lowercase letters, digits and -, starting with a letter or digit (at most 80).' },
    ]);
  });

  it('reports a value block with a bad name, a missing name, or a repeated name', () => {
    expect(errors(md('# G', '## n1 · S', '- kind: graph', '- graph: g2', FENCE + 'value 1x', 'a', FENCE, FENCE + 'value', 'b', FENCE, FENCE + 'value a', 'c', FENCE, FENCE + 'value a', 'd', FENCE))).toEqual([
      { line: 5, message: 'value "1x": "1x" is not a valid variable name: use letters, digits and _, starting with a letter or _ (at most 64 characters).' },
      { line: 8, message: 'a value block\'s first line is "value" and the variable\'s name, as in ```value company.' },
      { line: 14, message: 'step n1 sets the value a twice (also on line 11). Keep one.' },
    ]);
  });

  it('reports a prompt or sh block on a sub-graph step, and a graph line or value block on another step', () => {
    expect(errors(md('# G', '## n1 · S', '- kind: graph', '- graph: g2', FENCE + 'prompt', 'p', FENCE))).toEqual([
      { line: 5, message: "step n1 is a sub-graph step, so it can't have a ```prompt block. Remove the block, or make it an agent or command step." },
    ]);
    expect(errors(md('# G', '## n1 · S', '- kind: graph', '- graph: g2', FENCE + 'sh', 'ls', FENCE))[0].message).toContain("can't have a ```sh block");
    expect(errors(md('# G', '## n1 · A', '- kind: agent', '- graph: g2', FENCE + 'prompt', 'p', FENCE, FENCE + 'value a', 'x', FENCE))).toEqual([
      { line: 4, message: "step n1 is an agent step, so it can't have a graph. Remove this line, or make it a sub-graph step (kind: graph)." },
      { line: 8, message: "step n1 is an agent step, so it can't have a value block. Remove the block, or make it a sub-graph step (kind: graph)." },
    ]);
  });

  it('a value over 10,000 characters is an error', () => {
    expect(errors(md('# G', '## n1 · S', '- kind: graph', '- graph: g2', FENCE + 'value a', 'x'.repeat(10_001), FENCE))).toEqual([{ line: 5, message: 'The value of a can be at most 10000 characters.' }]);
  });

  it('drops agent and command fields from a sub-graph step with a warning, and the file still reads', () => {
    const r = parseGraphMarkdown(md('# G', '## n1 · S', '- kind: graph', '- graph: g2', '- access: read', '- workspace: wh_a', '- timeout: 5', '- model: claude/opus', '- effort: low', '- browser: on', '- attach: a.md'));
    if (!r.ok) throw new Error(formatFileErrors(r.errors, 10));
    expect(r.doc.steps[0]).toEqual({ id: 'n1', title: 'S', kind: 'graph', graph: 'g2', line: 2 });
    expect(r.warnings).toEqual(
      ['access', 'workspace', 'timeout', 'model', 'effort', 'browser', 'attach'].map((field, i) => ({ line: 5 + i, message: `step n1 is a sub-graph step, so it can't have ${field}. Agent Stream removed this line.` })),
    );
  });

  it('names graph among the step fields, and reads kind: graph', () => {
    expect(errors(md('# G', '## n1 · A', '- colour: red', FENCE + 'prompt', FENCE))).toEqual([
      { line: 3, message: 'unknown field "colour". Step fields are kind, access, workspace, timeout, model, effort, browser, attach, graph and fail-fast.' },
    ]);
    expect(errors(md('# G', '## n1 · A', '- kind: graph', '- graph: g2'))).toEqual([]);
  });
});
