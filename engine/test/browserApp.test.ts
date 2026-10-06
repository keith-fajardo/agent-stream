import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { BROWSER_IN_USE, NO_BROWSER_FOUND, RUN_STOPPED, type NewNodeInput, type RunMeta, type ServerMessage } from '@agent-stream/shared';
import { createApp, type App } from '../src/app';
import { browserDir, createBrowserLock } from '../src/browser/launcher';
import { BrowserService } from '../src/browser/service';
import { createBrowserTools, type BrowserTool } from '../src/browser/tools';
import type { NodeContext, NodeOutcome } from '../src/executors';
import type { ToolGate } from '../src/providers/toolGate';
import { FakeContext } from './browserFakes';
import { appTestDeps, signedIn, testGitBash, testProvider, tmpProject, tmpValuesFile } from './helpers';

// The real tool set, which a test can make throw once (a step must still end when its tools can't be made).
vi.mock('../src/browser/tools', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/browser/tools')>();
  return { ...real, createBrowserTools: vi.fn(real.createBrowserTools) };
});

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const JOBS = 'https://jobs.example/';
const SNAP = ['- link "Data engineer" [ref=e2]', '- button "Easy Apply" [ref=e3]'].join('\n');
const elements = Object.fromEntries(['e2', 'e3'].map((ref) => [ref, { text: '', attributes: {}, html: `<x id="${ref}"></x>` }]));

/** An App whose provider records what each step got, with a browser service over fake windows. */
function setup(o: { found?: boolean; otherWindow?: boolean; launchGate?: Promise<void>; step?: (ctx: NodeContext, gate: ToolGate) => Promise<NodeOutcome> } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'agent-stream-home-'));
  let found = o.found !== false;
  const contexts: FakeContext[] = [];
  const browser = new BrowserService({
    home,
    platform: 'darwin',
    env: {},
    settings: () => ({ path: '', searchEngine: '' }),
    exists: (p) => found && p === CHROME,
    lock: createBrowserLock({ dir: browserDir(home), pid: 100, isAlive: (pid) => pid === 100 || pid === 200 }),
    launch: async () => {
      await o.launchGate;
      const c = new FakeContext();
      c.sites[JOBS] = { title: 'Jobs', text: 'A job', snapshot: SNAP, elements };
      contexts.push(c);
      return c;
    },
  });
  if (o.otherWindow) {
    const other = createBrowserLock({ dir: browserDir(home), pid: 200, isAlive: () => true });
    other.acquire();
  }
  const seen: Record<string, { tools?: string[]; gate: ToolGate }> = {};
  const provider = testProvider({
    runStep: async (ctx, gate) => {
      ctx.emit({ type: 'start', kind: 'agent', cwd: ctx.cwd, prompt: ctx.prompt });
      seen[ctx.node.id] = { tools: ctx.browserTools?.map((t) => t.name), gate };
      return o.step ? o.step(ctx, gate) : { ok: true, output: 'done' };
    },
  });
  const paths = tmpProject();
  const app = createApp({ ...appTestDeps(), projectDir: paths.root, valuesFile: tmpValuesFile(), provider, status: signedIn, maxParallel: 1, gitBash: testGitBash, browser });
  const graphId = app.graphStore.create('G').id;
  const add = (node: NewNodeInput) => {
    const r = app.graphStore.apply(graphId, { type: 'addNode', node }, 'user');
    if (!r.ok) throw new Error(r.error);
  };
  return { app, graphId, add, seen, contexts, browser, setFound: (v: boolean) => (found = v) };
}

/** Previews and starts a run as the dialog does, and waits for it to end. */
async function run(app: App, graphId: string, extra: { mode?: 'only'; fromNodeId?: string; sourceRunId?: string } = {}): Promise<RunMeta> {
  const msgs: ServerMessage[] = [];
  const c = { send: (m: ServerMessage) => void msgs.push(structuredClone(m)) };
  app.connect(c);
  await app.handle(c, { type: 'previewRun', graphId, ...extra });
  const preview = msgs.filter((m) => m.type === 'runPreview').at(-1)!.preview;
  await app.handle(c, { type: 'startRun', graphId, reviewed: preview.signature, ...extra });
  await vi.waitFor(() => expect(['succeeded', 'failed', 'cancelled']).toContain(msgs.filter((m) => m.type === 'run').at(-1)?.run.status), { timeout: 5000 });
  return app.runStore.get(msgs.filter((m) => m.type === 'run').at(-1)!.run.id)!;
}

