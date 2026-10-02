import { describe, expect, it } from 'vitest';
import { applyOp, emptyGraph } from '../src/graph';
import { EXPORT_FORMAT, MAX_IMPORT_CHARS, parseExportFile, toExportFile } from '../src/exportFile';
import type { Graph, Op } from '../src/types';

const T = '2026-10-02T12:00:00.000Z';
function sample(): Graph {
  let g: Graph = { ...emptyGraph('dbt-parity', 'dbt parity', T), goal: 'Prove parity', instructions: 'Use dev', plannerSessionId: 'secret-session' };
  const ops: Op[] = [
    { type: 'addVariable', name: 'schema', description: 'Target schema' },
    { type: 'addNode', node: { title: 'Build', kind: 'command', command: 'dbt build --target {{ schema }}', timeoutSec: 60, position: { x: 1, y: 2 } } },
    { type: 'addNode', node: { title: 'Check', kind: 'agent', prompt: 'Compare' } },
    { type: 'connect', from: 'n1', to: 'n2' },
  ];
  for (const op of ops) {
    const r = applyOp(g, op, 'agent', T);
    if (!r.ok) throw new Error(r.error);
    g = r.graph;
  }
  return g;
}

describe('export files', () => {
  it('contains the definition only: no authorship, ids of the graph, planner state or values', () => {
    const file = toExportFile(sample(), T);
    expect(file).toEqual({
      format: EXPORT_FORMAT,
      version: 1,
      exportedAt: T,
      graph: {
        name: 'dbt parity',
        goal: 'Prove parity',
        instructions: 'Use dev',
        variables: [{ name: 'schema', description: 'Target schema' }],
        nodes: [
          { id: 'n1', title: 'Build', kind: 'command', command: 'dbt build --target {{ schema }}', timeoutSec: 60, position: { x: 1, y: 2 } },
          { id: 'n2', title: 'Check', kind: 'agent', prompt: 'Compare' },
        ],
        edges: [{ from: 'n1', to: 'n2' }],
      },
    });
  });

  it('imports an export as a new graph authored by the user', () => {
    const r = parseExportFile(JSON.stringify(toExportFile(sample(), T)), 'new-id', '2026-10-03T00:00:00.000Z');
    if (!r.ok) throw new Error(r.error);
    expect(r.graph).toMatchObject({ id: 'new-id', name: 'dbt parity', goal: 'Prove parity', instructions: 'Use dev', nodeSeq: 2, updatedAt: '2026-10-03T00:00:00.000Z' });
    expect(r.graph.plannerSessionId).toBeUndefined();
    expect(r.graph.nodes.map((n) => [n.id, n.createdBy, n.updatedBy, n.updatedAt])).toEqual([
      ['n1', 'user', 'user', '2026-10-03T00:00:00.000Z'],
      ['n2', 'user', 'user', '2026-10-03T00:00:00.000Z'],
    ]);
    expect(r.graph.edges).toEqual([{ id: 'n1->n2', from: 'n1', to: 'n2' }]);
  });

  it('refuses files that are too big, not JSON, not ours, a newer version, or invalid graphs', () => {
    const good = toExportFile(sample(), T);
    const parse = (content: string) => parseExportFile(content, 'x', T);
    expect(parse('x'.repeat(MAX_IMPORT_CHARS + 1))).toEqual({ ok: false, error: 'The file is larger than 1 MB.' });
    expect(parse('{nope')).toEqual({ ok: false, error: 'The file is not valid JSON.' });
    expect(parse(JSON.stringify({ format: 'other' }))).toEqual({ ok: false, error: 'This is not a claude-stream graph file.' });
    expect(parse(JSON.stringify({ ...good, version: 2 }))).toEqual({ ok: false, error: 'This file is version 2; this claude-stream reads version 1.' });
    expect(parse(JSON.stringify({ ...good, graph: { ...good.graph, name: ' ' } }))).toEqual({ ok: false, error: 'The graph in this file has no name.' });
    const cyclic = { ...good, graph: { ...good.graph, edges: [{ from: 'n1', to: 'n2' }, { from: 'n2', to: 'n1' }] } };
    expect(parse(JSON.stringify(cyclic))).toEqual({ ok: false, error: 'The graph in this file is invalid: the graph has a cycle' });
    const badVariable = { ...good, graph: { ...good.graph, variables: [{ name: 'env_var', description: '' }] } };
    expect(parse(JSON.stringify(badVariable))).toEqual({ ok: false, error: 'The graph in this file is invalid: invalid variable: "env_var" is a reserved word.' });
  });

describe('export files with unsafe step ids', () => {
  it.each(['__proto__', 'constructor', 'toString', 'con', 'LPT1'])('refuses %s', (id) => {
    const good = toExportFile(sample(), T);
    const file = { ...good, graph: { ...good.graph, nodes: [{ id, title: 'x', kind: 'agent', prompt: 'p' }], edges: [] } };
    expect(parseExportFile(JSON.stringify(file), 'x', T)).toEqual({ ok: false, error: `The graph in this file is invalid: "${id}" can't be used as a step id.` });
  });
});
});
