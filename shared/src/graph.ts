import { COMMAND_ALWAYS_WRITES, workspaceNameProblem, workspaceOf } from './access';
import { attachmentListProblem, ONLY_AGENT_STEPS_ATTACH } from './attachments';
import { ONLY_AGENT_STEPS_BROWSER } from './browser';
import { ONLY_AGENT_STEPS_MODEL, stepModelProblem, stepModelText } from './stepModels';
import { graphIdProblem, ONLY_SUBGRAPH_STEPS_GRAPH, setsStepField, sortedValues, SUBGRAPH_FIELDS_ONLY, SUBGRAPH_NEEDS_GRAPH, subgraphValuesProblem, valuesText } from './subgraphStep';
import { innerStepIds, scopeOf, subgraphFirstSteps, type Scope } from './subgraphs';
import { shapeProblems } from './shape';
import { variableNameProblem } from './variables';
import type { Actor, Graph, GraphNode, GraphResult, NodeKind, NodePatch, NodeRunState, Op, RenderedRun, RunAttachment, RunMode, StaleMark } from './types';

/** 1 to 64 letters, digits, - and _; no "--" and no trailing "-", so every id can be written in the Flow (an arrow starts at a "-"). */
const NODE_ID_RE = /^(?!.*--)(?=.{1,64}$)[A-Za-z0-9_-]*[A-Za-z0-9_]$/;
/** What graph files written before the Markdown format could hold: any 1 to 64 letters, digits, - and _. */
const LEGACY_NODE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const WINDOWS_DEVICE_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

const NODE_ID_RULE = 'Step ids use letters, digits, - and _ (at most 64), with no "--" and not ending in "-".';

function idProblem(id: string, pattern: RegExp): string | null {
  if (!pattern.test(id)) return `invalid node id "${id}". ${NODE_ID_RULE}`;
  if (id === '__proto__' || Object.prototype.hasOwnProperty.call(Object.prototype, id) || WINDOWS_DEVICE_RE.test(id)) {
    return `"${id}" can't be used as a step id.`;
  }
  return null;
}

/** Why `id` can't be a new step id, or null. Ids key plain objects and become folder names under runs/. */
export const nodeIdProblem = (id: string): string | null => idProblem(id, NODE_ID_RE);

/** Like `nodeIdProblem`, but for graphs that already exist: ids with "--" or a trailing "-" still load (`parseGraph`). */
export const legacyNodeIdProblem = (id: string): string | null => idProblem(id, LEGACY_NODE_ID_RE);

/** A step with something for the planner to refine: a description, a prompt or a command. */
export const refinable = (n: GraphNode): boolean => !!(n.description?.trim() || n.prompt?.trim() || n.command?.trim());

export function emptyGraph(id: string, name: string, now: string): Graph {
  return { id, name, goal: '', instructions: '', variables: [], nodes: [], edges: [], nodeSeq: 0, updatedAt: now };
}

export function edgeId(from: string, to: string): string {
  return `${from}->${to}`;
}

/** The number in an `n<number>` step id; 0 for any other id, and for a number too large to count on exactly. */
export function seqOf(id: string): number {
  const m = /^n(\d+)$/.exec(id);
  const n = m ? Number(m[1]) : 0;
  return Number.isSafeInteger(n) ? n : 0;
}

export function nextNodeId(graph: Graph): string {
  const max = graph.nodes.reduce((acc, n) => Math.max(acc, seqOf(n.id)), graph.nodeSeq);
  return `n${max + 1}`;
}

/** The first agent or command field a new condition or stop step, or a patch to one, sets; null when it sets none. Clearing one (0, '', null, [], false, write) doesn't set it. */
function agentFieldOn(kind: NodeKind, f: { timeoutSec?: number; access?: string; workspace?: string; model?: unknown; effort?: unknown; attachments?: string[]; browser?: boolean }): string | null {
  if (kind !== 'condition' && kind !== 'stop') return null;
  const set: [string, boolean][] = [
    ['timeout', (f.timeoutSec ?? 0) > 0],
    ['access', f.access === 'read'],
    ['workspace', !!f.workspace?.trim()],
    ['model', !!f.model],
    ['effort', !!f.effort],
    ['attachments', !!f.attachments?.length],
    ['browser', f.browser === true],
  ];
  const field = set.find(([, on]) => on)?.[0];
  return field ? `a ${kind} step can't have ${field}. Remove it.` : null;
}

