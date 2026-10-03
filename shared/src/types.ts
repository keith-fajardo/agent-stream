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

export type VariableDef = { name: string; description: string };

export type Graph = {
  id: string;
  name: string;
  goal: string;
  /** Longer guidance every agent step and the planner receive after the goal. */
  instructions: string;
  variables: VariableDef[];
  nodes: GraphNode[];
  edges: Edge[];
  /** Highest node number ever issued, so ids are never reused. */
  nodeSeq: number;
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
  | { type: 'setInstructions'; instructions: string }
  | { type: 'addVariable'; name: string; description?: string }
  | { type: 'renameVariable'; name: string; newName: string }
  | { type: 'setVariableDescription'; name: string; description: string }
  | { type: 'deleteVariable'; name: string }
  | { type: 'moveNode'; id: string; position: Position };

export type OpRecord = { at: string; by: Actor; op: Op };

export type GraphResult = { ok: true; graph: Graph } | { ok: false; error: string };

export type NodeStatus =
  | 'queued'
  | 'running'
  | 'waiting_approval'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  /** Never ran because a step before it failed (or itself did not run). */
  | 'not_run'
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

/** What a run actually executes: the goal, instructions and each step's prompt/command with variables filled in. */
export type RenderedRun = { goal: string; instructions: string; nodes: Record<string, string> };

/** `text` is the command or prompt as it will run; it is absent while the step can't be filled in (a variable it uses has no value, or it has a problem). */
export type PreviewStep = { id: string; title: string; kind: NodeKind; text?: string; reused: boolean };

/** The run confirmation dialog's contents, computed by the engine (spec §7.6). */
export type RunPreview = {
  graphId: string;
  fromNodeId?: string;
  sourceRunId?: string;
  /** Block Start. */
  problems: string[];
  /** Shown, don't block. */
  warnings: string[];
  steps: PreviewStep[];
  variables: { name: string; value: string }[];
  /** Start must send this back; the engine refuses if a re-render differs. */
  signature: string;
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
  rendered?: RenderedRun;
  /** Which provider ran this run's agent steps (absent for runs made before providers). */
  provider?: ProviderId;
};

export type RunSummary = { id: string; graphId: string; status: RunStatus; startedAt: string; endedAt?: string; provider?: ProviderId };

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
  graphId: string;
  nodeId: string;
  nodeTitle: string;
  toolName: string;
  input: unknown;
  createdAt: string;
};

export type ChatRole = 'user' | 'assistant' | 'tool' | 'error' | 'note';
export type ChatEntry = { at: string; role: ChatRole; text: string };

export type ProviderId = 'claude' | 'copilot';
export const PROVIDER_IDS: readonly ProviderId[] = ['claude', 'copilot'];

export type SessionTab = { graphId: string; group: number; index: number };
export type SessionPlannerState = { sessionId?: string; provider?: ProviderId; opCursor?: number };
export type Session = { id: string; name: string; createdAt: string; updatedAt: string; tabs: SessionTab[]; activeGraphId?: string; planner: Record<string, SessionPlannerState> };
export type SessionListItem = { id: string; name: string; updatedAt?: string; tabCount: number; problem?: string };
export type SessionResult = { ok: true; session: Session } | { ok: false; error: string };
/** Display names, for places that only have a ProviderId (run records). */
export const PROVIDER_NAMES: Record<ProviderId, string> = { claude: 'Claude', copilot: 'GitHub Copilot' };

export type ProviderStatus = {
  provider: ProviderId;
  /** Runs and planner chat are allowed. */
  ok: boolean;
  /** Status-bar text: "Claude Max", "not signed in", "Copilot (preview)", "Copilot not available". */
  label: string;
  /** Tooltip detail: the account, or the models VS Code reports. */
  detail?: string;
  /** Why runs and chat are refused, shown verbatim. */
  error?: string;
  /** Available but not runnable yet (the Copilot scaffold). */
  preview?: boolean;
};

export type GraphListItem = { id: string; name: string; error?: string; updatedAt?: string; lastRun?: { status: RunStatus; startedAt: string } };