async function preview(app: App, graphId: string, extra: { mode?: 'only'; fromNodeId?: string; sourceRunId?: string } = {}) {
  const msgs: ServerMessage[] = [];
  const c = { send: (m: ServerMessage) => void msgs.push(m) };
  await app.handle(c, { type: 'previewRun', graphId, ...extra });
  return msgs.filter((m) => m.type === 'runPreview').at(-1)!.preview;
}

const tool = (ctx: NodeContext, name: string): BrowserTool => ctx.browserTools!.find((t) => t.name === name)!;

describe('runs: Browser steps', () => {
  it('only a step with Browser on gets the browser tools, opened before its agent starts; its gate lets them through', async () => {
    const { app, graphId, add, seen, contexts } = setup();
    add({ title: 'Research', kind: 'agent', prompt: 'Find jobs.', browser: true });
    add({ title: 'Summarise', kind: 'agent', prompt: 'Sum up.' });
    const done = await run(app, graphId);
    expect(done.status).toBe('succeeded');
    expect(contexts).toHaveLength(1);
    expect(seen.n1.tools).toEqual(expect.arrayContaining(['browser_open', 'browser_click', 'browser_wait_for_you']));
    expect(seen.n1.gate.isSelfApproving('mcp__agent_stream_browser__browser_click')).toBe(true);
    // A configured MCP server named "browser" can't borrow the browser tools' self-approval: the namespace is ours alone.
    expect(seen.n1.gate.isSelfApproving('mcp__browser__browser_click')).toBe(false);
    expect(seen.n2.tools).toBeUndefined();
    expect(seen.n2.gate.isSelfApproving('mcp__agent_stream_browser__browser_click')).toBe(false);
  });

  it('a read-only step still gets every browser tool: Access is about files', async () => {
    const { app, graphId, add, seen } = setup();
    add({ title: 'Research', kind: 'agent', prompt: 'Find jobs.', browser: true, access: 'read' });
    await run(app, graphId);
    expect(seen.n1.tools).toEqual(expect.arrayContaining(['browser_open', 'browser_type']));
    expect(await seen.n1.gate.decide('mcp__agent_stream_browser__browser_type', { ref: 'e1', text: 'x' })).toEqual({ allow: true, by: 'graphTool' });
    // Its other non-read-only tools are still refused.
    expect((await seen.n1.gate.decide('Bash', { command: 'ls' })).allow).toBe(false);
  });

  it('records the pages it visits and closes its tabs when it succeeds; a failed step keeps them', async () => {
    const step = async (ctx: NodeContext): Promise<NodeOutcome> => {
      await tool(ctx, 'browser_open').run({ url: JOBS }, ctx.signal);
      return ctx.node.title === 'Fails' ? { ok: false, output: '', error: 'gave up' } : { ok: true, output: 'done' };
    };
    const { app, graphId, add, contexts } = setup({ step });
    add({ title: 'Research', kind: 'agent', prompt: 'p', browser: true });
    add({ title: 'Fails', kind: 'agent', prompt: 'p', browser: true });
    const done = await run(app, graphId);
    expect(done.nodes.n1.browserPages).toEqual([JOBS]);
    expect(app.runStore.readEvents(done.id, 'n1').filter((e) => e.type === 'browser').map((e) => (e.type === 'browser' ? e.text : ''))).toEqual([`🌐 opened ${JOBS}`]);
    const open = contexts[0].open.map((p) => p.url());
    // n1 succeeded: its tab closed. n2 failed: its tab is still there. The window's own first tab stays.
    expect(open.filter((u) => u === JOBS)).toHaveLength(1);
    expect(done.nodes.n2.status).toBe('failed');
  });

  it('fails a Browser step before it starts when no browser is found', async () => {
    const { app, graphId, add, seen } = setup({ found: false });
    add({ title: 'Research', kind: 'agent', prompt: 'p', browser: true });
    const done = await run(app, graphId);
    expect(done.nodes.n1).toMatchObject({ status: 'failed', error: NO_BROWSER_FOUND });
    expect(seen.n1).toBeUndefined();
    expect(app.runStore.readEvents(done.id, 'n1').some((e) => e.type === 'start')).toBe(false);
  });

  it('fails a Browser step before it starts when another VS Code window owns the browser, naming the lock file', async () => {
    const { app, graphId, add, seen } = setup({ otherWindow: true });
    add({ title: 'Research', kind: 'agent', prompt: 'p', browser: true });
    const done = await run(app, graphId);
    expect(done.nodes.n1.status).toBe('failed');
    expect(done.nodes.n1.error).toMatch(new RegExp(`^${BROWSER_IN_USE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\(lock: .+\\)$`));
    expect(seen.n1).toBeUndefined();
    expect(app.runStore.readEvents(done.id, 'n1').some((e) => e.type === 'start')).toBe(false);
  });

  it('the run dialog warns, without blocking, when a Browser step will run and no browser is found', async () => {
    const { app, graphId, add, setFound } = setup();
    add({ title: 'Research', kind: 'agent', prompt: 'p', browser: true });
    add({ title: 'Summarise', kind: 'agent', prompt: 'p' });
    expect((await preview(app, graphId)).warnings).not.toContain(NO_BROWSER_FOUND);
    const first = await run(app, graphId);
    setFound(false);
    const p = await preview(app, graphId);
    expect(p.warnings).toContain(NO_BROWSER_FOUND);
    expect(p.problems).toEqual([]);
    // Run only n2 reuses n1: no browser is needed, so no warning.
    expect((await preview(app, graphId, { mode: 'only', fromNodeId: 'n2', sourceRunId: first.id })).warnings).not.toContain(NO_BROWSER_FOUND);
  });

  it('a reused Browser step, and one Run only leaves out, never open the browser; the dialog gives no browser warning for them', async () => {
    // n3, a Browser step, fails: Run only leaves a step that didn't succeed out.
    const step = async (ctx: NodeContext): Promise<NodeOutcome> => (ctx.node.id === 'n3' ? { ok: false, output: '', error: 'gave up' } : { ok: true, output: 'done' });
    const { app, graphId, add, browser, setFound, seen } = setup({ step });
    add({ title: 'Research', kind: 'agent', prompt: 'p', browser: true });
    add({ title: 'Summarise', kind: 'agent', prompt: 'p' });
    add({ title: 'Browse more', kind: 'agent', prompt: 'p', browser: true });
    const edge = app.graphStore.apply(graphId, { type: 'connect', from: 'n1', to: 'n2' }, 'user');
    if (!edge.ok) throw new Error(edge.error);
    const source = await run(app, graphId);
    expect([source.nodes.n1.status, source.nodes.n2.status, source.nodes.n3.status]).toEqual(['succeeded', 'succeeded', 'failed']);
    const starts = vi.spyOn(browser, 'startStep');
    for (const id of Object.keys(seen)) delete seen[id];
    // Run only n2: n1 is reused and n3 doesn't run. No browser is needed, even with none to be found.
    setFound(false);
    const only = { mode: 'only' as const, fromNodeId: 'n2', sourceRunId: source.id };
    expect((await preview(app, graphId, only)).warnings).not.toContain(NO_BROWSER_FOUND);
    const alone = await run(app, graphId, only);
    expect([alone.nodes.n1.status, alone.nodes.n2.status, alone.nodes.n3.status]).toEqual(['reused', 'succeeded', 'not_run']);
    expect(starts).not.toHaveBeenCalled();
    expect(Object.keys(seen)).toEqual(['n2']);
    // A re-run from n2 reuses n1: only n3, which runs again, opens the browser.
    setFound(true);
    const rerun = await run(app, graphId, { fromNodeId: 'n2', sourceRunId: source.id });
    expect([rerun.nodes.n1.status, rerun.nodes.n2.status, rerun.nodes.n3.status]).toEqual(['reused', 'succeeded', 'failed']);
    expect(starts.mock.calls.map(([owner]) => owner.nodeId)).toEqual(['n3']);
  });

  it('a graph without Browser steps never looks for a browser', async () => {
    const { app, graphId, add, contexts } = setup({ found: false });
    add({ title: 'Summarise', kind: 'agent', prompt: 'p' });
    expect((await preview(app, graphId)).warnings).not.toContain(NO_BROWSER_FOUND);
    expect((await run(app, graphId)).status).toBe('succeeded');
    expect(contexts).toEqual([]);
  });
});

