import type { ClientMessage, HostCommand, HostMessage, WebviewMessage } from '@agent-stream/shared';
import { dispatch } from './store';

type VsCodeApi = { postMessage(message: unknown): void };
declare const acquireVsCodeApi: (() => VsCodeApi) | undefined;

let api: VsCodeApi | undefined;
function vscode(): VsCodeApi | undefined {
  if (!api && typeof acquireVsCodeApi === 'function') api = acquireVsCodeApi();
  return api;
}

/** The graph this tab shows, written into the page by the extension. */
export function bootGraphId(): string {
  return document.body.dataset.graphId ?? '';
}

export function post(msg: WebviewMessage): void {
  vscode()?.postMessage(msg);
}

export function send(msg: ClientMessage): void {
  post(msg);
}

export function sendHost(command: HostCommand): void {
  post({ type: 'host', command });
}

function isHostMessage(x: unknown): x is HostMessage {
  return typeof x === 'object' && x !== null && typeof (x as { type?: unknown }).type === 'string';
}

/** Listens to the extension and tells it this tab is ready; reports once its graph has loaded (ruling R5). */
export function connect(): void {
  window.addEventListener('message', (event: MessageEvent) => {
    const msg: unknown = event.data;
    if (!isHostMessage(msg)) return;
    dispatch({ kind: 'server', msg });
    if (msg.type === 'hello') send({ type: 'openGraph', graphId: bootGraphId() });
    if (msg.type === 'graphOpened') {
      post({ type: 'opened', graphId: msg.graph.id });
      // Interim (ruling P5): the tab chats in the Default session until the chat view replaces it.
      send({ type: 'openChat', graphId: msg.graph.id, sessionId: 'default' });
    }
  });
  post({ type: 'ready' });
}
