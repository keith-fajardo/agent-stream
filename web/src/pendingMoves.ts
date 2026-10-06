import { movedLabel, type Graph, type Position } from '@agent-stream/shared';
import { sendEdit } from './actions';

/** Forgets moves for steps the graph no longer has, so a flush never re-sends a move that can only fail. */
export function settleMoves(pending: Map<string, Position>, graph: Graph): void {
  const ids = new Set(graph.nodes.map((n) => n.id));
  for (const id of [...pending.keys()]) if (!ids.has(id)) pending.delete(id);
}

/** A drag is one action, even with several steps selected: remembers the drops and sends them as one edit (spec §6a.2). */
export function dropMoves(graphId: string, pending: Map<string, Position>, dropped: { id: string; position: Position }[]): void {
  const moves = dropped.map(({ id, position }): [string, Position] => [id, { x: Math.round(position.x), y: Math.round(position.y) }]);
  for (const [id, position] of moves) pending.set(id, position);
  sendEdit(graphId, moves.map(([id, position]) => ({ type: 'moveNode', id, position })), movedLabel(moves.map(([id]) => id)));
}