describe('runs: a Browser step ends its browser step, whatever way the step ended', () => {
  it('aborts the step signal when the step ends, and ends a wait it left pending', async () => {
    let signal: AbortSignal | undefined;
    let leftWaiting: Promise<{ text: string; isError?: boolean }> | undefined;
    const step = async (ctx: NodeContext): Promise<NodeOutcome> => {
      signal = ctx.signal;
      leftWaiting = tool(ctx, 'browser_wait_for_you').run({ reason: 'log in' }, ctx.signal);
      return { ok: true, output: 'done' };
    };
    const { app, graphId, add, browser } = setup({ step });
    add({ title: 'Research', kind: 'agent', prompt: 'p', browser: true });
    const done = await run(app, graphId);
    expect(done.status).toBe('succeeded');
    expect(signal!.aborted).toBe(true);
    expect(await leftWaiting).toEqual({ text: RUN_STOPPED, isError: true });
    expect(browser.state().steps).toEqual([]);
    expect(browser.waiting()).toEqual([]);
  });

  it('a provider that throws still ends the step: it fails with the error, its signal aborts, its tabs stay and it leaves the status bar', async () => {
    let signal: AbortSignal | undefined;
    const step = async (ctx: NodeContext): Promise<NodeOutcome> => {
      signal = ctx.signal;
      await tool(ctx, 'browser_open').run({ url: JOBS }, ctx.signal);
      throw new Error('provider blew up');
    };
    const { app, graphId, add, browser, contexts } = setup({ step });
    add({ title: 'Research', kind: 'agent', prompt: 'p', browser: true });
    const done = await run(app, graphId);
    expect(done.nodes.n1).toMatchObject({ status: 'failed', error: 'provider blew up' });
    expect(signal!.aborted).toBe(true);
    expect(browser.state().steps).toEqual([]);
    // A step that did not succeed leaves its tabs for the user.
    expect(contexts[0].open.map((p) => p.url())).toContain(JOBS);
  });

  it('a provider that throws while a wait is pending ends the wait', async () => {
    let leftWaiting: Promise<{ text: string; isError?: boolean }> | undefined;
    const step = async (ctx: NodeContext): Promise<NodeOutcome> => {
      leftWaiting = tool(ctx, 'browser_wait_for_you').run({ reason: 'log in' }, ctx.signal);
      await Promise.resolve();
      throw new Error('provider blew up');
    };
    const { app, graphId, add, browser } = setup({ step });
    add({ title: 'Research', kind: 'agent', prompt: 'p', browser: true });
    const done = await run(app, graphId);
    expect(done.nodes.n1.status).toBe('failed');
    expect(await leftWaiting).toEqual({ text: RUN_STOPPED, isError: true });
    expect(browser.waiting()).toEqual([]);
  });

  it('Stop ends the step as cancelled and releases its wait', async () => {
    let leftWaiting: Promise<{ text: string; isError?: boolean }> | undefined;
    const step = (ctx: NodeContext): Promise<NodeOutcome> =>
      new Promise((resolve) => {
        leftWaiting = tool(ctx, 'browser_wait_for_you').run({ reason: 'log in' }, ctx.signal);
        ctx.signal.addEventListener('abort', () => resolve({ ok: false, output: '', error: 'stopped' }), { once: true });
      });
    const { app, graphId, add, browser } = setup({ step });
    add({ title: 'Research', kind: 'agent', prompt: 'p', browser: true });
    const msgs: ServerMessage[] = [];
    const c = { send: (m: ServerMessage) => void msgs.push(structuredClone(m)) };
    app.connect(c);
    await app.handle(c, { type: 'previewRun', graphId });
    const p = msgs.filter((m) => m.type === 'runPreview').at(-1)!.preview;
    await app.handle(c, { type: 'startRun', graphId, reviewed: p.signature });
    await vi.waitFor(() => expect(browser.waiting()).toHaveLength(1), { timeout: 5000 });
    const runId = msgs.filter((m) => m.type === 'run').at(-1)!.run.id;
    await app.handle(c, { type: 'stopRun', runId });
    await vi.waitFor(() => expect(app.runStore.get(runId)?.nodes.n1.status).toBe('cancelled'), { timeout: 5000 });
    expect(await leftWaiting).toEqual({ text: RUN_STOPPED, isError: true });
    expect(browser.state().steps).toEqual([]);
  });
});

