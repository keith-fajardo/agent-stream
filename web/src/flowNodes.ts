import { MarkerType, type Edge as FlowEdge } from '@xyflow/react';
import { derivedStatus, type AgentChange, type ApprovalRequest, type Graph, type ModelChoice, type Position, type ProviderId, type RunMeta, type SubgraphEntry, type SubgraphProblem } from '@agent-stream/shared';
import type { StepData, StepFlowNode } from './components/StepNode';
import { layoutPositions } from './layout';
import { modelChip } from './stepModelMenus';

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
  /** The current provider and its models ([] while unknown): a step's model chip names and checks its model by them. */
  provider?: ProviderId;
  models?: readonly ModelChoice[];
  /** The canvas is inside sub-graph steps: a step's run state is under `prefix + id` (`n4/`), and '' at the top (sub-graphs spec §6.1). */
  prefix?: string;
  /** The inner graphs, for a sub-graph step's card, and the expansion's problems, each shown on the card it concerns. */
  subgraphs?: Record<string, SubgraphEntry>;
  problems?: readonly SubgraphProblem[];
};

/** A sub-graph step's card data: its inner graph's name and step count, and the first expansion problem at or inside it. */
function subgraphData(n: Graph['nodes'][number], expandedId: string, subgraphs: Record<string, SubgraphEntry>, problems: readonly SubgraphProblem[]): Pick<StepData, 'subgraph'> {
  if (n.kind !== 'graph') return {};
  const entry = n.graph ? subgraphs[n.graph] : undefined;
  const inner = entry && !('error' in entry) ? entry : undefined;
  const problem = problems.find((p) => p.stepId === expandedId || p.stepId.startsWith(`${expandedId}/`))?.message;
  return { subgraph: { graphName: inner?.name ?? (entry && 'error' in entry ? entry.name : undefined) ?? n.graph ?? '', ...(inner && { steps: inner.nodes.length }), ...(problem && { problem }) } };
}

/** Merge the server graph into the local React Flow nodes without clobbering in-flight drags, unconfirmed moves or local selection. */
export function buildFlowNodes(input: FlowNodesInput): StepFlowNode[] {
  const { graph, run, approvals, selectedId, selectionChanged, current, dragging, pendingMoves, baseline, changes = [], provider, models = [], prefix = '', subgraphs = {}, problems = [] } = input;
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
        // A sub-graph step shows the status derived from everything inside it (spec §4.2).
        state: n.kind === 'graph' && run ? derivedStatus(run, prefix + n.id) : run?.nodes[prefix + n.id],
        waiting: approvals.some((a) => a.runId === run?.id && (a.nodeId === prefix + n.id || (n.kind === 'graph' && a.nodeId.startsWith(`${prefix}${n.id}/`)))),
        ...changeData(nodeChange.get(n.id)),
        ...modelChipData(n, provider, models),
        ...subgraphData(n, prefix + n.id, subgraphs, problems),
      },
    };
  });
  return [...real, ...ghostNodes(graph, baseline, changes, previous)];
}

const modelChipData = (n: Graph['nodes'][number], provider: ProviderId | undefined, models: readonly ModelChoice[]): Pick<StepData, 'modelChip'> => {
  const chip = modelChip(n, provider, models);
  return chip ? { modelChip: chip } : {};
};

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
export function buildFlowEdges(graph: Graph, run: RunMeta | undefined, current: FlowEdge[], changes: AgentChange[] = [], prefix = ''): FlowEdge[] {
  const previous = new Map(current.map((e) => [e.id, e]));
  const added = new Set(changes.flatMap((c) => (c.kind === 'edge' && c.change === 'added' ? [c.id] : [])));
  const real: FlowEdge[] = graph.edges.map((e) => ({
    id: e.id,
    source: e.from,
    target: e.to,
    // A condition's `yes` or `no` arrow is drawn with its label; an unlabeled arrow has no label key.
    ...(e.label && { label: e.label }),
    markerEnd: { type: MarkerType.ArrowClosed },
    animated: run?.nodes[prefix + e.to]?.status === 'running',
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
