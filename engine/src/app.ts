import type { renameSync } from 'node:fs';
import {
  defaultEffortsFor,
  findModel,
  isWriteCapable,
  refinable,
  runStepModels,
  validateRunnable,
  workspaceOf,
  type AgentChange,
  type ApprovalRequest,
  type CheckoutInfo,
  type ProviderStatus,
  type ChatEntry,
  type ClientMessage,
  type Graph,
  type GraphFileError,
  type GraphListItem,
  type GraphNode,
  type GraphResult,
  type LeaseHolder,
  type ModelChoice,
  type ModelSelection,
  type NodeEvent,
  type NodeStatus,
  type NodeRunState,
  type Op,
  type OpRecord,
  type RunMeta,
  type ServerMessage,
  type Session,
  type SessionResult,
  type SessionTab,
  supportsEffort,
} from '@agent-stream/shared';
import { ApprovalBroker } from './approvals';
import { systemClock, type Clock } from './clock';
import { createCommandExecutor } from './commandExecutor';
import type { Executors, NodeExecutor } from './executors';
import { inspectCheckout, type GitExec } from './git';
import { GraphStore, type FileSync } from './graphStore';
import { migrateGraphsToMarkdown, migrateProjectFolder, migrateValuesFile } from './migrate';
import { ensureDataDirs, projectPaths } from './paths';
import { Planner } from './planner';
import { refineRequest, splitRequest } from './refine';
import { GIT_BASH_MISSING, type Found } from './platform';
import { createStepGate, STEP_GRAPH_TOOL_PREFIX } from './providers/toolGate';
import type { AgentProvider } from './providers/types';
import { previewRun, envLookup, type PreviewOutcome } from './runPreview';
import { needsCheckoutLease, Runner } from './runner';
import { buildRunReport } from './runReport';
import { RunStore } from './runStore';
import { createStepGraphTools } from './stepGraphTools';
import { migrateLegacy, SessionStore } from './sessionStore';
import type { EnvLookup } from './templates';
import { VariableValues } from './variableValues';
import { createVariantWorkspaces, removeWorkspace } from './variantWorkspaces';
import type { LeaseBlock, WriteLeases } from './writeLease';

/** Run states in which a step's definition may still be read: a revert must wait for them. */
const IN_PROGRESS = new Set<NodeStatus | undefined>(['queued', 'running', 'waiting_approval']);

export const CHANGED_SINCE_REVIEW = 'Something changed since you reviewed this run (a step, a variable or an environment variable). Review it again.';

export type Client = { send(msg: ServerMessage): void };

export type AppDeps = {
  projectDir: string;
  /**
   * Where this machine keeps the project's variable values: `valuesFileFor(projectDir)`, outside
   * the project. Required, so nothing (a test included) writes into the home folder by default.
   */
  valuesFile: string;
  /** The pre-rename values file (see legacyValuesFileFor): moved to valuesFile on startup, and denied to agents meanwhile. */
  legacyValuesFile?: string;
  /** For tests: replaces fs.renameSync in the migrations. */
  rename?: typeof renameSync;
  /** Runs agent steps and planner turns. */
  provider: AgentProvider;
  status: ProviderStatus;
  /**
   * The settings' default model and effort ('' or absent: none, Claude Code's own default), read when a run starts and on
   * every planner turn of a conversation without its own choice. Never written into a graph.
   */
  modelDefaults?: () => ModelSelection;
  maxParallel: number;
  /** For tests: replaces the step executors (agent steps then ignore the provider). */
  executors?: Executors;
  clock?: Clock;
  env?: EnvLookup;
  platform?: NodeJS.Platform;
  /** Windows: where Git Bash is (see findGitBash), or why it can't be found. */
  gitBash?: Found;
  /** The extension host's write leases, shared by every folder's engine (spec §4.2). */
  leases: WriteLeases;
  /** Runs git: realGit in VS Code; tests pass a fake, so none runs real git. */
  git: GitExec;
  /** The home folder: variant worktrees live in ~/.agent-stream/worktrees (spec §4.3a). Required, so no test writes to the real one. */
  home: string;
};

export type App = ReturnType<typeof createApp>;

/** The runBlocked message (spec §4.5), naming an unreadable lock file when there is one (ruling R6). */
export function blockedMessage(o: { graphName: string; holder: LeaseHolder; holderName: string; otherWindow: boolean; root: string; lockFile?: string }): string {
  const text = `"${o.graphName}" can't start: run ${o.holder.runId}${o.otherWindow ? ' in another VS Code window' : ''} of "${o.holderName}" is already changing files in this checkout (${o.root}). Separate tickets need separate worktrees.`;
  return o.lockFile ? `${text} Its lock file ${o.lockFile} can't be read; delete it if no run is changing files.` : text;
}

/** A variant workspace a run recorded and Manage Run Workspaces hasn't removed (spec §5.5). */
export type RunWorkspaceItem = { runId: string; graphId: string; graphName: string; name: string; path: string; head: string; checkoutRoot: string; running: boolean };

