import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { applyOp, derivedStatus, emptyGraph, expandGraph, type Graph, type GraphLookup, type Op, type RunMeta, type ServerMessage } from '@agent-stream/shared';
import { ApprovalBroker } from '../src/approvals';
import { createApp } from '../src/app';
import type { NodeContext, NodeExecutor, NodeOutcome } from '../src/executors';
import { needsCheckoutLease, Runner } from '../src/runner';
import { RunStore } from '../src/runStore';
import { appTestDeps, deferred, signedIn, testGitBash, testLeases, testProvider, tmpProject, tmpValuesFile } from './helpers';

/**
 * Job hunting: n1 Plan → n2 Research (sub-graph: Company research) → n3 Letter.
 * Company research: n1 Find site → n2 Read news and n1 → n3 Summarize, so n2 and n3 are its last steps.
 */
function setup(outcomes: Record<string, NodeOutcome | Promise<NodeOutcome>> = {}) {
  const paths = tmpProject();
  const contexts = new Map<string, NodeContext>();
  const exec: NodeExecutor = async (ctx) => {
    contexts.set(ctx.node.id, ctx);
    ctx.emit({ type: 'start', kind: ctx.node.kind, cwd: ctx.cwd });
    return (await outcomes[ctx.node.id]) ?? { ok: true, output: `out-${ctx.node.id}` };
  };
  const app = createApp({ ...appTestDeps(), projectDir: paths.root, valuesFile: tmpValuesFile(), provider: testProvider(), status: signedIn, maxParallel: 2, gitBash: testGitBash, executors: { agent: exec, command: exec } });
  const msgs: ServerMessage[] = [];
  const c = { send: (m: ServerMessage) => void msgs.push(structuredClone(m)) };
  app.connect(c);
  const s = app.graphStore;
  const research = s.create('Company research').id;
  for (const op of [
    { type: 'setGoal', goal: 'Know {{ company }}.' },
    { type: 'setInstructions', instructions: 'Use public sources.' },
    { type: 'addVariable', name: 'company' },
    { type: 'addNode', node: { title: 'Find site', kind: 'agent', prompt: 'Find the site of {{ company }}.' } },
    { type: 'addNode', node: { title: 'Read news', kind: 'agent', prompt: 'Read the news.' } },
    { type: 'addNode', node: { title: 'Summarize', kind: 'agent', prompt: 'Summarize.' } },
    { type: 'connect', from: 'n1', to: 'n2' },
    { type: 'connect', from: 'n1', to: 'n3' },
  ] as Op[]) s.apply(research, op, 'user');
  const hunting = s.create('Job hunting').id;
  for (const op of [
    { type: 'setGoal', goal: 'Get a job.' },
    { type: 'addNode', node: { title: 'Plan', kind: 'agent', prompt: 'Plan.' } },
    { type: 'addNode', node: { title: 'Research', kind: 'graph', graph: research, values: { company: 'Acme' } } },
    { type: 'addNode', node: { title: 'Letter', kind: 'agent', prompt: 'Write the letter.' } },
    { type: 'connect', from: 'n1', to: 'n2' },
    { type: 'connect', from: 'n2', to: 'n3' },
  ] as Op[]) s.apply(hunting, op, 'user');
  const runs = () => msgs.filter((m): m is Extract<ServerMessage, { type: 'run' }> => m.type === 'run').map((m) => m.run);
  /** Reviews and starts a run like the dialog, and waits for it to end. */
  async function runGraph(extra: { mode?: 'resume' | 'from' | 'only'; fromNodeId?: string; sourceRunId?: string } = {}, wait = true): Promise<RunMeta> {
    await app.handle(c, { type: 'previewRun', graphId: hunting, ...extra });
    const preview = msgs.filter((m): m is Extract<ServerMessage, { type: 'runPreview' }> => m.type === 'runPreview').at(-1)!.preview;
    expect(preview.problems).toEqual([]);
    const before = runs().length;
    await app.handle(c, { type: 'startRun', graphId: hunting, reviewed: preview.signature, ...extra });
    await vi.waitFor(() => expect(runs().length).toBeGreaterThan(before), { timeout: 5000 });
    const id = runs().at(-1)!.id;
    if (wait) await vi.waitFor(() => expect(app.runner.get(id)).toBeUndefined(), { timeout: 5000 });
    return app.runStore.get(id)!;
  }
  return { app, c, paths, contexts, research, hunting, runGraph, msgs };
}

