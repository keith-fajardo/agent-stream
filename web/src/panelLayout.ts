import { loadViewState, saveViewState } from './bridge';
import type { PanelLayout } from './state';
import { dispatch, getState } from './store';

export const SIDE_MIN = 280;
export const SIDE_DEFAULT = 440;
export const LOGS_MIN = 120;
/** Neither panel may take more than this share of the graph tab. */
export const MAX_SHARE = 0.7;
export const STEP = 16;
export const BIG_STEP = 64;
export const DEFAULT_LAYOUT: PanelLayout = { sideWidth: SIDE_DEFAULT, sideCollapsed: false, logsHeight: null, logsCollapsed: false };

const LAST_USED_KEY = 'agent-stream.panelLayout';

const clamp = (value: number, min: number, tabSize: number) => Math.round(Math.max(min, Math.min(value, tabSize * MAX_SHARE)));
export const clampSide = (width: number, tabWidth: number) => clamp(width, SIDE_MIN, tabWidth);
export const clampLogs = (height: number, tabHeight: number) => clamp(height, LOGS_MIN, tabHeight);

const isSize = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;

/** Keeps the fields that are valid; anything else is left out so the caller's fallback applies. */
function sanitize(raw: unknown): Partial<PanelLayout> {
  if (typeof raw !== 'object' || raw === null) return {};
  const r = raw as Record<string, unknown>;
  return {
    ...(isSize(r.sideWidth) && { sideWidth: r.sideWidth }),
    ...(typeof r.sideCollapsed === 'boolean' && { sideCollapsed: r.sideCollapsed }),
    ...((r.logsHeight === null || isSize(r.logsHeight)) && { logsHeight: r.logsHeight as number | null }),
    ...(typeof r.logsCollapsed === 'boolean' && { logsCollapsed: r.logsCollapsed }),
  };
}

function lastUsed(): Partial<PanelLayout> {
  try {
    const text = localStorage.getItem(LAST_USED_KEY);
    return text ? sanitize(JSON.parse(text)) : {};
  } catch {
    return {};
  }
}

function tabState(): Partial<PanelLayout> {
  try {
    const state = loadViewState();
    return typeof state === 'object' && state !== null ? sanitize((state as { layout?: unknown }).layout) : {};
  } catch {
    return {};
  }
}

/** This tab's own layout if it has one, else what was last used in any tab, else the defaults. */
export function loadLayout(): PanelLayout {
  return { ...DEFAULT_LAYOUT, ...lastUsed(), ...tabState() };
}

/** Applies this tab's stored layout to the store at boot. */
export function restoreLayout(): void {
  dispatch({ kind: 'setLayout', layout: loadLayout() });
}

/** Called when a drag ends, a key is pressed or a panel is collapsed: remembers the layout for this tab and for new tabs. */
export function persistLayout(): void {
  const { layout } = getState();
  try {
    saveViewState({ layout });
  } catch {
    /* the webview state is a convenience */
  }
  try {
    localStorage.setItem(LAST_USED_KEY, JSON.stringify(layout));
  } catch {
    /* storage can be blocked */
  }
}
