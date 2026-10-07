import { edgeId, topoOrder } from './graph';
import type { Edge, Graph, GraphNode, NodeRunState, NodeStatus, RunMeta } from './types';

/**
 * Finds an inner graph by id (sub-graphs spec §3). `broken`: the graph's file doesn't read now, so it must not be used
 * (never its last good version); `name` is its last good name when there is one.
 */
export type GraphLookup = (id: string) => { ok: true; graph: Graph } | { ok: false; reason: 'missing' | 'broken'; error: string; name?: string };
/**
 * One sub-graph step of an expanded graph: `stepId` is its expanded id, `depth` 1 for a step of the graph being run.
 * `attachments`: the inner graph's own graph-level attachment list (absent when empty), so a step's files come from its scope.
 */
export type Scope = { stepId: string; graphId: string; graphName: string; depth: number; values: Record<string, string>; attachments?: string[] };
/** `stepId`: the expanded id of the sub-graph step with the problem; '' for a problem of the whole graph (the step cap). */
export type SubgraphProblem = { stepId: string; message: string };
/** `graphs`: every inner graph used, by id, as the expansion read it (for its variables, goal and instructions). */
export type ExpandResult = { ok: true; graph: Graph; scopes: Record<string, Scope>; graphs: Record<string, Graph> } | { ok: false; problems: SubgraphProblem[] };
/** What the engine sends a tab for each graph reachable through sub-graph steps (spec §6.3): the graph, or why it can't be used. */
export type SubgraphEntry = Graph | { error: string; reason: 'missing' | 'broken'; name?: string };

/** At most 3 levels of sub-graphs below the graph being run, and 500 steps in all (spec §1, §3.1). */
export const MAX_SUBGRAPH_DEPTH = 3;
export const MAX_EXPANDED_STEPS = 500;

export const TOO_MANY_STEPS = `This graph expands to more than ${MAX_EXPANDED_STEPS} steps.`;
export const missingGraphProblem = (stepId: string, graphId: string) => `Step ${stepId} uses graph "${graphId}", which isn't in this folder.`;
export const brokenGraphProblem = (stepId: string, name: string, error: string) => `Step ${stepId} uses graph "${name}", whose file has errors: ${error.replace(/\.+$/, '')}.`;
export const loopProblem = (stepId: string, name: string, path: readonly string[]) => `Step ${stepId} would put "${name}" inside itself (${path.join(' › ')}).`;
export const tooDeepProblem = (stepId: string) => `Step ${stepId} nests sub-graphs more than ${MAX_SUBGRAPH_DEPTH} levels deep.`;
export const emptyGraphProblem = (stepId: string, name: string) => `Step ${stepId} uses graph "${name}", which has no steps.`;

