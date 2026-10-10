import { describe, expect, it } from 'vitest';
import { applyOp, emptyGraph } from '../src/graph';
import { EXPORT_FORMAT, MAX_IMPORT_CHARS, parseExportFile, toExportFile } from '../src/exportFile';
import type { Graph, Op } from '../src/types';

const T = '2026-10-02T12:00:00.000Z';
function sample(): Graph {
  // A graph file from before work sessions still carried planner state.
  let g = { ...emptyGraph('dbt-parity', 'dbt parity', T), goal: 'Prove parity', instructions: 'Use dev', plannerSessionId: 'secret-session' } as Graph;
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

describe('export format names', () => {
  it('writes agent-stream/graph and still reads the legacy claude-stream/graph', () => {
    const file = toExportFile(sample(), T);
    expect(file.format).toBe('agent-stream/graph');
    for (const format of ['agent-stream/graph', 'claude-stream/graph']) {
      const r = parseExportFile(JSON.stringify({ ...file, format }), 'copy', T);
      expect(r.ok).toBe(true);
    }
    expect(parseExportFile(JSON.stringify({ ...file, format: 'other/graph' }), 'copy', T)).toMatchObject({ ok: false });
  });
});

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
    expect((r.graph as Record<string, unknown>).plannerSessionId).toBeUndefined();
    expect(r.graph.nodes.map((n) => [n.id, n.createdBy, n.updatedBy, n.updatedAt])).toEqual([
      ['n1', 'user', 'user', '2026-10-03T00:00:00.000Z'],
      ['n2', 'user', 'user', '2026-10-03T00:00:00.000Z'],
    ]);
    expect(r.graph.edges).toEqual([{ id: 'n1->n2', from: 'n1', to: 'n2' }]);
  });

  it('carries a step description through export and import', () => {
    const r0 = applyOp(sample(), { type: 'updateNode', id: 'n2', patch: { description: 'Checks the new model matches.' } }, 'user', T);
    if (!r0.ok) throw new Error(r0.error);
    const file = toExportFile(r0.graph, T);
    expect(file.graph.nodes[1].description).toBe('Checks the new model matches.');
    expect(file.graph.nodes[0]).not.toHaveProperty('description');
    const r = parseExportFile(JSON.stringify(file), 'copy', T);
    if (!r.ok) throw new Error(r.error);
    expect(r.graph.nodes.map((n) => n.description)).toEqual([undefined, 'Checks the new model matches.']);
  });

  it('refuses files that are too big, not JSON, not ours, a newer version, or invalid graphs', () => {
    const good = toExportFile(sample(), T);
    const parse = (content: string) => parseExportFile(content, 'x', T);
    expect(parse('x'.repeat(MAX_IMPORT_CHARS + 1))).toEqual({ ok: false, error: 'The file is larger than 1 MB.' });
    expect(parse('{nope')).toEqual({ ok: false, error: 'The file is not valid JSON.' });
    expect(parse(JSON.stringify({ format: 'other' }))).toEqual({ ok: false, error: 'This is not an Agent Stream graph file.' });
    expect(parse(JSON.stringify({ ...good, version: 2 }))).toEqual({ ok: false, error: 'This file is version 2; this Agent Stream reads version 1.' });
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

describe('step access and workspace in export files', () => {
  it('carries access and workspace through export and import', () => {
    const r = applyOp(sample(), { type: 'updateNode', id: 'n2', patch: { access: 'read', workspace: 'wh_a' } }, 'user', T);
    if (!r.ok) throw new Error(r.error);
    const file = toExportFile(r.graph, T);
    expect(file.graph.nodes[1]).toMatchObject({ id: 'n2', access: 'read', workspace: 'wh_a' });
    expect(file.graph.nodes[0]).not.toHaveProperty('access');
    expect(file.graph.nodes[0]).not.toHaveProperty('workspace');
    const back = parseExportFile(JSON.stringify(file), 'copy', T);
    expect(back.ok && back.graph.nodes[1]).toMatchObject({ access: 'read', workspace: 'wh_a' });
  });

  it('keeps an arrow label through export and import', () => {
    let g = emptyGraph('g', 'G', T);
    const ops: Op[] = [
      { type: 'addNode', node: { title: 'Ready', kind: 'condition', prompt: 'Is it ready?' } },
      { type: 'addNode', node: { title: 'Ship', kind: 'command', command: 'ship' } },
      { type: 'connect', from: 'n1', to: 'n2', label: 'no' },
    ];
    for (const op of ops) {
      const r = applyOp(g, op, 'user', T);
      if (!r.ok) throw new Error(r.error);
      g = r.graph;
    }
    const file = toExportFile(g, T);
    expect(file.graph.edges).toEqual([{ from: 'n1', to: 'n2', label: 'no' }]);
    const back = parseExportFile(JSON.stringify(file), 'copy', T);
    expect(back.ok && back.graph.edges).toEqual([{ id: 'n1->n2', from: 'n1', to: 'n2', label: 'no' }]);
  });

  it('keeps fail-fast on a stop step through export and import', () => {
    const r = applyOp(emptyGraph('g', 'G', T), { type: 'addNode', node: { title: 'Halt', kind: 'stop', failFast: true } }, 'user', T);
    if (!r.ok) throw new Error(r.error);
    const file = toExportFile(r.graph, T);
    expect(file.graph.nodes[0].failFast).toBe(true);
    const back = parseExportFile(JSON.stringify(file), 'copy', T);
    expect(back.ok && back.graph.nodes[0].failFast).toBe(true);
  });
});
