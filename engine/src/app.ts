import type { renameSync } from 'node:fs';
import {
  validateRunnable,
  type ApprovalRequest,
  type ProviderStatus,
  type ChatEntry,
  type ClientMessage,
  type Graph,
  type GraphListItem,
  type GraphResult,
  type NodeEvent,
  type NodeRunState,
  type Op,
  type RunMeta,
  type ServerMessage,
  type Session,
  type SessionResult,
  type SessionTab,
} from '@agent-stream/shared';
import { ApprovalBroker } from './approvals';
import { systemClock, type Clock } from './clock';
import { createCommandExecutor } from './commandExecutor';
import type { Executors, NodeExecutor } from './executors';
import { GraphStore } from './graphStore';
import { migrateProjectFolder, migrateValuesFile } from './migrate';
import { ensureDataDirs, projectPaths } from './paths';
import { Planner } from './planner';
import { GIT_BASH_MISSING, type Found } from './platform';
import { createStepGate } from './providers/toolGate';
import type { AgentProvider } from './providers/types';
import { previewRun, envLookup, type PreviewOutcome } from './runPreview';
import { Runner } from './runner';
import { RunStore } from './runStore';
import { migrateLegacy, SessionStore } from './sessionStore';
import type { EnvLookup } from './templates';
import { VariableValues } from './variableValues';

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
  maxParallel: number;
  /** For tests: replaces the step executors (agent steps then ignore the provider). */
  executors?: Executors;
  clock?: Clock;
  env?: EnvLookup;
  platform?: NodeJS.Platform;
  /** Windows: where Git Bash is (see findGitBash), or why it can't be found. */
  gitBash?: Found;
};

export type App = ReturnType<typeof createApp>;

