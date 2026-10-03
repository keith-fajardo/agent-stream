// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyGraph, type AgentChange, type Graph, type RunMeta } from '@agent-stream/shared';

vi.mock('../src/bridge', () => ({ send: vi.fn(), sendHost: vi.fn(), post: vi.fn(), loadViewState: vi.fn(), saveViewState: vi.fn() }));
const { saveViewState } = await import('../src/bridge');
const { dispatch, getState, resetStoreForTests } = await import('../src/store');
const { RightPanel } = await import('../src/components/RightPanel');
const { LogsPanel } = await import('../src/components/LogsPanel');
const { MenuBar } = await import('../src/components/MenuBar');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const step = (id: string) => ({ id, title: id, kind: 'agent' as const, prompt: 'p', createdBy: 'user' as const, updatedBy: 'user' as const, updatedAt: 't' });
const graph: Graph = { ...emptyGraph('g', 'G', 't'), nodes: [step('n1')] };
const run: RunMeta = { id: 'r1', graphId: 'g', status: 'succeeded', startedAt: 't', snapshot: graph, nodes: {}, variables: {}, lastSeq: 0 } as unknown as RunMeta;
const change: AgentChange = { kind: 'node', change: 'added', id: 'n1', title: 'n1' };

// The tab is 1000 x 800; jsdom has no layout, so the panels' measured sizes are faked here.
let sideNow = 440;
let logsNow = 280;
let container: HTMLDivElement;
let root: Root;
const q = (sel: string) => container.querySelector(sel) as HTMLElement;
const handle = (label: string) => container.querySelector(`[role="separator"][aria-label="${label}"]`) as HTMLElement;
const fire = (el: Element, type: string, init: MouseEventInit = {}) => act(async () => void el.dispatchEvent(new MouseEvent(type, { bubbles: true, ...init })));
const key = (el: Element, k: string, shiftKey = false) => act(async () => void el.dispatchEvent(new KeyboardEvent('keydown', { key: k, shiftKey, bubbles: true })));
const drag = async (el: Element, from: number, to: number, axis: 'clientX' | 'clientY') => {
  await fire(el, 'pointerdown', { [axis]: from });
  await fire(el, 'pointermove', { [axis]: to });
  await fire(el, 'pointerup', { [axis]: to });
};
const side = () => getState().layout.sideWidth;

beforeEach(async () => {
  vi.mocked(saveViewState).mockClear();
  localStorage.clear();
  resetStoreForTests();
  sideNow = 440;
  logsNow = 280;
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1000);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const h = this.classList.contains('logs-panel') ? logsNow : 0;
    const w = this.classList.contains('side-panel') ? side() : 0;
    return { width: w, height: h, top: 0, left: 0, right: w, bottom: h, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
  });
  dispatch({ kind: 'server', msg: { type: 'graphOpened', changes: [], graph, runs: [], run, variableValues: {} } });
  dispatch({ kind: 'server', msg: { type: 'approvals', approvals: [] } });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root.render(createElement('div', { className: 'app' }, createElement('div', { className: 'main' }, createElement('div', { className: 'workspace' }, createElement(MenuBar), createElement(LogsPanel)), createElement(RightPanel)))));
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe('side panel', () => {
  it('has an accessible vertical handle and starts at 440 px', () => {
    const h = handle('Resize side panel');
    expect(h.getAttribute('aria-orientation')).toBe('vertical');
    expect(h.tabIndex).toBe(0);
    expect(q('.side-panel').style.width).toBe('440px');
  });

  it('widens when the handle is dragged left, and persists only on drag end', async () => {
    const h = handle('Resize side panel');
    await fire(h, 'pointerdown', { clientX: 500 });
    await fire(h, 'pointermove', { clientX: 400 });
    expect(side()).toBe(540);
    expect(q('.side-panel').style.width).toBe('540px');
    expect(saveViewState).not.toHaveBeenCalled();
    await fire(h, 'pointermove', { clientX: 380 });
    await fire(h, 'pointerup', { clientX: 380 });
    expect(side()).toBe(560);
    expect(saveViewState).toHaveBeenCalledTimes(1);
  });

  it('clamps at 280 px and at 70% of the tab', async () => {
    const h = handle('Resize side panel');
    await drag(h, 500, 900, 'clientX');
    expect(side()).toBe(280);
    await drag(h, 500, -900, 'clientX');
    expect(side()).toBe(700);
  });

  it('resets to 440 px on double-click', async () => {
    dispatch({ kind: 'setLayout', layout: { sideWidth: 600 } });
    await fire(handle('Resize side panel'), 'dblclick');
    expect(side()).toBe(440);
    expect(saveViewState).toHaveBeenCalled();
  });

  it('resizes with Left/Right by 16 px, Shift 64 px, clamped', async () => {
    const h = handle('Resize side panel');
    await key(h, 'ArrowLeft');
    expect(side()).toBe(456);
    await key(h, 'ArrowRight');
    await key(h, 'ArrowRight');
    expect(side()).toBe(424);
    await key(h, 'ArrowLeft', true);
    expect(side()).toBe(488);
    for (let i = 0; i < 5; i++) await key(h, 'ArrowRight', true);
    expect(side()).toBe(280);
    for (let i = 0; i < 20; i++) await key(h, 'ArrowLeft', true);
    expect(side()).toBe(700);
    expect(saveViewState).toHaveBeenCalledTimes(1 + 2 + 1 + 5 + 20);
  });

  it('collapses to a rail with Node and Graph, and Changes only when there are changes', async () => {
    const collapse = container.querySelector('button[aria-label="Collapse side panel"]') as HTMLButtonElement;
    expect(collapse.textContent).toBe('›');
    await act(async () => collapse.click());
    expect(getState().layout.sideCollapsed).toBe(true);
    expect(saveViewState).toHaveBeenCalled();
    expect(q('.side-panel.collapsed')).toBeTruthy();
    expect(handle('Resize side panel')).toBeNull();
    expect([...container.querySelectorAll('.side-rail button')].map((b) => b.textContent)).toEqual(['Node', 'Graph']);
    await act(async () => dispatch({ kind: 'server', msg: { type: 'graphOpened', changes: [change], graph, runs: [], run, variableValues: {} } }));
    expect([...container.querySelectorAll('.side-rail button')].map((b) => b.textContent)).toEqual(['Node', 'Graph', 'Changes (1)']);
  });

  it('expands on the clicked tab', async () => {
    dispatch({ kind: 'setLayout', layout: { sideCollapsed: true } });
    await act(async () => void 0);
    const graphBtn = [...container.querySelectorAll('.side-rail button')].find((b) => b.textContent === 'Graph') as HTMLButtonElement;
    await act(async () => graphBtn.click());
    expect(getState().layout.sideCollapsed).toBe(false);
    expect(getState().tab).toBe('graph');
    expect(q('.tabs button.active').textContent).toBe('Graph');
    expect(saveViewState).toHaveBeenCalled();
  });
});

