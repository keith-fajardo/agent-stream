/** The toasts of ⌘S (spec §6a.1). */
export const stepSavedToast = (id: string) => `Step ${id} saved.`;
export const GRAPH_SAVED = 'Graph saved.';
export const GRAPH_PANEL_SAVED = 'Goal and instructions saved.';
export const MARKDOWN_SAVED = 'Saved.';
export const cantSaveToast = (graphId: string) => `Can't save: ${graphId}.md has errors. Fix the file first.`;
