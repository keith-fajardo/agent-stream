import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '@claude-stream/engine';
import type { HostMessage, ServerMessage } from '@claude-stream/shared';
import type { Folder } from '../src/engines';
import { createMessageHandler, GraphPanel, GraphPanels, graphIdFromPath, hostCommandArgs, openAndSend } from '../src/graphEditor';

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
  const app = createApp({ projectDir: f.path, claudePath: 'claude', auth: { ok: true }, maxParallel: 1, executors: { agent: done, command: done }, queryFn: async function* () {}, valuesFile: join(mkdtempSync(join(tmpdir(), 'cs-home-')), 'values.json') });
  const graph = app.createGraph('G');
  const { posted, view } = fakeView();
  const panel = new GraphPanel(f, graph.id, view);
  const received: ServerMessage[] = [];
  const runHostCommand = vi.fn();
  const setMinimap = vi.fn();
  const handler = createMessageHandler({ app, panel, client: { send: (m) => void received.push(m) }, runHostCommand, setMinimap });
  return { app, graph, panel, posted, received, handler, runHostCommand, setMinimap };
}

describe('graph tab messages', () => {
  it('connects the tab to its engine when its page is ready, once per page load', () => {
    const s = setup();
    s.handler.handle({ type: 'ready' });
    expect(s.received.map((m) => m.type)).toEqual(['hello']);
    s.handler.handle({ type: 'ready' }); // the page reloaded
    s.app.createGraph('H');
    expect(s.received.filter((m) => m.type === 'graphs')).toHaveLength(1);
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
    expect(hostCommandArgs('newGraph', panel)).toEqual([{ folder: f }]);
    expect(hostCommandArgs('importGraph', panel)).toEqual([{ folder: f }]);
    expect(hostCommandArgs('deleteGraph', panel)).toEqual([{ folder: f, graphId: 'g' }]);
  });
});

describe('graphIdFromPath', () => {
  it('accepts graph files only', () => {
    expect(graphIdFromPath('/w/.claude-stream/graphs/dbt-parity.json')).toBe('dbt-parity');
    expect(graphIdFromPath('C:\\w\\.claude-stream\\graphs\\x.json')).toBe('x');
    expect(graphIdFromPath('/w/other/x.json')).toBeUndefined();
    expect(graphIdFromPath('/w/.claude-stream/graphs/Bad Name.json')).toBeUndefined();
  });
});
