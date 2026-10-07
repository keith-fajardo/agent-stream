import { describe, expect, it } from 'vitest';
import { GraphStore } from '../src/graphStore';
import type { CheckoutInfo } from '@agent-stream/shared';
import { ALL_HAVE_WORKTREES_ADVICE } from '../src/policy';
import { graphTools, type CheckoutSource } from '../src/plannerTools';
import { RunStore } from '../src/runStore';
import { fixedClock, outsideGit, tmpProject } from './helpers';

function setup(checkout?: CheckoutSource) {
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
    checkout: checkout ?? outsideGit(paths.root),
    requestRun: (fromNodeId, mode) => {
      runRequests.push(mode ? `${mode}:${fromNodeId ?? ''}` : fromNodeId);
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
      'get_graph', 'list_models', 'add_node', 'update_node', 'delete_node', 'connect', 'disconnect', 'set_goal', 'set_instructions', 'set_variable', 'delete_variable', 'request_run', 'get_run', 'checkout_info', 'check_tickets', 'list_graphs',
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
    expect((await s.call('request_run', { mode: 'resume' })).isError).toBe(false);
    expect((await s.call('request_run', { mode: 'only', fromNodeId: 'n2' })).isError).toBe(false);
    expect(s.runRequests).toEqual(['n1', 'resume:', 'only:n2']);
    expect((await s.call('request_run', { mode: 'again' })).isError).toBe(true);
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

  it('shows which steps of a run are stale, and why', async () => {
    const s = setup();
    await s.call('add_node', { kind: 'command', title: 'Build', command: 'dbt build' });
    await s.call('add_node', { kind: 'command', title: 'Test', command: 'dbt test' });
    await s.call('add_node', { kind: 'command', title: 'Docs', command: 'dbt docs' });
    s.runStore.create({
      id: '20261002-100000-aaaa',
      graphId: s.graphId,
      status: 'succeeded',
      startedAt: 't',
      snapshot: s.graphStore.get(s.graphId),
      nodes: {
        n1: { status: 'succeeded' },
        n2: { status: 'reused', stale: { reason: 'upstream', nodeId: 'n1', runId: '20261002-100000-aaaa' } },
        n3: { status: 'reused', stale: { reason: 'edited', nodeId: 'n3', runId: '20261002-100000-aaaa' } },
      },
    });
    const { text } = await s.call('get_run');
    expect(text).toContain('## n1 · Build — succeeded\n');
    expect(text).toContain('## n2 · Test — reused (stale: built on an older result of n1)');
    expect(text).toContain('## n3 · Docs — reused (stale: edited since this result)');
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

describe('planner tools for access, workspaces and tickets', () => {
  const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
  const repo = (worktrees: { path: string; branch?: string }[] = []): CheckoutInfo => ({
    git: true,
    root: '/work/app',
    linkedWorktree: false,
    branch: 'main',
    head: SHA,
    dirty: false,
    worktrees: [{ path: '/work/app', branch: 'main', head: SHA, current: true }, ...worktrees.map((w) => ({ ...w, head: SHA, current: false }))],
  });

  it('sets access and workspace with add_node and update_node, and get_graph shows them', async () => {
    const s = setup();
    expect(await s.call('add_node', { kind: 'agent', title: 'Look', prompt: 'p', access: 'read' })).toEqual({ text: 'Added n1.', isError: false });
    expect(await s.call('add_node', { kind: 'command', title: 'Run', command: 'make', workspace: 'wh_a' })).toEqual({ text: 'Added n2.', isError: false });
    const shown = JSON.parse((await s.call('get_graph')).text) as { nodes: Record<string, unknown>[] };
    expect(shown.nodes[0]).toMatchObject({ id: 'n1', access: 'read' });
    expect(shown.nodes[0]).not.toHaveProperty('workspace');
    expect(shown.nodes[1]).toMatchObject({ id: 'n2', workspace: 'wh_a' });
    expect(shown.nodes[1]).not.toHaveProperty('access');
    expect(await s.call('update_node', { id: 'n2', workspace: '' })).toEqual({ text: 'Updated n2.', isError: false });
    expect(s.graphStore.get(s.graphId).nodes[1]).not.toHaveProperty('workspace');
    expect(await s.call('update_node', { id: 'n2', access: 'read' })).toEqual({ text: 'Command steps can always change files; only agent steps can be read-only.', isError: true });
    expect(await s.call('add_node', { kind: 'agent', title: 'Bad', prompt: 'p', workspace: 'Bad Name' })).toEqual({
      text: 'Workspace names use lowercase letters, digits, - and _, starting with a letter.',
      isError: true,
    });
  });

  it('checkout_info returns the checkout and the lease holder as JSON', async () => {
    const holder = { runId: '20261003-090000-aaaa', graphId: 'other', folder: '/work/app', pid: 1, startedAt: 't' };
    expect(JSON.parse((await setup(async () => ({ info: repo(), lease: holder })).call('checkout_info')).text)).toEqual({ checkout: repo(), lease: holder });
    expect(JSON.parse((await setup(async () => ({ info: repo() })).call('checkout_info')).text)).toEqual({ checkout: repo(), lease: null });
  });

  it('check_tickets finds each ticket worktree by its feat/<slug> branch', async () => {
    const s = setup(async () => ({ info: repo([{ path: '/work/app-abc-1', branch: 'feat/abc-1' }, { path: '/work/app-abc-2', branch: 'feat/abc-2' }]) }));
    expect(JSON.parse((await s.call('check_tickets', { tickets: ['ABC-1', 'ABC 2'] })).text)).toEqual({
      tickets: [
        { ticket: 'ABC-1', slug: 'abc-1', branch: 'feat/abc-1', worktree: '/work/app-abc-1' },
        { ticket: 'ABC 2', slug: 'abc-2', branch: 'feat/abc-2', worktree: '/work/app-abc-2' },
      ],
      allHaveWorktrees: true,
      advice: ALL_HAVE_WORKTREES_ADVICE,
    });
  });

  it('check_tickets suggests Set Up Parallel Tickets when a ticket has no worktree', async () => {
    const s = setup(async () => ({ info: repo([{ path: '/work/app-abc-1', branch: 'feat/abc-1' }]) }));
    const r = JSON.parse((await s.call('check_tickets', { tickets: ['ABC-1', 'ABC-3'] })).text);
    expect(r.tickets[1]).toEqual({ ticket: 'ABC-3', slug: 'abc-3', branch: 'feat/abc-3' });
    expect(r).toMatchObject({ allHaveWorktrees: false, advice: 'Not every ticket has its own worktree. Suggest the command Agent Stream: Set Up Parallel Tickets, or plan the tickets one after another.' });
  });

  it('check_tickets says worktrees cannot be verified outside Git', async () => {
    expect(JSON.parse((await setup().call('check_tickets', { tickets: ['ABC-1'] })).text)).toEqual({
      tickets: [{ ticket: 'ABC-1', slug: 'abc-1', branch: 'feat/abc-1' }],
      allHaveWorktrees: false,
      advice: "Worktrees can't be verified here; plan the tickets one after another.",
    });
  });

  it('check_tickets takes 1 to 20 tickets that have letters or numbers', async () => {
    const s = setup();
    expect((await s.call('check_tickets', { tickets: [] })).isError).toBe(true);
    expect((await s.call('check_tickets', { tickets: Array.from({ length: 21 }, (_, i) => `T-${i}`) })).isError).toBe(true);
    expect(await s.call('check_tickets', { tickets: ['ABC-1', '???'] })).toEqual({ text: 'Ticket 2 needs letters or numbers.', isError: true });
  });
});
