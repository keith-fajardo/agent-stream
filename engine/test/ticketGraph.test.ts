import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isWriteCapable, parallelWriteSteps, parseExportFile, topoOrder, upstream, validateRunnable } from '@agent-stream/shared';
import { GraphStore } from '../src/graphStore';
import { projectPaths } from '../src/paths';
import { PARALLEL_POLICY, SERIALIZATION_GUIDANCE } from '../src/policy';
import { starterGraph, writeStarterGraph } from '../src/ticketGraph';
import { valuesFileFor, VariableValues } from '../src/variableValues';
import { leaseKey } from '../src/writeLease';

const T = '2026-10-03T00:00:00.000Z';
function parsed() {
  const r = parseExportFile(JSON.stringify(starterGraph('ABC-1 Fix login', T)), 'abc', T);
  if (!r.ok) throw new Error(r.error);
  return r.graph;
}

describe('starter ticket graph', () => {
  it('is a valid graph for the ticket, with a check_command variable', () => {
    const g = parsed();
    expect(g).toMatchObject({
      name: 'ABC-1 Fix login',
      goal: 'Complete ticket: ABC-1 Fix login',
      variables: [{ name: 'check_command', description: 'Full test suite and typecheck, e.g. npm test && npm run typecheck' }],
    });
    expect(validateRunnable(g)).toEqual([]);
    expect(g.nodes.map((n) => [n.id, n.title, n.kind, n.access ?? 'write'])).toEqual([
      ['n1', 'Read and research', 'agent', 'read'],
      ['n2', 'Implementation', 'agent', 'write'],
      ['n3', 'Focused tests', 'agent', 'write'],
      ['n4', 'Full test + typecheck', 'command', 'write'],
      ['n5', 'Review', 'agent', 'read'],
    ]);
    expect(g.nodes[3].command).toBe('{{ check_command | unquoted }}');
    for (const n of g.nodes) {
      expect(n.description?.trim()).toBeTruthy();
      expect((n.prompt ?? n.command ?? '').trim()).toBeTruthy();
    }
    expect(g.nodes.map((n) => n.position!.x)).toEqual([0, 280, 560, 840, 840]);
  });

  it('has exactly the edges of §5.2', () => {
    expect(parsed().edges.map((e) => `${e.from}->${e.to}`).sort()).toEqual(['n1->n2', 'n2->n3', 'n3->n4', 'n3->n5']);
  });

  it('never has two write-capable steps in one layer, and its widest layer is 2 steps', () => {
    const g = parsed();
    expect(parallelWriteSteps(g)).toEqual([]);
    const depth = new Map<string, number>();
    for (const id of topoOrder(g)) depth.set(id, Math.max(0, ...upstream(g, id).map((p) => depth.get(p)! + 1)));
    const layers = new Map<number, string[]>();
    for (const n of g.nodes) layers.set(depth.get(n.id)!, [...(layers.get(depth.get(n.id)!) ?? []), n.id]);
    for (const ids of layers.values()) expect(ids.filter((id) => isWriteCapable(g.nodes.find((n) => n.id === id)!)).length).toBeLessThanOrEqual(1);
    expect(Math.max(...[...layers.values()].map((ids) => ids.length))).toBe(2);
  });

  it('carries the policy, the worktree line and the serialization guidance in its instructions', () => {
    const { instructions } = parsed();
    expect(instructions).toContain(PARALLEL_POLICY);
    expect(instructions).toContain("This worktree is the only checkout this ticket's agents change.");
    expect(instructions).toContain(SERIALIZATION_GUIDANCE);
  });

  it('keeps two ticket worktrees apart: their own values file and lease key, and nothing copied', () => {
    const parent = realpathSync(mkdtempSync(join(tmpdir(), 'agent-stream-tickets-')));
    const home = mkdtempSync(join(tmpdir(), 'agent-stream-home-'));
    const a = join(parent, 'app-abc-1');
    const b = join(parent, 'app-abc-2');
    mkdirSync(a);
    mkdirSync(b);
    const ga = writeStarterGraph({ worktreePath: a, ticket: 'ABC-1', checkCommand: 'npm test', home });
    const gb = writeStarterGraph({ worktreePath: b, ticket: 'ABC-2', checkCommand: '  ', home });
    expect(valuesFileFor(a, home)).not.toBe(valuesFileFor(b, home));
    expect(leaseKey(a)).not.toBe(leaseKey(b));
    expect(new VariableValues(valuesFileFor(a, home)).get(ga.graphId)).toEqual({ check_command: 'npm test' });
    expect(existsSync(valuesFileFor(b, home))).toBe(false);
    expect(readdirSync(join(a, '.agent-stream')).sort()).toEqual(['.gitignore', 'graphs', 'runs', 'sessions']);
    expect(readdirSync(join(a, '.agent-stream', 'graphs')).sort()).toEqual([`${ga.graphId}.md`, `${ga.graphId}.meta.json`]);
    expect(readdirSync(join(a, '.agent-stream', 'runs'))).toEqual([]);
    expect(readdirSync(join(a, '.agent-stream', 'sessions'))).toEqual([]);
    expect(new GraphStore(projectPaths(b)).get(gb.graphId).name).toBe('ABC-2');
  });
});
