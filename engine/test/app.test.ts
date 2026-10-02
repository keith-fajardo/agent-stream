import { describe, expect, it, vi } from 'vitest';
import { emptyGraph, type AuthInfo, type ServerMessage } from '@claude-stream/shared';
import { createApp } from '../src/app';
import type { NodeExecutor } from '../src/executors';
import { RunStore } from '../src/runStore';
import { tmpProject } from './helpers';

const instant: NodeExecutor = async (ctx) => {
  ctx.emit({ type: 'start', kind: ctx.node.kind, cwd: ctx.cwd });
  return { ok: true, output: `out-${ctx.node.id}` };
};
const signedIn: AuthInfo = { ok: true, method: 'claude.ai', plan: 'max', email: 'me@example.com' };

function setup(auth: AuthInfo = signedIn, command: NodeExecutor = instant) {
  const paths = tmpProject();
  const app = createApp({
    projectDir: paths.root,
    claudePath: 'claude',
    auth,
    maxParallel: 2,
    executors: { agent: instant, command },
    queryFn: async function* () {},
  });
  const client = () => {
    const msgs: ServerMessage[] = [];
    // Copy like a real WebSocket would serialize: the runner keeps mutating RunMeta after sending.
    const c = { send: (m: ServerMessage) => void msgs.push(structuredClone(m)) };
    app.connect(c);
    const of = <T extends ServerMessage['type']>(type: T) => msgs.filter((m): m is Extract<ServerMessage, { type: T }> => m.type === type);
    return { c, msgs, of };
  };
  return { paths, app, client };
}

type TestClient = ReturnType<ReturnType<typeof setup>['client']>;

/** Asks for a run preview like the dialog does and returns it (its signature is what Start sends). */
async function reviewed(app: ReturnType<typeof setup>['app'], c: TestClient, graphId: string, extra: { fromNodeId?: string; sourceRunId?: string } = {}) {
  await app.handle(c.c, { type: 'previewRun', graphId, ...extra });
  return c.of('runPreview').at(-1)!.preview;
}

