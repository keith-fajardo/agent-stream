import { describe, expect, it } from 'vitest';
import { diffToOps, opLine } from '../src/diffToOps';
import { applyOp, emptyGraph } from '../src/graph';
import { canonicalGraph, formatFileErrors, type GraphDoc } from '../src/graphDoc';
import { parseGraphMarkdown } from '../src/graphMarkdownParse';
import { serializeGraphMarkdown } from '../src/graphMarkdownWrite';
import { graphAsDoc } from '../src/undo';
import type { Graph, Op } from '../src/types';
import { FIXTURES, randomGraph, T0 } from './graphFixtures';

function parsed(text: string): GraphDoc {
  const r = parseGraphMarkdown(text);
  if (!r.ok) throw new Error(formatFileErrors(r.errors, 5));
  return r.doc;
}
const g = canonicalGraph(FIXTURES.example);
const text = serializeGraphMarkdown(g);
/** The example's file with `from` replaced by `to`, read back. */
function editedDoc(from: string, to: string): GraphDoc {
  if (!text.includes(from)) throw new Error(`not in the file: ${from}`);
  return parsed(text.replace(from, to));
}
function applied(graph: Graph, doc: GraphDoc): Graph {
  let out = graph;
  for (const op of diffToOps(graph, doc)) {
    const r = applyOp(out, op, 'user', T0);
    if (!r.ok) throw new Error(`${op.type}: ${r.error}`);
    out = r.graph;
  }
  return out;
}

