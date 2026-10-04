import { z } from 'zod';
import { COMMAND_ALWAYS_WRITES, workspaceNameProblem } from './access';
import { legacyNodeIdProblem, topoOrder } from './graph';
import { MAX_VARIABLE_VALUE_CHARS, variableNameProblem } from './variables';
import { EFFORT_LEVELS, type ClientMessage, type Graph, type GraphResult, type WebviewHostMessage } from './types';

const position = z.object({ x: z.number(), y: z.number() });
const actor = z.enum(['user', 'agent']);
const nodeKind = z.enum(['agent', 'command']);
const access = z.enum(['read', 'write']);
const timeoutSec = z.number().positive();
const description = z.string().max(2000).optional();

const graphNodeSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  title: z.string(),
  kind: nodeKind,
  description,
  prompt: z.string().optional(),
  command: z.string().optional(),
  timeoutSec: timeoutSec.optional(),
  access: access.optional(),
  workspace: z.string().optional(),
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
  updatedAt: z.string().default(''),
});

export function parseGraph(json: unknown): GraphResult {
  const r = graphSchema.safeParse(json);
  if (!r.success) return { ok: false, error: z.prettifyError(r.error) };
  const graph = r.data as Graph;
  const ids = new Set<string>();
  for (const n of graph.nodes) {
    const idProblem = legacyNodeIdProblem(n.id);
    if (idProblem) return { ok: false, error: idProblem };
    if (ids.has(n.id)) return { ok: false, error: `duplicate node id ${n.id}` };
    ids.add(n.id);
    if (n.access === 'read' && n.kind === 'command') return { ok: false, error: `${n.id}: ${COMMAND_ALWAYS_WRITES}` };
    const workspaceProblem = n.workspace === undefined ? null : workspaceNameProblem(n.workspace);
    if (workspaceProblem) return { ok: false, error: `${n.id}: ${workspaceProblem}` };
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
  description,
  prompt: z.string().optional(),
  command: z.string().optional(),
  timeoutSec: timeoutSec.optional(),
  access: access.optional(),
  workspace: z.string().optional(),
  position: position.optional(),
});

const nodePatch = z.object({
  title: z.string().optional(),
  kind: nodeKind.optional(),
  description,
  prompt: z.string().optional(),
  command: z.string().optional(),
  timeoutSec: timeoutSec.optional(),
  access: access.optional(),
  workspace: z.string().optional(),
});

const changeTarget = z.discriminatedUnion('kind', [z.object({ kind: z.literal('node'), id: z.string() }), z.object({ kind: z.literal('edge'), id: z.string() }), z.object({ kind: z.literal('all') })]);

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
  z.object({ type: z.literal('acceptChange'), target: changeTarget }),
  z.object({ type: z.literal('revertChange'), target: changeTarget }),
]);

const refineNodeIds = z.array(z.string()).min(1).max(50);

const clientMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('openGraph'), graphId: z.string() }),
  z.object({ type: z.literal('createGraph'), name: z.string().min(1) }),
  z.object({ type: z.literal('op'), graphId: z.string(), op: opSchema }),
  z.object({ type: z.literal('openChat'), graphId: z.string(), sessionId: z.string() }),
  z.object({ type: z.literal('chat'), graphId: z.string(), sessionId: z.string(), text: z.string().min(1) }),
  z.object({ type: z.literal('refineSteps'), graphId: z.string(), sessionId: z.string(), nodeIds: refineNodeIds }),
  z.object({ type: z.literal('splitStep'), graphId: z.string(), sessionId: z.string(), nodeId: z.string() }),
  z.object({ type: z.literal('newChat'), graphId: z.string(), sessionId: z.string() }),
  z.object({ type: z.literal('stopPlanner'), graphId: z.string(), sessionId: z.string() }),
  z.object({ type: z.literal('setPlannerModel'), graphId: z.string(), sessionId: z.string(), model: z.string().min(1).max(200).optional(), effort: z.enum(EFFORT_LEVELS).optional() }),
  z.object({ type: z.literal('startRun'), graphId: z.string(), reviewed: z.string(), fromNodeId: z.string().optional(), sourceRunId: z.string().optional(), sequential: z.boolean().optional() }),
  z.object({ type: z.literal('inspectCheckout') }),
  z.object({ type: z.literal('previewRun'), graphId: z.string(), fromNodeId: z.string().optional(), sourceRunId: z.string().optional(), requestId: z.string().max(64).optional() }),
  z.object({ type: z.literal('setVariableValue'), graphId: z.string(), name: z.string(), value: z.string().max(MAX_VARIABLE_VALUE_CHARS) }),
  z.object({ type: z.literal('stopRun'), runId: z.string() }),
  z.object({ type: z.literal('selectRun'), runId: z.string() }),
  z.object({ type: z.literal('getNodeLogs'), runId: z.string(), nodeId: z.string() }),
  z.object({ type: z.literal('exportRunReport'), graphId: z.string(), runId: z.string() }),
  z.object({ type: z.literal('decide'), approvalId: z.string(), decision: z.enum(['approve', 'deny']), note: z.string().optional() }),
]);

const hostCommand = z.enum(['newGraph', 'openGraph', 'importGraph', 'exportGraph', 'renameGraph', 'duplicateGraph', 'deleteGraph', 'showSidebar', 'focusChat', 'openGraphMarkdown']);
const webviewHostSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready') }),
  z.object({ type: z.literal('opened'), graphId: z.string() }),
  z.object({ type: z.literal('host'), command: hostCommand }),
  z.object({ type: z.literal('setMinimap'), value: z.boolean() }),
  z.object({ type: z.literal('chatCommand'), command: z.enum(['switchSession', 'newChat']) }),
  z.object({ type: z.literal('draftState'), dirty: z.boolean() }),
  z.object({ type: z.literal('refineSteps'), nodeIds: refineNodeIds }),
  z.object({ type: z.literal('splitStep'), nodeId: z.string() }),
  z.object({ type: z.literal('exportRunReport'), runId: z.string() }),
  z.object({ type: z.literal('setUpParallelTickets') }),
  z.object({ type: z.literal('openExternal'), url: z.string().max(4096) }),
]);

/** Validates what a graph tab posts: an engine message, or one of the tab's own messages for the extension. */
export function parseWebviewMessage(
  value: unknown,
): { ok: true; kind: 'engine'; msg: ClientMessage } | { ok: true; kind: 'host'; msg: WebviewHostMessage } | { ok: false; error: string } {
  const engine = clientMessageSchema.safeParse(value);
  if (engine.success) return { ok: true, kind: 'engine', msg: engine.data as ClientMessage };
  const host = webviewHostSchema.safeParse(value);
  if (host.success) return { ok: true, kind: 'host', msg: host.data as WebviewHostMessage };
  return { ok: false, error: z.prettifyError(engine.error) };
}
