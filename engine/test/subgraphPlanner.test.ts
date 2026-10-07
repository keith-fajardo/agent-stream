import { describe, expect, it } from 'vitest';
import { expandGraph } from '@agent-stream/shared';
import { GraphStore } from '../src/graphStore';
import { PLANNER_APPEND } from '../src/planner';
import { graphTools } from '../src/plannerTools';
import { RunStore } from '../src/runStore';
import { fixedClock, outsideGit, tmpProject } from './helpers';

function setup() {
  const paths = tmpProject();
  const graphStore = new GraphStore(paths, fixedClock());
  const runStore = new RunStore(paths);
  const research = graphStore.create('Company research').id;
  graphStore.apply(research, { type: 'setGoal', goal: 'Know the company.' }, 'user');
  graphStore.apply(research, { type: 'addVariable', name: 'company', description: 'Who to research' }, 'user');
  graphStore.apply(research, { type: 'addNode', node: { title: 'Find site', kind: 'agent', prompt: 'find' } }, 'user');
  const graphId = graphStore.create('Job hunting').id;
  const tools = graphTools({ graphStore, runStore, graphId, source: { kind: 'planner', sessionId: 's' }, checkout: outsideGit(paths.root), requestRun: () => null });
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await tools.find((t) => t.name === name)!.run(args);
    return { text: r.text, isError: r.isError === true };
  };
  return { graphStore, runStore, graphId, research, call };
}

describe('the planner and sub-graphs (spec §7)', () => {
  it('list_graphs lists the other graphs with their variables and step counts, and says which would make a loop', async () => {
    const s = setup();
    const user = s.graphStore.create('Uses job hunting').id;
    s.graphStore.apply(user, { type: 'addNode', node: { title: 'Hunt', kind: 'graph', graph: s.graphId } }, 'user');
    const listed = JSON.parse((await s.call('list_graphs')).text) as { id: string; loop: boolean; steps: number; variables: unknown[]; goal: string }[];
    expect(listed.map((g) => g.id).sort()).toEqual([s.research, user].sort());
    expect(listed.find((g) => g.id === s.research)).toEqual({ id: s.research, name: 'Company research', goal: 'Know the company.', variables: [{ name: 'company', description: 'Who to research' }], steps: 1, loop: false });
    expect(listed.find((g) => g.id === user)?.loop).toBe(true);
  });

  it('add_node and update_node make and change a sub-graph step; get_graph shows its graph, name and values', async () => {
    const s = setup();
    expect(await s.call('add_node', { kind: 'graph', title: 'Research', graph: s.research, values: { company: '{{ target_company }}' } })).toEqual({ text: 'Added n1.', isError: false });
    expect(await s.call('update_node', { id: 'n1', values: { company: 'Acme' } })).toEqual({ text: 'Updated n1.', isError: false });
    const graph = JSON.parse((await s.call('get_graph')).text) as { nodes: Record<string, unknown>[] };
    expect(graph.nodes[0]).toMatchObject({ id: 'n1', kind: 'graph', graph: s.research, graphName: 'Company research', values: { company: 'Acme' } });
    expect((await s.call('add_node', { kind: 'graph', title: 'Bad', graph: s.research, prompt: 'p' })).isError).toBe(true);
  });

  it('get_run lists the steps inside a sub-graph, indented under it', async () => {
    const s = setup();
    s.graphStore.apply(s.graphId, { type: 'addNode', node: { title: 'Research', kind: 'graph', graph: s.research } }, 'user');
    const r = expandGraph(s.graphStore.get(s.graphId), (id) => s.graphStore.lookup(id));
    if (!r.ok) throw new Error('expected an expansion');
    const runId = '20261007-100000-abcd';
    s.runStore.create({ id: runId, graphId: s.graphId, status: 'failed', startedAt: 't', snapshot: r.graph, scopes: r.scopes, nodes: { n1: { status: 'not_run' }, 'n1/n1': { status: 'failed', error: 'boom' } } });
    const text = (await s.call('get_run')).text;
    expect(text).toContain('\n## n1 · Research (sub-graph "Company research") — failed\n\n  ## n1/n1 · Find site — failed\nerror: boom');
  });

  it('tells the planner to look for a graph that already does the work, and that it cannot edit inner graphs', () => {
    expect(PLANNER_APPEND).toContain('call list_graphs and use a sub-graph step');
    expect(PLANNER_APPEND).toContain("You can't edit the graphs it uses from this chat.");
  });
});
