import type { Op } from '@agent-stream/shared';

type SelectableNode = { id: string; selected?: boolean; data: { ghost?: boolean } };
type SelectableEdge = { id: string; source: string; target: string; selected?: boolean; deletable?: boolean };

/** Keys that add a clicked step or connection to the selection instead of replacing it. */
export const MULTI_SELECT_KEYS = ['Meta', 'Control', 'Shift'];
export const addsToSelection = (e: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }): boolean => e.metaKey || e.ctrlKey || e.shiftKey;

/** What the canvas's Delete button removes: selected steps and connections, never ghosts of removed ones. */
export function selectedForDelete<E extends SelectableEdge>(nodes: SelectableNode[], edges: E[]): { nodeIds: string[]; edges: E[]; count: number } {
  const nodeIds = nodes.filter((n) => n.selected && !n.data.ghost).map((n) => n.id);
  const picked = edges.filter((e) => e.selected && e.deletable !== false);
  return { nodeIds, edges: picked, count: nodeIds.length + picked.length };
}

/** A step's connections go with it; a selected connection between steps that stay is disconnected on its own. */
export function deletionOps(nodeIds: string[], edges: SelectableEdge[]): Op[] {
  const ids = new Set(nodeIds);
  const ops: Op[] = [];
  for (const e of edges) if (!ids.has(e.source) && !ids.has(e.target)) ops.push({ type: 'disconnect', from: e.source, to: e.target });
  for (const id of ids) ops.push({ type: 'deleteNode', id });
  return ops;
}
