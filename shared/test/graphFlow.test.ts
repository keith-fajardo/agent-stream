import { describe, expect, it } from 'vitest';
import { ONLY_ARROWS, parseChain, parseFlow } from '../src/graphFlow';

const ids = new Set(['n1', 'n2', 'n3', 'a-b', 'step_4']);
/** The block's lines, numbered from 11 (the opening fence is line 10). */
const flow = (...texts: string[]) => parseFlow(texts.map((text, k) => ({ line: 11 + k, text })), ids, 10);

describe('parseChain', () => {
  it('reads ids joined by arrows, skipping every label form', () => {
    expect(parseChain('n1 --> n2 --> n3')).toEqual({ ok: true, ids: ['n1', 'n2', 'n3'] });
    expect(parseChain('n1["Check · the \\"table\\""] --> n2("Run") --> n3[plain label]')).toEqual({ ok: true, ids: ['n1', 'n2', 'n3'] });
    expect(parseChain('n1(plain) --> n2')).toEqual({ ok: true, ids: ['n1', 'n2'] });
    expect(parseChain('a-b-->step_4;')).toEqual({ ok: true, ids: ['a-b', 'step_4'] });
    expect(parseChain('n1')).toEqual({ ok: true, ids: ['n1'] });
  });

  it('refuses other Mermaid links and shapes', () => {
    for (const text of ['n1 -.-> n2', 'n1 ==> n2', 'n1 -->|yes| n2', 'n1 --- n2', 'n1 & n2 --> n3', 'n1 ---> n2', 'n1{"x"} --> n2', 'n1 -- text --> n2']) {
      expect(parseChain(text)).toMatchObject({ ok: false, error: expect.stringContaining(ONLY_ARROWS) });
    }
    expect(parseChain('n1["open --> n2')).toEqual({ ok: false, error: 'the label after n1 isn\'t closed. Write it as n1["Title"].' });
  });
});

describe('parseFlow', () => {
  it('reads edges in order, with any direction, comments and blank lines', () => {
    const r = flow('flowchart TD', '', '  %% a comment', '  n1["A"] --> n2["B"] --> n3["C"]', '  step_4');
    expect(r).toEqual({
      errors: [],
      edges: [
        { from: 'n1', to: 'n2', line: 14 },
        { from: 'n2', to: 'n3', line: 14 },
      ],
    });
    expect(flow('graph', 'n1 --> n2').edges).toEqual([{ from: 'n1', to: 'n2', line: 12 }]);
    expect(flow('flowchart LR').edges).toEqual([]);
  });

  it('reports each problem with its line', () => {
    const r = flow('flowchart LR', 'subgraph one', 'n1 --> n7', 'n1 --> n1', 'n1 --> n2', 'n1 --> n2', 'n2 --> n1', 'classDef x fill:#f00', 'end', 'n1 ==> n3');
    expect(r.errors).toEqual([
      { line: 12, message: `"subgraph" isn't supported in the Flow. ${ONLY_ARROWS}` },
      { line: 13, message: 'the Flow block mentions n7, but there is no "## n7 · …" step section. Add one or remove n7 from the Flow.' },
      { line: 14, message: "n1 --> n1: a step can't connect to itself. Remove this arrow." },
      { line: 16, message: 'n1 --> n2 is in the Flow twice. Remove one of them.' },
      { line: 17, message: "n2 --> n1 would make a cycle. Steps run in arrow order, so the arrows can't loop back." },
      { line: 18, message: `"classDef" isn't supported in the Flow. ${ONLY_ARROWS}` },
      { line: 19, message: `"end" isn't supported in the Flow. ${ONLY_ARROWS}` },
      { line: 20, message: `"==> n3" isn't supported. ${ONLY_ARROWS}` },
    ]);
    expect(r.edges).toEqual([{ from: 'n1', to: 'n2', line: 15 }]);
  });

  it('asks for the flowchart header, and for content in an empty block', () => {
    expect(flow('n1 --> n2').errors).toEqual([{ line: 11, message: 'the mermaid block must start with "flowchart LR" (or TD, TB, RL, BT).' }]);
    expect(flow('', '%% only a comment').errors).toEqual([{ line: 10, message: 'the mermaid block is empty. Start it with "flowchart LR", then one arrow per line, such as n1 --> n2.' }]);
  });
});
