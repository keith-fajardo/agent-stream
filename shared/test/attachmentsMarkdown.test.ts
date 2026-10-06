import { describe, expect, it } from 'vitest';
import { diffToOps, opLine } from '../src/diffToOps';
import { canonicalGraph, formatFileErrors, type GraphDoc } from '../src/graphDoc';
import { parseGraphMarkdown } from '../src/graphMarkdownParse';
import { serializeGraphMarkdown } from '../src/graphMarkdownWrite';
import { graphFromDoc, parseGraphMeta, serializeGraphMeta } from '../src/graphMeta';
import type { GraphFileError } from '../src/types';
import { build, T0 } from './graphFixtures';
import { attachmentListProblem } from '../src/attachments';
import { applyOp } from '../src/graph';
import { graphAsDoc, undoOps, undoState } from '../src/undo';
import type { Op } from '../src/types';

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

const g = build('Files', [
  { type: 'addVariable', name: 'target' },
  { type: 'setGraphAttachments', names: ['brief.pdf', 'logo.png'] },
  { type: 'addNode', node: { title: 'Design', kind: 'agent', prompt: 'Build it.', effort: 'high', attachments: ['mockup.png', 'Q3 notes.md'] } },
]);
const text = serializeGraphMarkdown(g);

describe('attachments in the Markdown file (spec §6b.3)', () => {
  it('writes "## Attachments" after Variables, and a step’s attach lines after effort, in order', () => {
    expect(text).toContain(md('## Variables', '', '- `target`', '', '## Attachments', '', '- `brief.pdf`', '- `logo.png`', '', '## Flow'));
    expect(text).toContain(md('- kind: agent', '- effort: high', '- attach: mockup.png', '- attach: Q3 notes.md', '', FENCE + 'prompt'));
  });

  it('reads them back exactly', () => {
    const d = doc(text);
    expect(d.attachments).toEqual({ names: ['brief.pdf', 'logo.png'], line: expect.any(Number) });
    expect(d.steps[0].attachments).toEqual(['mockup.png', 'Q3 notes.md']);
    const reload = graphFromDoc(d, parseGraphMeta(serializeGraphMeta(g)), g.id, T0);
    expect(reload).toEqual(canonicalGraph(g));
    expect(serializeGraphMarkdown(reload)).toBe(text);
  });

  it('a missing file is not an error: the parser checks names only', () => {
    expect(doc(md('# G', '## Attachments', '- `not-pulled-yet.png`')).attachments?.names).toEqual(['not-pulled-yet.png']);
  });

  it('reports unsafe names, duplicates, attach on a command step and stray text, each with its line', () => {
    const rule = "isn't a safe attachment name.";
    const e = errors(
      md(
        '# G',
        '## Attachments',
        '- `../secret.png`',
        '- `a.png`',
        '- `A.png`',
        'some text',
        '## n1 · A',
        '- attach: b.md',
        '- attach: b.md',
        '- attach: c:d.md',
        FENCE + 'prompt',
        FENCE,
        '## n2 · B',
        '- kind: command',
        '- attach: x.md',
        FENCE + 'sh',
        FENCE,
      ),
    );
    expect(e.map((x) => x.line)).toEqual([3, 5, 6, 9, 10, 15]);
    expect(e[0].message).toContain(rule);
    expect(e[1].message).toBe('A.png is attached twice in the graph (also on line 4). Keep one.');
    expect(e[2].message).toBe('each line under "## Attachments" is one file, written as - `name`.');
    expect(e[3].message).toBe('b.md is attached twice in step n1 (also on line 8). Keep one.');
    expect(e[4].message).toContain(rule);
    expect(e[5].message).toBe("step n2 is a command step, so it can't have attachments. Remove this line, or make it an agent step.");
  });

  it('refuses more than 20 in one list', () => {
    const lines = Array.from({ length: 21 }, (_, i) => `- \`f${i}.md\``);
    expect(errors(md('# G', '## Attachments', ...lines))).toEqual([{ line: 23, message: 'the graph has 21 attachments; the most is 20. Remove 1.' }]);
  });
});

