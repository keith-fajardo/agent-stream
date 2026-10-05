import { COMMAND_ALWAYS_WRITES, workspaceNameProblem } from './access';
import { ONLY_AGENT_STEPS_MODEL, stepModelProblem, stepModelText } from './stepModels';
import { variableNameProblem } from './variables';
import type { Actor, Graph, GraphNode, GraphResult, NodePatch, NodeRunState, Op, RenderedRun } from './types';

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
      const modelProblem = stepModelProblem(op.node.model, op.node.effort);
      if (modelProblem) return fail(modelProblem);
      if ((op.node.model || op.node.effort) && op.node.kind === 'command') return fail(ONLY_AGENT_STEPS_MODEL);
      const workspace = op.node.workspace?.trim() || undefined;
      const workspaceProblem = workspace === undefined ? null : workspaceNameProblem(workspace);
      if (workspaceProblem) return fail(workspaceProblem);
      const node = definedOnly<GraphNode>({
        id,
        title,
        kind: op.node.kind,
        description: op.node.description,
        prompt: op.node.prompt,
        command: op.node.command,
        timeoutSec: op.node.timeoutSec,
        access: op.node.access === 'read' ? 'read' : undefined,
        workspace,
        model: op.node.model && { provider: op.node.model.provider, id: op.node.model.id },
        effort: op.node.effort,
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
      const { access, workspace, timeoutSec, model, effort, ...patch } = definedOnly<NodePatch>(op.patch);
      if (patch.title !== undefined) {
        patch.title = patch.title.trim();
        if (!patch.title) return fail('a node needs a title');
      }
      if ((patch.description?.length ?? 0) > MAX_DESCRIPTION_CHARS) return fail(DESCRIPTION_TOO_LONG);
      const kind = patch.kind ?? node.kind;
      if (access === 'read' && kind === 'command') return fail(COMMAND_ALWAYS_WRITES);
      const modelProblem = stepModelProblem(model ?? undefined, effort ?? undefined);
      if (modelProblem) return fail(modelProblem);
      if ((model || effort) && kind === 'command') return fail(ONLY_AGENT_STEPS_MODEL);
      let nextWorkspace = node.workspace;
      if (workspace !== undefined) {
        const trimmed = workspace.trim();
        const problem = trimmed === '' ? null : workspaceNameProblem(trimmed);
        if (problem) return fail(problem);
        nextWorkspace = trimmed || undefined;
      }
      // A command step can always change files, so becoming one drops `access` (spec §3.1).
      const nextAccess = kind === 'command' ? undefined : (access ?? node.access) === 'read' ? 'read' : undefined;
      // 0 clears the timeout; a missing one keeps it.
      const nextTimeout = timeoutSec === undefined ? node.timeoutSec : timeoutSec > 0 ? timeoutSec : undefined;
      // Only agent steps have a model or effort, so becoming a command step drops both (spec §2.1); null clears one.
      const nextModel = kind === 'command' || model === null ? undefined : (model ?? node.model);
      const nextEffort = kind === 'command' || effort === null ? undefined : (effort ?? node.effort);
      const { access: _access, workspace: _workspace, timeoutSec: _timeoutSec, model: _model, effort: _effort, ...base } = node;
      const updated: GraphNode = {
        ...base,
        ...patch,
        ...(nextTimeout !== undefined && { timeoutSec: nextTimeout }),
        ...(nextAccess && { access: nextAccess }),
        ...(nextWorkspace && { workspace: nextWorkspace }),
        ...(nextModel && { model: { provider: nextModel.provider, id: nextModel.id } }),
        ...(nextEffort && { effort: nextEffort }),
        updatedBy: by,
        updatedAt: now,
      };
      return done({ nodes: graph.nodes.map((n) => (n.id === op.id ? updated : n)) });
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
      if (wouldCreateCycle(graph, op.from, op.to)) return fail(`connecting ${op.from} -> ${op.to} would create a cycle`);
      return done({ edges: [...graph.edges, { id: edgeId(op.from, op.to), from: op.from, to: op.to }] });
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
        if (prompt === n.prompt && command === n.command) return n;
        return definedOnly<GraphNode>({ ...n, prompt, command, updatedBy: by, updatedAt: now }) as GraphNode;
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
    nodes: g.nodes.map((n) => [n.id, n.kind, n.title, n.description ?? '', n.prompt ?? '', n.command ?? '', n.timeoutSec ?? null, n.access ?? 'write', n.workspace ?? '', n.model ? stepModelText(n.model) : '', n.effort ?? '']),
    edges: g.edges.map((e) => e.id).sort(),
  });
}

export function validateRunnable(graph: Graph): string[] {
  const problems: string[] = [];
  if (graph.nodes.length === 0) problems.push('The graph has no nodes.');
  for (const n of graph.nodes) {
    if (n.kind === 'agent' && !n.prompt?.trim()) problems.push(`${n.id} "${n.title}": an agent node needs a prompt.`);
    if (n.kind === 'command' && !n.command?.trim()) problems.push(`${n.id} "${n.title}": a command node needs a command.`);
  }
  if (topoOrder(graph).length !== graph.nodes.length) problems.push('The graph has a cycle.');
  return problems;
}

export type RunSource = { snapshot: Graph; nodes: Record<string, NodeRunState>; rendered?: RenderedRun };

function sameSet(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x) => b.includes(x));
}

/**
 * Node ids a re-run may reuse from `source` (spec §7.2). A node executes again when it is
 * `fromNodeId`, did not succeed last time, changed kind or rendered prompt/command (the template,
 * for runs recorded before rendering), for an agent step changed its own description, model or effort, changed access or workspace, has a workspace, or gained/lost an upstream edge — and so does everything
 * downstream of it. Everything else is reused.
 */
export function reusableNodeIds(graph: Graph, source: RunSource, fromNodeId?: string, rendered?: RenderedRun): Set<string> {
  const seeds = new Set<string>(fromNodeId ? [fromNodeId] : []);
  for (const n of graph.nodes) {
    const prev = source.snapshot.nodes.find((p) => p.id === n.id);
    const state = source.nodes[n.id];
    const succeeded = state?.status === 'succeeded' || state?.status === 'reused';
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
    const sameDefinition = !!prev && prev.kind === n.kind && sameText && sameDescription && sameAccess && samePlace && sameModel;
    const sameInputs = !!prev && sameSet(upstream(graph, n.id), upstream(source.snapshot, n.id));
    // A step with a workspace is never reused: its files lived in that run's own worktree (spec §4.3a).
    if (!succeeded || !sameDefinition || !sameInputs || n.workspace) seeds.add(n.id);
  }
  const execute = new Set(seeds);
  for (const id of seeds) for (const d of descendants(graph, id)) execute.add(d);
  return new Set(graph.nodes.map((n) => n.id).filter((id) => !execute.has(id)));
}
