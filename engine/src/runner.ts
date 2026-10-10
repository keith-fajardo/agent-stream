import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { isAbsolute, join, relative } from 'node:path';
import {
  MAX_BROWSER_PAGES,
  MAX_BROWSER_URL_CHARS,
  edgeId,
  folderId,
  isWriteCapable,
  loggedUrl,
  scopeOf,
  onlyRunPlan,
  readVerdict,
  reusableNodeIds,
  routeNode,
  runModeProblem,
  toRunCheckout,
  topoOrder,
  upstream,
  validateRunnable,
  verdictInstructionFor,
  workspaceOf,
  type CheckoutInfo,
  type EdgeLabel,
  type Graph,
  type GraphNode,
  type LeaseHolder,
  type NodeEvent,
  type NodeEventBody,
  type NodeRunState,
  type NodeStatus,
  type EffortLevel,
  type RunAttachment,
  type ProviderId,
  type RenderedRun,
  type RunMeta,
  type RunMode,
  type Scope,
  type StaleReason,
  type StepModelUse,
  type WaitingFor,
} from '@agent-stream/shared';
import type { ApprovalBroker } from './approvals';
import { systemClock, type Clock } from './clock';
import type { Executors, NodeExecutor, NodeOutcome } from './executors';
import { missingAttachmentLine, stepAttachments, storeReader } from './attachedFiles';
import { AttachmentStore } from './attachmentStore';
import { realOrResolved } from './git';
import { projectPaths } from './paths';
import { buildNodePrompt } from './prompt';
import type { RunStore } from './runStore';
import type { WriteLeases } from './writeLease';

