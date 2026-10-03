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

describe('LogView markdown', () => {
  it('renders agent text as Markdown', async () => {
    const el = await render([{ type: 'text', at, text: '**hi**' }]);
    expect(el.querySelector('.ev.text strong')?.outerHTML).toBe('<strong>hi</strong>');
  });
  it('renders the prompt sent to the agent as Markdown', async () => {
    const el = await render([{ type: 'start', at, kind: 'agent', cwd: '/w', prompt: '# Plan\n\n- a' } as NodeEvent]);
    expect(el.querySelector('details .markdown h1')?.textContent).toBe('Plan');
  });
  it('keeps tool results, tool calls and output as raw text', async () => {
    const el = await render([
      { type: 'tool_result', at, content: '**hi**', isError: false } as NodeEvent,
      { type: 'stdout', at, chunk: '**out**' } as NodeEvent,
    ]);
    expect(el.querySelector('strong')).toBeNull();
    expect(el.textContent).toContain('**hi**');
    expect(el.textContent).toContain('**out**');
  });
});
