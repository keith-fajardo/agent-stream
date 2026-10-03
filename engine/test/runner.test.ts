import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyOp, emptyGraph, type CheckoutInfo, type Graph, type GraphNode, type Op, type RenderedRun } from '@agent-stream/shared';
import { ApprovalBroker } from '../src/approvals';
import type { NodeContext, NodeExecutor, NodeOutcome } from '../src/executors';
import { newRunId, Runner } from '../src/runner';
import { RunStore } from '../src/runStore';
import { createWriteLeases, type WriteLeases } from '../src/writeLease';
import { testLeases, tmpProject } from './helpers';

/** The reviewed text a run needs: every step's prompt or command as written. */
const asRendered = (graph: Graph): RenderedRun => ({
  goal: graph.goal,
  instructions: graph.instructions,
  nodes: Object.fromEntries(graph.nodes.map((n) => [n.id, n.prompt ?? n.command ?? ''])),
});
const withRendered = (graph: Graph, extra: { sourceRunId?: string; fromNodeId?: string } = {}) => ({ graph, rendered: asRendered(graph), ...extra });

const tick = () => new Promise((r) => setImmediate(r));

function graphOf(ops: Op[]): Graph {
  let g = emptyGraph('g', 'G', 't');
  for (const op of ops) {
    const r = applyOp(g, op, 'user', 't');
    if (!r.ok) throw new Error(r.error);
    g = r.graph;
  }
  return g;
}
const agent = (title: string): Op => ({ type: 'addNode', node: { title, kind: 'agent', prompt: `do ${title}` } });
const reader = (title: string): Op => ({ type: 'addNode', node: { title, kind: 'agent', prompt: `do ${title}`, access: 'read' } });
const link = (from: string, to: string): Op => ({ type: 'connect', from, to });

/** An executor whose nodes finish only when the test says so. */
function controllable() {
  const started: string[] = [];
  const contexts = new Map<string, NodeContext>();
  const finishers = new Map<string, (o: NodeOutcome) => void>();
  let active = 0;
  let maxActive = 0;
  const exec: NodeExecutor = (ctx) =>
    new Promise<NodeOutcome>((resolve) => {
      started.push(ctx.node.id);
      contexts.set(ctx.node.id, ctx);
      active++;
      maxActive = Math.max(maxActive, active);
      const finish = (o: NodeOutcome) => {
        if (finishers.get(ctx.node.id) !== finish) return;
        finishers.delete(ctx.node.id);
        active--;
        resolve(o);
      };
      finishers.set(ctx.node.id, finish);
      ctx.signal.addEventListener('abort', () => finish({ ok: false, output: '', error: 'cancelled' }), { once: true });
    });
  return {
    exec,
    started,
    contexts,
    finish: (id: string, o: NodeOutcome = { ok: true, output: `out-${id}` }) => finishers.get(id)?.(o),
    get maxActive() {
      return maxActive;
    },
  };
}

let seq = 0;
function setup(maxParallel = 3, leases: WriteLeases = testLeases(), leaseRetryMs?: number) {
  const paths = tmpProject();
  const runStore = new RunStore(paths);
  const broker = new ApprovalBroker();
  const fake = controllable();
  const runner = new Runner({
    runStore,
    broker,
    executors: { agent: fake.exec, command: fake.exec },
    projectDir: paths.root,
    maxParallel,
    leases,
    leaseRetryMs,
    newRunId: () => `20261002-000000-${(seq++).toString(16).padStart(4, '0')}`,
  });
  return { runStore, broker, fake, runner, leases, projectDir: paths.root };
}

function started(r: ReturnType<Runner['start']>) {
  if (!r.ok) throw new Error(r.error);
  return r;
}