describe('a run with a sub-graph step', () => {
  it('runs the inner steps with the inner goal and instructions, collects the last steps’ outputs, and gives them to the step after', async () => {
    const s = setup();
    const meta = await run(s);
    expect(meta.status).toBe('succeeded');
    expect(Object.keys(meta.nodes).sort()).toEqual(['n1', 'n2', 'n2/n1', 'n2/n2', 'n2/n3', 'n3']);
    expect(meta.scopes).toEqual({ n2: { stepId: 'n2', graphId: s.research, graphName: 'Company research', depth: 1, values: { company: 'Acme' } } });
    expect(meta.rendered?.scopes).toEqual({ n2: { goal: 'Know Acme.', instructions: 'Use public sources.' } });
    const inner = s.contexts.get('n2/n1')!.prompt;
    expect(inner).toContain('# Workflow goal\nKnow Acme.');
    expect(inner).toContain('# Instructions & context\nUse public sources.');
    expect(inner).not.toContain('Get a job.');
    expect(inner).toContain('Find the site of Acme.');
    // The inner first step gets what fed the sub-graph step.
    expect(inner).toContain('## n1 · Plan (agent, succeeded)\nout-n1');
    const out = (id: string) => join('.agent-stream', 'runs', meta.id, 'nodes', id, 'output.md');
    const collected = `### n2 · Read news\nout-n2/n2\nFull output: ${out('n2~n2')}\n\n### n3 · Summarize\nout-n2/n3\nFull output: ${out('n2~n3')}`;
    expect(s.app.runStore.readOutput(meta.id, 'n2')).toBe(collected);
    expect(s.contexts.get('n3')!.prompt).toContain(`## n2 · Research (sub-graph "Company research", succeeded)\n${collected}\nFull output: ${out('n2')}`);
    expect(s.contexts.get('n3')!.prompt).toContain('# Workflow goal\nGet a job.');
    // The sub-graph step ran no executor and logged its start and result.
    expect(s.contexts.has('n2')).toBe(false);
    expect(s.app.runStore.readEvents(meta.id, 'n2').map((e) => e.type)).toEqual(['start', 'result']);
    expect(s.app.runStore.readEvents(meta.id, 'n2')[0]).toMatchObject({ type: 'start', kind: 'graph' });
  });

  it('gives an inner step its sub-graph’s attachments, from that graph’s folder', async () => {
    const s = setup();
    const folder = join(s.paths.attachmentsDir, s.research);
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'brief.md'), 'brief');
    s.app.graphStore.apply(s.research, { type: 'setGraphAttachments', names: ['brief.md'] }, 'user');
    const meta = await run(s);
    expect(s.contexts.get('n2/n1')!.attachments?.map((a) => a.path)).toEqual([join(folder, 'brief.md')]);
    expect(s.contexts.get('n1')!.attachments).toBeUndefined();
    expect(meta.attachments).toEqual([{ name: 'brief.md', sha256: expect.any(String), graphId: s.research }]);
  });

  it('an inner failure fails the run: the sub-graph step shows failed and the steps after it do not run', async () => {
    const s = setup({ 'n2/n2': { ok: false, output: '', error: 'boom' } });
    const meta = await run(s);
    expect(meta.status).toBe('failed');
    expect(meta.nodes['n2'].status).toBe('not_run');
    expect(meta.nodes['n3'].status).toBe('not_run');
    expect(derivedStatus(meta, 'n2')?.status).toBe('failed');
  });

  it('Retry from where it stopped resumes inside the sub-graph', async () => {
    const outcomes: Record<string, NodeOutcome> = { 'n2/n2': { ok: false, output: '', error: 'boom' } };
    const s = setup(outcomes);
    const first = await run(s);
    delete outcomes['n2/n2'];
    const second = await run(s, { mode: 'resume', sourceRunId: first.id });
    expect(second.status).toBe('succeeded');
    expect(Object.fromEntries(Object.entries(second.nodes).map(([id, st]) => [id, st.status]))).toEqual({ n1: 'reused', 'n2/n1': 'reused', 'n2/n2': 'succeeded', 'n2/n3': 'reused', n2: 'succeeded', n3: 'succeeded' });
  });

  it('Stop in the middle of a sub-graph stops it all', async () => {
    const held = deferred<NodeOutcome>();
    const s = setup({ 'n2/n2': held.promise });
    const started = await run(s, {}, false);
    await vi.waitFor(() => expect(s.contexts.has('n2/n2')).toBe(true), { timeout: 5000 });
    await s.app.handle(s.c, { type: 'stopRun', runId: started.id });
    held.resolve({ ok: false, output: '', error: 'stopped' });
    await vi.waitFor(() => expect(s.app.runner.get(started.id)).toBeUndefined(), { timeout: 5000 });
    const meta = s.app.runStore.get(started.id)!;
    expect(meta.status).toBe('cancelled');
    expect(meta.nodes['n2'].status).toBe('cancelled');
    expect(derivedStatus(meta, 'n2')?.status).toBe('cancelled');
  });

  it('refuses to delete a graph while a run uses it as a sub-graph', async () => {
    const held = deferred<NodeOutcome>();
    const s = setup({ 'n2/n1': held.promise });
    const started = await run(s, {}, false);
    await vi.waitFor(() => expect(s.contexts.has('n2/n1')).toBe(true), { timeout: 5000 });
    expect(s.app.deleteGraph(s.research)).toEqual({ ok: false, error: '"Company research" is being used by a run of "Job hunting". Stop it first.' });
    held.resolve({ ok: true, output: 'done' });
    await vi.waitFor(() => expect(s.app.runner.get(started.id)).toBeUndefined(), { timeout: 5000 });
    expect(s.app.deleteGraph(s.research)).toEqual({ ok: true });
  });
});

