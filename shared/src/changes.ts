import type { AgentChange, ChangedField, Graph, GraphNode } from './types';

const FIELDS: ChangedField[] = ['title', 'description', 'kind', 'prompt', 'command', 'timeoutSec', 'access', 'workspace'];
const norm = (v: unknown) => (v === undefined || v === null ? '' : String(v));

export function changedFields(before: GraphNode, after: GraphNode): ChangedField[] {
  return FIELDS.filter((f) => norm(before[f]) !== norm(after[f]));
}

/** What agents changed since the user's accepted baseline (agent changes spec §3.3). Positions and authorship are not content. */
export function diffGraphs(baseline: Graph, graph: Graph): AgentChange[] {
  const out: AgentChange[] = [];
  const now = new Map(graph.nodes.map((n) => [n.id, n]));
  const before = new Map(baseline.nodes.map((n) => [n.id, n]));
  for (const b of baseline.nodes) {
    const n = now.get(b.id);
    if (!n) out.push({ kind: 'node', change: 'removed', id: b.id, title: b.title });
    else {
      const fields = changedFields(b, n);
      if (fields.length) out.push({ kind: 'node', change: 'changed', id: n.id, title: n.title, fields });
    }
  }
  for (const n of graph.nodes) if (!before.has(n.id)) out.push({ kind: 'node', change: 'added', id: n.id, title: n.title });
  const edgeKey = (e: { from: string; to: string }) => `${e.from}->${e.to}`;
  const nowEdges = new Set(graph.edges.map(edgeKey));
  const beforeEdges = new Set(baseline.edges.map(edgeKey));
  for (const e of baseline.edges) if (!nowEdges.has(edgeKey(e))) out.push({ kind: 'edge', change: 'removed', id: e.id, from: e.from, to: e.to });
  for (const e of graph.edges) if (!beforeEdges.has(edgeKey(e))) out.push({ kind: 'edge', change: 'added', id: e.id, from: e.from, to: e.to });
  return out;
}
