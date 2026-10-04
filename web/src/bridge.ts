import type { ClientMessage, GraphListItem, HostCommand, HostMessage, WebviewMessage } from '@agent-stream/shared';
import { dispatch, getState } from './store';

type VsCodeApi = { postMessage(message: unknown): void; getState?(): unknown; setState?(state: unknown): void };
declare const acquireVsCodeApi: (() => VsCodeApi) | undefined;

let api: VsCodeApi | undefined;
function vscode(): VsCodeApi | undefined {
  if (!api && typeof acquireVsCodeApi === 'function') api = acquireVsCodeApi();
  return api;
}

/** This tab's webview state: VS Code keeps it while the tab is hidden and shown again. Empty outside VS Code (tests). */
export function loadViewState(): unknown {
  return vscode()?.getState?.();
}

export function saveViewState(state: unknown): void {
  vscode()?.setState?.(state);
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

/** Whether the graphs list has this tab's graph, readable. */
const listsOwnGraph = (graphs: readonly GraphListItem[]) => graphs.some((g) => g.id === bootGraphId() && !g.error);

/** Listens to the extension and tells it this tab is ready; reports once its graph has loaded (ruling R5). */
export function connect(): void {
  window.addEventListener('message', (event: MessageEvent) => {
    const msg: unknown = event.data;
    if (!isHostMessage(msg)) return;
    const wasListed = listsOwnGraph(getState().graphs);
    dispatch({ kind: 'server', msg });
    if (msg.type === 'hello') send({ type: 'openGraph', graphId: bootGraphId() });
    // The graph's file came back, or reads again (Markdown graph files spec §6.5): open it again. Only for a graph that
    // went (graphGone), so a tab still opening doesn't ask twice.
    const reopen = msg.type === 'graphs' && getState().graphGone && !getState().graph && !wasListed && listsOwnGraph(msg.graphs);
    if (reopen) send({ type: 'openGraph', graphId: bootGraphId() });
    if (msg.type === 'graphOpened') post({ type: 'opened', graphId: msg.graph.id });
  });
  // The checkout can change while the tab is hidden (a branch switch in a terminal): ask again when it shows (spec §7).
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') send({ type: 'inspectCheckout' });
  });
  post({ type: 'ready' });
}
