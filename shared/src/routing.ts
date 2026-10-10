import type { EdgeLabel, Graph, NodeStatus } from './types';

/** `wait`: a parent is unfinished. `run`: at least one arrow in is live. `skip`: every arrow in is dead. `not_run`: a parent failed. */
export type Route = 'wait' | 'run' | 'skip' | 'not_run';

const DONE_OK = new Set<NodeStatus>(['succeeded', 'reused']);
const FAILED = new Set<NodeStatus>(['failed', 'not_run', 'cancelled', 'interrupted']);
const UNFINISHED = new Set<NodeStatus>(['queued', 'running', 'waiting_approval']);

/**
 * Decide what a queued step does now (spec §3). `verdicts` maps a condition step's id to the verdict it read.
 * An arrow is live when its source finished OK and, for an arrow out of a condition, the verdict matches its label.
 */
export function routeNode(graph: Graph, statuses: Record<string, NodeStatus>, verdicts: Record<string, EdgeLabel | undefined>, id: string): Route {
  const incoming = graph.edges.filter((e) => e.to === id);
  if (incoming.some((e) => FAILED.has(statuses[e.from]))) return 'not_run';
  if (incoming.some((e) => UNFINISHED.has(statuses[e.from]))) return 'wait';
  if (incoming.length === 0) return 'run';
  const live = incoming.some((e) => DONE_OK.has(statuses[e.from]) && (e.label === undefined || verdicts[e.from] === e.label));
  return live ? 'run' : 'skip';
}
