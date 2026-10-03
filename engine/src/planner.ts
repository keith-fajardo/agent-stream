import { EventEmitter } from 'node:events';
import type { ChatEntry, ChatRole, Op, OpRecord } from '@agent-stream/shared';
import type { ChatLog } from './chatLog';
import { systemClock, type Clock } from './clock';
import type { GraphStore } from './graphStore';
import { graphTools } from './plannerTools';
import { createPlannerGate } from './providers/toolGate';
import type { AgentProvider } from './providers/types';
import type { RunStore } from './runStore';

const SESSION_RESET_NOTE = ' (The previous planner session was reset; send your message again.)';

export const PLANNER_APPEND = `You are the planner inside Agent Stream, a local tool where the user and you co-create a workflow graph that is then executed step by step.

How the graph works:
- Each node is a step. kind "agent" is a separate AI agent run that receives the workflow goal, its own prompt, and the outputs of the nodes it depends on. kind "command" is an exact shell command run in the project root, with no LLM involved.
- An edge from A to B means B runs after A and receives A's output. Nodes with no path between them run in parallel.
- Agent nodes ask the user before every file edit or shell command. Command nodes run exactly as written once the user starts the run.

How to work:
- Build and change plans only through the graph tools (add_node, update_node, delete_node, connect, disconnect, set_goal, set_instructions, set_variable, delete_variable). Do not just describe a plan in chat.
- The goal and the instructions (set_instructions) are given to every agent step. Put shared guidance there (targets, conventions, what never to touch) instead of repeating it in each step.
- Use the read-only tools (Read, Glob, Grep) to ground the plan in the actual project.
- Prefer command nodes for anything that must be reproducible: builds, test runs, timings, queries, diffs. Use agent nodes for judgment: writing code or SQL, analysing results, summarising.
- Make every agent node prompt self-contained: what to do, where, and what to output. Downstream nodes see upstream outputs, not this chat.
- Command nodes never receive upstream output as input. If a command needs something an agent produced, have the agent write it to a file and have the command read that file.
- The user edits the same graph. Respect their edits; you will be told what they changed since your last turn.
- You cannot start runs. Use request_run to ask the user, and get_run to read results when debugging.
- Keep chat replies short; the graph is the plan.

Variables and templates:
- Steps, the goal and the instructions are Jinja templates. {{ name }} inserts a graph variable; define it with set_variable. The user sets values on their own machine; you never see them, and they are never exported.
- {{ env_var('NAME', 'default') }} reads an environment variable on the user's machine.
- In command steps every {{ ... }} value is shell-quoted automatically. Write {{ flags | unquoted }} only for a value that must expand to several arguments, and keep {{ }} outside quoted strings.
- Values "true" and "false" are booleans, so {% if full_refresh %}--full-refresh{% endif %} works.
- dbt's own Jinja ({{ ref('x') }}, {{ config(...) }}) must be wrapped in {% raw %}...{% endraw %} so Agent Stream leaves it alone.`;

export function describeOp(op: Op): string {
  switch (op.type) {
    case 'addNode':
      return `added ${op.node.id ?? 'a node'} "${op.node.title}" (${op.node.kind})`;
    case 'updateNode':
      return `changed ${op.id}: ${Object.entries(op.patch).filter(([, v]) => v !== undefined).map(([k]) => k).join(', ')}`;
    case 'deleteNode':
      return `deleted ${op.id}`;
    case 'connect':
      return `connected ${op.from} -> ${op.to}`;
    case 'disconnect':
      return `disconnected ${op.from} -> ${op.to}`;
    case 'setGoal':
      return `set the goal to "${op.goal}"`;
    case 'setInstructions':
      return 'changed the instructions';
    case 'addVariable':
      return `added variable ${op.name}`;
    case 'renameVariable':
      return `renamed variable ${op.name} to ${op.newName}`;
    case 'setVariableDescription':
      return `changed the description of variable ${op.name}`;
    case 'deleteVariable':
      return `deleted variable ${op.name}`;
    case 'moveNode':
      return `moved ${op.id}`;
  }
}

/** Tells the planner what the user changed since its last turn (spec §6). */
export function userEditsPreamble(records: OpRecord[]): string {
  const lines = records.filter((r) => r.by === 'user').map((r) => `- ${describeOp(r.op)}`);
  if (lines.length === 0) return '';
  return `[Since your last turn, the user edited the graph:\n${lines.join('\n')}\nCall get_graph for the full current state.]\n\n`;
}