describe('diffToOps', () => {
  it('has nothing to do for the same graph', () => {
    expect(diffToOps(g, parsed(text))).toEqual([]);
    for (let seed = 1; seed <= 100; seed++) {
      const r = canonicalGraph(randomGraph(seed));
      expect(diffToOps(r, parsed(serializeGraphMarkdown(r))), `seed ${seed}`).toEqual([]);
    }
  });

  it('disconnects a removed arrow and connects a new one', () => {
    expect(diffToOps(g, editedDoc('  n2["Run model"] --> n3["Check table exists"]', '  n1 --> n3'))).toEqual([
      { type: 'disconnect', from: 'n2', to: 'n3' },
      { type: 'connect', from: 'n1', to: 'n3' },
    ]);
  });

  it('deletes a step whose section is gone', () => {
    const without = parsed(text.replace('  n2["Run model"] --> n3["Check table exists"]\n', '').replace(/\n## n3 · [\s\S]*$/, '\n'));
    expect(diffToOps(g, without)).toEqual([
      { type: 'disconnect', from: 'n2', to: 'n3' },
      { type: 'deleteNode', id: 'n3' },
    ]);
  });

  it('adds new steps, with or without an id', () => {
    const doc = parsed(`${text}\n## n8 · Report\n\n> Says how it went.\n\n\`\`\`prompt\nSum up.\n\`\`\`\n\n## Clean up\n\n- timeout: 5\n\n\`\`\`sh\nrm -rf tmp\n\`\`\`\n`);
    expect(diffToOps(g, doc)).toEqual([
      { type: 'addNode', node: { id: 'n8', title: 'Report', kind: 'agent', description: 'Says how it went.', prompt: 'Sum up.' } },
      { type: 'addNode', node: { title: 'Clean up', kind: 'command', timeoutSec: 5, command: 'rm -rf tmp' } },
    ]);
  });

  it('updates only the fields that changed, clearing what was removed', () => {
    expect(diffToOps(g, editedDoc('- kind: command\n- timeout: 120\n\n> Confirms the target table doesn\'t exist before the first run.\n', '- kind: command\n'))).toEqual([
      { type: 'updateNode', id: 'n1', patch: { description: '', timeoutSec: 0 } },
    ]);
    expect(diffToOps(g, editedDoc('## n2 · Run model\n\n- kind: agent\n- workspace: wh_a\n', '## n2 · Run the model\n\n- kind: agent\n- access: read\n'))).toEqual([
      { type: 'updateNode', id: 'n2', patch: { title: 'Run the model', access: 'read', workspace: '' } },
    ]);
    expect(diffToOps(g, editedDoc('- kind: command\n\n```sh\ndbt run-operation table_exists\n```', '- kind: agent\n\n```prompt\nCheck it.\n```'))).toEqual([
      { type: 'updateNode', id: 'n3', patch: { kind: 'agent', prompt: 'Check it.' } },
    ]);
  });

  it('sets the goal and instructions, and changes variables by name', () => {
    const changed = parsed(
      text
        .replace('Prove the SCD2 model works.', 'Prove it.')
        .replace('Use the dev target. Never touch prod.', 'Use dev.')
        .replace('- `target_schema`: Schema the tests write to', '- `schema`: Renamed\n- `warehouse`'),
    );
    expect(diffToOps(g, changed)).toEqual([
      { type: 'setGoal', goal: 'Prove it.' },
      { type: 'setInstructions', instructions: 'Use dev.' },
      { type: 'deleteVariable', name: 'target_schema' },
      { type: 'addVariable', name: 'schema', description: 'Renamed' },
      { type: 'addVariable', name: 'warehouse' },
    ]);
    expect(diffToOps(g, editedDoc('Schema the tests write to', 'Where tests write'))).toEqual([{ type: 'setVariableDescription', name: 'target_schema', description: 'Where tests write' }]);
  });

  it('orders every kind of operation as the spec lists them, and the result matches the file', () => {
    const doc = parsed(
      text
        .replace('Prove the SCD2 model works.', 'Prove it.')
        .replace('- `target_schema`: Schema the tests write to', '- `schema`')
        .replace('  n1["Check table absent"] --> n2["Run model"]\n  n2["Run model"] --> n3["Check table exists"]', '  n1 --> n3\n  n9 --> n1')
        .replace('## n2 · Run model', '## n9 · Prepare')
        .replace('dbt run-operation table_exists\n', 'dbt run-operation table_exists --strict\n'),
    );
    expect(diffToOps(g, doc).map((op) => op.type)).toEqual(['disconnect', 'disconnect', 'deleteNode', 'addNode', 'updateNode', 'connect', 'connect', 'setGoal', 'deleteVariable', 'addVariable']);
    const result = applied(g, doc);
    expect(diffToOps(canonicalGraph(result), doc)).toEqual([]);
    expect(result.nodes.map((n) => n.id)).toEqual(['n1', 'n3', 'n9']);
    expect(result.edges.map((e) => e.id).sort()).toEqual(['n1->n3', 'n9->n1']);
  });

  it('names the line an operation came from', () => {
    const doc = parsed(`${text}\n## Clean up\n\n\`\`\`sh\nx\n\`\`\`\n`);
    expect(opLine(doc, { type: 'updateNode', id: 'n2', patch: {} })).toBe(34);
    expect(opLine(doc, { type: 'addNode', node: { title: 'Clean up', kind: 'command' } })).toBe(53);
    expect(opLine(doc, { type: 'connect', from: 'n2', to: 'n3' })).toBe(20);
    expect(opLine(doc, { type: 'addVariable', name: 'target_schema' })).toBe(13);
    expect(opLine(doc, { type: 'setGoal', goal: '' })).toBe(1);
  });

  describe('labels and fail-fast', () => {
    function built(ops: Op[]): Graph {
      let out = emptyGraph('g', 'G', T0);
      for (const op of ops) {
        const r = applyOp(out, op, 'user', T0);
        if (!r.ok) throw new Error(`${op.type}: ${r.error}`);
        out = r.graph;
      }
      return out;
    }
    const branch = (label: 'yes' | 'no'): Graph =>
      built([
        { type: 'addNode', node: { title: 'Is it ready', kind: 'condition', prompt: 'Is it ready?' } },
        { type: 'addNode', node: { title: 'Ship', kind: 'command', command: 'ship' } },
        { type: 'connect', from: 'n1', to: 'n2', label },
      ]);

    it('replaces an arrow whose label changed: a disconnect, then a connect with the new label', () => {
      expect(diffToOps(branch('yes'), graphAsDoc(branch('no')))).toEqual([
        { type: 'disconnect', from: 'n1', to: 'n2' },
        { type: 'connect', from: 'n1', to: 'n2', label: 'no' },
      ]);
    });

    it('has nothing to do for the same labeled arrow', () => {
      expect(diffToOps(branch('yes'), graphAsDoc(branch('yes')))).toEqual([]);
    });

    it('patches fail-fast on a stop step', () => {
      const stop = (failFast: boolean): Graph =>
        built([
          { type: 'addNode', node: { title: 'Halt', kind: 'stop' } },
          ...(failFast ? [{ type: 'updateNode', id: 'n1', patch: { failFast: true } } as Op] : []),
        ]);
      expect(diffToOps(stop(false), graphAsDoc(stop(true)))).toEqual([{ type: 'updateNode', id: 'n1', patch: { failFast: true } }]);
      expect(diffToOps(stop(true), graphAsDoc(stop(false)))).toEqual([{ type: 'updateNode', id: 'n1', patch: { failFast: false } }]);
    });
  });
});