describe('app', () => {
  it('greets a client with auth, graphs and pending approvals', () => {
    const { app, client } = setup();
    app.graphStore.create('First');
    expect(client().msgs[0]).toEqual({
      type: 'hello',
      auth: signedIn,
      project: expect.any(String),
      graphs: [{ id: 'first', name: 'First' }],
      approvals: [],
    });
  });

  it('creates graphs, applies user ops and broadcasts the new graph', async () => {
    const { app, client } = setup();
    const a = client();
    const b = client();
    await app.handle(a.c, { type: 'createGraph', name: 'Parity' });
    expect(a.of('graphOpened')[0].graph.id).toBe('parity');
    expect(b.of('graphs').at(-1)?.graphs).toEqual([{ id: 'parity', name: 'Parity' }]);
    await app.handle(a.c, { type: 'op', graphId: 'parity', op: { type: 'addNode', node: { title: 'Plan', kind: 'agent', prompt: 'p' } } });
    expect(b.of('graph').at(-1)?.graph.nodes[0]).toMatchObject({ id: 'n1', createdBy: 'user' });
    await app.handle(a.c, { type: 'op', graphId: 'parity', op: { type: 'connect', from: 'n1', to: 'n1' } });
    expect(a.of('opRejected')).toEqual([{ type: 'opRejected', graphId: 'parity', error: 'a node cannot depend on itself' }]);
    expect(b.of('opRejected')).toEqual([]);
  });

  it('reports unknown graphs', async () => {
    const { app, client } = setup();
    const a = client();
    await app.handle(a.c, { type: 'openGraph', graphId: 'nope' });
    expect(a.of('error')).toEqual([{ type: 'error', message: 'graph "nope" not found' }]);
  });

  it('runs a graph and streams run, node and log updates', async () => {
    const { app, client } = setup();
    const a = client();
    const g = app.graphStore.create('G');
    app.graphStore.apply(g.id, { type: 'addNode', node: { title: 'a', kind: 'agent', prompt: 'p' } }, 'user');
    await app.handle(a.c, { type: 'startRun', graphId: g.id, reviewed: (await reviewed(app, a, g.id)).signature });
    await vi.waitFor(() => expect(a.of('run').at(-1)?.run.status).toBe('succeeded'));
    const runId = a.of('run')[0].run.id;
    expect(a.of('run')[0].run.status).toBe('running');
    expect(a.of('runNode').map((m) => m.state.status)).toEqual(['running', 'succeeded']);
    expect(a.of('nodeEvent').map((m) => m.event.type)).toEqual(['start', 'result']);
    expect(a.of('runs').at(-1)?.runs[0]).toMatchObject({ id: runId, status: 'succeeded' });
    await app.handle(a.c, { type: 'getNodeLogs', runId, nodeId: 'n1' });
    expect(a.of('nodeLogs')[0].events.map((e) => e.type)).toEqual(['start', 'result']);
    await app.handle(a.c, { type: 'selectRun', runId });
    expect(a.of('run').at(-1)).toMatchObject({ select: true, run: { id: runId } });
    await app.handle(a.c, { type: 'openGraph', graphId: g.id });
    expect(a.of('graphOpened')[0]).toMatchObject({ graph: { id: g.id }, chat: [], chatBusy: false, runs: [{ id: runId }], run: { id: runId } });
  });

  it('refuses to start a run when the graph changed after the user reviewed it', async () => {
    const { app, client } = setup();
    const a = client();
    const g = app.graphStore.create('G');
    app.graphStore.apply(g.id, { type: 'addNode', node: { title: 'a', kind: 'command', command: 'echo reviewed' } }, 'user');
    const preview = await reviewed(app, a, g.id);
    app.graphStore.apply(g.id, { type: 'updateNode', id: 'n1', patch: { command: 'echo swapped' } }, 'agent');
    await app.handle(a.c, { type: 'startRun', graphId: g.id, reviewed: preview.signature });
    expect(a.of('error').map((m) => m.message)).toEqual(['Something changed since you reviewed this run (a step, a variable or an environment variable). Review it again.']);
    expect(a.of('run')).toEqual([]);
    expect(app.runStore.list(g.id)).toEqual([]);
  });

  it('disables runs and chat when not signed in to a subscription', async () => {
    const { app, client } = setup({ ok: false, error: 'Not signed in.' });
    const a = client();
    const g = app.graphStore.create('G');
    app.graphStore.apply(g.id, { type: 'addNode', node: { title: 'a', kind: 'agent', prompt: 'p' } }, 'user');
    await app.handle(a.c, { type: 'startRun', graphId: g.id, reviewed: (await reviewed(app, a, g.id)).signature });
    await app.handle(a.c, { type: 'chat', graphId: g.id, text: 'hi' });
    expect(a.of('error').map((m) => m.message)).toEqual(['Runs are disabled: Not signed in.', 'Chat is disabled: Not signed in.']);
    expect(a.of('run')).toEqual([]);
  });

  it('passes approval decisions to the broker and broadcasts the queue', async () => {
    const { app, client } = setup();
    const a = client();
    const req = app.broker.request({ runId: 'r', nodeId: 'n1', nodeTitle: 't', toolName: 'Bash', input: {} });
    expect(a.of('approvals').at(-1)?.approvals).toHaveLength(1);
    await app.handle(a.c, { type: 'decide', approvalId: req.id, decision: 'deny', note: 'not now' });
    await expect(req.decision).resolves.toEqual({ decision: 'deny', note: 'not now' });
    expect(a.of('approvals').at(-1)?.approvals).toEqual([]);
  });

  it('asks the browser to confirm planner-requested runs', () => {
    const { app, client } = setup();
    const a = client();
    const g = app.graphStore.create('G');
    app.graphStore.apply(g.id, { type: 'addNode', node: { title: 'a', kind: 'agent', prompt: '' } }, 'agent');
    expect(app.requestRun(g.id)).toContain('needs a prompt');
    app.graphStore.apply(g.id, { type: 'updateNode', id: 'n1', patch: { prompt: 'p' } }, 'agent');
    expect(app.requestRun(g.id, 'n1')).toBe('There is no previous run to re-run from.');
    expect(app.requestRun(g.id)).toBeNull();
    expect(a.of('confirmRun')).toEqual([{ type: 'confirmRun', graphId: g.id }]);
  });

  it('marks runs left running by a previous server as interrupted', () => {
    const paths = tmpProject();
    new RunStore(paths).create({
      id: '20261001-120000-abcd',
      graphId: 'g',
      status: 'running',
      startedAt: 't',
      snapshot: emptyGraph('g', 'G', 't'),
      nodes: { n1: { status: 'running' } },
    });
    const app = createApp({ projectDir: paths.root, claudePath: 'claude', auth: signedIn, maxParallel: 1, executors: { agent: instant, command: instant } });
    expect(app.runStore.get('20261001-120000-abcd')).toMatchObject({ status: 'interrupted', nodes: { n1: { status: 'interrupted' } } });
  });

  it('previews and starts a run with variable values filled in', async () => {
    const commands: string[] = [];
    const { app, client } = setup(signedIn, async (ctx) => {
      commands.push(ctx.node.command ?? '');
      return { ok: true, output: '' };
    });
    const a = client();
    const g = app.graphStore.create('G');
    app.graphStore.apply(g.id, { type: 'addVariable', name: 'model' }, 'user');
    app.graphStore.apply(g.id, { type: 'addNode', node: { title: 'b', kind: 'command', command: 'dbt build -s {{ model }}' } }, 'user');
    await app.handle(a.c, { type: 'setVariableValue', graphId: g.id, name: 'model', value: 'orders v2' });
    expect(a.of('variableValues').at(-1)).toEqual({ type: 'variableValues', graphId: g.id, values: { model: 'orders v2' } });
    const preview = await reviewed(app, a, g.id);
    expect(preview.steps[0].text).toBe("dbt build -s 'orders v2'");
    await app.handle(a.c, { type: 'startRun', graphId: g.id, reviewed: preview.signature });
    await vi.waitFor(() => expect(a.of('run').at(-1)?.run.status).toBe('succeeded'));
    expect(commands).toEqual(["dbt build -s 'orders v2'"]);
  });

  it('refuses to start when a value changed after review', async () => {
    const { app, client } = setup();
    const a = client();
    const g = app.graphStore.create('G');
    app.graphStore.apply(g.id, { type: 'addVariable', name: 'model' }, 'user');
    app.graphStore.apply(g.id, { type: 'addNode', node: { title: 'b', kind: 'command', command: 'echo {{ model }}' } }, 'user');
    await app.handle(a.c, { type: 'setVariableValue', graphId: g.id, name: 'model', value: 'a' });
    const preview = await reviewed(app, a, g.id);
    await app.handle(a.c, { type: 'setVariableValue', graphId: g.id, name: 'model', value: 'b' });
    await app.handle(a.c, { type: 'startRun', graphId: g.id, reviewed: preview.signature });
    expect(a.of('error').at(-1)?.message).toBe('Something changed since you reviewed this run (a step, a variable or an environment variable). Review it again.');
    expect(a.of('run')).toEqual([]);
  });

  it('sends values with the opened graph, refuses unknown variables, and follows renames and deletes', async () => {
    const { app, client } = setup();
    const a = client();
    const g = app.graphStore.create('G');
    app.graphStore.apply(g.id, { type: 'addVariable', name: 'schema' }, 'user');
    await app.handle(a.c, { type: 'setVariableValue', graphId: g.id, name: 'schema', value: 'dev' });
    await app.handle(a.c, { type: 'openGraph', graphId: g.id });
    expect(a.of('graphOpened').at(-1)?.variableValues).toEqual({ schema: 'dev' });
    await app.handle(a.c, { type: 'setVariableValue', graphId: g.id, name: 'nope', value: 'x' });
    expect(a.of('error').at(-1)?.message).toBe('variable nope does not exist');
    await app.handle(a.c, { type: 'op', graphId: g.id, op: { type: 'renameVariable', name: 'schema', newName: 'target' } });
    expect(app.values.get(g.id)).toEqual({ target: 'dev' });
    await app.handle(a.c, { type: 'op', graphId: g.id, op: { type: 'deleteVariable', name: 'target' } });
    expect(app.values.get(g.id)).toEqual({});
  });
});
