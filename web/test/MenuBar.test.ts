// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyGraph } from '@agent-stream/shared';

vi.mock('../src/bridge', () => ({ send: vi.fn(), sendHost: vi.fn(), post: vi.fn() }));
const { sendHost } = await import('../src/bridge');
const { dispatch } = await import('../src/store');
const { MenuBar } = await import('../src/components/MenuBar');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
const title = (label: string) => [...container.querySelectorAll('.menu > button')].find((b) => b.textContent === label) as HTMLButtonElement;
const openItems = () => [...container.querySelectorAll('.menu-items button')].map((b) => b.textContent?.replace('✓', '').trim());

beforeEach(async () => {
  dispatch({ kind: 'server', msg: { type: 'hello', status: { provider: 'claude', ok: true, label: 'Claude Max' }, project: '/p', graphs: [], approvals: [] } });
  dispatch({ kind: 'server', msg: { type: 'graphOpened', graph: emptyGraph('g', 'G', 't'), runs: [], variableValues: {} } });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root.render(createElement(MenuBar)));
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe('MenuBar', () => {
  it('opens on click, switches on hover while open, and closes on Esc or a click outside', async () => {
    expect(openItems()).toEqual([]);
    await act(async () => title('File').click());
    expect(openItems()).toContain('New graph…');
    await act(async () => title('Edit').dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
    expect(openItems()).toEqual(['Add step', 'Delete selected step', 'Tidy layout', 'Refine selected step', 'Refine steps you changed (0)']);
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
    expect(openItems()).toEqual([]);
    await act(async () => title('Run').click());
    await act(async () => document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
    expect(openItems()).toEqual([]);
  });

  it('does not open a menu on hover when none is open', async () => {
    await act(async () => title('Edit').dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
    expect(openItems()).toEqual([]);
  });

  it('shows unavailable items greyed out, runs an item and closes', async () => {
    await act(async () => title('Run').click());
    const stop = [...container.querySelectorAll('.menu-items button')].find((b) => b.textContent?.includes('Stop')) as HTMLButtonElement;
    expect(stop.disabled).toBe(true);
    await act(async () => title('Run').click());
    await act(async () => title('File').click());
    const exportItem = [...container.querySelectorAll('.menu-items button')].find((b) => b.textContent?.includes('Export…')) as HTMLButtonElement;
    await act(async () => exportItem.click());
    expect(sendHost).toHaveBeenCalledWith('exportGraph');
    expect(openItems()).toEqual([]);
  });
});
