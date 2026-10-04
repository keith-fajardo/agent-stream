import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { createApp, createClaudeProvider } from '@agent-stream/engine';
import type { HostMessage, ServerMessage } from '@agent-stream/shared';
import type { Folder } from '../src/engines';
import { engineTestDeps } from './helpers';
import { createMessageHandler, GraphPanel, GraphPanels, graphIdFromPath, graphTarget, hostCommandArgs, notGraphText, openAndSend } from '../src/graphEditor';

const folder = (name: string): Folder => {
  const path = mkdtempSync(join(tmpdir(), `cs-${name}-`));
  return { key: `file://${path}`, name, path };
};
function fakeView() {
  const posted: HostMessage[] = [];
  return { posted, view: { post: (m: HostMessage) => void posted.push(m), reveal: vi.fn(), close: vi.fn(), visible: () => false, active: () => false } };
}
function setup() {
  const f = folder('a');
  const done = async () => ({ ok: true, output: '' });
  const app = createApp({
    ...engineTestDeps(),
    projectDir: f.path,
    provider: createClaudeProvider({ findClaude: () => ({ ok: true, path: '/bin/claude' }) }),
    status: { provider: 'claude', ok: true, label: 'Claude Max' },
    maxParallel: 1,
    executors: { agent: done, command: done },
    valuesFile: join(mkdtempSync(join(tmpdir(), 'cs-home-')), 'values.json'),
  });
  const graph = app.createGraph('G');
  const { posted, view } = fakeView();
  const panel = new GraphPanel(f, graph.id, view);
  const received: ServerMessage[] = [];
  const runHostCommand = vi.fn();
  const setMinimap = vi.fn();
  const setUpParallelTickets = vi.fn();
  const exportRunReport = vi.fn();
  const handler = createMessageHandler({ app, panel, client: { send: (m) => void received.push(m) }, runHostCommand, setMinimap, setUpParallelTickets, exportRunReport, activeSession: () => 'work' });
  return { app, graph, panel, posted, received, handler, runHostCommand, setMinimap, setUpParallelTickets, exportRunReport };
}