describe('runs: a Browser step that never gets to its agent', () => {
  it('Stop while the browser opens: the step ends cancelled, its agent never starts, and it leaves the status bar', async () => {
    let release!: () => void;
    const { app, graphId, add, browser, seen } = setup({ launchGate: new Promise<void>((r) => (release = r)) });
    add({ title: 'Research', kind: 'agent', prompt: 'p', browser: true });
    const ended = vi.fn();
    browser.on('state', (s: { steps: string[] }) => ended(s.steps));
    const msgs: ServerMessage[] = [];
    const c = { send: (m: ServerMessage) => void msgs.push(structuredClone(m)) };
    app.connect(c);
    await app.handle(c, { type: 'previewRun', graphId });
    const p = msgs.filter((m) => m.type === 'runPreview').at(-1)!.preview;
    await app.handle(c, { type: 'startRun', graphId, reviewed: p.signature });
    const runId = msgs.filter((m) => m.type === 'run').at(-1)!.run.id;
    await app.handle(c, { type: 'stopRun', runId });
    release();
    await vi.waitFor(() => expect(app.runStore.get(runId)?.nodes.n1.status).toBe('cancelled'), { timeout: 5000 });
    expect(seen.n1).toBeUndefined();
    await vi.waitFor(() => expect(browser.state().steps).toEqual([]));
    expect(app.runStore.readEvents(runId, 'n1').some((e) => e.type === 'start')).toBe(false);
  });

  it("a step whose browser tools can't be made still ends its browser step", async () => {
    const { app, graphId, add, browser, seen } = setup();
    add({ title: 'Research', kind: 'agent', prompt: 'p', browser: true });
    vi.mocked(createBrowserTools).mockImplementationOnce(() => {
      throw new Error('no tools');
    });
    const done = await run(app, graphId);
    expect(done.nodes.n1.status).toBe('failed');
    expect(seen.n1).toBeUndefined();
    expect(browser.state().steps).toEqual([]);
  });
});

