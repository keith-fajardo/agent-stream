import { MarkerType, type Edge as FlowEdge } from '@xyflow/react';
import type { AgentChange, ApprovalRequest, Graph, Position, RunMeta } from '@agent-stream/shared';
import type { StepData, StepFlowNode } from './components/StepNode';
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
  /** The user's accepted version and what agents changed since: drawn as marks and ghosts. */
  baseline?: Graph;
  changes?: AgentChange[];
};

/** Merge the server graph into the local React Flow nodes without clobbering in-flight drags, unconfirmed moves or local selection. */
export function buildFlowNodes(input: FlowNodesInput): StepFlowNode[] {
  const { graph, run, approvals, selectedId, selectionChanged, current, dragging, pendingMoves, baseline, changes = [] } = input;
  const auto = layoutPositions(graph, true);
  const previous = new Map(current.map((n) => [n.id, n]));
  const nodeChange = new Map(changes.flatMap((c) => (c.kind === 'node' ? [[c.id, c] as const] : [])));
  const real: StepFlowNode[] = graph.nodes.map((n) => {
    const prev = previous.get(n.id);
    const pending = pendingMoves.get(n.id);
    if (pending && n.position && n.position.x === pending.x && n.position.y === pending.y) pendingMoves.delete(n.id);
    const serverPos = n.position ?? auto.get(n.id) ?? { x: 0, y: 0 };
    const isDragging = dragging.has(n.id);
    const position = isDragging && prev ? prev.position : (pendingMoves.get(n.id) ?? serverPos);
    return {
      // Keep what React Flow put on the node (measured size etc.); unmeasured nodes render hidden.
      ...prev,
      id: n.id,
      type: 'step',
      position,
      dragging: isDragging ? prev?.dragging : undefined,
      selected: selectionChanged || !prev ? n.id === selectedId : prev.selected,
      data: {
        node: n,
        state: run?.nodes[n.id],
        waiting: approvals.some((a) => a.nodeId === n.id && a.runId === run?.id),
        ...changeData(nodeChange.get(n.id)),
      },
    };
  });
  return [...real, ...ghostNodes(graph, baseline, changes, previous)];
}

const changeData = (c?: AgentChange): Pick<StepData, 'change' | 'changeBy' | 'changeFields'> =>
  c?.kind === 'node' && c.change !== 'removed' ? { change: c.change, ...(c.by && { changeBy: c.by }), ...(c.fields && { changeFields: c.fields }) } : {};

/** A removed step drawn from the baseline, at its baseline position: faded, never selectable. */
function ghostNodes(graph: Graph, baseline: Graph | undefined, changes: AgentChange[], previous: Map<string, StepFlowNode>): StepFlowNode[] {
  if (!baseline) return [];
  const auto = layoutPositions(baseline, true);
  const out: StepFlowNode[] = [];
  for (const c of changes) {
    if (c.kind !== 'node' || c.change !== 'removed') continue;
    const node = baseline.nodes.find((n) => n.id === c.id);
    if (!node || graph.nodes.some((n) => n.id === c.id)) continue;
    const id = ghostId(c.id);
    out.push({
      ...previous.get(id),
      id,
      type: 'step',
      position: node.position ?? auto.get(node.id) ?? { x: 0, y: 0 },
      selectable: false,
      draggable: false,
      deletable: false,
      connectable: false,
      selected: false,
      data: { node, waiting: false, ghost: true, change: 'removed', ...(c.by && { changeBy: c.by }) },
    });
  }
  return out;
}

export const GHOST_PREFIX = 'ghost:';
const ghostId = (id: string) => `${GHOST_PREFIX}${id}`;

/** React Flow edges for the server graph, keeping local edge selection so Delete can remove a selected edge. */
export function buildFlowEdges(graph: Graph, run: RunMeta | undefined, current: FlowEdge[], changes: AgentChange[] = []): FlowEdge[] {
  const previous = new Map(current.map((e) => [e.id, e]));
  const added = new Set(changes.flatMap((c) => (c.kind === 'edge' && c.change === 'added' ? [c.id] : [])));
  const real: FlowEdge[] = graph.edges.map((e) => ({
    id: e.id,
    source: e.from,
    target: e.to,
    markerEnd: { type: MarkerType.ArrowClosed },
    animated: run?.nodes[e.to]?.status === 'running',
    selected: previous.get(e.id)?.selected ?? false,
    ...(added.has(e.id) && { className: 'edge-added' }),
  }));
  return [...real, ...ghostEdges(graph, changes)];
}

/** A removed connection, drawn faded between the steps it joined (real, or ghosts of removed steps). */
function ghostEdges(graph: Graph, changes: AgentChange[]): FlowEdge[] {
  const real = new Set(graph.nodes.map((n) => n.id));
  const removed = new Set(changes.flatMap((c) => (c.kind === 'node' && c.change === 'removed' ? [c.id] : [])));
  const end = (id: string) => (real.has(id) ? id : removed.has(id) ? ghostId(id) : undefined);
  const out: FlowEdge[] = [];
  for (const c of changes) {
    if (c.kind !== 'edge' || c.change !== 'removed') continue;
    const source = end(c.from);
    const target = end(c.to);
    if (source && target) out.push({ id: ghostId(c.id), source, target, markerEnd: { type: MarkerType.ArrowClosed }, className: 'edge-removed', selectable: false, deletable: false, focusable: false });
  }
  return out;
}