describe('Runner', () => {
  it('creates sortable run ids', () => {
    expect(newRunId(new Date(2026, 9, 2, 13, 4, 5))).toMatch(/^20261002-130405-[0-9a-f]{4}$/);
  });

  it('runs a chain in order and feeds outputs downstream', async () => {
    const { runner, fake, runStore } = setup();
    const statuses: string[] = [];
    runner.on('node', (_runId: string, nodeId: string, state: { status: string }) => statuses.push(`${nodeId}:${state.status}`));
    const r = started(runner.start(withRendered(graphOf([agent('a'), agent('b'), link('n1', 'n2')]))));
    expect(r.run.nodes.n2.status).toBe('queued');
    await tick();
    expect(fake.started).toEqual(['n1']);
    fake.finish('n1');
    await tick();
    expect(fake.started).toEqual(['n1', 'n2']);
    const prompt = fake.contexts.get('n2')!.prompt;
    expect(prompt).toContain('out-n1');
    expect(prompt).toContain(join('.agent-stream', 'runs', r.run.id, 'nodes', 'n1', 'output.md'));
    fake.finish('n2');
    const done = await r.done;
    expect(done.status).toBe('succeeded');
    expect(statuses).toEqual(['n1:running', 'n1:succeeded', 'n2:running', 'n2:succeeded']);
    expect(runStore.readOutput(done.id, 'n2')).toBe('out-n2');
    expect(runStore.readEvents(done.id, 'n1').map((e) => e.type)).toEqual(['result']);
    expect(runStore.get(done.id)?.status).toBe('succeeded');
  });

  it('runs independent nodes in parallel up to maxParallel', async () => {
    const { runner, fake } = setup(2);
    // Read-only: write-capable steps in one workspace take turns (spec §4.3).
    const r = started(runner.start(withRendered(graphOf([reader('a'), reader('b'), reader('c'), reader('d')]))));
    await tick();
    expect(fake.started).toEqual(['n1', 'n2']);
    fake.finish('n1');
    await tick();
    expect(fake.started).toEqual(['n1', 'n2', 'n3']);
    fake.finish('n2');
    fake.finish('n3');
    await tick();
    fake.finish('n4');
    expect((await r.done).status).toBe('succeeded');
    expect(fake.maxActive).toBe(2);
  });

  it('skips descendants of a failed node but finishes independent branches', async () => {
    const { runner, fake, runStore } = setup();
    const r = started(runner.start(withRendered(graphOf([agent('a'), agent('b'), reader('c'), link('n1', 'n2')]))));
    await tick();
    fake.finish('n1', { ok: false, output: 'partial', error: 'boom' });
    fake.finish('n3');
    const done = await r.done;
    expect(done.status).toBe('failed');
    expect(done.nodes.n1).toMatchObject({ status: 'failed', error: 'boom' });
    expect(done.nodes.n2.status).toBe('not_run');
    expect(done.nodes.n3.status).toBe('succeeded');
    expect(fake.started).not.toContain('n2');
    expect(runStore.readEvents(done.id, 'n1').at(-1)).toMatchObject({ type: 'result', ok: false, error: 'boom' });
  });

  it('stops running and pending nodes and cancels their approvals', async () => {
    const { runner, broker } = setup();
    const r = started(runner.start(withRendered(graphOf([agent('a'), agent('b'), agent('c'), link('n1', 'n3')]))));
    await tick();
    const approval = broker.request({ runId: r.run.id, graphId: 'g', nodeId: 'n2', nodeTitle: 'b', toolName: 'Bash', input: {} });
    expect(runner.stop(r.run.id)).toBe(true);
    const done = await r.done;
    expect(done.status).toBe('cancelled');
    expect(done.nodes).toMatchObject({ n1: { status: 'cancelled' }, n2: { status: 'cancelled' }, n3: { status: 'cancelled' } });
    await expect(approval.decision).resolves.toEqual({ decision: 'cancelled' });
    expect(runner.stop(r.run.id)).toBe(false);
  });

  it('stopAll stops every active run', async () => {
    const { runner } = setup();
    const r = started(runner.start(withRendered(graphOf([agent('a')]))));
    await tick();
    runner.stopAll();
    expect((await r.done).status).toBe('cancelled');
  });

  it('re-runs from a node, reusing unchanged upstream results', async () => {
    const { runner, fake, runStore } = setup();
    const g = graphOf([agent('a'), agent('b'), agent('c'), link('n1', 'n2'), link('n2', 'n3')]);
    const first = started(runner.start(withRendered(g)));
    await tick();
    fake.finish('n1');
    await tick();
    fake.finish('n2');
    await tick();
    fake.finish('n3');
    await first.done;
    fake.started.length = 0;
    const second = started(runner.start(withRendered(g, { sourceRunId: first.run.id, fromNodeId: 'n2' })));
    expect(second.run.nodes.n1.status).toBe('reused');
    expect(second.run.sourceRunId).toBe(first.run.id);
    expect(runStore.readOutput(second.run.id, 'n1')).toBe('out-n1');
    await tick();
    expect(fake.started).toEqual(['n2']);
    expect(fake.contexts.get('n2')!.prompt).toContain('out-n1');
    fake.finish('n2');
    await tick();
    fake.finish('n3');
    expect((await second.done).status).toBe('succeeded');
  });

  it('refuses runs that cannot start', () => {
    const { runner } = setup();
    const draft = graphOf([{ type: 'addNode', node: { title: 'x', kind: 'agent', prompt: '' } }]);
    expect(runner.start(withRendered(draft))).toEqual({ ok: false, error: 'n1 "x": an agent node needs a prompt.' });
    const g = graphOf([agent('a')]);
    expect(runner.start(withRendered(g, { fromNodeId: 'n9' }))).toEqual({ ok: false, error: 'node n9 does not exist' });
    expect(runner.start(withRendered(g, { sourceRunId: '20990101-000000-ffff' }))).toEqual({ ok: false, error: 'run 20990101-000000-ffff not found' });
    expect(runner.start(withRendered(g)).ok).toBe(true);
    expect(runner.start(withRendered(g))).toEqual({ ok: false, error: 'A run is already in progress for this graph.' });
  });

  it('refuses a run whose reviewed text misses a step, and creates no run', () => {
    const { runner, runStore } = setup();
    const g = graphOf([agent('a'), agent('b')]);
    const rendered = { goal: g.goal, instructions: g.instructions, nodes: { n1: 'do a' } };
    expect(runner.start({ graph: g, rendered })).toEqual({ ok: false, error: 'The run has no reviewed text for step n2.' });
    expect(runStore.list('g')).toEqual([]);
    expect(runner.activeFor('g')).toBeUndefined();
  });

  it('marks a node waiting while any of its approvals is pending', async () => {
    const { runner, fake } = setup();
    const r = started(runner.start(withRendered(graphOf([agent('a')]))));
    await tick();
    const { emit } = fake.contexts.get('n1')!;
    const status = () => runner.get(r.run.id)!.nodes.n1.status;
    emit({ type: 'approval_requested', approvalId: 'a1', toolName: 'Bash', input: {} });
    emit({ type: 'approval_requested', approvalId: 'a2', toolName: 'Edit', input: {} });
    expect(status()).toBe('waiting_approval');
    emit({ type: 'approval_decided', approvalId: 'a2', decision: 'approve' });
    expect(status()).toBe('waiting_approval');
    emit({ type: 'approval_decided', approvalId: 'a1', decision: 'deny' });
    expect(status()).toBe('running');
    fake.finish('n1');
    await r.done;
  });
});