describe('logs panel', () => {
  beforeEach(async () => {
    await act(async () => dispatch({ kind: 'selectNode', id: 'n1' }));
  });

  it('has an accessible horizontal handle and a CSS default height', () => {
    const h = handle('Resize logs panel');
    expect(h.getAttribute('aria-orientation')).toBe('horizontal');
    expect(h.tabIndex).toBe(0);
    expect(q('.logs-panel').style.height).toBe('');
  });

  it('grows when the handle is dragged up, persisting on drag end only', async () => {
    const h = handle('Resize logs panel');
    await fire(h, 'pointerdown', { clientY: 500 });
    await fire(h, 'pointermove', { clientY: 450 });
    expect(getState().layout.logsHeight).toBe(330);
    expect(q('.logs-panel').style.height).toBe('330px');
    expect(saveViewState).not.toHaveBeenCalled();
    await fire(h, 'pointerup', { clientY: 450 });
    expect(saveViewState).toHaveBeenCalledTimes(1);
  });

  it('clamps at 120 px and at 70% of the tab', async () => {
    const h = handle('Resize logs panel');
    await drag(h, 500, 900, 'clientY');
    expect(getState().layout.logsHeight).toBe(120);
    logsNow = 120;
    await drag(h, 500, -900, 'clientY');
    expect(getState().layout.logsHeight).toBe(560);
  });

  it('resets on double-click', async () => {
    dispatch({ kind: 'setLayout', layout: { logsHeight: 400 } });
    await fire(handle('Resize logs panel'), 'dblclick');
    expect(getState().layout.logsHeight).toBeNull();
  });

  it('resizes with Up/Down by 16 px, Shift 64 px, clamped', async () => {
    const h = handle('Resize logs panel');
    await key(h, 'ArrowUp');
    expect(getState().layout.logsHeight).toBe(296);
    await key(h, 'ArrowDown');
    await key(h, 'ArrowDown');
    expect(getState().layout.logsHeight).toBe(264);
    await key(h, 'ArrowUp', true);
    expect(getState().layout.logsHeight).toBe(328);
    for (let i = 0; i < 20; i++) await key(h, 'ArrowDown', true);
    expect(getState().layout.logsHeight).toBe(120);
    expect(saveViewState).toHaveBeenCalledTimes(24);
  });

  it('collapses to a thin bar with the title and an expand button, and a new selection leaves it collapsed', async () => {
    await act(async () => (container.querySelector('button[aria-label="Collapse logs panel"]') as HTMLButtonElement).click());
    expect(getState().layout.logsCollapsed).toBe(true);
    expect(saveViewState).toHaveBeenCalled();
    expect(q('.logs-panel.collapsed').textContent).toContain('Logs · n1');
    expect(q('.logs-body')).toBeNull();
    await act(async () => dispatch({ kind: 'selectNode', id: 'n1' }));
    expect(getState().layout.logsCollapsed).toBe(true);
    await act(async () => (container.querySelector('button[aria-label="Expand logs panel"]') as HTMLButtonElement).click());
    expect(getState().layout.logsCollapsed).toBe(false);
    expect(q('.logs-body')).toBeTruthy();
  });
});

describe('View menu', () => {
  const open = async () => act(async () => ([...container.querySelectorAll('.menu > button')].find((b) => b.textContent === 'View') as HTMLButtonElement).click());
  const labels = () => [...container.querySelectorAll('.menu-items button')].map((b) => b.textContent?.replace('✓', '').trim());
  const pick = async (label: string) => act(async () => ([...container.querySelectorAll('.menu-items button')].find((b) => b.textContent?.includes(label)) as HTMLButtonElement).click());

  it('hides and shows the side panel, labelled by state', async () => {
    await open();
    expect(labels()).toContain('Hide Side Panel');
    await pick('Hide Side Panel');
    expect(getState().layout.sideCollapsed).toBe(true);
    expect(saveViewState).toHaveBeenCalled();
    await open();
    expect(labels()).toContain('Show Side Panel');
    await pick('Show Side Panel');
    expect(getState().layout.sideCollapsed).toBe(false);
  });

  it('hides and shows the logs, labelled by state', async () => {
    await act(async () => dispatch({ kind: 'selectNode', id: 'n1' }));
    await open();
    expect(labels()).toContain('Hide Logs');
    await pick('Hide Logs');
    expect(getState().layout.logsCollapsed).toBe(true);
    await open();
    expect(labels()).toContain('Show Logs');
    await pick('Show Logs');
    expect(getState().layout.logsCollapsed).toBe(false);
  });
});
