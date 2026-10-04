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

  it('shows a graph change as its summary, with the exact text that would run', async () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    const graphChange = { summary: 'n1 wants to add a step "Install deps"', detail: 'Step n5 (command)\nnpm ci' };
    await act(async () => root.render(createElement(ApprovalCard, { request: { ...request('a2', ''), toolName: 'Change graph', input: {}, graphChange } })));
    const card = container.querySelector('.approval-card') as HTMLElement;
    expect(card.querySelector('.approval-title')!.textContent).toBe(graphChange.summary);
    expect(card.textContent).not.toContain('wants to use');
    const pre = card.querySelector('details pre') as HTMLElement;
    expect(pre.textContent).toBe(graphChange.detail);
    expect(card.querySelector('details')!.open).toBe(true);
    expect([...card.querySelectorAll('button')].map((b) => b.textContent)).toEqual(expect.arrayContaining(['Approve', 'Deny']));
    await act(async () => root.unmount());
  });

  it('shows a Patch as each file and its diff, with added and removed lines marked', async () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    const input = { changes: [{ path: 'src/a.ts', kind: 'update', diff: '@@ -1 +1 @@\n-old\n+new' }] };
    await act(async () => root.render(createElement(ApprovalCard, { request: { ...request('a3', ''), toolName: 'Patch', input } })));
    const card = container.querySelector('.approval-card') as HTMLElement;
    expect(card.querySelector('.approval-label')!.textContent).toBe('Update src/a.ts');
    expect([...card.querySelectorAll('.patch-add')].map((e) => e.textContent)).toEqual(['+new']);
    expect([...card.querySelectorAll('.patch-del')].map((e) => e.textContent)).toEqual(['-old']);
    expect(card.querySelector('.diff-block')!.textContent).toContain('@@ -1 +1 @@');
    await act(async () => root.unmount());
  });
});
