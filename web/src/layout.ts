import { graphlib, layout } from '@dagrejs/dagre';
import type { Graph, Position } from '@agent-stream/shared';

/** A step's width is fixed in CSS (.step). */
export const NODE_WIDTH = 220;
/** Height assumed for a step not yet measured: title, two description lines, badges and status. */
export const NODE_HEIGHT = 140;
/** Clear space between stacked steps; the change and selection outlines take a few pixels of it. */
export const NODE_GAP = 60;
const RANK_GAP = 120;

export type NodeSize = { width: number; height: number };

/** Left-to-right layout. With onlyMissing, returns positions just for nodes that have none. Measured sizes, when given, replace the estimate. */
export function layoutPositions(graph: Graph, onlyMissing: boolean, sizes?: ReadonlyMap<string, NodeSize>): Map<string, Position> {
  const g = new graphlib.Graph();
  g.setGraph({ rankdir: 'LR', nodesep: NODE_GAP, ranksep: RANK_GAP });
  g.setDefaultEdgeLabel(() => ({}));
  const size = (id: string): NodeSize => sizes?.get(id) ?? { width: NODE_WIDTH, height: NODE_HEIGHT };
  for (const n of graph.nodes) g.setNode(n.id, size(n.id));
  for (const e of graph.edges) g.setEdge(e.from, e.to);
  layout(g);
  const out = new Map<string, Position>();
  for (const n of graph.nodes) {
    if (onlyMissing && n.position) continue;
    const p = g.node(n.id);
    const { width, height } = size(n.id);
    out.set(n.id, { x: Math.round(p.x - width / 2), y: Math.round(p.y - height / 2) });
  }
  return out;
}
