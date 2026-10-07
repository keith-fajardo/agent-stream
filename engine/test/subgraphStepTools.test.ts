import { describe, expect, it, vi } from 'vitest';
import { approvalSentence, approvalStepLabel, expandGraph, type ServerMessage } from '@agent-stream/shared';
import { ApprovalBroker } from '../src/approvals';
import { createApp } from '../src/app';
import type { NodeContext, NodeExecutor, NodeOutcome } from '../src/executors';
import { GraphStore } from '../src/graphStore';
import type { ToolGate } from '../src/providers/toolGate';
import { Runner } from '../src/runner';
import { RunStore } from '../src/runStore';
import { createStepGraphTools } from '../src/stepGraphTools';
import { appTestDeps, deferred, fixedClock, signedIn, testGitBash, testLeases, testProvider, tmpProject, tmpValuesFile } from './helpers';

const render = (_g: unknown, node: { prompt?: string; command?: string }) => ({ ok: true as const, text: node.prompt ?? node.command ?? '' });

/** Job hunting: n1 Plan (the calling step, held) → n2 Research (sub-graph, its n1 held) → n3 Check, running. */
async function setup() {
  const paths = tmpProject();
  const clock = fixedClock();
  const graphStore = new GraphStore(paths, clock);
  const broker = new ApprovalBroker(clock);
  const inner = graphStore.create('Company research').id;
  graphStore.apply(inner, { type: 'addNode', node: { title: 'Find site', kind: 'agent', prompt: 'find' } }, 'user');
  const outer = graphStore.create('Job hunting').id;
  graphStore.apply(outer, { type: 'addNode', node: { title: 'Plan', kind: 'agent', prompt: 'plan' } }, 'user');
  graphStore.apply(outer, { type: 'addNode', node: { title: 'Research', kind: 'graph', graph: inner } }, 'user');
  graphStore.apply(outer, { type: 'addNode', node: { title: 'Check', kind: 'command', command: 'echo ok' } }, 'user');
  graphStore.apply(outer, { type: 'connect', from: 'n1', to: 'n2' }, 'user');
  graphStore.apply(outer, { type: 'connect', from: 'n2', to: 'n3' }, 'user');
  const expanded = expandGraph(graphStore.get(outer), (id) => graphStore.lookup(id));
  if (!expanded.ok) throw new Error('expected an expansion');
  const contexts = new Map<string, NodeContext>();
  const exec: NodeExecutor = (ctx) =>
    new Promise<NodeOutcome>((resolve) => {
      contexts.set(ctx.node.id, ctx);
      ctx.signal.addEventListener('abort', () => resolve({ ok: false, output: '', error: 'cancelled' }), { once: true });
      if (ctx.node.id !== 'n1') resolve({ ok: true, output: 'ok' });
    });
  const runner = new Runner({ runStore: new RunStore(paths), broker, executors: { agent: exec, command: exec }, projectDir: paths.root, maxParallel: 3, clock, leases: testLeases() });
  const nodes = Object.fromEntries(expanded.graph.nodes.map((n) => [n.id, n.prompt ?? n.command ?? '']));
  const r = runner.start({ graph: expanded.graph, rendered: { goal: '', instructions: '', nodes, scopes: { n2: { goal: '', instructions: '' } } }, scopes: expanded.scopes });
  if (!r.ok) throw new Error(r.error);
  await vi.waitFor(() => expect(contexts.has('n1')).toBe(true));
  const toolsOf = (id: string) => createStepGraphTools({ ctx: contexts.get(id) ?? { ...contexts.get('n1')!, node: expanded.graph.nodes.find((n) => n.id === id)! }, graphStore, runner, broker, render, signal: contexts.get('n1')!.signal });
  const call = (id: string, name: string, input: unknown) => toolsOf(id).find((t) => t.name === name)!.run(input);
  return { call, runner, runId: r.run.id };
}

