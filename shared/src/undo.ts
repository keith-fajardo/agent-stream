import { diffToOps } from './diffToOps';
import type { GraphDoc } from './graphDoc';
import type { Graph, Op } from './types';

/** The most undo steps a tab keeps per graph (spec §6a.2). */
export const MAX_UNDO = 50;
export const TIDY_LABEL = 'tidied the layout';
export const MARKDOWN_SAVE_LABEL = 'saved the Markdown';
/** The longest label a tab may send with a batch of edits. */
export const MAX_UNDO_LABEL_CHARS = 200;

/** Toasts (spec §6a.2). */
export const NOTHING_TO_UNDO = 'Nothing to undo.';
export const UNDO_CHANGED = "Can't undo: the graph changed since (by the planner, a run, the file or another tab).";
export const undoneMessage = (label: string) => `Undid ${label}.`;
export const undoFileErrors = (graphId: string) => `Can't undo: ${graphId}.md has errors. Fix the file first.`;

/** JSON with object keys sorted, so two graphs built in different ways compare equal. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined);
    return `{${entries
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
const byKey = <T>(key: (x: T) => string) => (a: T, b: T) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);

/**
 * What undo compares (spec §6a.2): the graph's content and where its steps are, ignoring order (undo re-adds a deleted step
 * at the end), the name, and bookkeeping (who changed what, when, the id counter).
 */
export function undoState(g: Graph): string {
  return stable({
    goal: g.goal,
    instructions: g.instructions,
    variables: [...g.variables].sort(byKey((v) => v.name)),
    nodes: [...g.nodes].sort(byKey((n) => n.id)).map(({ createdBy: _c, updatedBy: _u, updatedAt: _a, ...n }) => n),
    edges: g.edges.map((e) => `${e.from}->${e.to}`).sort(),
  });
}

/** A graph as its Markdown file would state it, for diffToOps. */
export function graphAsDoc(g: Graph): GraphDoc {
  return {
    name: g.name,
    goal: g.goal,
    instructions: g.instructions,
    variables: g.variables.map((v) => ({ name: v.name, description: v.description, line: 1 })),
    steps: g.nodes.map(({ id, title, kind, access, workspace, timeoutSec, model, effort, description, prompt, command }) => ({
      id,
      title,
      kind,
      ...(access === 'read' && { access }),
      ...(workspace && { workspace }),
      ...(timeoutSec !== undefined && { timeoutSec }),
      ...(model && { model }),
      ...(effort && { effort }),
      ...(description && { description }),
      ...(prompt && { prompt }),
      ...(command && { command }),
      line: 1,
    })),
    edges: g.edges.map((e) => ({ from: e.from, to: e.to, line: 1 })),
  };
}

/**
 * The operations that take `current` back to `before` (spec §6a.2): diffToOps, then a move for every step whose place
 * differs (null puts a step back on the automatic layout). A variable rename is undone by renaming it back, so its saved
 * value and the steps that use it follow.
 */
export function undoOps(current: Graph, before: Graph, forward: readonly Op[] = []): Op[] {
  const only = forward.length === 1 ? forward[0] : undefined;
  if (only?.type === 'renameVariable') return [{ type: 'renameVariable', name: only.newName, newName: only.name }];
  const ops = diffToOps(current, graphAsDoc(before));
  const now = new Map(current.nodes.map((n) => [n.id, n.position]));
  for (const n of before.nodes) {
    const at = now.get(n.id);
    if (stable(at ?? null) !== stable(n.position ?? null)) ops.push({ type: 'moveNode', id: n.id, position: n.position ?? null });
  }
  return ops;
}

/** The label of one edit, as Edit › Undo and its toast name it. Reviews of agent changes are never undo steps. */
export function undoLabel(op: Op): string | undefined {
  switch (op.type) {
    case 'addNode':
      return op.node.id ? `added ${op.node.id}` : 'added a step';
    case 'updateNode':
      return `saved ${op.id}`;
    case 'deleteNode':
      return `deleted ${op.id}`;
    case 'connect':
      return `connected ${op.from} → ${op.to}`;
    case 'disconnect':
      return `disconnected ${op.from} → ${op.to}`;
    case 'moveNode':
      return `moved ${op.id}`;
    case 'setGoal':
      return 'edited the goal';
    case 'setInstructions':
      return 'edited the instructions';
    case 'addVariable':
      return `added variable ${op.name}`;
    case 'renameVariable':
      return `renamed variable ${op.name}`;
    case 'setVariableDescription':
      return `edited variable ${op.name}`;
    case 'deleteVariable':
      return `deleted variable ${op.name}`;
    case 'acceptChange':
    case 'revertChange':
      return undefined;
  }
}

/** One drag: `moved n3`, `moved 2 steps`. */
export const movedLabel = (ids: readonly string[]): string => (ids.length === 1 ? `moved ${ids[0]}` : `moved ${ids.length} steps`);

/** One delete of a selection: `deleted n3`, `deleted 3 steps`, `deleted the connection n1 → n2`, `deleted 2 steps and 1 connection`. */
export function deletedLabel(nodeIds: readonly string[], edges: readonly { from: string; to: string }[]): string {
  const steps = nodeIds.length === 1 ? nodeIds[0] : `${nodeIds.length} steps`;
  const links = edges.length === 1 ? '1 connection' : `${edges.length} connections`;
  if (!edges.length) return `deleted ${steps}`;
  if (!nodeIds.length) return edges.length === 1 ? `deleted the connection ${edges[0].from} → ${edges[0].to}` : `deleted ${links}`;
  return `deleted ${steps} and ${links}`;
}
