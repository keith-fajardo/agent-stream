import { describe, expect, it, vi } from 'vitest';
import { applyOp, emptyGraph, type EffortLevel, type Graph, type ModelChoice, type ModelSelection, type NodeEvent, type Op, type ServerMessage } from '@agent-stream/shared';
import { createApp, type App } from '../src/app';
import { ApprovalBroker } from '../src/approvals';
import type { NodeContext, NodeExecutor } from '../src/executors';
import { Runner } from '../src/runner';
import { RunStore } from '../src/runStore';
import { appTestDeps, signedIn, testGitBash, testLeases, testProvider, tmpProject, tmpValuesFile } from './helpers';

const all: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const MODELS: ModelChoice[] = [
  { value: 'sonnet', label: 'Sonnet', efforts: all },
  { value: 'opus', label: 'Opus', efforts: all },
  { value: 'haiku', label: 'Haiku', efforts: [] },
];
const opus = { provider: 'claude' as const, id: 'opus' };

function graphOf(ops: Op[]): Graph {
  let g = emptyGraph('g', 'G', 't');
  for (const op of ops) {
    const r = applyOp(g, op, 'user', 't');
    if (!r.ok) throw new Error(r.error);
    g = r.graph;
  }
  return g;
}

describe('Runner: each step’s model and effort', () => {
  it('gives each agent step its resolved model and effort, records them, and logs a note right after the start', async () => {
    const paths = tmpProject();
    const runStore = new RunStore(paths);
    const seen: Record<string, { model?: string; effort?: EffortLevel }> = {};
    const agent: NodeExecutor = async (ctx: NodeContext) => {
      ctx.emit({ type: 'start', kind: 'agent', cwd: ctx.cwd });
      seen[ctx.node.id] = { model: ctx.model, effort: ctx.effort };
      return { ok: true, output: '' };
    };
    const runner = new Runner({ runStore, broker: new ApprovalBroker(), executors: { agent, command: agent }, projectDir: paths.root, maxParallel: 2, leases: testLeases() });
    const graph = graphOf([
      { type: 'addNode', node: { title: 'a', kind: 'agent', prompt: 'a' } },
      { type: 'addNode', node: { title: 'b', kind: 'agent', prompt: 'b' } },
    ]);
    const rendered = { goal: '', instructions: '', nodes: { n1: 'a', n2: 'b' } };
    const stepModels = { n1: { model: 'opus', effort: 'max' as const, note: 'Why not its own.' } };
    const started = runner.start({ graph, rendered, model: 'sonnet', effort: 'high', stepModels });
    if (!started.ok) throw new Error(started.error);
    const done = await started.done;
    expect(seen).toEqual({ n1: { model: 'opus', effort: 'max' }, n2: { model: 'sonnet', effort: 'high' } });
    expect(done.stepModels).toEqual(stepModels);
    expect(done.stepModels).not.toBe(stepModels);
    expect(runStore.readEvents(done.id, 'n1').map((e) => e.type === 'text' ? `text: ${e.text}` : e.type)).toEqual(['start', 'text: Why not its own.', 'result']);
    expect(runStore.readEvents(done.id, 'n2').map((e) => e.type)).toEqual(['start', 'result']);
  });
});

