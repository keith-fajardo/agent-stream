// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { allowedActionLine, nowOnLine, openedLine, searchedLine, type NodeEvent } from '@agent-stream/shared';

vi.mock('../src/bridge', () => ({ send: vi.fn(), sendHost: vi.fn(), post: vi.fn() }));
const { send } = await import('../src/bridge');
const { LogView } = await import('../src/components/LogView');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const at = '2026-10-06T00:00:00.000Z';
async function render(events: NodeEvent[], live?: boolean) {
  const el = document.createElement('div');
  await act(async () => createRoot(el).render(createElement(LogView, { events, live })));
  return el;
}
const waiting: NodeEvent = { type: 'browser_wait', at, waitId: 'w1', text: 'Step n3 is waiting for you in the browser: Log in to LinkedIn.' };

describe('LogView: waiting for the user', () => {
  it('shows the waiting line with a Done button that ends the wait', async () => {
    const el = await render([waiting]);
    const line = el.querySelector('.ev.browser-wait') as HTMLElement;
    expect(line.textContent).toContain('Step n3 is waiting for you in the browser: Log in to LinkedIn.');
    const done = line.querySelector('button') as HTMLButtonElement;
    expect(done.textContent).toBe('Done');
    vi.mocked(send).mockClear();
    await act(async () => done.click());
    expect(send).toHaveBeenCalledWith({ type: 'browserDone', waitId: 'w1' });
  });

  it('drops the button once the wait ended, saying how', async () => {
    const byUser = await render([waiting, { type: 'browser_wait_done', at, waitId: 'w1', by: 'user' }]);
    expect(byUser.querySelector('.ev.browser-wait button')).toBeNull();
    expect(byUser.textContent).toContain('✔ Done');
    const stopped = await render([waiting, { type: 'browser_wait_done', at, waitId: 'w1', by: 'stopped' }]);
    expect(stopped.textContent).toContain('■ Stopped (run stopped)');
  });

  it('shows no Done button for a wait whose step is no longer running', async () => {
    const el = await render([waiting], false);
    expect(el.querySelector('.ev.browser-wait button')).toBeNull();
    expect(el.textContent).toContain('Step n3 is waiting for you in the browser');
    const live = await render([waiting], true);
    expect(live.querySelector('.ev.browser-wait button')).not.toBeNull();
  });
});

describe('LogView: the page log', () => {
  it('shows each 🌐 line as it was logged', async () => {
    const el = await render([
      { type: 'browser', at, text: '🌐 searched "data engineer"' },
      { type: 'browser', at, text: '🌐 opened https://www.linkedin.com/jobs/' },
    ]);
    // Each line is its time stamp (the .t span), then the text exactly.
    const lines = [...el.querySelectorAll('.ev.browser')].map((e) => e.textContent!.slice(e.querySelector('.t')!.textContent!.length));
    expect(lines).toEqual(['🌐 searched "data engineer"', '🌐 opened https://www.linkedin.com/jobs/']);
  });

  it('shows every kind of line the browser session and tools log: opened, searched, now on and an allowed action', async () => {
    const texts = [
      openedLine('https://a.example/'),
      searchedLine('data engineer'),
      nowOnLine('https://b.example/'),
      allowedActionLine('clicked button "Easy Apply"', 'https://jobs.example'),
    ];
    const el = await render(texts.map((text) => ({ type: 'browser' as const, at, text })));
    const lines = [...el.querySelectorAll('.ev.browser')].map((e) => e.textContent!.slice(e.querySelector('.t')!.textContent!.length));
    expect(lines).toEqual(texts);
    expect(lines.every((l) => l.startsWith('🌐 '))).toBe(true);
  });
});
