// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import type { ApprovalRequest, NodeEvent } from '@agent-stream/shared';

vi.mock('../src/bridge', () => ({ send: vi.fn(), sendHost: vi.fn(), post: vi.fn() }));
const { send } = await import('../src/bridge');
const { ApprovalCard } = await import('../src/components/ApprovalCard');
const { LogView } = await import('../src/components/LogView');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const base: ApprovalRequest = { id: 'a1', runId: 'r', graphId: 'g', nodeId: 'n1', nodeTitle: 'Build', toolName: 'Bash', input: { command: 'ls' }, createdAt: 't' };
const kinds: [string, ApprovalRequest][] = [
  ['tool', base],
  ['graph change', { ...base, toolName: 'Change graph', input: {}, graphChange: { summary: 'n1 wants to add a step', detail: 'Step n5' } }],
  ['browser', { ...base, toolName: 'browser_click', input: { ref: 'e1' }, browserAction: { site: 'jobs.example', url: 'https://jobs.example/', title: 'Jobs', element: 'button "Go"' } }],
];

describe('Allow all for this step on the approval card', () => {
  it.each(kinds)('is offered on a %s card, and sends the step scope', async (_name, request) => {
    const container = document.createElement('div');
    const root = createRoot(container);
    await act(async () => root.render(createElement(ApprovalCard, { request })));
    const buttons = [...container.querySelectorAll('.approval-actions button')] as HTMLButtonElement[];
    const allowAll = buttons.filter((b) => b.textContent === 'Allow all for this step');
    expect(allowAll).toHaveLength(1);
    vi.mocked(send).mockClear();
    await act(async () => allowAll[0].click());
    expect(vi.mocked(send).mock.calls.map((c) => c[0])).toEqual([{ type: 'decide', approvalId: 'a1', decision: 'approve', scope: 'step' }]);
    await act(async () => root.unmount());
  });
});

describe('LogView: Allow all for this step', () => {
  it('shows the press and each request it approved', async () => {
    const at = '2026-01-01T00:00:00.000Z';
    const events = [
      { type: 'approval_allowed_all', at } as NodeEvent,
      { type: 'approval_decided', at, approvalId: 'a', decision: 'approve', scope: 'step' } as NodeEvent,
    ];
    const el = document.createElement('div');
    await act(async () => createRoot(el).render(createElement(LogView, { events })));
    const lines = [...el.querySelectorAll('.ev.approval')].map((l) => l.textContent);
    expect(lines[0]).toContain('Allowed everything for the rest of this step');
    expect(lines[1]).toContain('✔ Approved (allowed for this step)');
  });
});
