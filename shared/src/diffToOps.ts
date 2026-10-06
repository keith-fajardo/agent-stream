import type { DocStep, GraphDoc } from './graphDoc';
import { stepModelText } from './stepModels';
import type { Graph, GraphNode, NewNodeInput, NodePatch, Op, StepModel } from './types';

const modelText = (m: StepModel | undefined) => (m ? stepModelText(m) : '');

const edgeKey = (e: { from: string; to: string }) => `${e.from}->${e.to}`;

function newNode(step: DocStep): NewNodeInput {
  const { line: _line, ...node } = step;
  return node;
}

/** Only the fields that differ; '' clears a description, prompt, command or workspace, 0 a timeout, and null a model or effort. */
function patchOf(node: GraphNode, step: DocStep): NodePatch {
  const patch: NodePatch = {};
  if (node.title !== step.title) patch.title = step.title;
  if (node.kind !== step.kind) patch.kind = step.kind;
  if ((node.description ?? '') !== (step.description ?? '')) patch.description = step.description ?? '';
  if (step.kind === 'agent' && (node.kind !== 'agent' || (node.prompt ?? '') !== (step.prompt ?? ''))) patch.prompt = step.prompt ?? '';
  if (step.kind === 'command' && (node.kind !== 'command' || (node.command ?? '') !== (step.command ?? ''))) patch.command = step.command ?? '';
  if ((node.access === 'read') !== (step.access === 'read')) patch.access = step.access ?? 'write';
  if ((node.workspace ?? '') !== (step.workspace ?? '')) patch.workspace = step.workspace ?? '';
  if ((node.timeoutSec ?? 0) !== (step.timeoutSec ?? 0)) patch.timeoutSec = step.timeoutSec ?? 0;
  // A step that becomes a command step loses both without a patch (applyOp drops them).
  if (step.kind === 'agent' && modelText(node.model) !== modelText(step.model)) patch.model = step.model ?? null;
  if (step.kind === 'agent' && (node.effort ?? '') !== (step.effort ?? '')) patch.effort = step.effort ?? null;
  if (step.kind === 'agent' && JSON.stringify(node.attachments ?? []) !== JSON.stringify(step.attachments ?? [])) patch.attachments = step.attachments ?? [];
  // Removing the line turns the browser off.
  if (step.kind === 'agent' && (node.browser === true) !== (step.browser === true)) patch.browser = step.browser === true;
  return patch;
}

/**
 * The operations that turn `current` into what the Markdown file says (Markdown graph files spec §6.3), matching steps
 * by id, in this order: disconnect, deleteNode, addNode, updateNode, connect, setGoal and setInstructions, the graph's
 * attachments, then variables. `current` is in canonical form (the store keeps it so). The name is not an operation: the store renames.
 */
export function diffToOps(current: Graph, doc: GraphDoc): Op[] {
  const ops: Op[] = [];
  const docIds = new Set(doc.steps.flatMap((s) => (s.id ? [s.id] : [])));
  const nodes = new Map(current.nodes.map((n) => [n.id, n]));
  const docEdges = new Set(doc.edges.map(edgeKey));
  const currentEdges = new Set(current.edges.map(edgeKey));
  for (const e of current.edges) if (!docEdges.has(edgeKey(e))) ops.push({ type: 'disconnect', from: e.from, to: e.to });
  for (const n of current.nodes) if (!docIds.has(n.id)) ops.push({ type: 'deleteNode', id: n.id });
  for (const s of doc.steps) if (!s.id || !nodes.has(s.id)) ops.push({ type: 'addNode', node: newNode(s) });
  for (const s of doc.steps) {
    const node = s.id ? nodes.get(s.id) : undefined;
    if (!node) continue;
    const patch = patchOf(node, s);
    if (Object.keys(patch).length) ops.push({ type: 'updateNode', id: node.id, patch });
  }
  for (const e of doc.edges) if (!currentEdges.has(edgeKey(e))) ops.push({ type: 'connect', from: e.from, to: e.to });
  if (doc.goal !== current.goal) ops.push({ type: 'setGoal', goal: doc.goal });
  if (doc.instructions !== current.instructions) ops.push({ type: 'setInstructions', instructions: doc.instructions });
  const attachments = doc.attachments?.names ?? [];
  if (JSON.stringify(attachments) !== JSON.stringify(current.attachments ?? [])) ops.push({ type: 'setGraphAttachments', names: attachments });
  const docVariables = new Map(doc.variables.map((v) => [v.name, v]));
  const variables = new Map(current.variables.map((v) => [v.name, v]));
  for (const v of current.variables) if (!docVariables.has(v.name)) ops.push({ type: 'deleteVariable', name: v.name });
  for (const v of doc.variables) {
    const before = variables.get(v.name);
    if (!before) ops.push({ type: 'addVariable', name: v.name, ...(v.description && { description: v.description }) });
    else if (before.description !== v.description) ops.push({ type: 'setVariableDescription', name: v.name, description: v.description });
  }
  return ops;
}

/** The file line an operation came from, for an error message: its step, arrow or variable; 1 when there is none. */
export function opLine(doc: GraphDoc, op: Op): number {
  switch (op.type) {
    case 'addNode':
      return (op.node.id ? doc.steps.find((s) => s.id === op.node.id) : doc.steps.find((s) => !s.id && s.title === op.node.title))?.line ?? 1;
    case 'updateNode':
      return doc.steps.find((s) => s.id === op.id)?.line ?? 1;
    case 'connect':
      return doc.edges.find((e) => e.from === op.from && e.to === op.to)?.line ?? 1;
    case 'addVariable':
    case 'setVariableDescription':
      return doc.variables.find((v) => v.name === op.name)?.line ?? 1;
    case 'setGraphAttachments':
      return doc.attachments?.line ?? 1;
    default:
      return 1;
  }
}