export function describeToolCall(name: string, input: unknown): string {
  const text = `${name.replace(/^mcp__graph__/, '')} ${JSON.stringify(input)}`;
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

export type PlannerDeps = {
  graphStore: GraphStore;
  runStore: RunStore;
  chatLog: ChatLog;
  projectDir: string;
  /** The provider that runs planner turns, read per turn: the user can switch it at any time. */
  provider: () => AgentProvider;
  /** Files the planner is denied reading (the variable values files). */
  privateFiles: () => string[];
  requestRun: (graphId: string, fromNodeId?: string) => string | null;
  clock?: Clock;
};

/** The chat agent: one resumable provider conversation per graph. Events: 'entry', 'busy'. */
export class Planner extends EventEmitter {
  private busy = new Set<string>();
  private clock: Clock;

  constructor(private d: PlannerDeps) {
    super();
    this.clock = d.clock ?? systemClock;
  }

  isBusy(graphId: string): boolean {
    return this.busy.has(graphId);
  }

  private add(graphId: string, role: ChatRole, text: string): void {
    const entry: ChatEntry = { at: this.clock(), role, text };
    this.d.chatLog.append(graphId, entry);
    this.emit('entry', graphId, entry);
  }

  /** Never rejects: failures become chat errors, or are logged when even that is impossible. */
  async send(graphId: string, text: string): Promise<void> {
    if (this.busy.has(graphId)) {
      try {
        this.add(graphId, 'error', 'The planner is still working on your previous message.');
      } catch (e) {
        console.error('[agent-stream] planner error', e);
      }
      return;
    }
    this.busy.add(graphId);
    const abortController = new AbortController();
    try {
      this.emit('busy', graphId, true);
      this.add(graphId, 'user', text);
      // Re-checked per turn: the project's settings can change while VS Code runs.
      const provider = this.d.provider();
      const problem = provider.folderProblem?.(this.d.projectDir);
      if (problem) {
        this.add(graphId, 'error', problem);
        return;
      }
      const graph = this.d.graphStore.get(graphId);
      const ops = this.d.graphStore.readOps(graphId);
      const cursor = ops.length;
      const tools = graphTools({ graphStore: this.d.graphStore, runStore: this.d.runStore, graphId, requestRun: (fromNodeId) => this.d.requestRun(graphId, fromNodeId) });
      const r = await provider.planTurn({
        prompt: userEditsPreamble(ops.slice(graph.plannerOpCursor ?? 0)) + text,
        systemAppend: PLANNER_APPEND,
        cwd: this.d.projectDir,
        tools,
        resume: graph.plannerSessionId,
        gate: createPlannerGate({ projectDir: this.d.projectDir, privateFiles: this.d.privateFiles(), graphToolNames: new Set(tools.map((t) => t.name)) }),
        signal: abortController.signal,
        onEvent: (e) => (e.type === 'text' ? this.add(graphId, 'assistant', e.text) : this.add(graphId, 'tool', describeToolCall(e.name, e.input))),
      });
      if (!r.ok) {
        // A conversation that could not be resumed is dropped, so the next message starts fresh instead of failing the same way forever.
        if (r.resumeFailed) this.d.graphStore.setPlannerState(graphId, { plannerSessionId: undefined });
        this.add(graphId, 'error', r.resumeFailed ? `${r.error}${SESSION_RESET_NOTE}` : r.error);
        return;
      }
      if (r.error) this.add(graphId, 'error', r.error);
      this.d.graphStore.setPlannerState(graphId, { plannerSessionId: r.sessionId ?? graph.plannerSessionId, plannerOpCursor: cursor });
    } catch (e) {
      try {
        const hadSession = !!this.d.graphStore.load(graphId).ok && !!this.d.graphStore.get(graphId).plannerSessionId;
        if (hadSession) this.d.graphStore.setPlannerState(graphId, { plannerSessionId: undefined });
        const message = e instanceof Error ? e.message : String(e);
        this.add(graphId, 'error', hadSession ? `${message}${SESSION_RESET_NOTE}` : message);
      } catch (inner) {
        console.error('[agent-stream] planner error', e, inner);
      }
    } finally {
      this.busy.delete(graphId);
      try {
        this.emit('busy', graphId, false);
      } catch (e) {
        console.error('[agent-stream] planner error', e);
      }
    }
  }
}
