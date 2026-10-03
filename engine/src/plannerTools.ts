import { z, type ZodRawShape } from 'zod';
import type { Graph, Op } from '@agent-stream/shared';
import type { GraphStore } from './graphStore';
import { truncateHead, truncateTail } from './prompt';
import type { GraphTool, ToolReply } from './providers/types';
import type { RunStore } from './runStore';

export type PlannerToolDeps = {
  graphStore: GraphStore;
  runStore: RunStore;
  graphId: string;
  /** Opens the run confirmation dialog in the graph's tab; returns an error message or null. */
  requestRun: (fromNodeId?: string) => string | null;
};

const reply = (text: string, isError = false): ToolReply => (isError ? { text, isError: true } : { text });

/** One graph tool: its input is checked against `schema` before `handler` sees it. */
function tool<S extends ZodRawShape>(name: string, description: string, schema: S, handler: (args: z.infer<z.ZodObject<S>>) => Promise<ToolReply>): GraphTool {
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

const kind = z.enum(['agent', 'command']);
const RUN_EXCERPT_CHARS = 2000;

export function summarizeGraph(graph: Graph) {
  return {
    goal: graph.goal,
    instructions: graph.instructions,
    variables: graph.variables.map(({ name, description }) => ({ name, description })),
    nodes: graph.nodes.map(({ id, title, kind: k, description, prompt, command, timeoutSec, createdBy, updatedBy }) => ({
      id, title, kind: k, description, prompt, command, timeoutSec, createdBy, updatedBy,
    })),
    edges: graph.edges.map((e) => `${e.from} -> ${e.to}`),
  };
}

/** The planner edits the graph only through these tools; every change is tagged `agent`. */
export function graphTools(d: PlannerToolDeps): GraphTool[] {
  const apply = (op: Op) => d.graphStore.apply(d.graphId, op, 'agent');
  const outcome = (r: { ok: true } | { ok: false; error: string }, success: string) => (r.ok ? reply(success) : reply(r.error, true));

  return [
    tool('get_graph', 'Return the current workflow graph: goal, nodes (id, title, kind, prompt or command) and edges.', {}, async () =>
      reply(JSON.stringify(summarizeGraph(d.graphStore.get(d.graphId)), null, 2)),
    ),
    tool(
      'add_node',
      'Add a step. kind "agent" runs a separate AI agent with `prompt`; kind "command" runs the exact shell `command` in the project root. `after` lists ids of steps this one depends on; an edge is created from each. `description` is one plain-language sentence for people saying what the step does and why.',
      {
        kind,
        title: z.string(),
        description: z.string().optional(),
        prompt: z.string().optional(),
        command: z.string().optional(),
        timeoutSec: z.number().positive().optional(),
        after: z.array(z.string()).optional(),
      },
      async (a) => {
        const r = apply({ type: 'addNode', node: { title: a.title, kind: a.kind, description: a.description, prompt: a.prompt, command: a.command, timeoutSec: a.timeoutSec } });
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
    tool(
      'update_node',
      'Change fields of a step. Only the fields you pass change. `description` is one plain-language sentence for people saying what the step does and why.',
      {
        id: z.string(),
        title: z.string().optional(),
        kind: kind.optional(),
        description: z.string().optional(),
        prompt: z.string().optional(),
        command: z.string().optional(),
        timeoutSec: z.number().positive().optional(),
      },
      async ({ id, ...patch }) => outcome(apply({ type: 'updateNode', id, patch }), `Updated ${id}.`),
    ),
    tool('delete_node', 'Delete a step and its edges.', { id: z.string() }, async ({ id }) =>
      outcome(apply({ type: 'deleteNode', id }), `Deleted ${id}.`),
    ),
    tool('connect', 'Make `to` run after `from` and receive its output.', { from: z.string(), to: z.string() }, async ({ from, to }) =>
      outcome(apply({ type: 'connect', from, to }), `Connected ${from} -> ${to}.`),
    ),
    tool('disconnect', 'Remove the edge from `from` to `to`.', { from: z.string(), to: z.string() }, async ({ from, to }) =>
      outcome(apply({ type: 'disconnect', from, to }), `Disconnected ${from} -> ${to}.`),
    ),
    tool('set_goal', 'Set the workflow goal: shared context every agent step receives.', { goal: z.string() }, async ({ goal }) =>
      outcome(apply({ type: 'setGoal', goal }), 'Goal updated.'),
    ),
    tool(
      'set_instructions',
      'Set the instructions & context: longer guidance every agent step receives after the goal (targets, conventions, what never to touch).',
      { instructions: z.string() },
      async ({ instructions }) => outcome(apply({ type: 'setInstructions', instructions }), 'Instructions updated.'),
    ),
    tool(
      'set_variable',
      'Define a variable steps can use as {{ name }} (Jinja), or change its description. The user sets its value on their machine; you never see values.',
      { name: z.string(), description: z.string().optional() },
      async ({ name, description }) => {
        const exists = d.graphStore.get(d.graphId).variables.some((v) => v.name === name);
        if (exists) return outcome(apply({ type: 'setVariableDescription', name, description: description ?? '' }), `Updated variable ${name}.`);
        return outcome(apply({ type: 'addVariable', name, description }), `Added variable ${name}. Ask the user to set its value (Variables menu).`);
      },
    ),
    tool('delete_variable', 'Remove a variable definition. Steps still using it fail the run check until updated.', { name: z.string() }, async ({ name }) =>
      outcome(apply({ type: 'deleteVariable', name }), `Deleted variable ${name}.`),
    ),
    tool(
      'request_run',
      "Ask the user to start a run. This opens a confirmation dialog in Agent Stream; the user decides whether to start it. Pass fromNodeId to re-run from that step, reusing the latest run's results for unchanged steps.",
      { fromNodeId: z.string().optional() },
      async ({ fromNodeId }) => {
        const error = d.requestRun(fromNodeId);
        return error ? reply(error, true) : reply('Asked the user to confirm the run in the UI. Call get_run later to see results.');
      },
    ),
    tool('get_run', 'Show the latest run (or runId): status of each step, errors, and output excerpts.', { runId: z.string().optional() }, async ({ runId }) => {
      const id = runId ?? d.runStore.list(d.graphId)[0]?.id;
      const meta = id ? d.runStore.get(id) : undefined;
      if (!meta || meta.graphId !== d.graphId) return runId ? reply(`Run ${runId} not found.`, true) : reply('No runs yet.');
      const lines = [`Run ${meta.id}: ${meta.status}`];
      for (const n of meta.snapshot.nodes) {
        const state = meta.nodes[n.id];
        const output = d.runStore.readOutput(meta.id, n.id);
        const excerpt = n.kind === 'command' ? truncateTail(output, RUN_EXCERPT_CHARS) : truncateHead(output, RUN_EXCERPT_CHARS);
        lines.push(`\n## ${n.id} · ${n.title} — ${state?.status ?? 'unknown'}`);
        if (state?.error) lines.push(`error: ${state.error}`);
        if (excerpt.trim()) lines.push(`output:\n${excerpt}`);
      }
      return reply(lines.join('\n'));
    }),
  ];
}