describe('runs: a site allowance belongs to one start of one step', () => {
  /** Answers every browser card as it appears: "on this site" when `site`, else once. Returns the nodes that were asked. */
  function answering(app: App, site: boolean): string[] {
    const asked: string[] = [];
    const seenIds = new Set<string>();
    app.broker.on('changed', (pending: { id: string; nodeId: string }[]) => {
      for (const r of pending) {
        if (seenIds.has(r.id)) continue;
        seenIds.add(r.id);
        asked.push(r.nodeId);
        queueMicrotask(() => app.broker.decide(r.id, site ? { decision: 'approve', scope: 'site' } : { decision: 'approve' }));
      }
    });
    return asked;
  }
  /** Opens the jobs page and clicks twice: with "on this site" the second click asks nothing. */
  const clicking = async (ctx: NodeContext): Promise<NodeOutcome> => {
    await tool(ctx, 'browser_open').run({ url: JOBS }, ctx.signal);
    await tool(ctx, 'browser_snapshot').run({}, ctx.signal);
    const first = await tool(ctx, 'browser_click').run({ ref: 'e3' }, ctx.signal);
    const second = await tool(ctx, 'browser_click').run({ ref: 'e3' }, ctx.signal);
    return first.isError || second.isError ? { ok: false, output: '', error: `${first.text} / ${second.text}` } : { ok: true, output: 'done' };
  };

  it('two steps of one run each ask once for the same site', async () => {
    const { app, graphId, add } = setup({ step: clicking });
    add({ title: 'One', kind: 'agent', prompt: 'p', browser: true });
    add({ title: 'Two', kind: 'agent', prompt: 'p', browser: true });
    const asked = answering(app, true);
    const done = await run(app, graphId);
    expect(done.status).toBe('succeeded');
    // Each step's first click asked, its second ran under its own allowance; n2 did not inherit n1's.
    expect(asked).toEqual(['n1', 'n2']);
  });

  it('the same step on a re-run asks again', async () => {
    const { app, graphId, add } = setup({ step: clicking });
    add({ title: 'One', kind: 'agent', prompt: 'p', browser: true });
    const asked = answering(app, true);
    expect((await run(app, graphId)).status).toBe('succeeded');
    expect(asked).toEqual(['n1']);
    expect((await run(app, graphId)).status).toBe('succeeded');
    expect(asked).toEqual(['n1', 'n1']);
  });

  it('a step gets a fresh tool set at each start', async () => {
    const sets: BrowserTool[][] = [];
    const step = async (ctx: NodeContext): Promise<NodeOutcome> => {
      sets.push(ctx.browserTools!);
      return { ok: true, output: 'done' };
    };
    const { app, graphId, add } = setup({ step });
    add({ title: 'One', kind: 'agent', prompt: 'p', browser: true });
    await run(app, graphId);
    await run(app, graphId);
    expect(sets).toHaveLength(2);
    expect(sets[0][0]).not.toBe(sets[1][0]);
  });
});