export function createApp(d: AppDeps) {
  let provider = d.provider;
  let status = d.status;
  const clock = d.clock ?? systemClock;
  const paths = projectPaths(d.projectDir);
  const migrationWarnings = migrateProjectFolder(d.projectDir, d.rename);
  if (d.legacyValuesFile) migrationWarnings.push(...migrateValuesFile(d.valuesFile, d.legacyValuesFile, d.rename));
  ensureDataDirs(paths);
  const graphStore = new GraphStore(paths, clock);
  const sessions = new SessionStore(paths, clock);
  // Planner state and chats from before work sessions move into the Default session.
  migrationWarnings.push(...migrateLegacy(paths, sessions));
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
  /** Agent steps on `p`, each asking the user through its own step gate. */
  const agentFor =
    (p: AgentProvider): NodeExecutor =>
    (ctx) =>
      p.runStep(
        ctx,
        createStepGate({
          broker,
          runId: ctx.runId,
          graphId: ctx.graph.id,
          nodeId: ctx.node.id,
          nodeTitle: ctx.node.title,
          projectDir: ctx.cwd,
          privateFiles: privateFiles(),
          signal: ctx.signal,
          emit: ctx.emit,
        }),
      );
  const executors = d.executors ?? {
    agent: agentFor(provider),
    command: createCommandExecutor({ platform, gitBashPath: d.gitBash?.ok ? d.gitBash.path : undefined }),
  };
  const runner = new Runner({ runStore, broker, executors, projectDir: d.projectDir, maxParallel: d.maxParallel, clock });
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
    sessions.removeGraph(id);
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
    broadcast({ type: 'confirmRun', graphId, fromNodeId, sourceRunId });
    return null;
  }

  const planner = new Planner({ graphStore, runStore, sessions, projectDir: d.projectDir, provider: () => provider, privateFiles, requestRun, clock });

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
  graphStore.on('op', (graphId: string, op: Op) => {
    if (op.type === 'renameVariable') values.rename(graphId, op.name, op.newName);
    if (op.type === 'deleteVariable') values.delete(graphId, op.name);
  });
  graphStore.on('changed', (graph: Graph) => broadcast({ type: 'graph', graph }));
  runner.on('run', (run: RunMeta) => {
    broadcast({ type: 'run', run });
    broadcast({ type: 'runs', graphId: run.graphId, runs: runStore.list(run.graphId) });
    broadcastGraphs();
  });
  runner.on('node', (runId: string, nodeId: string, state: NodeRunState) => broadcast({ type: 'runNode', runId, nodeId, state }));
  runner.on('event', (runId: string, nodeId: string, event: NodeEvent) => broadcast({ type: 'nodeEvent', runId, nodeId, event }));
  broker.on('changed', (approvals: ApprovalRequest[]) => broadcast({ type: 'approvals', approvals }));
  sessions.on('changed', () => broadcast({ type: 'sessions', sessions: sessions.list() }));
  planner.on('entry', (sessionId: string, graphId: string, entry: ChatEntry) => toConversation(sessionId, graphId, { type: 'chatEntry', graphId, sessionId, entry }));
  planner.on('busy', (sessionId: string, graphId: string, busy: boolean) => toConversation(sessionId, graphId, { type: 'chatBusy', graphId, sessionId, busy }));
  planner.on('cleared', (sessionId: string, graphId: string) => toConversation(sessionId, graphId, { type: 'chatOpened', graphId, sessionId, chat: [], busy: false }));

  function preview(graph: Graph, fromNodeId?: string, sourceRunId?: string): { ok: true; outcome: PreviewOutcome } | { ok: false; error: string } {
    let source: RunMeta | undefined;
    if (sourceRunId) {
      source = runStore.get(sourceRunId);
      if (!source || source.graphId !== graph.id) return { ok: false, error: `run ${sourceRunId} not found` };
    }
    return { ok: true, outcome: previewRun({ graph, values: values.get(graph.id), env, source, fromNodeId, commandShellProblem }) };
  }

  function opened(graph: Graph): ServerMessage {
    const runs = runStore.list(graph.id);
    const run = runner.activeFor(graph.id) ?? (runs[0] ? runStore.get(runs[0].id) : undefined);
    return { type: 'graphOpened', graph, runs, run, variableValues: values.get(graph.id) };
  }

  /** The provider or its status changed (settings, Check again): new runs and planner turns use it; running ones keep theirs. */
  function setProvider(next: AgentProvider, nextStatus: ProviderStatus): void {
    provider = next;
    status = nextStatus;
    broadcast({ type: 'auth', status });
  }

  /** VS Code is closing: stop every run (ruling R4). */
  function dispose(): void {
    runner.stopAll();
  }

  function startupWarnings(): string[] {
    values.get('');
    return values.problem ? [...migrationWarnings, values.problem] : migrationWarnings;
  }

  function connect(client: Client): () => void {
    clients.add(client);
    client.send({ type: 'hello', status, project: d.projectDir, graphs: listGraphs(), approvals: broker.pending() });
    client.send({ type: 'sessions', sessions: sessions.list() });
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
        const r = graphStore.apply(msg.graphId, msg.op, 'user');
        if (!r.ok) client.send({ type: 'opRejected', graphId: msg.graphId, error: r.error });
        return;
      }
      case 'openChat': {
        const g = graphStore.load(msg.graphId);
        if (!g.ok) return error(g.error);
        const s = sessions.load(msg.sessionId);
        if (!s.ok) return error(s.error);
        chatSubscriptions.set(client, { graphId: msg.graphId, sessionId: msg.sessionId });
        client.send({ type: 'chatOpened', graphId: msg.graphId, sessionId: msg.sessionId, chat: sessions.chatLog(msg.sessionId).read(msg.graphId), busy: planner.isBusy(msg.sessionId, msg.graphId) });
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
      case 'newChat': {
        const s = sessions.load(msg.sessionId);
        if (!s.ok) return error(s.error);
        const r = planner.newChat(msg.sessionId, msg.graphId);
        if (!r.ok) return error(r.error);
        return;
      }
      case 'previewRun': {
        const r = graphStore.load(msg.graphId);
        if (!r.ok) return error(r.error);
        const p = preview(r.graph, msg.fromNodeId, msg.sourceRunId);
        if (!p.ok) return error(p.error);
        client.send({ type: 'runPreview', preview: p.outcome.preview, ...(msg.requestId !== undefined && { requestId: msg.requestId }) });
        return;
      }
      case 'startRun': {
        if (!status.ok) return error(`Runs are disabled: ${status.error}`);
        const r = graphStore.load(msg.graphId);
        if (!r.ok) return error(r.error);
        const p = preview(r.graph, msg.fromNodeId, msg.sourceRunId);
        if (!p.ok) return error(p.error);
        // Run only what the user reviewed: a step, a value or an environment variable may have changed since.
        if (p.outcome.preview.signature !== msg.reviewed) return error(CHANGED_SINCE_REVIEW);
        if (!p.outcome.rendered) return error(p.outcome.preview.problems.join('\n'));
        const started = runner.start({
          graph: r.graph,
          rendered: p.outcome.rendered,
          sourceRunId: msg.sourceRunId,
          fromNodeId: msg.fromNodeId,
          provider: provider.id,
          // Fixed for the whole run: a provider switch mid-run doesn't reach its later steps.
          ...(d.executors ? {} : { agent: agentFor(provider) }),
        });
        if (!started.ok) return error(started.error);
        return;
      }
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
      case 'decide':
        broker.decide(msg.approvalId, msg.decision === 'approve' ? { decision: 'approve' } : { decision: 'deny', note: msg.note });
        return;
    }
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
    listSessions,
    createSession,
    renameSession,
    duplicateSession,
    deleteSession,
    saveSessionTabs,
    setProvider,
    provider: () => provider,
    status: () => status,
    dispose,
    startupWarnings,
  };
}
