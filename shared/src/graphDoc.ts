import { edgeId, nodeIdProblem, seqOf } from './graph';
import type { FlowEdge } from './graphFlow';
import type { EffortLevel, Graph, GraphFileError, GraphNode, NodeKind, StepModel } from './types';

/** The longest timeout a step can have: Node's longest timer, in whole seconds. */
export const MAX_TIMEOUT_SEC = 2_147_483;
/** Between a step's id and its title in its heading: space, U+00B7, space. */
export const STEP_SEPARATOR = ' · ';

/** A step section of a graph's Markdown file. Empty text and a description are left out, as are `access: write` and defaults. */
export type DocStep = {
  /** Missing for a heading without an id: the store gives it the next n<number>. */
  id?: string;
  title: string;
  kind: NodeKind;
  access?: 'read';
  workspace?: string;
  timeoutSec?: number;
  /** Agent steps only. */
  model?: StepModel;
  effort?: EffortLevel;
  attachments?: string[];
  description?: string;
  prompt?: string;
  command?: string;
  /** The heading's line, for messages. */
  line: number;
};
export type DocVariable = { name: string; description: string; line: number };
/** The graph's "## Attachments" list, with the section's line for messages (step model spec §6b.3). */
export type DocAttachments = { names: string[]; line: number };
/** A graph's meaning as its Markdown file states it (Markdown graph files spec §3.1). Positions and bookkeeping are in the side file. */
export type GraphDoc = { name: string; goal: string; instructions: string; variables: DocVariable[]; attachments?: DocAttachments; steps: DocStep[]; edges: FlowEdge[] };
export type ParseGraphResult = { ok: true; doc: GraphDoc } | { ok: false; errors: GraphFileError[] };

/** CRLF and lone CR as LF. */
export const normText = (text: string): string => text.replace(/\r\n?/g, '\n');
/** Line breaks (and the spaces around them) as one space, trimmed: for headings, list items and the description line. */
export const oneLine = (text: string): string => text.replace(/[ \t]*[\r\n]+[ \t]*/g, ' ').trim();
/** A timeout as the file can hold it: whole seconds from 1 to MAX_TIMEOUT_SEC, rounded up. */
export const timeoutValue = (sec: number): number => Math.min(MAX_TIMEOUT_SEC, Math.max(1, Math.ceil(sec)));

/** `line 3: … (and 2 more)`: the first `max` problems, for a list item, a notice or an import error. */
export function formatFileErrors(errors: readonly GraphFileError[], max = 1): string {
  const shown = errors
    .slice(0, max)
    .map((e) => `line ${e.line}: ${e.message}`)
    .join(' ');
  const more = errors.length - max;
  return more > 0 ? `${shown} (and ${more} more)` : shown;
}

/**
 * The graph as its files hold it (spec §4): what loading its Markdown and side file gives back. Names, titles, variable
 * descriptions and step descriptions on one line; goal and instructions trimmed; LF line endings; only the text of the
 * step's kind (a prompt or a command), absent when empty; `access` only for a read-only agent step; a model and an
 * effort only on an agent step; whole-second timeouts; `nodeSeq` at least the highest n<number> id.
 */
export function canonicalGraph(graph: Graph): Graph {
  const nodes = graph.nodes.map(canonicalNode);
  return {
    ...graph,
    name: oneLine(graph.name),
    goal: normText(graph.goal).trim(),
    instructions: normText(graph.instructions).trim(),
    variables: graph.variables.map((v) => ({ name: v.name, description: oneLine(v.description) })),
    ...(graph.attachments?.length ? { attachments: [...graph.attachments] } : { attachments: undefined }),
    nodes,
    edges: graph.edges.map((e) => ({ id: edgeId(e.from, e.to), from: e.from, to: e.to })),
    nodeSeq: Math.max(graph.nodeSeq, ...nodes.map((n) => seqOf(n.id))),
  };
}

function canonicalNode(node: GraphNode): GraphNode {
  const { prompt, command, description, timeoutSec, access, workspace, model, effort, attachments, ...rest } = node;
  const text = normText((node.kind === 'agent' ? prompt : command) ?? '');
  const summary = oneLine(description ?? '');
  return {
    ...rest,
    title: oneLine(node.title),
    ...(summary && { description: summary }),
    ...(text && (node.kind === 'agent' ? { prompt: text } : { command: text })),
    ...(timeoutSec !== undefined && { timeoutSec: timeoutValue(timeoutSec) }),
    ...(node.kind === 'agent' && access === 'read' && { access: 'read' as const }),
    ...(workspace && { workspace }),
    ...(node.kind === 'agent' && model && { model: { provider: model.provider, id: model.id } }),
    ...(node.kind === 'agent' && effort && { effort }),
    ...(node.kind === 'agent' && attachments?.length && { attachments: [...attachments] }),
  };
}

/** A step id changed so the Markdown can hold it. */
export type StepRename = { from: string; to: string };
const UNTITLED_STEP = 'Untitled step';

/**
 * A graph from the old JSON format as the Markdown can hold it, so the written file reads back: an empty name becomes
 * the graph's id, an empty step title `Untitled step`, and a step id the strict rule refuses ("--", a trailing "-") is
 * renamed, its edges with it: runs of "-" collapsed and a trailing "-" dropped, or the next free n<number> when that
 * is empty, invalid or already used. `renames` are applied first (a baseline follows its graph); `reserved` ids are
 * never given.
 */
export function legacyGraphForMarkdown(
  graph: Graph,
  renames: ReadonlyMap<string, string> = new Map(),
  reserved: Iterable<string> = [],
): { graph: Graph; renamed: StepRename[] } {
  const taken = new Set([...reserved, ...renames.values(), ...graph.nodes.filter((n) => !renames.has(n.id) && !nodeIdProblem(n.id)).map((n) => n.id)]);
  let seq = Math.max(graph.nodeSeq, ...[...taken, ...graph.nodes.map((n) => n.id)].map(seqOf));
  const nextFree = () => {
    while (taken.has(`n${++seq}`));
    return `n${seq}`;
  };
  const to = new Map<string, string>();
  for (const { id } of graph.nodes) {
    const given = renames.get(id);
    if (given !== undefined) to.set(id, given);
    else if (nodeIdProblem(id)) {
      const short = id.replace(/-+/g, '-').replace(/-$/, '');
      const next = short && !nodeIdProblem(short) && !taken.has(short) ? short : nextFree();
      taken.add(next);
      to.set(id, next);
    }
  }
  const idOf = (id: string) => to.get(id) ?? id;
  const name = oneLine(graph.name) ? graph.name : graph.id;
  const untitled = graph.nodes.some((n) => !oneLine(n.title));
  if (!to.size && name === graph.name && !untitled) return { graph, renamed: [] };
  return {
    graph: {
      ...graph,
      name,
      nodes: graph.nodes.map((n) => ({ ...n, id: idOf(n.id), title: oneLine(n.title) ? n.title : UNTITLED_STEP })),
      edges: graph.edges.map((e) => ({ id: edgeId(idOf(e.from), idOf(e.to)), from: idOf(e.from), to: idOf(e.to) })),
      nodeSeq: Math.max(graph.nodeSeq, seq),
    },
    renamed: [...to].filter(([from, next]) => from !== next).map(([from, next]) => ({ from, to: next })),
  };
}
