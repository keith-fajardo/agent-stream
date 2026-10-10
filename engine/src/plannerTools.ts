import { z, type ZodRawShape } from 'zod';
import { CLI_DEFAULT_MODEL, derivedStatus, EFFORT_LEVELS, groupedOrder, parseStepModel, scopeOf, staleNote, stepModelText, wouldCreateGraphLoop, type ChangeSource, type CheckoutInfo, type EffortLevel, type Graph, type LeaseHolder, type ModelChoice, type NodePatch, type Op, type ProviderId, type RunMode, type StepModel } from '@agent-stream/shared';
import type { GraphStore } from './graphStore';
import { truncateHead, truncateTail } from './prompt';
import { ALL_HAVE_WORKTREES_ADVICE, MISSING_WORKTREES_ADVICE, OUTSIDE_GIT_ADVICE } from './policy';
import type { GraphTool, ToolReply } from './providers/types';
import type { RunStore } from './runStore';
import { ticketSlugs } from './worktrees';

/** Where the folder's graphs work and who holds its write lease. */
export type CheckoutSource = () => Promise<{ info: CheckoutInfo; lease?: LeaseHolder }>;

export type PlannerToolDeps = {
  graphStore: GraphStore;
  runStore: RunStore;
  graphId: string;
  /** Which agent the edits are recorded as: the planner in its work session. */
  source: ChangeSource;
  /** Opens the run confirmation dialog in the graph's tab; returns an error message or null. */
  requestRun: (fromNodeId?: string, mode?: RunMode) => string | null;
  /** checkout_info and check_tickets read it. */
  checkout: CheckoutSource;
  /** list_models reads it: the current provider and its models ([] when they can't be listed). */
  models?: () => Promise<{ provider: ProviderId; models: ModelChoice[] }>;
};

export const reply = (text: string, isError = false): ToolReply => (isError ? { text, isError: true } : { text });

/** One graph tool: its input is checked against `schema` before `handler` sees it. */
export function defineTool<S extends ZodRawShape>(name: string, description: string, schema: S, handler: (args: z.infer<z.ZodObject<S>>) => Promise<ToolReply>): GraphTool {
  const parser = z.object(schema);
  return {
    name,
    description,
    schema,
    async run(input) {
      const parsed = parser.safeParse(input ?? {});
      return parsed.success ? handler(parsed.data) : reply(z.prettifyError(parsed.error), true);
    },
  };
}

const kind = z.enum(['agent', 'command', 'graph', 'condition', 'stop']);
/** A sub-graph step's values: inner variable name → value, a template that may use this graph's variables (sub-graphs spec §7). */
const subgraphValues = z.record(z.string(), z.string());
const access = z.enum(['read', 'write']);
const effort = z.enum(EFFORT_LEVELS);
const RUN_EXCERPT_CHARS = 2000;
/** list_models when the provider can't list its models. */
export const NO_MODEL_LIST = "The current provider's models can't be listed right now; leave model on Default.";

/** The planner's `model` text ("" = Default) as a step model, or why it can't be one (step model spec §5). */
function modelArg(text: string | undefined): { ok: true; model?: StepModel | null } | { ok: false; error: string } {
  if (text === undefined) return { ok: true };
  if (text === '') return { ok: true, model: null };
  const r = parseStepModel(text);
  return r.ok ? { ok: true, model: r.model } : r;
}

/** `graphName`: a sub-graph step's inner graph name, by its id (undefined when it can't be read). */
export function summarizeGraph(graph: Graph, graphName: (id: string) => string | undefined = () => undefined) {
  return {
    goal: graph.goal,
    instructions: graph.instructions,
    variables: graph.variables.map(({ name, description }) => ({ name, description })),
    // Names only, as context: the planner never gets their contents, and can't add or remove them (step model spec §6b.1).
    ...(graph.attachments?.length && { attachments: graph.attachments }),
    nodes: graph.nodes.map(({ id, title, kind: k, description, prompt, command, timeoutSec, access: a, workspace, model, effort: e, attachments, browser, graph: inner, values, failFast, createdBy, updatedBy }) => ({
      id, title, kind: k, description, prompt, command, timeoutSec,
      ...(a === 'read' && { access: 'read' as const }),
      ...(workspace && { workspace }),
      ...(model && { model: stepModelText(model) }),
      ...(e && { effort: e }),
      ...(attachments?.length && { attachments }),
      ...(browser && { browser: true }),
      // A sub-graph step: the graph it runs, by id and name, and its values (sub-graphs spec §7).
      ...(inner && { graph: inner, graphName: graphName(inner) ?? null }),
      ...(values && { values }),
      ...(failFast && { failFast: true }),
      createdBy, updatedBy,
    })),
    edges: graph.edges.map((e) => `${e.from} -> ${e.to}${e.label ? ` (${e.label})` : ''}`),
  };
}