function definedOnly<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}

const MAX_DESCRIPTION_CHARS = 2000;
const DESCRIPTION_TOO_LONG = `a description can be at most ${MAX_DESCRIPTION_CHARS} characters`;

export type ApplyOptions = {
  /** Rewrites references to a renamed variable inside a template (the engine passes a Jinja-aware one). */
  rewriteReferences?: (text: string, from: string, to: string) => string;
};

export function applyOp(graph: Graph, op: Op, by: Actor, now: string, options: ApplyOptions = {}): GraphResult {
  const fail = (error: string): GraphResult => ({ ok: false, error });
  const has = (id: string) => graph.nodes.some((n) => n.id === id);
  const done = (patch: Partial<Graph>): GraphResult => ({ ok: true, graph: { ...graph, ...patch, updatedAt: now } });

  switch (op.type) {
    case 'addNode': {
      const id = op.node.id ?? nextNodeId(graph);
      const idProblem = nodeIdProblem(id);
      if (idProblem) return fail(idProblem);
      if (has(id)) return fail(`node ${id} already exists`);
      const title = op.node.title.trim();
      if (!title) return fail('a node needs a title');
      if ((op.node.description?.length ?? 0) > MAX_DESCRIPTION_CHARS) return fail(DESCRIPTION_TOO_LONG);
      if (op.node.access === 'read' && op.node.kind === 'command') return fail(COMMAND_ALWAYS_WRITES);
      const agentField = agentFieldOn(op.node.kind, op.node);
      if (agentField) return fail(agentField);
      const modelProblem = stepModelProblem(op.node.model, op.node.effort);
      if (modelProblem) return fail(modelProblem);
      if ((op.node.model || op.node.effort) && op.node.kind === 'command') return fail(ONLY_AGENT_STEPS_MODEL);
      const attachProblem = op.node.attachments ? attachmentListProblem(op.node.attachments) : null;
      if (attachProblem) return fail(attachProblem);
      if (op.node.attachments?.length && op.node.kind === 'command') return fail(ONLY_AGENT_STEPS_ATTACH);
      if (op.node.browser && op.node.kind === 'command') return fail(ONLY_AGENT_STEPS_BROWSER);
      const isGraph = op.node.kind === 'graph';
      if (isGraph) {
        if (setsStepField(op.node)) return fail(SUBGRAPH_FIELDS_ONLY);
        if (!op.node.graph) return fail(SUBGRAPH_NEEDS_GRAPH);
        const graphProblem = graphIdProblem(op.node.graph);
        if (graphProblem) return fail(graphProblem);
        const valuesProblem = op.node.values ? subgraphValuesProblem(op.node.values) : null;
        if (valuesProblem) return fail(valuesProblem);
      } else if (op.node.graph !== undefined || op.node.values !== undefined) return fail(ONLY_SUBGRAPH_STEPS_GRAPH);
      const workspace = isGraph ? undefined : op.node.workspace?.trim() || undefined;
      const workspaceProblem = workspace === undefined ? null : workspaceNameProblem(workspace);
      if (workspaceProblem) return fail(workspaceProblem);
      const node = definedOnly<GraphNode>({
        id,
        title,
        kind: op.node.kind,
        description: op.node.description,
        prompt: isGraph ? undefined : op.node.prompt,
        command: isGraph ? undefined : op.node.command,
        timeoutSec: isGraph ? undefined : op.node.timeoutSec,
        access: op.node.access === 'read' ? 'read' : undefined,
        workspace,
        model: op.node.model && { provider: op.node.model.provider, id: op.node.model.id },
        effort: op.node.effort,
        attachments: op.node.attachments?.length ? [...op.node.attachments] : undefined,
        // Only `true` is stored: off is no field (spec §2.1).
        browser: op.node.browser === true ? true : undefined,
        // Stored when set, true or false, as the file writer does; shapeProblems rejects it on a step that is not a stop.
        failFast: op.node.failFast,
        graph: isGraph ? op.node.graph : undefined,
        // An empty map is no field; the values are kept in name order.
        values: isGraph && op.node.values && Object.keys(op.node.values).length > 0 ? sortedValues(op.node.values) : undefined,
        position: op.node.position,
        createdBy: by,
        updatedBy: by,
        updatedAt: now,
      }) as GraphNode;
      return done({ nodes: [...graph.nodes, node], nodeSeq: Math.max(graph.nodeSeq, seqOf(id)) });
    }
    case 'updateNode': {
      const node = graph.nodes.find((n) => n.id === op.id);
      if (!node) return fail(`node ${op.id} does not exist`);
      const { access, workspace, timeoutSec, model, effort, attachments, browser, graph: innerGraph, values, ...patch } = definedOnly<NodePatch>(op.patch);
      if (patch.title !== undefined) {
        patch.title = patch.title.trim();
        if (!patch.title) return fail('a node needs a title');
      }
      if ((patch.description?.length ?? 0) > MAX_DESCRIPTION_CHARS) return fail(DESCRIPTION_TOO_LONG);
      const kind = patch.kind ?? node.kind;
      if (access === 'read' && kind === 'command') return fail(COMMAND_ALWAYS_WRITES);
      const agentField = agentFieldOn(kind, { timeoutSec, access, workspace, model, effort, attachments, browser });
      if (agentField) return fail(agentField);
      const modelProblem = stepModelProblem(model ?? undefined, effort ?? undefined);
      if (modelProblem) return fail(modelProblem);
      if ((model || effort) && kind === 'command') return fail(ONLY_AGENT_STEPS_MODEL);
      const attachProblem = attachments ? attachmentListProblem(attachments) : null;
      if (attachProblem) return fail(attachProblem);
      if (attachments?.length && kind === 'command') return fail(ONLY_AGENT_STEPS_ATTACH);
      if (browser && kind === 'command') return fail(ONLY_AGENT_STEPS_BROWSER);
      // A sub-graph step has only its graph and values (spec §2.1); becoming one needs a graph, becoming anything else drops both.
      const isGraph = kind === 'graph';
      if (isGraph && setsStepField({ prompt: patch.prompt, command: patch.command, timeoutSec, access, workspace, model, effort, attachments, browser })) return fail(SUBGRAPH_FIELDS_ONLY);
      if (!isGraph && (innerGraph !== undefined || values !== undefined)) return fail(ONLY_SUBGRAPH_STEPS_GRAPH);
      const nextGraph = isGraph ? (innerGraph ?? node.graph) : undefined;
      if (isGraph && !nextGraph) return fail(SUBGRAPH_NEEDS_GRAPH);
      const graphProblem = nextGraph ? graphIdProblem(nextGraph) : null;
      if (graphProblem) return fail(graphProblem);
      const valuesProblem = values ? subgraphValuesProblem(values) : null;
      if (valuesProblem) return fail(valuesProblem);
      const nextValues = isGraph ? (values ?? node.values) : undefined;
      // A condition or stop step has neither a workspace nor a timeout, so becoming one drops both (spec §2).
      const bare = kind === 'condition' || kind === 'stop';
      let nextWorkspace = isGraph || bare ? undefined : node.workspace;
      if (workspace !== undefined && !isGraph && !bare) {
        const trimmed = workspace.trim();
        const problem = trimmed === '' ? null : workspaceNameProblem(trimmed);
        if (problem) return fail(problem);
        nextWorkspace = trimmed || undefined;
      }
      // A command step can always change files, so becoming one drops `access` (spec §3.1).
      const nextAccess = kind !== 'agent' ? undefined : (access ?? node.access) === 'read' ? 'read' : undefined;
      // 0 clears the timeout; a missing one keeps it.
      const nextTimeout = isGraph || bare ? undefined : timeoutSec === undefined ? node.timeoutSec : timeoutSec > 0 ? timeoutSec : undefined;
      // Only agent steps have a model or effort, so becoming a command step drops both (spec §2.1); null clears one.
      const nextModel = kind !== 'agent' || model === null ? undefined : (model ?? node.model);
      const nextEffort = kind !== 'agent' || effort === null ? undefined : (effort ?? node.effort);
      // So do its attachments; [] clears them (spec §6b.3).
      const nextAttachments = kind !== 'agent' ? undefined : (attachments ?? node.attachments);
      // And the browser (browser spec §2.1); false turns it off.
      const nextBrowser = kind !== 'agent' ? false : (browser ?? node.browser === true);
      const { access: _access, workspace: _workspace, timeoutSec: _timeoutSec, model: _model, effort: _effort, attachments: _attachments, browser: _browser, graph: _graph, values: _values, ...kept } = node;
      // A sub-graph step has no prompt or command: neither the old one nor one the patch clears.
      const { prompt: _prompt, command: _command, ...keptBase } = kept;
      const { prompt: _patchPrompt, command: _patchCommand, ...patchBase } = patch;
      const updated: GraphNode = {
        ...(isGraph ? keptBase : kept),
        ...(isGraph ? patchBase : patch),
        ...(nextTimeout !== undefined && { timeoutSec: nextTimeout }),
        ...(nextAccess && { access: nextAccess }),
        ...(nextWorkspace && { workspace: nextWorkspace }),
        ...(nextModel && { model: { provider: nextModel.provider, id: nextModel.id } }),
        ...(nextEffort && { effort: nextEffort }),
        ...(nextAttachments?.length && { attachments: [...nextAttachments] }),
        ...(nextBrowser && { browser: true }),
        ...(nextGraph && { graph: nextGraph }),
        ...(nextValues && Object.keys(nextValues).length > 0 && { values: sortedValues(nextValues) }),
        updatedBy: by,
        updatedAt: now,
      };
      // Fail-fast is stored only as `true` on a stop step: off, or on another kind of step, is no field (spec §2.1).
      const { failFast, ...unflagged } = updated;
      const stored: GraphNode = kind === 'stop' && failFast === true ? { ...unflagged, failFast: true } : unflagged;
      return done({ nodes: graph.nodes.map((n) => (n.id === op.id ? stored : n)) });
    }
    case 'deleteNode': {
      if (!has(op.id)) return fail(`node ${op.id} does not exist`);
      return done({
        nodes: graph.nodes.filter((n) => n.id !== op.id),
        edges: graph.edges.filter((e) => e.from !== op.id && e.to !== op.id),
      });
    }
    case 'connect': {
      if (!has(op.from)) return fail(`node ${op.from} does not exist`);
      if (!has(op.to)) return fail(`node ${op.to} does not exist`);
      if (op.from === op.to) return fail('a node cannot depend on itself');
      if (graph.edges.some((e) => e.from === op.from && e.to === op.to)) return fail(`${op.from} -> ${op.to} already exists`);
      if (op.label && graph.nodes.find((n) => n.id === op.from)?.kind !== 'condition') return fail(`only an arrow out of a condition step can be labeled yes or no`);
      if (wouldCreateCycle(graph, op.from, op.to)) return fail(`connecting ${op.from} -> ${op.to} would create a cycle`);
      return done({ edges: [...graph.edges, { id: edgeId(op.from, op.to), from: op.from, to: op.to, ...(op.label && { label: op.label }) }] });
    }
    case 'disconnect': {
      if (!graph.edges.some((e) => e.from === op.from && e.to === op.to)) return fail(`${op.from} -> ${op.to} does not exist`);
      return done({ edges: graph.edges.filter((e) => !(e.from === op.from && e.to === op.to)) });
    }
    case 'setGoal':
      return done({ goal: op.goal });
    case 'setInstructions':
      return done({ instructions: op.instructions });
    case 'addVariable': {
      const problem = variableNameProblem(op.name, graph.variables);
      if (problem) return fail(problem);
      return done({ variables: [...graph.variables, { name: op.name, description: op.description?.trim() ?? '' }] });
    }
    case 'renameVariable': {
      if (!graph.variables.some((v) => v.name === op.name)) return fail(`variable ${op.name} does not exist`);
      if (op.newName === op.name) return done({});
      const problem = variableNameProblem(op.newName, graph.variables);
      if (problem) return fail(problem);
      const rewrite = options.rewriteReferences;
      const text = (s: string | undefined) => (s === undefined || !rewrite ? s : rewrite(s, op.name, op.newName));
      const nodes = graph.nodes.map((n) => {
        const prompt = text(n.prompt);
        const command = text(n.command);
        const values = n.values && Object.fromEntries(Object.entries(n.values).map(([k, v]) => [k, text(v) ?? v]));
        if (prompt === n.prompt && command === n.command && JSON.stringify(values) === JSON.stringify(n.values)) return n;
        return definedOnly<GraphNode>({ ...n, prompt, command, values, updatedBy: by, updatedAt: now }) as GraphNode;
      });
      return done({
        variables: graph.variables.map((v) => (v.name === op.name ? { ...v, name: op.newName } : v)),
        nodes,
        goal: text(graph.goal) ?? '',
        instructions: text(graph.instructions) ?? '',
      });
    }
    case 'setVariableDescription': {
      if (!graph.variables.some((v) => v.name === op.name)) return fail(`variable ${op.name} does not exist`);
      return done({ variables: graph.variables.map((v) => (v.name === op.name ? { ...v, description: op.description.trim() } : v)) });
    }
    case 'deleteVariable': {
      if (!graph.variables.some((v) => v.name === op.name)) return fail(`variable ${op.name} does not exist`);
      return done({ variables: graph.variables.filter((v) => v.name !== op.name) });
    }
    case 'setGraphAttachments': {
      const problem = attachmentListProblem(op.names);
      if (problem) return fail(problem);
      const { attachments: _attachments, ...rest } = graph;
      return { ok: true, graph: { ...rest, ...(op.names.length > 0 && { attachments: [...op.names] }), updatedAt: now } };
    }
    case 'moveNode': {
      if (!has(op.id)) return fail(`node ${op.id} does not exist`);
      const place = (n: GraphNode): GraphNode => {
        if (op.position) return { ...n, position: op.position };
        const { position: _position, ...rest } = n;
        return rest;
      };
      return done({ nodes: graph.nodes.map((n) => (n.id === op.id ? place(n) : n)) });
    }
    case 'acceptChange':
    case 'revertChange':
      return fail('acceptChange and revertChange are applied by the graph store');
  }
}

