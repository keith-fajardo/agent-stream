// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

const posted: unknown[] = [];
(globalThis as { acquireVsCodeApi?: () => unknown }).acquireVsCodeApi = () => ({ postMessage: (m: unknown) => posted.push(m) });
document.body.dataset.graphId = 'parity';
const { connect } = await import('../src/bridge');
const deliver = (data: unknown) => window.dispatchEvent(new MessageEvent('message', { data }));

describe('bridge: a graph tab opening', () => {
  it('asks for its graph once, even when the list with the graph arrives before the graph', () => {
    connect();
    deliver({ type: 'hello', status: { provider: 'claude', ok: true, label: 'Claude Max' }, project: '/p', graphs: [], approvals: [] });
    deliver({ type: 'graphs', graphs: [{ id: 'parity', name: 'Parity' }] });
    expect(posted.filter((m) => (m as { type: string }).type === 'openGraph')).toEqual([{ type: 'openGraph', graphId: 'parity' }]);
  });
});
