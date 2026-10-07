import { describe, expect, it } from 'vitest';
import { applyOp, onlyRunPlan, reusableNodeIds, type RunSource } from '../src/graph';
import { expandGraph, type GraphLookup } from '../src/subgraphs';
import type { Graph, NodeRunState, Op, RunAttachment } from '../src/types';
import { build, T0 } from './graphFixtures';

const agent = (title: string, over: object = {}): Op => ({ type: 'addNode', node: { title, kind: 'agent', prompt: `Do ${title}.`, ...over } });
const link = (from: string, to: string): Op => ({ type: 'connect', from, to });
const graph = (id: string, name: string, ops: Op[]): Graph => ({ ...build(name, ops), id });
function edit(g: Graph, op: Op): Graph {
  const r = applyOp(g, op, 'user', T0);
  if (!r.ok) throw new Error(r.error);
  return r.graph;
}

/** Company research: n1, n2 → n3. */
const research = graph('company-research', 'Company research', [agent('Find site'), agent('Read news'), agent('Summarize'), link('n1', 'n3'), link('n2', 'n3')]);
/** Job hunting: n1 → n2 (sub-graph, Company research) → n3. */
const hunting = graph('job-hunting', 'Job hunting', [agent('Plan'), { type: 'addNode', node: { title: 'Research', kind: 'graph', graph: 'company-research', values: { company: 'Acme' } } }, agent('Letter'), link('n1', 'n2'), link('n2', 'n3')]);

function expand(outer: Graph, ...inner: Graph[]) {
  const lookup: GraphLookup = (id) => {
    const g = inner.find((x) => x.id === id);
    return g ? { ok: true, graph: g } : { ok: false, reason: 'missing', error: 'missing' };
  };
  const r = expandGraph(outer, lookup);
  if (!r.ok) throw new Error(JSON.stringify(r.problems));
  return r;
}
const done = (g: Graph, status: NodeRunState['status'] = 'succeeded') => Object.fromEntries(g.nodes.map((n) => [n.id, { status }])) as Record<string, NodeRunState>;
const sorted = (s: Set<string>) => [...s].sort();
const all = expand(hunting, research);
const source: RunSource = { snapshot: all.graph, nodes: done(all.graph), scopes: all.scopes };