describe('graph changes during a run stay out of sub-graphs (spec §4.6)', () => {
  it('refuses to connect into or out of a sub-graph step, or to change one', async () => {
    const s = await setup();
    const refusal = { text: "Changes that touch sub-graph step n2 can't be made during a run; change the graph after it finishes.", isError: true };
    expect(await s.call('n1', 'add_step', { title: 'Extra', kind: 'agent', prompt: 'p', after: ['n2'], before: [] })).toEqual(refusal);
    expect(await s.call('n1', 'add_step', { title: 'Extra', kind: 'agent', prompt: 'p', after: [], before: ['n2'] })).toEqual(refusal);
    expect(await s.call('n1', 'change_step', { id: 'n2', title: 'Other' })).toEqual(refusal);
    s.runner.stop(s.runId);
  });

  it('treats a step inside a sub-graph as not existing', async () => {
    const s = await setup();
    expect(await s.call('n1', 'add_step', { title: 'Extra', kind: 'agent', prompt: 'p', after: ['n2/n1'], before: [] })).toEqual({ text: 'node n2/n1 does not exist', isError: true });
    expect(await s.call('n1', 'change_step', { id: 'n2/n1', title: 'x' })).toEqual({ text: 'node n2/n1 does not exist', isError: true });
    s.runner.stop(s.runId);
  });

  it('answers a step inside a sub-graph that reaches the tools anyway', async () => {
    const s = await setup();
    expect(await s.call('n2/n1', 'add_step', { title: 'Extra', kind: 'agent', prompt: 'p', after: [], before: ['n3'] })).toEqual({ text: "Steps inside a sub-graph can't change graphs.", isError: true });
    s.runner.stop(s.runId);
  });
});

describe('an inner step through the App', () => {
  it('gets no graph tools, and its approvals name the sub-graph; Allow all for this step covers its later requests', async () => {
    const paths = tmpProject();
    const seen = new Map<string, NodeContext>();
    const second = deferred<void>();
    const runStep = async (ctx: NodeContext, gate: ToolGate): Promise<NodeOutcome> => {
      seen.set(ctx.node.id, ctx);
      if (ctx.node.id !== 'n1/n1') return { ok: true, output: '' };
      const first = await gate.approve('Bash', { command: 'ls' });
      const again = await gate.approve('Bash', { command: 'pwd' });
      second.resolve();
      return { ok: first.allow && again.allow, output: '' };
    };
    const app = createApp({ ...appTestDeps(), projectDir: paths.root, valuesFile: tmpValuesFile(), provider: testProvider({ runStep }), status: signedIn, maxParallel: 1, gitBash: testGitBash });
    const msgs: ServerMessage[] = [];
    const c = { send: (m: ServerMessage) => void msgs.push(structuredClone(m)) };
    app.connect(c);
    const inner = app.graphStore.create('Company research').id;
    app.graphStore.apply(inner, { type: 'addNode', node: { title: 'Read news', kind: 'agent', prompt: 'read' } }, 'user');
    const outer = app.graphStore.create('Job hunting').id;
    app.graphStore.apply(outer, { type: 'addNode', node: { title: 'Research', kind: 'graph', graph: inner } }, 'user');
    app.graphStore.apply(outer, { type: 'addNode', node: { title: 'Letter', kind: 'agent', prompt: 'write' } }, 'user');
    app.graphStore.apply(outer, { type: 'connect', from: 'n1', to: 'n2' }, 'user');
    await app.handle(c, { type: 'previewRun', graphId: outer });
    const preview = msgs.filter((m): m is Extract<ServerMessage, { type: 'runPreview' }> => m.type === 'runPreview').at(-1)!.preview;
    await app.handle(c, { type: 'startRun', graphId: outer, reviewed: preview.signature });
    await vi.waitFor(() => expect(app.broker.pending()).toHaveLength(1), { timeout: 5000 });
    const request = app.broker.pending()[0];
    expect(request).toMatchObject({ graphId: outer, nodeId: 'n1/n1', nodeTitle: 'Read news', inGraph: 'Company research' });
    expect(approvalStepLabel(request)).toBe('n1/n1 · Read news (in Company research)');
    expect(approvalSentence(request)).toBe('n1/n1 · Read news (in Company research) wants to run: ls');
    expect(seen.get('n1/n1')?.graphTools).toEqual([]);
    await app.handle(c, { type: 'decide', approvalId: request.id, decision: 'approve', scope: 'step' });
    await second.promise;
    expect(app.broker.pending()).toEqual([]);
    await vi.waitFor(() => expect(app.runner.activeFor(outer)).toBeUndefined(), { timeout: 5000 });
    expect(seen.get('n2')?.graphTools?.length).toBeGreaterThan(0);
  });
});
