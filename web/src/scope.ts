import { expandGraph, lookupFromEntries, type AgentChange, type ExpandResult, type Graph, type SubgraphEntry } from '@agent-stream/shared';
import type { State } from './state';

type ScopeState = Pick<State, 'graph' | 'scope' | 'subgraphs'>;

/** The graph the canvas shows: the tab's graph, or the inner graph of the sub-graph step it is inside (sub-graphs spec §6.1). */
export function shownGraph(s: ScopeState): Graph | undefined {
  let g = s.graph;
  for (const id of s.scope) {
    const step = g?.nodes.find((n) => n.id === id && n.kind === 'graph');
    const entry = step?.graph ? s.subgraphs[step.graph] : undefined;
    g = entry && !('error' in entry) ? entry : undefined;
  }
  return g;
}

/** Why the canvas can't show the graph it is inside: it is missing or its file has errors (spec §6.1). Undefined when it can. */
export function scopeProblem(s: ScopeState): string | undefined {
  let g = s.graph;
  for (const id of s.scope) {
    const step = g?.nodes.find((n) => n.id === id && n.kind === 'graph');
    if (!g || !step?.graph) return `Step ${id} is no longer a sub-graph step.`;
    const entry: SubgraphEntry | undefined = s.subgraphs[step.graph];
    // The engine sends every inner graph, the missing ones too: none yet means the message hasn't arrived.
    if (!entry) return undefined;
    if ('error' in entry) return entry.reason === 'missing' ? `This step uses graph "${step.graph}", which isn't in this folder.` : `This step uses graph "${entry.name ?? step.graph}", whose file has errors: ${entry.error}`;
    g = entry;
  }
  return undefined;
}

/** What a step id on the shown canvas is in the run: `n4/n2` inside `n4`, the id itself at the top. */
export const expandedIdOf = (s: Pick<State, 'scope'>, id: string): string => [...s.scope, id].join('/');

/** The agent-change review of the shown graph: the tab's own, or the inner graph's as the engine sent it. */
export function shownReview(s: Pick<State, 'graph' | 'scope' | 'subgraphs' | 'baseline' | 'changes' | 'subReviews'>): { baseline?: Graph; changes: AgentChange[] } {
  if (s.scope.length === 0) return { baseline: s.baseline, changes: s.changes };
  const g = shownGraph(s);
  return (g && s.subReviews[g.id]) ?? NO_REVIEW;
}
const NO_REVIEW: { changes: AgentChange[] } = { changes: [] };

/** What Edit › Undo would undo in the shown graph. */
export function shownUndoLabel(s: Pick<State, 'graph' | 'scope' | 'subgraphs' | 'undoLabel' | 'subUndo'>): string | undefined {
  if (s.scope.length === 0) return s.undoLabel;
  const g = shownGraph(s);
  return g ? s.subUndo[g.id] : undefined;
}

/**
 * Whether a sub-graph step the graph reaches has no entry yet. The engine sends every reachable id, a missing graph or one
 * with errors as an error entry, so an absent id means its `subgraphs` message hasn't arrived (not that the graph is missing).
 */
export function subgraphsPending(graph: Graph, entries: Record<string, SubgraphEntry>): boolean {
  const seen = new Set<string>();
  const queue = [graph];
  while (queue.length) {
    for (const n of queue.shift()!.nodes) {
      if (n.kind !== 'graph' || !n.graph || n.graph === graph.id || seen.has(n.graph)) continue;
      seen.add(n.graph);
      if (!Object.hasOwn(entries, n.graph)) return true;
      const entry = entries[n.graph];
      if (!('error' in entry)) queue.push(entry);
    }
  }
  return false;
}

let memo: { graph?: Graph; subgraphs?: Record<string, SubgraphEntry>; result?: ExpandResult } = {};
/**
 * The tab's graph expanded with the inner graphs it has (spec §6.3), as the engine would expand it: the same object while
 * neither changes, so React can compare it. Undefined before the graph loads, and while its inner graphs haven't arrived.
 */
export function liveExpansion(s: Pick<State, 'graph' | 'subgraphs'>): ExpandResult | undefined {
  if (!s.graph) return undefined;
  if (memo.graph !== s.graph || memo.subgraphs !== s.subgraphs) {
    const result = subgraphsPending(s.graph, s.subgraphs) ? undefined : expandGraph(s.graph, lookupFromEntries(s.subgraphs, s.graph));
    memo = { graph: s.graph, subgraphs: s.subgraphs, result };
  }
  return memo.result;
}

/** The breadcrumb's parts (spec §6.1): the tab's graph, then each sub-graph step the canvas is inside. */
export function scopeTrail(s: ScopeState): { label: string; depth: number }[] {
  const parts = [{ label: s.graph?.name ?? '', depth: 0 }];
  let g = s.graph;
  s.scope.forEach((id, i) => {
    const step = g?.nodes.find((n) => n.id === id);
    const entry = step?.graph ? s.subgraphs[step.graph] : undefined;
    const inner = entry && !('error' in entry) ? entry : undefined;
    parts.push({ label: `${id} ${step?.title ?? ''} (${inner?.name ?? (entry && 'error' in entry ? (entry.name ?? step?.graph) : step?.graph) ?? ''})`, depth: i + 1 });
    g = inner;
  });
  return parts;
}
