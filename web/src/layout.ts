import { graphlib, layout } from '@dagrejs/dagre';
import type { Graph, Position } from '@agent-stream/shared';

export const NODE_WIDTH = 220;
export const NODE_HEIGHT = 70;

/** Left-to-right layout. With onlyMissing, returns positions just for nodes that have none. */
export function layoutPositions(graph: Graph, onlyMissing: boolean): Map<string, Position> {
  const g = new graphlib.Graph();
  g.setGraph({ rankdir: 'LR', nodesep: 40, ranksep: 80 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of graph.nodes) g.setNode(n.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  for (const e of graph.edges) g.setEdge(e.from, e.to);
  layout(g);
  const out = new Map<string, Position>();
  for (const n of graph.nodes) {
    if (onlyMissing && n.position) continue;
    const p = g.node(n.id);
    out.set(n.id, { x: Math.round(p.x - NODE_WIDTH / 2), y: Math.round(p.y - NODE_HEIGHT / 2) });
  }
  return out;
}
