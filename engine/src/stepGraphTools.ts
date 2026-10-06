import { z } from 'zod';
import { applyOp, changedFields, nextNodeId, validateRunnable, type ChangedField, type ChangeSource, type Decision, type Graph, type GraphNode, type Op, type RunMeta } from '@agent-stream/shared';
import { requestApproval, type ApprovalBroker } from './approvals';
import type { NodeContext } from './executors';
import type { GraphStore } from './graphStore';
import { defineTool, reply } from './plannerTools';
import { couldNotAsk, denialReason } from './providers/toolGate';
import type { GraphTool, ToolReply } from './providers/types';
import type { RunChange, Runner } from './runner';

export type StepGraphToolDeps = {
  /** The agent step calling the tools. */
  ctx: NodeContext;
  graphStore: GraphStore;
  runner: Runner;
  broker: ApprovalBroker;
  /** Fills in `{{ }}` in the node's prompt or command exactly as the run would, with the run preview's warnings. */
  render(graph: Graph, node: GraphNode): { ok: true; text: string; warnings?: string[] } | { ok: false; error: string };
  signal: AbortSignal;
};

const APPROVAL = "Every change waits for the user's approval; only steps that haven't started can be changed.";
const TOOL_NAME = 'Change graph';
const started = (id: string) => `${id} already started; the change was not applied.`;
/** A title is part of what runs (`# Your step: <title>`): one line (no Unicode line break either), so it can't smuggle in instructions. */
const MAX_TITLE_CHARS = 200;
const TITLE_PROBLEM = `a step title must be one line of at most ${MAX_TITLE_CHARS} characters`;
const titleProblem = (title: string | undefined) => (title !== undefined && (/[\r\n\u2028\u2029\u0085\v\f]/.test(title) || title.length > MAX_TITLE_CHARS) ? TITLE_PROBLEM : null);

