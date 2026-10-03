import { describe, expect, it } from 'vitest';
import { GraphStore } from '../src/graphStore';
import { graphTools } from '../src/plannerTools';
import { RunStore } from '../src/runStore';
import { fixedClock, tmpProject } from './helpers';

function setup() {
  const paths = tmpProject();
  const graphStore = new GraphStore(paths, fixedClock());
  const runStore = new RunStore(paths);
  const graphId = graphStore.create('G').id;
  const runRequests: (string | undefined)[] = [];
  let runError: string | null = null;
  const tools = graphTools({
    graphStore,
    runStore,
    graphId,
    source: { kind: 'planner', sessionId: 's' },
    requestRun: (fromNodeId) => {
      runRequests.push(fromNodeId);
      return runError;
    },
  });
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const t = tools.find((x) => x.name === name);
    if (!t) throw new Error(`no tool ${name}`);
    const r = await t.run(args);
    return { text: r.text, isError: r.isError === true };
  };
  return { tools, graphStore, runStore, graphId, call, runRequests, failRuns: (e: string | null) => (runError = e) };
}

describe('planner graph tools', () => {
  it('exposes the documented tools', () => {
    expect(setup().tools.map((t) => t.name)).toEqual([
      'get_graph', 'add_node', 'update_node', 'delete_node', 'connect', 'disconnect', 'set_goal', 'set_instructions', 'set_variable', 'delete_variable', 'request_run', 'get_run',
    ]);
  });

  it('refuses input that misses a required field, without touching the graph', async () => {
    const s = setup();
    const r = await s.call('add_node', { title: 'No kind' });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('kind');
    expect(s.graphStore.get(s.graphId).nodes).toEqual([]);
    expect(s.graphStore.readOps(s.graphId)).toEqual([]);
  });

  it('describes the tools without naming a model vendor', () => {
    expect(setup().tools.find((t) => t.name === 'add_node')?.description).toContain('runs a separate AI agent');
    for (const t of setup().tools) expect(t.description).not.toMatch(/Claude|Anthropic/);
  });

  it('records every edit with the source the tools were built for', async () => {
    const s = setup();
    await s.call('add_node', { kind: 'command', title: 'Build', command: 'make' });
    await s.call('add_node', { kind: 'agent', title: 'Check', prompt: 'Check it.', after: ['n1'] });
    await s.call('update_node', { id: 'n1', command: 'make all' });
    const ops = s.graphStore.readOps(s.graphId);
    expect(ops).toHaveLength(4);
    for (const r of ops) expect(r).toMatchObject({ by: 'agent', source: { kind: 'planner', sessionId: 's' } });
    expect(s.graphStore.agentChanges(s.graphId).map((c) => c.by)).toEqual([
      { kind: 'planner', sessionId: 's' },
      { kind: 'planner', sessionId: 's' },
      { kind: 'planner', sessionId: 's' },
    ]);
  });

  it('adds agent-authored nodes and wires them after existing ones', async () => {
    const s = setup();
    expect(await s.call('add_node', { kind: 'command', title: 'Build', command: 'dbt build -s orders' })).toEqual({ text: 'Added n1.', isError: false });
    expect(await s.call('add_node', { kind: 'agent', title: 'Check', prompt: 'Check the build.', after: ['n1'] })).toEqual({ text: 'Added n2.', isError: false });
    const g = s.graphStore.get(s.graphId);
    expect(g.nodes.map((n) => [n.id, n.createdBy])).toEqual([['n1', 'agent'], ['n2', 'agent']]);
    expect(g.edges.map((e) => e.id)).toEqual(['n1->n2']);
    expect(s.graphStore.readOps(s.graphId).every((r) => r.by === 'agent')).toBe(true);
  });

  it('keeps the node but reports edges that could not be created', async () => {
    const s = setup();
    expect(await s.call('add_node', { kind: 'agent', title: 'Orphan', prompt: 'x', after: ['n9'] })).toEqual({
      text: 'Added n1, but some edges failed:\nnode n9 does not exist',
      isError: true,
    });
    expect(s.graphStore.get(s.graphId).nodes).toHaveLength(1);
  });

  it('updates, connects, disconnects, deletes and sets the goal', async () => {
    const s = setup();
    await s.call('add_node', { kind: 'agent', title: 'A', prompt: 'a' });
    await s.call('add_node', { kind: 'agent', title: 'B', prompt: 'b' });
    expect(await s.call('update_node', { id: 'n1', prompt: 'better' })).toEqual({ text: 'Updated n1.', isError: false });
    expect(await s.call('connect', { from: 'n1', to: 'n2' })).toEqual({ text: 'Connected n1 -> n2.', isError: false });
    expect(await s.call('connect', { from: 'n2', to: 'n1' })).toEqual({ text: 'connecting n2 -> n1 would create a cycle', isError: true });
    expect(await s.call('disconnect', { from: 'n1', to: 'n2' })).toEqual({ text: 'Disconnected n1 -> n2.', isError: false });
    expect(await s.call('set_goal', { goal: 'Prove parity' })).toEqual({ text: 'Goal updated.', isError: false });
    expect(await s.call('delete_node', { id: 'n2' })).toEqual({ text: 'Deleted n2.', isError: false });
    const g = s.graphStore.get(s.graphId);
    expect(g).toMatchObject({ goal: 'Prove parity', edges: [] });
    expect(g.nodes).toEqual([expect.objectContaining({ id: 'n1', prompt: 'better', updatedBy: 'agent' })]);
  });

  it('returns a compact view of the graph', async () => {
    const s = setup();
    await s.call('add_node', { kind: 'command', title: 'Build', command: 'dbt build' });
    await s.call('add_node', { kind: 'agent', title: 'Check', prompt: 'check', after: ['n1'] });
    expect(JSON.parse((await s.call('get_graph')).text)).toEqual({
      goal: '',
      instructions: '',
      variables: [],
      nodes: [
        { id: 'n1', title: 'Build', kind: 'command', command: 'dbt build', createdBy: 'agent', updatedBy: 'agent' },
        { id: 'n2', title: 'Check', kind: 'agent', prompt: 'check', createdBy: 'agent', updatedBy: 'agent' },
      ],
      edges: ['n1 -> n2'],
    });
  });

  it('stores a description from add_node, changes only it with update_node, and shows it in get_graph', async () => {
    const s = setup();
    await s.call('add_node', { kind: 'agent', title: 'Check', prompt: 'check', description: 'Checks the build.' });
    expect(s.graphStore.get(s.graphId).nodes[0].description).toBe('Checks the build.');
    expect(await s.call('update_node', { id: 'n1', description: 'Checks the new model matches.' })).toEqual({ text: 'Updated n1.', isError: false });
    expect(s.graphStore.get(s.graphId).nodes[0]).toMatchObject({ title: 'Check', prompt: 'check', description: 'Checks the new model matches.' });
    const text = (await s.call('get_graph')).text;
    expect(text).toContain('"description"');
    expect(JSON.parse(text).nodes[0].description).toBe('Checks the new model matches.');
    expect(s.tools.find((t) => t.name === 'add_node')?.description).toContain('`description` is one plain-language sentence for people saying what the step does and why.');
  });

  it('refuses a description over 2000 characters from add_node and update_node, without storing it', async () => {
    const s = setup();
    const long = 'x'.repeat(2001);
    const added = await s.call('add_node', { kind: 'agent', title: 'A', prompt: 'a', description: long });
    expect(added.isError).toBe(true);
    expect(s.graphStore.get(s.graphId).nodes).toEqual([]);
    await s.call('add_node', { kind: 'agent', title: 'A', prompt: 'a' });
    const updated = await s.call('update_node', { id: 'n1', description: long });
    expect(updated.isError).toBe(true);
    expect(s.graphStore.get(s.graphId).nodes[0].description).toBeUndefined();
  });

  it('asks the user to start runs instead of starting them', async () => {
    const s = setup();
    expect((await s.call('request_run', { fromNodeId: 'n1' })).isError).toBe(false);
    expect(s.runRequests).toEqual(['n1']);
    s.failRuns("The graph can't run yet");
    expect(await s.call('request_run')).toEqual({ text: "The graph can't run yet", isError: true });
  });

  it('summarises the latest run for debugging', async () => {
    const s = setup();
    expect(await s.call('get_run')).toEqual({ text: 'No runs yet.', isError: false });
    await s.call('add_node', { kind: 'command', title: 'Build', command: 'dbt build' });
    const id = '20261002-100000-aaaa';
    s.runStore.create({
      id,
      graphId: s.graphId,
      status: 'failed',
      startedAt: 't',
      snapshot: s.graphStore.get(s.graphId),
      nodes: { n1: { status: 'failed', error: 'exited with code 2' } },
    });
    s.runStore.writeOutput(id, 'n1', 'Compilation Error in model orders');
    const { text } = await s.call('get_run');
    expect(text).toContain(`Run ${id}: failed`);
    expect(text).toContain('## n1 · Build — failed');
    expect(text).toContain('error: exited with code 2');
    expect(text).toContain('Compilation Error in model orders');
    expect(await s.call('get_run', { runId: '20990101-000000-ffff' })).toEqual({ text: 'Run 20990101-000000-ffff not found.', isError: true });
  });

  it('sets the instructions as the agent and shows them in get_graph', async () => {
    const s = setup();
    expect(await s.call('set_instructions', { instructions: 'Use target dev.' })).toEqual({ text: 'Instructions updated.', isError: false });
    expect(s.graphStore.get(s.graphId).instructions).toBe('Use target dev.');
    expect(JSON.parse((await s.call('get_graph')).text).instructions).toBe('Use target dev.');
    expect(s.graphStore.readOps(s.graphId).at(-1)).toMatchObject({ by: 'agent', op: { type: 'setInstructions' } });
  });

  it('defines, describes and deletes variables, and get_graph lists names and descriptions only', async () => {
    const s = setup();
    expect(await s.call('set_variable', { name: 'schema', description: 'Target schema' })).toEqual({
      text: 'Added variable schema. Ask the user to set its value (Variables menu).',
      isError: false,
    });
    expect(await s.call('set_variable', { name: 'schema', description: 'Where to build' })).toEqual({ text: 'Updated variable schema.', isError: false });
    expect(JSON.parse((await s.call('get_graph')).text).variables).toEqual([{ name: 'schema', description: 'Where to build' }]);
    expect((await s.call('set_variable', { name: 'env_var' })).isError).toBe(true);
    expect(await s.call('delete_variable', { name: 'schema' })).toEqual({ text: 'Deleted variable schema.', isError: false });
    expect(s.graphStore.get(s.graphId).variables).toEqual([]);
  });
});