describe('diffToOps: attachments', () => {
  const edit = (from: string, to: string) => {
    if (!text.includes(from)) throw new Error(`not in the file: ${from}`);
    return diffToOps(g, doc(text.replace(from, to)));
  };

  it('sets, reorders and clears a step’s list, and the graph’s', () => {
    expect(edit('- attach: Q3 notes.md\n', '')).toEqual([{ type: 'updateNode', id: 'n1', patch: { attachments: ['mockup.png'] } }]);
    expect(edit('- attach: mockup.png\n- attach: Q3 notes.md\n', '- attach: Q3 notes.md\n- attach: mockup.png\n')).toEqual([{ type: 'updateNode', id: 'n1', patch: { attachments: ['Q3 notes.md', 'mockup.png'] } }]);
    expect(edit('- attach: mockup.png\n- attach: Q3 notes.md\n', '')).toEqual([{ type: 'updateNode', id: 'n1', patch: { attachments: [] } }]);
    const ops = edit('- `logo.png`\n', '- `logo.png`\n- `extra.md`\n');
    expect(ops).toEqual([{ type: 'setGraphAttachments', names: ['brief.pdf', 'logo.png', 'extra.md'] }]);
    expect(edit('## Attachments\n\n- `brief.pdf`\n- `logo.png`\n\n', '')).toEqual([{ type: 'setGraphAttachments', names: [] }]);
    const changed = text.replace('- `logo.png`\n', '- `logo.png`\n- `extra.md`\n');
    expect(opLine(doc(changed), ops[0])).toBe(changed.split('\n').indexOf('## Attachments') + 1);
  });
});

describe('NFC names and undo (controller requirements)', () => {
  it('reports a line-numbered error for a name that is not NFC, in a step and in the section', () => {
    const decomposed = 'Gro\u0308\u00dfe.md';
    const why = attachmentListProblem([decomposed]);
    expect(why).toContain('composed form');
    const e = errors(md('# G', '## Attachments', `- \`${decomposed}\``, '## n1 · A', `- attach: ${decomposed}`, FENCE + 'prompt', FENCE));
    expect(e).toEqual([
      { line: 3, message: expect.stringContaining(why!) },
      { line: 5, message: expect.stringContaining(why!) },
    ]);
  });

  it('graphAsDoc carries both lists, and undoOps takes a step list and a graph list back', () => {
    const base = canonicalGraph(g);
    expect(graphAsDoc(base).attachments?.names).toEqual(['brief.pdf', 'logo.png']);
    expect(graphAsDoc(base).steps[0].attachments).toEqual(['mockup.png', 'Q3 notes.md']);
    const apply = (gr: typeof base, ops: Op[]) => {
      let out = gr;
      for (const op of ops) {
        const r = applyOp(out, op, 'user', T0);
        if (!r.ok) throw new Error(r.error);
        out = r.graph;
      }
      return canonicalGraph(out);
    };
    for (const forward of [
      [{ type: 'updateNode', id: 'n1', patch: { attachments: ['other.md'] } }],
      [{ type: 'updateNode', id: 'n1', patch: { attachments: [] } }],
      [{ type: 'setGraphAttachments', names: ['x.md'] }],
      [{ type: 'setGraphAttachments', names: [] }],
    ] as Op[][]) {
      const after = apply(base, forward);
      expect(undoState(after), JSON.stringify(forward)).not.toBe(undoState(base));
      const back = apply(after, undoOps(after, base, forward));
      expect(undoState(back), JSON.stringify(forward)).toBe(undoState(base));
      expect(back.attachments).toEqual(base.attachments);
      expect(back.nodes[0].attachments).toEqual(base.nodes[0].attachments);
    }
  });
});