export function children(graph: Graph, id: string): string[] {
  return graph.edges.filter((e) => e.from === id).map((e) => e.to);
}

export function upstream(graph: Graph, id: string): string[] {
  return graph.edges.filter((e) => e.to === id).map((e) => e.from);
}

/** Every node reachable from `id` by following edges forward. */
export function descendants(graph: Graph, id: string): Set<string> {
  const seen = new Set<string>();
  const stack = [id];
  while (stack.length) {
    const current = stack.pop()!;
    for (const next of children(graph, current)) {
      if (!seen.has(next)) {
        seen.add(next);
        stack.push(next);
      }
    }
  }
  return seen;
}

/** Adding from -> to creates a cycle exactly when `from` is reachable from `to`. */
export function wouldCreateCycle(graph: Graph, from: string, to: string): boolean {
  return from === to || descendants(graph, to).has(from);
}

/** Kahn's algorithm. Returns fewer ids than there are nodes when the graph has a cycle. */
export function topoOrder(graph: Graph): string[] {
  const indegree = new Map(graph.nodes.map((n) => [n.id, 0]));
  for (const e of graph.edges) indegree.set(e.to, (indegree.get(e.to) ?? 0) + 1);
  const ready = graph.nodes.filter((n) => indegree.get(n.id) === 0).map((n) => n.id);
  const order: string[] = [];
  while (ready.length) {
    const id = ready.shift()!;
    order.push(id);
    for (const child of children(graph, id)) {
      const left = (indegree.get(child) ?? 0) - 1;
      indegree.set(child, left);
      if (left === 0) ready.push(child);
    }
  }
  return order;
}

