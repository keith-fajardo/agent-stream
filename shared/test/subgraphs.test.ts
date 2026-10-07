import { describe, expect, it } from 'vitest';
import { topoOrder } from '../src/graph';
import {
  collectSubgraphs,
  derivedStatus,
  expandGraph,
  folderId,
  groupedOrder,
  lookupFromEntries,
  scopeOf,
  subgraphFirstSteps,
  wouldCreateGraphLoop,
  type GraphLookup,
  type SubgraphEntry,
} from '../src/subgraphs';
import type { Graph, NodeRunState, Op } from '../src/types';
import { build } from './graphFixtures';

const agent = (title: string, over: object = {}): Op => ({ type: 'addNode', node: { title, kind: 'agent', prompt: `Do ${title}.`, ...over } });
const sub = (title: string, graph: string, values?: Record<string, string>): Op => ({ type: 'addNode', node: { title, kind: 'graph', graph, ...(values && { values }) } });
const link = (from: string, to: string): Op => ({ type: 'connect', from, to });
const graph = (id: string, name: string, ops: Op[]): Graph => ({ ...build(name, ops), id });

/** Company research: two first steps (n1, n2) feeding one last step (n3), which works in workspace wh_a. */
const research = graph('company-research', 'Company research', [
  { type: 'addVariable', name: 'company' },
  { type: 'setGraphAttachments', names: ['brief.md'] },
  agent('Find site'),
  agent('Read news'),
  agent('Summarize', { workspace: 'wh_a' }),
  link('n1', 'n3'),
  link('n2', 'n3'),
]);
/** One first step and two last steps. */
const fork = graph('fork', 'Fork', [agent('Start'), agent('Left'), agent('Right'), link('n1', 'n2'), link('n1', 'n3')]);
/** Job hunting: n1 and n2 feed sub-graph step n3 (Company research), which feeds n4. */
const hunting = graph('job-hunting', 'Job hunting', [agent('Plan'), agent('Prep'), sub('Research the target company', 'company-research', { company: '{{ target_company }}' }), agent('Letter'), link('n1', 'n3'), link('n2', 'n3'), link('n3', 'n4')]);

function lookupOf(...graphs: Graph[]): GraphLookup {
  return (id) => {
    const g = graphs.find((x) => x.id === id);
    return g ? { ok: true, graph: g } : { ok: false, reason: 'missing', error: `graph "${id}" not found` };
  };
}
const edgesOf = (g: Graph) => g.edges.map((e) => e.id).sort();
function expanded(outer: Graph, ...graphs: Graph[]) {
  const r = expandGraph(outer, lookupOf(...graphs));
  if (!r.ok) throw new Error(JSON.stringify(r.problems));
  return r;
}

