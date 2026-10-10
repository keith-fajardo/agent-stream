import { z } from 'zod';
import { edgeId, nodeIdProblem, seqOf } from './graph';
import type { GraphDoc } from './graphDoc';
import type { Actor, Graph, GraphNode, Position } from './types';

/** One step's bookkeeping in the side file. */
export type GraphMetaNode = { position?: Position; createdBy?: Actor; updatedBy?: Actor; updatedAt?: string };
/** `<id>.meta.json` as read: what wasn't valid is left out (Markdown graph files spec §3.2). */
export type GraphMeta = { nodeSeq: number; updatedAt?: string; nodes: Map<string, GraphMetaNode> };
/** `<id>.meta.json` as written. */
export type GraphMetaFile = {
  version: 1;
  nodeSeq: number;
  updatedAt: string;
  nodes: Record<string, { position?: Position; createdBy: Actor; updatedBy: Actor; updatedAt: string }>;
};

const actor = z.enum(['user', 'agent']);
const metaNodeSchema = z.object({
  position: z.object({ x: z.number(), y: z.number() }).optional().catch(undefined),
  createdBy: actor.optional().catch(undefined),
  updatedBy: actor.optional().catch(undefined),
  updatedAt: z.string().optional().catch(undefined),
});
const metaSchema = z.object({
  version: z.literal(1),
  // int() refuses a number that isn't a safe integer, so a counter too large to count on exactly reads as 0.
  nodeSeq: z.number().int().optional().catch(undefined),
  updatedAt: z.string().optional().catch(undefined),
  nodes: z.record(z.string(), metaNodeSchema.nullable().catch(null)).optional().catch(undefined),
});

/** The side file's text read leniently: undefined when it is missing or not a version 1 side file; a bad entry is left out. */
export function parseGraphMeta(text: string | undefined): GraphMeta | undefined {
  if (text === undefined) return undefined;
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return undefined;
  }
  const r = metaSchema.safeParse(json);
  if (!r.success) return undefined;
  const nodes = new Map<string, GraphMetaNode>();
  for (const [id, entry] of Object.entries(r.data.nodes ?? {})) {
    if (!entry || nodeIdProblem(id)) continue;
    nodes.set(id, {
      ...(entry.position && { position: entry.position }),
      ...(entry.createdBy && { createdBy: entry.createdBy }),
      ...(entry.updatedBy && { updatedBy: entry.updatedBy }),
      ...(entry.updatedAt && { updatedAt: entry.updatedAt }),
    });
  }
  return { nodeSeq: Math.max(0, r.data.nodeSeq ?? 0), ...(r.data.updatedAt && { updatedAt: r.data.updatedAt }), nodes };
}

/** What the side file holds for `graph`: positions, who made and last changed each step and when, and the id counter. */
export function metaOf(graph: Graph): GraphMetaFile {
  return {
    version: 1,
    nodeSeq: graph.nodeSeq,
    updatedAt: graph.updatedAt,
    nodes: Object.fromEntries(
      graph.nodes.map((n) => [n.id, { ...(n.position && { position: n.position }), createdBy: n.createdBy, updatedBy: n.updatedBy, updatedAt: n.updatedAt }]),
    ),
  };
}

export function serializeGraphMeta(graph: Graph): string {
  return `${JSON.stringify(metaOf(graph), null, 2)}\n`;
}

/** `graph` with the side file's bookkeeping, and the defaults where it has none: no position, `user`, `now` (spec §3.2, §6.4). */
export function withMeta(graph: Graph, meta: GraphMeta | undefined, now: string): Graph {
  const nodes = graph.nodes.map((n): GraphNode => {
    const m = meta?.nodes.get(n.id);
    const { position: _position, ...rest } = n;
    return { ...rest, ...(m?.position && { position: m.position }), createdBy: m?.createdBy ?? 'user', updatedBy: m?.updatedBy ?? 'user', updatedAt: m?.updatedAt ?? now };
  });
  return { ...graph, nodes, nodeSeq: Math.max(graph.nodeSeq, meta?.nodeSeq ?? 0), updatedAt: meta?.updatedAt ?? now };
}

/**
 * The in-memory graph from a parsed Markdown file and its side file (spec §3.3). A step without an id gets
 * n<nodeSeq + 1>, and `nodeSeq` advances, so ids are never reused. `nodeSeq` is at least the highest n<number> in use.
 */
export function graphFromDoc(doc: GraphDoc, meta: GraphMeta | undefined, id: string, now: string): Graph {
  let seq = Math.max(meta?.nodeSeq ?? 0, ...doc.steps.map((s) => (s.id ? seqOf(s.id) : 0)));
  const nodes = doc.steps.map((s): GraphNode => {
    const { line: _line, id: stepId, ...content } = s;
    return { id: stepId ?? `n${++seq}`, ...content, createdBy: 'user', updatedBy: 'user', updatedAt: now };
  });
  const graph: Graph = {
    id,
    name: doc.name,
    goal: doc.goal,
    instructions: doc.instructions,
    variables: doc.variables.map(({ name, description }) => ({ name, description })),
    ...(doc.attachments?.names.length && { attachments: [...doc.attachments.names] }),
    nodes,
    edges: doc.edges.map(({ from, to, label }) => ({ id: edgeId(from, to), from, to, ...(label && { label }) })),
    nodeSeq: seq,
    updatedAt: now,
  };
  return withMeta(graph, meta, now);
}
