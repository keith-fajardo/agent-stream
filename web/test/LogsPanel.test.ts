// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Graph, RunMeta, ServerMessage } from '@claude-stream/shared';

vi.mock('../src/socket', () => ({ send: vi.fn() }));
const { send } = await import('../src/socket');
const { dispatch } = await import('../src/store');
const { LogsPanel } = await import('../src/components/LogsPanel');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const step = (id: string, title: string) => ({ id, title, kind: 'agent' as const, prompt: 'p', createdBy: 'user' as const, updatedBy: 'user' as const, updatedAt: 't' });
const graph: Graph = { id: 'g', name: 'G', goal: '', nodes: [step('n1', 'Plan'), step('n2', 'Build new')], edges: [], nodeSeq: 2, updatedAt: 't' };
const run: RunMeta = {
  id: '20261002-100000-aaaa',
  graphId: 'g',
  status: 'failed',
  startedAt: 't',
  snapshot: { ...graph, nodes: [graph.nodes[1]] },
  nodes: { n2: { status: 'failed', durationMs: 4200, error: 'exited with code 2' } },
};
const server = (msg: ServerMessage) => dispatch({ kind: 'server', msg });

let container: HTMLDivElement;
let root: Root;
const text = () => container.textContent ?? '';

beforeEach(async () => {
  vi.mocked(send).mockClear();
  server({ type: 'graphOpened', graph, chat: [], chatBusy: false, runs: [], run });
  dispatch({ kind: 'selectNode' });
  container = document.createElement('div');
  root = createRoot(container);
  await act(async () => root.render(createElement(LogsPanel)));
});

afterEach(async () => {
  await act(async () => root.unmount());
});

describe('LogsPanel', () => {
  it('stays hidden until a step is selected', () => {
    expect(container.innerHTML).toBe('');
  });

  it("shows the selected step's status, error and log timeline, requesting the log once", async () => {
    await act(async () => dispatch({ kind: 'selectNode', id: 'n2' }));
    expect(text()).toContain('Logs · n2 Build new');
    expect(text()).toContain('Failed');
    expect(text()).toContain('4.2 s');
    expect(text()).toContain('exited with code 2');
    expect(vi.mocked(send).mock.calls).toEqual([[{ type: 'getNodeLogs', runId: run.id, nodeId: 'n2' }]]);

    await act(async () => server({ type: 'nodeLogs', runId: run.id, nodeId: 'n2', events: [{ at: '2026-10-02T10:00:00Z', type: 'text', text: 'Compilation Error in model orders' }] }));
    expect(text()).toContain('Compilation Error in model orders');
    expect(vi.mocked(send)).toHaveBeenCalledTimes(1);
  });

  it("says so when the step hasn't run in the selected run", async () => {
    await act(async () => dispatch({ kind: 'selectNode', id: 'n1' }));
    expect(text()).toContain("This step hasn't run in the selected run.");
    expect(send).not.toHaveBeenCalled();
  });

  it('closes when ✕ is clicked', async () => {
    await act(async () => dispatch({ kind: 'selectNode', id: 'n2' }));
    const close = container.querySelector('button[aria-label="Close logs"]') as HTMLButtonElement;
    await act(async () => close.click());
    expect(container.innerHTML).toBe('');
  });
});
