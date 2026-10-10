import { describe, expect, it } from 'vitest';
import { applyOp } from '../src/graph';
import { canonicalGraph, formatFileErrors, MAX_TIMEOUT_SEC, type GraphDoc } from '../src/graphDoc';
import { parseGraphMarkdown } from '../src/graphMarkdownParse';
import { serializeGraphMarkdown } from '../src/graphMarkdownWrite';
import { graphFromDoc, metaOf, parseGraphMeta, serializeGraphMeta, withMeta } from '../src/graphMeta';
import type { Graph, Op } from '../src/types';
import { build, FIXTURES, randomGraph, T0 } from './graphFixtures';

const NOW = '2026-10-04T12:00:00.000Z';
function parsed(text: string): GraphDoc {
  const r = parseGraphMarkdown(text);
  if (!r.ok) throw new Error(`${formatFileErrors(r.errors, 5)}\n---\n${text}`);
  return r.doc;
}
/** What loading the graph's two files gives back. */
const reload = (g: Graph) => graphFromDoc(parsed(serializeGraphMarkdown(g)), parseGraphMeta(serializeGraphMeta(g)), g.id, NOW);
function edited(g: Graph, op: Op): Graph {
  const r = applyOp(g, op, 'user', T0);
  if (!r.ok) throw new Error(r.error);
  return r.graph;
}
/** Lines removed and added between two texts (as sets: enough for a few changed lines). */
function lineChanges(before: string, after: string) {
  const a = before.split('\n');
  const b = after.split('\n');
  return { removed: a.filter((l) => !b.includes(l)), added: b.filter((l) => !a.includes(l)) };
}

