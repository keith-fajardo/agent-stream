import { reusableNodeIds, validateRunnable, type Graph, type GraphNode, type RunMeta } from '@claude-stream/shared';
import type { ConfirmRequest } from './state';

export type RunPlan = { problems: string[]; commands: GraphNode[]; agentCount: number; reused: string[]; exact: boolean };

/**
 * What the confirmation dialog shows (spec §7.1). For a re-run it is exact only when the
 * source run is the one loaded in the browser; otherwise it lists every command node.
 */
export function describeRunPlan(graph: Graph, request: ConfirmRequest, loadedRun?: RunMeta): RunPlan {
  const problems = validateRunnable(graph);
  let reused = new Set<string>();
  let exact = true;
  if (request.sourceRunId) {
    if (loadedRun?.id === request.sourceRunId) reused = reusableNodeIds(graph, loadedRun, request.fromNodeId);
    else exact = false;
  }
  const executing = graph.nodes.filter((n) => !reused.has(n.id));
  return {
    problems,
    commands: executing.filter((n) => n.kind === 'command'),
    agentCount: executing.filter((n) => n.kind === 'agent').length,
    reused: [...reused],
    exact,
  };
}
