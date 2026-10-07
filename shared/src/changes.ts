import { stepModelText } from './stepModels';
import { valuesText } from './subgraphStep';
import type { AgentChange, ChangedField, Graph, GraphNode } from './types';

const FIELDS: ChangedField[] = ['title', 'description', 'kind', 'prompt', 'command', 'timeoutSec', 'access', 'workspace', 'model', 'effort', 'attachments', 'browser', 'graph', 'values'];

/** A step field as text, for comparing and for the Changes tab: '' when absent, a model as `claude/opus`, attachments one per line. */
export function changedFieldText(node: GraphNode | undefined, field: ChangedField): string {
  if (field === 'model') return node?.model ? stepModelText(node.model) : '';
  if (field === 'attachments') return (node?.attachments ?? []).join('\n');
  if (field === 'browser') return node?.browser ? 'on' : '';
  if (field === 'values') return valuesText(node?.values);
  const v = node?.[field];
  return v === undefined || v === null ? '' : String(v);
}

export function changedFields(before: GraphNode, after: GraphNode): ChangedField[] {
  return FIELDS.filter((f) => changedFieldText(before, f) !== changedFieldText(after, f));
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