/** Reviews and starts a run of Job hunting, and (unless `wait` is false) waits for it to end. */
function run(s: ReturnType<typeof setup>, extra: Parameters<ReturnType<typeof setup>['runGraph']>[0] = {}, wait = true) {
  return s.runGraph(extra, wait);
}

describe('run records for steps inside sub-graphs', () => {
  it('keep each step in nodes/<folder id>/, at most 4 levels', () => {
    const paths = tmpProject();
    const store = new RunStore(paths);
    const runId = '20261007-120000-abcd';
    store.create({ id: runId, graphId: 'g', status: 'running', startedAt: 't', snapshot: emptyGraph('g', 'G', 't'), nodes: {} });
    store.writeOutput(runId, 'n4/n2', 'inner');
    store.appendEvent(runId, 'n4/n2', { type: 'text', text: 'hi', at: 't' });
    expect(store.readOutput(runId, 'n4/n2')).toBe('inner');
    expect(store.readEvents(runId, 'n4/n2')).toEqual([{ type: 'text', text: 'hi', at: 't' }]);
    expect(store.outputRelPath(runId, 'n4/n2')).toBe(join('.agent-stream', 'runs', runId, 'nodes', 'n4~n2', 'output.md'));
    expect(() => store.writeOutput(runId, 'a/b/c/d/e', 'x')).toThrow('invalid node id "a/b/c/d/e"');
    expect(store.readOutput(runId, '../x')).toBe('');
  });
});

