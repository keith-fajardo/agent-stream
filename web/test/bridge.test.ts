// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { emptyGraph } from '@agent-stream/shared';

const posted: unknown[] = [];
(globalThis as { acquireVsCodeApi?: () => unknown }).acquireVsCodeApi = () => ({ postMessage: (m: unknown) => posted.push(m) });
document.body.dataset.graphId = 'parity';
const { connect, post, send, sendHost } = await import('../src/bridge');
const { getState } = await import('../src/store');
const deliver = (data: unknown) => window.dispatchEvent(new MessageEvent('message', { data }));

describe('bridge', () => {
  it('says ready, opens its own graph after hello, and reports when the graph has loaded', () => {
    connect();
    expect(posted).toEqual([{ type: 'ready' }]);
    deliver({ type: 'hello', auth: { ok: true }, project: '/p', graphs: [], approvals: [] });
    expect(getState().auth).toEqual({ ok: true });
    expect(posted.at(-1)).toEqual({ type: 'openGraph', graphId: 'parity' });
    deliver({ type: 'graphOpened', graph: emptyGraph('parity', 'Parity', 't'), chat: [], chatBusy: false, runs: [], variableValues: {} });
    expect(getState().graph?.id).toBe('parity');
    expect(posted.at(-1)).toEqual({ type: 'opened', graphId: 'parity' });
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
});
