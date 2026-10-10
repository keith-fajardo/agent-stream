import { edgeId, seqOf } from './graph';
import { parseGraph } from './schemas';
import { MAX_IMPORT_CHARS, type EdgeLabel, type Graph, type GraphNode, type GraphResult, type VariableDef } from './types';

export const EXPORT_FORMAT = 'agent-stream/graph';
/** The format name written before the rename to Agent Stream; still accepted on import. */
const LEGACY_EXPORT_FORMAT = 'claude-stream/graph';
export const EXPORT_VERSION = 1;
// Defined in types.ts so the message schemas can bound text with it without importing this module back.
export { MAX_IMPORT_CHARS };

export type ExportedNode = Pick<GraphNode, 'id' | 'title' | 'kind' | 'description' | 'prompt' | 'command' | 'timeoutSec' | 'access' | 'workspace' | 'failFast' | 'position'>;
export type ExportFile = {
  format: typeof EXPORT_FORMAT;
  version: typeof EXPORT_VERSION;
  exportedAt: string;
  graph: { name: string; goal: string; instructions: string; variables: VariableDef[]; nodes: ExportedNode[]; edges: { from: string; to: string; label?: EdgeLabel }[] };
};

/** The shareable definition (spec §5): never values, authorship, planner state, chat, ops or runs. */
export function toExportFile(graph: Graph, now: string): ExportFile {
  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: now,
    graph: {
      name: graph.name,
      goal: graph.goal,
      instructions: graph.instructions,
      variables: graph.variables.map(({ name, description }) => ({ name, description })),
      // JSON round trip drops fields that are undefined.
      nodes: graph.nodes.map(({ id, title, kind, description, prompt, command, timeoutSec, access, workspace, failFast, position }) =>
        JSON.parse(JSON.stringify({ id, title, kind, description, prompt, command, timeoutSec, access, workspace, failFast, position })) as ExportedNode,
      ),
      edges: graph.edges.map(({ from, to, label }) => ({ from, to, ...(label && { label }) })),
    },
  };
}

/** Validates an export file and turns it into a new graph with `id`, authored by the user at `now`. */
export function parseExportFile(content: string, id: string, now: string): GraphResult {
  if (content.length > MAX_IMPORT_CHARS) return { ok: false, error: 'The file is larger than 1 MB.' };
  let json: unknown;
  try {
    json = JSON.parse(content);
  } catch {
    return { ok: false, error: 'The file is not valid JSON.' };
  }
  const head = (typeof json === 'object' && json !== null ? json : {}) as { format?: unknown; version?: unknown; graph?: unknown };
  if (head.format !== EXPORT_FORMAT && head.format !== LEGACY_EXPORT_FORMAT) return { ok: false, error: 'This is not an Agent Stream graph file.' };
  if (head.version !== EXPORT_VERSION) return { ok: false, error: `This file is version ${String(head.version)}; this Agent Stream reads version ${EXPORT_VERSION}.` };
  const g = (typeof head.graph === 'object' && head.graph !== null ? head.graph : {}) as Record<string, unknown>;
  const name = typeof g.name === 'string' ? g.name.trim() : '';
  if (!name) return { ok: false, error: 'The graph in this file has no name.' };
  const nodes = Array.isArray(g.nodes) ? g.nodes : [];
  const edges = Array.isArray(g.edges) ? g.edges : [];
  const r = parseGraph({
    id,
    name,
    goal: g.goal,
    instructions: g.instructions,
    variables: g.variables,
    nodes: nodes.map((n) => ({ ...(n as object), createdBy: 'user', updatedBy: 'user', updatedAt: now })),
    edges: edges.map((e) => {
      const { from, to, label } = e as { from?: unknown; to?: unknown; label?: unknown };
      return { id: edgeId(String(from), String(to)), from, to, ...(label !== undefined && { label }) };
    }),
    updatedAt: now,
  });
  if (!r.ok) return { ok: false, error: `The graph in this file is invalid: ${r.error}` };
  const nodeSeq = r.graph.nodes.reduce((max, n) => Math.max(max, seqOf(n.id)), 0);
  return { ok: true, graph: { ...r.graph, nodeSeq } };
}
