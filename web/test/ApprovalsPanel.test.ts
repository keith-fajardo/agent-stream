// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import type { ApprovalRequest } from '@claude-stream/shared';

vi.mock('../src/socket', () => ({ send: vi.fn() }));
const { send } = await import('../src/socket');
const { dispatch } = await import('../src/store');
const { ApprovalsPanel } = await import('../src/components/ApprovalsPanel');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const request = (id: string, command: string): ApprovalRequest => ({ id, runId: 'r', nodeId: 'n1', nodeTitle: 'Build', toolName: 'Bash', input: { command }, createdAt: 't' });

describe('ApprovalsPanel', () => {
  it('approves exactly the listed requests with "Approve all"', async () => {
    dispatch({ kind: 'server', msg: { type: 'approvals', approvals: [request('a1', 'dbt build'), request('a2', 'dbt test')] } });
    const container = document.createElement('div');
    const root = createRoot(container);
    await act(async () => root.render(createElement(ApprovalsPanel)));
    const all = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Approve all (2)') as HTMLButtonElement;
    await act(async () => all.click());
    expect(vi.mocked(send).mock.calls).toEqual([
      [{ type: 'decide', approvalId: 'a1', decision: 'approve' }],
      [{ type: 'decide', approvalId: 'a2', decision: 'approve' }],
    ]);
    await act(async () => root.unmount());
  });

  it('puts the decision controls above the details so they never fall below the fold', async () => {
    dispatch({ kind: 'server', msg: { type: 'approvals', approvals: [request('a1', 'dbt build --full-refresh')] } });
    const container = document.createElement('div');
    const root = createRoot(container);
    await act(async () => root.render(createElement(ApprovalsPanel)));
    const card = container.querySelector('.approval-card') as HTMLElement;
    const approve = [...card.querySelectorAll('button')].find((b) => b.textContent === 'Approve') as HTMLButtonElement;
    const details = [...card.querySelectorAll('pre')].find((p) => p.textContent?.includes('dbt build --full-refresh')) as HTMLElement;
    expect(approve.compareDocumentPosition(details) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await act(async () => root.unmount());
  });

  it('offers no "Approve all" when nothing is waiting', async () => {
    dispatch({ kind: 'server', msg: { type: 'approvals', approvals: [] } });
    const container = document.createElement('div');
    const root = createRoot(container);
    await act(async () => root.render(createElement(ApprovalsPanel)));
    expect(container.textContent).not.toContain('Approve all');
    await act(async () => root.unmount());
  });
});