export function newRunId(date: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp = `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
  return `${stamp}-${randomBytes(2).toString('hex')}`;
}

/** How often a waiting run retries while the lease holder is in another VS Code window (spec §4.3). */
export const LEASE_RETRY_MS = 3000;

export type RunnerDeps = {
  runStore: RunStore;
  broker: ApprovalBroker;
  executors: Executors;
  projectDir: string;
  maxParallel: number;
  /** The extension host's write leases, shared by every folder's engine (spec §4.2). */
  leases: WriteLeases;
  /** For tests: how often to retry while the holder is in another window. */
  leaseRetryMs?: number;
  clock?: Clock;
  newRunId?: () => string;
};

export type StartRunInput = {
  graph: Graph;
  rendered: RenderedRun;
  sourceRunId?: string;
  /** With `sourceRunId`: the step `from` re-runs from, or `only` runs alone. */
  fromNodeId?: string;
  /** How the run uses `sourceRunId` (see the startRun message). Absent: `from` with a step, else a retry from where it stopped. */
  mode?: RunMode;
  /** Runs this run's agent steps instead of `executors.agent`: the provider chosen when the run started. */
  agent?: NodeExecutor;
  /** Which provider runs the agent steps, recorded in the run. */
  provider?: ProviderId;
  /** The model and effort every agent step of this run gets, captured at start and recorded in the run (only when set). */
  model?: string;
  effort?: EffortLevel;
  /** Each agent step's own model and effort, resolved at start (step model spec §3.1); a step without an entry gets `model` and `effort`. */
  stepModels?: Record<string, StepModelUse>;
  /** The attachments the steps use, with their SHA-256 now (spec §6b.5): recorded in the run, and what reuse compares. */
  attachments?: RunAttachment[];
  /** The run's id, when the caller needs it before the run starts (variant worktree paths contain it). */
  runId?: string;
  /** Start even though another run holds the checkout's lease: write-capable checkout steps wait for it (spec §4.3). */
  sequential?: boolean;
  /** The checkout the app inspected (ruling R4): recorded in RunMeta.checkout, and its root keys the lease. Default: projectDir. */
  checkout?: CheckoutInfo;
  /** The variant workspaces the app created for this run, by name (spec §4.3a). */
  workspaces?: Record<string, { path: string; head: string }>;
  /** The sub-graph steps of `graph`, which is expanded (sub-graphs spec §3.1): recorded in the run. */
  scopes?: Record<string, Scope>;
};
/** An approved change a step agent makes to its run: a new step with its connections, or new text for a step that hasn't started. */
export type RunChange =
  | { kind: 'add'; node: GraphNode; text: string; after: string[]; before: string[] }
  | { kind: 'change'; node: GraphNode; text: string };

/** Another run holds the checkout's write lease (spec §4.3); nothing was created. */
export type RunBlocked = { holder: LeaseHolder; otherWindow: boolean; checkout: CheckoutInfo; lockFile?: string };
export type StartRunResult = { ok: true; run: RunMeta; done: Promise<RunMeta> } | { ok: false; error: string; blocked?: RunBlocked };

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
  /** The checkout root that keys this run's lease. */
  leaseRoot: string;
  holdsLease: boolean;
  /** Set while the run waits for the lease: unsubscribes and stops retrying. */
  stopWaiting?: () => void;
  /** This run's variant worktrees, by name. */
  workspaces: Record<string, { path: string; head: string }>;
  /** The stop step that halted the run; no step launches after it. */
  halted?: string;
  /** Running steps cancelled by a fail-fast stop, so their outcome reads cancelled. */
  abortedByStop: Set<string>;
};

const DONE_OK: ReadonlySet<NodeStatus> = new Set(['succeeded', 'reused']);
const statusesOf = (meta: RunMeta): Record<string, NodeStatus> => Object.fromEntries(Object.entries(meta.nodes).map(([id, s]) => [id, s.status]));
const verdictsOf = (meta: RunMeta): Record<string, EdgeLabel | undefined> => Object.fromEntries(Object.entries(meta.nodes).map(([id, s]) => [id, s.verdict]));
const waitingOn = (h: LeaseHolder): WaitingFor => ({ runId: h.runId, graphId: h.graphId, folder: h.folder });

/** Only write-capable steps in this checkout that will actually run need the lease (spec §4.3). */
export const needsCheckoutLease = (graph: Graph, reuse: ReadonlySet<string>): boolean =>
  graph.nodes.some((n) => isWriteCapable(n) && workspaceOf(n) === null && !reuse.has(n.id));

/**
 * Executes a frozen snapshot of a graph (spec §7.2): a node starts once every upstream node
 * succeeded or was reused, up to `maxParallel` at a time; failures skip descendants.
 * Events: 'run' (RunMeta), 'node' (runId, nodeId, NodeRunState), 'event' (runId, nodeId, NodeEvent).
 */
export class Runner extends EventEmitter {
  private runs = new Map<string, ActiveRun>();
  private clock: Clock;
  private makeRunId: () => string;
  private attachmentStore: AttachmentStore;

  constructor(private deps: RunnerDeps) {
    super();
    this.attachmentStore = new AttachmentStore(projectPaths(deps.projectDir));
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

  /** Every run in progress in this folder. */
  activeRuns(): RunMeta[] {
    return [...this.runs.values()].map((r) => r.meta);
  }

  start(input: StartRunInput): StartRunResult {
    const graph = structuredClone(input.graph);
    const problems = validateRunnable(graph);
    if (problems.length) return { ok: false, error: problems.join('\n') };
    if (this.activeFor(graph.id)) return { ok: false, error: 'A run is already in progress for this graph.' };
    // Its run.json and its variant worktree paths are keyed by the id: two active runs must never share one.
    if (input.runId !== undefined && this.runs.has(input.runId)) return { ok: false, error: `Run ${input.runId} is already in progress.` };
    const modeProblem = runModeProblem(input.mode, input.fromNodeId, input.sourceRunId);
    if (modeProblem) return { ok: false, error: modeProblem };
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
    const mode: RunMode | undefined = source ? (input.mode ?? (input.fromNodeId ? 'from' : 'resume')) : undefined;
    // `reuse`: steps that keep their old result; `notRun`: steps that neither run nor keep one; `carriedSkip`: steps the source
    // run skipped, which stay skipped (only `Run only` leaves either, R32).
    let reuse = new Set<string>();
    let notRun = new Set<string>();
    let carriedSkip = new Set<string>();
    let stale = new Map<string, StaleReason>();
    if (source && mode === 'only') {
      const plan = onlyRunPlan(graph, source, input.fromNodeId!, input.rendered, input.attachments, input.scopes);
      if (!plan.ok) return { ok: false, error: plan.error };
      ({ reuse, notRun, stale } = plan);
      carriedSkip = plan.skipped;
    } else if (source) reuse = reusableNodeIds(graph, source, mode === 'resume' ? undefined : input.fromNodeId, input.rendered, input.attachments, input.scopes);
    const skipped = new Set([...reuse, ...notRun, ...carriedSkip]);
    for (const n of graph.nodes) {
      const ws = workspaceOf(n);
      if (ws !== null && !skipped.has(n.id) && !input.workspaces?.[ws]) return { ok: false, error: `Step ${n.id} uses workspace "${ws}", but this run has no worktree for it.` };
    }

    const runId = input.runId ?? this.makeRunId();
    const leaseRoot = input.checkout?.root ?? this.deps.projectDir;
    const startedAt = this.clock();
    const needsLease = needsCheckoutLease(graph, skipped);
    let holdsLease = false;
    let waitFor: { holder: LeaseHolder; otherWindow: boolean } | undefined;
    if (needsLease) {
      const got = this.deps.leases.acquire(leaseRoot, { runId, graphId: graph.id, folder: this.deps.projectDir, startedAt });
      if (got.ok) holdsLease = true;
      else if (!input.sequential) {
        return {
          ok: false,
          error: `Run ${got.holder.runId} is already changing files in ${leaseRoot}.`,
          blocked: {
            holder: got.holder,
            otherWindow: got.otherWindow,
            checkout: input.checkout ?? { git: false, root: leaseRoot, reason: 'Not inspected' },
            ...(got.lockFile && { lockFile: got.lockFile }),
          },
        };
      } else waitFor = { holder: got.holder, otherWindow: got.otherWindow };
    }

    // One copy, shared by the run and its record, so the two can't drift.
    const workspaces = structuredClone(input.workspaces ?? {});
    const meta: RunMeta = {
      id: runId,
      graphId: graph.id,
      status: 'running',
      startedAt,
      snapshot: graph,
      nodes: {},
      ...(input.provider && { provider: input.provider }),
      ...(input.model && { model: input.model }),
      ...(input.effort && { effort: input.effort }),
      ...(input.stepModels && Object.keys(input.stepModels).length > 0 && { stepModels: structuredClone(input.stepModels) }),
      ...(input.attachments && input.attachments.length > 0 && { attachments: structuredClone(input.attachments) }),
      ...(input.checkout && { checkout: toRunCheckout(input.checkout) }),
      ...(waitFor && { waitingFor: waitingOn(waitFor.holder) }),
      ...(Object.keys(workspaces).length > 0 && { workspaces }),
      ...(input.scopes && Object.keys(input.scopes).length > 0 && { scopes: structuredClone(input.scopes) }),
    };
    meta.rendered = structuredClone(input.rendered);
    if (source) meta.sourceRunId = source.id;
    if (mode) meta.mode = mode;
    if (input.fromNodeId) meta.fromNodeId = input.fromNodeId;
    for (const n of graph.nodes) {
      const mark = stale.get(n.id);
      meta.nodes[n.id] =
        source && reuse.has(n.id)
          ? { ...source.nodes[n.id], status: 'reused', ...(mark && { stale: { ...mark, runId } }) }
          : notRun.has(n.id)
            ? { status: 'not_run' }
            : source && carriedSkip.has(n.id)
              ? { status: 'skipped', ...(source.nodes[n.id]?.error && { error: source.nodes[n.id].error }) }
              : { status: 'queued' };
    }
    try {
      this.deps.runStore.create(meta);
      if (source) for (const id of reuse) this.deps.runStore.copyOutput(source.id, meta.id, id);
    } catch (e) {
      if (holdsLease) this.releaseLease(leaseRoot, runId);
      throw e;
    }

    let resolveDone!: (m: RunMeta) => void;
    const done = new Promise<RunMeta>((resolve) => (resolveDone = resolve));
    const run: ActiveRun = {
      meta,
      agent: input.agent,
      order: topoOrder(graph),
      running: new Map(),
      waiting: new Map(),
      stopping: false,
      finished: false,
      resolveDone,
      leaseRoot,
      holdsLease,
      workspaces,
      abortedByStop: new Set<string>(),
    };
    this.runs.set(meta.id, run);
    if (waitFor) this.waitForLease(run, waitFor.otherWindow);
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
    if (run.halted) return { ok: false, error: `The run was stopped at ${run.halted}` };
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
    meta.amendments = [...(meta.amendments ?? []), { at: this.clock(), byNodeId, nodeId: change.node.id, summary }];
    this.persist(meta);
    this.safeEmit('run', meta);
    this.schedule(run);
    return { ok: true };
  }

  /**
   * A page a browser step visited (browser spec §4.4): kept in run.json as the step's `browserPages`, each URL once in
   * first-visit order, at most MAX_BROWSER_PAGES. Ignored for a run or step that isn't running here.
   */
  recordBrowserPage(runId: string, nodeId: string, url: string): void {
    const run = this.runs.get(runId);
    const state = run?.meta.nodes[nodeId];
    if (!run || !state) return;
    // The cleaned form (no userinfo, no fragment) is what is kept, whoever calls; it is idempotent.
    const page = loggedUrl(url).slice(0, MAX_BROWSER_URL_CHARS);
    const pages = state.browserPages ?? [];
    if (pages.includes(page) || pages.length >= MAX_BROWSER_PAGES) return;
    this.setNode(run, nodeId, { browserPages: [...pages, page] });
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

  /** A fresh run id, for callers that need it before start (variant worktree paths). */
  newRunId(): string {
    return this.makeRunId();
  }

  /**
   * VS Code is closing (spec §8): stop every run and release every lease this engine holds. Waiting runs stop
   * listening first, so none takes a released lease and launches a write-capable step during shutdown.
   */
  dispose(): void {
    for (const run of this.runs.values()) this.endWait(run);
    this.stopAll();
    // Runs that finished inside stopAll released theirs already; the rest are still stopping.
    for (const run of this.runs.values()) {
      if (run.holdsLease) {
        run.holdsLease = false;
        this.releaseLease(run.leaseRoot, run.meta.id);
      }
    }
  }

  /** A lock file Windows won't let go of (EPERM/EBUSY) must never leave a run unfinished or break shutdown. */
  private releaseLease(root: string, runId: string): void {
    try {
      this.deps.leases.release(root, runId);
    } catch (e) {
      console.error('[agent-stream] could not release the write lease of run', runId, e);
    }
  }

  private schedule(run: ActiveRun): void {
    if (run.finished) return;
    if (run.halted) this.skipQueued(run, `run stopped at ${run.halted}`);
    if (!run.stopping) {
      for (const id of run.order) {
        if (run.meta.nodes[id].status !== 'queued') continue;
        // Every step in the snapshot has a status from start() or amend(): routeNode reads a missing one as dead.
        const route = routeNode(run.meta.snapshot, statusesOf(run.meta), verdictsOf(run.meta), id);
        if (route === 'wait') continue;
        if (route === 'not_run') {
          this.setNode(run, id, { status: 'not_run' });
          continue;
        }
        if (route === 'skip') {
          this.setNode(run, id, { status: 'skipped' });
          continue;
        }
        if (run.halted || run.running.size >= this.deps.maxParallel) continue;
        const node = run.meta.snapshot.nodes.find((n) => n.id === id)!;
        if (isWriteCapable(node)) {
          // At most one write-capable step per workspace at a time; in the checkout only while the run holds the lease (spec §4.3).
          const workspace = workspaceOf(node);
          if (this.writerRunning(run, workspace)) continue;
          if (workspace === null && !this.ensureLease(run)) continue;
        }
        this.launch(run, id);
      }
    }
    // Queued steps with nothing running can only be waiting for the lease: the run isn't over yet.
    const waitingForLease = !run.stopping && !!run.stopWaiting && run.order.some((id) => run.meta.nodes[id].status === 'queued');
    if (run.running.size === 0 && !waitingForLease) this.finish(run);
  }

  /** Steps that have not started will not: the run was halted by a stop step. */
  private skipQueued(run: ActiveRun, reason?: string): void {
    for (const id of run.order) if (run.meta.nodes[id].status === 'queued') this.setNode(run, id, { status: 'skipped', error: reason });
  }

  /** Another write-capable step of this run is running in the same workspace. */
  private writerRunning(run: ActiveRun, workspace: string | null): boolean {
    for (const id of run.running.keys()) {
      const n = run.meta.snapshot.nodes.find((x) => x.id === id);
      if (n && isWriteCapable(n) && workspaceOf(n) === workspace) return true;
    }
    return false;
  }

  private holderOf(run: ActiveRun): Omit<LeaseHolder, 'pid'> {
    return { runId: run.meta.id, graphId: run.meta.graphId, folder: this.deps.projectDir, startedAt: run.meta.startedAt };
  }

  /** A write-capable checkout step may start only while its run holds the lease. A run without it takes it now, or waits (ruling R7). */
  private ensureLease(run: ActiveRun): boolean {
    if (run.holdsLease) return true;
    if (run.stopWaiting) return false;
    const got = this.deps.leases.acquire(run.leaseRoot, this.holderOf(run));
    if (got.ok) {
      run.holdsLease = true;
      return true;
    }
    this.setWaiting(run, got.holder);
    this.waitForLease(run, got.otherWindow);
    return false;
  }

  /**
   * Retries the lease whenever one is released in this process and, while the holder is in another window, every
   * LEASE_RETRY_MS (spec §4.3). One listener per waiting run, subscribed when it starts waiting, so runs acquire in that order.
   */
  private waitForLease(run: ActiveRun, otherWindow: boolean): void {
    if (run.stopWaiting) return;
    let timer: NodeJS.Timeout | undefined;
    const poll = (on: boolean) => {
      if (on && !timer) {
        timer = setInterval(retry, this.deps.leaseRetryMs ?? LEASE_RETRY_MS);
        timer.unref?.();
      } else if (!on && timer) {
        clearInterval(timer);
        timer = undefined;
      }
    };
    const retry = () => {
      if (run.finished || run.stopping || run.holdsLease) return;
      const got = this.deps.leases.acquire(run.leaseRoot, this.holderOf(run));
      if (!got.ok) {
        poll(got.otherWindow);
        if (run.meta.waitingFor?.runId !== got.holder.runId) this.setWaiting(run, got.holder);
        return;
      }
      run.holdsLease = true;
      this.endWait(run);
      this.setWaiting(run);
      this.schedule(run);
    };
    const off = this.deps.leases.onRelease((root) => {
      if (root === run.leaseRoot) retry();
    });
    poll(otherWindow);
    run.stopWaiting = () => {
      off();
      poll(false);
    };
  }

  private endWait(run: ActiveRun): void {
    run.stopWaiting?.();
    run.stopWaiting = undefined;
  }

  /** Records who the run waits for (or that it no longer waits), saves it and tells the clients. */
  private setWaiting(run: ActiveRun, holder?: LeaseHolder): void {
    if (holder) run.meta.waitingFor = waitingOn(holder);
    else delete run.meta.waitingFor;
    this.persist(run.meta);
    this.safeEmit('run', run.meta);
  }

  /**
   * A sub-graph step, once its inner last steps all succeeded (sub-graphs spec §4.1): it calls no model, runs no command,
   * takes no lease and asks nothing. Its output is each inner last step's output in run order, under its own heading.
   */
  private collect(run: ActiveRun, nodeId: string): void {
    const { meta } = run;
    run.running.set(nodeId, new AbortController());
    this.setNode(run, nodeId, { status: 'running', startedAt: this.clock() });
    const startedAt = Date.now();
    Promise.resolve()
      .then((): NodeOutcome => {
        this.emitEvent(run, nodeId, { type: 'start', kind: 'graph', cwd: this.deps.projectDir });
        // A stop step inside the sub-graph is one of its last steps, but has no output to collect.
        const lasts = new Set(upstream(meta.snapshot, nodeId).filter((id) => meta.snapshot.nodes.find((n) => n.id === id)?.kind !== 'stop'));
        const sections = topoOrder(meta.snapshot)
          .filter((id) => lasts.has(id))
          .map((id) => {
            const title = meta.snapshot.nodes.find((n) => n.id === id)?.title ?? '';
            const output = this.deps.runStore.readOutput(meta.id, id).trim();
            return `### ${id.slice(nodeId.length + 1)} · ${title}\n${output || '(no output)'}\nFull output: ${this.deps.runStore.outputRelPath(meta.id, id)}`;
          });
        return { ok: true, output: sections.join('\n\n') };
      })
      .catch((e: unknown): NodeOutcome => ({ ok: false, output: '', error: e instanceof Error ? e.message : String(e) }))
      .then((outcome) => this.complete(run, nodeId, outcome, Date.now() - startedAt))
      .catch((e: unknown) => this.failInternally(run, nodeId, e));
  }

  /** A condition step: no model call. It reads the verdict its parent wrote, and fails if the parent wrote none (spec §3). */
  private decide(run: ActiveRun, nodeId: string): void {
    run.running.set(nodeId, new AbortController());
    this.setNode(run, nodeId, { status: 'running', startedAt: this.clock() });
    Promise.resolve()
      .then(() => {
        const [parent] = upstream(run.meta.snapshot, nodeId);
        const verdict = readVerdict(this.deps.runStore.readOutput(run.meta.id, parent));
        if (!verdict) return this.complete(run, nodeId, { ok: false, output: '', error: `no VERDICT line in ${parent} output` }, 0);
        this.setNode(run, nodeId, { verdict });
        this.complete(run, nodeId, { ok: true, output: `VERDICT: ${verdict}` }, 0);
      })
      .catch((e: unknown) => this.failInternally(run, nodeId, e));
  }

  /** A stop step: halts the run (spec §3). Its own outcome is succeeded; the run reads `stopped` at the end. */
  private stopRun(run: ActiveRun, nodeId: string): void {
    run.running.set(nodeId, new AbortController());
    this.setNode(run, nodeId, { status: 'running', startedAt: this.clock() });
    // Halted now, inside this schedule pass: a step that is ready in the same pass is skipped, never launched (spec §3).
    this.halt(run, nodeId);
    Promise.resolve()
      .then(() => this.complete(run, nodeId, { ok: true, output: '' }, 0))
      .catch((e: unknown) => this.failInternally(run, nodeId, e));
  }

  /** Stops new work. Drain leaves running steps alone; fail-fast also aborts them. A run the user stopped stays cancelled. */
  private halt(run: ActiveRun, stopId: string): void {
    if (run.stopping) return;
    run.halted = stopId;
    run.meta.stoppedBy = stopId;
    this.persist(run.meta);
    this.skipQueued(run, `run stopped at ${stopId}`);
    const failFast = run.meta.snapshot.nodes.find((n) => n.id === stopId)?.failFast === true;
    if (!failFast) return;
    for (const [id, controller] of [...run.running]) {
      if (id === stopId) continue;
      run.abortedByStop.add(id);
      try {
        controller.abort();
      } catch (e) {
        // An abort listener that throws must not stop the halt half way, or escape the schedule pass.
        console.error('[agent-stream] could not cancel step', id, 'of run', run.meta.id, e);
      }
    }
  }

  private launch(run: ActiveRun, nodeId: string): void {
    const { meta } = run;
    const node = meta.snapshot.nodes.find((n) => n.id === nodeId)!;
    if (node.kind === 'graph') return this.collect(run, nodeId);
    if (node.kind === 'condition') return this.decide(run, nodeId);
    if (node.kind === 'stop') return this.stopRun(run, nodeId);
    const controller = new AbortController();
    run.running.set(nodeId, controller);
    this.deps.broker.beginStep(run.meta.id, nodeId);
    this.setNode(run, nodeId, { status: 'running', startedAt: this.clock() });
    const startedAt = Date.now();
    const executor = node.kind === 'agent' ? (run.agent ?? this.deps.executors.agent) : this.deps.executors.command;
    // What the run resolved for this step when it started; a step added during the run gets the run's own (spec §3.1).
    const use: StepModelUse | undefined = node.kind === 'agent' ? (meta.stepModels?.[nodeId] ?? { model: meta.model, effort: meta.effort }) : undefined;
    let noted = false;
    /** Lines for the step's log right after it starts: why it doesn't run its own model, which attachments are missing. */
    let notes: string[] = use?.note ? [use.note] : [];
    const emit = (event: NodeEventBody) => {
      this.emitEvent(run, nodeId, event);
      if (event.type === 'start' && !noted) {
        noted = true;
        for (const text of notes) this.emitEvent(run, nodeId, { type: 'text', text });
      }
    };
    Promise.resolve()
      .then(() => {
        const workspace = workspaceOf(node);
        const worktree = workspace === null ? undefined : run.workspaces[workspace];
        if (workspace !== null && !worktree) throw new Error(`Step ${nodeId} uses workspace "${workspace}", but this run has no worktree for it.`);
        const place = worktree && { ...worktree, path: variantWorkDir(worktree.path, meta.checkout?.root, this.deps.projectDir) };
        if (place && place.path !== worktree.path && !existsSync(place.path)) {
          const sub = relative(worktree.path, place.path);
          const outcome: NodeOutcome = { ok: false, output: '', error: `Workspace "${workspace}" has no ${sub} folder: its worktree holds only committed files, so commit that folder first.` };
          return outcome;
        }
        // Inside the chain so a failure reading upstream outputs fails this node instead of escaping.
        const upstreamResults = upstream(meta.snapshot, nodeId).map((parentId) => {
          const rel = this.deps.runStore.outputRelPath(meta.id, parentId);
          const graphName = meta.scopes?.[parentId]?.graphName;
          return {
            node: executionNode(meta, parentId),
            state: meta.nodes[parentId],
            output: this.deps.runStore.readOutput(meta.id, parentId),
            // Relative to the folder; a step working in a worktree needs the full path (Review Focus 3).
            outputPath: place ? join(this.deps.projectDir, rel) : rel,
            ...(graphName && { graphName }),
          };
        });
        // A step inside a sub-graph gets that graph's goal, instructions and attachments, not the run's graph's (sub-graphs spec §4.3).
        const scope = scopeOf(meta.scopes, nodeId);
        const texts = scope ? (meta.rendered?.scopes?.[scope.stepId] ?? { goal: '', instructions: '' }) : meta.rendered;
        const graph = texts ? { ...meta.snapshot, goal: texts.goal, instructions: texts.instructions } : meta.snapshot;
        const execNode = executionNode(meta, nodeId);
        // The prompt names the inner graph's own workspace name; the folder is the scoped one's (spec §4.3).
        const prompted = scope && execNode.workspace ? { ...execNode, workspace: execNode.workspace.slice(folderId(scope.stepId).length + 1) } : execNode;
        // An agent step a condition reads ends its reply with a verdict line; the saved graph is unchanged (spec §3).
        const verdictLine = verdictInstructionFor(meta.snapshot, nodeId);
        const prompt = node.kind === 'agent' ? [buildNodePrompt(graph, prompted, upstreamResults, place), verdictLine].filter(Boolean).join('\n\n') : '';
        const cwd = place?.path ?? this.deps.projectDir;
        const filesGraph = scope ? { ...meta.snapshot, id: scope.graphId, attachments: scope.attachments } : meta.snapshot;
        const files = stepAttachments({ store: this.attachmentStore, graph: filesGraph, node, cwd, worktree: !!place });
        notes = [...notes, ...files.filter((f) => f.missing).map((f) => missingAttachmentLine(filesGraph.id, f.name))];
        return executor({
          runId: meta.id,
          graph,
          node: execNode,
          prompt,
          // Agents get the variant path as their working directory; commands run there (spec §4.3a).
          cwd,
          signal: controller.signal,
          emit,
          ...(use?.model && { model: use.model }),
          ...(use?.effort && { effort: use.effort }),
          ...(files.length > 0 && { attachments: files, readAttachment: storeReader(this.attachmentStore, filesGraph.id, files) }),
          ...(scope && { scopeName: scope.graphName }),
        });
      })
      .catch((e: unknown): NodeOutcome => ({ ok: false, output: '', error: e instanceof Error ? e.message : String(e) }))
      .then((outcome) => this.complete(run, nodeId, outcome, Date.now() - startedAt))
      .catch((e: unknown) => this.failInternally(run, nodeId, e));
  }

  /** Last resort: a run must always reach finish, and nothing may escape as an unhandled rejection. */
  private failInternally(run: ActiveRun, nodeId: string, e: unknown): void {
    console.error('[agent-stream] internal error in run', run.meta.id, 'node', nodeId, e);
    const status = run.meta.nodes[nodeId]?.status;
    if (run.running.has(nodeId) || status === 'running' || status === 'waiting_approval') {
      run.running.delete(nodeId);
      run.waiting.delete(nodeId);
      this.deps.broker.endStep(run.meta.id, nodeId);
      this.setNode(run, nodeId, {
        status: 'failed',
        endedAt: this.clock(),
        error: `Agent Stream internal error: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
    this.schedule(run);
  }

  private complete(run: ActiveRun, nodeId: string, outcome: NodeOutcome, durationMs: number): void {
    run.running.delete(nodeId);
    run.waiting.delete(nodeId);
    // The step is no longer running: its Allow all for this step allowance is deleted, and a card it left open can no longer set one.
    this.deps.broker.endStep(run.meta.id, nodeId);
    try {
      this.deps.runStore.writeOutput(run.meta.id, nodeId, outcome.output);
    } catch (e) {
      console.error('[agent-stream] could not write output for run', run.meta.id, nodeId, e);
    }
    this.emitEvent(run, nodeId, { type: 'result', ok: outcome.ok, durationMs, error: outcome.error, exitCode: outcome.exitCode, usage: outcome.usage });
    // A step cut short by Stop or by a fail-fast stop step reads cancelled, not failed.
    const cut = run.stopping || run.abortedByStop.has(nodeId);
    const status: NodeStatus = outcome.ok ? 'succeeded' : cut ? 'cancelled' : 'failed';
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
    } else if (body.type === 'approval_decided' && !body.auto) {
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
    this.deps.broker.forgetRun(run.meta.id);
    this.endWait(run);
    delete run.meta.waitingFor;
    const statuses = Object.values(run.meta.nodes).map((s) => s.status);
    // A run is settled when every step succeeded, was skipped, or was cancelled by its stop step.
    const settled = statuses.every((s) => DONE_OK.has(s) || s === 'skipped' || (s === 'cancelled' && run.meta.stoppedBy !== undefined));
    run.meta.status = run.stopping ? 'cancelled' : !settled ? 'failed' : run.meta.stoppedBy ? 'stopped' : 'succeeded';
    run.meta.endedAt = this.clock();
    this.persist(run.meta);
    this.runs.delete(run.meta.id);
    // Released at any final status (spec §4.3): waiting runs hear it through onRelease.
    if (run.holdsLease) {
      run.holdsLease = false;
      this.releaseLease(run.leaseRoot, run.meta.id);
    }
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
  if (node.kind === 'graph') return node;
  return node.kind === 'command' ? { ...node, command: text } : { ...node, prompt: text };
}

/** A variant step works in the same subfolder of its worktree as the opened folder is of its checkout (e.g. analytics/dbt), so commands find the same project files. */
export function variantWorkDir(worktree: string, checkoutRoot: string | undefined, projectDir: string): string {
  if (!checkoutRoot) return worktree;
  const sub = relative(checkoutRoot, realOrResolved(projectDir));
  return sub && !sub.startsWith('..') && !isAbsolute(sub) ? join(worktree, sub) : worktree;
}