/** The planner edits the graph only through these tools; every change is tagged `agent`, from `d.source`. */
export function graphTools(d: PlannerToolDeps): GraphTool[] {
  const apply = (op: Op) => d.graphStore.apply(d.graphId, op, 'agent', d.source);
  const outcome = (r: { ok: true } | { ok: false; error: string }, success: string) => (r.ok ? reply(success) : reply(r.error, true));
  const graphName = (id: string) => {
    const r = d.graphStore.lookup(id);
    return r.ok ? r.graph.name : undefined;
  };

  return [
    defineTool('get_graph', 'Return the current workflow graph: goal, nodes (id, title, kind, prompt or command, an agent step\'s own model and effort, a sub-graph step\'s graph and values) and edges.', {}, async () =>
      reply(JSON.stringify(summarizeGraph(d.graphStore.get(d.graphId), graphName), null, 2)),
    ),
    defineTool(
      'list_models',
      'Read-only. List the current provider\'s models as JSON: each model\'s id, name, effort levels, and which one is the default. Give a step one of them as model "<provider>/<id>" in add_node or update_node.',
      {},
      async () => {
        const listed = await d.models?.().catch(() => undefined);
        if (!listed || listed.models.length === 0) return reply(NO_MODEL_LIST);
        const isDefault = (m: ModelChoice) => !!m.isDefault || (listed.provider === 'claude' && m.value === CLI_DEFAULT_MODEL);
        const models = listed.models.map((m) => ({ id: m.value, name: m.label, efforts: m.efforts, ...(isDefault(m) && { default: true }) }));
        return reply(JSON.stringify({ provider: listed.provider, models }, null, 2));
      },
    ),
    defineTool(
      'add_node',
      'Add a step. kind "agent" runs a separate AI agent with `prompt`; kind "command" runs the exact shell `command` in the project root; kind "graph" runs another graph of this folder (`graph`, an id from list_graphs) as one step, with `values` for its variables (each a template that may use this graph\'s variables; leave one out to have it asked when the run starts). kind "condition" reads the verdict of the step before it and routes the run along its yes or no arrow; give it exactly two arrows out, made with connect and label "yes" or "no". A condition has no prompt of its own: the question goes in the step before the condition, and that step\'s prompt must say what yes and no mean. kind "stop" ends the run when reached; `failFast` true also cancels the steps still running. Condition and stop steps take no prompt, command, timeoutSec, access, workspace, model, effort or browser. `after` lists ids of steps this one depends on; an edge is created from each. `description` is one plain-language sentence for people saying what the step does and why. `access` "read" marks an agent step that only reads and reports: it can\'t edit files or run commands. Command steps can always change files. `workspace` names a variant workspace (lowercase letters, digits, - and _): steps with the same workspace run in their own Git worktree for each run, for A/B tests; leave it out for this checkout. `model` ("<provider>/<id>", an id from list_models) and `effort` give an agent step its own model and effort; leave them out for the run\'s. `browser` true lets an agent step use the Agent Stream browser, with the user\'s logins (clicks and typing ask the user first): set it only for steps that need websites.',
      {
        kind,
        title: z.string(),
        description: z.string().max(2000).optional(),
        prompt: z.string().optional(),
        command: z.string().optional(),
        timeoutSec: z.number().positive().optional(),
        after: z.array(z.string()).optional(),
        access: access.optional(),
        workspace: z.string().optional(),
        model: z.string().optional(),
        effort: effort.optional(),
        browser: z.boolean().optional(),
        graph: z.string().optional(),
        values: subgraphValues.optional(),
        failFast: z.boolean().optional(),
      },
      async (a) => {
        const m = modelArg(a.model || undefined);
        if (!m.ok) return reply(m.error, true);
        const r = apply({ type: 'addNode', node: { title: a.title, kind: a.kind, description: a.description, prompt: a.prompt, command: a.command, timeoutSec: a.timeoutSec, access: a.access, workspace: a.workspace, ...(m.model && { model: m.model }), ...(a.effort && { effort: a.effort }), ...(a.browser !== undefined && { browser: a.browser }), ...(a.graph !== undefined && { graph: a.graph }), ...(a.values && { values: a.values }), ...(a.failFast !== undefined && { failFast: a.failFast }) } });
        if (!r.ok) return reply(r.error, true);
        const id = r.graph.nodes[r.graph.nodes.length - 1].id;
        const errors: string[] = [];
        for (const from of a.after ?? []) {
          const c = apply({ type: 'connect', from, to: id });
          if (!c.ok) errors.push(c.error);
        }
        return errors.length ? reply(`Added ${id}, but some edges failed:\n${errors.join('\n')}`, true) : reply(`Added ${id}.`);
      },
    ),
    defineTool(
      'update_node',
      'Change fields of a step. Only the fields you pass change. `description` is one plain-language sentence for people saying what the step does and why. `access` "read" or "write"; `workspace` "" puts the step back in this checkout. `model` ("<provider>/<id>", an id from list_models) and `effort` set an agent step\'s own model and effort; "" puts either back on the run\'s. `browser` true or false switches the Agent Stream browser on or off for an agent step. A sub-graph step (kind "graph") takes `graph` and `values`; `values` replaces all of them. A stop step (kind "stop") takes `failFast` true or false.',
      {
        id: z.string(),
        title: z.string().optional(),
        kind: kind.optional(),
        description: z.string().max(2000).optional(),
        prompt: z.string().optional(),
        command: z.string().optional(),
        timeoutSec: z.number().positive().optional(),
        access: access.optional(),
        workspace: z.string().optional(),
        model: z.string().optional(),
        effort: z.union([effort, z.literal('')]).optional(),
        browser: z.boolean().optional(),
        graph: z.string().optional(),
        values: subgraphValues.optional(),
        failFast: z.boolean().optional(),
      },
      async ({ id, model, effort: e, ...rest }) => {
        const m = modelArg(model);
        if (!m.ok) return reply(m.error, true);
        const patch: NodePatch = { ...rest, ...(m.model !== undefined && { model: m.model }), ...(e !== undefined && { effort: e === '' ? null : (e as EffortLevel) }) };
        return outcome(apply({ type: 'updateNode', id, patch }), `Updated ${id}.`);
      },
    ),
    defineTool('delete_node', 'Delete a step and its edges.', { id: z.string() }, async ({ id }) =>
      outcome(apply({ type: 'deleteNode', id }), `Deleted ${id}.`),
    ),
    defineTool('connect', 'Make `to` run after `from` and receive its output. `label` "yes" or "no" marks an arrow out of a condition step: `to` runs only when the verdict matches.', { from: z.string(), to: z.string(), label: z.enum(['yes', 'no']).optional() }, async ({ from, to, label }) =>
      outcome(apply({ type: 'connect', from, to, ...(label && { label }) }), `Connected ${from} -> ${to}${label ? ` (${label})` : ''}.`),
    ),
    defineTool('disconnect', 'Remove the edge from `from` to `to`.', { from: z.string(), to: z.string() }, async ({ from, to }) =>
      outcome(apply({ type: 'disconnect', from, to }), `Disconnected ${from} -> ${to}.`),
    ),
    defineTool('set_goal', 'Set the workflow goal: shared context every agent step receives.', { goal: z.string() }, async ({ goal }) =>
      outcome(apply({ type: 'setGoal', goal }), 'Goal updated.'),
    ),
    defineTool(
      'set_instructions',
      'Set the instructions & context: longer guidance every agent step receives after the goal (targets, conventions, what never to touch).',
      { instructions: z.string() },
      async ({ instructions }) => outcome(apply({ type: 'setInstructions', instructions }), 'Instructions updated.'),
    ),
    defineTool(
      'set_variable',
      'Define a variable steps can use as {{ name }} (Jinja), or change its description. The user sets its value on their machine; you never see values.',
      { name: z.string(), description: z.string().optional() },
      async ({ name, description }) => {
        const exists = d.graphStore.get(d.graphId).variables.some((v) => v.name === name);
        if (exists) return outcome(apply({ type: 'setVariableDescription', name, description: description ?? '' }), `Updated variable ${name}.`);
        return outcome(apply({ type: 'addVariable', name, description }), `Added variable ${name}. Ask the user to set its value (Variables menu).`);
      },
    ),
    defineTool('delete_variable', 'Remove a variable definition. Steps still using it fail the run check until updated.', { name: z.string() }, async ({ name }) =>
      outcome(apply({ type: 'deleteVariable', name }), `Deleted variable ${name}.`),
    ),
    defineTool(
      'request_run',
      "Ask the user to start a run. This opens a confirmation dialog in Agent Stream; the user decides whether to start it. With no mode and no fromNodeId it asks for a fresh run. mode 'resume' retries from where the latest run stopped: it runs the steps that didn't finish and everything after them, and reuses the rest. mode 'from' (or just fromNodeId) re-runs that step and everything after it, reusing the latest run's results for the rest. mode 'only' runs just that step, reusing the latest run for everything else; steps after it keep their old results, marked stale. 'from' and 'only' need fromNodeId; 'resume' takes none. All three need an earlier run.",
      { mode: z.enum(['resume', 'from', 'only']).optional(), fromNodeId: z.string().optional() },
      async ({ mode, fromNodeId }) => {
        const error = d.requestRun(fromNodeId, mode);
        return error ? reply(error, true) : reply('Asked the user to confirm the run in the UI. Call get_run later to see results.');
      },
    ),
    defineTool('get_run', 'Show the latest run (or runId): status of each step, errors, and output excerpts.', { runId: z.string().optional() }, async ({ runId }) => {
      const id = runId ?? d.runStore.list(d.graphId)[0]?.id;
      const meta = id ? d.runStore.get(id) : undefined;
      if (!meta || meta.graphId !== d.graphId) return runId ? reply(`Run ${runId} not found.`, true) : reply('No runs yet.');
      const lines = [`Run ${meta.id}: ${meta.status}`];
      // Run order; steps inside a sub-graph indented under it, which shows the status of everything in it (sub-graphs spec §7).
      for (const id of groupedOrder(meta.snapshot)) {
        const n = meta.snapshot.nodes.find((x) => x.id === id)!;
        const state = n.kind === 'graph' ? derivedStatus(meta, n.id) : meta.nodes[n.id];
        const output = d.runStore.readOutput(meta.id, n.id);
        const excerpt = n.kind === 'command' ? truncateTail(output, RUN_EXCERPT_CHARS) : truncateHead(output, RUN_EXCERPT_CHARS);
        const indent = '  '.repeat(scopeOf(meta.scopes, n.id)?.depth ?? 0);
        const sub = meta.scopes?.[n.id] ? ` (sub-graph "${meta.scopes[n.id].graphName}")` : '';
        lines.push(`\n${indent}## ${n.id} · ${n.title}${sub} — ${state?.status ?? 'unknown'}${state?.stale ? ` (stale: ${staleNote(state.stale, n.id)})` : ''}`);
        if (state?.error) lines.push(`error: ${state.error}`);
        if (excerpt.trim()) lines.push(`output:\n${excerpt}`);
      }
      return reply(lines.join('\n'));
    }),
    defineTool(
      'checkout_info',
      'Read-only. Return where this graph works, as JSON: the Git checkout (root, branch, HEAD, uncommitted changes, other worktrees) and the run that is changing files there, if any.',
      {},
      async () => {
        const { info, lease } = await d.checkout();
        return reply(JSON.stringify({ checkout: info, lease: lease ?? null }, null, 2));
      },
    ),
    defineTool(
      'check_tickets',
      'Read-only. Check whether each ticket already has its own Git worktree on branch feat/<slug>. Call it before planning work for several tickets.',
      { tickets: z.array(z.string()).min(1).max(20) },
      async ({ tickets }) => {
        const s = ticketSlugs(tickets);
        if (!s.ok) return reply(s.error, true);
        const { info } = await d.checkout();
        const rows = tickets.map((ticket, i) => {
          const branch = `feat/${s.slugs[i]}`;
          const worktree = info.git ? info.worktrees.find((w) => w.branch === branch)?.path : undefined;
          return { ticket, slug: s.slugs[i], branch, ...(worktree && { worktree }) };
        });
        const allHaveWorktrees = info.git && rows.every((r) => r.worktree);
        const advice = !info.git ? OUTSIDE_GIT_ADVICE : allHaveWorktrees ? ALL_HAVE_WORKTREES_ADVICE : MISSING_WORKTREES_ADVICE;
        return reply(JSON.stringify({ tickets: rows, allHaveWorktrees, advice }, null, 2));
      },
    ),
    defineTool(
      'list_graphs',
      "Read-only. List this folder's other graphs as JSON: each one's id, name, goal, variables (name and description), number of steps, and `loop`: true when using it here would put this graph inside itself. Use one as a step with add_node kind \"graph\".",
      {},
      async () => {
        const lookup = (id: string) => d.graphStore.lookup(id);
        const graphs = d.graphStore
          .list()
          .filter((g) => g.id !== d.graphId)
          .map((g) => {
            const r = lookup(g.id);
            if (!r.ok) return { id: g.id, name: g.name, error: r.error };
            return { id: g.id, name: r.graph.name, goal: r.graph.goal, variables: r.graph.variables.map(({ name, description }) => ({ name, description })), steps: r.graph.nodes.length, loop: wouldCreateGraphLoop(d.graphId, g.id, lookup) };
          });
        return reply(JSON.stringify(graphs, null, 2));
      },
    ),
  ];
}