/** An expanded id: 1 to 4 step ids joined by "/" (`n4/n2`). Its run folder is `nodes/<folder id>/` (spec §4.4). */
export const EXPANDED_NODE_ID_RE = /^[A-Za-z0-9_-]{1,64}(?:\/[A-Za-z0-9_-]{1,64}){0,3}$/;
/** The run folder name of an expanded id: "/" written as "~", which no step id contains (`n4/n2` → `n4~n2`). */
export const folderId = (expandedId: string): string => expandedId.replace(/\//g, '~');
/** An inner step's workspace in the expanded graph: `<step>~<name>`, so it never meets an outer one or another use's (spec §3.1.6). */
export const scopedWorkspace = (stepId: string, name: string): string => `${folderId(stepId)}~${name}`;
/** The sub-graph step an expanded id is inside (`n4/n2/n1` → `n4/n2`), or undefined for a step of the graph being run. */
export function parentScopeId(expandedId: string): string | undefined {
  const i = expandedId.lastIndexOf('/');
  return i < 0 ? undefined : expandedId.slice(0, i);
}
/** The run form's key and label for an inner variable asked at run start (spec §3.3): `n4/company`, `n4 · company`. */
export const subgraphValueKey = (stepId: string, name: string): string => `${stepId}/${name}`;
export const subgraphValueLabel = (stepId: string, name: string): string => `${stepId} · ${name}`;

/** The longest scope whose step is a "/"-prefix of the id: the sub-graph the step belongs to. Undefined: the outer graph (spec §3.2). */
export function scopeOf(scopes: Record<string, Scope> | undefined, expandedId: string): Scope | undefined {
  for (let parent = parentScopeId(expandedId); parent !== undefined; parent = parentScopeId(parent)) {
    const scope = scopes?.[parent];
    if (scope) return scope;
  }
  return undefined;
}

type Level = { nodes: GraphNode[]; edges: Edge[] };
type Expansion = { lookup: GraphLookup; problems: SubgraphProblem[]; scopes: Record<string, Scope>; graphs: Record<string, Graph>; tooBig: boolean };

/** `g` with each of its sub-graph steps' inner steps copied in under prefixed ids and rewired (spec §3.1); `at` is g's own prefix. */
function expandLevel(g: Graph, path: readonly Graph[], at: string, x: Expansion): Level {
  let nodes = [...g.nodes];
  let edges = [...g.edges];
  for (const s of g.nodes) {
    if (s.kind !== 'graph' || !s.graph) continue;
    const stepId = at + s.id;
    const depth = stepId.split('/').length;
    const found = x.lookup(s.graph);
    if (!found.ok) {
      x.problems.push({ stepId, message: found.reason === 'missing' ? missingGraphProblem(stepId, s.graph) : brokenGraphProblem(stepId, found.name ?? s.graph, found.error) });
      continue;
    }
    const inner = found.graph;
    if (path.some((p) => p.id === inner.id)) {
      x.problems.push({ stepId, message: loopProblem(stepId, inner.name, [...path.map((p) => p.name), inner.name]) });
      continue;
    }
    if (depth > MAX_SUBGRAPH_DEPTH) {
      x.problems.push({ stepId, message: tooDeepProblem(stepId) });
      continue;
    }
    if (inner.nodes.length === 0) {
      x.problems.push({ stepId, message: emptyGraphProblem(stepId, inner.name) });
      continue;
    }
    x.graphs[inner.id] = inner;
    x.scopes[stepId] = { stepId, graphId: inner.id, graphName: inner.name, depth, values: { ...(s.values ?? {}) }, ...(inner.attachments?.length && { attachments: [...inner.attachments] }) };
    // The inner graph's own sub-graph steps first, so this step copies them already expanded.
    const sub = expandLevel(inner, [...path, inner], `${stepId}/`, x);
    if (nodes.length + sub.nodes.length > MAX_EXPANDED_STEPS) {
      x.tooBig = true;
      continue;
    }
    const p = `${s.id}/`;
    const firsts = sub.nodes.filter((n) => !sub.edges.some((e) => e.to === n.id)).map((n) => p + n.id);
    const lasts = sub.nodes.filter((n) => !sub.edges.some((e) => e.from === n.id)).map((n) => p + n.id);
    const into = edges.filter((e) => e.to === s.id);
    edges = [
      ...edges.filter((e) => e.to !== s.id),
      ...into.flatMap((e) => firsts.map((to) => ({ id: edgeId(e.from, to), from: e.from, to }))),
      ...sub.edges.map((e) => ({ id: edgeId(p + e.from, p + e.to), from: p + e.from, to: p + e.to })),
      ...lasts.map((from) => ({ id: edgeId(from, s.id), from, to: s.id })),
    ];
    nodes = [...nodes, ...sub.nodes.map((n): GraphNode => ({ ...n, id: p + n.id, ...(n.workspace && { workspace: scopedWorkspace(s.id, n.workspace) }) }))];
  }
  return { nodes, edges };
}

/**
 * The graph a run executes (sub-graphs spec §3): each sub-graph step's inner steps copied in as `s/<id>`, fed by the steps
 * that fed `s`, and feeding `s` itself, which stays as the collector. Keeps the outer graph's id, name, goal, instructions,
 * variables and attachments. Problems are collected for every sub-graph step; any problem means no graph.
 */
export function expandGraph(outer: Graph, lookup: GraphLookup): ExpandResult {
  const x: Expansion = { lookup, problems: [], scopes: {}, graphs: {}, tooBig: false };
  const level = expandLevel(outer, [outer], '', x);
  if (x.tooBig) x.problems.push({ stepId: '', message: TOO_MANY_STEPS });
  if (x.problems.length) return { ok: false, problems: x.problems };
  return { ok: true, graph: { ...outer, nodes: level.nodes, edges: level.edges }, scopes: x.scopes, graphs: x.graphs };
}

/** Whether using `candidateId` as a sub-graph in `outerId` would put `outerId` inside itself, directly or through other graphs (spec §6.2). */
export function wouldCreateGraphLoop(outerId: string, candidateId: string, lookup: GraphLookup): boolean {
  const seen = new Set<string>();
  const queue = [candidateId];
  while (queue.length) {
    const id = queue.shift()!;
    if (id === outerId) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    const found = lookup(id);
    if (found.ok) for (const n of found.graph.nodes) if (n.kind === 'graph' && n.graph) queue.push(n.graph);
  }
  return false;
}

/** Every graph reachable from `root` through sub-graph steps, transitively, each as the lookup finds it: what the engine sends a tab (spec §6.3). */
export function collectSubgraphs(root: Graph, lookup: GraphLookup): Record<string, SubgraphEntry> {
  const out: Record<string, SubgraphEntry> = {};
  const queue = root.nodes.flatMap((n) => (n.kind === 'graph' && n.graph ? [n.graph] : []));
  while (queue.length) {
    const id = queue.shift()!;
    if (Object.hasOwn(out, id) || id === root.id) continue;
    const found = lookup(id);
    if (!found.ok) {
      out[id] = { error: found.error, reason: found.reason, ...(found.name && { name: found.name }) };
      continue;
    }
    out[id] = found.graph;
    for (const n of found.graph.nodes) if (n.kind === 'graph' && n.graph) queue.push(n.graph);
  }
  return out;
}

/** A lookup over what collectSubgraphs gave: what the web expands with. An id it doesn't hold is missing. */
export function lookupFromEntries(entries: Record<string, SubgraphEntry>, also?: Graph): GraphLookup {
  return (id) => {
    if (also && id === also.id) return { ok: true, graph: also };
    const e = Object.hasOwn(entries, id) ? entries[id] : undefined;
    if (!e) return { ok: false, reason: 'missing', error: `graph "${id}" not found` };
    return 'error' in e ? { ok: false, reason: e.reason, error: e.error, ...(e.name && { name: e.name }) } : { ok: true, graph: e };
  };
}

/** The expanded ids inside sub-graph step `stepId`, at any depth. */
export const innerStepIds = (graph: Graph, stepId: string): string[] => graph.nodes.filter((n) => n.id.startsWith(`${stepId}/`)).map((n) => n.id);

/** A sub-graph step's inner first steps in an expanded graph: inside it, with no step inside it before them (spec §4.5). */
export function subgraphFirstSteps(graph: Graph, stepId: string): string[] {
  const inner = new Set(innerStepIds(graph, stepId));
  return [...inner].filter((id) => !graph.edges.some((e) => e.to === id && inner.has(e.from)));
}

/**
 * The ids in run order, each sub-graph step placed just before its inner steps and those inner steps kept together right after it,
 * so the run dialog and report can indent them as one group (spec §5). Outer steps on parallel branches never land inside a group.
 */
export function groupedOrder(graph: Graph): string[] {
  const order = topoOrder(graph);
  const ids = order.length === graph.nodes.length ? order : graph.nodes.map((n) => n.id);
  const subgraphSteps = new Set(graph.nodes.filter((n) => n.kind === 'graph').map((n) => n.id));
  const out: string[] = [];
  const placed = new Set<string>();
  const place = (id: string): void => {
    if (placed.has(id)) return;
    const parent = parentScopeId(id);
    if (parent !== undefined && subgraphSteps.has(parent)) {
      place(parent);
      return;
    }
    placed.add(id);
    out.push(id);
    if (!subgraphSteps.has(id)) return;
    // The whole group now, in run order; a nested sub-graph step brings its own inner steps along.
    for (const inner of ids) if (parentScopeId(inner) === id) placeInner(inner);
  };
  const placeInner = (id: string): void => {
    if (placed.has(id)) return;
    placed.add(id);
    out.push(id);
    if (subgraphSteps.has(id)) for (const inner of ids) if (parentScopeId(inner) === id) placeInner(inner);
  };
  for (const id of ids) place(id);
  return out;
}

const anyStatus = (states: NodeRunState[], status: NodeStatus) => states.some((s) => s.status === status);

/**
 * The status a sub-graph step shows (spec §4.2), from its own state and every state inside it; the first rule that matches
 * wins. A stale inner step makes a succeeded sub-graph step stale too. Undefined when the run has neither.
 */
export function derivedStatus(run: Pick<RunMeta, 'nodes'>, stepId: string): NodeRunState | undefined {
  const own = run.nodes[stepId];
  const inner = Object.entries(run.nodes)
    .filter(([id]) => id.startsWith(`${stepId}/`))
    .map(([, s]) => s);
  if (!own && inner.length === 0) return undefined;
  const base: NodeRunState = own ?? { status: 'queued' };
  for (const [status, shown] of [
    ['waiting_approval', 'waiting_approval'],
    ['running', 'running'],
    ['failed', 'failed'],
    ['interrupted', 'interrupted'],
    ['cancelled', 'cancelled'],
  ] as const) {
    if (anyStatus(inner, status)) return { ...base, status: shown };
  }
  if (own?.status === 'succeeded') {
    const stale = own.stale ?? inner.find((s) => s.stale)?.stale;
    return stale ? { ...own, stale } : own;
  }
  if (own?.status === 'reused' && inner.every((s) => s.status === 'reused')) return own;
  return base;
}
