import type { ApprovalRequest, Graph, Position, RunMeta } from '@claude-stream/shared';
import type { StepFlowNode } from './components/StepNode';
import { layoutPositions } from './layout';

export type FlowNodesInput = {
  graph: Graph;
  run?: RunMeta;
  approvals: ApprovalRequest[];
  selectedId?: string;
  selectionChanged: boolean;
  current: StepFlowNode[];
  dragging: ReadonlySet<string>;
  pendingMoves: Map<string, Position>;
};

/** Merge the server graph into the local React Flow nodes without clobbering in-flight drags, unconfirmed moves or local selection. */
export function buildFlowNodes(input: FlowNodesInput): StepFlowNode[] {
  const { graph, run, approvals, selectedId, selectionChanged, current, dragging, pendingMoves } = input;
  const auto = layoutPositions(graph, true);
  const previous = new Map(current.map((n) => [n.id, n]));
  return graph.nodes.map((n) => {
    const prev = previous.get(n.id);
    const pending = pendingMoves.get(n.id);
    if (pending && n.position && n.position.x === pending.x && n.position.y === pending.y) pendingMoves.delete(n.id);
    const serverPos = n.position ?? auto.get(n.id) ?? { x: 0, y: 0 };
    const isDragging = dragging.has(n.id);
    const position = isDragging && prev ? prev.position : (pendingMoves.get(n.id) ?? serverPos);
    return {
      id: n.id,
      type: 'step',
      position,
      ...(isDragging ? { dragging: prev?.dragging } : {}),
      selected: selectionChanged || !prev ? n.id === selectedId : prev.selected,
      data: {
        node: n,
        state: run?.nodes[n.id],
        waiting: approvals.some((a) => a.nodeId === n.id && a.runId === run?.id),
      },
    };
  });
}