describe('Runner when the filesystem or a listener fails', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('finishes the run when a node output cannot be written', { timeout: 2000 }, async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { runner, fake, runStore } = setup();
    runStore.writeOutput = () => {
      throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
    };
    const r = started(runner.start(withRendered(graphOf([agent('a'), agent('b'), link('n1', 'n2')]))));
    await tick();
    fake.finish('n1');
    await tick();
    fake.finish('n2');
    const done = await r.done;
    expect(done.status).toBe('succeeded');
    expect(done.nodes).toMatchObject({ n1: { status: 'succeeded' }, n2: { status: 'succeeded' } });
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('[agent-stream]'), expect.anything(), expect.anything(), expect.any(Error));
  });

  it('finishes the run when node events cannot be logged', { timeout: 2000 }, async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { runner, fake, runStore } = setup();
    runStore.appendEvent = () => {
      throw new Error('EACCES: permission denied, open events.jsonl');
    };
    const live: string[] = [];
    runner.on('event', (_runId: string, _nodeId: string, event: { type: string }) => live.push(event.type));
    const r = started(runner.start(withRendered(graphOf([agent('a')]))));
    await tick();
    expect(() => fake.contexts.get('n1')!.emit({ type: 'text', text: 'working' })).not.toThrow();
    fake.finish('n1');
    const done = await r.done;
    expect(done.status).toBe('succeeded');
    expect(live).toEqual(['text', 'result']);
  });

  it('finishes the run when a listener throws', { timeout: 2000 }, async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { runner, fake } = setup();
    runner.on('node', () => {
      throw new Error('listener bug');
    });
    const r = started(runner.start(withRendered(graphOf([agent('a')]))));
    await tick();
    fake.finish('n1');
    expect((await r.done).status).toBe('succeeded');
  });

  it('fails the node and finishes the run when completing a node throws unexpectedly', { timeout: 2000 }, async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const paths = tmpProject();
    const broken: NodeExecutor = async () => undefined as unknown as NodeOutcome;
    const runner = new Runner({
      runStore: new RunStore(paths),
      broker: new ApprovalBroker(),
      executors: { agent: broken, command: broken },
      projectDir: paths.root,
      maxParallel: 3,
      leases: testLeases(),
      newRunId: () => `20261002-000000-${(seq++).toString(16).padStart(4, '0')}`,
    });
    const r = started(runner.start(withRendered(graphOf([agent('a'), agent('b'), link('n1', 'n2')]))));
    const done = await r.done;
    expect(done.status).toBe('failed');
    expect(done.nodes.n1.status).toBe('failed');
    expect(done.nodes.n1.error).toMatch(/^Agent Stream internal error: /);
    expect(done.nodes.n2.status).toBe('not_run');
  });

  it('runs and records the rendered text instead of the templates', async () => {
    const { runner, fake, runStore } = setup();
    const g = graphOf([{ type: 'addNode', node: { title: 'build', kind: 'command', command: 'dbt build -s {{ model }}' } }, agent('check'), link('n1', 'n2')]);
    const rendered = { goal: 'goal!', instructions: 'be careful', nodes: { n1: "dbt build -s 'orders'", n2: 'do check now' } };
    const r = started(runner.start({ graph: g, rendered }));
    await tick();
    expect(fake.contexts.get('n1')?.node.command).toBe("dbt build -s 'orders'");
    fake.finish('n1');
    await tick();
    const ctx = fake.contexts.get('n2')!;
    expect(ctx.node.prompt).toBe('do check now');
    expect(ctx.graph.goal).toBe('goal!');
    expect(ctx.prompt).toContain("## n1 · build (command `dbt build -s 'orders'`");
    expect(ctx.prompt).toContain('# Instructions & context\nbe careful');
    fake.finish('n2');
    const done = await r.done;
    expect(done.rendered).toEqual(rendered);
    expect(done.snapshot.nodes[0].command).toBe('dbt build -s {{ model }}');
    expect(runStore.get(done.id)?.rendered).toEqual(rendered);
  });

  it("runs agent steps with the run's own executor and records its provider", async () => {
    const { runner, fake, runStore } = setup();
    const ran: string[] = [];
    const own: NodeExecutor = async (ctx) => {
      ran.push(ctx.node.id);
      return { ok: true, output: `own-${ctx.node.id}` };
    };
    const g = graphOf([agent('a'), { type: 'addNode', node: { title: 'c', kind: 'command', command: 'ls' } }, link('n1', 'n2')]);
    const r = started(runner.start({ ...withRendered(g), agent: own, provider: 'copilot' }));
    expect(r.run.provider).toBe('copilot');
    await tick();
    expect(ran).toEqual(['n1']);
    expect(fake.started).toEqual(['n2']);
    fake.finish('n2');
    const done = await r.done;
    expect(done.status).toBe('succeeded');
    expect(runStore.readOutput(done.id, 'n1')).toBe('own-n1');
    expect(runStore.get(done.id)?.provider).toBe('copilot');
  });

  it('records no provider when the run names none', async () => {
    const { runner, fake } = setup();
    const r = started(runner.start(withRendered(graphOf([agent('a')]))));
    expect(r.run).not.toHaveProperty('provider');
    await tick();
    fake.finish('n1');
    await r.done;
  });
});