describe('expandGraph', () => {
  it('leaves a graph without sub-graph steps as it is', () => {
    const r = expanded(research);
    expect(r.graph).toEqual(research);
    expect(r.scopes).toEqual({});
  });

  it('copies the inner steps under prefixed ids, keeps the sub-graph step, and keeps the outer graph itself', () => {
    const r = expanded(hunting, research);
    expect(r.graph.nodes.map((n) => n.id)).toEqual(['n1', 'n2', 'n3', 'n4', 'n3/n1', 'n3/n2', 'n3/n3']);
    expect(r.graph.nodes.find((n) => n.id === 'n3')).toEqual(hunting.nodes[2]);
    expect(r.graph.nodes.find((n) => n.id === 'n3/n1')).toMatchObject({ title: 'Find site', kind: 'agent', prompt: 'Do Find site.' });
    expect(r.graph).toMatchObject({ id: 'job-hunting', name: 'Job hunting', goal: hunting.goal, variables: hunting.variables, nodeSeq: hunting.nodeSeq });
    expect(r.graphs).toEqual({ 'company-research': research });
    expect(r.scopes).toEqual({ n3: { stepId: 'n3', graphId: 'company-research', graphName: 'Company research', depth: 1, values: { company: '{{ target_company }}' }, attachments: ['brief.md'] } });
  });

  it('rewires: every step that fed the sub-graph step feeds every inner first step, and the last steps feed it (Review Focus 5)', () => {
    const r = expanded(hunting, research);
    expect(edgesOf(r.graph)).toEqual(['n1->n3/n1', 'n1->n3/n2', 'n2->n3/n1', 'n2->n3/n2', 'n3->n4', 'n3/n1->n3/n3', 'n3/n2->n3/n3', 'n3/n3->n3'].sort());
    expect(topoOrder(r.graph)).toHaveLength(r.graph.nodes.length);
  });

  it('collects several last steps', () => {
    const outer = graph('o', 'O', [agent('A'), sub('Fork it', 'fork'), link('n1', 'n2')]);
    expect(edgesOf(expanded(outer, fork).graph)).toEqual(['n1->n2/n1', 'n2/n1->n2/n2', 'n2/n1->n2/n3', 'n2/n2->n2', 'n2/n3->n2'].sort());
  });

  it('two uses of the same inner graph get their own ids, scopes, values and workspaces', () => {
    const outer = graph('o', 'O', [sub('Research A', 'company-research', { company: 'Acme' }), sub('Research B', 'company-research', { company: 'Initech' }), agent('Compare'), link('n1', 'n3'), link('n2', 'n3')]);
    const r = expanded(outer, research);
    expect(r.graph.nodes.map((n) => n.id)).toEqual(['n1', 'n2', 'n3', 'n1/n1', 'n1/n2', 'n1/n3', 'n2/n1', 'n2/n2', 'n2/n3']);
    expect(r.scopes.n1.values).toEqual({ company: 'Acme' });
    expect(r.scopes.n2.values).toEqual({ company: 'Initech' });
    expect(r.graph.nodes.find((n) => n.id === 'n1/n3')?.workspace).toBe('n1~wh_a');
    expect(r.graph.nodes.find((n) => n.id === 'n2/n3')?.workspace).toBe('n2~wh_a');
  });

  it('expands nested sub-graphs inside out, to depth 3, with scoped workspaces at every level', () => {
    const level3 = graph('level-3', 'Level 3', [sub('Research', 'company-research')]);
    const level2 = graph('level-2', 'Level 2', [agent('Before'), sub('Deeper', 'level-3'), link('n1', 'n2')]);
    const outer = graph('o', 'O', [sub('Go', 'level-2')]);
    const r = expanded(outer, level2, level3, research);
    expect(Object.values(r.scopes).map((s) => [s.stepId, s.depth])).toEqual([
      ['n1', 1],
      ['n1/n2', 2],
      ['n1/n2/n1', 3],
    ]);
    expect(r.graph.nodes.find((n) => n.id === 'n1/n2/n1/n3')?.workspace).toBe('n1~n2~n1~wh_a');
    expect(edgesOf(r.graph)).toContain('n1/n1->n1/n2/n1/n1');
    expect(edgesOf(r.graph)).toContain('n1/n2/n1->n1/n2');
    expect(edgesOf(r.graph)).toContain('n1/n2->n1');
    const deeper = graph('level-4', 'Level 4', [sub('Too deep', 'level-3')]);
    expect(expandGraph(graph('o', 'O', [sub('Go', 'level-4')]), lookupOf(deeper, level3, research))).toEqual({ ok: true, graph: expect.anything(), scopes: expect.anything(), graphs: expect.anything() });
    const four = graph('o', 'O', [sub('Go', 'level-2b')]);
    const level2b = graph('level-2b', 'Level 2b', [sub('Deeper', 'level-4')]);
    expect(expandGraph(four, lookupOf(level2b, deeper, level3, research))).toEqual({ ok: false, problems: [{ stepId: 'n1/n1/n1/n1', message: 'Step n1/n1/n1/n1 nests sub-graphs more than 3 levels deep.' }] });
  });

  it('expands an inner graph whose only step is itself a sub-graph step (Review Focus 3)', () => {
    const wrapper = graph('wrapper', 'Wrapper', [sub('Only', 'company-research')]);
    const outer = graph('o', 'O', [agent('Before'), sub('Wrapped', 'wrapper'), agent('After'), link('n1', 'n2'), link('n2', 'n3')]);
    const r = expanded(outer, wrapper, research);
    expect(edgesOf(r.graph)).toEqual(['n1->n2/n1/n1', 'n1->n2/n1/n2', 'n2->n3', 'n2/n1->n2', 'n2/n1/n1->n2/n1/n3', 'n2/n1/n2->n2/n1/n3', 'n2/n1/n3->n2/n1'].sort());
    expect(subgraphFirstSteps(r.graph, 'n2').sort()).toEqual(['n2/n1/n1', 'n2/n1/n2']);
    expect(topoOrder(r.graph)).toHaveLength(r.graph.nodes.length);
  });

  it('refuses direct and indirect loops, naming the path', () => {
    const self = graph('job-hunting', 'Job hunting', [sub('Me again', 'job-hunting')]);
    expect(expandGraph(self, lookupOf(self))).toEqual({ ok: false, problems: [{ stepId: 'n1', message: 'Step n1 would put "Job hunting" inside itself (Job hunting › Job hunting).' }] });
    const back = graph('company-research', 'Company research', [agent('Find site'), sub('Hunt', 'job-hunting')]);
    expect(expandGraph(hunting, lookupOf(hunting, back))).toEqual({
      ok: false,
      problems: [{ stepId: 'n3/n2', message: 'Step n3/n2 would put "Job hunting" inside itself (Job hunting › Company research › Job hunting).' }],
    });
  });

  it('reports missing, broken and empty inner graphs, every one of them', () => {
    const outer = graph('o', 'O', [sub('A', 'gone'), sub('B', 'bad'), sub('C', 'empty'), sub('D', 'company-research')]);
    const lookup: GraphLookup = (id) =>
      id === 'bad' ? { ok: false, reason: 'broken', error: 'line 3: kind is "robot"; use agent or command.', name: 'Bad graph' } : lookupOf(graph('empty', 'Empty', []), research)(id);
    expect(expandGraph(outer, lookup)).toEqual({
      ok: false,
      problems: [
        { stepId: 'n1', message: 'Step n1 uses graph "gone", which isn\'t in this folder.' },
        { stepId: 'n2', message: 'Step n2 uses graph "Bad graph", whose file has errors: line 3: kind is "robot"; use agent or command.' },
        { stepId: 'n3', message: 'Step n3 uses graph "Empty", which has no steps.' },
      ],
    });
  });

  it('refuses more than 500 steps in all', () => {
    const big = graph('big', 'Big', Array.from({ length: 300 }, (_, i) => agent(`S${i}`)));
    const outer = graph('o', 'O', [sub('One', 'big'), sub('Two', 'big')]);
    expect(expandGraph(outer, lookupOf(big))).toEqual({ ok: false, problems: [{ stepId: '', message: 'This graph expands to more than 500 steps.' }] });
    expect(expandGraph(graph('o', 'O', [sub('One', 'big')]), lookupOf(big)).ok).toBe(true);
  });

  it('is deterministic: the same graphs give the same expansion', () => {
    expect(expanded(hunting, research)).toEqual(expanded(JSON.parse(JSON.stringify(hunting)) as Graph, JSON.parse(JSON.stringify(research)) as Graph));
  });
});

