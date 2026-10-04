// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Graph, RunMeta, ServerMessage } from '@agent-stream/shared';

vi.mock('../src/bridge', () => ({ send: vi.fn(), sendHost: vi.fn(), post: vi.fn() }));
const { send } = await import('../src/bridge');
const { dispatch } = await import('../src/store');
const { LogsPanel } = await import('../src/components/LogsPanel');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const step = (id: string, title: string) => ({ id, title, kind: 'agent' as const, prompt: 'p', createdBy: 'user' as const, updatedBy: 'user' as const, updatedAt: 't' });
const graph: Graph = { id: 'g', name: 'G', goal: '', instructions: '', variables: [], nodes: [step('n1', 'Plan'), step('n2', 'Build new')], edges: [], nodeSeq: 2, updatedAt: 't' };
const run: RunMeta = {
  id: '20261002-100000-aaaa',
  graphId: 'g',
  status: 'failed',
  startedAt: 't',
  snapshot: { ...graph, nodes: [graph.nodes[1]] },
  nodes: { n2: { status: 'failed', durationMs: 4200, error: 'exited with code 2' } },
};
const server = (msg: ServerMessage) => dispatch({ kind: 'server', msg });
const approval = (id: string, nodeId: string, command: string) => ({
  id,
  runId: run.id,
  graphId: graph.id,
  nodeId,
  nodeTitle: nodeId === 'n2' ? 'Build new' : 'Plan',
  toolName: 'Bash',
  input: { command },
  createdAt: 't',
});

let container: HTMLDivElement;
let root: Root;
const text = () => container.textContent ?? '';

beforeEach(async () => {
  vi.mocked(send).mockClear();
  server({ type: 'graphOpened', changes: [], graph, runs: [], run, variableValues: {} });
  server({ type: 'approvals', approvals: [] });
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

  it("names the run's provider in the header, and nothing when the run has none", async () => {
    await act(async () => dispatch({ kind: 'selectNode', id: 'n2' }));
    expect(text()).not.toContain('GitHub Copilot');
    await act(async () => server({ type: 'run', run: { ...run, provider: 'copilot' } }));
    expect(container.querySelector('.logs-head')?.textContent).toContain('GitHub Copilot');
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

  it("pins only the selected step's pending approvals above its logs", async () => {
    server({ type: 'approvals', approvals: [approval('a1', 'n2', 'dbt build -s orders_v2'), approval('a2', 'n1', 'rm -rf target')] });
    await act(async () => dispatch({ kind: 'selectNode', id: 'n2' }));
    expect(text()).toContain('dbt build -s orders_v2');
    expect(text()).not.toContain('rm -rf target');
    // Pinned: outside the scrolling log, so following new log lines never hides it.
    expect(container.querySelector('.logs-pinned')?.textContent).toContain('dbt build -s orders_v2');
    expect(container.querySelector('.logs-body')?.textContent).not.toContain('dbt build -s orders_v2');
    const approve = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Approve') as HTMLButtonElement;
    await act(async () => approve.click());
    expect(send).toHaveBeenCalledWith({ type: 'decide', approvalId: 'a1', decision: 'approve' });
  });

  it('says which step changed the selected step during the run, and nothing for an unchanged step', async () => {
    const amendments = [
      { at: 't1', byNodeId: 'n1', nodeId: 'n2', summary: "n1 wants to change n2's prompt" },
      { at: 't2', byNodeId: 'n1', nodeId: 'n3', summary: 'n1 wants to add step "Install" after n1, before n2' },
    ];
    await act(async () => server({ type: 'run', run: { ...run, amendments } }));
    await act(async () => dispatch({ kind: 'selectNode', id: 'n2' }));
    expect(container.querySelector('.logs-head')?.textContent).toContain('· changed during the run by n1');
    await act(async () => dispatch({ kind: 'selectNode', id: 'n1' }));
    expect(container.querySelector('.logs-head')?.textContent).not.toContain('changed during the run');
  });

  it('closes when ✕ is clicked', async () => {
    await act(async () => dispatch({ kind: 'selectNode', id: 'n2' }));
    const close = container.querySelector('button[aria-label="Close logs"]') as HTMLButtonElement;
    await act(async () => close.click());
    expect(container.innerHTML).toBe('');
  });
  it('shows the workspace a step ran in, from the run record', async () => {
    const inWorkspace = { ...graph.nodes[1], workspace: 'wh_small' };
    await act(async () => server({ type: 'run', run: { ...run, snapshot: { ...run.snapshot, nodes: [inWorkspace] }, workspaces: { wh_small: { path: '/wt/wh_small', head: 'a1b2c3d4' } } } }));
    await act(async () => dispatch({ kind: 'selectNode', id: 'n2' }));
    expect(container.querySelector('.logs-head .logs-workspace')?.textContent).toBe('workspace wh_small · /wt/wh_small');
    await act(async () => server({ type: 'run', run }));
    expect(container.querySelector('.logs-workspace')).toBeNull();
  });

  it('says what a waiting run waits for', async () => {
    await act(async () => server({ type: 'run', run: { ...run, status: 'running', waitingFor: { runId: '20261003-090000-aaaa', graphId: 'billing', folder: '/p' } } }));
    await act(async () => dispatch({ kind: 'selectNode', id: 'n2' }));
    expect(container.querySelector('.logs-head .logs-waiting')?.textContent).toBe('Waiting for run 20261003-090000-aaaa ("billing") to finish changing files');
  });

  it('shows only the request count for a step that reports no tokens or cost (Copilot)', async () => {
    await act(async () => dispatch({ kind: 'selectNode', id: 'n2' }));
    const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, turns: 3 };
    await act(async () => server({ type: 'nodeLogs', runId: run.id, nodeId: 'n2', events: [{ at: '2026-10-02T10:00:00Z', type: 'result', ok: true, durationMs: 1200, usage }] }));
    expect(text()).toContain('· 3 turns');
    expect(text()).not.toContain('API-equivalent');
    expect(text()).not.toContain('0 in / 0 out');
  });

  it('shows tokens but no API-equivalent cost for a step that reports no cost (Codex)', async () => {
    await act(async () => dispatch({ kind: 'selectNode', id: 'n2' }));
    const usage = { inputTokens: 300, outputTokens: 50, cacheReadTokens: 600, cacheWriteTokens: 100, costUsd: 0, turns: 1 };
    await act(async () => server({ type: 'nodeLogs', runId: run.id, nodeId: 'n2', events: [{ at: '2026-10-02T10:00:00Z', type: 'result', ok: true, durationMs: 1200, usage }] }));
    expect(text()).toContain('· 1000 in / 50 out tokens · 1 turns');
    expect(text()).not.toContain('API-equivalent');
  });
});