describe('serializeGraphMarkdown', () => {
  it('writes a yes or no label on an arrow and leaves an unlabeled arrow plain', () => {
    const g = FIXTURES.example;
    const labeled: Graph = { ...g, edges: g.edges.map((e, k) => (k === 0 ? { ...e, label: 'yes' as const } : e)) };
    const text = serializeGraphMarkdown(labeled);
    expect(text).toContain('  n1["Check table absent"] -->|yes| n2["Run model"]');
    expect(text).toContain('  n2["Run model"] --> n3["Check table exists"]');
  });

  it("writes the spec's example in the fixed order, with labels on every Flow line", () => {
    expect(serializeGraphMarkdown(FIXTURES.example)).toBe(
      [
        '# scd2_tests',
        '',
        '## Goal',
        '',
        'Prove the SCD2 model works.',
        '',
        '## Instructions',
        '',
        'Use the dev target. Never touch prod.',
        '',
        '## Variables',
        '',
        '- `target_schema`: Schema the tests write to',
        '',
        '## Flow',
        '',
        '```mermaid',
        'flowchart LR',
        '  n1["Check table absent"] --> n2["Run model"]',
        '  n2["Run model"] --> n3["Check table exists"]',
        '```',
        '',
        '## n1 · Check table absent',
        '',
        '- kind: command',
        '- timeout: 120',
        '',
        "> Confirms the target table doesn't exist before the first run.",
        '',
        '```sh',
        "dbt run-operation table_exists --args '{table: dim_customer}'",
        '```',
        '',
        '## n2 · Run model',
        '',
        '- kind: agent',
        '- workspace: wh_a',
        '',
        '> Builds the model for the first time.',
        '',
        '```prompt',
        'Run `dbt run -s dim_customer` and report the row count.',
        '```',
        '',
        '## n3 · Check table exists',
        '',
        '- kind: command',
        '',
        '```sh',
        'dbt run-operation table_exists',
        '```',
        '',
      ].join('\n'),
    );
  });

  it('always writes the Flow, leaves out empty sections, and lists steps without edges', () => {
    expect(serializeGraphMarkdown(FIXTURES.empty)).toBe('# Empty\n\n## Flow\n\n```mermaid\nflowchart LR\n```\n');
    const g = build('G', [
      { type: 'addNode', node: { title: 'A "quoted"\ntitle', kind: 'agent', access: 'read', prompt: 'x' } },
      { type: 'addNode', node: { title: 'B', kind: 'command', command: 'y' } },
    ]);
    const text = serializeGraphMarkdown(g);
    expect(text).toContain('```mermaid\nflowchart LR\n  n1["A #quot;quoted#quot; title"]\n  n2["B"]\n```');
    expect(text).toContain('## n1 · A "quoted" title\n\n- kind: agent\n- access: read\n');
    expect(text).not.toMatch(/## (Goal|Instructions|Variables)/);
    expect(text).not.toContain('\r');
    expect(text.endsWith('```\n')).toBe(true);
  });

  it('picks a fence the content cannot close', () => {
    const text = serializeGraphMarkdown(FIXTURES.fencesAndJinja);
    expect(text).toContain('`````prompt\nWrite:\n```sql\nselect 1\n```\nand\n````md\nx\n````\n`````');
    expect(text).toContain('## n3 · Empty prompt\n\n- kind: agent\n\n```prompt\n```');
  });
});

describe('round trip', () => {
  it('gives every fixture back exactly, and writes the same text again', () => {
    for (const [name, g] of Object.entries(FIXTURES)) {
      const text = serializeGraphMarkdown(g);
      expect(reload(g), name).toEqual(canonicalGraph(g));
      expect(serializeGraphMarkdown(reload(g)), name).toBe(text);
    }
  });

  it('gives generated graphs back exactly (300 seeds)', () => {
    for (let seed = 1; seed <= 300; seed++) {
      const g = randomGraph(seed);
      const text = serializeGraphMarkdown(g);
      expect(reload(g), `seed ${seed}`).toEqual(canonicalGraph(g));
      expect(serializeGraphMarkdown(reload(g)), `seed ${seed}`).toBe(text);
      expect(serializeGraphMarkdown(canonicalGraph(g)), `seed ${seed}`).toBe(text);
    }
  });

  it('changes only the lines that hold what one canvas edit changed', () => {
    const g = FIXTURES.example;
    const before = serializeGraphMarkdown(g);
    expect(serializeGraphMarkdown(edited(g, { type: 'moveNode', id: 'n2', position: { x: 5, y: 6 } }))).toBe(before);
    expect(lineChanges(before, serializeGraphMarkdown(edited(g, { type: 'updateNode', id: 'n2', patch: { prompt: 'Run it.' } })))).toEqual({
      removed: ['Run `dbt run -s dim_customer` and report the row count.'],
      added: ['Run it.'],
    });
    expect(lineChanges(before, serializeGraphMarkdown(edited(g, { type: 'updateNode', id: 'n3', patch: { title: 'Verify' } })))).toEqual({
      removed: ['  n2["Run model"] --> n3["Check table exists"]', '## n3 · Check table exists'],
      added: ['  n2["Run model"] --> n3["Verify"]', '## n3 · Verify'],
    });
    expect(lineChanges(before, serializeGraphMarkdown(edited(g, { type: 'updateNode', id: 'n3', patch: { timeoutSec: 60 } })))).toEqual({ removed: [], added: ['- timeout: 60'] });
  });
});

describe('canonicalGraph', () => {
  it('keeps only what the files can hold', () => {
    const g: Graph = {
      ...FIXTURES.empty,
      name: ' Two\nlines ',
      goal: '\r\n  goal\r\n',
      variables: [{ name: 'v', description: 'a\nb' }],
      nodes: [
        { id: 'n1', title: 'A', kind: 'agent', prompt: 'p\r\nq', command: 'stale', access: 'write', description: ' one\ntwo ', timeoutSec: 0.5, createdBy: 'agent', updatedBy: 'user', updatedAt: T0 },
        { id: 'n7', title: 'B', kind: 'command', prompt: 'stale', command: '', access: 'read', workspace: '', timeoutSec: 1e12, createdBy: 'user', updatedBy: 'user', updatedAt: T0 },
      ],
      nodeSeq: 2,
    };
    expect(canonicalGraph(g)).toEqual({
      ...g,
      name: 'Two lines',
      goal: 'goal',
      variables: [{ name: 'v', description: 'a b' }],
      nodes: [
        { id: 'n1', title: 'A', kind: 'agent', prompt: 'p\nq', description: 'one two', timeoutSec: 1, createdBy: 'agent', updatedBy: 'user', updatedAt: T0 },
        { id: 'n7', title: 'B', kind: 'command', timeoutSec: MAX_TIMEOUT_SEC, createdBy: 'user', updatedBy: 'user', updatedAt: T0 },
      ],
      nodeSeq: 7,
    });
  });
});

describe('the side file', () => {
  it('holds positions, authorship, timestamps and the id counter, and nothing else', () => {
    const g = edited(edited(FIXTURES.example, { type: 'moveNode', id: 'n1', position: { x: 1, y: 2 } }), { type: 'deleteNode', id: 'n3' });
    expect(metaOf(g)).toEqual({
      version: 1,
      nodeSeq: 3,
      updatedAt: T0,
      nodes: { n1: { position: { x: 1, y: 2 }, createdBy: 'user', updatedBy: 'user', updatedAt: T0 }, n2: { createdBy: 'user', updatedBy: 'user', updatedAt: T0 } },
    });
    expect(serializeGraphMeta(g).endsWith('}\n')).toBe(true);
  });

  it('falls back to defaults without a side file, or with an invalid one', () => {
    const doc = parsed(serializeGraphMarkdown(FIXTURES.example));
    for (const text of [undefined, 'not json', '{"version":2}', '[]']) {
      const g = graphFromDoc(doc, parseGraphMeta(text), 'g', NOW);
      expect(g.nodes.every((n) => !n.position && n.createdBy === 'user' && n.updatedBy === 'user' && n.updatedAt === NOW)).toBe(true);
      expect([g.nodeSeq, g.updatedAt]).toEqual([3, NOW]);
    }
  });

  it('ignores bad entries: unknown ids, bad values and a negative nodeSeq', () => {
    const meta = parseGraphMeta('{"version":1,"nodeSeq":-4,"nodes":{"n1":{"position":{"x":"a"},"createdBy":"robot","updatedBy":"agent"},"n9":{"createdBy":"agent"},"__proto__":{"createdBy":"agent"},"bad id":{}}}');
    expect(meta).toEqual({ nodeSeq: 0, nodes: new Map([['n1', { updatedBy: 'agent' }], ['n9', { createdBy: 'agent' }]]) });
    const g = graphFromDoc(parsed(serializeGraphMarkdown(FIXTURES.example)), meta, 'g', NOW);
    expect(g.nodes[0]).toMatchObject({ id: 'n1', createdBy: 'user', updatedBy: 'agent' });
    expect(g.nodes.map((n) => n.id)).toEqual(['n1', 'n2', 'n3']);
  });

  it('gives a step without an id the next number, and never reuses one', () => {
    const doc = parsed(['# G', '## New one', '```sh', 'a', '```', '## n4 · Old', '```sh', '```', '## Another', '```prompt', '```'].join('\n'));
    expect(graphFromDoc(doc, undefined, 'g', NOW).nodes.map((n) => n.id)).toEqual(['n5', 'n4', 'n6']);
    const g = graphFromDoc(doc, parseGraphMeta('{"version":1,"nodeSeq":9}'), 'g', NOW);
    expect([g.nodes.map((n) => n.id), g.nodeSeq]).toEqual([['n10', 'n4', 'n11'], 11]);
  });

  it('re-reads only bookkeeping with withMeta', () => {
    const g = FIXTURES.example;
    const moved = withMeta(g, parseGraphMeta(JSON.stringify({ version: 1, nodeSeq: 8, updatedAt: NOW, nodes: { n2: { position: { x: 3, y: 4 }, createdBy: 'agent', updatedBy: 'agent', updatedAt: NOW } } })), NOW);
    expect(moved.nodes[1]).toMatchObject({ position: { x: 3, y: 4 }, createdBy: 'agent', prompt: g.nodes[1].prompt });
    expect([moved.nodeSeq, moved.updatedAt, moved.nodes[0].updatedAt]).toEqual([8, NOW, NOW]);
  });
});
