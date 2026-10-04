// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { emptyGraph } from '@agent-stream/shared';

const posted: unknown[] = [];
(globalThis as { acquireVsCodeApi?: () => unknown }).acquireVsCodeApi = () => ({ postMessage: (m: unknown) => posted.push(m), getState: () => viewState, setState: (s: unknown) => void (viewState = s) });
let viewState: unknown;
document.body.dataset.graphId = 'parity';
const { connect, loadViewState, post, saveViewState, send, sendHost } = await import('../src/bridge');
const { getState } = await import('../src/store');
const deliver = (data: unknown) => window.dispatchEvent(new MessageEvent('message', { data }));

describe('bridge', () => {
  it('says ready, opens its own graph after hello, and reports when the graph has loaded', () => {
    connect();
    expect(posted).toEqual([{ type: 'ready' }]);
    deliver({ type: 'hello', status: { provider: 'claude', ok: true, label: 'Claude Max' }, project: '/p', graphs: [], approvals: [] });
    expect(getState().status).toEqual({ provider: 'claude', ok: true, label: 'Claude Max' });
    expect(posted.at(-1)).toEqual({ type: 'openGraph', graphId: 'parity' });
    deliver({ type: 'graphOpened', changes: [], graph: emptyGraph('parity', 'Parity', 't'), runs: [], variableValues: {} });
    expect(getState().graph?.id).toBe('parity');
    expect(posted.at(-1)).toEqual({ type: 'opened', graphId: 'parity' });
  });

  it('asks for the checkout again whenever the tab becomes visible', () => {
    posted.length = 0;
    const visibility = (state: string) => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
      document.dispatchEvent(new Event('visibilitychange'));
    };
    visibility('visible');
    expect(posted).toEqual([{ type: 'inspectCheckout' }]);
    visibility('hidden');
    expect(posted).toEqual([{ type: 'inspectCheckout' }]);
  });

  it('ignores messages that are not from the extension', () => {
    const before = getState();
    deliver('junk');
    deliver({ nope: true });
    expect(getState()).toBe(before);
  });

  it('posts engine and extension messages', () => {
    posted.length = 0;
    send({ type: 'stopRun', runId: 'r' });
    sendHost('exportGraph');
    post({ type: 'setMinimap', value: false });
    expect(posted).toEqual([{ type: 'stopRun', runId: 'r' }, { type: 'host', command: 'exportGraph' }, { type: 'setMinimap', value: false }]);
  });

  it("keeps the tab's view state in the webview state", () => {
    expect(loadViewState()).toBeUndefined();
    saveViewState({ layout: { sideWidth: 300 } });
    expect(loadViewState()).toEqual({ layout: { sideWidth: 300 } });
  });
});

describe('bridge: the graph file comes back', () => {
  it('opens its graph again when the list has it readable again, and only then', () => {
    const graphs = (error?: string) => ({ type: 'graphs', graphs: [{ id: 'parity', name: 'Parity', ...(error && { error }) }] });
    deliver({ type: 'graphDeleted', graphId: 'parity', reason: 'file' });
    deliver({ type: 'graphs', graphs: [] });
    posted.length = 0;
    deliver(graphs('line 1: the file must start with the graph\'s name, as "# Name".'));
    expect(posted).toEqual([]);
    deliver(graphs());
    expect(posted).toEqual([{ type: 'openGraph', graphId: 'parity' }]);
    deliver(graphs());
    expect(posted).toHaveLength(1);
  });
});
