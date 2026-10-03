import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { isGraphId, type App, type Client } from '@agent-stream/engine';
import { parseWebviewMessage, type HostCommand, type HostMessage } from '@agent-stream/shared';
import type { EngineManager, Folder } from './engines';
import { folderUri } from './folders';
import { openExternalUrl } from './ui';
import { escapeHtml, webviewHtml } from './webviewHtml';

export const GRAPH_VIEW_TYPE = 'agentStream.graph';

/** `<folder>/.agent-stream/graphs/<id>.json` → id; undefined for any other file. */
export function graphIdFromPath(p: string): string | undefined {
  const m = /[\\/]\.agent-stream[\\/]graphs[\\/]([^\\/]+)\.json$/.exec(p);
  return m && isGraphId(m[1]) ? m[1] : undefined;
}

/** The graph id when `filePath` is exactly `<folderPath>/.agent-stream/graphs/<id>.json`; nested copies belong to no engine. */
export function graphTarget(folderPath: string, filePath: string): string | undefined {
  const segments = (p: string) => p.replace(/\\/g, '/').split('/').filter(Boolean);
  const base = segments(folderPath);
  const file = segments(filePath);
  if (file.length !== base.length + 3 || !base.every((seg, i) => seg === file[i])) return undefined;
  const [dir, graphs, name] = file.slice(base.length);
  const m = /^(.+)\.json$/.exec(name);
  return dir === '.agent-stream' && graphs === 'graphs' && m && isGraphId(m[1]) ? m[1] : undefined;
}

const GENERIC_NOT_GRAPH = `This file isn't a graph in this workspace folder. Graphs live in .agent-stream/graphs at the folder's root. Use "Reopen Editor With… → Text Editor" to see it as JSON.`;
const BASELINE_NOT_GRAPH = 'This is the agent-change baseline for a graph (your accepted version). Use "Reopen Editor With… → Text Editor" to see it as JSON.';

/** Why a file the graph editor was asked to open isn't shown as a graph. The editor selector also matches `<id>.baseline.json`. */
export function notGraphText(filePath: string): string {
  return /(^|[\\/])[^\\/]+\.baseline\.json$/.test(filePath) ? BASELINE_NOT_GRAPH : GENERIC_NOT_GRAPH;
}

export const panelKey = (folderKey: string, graphId: string): string => `${folderKey}|${graphId}`;

/** What the registry needs from a webview panel; tests pass a fake. */
export type PanelView = { post(msg: HostMessage): void; reveal(): void; close(): void; visible(): boolean; active(): boolean };

/** One open graph tab. Messages from the extension wait until the tab has loaded its graph (ruling R5). */
export class GraphPanel {
  /** The tab's latest `draftState`: it has unsaved step edits. */
  dirty = false;
  private loaded = false;
  private queue: HostMessage[] = [];

  constructor(
    readonly folder: Folder,
    readonly graphId: string,
    readonly view: PanelView,
  ) {}

  get isLoaded(): boolean {
    return this.loaded;
  }

  send(msg: HostMessage): void {
    if (this.loaded) this.view.post(msg);
    else this.queue.push(msg);
  }

  markLoaded(): void {
    this.loaded = true;
    for (const msg of this.queue.splice(0)) this.view.post(msg);
  }

  /** The tab's page started (again): wait for it to load the graph before delivering. */
  markStarting(): void {
    this.loaded = false;
  }
}

/** Open graph tabs, keyed by folder + graph id (two folders may both have a graph "demo"). */
export class GraphPanels {
  private panels = new Map<string, GraphPanel>();

  add(panel: GraphPanel): void {
    this.panels.set(panelKey(panel.folder.key, panel.graphId), panel);
  }

  remove(panel: GraphPanel): void {
    const key = panelKey(panel.folder.key, panel.graphId);
    if (this.panels.get(key) === panel) this.panels.delete(key);
  }

  get(folderKey: string, graphId: string): GraphPanel | undefined {
    return this.panels.get(panelKey(folderKey, graphId));
  }

  all(): GraphPanel[] {
    return [...this.panels.values()];
  }

  active(): GraphPanel | undefined {
    return this.all().find((p) => p.view.active());
  }

  isVisible(folderKey: string, graphId: string): boolean {
    return this.get(folderKey, graphId)?.view.visible() ?? false;
  }
}

export type MessageHandlerDeps = {
  app: App;
  panel: GraphPanel;
  client: Client;
  runHostCommand(command: HostCommand, panel: GraphPanel): void;
  setMinimap(value: boolean): void;
  /** The id of the folder's active work session: where Refine's planner turn runs. */
  activeSession(folder: Folder): string;
  /** The tab's run dialog asked for Set Up Parallel Tickets (spec §5.3). */
  setUpParallelTickets(folder: Folder): void;
};

