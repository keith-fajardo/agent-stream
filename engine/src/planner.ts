import { EventEmitter } from 'node:events';
import type { ChatEntry, ChatRole, ModelSelection, Op, OpRecord } from '@agent-stream/shared';
import { systemClock, type Clock } from './clock';
import type { GraphStore } from './graphStore';
import { graphTools, type CheckoutSource } from './plannerTools';
import { ALTERNATIVES_RULE, PARALLEL_POLICY, PLANNER_AB_RULES, PLANNER_TICKET_RULES, SERIALIZATION_GUIDANCE } from './policy';
import { createPlannerGate } from './providers/toolGate';
import type { AgentProvider } from './providers/types';
import type { RunStore } from './runStore';
import type { SessionStore } from './sessionStore';

const SESSION_RESET_NOTE = ' (The previous planner session was reset; send your message again.)';

export const PLANNER_APPEND = `You are the planner inside Agent Stream, a local tool where the user and you co-create a workflow graph that is then executed step by step.

How the graph works:
- Each node is a step. kind "agent" is a separate AI agent run that receives the workflow goal, its own prompt, and the outputs of the nodes it depends on. kind "command" is an exact shell command run in the project root, with no LLM involved.
- An edge from A to B means B runs after A and receives A's output. Nodes with no path between them run in parallel.
- Steps that can change files take turns within one workspace; read-only steps (access: read) and steps in other workspaces run alongside them.
- Agent nodes ask the user before every file edit or shell command. Command nodes run exactly as written once the user starts the run.

How to work:
- Build and change plans only through the graph tools (add_node, update_node, delete_node, connect, disconnect, set_goal, set_instructions, set_variable, delete_variable). Do not just describe a plan in chat.
- The goal and the instructions (set_instructions) are given to every agent step. Put shared guidance there (targets, conventions, what never to touch) instead of repeating it in each step.
- Use the read-only tools (Read, Glob, Grep) to ground the plan in the actual project.
- Prefer command nodes for anything that must be reproducible: builds, test runs, timings, queries, diffs. Use agent nodes for judgment: writing code or SQL, analysing results, summarising.
- Make every agent node prompt self-contained: what to do, where, and what to output. Downstream nodes see upstream outputs, not this chat.
- Command nodes never receive upstream output as input. If a command needs something an agent produced, have the agent write it to a file and have the command read that file.
- The user edits the same graph. Respect their edits; you will be told what they changed since your last turn.
- You cannot start runs. Only call request_run when the user asks you to run or test the graph; after building or changing a plan, stop and let the user review it. Use get_run to read results when debugging.
- Keep chat replies short; the graph is the plan.
- Every step has a short plain-language description for people: one sentence on what the step does and why, without technical detail. Write one whenever you add a step, and update it whenever you change a step's prompt or command. The user may write a step's prompt or description in plain language; when asked to refine steps, turn that into precise instructions and keep the description short and readable.

Variables and templates:
- Steps, the goal and the instructions are Jinja templates. {{ name }} inserts a graph variable; define it with set_variable. The user sets values on their own machine; you never see them, and they are never exported.
- {{ env_var('NAME', 'default') }} reads an environment variable on the user's machine.
- In command steps every {{ ... }} value is shell-quoted automatically. Write {{ flags | unquoted }} only for a value that must expand to several arguments, and keep {{ }} outside quoted strings.
- Values "true" and "false" are booleans, so {% if full_refresh %}--full-refresh{% endif %} works.
- dbt's own Jinja ({{ ref('x') }}, {{ config(...) }}) must be wrapped in {% raw %}...{% endraw %} so Agent Stream leaves it alone.

Parallel work and workspaces:
- ${PARALLEL_POLICY}
- ${ALTERNATIVES_RULE}
- ${PLANNER_TICKET_RULES}
- ${SERIALIZATION_GUIDANCE}
- ${PLANNER_AB_RULES}
- Use checkout_info to see the branch, other worktrees and which run is changing files in this checkout.`;

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
    case 'acceptChange':
      return op.target.kind === 'all' ? 'accepted all agent changes' : `accepted the agent change to ${op.target.id}`;
    case 'revertChange':
      return op.target.kind === 'all' ? 'reverted all agent changes' : `reverted the agent change to ${op.target.id}`;
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
  /** Where each work session keeps its planner conversations: chats and provider state per graph. */
  sessions: SessionStore;
  projectDir: string;
  /** The provider that runs planner turns, read per turn: the user can switch it at any time. */
  provider: () => AgentProvider;
  /** The settings' default model and effort, read per turn, for a conversation without its own choice ('' or absent: none). */
  modelDefaults?: () => ModelSelection;
  /** Files the planner is denied reading (the variable values files). */
  privateFiles: () => string[];
  requestRun: (graphId: string, fromNodeId?: string) => string | null;
  /** Where the folder's graphs work and who holds its write lease (checkout_info, check_tickets). */
  checkout: CheckoutSource;
  clock?: Clock;
};