describe('App: runs with step models', () => {
  type Ctx = { node: string; model?: string; effort?: EffortLevel };

  /** `listed: false`: the provider hasn't listed its models yet. */
  function setup(defaults: ModelSelection, listed = true) {
    const known = listed ? MODELS : undefined;
    const seen: Ctx[] = [];
    const provider = testProvider({
      knownModels: () => known,
      listModels: async () => known ?? [],
      runStep: async (ctx) => {
        ctx.emit({ type: 'start', kind: 'agent', cwd: ctx.cwd, ...(ctx.model && { model: ctx.model }), ...(ctx.effort && { effort: ctx.effort }) });
        seen.push({ node: ctx.node.id, model: ctx.model, effort: ctx.effort });
        return { ok: true, output: `out-${ctx.node.id}` };
      },
    });
    const paths = tmpProject();
    const app = createApp({ ...appTestDeps(), projectDir: paths.root, valuesFile: tmpValuesFile(), provider, status: signedIn, maxParallel: 1, gitBash: testGitBash, modelDefaults: () => defaults });
    const graphId = app.graphStore.create('G').id;
    const msgs: ServerMessage[] = [];
    const client = { send: (m: ServerMessage) => void msgs.push(structuredClone(m)) };
    app.connect(client);
    const last = <T extends ServerMessage['type']>(type: T) => msgs.filter((m): m is Extract<ServerMessage, { type: T }> => m.type === type).at(-1)!;
    return { app, graphId, seen, client, last };
  }

  async function run(app: App, client: { send(m: ServerMessage): void }, last: ReturnType<typeof setup>['last'], graphId: string, extra: { fromNodeId?: string; sourceRunId?: string } = {}) {
    await app.handle(client, { type: 'previewRun', graphId, ...extra });
    await app.handle(client, { type: 'startRun', graphId, reviewed: last('runPreview').preview.signature, ...extra });
    await vi.waitFor(() => expect(last('run').run.status).toBe('succeeded'), { timeout: 5000 });
    return last('run').run;
  }

  it('resolves each agent step when the run starts, saves it in the run, and runs each step with it', async () => {
    const { app, graphId, seen, client, last } = setup({ model: 'sonnet', effort: 'high' });
    app.graphStore.apply(graphId, { type: 'addNode', node: { id: 'n1', title: 'own', kind: 'agent', prompt: 'p', model: opus, effort: 'max' } }, 'user');
    app.graphStore.apply(graphId, { type: 'addNode', node: { id: 'n2', title: 'other', kind: 'agent', prompt: 'p', model: { provider: 'codex', id: 'gpt-6-astra' } } }, 'user');
    app.graphStore.apply(graphId, { type: 'addNode', node: { id: 'n3', title: 'plain', kind: 'agent', prompt: 'p' } }, 'user');
    const done = await run(app, client, last, graphId);
    const note = 'This step is set to an OpenAI Codex model (gpt-6-astra); this run uses Claude, so it uses the default model.';
    expect(done.stepModels).toEqual({ n1: { model: 'opus', effort: 'max' }, n2: { model: 'sonnet', effort: 'high', note }, n3: { model: 'sonnet', effort: 'high' } });
    expect(seen.sort((a, b) => a.node.localeCompare(b.node))).toEqual([
      { node: 'n1', model: 'opus', effort: 'max' },
      { node: 'n2', model: 'sonnet', effort: 'high' },
      { node: 'n3', model: 'sonnet', effort: 'high' },
    ]);
    const events: NodeEvent[] = app.runStore.readEvents(done.id, 'n2');
    expect(events.slice(0, 2)).toMatchObject([{ type: 'start', model: 'sonnet', effort: 'high' }, { type: 'text', text: note }]);
  });

  it('a re-run resolves the steps it runs again, and a reused step keeps what it ran with', async () => {
    const defaults: ModelSelection = { model: 'sonnet', effort: 'high' };
    const { app, graphId, client, last } = setup(defaults);
    app.graphStore.apply(graphId, { type: 'addNode', node: { id: 'n1', title: 'first', kind: 'agent', prompt: 'p' } }, 'user');
    app.graphStore.apply(graphId, { type: 'addNode', node: { id: 'n2', title: 'second', kind: 'agent', prompt: 'p', effort: 'low' } }, 'user');
    app.graphStore.apply(graphId, { type: 'connect', from: 'n1', to: 'n2' }, 'user');
    const first = await run(app, client, last, graphId);
    defaults.model = 'haiku';
    delete defaults.effort;
    const second = await run(app, client, last, graphId, { fromNodeId: 'n2', sourceRunId: first.id });
    expect(second.nodes.n1.status).toBe('reused');
    expect(second.stepModels).toEqual({ n1: { model: 'sonnet', effort: 'high' }, n2: { model: 'haiku', note: 'Haiku (haiku) has no "low" effort level; running without an effort level.' } });
  });

  it('with no model list known yet, a step tries its own model', async () => {
    const { app, graphId, client, last } = setup({}, false);
    app.graphStore.apply(graphId, { type: 'addNode', node: { id: 'n1', title: 'own', kind: 'agent', prompt: 'p', model: { provider: 'claude', id: 'claude-fable-5' } } }, 'user');
    const done = await run(app, client, last, graphId);
    expect(done.stepModels).toEqual({ n1: { model: 'claude-fable-5' } });
  });
});
