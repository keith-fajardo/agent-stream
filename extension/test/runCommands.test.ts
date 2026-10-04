import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createApp, type NodeOutcome } from '@agent-stream/engine';
import type { HostMessage } from '@agent-stream/shared';
import { EngineManager, type Folder } from '../src/engines';
import { noGit } from './helpers';
import { GraphPanel, GraphPanels } from '../src/graphEditor';
import { runCommands } from '../src/runCommands';

const folder = (name: string): Folder => {
  const path = mkdtempSync(join(tmpdir(), `cs-${name}-`));
  return { key: `file://${path}`, name, path };
};

function setup() {
  const f = folder('a');
  const held = (ctx: { signal: AbortSignal }) =>
    new Promise<NodeOutcome>((resolve) => ctx.signal.addEventListener('abort', () => resolve({ ok: false, output: '', error: 'cancelled' })));
  const manager = new EngineManager({
    settings: () => ({ claudePath: '', codexPath: '', gitBashPath: '', maxParallel: 1, provider: 'claude', model: '', effort: '' as const, copilotMaxRequestsPerStep: 25, copilotMaxRequestsPerTurn: 10 }),
    platform: 'darwin',
    env: {},
    home: mkdtempSync(join(tmpdir(), 'cs-home-')),
    git: noGit,
    events: { graphs() {}, approvals() {}, confirmRun() {}, graphDeleted() {}, sessions() {}, auth() {}, warning() {} },
    checkAuth: async () => ({ provider: 'claude' as const, ok: true, label: 'Claude Max' }),
    findClaude: () => ({ ok: true, path: '/bin/claude' }),
    // Signed in from the start (no checkSignIn in these tests), with steps that wait to be stopped.
    createApp: (deps) => createApp({ ...deps, status: { provider: 'claude', ok: true, label: 'Claude Max' }, executors: { agent: held, command: held } }),
  });
  const app = manager.get(f);
  const g = app.createGraph('G');
  const panels = new GraphPanels();
  const sent: { graphId: string; msg: HostMessage }[] = [];
  const info = vi.fn();
  const showSidebar = vi.fn();
  const cmds = runCommands({
    engines: manager,
    panels,
    pickGraph: async () => undefined,
    openAndSend: async (t, msg) => void sent.push({ graphId: t.graphId, msg }),
    info,
    showSidebar,
  });
  const activate = () => panels.add(new GraphPanel(f, g.id, { post() {}, reveal() {}, close() {}, visible: () => true, active: () => true }));
  return { manager, f, app, g, cmds, sent, info, showSidebar, activate };
}

describe('run commands', () => {
  it('opens the run dialog and the Variables dialog in the active tab', async () => {
    const s = setup();
    s.activate();
    await s.cmds.runGraph();
    await s.cmds.editVariables();
    expect(s.sent).toEqual([
      { graphId: s.g.id, msg: { type: 'openRunDialog' } },
      { graphId: s.g.id, msg: { type: 'openVariables' } },
    ]);
  });

  it("stops the active tab's run, or says nothing is running", async () => {
    const s = setup();
    s.activate();
    await s.cmds.stopRun();
    expect(s.info).toHaveBeenCalledWith('Nothing is running in this graph.');
    s.app.graphStore.apply(s.g.id, { type: 'addNode', node: { title: 'b', kind: 'command', command: 'x' } }, 'user');
    const msgs: { type: string; preview?: { signature: string } }[] = [];
    const client = { send: (m: never) => void msgs.push(m) };
    await s.app.handle(client, { type: 'previewRun', graphId: s.g.id });
    await s.app.handle(client, { type: 'startRun', graphId: s.g.id, reviewed: msgs.find((m) => m.type === 'runPreview')!.preview!.signature });
    await s.cmds.stopRun();
    await vi.waitFor(() => expect(s.app.runner.activeFor(s.g.id)).toBeUndefined());
  });

  it('decides approvals one by one or all at once, and reveals the step', async () => {
    const s = setup();
    const ask = () => s.app.broker.request({ runId: 'r', graphId: s.g.id, nodeId: 'n1', nodeTitle: 'b', toolName: 'Bash', input: {} });
    const one = ask();
    const two = ask();
    const three = ask();
    const item = (id: string) => ({ folder: s.f, request: s.app.broker.pending().find((p) => p.id === id)! });
    await s.cmds.revealApproval(item(one.id));
    expect(s.sent.at(-1)).toEqual({ graphId: s.g.id, msg: { type: 'revealNode', nodeId: 'n1' } });
    s.cmds.deny(item(one.id));
    expect(await one.decision).toEqual({ decision: 'deny' });
    s.cmds.approve(item(two.id));
    expect(await two.decision).toEqual({ decision: 'approve' });
    s.cmds.approveAll();
    expect(await three.decision).toEqual({ decision: 'approve' });
  });

  it('leaves graph-change approvals out of Approve all, since each needs its own approval', async () => {
    const s = setup();
    const ask = (graphChange?: { summary: string; detail: string }) =>
      s.app.broker.request({ runId: 'r', graphId: s.g.id, nodeId: 'n1', nodeTitle: 'b', toolName: graphChange ? 'Change graph' : 'Bash', input: {}, ...(graphChange ? { graphChange } : {}) });
    const plain = ask();
    const change = ask({ summary: 'n1 wants to add a step', detail: 'npm ci' });
    s.cmds.approveAll();
    expect(await plain.decision).toEqual({ decision: 'approve' });
    expect(s.app.broker.pending().map((p) => p.id)).toEqual([change.id]);
    s.cmds.approve({ folder: s.f, request: s.app.broker.pending()[0] });
    expect(await change.decision).toEqual({ decision: 'approve' });
  });

  it('does nothing when an approval command gets no item', async () => {
    const s = setup();
    const req = s.app.broker.request({ runId: 'r', graphId: s.g.id, nodeId: 'n1', nodeTitle: 'b', toolName: 'Bash', input: {} });
    expect(() => s.cmds.approve(undefined as never)).not.toThrow();
    expect(() => s.cmds.deny({} as never)).not.toThrow();
    await expect(s.cmds.revealApproval(undefined as never)).resolves.toBeUndefined();
    expect(s.app.broker.pending().map((p) => p.id)).toEqual([req.id]);
    expect(s.sent).toEqual([]);
  });

  it('keeps two folders with the same graph id apart', async () => {
    const s = setup();
    const other = folder('b');
    const appB = s.manager.get(other);
    const ask = (app: typeof s.app) => app.broker.request({ runId: 'r', graphId: 'g', nodeId: 'n1', nodeTitle: 'b', toolName: 'Bash', input: {} });
    const inA = ask(s.app);
    const inB = ask(appB);
    s.cmds.approve({ folder: s.f, request: s.app.broker.pending()[0] });
    expect(await inA.decision).toEqual({ decision: 'approve' });
    expect(appB.broker.pending().map((p) => p.id)).toEqual([inB.id]);
    const again = ask(s.app);
    s.cmds.approveAll();
    expect(await again.decision).toEqual({ decision: 'approve' });
    expect(await inB.decision).toEqual({ decision: 'approve' });
  });

  it('shows the sidebar', () => {
    const s = setup();
    s.cmds.showSidebar();
    expect(s.showSidebar).toHaveBeenCalled();
  });
});
