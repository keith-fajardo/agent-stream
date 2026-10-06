// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import type { NodeEvent } from '@agent-stream/shared';

vi.mock('../src/bridge', () => ({ send: vi.fn(), sendHost: vi.fn(), post: vi.fn() }));
const { LogView } = await import('../src/components/LogView');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const at = '2026-01-01T00:00:00.000Z';
async function render(events: NodeEvent[]) {
  const el = document.createElement('div');
  await act(async () => createRoot(el).render(createElement(LogView, { events })));
  return el;
}

describe('LogView: approvals with a scope', () => {
  it('says when an approval was for the whole site', async () => {
    const el = await render([
      { type: 'approval_decided', at, approvalId: 'a', decision: 'approve', scope: 'site' } as NodeEvent,
      { type: 'approval_decided', at, approvalId: 'b', decision: 'approve' } as NodeEvent,
    ]);
    const lines = [...el.querySelectorAll('.ev.approval')].map((l) => l.textContent);
    expect(lines[0]).toContain('✔ Approved: on this site for this step');
    expect(lines[1]).not.toContain('on this site');
    expect(lines[1]).toContain('✔ Approved');
  });
});
