import { edgeId, seqOf } from './graph';
import type { FlowEdge } from './graphFlow';
import type { Graph, GraphFileError, GraphNode, NodeKind } from './types';

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
  description?: string;
  prompt?: string;
  command?: string;
  /** The heading's line, for messages. */
  line: number;
};
export type DocVariable = { name: string; description: string; line: number };
/** A graph's meaning as its Markdown file states it (Markdown graph files spec §3.1). Positions and bookkeeping are in the side file. */
export type GraphDoc = { name: string; goal: string; instructions: string; variables: DocVariable[]; steps: DocStep[]; edges: FlowEdge[] };
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
 * step's kind (a prompt or a command), absent when empty; `access` only for a read-only agent step; whole-second
 * timeouts; `nodeSeq` at least the highest n<number> id.
 */
export function canonicalGraph(graph: Graph): Graph {
  const nodes = graph.nodes.map(canonicalNode);
  return {
    ...graph,
    name: oneLine(graph.name),
    goal: normText(graph.goal).trim(),
    instructions: normText(graph.instructions).trim(),
    variables: graph.variables.map((v) => ({ name: v.name, description: oneLine(v.description) })),
    nodes,
    edges: graph.edges.map((e) => ({ id: edgeId(e.from, e.to), from: e.from, to: e.to })),
    nodeSeq: Math.max(graph.nodeSeq, ...nodes.map((n) => seqOf(n.id))),
  };
}

function canonicalNode(node: GraphNode): GraphNode {
  const { prompt, command, description, timeoutSec, access, workspace, ...rest } = node;
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
  };
}