const STILL_WORKING = 'The planner is still working on your previous message.';
const STOPPED = 'Stopped.';
const key = (sessionId: string, graphId: string) => `${sessionId}|${graphId}`;

/**
 * The chat agent: one resumable provider conversation per work session and graph.
 * Events: 'entry'(sessionId, graphId, entry), 'busy'(sessionId, graphId, busy), 'cleared'(sessionId, graphId).
 */
export class Planner extends EventEmitter {
  /** `${sessionId}|${graphId}` of the conversations with a turn running, each with the controller that stops it. */
  private busy = new Map<string, AbortController>();
  private clock: Clock;

  constructor(private d: PlannerDeps) {
    super();
    this.clock = d.clock ?? systemClock;
  }

  isBusy(sessionId: string, graphId: string): boolean {
    return this.busy.has(key(sessionId, graphId));
  }

  isBusyInGraph(graphId: string): boolean {
    return [...this.busy.keys()].some((k) => k.slice(k.indexOf('|') + 1) === graphId);
  }

  isBusyInSession(sessionId: string): boolean {
    return [...this.busy.keys()].some((k) => k.slice(0, k.indexOf('|')) === sessionId);
  }

  private add(sessionId: string, graphId: string, role: ChatRole, text: string): void {
    const entry: ChatEntry = { at: this.clock(), role, text };
    this.d.sessions.chatLog(sessionId).append(graphId, entry);
    this.emit('entry', sessionId, graphId, entry);
  }

  /** Stops this conversation's running turn (the chat's Stop button or Esc); does nothing when none is running. */
  stop(sessionId: string, graphId: string): void {
    this.busy.get(key(sessionId, graphId))?.abort();
  }

  /** "New chat": forgets this session's conversation for the graph (its chat and provider session). */
  newChat(sessionId: string, graphId: string): { ok: true } | { ok: false; error: string } {
    if (this.isBusy(sessionId, graphId)) return { ok: false, error: STILL_WORKING };
    this.d.sessions.clearPlanner(sessionId, graphId);
    this.emit('cleared', sessionId, graphId);
    return { ok: true };
  }

