import { z } from 'zod';
import { topoOrder } from './graph';
import { variableNameProblem } from './variables';
import type { ClientMessage, Graph, GraphResult } from './types';

const position = z.object({ x: z.number(), y: z.number() });
const actor = z.enum(['user', 'agent']);
const nodeKind = z.enum(['agent', 'command']);
const timeoutSec = z.number().positive();

const graphNodeSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  title: z.string(),
  kind: nodeKind,
  prompt: z.string().optional(),
  command: z.string().optional(),
  timeoutSec: timeoutSec.optional(),
  position: position.optional(),
  createdBy: actor.default('user'),
  updatedBy: actor.default('user'),
  updatedAt: z.string().default(''),
});

const graphSchema = z.object({
  id: z.string(),
  name: z.string(),
  goal: z.string().default(''),
  instructions: z.string().default(''),
  variables: z.array(z.object({ name: z.string(), description: z.string().default('') })).default([]),
  nodes: z.array(graphNodeSchema).default([]),
  edges: z.array(z.object({ id: z.string(), from: z.string(), to: z.string() })).default([]),
  nodeSeq: z.number().int().nonnegative().default(0),
  plannerSessionId: z.string().optional(),
  plannerOpCursor: z.number().int().nonnegative().optional(),
  updatedAt: z.string().default(''),
});

export function parseGraph(json: unknown): GraphResult {
  const r = graphSchema.safeParse(json);
  if (!r.success) return { ok: false, error: z.prettifyError(r.error) };
  const graph = r.data as Graph;
  const ids = new Set<string>();
  for (const n of graph.nodes) {
    if (ids.has(n.id)) return { ok: false, error: `duplicate node id ${n.id}` };
    ids.add(n.id);
  }
  const seen = new Set<string>();
  for (const e of graph.edges) {
    if (!ids.has(e.from) || !ids.has(e.to)) return { ok: false, error: `edge ${e.from} -> ${e.to} refers to a missing node` };
    const key = `${e.from}->${e.to}`;
    if (seen.has(key)) return { ok: false, error: `duplicate edge ${e.from} -> ${e.to}` };
    seen.add(key);
  }
  for (let i = 0; i < graph.variables.length; i++) {
    const problem = variableNameProblem(graph.variables[i].name, graph.variables.slice(0, i));
    if (problem) return { ok: false, error: `invalid variable: ${problem}` };
  }
  if (topoOrder(graph).length !== graph.nodes.length) return { ok: false, error: 'the graph has a cycle' };
  return { ok: true, graph };
}

const newNode = z.object({
  id: z.string().optional(),
  title: z.string(),
  kind: nodeKind,
  prompt: z.string().optional(),
  command: z.string().optional(),
  timeoutSec: timeoutSec.optional(),
  position: position.optional(),
});

const nodePatch = z.object({
  title: z.string().optional(),
  kind: nodeKind.optional(),
  prompt: z.string().optional(),
  command: z.string().optional(),
  timeoutSec: timeoutSec.optional(),
});

const opSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('addNode'), node: newNode }),
  z.object({ type: z.literal('updateNode'), id: z.string(), patch: nodePatch }),
  z.object({ type: z.literal('deleteNode'), id: z.string() }),
  z.object({ type: z.literal('connect'), from: z.string(), to: z.string() }),
  z.object({ type: z.literal('disconnect'), from: z.string(), to: z.string() }),
  z.object({ type: z.literal('setGoal'), goal: z.string() }),
  z.object({ type: z.literal('setInstructions'), instructions: z.string() }),
  z.object({ type: z.literal('addVariable'), name: z.string(), description: z.string().optional() }),
  z.object({ type: z.literal('renameVariable'), name: z.string(), newName: z.string() }),
  z.object({ type: z.literal('setVariableDescription'), name: z.string(), description: z.string() }),
  z.object({ type: z.literal('deleteVariable'), name: z.string() }),
  z.object({ type: z.literal('moveNode'), id: z.string(), position }),
]);

const clientMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('openGraph'), graphId: z.string() }),
  z.object({ type: z.literal('createGraph'), name: z.string().min(1) }),
  z.object({ type: z.literal('op'), graphId: z.string(), op: opSchema }),
  z.object({ type: z.literal('chat'), graphId: z.string(), text: z.string().min(1) }),
  z.object({ type: z.literal('startRun'), graphId: z.string(), reviewed: z.string(), fromNodeId: z.string().optional(), sourceRunId: z.string().optional() }),
  z.object({ type: z.literal('stopRun'), runId: z.string() }),
  z.object({ type: z.literal('selectRun'), runId: z.string() }),
  z.object({ type: z.literal('getNodeLogs'), runId: z.string(), nodeId: z.string() }),
  z.object({ type: z.literal('decide'), approvalId: z.string(), decision: z.enum(['approve', 'deny']), note: z.string().optional() }),
]);

export function parseClientMessage(raw: string): { ok: true; msg: ClientMessage } | { ok: false; error: string } {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'message is not valid JSON' };
  }
  const r = clientMessageSchema.safeParse(json);
  return r.success ? { ok: true, msg: r.data as ClientMessage } : { ok: false, error: z.prettifyError(r.error) };
}