/** What a run depends on; positions are layout, not content. */
export function contentSignature(g: Graph): string {
  return JSON.stringify({
    goal: g.goal,
    instructions: g.instructions,
    attachments: g.attachments ?? [],
    // A sub-graph step's graph and values are added only for it, so graphs without one keep their signature.
    nodes: g.nodes.map((n) => [n.id, n.kind, n.title, n.description ?? '', n.prompt ?? '', n.command ?? '', n.timeoutSec ?? null, n.access ?? 'write', n.workspace ?? '', n.model ? stepModelText(n.model) : '', n.effort ?? '', n.attachments ?? [], n.browser === true, ...(n.kind === 'graph' ? [n.graph ?? '', sortedValues(n.values)] : []), ...(n.kind === 'stop' ? [n.failFast === true] : [])]),
    edges: g.edges.map((e) => `${e.id}${e.label ? `:${e.label}` : ''}`).sort(),
  });
}

export function validateRunnable(graph: Graph): string[] {
  const problems: string[] = [];
  if (graph.nodes.length === 0) problems.push('The graph has no nodes.');
  for (const n of graph.nodes) {
    if (n.kind === 'agent' && !n.prompt?.trim()) problems.push(`${n.id} "${n.title}": an agent node needs a prompt.`);
    if (n.kind === 'command' && !n.command?.trim()) problems.push(`${n.id} "${n.title}": a command node needs a command.`);
    if (n.kind === 'graph' && !n.graph) problems.push(`${n.id} "${n.title}": a sub-graph step needs a graph.`);
  }
  if (topoOrder(graph).length !== graph.nodes.length) problems.push('The graph has a cycle.');
  problems.push(...shapeProblems(graph).map((p) => p.message));
  return problems;
}

