import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  edgeId,
  reusableNodeIds,
  topoOrder,
  upstream,
  validateRunnable,
  type Graph,
  type GraphNode,
  type NodeEvent,
  type NodeEventBody,
  type NodeRunState,
  type NodeStatus,
  type ProviderId,
  type RenderedRun,
  type RunMeta,
} from '@agent-stream/shared';
import type { ApprovalBroker } from './approvals';
import { systemClock, type Clock } from './clock';
import type { Executors, NodeExecutor, NodeOutcome } from './executors';
import { buildNodePrompt } from './prompt';
import type { RunStore } from './runStore';

export function newRunId(date: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp = `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
  return `${stamp}-${randomBytes(2).toString('hex')}`;
}

export type RunnerDeps = {
  runStore: RunStore;
  broker: ApprovalBroker;
  executors: Executors;
  projectDir: string;
  maxParallel: number;
  clock?: Clock;
  newRunId?: () => string;
};

export type StartRunInput = {
  graph: Graph;
  rendered: RenderedRun;
  sourceRunId?: string;
  fromNodeId?: string;
  /** Runs this run's agent steps instead of `executors.agent`: the provider chosen when the run started. */
  agent?: NodeExecutor;
  /** Which provider runs the agent steps, recorded in the run. */
  provider?: ProviderId;
};
/** An approved change a step agent makes to its run: a new step with its connections, or new text for a step that hasn't started. */
export type RunChange =
  | { kind: 'add'; node: GraphNode; text: string; after: string[]; before: string[] }
  | { kind: 'change'; node: GraphNode; text: string };

export type StartRunResult = { ok: true; run: RunMeta; done: Promise<RunMeta> } | { ok: false; error: string };

type ActiveRun = {
  meta: RunMeta;
  /** The run's own agent executor; a provider switch mid-run doesn't reach it. */
  agent?: NodeExecutor;
  order: string[];
  running: Map<string, AbortController>;
  waiting: Map<string, number>;
  stopping: boolean;
  finished: boolean;
  resolveDone: (meta: RunMeta) => void;
};

const DONE_OK: ReadonlySet<NodeStatus> = new Set(['succeeded', 'reused']);
const BLOCKED: ReadonlySet<NodeStatus> = new Set(['failed', 'not_run', 'cancelled', 'interrupted']);

/**
 * Executes a frozen snapshot of a graph (spec §7.2): a node starts once every upstream node
 * succeeded or was reused, up to `maxParallel` at a time; failures skip descendants.
 * Events: 'run' (RunMeta), 'node' (runId, nodeId, NodeRunState), 'event' (runId, nodeId, NodeEvent).
 */
export class Runner extends EventEmitter {
  private runs = new Map<string, ActiveRun>();
  private clock: Clock;
  private makeRunId: () => string;

  constructor(private deps: RunnerDeps) {
    super();
    this.clock = deps.clock ?? systemClock;
    this.makeRunId = deps.newRunId ?? (() => newRunId());
  }

  get(runId: string): RunMeta | undefined {
    return this.runs.get(runId)?.meta;
  }

  activeFor(graphId: string): RunMeta | undefined {
    for (const run of this.runs.values()) if (run.meta.graphId === graphId) return run.meta;
    return undefined;
  }

  start(input: StartRunInput): StartRunResult {
    const graph = structuredClone(input.graph);
    const problems = validateRunnable(graph);
    if (problems.length) return { ok: false, error: problems.join('\n') };
    if (this.activeFor(graph.id)) return { ok: false, error: 'A run is already in progress for this graph.' };
    if (input.fromNodeId && !graph.nodes.some((n) => n.id === input.fromNodeId)) {
      return { ok: false, error: `node ${input.fromNodeId} does not exist` };
    }
    for (const n of graph.nodes) {
      if (input.rendered.nodes[n.id] === undefined) return { ok: false, error: `The run has no reviewed text for step ${n.id}.` };
    }
    let source: RunMeta | undefined;
    if (input.sourceRunId) {
      source = this.deps.runStore.get(input.sourceRunId);
      if (!source) return { ok: false, error: `run ${input.sourceRunId} not found` };
    }
    const reuse = source ? reusableNodeIds(graph, source, input.fromNodeId, input.rendered) : new Set<string>();

    const meta: RunMeta = {
      id: this.makeRunId(),
      graphId: graph.id,
      status: 'running',
      startedAt: this.clock(),
      snapshot: graph,
      nodes: {},
      ...(input.provider && { provider: input.provider }),
    };
    meta.rendered = structuredClone(input.rendered);
    if (source) meta.sourceRunId = source.id;
    if (input.fromNodeId) meta.fromNodeId = input.fromNodeId;
    for (const n of graph.nodes) {
      meta.nodes[n.id] = source && reuse.has(n.id) ? { ...source.nodes[n.id], status: 'reused' } : { status: 'queued' };
    }
    this.deps.runStore.create(meta);
    if (source) for (const id of reuse) this.deps.runStore.copyOutput(source.id, meta.id, id);

    let resolveDone!: (m: RunMeta) => void;
    const done = new Promise<RunMeta>((resolve) => (resolveDone = resolve));
    const run: ActiveRun = { meta, agent: input.agent, order: topoOrder(graph), running: new Map(), waiting: new Map(), stopping: false, finished: false, resolveDone };
    this.runs.set(meta.id, run);
    this.safeEmit('run', meta);
    this.schedule(run);
    return { ok: true, run: meta, done };
  }

  /**
   * Applies a step agent's approved graph change to the running run (agent changes spec §4.3): an added
   * step joins as queued with its rendered text and edges; a changed step that hasn't started gets its
   * new definition and text. Refused, changing nothing, once the run stops or a target started.
   */
  amend(runId: string, change: RunChange, byNodeId: string, summary: string): { ok: true } | { ok: false; error: string } {
    const run = this.runs.get(runId);
    if (!run || run.finished || run.stopping) return { ok: false, error: 'The run was stopped.' };
    const meta = run.meta;
    const exists = (id: string) => meta.snapshot.nodes.some((n) => n.id === id) && meta.nodes[id] !== undefined;
    const started = (id: string) => `${id} already started; the change was not applied.`;
    const notStarted = (id: string) => meta.nodes[id]?.status === 'queued';
    if (change.kind === 'change') {
      if (!exists(change.node.id)) return { ok: false, error: `node ${change.node.id} does not exist` };
      if (!notStarted(change.node.id)) return { ok: false, error: started(change.node.id) };
      meta.snapshot = { ...meta.snapshot, nodes: meta.snapshot.nodes.map((n) => (n.id === change.node.id ? change.node : n)) };
    } else {
      if (exists(change.node.id) || meta.nodes[change.node.id] !== undefined) return { ok: false, error: `node ${change.node.id} already exists` };
      for (const id of [...change.after, ...change.before]) if (!exists(id)) return { ok: false, error: `node ${id} does not exist` };
      for (const id of change.before) if (!notStarted(id)) return { ok: false, error: started(id) };
      const edges = [
        ...[...new Set(change.after)].map((from) => ({ id: edgeId(from, change.node.id), from, to: change.node.id })),
        ...[...new Set(change.before)].map((to) => ({ id: edgeId(change.node.id, to), from: change.node.id, to })),
      ];
      const next = { ...meta.snapshot, nodes: [...meta.snapshot.nodes, change.node], edges: [...meta.snapshot.edges, ...edges] };
      const problems = validateRunnable(next);
      if (problems.length) return { ok: false, error: problems.join('\n') };
      meta.snapshot = next;
      meta.nodes[change.node.id] = { status: 'queued' };
      run.order = topoOrder(next);
    }
    meta.rendered = { ...meta.rendered!, nodes: { ...meta.rendered!.nodes, [change.node.id]: change.text } };
    meta.amendments = [...(meta.amendments ?? []), { at: this.clock(), byNodeId, summary }];
    this.persist(meta);
    this.safeEmit('run', meta);
    this.schedule(run);
    return { ok: true };
  }

  stop(runId: string): boolean {
    const run = this.runs.get(runId);
    if (!run || run.finished) return false;
    run.stopping = true;
    for (const id of run.order) if (run.meta.nodes[id].status === 'queued') this.setNode(run, id, { status: 'cancelled' });
    this.deps.broker.cancelRun(runId);
    for (const controller of run.running.values()) controller.abort();
    this.schedule(run);
    return true;
  }

  stopAll(): void {
    for (const id of [...this.runs.keys()]) this.stop(id);
  }

  private schedule(run: ActiveRun): void {
    if (run.finished) return;
    if (!run.stopping) {
      for (const id of run.order) {
        if (run.meta.nodes[id].status !== 'queued') continue;
        const parents = upstream(run.meta.snapshot, id).map((p) => run.meta.nodes[p].status);
        if (parents.some((s) => BLOCKED.has(s))) {
          this.setNode(run, id, { status: 'not_run' });
          continue;
        }
        if (parents.every((s) => DONE_OK.has(s)) && run.running.size < this.deps.maxParallel) this.launch(run, id);
      }
    }
    if (run.running.size === 0) this.finish(run);
  }

  private launch(run: ActiveRun, nodeId: string): void {
    const { meta } = run;
    const node = meta.snapshot.nodes.find((n) => n.id === nodeId)!;
    const controller = new AbortController();
    run.running.set(nodeId, controller);
    this.setNode(run, nodeId, { status: 'running', startedAt: this.clock() });
    const startedAt = Date.now();
    const executor = node.kind === 'agent' ? (run.agent ?? this.deps.executors.agent) : this.deps.executors[node.kind];
    Promise.resolve()
      .then(() => {
        // Inside the chain so a failure reading upstream outputs fails this node instead of escaping.
        const upstreamResults = upstream(meta.snapshot, nodeId).map((parentId) => ({
          node: executionNode(meta, parentId),
          state: meta.nodes[parentId],
          output: this.deps.runStore.readOutput(meta.id, parentId),
          outputPath: this.deps.runStore.outputRelPath(meta.id, parentId),
        }));
        const graph = meta.rendered ? { ...meta.snapshot, goal: meta.rendered.goal, instructions: meta.rendered.instructions } : meta.snapshot;
        const execNode = executionNode(meta, nodeId);
        const prompt = node.kind === 'agent' ? buildNodePrompt(graph, execNode, upstreamResults) : '';
        return executor({
          runId: meta.id,
          graph,
          node: execNode,
          prompt,
          cwd: this.deps.projectDir,
          signal: controller.signal,
          emit: (event) => this.emitEvent(run, nodeId, event),
        });
      })
      .catch((e: unknown): NodeOutcome => ({ ok: false, output: '', error: e instanceof Error ? e.message : String(e) }))
      .then((outcome) => this.complete(run, nodeId, outcome, Date.now() - startedAt))
      .catch((e: unknown) => {
        // Last resort: a run must always reach finish, and nothing may escape as an unhandled rejection.
        console.error('[agent-stream] internal error in run', meta.id, 'node', nodeId, e);
        const status = meta.nodes[nodeId]?.status;
        if (run.running.has(nodeId) || status === 'running' || status === 'waiting_approval') {
          run.running.delete(nodeId);
          run.waiting.delete(nodeId);
          this.setNode(run, nodeId, {
            status: 'failed',
            endedAt: this.clock(),
            error: `Agent Stream internal error: ${e instanceof Error ? e.message : String(e)}`,
          });
        }
        this.schedule(run);
      });
  }

  private complete(run: ActiveRun, nodeId: string, outcome: NodeOutcome, durationMs: number): void {
    run.running.delete(nodeId);
    run.waiting.delete(nodeId);
    try {
      this.deps.runStore.writeOutput(run.meta.id, nodeId, outcome.output);
    } catch (e) {
      console.error('[agent-stream] could not write output for run', run.meta.id, nodeId, e);
    }
    this.emitEvent(run, nodeId, { type: 'result', ok: outcome.ok, durationMs, error: outcome.error, exitCode: outcome.exitCode, usage: outcome.usage });
    const status: NodeStatus = outcome.ok ? 'succeeded' : run.stopping ? 'cancelled' : 'failed';
    this.setNode(run, nodeId, {
      status,
      endedAt: this.clock(),
      durationMs,
      error: outcome.ok ? undefined : outcome.error,
      exitCode: outcome.exitCode,
      usage: outcome.usage,
    });
    this.schedule(run);
  }

  private emitEvent(run: ActiveRun, nodeId: string, body: NodeEventBody): void {
    const event = { ...body, at: this.clock() } as NodeEvent;
    try {
      this.deps.runStore.appendEvent(run.meta.id, nodeId, event);
    } catch (e) {
      console.error('[agent-stream] could not log an event for run', run.meta.id, nodeId, e);
    }
    this.safeEmit('event', run.meta.id, nodeId, event);
    if (!run.running.has(nodeId)) return;
    if (body.type === 'approval_requested') {
      run.waiting.set(nodeId, (run.waiting.get(nodeId) ?? 0) + 1);
      this.setNode(run, nodeId, { status: 'waiting_approval' });
    } else if (body.type === 'approval_decided') {
      const left = Math.max(0, (run.waiting.get(nodeId) ?? 1) - 1);
      run.waiting.set(nodeId, left);
      if (left === 0 && run.meta.nodes[nodeId].status === 'waiting_approval') this.setNode(run, nodeId, { status: 'running' });
    }
  }

  private setNode(run: ActiveRun, nodeId: string, patch: Partial<NodeRunState>): void {
    const state = { ...run.meta.nodes[nodeId], ...patch } as NodeRunState;
    run.meta.nodes[nodeId] = state;
    this.persist(run.meta);
    this.safeEmit('node', run.meta.id, nodeId, state);
  }

  private finish(run: ActiveRun): void {
    if (run.finished) return;
    run.finished = true;
    const statuses = Object.values(run.meta.nodes).map((s) => s.status);
    run.meta.status = run.stopping ? 'cancelled' : statuses.every((s) => DONE_OK.has(s)) ? 'succeeded' : 'failed';
    run.meta.endedAt = this.clock();
    this.persist(run.meta);
    this.runs.delete(run.meta.id);
    this.safeEmit('run', run.meta);
    run.resolveDone(run.meta);
  }

  /** Saving run.json can fail (disk full, permissions); the run itself must carry on. */
  private persist(meta: RunMeta): void {
    try {
      this.deps.runStore.save(meta);
    } catch (e) {
      console.error('[agent-stream] could not save run', meta.id, e);
    }
  }

  /** A throwing listener must not break the run that emitted the event. */
  private safeEmit(event: string, ...args: unknown[]): void {
    try {
      this.emit(event, ...args);
    } catch (e) {
      console.error(`[agent-stream] a '${event}' listener failed`, e);
    }
  }
}

/** The step as it runs: its prompt or command replaced by the text rendered for this run. */
function executionNode(meta: RunMeta, id: string): GraphNode {
  const node = meta.snapshot.nodes.find((n) => n.id === id)!;
  const text = meta.rendered?.nodes[id];
  if (text === undefined) throw new Error(`no reviewed text for step ${id}`);
  return node.kind === 'command' ? { ...node, command: text } : { ...node, prompt: text };
}
