import {
  validateRunnable,
  type ApprovalRequest,
  type AuthInfo,
  type ChatEntry,
  type ClientMessage,
  type Graph,
  type NodeEvent,
  type NodeRunState,
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
import { Runner } from './runner';
import { RunStore } from './runStore';
import type { QueryFn } from './sdk';

export type Client = { send(msg: ServerMessage): void };

export type AppDeps = {
  projectDir: string;
  claudePath: string;
  auth: AuthInfo;
  maxParallel: number;
  executors?: Executors;
  queryFn?: QueryFn;
  clock?: Clock;
};

export type App = ReturnType<typeof createApp>;

export function createApp(d: AppDeps) {
  const clock = d.clock ?? systemClock;
  const paths = projectPaths(d.projectDir);
  ensureDataDirs(paths);
  const graphStore = new GraphStore(paths, clock);
  const chatLog = new ChatLog(paths);
  const runStore = new RunStore(paths);
  runStore.recoverInterrupted(clock());
  const broker = new ApprovalBroker(clock);
  const executors = d.executors ?? {
    agent: createAgentExecutor({ claudePath: d.claudePath, broker, queryFn: d.queryFn }),
    command: createCommandExecutor(),
  };
  const runner = new Runner({ runStore, broker, executors, projectDir: d.projectDir, maxParallel: d.maxParallel, clock });
  const clients = new Set<Client>();
  const broadcast = (msg: ServerMessage) => {
    for (const c of clients) c.send(msg);
  };

  /** Planner's request_run: validate, then let the user confirm in the browser. */
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

  const planner = new Planner({ graphStore, runStore, chatLog, projectDir: d.projectDir, claudePath: d.claudePath, requestRun, queryFn: d.queryFn, clock });

  graphStore.on('changed', (graph: Graph) => broadcast({ type: 'graph', graph }));
  runner.on('run', (run: RunMeta) => {
    broadcast({ type: 'run', run });
    broadcast({ type: 'runs', graphId: run.graphId, runs: runStore.list(run.graphId) });
  });
  runner.on('node', (runId: string, nodeId: string, state: NodeRunState) => broadcast({ type: 'runNode', runId, nodeId, state }));
  runner.on('event', (runId: string, nodeId: string, event: NodeEvent) => broadcast({ type: 'nodeEvent', runId, nodeId, event }));
  broker.on('changed', (approvals: ApprovalRequest[]) => broadcast({ type: 'approvals', approvals }));
  planner.on('entry', (graphId: string, entry: ChatEntry) => broadcast({ type: 'chatEntry', graphId, entry }));
  planner.on('busy', (graphId: string, busy: boolean) => broadcast({ type: 'chatBusy', graphId, busy }));

  function opened(graph: Graph): ServerMessage {
    const runs = runStore.list(graph.id);
    const run = runner.activeFor(graph.id) ?? (runs[0] ? runStore.get(runs[0].id) : undefined);
    return { type: 'graphOpened', graph, chat: chatLog.read(graph.id), chatBusy: planner.isBusy(graph.id), runs, run };
  }

  function connect(client: Client): () => void {
    clients.add(client);
    client.send({ type: 'hello', auth: d.auth, project: d.projectDir, graphs: graphStore.list(), approvals: broker.pending() });
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
        const graph = graphStore.create(msg.name);
        broadcast({ type: 'graphs', graphs: graphStore.list() });
        client.send(opened(graph));
        return;
      }
      case 'op': {
        const r = graphStore.apply(msg.graphId, msg.op, 'user');
        if (!r.ok) client.send({ type: 'opRejected', graphId: msg.graphId, error: r.error });
        return;
      }
      case 'chat': {
        if (!d.auth.ok) return error(`Chat is disabled: ${d.auth.error}`);
        const r = graphStore.load(msg.graphId);
        if (!r.ok) return error(r.error);
        planner.send(msg.graphId, msg.text).catch((e: unknown) => console.error('[claude-stream] planner error', e));
        return;
      }
      case 'startRun': {
        if (!d.auth.ok) return error(`Runs are disabled: ${d.auth.error}`);
        const r = graphStore.load(msg.graphId);
        if (!r.ok) return error(r.error);
        const started = runner.start({ graph: r.graph, sourceRunId: msg.sourceRunId, fromNodeId: msg.fromNodeId });
        if (!started.ok) return error(started.error);
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

  return { connect, handle, requestRun, graphStore, runStore, runner, broker, planner };
}