describe('the runner on an expanded graph', () => {
  const graphOf = (id: string, name: string, ops: Op[]): Graph =>
    ops.reduce((g, op) => {
      const r = applyOp(g, op, 'user', 't');
      if (!r.ok) throw new Error(r.error);
      return r.graph;
    }, emptyGraph(id, name, 't'));
  const lookupOf =
    (...graphs: Graph[]): GraphLookup =>
    (id) => {
      const g = graphs.find((x) => x.id === id);
      return g ? { ok: true, graph: g } : { ok: false, reason: 'missing', error: 'missing' };
    };

  it('needs no lease for a sub-graph whose inner steps only read', () => {
    const readers = graphOf('readers', 'Readers', [{ type: 'addNode', node: { title: 'Read', kind: 'agent', prompt: 'r', access: 'read' } }]);
    const writers = graphOf('writers', 'Writers', [{ type: 'addNode', node: { title: 'Write', kind: 'agent', prompt: 'w' } }]);
    const outer = (inner: string) => graphOf('o', 'O', [{ type: 'addNode', node: { title: 'Look', kind: 'agent', prompt: 'l', access: 'read' } }, { type: 'addNode', node: { title: 'Sub', kind: 'graph', graph: inner } }]);
    const expanded = (inner: string) => {
      const r = expandGraph(outer(inner), lookupOf(readers, writers));
      if (!r.ok) throw new Error('expected an expansion');
      return r.graph;
    };
    expect(needsCheckoutLease(expanded('readers'), new Set())).toBe(false);
    expect(needsCheckoutLease(expanded('writers'), new Set())).toBe(true);
  });

  it('runs an inner step in its scoped workspace and names the inner graph’s own workspace in its prompt', async () => {
    const inner = graphOf('inner', 'Inner', [{ type: 'addNode', node: { title: 'Build', kind: 'agent', prompt: 'Build it.', workspace: 'wh_a' } }]);
    const outer = graphOf('o', 'O', [{ type: 'addNode', node: { title: 'Sub', kind: 'graph', graph: 'inner' } }]);
    const r = expandGraph(outer, lookupOf(inner));
    if (!r.ok) throw new Error('expected an expansion');
    expect(r.graph.nodes.find((n) => n.id === 'n1/n1')?.workspace).toBe('n1~wh_a');
    const paths = tmpProject();
    const worktree = mkdtempSync(join(tmpdir(), 'agent-stream-wt-'));
    const seen: NodeContext[] = [];
    const exec: NodeExecutor = async (ctx) => {
      seen.push(ctx);
      return { ok: true, output: 'built' };
    };
    const runner = new Runner({ runStore: new RunStore(paths), broker: new ApprovalBroker(), executors: { agent: exec, command: exec }, projectDir: paths.root, maxParallel: 2, leases: testLeases() });
    const started = runner.start({
      graph: r.graph,
      rendered: { goal: '', instructions: '', nodes: { n1: '', 'n1/n1': 'Build it.' }, scopes: { n1: { goal: 'Inner goal.', instructions: '' } } },
      scopes: r.scopes,
      workspaces: { 'n1~wh_a': { path: worktree, head: 'abcdef1234567890' } },
    });
    if (!started.ok) throw new Error(started.error);
    const meta = await started.done;
    expect(meta.status).toBe('succeeded');
    expect(seen[0].cwd).toBe(worktree);
    expect(seen[0].prompt).toContain(`You are working in workspace "wh_a" at ${worktree}: a separate Git worktree of this repository at abcdef1. Change files only there.`);
    expect(seen[0].prompt).toContain('# Workflow goal\nInner goal.');
    expect(seen[0].scopeName).toBe('Inner');
  });

  it('fails the sub-graph step and finishes the run when completing it throws unexpectedly', { timeout: 2000 }, async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const inner = graphOf('inner', 'Inner', [{ type: 'addNode', node: { title: 'Build', kind: 'agent', prompt: 'Build it.' } }]);
    const outer = graphOf('o', 'O', [{ type: 'addNode', node: { title: 'Sub', kind: 'graph', graph: 'inner' } }]);
    const r = expandGraph(outer, lookupOf(inner));
    if (!r.ok) throw new Error('expected an expansion');
    // The first time the sub-graph step is cleaned up, the broker throws, as a bug in completing a step would.
    let thrown = false;
    class FlakyBroker extends ApprovalBroker {
      override endStep(runId: string, nodeId: string): void {
        if (nodeId === 'n1' && !thrown) {
          thrown = true;
          throw new Error('broker bug');
        }
        super.endStep(runId, nodeId);
      }
    }
    const paths = tmpProject();
    const exec: NodeExecutor = async () => ({ ok: true, output: 'built' });
    const runner = new Runner({ runStore: new RunStore(paths), broker: new FlakyBroker(), executors: { agent: exec, command: exec }, projectDir: paths.root, maxParallel: 2, leases: testLeases() });
    const started = runner.start({ graph: r.graph, rendered: { goal: '', instructions: '', nodes: { n1: '', 'n1/n1': 'Build it.' }, scopes: { n1: { goal: '', instructions: '' } } }, scopes: r.scopes });
    if (!started.ok) throw new Error(started.error);
    const meta = await started.done;
    expect(meta.status).toBe('failed');
    expect(meta.nodes.n1.status).toBe('failed');
    expect(meta.nodes.n1.error).toBe('Agent Stream internal error: broker bug');
  });
});
