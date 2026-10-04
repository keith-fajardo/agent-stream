import { post } from './bridge';

const unsaved = { node: false, markdown: false };

/**
 * Unsaved work in this tab, for the extension's count of tabs with unsaved edits (the session switch asks first): a
 * step's edits in the side panel or the Markdown editor's draft. Each reports its own; the tab posts either.
 */
export function reportDraft(source: keyof typeof unsaved, dirty: boolean): void {
  unsaved[source] = dirty;
  post({ type: 'draftState', dirty: unsaved.node || unsaved.markdown });
}
