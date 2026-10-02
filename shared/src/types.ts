export type Actor = 'user' | 'agent';
export type NodeKind = 'agent' | 'command';
export type Position = { x: number; y: number };

export type GraphNode = {
  id: string;
  title: string;
  kind: NodeKind;
  prompt?: string;
  command?: string;
  timeoutSec?: number;
  position?: Position;
  createdBy: Actor;
  updatedBy: Actor;
  updatedAt: string;
};

export type Edge = { id: string; from: string; to: string };

export type Graph = {
  id: string;
  name: string;
  goal: string;
  nodes: GraphNode[];
  edges: Edge[];
  /** Highest node number ever issued, so ids are never reused. */
  nodeSeq: number;
  plannerSessionId?: string;
  /** Length of the ops log when the planner's last turn started. */
  plannerOpCursor?: number;
  updatedAt: string;
};

export type NewNodeInput = {
  id?: string;
  title: string;
  kind: NodeKind;
  prompt?: string;
  command?: string;
  timeoutSec?: number;
  position?: Position;
};

export type NodePatch = {
  title?: string;
  kind?: NodeKind;
  prompt?: string;
  command?: string;
  timeoutSec?: number;
};

export type Op =
  | { type: 'addNode'; node: NewNodeInput }
  | { type: 'updateNode'; id: string; patch: NodePatch }
  | { type: 'deleteNode'; id: string }
  | { type: 'connect'; from: string; to: string }
  | { type: 'disconnect'; from: string; to: string }
  | { type: 'setGoal'; goal: string }
  | { type: 'moveNode'; id: string; position: Position };

export type OpRecord = { at: string; by: Actor; op: Op };

export type GraphResult = { ok: true; graph: Graph } | { ok: false; error: string };

export type NodeStatus =
  | 'pending'
  | 'running'
  | 'waiting_approval'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'skipped'
  | 'reused'
  | 'interrupted';

export type RunStatus = 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';

export type NodeUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  turns: number;
};

export type NodeRunState = {
  status: NodeStatus;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  error?: string;
  exitCode?: number | null;
  usage?: NodeUsage;
};

export type RunMeta = {
  id: string;
  graphId: string;
  status: RunStatus;
  startedAt: string;
  endedAt?: string;
  sourceRunId?: string;
  fromNodeId?: string;
  snapshot: Graph;
  nodes: Record<string, NodeRunState>;
};

export type RunSummary = { id: string; graphId: string; status: RunStatus; startedAt: string; endedAt?: string };

export type Decision = { decision: 'approve' } | { decision: 'deny'; note?: string } | { decision: 'cancelled' };

export type NodeEventBody =
  | { type: 'start'; kind: NodeKind; cwd: string; command?: string; prompt?: string }
  | { type: 'text'; text: string }
  | { type: 'tool_call'; toolUseId: string; name: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; content: string; isError: boolean }
  | { type: 'approval_requested'; approvalId: string; toolName: string; input: unknown }
  | { type: 'approval_decided'; approvalId: string; decision: Decision['decision']; note?: string }
  | { type: 'retry'; attempt: number; maxRetries: number; error: string }
  | { type: 'stdout'; chunk: string }
  | { type: 'stderr'; chunk: string }
  | { type: 'result'; ok: boolean; durationMs: number; error?: string; exitCode?: number | null; usage?: NodeUsage }
  | { type: 'error'; message: string };

export type NodeEvent = NodeEventBody & { at: string };

export type ApprovalRequest = {
  id: string;
  runId: string;
  nodeId: string;
  nodeTitle: string;
  toolName: string;
  input: unknown;
  createdAt: string;
};

export type ChatRole = 'user' | 'assistant' | 'tool' | 'error';
export type ChatEntry = { at: string; role: ChatRole; text: string };

export type AuthInfo = { ok: boolean; method?: string; plan?: string; email?: string; error?: string };

export type GraphListItem = { id: string; name: string; error?: string };

export type ServerMessage =
  | { type: 'hello'; auth: AuthInfo; project: string; graphs: GraphListItem[]; approvals: ApprovalRequest[] }
  | { type: 'graphs'; graphs: GraphListItem[] }
  | { type: 'graphOpened'; graph: Graph; chat: ChatEntry[]; chatBusy: boolean; runs: RunSummary[]; run?: RunMeta }
  | { type: 'graph'; graph: Graph }
  | { type: 'opRejected'; graphId: string; error: string }
  | { type: 'runs'; graphId: string; runs: RunSummary[] }
  | { type: 'run'; run: RunMeta; select?: boolean }
  | { type: 'runNode'; runId: string; nodeId: string; state: NodeRunState }
  | { type: 'nodeEvent'; runId: string; nodeId: string; event: NodeEvent }
  | { type: 'nodeLogs'; runId: string; nodeId: string; events: NodeEvent[] }
  | { type: 'approvals'; approvals: ApprovalRequest[] }
  | { type: 'chatEntry'; graphId: string; entry: ChatEntry }
  | { type: 'chatBusy'; graphId: string; busy: boolean }
  | { type: 'confirmRun'; graphId: string; fromNodeId?: string; sourceRunId?: string }
  | { type: 'error'; message: string };

export type ClientMessage =
  | { type: 'openGraph'; graphId: string }
  | { type: 'createGraph'; name: string }
  | { type: 'op'; graphId: string; op: Op }
  | { type: 'chat'; graphId: string; text: string }
  | { type: 'startRun'; graphId: string; fromNodeId?: string; sourceRunId?: string }
  | { type: 'stopRun'; runId: string }
  | { type: 'selectRun'; runId: string }
  | { type: 'getNodeLogs'; runId: string; nodeId: string }
  | { type: 'decide'; approvalId: string; decision: 'approve' | 'deny'; note?: string };