describe('graph tab messages', () => {
  it('opens https links in the browser and ignores other schemes', () => {
    const s = setup();
    vi.mocked(vscode.env.openExternal).mockClear();
    s.handler.handle({ type: 'openExternal', url: 'https://example.com/a' });
    expect(vscode.env.openExternal).toHaveBeenCalledTimes(1);
    for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'vscode://x/y', ' https://example.com']) s.handler.handle({ type: 'openExternal', url });
    expect(vscode.env.openExternal).toHaveBeenCalledTimes(1);
  });

  it("runs Set Up Parallel Tickets for the tab's folder", () => {
    const s = setup();
    s.handler.handle({ type: 'setUpParallelTickets' });
    expect(s.setUpParallelTickets).toHaveBeenCalledWith(s.panel.folder);
  });

  it("exports the selected run's report for the tab's graph", () => {
    const s = setup();
    s.handler.handle({ type: 'exportRunReport', runId: '20261003-100000-abcd' });
    expect(s.exportRunReport).toHaveBeenCalledWith(s.panel.folder, s.graph.id, '20261003-100000-abcd');
    expect(s.received).toEqual([]);
  });

  it('keeps the latest draft state on the panel', () => {
    const s = setup();
    expect(s.panel.dirty).toBe(false);
    s.handler.handle({ type: 'draftState', dirty: true });
    expect(s.panel.dirty).toBe(true);
    s.handler.handle({ type: 'draftState', dirty: false });
    expect(s.panel.dirty).toBe(false);
  });

  it("asks the engine to refine steps in the folder's active session", () => {
    const s = setup();
    const handle = vi.spyOn(s.app, 'handle').mockResolvedValue();
    s.handler.handle({ type: 'refineSteps', nodeIds: ['n1'] });
    expect(handle).toHaveBeenCalledWith(expect.anything(), { type: 'refineSteps', graphId: s.graph.id, sessionId: 'work', nodeIds: ['n1'] });
  });

  it("asks the engine to split a step in the folder's active session", () => {
    const s = setup();
    const handle = vi.spyOn(s.app, 'handle').mockResolvedValue();
    s.handler.handle({ type: 'splitStep', nodeId: 'n1' });
    expect(handle).toHaveBeenCalledWith(expect.anything(), { type: 'splitStep', graphId: s.graph.id, sessionId: 'work', nodeId: 'n1' });
  });

  it('connects the tab to its engine when its page is ready, once per page load', () => {
    const s = setup();
    const connect = s.app.connect.bind(s.app);
    let active = 0;
    vi.spyOn(s.app, 'connect').mockImplementation((client) => {
      active++;
      const off = connect(client);
      let done = false;
      return () => {
        if (!done) active--;
        done = true;
        off();
      };
    });
    s.handler.handle({ type: 'ready' });
    expect(s.received.map((m) => m.type)).toEqual(['hello', 'sessions']);
    s.handler.handle({ type: 'ready' }); // the page reloaded
    expect(active).toBe(1);
    s.received.length = 0;
    s.app.createGraph('H');
    expect(s.received.filter((m) => m.type === 'graphs')).toHaveLength(1);
  });

  it('stops delivering engine broadcasts after dispose', () => {
    const s = setup();
    s.handler.handle({ type: 'ready' });
    s.handler.dispose();
    s.received.length = 0;
    s.app.createGraph('H');
    expect(s.received).toEqual([]);
  });

  it('does not unlock the tab for another graph being opened', () => {
    const s = setup();
    s.panel.send({ type: 'openVariables' });
    s.handler.handle({ type: 'opened', graphId: 'other' });
    expect(s.panel.isLoaded).toBe(false);
    expect(s.posted).toEqual([]);
  });

  it('keeps malformed engine messages away from the engine', () => {
    const s = setup();
    const handle = vi.spyOn(s.app, 'handle');
    s.handler.handle({ type: 'applyOps' });
    s.handler.handle({ type: 'nonsense' });
    expect(handle).not.toHaveBeenCalled();
    expect(s.received.filter((m) => m.type === 'error')).toHaveLength(2);
  });

  it('passes engine messages to the engine', async () => {
    const s = setup();
    s.handler.handle({ type: 'ready' });
    s.handler.handle({ type: 'openGraph', graphId: s.graph.id });
    await vi.waitFor(() => expect(s.received.some((m) => m.type === 'graphOpened')).toBe(true));
  });

  it('hands host commands and the minimap preference to the extension', () => {
    const s = setup();
    s.handler.handle({ type: 'host', command: 'exportGraph' });
    expect(s.runHostCommand).toHaveBeenCalledWith('exportGraph', s.panel);
    s.handler.handle({ type: 'setMinimap', value: false });
    expect(s.setMinimap).toHaveBeenCalledWith(false);
  });

  it('answers a malformed message with an error', () => {
    const s = setup();
    s.handler.handle({ type: 'format_disk' });
    expect(s.received.at(-1)).toMatchObject({ type: 'error' });
  });

  it('holds messages for the tab until its graph has loaded', () => {
    const s = setup();
    s.panel.send({ type: 'revealNode', nodeId: 'n1' });
    expect(s.posted).toEqual([]);
    s.handler.handle({ type: 'opened', graphId: s.graph.id });
    expect(s.panel.isLoaded).toBe(true);
    expect(s.posted).toEqual([{ type: 'revealNode', nodeId: 'n1' }]);
    s.panel.send({ type: 'openVariables' });
    expect(s.posted.at(-1)).toEqual({ type: 'openVariables' });
  });
});

describe('GraphPanels', () => {
  it('keeps tabs of same-id graphs in different folders apart', () => {
    const panels = new GraphPanels();
    const a = folder('a');
    const b = folder('b');
    const pa = new GraphPanel(a, 'g', fakeView().view);
    const pb = new GraphPanel(b, 'g', fakeView().view);
    panels.add(pa);
    panels.add(pb);
    expect(panels.get(a.key, 'g')).toBe(pa);
    expect(panels.get(b.key, 'g')).toBe(pb);
    panels.remove(pa);
    expect(panels.get(a.key, 'g')).toBeUndefined();
    expect(panels.get(b.key, 'g')).toBe(pb);
  });
});

describe('openAndSend', () => {
  it('opens a closed tab and reveals the step only after the graph has loaded', async () => {
    const panels = new GraphPanels();
    const f = folder('a');
    const { posted, view } = fakeView();
    let panel: GraphPanel | undefined;
    const open = vi.fn(async () => {
      panel = new GraphPanel(f, 'g', view);
      panels.add(panel);
    });
    await openAndSend(panels, f, 'g', { type: 'revealNode', nodeId: 'n2' }, open);
    expect(open).toHaveBeenCalledWith(f, 'g');
    expect(posted).toEqual([]);
    panel!.markLoaded();
    expect(posted).toEqual([{ type: 'revealNode', nodeId: 'n2' }]);
  });

  it('focuses a tab that is already open instead of opening another', async () => {
    const panels = new GraphPanels();
    const f = folder('a');
    const { posted, view } = fakeView();
    const panel = new GraphPanel(f, 'g', view);
    panel.markLoaded();
    panels.add(panel);
    const open = vi.fn();
    await openAndSend(panels, f, 'g', { type: 'openRunDialog' }, open);
    expect(open).not.toHaveBeenCalled();
    expect(view.reveal).toHaveBeenCalled();
    expect(posted).toEqual([{ type: 'openRunDialog' }]);
  });
});

