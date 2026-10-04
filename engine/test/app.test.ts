import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { HookInput, Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { emptyGraph, type EffortLevel, type ModelChoice, type ModelSelection, type Op, type ProviderStatus, type RunMeta, type ServerMessage } from '@agent-stream/shared';
import { CHANGED_SINCE_REVIEW, createApp, type App, type AppDeps } from '../src/app';
import type { NodeExecutor } from '../src/executors';
import type { GitExec } from '../src/git';
import { createClaudeProvider } from '../src/providers/claude';
import type { PlannerTurn, PlannerTurnResult } from '../src/providers/types';
import { refineRequest, splitRequest } from '../src/refine';
import { RunStore } from '../src/runStore';
import { variantPath } from '../src/variantWorkspaces';
import { createWriteLeases, leaseFile, type WriteLeases } from '../src/writeLease';
import { appTestDeps, deferred, noGit, repoGit, testGitBash, testLeases, testProvider, tmpProject, tmpValuesFile } from './helpers';

const instant: NodeExecutor = async (ctx) => {
  ctx.emit({ type: 'start', kind: ctx.node.kind, cwd: ctx.cwd });
  return { ok: true, output: `out-${ctx.node.id}` };
};
const signedIn: ProviderStatus = { provider: 'claude', ok: true, label: 'Claude Max', detail: 'me@example.com' };

function setup(status: ProviderStatus = signedIn, command: NodeExecutor = instant, env?: (name: string) => string | undefined, over: Partial<AppDeps> = {}) {
  const paths = tmpProject();
  const valuesFile = tmpValuesFile();
  const app = createApp({
    ...appTestDeps(),
    projectDir: paths.root,
    valuesFile,
    provider: testProvider(),
    status,
    maxParallel: 2,
    gitBash: testGitBash,
    env,
    executors: { agent: instant, command },
    ...over,
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

/** An App with one graph; `over` replaces its dependencies (a planner provider, say). */
function setupWithGraph(over: Partial<AppDeps> = {}) {
  const paths = tmpProject();
  const app = createApp({ ...appTestDeps(), projectDir: paths.root, valuesFile: tmpValuesFile(), provider: testProvider(), status: signedIn, maxParallel: 1, gitBash: testGitBash, ...over });
  const graphId = app.graphStore.create('G').id;
  return { app, graphId, paths };
}

/** A connected client that records what it receives. */
function client(app: App) {
  const msgs: ServerMessage[] = [];
  const c = { send: (m: ServerMessage) => void msgs.push(structuredClone(m)) };
  app.connect(c);
  const all = <T extends ServerMessage['type']>(type: T) => msgs.filter((m): m is Extract<ServerMessage, { type: T }> => m.type === type);
  const last = <T extends ServerMessage['type']>(type: T) => all(type).at(-1)!;
  return { client: c, msgs, all, last };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('app', () => {
  it('greets a client with auth, graphs and pending approvals', () => {
    const { app, client } = setup();
    app.graphStore.create('First');
    expect(client().msgs[0]).toEqual({
      type: 'hello',
      status: signedIn,
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
    expect(a.of('graphOpened')[0]).toMatchObject({ graph: { id: g.id }, runs: [{ id: runId }], run: { id: runId } });
  });

  it('exports a run report with a suggested file name, leaving out saved values and the environment', async () => {
    const { app, client } = setup(signedIn, instant, (name) => (name === 'SECRET_ENV' ? 'env-secret-xyz' : undefined));
    const a = client();
    const g = app.graphStore.create('Parity');
    app.graphStore.apply(g.id, { type: 'addVariable', name: 'schema' }, 'user');
    app.graphStore.apply(g.id, { type: 'addVariable', name: 'password' }, 'user');
    app.graphStore.apply(g.id, { type: 'addNode', node: { title: 'Build', kind: 'agent', prompt: 'Build {{ schema }}' } }, 'user');
    await app.handle(a.c, { type: 'setVariableValue', graphId: g.id, name: 'schema', value: 'dev' });
    // Saved but used by no step: it never appears in what ran, so it must not appear in the report.
    await app.handle(a.c, { type: 'setVariableValue', graphId: g.id, name: 'password', value: 'hunter2-saved' });
    await app.handle(a.c, { type: 'startRun', graphId: g.id, reviewed: (await reviewed(app, a, g.id)).signature });
    await vi.waitFor(() => expect(a.of('run').at(-1)?.run.status).toBe('succeeded'));
    const runId = a.of('run')[0].run.id;
    await app.handle(a.c, { type: 'exportRunReport', graphId: g.id, runId });
    const report = a.of('runReport')[0];
    expect(report).toMatchObject({ type: 'runReport', runId, suggestedName: `${g.id}-run-${runId}.md` });
    expect(report.markdown).toContain('# Run report: Parity');
    expect(report.markdown).toContain('### n1 · Build — Succeeded');
    expect(report.markdown).toContain('Build dev');
    expect(report.markdown).toContain('out-n1');
    expect(report.markdown).not.toContain('hunter2-saved');
    expect(report.markdown).not.toContain('env-secret-xyz');
    expect(app.runReport(g.id, runId)).toEqual({ ok: true, markdown: expect.any(String), suggestedName: report.suggestedName });
  });

  it('reports an unknown run, or a run of another graph, as an error', async () => {
    const { app, client } = setup();
    const a = client();
    const g = app.graphStore.create('G');
    app.graphStore.apply(g.id, { type: 'addNode', node: { title: 'a', kind: 'agent', prompt: 'p' } }, 'user');
    await app.handle(a.c, { type: 'exportRunReport', graphId: g.id, runId: '20261003-100000-abcd' });
    await app.handle(a.c, { type: 'exportRunReport', graphId: g.id, runId: '../../etc' });
    await app.handle(a.c, { type: 'startRun', graphId: g.id, reviewed: (await reviewed(app, a, g.id)).signature });
    await vi.waitFor(() => expect(a.of('run').at(-1)?.run.status).toBe('succeeded'));
    const runId = a.of('run')[0].run.id;
    await app.handle(a.c, { type: 'exportRunReport', graphId: 'other', runId });
    expect(a.of('error').map((m) => m.message)).toEqual(['run 20261003-100000-abcd not found', 'run ../../etc not found', `run ${runId} not found`]);
    expect(a.of('runReport')).toEqual([]);
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
    const { app, client } = setup({ provider: 'claude', ok: false, label: 'not signed in', error: 'Not signed in.' });
    const a = client();
    const g = app.graphStore.create('G');
    app.graphStore.apply(g.id, { type: 'addNode', node: { title: 'a', kind: 'agent', prompt: 'p' } }, 'user');
    await app.handle(a.c, { type: 'startRun', graphId: g.id, reviewed: (await reviewed(app, a, g.id)).signature });
    await app.handle(a.c, { type: 'chat', graphId: g.id, sessionId: 'default', text: 'hi' });
    expect(a.of('error').map((m) => m.message)).toEqual(['Runs are disabled: Not signed in.', 'Chat is disabled: Not signed in.']);
    expect(a.of('run')).toEqual([]);
  });

  it("refuses to refine steps when the provider can't run", async () => {
    const { app, client } = setup({ provider: 'claude', ok: false, label: 'not signed in', error: 'Not signed in.' });
    const a = client();
    const g = app.graphStore.create('G');
    app.graphStore.apply(g.id, { type: 'addNode', node: { title: 'a', kind: 'agent', prompt: 'p' } }, 'user');
    await app.handle(a.c, { type: 'refineSteps', graphId: g.id, sessionId: 'default', nodeIds: ['n1'] });
    expect(a.of('error').map((m) => m.message)).toEqual(['Chat is disabled: Not signed in.']);
    expect(a.of('chatEntry')).toEqual([]);
  });

  it("refuses to split a step when the provider can't run", async () => {
    const { app, client } = setup({ provider: 'claude', ok: false, label: 'not signed in', error: 'Not signed in.' });
    const a = client();
    const g = app.graphStore.create('G');
    app.graphStore.apply(g.id, { type: 'addNode', node: { title: 'a', kind: 'agent', prompt: 'p' } }, 'user');
    await app.handle(a.c, { type: 'splitStep', graphId: g.id, sessionId: 'default', nodeId: 'n1' });
    expect(a.of('error').map((m) => m.message)).toEqual(['Chat is disabled: Not signed in.']);
    expect(a.of('chatEntry')).toEqual([]);
  });

  it('checks the steps before the provider when refining (spec §6.2)', async () => {
    const { app, client } = setup({ provider: 'claude', ok: false, label: 'not signed in', error: 'Not signed in.' });
    const a = client();
    const g = app.graphStore.create('G');
    app.graphStore.apply(g.id, { type: 'addNode', node: { title: 'Only a title', kind: 'agent' } }, 'user');
    await app.handle(a.c, { type: 'refineSteps', graphId: g.id, sessionId: 'default', nodeIds: ['n1'] });
    await app.handle(a.c, { type: 'refineSteps', graphId: g.id, sessionId: 'default', nodeIds: ['n7'] });
    expect(a.of('error').map((m) => m.message)).toEqual(['Write what the step should do first.', 'node n7 does not exist']);
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
    expect(a.of('confirmRun')).toEqual([{ type: 'confirmRun', graphId: g.id, requestedBy: 'planner' }]);
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
    const app = createApp({ ...appTestDeps(), projectDir: paths.root, valuesFile: tmpValuesFile(), provider: testProvider(), status: signedIn, maxParallel: 1, executors: { agent: instant, command: instant } });
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
    const legacyValuesFile = tmpValuesFile();
    const sessions: Options[] = [];
    const provider = createClaudeProvider({
      findClaude: () => ({ ok: true, path: 'claude' }),
      checkAuth: async () => signedIn,
      queryFn: ({ options }) => {
        sessions.push(options!);
        return (async function* () {
          yield { type: 'system', subtype: 'init', apiKeySource: 'none', session_id: 's' } as unknown as SDKMessage;
          const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
          yield { type: 'result', subtype: 'success', is_error: false, result: 'ok', num_turns: 1, total_cost_usd: 0, usage, session_id: 's' } as unknown as SDKMessage;
        })();
      },
    });
    await provider.status();
    const app = createApp({
      ...appTestDeps(),
      projectDir: paths.root,
      valuesFile,
      legacyValuesFile,
      provider,
      status: signedIn,
      maxParallel: 1,
      gitBash: testGitBash,
    });
    const sent: ServerMessage[] = [];
    const c = { send: (m: ServerMessage) => void sent.push(m) };
    const g = app.graphStore.create('G');
    app.graphStore.apply(g.id, { type: 'addNode', node: { title: 'a', kind: 'agent', prompt: 'p' } }, 'user');
    await app.handle(c, { type: 'chat', graphId: g.id, sessionId: 'default', text: 'hi' });
    await vi.waitFor(() => expect(app.planner.isBusy('default', g.id)).toBe(false));
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
      const legacy = { ...read, tool_input: { file_path: legacyValuesFile } } as HookInput;
      expect(await hook(legacy, 't', { signal: new AbortController().signal })).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
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
      ...appTestDeps(),
      projectDir: paths.root,
      valuesFile: tmpValuesFile(),
      provider: testProvider({
        planTurn: async () => {
          await new Promise<void>((resolve) => (gate.release = resolve));
          return { ok: true, sessionId: 's' };
        },
      }),
      status: signedIn,
      maxParallel: 1,
      gitBash: testGitBash,
    });
    const c = { send: () => {} };
    const g = app.graphStore.create('G');
    await app.handle(c, { type: 'chat', graphId: g.id, sessionId: 'default', text: 'hi' });
    await vi.waitFor(() => expect(app.planner.isBusy('default', g.id)).toBe(true));
    expect(app.deleteGraph(g.id)).toEqual({ ok: false, error: "The planner is still working on this graph. Try again when it's done." });
    expect(app.graphStore.load(g.id).ok).toBe(true);
    gate.release();
    await vi.waitFor(() => expect(app.planner.isBusy('default', g.id)).toBe(false));
    expect(app.deleteGraph(g.id)).toEqual({ ok: true });
  });

  it('reports a missing Git Bash on Windows in the preview of graphs with command steps', async () => {
    const paths = tmpProject();
    const app = createApp({
      ...appTestDeps(),
      projectDir: paths.root,
      valuesFile: tmpValuesFile(),
      provider: testProvider(),
      status: signedIn,
      maxParallel: 1,
      platform: 'win32',
      gitBash: { ok: false, error: 'Command steps need Git Bash on Windows. Install Git for Windows, or set agentStream.gitBashPath.' },
      executors: { agent: instant, command: instant },
    });
    const msgs: ServerMessage[] = [];
    const c = { send: (m: ServerMessage) => void msgs.push(m) };
    const g = app.graphStore.create('G');
    app.graphStore.apply(g.id, { type: 'addNode', node: { title: 'b', kind: 'command', command: 'x' } }, 'user');
    await app.handle(c, { type: 'previewRun', graphId: g.id });
    const preview = msgs.find((m): m is Extract<ServerMessage, { type: 'runPreview' }> => m.type === 'runPreview')!.preview;
    expect(preview.problems).toEqual(['Command steps need Git Bash on Windows. Install Git for Windows, or set agentStream.gitBashPath.']);
  });

  describe('work sessions', () => {
    it('migrates legacy planner state and chats into the Default session on start', () => {
      const paths = tmpProject();
      writeFileSync(join(paths.graphsDir, 'g1.json'), JSON.stringify({ id: 'g1', name: 'G', goal: '', instructions: '', variables: [], nodes: [], edges: [], nodeSeq: 0, updatedAt: 't', plannerSessionId: 's', plannerOpCursor: 2 }));
      writeFileSync(join(paths.graphsDir, 'g1.chat.jsonl'), `${JSON.stringify({ at: 't', role: 'user', text: 'old' })}\n`);
      const app = createApp({ ...appTestDeps(), projectDir: paths.root, valuesFile: tmpValuesFile(), provider: testProvider(), status: signedIn, maxParallel: 1 });
      expect(app.sessionStore.plannerState('default', 'g1')).toEqual({ sessionId: 's', provider: 'claude', opCursor: 2 });
      expect(app.sessionStore.chatLog('default').read('g1').map((e) => e.text)).toEqual(['old']);
      expect(app.startupWarnings()).toEqual([]);
    });

    it('sends each chat only to the clients subscribed to that conversation', async () => {
      const { app, graphId } = setupWithGraph();
      app.createSession('B');
      const a = client(app),
        b = client(app);
      await app.handle(a.client, { type: 'openChat', graphId, sessionId: 'default' });
      await app.handle(b.client, { type: 'openChat', graphId, sessionId: 'b' });
      expect(a.last('chatOpened')).toEqual({ type: 'chatOpened', graphId, sessionId: 'default', chat: [], busy: false });
      await app.handle(a.client, { type: 'chat', graphId, sessionId: 'default', text: 'hello' });
      await flush();
      expect(a.all('chatEntry').map((m) => m.entry.text)).toContain('hello');
      expect(b.all('chatEntry')).toEqual([]);
    });

    it('refines steps as a planner turn: short line in the chat, full instruction to the provider', async () => {
      const seen: PlannerTurn[] = [];
      const { app, graphId } = setupWithGraph({ provider: testProvider({ planTurn: async (t) => (seen.push(t), { ok: true }) }) });
      app.graphStore.apply(graphId, { type: 'addNode', node: { id: 'n1', title: 'Compare', kind: 'agent', prompt: 'compare the two tables' } }, 'user');
      const c = client(app);
      await app.handle(c.client, { type: 'openChat', graphId, sessionId: 'default' });
      await app.handle(c.client, { type: 'refineSteps', graphId, sessionId: 'default', nodeIds: ['n1'] });
      await flush();
      expect(c.all('chatEntry').map((m) => m.entry).find((e) => e.role === 'user')?.text).toBe('Refine n1');
      expect(seen[0].prompt).toContain(refineRequest(['n1']).prompt);
    });

    it('refuses to refine unknown sessions, missing steps and title-only steps', async () => {
      const { app, graphId } = setupWithGraph();
      app.graphStore.apply(graphId, { type: 'addNode', node: { id: 'n1', title: 'Only a title', kind: 'agent' } }, 'user');
      const c = client(app);
      await app.handle(c.client, { type: 'refineSteps', graphId, sessionId: 'nope', nodeIds: ['n1'] });
      await app.handle(c.client, { type: 'refineSteps', graphId, sessionId: 'default', nodeIds: ['n9'] });
      await app.handle(c.client, { type: 'refineSteps', graphId, sessionId: 'default', nodeIds: ['n1'] });
      expect(c.all('error').map((m) => m.message)).toEqual(['session "nope" not found', 'node n9 does not exist', 'Write what the step should do first.']);
    });

    it('splits a step as a planner turn: short line in the chat, full instruction to the provider', async () => {
      const seen: PlannerTurn[] = [];
      const { app, graphId } = setupWithGraph({ provider: testProvider({ planTurn: async (t) => (seen.push(t), { ok: true }) }) });
      app.graphStore.apply(graphId, { type: 'addNode', node: { id: 'n3', title: 'Checks', kind: 'agent', prompt: 'check a and check b' } }, 'user');
      const c = client(app);
      await app.handle(c.client, { type: 'openChat', graphId, sessionId: 'default' });
      await app.handle(c.client, { type: 'splitStep', graphId, sessionId: 'default', nodeId: 'n3' });
      await flush();
      expect(c.all('chatEntry').map((m) => m.entry).find((e) => e.role === 'user')?.text).toBe('Split n3');
      expect(seen[0].prompt).toContain(splitRequest('n3').prompt);
    });

    it('refuses to split unknown graphs, sessions, missing steps, title-only steps and a disabled provider', async () => {
      const { app, graphId } = setupWithGraph();
      app.graphStore.apply(graphId, { type: 'addNode', node: { id: 'n1', title: 'Only a title', kind: 'agent' } }, 'user');
      const c = client(app);
      await app.handle(c.client, { type: 'splitStep', graphId: 'nope', sessionId: 'default', nodeId: 'n1' });
      await app.handle(c.client, { type: 'splitStep', graphId, sessionId: 'nope', nodeId: 'n1' });
      await app.handle(c.client, { type: 'splitStep', graphId, sessionId: 'default', nodeId: 'n9' });
      await app.handle(c.client, { type: 'splitStep', graphId, sessionId: 'default', nodeId: 'n1' });
      const errors = c.all('error').map((m) => m.message);
      expect(errors.slice(1)).toEqual(['session "nope" not found', 'node n9 does not exist', 'Write what the step should do first.']);
      expect(errors).toHaveLength(4);
    });

    it('refuses chat for an unknown session, and cleans every session when a graph is deleted', async () => {
      const { app, graphId } = setupWithGraph();
      const a = client(app);
      await app.handle(a.client, { type: 'chat', graphId, sessionId: 'nope', text: 'x' });
      expect(a.last('error')).toEqual({ type: 'error', message: 'session "nope" not found' });
      app.saveSessionTabs('default', [{ graphId, group: 1, index: 0 }], graphId);
      const other = app.createSession('Other');
      app.sessionStore.chatLog(other.id).append(graphId, { at: 't', role: 'user', text: 'hi' });
      app.sessionStore.setPlannerState(other.id, graphId, { sessionId: 's', provider: 'claude', opCursor: 1 });
      expect(app.deleteGraph(graphId)).toEqual({ ok: true });
      expect(app.sessionStore.get('default').tabs).toEqual([]);
      expect(app.sessionStore.chatLog(other.id).read(graphId)).toEqual([]);
      expect(app.sessionStore.plannerState(other.id, graphId)).toEqual({});
    });

    it('broadcasts a duplicated session once, with the tabs it copied', () => {
      const { app, graphId } = setupWithGraph();
      const second = app.createGraph('H').id;
      const b = app.createSession('B');
      app.saveSessionTabs(b.id, [{ graphId, group: 1, index: 0 }, { graphId: second, group: 1, index: 1 }], graphId);
      const watcher = client(app);
      const before = watcher.all('sessions').length;
      const copy = app.duplicateSession(b.id);
      if (!copy.ok) throw new Error(copy.error);
      expect(watcher.all('sessions')).toHaveLength(before + 1);
      expect(watcher.last('sessions').sessions.find((x) => x.id === copy.session.id)).toMatchObject({ name: 'B copy', tabCount: 2 });
    });

    it('shows an unreadable chat as empty with a warning, and leaves the file alone', async () => {
      const { app, graphId, paths } = setupWithGraph();
      const a = client(app);
      // A folder where the chat file should be: reading it fails.
      const chatPath = join(paths.sessionsDir, 'default', 'chats', `${graphId}.chat.jsonl`);
      mkdirSync(join(chatPath, 'inside'), { recursive: true });
      await app.handle(a.client, { type: 'openChat', graphId, sessionId: 'default' });
      expect(a.msgs.slice(-2)).toEqual([
        { type: 'chatOpened', graphId, sessionId: 'default', chat: [], busy: false },
        {
          type: 'error',
          message: expect.stringMatching(new RegExp(`^The planner chat for ${graphId} in this session could not be read \\(.+\\); it shows as empty and the file is left untouched\\.$`)),
        },
      ]);
      expect(statSync(chatPath).isDirectory()).toBe(true);
      expect(readdirSync(chatPath)).toEqual(['inside']);
    });

    it('still reports a deleted graph when cleaning the sessions fails', () => {
      const { app, graphId } = setupWithGraph();
      const a = client(app);
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
      const failure = new Error('EACCES: permission denied');
      const removeGraph = vi.spyOn(app.sessionStore, 'removeGraph').mockImplementation(() => {
        throw failure;
      });
      try {
        expect(app.deleteGraph(graphId)).toEqual({ ok: true });
        expect(a.all('graphDeleted')).toEqual([{ type: 'graphDeleted', graphId }]);
        expect(a.last('graphs').graphs).toEqual([]);
        expect(logged).toHaveBeenCalledWith('[agent-stream] could not clean sessions', failure);
      } finally {
        logged.mockRestore();
        removeGraph.mockRestore();
      }
    });

    it('broadcasts the session list on every change, and refuses to delete a session whose planner is busy', async () => {
      const held = deferred<PlannerTurnResult>();
      const { app, graphId } = setupWithGraph({ provider: testProvider({ planTurn: () => held.promise }) });
      const watcher = client(app);
      const b = app.createSession('B');
      expect(app.renameSession(b.id, 'Bee')).toMatchObject({ ok: true });
      const copy = app.duplicateSession(b.id);
      expect(copy).toMatchObject({ ok: true });
      expect(watcher.all('sessions').map((m) => m.sessions.map((s) => s.name).sort())).toEqual([
        ['Default'], // on connect
        ['B', 'Default'],
        ['Bee', 'Default'],
        ['Bee', 'Bee copy', 'Default'],
      ]);
      await app.handle(watcher.client, { type: 'chat', graphId, sessionId: b.id, text: 'slow' });
      await flush();
      expect(app.deleteSession(b.id)).toEqual({ ok: false, error: "The planner is still working in this session. Try again when it's done." });
      held.resolve({ ok: true });
      await flush();
      expect(app.deleteSession(b.id)).toEqual({ ok: true });
      expect(watcher.last('sessions').sessions.map((s) => s.id).sort()).toEqual(['bee-copy', 'default']);
    });

    it('sends the session list right after hello, and starts a new chat only for its own subscribers', async () => {
      const { app, graphId } = setupWithGraph();
      app.createSession('B');
      const a = client(app),
        b = client(app);
      expect(a.msgs.slice(0, 2).map((m) => m.type)).toEqual(['hello', 'sessions']);
      await app.handle(a.client, { type: 'openChat', graphId, sessionId: 'default' });
      await app.handle(b.client, { type: 'openChat', graphId, sessionId: 'b' });
      await app.handle(a.client, { type: 'chat', graphId, sessionId: 'default', text: 'hello' });
      await flush();
      await app.handle(a.client, { type: 'newChat', graphId, sessionId: 'default' });
      expect(a.last('chatOpened')).toEqual({ type: 'chatOpened', graphId, sessionId: 'default', chat: [], busy: false });
      expect(app.sessionStore.chatLog('default').read(graphId)).toEqual([]);
      expect(b.all('chatOpened')).toHaveLength(1);
      await app.handle(a.client, { type: 'newChat', graphId, sessionId: 'nope' });
      expect(a.last('error')).toEqual({ type: 'error', message: 'session "nope" not found' });
    });
  });

    it('stops the running planner turn of the conversation stopPlanner names', async () => {
      const seen: PlannerTurn[] = [];
      const provider = testProvider({
        planTurn: (t) => {
          seen.push(t);
          return new Promise<PlannerTurnResult>((resolve) => t.signal.addEventListener('abort', () => resolve({ ok: true, sessionId: 's1', error: 'cancelled' }), { once: true }));
        },
      });
      const { app, graphId } = setupWithGraph({ provider });
      app.createSession('B');
      const a = client(app);
      await app.handle(a.client, { type: 'openChat', graphId, sessionId: 'default' });
      await app.handle(a.client, { type: 'chat', graphId, sessionId: 'default', text: 'plan' });
      await app.handle(a.client, { type: 'chat', graphId, sessionId: 'b', text: 'plan' });
      await flush();
      expect(seen).toHaveLength(2);
      await app.handle(a.client, { type: 'stopPlanner', graphId, sessionId: 'default' });
      await flush();
      expect(seen.map((t) => t.signal.aborted)).toEqual([true, false]);
      expect(a.last('chatBusy')).toEqual({ type: 'chatBusy', graphId, sessionId: 'default', busy: false });
      expect(a.last('chatEntry').entry).toMatchObject({ role: 'note', text: 'Stopped.' });
      expect(a.all('error')).toEqual([]);
      await app.handle(a.client, { type: 'stopPlanner', graphId, sessionId: 'b' });
      await flush();
    });

  describe('for the extension', () => {
    it('lists the variant workspaces of its runs, newest first, and marks one removed', () => {
      const { app, graphId, paths } = setupWithGraph();
      const run = (id: string, workspaces: RunMeta['workspaces'], checkout?: RunMeta['checkout']): RunMeta => ({
        id,
        graphId,
        status: 'succeeded',
        startedAt: 't',
        snapshot: emptyGraph(graphId, 'G', 't'),
        nodes: {},
        workspaces,
        ...(checkout && { checkout }),
      });
      app.runStore.create(run('20261003-100000-aaaa', { wh_a: { path: 'wt-a', head: 'h' } }));
      app.runStore.create(run('20261003-110000-bbbb', { wh_b: { path: 'wt-b', head: 'h' }, wh_c: { path: 'wt-c', head: 'h', removed: true } }, { root: 'repo', linkedWorktree: false }));
      expect(app.runWorkspaces()).toEqual([
        { runId: '20261003-110000-bbbb', graphId, graphName: 'G', name: 'wh_b', path: 'wt-b', head: 'h', checkoutRoot: 'repo', running: false },
        { runId: '20261003-100000-aaaa', graphId, graphName: 'G', name: 'wh_a', path: 'wt-a', head: 'h', checkoutRoot: paths.root, running: false },
      ]);
      expect(app.markWorkspaceRemoved('20261003-100000-aaaa', 'wh_a')).toEqual({ ok: true });
      expect(app.runStore.get('20261003-100000-aaaa')?.workspaces?.wh_a).toEqual({ path: 'wt-a', head: 'h', removed: true });
      expect(app.runWorkspaces().map((w) => w.name)).toEqual(['wh_b']);
      expect(app.markWorkspaceRemoved('20261003-100000-aaaa', 'nope')).toEqual({ ok: false, error: 'Run 20261003-100000-aaaa has no workspace "nope".' });
    });
    it('changes the provider and its sign-in state at runtime', async () => {
      const { app, client } = setup({ provider: 'claude', ok: false, label: 'not signed in', error: 'Not signed in.' });
      const a = client();
      const g = app.graphStore.create('G');
      app.graphStore.apply(g.id, { type: 'addNode', node: { title: 'a', kind: 'agent', prompt: 'p' } }, 'user');
      const sig = (await reviewed(app, a, g.id)).signature;
      await app.handle(a.c, { type: 'startRun', graphId: g.id, reviewed: sig });
      expect(a.of('error').at(-1)?.message).toBe('Runs are disabled: Not signed in.');
      const next = testProvider();
      app.setProvider(next, signedIn);
      expect(a.of('auth')).toEqual([{ type: 'auth', status: signedIn }]);
      expect(app.provider()).toBe(next);
      expect(app.status()).toEqual(signedIn);
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

    it('a run keeps the provider it started with', async () => {
      const first = { gate: deferred<void>(), ran: [] as string[] };
      const a = testProvider({
        id: 'claude',
        runStep: async (ctx) => {
          first.ran.push(`a:${ctx.node.id}`);
          await first.gate.promise;
          return { ok: true, output: '' };
        },
      });
      const b = testProvider({
        id: 'copilot',
        name: 'GitHub Copilot',
        runStep: async (ctx) => {
          first.ran.push(`b:${ctx.node.id}`);
          return { ok: true, output: '' };
        },
      });
      // No executors override: agent steps run on the App's provider.
      const { app, client } = setup(signedIn, instant, undefined, { provider: a, executors: undefined });
      const c = client();
      const g = app.graphStore.create('G');
      app.graphStore.apply(g.id, { type: 'addNode', node: { title: 'one', kind: 'agent', prompt: 'p1' } }, 'user');
      app.graphStore.apply(g.id, { type: 'addNode', node: { title: 'two', kind: 'agent', prompt: 'p2' } }, 'user');
      app.graphStore.apply(g.id, { type: 'connect', from: 'n1', to: 'n2' }, 'user');
      const finished = async (runId: string): Promise<RunMeta> => {
        await vi.waitFor(() => expect(c.of('run').filter((m) => m.run.id === runId).at(-1)?.run.status).toBe('succeeded'));
        return c.of('run').filter((m) => m.run.id === runId).at(-1)!.run;
      };

      await app.handle(c.c, { type: 'startRun', graphId: g.id, reviewed: (await reviewed(app, c, g.id)).signature });
      const runId = c.of('run')[0].run.id;
      await vi.waitFor(() => expect(first.ran).toEqual(['a:n1']));
      // n1 is waiting inside provider a: swap providers mid-run, then let it finish.
      app.setProvider(b, { provider: 'copilot', ok: true, label: 'Copilot' });
      first.gate.resolve();
      const run = await finished(runId);
      expect(first.ran).toEqual(['a:n1', 'a:n2']);
      expect(run.provider).toBe('claude');

      // The swap did happen: the next run starts on provider b.
      await app.handle(c.c, { type: 'startRun', graphId: g.id, reviewed: (await reviewed(app, c, g.id)).signature });
      const nextId = c.of('run').filter((m) => m.run.id !== runId)[0].run.id;
      const next = await finished(nextId);
      expect(first.ran).toEqual(['a:n1', 'a:n2', 'b:n1', 'b:n2']);
      expect(next.provider).toBe('copilot');
      expect(Object.fromEntries(app.runStore.list(g.id).map((r) => [r.id, r.provider]))).toEqual({ [runId]: 'claude', [nextId]: 'copilot' });
    });

    describe('migrating the old names', () => {
      const mk = (extra: Partial<Parameters<typeof createApp>[0]> = {}) => {
        const root = mkdtempSync(join(tmpdir(), 'agent-stream-mig-'));
        const base = { ...appTestDeps(), projectDir: root, valuesFile: tmpValuesFile(), provider: testProvider(), status: signedIn, maxParallel: 1, executors: { agent: instant, command: instant } };
        return { root, make: () => createApp({ ...base, ...extra }) };
      };

      it('moves .claude-stream to .agent-stream so the graphs still list', () => {
        const { root, make } = mk();
        const old = join(root, '.claude-stream');
        mkdirSync(join(old, 'graphs'), { recursive: true });
        writeFileSync(join(old, 'graphs', 'g1.json'), JSON.stringify(emptyGraph('g1', 'Old graph', '2026-10-02T00:00:00.000Z')));
        const app = make();
        expect(existsSync(old)).toBe(false);
        expect(app.graphStore.list().map((g) => g.id)).toEqual(['g1']);
        expect(app.startupWarnings()).toEqual([]);
      });

      it('warns and uses .agent-stream when both folders exist', () => {
        const { root, make } = mk();
        mkdirSync(join(root, '.claude-stream'));
        mkdirSync(join(root, '.agent-stream'));
        expect(make().startupWarnings()).toEqual([expect.stringContaining('Found both .agent-stream and an older .claude-stream folder')]);
        expect(existsSync(join(root, '.claude-stream'))).toBe(true);
      });

      it('warns, and still starts on the new folder, when the rename fails', () => {
        const { root, make } = mk({
          rename: () => {
            throw new Error('EBUSY: locked');
          },
        });
        mkdirSync(join(root, '.claude-stream'));
        const app = make();
        expect(app.startupWarnings()).toEqual([expect.stringContaining('EBUSY: locked')]);
        expect(existsSync(join(root, '.agent-stream', 'graphs'))).toBe(true);
      });

      it('moves the legacy values file to the new one', () => {
        const home = mkdtempSync(join(tmpdir(), 'agent-stream-home-'));
        const legacyValuesFile = join(home, '.claude-stream', 'values', 'h.json');
        const valuesFile = join(home, '.agent-stream', 'values', 'h.json');
        mkdirSync(dirname(legacyValuesFile), { recursive: true });
        writeFileSync(legacyValuesFile, JSON.stringify({ version: 1, graphs: { g1: { schema: 'dev' } } }));
        const { make } = mk({ valuesFile, legacyValuesFile });
        const app = make();
        expect(existsSync(legacyValuesFile)).toBe(false);
        expect(app.startupWarnings()).toEqual([]);
        expect(JSON.parse(readFileSync(valuesFile, 'utf8')).graphs.g1).toEqual({ schema: 'dev' });
      });
    });

    it('reports an unreadable local values file once at startup', () => {
      const paths = tmpProject();
      const valuesFile = tmpValuesFile();
      writeFileSync(valuesFile, '{');
      const app = createApp({ ...appTestDeps(), projectDir: paths.root, valuesFile, provider: testProvider(), status: signedIn, maxParallel: 1, executors: { agent: instant, command: instant } });
      expect(app.startupWarnings()).toEqual([expect.stringMatching(/^The variable values file \(.+\) could not be read/)]);
    });
  });

  describe('agent changes', () => {
    const planner = { kind: 'planner', sessionId: 'default' } as const;

    it('opens a graph with its agent changes and baseline, and broadcasts new changes', async () => {
      const { app, client } = setup();
      const a = client();
      const g = app.graphStore.create('G');
      app.graphStore.apply(g.id, { type: 'addNode', node: { title: 'a', kind: 'agent', prompt: 'p' } }, 'user');
      await app.handle(a.c, { type: 'openGraph', graphId: g.id });
      expect(a.of('graphOpened').at(-1)?.changes).toEqual([]);
      expect(a.of('graphOpened').at(-1)).not.toHaveProperty('baseline');
      app.graphStore.apply(g.id, { type: 'updateNode', id: 'n1', patch: { prompt: 'agent prompt' } }, 'agent', planner);
      const change = { kind: 'node', change: 'changed', id: 'n1', title: 'a', fields: ['prompt'], by: planner, at: expect.any(String) };
      expect(a.of('graph').at(-1)).toMatchObject({ graph: { nodes: [{ prompt: 'agent prompt' }] }, baseline: { nodes: [{ prompt: 'p' }] } });
      expect(a.of('graph').at(-1)?.changes).toEqual([change]);
      await app.handle(a.c, { type: 'openGraph', graphId: g.id });
      expect(a.of('graphOpened').at(-1)).toMatchObject({ baseline: { nodes: [{ prompt: 'p' }] } });
      expect(a.of('graphOpened').at(-1)?.changes).toEqual([change]);
      expect(app.listGraphs()).toEqual([{ id: g.id, name: 'G', updatedAt: expect.any(String), agentChanges: 1 }]);
      await app.handle(a.c, { type: 'op', graphId: g.id, op: { type: 'acceptChange', target: { kind: 'node', id: 'n1' } } });
      expect(a.of('graph').at(-1)?.changes).toEqual([]);
      expect(a.of('graph').at(-1)).not.toHaveProperty('baseline');
    });

    it('refuses to revert a step of a run in progress', async () => {
      const waiting: (() => void)[] = [];
      const releaseAll = () => waiting.splice(0).forEach((release) => release());
      const { app, client } = setup(signedIn, () => new Promise((resolve) => waiting.push(() => resolve({ ok: true, output: '' }))));
      const a = client();
      const g = app.graphStore.create('G');
      app.graphStore.apply(g.id, { type: 'addNode', node: { title: 'build', kind: 'command', command: 'x' } }, 'user');
      app.graphStore.apply(g.id, { type: 'addNode', node: { title: 'test', kind: 'command', command: 'y' } }, 'user');
      app.graphStore.apply(g.id, { type: 'connect', from: 'n1', to: 'n2' }, 'user');
      app.graphStore.apply(g.id, { type: 'addNode', node: { title: 'lint', kind: 'command', command: 'z' } }, 'user');
      await app.handle(a.c, { type: 'startRun', graphId: g.id, reviewed: (await reviewed(app, a, g.id)).signature });
      await vi.waitFor(() => expect(app.runner.activeFor(g.id)?.nodes.n1.status).toBe('running'));
      expect(app.runner.activeFor(g.id)?.nodes.n2.status).toBe('queued');
      app.graphStore.apply(g.id, { type: 'updateNode', id: 'n1', patch: { command: 'x2' } }, 'agent', planner);
      app.graphStore.apply(g.id, { type: 'updateNode', id: 'n2', patch: { command: 'y2' } }, 'agent', planner);
      app.graphStore.apply(g.id, { type: 'connect', from: 'n2', to: 'n3' }, 'agent', planner);
      app.graphStore.apply(g.id, { type: 'addNode', node: { title: 'later', kind: 'command', command: 'w' } }, 'agent', planner);
      const revert = (target: { kind: 'node'; id: string } | { kind: 'edge'; id: string } | { kind: 'all' }) =>
        app.handle(a.c, { type: 'op', graphId: g.id, op: { type: 'revertChange', target } });
      await revert({ kind: 'node', id: 'n1' });
      await revert({ kind: 'node', id: 'n2' });
      await revert({ kind: 'edge', id: 'n2->n3' });
      await revert({ kind: 'all' });
      expect(a.of('opRejected')).toEqual(Array(4).fill({ type: 'opRejected', graphId: g.id, error: 'Stop the run first.' }));
      expect(app.graphStore.get(g.id).nodes.map((n) => n.command)).toEqual(['x2', 'y2', 'z', 'w']);
      // A step the run doesn't include can be reverted meanwhile; accepting is always allowed.
      await revert({ kind: 'node', id: 'n4' });
      await app.handle(a.c, { type: 'op', graphId: g.id, op: { type: 'acceptChange', target: { kind: 'node', id: 'n2' } } });
      expect(a.of('opRejected')).toHaveLength(4);
      expect(app.graphStore.agentChanges(g.id).map((c) => c.id)).toEqual(['n1', 'n2->n3']);
      // build (n1) and lint (n3) can both change files, so they take turns (spec §4.3); test (n2) follows build.
      releaseAll();
      await vi.waitFor(() => expect(app.runner.activeFor(g.id)?.nodes.n3.status).toBe('running'));
      releaseAll();
      await vi.waitFor(() => expect(app.runner.activeFor(g.id)?.nodes.n2.status).toBe('running'));
      releaseAll();
      await vi.waitFor(() => expect(app.runner.activeFor(g.id)).toBeUndefined());
      await revert({ kind: 'all' });
      expect(a.of('opRejected')).toHaveLength(4);
      expect(app.graphStore.agentChanges(g.id)).toEqual([]);
    });

    it('re-broadcasts the graphs list when an edit changes the number of agent changes', () => {
      const { app, client } = setup();
      const a = client();
      const g = app.graphStore.create('G');
      app.graphStore.apply(g.id, { type: 'addNode', node: { title: 'a', kind: 'agent', prompt: 'p' } }, 'user');
      const lists = () => a.of('graphs').length;
      let seen = lists();
      app.graphStore.apply(g.id, { type: 'updateNode', id: 'n1', patch: { prompt: 'agent prompt' } }, 'agent', planner);
      expect(lists()).toBe(seen + 1);
      expect(a.of('graphs').at(-1)?.graphs[0].agentChanges).toBe(1);
      seen = lists();
      // Same count: no new list.
      app.graphStore.apply(g.id, { type: 'updateNode', id: 'n1', patch: { prompt: 'agent prompt 2' } }, 'agent', planner);
      expect(lists()).toBe(seen);
      app.graphStore.apply(g.id, { type: 'addNode', node: { title: 'b', kind: 'agent', prompt: 'q' } }, 'agent', planner);
      expect(lists()).toBe(seen + 1);
      expect(a.of('graphs').at(-1)?.graphs[0].agentChanges).toBe(2);
      app.graphStore.apply(g.id, { type: 'acceptChange', target: { kind: 'all' } }, 'user');
      expect(lists()).toBe(seen + 2);
      expect(a.of('graphs').at(-1)?.graphs[0]).not.toHaveProperty('agentChanges');
    });

    it('gives agent steps the add_step and change_step tools, approved by themselves', async () => {
      const seen: { tools: string[]; selfApproving: boolean[] }[] = [];
      const provider = testProvider({
        runStep: async (ctx, gate) => {
          const tools = (ctx.graphTools ?? []).map((t) => t.name);
          seen.push({ tools, selfApproving: [...tools.map((t) => gate.isSelfApproving(`mcp__run_graph__${t}`)), gate.isSelfApproving('Bash')] });
          return { ok: true, output: '' };
        },
      });
      const { app, client } = setup(signedIn, instant, undefined, { provider, executors: undefined });
      const c = client();
      const g = app.graphStore.create('G');
      app.graphStore.apply(g.id, { type: 'addNode', node: { title: 'one', kind: 'agent', prompt: 'p1' } }, 'user');
      await app.handle(c.c, { type: 'startRun', graphId: g.id, reviewed: (await reviewed(app, c, g.id)).signature });
      await vi.waitFor(() => expect(c.of('run').at(-1)?.run.status).toBe('succeeded'));
      expect(seen).toEqual([{ tools: ['add_step', 'change_step'], selfApproving: [true, true, false] }]);
    });

    it('gives a read-only step no graph tools and a gate that refuses edits without asking', async () => {
      const seen: { tools: string[]; decision: unknown }[] = [];
      const provider = testProvider({
        runStep: async (ctx, gate) => {
          seen.push({ tools: (ctx.graphTools ?? []).map((t) => t.name), decision: await gate.decide('Edit', { file_path: join(ctx.cwd, 'a.ts') }) });
          return { ok: true, output: '' };
        },
      });
      const { app, client } = setup(signedIn, instant, undefined, { provider, executors: undefined });
      const c = client();
      const g = app.graphStore.create('G');
      app.graphStore.apply(g.id, { type: 'addNode', node: { title: 'look', kind: 'agent', prompt: 'p', access: 'read' } }, 'user');
      await app.handle(c.c, { type: 'startRun', graphId: g.id, reviewed: (await reviewed(app, c, g.id)).signature });
      await vi.waitFor(() => expect(c.of('run').at(-1)?.run.status).toBe('succeeded'));
      expect(seen).toEqual([
        { tools: [], decision: { allow: false, reason: 'This step is read-only, so Edit isn\'t allowed. Mark the step "Can edit files" if it needs to change something.' } },
      ]);
      expect(app.broker.pending()).toEqual([]);
    });

    it('fills in a step agent\'s change with the graph\'s values before asking', async () => {
      const held = deferred<void>();
      let tools: import('../src/providers/types').GraphTool[] = [];
      const prompts: Record<string, string | undefined> = {};
      const provider = testProvider({
        runStep: async (ctx) => {
          prompts[ctx.node.id] = ctx.node.prompt;
          if (ctx.node.id === 'n1') {
            tools = ctx.graphTools ?? [];
            await held.promise;
          }
          return { ok: true, output: '' };
        },
      });
      const { app, client } = setup(signedIn, instant, undefined, { provider, executors: undefined });
      const c = client();
      const g = app.graphStore.create('G');
      app.graphStore.apply(g.id, { type: 'addVariable', name: 'target' }, 'user');
      app.graphStore.apply(g.id, { type: 'addNode', node: { title: 'one', kind: 'agent', prompt: 'p1' } }, 'user');
      app.graphStore.apply(g.id, { type: 'addNode', node: { title: 'two', kind: 'agent', prompt: 'p2' } }, 'user');
      app.graphStore.apply(g.id, { type: 'connect', from: 'n1', to: 'n2' }, 'user');
      await app.handle(c.c, { type: 'setVariableValue', graphId: g.id, name: 'target', value: 'dev' });
      await app.handle(c.c, { type: 'startRun', graphId: g.id, reviewed: (await reviewed(app, c, g.id)).signature });
      await vi.waitFor(() => expect(tools).toHaveLength(2));
      const change = tools.find((t) => t.name === 'change_step')!;
      expect(await change.run({ id: 'n2', prompt: 'Deploy to {{ nope }}' })).toMatchObject({ isError: true, text: expect.stringContaining('nope') });
      expect(c.of('approvals').at(-1)?.approvals ?? []).toEqual([]);
      const pending = change.run({ id: 'n2', prompt: 'Deploy to {{ target }}' });
      await vi.waitFor(() => expect(c.of('approvals').at(-1)?.approvals).toHaveLength(1));
      const [request] = c.of('approvals').at(-1)!.approvals;
      expect(request.graphChange).toEqual({ summary: "n1 wants to change n2's prompt", detail: 'Title: two\n\nPrompt:\nDeploy to dev' });
      await app.handle(c.c, { type: 'decide', approvalId: request.id, decision: 'approve' });
      expect(await pending).toEqual({ text: "Applied: n1 wants to change n2's prompt" });
      held.resolve();
      await vi.waitFor(() => expect(c.of('run').at(-1)?.run.status).toBe('succeeded'));
      const run = c.of('run').at(-1)!.run;
      expect(run.rendered!.nodes.n2).toBe('Deploy to dev');
      expect(prompts.n2).toBe('Deploy to dev');
      expect(run.amendments).toEqual([{ at: expect.any(String), byNodeId: 'n1', nodeId: 'n2', summary: "n1 wants to change n2's prompt" }]);
      expect(app.graphStore.get(g.id).nodes.find((n) => n.id === 'n2')!.prompt).toBe('Deploy to {{ target }}');
    });

    it("adds the run preview's warnings to a step agent's change", async () => {
      const held = deferred<void>();
      let tools: import('../src/providers/types').GraphTool[] = [];
      const provider = testProvider({
        runStep: async (ctx) => {
          if (ctx.node.id === 'n1') {
            tools = ctx.graphTools ?? [];
            await held.promise;
          }
          return { ok: true, output: '' };
        },
      });
      const env = (name: string) => (name === 'API_TOKEN' ? 'secret-value' : undefined);
      const { app, client } = setup(signedIn, instant, env, { provider, executors: undefined });
      const c = client();
      const g = app.graphStore.create('G');
      app.graphStore.apply(g.id, { type: 'addNode', node: { title: 'one', kind: 'agent', prompt: 'p1' } }, 'user');
      app.graphStore.apply(g.id, { type: 'addNode', node: { title: 'two', kind: 'agent', prompt: 'p2' } }, 'user');
      app.graphStore.apply(g.id, { type: 'connect', from: 'n1', to: 'n2' }, 'user');
      await app.handle(c.c, { type: 'startRun', graphId: g.id, reviewed: (await reviewed(app, c, g.id)).signature });
      await vi.waitFor(() => expect(tools).toHaveLength(2));
      void tools.find((t) => t.name === 'change_step')!.run({ id: 'n2', prompt: "Use {{ env_var('API_TOKEN') }}" });
      await vi.waitFor(() => expect(app.broker.pending()).toHaveLength(1));
      const { detail } = app.broker.pending()[0].graphChange!;
      expect(detail).toMatch(/^Title: two\n\nPrompt:\nUse secret-value\n\nWarnings:\n- `API_TOKEN` looks like a credential\./);
      app.runner.stop(app.runner.activeFor(g.id)!.id);
      held.resolve();
    });

    it('warns at startup about a baseline it cannot read', () => {
      const paths = tmpProject();
      writeFileSync(join(paths.graphsDir, 'g1.json'), JSON.stringify(emptyGraph('g1', 'G', 't')));
      writeFileSync(join(paths.graphsDir, 'g1.baseline.json'), '{ nope');
      const app = createApp({ ...appTestDeps(), projectDir: paths.root, valuesFile: tmpValuesFile(), provider: testProvider(), status: signedIn, maxParallel: 1 });
      expect(app.startupWarnings()).toEqual([expect.stringMatching(/^The agent-change baseline .+g1\.baseline\.json could not be read \(/)]);
      expect(app.listGraphs().map((g) => g.id)).toEqual(['g1']);
    });
  });
});

describe('the checkout and the write lease', () => {
  const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
  const held = (gate: { promise: Promise<void> }): NodeExecutor => async () => {
    await gate.promise;
    return { ok: true, output: '' };
  };
  /** An App on `projectDir` (a fresh folder by default) whose fake git is built for its real path. */
  function gitApp(o: { git?: (root: string) => GitExec; leases?: WriteLeases; projectDir?: string; over?: Partial<AppDeps> } = {}) {
    const projectDir = o.projectDir ?? tmpProject().root;
    const root = realpathSync(projectDir);
    const deps = appTestDeps();
    const leases = o.leases ?? deps.leases;
    const app = createApp({
      ...deps,
      leases,
      projectDir,
      valuesFile: tmpValuesFile(),
      provider: testProvider(),
      status: signedIn,
      maxParallel: 2,
      gitBash: testGitBash,
      executors: { agent: instant, command: instant },
      git: o.git ? o.git(root) : noGit,
      ...o.over,
    });
    return { app, root, projectDir, home: deps.home, leases };
  }
  const main = (root: string) => repoGit({ root, branch: 'main', head: SHA }).exec;
  async function reviewedBy(app: App, c: ReturnType<typeof client>, graphId: string) {
    await app.handle(c.client, { type: 'previewRun', graphId });
    return c.last('runPreview').preview;
  }
  function graphWith(app: App, name: string, ...nodes: Op[]) {
    const g = app.graphStore.create(name);
    for (const op of nodes) app.graphStore.apply(g.id, op, 'user');
    return g;
  }
  const writer: Op = { type: 'addNode', node: { title: 'edit', kind: 'agent', prompt: 'p' } };

  it('sends the checkout after hello and when asked', async () => {
    const { app, root } = gitApp({ git: main });
    const c = client(app);
    expect(c.msgs.slice(0, 2).map((m) => m.type)).toEqual(['hello', 'sessions']);
    await vi.waitFor(() => expect(c.all('checkout')).toHaveLength(1));
    expect(c.last('checkout')).toEqual({
      type: 'checkout',
      info: { git: true, root, linkedWorktree: false, branch: 'main', head: SHA, dirty: false, worktrees: [{ path: root, branch: 'main', head: SHA, current: true }] },
    });
    await app.handle(c.client, { type: 'inspectCheckout' });
    expect(c.all('checkout')).toHaveLength(2);
  });

  it('records where a run ran, and announces the checkout when the run starts and ends', async () => {
    const gate = deferred<void>();
    const { app, root } = gitApp({ git: main, over: { executors: { agent: held(gate), command: held(gate) } } });
    const c = client(app);
    await vi.waitFor(() => expect(c.all('checkout')).toHaveLength(1));
    const g = graphWith(app, 'G', writer);
    const preview = await reviewedBy(app, c, g.id);
    expect(preview.checkout).toMatchObject({ git: true, root, branch: 'main' });
    await app.handle(c.client, { type: 'startRun', graphId: g.id, reviewed: preview.signature });
    const runId = c.all('run')[0].run.id;
    await vi.waitFor(() => expect(c.all('checkout').at(-1)?.lease?.runId).toBe(runId));
    gate.resolve();
    await vi.waitFor(() => expect(c.all('run').at(-1)?.run.status).toBe('succeeded'));
    await vi.waitFor(() => expect(c.all('checkout').at(-1)).not.toHaveProperty('lease'));
    expect(app.runStore.get(runId)?.checkout).toEqual({ root, branch: 'main', head: SHA, linkedWorktree: false });
  });

  it('refuses a second run that would change files in the same checkout with runBlocked, not an error', async () => {
    const leases = testLeases();
    const gate = deferred<void>();
    const a = gitApp({ leases, git: main, over: { executors: { agent: held(gate), command: held(gate) } } });
    const b = gitApp({ leases, git: () => main(a.root) });
    const ga = graphWith(a.app, 'Orders', writer);
    const gb = graphWith(b.app, 'Billing', writer);
    const ca = client(a.app);
    const cb = client(b.app);
    await a.app.handle(ca.client, { type: 'startRun', graphId: ga.id, reviewed: (await reviewedBy(a.app, ca, ga.id)).signature });
    const runA = ca.all('run')[0].run.id;
    await b.app.handle(cb.client, { type: 'startRun', graphId: gb.id, reviewed: (await reviewedBy(b.app, cb, gb.id)).signature });
    expect(cb.last('runBlocked')).toEqual({
      type: 'runBlocked',
      graphId: gb.id,
      message: `"Billing" can't start: run ${runA} of "Orders" is already changing files in this checkout (${a.root}). Separate tickets need separate worktrees.`,
      holder: expect.objectContaining({ runId: runA, graphId: ga.id, folder: a.projectDir }),
      otherWindow: false,
      checkout: expect.objectContaining({ git: true, root: a.root }),
      canSetUpTickets: true,
    });
    expect(cb.all('error')).toEqual([]);
    expect(b.app.runStore.list(gb.id)).toEqual([]);
    gate.resolve();
    await vi.waitFor(() => expect(ca.all('run').at(-1)?.run.status).toBe('succeeded'));
  });

  it('offers only sequential execution outside Git', async () => {
    const leases = testLeases();
    const gate = deferred<void>();
    const folder = tmpProject().root;
    const a = gitApp({ leases, projectDir: folder, over: { executors: { agent: held(gate), command: held(gate) } } });
    const b = gitApp({ leases, projectDir: folder });
    const ga = graphWith(a.app, 'Orders', writer);
    const gb = graphWith(b.app, 'Billing', writer);
    const ca = client(a.app);
    const cb = client(b.app);
    await a.app.handle(ca.client, { type: 'startRun', graphId: ga.id, reviewed: (await reviewedBy(a.app, ca, ga.id)).signature });
    await b.app.handle(cb.client, { type: 'startRun', graphId: gb.id, reviewed: (await reviewedBy(b.app, cb, gb.id)).signature });
    expect(cb.last('runBlocked')).toMatchObject({ canSetUpTickets: false, checkout: { git: false, root: a.root, reason: 'Not a Git repository' } });
    expect(cb.last('runBlocked').message).toContain(`is already changing files in this checkout (${a.root}).`);
    gate.resolve();
    await vi.waitFor(() => expect(ca.all('run').at(-1)?.run.status).toBe('succeeded'));
  });

  it('starts a sequential run that waits for the lease, and runs it once the first run ends', async () => {
    const leases = testLeases();
    const gate = deferred<void>();
    const a = gitApp({ leases, git: main, over: { executors: { agent: held(gate), command: held(gate) } } });
    const b = gitApp({ leases, git: () => main(a.root) });
    const ga = graphWith(a.app, 'Orders', writer);
    const gb = graphWith(b.app, 'Billing', writer);
    const ca = client(a.app);
    const cb = client(b.app);
    await a.app.handle(ca.client, { type: 'startRun', graphId: ga.id, reviewed: (await reviewedBy(a.app, ca, ga.id)).signature });
    const runA = ca.all('run')[0].run.id;
    await b.app.handle(cb.client, { type: 'startRun', graphId: gb.id, reviewed: (await reviewedBy(b.app, cb, gb.id)).signature, sequential: true });
    expect(cb.all('runBlocked')).toEqual([]);
    expect(cb.all('run')[0].run.waitingFor).toEqual({ runId: runA, graphId: ga.id, folder: a.projectDir });
    gate.resolve();
    await vi.waitFor(() => expect(cb.all('run').at(-1)?.run.status).toBe('succeeded'));
  });

  it('names another VS Code window, and an unreadable lock file, in the message', async () => {
    const locksDir = mkdtempSync(join(tmpdir(), 'agent-stream-locks-'));
    const { app, root } = gitApp({ leases: createWriteLeases({ locksDir, isAlive: () => true }), git: main });
    createWriteLeases({ locksDir, pid: 4242, isAlive: () => true }).acquire(root, { runId: '20261003-090000-beef', graphId: 'billing', folder: join(tmpdir(), 'elsewhere'), startedAt: 't' });
    const c = client(app);
    const g = graphWith(app, 'Orders', writer);
    await app.handle(c.client, { type: 'startRun', graphId: g.id, reviewed: (await reviewedBy(app, c, g.id)).signature });
    expect(c.last('runBlocked')).toMatchObject({
      otherWindow: true,
      message: `"Orders" can't start: run 20261003-090000-beef in another VS Code window of "billing" is already changing files in this checkout (${root}). Separate tickets need separate worktrees.`,
    });
    writeFileSync(leaseFile(locksDir, root), 'not json');
    await app.handle(c.client, { type: 'startRun', graphId: g.id, reviewed: (await reviewedBy(app, c, g.id)).signature });
    expect(c.last('runBlocked').message).toBe(
      `"Orders" can't start: run unknown in another VS Code window of "unknown" is already changing files in this checkout (${root}). Separate tickets need separate worktrees. Its lock file ${leaseFile(locksDir, root)} can't be read; delete it if no run is changing files.`,
    );
  });

  it('creates the variant worktrees before the run starts, records them, and runs each step in its own', async () => {
    const ran: { id: string; cwd: string }[] = [];
    const record: NodeExecutor = async (ctx) => {
      ran.push({ id: ctx.node.id, cwd: ctx.cwd });
      return { ok: true, output: '' };
    };
    const added: string[] = [];
    const removed: string[] = [];
    const { app, root, home, projectDir } = gitApp({
      git: (root) =>
        repoGit({
          root,
          branch: 'main',
          head: SHA,
          answers: {
            'worktree add --detach *': (cwd, args) => {
              added.push(`${cwd}|${args[3]}|${args[4]}`);
              return {};
            },
            'worktree remove *': (_cwd, args) => {
              removed.push(args.join(' '));
              return {};
            },
          },
        }).exec,
      over: { executors: { agent: record, command: record } },
    });
    const c = client(app);
    const g = graphWith(
      app,
      'AB',
      { type: 'addNode', node: { title: 'a', kind: 'command', command: 'make', workspace: 'wh_a' } },
      { type: 'addNode', node: { title: 'b', kind: 'command', command: 'make', workspace: 'wh_b' } },
      { type: 'addNode', node: { title: 'compare', kind: 'agent', prompt: 'p', access: 'read' } },
    );
    await app.handle(c.client, { type: 'startRun', graphId: g.id, reviewed: (await reviewedBy(app, c, g.id)).signature });
    await vi.waitFor(() => expect(c.all('run').at(-1)?.run.status).toBe('succeeded'));
    const run = c.all('run').at(-1)!.run;
    const pathA = variantPath(home, root, run.id, 'wh_a');
    const pathB = variantPath(home, root, run.id, 'wh_b');
    expect(run.workspaces).toEqual({ wh_a: { path: pathA, head: SHA }, wh_b: { path: pathB, head: SHA } });
    expect(added).toEqual([`${root}|${pathA}|${SHA}`, `${root}|${pathB}|${SHA}`]);
    expect(ran).toEqual(expect.arrayContaining([{ id: 'n1', cwd: pathA }, { id: 'n2', cwd: pathB }, { id: 'n3', cwd: projectDir }]));
    // Kept after the run for inspection (spec §4.3a): nothing removes them.
    expect(removed).toEqual([]);
  });

  it("refuses the run when a workspace can't be created, removing this attempt's worktrees", async () => {
    const ran: string[] = [];
    const { app } = gitApp({
      git: (root) =>
        repoGit({
          root,
          branch: 'main',
          head: SHA,
          answers: {
            'worktree add --detach *': (_cwd, args) => {
              ran.push(`add ${args[3]}`);
              return args[3].endsWith('wh_b') ? { code: 128, stderr: 'fatal: boom\n' } : {};
            },
            'worktree remove --force *': (_cwd, args) => {
              ran.push(`remove ${args[3]}`);
              return {};
            },
          },
        }).exec,
    });
    const c = client(app);
    const g = graphWith(
      app,
      'AB',
      { type: 'addNode', node: { title: 'a', kind: 'command', command: 'make', workspace: 'wh_a' } },
      { type: 'addNode', node: { title: 'b', kind: 'command', command: 'make', workspace: 'wh_b' } },
    );
    await app.handle(c.client, { type: 'startRun', graphId: g.id, reviewed: (await reviewedBy(app, c, g.id)).signature });
    expect(c.last('error').message).toBe('Couldn\'t create workspace "wh_b": fatal: boom');
    expect(app.runStore.list(g.id)).toEqual([]);
    expect(ran).toHaveLength(3);
    expect(ran[2]).toBe(ran[0].replace('add', 'remove'));
  });

  it('refuses a start with workspaces when HEAD moved since review, and still starts a graph without them', async () => {
    let head = SHA;
    const ran: string[] = [];
    const { app } = gitApp({
      git: (root) => (args, cwd) => {
        ran.push(args.join(' '));
        return repoGit({ root, branch: 'main', head, answers: { 'worktree add --detach *': {} } }).exec(args, cwd);
      },
    });
    const c = client(app);
    const ab = graphWith(app, 'AB', { type: 'addNode', node: { title: 'a', kind: 'command', command: 'make', workspace: 'wh_a' } });
    const plain = graphWith(app, 'Plain', writer);
    const reviewedAb = (await reviewedBy(app, c, ab.id)).signature;
    const reviewedPlain = (await reviewedBy(app, c, plain.id)).signature;
    head = 'f'.repeat(40);
    await app.handle(c.client, { type: 'startRun', graphId: ab.id, reviewed: reviewedAb });
    expect(c.last('error').message).toBe(CHANGED_SINCE_REVIEW);
    expect(ran.some((a) => a.startsWith('worktree add'))).toBe(false);
    expect(app.runStore.list(ab.id)).toEqual([]);
    await app.handle(c.client, { type: 'startRun', graphId: plain.id, reviewed: reviewedPlain });
    await vi.waitFor(() => expect(c.all('run').at(-1)?.run).toMatchObject({ graphId: plain.id, status: 'succeeded' }));
  });

  it('refuses a start the lease blocks before creating any worktree', async () => {
    const locksDir = mkdtempSync(join(tmpdir(), 'agent-stream-locks-'));
    let git: ReturnType<typeof repoGit> | undefined;
    const { app, root } = gitApp({
      leases: createWriteLeases({ locksDir, isAlive: () => true }),
      git: (root) => (git = repoGit({ root, branch: 'main', head: SHA, answers: { 'worktree add --detach *': {}, 'worktree remove --force *': {} } })).exec,
    });
    createWriteLeases({ locksDir, pid: 4242, isAlive: () => true }).acquire(root, { runId: '20261003-090000-beef', graphId: 'billing', folder: join(tmpdir(), 'elsewhere'), startedAt: 't' });
    const c = client(app);
    const g = graphWith(app, 'Orders', { type: 'addNode', node: { title: 'a', kind: 'command', command: 'make', workspace: 'wh_a' } }, writer);
    await app.handle(c.client, { type: 'startRun', graphId: g.id, reviewed: (await reviewedBy(app, c, g.id)).signature });
    expect(c.last('runBlocked')).toMatchObject({
      otherWindow: true,
      holder: expect.objectContaining({ runId: '20261003-090000-beef', pid: 4242 }),
      checkout: expect.objectContaining({ git: true, root }),
      canSetUpTickets: true,
      message: `"Orders" can't start: run 20261003-090000-beef in another VS Code window of "billing" is already changing files in this checkout (${root}). Separate tickets need separate worktrees.`,
    });
    expect(c.all('error')).toEqual([]);
    expect(git!.ran().filter((a) => a.startsWith('worktree add') || a.startsWith('worktree remove'))).toEqual([]);
    expect(app.runStore.list(g.id)).toEqual([]);
  });

  it('removes the worktrees it made when the runner blocks the start (the lease was taken meanwhile)', async () => {
    const ran: string[] = [];
    const locksDir = mkdtempSync(join(tmpdir(), 'agent-stream-locks-'));
    const takeLease = () => createWriteLeases({ locksDir, pid: 4242, isAlive: () => true }).acquire(root, { runId: '20261003-090000-beef', graphId: 'x', folder: 'f', startedAt: 't' });
    const { app, root } = gitApp({
      leases: createWriteLeases({ locksDir, isAlive: () => true }),
      git: (root) =>
        repoGit({
          root,
          branch: 'main',
          head: SHA,
          answers: { 'worktree add --detach *': (_cwd, args) => (ran.push(`add ${args[3]}`), takeLease(), {}), 'worktree remove --force *': (_cwd, args) => (ran.push(`remove ${args[3]}`), {}) },
        }).exec,
    });
    const c = client(app);
    const g = graphWith(app, 'AB', { type: 'addNode', node: { title: 'a', kind: 'command', command: 'make', workspace: 'wh_a' } }, writer);
    await app.handle(c.client, { type: 'startRun', graphId: g.id, reviewed: (await reviewedBy(app, c, g.id)).signature });
    expect(c.all('runBlocked')).toHaveLength(1);
    expect(ran).toHaveLength(2);
    expect(ran[0]).toMatch(/^add .*wh_a$/);
    expect(ran[1]).toBe(ran[0].replace('add', 'remove'));
  });

  it("logs a worktree it can't remove after a blocked start, and keeps the runBlocked message", async () => {
    const added: string[] = [];
    const locksDir = mkdtempSync(join(tmpdir(), 'agent-stream-locks-'));
    const takeLease = () =>
      createWriteLeases({ locksDir, pid: 4242, isAlive: () => true }).acquire(root, { runId: '20261003-090000-beef', graphId: 'billing', folder: join(tmpdir(), 'elsewhere'), startedAt: 't' });
    const { app, root } = gitApp({
      leases: createWriteLeases({ locksDir, isAlive: () => true }),
      git: (root) =>
        repoGit({
          root,
          branch: 'main',
          head: SHA,
          answers: {
            // The lease is taken meanwhile, so the pre-check passes and the runner blocks the start.
            'worktree add --detach *': (_cwd, args) => (added.push(args[3]), takeLease(), {}),
            'worktree remove --force *': () => ({ code: 128, stderr: "fatal: '/x' is locked\n" }),
          },
        }).exec,
    });
    const c = client(app);
    const g = graphWith(app, 'Orders', { type: 'addNode', node: { title: 'a', kind: 'command', command: 'make', workspace: 'wh_a' } }, writer);
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await app.handle(c.client, { type: 'startRun', graphId: g.id, reviewed: (await reviewedBy(app, c, g.id)).signature });
      expect(c.last('runBlocked').message).toBe(
        `"Orders" can't start: run 20261003-090000-beef in another VS Code window of "billing" is already changing files in this checkout (${root}). Separate tickets need separate worktrees.`,
      );
      expect(c.all('error')).toEqual([]);
      expect(added).toHaveLength(1);
      expect(logged).toHaveBeenCalledWith('[agent-stream] could not remove a worktree after a refused start', added[0], "fatal: '/x' is locked");
    } finally {
      logged.mockRestore();
    }
  });

  it("removes this attempt's worktrees when the run can't be recorded, logs one it can't remove, and rethrows", async () => {
    const ran: string[] = [];
    const { app } = gitApp({
      git: (root) =>
        repoGit({
          root,
          branch: 'main',
          head: SHA,
          answers: {
            'worktree add --detach *': (_cwd, args) => (ran.push(`add ${args[3]}`), {}),
            'worktree remove --force *': (_cwd, args) => (ran.push(`remove ${args[3]}`), args[3].endsWith('wh_b') ? { code: 128, stderr: 'fatal: locked\n' } : {}),
          },
        }).exec,
    });
    const c = client(app);
    const g = graphWith(
      app,
      'AB',
      { type: 'addNode', node: { title: 'a', kind: 'command', command: 'make', workspace: 'wh_a' } },
      { type: 'addNode', node: { title: 'b', kind: 'command', command: 'make', workspace: 'wh_b' } },
    );
    const reviewed = (await reviewedBy(app, c, g.id)).signature;
    const create = vi.spyOn(app.runStore, 'create').mockImplementation(() => {
      throw new Error('ENOSPC: no space left on device');
    });
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(app.handle(c.client, { type: 'startRun', graphId: g.id, reviewed })).rejects.toThrow('ENOSPC: no space left on device');
      expect(ran).toHaveLength(4);
      expect(ran.slice(2)).toEqual([ran[0].replace('add', 'remove'), ran[1].replace('add', 'remove')]);
      expect(logged).toHaveBeenCalledWith('[agent-stream] could not remove a worktree after a refused start', ran[1].slice('add '.length), 'fatal: locked');
    } finally {
      logged.mockRestore();
      create.mockRestore();
    }
  });

  it('refuses a step with a workspace outside Git or before the first commit', async () => {
    for (const { app } of [gitApp(), gitApp({ git: (root) => repoGit({ root, branch: 'main' }).exec })]) {
      const c = client(app);
      const g = graphWith(app, 'AB', { type: 'addNode', node: { title: 'a', kind: 'command', command: 'make', workspace: 'wh_a' } });
      const preview = await reviewedBy(app, c, g.id);
      const problem = 'Step n1 uses workspace "wh_a", which needs a Git repository with at least one commit.';
      expect(preview.problems).toContain(problem);
      await app.handle(c.client, { type: 'startRun', graphId: g.id, reviewed: preview.signature });
      expect(c.last('error').message).toContain(problem);
      expect(app.runStore.list(g.id)).toEqual([]);
    }
  });

  it('releases its leases on dispose', async () => {
    const gate = deferred<void>();
    const { app, root, leases } = gitApp({ over: { executors: { agent: held(gate), command: held(gate) } } });
    const c = client(app);
    const g = graphWith(app, 'G', writer);
    await app.handle(c.client, { type: 'startRun', graphId: g.id, reviewed: (await reviewedBy(app, c, g.id)).signature });
    expect(leases.holder(root)?.runId).toBe(c.all('run')[0].run.id);
    app.dispose();
    expect(leases.holder(root)).toBeUndefined();
  });
});

describe('app: model and effort', () => {
  const MODELS = [
    { value: 'sonnet', label: 'Sonnet', efforts: ['low', 'high'] as EffortLevel[] },
    { value: 'haiku', label: 'Haiku', efforts: [] as EffortLevel[] },
  ];

  it("saves the conversation's choice in the session, tells its subscribers, and sends it on the next turn", async () => {
    const seen: PlannerTurn[] = [];
    const defaults: ModelSelection = { model: 'haiku' };
    const { app, graphId } = setupWithGraph({ provider: testProvider({ planTurn: async (t) => (seen.push(t), { ok: true, sessionId: 'p1' }) }), modelDefaults: () => defaults });
    app.createSession('B');
    const a = client(app),
      b = client(app);
    await app.handle(a.client, { type: 'openChat', graphId, sessionId: 'default' });
    await app.handle(b.client, { type: 'openChat', graphId, sessionId: 'b' });
    await app.handle(a.client, { type: 'chat', graphId, sessionId: 'default', text: 'one' });
    await flush();
    expect(seen[0].model).toBe('haiku');
    await app.handle(a.client, { type: 'setPlannerModel', graphId, sessionId: 'default', model: 'sonnet', effort: 'high' });
    expect(a.last('plannerModel')).toEqual({ type: 'plannerModel', graphId, sessionId: 'default', model: 'sonnet', effort: 'high' });
    expect(b.all('plannerModel')).toEqual([]);
    expect(app.sessionStore.plannerState('default', graphId)).toMatchObject({ model: 'sonnet', effort: 'high' });
    await app.handle(a.client, { type: 'chat', graphId, sessionId: 'default', text: 'two' });
    await flush();
    expect(seen[1]).toMatchObject({ model: 'sonnet', effort: 'high' });
    // Opened again (a reload): the choice comes with the conversation, and New chat keeps it.
    const later = client(app);
    await app.handle(later.client, { type: 'openChat', graphId, sessionId: 'default' });
    expect(later.last('chatOpened')).toMatchObject({ model: 'sonnet', effort: 'high' });
    await app.handle(a.client, { type: 'newChat', graphId, sessionId: 'default' });
    expect(a.last('chatOpened')).toEqual({ type: 'chatOpened', graphId, sessionId: 'default', chat: [], busy: false, model: 'sonnet', effort: 'high' });
    // Default again: the settings default applies.
    await app.handle(a.client, { type: 'setPlannerModel', graphId, sessionId: 'default' });
    expect(a.last('plannerModel')).toEqual({ type: 'plannerModel', graphId, sessionId: 'default' });
    await app.handle(a.client, { type: 'chat', graphId, sessionId: 'default', text: 'three' });
    await flush();
    expect(seen[2].model).toBe('haiku');
    expect(seen[2].effort).toBeUndefined();
  });

  it('refuses a choice for an unknown session or graph', async () => {
    const { app, graphId } = setupWithGraph();
    const a = client(app);
    await app.handle(a.client, { type: 'setPlannerModel', graphId, sessionId: 'nope', model: 'x' });
    await app.handle(a.client, { type: 'setPlannerModel', graphId: 'nope', sessionId: 'default', model: 'x' });
    expect(a.all('error').map((m) => m.message)).toEqual(['session "nope" not found', 'graph "nope" not found']);
  });

  it("sends the provider's models with an opened chat, and again when the provider changes", async () => {
    const { app, graphId } = setupWithGraph({ provider: testProvider({ listModels: async () => MODELS }) });
    const a = client(app);
    await app.handle(a.client, { type: 'openChat', graphId, sessionId: 'default' });
    await vi.waitFor(() => expect(a.last('models')).toEqual({ type: 'models', provider: 'claude', models: MODELS, defaultEfforts: [] }));
    app.setProvider(testProvider({ id: 'copilot', name: 'GitHub Copilot' }), signedIn);
    await vi.waitFor(() => expect(a.last('models')).toEqual({ type: 'models', provider: 'copilot', models: [], defaultEfforts: [] }));
  });

  it("gives Default the levels of the settings' model, else Claude Code's default row, and re-sends them when the settings change", async () => {
    const listed = [{ value: 'default', label: 'Default (recommended)', efforts: ['low', 'max'] as EffortLevel[] }, ...MODELS];
    const defaults: ModelSelection = {};
    const retries: (boolean | undefined)[] = [];
    const { app, graphId } = setupWithGraph({ provider: testProvider({ listModels: async (o) => (retries.push(o?.retry), listed) }), modelDefaults: () => defaults });
    const a = client(app);
    await app.handle(a.client, { type: 'openChat', graphId, sessionId: 'default' });
    await vi.waitFor(() => expect(a.last('models')?.defaultEfforts).toEqual(['low', 'max']));
    // A chat opening may retry a failed list once.
    expect(retries).toEqual([true]);
    defaults.model = 'sonnet';
    app.modelDefaultsChanged();
    await vi.waitFor(() => expect(a.last('models')?.defaultEfforts).toEqual(['low', 'high']));
    expect(a.all('models')).toHaveLength(2);
  });

  it("shows the provider's per-step request cap and the model a step would run on", async () => {
    const defaults: ModelSelection = { model: 'gpt-9' };
    const auto: ModelChoice = { value: 'auto', label: 'Auto', efforts: [] };
    const provider = testProvider({ id: 'copilot', name: 'GitHub Copilot', stepRequestCap: () => 25, modelInUse: () => auto });
    const { app, graphId } = setupWithGraph({ provider, modelDefaults: () => defaults });
    app.graphStore.apply(graphId, { type: 'addNode', node: { id: 'n1', title: 'one', kind: 'agent', prompt: 'p1' } }, 'user');
    const c = client(app);
    await app.handle(c.client, { type: 'previewRun', graphId });
    expect(c.last('runPreview').preview).toMatchObject({ copilotRequestsPerStep: 25, model: { value: 'auto', label: 'Auto' } });
  });

  it('leaves the cap out for a provider without one', async () => {
    const { app, graphId } = setupWithGraph();
    const c = client(app);
    await app.handle(c.client, { type: 'previewRun', graphId });
    expect(c.last('runPreview').preview).not.toHaveProperty('copilotRequestsPerStep');
  });

  it('names the provider in a preview and drops the configured effort for Copilot, which ignores it', async () => {
    const defaults: ModelSelection = { effort: 'high' };
    const copilot = setupWithGraph({ provider: testProvider({ id: 'copilot', name: 'GitHub Copilot' }), modelDefaults: () => defaults });
    copilot.app.graphStore.apply(copilot.graphId, { type: 'addNode', node: { id: 'n1', title: 'one', kind: 'agent', prompt: 'p1' } }, 'user');
    const c = client(copilot.app);
    await copilot.app.handle(c.client, { type: 'previewRun', graphId: copilot.graphId });
    expect(c.last('runPreview').preview).toMatchObject({ provider: 'copilot' });
    expect(c.last('runPreview').preview).not.toHaveProperty('effort');
    const claude = setupWithGraph({ modelDefaults: () => defaults });
    const c2 = client(claude.app);
    await claude.app.handle(c2.client, { type: 'previewRun', graphId: claude.graphId });
    expect(c2.last('runPreview').preview).toMatchObject({ effort: 'high' });
  });

  it('never waits on the model list for a preview: the cached list names the model, else its id', async () => {
    let known: ModelChoice[] | undefined;
    const listModels = vi.fn(() => new Promise<ModelChoice[]>(() => {}));
    const defaults: ModelSelection = { model: 'claude-sonnet-5', effort: 'high' };
    const { app, graphId } = setupWithGraph({ provider: testProvider({ listModels, knownModels: () => known }), modelDefaults: () => defaults });
    app.graphStore.apply(graphId, { type: 'addNode', node: { id: 'n1', title: 'one', kind: 'agent', prompt: 'p1' } }, 'user');
    const c = client(app);
    await app.handle(c.client, { type: 'previewRun', graphId });
    expect(c.last('runPreview').preview).toMatchObject({ model: { value: 'claude-sonnet-5', label: 'claude-sonnet-5' }, effort: 'high' });
    // One background fetch, without a retry; the hanging list never held the dialog up.
    expect(listModels).toHaveBeenCalledTimes(1);
    expect(listModels.mock.calls[0]).toEqual([]);
    known = [{ value: 'sonnet', label: 'Sonnet', resolved: 'claude-sonnet-5', efforts: ['low', 'high'] }];
    await app.handle(c.client, { type: 'previewRun', graphId });
    expect(c.last('runPreview').preview.model).toEqual({ value: 'claude-sonnet-5', label: 'Sonnet' });
    expect(listModels).toHaveBeenCalledTimes(1);
  });

  it('runs with the settings captured at start, records them, and never takes a mid-run change', async () => {
    const defaults: ModelSelection = { model: 'sonnet', effort: 'high' };
    const seen: { node: string; model?: string; effort?: string }[] = [];
    const provider = testProvider({
      listModels: async () => MODELS,
      knownModels: () => MODELS,
      runStep: async (ctx) => {
        seen.push({ node: ctx.node.id, model: ctx.model, effort: ctx.effort });
        if (ctx.node.id === 'n1') {
          defaults.model = 'haiku';
          defaults.effort = undefined;
        }
        return { ok: true, output: '' };
      },
    });
    const { app, graphId } = setupWithGraph({ provider, modelDefaults: () => defaults });
    app.graphStore.apply(graphId, { type: 'addNode', node: { id: 'n1', title: 'one', kind: 'agent', prompt: 'p1' } }, 'user');
    app.graphStore.apply(graphId, { type: 'addNode', node: { id: 'n2', title: 'two', kind: 'agent', prompt: 'p2' } }, 'user');
    app.graphStore.apply(graphId, { type: 'connect', from: 'n1', to: 'n2' }, 'user');
    const c = client(app);
    await app.handle(c.client, { type: 'previewRun', graphId });
    const preview = c.last('runPreview').preview;
    expect(preview).toMatchObject({ model: { value: 'sonnet', label: 'Sonnet' }, effort: 'high' });
    await app.handle(c.client, { type: 'startRun', graphId, reviewed: preview.signature });
    await vi.waitFor(() => expect(c.last('run').run.status).toBe('succeeded'));
    expect(seen).toEqual([
      { node: 'n1', model: 'sonnet', effort: 'high' },
      { node: 'n2', model: 'sonnet', effort: 'high' },
    ]);
    const run = c.last('run').run;
    expect(run).toMatchObject({ model: 'sonnet', effort: 'high' });
    expect(app.runStore.list(graphId)[0]).toMatchObject({ model: 'sonnet', effort: 'high' });
    // The next run takes the new settings; an empty setting records nothing.
    await app.handle(c.client, { type: 'previewRun', graphId });
    const next = c.last('runPreview').preview;
    expect(next.model).toEqual({ value: 'haiku', label: 'Haiku' });
    expect(next.effort).toBeUndefined();
    defaults.model = '';
    await app.handle(c.client, { type: 'previewRun', graphId });
    const third = c.last('runPreview').preview;
    expect(third.model).toBeUndefined();
    await app.handle(c.client, { type: 'startRun', graphId, reviewed: third.signature });
    await vi.waitFor(() => expect(c.last('run').run.id).not.toBe(run.id));
    await vi.waitFor(() => expect(c.last('run').run.status).toBe('succeeded'));
    expect('model' in c.last('run').run).toBe(false);
    expect('effort' in c.last('run').run).toBe(false);
    expect(seen.slice(2).map((s) => s.model)).toEqual([undefined, undefined]);
  });

  it('never writes a model or effort into the graph file or its export', async () => {
    const { app, graphId, paths } = setupWithGraph({ provider: testProvider({ planTurn: async () => ({ ok: true, sessionId: 'p' }) }), modelDefaults: () => ({ model: 'sonnet', effort: 'high' }) });
    const a = client(app);
    await app.handle(a.client, { type: 'setPlannerModel', graphId, sessionId: 'default', model: 'haiku', effort: 'low' });
    await app.handle(a.client, { type: 'chat', graphId, sessionId: 'default', text: 'plan' });
    await flush();
    const exported = app.exportGraph(graphId);
    if (!exported.ok) throw new Error(exported.error);
    for (const text of [exported.content, readFileSync(join(paths.graphsDir, `${graphId}.md`), 'utf8'), readFileSync(join(paths.graphsDir, `${graphId}.meta.json`), 'utf8')]) {
      expect(text).not.toMatch(/"model"|"effort"|sonnet|haiku/);
    }
  });
});

describe('graphs from before Markdown', () => {
  it('converts them on start, after the planner-state move, with one note per graph', () => {
    const paths = tmpProject();
    writeFileSync(join(paths.graphsDir, 'g1.json'), JSON.stringify({ ...emptyGraph('g1', 'Old graph', 't'), plannerSessionId: 's' }));
    const app = createApp({ ...appTestDeps(), projectDir: paths.root, valuesFile: tmpValuesFile(), provider: testProvider(), status: signedIn, maxParallel: 1 });
    expect(app.startupNotes()).toEqual(['Converted the graph "Old graph" to g1.md; the old file is kept as g1.json.bak.']);
    expect(app.startupWarnings()).toEqual([]);
    expect(app.sessionStore.plannerState('default', 'g1')).toMatchObject({ sessionId: 's' });
    expect(app.listGraphs().map((g) => g.id)).toEqual(['g1']);
    expect(existsSync(join(paths.graphsDir, 'g1.json.bak'))).toBe(true);
  });

  it('leaves a graph whose planner-state move failed as JSON, so the move can be retried next start', () => {
    const paths = tmpProject();
    const deps = () => ({ ...appTestDeps(), projectDir: paths.root, valuesFile: tmpValuesFile(), provider: testProvider(), status: signedIn, maxParallel: 1 });
    createApp(deps()); // makes the Default session
    writeFileSync(join(paths.graphsDir, 'g1.json'), JSON.stringify({ ...emptyGraph('g1', 'Old graph', 't'), plannerSessionId: 's' }));
    writeFileSync(join(paths.graphsDir, 'g1.chat.jsonl'), '{}\n');
    // The moved chat's place is taken by a folder, so the move fails this start.
    const dest = join(paths.sessionsDir, 'default', 'chats', 'g1.chat.jsonl');
    mkdirSync(dest, { recursive: true });
    const first = createApp(deps());
    expect(first.startupWarnings()).toEqual([expect.stringMatching(/^Could not finish moving the planner conversation of graph g1 .*retried next time\.$/)]);
    expect(first.startupNotes()).toEqual([]);
    expect(existsSync(join(paths.graphsDir, 'g1.json'))).toBe(true);
    expect(existsSync(join(paths.graphsDir, 'g1.md'))).toBe(false);
    rmSync(dest, { recursive: true });
    const second = createApp(deps());
    expect(second.startupWarnings()).toEqual([]);
    expect(second.startupNotes()).toEqual(['Converted the graph "Old graph" to g1.md; the old file is kept as g1.json.bak.']);
    expect(second.sessionStore.plannerState('default', 'g1')).toMatchObject({ sessionId: 's' });
  });
});

describe('graph files changed outside Agent Stream', () => {
  function withFile() {
    const { app, graphId, paths } = setupWithGraph();
    app.graphStore.apply(graphId, { type: 'addVariable', name: 'schema' }, 'user');
    app.graphStore.apply(graphId, { type: 'addNode', node: { title: 'Build', kind: 'command', command: 'make {{ schema }}' } }, 'user');
    const md = join(paths.graphsDir, `${graphId}.md`);
    const edit = (from: string, to: string) => writeFileSync(md, readFileSync(md, 'utf8').replace(from, to));
    return { app, graphId, md, edit, c: client(app) };
  }

  it('sends the edited graph and the list, and records the edit as the user’s, via the file', () => {
    const { app, graphId, edit, c } = withFile();
    edit('# G', '# G edited\n\n## Goal\n\nFrom a text editor.');
    expect(app.graphFileChanged(graphId)).toBe('applied');
    expect(c.last('graph').graph).toMatchObject({ name: 'G edited', goal: 'From a text editor.' });
    expect(c.last('graphs').graphs.find((g) => g.id === graphId)?.name).toBe('G edited');
    expect(app.graphStore.readOps(graphId).at(-1)).toMatchObject({ by: 'user', op: { type: 'setGoal' }, via: 'file' });
    expect(app.graphFileChanged(graphId)).toBe('unchanged');
  });

  it('keeps the value of a variable the file removed, so it is there again when the file brings the variable back', () => {
    const { app, graphId, md, edit } = withFile();
    app.values.set(graphId, 'schema', 'dev');
    const original = readFileSync(md, 'utf8');
    edit('## Variables\n\n- `schema`\n\n', '');
    edit('make {{ schema }}', 'make');
    expect(app.graphFileChanged(graphId)).toBe('applied');
    expect(app.graphStore.get(graphId).variables).toEqual([]);
    expect(app.values.get(graphId)).toEqual({ schema: 'dev' });
    writeFileSync(md, original);
    expect(app.graphFileChanged(graphId)).toBe('applied');
    expect(app.graphStore.get(graphId).variables.map((v) => v.name)).toEqual(['schema']);
    expect(app.values.get(graphId)).toEqual({ schema: 'dev' });
  });

  it('publishes file errors, includes them when the graph opens, and clears them when fixed', async () => {
    const { app, graphId, edit, c } = withFile();
    edit('- kind: command', '- kind: robot');
    expect(app.graphFileChanged(graphId)).toBe('errors');
    expect(c.last('graphFileErrors')).toEqual({ type: 'graphFileErrors', graphId, errors: [{ line: expect.any(Number), message: 'kind is "robot"; use agent or command.' }] });
    await app.handle(c.client, { type: 'openGraph', graphId });
    expect(c.last('graphOpened').fileErrors).toEqual(c.last('graphFileErrors').errors);
    // Back to the text the store holds: nothing to apply, and the problems are gone.
    edit('- kind: robot', '- kind: command');
    expect(app.graphFileChanged(graphId)).toBe('unchanged');
    expect(c.last('graphFileErrors')).toEqual({ type: 'graphFileErrors', graphId, errors: [] });
    await app.handle(c.client, { type: 'openGraph', graphId });
    expect('fileErrors' in c.last('graphOpened')).toBe(false);
  });

  it('tells the tabs a deleted file’s graph is gone, and lists it again when the file comes back', () => {
    const { app, graphId, md, c } = withFile();
    const saved = readFileSync(md, 'utf8');
    rmSync(md);
    expect(app.graphFileDeleted(graphId)).toBe('deleted');
    expect(c.last('graphDeleted')).toEqual({ type: 'graphDeleted', graphId, reason: 'file' });
    expect(c.last('graphs').graphs.map((g) => g.id)).toEqual([]);
    writeFileSync(md, saved);
    expect(app.graphFileChanged(graphId)).toBe('added');
    expect(c.last('graphs').graphs.map((g) => g.id)).toEqual([graphId]);
  });

  it('sends the graph itself, not just the list, when a file is added or comes back (so a tab showing it refreshes)', () => {
    const { app, graphId, md, c } = withFile();
    const saved = readFileSync(md, 'utf8');
    rmSync(md);
    app.graphFileDeleted(graphId);
    const before = c.all('graph').length;
    writeFileSync(md, saved.replace('# G', '# G back'));
    expect(app.graphFileChanged(graphId)).toBe('added');
    expect(c.all('graph').length).toBe(before + 1);
    expect(c.last('graph').graph).toMatchObject({ id: graphId, name: 'G back' });
    expect(c.last('graphs').graphs.find((g) => g.id === graphId)?.name).toBe('G back');
  });
});
