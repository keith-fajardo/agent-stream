import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { HookInput, Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { emptyGraph, type AuthInfo, type ServerMessage } from '@claude-stream/shared';
import { createApp } from '../src/app';
import type { NodeExecutor } from '../src/executors';
import { RunStore } from '../src/runStore';
import { testGitBash, tmpProject, tmpValuesFile } from './helpers';

const instant: NodeExecutor = async (ctx) => {
  ctx.emit({ type: 'start', kind: ctx.node.kind, cwd: ctx.cwd });
  return { ok: true, output: `out-${ctx.node.id}` };
};
const signedIn: AuthInfo = { ok: true, method: 'claude.ai', plan: 'max', email: 'me@example.com' };

function setup(auth: AuthInfo = signedIn, command: NodeExecutor = instant, env?: (name: string) => string | undefined) {
  const paths = tmpProject();
  const valuesFile = tmpValuesFile();
  const app = createApp({
    projectDir: paths.root,
    valuesFile,
    claudePath: 'claude',
    auth,
    maxParallel: 2,
    gitBash: testGitBash,
    env,
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
  return { paths, valuesFile, app, client };
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
      graphs: [{ id: 'first', name: 'First', updatedAt: expect.any(String) }],
      approvals: [],
    });
  });

  it('echoes the preview request id in its reply', async () => {
    const { app, client } = setup();
    const a = client();
    const g = app.graphStore.create('G');
    await app.handle(a.c, { type: 'previewRun', graphId: g.id, requestId: 'r1' });
    expect(a.of('runPreview').at(-1)?.requestId).toBe('r1');
    await app.handle(a.c, { type: 'previewRun', graphId: g.id });
    expect(a.of('runPreview').at(-1)).not.toHaveProperty('requestId');
  });

  it('creates graphs, applies user ops and broadcasts the new graph', async () => {
    const { app, client } = setup();
    const a = client();
    const b = client();
    await app.handle(a.c, { type: 'createGraph', name: 'Parity' });
    expect(a.of('graphOpened')[0].graph.id).toBe('parity');
    expect(b.of('graphs').at(-1)?.graphs).toEqual([{ id: 'parity', name: 'Parity', updatedAt: expect.any(String) }]);
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
    const req = app.broker.request({ runId: 'r', graphId: 'g', nodeId: 'n1', nodeTitle: 't', toolName: 'Bash', input: {} });
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
    const app = createApp({ projectDir: paths.root, valuesFile: tmpValuesFile(), claudePath: 'claude', auth: signedIn, maxParallel: 1, executors: { agent: instant, command: instant } });
    expect(app.runStore.get('20261001-120000-abcd')).toMatchObject({ status: 'interrupted', nodes: { n1: { status: 'interrupted' } } });
  });

  it('keeps variable values in the given values file and writes none into the project', async () => {
    const { app, client, paths, valuesFile } = setup();
    const a = client();
    const g = app.graphStore.create('G');
    app.graphStore.apply(g.id, { type: 'addVariable', name: 'password' }, 'user');
    await app.handle(a.c, { type: 'setVariableValue', graphId: g.id, name: 'password', value: 'hunter2' });
    expect(JSON.parse(readFileSync(valuesFile, 'utf8'))).toEqual({ version: 1, graphs: { [g.id]: { password: 'hunter2' } } });
    const files = (readdirSync(paths.root, { recursive: true }) as string[]).map((f) => join(paths.root, f)).filter((f) => statSync(f).isFile());
    expect(files.length).toBeGreaterThan(0);
    expect(files.filter((f) => f.endsWith('variables.local.json'))).toEqual([]);
    expect(files.filter((f) => readFileSync(f, 'utf8').includes('hunter2'))).toEqual([]);
  });

  it('denies Claude the values file in planner turns and agent steps', async () => {
    const paths = tmpProject();
    const valuesFile = tmpValuesFile();
    const sessions: Options[] = [];
    const app = createApp({
      projectDir: paths.root,
      valuesFile,
      claudePath: 'claude',
      auth: signedIn,
      maxParallel: 1,
      gitBash: testGitBash,
      queryFn: ({ options }) => {
        sessions.push(options!);
        return (async function* () {
          yield { type: 'system', subtype: 'init', apiKeySource: 'none', session_id: 's' } as unknown as SDKMessage;
          const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
          yield { type: 'result', subtype: 'success', is_error: false, result: 'ok', num_turns: 1, total_cost_usd: 0, usage, session_id: 's' } as unknown as SDKMessage;
        })();
      },
    });
    const sent: ServerMessage[] = [];
    const c = { send: (m: ServerMessage) => void sent.push(m) };
    const g = app.graphStore.create('G');
    app.graphStore.apply(g.id, { type: 'addNode', node: { title: 'a', kind: 'agent', prompt: 'p' } }, 'user');
    await app.handle(c, { type: 'chat', graphId: g.id, text: 'hi' });
    await vi.waitFor(() => expect(app.planner.isBusy(g.id)).toBe(false));
    await app.handle(c, { type: 'previewRun', graphId: g.id });
    const preview = sent.find((m): m is Extract<ServerMessage, { type: 'runPreview' }> => m.type === 'runPreview')!.preview;
    await app.handle(c, { type: 'startRun', graphId: g.id, reviewed: preview.signature });
    await vi.waitFor(() => expect(app.runStore.list(g.id)[0]?.status).toBe('succeeded'));
    expect(sessions.map((o) => o.permissionMode)).toEqual(['dontAsk', 'default']);
    for (const o of sessions) {
      const hook = o.hooks!.PreToolUse![0].hooks[0];
      const read = { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: valuesFile }, tool_use_id: 't', session_id: 's', transcript_path: '/t', cwd: paths.root } as HookInput;
      expect(await hook(read, 't', { signal: new AbortController().signal })).toMatchObject({
        hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: expect.stringContaining('the variable values file') },
      });
    }
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

  it('refuses to start when the preview has problems, even with its own signature', async () => {
    const { app, client } = setup();
    const a = client();
    const g = app.graphStore.create('G');
    app.graphStore.apply(g.id, { type: 'addVariable', name: 'model' }, 'user');
    app.graphStore.apply(g.id, { type: 'addNode', node: { title: 'b', kind: 'command', command: 'echo {{ model }}' } }, 'user');
    const preview = await reviewed(app, a, g.id);
    expect(preview.problems.length).toBeGreaterThan(0);
    await app.handle(a.c, { type: 'startRun', graphId: g.id, reviewed: preview.signature });
    expect(a.of('error').at(-1)?.message).toContain('Set a value for model (Variables menu).');
    expect(a.of('run')).toEqual([]);
  });

  it('refuses to start when an environment variable changed after review', async () => {
    const envMap: Record<string, string> = { T: 'a' };
    const { app, client } = setup(signedIn, instant, (name) => envMap[name]);
    const a = client();
    const g = app.graphStore.create('G');
    app.graphStore.apply(g.id, { type: 'addNode', node: { title: 'b', kind: 'command', command: "echo {{ env_var('T') }}" } }, 'user');
    const preview = await reviewed(app, a, g.id);
    envMap.T = 'b';
    await app.handle(a.c, { type: 'startRun', graphId: g.id, reviewed: preview.signature });
    expect(a.of('error').at(-1)?.message).toBe('Something changed since you reviewed this run (a step, a variable or an environment variable). Review it again.');
    expect(a.of('run')).toEqual([]);
  });

  it('re-executes a reused step when its variable value changed', async () => {
    const commands: string[] = [];
    const { app, client } = setup(signedIn, async (ctx) => {
      commands.push(ctx.node.command ?? '');
      return { ok: true, output: 'o' };
    });
    const a = client();
    const g = app.graphStore.create('G');
    app.graphStore.apply(g.id, { type: 'addVariable', name: 'model' }, 'user');
    app.graphStore.apply(g.id, { type: 'addNode', node: { title: 'c', kind: 'command', command: 'echo {{ model }}' } }, 'user');
    app.graphStore.apply(g.id, { type: 'addNode', node: { title: 'a', kind: 'agent', prompt: 'summarize' } }, 'user');
    app.graphStore.apply(g.id, { type: 'connect', from: 'n1', to: 'n2' }, 'user');
    await app.handle(a.c, { type: 'setVariableValue', graphId: g.id, name: 'model', value: 'a' });
    await app.handle(a.c, { type: 'startRun', graphId: g.id, reviewed: (await reviewed(app, a, g.id)).signature });
    await vi.waitFor(() => expect(a.of('run').at(-1)?.run.status).toBe('succeeded'));
    const firstId = a.of('run').at(-1)!.run.id;
    expect(commands).toEqual(["echo 'a'"]);
    await app.handle(a.c, { type: 'setVariableValue', graphId: g.id, name: 'model', value: 'b' });
    const extra = { fromNodeId: 'n2', sourceRunId: firstId };
    const preview = await reviewed(app, a, g.id, extra);
    await app.handle(a.c, { type: 'startRun', graphId: g.id, reviewed: preview.signature, ...extra });
    await vi.waitFor(() => expect(a.of('run').filter((m) => m.run.id !== firstId).at(-1)?.run.status).toBe('succeeded'));
    expect(commands).toEqual(["echo 'a'", "echo 'b'"]);
  });

  describe('graph management', () => {
    it('lists graphs with their last run', async () => {
      const { app, client } = setup();
      const a = client();
      const g = app.graphStore.create('G');
      app.graphStore.apply(g.id, { type: 'addNode', node: { title: 'a', kind: 'agent', prompt: 'p' } }, 'user');
      await app.handle(a.c, { type: 'startRun', graphId: g.id, reviewed: (await reviewed(app, a, g.id)).signature });
      await vi.waitFor(() => expect(app.listGraphs()[0].lastRun?.status).toBe('succeeded'));
      expect(a.of('graphs').at(-1)?.graphs[0].lastRun?.status).toBe('succeeded');
    });

    it('duplicates with local values, and deletes values with the graph', () => {
      const { app } = setup();
      const g = app.graphStore.create('G');
      app.graphStore.apply(g.id, { type: 'addVariable', name: 'schema' }, 'user');
      app.values.set(g.id, 'schema', 'dev');
      const copy = app.duplicateGraph(g.id);
      if (!copy.ok) throw new Error(copy.error);
      expect(app.values.get(copy.graph.id)).toEqual({ schema: 'dev' });
      expect(app.deleteGraph(copy.graph.id)).toEqual({ ok: true });
      expect(app.values.get(copy.graph.id)).toEqual({});
    });

    it('refuses to delete a graph that is running, and announces deletions', async () => {
      const gate = { release: () => {} };
      const { app, client } = setup(signedIn, () => new Promise((resolve) => (gate.release = () => resolve({ ok: true, output: '' }))));
      const a = client();
      const g = app.graphStore.create('G');
      app.graphStore.apply(g.id, { type: 'addNode', node: { title: 'b', kind: 'command', command: 'x' } }, 'user');
      await app.handle(a.c, { type: 'startRun', graphId: g.id, reviewed: (await reviewed(app, a, g.id)).signature });
      expect(app.deleteGraph(g.id)).toEqual({ ok: false, error: 'Stop the run first.' });
      gate.release();
      await vi.waitFor(() => expect(app.runner.activeFor(g.id)).toBeUndefined());
      expect(app.deleteGraph(g.id)).toEqual({ ok: true });
      expect(a.of('graphDeleted')).toEqual([{ type: 'graphDeleted', graphId: g.id }]);
    });
  });

  it('refuses to delete a graph while the planner is working on it', async () => {
    const paths = tmpProject();
    const gate = { release: () => {} };
    const app = createApp({
      projectDir: paths.root,
      valuesFile: tmpValuesFile(),
      claudePath: 'claude',
      auth: signedIn,
      maxParallel: 1,
      gitBash: testGitBash,
      queryFn: () =>
        (async function* () {
          await new Promise<void>((resolve) => (gate.release = resolve));
          yield { type: 'system', subtype: 'init', apiKeySource: 'none', session_id: 's' } as unknown as SDKMessage;
        })(),
    });
    const c = { send: () => {} };
    const g = app.graphStore.create('G');
    await app.handle(c, { type: 'chat', graphId: g.id, text: 'hi' });
    await vi.waitFor(() => expect(app.planner.isBusy(g.id)).toBe(true));
    expect(app.deleteGraph(g.id)).toEqual({ ok: false, error: "The planner is still working on this graph. Try again when it's done." });
    expect(app.graphStore.load(g.id).ok).toBe(true);
    gate.release();
    await vi.waitFor(() => expect(app.planner.isBusy(g.id)).toBe(false));
    expect(app.deleteGraph(g.id)).toEqual({ ok: true });
  });

  it('reports a missing Git Bash on Windows in the preview of graphs with command steps', async () => {
    const paths = tmpProject();
    const app = createApp({
      projectDir: paths.root,
      valuesFile: tmpValuesFile(),
      claudePath: 'claude',
      auth: signedIn,
      maxParallel: 1,
      platform: 'win32',
      gitBash: { ok: false, error: 'Command steps need Git Bash on Windows. Install Git for Windows, or set claudeStream.gitBashPath.' },
      executors: { agent: instant, command: instant },
      queryFn: async function* () {},
    });
    const msgs: ServerMessage[] = [];
    const c = { send: (m: ServerMessage) => void msgs.push(m) };
    const g = app.graphStore.create('G');
    app.graphStore.apply(g.id, { type: 'addNode', node: { title: 'b', kind: 'command', command: 'x' } }, 'user');
    await app.handle(c, { type: 'previewRun', graphId: g.id });
    const preview = msgs.find((m): m is Extract<ServerMessage, { type: 'runPreview' }> => m.type === 'runPreview')!.preview;
    expect(preview.problems).toEqual(['Command steps need Git Bash on Windows. Install Git for Windows, or set claudeStream.gitBashPath.']);
  });

  describe('for the extension', () => {
    it('changes sign-in state and the Claude Code path at runtime', async () => {
      const { app, client } = setup({ ok: false, error: 'Not signed in.' });
      const a = client();
      const g = app.graphStore.create('G');
      app.graphStore.apply(g.id, { type: 'addNode', node: { title: 'a', kind: 'agent', prompt: 'p' } }, 'user');
      const sig = (await reviewed(app, a, g.id)).signature;
      await app.handle(a.c, { type: 'startRun', graphId: g.id, reviewed: sig });
      expect(a.of('error').at(-1)?.message).toBe('Runs are disabled: Not signed in.');
      app.setAuth(signedIn, '/new/claude');
      expect(a.of('auth')).toEqual([{ type: 'auth', auth: signedIn }]);
      await app.handle(a.c, { type: 'startRun', graphId: g.id, reviewed: sig });
      await vi.waitFor(() => expect(a.of('run').at(-1)?.run.status).toBe('succeeded'));
    });

    it('stops every run on dispose', async () => {
      const { app, client } = setup(signedIn, (ctx) => new Promise((resolve) => ctx.signal.addEventListener('abort', () => resolve({ ok: false, output: '', error: 'cancelled' }))));
      const a = client();
      const g = app.graphStore.create('G');
      app.graphStore.apply(g.id, { type: 'addNode', node: { title: 'b', kind: 'command', command: 'x' } }, 'user');
      await app.handle(a.c, { type: 'startRun', graphId: g.id, reviewed: (await reviewed(app, a, g.id)).signature });
      app.dispose();
      await vi.waitFor(() => expect(a.of('run').at(-1)?.run.status).toBe('cancelled'));
    });

    it('reports an unreadable local values file once at startup', () => {
      const paths = tmpProject();
      const valuesFile = tmpValuesFile();
      writeFileSync(valuesFile, '{');
      const app = createApp({ projectDir: paths.root, valuesFile, claudePath: 'claude', auth: signedIn, maxParallel: 1, executors: { agent: instant, command: instant }, queryFn: async function* () {} });
      expect(app.startupWarnings()).toEqual([expect.stringMatching(/^The variable values file \(.+\) could not be read/)]);
    });
  });
});
