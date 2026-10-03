import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import type { App, Client } from '@agent-stream/engine';
import { parseWebviewMessage, type HostMessage } from '@agent-stream/shared';
import type { Folder } from './engines';
import { openExternalUrl } from './ui';
import { webviewHtml } from './webviewHtml';

export type ChatSource = { folder: Folder; graphId: string };
export type ChatViewDeps = {
  app(folder: Folder): App;
  sessions: { active(folder: Folder): { id: string; name: string } };
  confirm(message: string, action: string): Promise<boolean>;
  switchSession(folder: Folder): void;
  error(message: string): void;
};
type Target = { folder: Folder; graphId: string; graphName: string; sessionId: string; sessionName: string };
const same = (a: ChatSource, b: ChatSource) => a.folder.key === b.folder.key && a.graphId === b.graphId;

/** What the chat view shows (sessions spec §6): the active graph tab's conversation in its folder's active session. */
export class ChatViewController {
  private post: (msg: HostMessage) => void = () => {};
  private recent: ChatSource[] = [];
  private target: Target | undefined;
  private detach: (() => void) | undefined;
  private client: Client = { send: (msg) => this.post(msg) };

  constructor(private d: ChatViewDeps) {}

  attach(post: (msg: HostMessage) => void): void {
    this.post = post;
  }

  /** A tab became active (`active` undefined: not a graph tab). `open` lists the graph tabs open now. */
  activate(active: ChatSource | undefined, open: ChatSource[]): void {
    if (active) this.recent = [active, ...this.recent.filter((r) => !same(r, active))];
    this.refresh(open);
  }

  /** Re-evaluate after tabs closed, a session switched, or a graph was renamed or deleted. */
  refresh(open: ChatSource[]): void {
    this.recent = this.recent.filter((r) => open.some((o) => same(o, r)));
    const next = this.recent.find((r) => this.d.app(r.folder).listGraphs().some((g) => g.id === r.graphId && !g.error));
    this.show(next);
  }

  /** The webview (re)loaded: send it the current conversation again. */
  ready(): void {
    const current = this.target;
    this.target = undefined;
    this.show(current && { folder: current.folder, graphId: current.graphId });
  }

  handle(raw: unknown): void {
    const parsed = parseWebviewMessage(raw);
    if (!parsed.ok) return this.post({ type: 'error', message: `Agent Stream ignored a malformed message: ${parsed.error}` });
    const msg = parsed.msg;
    if (msg.type === 'ready') return this.ready();
    if (msg.type === 'openExternal') return openExternalUrl(msg.url);
    const t = this.target;
    if (msg.type === 'chatCommand') {
      if (!t) return;
      if (msg.command === 'switchSession') return this.d.switchSession(t.folder);
      void this.d.confirm(`Start a new conversation? This clears the planner chat for ${t.graphName} in ${t.sessionName}.`, 'New chat').then((yes) => {
        if (yes && this.target === t) void this.d.app(t.folder).handle(this.client, { type: 'newChat', graphId: t.graphId, sessionId: t.sessionId });
      });
      return;
    }
    if (msg.type === 'chat' || msg.type === 'setPlannerModel' || msg.type === 'stopPlanner') {
      if (!t || msg.graphId !== t.graphId || msg.sessionId !== t.sessionId) return this.post({ type: 'error', message: 'This chat is no longer open.' });
      void this.d.app(t.folder).handle(this.client, msg);
      return;
    }
    this.post({ type: 'error', message: `The chat view can't send ${msg.type}.` });
  }

  dispose(): void {
    this.detach?.();
    this.detach = undefined;
  }

  private show(source: ChatSource | undefined): void {
    const graph = source && this.d.app(source.folder).listGraphs().find((g) => g.id === source.graphId && !g.error);
    if (!source || !graph) {
      this.dispose();
      this.target = undefined;
      this.post({ type: 'chatTarget' });
      return;
    }
    const session = this.d.sessions.active(source.folder);
    const next: Target = { folder: source.folder, graphId: source.graphId, graphName: graph.name, sessionId: session.id, sessionName: session.name };
    const cur = this.target;
    const sameConversation = !!cur && cur.folder.key === next.folder.key && cur.graphId === next.graphId && cur.sessionId === next.sessionId;
    // Nothing to tell the view when the conversation and its names are unchanged.
    if (cur && sameConversation && cur.graphName === next.graphName && cur.sessionName === next.sessionName) return;
    this.target = next;
    this.post({ type: 'chatTarget', target: { graphId: next.graphId, graphName: next.graphName, sessionId: next.sessionId, sessionName: next.sessionName } });
    if (sameConversation) return;
    this.dispose();
    const app = this.d.app(next.folder);
    this.detach = app.connect(this.client);
    void app.handle(this.client, { type: 'openChat', graphId: next.graphId, sessionId: next.sessionId });
  }
}

/** The "Agent Stream Chat" view (a webview in the secondary side bar). */
export class ChatViewProvider implements vscode.WebviewViewProvider {
  constructor(
    private extensionUri: vscode.Uri,
    private controller: ChatViewController,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    const root = vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview');
    view.webview.options = { enableScripts: true, localResourceRoots: [root] };
    const asset = (name: string) => view.webview.asWebviewUri(vscode.Uri.joinPath(root, 'assets', name)).toString();
    view.webview.html = webviewHtml({ cspSource: view.webview.cspSource, scriptUri: asset('index.js'), styleUri: asset('index.css'), nonce: randomBytes(16).toString('hex'), view: 'chat', minimap: false });
    this.controller.attach((msg) => void view.webview.postMessage(msg));
    const sub = view.webview.onDidReceiveMessage((raw) => this.controller.handle(raw));
    view.onDidDispose(() => {
      sub.dispose();
      this.controller.dispose();
      this.controller.attach(() => {});
    });
  }
}
