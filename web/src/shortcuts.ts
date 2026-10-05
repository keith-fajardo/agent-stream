import { actions } from './actions';
import { getState } from './store';

/** ⌘ on macOS, Ctrl elsewhere: how menus show the graph tab's shortcuts. */
export const MOD = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform ?? '') ? '⌘' : 'Ctrl+';

/** A field with its own text undo: ⌘Z there undoes typing, not graph edits (spec §6a.2). */
export function isTextField(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.tagName !== 'string') return false;
  return el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA';
}

/** A dialog is open: the shortcuts leave the graph alone under it. */
function modalOpen(): boolean {
  const s = getState();
  return !!(s.variablesDialog || s.confirm || s.changeConfirm || s.markdown.confirmLeave);
}

/**
 * The graph tab's ⌘S and ⌘Z (Ctrl on Windows and Linux), wherever focus is in the tab (spec §6a). A key a field already
 * handled (the Markdown editor's own ⌘S) is left alone.
 */
export function onShortcutKey(e: KeyboardEvent): void {
  if (e.defaultPrevented || e.altKey || e.shiftKey || !(e.metaKey || e.ctrlKey) || modalOpen()) return;
  // The physical key too, so a layout whose letters are not Latin still works.
  const key = e.code === 'KeyS' || e.code === 'KeyZ' ? e.code.slice(3).toLowerCase() : e.key.toLowerCase();
  if (key === 's') {
    e.preventDefault();
    actions.save();
  } else if (key === 'z' && !isTextField(e.target)) {
    e.preventDefault();
    actions.undo();
  }
}