describe('hostCommandArgs', () => {
  it('passes the tab’s folder and graph only to commands that act on them', () => {
    const f = folder('a');
    const panel = { folder: f, graphId: 'g' };
    expect(hostCommandArgs('openGraph', panel)).toEqual([]);
    expect(hostCommandArgs('showSidebar', panel)).toEqual([]);
    expect(hostCommandArgs('focusChat', panel)).toEqual([]);
    expect(hostCommandArgs('newGraph', panel)).toEqual([{ folder: f }]);
    expect(hostCommandArgs('importGraph', panel)).toEqual([{ folder: f }]);
    expect(hostCommandArgs('deleteGraph', panel)).toEqual([{ folder: f, graphId: 'g' }]);
    expect(hostCommandArgs('openGraphMarkdown', panel)).toEqual([{ folder: f, graphId: 'g' }]);
  });
});

describe('graphIdFromPath', () => {
  it('accepts graph files only', () => {
    expect(graphIdFromPath('/w/.agent-stream/graphs/dbt-parity.json')).toBe('dbt-parity');
    expect(graphIdFromPath('C:\\w\\.agent-stream\\graphs\\x.json')).toBe('x');
    expect(graphIdFromPath('/w/other/x.json')).toBeUndefined();
    expect(graphIdFromPath('/w/.agent-stream/graphs/Bad Name.json')).toBeUndefined();
    expect(graphIdFromPath('/w/.agent-stream/graphs/dbt-parity.md')).toBe('dbt-parity');
    expect(graphIdFromPath('C:\\w\\.agent-stream\\graphs\\x.md')).toBe('x');
    expect(graphIdFromPath('/w/.agent-stream/graphs/x.meta.json')).toBeUndefined();
  });
});

describe('graphTarget', () => {
  it('accepts only graphs at the folder root', () => {
    expect(graphTarget('/ws', '/ws/.agent-stream/graphs/g.json')).toBe('g');
    expect(graphTarget('C:\\ws', 'C:\\ws\\.agent-stream\\graphs\\g.json')).toBe('g');
    expect(graphTarget('/ws', '/ws/sub/.agent-stream/graphs/x.json')).toBeUndefined();
    expect(graphTarget('/ws', '/ws/node_modules/p/.agent-stream/graphs/x.json')).toBeUndefined();
    expect(graphTarget('/ws', '/ws/.agent-stream/graphs/Bad Name.json')).toBeUndefined();
    expect(graphTarget('/ws', '/other/.agent-stream/graphs/g.json')).toBeUndefined();
    expect(graphTarget('/ws', '/ws/.agent-stream/graphs/g.md')).toBe('g');
    expect(graphTarget('C:\\ws', 'C:\\ws\\.agent-stream\\graphs\\g.md')).toBe('g');
    expect(graphTarget('/ws', '/ws/.agent-stream/graphs/g.meta.json')).toBeUndefined();
    expect(graphTarget('/ws', '/ws/sub/.agent-stream/graphs/x.md')).toBeUndefined();
  });
});

describe('notGraphText', () => {
  const generic = "This file isn't a graph in this workspace folder. Graphs live in .agent-stream/graphs at the folder's root. Use \"Reopen Editor With… → Text Editor\" to see it as text.";
  const baseline = 'This is the agent-change baseline for a graph (your accepted version). Use "Reopen Editor With… → Text Editor" to see it as JSON.';

  it('explains a baseline file, which the graph editor selector also matches', () => {
    const file = '/ws/.agent-stream/graphs/g.baseline.json';
    expect(graphTarget('/ws', file)).toBeUndefined();
    expect(notGraphText(file)).toBe(baseline);
    expect(notGraphText('C:\\ws\\.agent-stream\\graphs\\g.baseline.json')).toBe(baseline);
  });

  it('keeps the general explanation for any other file that is not a graph here', () => {
    for (const file of ['/ws/sub/.agent-stream/graphs/x.json', '/ws/.agent-stream/graphs/Bad Name.json', '/other/.agent-stream/graphs/g.json']) {
      expect(graphTarget('/ws', file)).toBeUndefined();
      expect(notGraphText(file)).toBe(generic);
    }
  });
});
