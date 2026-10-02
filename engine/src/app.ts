import {
  validateRunnable,
  type ApprovalRequest,
  type AuthInfo,
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
} from '@claude-stream/shared';
import { createAgentExecutor } from './agentExecutor';
import { ApprovalBroker } from './approvals';
import { ChatLog } from './chatLog';
import { systemClock, type Clock } from './clock';
import { createCommandExecutor } from './commandExecutor';
import type { Executors } from './executors';
import { GraphStore } from './graphStore';
import { ensureDataDirs, projectPaths } from './paths';
import { Planner } from './planner';
import { GIT_BASH_MISSING, type Found } from './platform';
import { previewRun, envLookup, type PreviewOutcome } from './runPreview';
import { Runner } from './runner';
import { RunStore } from './runStore';
import type { QueryFn } from './sdk';
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
  claudePath: string;
  auth: AuthInfo;
  maxParallel: number;
  executors?: Executors;
  queryFn?: QueryFn;
  clock?: Clock;
  env?: EnvLookup;
  platform?: NodeJS.Platform;
  /** Windows: where Git Bash is (see findGitBash), or why it can't be found. */
  gitBash?: Found;
};

export type App = ReturnType<typeof createApp>;

export function createApp(d: AppDeps) {
  let auth = d.auth;
  let claudePath = d.claudePath;
  const clock = d.clock ?? systemClock;
  const paths = projectPaths(d.projectDir);
  ensureDataDirs(paths);
  const graphStore = new GraphStore(paths, clock);
  const chatLog = new ChatLog(paths);
  const runStore = new RunStore(paths);
  const platform = d.platform ?? process.platform;
  const env = d.env ?? envLookup(process.env, platform);
  const values = new VariableValues(d.valuesFile, platform);
  /** Why command steps can't run on this machine, shown in every run preview that has command steps. */
  const commandShellProblem: string | null = platform === 'win32' ? (d.gitBash?.ok ? null : (d.gitBash?.error ?? GIT_BASH_MISSING)) : null;
  runStore.recoverInterrupted(clock());
  const broker = new ApprovalBroker(clock);
  const executors = d.executors ?? {
    agent: createAgentExecutor({ claudePath: () => claudePath, broker, queryFn: d.queryFn, valuesFile: d.valuesFile }),
    command: createCommandExecutor({ platform, gitBashPath: d.gitBash?.ok ? d.gitBash.path : undefined }),
  };
  const runner = new Runner({ runStore, broker, executors, projectDir: d.projectDir, maxParallel: d.maxParallel, clock });
  const clients = new Set<Client>();
  const broadcast = (msg: ServerMessage) => {
    for (const c of clients) c.send(msg);
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
    if (planner.isBusy(id)) return { ok: false, error: "The planner is still working on this graph. Try again when it's done." };
    const r = graphStore.delete(id);
    if (!r.ok) return r;
    values.deleteGraph(id);
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

  const planner = new Planner({ graphStore, runStore, chatLog, projectDir: d.projectDir, valuesFile: d.valuesFile, claudePath: () => claudePath, requestRun, queryFn: d.queryFn, clock });

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
  planner.on('entry', (graphId: string, entry: ChatEntry) => broadcast({ type: 'chatEntry', graphId, entry }));
  planner.on('busy', (graphId: string, busy: boolean) => broadcast({ type: 'chatBusy', graphId, busy }));

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
    return { type: 'graphOpened', graph, chat: chatLog.read(graph.id), chatBusy: planner.isBusy(graph.id), runs, run, variableValues: values.get(graph.id) };
  }

  /** Sign-in changed (Retry in the sidebar): update every check and tell the tabs. */
  function setAuth(next: AuthInfo, nextClaudePath?: string): void {
    auth = next;
    if (nextClaudePath) claudePath = nextClaudePath;
    broadcast({ type: 'auth', auth });
  }

  /** VS Code is closing: stop every run (ruling R4). */
  function dispose(): void {
    runner.stopAll();
  }

  function startupWarnings(): string[] {
    values.get('');
    return values.problem ? [values.problem] : [];
  }

  function connect(client: Client): () => void {
    clients.add(client);
    client.send({ type: 'hello', auth, project: d.projectDir, graphs: listGraphs(), approvals: broker.pending() });
    return () => {
      clients.delete(client);
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
      case 'chat': {
        if (!auth.ok) return error(`Chat is disabled: ${auth.error}`);
        const r = graphStore.load(msg.graphId);
        if (!r.ok) return error(r.error);
        planner.send(msg.graphId, msg.text).catch((e: unknown) => console.error('[claude-stream] planner error', e));
        return;
      }
      case 'previewRun': {
        const r = graphStore.load(msg.graphId);
        if (!r.ok) return error(r.error);
        const p = preview(r.graph, msg.fromNodeId, msg.sourceRunId);
        if (!p.ok) return error(p.error);
        client.send({ type: 'runPreview', preview: p.outcome.preview });
        return;
      }
      case 'startRun': {
        if (!auth.ok) return error(`Runs are disabled: ${auth.error}`);
        const r = graphStore.load(msg.graphId);
        if (!r.ok) return error(r.error);
        const p = preview(r.graph, msg.fromNodeId, msg.sourceRunId);
        if (!p.ok) return error(p.error);
        // Run only what the user reviewed: a step, a value or an environment variable may have changed since.
        if (p.outcome.preview.signature !== msg.reviewed) return error(CHANGED_SINCE_REVIEW);
        if (!p.outcome.rendered) return error(p.outcome.preview.problems.join('\n'));
        const started = runner.start({ graph: r.graph, rendered: p.outcome.rendered, sourceRunId: msg.sourceRunId, fromNodeId: msg.fromNodeId });
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
    setAuth,
    dispose,
    startupWarnings,
  };
}