/** Routes what a tab posts: engine messages to its folder's engine, the tab's own messages to the extension. */
export function createMessageHandler(d: MessageHandlerDeps): { handle(raw: unknown): void; dispose(): void } {
  let detach: (() => void) | undefined;
  const fail = (message: string) => d.client.send({ type: 'error', message });
  return {
    handle(raw) {
      const parsed = parseWebviewMessage(raw);
      if (!parsed.ok) return fail(`Agent Stream ignored a malformed message: ${parsed.error}`);
      if (parsed.kind === 'engine') {
        d.app.handle(d.client, parsed.msg).catch((e: unknown) => fail(e instanceof Error ? e.message : String(e)));
        return;
      }
      const msg = parsed.msg;
      switch (msg.type) {
        case 'ready':
          detach?.();
          d.panel.markStarting();
          detach = d.app.connect(d.client);
          return;
        case 'opened':
          if (msg.graphId === d.panel.graphId) d.panel.markLoaded();
          return;
        case 'host':
          d.runHostCommand(msg.command, d.panel);
          return;
        case 'draftState':
          d.panel.dirty = msg.dirty;
          return;
        case 'setMinimap':
          d.setMinimap(msg.value);
          return;
        case 'openExternal':
          openExternalUrl(msg.url);
          return;
        case 'setUpParallelTickets':
          d.setUpParallelTickets(d.panel.folder);
          return;
        case 'splitStep':
          d.app.handle(d.client, { type: 'splitStep', graphId: d.panel.graphId, sessionId: d.activeSession(d.panel.folder), nodeId: msg.nodeId }).catch((e: unknown) => fail(e instanceof Error ? e.message : String(e)));
          return;
        case 'refineSteps':
          d.app.handle(d.client, { type: 'refineSteps', graphId: d.panel.graphId, sessionId: d.activeSession(d.panel.folder), nodeIds: msg.nodeIds }).catch((e: unknown) => fail(e instanceof Error ? e.message : String(e)));
          return;
      }
    },
    dispose() {
      detach?.();
      detach = undefined;
    },
  };
}

export type EditorDeps = {
  extensionUri: vscode.Uri;
  engines: EngineManager;
  panels: GraphPanels;
  folderFor(uri: vscode.Uri): Folder | undefined;
  runHostCommand(command: HostCommand, panel: GraphPanel): void;
  activeSession(folder: Folder): string;
  minimap(): boolean;
  setMinimap(value: boolean): void;
  /** The tab's run dialog asked for Set Up Parallel Tickets (spec §5.3). */
  setUpParallelTickets(folder: Folder): void;
};

function messagePage(text: string): string {
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"></head><body style="font-family: var(--vscode-font-family); padding: 16px">${escapeHtml(text)}</body></html>`;
}

/** Graph files open as graph tabs (spec §3.3). The engine writes the files, so the editor is read-only to VS Code. */
export class GraphEditorProvider implements vscode.CustomReadonlyEditorProvider {
  constructor(private d: EditorDeps) {}

  openCustomDocument(uri: vscode.Uri): vscode.CustomDocument {
    return { uri, dispose: () => {} };
  }

  resolveCustomEditor(document: vscode.CustomDocument, webviewPanel: vscode.WebviewPanel): void {
    const root = vscode.Uri.joinPath(this.d.extensionUri, 'dist', 'webview');
    const webview = webviewPanel.webview;
    webview.options = { enableScripts: true, localResourceRoots: [root] };
    const folder = this.d.folderFor(document.uri);
    const graphId = folder && graphTarget(folder.path, document.uri.fsPath);
    if (!folder || !graphId) {
      webview.html = messagePage(notGraphText(document.uri.fsPath));
      return;
    }
    const app = this.d.engines.get(folder);
    const asset = (name: string) => webview.asWebviewUri(vscode.Uri.joinPath(root, 'assets', name)).toString();
    webview.html = webviewHtml({
      cspSource: webview.cspSource,
      scriptUri: asset('index.js'),
      styleUri: asset('index.css'),
      nonce: randomBytes(16).toString('hex'),
      view: 'graph',
      graphId,
      minimap: this.d.minimap(),
    });
    const panel = new GraphPanel(folder, graphId, {
      post: (msg) => void webview.postMessage(msg),
      reveal: () => webviewPanel.reveal(),
      close: () => webviewPanel.dispose(),
      visible: () => webviewPanel.visible,
      active: () => webviewPanel.active,
    });
    this.d.panels.add(panel);
    const handler = createMessageHandler({
      app,
      panel,
      client: { send: (msg) => void webview.postMessage(msg) },
      runHostCommand: this.d.runHostCommand,
      activeSession: (f) => this.d.activeSession(f),
      setUpParallelTickets: (f) => this.d.setUpParallelTickets(f),
      setMinimap: (value) => {
        this.d.setMinimap(value);
        for (const other of this.d.panels.all()) if (other !== panel) other.send({ type: 'prefs', minimap: value });
      },
    });
    const subscription = webview.onDidReceiveMessage((raw) => handler.handle(raw));
    webviewPanel.onDidDispose(() => {
      subscription.dispose();
      handler.dispose();
      this.d.panels.remove(panel);
    });
  }
}

/** What a tab's menu passes to `agentStream.<command>`: Open… must show the picker, New/Import act on the folder. */
export function hostCommandArgs(command: HostCommand, panel: { folder: Folder; graphId: string }): unknown[] {
  if (command === 'openGraph' || command === 'showSidebar' || command === 'focusChat') return [];
  if (command === 'newGraph' || command === 'importGraph') return [{ folder: panel.folder }];
  return [{ folder: panel.folder, graphId: panel.graphId }];
}

export function graphUri(folder: Folder, graphId: string): vscode.Uri {
  return vscode.Uri.joinPath(folderUri(folder), '.agent-stream', 'graphs', `${graphId}.json`);
}

export async function openGraphTab(folder: Folder, graphId: string): Promise<void> {
  await vscode.commands.executeCommand('vscode.openWith', graphUri(folder, graphId), GRAPH_VIEW_TYPE);
}

/** Opens (or focuses) a graph's tab, then sends it `msg` once its graph has loaded. */
export async function openAndSend(
  panels: GraphPanels,
  folder: Folder,
  graphId: string,
  msg: HostMessage,
  open: (folder: Folder, graphId: string) => Promise<void> = openGraphTab,
): Promise<void> {
  let panel = panels.get(folder.key, graphId);
  if (panel) panel.view.reveal();
  else {
    await open(folder, graphId);
    panel = panels.get(folder.key, graphId);
  }
  panel?.send(msg);
}
