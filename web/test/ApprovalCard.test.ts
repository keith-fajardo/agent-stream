// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import type { ApprovalRequest } from '@agent-stream/shared';

vi.mock('../src/bridge', () => ({ send: vi.fn(), sendHost: vi.fn(), post: vi.fn() }));
const { ApprovalCard } = await import('../src/components/ApprovalCard');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const request = (id: string, command: string): ApprovalRequest => ({ id, runId: 'r', graphId: 'g', nodeId: 'n1', nodeTitle: 'Build', toolName: 'Bash', input: { command }, createdAt: 't' });

describe('ApprovalCard', () => {
  it('puts the decision controls above the details so they never fall below the fold', async () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    await act(async () => root.render(createElement(ApprovalCard, { request: request('a1', 'dbt build --full-refresh') })));
    const card = container.querySelector('.approval-card') as HTMLElement;
    const approve = [...card.querySelectorAll('button')].find((b) => b.textContent === 'Approve') as HTMLButtonElement;
    const details = [...card.querySelectorAll('pre')].find((p) => p.textContent?.includes('dbt build --full-refresh')) as HTMLElement;
    expect(approve.compareDocumentPosition(details) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await act(async () => root.unmount());
  });
});