export type RunSource = { snapshot: Graph; nodes: Record<string, NodeRunState>; rendered?: RenderedRun; attachments?: RunAttachment[]; scopes?: Record<string, Scope> };

function sameSet(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x) => b.includes(x));
}

/** The arrows into `id` as `from:label` (no label: `from:`), so a changed yes/no label is another input. */
function incoming(graph: Graph, id: string): string[] {
  return graph.edges.filter((e) => e.to === id).map((e) => `${e.from}:${e.label ?? ''}`);
}

/** Every node that reaches `id` by following edges backward. */
export function ancestors(graph: Graph, id: string): Set<string> {
  const seen = new Set<string>();
  const stack = [id];
  while (stack.length) {
    const current = stack.pop()!;
    for (const prev of upstream(graph, current)) {
      if (!seen.has(prev)) {
        seen.add(prev);
        stack.push(prev);
      }
    }
  }
  return seen;
}

/** The closest step before `id` (fewest edges; the first listed on a tie) that `test` accepts. */
function nearestAncestor(graph: Graph, id: string, test: (n: GraphNode) => boolean): string | undefined {
  const seen = new Set<string>([id]);
  let level = [id];
  while (level.length) {
    const next: string[] = [];
    for (const current of level) {
      for (const prev of upstream(graph, current)) {
        if (seen.has(prev)) continue;
        seen.add(prev);
        next.push(prev);
      }
    }
    const hit = next.find((p) => test(graph.nodes.find((n) => n.id === p)!));
    if (hit) return hit;
    level = next;
  }
  return undefined;
}