describe('scopes and ids', () => {
  const level2 = graph('level-2', 'Level 2', [agent('Before'), sub('Research', 'company-research'), link('n1', 'n2')]);
  const r = expanded(graph('o', 'O', [sub('Go', 'level-2')]), level2, research);

  it('scopeOf finds the deepest sub-graph a step is inside; a sub-graph step belongs to the graph around it', () => {
    expect(scopeOf(r.scopes, 'n1/n2/n3')?.stepId).toBe('n1/n2');
    expect(scopeOf(r.scopes, 'n1/n1')?.stepId).toBe('n1');
    expect(scopeOf(r.scopes, 'n1/n2')?.stepId).toBe('n1');
    expect(scopeOf(r.scopes, 'n1')).toBeUndefined();
    expect(folderId('n1/n2/n3')).toBe('n1~n2~n3');
  });

  it('groupedOrder puts each sub-graph step right before its inner steps', () => {
    expect(groupedOrder(r.graph)).toEqual(['n1', 'n1/n1', 'n1/n2', 'n1/n2/n1', 'n1/n2/n2', 'n1/n2/n3']);
    expect(groupedOrder(expanded(hunting, research).graph)).toEqual(['n1', 'n2', 'n3', 'n3/n1', 'n3/n2', 'n3/n3', 'n4']);
  });
});

describe('wouldCreateGraphLoop', () => {
  it('is true for the graph itself and for any graph that uses it, at any depth', () => {
    const middle = graph('middle', 'Middle', [sub('Hunt', 'job-hunting')]);
    const top = graph('top', 'Top', [sub('Mid', 'middle')]);
    const lookup = lookupOf(hunting, research, middle, top);
    expect(wouldCreateGraphLoop('job-hunting', 'job-hunting', lookup)).toBe(true);
    expect(wouldCreateGraphLoop('job-hunting', 'middle', lookup)).toBe(true);
    expect(wouldCreateGraphLoop('job-hunting', 'top', lookup)).toBe(true);
    expect(wouldCreateGraphLoop('job-hunting', 'company-research', lookup)).toBe(false);
    expect(wouldCreateGraphLoop('job-hunting', 'gone', lookup)).toBe(false);
  });

  it('stops on a loop that does not involve the outer graph', () => {
    const a = graph('a', 'A', [sub('B', 'b')]);
    const b = graph('b', 'B', [sub('A', 'a')]);
    expect(wouldCreateGraphLoop('job-hunting', 'a', lookupOf(a, b))).toBe(false);
  });
});

