/** Which page the extension asked for: a graph tab, or the planner chat view (sessions spec §6). */
export function viewMode(dataset: { view?: string }): 'graph' | 'chat' {
  return dataset.view === 'chat' ? 'chat' : 'graph';
}