const didSucceed = (state: NodeRunState | undefined): boolean => state?.status === 'succeeded' || state?.status === 'reused';
/** A step's kept result is current: it succeeded (or was reused) and nothing marked it stale. */
const isCurrent = (state: NodeRunState | undefined): boolean => didSucceed(state) && !state?.stale;

/**
 * The steps whose own definition or inputs differ from `source` (spec §7.2), not their descendants: a missing step, another kind or
 * rendered prompt/command (the template, for runs recorded before rendering), for an agent step another description, browser setting, model,
 * effort, access, workspace or attachments (its own, then the graph's: another list, or, given `attachments` (the files now)
 * and a source that recorded them, another file under a name), or another set of upstream steps. On expanded graphs
 * (`scopes`: the new run's sub-graph steps; `source.scopes`: the source run's), a step inside a sub-graph compares its
 * scope graph's attachments, and a step whose sub-graph now uses another graph, or a sub-graph step with another graph
 * or other values, changed (sub-graphs spec §4.5).
 */
export function changedSinceSource(graph: Graph, source: RunSource, rendered?: RenderedRun, attachments?: readonly RunAttachment[], scopes?: Record<string, Scope>): Set<string> {
  const changed = new Set<string>();
  for (const n of graph.nodes) {
    const scope = scopeOf(scopes, n.id);
    const prevScope = scopeOf(source.scopes, n.id);
    /** The graph-level attachments a step gets: its sub-graph's, else the run's graph's. */
    const graphFiles = (s: Scope | undefined, g: Graph) => (s ? (s.attachments ?? []) : (g.attachments ?? []));
    const prev = source.snapshot.nodes.find((p) => p.id === n.id);
    const before = source.rendered?.nodes[n.id];
    const now = rendered?.nodes[n.id];
    const sameText =
      before !== undefined && now !== undefined
        ? before === now
        : (prev?.prompt ?? '') === (n.prompt ?? '') && (prev?.command ?? '') === (n.command ?? '');
    const sameDescription = n.kind !== 'agent' || (prev?.description ?? '').trim() === (n.description ?? '').trim();
    // What a step may do and where it runs are part of its definition (spec §3.1, §3.1a).
    const sameAccess = n.kind !== 'agent' || (prev?.access ?? 'write') === (n.access ?? 'write');
    const samePlace = (prev?.workspace ?? '') === (n.workspace ?? '');
    // The model and effort a step runs with are part of its definition: comparing models is one of their uses (spec §1).
    const sameModel = n.kind !== 'agent' || ((prev?.model ? stepModelText(prev.model) : '') === (n.model ? stepModelText(n.model) : '') && (prev?.effort ?? '') === (n.effort ?? ''));
    // An agent step gets its own attachments, then the graph's (spec §6b.5): another list is another input.
    const files = (step: GraphNode | undefined, list: readonly string[]) => JSON.stringify([...(step?.attachments ?? []), ...list]);
    // A file is known by its scope graph's folder and its name: two graphs may each have a `brief.md`.
    const hashOf = (list: readonly RunAttachment[] | undefined, name: string) => list?.find((a) => a.name === name && a.graphId === scope?.graphId)?.sha256 ?? '';
    const sameContent = !attachments || !source.attachments || [...(n.attachments ?? []), ...graphFiles(scope, graph)].every((name) => hashOf(attachments, name) === hashOf(source.attachments, name));
    const sameFiles = n.kind !== 'agent' || (files(prev, graphFiles(prevScope, source.snapshot)) === files(n, graphFiles(scope, graph)) && sameContent);
    // Whether it may use the browser is part of its definition too (browser spec §2.2).
    const sameBrowser = n.kind !== 'agent' || (prev?.browser === true) === (n.browser === true);
    // Which graph a step's sub-graph uses, and a sub-graph step's own graph and values (sub-graphs spec §2.3).
    const sameScope = (prevScope?.graphId ?? '') === (scope?.graphId ?? '');
    const sameSubgraph = n.kind !== 'graph' || ((prev?.graph ?? '') === (n.graph ?? '') && valuesText(prev?.values) === valuesText(n.values));
    const sameDefinition = !!prev && prev.kind === n.kind && sameText && sameDescription && sameAccess && samePlace && sameModel && sameFiles && sameBrowser && sameScope && sameSubgraph;
    // The label on an arrow into a step (yes or no out of a condition) is part of its inputs.
    const sameInputs = !!prev && sameSet(upstream(graph, n.id), upstream(source.snapshot, n.id)) && sameSet(incoming(graph, n.id), incoming(source.snapshot, n.id));
    if (!sameDefinition || !sameInputs) changed.add(n.id);
  }
  return changed;
}