describe('collectSubgraphs and lookupFromEntries', () => {
  it('collects every graph reachable through sub-graph steps, with why one cannot be used, and looks them up again', () => {
    const wrapper = graph('wrapper', 'Wrapper', [sub('R', 'company-research'), sub('Gone', 'gone')]);
    const outer = graph('o', 'O', [sub('W', 'wrapper'), sub('Self', 'o')]);
    const entries = collectSubgraphs(outer, lookupOf(wrapper, research));
    expect(Object.keys(entries).sort()).toEqual(['company-research', 'gone', 'wrapper']);
    expect(entries.gone).toEqual({ error: 'graph "gone" not found', reason: 'missing' });
    const again = lookupFromEntries(entries);
    expect(again('wrapper')).toEqual({ ok: true, graph: wrapper });
    expect(again('gone')).toEqual({ ok: false, reason: 'missing', error: 'graph "gone" not found' });
    expect(again('other')).toEqual({ ok: false, reason: 'missing', error: 'graph "other" not found' });
    const broken: Record<string, SubgraphEntry> = { bad: { error: 'line 2: x', reason: 'broken', name: 'Bad' } };
    expect(lookupFromEntries(broken)('bad')).toEqual({ ok: false, reason: 'broken', error: 'line 2: x', name: 'Bad' });
    // The tab's own graph is found too, so a loop back to it is reported as a loop, not as missing.
    expect(lookupFromEntries(entries, outer)('o')).toEqual({ ok: true, graph: outer });
  });
});

describe('derivedStatus', () => {
  const run = (nodes: Record<string, NodeRunState>) => ({ nodes });
  const ok: NodeRunState = { status: 'succeeded' };

  it('applies the rules in order: approval, running, failed, interrupted, stopped', () => {
    expect(derivedStatus(run({ n4: { status: 'queued' }, 'n4/n1': { status: 'waiting_approval' }, 'n4/n2': { status: 'failed' } }), 'n4')?.status).toBe('waiting_approval');
    expect(derivedStatus(run({ n4: { status: 'queued' }, 'n4/n1': { status: 'running' }, 'n4/n2': { status: 'failed' } }), 'n4')?.status).toBe('running');
    expect(derivedStatus(run({ n4: { status: 'not_run' }, 'n4/n1': { status: 'failed' }, 'n4/n2': { status: 'interrupted' } }), 'n4')?.status).toBe('failed');
    expect(derivedStatus(run({ n4: { status: 'not_run' }, 'n4/n1': { status: 'interrupted' }, 'n4/n2': { status: 'cancelled' } }), 'n4')?.status).toBe('interrupted');
    expect(derivedStatus(run({ n4: { status: 'cancelled' }, 'n4/n1': { status: 'cancelled' }, 'n4/n2': ok }), 'n4')?.status).toBe('cancelled');
  });

  it('is succeeded when the step succeeded, stale when a step inside it is, reused when all were, else its own status', () => {
    expect(derivedStatus(run({ n4: ok, 'n4/n1': ok }), 'n4')).toEqual(ok);
    const mark = { reason: 'edited' as const, nodeId: 'n4/n1', runId: 'r2' };
    expect(derivedStatus(run({ n4: ok, 'n4/n1': { status: 'reused', stale: mark } }), 'n4')).toEqual({ status: 'succeeded', stale: mark });
    expect(derivedStatus(run({ n4: { status: 'reused' }, 'n4/n1': { status: 'reused' }, 'n4/n2/n1': { status: 'reused' } }), 'n4')?.status).toBe('reused');
    expect(derivedStatus(run({ n4: { status: 'queued' }, 'n4/n1': ok }), 'n4')?.status).toBe('queued');
    expect(derivedStatus(run({ n4: { status: 'not_run' } }), 'n4')?.status).toBe('not_run');
    expect(derivedStatus(run({ n1: ok }), 'n4')).toBeUndefined();
  });

  it('counts steps at any depth, and not a step whose id only starts the same', () => {
    expect(derivedStatus(run({ n4: { status: 'queued' }, 'n4/n2/n1': { status: 'waiting_approval' } }), 'n4')?.status).toBe('waiting_approval');
    expect(derivedStatus(run({ n4: ok, n40: { status: 'failed' } }), 'n4')?.status).toBe('succeeded');
  });
});
