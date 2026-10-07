import { emptyGraph, wouldCreateGraphLoop, type GraphListItem, type GraphLookup, type GraphNode } from '@agent-stream/shared';

/** One graph the picker offers (sub-graphs spec §6.2): its name and step count; a graph whose file has errors is disabled with the error. */
export type PickerOption = { id: string; label: string; disabled: boolean; title?: string };

/**
 * A lookup over the graphs list, enough to find loops: each graph's sub-graph steps, from the other graphs' `usedBy`. The
 * picker can't read every graph, and doesn't need to.
 */
export function lookupFromList(graphs: readonly GraphListItem[]): GraphLookup {
  const uses = new Map<string, string[]>();
  for (const g of graphs) for (const user of g.usedBy ?? []) uses.set(user, [...(uses.get(user) ?? []), g.id]);
  return (id) => {
    const item = graphs.find((g) => g.id === id);
    if (!item) return { ok: false, reason: 'missing', error: `graph "${id}" not found` };
    const nodes = (uses.get(id) ?? []).map((inner, i): GraphNode => ({ id: `n${i + 1}`, title: inner, kind: 'graph', graph: inner, createdBy: 'user', updatedBy: 'user', updatedAt: '' }));
    return { ok: true, graph: { ...emptyGraph(id, item.name, ''), nodes } };
  };
}

/** The folder's graphs a sub-graph step in `ownerId` may use: never `ownerId` itself, nor a graph that would put it inside itself. */
export function pickerOptions(graphs: readonly GraphListItem[], ownerId: string): PickerOption[] {
  const lookup = lookupFromList(graphs);
  return graphs
    .filter((g) => g.id !== ownerId && !wouldCreateGraphLoop(ownerId, g.id, lookup))
    .map((g) => ({ id: g.id, label: `${g.name} · ${g.steps ?? 0} step${g.steps === 1 ? '' : 's'}`, disabled: !!(g.error || g.broken), ...((g.error ?? g.broken) && { title: g.error ?? g.broken }) }));
}