  /** Never rejects: failures become chat errors, or are logged when even that is impossible. */
  /** `options.display` is what the chat shows for the user's turn when it differs from `text`, the full instruction. */
  async send(sessionId: string, graphId: string, text: string, options: { display?: string } = {}): Promise<void> {
    const k = key(sessionId, graphId);
    if (this.busy.has(k)) {
      try {
        this.add(sessionId, graphId, 'error', STILL_WORKING);
      } catch (e) {
        console.error('[agent-stream] planner error', e);
      }
      return;
    }
    const abortController = new AbortController();
    this.busy.set(k, abortController);
    /** The user stopped this turn: whatever the provider then reports, the chat shows one Stopped. note. */
    const stopped = () => abortController.signal.aborted;
    /** The provider conversation this turn resumes, if any. */
    let resume: string | undefined;
    try {
      this.emit('busy', sessionId, graphId, true);
      this.add(sessionId, graphId, 'user', options.display ?? text);
      // Re-checked per turn: the project's settings can change while VS Code runs.
      const provider = this.d.provider();
      const problem = provider.folderProblem?.(this.d.projectDir);
      if (problem) {
        this.add(sessionId, graphId, 'error', problem);
        return;
      }
      const state = this.d.sessions.plannerState(sessionId, graphId);
      const transcripts = this.d.sessions.transcripts(sessionId);
      // State saved before providers existed is Claude's. Another provider can't resume it, so it starts fresh.
      const sameProvider = (state.provider ?? 'claude') === provider.id;
      if (state.sessionId && !sameProvider) this.add(sessionId, graphId, 'note', `Started a new planner conversation with ${provider.name}; it doesn't see earlier messages.`);
      resume = sameProvider ? state.sessionId : undefined;
      const ops = this.d.graphStore.readOps(graphId);
      const cursor = ops.length;
      // Each field on its own: the conversation's choice, else the settings' default, else nothing (Claude Code's own default).
      const defaults = this.d.modelDefaults?.() ?? {};
      const model = state.model || defaults.model || undefined;
      const effort = state.effort || defaults.effort || undefined;
      const tools = graphTools({
        graphStore: this.d.graphStore,
        runStore: this.d.runStore,
        graphId,
        source: { kind: 'planner', sessionId },
        requestRun: (fromNodeId) => this.d.requestRun(graphId, fromNodeId),
        checkout: this.d.checkout,
      });
      const r = await provider.planTurn({
        // Only a resumed conversation has a last turn to compare with; a fresh one starts from get_graph.
        prompt: (resume ? userEditsPreamble(ops.slice(state.opCursor ?? 0)) : '') + text,
        systemAppend: PLANNER_APPEND,
        cwd: this.d.projectDir,
        tools,
        resume,
        ...(model && { model }),
        ...(effort && { effort }),
        gate: createPlannerGate({ projectDir: this.d.projectDir, privateFiles: this.d.privateFiles(), graphToolNames: new Set(tools.map((t) => t.name)) }),
        transcript: { load: (id) => transcripts.load(graphId, provider.id, id), save: (id, messages) => transcripts.save(graphId, provider.id, id, messages) },
        signal: abortController.signal,
        onEvent: (e) => (e.type === 'text' ? this.add(sessionId, graphId, 'assistant', e.text) : this.add(sessionId, graphId, 'tool', describeToolCall(e.name, e.input))),
      });
      if (stopped()) {
        if (!r.ok && r.resumeFailed) this.d.sessions.setPlannerState(sessionId, graphId, { sessionId: undefined });
        // Saved like a finished turn, so the user can type "continue"; the provider's cancelled error isn't shown.
        if (r.ok) this.d.sessions.setPlannerState(sessionId, graphId, { sessionId: r.sessionId ?? resume, provider: provider.id, opCursor: cursor });
        this.add(sessionId, graphId, 'note', STOPPED);
        return;
      }
      if (!r.ok) {
        // A conversation that could not be resumed is dropped, so the next message starts fresh instead of failing the same way forever.
        if (r.resumeFailed) this.d.sessions.setPlannerState(sessionId, graphId, { sessionId: undefined });
        this.add(sessionId, graphId, 'error', r.resumeFailed ? `${r.error}${SESSION_RESET_NOTE}` : r.error);
        return;
      }
      if (r.error) this.add(sessionId, graphId, 'error', r.error);
      this.d.sessions.setPlannerState(sessionId, graphId, { sessionId: r.sessionId ?? resume, provider: provider.id, opCursor: cursor });
    } catch (e) {
      try {
        // A provider that throws when stopped keeps its conversation: the stop is not a broken session.
        if (stopped()) {
          this.add(sessionId, graphId, 'note', STOPPED);
          return;
        }
        if (resume) this.d.sessions.setPlannerState(sessionId, graphId, { sessionId: undefined });
        const message = e instanceof Error ? e.message : String(e);
        this.add(sessionId, graphId, 'error', resume ? `${message}${SESSION_RESET_NOTE}` : message);
      } catch (inner) {
        console.error('[agent-stream] planner error', e, inner);
      }
    } finally {
      this.busy.delete(k);
      try {
        this.emit('busy', sessionId, graphId, false);
      } catch (e) {
        console.error('[agent-stream] planner error', e);
      }
    }
  }
}