describe('Runner.amend', () => {
  const newNode = (id: string, over: Partial<GraphNode> = {}): GraphNode => ({ id, title: id, kind: 'agent', prompt: `do ${id}`, createdBy: 'agent', updatedBy: 'agent', updatedAt: 't', ...over });

  it('refuses to amend a finished run', async () => {
    const { runner, fake } = setup();
    const r = started(runner.start(withRendered(graphOf([agent('a')]))));
    await tick();
    fake.finish('n1');
    await r.done;
    expect(runner.amend(r.run.id, { kind: 'add', node: newNode('n2'), text: 'x', after: ['n1'], before: [] }, 'n1', 's')).toEqual({ ok: false, error: 'The run was stopped.' });
    expect(runner.amend('nope', { kind: 'change', node: newNode('n1'), text: 'x' }, 'n1', 's')).toEqual({ ok: false, error: 'The run was stopped.' });
  });

  it('refuses steps that started, unknown steps and cycles, and changes nothing', async () => {
    const { runner } = setup();
    const r = started(runner.start(withRendered(graphOf([agent('a'), agent('b'), link('n1', 'n2')]))));
    await tick();
    const before = structuredClone(runner.get(r.run.id));
    expect(runner.amend(r.run.id, { kind: 'change', node: newNode('n1'), text: 'x' }, 'n1', 's')).toEqual({ ok: false, error: 'n1 already started; the change was not applied.' });
    expect(runner.amend(r.run.id, { kind: 'add', node: newNode('n3'), text: 'x', after: [], before: ['n1'] }, 'n1', 's')).toEqual({ ok: false, error: 'n1 already started; the change was not applied.' });
    expect(runner.amend(r.run.id, { kind: 'add', node: newNode('n3'), text: 'x', after: ['n9'], before: [] }, 'n1', 's')).toEqual({ ok: false, error: 'node n9 does not exist' });
    expect(runner.amend(r.run.id, { kind: 'change', node: newNode('n9'), text: 'x' }, 'n1', 's')).toEqual({ ok: false, error: 'node n9 does not exist' });
    expect(runner.amend(r.run.id, { kind: 'add', node: newNode('n2'), text: 'x', after: ['n1'], before: [] }, 'n1', 's')).toEqual({ ok: false, error: 'node n2 already exists' });
    expect(runner.amend(r.run.id, { kind: 'add', node: newNode('n3'), text: 'x', after: ['n2'], before: ['n2'] }, 'n1', 's')).toEqual({ ok: false, error: 'The graph has a cycle.' });
    expect(runner.get(r.run.id)).toEqual(before);
    runner.stop(r.run.id);
    await r.done;
  });
});

