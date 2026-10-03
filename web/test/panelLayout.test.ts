// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/bridge', () => ({ send: vi.fn(), sendHost: vi.fn(), post: vi.fn(), loadViewState: vi.fn(), saveViewState: vi.fn() }));
const { loadViewState, saveViewState } = await import('../src/bridge');
const { dispatch, getState, resetStoreForTests } = await import('../src/store');
const { DEFAULT_LAYOUT, clampLogs, clampSide, loadLayout, persistLayout, restoreLayout } = await import('../src/panelLayout');

beforeEach(() => {
  vi.mocked(loadViewState).mockReset();
  vi.mocked(saveViewState).mockReset();
  localStorage.clear();
  resetStoreForTests();
});

describe('panelLayout', () => {
  it('clamps the side panel to 280 px … 70% of the tab, and the logs to 120 px … 70%', () => {
    expect(clampSide(100, 1000)).toBe(280);
    expect(clampSide(900, 1000)).toBe(700);
    expect(clampSide(500, 1000)).toBe(500);
    expect(clampSide(900, 300)).toBe(280);
    expect(clampLogs(10, 800)).toBe(120);
    expect(clampLogs(790, 800)).toBe(560);
    expect(clampLogs(300, 800)).toBe(300);
  });

  it('uses the defaults when nothing is stored', () => {
    expect(loadLayout()).toEqual(DEFAULT_LAYOUT);
    expect(DEFAULT_LAYOUT).toEqual({ sideWidth: 440, sideCollapsed: false, logsHeight: null, logsCollapsed: false });
  });

  it("restores this tab's webview state", () => {
    vi.mocked(loadViewState).mockReturnValue({ layout: { sideWidth: 333, sideCollapsed: true, logsHeight: 200, logsCollapsed: true } });
    expect(loadLayout()).toEqual({ sideWidth: 333, sideCollapsed: true, logsHeight: 200, logsCollapsed: true });
  });

  it('seeds a new tab from the last values used in any tab', () => {
    localStorage.setItem('agent-stream.panelLayout', JSON.stringify({ sideWidth: 360, sideCollapsed: false, logsHeight: 150, logsCollapsed: false }));
    expect(loadLayout()).toEqual({ sideWidth: 360, sideCollapsed: false, logsHeight: 150, logsCollapsed: false });
  });

  it('prefers webview state over the last used, and ignores junk', () => {
    localStorage.setItem('agent-stream.panelLayout', JSON.stringify({ sideWidth: 360 }));
    vi.mocked(loadViewState).mockReturnValue({ layout: { sideWidth: 'wide', sideCollapsed: 'yes', logsHeight: -4 } });
    expect(loadLayout()).toEqual({ ...DEFAULT_LAYOUT, sideWidth: 360 });
  });

  it('falls back to the defaults when storage throws', () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(loadLayout()).toEqual(DEFAULT_LAYOUT);
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(() => persistLayout()).not.toThrow();
    spy.mockRestore();
    set.mockRestore();
  });

  it('applies the stored layout at boot, keeping a stored size larger than the tab (CSS clamps the render)', () => {
    vi.mocked(loadViewState).mockReturnValue({ layout: { sideWidth: 5000, sideCollapsed: true } });
    restoreLayout();
    expect(getState().layout).toEqual({ ...DEFAULT_LAYOUT, sideWidth: 5000, sideCollapsed: true });
  });

  it('persists to the webview state and to the last used', () => {
    dispatch({ kind: 'setLayout', layout: { sideWidth: 500 } });
    persistLayout();
    expect(saveViewState).toHaveBeenCalledWith({ layout: { ...DEFAULT_LAYOUT, sideWidth: 500 } });
    expect(JSON.parse(localStorage.getItem('agent-stream.panelLayout')!)).toEqual({ ...DEFAULT_LAYOUT, sideWidth: 500 });
    expect(getState().layout.sideWidth).toBe(500);
  });
});