/**
 * Node ids a re-run may reuse from `source` (spec §7.2). A node executes again when it is
 * `fromNodeId`, did not succeed last time or is marked stale, changed (see changedSinceSource), has a workspace or is a stop step
 * — and so does everything downstream of it. With no `fromNodeId` this is a retry from where the run stopped. Everything else is reused.
 * Re-run from a sub-graph step starts at its inner first steps (sub-graphs spec §4.5).
 */
export function reusableNodeIds(graph: Graph, source: RunSource, fromNodeId?: string, rendered?: RenderedRun, attachments?: readonly RunAttachment[], scopes?: Record<string, Scope>): Set<string> {
  const seeds = new Set<string>(fromNodeId ? fromSeeds(graph, fromNodeId) : []);
  const changed = changedSinceSource(graph, source, rendered, attachments, scopes);
  for (const n of graph.nodes) {
    // A step with a workspace is never reused: its files lived in that run's own worktree (spec §4.3a).
    // A stop step always runs again: only running it halts the run, so a reused one would let a retry read succeeded.
    if (!isCurrent(source.nodes[n.id]) || changed.has(n.id) || n.workspace || n.kind === 'stop') seeds.add(n.id);
  }
  const execute = new Set(seeds);
  for (const id of seeds) for (const d of descendants(graph, id)) execute.add(d);
  return new Set(graph.nodes.map((n) => n.id).filter((id) => !execute.has(id)));
}

/** Where Re-run from `id` starts: the step, or a sub-graph step's inner first steps, which run it all (sub-graphs spec §4.5). */
function fromSeeds(graph: Graph, id: string): string[] {
  const firsts = graph.nodes.find((n) => n.id === id)?.kind === 'graph' ? subgraphFirstSteps(graph, id) : [];
  return firsts.length ? firsts : [id];
}

/** A stale marker before the run that makes it is known. */
export type StaleReason = Omit<StaleMark, 'runId'>;