describe('Runner write leases', () => {
  const checkout: CheckoutInfo = { git: false, root: join(tmpdir(), 'agent-stream-checkout'), reason: 'Not a Git repository' };
  const g = (...ops: Op[]) => graphOf(ops);

  it('blocks a second write-capable run in the same checkout, from another engine, creating nothing (Review Focus 1)', async () => {
    const leases = testLeases();
    const a = setup(3, leases);
    const b = setup(3, leases);
    const first = started(a.runner.start({ ...withRendered(g(agent('a'))), checkout }));
    expect(first.run.checkout).toEqual({ root: checkout.root, linkedWorktree: false });
    const second = b.runner.start({ ...withRendered(g(agent('b'))), checkout });
    expect(second).toEqual({
      ok: false,
      error: `Run ${first.run.id} is already changing files in ${checkout.root}.`,
      blocked: { holder: { runId: first.run.id, graphId: 'g', folder: a.projectDir, pid: process.pid, startedAt: first.run.startedAt }, otherWindow: false, checkout },
    });
    expect(b.runStore.list('g')).toEqual([]);
    expect(b.runner.activeFor('g')).toBeUndefined();
    await tick();
    a.fake.finish('n1');
    await first.done;
  });

  it('starts a read-only run alongside a write-capable run', async () => {
    const leases = testLeases();
    const a = setup(3, leases);
    const b = setup(3, leases);
    const first = started(a.runner.start({ ...withRendered(g(agent('a'))), checkout }));
    const second = started(b.runner.start({ ...withRendered(g(reader('look'))), checkout }));
    expect(second.run.waitingFor).toBeUndefined();
    await tick();
    expect(b.fake.started).toEqual(['n1']);
    b.fake.finish('n1');
    expect((await second.done).status).toBe('succeeded');
    a.fake.finish('n1');
    await first.done;
  });

  it('in a sequential run, read-only steps run and write-capable steps wait until the first run ends', async () => {
    const leases = testLeases();
    const a = setup(3, leases);
    const b = setup(3, leases);
    const first = started(a.runner.start({ ...withRendered(g(agent('a'))), checkout }));
    const second = started(b.runner.start({ ...withRendered(g(reader('look'), agent('edit'))), checkout, sequential: true }));
    expect(second.run.waitingFor).toEqual({ runId: first.run.id, graphId: 'g', folder: a.projectDir });
    await tick();
    expect(b.fake.started).toEqual(['n1']);
    b.fake.finish('n1');
    await tick();
    expect(b.runner.get(second.run.id)).toMatchObject({ status: 'running', nodes: { n2: { status: 'queued' } } });
    a.fake.finish('n1');
    await first.done;
    await tick();
    expect(b.fake.started).toEqual(['n1', 'n2']);
    expect(b.runner.get(second.run.id)?.waitingFor).toBeUndefined();
    expect(leases.holder(checkout.root)?.runId).toBe(second.run.id);
    b.fake.finish('n2');
    expect((await second.done).status).toBe('succeeded');
    expect(leases.holder(checkout.root)).toBeUndefined();
  });

  it('never overlaps write-capable checkout steps of one run, while read-only ones run alongside', async () => {
    const { runner, fake } = setup(4);
    const r = started(runner.start({ ...withRendered(g(agent('a'), agent('b'), reader('c'), reader('d'))), checkout }));
    await tick();
    expect(fake.started).toEqual(['n1', 'n3', 'n4']);
    fake.finish('n3');
    fake.finish('n4');
    await tick();
    expect(fake.started).toEqual(['n1', 'n3', 'n4']);
    fake.finish('n1');
    await tick();
    expect(fake.started).toEqual(['n1', 'n3', 'n4', 'n2']);
    fake.finish('n2');
    expect((await r.done).status).toBe('succeeded');
    expect(fake.maxActive).toBe(3);
  });

  it('releases the lease on success, failure and cancel', async () => {
    const { runner, fake, leases } = setup();
    const graph = g(agent('a'));
    const ok = started(runner.start({ ...withRendered(graph), checkout }));
    expect(leases.holder(checkout.root)?.runId).toBe(ok.run.id);
    await tick();
    fake.finish('n1');
    await ok.done;
    expect(leases.holder(checkout.root)).toBeUndefined();
    const failed = started(runner.start({ ...withRendered(graph), checkout }));
    await tick();
    fake.finish('n1', { ok: false, output: '', error: 'boom' });
    expect((await failed.done).status).toBe('failed');
    expect(leases.holder(checkout.root)).toBeUndefined();
    const cancelled = started(runner.start({ ...withRendered(graph), checkout }));
    await tick();
    runner.stop(cancelled.run.id);
    expect((await cancelled.done).status).toBe('cancelled');
    expect(leases.holder(checkout.root)).toBeUndefined();
  });

  it('a cancelled waiting run never takes the lease', async () => {
    const leases = testLeases();
    const a = setup(3, leases);
    const b = setup(3, leases);
    const first = started(a.runner.start({ ...withRendered(g(agent('a'))), checkout }));
    const second = started(b.runner.start({ ...withRendered(g(agent('b'))), checkout, sequential: true }));
    b.runner.stop(second.run.id);
    const stopped = await second.done;
    expect(stopped.status).toBe('cancelled');
    expect(stopped.waitingFor).toBeUndefined();
    await tick();
    a.fake.finish('n1');
    await first.done;
    expect(leases.holder(checkout.root)).toBeUndefined();
    expect(b.fake.started).toEqual([]);
  });

  it('waiting runs take the lease in the order they started', async () => {
    const leases = testLeases();
    const a = setup(3, leases);
    const b = setup(3, leases);
    const c = setup(3, leases);
    const first = started(a.runner.start({ ...withRendered(g(agent('a'))), checkout }));
    const second = started(c.runner.start({ ...withRendered(g(agent('c'))), checkout, sequential: true }));
    const third = started(b.runner.start({ ...withRendered(g(agent('b'))), checkout, sequential: true }));
    await tick();
    a.fake.finish('n1');
    await first.done;
    expect(leases.holder(checkout.root)?.runId).toBe(second.run.id);
    expect(b.runner.get(third.run.id)?.waitingFor?.runId).toBe(second.run.id);
    await tick();
    c.fake.finish('n1');
    await second.done;
    expect(leases.holder(checkout.root)?.runId).toBe(third.run.id);
    await tick();
    b.fake.finish('n1');
    await third.done;
  });

  it('retries every few seconds while the holder is in another window', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-stream-locks-'));
    const elsewhere = join(tmpdir(), 'elsewhere');
    const otherWindow = createWriteLeases({ locksDir: dir, pid: 4242, isAlive: () => true });
    otherWindow.acquire(checkout.root, { runId: '20261003-090000-beef', graphId: 'billing', folder: elsewhere, startedAt: 't' });
    const { runner, fake } = setup(3, createWriteLeases({ locksDir: dir, isAlive: () => true }), 20);
    const r = started(runner.start({ ...withRendered(g(agent('a'))), checkout, sequential: true }));
    expect(r.run.waitingFor).toEqual({ runId: '20261003-090000-beef', graphId: 'billing', folder: elsewhere });
    otherWindow.release(checkout.root, '20261003-090000-beef');
    await vi.waitFor(() => expect(fake.started).toEqual(['n1']));
    fake.finish('n1');
    expect((await r.done).status).toBe('succeeded');
  });

  it('a sequential start takes the lease at once when it is free (Review Focus 5)', async () => {
    const { runner, fake, leases } = setup();
    const r = started(runner.start({ ...withRendered(g(agent('a'))), checkout, sequential: true }));
    expect(r.run.waitingFor).toBeUndefined();
    expect(leases.holder(checkout.root)?.runId).toBe(r.run.id);
    await tick();
    expect(fake.started).toEqual(['n1']);
    fake.finish('n1');
    expect((await r.done).status).toBe('succeeded');
  });

  it('needs no lease when its write-capable steps are all reused', async () => {
    const { runner, fake, leases } = setup();
    const graph = g(agent('a'), reader('b'), link('n1', 'n2'));
    const first = started(runner.start({ ...withRendered(graph), checkout }));
    await tick();
    fake.finish('n1');
    await tick();
    fake.finish('n2');
    await first.done;
    expect(leases.acquire(checkout.root, { runId: '20261003-090000-beef', graphId: 'x', folder: 'f', startedAt: 't' })).toEqual({ ok: true });
    const rerun = started(runner.start({ ...withRendered(graph, { sourceRunId: first.run.id, fromNodeId: 'n2' }), checkout }));
    expect(rerun.run.nodes.n1.status).toBe('reused');
    expect(rerun.run.waitingFor).toBeUndefined();
    await tick();
    fake.finish('n2');
    expect((await rerun.done).status).toBe('succeeded');
    leases.release(checkout.root, '20261003-090000-beef');
  });

  it('dispose releases every lease and stops the runs', async () => {
    const { runner, leases } = setup();
    const r = started(runner.start({ ...withRendered(g(agent('a'))), checkout }));
    await tick();
    runner.dispose();
    expect(leases.holder(checkout.root)).toBeUndefined();
    expect((await r.done).status).toBe('cancelled');
  });

  it('dispose stops waiting runs before releasing, so a waiting run starts nothing during shutdown', async () => {
    const { runner, fake, leases } = setup();
    const first = started(runner.start({ ...withRendered(g(agent('a'))), checkout }));
    // Another graph in the same runner, waiting for the lease.
    const second = started(runner.start({ ...withRendered({ ...g(agent('edit')), id: 'h' }), checkout, sequential: true }));
    expect(second.run.waitingFor?.runId).toBe(first.run.id);
    await tick();
    expect(fake.started).toEqual(['n1']);
    runner.dispose();
    await tick();
    expect(fake.started).toEqual(['n1']);
    expect(leases.holder(checkout.root)).toBeUndefined();
    expect((await first.done).status).toBe('cancelled');
    const stopped = await second.done;
    expect(stopped.status).toBe('cancelled');
    expect(stopped.nodes.n1.status).toBe('cancelled');
  });

  it('uses the run id it is given', () => {
    const { runner } = setup();
    const r = started(runner.start({ ...withRendered(g(reader('a'))), runId: '20261003-120000-abcd' }));
    expect(r.run.id).toBe('20261003-120000-abcd');
    runner.stop(r.run.id);
  });
});