export type ServerMessage =
  | { type: 'auth'; status: ProviderStatus }
  | { type: 'hello'; status: ProviderStatus; project: string; graphs: GraphListItem[]; approvals: ApprovalRequest[] }
  | { type: 'graphs'; graphs: GraphListItem[] }
  | { type: 'graphDeleted'; graphId: string }
  | { type: 'graphOpened'; graph: Graph; runs: RunSummary[]; run?: RunMeta; variableValues: Record<string, string> }
  | { type: 'graph'; graph: Graph }
  | { type: 'opRejected'; graphId: string; error: string }
  | { type: 'runs'; graphId: string; runs: RunSummary[] }
  | { type: 'run'; run: RunMeta; select?: boolean }
  | { type: 'runNode'; runId: string; nodeId: string; state: NodeRunState }
  | { type: 'nodeEvent'; runId: string; nodeId: string; event: NodeEvent }
  | { type: 'nodeLogs'; runId: string; nodeId: string; events: NodeEvent[] }
  | { type: 'approvals'; approvals: ApprovalRequest[] }
  | { type: 'chatEntry'; graphId: string; sessionId: string; entry: ChatEntry }
  | { type: 'chatBusy'; graphId: string; sessionId: string; busy: boolean }
  /** A planner conversation (one work session, one graph): sent on openChat, and empty again after New chat. */
  | { type: 'chatOpened'; graphId: string; sessionId: string; chat: ChatEntry[]; busy: boolean }
  | { type: 'sessions'; sessions: SessionListItem[] }
  | { type: 'confirmRun'; graphId: string; fromNodeId?: string; sourceRunId?: string }
  | { type: 'runPreview'; preview: RunPreview; requestId?: string }
  | { type: 'variableValues'; graphId: string; values: Record<string, string> }
  | { type: 'error'; message: string };

export type ClientMessage =
  | { type: 'openGraph'; graphId: string }
  | { type: 'createGraph'; name: string }
  | { type: 'op'; graphId: string; op: Op }
  /** Subscribes this client to one planner conversation; the engine answers with chatOpened. */
  | { type: 'openChat'; graphId: string; sessionId: string }
  | { type: 'chat'; graphId: string; sessionId: string; text: string }
  /** Clears the conversation: its chat and the provider session. */
  | { type: 'newChat'; graphId: string; sessionId: string }
  /** `reviewed` is the signature of the run preview the user confirmed; the engine refuses if a re-render differs. */
  | { type: 'startRun'; graphId: string; reviewed: string; fromNodeId?: string; sourceRunId?: string }
  | { type: 'previewRun'; graphId: string; fromNodeId?: string; sourceRunId?: string; requestId?: string }
  | { type: 'setVariableValue'; graphId: string; name: string; value: string }
  | { type: 'stopRun'; runId: string }
  | { type: 'selectRun'; runId: string }
  | { type: 'getNodeLogs'; runId: string; nodeId: string }
  | { type: 'decide'; approvalId: string; decision: 'approve' | 'deny'; note?: string };

/** Graph actions that need VS Code's own UI (input box, file dialogs, confirmations, quick pick). */
export type ChatTarget = { graphId: string; graphName: string; sessionId: string; sessionName: string };

export type HostCommand = 'newGraph' | 'openGraph' | 'importGraph' | 'exportGraph' | 'renameGraph' | 'duplicateGraph' | 'deleteGraph' | 'showSidebar' | 'focusChat';

/** Messages a graph tab sends that the extension handles itself (not the engine). */
export type WebviewHostMessage =
  | { type: 'ready' }
  | { type: 'opened'; graphId: string }
  | { type: 'host'; command: HostCommand }
  | { type: 'setMinimap'; value: boolean }
  | { type: 'chatCommand'; command: 'switchSession' | 'newChat' }
  | { type: 'draftState'; dirty: boolean };

export type WebviewMessage = ClientMessage | WebviewHostMessage;

/** Everything a graph tab receives: engine messages plus the extension's own. */
export type HostMessage =
  | ServerMessage
  | { type: 'revealNode'; nodeId: string }
  | { type: 'openRunDialog'; fromNodeId?: string; sourceRunId?: string }
  | { type: 'openVariables' }
  | { type: 'prefs'; minimap: boolean }
  | { type: 'chatTarget'; target?: ChatTarget };