/** Why a kept result is stale, as the logs and the run report say it after "Stale: ". `ownId`: the step the mark is on. */
export function staleNote(mark: Pick<StaleMark, 'reason' | 'nodeId'>, ownId?: string): string {
  // A step built on an edited step says so; only the edited step itself was edited.
  const builtOn = mark.reason === 'upstream' || (mark.nodeId !== undefined && ownId !== undefined && mark.nodeId !== ownId);
  return builtOn ? (mark.nodeId ? `built on an older result of ${mark.nodeId}` : 'built on an older result') : 'edited since this result';
}

export type OnlyRunPlan =
  | { ok: true; reuse: Set<string>; notRun: Set<string>; stale: Map<string, StaleReason> }
  | { ok: false; error: string };

/**
 * What `Run only` does (retry options): `nodeId` runs, alone. Every other step that succeeded (or was reused) is reused,
 * workspace or not; one that didn't is not run. A reused step is marked stale when it follows `nodeId` (`upstream`) or was
 * edited since (`edited`), and a step following a stale one is stale for the same reason; a mark it already carries stays.
 * Refused unless every ancestor of `nodeId` has a current result: it succeeded, isn't stale and is unchanged. Also refused for a
 * step in a workspace when an ancestor shares it: the new worktree starts from HEAD, without the changes that ancestor made.
 * Run only a sub-graph step runs it and every step inside it; the ancestor rule applies to the steps that fed it (sub-graphs spec §4.5).
 */
export function onlyRunPlan(graph: Graph, source: RunSource, nodeId: string, rendered?: RenderedRun, attachments?: readonly RunAttachment[], scopes?: Record<string, Scope>): OnlyRunPlan {
  const target = graph.nodes.find((n) => n.id === nodeId);
  if (!target) return { ok: false, error: `node ${nodeId} does not exist` };
  const changed = changedSinceSource(graph, source, rendered, attachments, scopes);
  const order = topoOrder(graph);
  /** What runs: the step, and for a sub-graph step everything inside it. */
  const group = new Set([nodeId, ...(target.kind === 'graph' ? innerStepIds(graph, nodeId) : [])]);
  const before = new Set([...group].flatMap((id) => [...ancestors(graph, id)]).filter((id) => !group.has(id)));
  const place = workspaceOf(graph.nodes.find((n) => n.id === nodeId)!);
  const sharing = place === null ? undefined : nearestAncestor(graph, nodeId, (a) => workspaceOf(a) === place);
  if (sharing) return { ok: false, error: `Run only ${nodeId} needs the changes ${sharing} made in its workspace: use Re-run from ${sharing} instead.` };
  const blocking = order.find((id) => before.has(id) && (!isCurrent(source.nodes[id]) || changed.has(id)));
  if (blocking) return { ok: false, error: `Run only ${nodeId} needs ${blocking} to have a current result: run it first.` };

  const after = descendants(graph, nodeId);
  const reuse = new Set<string>();
  const notRun = new Set<string>();
  const stale = new Map<string, StaleReason>();
  /** Every reused step's mark, the new and the one it already carried: what the steps after it inherit. */
  const marked = new Map<string, StaleReason>();
  for (const id of order) {
    if (group.has(id)) continue;
    const state = source.nodes[id];
    if (!didSucceed(state)) {
      notRun.add(id);
      continue;
    }
    reuse.add(id);
    if (state?.stale) {
      marked.set(id, { reason: state.stale.reason, ...(state.stale.nodeId && { nodeId: state.stale.nodeId }) });
      continue;
    }
    const inherited = upstream(graph, id).map((p) => marked.get(p)).find((m) => m !== undefined);
    const mark: StaleReason | undefined = after.has(id) ? { reason: 'upstream', nodeId } : changed.has(id) ? { reason: 'edited', nodeId: id } : inherited;
    if (mark) {
      stale.set(id, mark);
      marked.set(id, mark);
    }
  }
  return { ok: true, reuse, notRun, stale };
}

/** Why a start request's mode, step and source run don't fit together, or null. Absent mode: the older requests, always allowed. */
export function runModeProblem(mode: RunMode | undefined, fromNodeId: string | undefined, sourceRunId: string | undefined): string | null {
  if (!mode) return null;
  if (!sourceRunId) return mode === 'from' ? 'There is no previous run to re-run from.' : 'There is no previous run to retry.';
  if (mode === 'resume' && fromNodeId) return 'Retry from where it stopped takes no step.';
  if (mode === 'only' && !fromNodeId) return 'Run only needs a step.';
  if (mode === 'from' && !fromNodeId) return 'Re-run from needs a step.';
  return null;
}