/** Changed fields in the order a person reads them: the text that runs first. */
const FIELD_ORDER: ChangedField[] = ['prompt', 'command', 'title', 'description', 'kind', 'timeoutSec', 'access', 'workspace', 'model', 'effort', 'attachments', 'browser'];
const FIELD_NAMES: Record<ChangedField, string> = { prompt: 'prompt', command: 'command', title: 'title', description: 'description', kind: 'kind', timeoutSec: 'timeout', access: 'access', workspace: 'workspace', model: 'model', effort: 'effort', attachments: 'attachments', browser: 'browser' };
/** "command", "prompt and description", "prompt, title and description". */
const listed = (names: string[]) => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`);
const unique = (ids: string[]) => [...new Set(ids)];

/** A valid change, checked against the graph and the run: the ops for the graph and the node the run gets. */
type Proposal = { kind: 'add' | 'change'; graph: Graph; ops: Op[]; node: GraphNode; summary: string; change(text: string): RunChange };

/** `ops` applied in memory, as the graph store would: the first refusal (unknown id, cycle, ...) or the result. */
function simulate(graph: Graph, ops: Op[]): Graph | string {
  let g = graph;
  for (const op of ops) {
    const r = applyOp(g, op, 'agent', g.updatedAt);
    if (!r.ok) return r.error;
    g = r.graph;
  }
  return g;
}

/**
 * The graph tools an agent step gets during a run (agent changes spec §4): add a step, or change one that
 * hasn't started. Each valid call asks the user once, showing the exact text that would run, and only
 * an approval changes the run and the graph (as `agent`, from this step).
 */
export function createStepGraphTools(d: StepGraphToolDeps): GraphTool[] {
  const { ctx } = d;
  const source: ChangeSource = { kind: 'step', runId: ctx.runId, nodeId: ctx.node.id };

  /** The graph now and the run as it stands, or why the change can't be made. */
  function current(): { graph: Graph; run: RunMeta } | string {
    const run = d.runner.get(ctx.runId);
    if (!run) return 'The run was stopped.';
    const r = d.graphStore.load(run.graphId);
    return r.ok ? { graph: r.graph, run } : r.error;
  }
  /** In the graph and in this run. */
  const known = (s: { graph: Graph; run: RunMeta }, id: string) => s.graph.nodes.some((n) => n.id === id) && s.run.snapshot.nodes.some((n) => n.id === id);
  /** Only steps still queued can be changed or run before a new one; never the calling step. */
  const notStarted = (s: { run: RunMeta }, id: string) => id !== ctx.node.id && s.run.nodes[id]?.status === 'queued';

  type AddArgs = { title: string; kind: 'agent' | 'command'; prompt?: string; command?: string; description?: string; after: string[]; before: string[] };
  /** The new step's id is the next free one when this runs: at approval it is picked again, from the graph then. */
  function proposeAdd(a: AddArgs): Proposal | string {
    const s = current();
    if (typeof s === 'string') return s;
    const badTitle = titleProblem(a.title);
    if (badTitle) return badTitle;
    const after = unique(a.after);
    const before = unique(a.before);
    for (const ref of [...after, ...before]) if (!known(s, ref)) return `node ${ref} does not exist`;
    for (const ref of before) if (!notStarted(s, ref)) return started(ref);
    if (a.kind === 'command' && !a.command?.trim()) return 'a command step needs a command';
    if (a.kind === 'agent' && !a.prompt?.trim()) return 'an agent step needs a prompt';
    // Never an id the run already has, even one the graph no longer does.
    const newId = nextNodeId({ ...s.graph, nodes: [...s.graph.nodes, ...s.run.snapshot.nodes] });
    const text = a.kind === 'command' ? { command: a.command } : { prompt: a.prompt };
    const ops: Op[] = [
      { type: 'addNode', node: { id: newId, title: a.title, kind: a.kind, description: a.description, ...text } },
      ...after.map((from): Op => ({ type: 'connect', from, to: newId })),
      ...before.map((to): Op => ({ type: 'connect', from: newId, to })),
    ];
    const next = simulate(s.graph, ops);
    if (typeof next === 'string') return next;
    const node = next.nodes.find((n) => n.id === newId)!;
    const inRun = simulate({ ...s.run.snapshot, nodeSeq: Math.max(s.run.snapshot.nodeSeq, s.graph.nodeSeq) }, ops);
    if (typeof inRun === 'string') return inRun;
    const problems = validateRunnable(inRun);
    if (problems.length) return problems.join('\n');
    return {
      kind: 'add',
      graph: s.graph,
      ops,
      node,
      summary: `${ctx.node.id} wants to add step "${node.title}" after ${after.join(', ') || 'nothing'}, before ${before.join(', ') || 'nothing'}`,
      change: (rendered) => ({ kind: 'add', node, text: rendered, after, before }),
    };
  }

  type ChangeArgs = { id: string; title?: string; description?: string; prompt?: string; command?: string };
  function proposeChange(a: ChangeArgs): Proposal | string {
    const s = current();
    if (typeof s === 'string') return s;
    const { id, ...patch } = a;
    if (!known(s, id)) return `node ${id} does not exist`;
    if (!notStarted(s, id)) return started(id);
    const badTitle = titleProblem(patch.title);
    if (badTitle) return badTitle;
    const existing = s.graph.nodes.find((n) => n.id === id)!;
    if (existing.kind === 'command' && (patch.prompt !== undefined || (patch.command !== undefined && !patch.command.trim()))) return 'a command step needs a command';
    if (existing.kind === 'agent' && (patch.command !== undefined || (patch.prompt !== undefined && !patch.prompt.trim()))) return 'an agent step needs a prompt';
    const ops: Op[] = [{ type: 'updateNode', id, patch }];
    const next = simulate(s.graph, ops);
    if (typeof next === 'string') return next;
    const node = next.nodes.find((n) => n.id === id)!;
    const fields = changedFields(existing, node);
    if (fields.length === 0) return `Nothing to change in ${id}.`;
    const names = FIELD_ORDER.filter((f) => fields.includes(f)).map((f) => FIELD_NAMES[f]);
    return { kind: 'change', graph: s.graph, ops, node, summary: `${ctx.node.id} wants to change ${id}'s ${listed(names)}`, change: (rendered) => ({ kind: 'change', node, text: rendered }) };
  }

  /** One approval request, logged on the calling step like any other (createStepGate). */
  const ask = (input: unknown, summary: string, detail: string): Promise<Decision> =>
    requestApproval({ broker: d.broker, ctx, toolName: TOOL_NAME, input, card: { graphChange: { summary, detail } }, signal: d.signal });

  /** Check, fill in, ask; on approval check again, then change the run and the graph. Nothing changes otherwise. */
  async function propose(input: unknown, make: () => Proposal | string): Promise<ToolReply> {
    const p = make();
    if (typeof p === 'string') return reply(p, true);
    const r = d.render(p.graph, p.node);
    if (!r.ok) return reply(r.error, true);
    const description = p.node.description?.trim();
    const warnings = r.warnings?.length ? `\n\nWarnings:\n${r.warnings.map((w) => `- ${w}`).join('\n')}` : '';
    // Everything of the step that runs: its title (the agent's prompt starts with it), its text and description.
    const detail = `Title: ${p.node.title}\n\n${p.node.kind === 'command' ? 'Command' : 'Prompt'}:\n${r.text}${description ? `\n\nDescription: ${description}` : ''}${warnings}`;
    let decision: Decision;
    try {
      decision = await ask(input, p.summary, detail);
    } catch (error) {
      return reply(couldNotAsk(error), true);
    }
    if (decision.decision !== 'approve') return reply(denialReason(decision, d.signal.aborted || !d.runner.get(ctx.runId)), true);
    // The run moved on while the user decided: a target may have started.
    const again = make();
    if (typeof again === 'string') return reply(again, true);
    // The run gets exactly the approved node and text: a changed step as approved; an added step (built from
    // the same arguments) under the id that is free now. The run goes first: if it refuses, nothing changes.
    const amended = d.runner.amend(ctx.runId, (p.kind === 'add' ? again : p).change(r.text), ctx.node.id, p.summary);
    if (!amended.ok) return reply(amended.error, true);
    try {
      for (const op of again.ops) {
        const applied = d.graphStore.apply(ctx.graph.id, op, 'agent', source);
        if (!applied.ok) return reply(`The run was changed, but the graph could not be: ${applied.error}`, true);
      }
    } catch (error) {
      return reply(`The run was changed, but the graph could not be: ${error instanceof Error ? error.message : String(error)}`, true);
    }
    return reply(`Applied: ${p.summary}`);
  }

  const kind = z.enum(['agent', 'command']);
  return [
    defineTool(
      'add_step',
      `Add a step to this run. It runs after the \`after\` steps and before the \`before\` steps (ids). kind "agent" runs a separate AI agent with \`prompt\`; kind "command" runs the exact shell \`command\` in the project root. \`description\` is one plain-language sentence for people saying what the step does and why. ${APPROVAL}`,
      {
        title: z.string(),
        kind,
        prompt: z.string().optional(),
        command: z.string().optional(),
        description: z.string().optional(),
        after: z.array(z.string()),
        before: z.array(z.string()),
      },
      async (a) => propose(a, () => proposeAdd(a)),
    ),
    defineTool(
      'change_step',
      `Change a step of this run that hasn't started (not your own step). Only the fields you pass change. ${APPROVAL}`,
      {
        id: z.string(),
        title: z.string().optional(),
        description: z.string().optional(),
        prompt: z.string().optional(),
        command: z.string().optional(),
      },
      async (a) => propose(a, () => proposeChange(a)),
    ),
  ];
}