describe('reuse on expanded graphs', () => {
  it('reuses everything when nothing changed', () => {
    expect(sorted(reusableNodeIds(all.graph, source, undefined, undefined, undefined, all.scopes))).toEqual(sorted(new Set(all.graph.nodes.map((n) => n.id))));
  });

  it('an edit inside the inner graph re-runs that step, the inner steps after it, the sub-graph step and the steps after it', () => {
    const now = expand(hunting, edit(research, { type: 'updateNode', id: 'n1', patch: { prompt: 'Find the careers page.' } }));
    expect(sorted(reusableNodeIds(now.graph, source, undefined, undefined, undefined, now.scopes))).toEqual(['n1', 'n2/n2']);
  });

  it('a source run from before sub-graphs has no inner steps, so they all count as changed', () => {
    const before: RunSource = { snapshot: hunting, nodes: done(hunting) };
    expect(sorted(reusableNodeIds(all.graph, before, undefined, undefined, undefined, all.scopes))).toEqual(['n1']);
  });

  it('a retry after the inner graph gained or lost a step re-runs what that touches (Review Focus 4)', () => {
    const gained = expand(hunting, edit(edit(research, agent('Check facts')), link('n3', 'n4')));
    expect(gained.graph.nodes.map((n) => n.id)).toContain('n2/n4');
    expect(sorted(reusableNodeIds(gained.graph, source, undefined, undefined, undefined, gained.scopes))).toEqual(['n1', 'n2/n1', 'n2/n2', 'n2/n3']);
    const lost = expand(hunting, edit(research, { type: 'deleteNode', id: 'n2' }));
    expect(sorted(reusableNodeIds(lost.graph, source, undefined, undefined, undefined, lost.scopes))).toEqual(['n1', 'n2/n1']);
    // A failed inner step in the source run is retried with everything after it.
    const failed: RunSource = { ...source, nodes: { ...source.nodes, 'n2/n2': { status: 'failed' }, n2: { status: 'not_run' }, n3: { status: 'not_run' } } };
    expect(sorted(reusableNodeIds(all.graph, failed, undefined, undefined, undefined, all.scopes))).toEqual(['n1', 'n2/n1']);
  });

  it('another graph or other values on the sub-graph step re-run it and the steps after it', () => {
    const revalued = expand(edit(hunting, { type: 'updateNode', id: 'n2', patch: { values: { company: 'Initech' } } }), research);
    expect(sorted(reusableNodeIds(revalued.graph, source, undefined, undefined, undefined, revalued.scopes))).toEqual(['n1', 'n2/n1', 'n2/n2', 'n2/n3']);
    const other = { ...research, id: 'research-copy', name: 'Copy' };
    const moved = expand(edit(hunting, { type: 'updateNode', id: 'n2', patch: { graph: 'research-copy' } }), other);
    expect(sorted(reusableNodeIds(moved.graph, source, undefined, undefined, undefined, moved.scopes))).toEqual(['n1']);
  });

  it('compares an inner step’s attachments against its scope graph, not the outer graph', () => {
    const withFiles = expand({ ...hunting, attachments: ['outer.md'] }, { ...research, attachments: ['brief.md'] });
    const files: RunAttachment[] = [{ name: 'outer.md', sha256: 'o1' }, { name: 'brief.md', sha256: 'b1', graphId: 'company-research' }];
    const src: RunSource = { snapshot: withFiles.graph, nodes: done(withFiles.graph), scopes: withFiles.scopes, attachments: files };
    const reuse = (atts: RunAttachment[], g = withFiles) => sorted(reusableNodeIds(g.graph, src, undefined, undefined, atts, g.scopes));
    expect(reuse(files)).toHaveLength(6);
    // The inner graph's file changed: its agent steps re-run; the outer step before the sub-graph doesn't.
    expect(reuse([files[0], { ...files[1], sha256: 'b2' }])).toEqual(['n1']);
    // A file of the same name in the outer graph's folder is another file.
    expect(reuse([files[0], files[1], { name: 'brief.md', sha256: 'zz' }])).toHaveLength(6);
    // The inner graph's list changed.
    const relisted = expand({ ...hunting, attachments: ['outer.md'] }, { ...research, attachments: ['brief.md', 'more.md'] });
    expect(reuse(files, relisted)).toEqual(['n1']);
  });
});

describe('Re-run from and Run only a sub-graph step', () => {
  it('Re-run from it starts at its inner first steps and runs it all', () => {
    expect(sorted(reusableNodeIds(all.graph, source, 'n2', undefined, undefined, all.scopes))).toEqual(['n1']);
    expect(sorted(reusableNodeIds(all.graph, source, 'n2/n2', undefined, undefined, all.scopes))).toEqual(['n1', 'n2/n1']);
  });

  it('Run only it runs it and every step inside it, keeps the steps after it as stale, and needs the steps that fed it', () => {
    const plan = onlyRunPlan(all.graph, source, 'n2', undefined, undefined, all.scopes);
    if (!plan.ok) throw new Error(plan.error);
    expect(sorted(plan.reuse)).toEqual(['n1', 'n3']);
    expect(plan.stale).toEqual(new Map([['n3', { reason: 'upstream', nodeId: 'n2' }]]));
    expect(plan.notRun).toEqual(new Set());
    const fedBadly: RunSource = { ...source, nodes: { ...source.nodes, n1: { status: 'failed' } } };
    expect(onlyRunPlan(all.graph, fedBadly, 'n2', undefined, undefined, all.scopes)).toEqual({ ok: false, error: 'Run only n2 needs n1 to have a current result: run it first.' });
  });

  it('Run only an inner step uses its expanded id like any other step', () => {
    const plan = onlyRunPlan(all.graph, source, 'n2/n1', undefined, undefined, all.scopes);
    if (!plan.ok) throw new Error(plan.error);
    expect(sorted(plan.reuse)).toEqual(['n1', 'n2', 'n2/n2', 'n2/n3', 'n3']);
    expect([...plan.stale.keys()].sort()).toEqual(['n2', 'n2/n3', 'n3']);
  });
});