export function createApp(d: AppDeps) {
  let provider = d.provider;
  let status = d.status;
  const clock = d.clock ?? systemClock;
  /** The settings' defaults with empty values dropped. */
  const modelDefaults = (): ModelSelection => {
    const m = d.modelDefaults?.() ?? {};
    return { ...(m.model && { model: m.model }), ...(m.effort && { effort: m.effort }) };
  };
  /** A provider's models; [] when it can't list them. `retry`: a failed list may be tried once more (a chat opening). */
  const listModels = async (p: AgentProvider = provider, o?: { retry?: boolean }): Promise<ModelChoice[]> => {
    try {
      return (await (o ? p.listModels?.(o) : p.listModels?.())) ?? [];
    } catch (e) {
      console.error('[agent-stream] could not list models', e);
      return [];
    }
  };
  /** Providers asked for their models in the background (a preview with nothing cached): once each per window. */
  const prefetched = new WeakSet<AgentProvider>();
  /** The models already listed, never waiting; the first miss starts one background fetch. */
  const knownModels = (): ModelChoice[] | undefined => {
    const known = provider.knownModels?.();
    if (!known && provider.listModels && !prefetched.has(provider)) {
      prefetched.add(provider);
      void listModels(provider);
    }
    return known;
  };
  const paths = projectPaths(d.projectDir);
  const migrationWarnings = migrateProjectFolder(d.projectDir, d.rename);
  if (d.legacyValuesFile) migrationWarnings.push(...migrateValuesFile(d.valuesFile, d.legacyValuesFile, d.rename));
  ensureDataDirs(paths);
  const graphStore = new GraphStore(paths, clock);
  const sessions = new SessionStore(paths, clock);
  // Planner state and chats from before work sessions move into the Default session.
  const legacyMoveFailed = new Set<string>();
  migrationWarnings.push(...migrateLegacy(paths, sessions, undefined, legacyMoveFailed));
  // After the planner-state move above, which reads the old JSON graph files; a graph whose move failed stays JSON for its retry.
  const converted = migrateGraphsToMarkdown(paths, graphStore, d.rename, legacyMoveFailed);
  migrationWarnings.push(...converted.warnings);
  sessions.ensureDefault();
  const runStore = new RunStore(paths);
  const platform = d.platform ?? process.platform;
  const env = d.env ?? envLookup(process.env, platform);
  const values = new VariableValues(d.valuesFile, platform);
  /** Why command steps can't run on this machine, shown in every run preview that has command steps. */
  const commandShellProblem: string | null = platform === 'win32' ? (d.gitBash?.ok ? null : (d.gitBash?.error ?? GIT_BASH_MISSING)) : null;
  runStore.recoverInterrupted(clock());
  const broker = new ApprovalBroker(clock);
  /** The variable values files: no agent or planner may read them. */
  const privateFiles = () => [d.valuesFile, d.legacyValuesFile].filter((f): f is string => !!f);
  /** A step's prompt or command filled in with the graph's values, exactly as a run would, with the preview's warnings; or the first problem. */
  function renderNode(graph: Graph, node: GraphNode): { ok: true; text: string; warnings: string[] } | { ok: false; error: string } {
    const { preview } = previewRun({ graph: { ...graph, nodes: [node], edges: [] }, values: values.get(graph.id), env, commandShellProblem });
    const text = preview.steps[0]?.text;
    if (preview.problems.length || text === undefined) return { ok: false, error: preview.problems[0] ?? `${node.id} could not be filled in.` };
    return { ok: true, text, warnings: preview.warnings };
  }
  /**
   * Agent steps on `p`, each asking the user through its own step gate. A step that can change files also gets the graph
   * tools (add_step, change_step), which ask the user themselves, so the gate lets them through. A read-only step gets no
   * graph tools, and its gate refuses everything that isn't read-only without asking (spec §4.4).
   */
  const agentFor =
    (p: AgentProvider): NodeExecutor =>
    (ctx) => {
      const readOnly = !isWriteCapable(ctx.node);
      const graphTools = readOnly ? [] : createStepGraphTools({ ctx, graphStore, runner, broker, render: renderNode, signal: ctx.signal });
      return p.runStep(
        { ...ctx, graphTools },
        createStepGate({
          broker,
          runId: ctx.runId,
          graphId: ctx.graph.id,
          nodeId: ctx.node.id,
          nodeTitle: ctx.node.title,
          projectDir: ctx.cwd,
          runsRoot: d.projectDir,
          privateFiles: privateFiles(),
          signal: ctx.signal,
          emit: ctx.emit,
          readOnly,
          selfApproving: new Set(graphTools.map((t) => STEP_GRAPH_TOOL_PREFIX + t.name)),
        }),
      );
    };
  const executors = d.executors ?? {
    agent: agentFor(provider),
    command: createCommandExecutor({ platform, gitBashPath: d.gitBash?.ok ? d.gitBash.path : undefined }),
  };
  const runner = new Runner({ runStore, broker, executors, projectDir: d.projectDir, maxParallel: d.maxParallel, clock, leases: d.leases });
  const inspect = (): Promise<CheckoutInfo> => inspectCheckout(d.projectDir, d.git);
  async function checkoutMessage(): Promise<ServerMessage> {
    const info = await inspect();
    const lease = d.leases.holder(info.root);
    return { type: 'checkout', info, ...(lease && { lease }) };
  }
  /** Inspects the checkout and sends it; a failure is logged, never thrown into a run or a client. */
  function sendCheckout(send: (msg: ServerMessage) => void): void {
    checkoutMessage().then(send, (e: unknown) => console.error('[agent-stream] could not inspect the checkout', e));
  }
  /** The holder's graph name, read from its own folder: another workspace folder or window may hold the lease. */
  function holderGraphName(holder: LeaseHolder): string {
    if (!holder.folder) return holder.graphId;
    const store = holder.folder === d.projectDir ? graphStore : new GraphStore(projectPaths(holder.folder));
    const r = store.load(holder.graphId);
    return r.ok ? r.graph.name : holder.graphId;
  }
  const clients = new Set<Client>();
  const broadcast = (msg: ServerMessage) => {
    for (const c of clients) c.send(msg);
  };
  /** The one planner conversation each client shows (openChat). */
  const chatSubscriptions = new Map<Client, { graphId: string; sessionId: string }>();
  const toConversation = (sessionId: string, graphId: string, msg: ServerMessage) => {
    for (const [c, sub] of chatSubscriptions) if (sub.graphId === graphId && sub.sessionId === sessionId) c.send(msg);
  };

  /** Planner's request_run: validate, then let the user confirm in the browser. */
  function listGraphs(): GraphListItem[] {
    const latest = runStore.latestByGraph();
    return graphStore.list().map((g) => {
      const run = latest.get(g.id);
      return run ? { ...g, lastRun: { status: run.status, startedAt: run.startedAt } } : g;
    });
  }
  const broadcastGraphs = () => broadcast({ type: 'graphs', graphs: listGraphs() });

  function createGraph(name: string): Graph {
    const graph = graphStore.create(name);
    broadcastGraphs();
    return graph;
  }
  function renameGraph(id: string, name: string): GraphResult {
    const r = graphStore.rename(id, name);
    if (r.ok) broadcastGraphs();
    return r;
  }
  function duplicateGraph(id: string): GraphResult {
    const r = graphStore.duplicate(id);
    if (r.ok) {
      values.copyGraph(id, r.graph.id);
      broadcastGraphs();
    }
    return r;
  }
  function deleteGraph(id: string): { ok: true } | { ok: false; error: string } {
    if (runner.activeFor(id)) return { ok: false, error: 'Stop the run first.' };
    if (planner.isBusyInGraph(id)) return { ok: false, error: "The planner is still working on this graph. Try again when it's done." };
    const r = graphStore.delete(id);
    if (!r.ok) return r;
    values.deleteGraph(id);
    agentChangeCounts.delete(id);
    markdownSent.delete(id);
    try {
      sessions.removeGraph(id);
    } catch (e) {
      // The graph is gone either way: clients still hear about it.
      console.error('[agent-stream] could not clean sessions', e);
    }
    broadcast({ type: 'graphDeleted', graphId: id });
    broadcastGraphs();
    return r;
  }
  function importGraph(content: string): GraphResult {
    const r = graphStore.importGraph(content);
    if (r.ok) broadcastGraphs();
    return r;
  }

  function requestRun(graphId: string, fromNodeId?: string): string | null {
    const r = graphStore.load(graphId);
    if (!r.ok) return r.error;
    const problems = validateRunnable(r.graph);
    if (problems.length) return `The graph can't run yet:\n${problems.join('\n')}`;
    if (runner.activeFor(graphId)) return 'A run is already in progress.';
    let sourceRunId: string | undefined;
    if (fromNodeId) {
      if (!r.graph.nodes.some((n) => n.id === fromNodeId)) return `node ${fromNodeId} does not exist`;
      sourceRunId = runStore.list(graphId)[0]?.id;
      if (!sourceRunId) return 'There is no previous run to re-run from.';
    }
    broadcast({ type: 'confirmRun', graphId, fromNodeId, sourceRunId, requestedBy: 'planner' });
    return null;
  }

  const planner = new Planner({ graphStore, runStore, sessions, projectDir: d.projectDir, provider: () => provider, modelDefaults,
    privateFiles,
    requestRun,
    checkout: async () => {
      const info = await inspect();
      const lease = d.leases.holder(info.root);
      return { info, ...(lease && { lease }) };
    },
    clock,
  });

  /** Work sessions: the store's 'changed' event broadcasts the list. */
  function listSessions() {
    return sessions.list();
  }
  /** Throws on a blank name: the caller validates it. */
  function createSession(name: string): Session {
    return sessions.create(name);
  }
  function renameSession(id: string, name: string): SessionResult {
    return sessions.rename(id, name);
  }
  function duplicateSession(id: string): SessionResult {
    return sessions.duplicate(id);
  }
  function deleteSession(id: string): { ok: true } | { ok: false; error: string } {
    if (planner.isBusyInSession(id)) return { ok: false, error: "The planner is still working in this session. Try again when it's done." };
    return sessions.delete(id);
  }
  function saveSessionTabs(id: string, tabs: SessionTab[], activeGraphId?: string): void {
    sessions.saveTabs(id, tabs, activeGraphId);
  }

  values.on('changed', (graphId: string, vals: Record<string, string>) => broadcast({ type: 'variableValues', graphId, values: vals }));
  graphStore.on('op', (graphId: string, op: Op, via?: OpRecord['via']) => {
    if (op.type === 'renameVariable') values.rename(graphId, op.name, op.newName);
    // A file edit (a branch switch, a hand edit) never deletes a saved value: the variable may come back with the file.
    if (op.type === 'deleteVariable' && via !== 'file') values.delete(graphId, op.name);
  });
  /** Each graph's agent-change count as last broadcast, so the graphs list follows it. */
  const agentChangeCounts = new Map<string, number>();
  /** The Markdown text last sent for each graph a tab's Markdown editor asked for (getGraphMarkdown): those tabs follow the file. */
  const markdownSent = new Map<string, string>();
  /** Sends a watched graph's Markdown file to the tabs when its text changed since it was last sent. */
  function sendMarkdownIfChanged(graphId: string): void {
    if (!markdownSent.has(graphId)) return;
    const text = graphStore.markdownText(graphId);
    if (text === undefined || text === markdownSent.get(graphId)) return;
    markdownSent.set(graphId, text);
    broadcast({ type: 'graphMarkdown', graphId, text });
  }
  graphStore.on('changed', (graph: Graph) => {
    const r = review(graph.id);
    broadcast({ type: 'graph', graph, ...r });
    if ((agentChangeCounts.get(graph.id) ?? 0) !== r.changes.length) {
      agentChangeCounts.set(graph.id, r.changes.length);
      broadcastGraphs();
    }
    sendMarkdownIfChanged(graph.id);
  });
  graphStore.on('fileErrors', (graphId: string, errors: GraphFileError[]) => {
    broadcast({ type: 'graphFileErrors', graphId, errors });
    sendMarkdownIfChanged(graphId);
  });
  graphStore.on('fileDeleted', (graphId: string) => {
    agentChangeCounts.delete(graphId);
    broadcast({ type: 'graphDeleted', graphId, reason: 'file' });
    broadcastGraphs();
  });
  /** The extension's file watcher saw `<id>.md` or `<id>.meta.json` change (Markdown graph files spec §6.2). */
  function graphFileChanged(id: string): FileSync {
    const r = graphStore.graphFileChanged(id);
    fileSynced(id, r);
    return r;
  }
  /** Tells the clients what reading the graph's Markdown file did (graphFileChanged, or a save from the Markdown editor). */
  function fileSynced(id: string, r: FileSync): void {
    if (r === 'added') {
      // The store emits nothing for a new or restored file: a tab showing this id gets the graph itself too.
      const g = graphStore.load(id);
      if (g.ok) broadcast({ type: 'graph', graph: g.graph, ...review(id) });
    }
    if (r === 'added' || r === 'applied' || r === 'errors') broadcastGraphs();
    // A broken file edited again with the same problems emits nothing: its text still changed.
    sendMarkdownIfChanged(id);
  }
  /** The Markdown editor's Save (Graph | Markdown toggle): the store writes the text and reads it like an outside edit. */
  function saveGraphMarkdown(client: Client, msg: Extract<ClientMessage, { type: 'saveGraphMarkdown' }>): void {
    const { graphId } = msg;
    let r: ReturnType<GraphStore['saveMarkdown']>;
    try {
      r = graphStore.saveMarkdown(graphId, msg.text, msg.base, msg.force);
    } catch (e) {
      r = { ok: false, error: `Could not save ${graphId}.md (${e instanceof Error ? e.message : String(e)}).` };
    }
    if (!r.ok) return client.send({ type: 'graphMarkdownSaved', graphId, ok: false, ...('conflict' in r ? { conflict: true } : { error: r.error }) });
    fileSynced(graphId, r.sync);
    const errors = graphStore.fileErrors(graphId);
    client.send({ type: 'graphMarkdownSaved', graphId, ok: errors.length === 0, text: graphStore.markdownText(graphId), ...(errors.length > 0 && { errors }) });
  }
  /** The extension's file watcher saw `<id>.md` deleted: the store's fileDeleted event tells the clients. */
  function graphFileDeleted(id: string): FileSync {
    return graphStore.graphFileDeleted(id);
  }
  /** Each active run's last announced state: the checkout chip follows a run that starts, ends or stops waiting (spec §4.5). */
  const announced = new Map<string, string>();
  runner.on('run', (run: RunMeta) => {
    broadcast({ type: 'run', run });
    broadcast({ type: 'runs', graphId: run.graphId, runs: runStore.list(run.graphId) });
    broadcastGraphs();
    const state = `${run.status}|${run.waitingFor?.runId ?? ''}`;
    if (announced.get(run.id) === state) return;
    if (run.status === 'running') announced.set(run.id, state);
    else announced.delete(run.id);
    sendCheckout(broadcast);
  });
  runner.on('node', (runId: string, nodeId: string, state: NodeRunState) => broadcast({ type: 'runNode', runId, nodeId, state }));
  runner.on('event', (runId: string, nodeId: string, event: NodeEvent) => broadcast({ type: 'nodeEvent', runId, nodeId, event }));
  broker.on('changed', (approvals: ApprovalRequest[]) => broadcast({ type: 'approvals', approvals }));
  sessions.on('changed', () => broadcast({ type: 'sessions', sessions: sessions.list() }));
  planner.on('entry', (sessionId: string, graphId: string, entry: ChatEntry) => toConversation(sessionId, graphId, { type: 'chatEntry', graphId, sessionId, entry }));
  planner.on('busy', (sessionId: string, graphId: string, busy: boolean) => toConversation(sessionId, graphId, { type: 'chatBusy', graphId, sessionId, busy }));
  planner.on('cleared', (sessionId: string, graphId: string) => toConversation(sessionId, graphId, { type: 'chatOpened', graphId, sessionId, chat: [], busy: false, ...choiceOf(sessionId, graphId) }));

  /** A conversation's own model and effort choice (absent fields: Default). */
  function choiceOf(sessionId: string, graphId: string): ModelSelection {
    const { model, effort } = sessions.plannerState(sessionId, graphId);
    return { ...(model && { model }), ...(effort && { effort }) };
  }
  /**
   * Sends the provider's models to one client, with the levels the menu's Default offers: after it opens a chat (which may
   * retry a failed list once), when the provider changes, and when the settings' defaults change. A client that left gets nothing.
   */
  function sendModels(client: Client, p: AgentProvider = provider, o?: { retry?: boolean }): void {
    void listModels(p, o).then((models) => {
      if (clients.has(client) && p === provider) client.send({ type: 'models', provider: p.id, models, defaultEfforts: defaultEffortsFor(models, modelDefaults().model) });
    });
  }
  /** The settings' default model or effort changed: the chats' Default menus follow. Runs and turns read them when they start. */
  function modelDefaultsChanged(): void {
    for (const c of chatSubscriptions.keys()) sendModels(c);
  }

  async function preview(
    graph: Graph,
    fromNodeId?: string,
    sourceRunId?: string,
  ): Promise<{ ok: true; outcome: PreviewOutcome; checkout: CheckoutInfo } | { ok: false; error: string }> {
    let source: RunMeta | undefined;
    if (sourceRunId) {
      source = runStore.get(sourceRunId);
      if (!source || source.graphId !== graph.id) return { ok: false, error: `run ${sourceRunId} not found` };
    }
    const checkout = await inspect();
    return { ok: true, checkout, outcome: previewRun({ graph, values: values.get(graph.id), env, source, fromNodeId, commandShellProblem, checkout }) };
  }

  /** The pending agent changes and the baseline they are against, for graphOpened and graph. */
  function review(graphId: string): { baseline?: Graph; changes: AgentChange[] } {
    const base = graphStore.baseline(graphId);
    return { ...(base.ok && base.graph && { baseline: base.graph }), changes: graphStore.agentChanges(graphId) };
  }

  function opened(graph: Graph): ServerMessage {
    const runs = runStore.list(graph.id);
    const run = runner.activeFor(graph.id) ?? (runs[0] ? runStore.get(runs[0].id) : undefined);
    const fileErrors = graphStore.fileErrors(graph.id);
    return { type: 'graphOpened', graph, runs, run, variableValues: values.get(graph.id), ...review(graph.id), ...(fileErrors.length > 0 && { fileErrors }) };
  }

  /** A revert would change a step that a run in progress is about to run or is running. */
  function revertBlockedByRun(graphId: string, op: Op): boolean {
    if (op.type !== 'revertChange') return false;
    const run = runner.activeFor(graphId);
    if (!run) return false;
    const busy = (id: string) => IN_PROGRESS.has(run.nodes[id]?.status);
    const { target } = op;
    if (target.kind === 'all') return Object.keys(run.nodes).some(busy);
    if (target.kind === 'node') return busy(target.id);
    const edge = graphStore.agentChanges(graphId).find((c): c is Extract<AgentChange, { kind: 'edge' }> => c.kind === 'edge' && c.id === target.id);
    return !!edge && (busy(edge.from) || busy(edge.to));
  }

  /** The provider or its status changed (settings, Check again): new runs and planner turns use it; running ones keep theirs. */
  function setProvider(next: AgentProvider, nextStatus: ProviderStatus): void {
    provider = next;
    status = nextStatus;
    broadcast({ type: 'auth', status });
    for (const c of chatSubscriptions.keys()) sendModels(c, next);
  }

  /** VS Code is closing: release this engine's leases and stop every run (ruling R4, spec §8). */
  function dispose(): void {
    runner.dispose();
  }

  function startupWarnings(): string[] {
    values.get('');
    const warnings = values.problem ? [...migrationWarnings, values.problem] : [...migrationWarnings];
    for (const g of graphStore.list()) {
      const base = graphStore.baseline(g.id);
      if (!base.ok) warnings.push(base.error);
    }
    return warnings;
  }

  function connect(client: Client): () => void {
    clients.add(client);
    client.send({ type: 'hello', status, project: d.projectDir, graphs: listGraphs(), approvals: broker.pending() });
    client.send({ type: 'sessions', sessions: sessions.list() });
    // After this turn, so hello and sessions always come first (ruling R9); never to a client that left meanwhile.
    setImmediate(() => sendCheckout((msg) => clients.has(client) && client.send(msg)));
    return () => {
      clients.delete(client);
      chatSubscriptions.delete(client);
    };
  }

  async function handle(client: Client, msg: ClientMessage): Promise<void> {
    const error = (message: string) => client.send({ type: 'error', message });
    switch (msg.type) {
      case 'openGraph': {
        const r = graphStore.load(msg.graphId);
        if (!r.ok) return error(r.error);
        client.send(opened(r.graph));
        return;
      }
      case 'createGraph': {
        const graph = createGraph(msg.name);
        client.send(opened(graph));
        return;
      }
      case 'op': {
        if (revertBlockedByRun(msg.graphId, msg.op)) return client.send({ type: 'opRejected', graphId: msg.graphId, error: 'Stop the run first.' });
        const r = graphStore.apply(msg.graphId, msg.op, 'user');
        if (!r.ok) client.send({ type: 'opRejected', graphId: msg.graphId, error: r.error });
        return;
      }
      case 'getGraphMarkdown': {
        const text = graphStore.markdownText(msg.graphId);
        if (text === undefined) return error(`graph "${msg.graphId}" not found`);
        markdownSent.set(msg.graphId, text);
        client.send({ type: 'graphMarkdown', graphId: msg.graphId, text });
        return;
      }
      case 'saveGraphMarkdown':
        return saveGraphMarkdown(client, msg);
      case 'openChat': {
        const g = graphStore.load(msg.graphId);
        if (!g.ok) return error(g.error);
        const s = sessions.load(msg.sessionId);
        if (!s.ok) return error(s.error);
        chatSubscriptions.set(client, { graphId: msg.graphId, sessionId: msg.sessionId });
        const busy = planner.isBusy(msg.sessionId, msg.graphId);
        const choice = choiceOf(msg.sessionId, msg.graphId);
        if (provider.listModels) sendModels(client, provider, { retry: true });
        let chat: ChatEntry[];
        try {
          chat = sessions.chatLog(msg.sessionId).read(msg.graphId);
        } catch (e) {
          // Spec §7: shown as empty plus a warning; the file is left for the user to fix.
          client.send({ type: 'chatOpened', graphId: msg.graphId, sessionId: msg.sessionId, chat: [], busy, ...choice });
          return error(`The planner chat for ${msg.graphId} in this session could not be read (${e instanceof Error ? e.message : String(e)}); it shows as empty and the file is left untouched.`);
        }
        client.send({ type: 'chatOpened', graphId: msg.graphId, sessionId: msg.sessionId, chat, busy, ...choice });
        return;
      }
      case 'chat': {
        if (!status.ok) return error(`Chat is disabled: ${status.error}`);
        const g = graphStore.load(msg.graphId);
        if (!g.ok) return error(g.error);
        const s = sessions.load(msg.sessionId);
        if (!s.ok) return error(s.error);
        planner.send(msg.sessionId, msg.graphId, msg.text).catch((e: unknown) => console.error('[agent-stream] planner error', e));
        return;
      }
      case 'refineSteps': {
        const g = graphStore.load(msg.graphId);
        if (!g.ok) return error(g.error);
        const s = sessions.load(msg.sessionId);
        if (!s.ok) return error(s.error);
        for (const id of msg.nodeIds) {
          const node = g.graph.nodes.find((n) => n.id === id);
          if (!node) return error(`node ${id} does not exist`);
          if (!refinable(node)) return error('Write what the step should do first.');
        }
        if (!status.ok) return error(`Chat is disabled: ${status.error}`);
        const r = refineRequest(msg.nodeIds);
        planner.send(msg.sessionId, msg.graphId, r.prompt, { display: r.display }).catch((e: unknown) => console.error('[agent-stream] planner error', e));
        return;
      }
      case 'splitStep': {
        const g = graphStore.load(msg.graphId);
        if (!g.ok) return error(g.error);
        const s = sessions.load(msg.sessionId);
        if (!s.ok) return error(s.error);
        const node = g.graph.nodes.find((n) => n.id === msg.nodeId);
        if (!node) return error(`node ${msg.nodeId} does not exist`);
        if (!refinable(node)) return error('Write what the step should do first.');
        if (!status.ok) return error(`Chat is disabled: ${status.error}`);
        const r = splitRequest(msg.nodeId);
        planner.send(msg.sessionId, msg.graphId, r.prompt, { display: r.display }).catch((e: unknown) => console.error('[agent-stream] planner error', e));
        return;
      }
      case 'newChat': {
        const s = sessions.load(msg.sessionId);
        if (!s.ok) return error(s.error);
        const r = planner.newChat(msg.sessionId, msg.graphId);
        if (!r.ok) return error(r.error);
        return;
      }
      case 'stopPlanner': {
        planner.stop(msg.sessionId, msg.graphId);
        return;
      }
      case 'setPlannerModel': {
        const g = graphStore.load(msg.graphId);
        if (!g.ok) return error(g.error);
        const s = sessions.load(msg.sessionId);
        if (!s.ok) return error(s.error);
        // Absent fields clear the choice (Default). A turn already running keeps its own; the next one uses this.
        sessions.setPlannerState(msg.sessionId, msg.graphId, { model: msg.model, effort: msg.effort });
        toConversation(msg.sessionId, msg.graphId, { type: 'plannerModel', graphId: msg.graphId, sessionId: msg.sessionId, ...choiceOf(msg.sessionId, msg.graphId) });
        return;
      }
      case 'previewRun': {
        const r = graphStore.load(msg.graphId);
        if (!r.ok) return error(r.error);
        const p = await preview(r.graph, msg.fromNodeId, msg.sourceRunId);
        if (!p.ok) return error(p.error);
        // The dialog's Model line: what agent steps would get if the run started now. Never waits for the model list.
        const { model, effort } = modelDefaults();
        const label = model && (findModel(knownModels(), model)?.label ?? model);
        // A provider that runs its default in place of a model it no longer lists (Copilot) names the one a step would get.
        const inUse = provider.modelInUse?.(model);
        const shownModel = inUse ? { value: inUse.value, label: inUse.label } : model && label ? { value: model, label } : undefined;
        const cap = provider.stepRequestCap?.();
        // Copilot ignores effort, so a configured level isn't previewed as if it applied.
        const shownEffort = supportsEffort(provider.id) ? effort : undefined;
        const shown = { ...p.outcome.preview, provider: provider.id, ...(shownModel && { model: shownModel }), ...(shownEffort && { effort: shownEffort }), ...(cap !== undefined && { copilotRequestsPerStep: cap }) };
        client.send({ type: 'runPreview', preview: shown, ...(msg.requestId !== undefined && { requestId: msg.requestId }) });
        return;
      }
      case 'startRun': {
        if (!status.ok) return error(`Runs are disabled: ${status.error}`);
        const r = graphStore.load(msg.graphId);
        if (!r.ok) return error(r.error);
        const p = await preview(r.graph, msg.fromNodeId, msg.sourceRunId);
        if (!p.ok) return error(p.error);
        // Run only what the user reviewed: a step, a value or an environment variable may have changed since.
        if (p.outcome.preview.signature !== msg.reviewed) return error(CHANGED_SINCE_REVIEW);
        if (!p.outcome.rendered) return error(p.outcome.preview.problems.join('\n'));
        if (runner.activeFor(r.graph.id)) return error('A run is already in progress for this graph.');
        const { checkout } = p;
        const runId = runner.newRunId();
        // Steps with a workspace never reuse (spec §4.3a): every workspace the graph names gets a fresh worktree, before start.
        const names = [...new Set(r.graph.nodes.map(workspaceOf).filter((w): w is string => w !== null))];
        let workspaces: Record<string, { path: string; head: string }> | undefined;
        const sendBlocked = ({ holder, otherWindow, lockFile }: LeaseBlock) =>
          client.send({
            type: 'runBlocked',
            graphId: r.graph.id,
            message: blockedMessage({ graphName: r.graph.name, holder, holderName: holderGraphName(holder), otherWindow, root: checkout.root, lockFile }),
            holder,
            otherWindow,
            checkout,
            canSetUpTickets: checkout.git,
          });
        if (names.length) {
          // The preview already refused this; kept so `head` is known here.
          if (!checkout.git || !checkout.head) return error(p.outcome.preview.problems.join('\n'));
          // Blocked now: refuse before making any worktree (spec §4.3, "nothing is created"). The runner checks again.
          const reused = new Set(p.outcome.preview.steps.filter((s) => s.reused).map((s) => s.id));
          const block = !msg.sequential && needsCheckoutLease(r.graph, reused) ? d.leases.blockedBy(checkout.root) : undefined;
          if (block) return sendBlocked(block);
          const made = await createVariantWorkspaces({ checkoutRoot: checkout.root, runId, names, head: checkout.head, git: d.git, home: d.home });
          if (!made.ok) return error(made.error);
          workspaces = made.workspaces;
        }
        /** Nothing ran in them yet: the worktrees this attempt made go again. A failure is logged (ruling P3). */
        const removeAttempt = async () => {
          for (const w of Object.values(workspaces ?? {})) {
            const removed = await removeWorkspace({ checkoutRoot: checkout.root, path: w.path, force: true, git: d.git });
            if (!removed.ok) console.error('[agent-stream] could not remove a worktree after a refused start', w.path, removed.error);
          }
        };
        // Like the provider, fixed for the whole run: a settings change mid-run doesn't reach its later steps.
        const defaults = modelDefaults();
        // Each agent step's own model and effort, resolved once against the list known now (never waiting for it); a
        // reused step keeps what it ran with (step model spec §3.1).
        const reusedIds = new Set(p.outcome.preview.steps.filter((s) => s.reused).map((s) => s.id));
        const source = msg.sourceRunId ? runStore.get(msg.sourceRunId) : undefined;
        const stepModels = runStepModels(r.graph, { provider: provider.id, ...defaults }, knownModels(), reusedIds, source);
        let started: ReturnType<typeof runner.start>;
        try {
          started = runner.start({
            graph: r.graph,
            rendered: p.outcome.rendered,
            sourceRunId: msg.sourceRunId,
            fromNodeId: msg.fromNodeId,
            provider: provider.id,
            ...defaults,
            stepModels,
            runId,
            checkout,
            sequential: msg.sequential,
            ...(workspaces && { workspaces }),
            // Fixed for the whole run: a provider switch mid-run doesn't reach its later steps.
            ...(d.executors ? {} : { agent: agentFor(provider) }),
          });
        } catch (e) {
          // The run couldn't be recorded (a disk error): its worktrees would be recorded nowhere.
          await removeAttempt();
          throw e;
        }
        if (started.ok) return;
        // The reply stays the same whether or not every worktree could be removed.
        await removeAttempt();
        if (!started.blocked) return error(started.error);
        return sendBlocked(started.blocked);
      }
      case 'inspectCheckout':
        client.send(await checkoutMessage());
        return;
      case 'setVariableValue': {
        const r = graphStore.load(msg.graphId);
        if (!r.ok) return error(r.error);
        if (!r.graph.variables.some((v) => v.name === msg.name)) return error(`variable ${msg.name} does not exist`);
        try {
          values.set(msg.graphId, msg.name, msg.value);
        } catch (e) {
          return error((e as Error).message);
        }
        return;
      }
      case 'stopRun':
        runner.stop(msg.runId);
        return;
      case 'selectRun': {
        const run = runner.get(msg.runId) ?? runStore.get(msg.runId);
        if (!run) return error(`run ${msg.runId} not found`);
        client.send({ type: 'run', run, select: true });
        return;
      }
      case 'getNodeLogs':
        client.send({ type: 'nodeLogs', runId: msg.runId, nodeId: msg.nodeId, events: runStore.readEvents(msg.runId, msg.nodeId) });
        return;
      case 'exportRunReport': {
        const r = runReport(msg.graphId, msg.runId);
        if (!r.ok) return error(r.error);
        client.send({ type: 'runReport', runId: msg.runId, markdown: r.markdown, suggestedName: r.suggestedName });
        return;
      }
      case 'decide':
        broker.decide(msg.approvalId, msg.decision === 'approve' ? { decision: 'approve' } : { decision: 'deny', note: msg.note });
        return;
    }
  }

  /**
   * A run's Markdown report (one audit trail per run), built from the run record, its step logs and outputs only:
   * never the variable values file or the environment.
   */
  function runReport(graphId: string, runId: string): { ok: true; markdown: string; suggestedName: string } | { ok: false; error: string } {
    const run = runner.get(runId) ?? runStore.get(runId);
    if (!run || run.graphId !== graphId) return { ok: false, error: `run ${runId} not found` };
    const g = graphStore.load(graphId);
    const steps = Object.fromEntries(
      run.snapshot.nodes.map((n) => {
        let outputPath: string | undefined;
        try {
          outputPath = runStore.outputRelPath(run.id, n.id);
        } catch {
          outputPath = undefined;
        }
        return [n.id, { events: runStore.readEvents(run.id, n.id), output: runStore.readOutput(run.id, n.id), outputPath }];
      }),
    );
    const markdown = buildRunReport({ graphName: g.ok ? g.graph.name : run.snapshot.name, run, steps, now: clock() });
    return { ok: true, markdown, suggestedName: `${graphId}-run-${run.id}.md` };
  }

  /** Every variant workspace this folder's runs recorded and haven't removed, newest run first (spec §5.5, ruling R16). */
  function runWorkspaces(): RunWorkspaceItem[] {
    const names = new Map(graphStore.list().map((g) => [g.id, g.name]));
    return runStore.all().flatMap((run) =>
      Object.entries(run.workspaces ?? {})
        .filter(([, w]) => !w.removed)
        .map(([name, w]) => ({
          runId: run.id,
          graphId: run.graphId,
          graphName: names.get(run.graphId) ?? run.graphId,
          name,
          path: w.path,
          head: w.head,
          checkoutRoot: run.checkout?.root ?? d.projectDir,
          running: !!runner.get(run.id),
        })),
    );
  }
  /** Manage Run Workspaces removed it: the run keeps the entry, marked removed (spec §5.5). */
  function markWorkspaceRemoved(runId: string, name: string): { ok: true } | { ok: false; error: string } {
    if (runner.get(runId)) return { ok: false, error: `Run ${runId} is still running. Stop it first.` };
    const run = runStore.get(runId);
    const w = run?.workspaces?.[name];
    if (!run || !w) return { ok: false, error: `Run ${runId} has no workspace "${name}".` };
    run.workspaces = { ...run.workspaces, [name]: { ...w, removed: true } };
    runStore.save(run);
    return { ok: true };
  }

  return {
    connect,
    handle,
    requestRun,
    graphStore,
    runStore,
    sessionStore: sessions,
    runner,
    broker,
    planner,
    values,
    listGraphs,
    createGraph,
    renameGraph,
    duplicateGraph,
    deleteGraph,
    exportGraph: (id: string) => graphStore.exportGraph(id),
    importGraph,
    graphFileChanged,
    graphFileDeleted,
    runWorkspaces,
    markWorkspaceRemoved,
    runReport,
    listSessions,
    createSession,
    renameSession,
    duplicateSession,
    deleteSession,
    saveSessionTabs,
    setProvider,
    modelDefaultsChanged,
    provider: () => provider,
    status: () => status,
    dispose,
    startupWarnings,
    /** One line per graph converted to Markdown on startup, for the Agent Stream output channel. */
    startupNotes: () => [...converted.notes],
  };
}
