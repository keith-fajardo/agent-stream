export type Actor = 'user' | 'agent';
export type NodeKind = 'agent' | 'command';
export type Position = { x: number; y: number };

export type NodeAccess = 'read' | 'write';

export type GraphNode = {
  id: string;
  title: string;
  kind: NodeKind;
  /** One plain-language sentence for people: what the step does and why. */
  description?: string;
  prompt?: string;
  command?: string;
  timeoutSec?: number;
  /** 'read': an agent step that only reads and reports (spec §3.1). Missing means it can change files. */
  access?: NodeAccess;
  /** A variant workspace: steps with the same name share one worktree per run (spec §3.1a). Missing means this checkout; '' in a patch clears it. */
  workspace?: string;
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
  description?: string;
  prompt?: string;
  command?: string;
  timeoutSec?: number;
  /** 'read': an agent step that only reads and reports (spec §3.1). Missing means it can change files. */
  access?: NodeAccess;
  /** A variant workspace: steps with the same name share one worktree per run (spec §3.1a). Missing means this checkout; '' in a patch clears it. */
  workspace?: string;
  position?: Position;
};

export type NodePatch = {
  title?: string;
  kind?: NodeKind;
  description?: string;
  prompt?: string;
  command?: string;
  timeoutSec?: number;
  /** 'read': an agent step that only reads and reports (spec §3.1). Missing means it can change files. */
  access?: NodeAccess;
  /** A variant workspace: steps with the same name share one worktree per run (spec §3.1a). Missing means this checkout; '' in a patch clears it. */
  workspace?: string;
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
  | { type: 'moveNode'; id: string; position: Position }
  /** Review of agent changes (agent changes spec §3.4): applied by the graph store, which keeps the baseline. */
  | { type: 'acceptChange'; target: ChangeTarget }
  | { type: 'revertChange'; target: ChangeTarget };

/** Which agent made an edit: the planner (in a work session) or an agent step during a run. */
export type ChangeSource = { kind: 'planner'; sessionId?: string } | { kind: 'step'; runId: string; nodeId: string };

export type OpRecord = { at: string; by: Actor; op: Op; source?: ChangeSource };

export type ChangeTarget = { kind: 'node'; id: string } | { kind: 'edge'; id: string } | { kind: 'all' };

export type ChangedField = 'title' | 'description' | 'kind' | 'prompt' | 'command' | 'timeoutSec' | 'access' | 'workspace';

/** One difference between the user's baseline and the graph; `by`/`at` come from the latest agent op that touched it. */
export type AgentChange =
  | { kind: 'node'; change: 'added' | 'changed' | 'removed'; id: string; title: string; fields?: ChangedField[]; by?: ChangeSource; at?: string }
  | { kind: 'edge'; change: 'added' | 'removed'; id: string; from: string; to: string; by?: ChangeSource; at?: string };

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
export type PreviewStep = { id: string; title: string; kind: NodeKind; description?: string; text?: string; reused: boolean };

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
  /** Shown, never block (spec §4.7): writers that take turns, uncommitted changes left out of workspaces. */
  notes?: string[];
  /** The checkout the run will use: the dialog's Checkout line. */
  checkout?: CheckoutInfo;
  /** The settings' default model (with its label) and effort that agent steps would use now: the dialog's Model line. */
  model?: { value: string; label: string };
  effort?: EffortLevel;
  /** The provider the run would use: the dialog's Effort reads "not supported" for Copilot. */
  provider?: ProviderId;
  /** The run's provider caps model requests per step (Copilot): the dialog's "Copilot requests per step" line. */
  copilotRequestsPerStep?: number;
};

/** Where a folder's graphs work (spec §3.2). `root` is a real path: the Git top-level, or the folder itself outside Git. */
export type CheckoutInfo =
  | { git: false; root: string; reason: string }
  | {
      git: true;
      root: string;
      linkedWorktree: boolean;
      /** Absent when HEAD is detached. */
      branch?: string;
      /** Absent before the first commit. */
      head?: string;
      /** Tracked files modified or staged. */
      dirty: boolean;
      worktrees: { path: string; branch?: string; head?: string; current: boolean }[];
    };

/** The run changing files in a checkout (spec §4.2). */
export type LeaseHolder = { runId: string; graphId: string; folder: string; pid: number; startedAt: string };
/** Where a run ran, recorded when it starts. */
export type RunCheckout = { root: string; branch?: string; head?: string; linkedWorktree: boolean };
/** A variant workspace a run created (spec §4.3a); `removed` once Manage Run Workspaces removed it. */
export type RunWorkspace = { path: string; head: string; removed?: boolean };
/** The run whose lease a sequential run's write-capable steps wait for. */
export type WaitingFor = { runId: string; graphId: string; folder: string };

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
  /** Graph changes a step agent made to this run while it ran, each approved by the user. */
  amendments?: RunAmendment[];
  /** Where the run ran, recorded when it started. */
  checkout?: RunCheckout;
  /** One entry per variant workspace the run created. */
  workspaces?: Record<string, RunWorkspace>;
  /** Set while the run's write-capable steps wait for another run's write lease. */
  waitingFor?: WaitingFor;
  /** The model and effort the run's agent steps used, captured from the settings when it started (only when set). */
  model?: string;
  effort?: EffortLevel;
};

/** One approved change a step agent made to a run in progress: `byNodeId` asked, `nodeId` is the step added or changed. */
export type RunAmendment = { at: string; byNodeId: string; nodeId: string; summary: string };

/** `amendments`: how many changes step agents made to the run, when there were any. */
export type RunSummary = { id: string; graphId: string; status: RunStatus; startedAt: string; endedAt?: string; provider?: ProviderId; amendments?: number; checkout?: RunCheckout; waitingFor?: WaitingFor; model?: string; effort?: EffortLevel };

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
  /** A step agent's graph change: what it wants (`summary`) and the exact text that would run (`detail`). */
  graphChange?: GraphChangeRequest;
};

export type GraphChangeRequest = { summary: string; detail: string };

export type ChatRole = 'user' | 'assistant' | 'tool' | 'error' | 'note';
export type ChatEntry = { at: string; role: ChatRole; text: string };

export type ProviderId = 'claude' | 'copilot';
export const PROVIDER_IDS: readonly ProviderId[] = ['claude', 'copilot'];

/** How hard the model thinks: the Claude Agent SDK's levels. */
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export const EFFORT_LEVELS: readonly EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];
/**
 * A model a provider offers. `efforts` is empty when the model has no effort levels; `unavailable` when the provider can't
 * run it yet; `resolved` the full id an alias row stands for (sonnet → claude-sonnet-5).
 */
export type ModelChoice = { value: string; label: string; description?: string; efforts: EffortLevel[]; unavailable?: boolean; resolved?: string };
/** A model and effort choice; an absent field means Default. */
export type ModelSelection = { model?: string; effort?: EffortLevel };

export type SessionTab = { graphId: string; group: number; index: number };
/** `model`/`effort`: the conversation's own choice (absent: Default, the settings' default). */
export type SessionPlannerState = { sessionId?: string; provider?: ProviderId; opCursor?: number; model?: string; effort?: EffortLevel };
export type Session = { id: string; name: string; createdAt: string; updatedAt: string; tabs: SessionTab[]; activeGraphId?: string; planner: Record<string, SessionPlannerState> };
export type SessionListItem = { id: string; name: string; updatedAt?: string; tabCount: number; problem?: string };
export type SessionResult = { ok: true; session: Session } | { ok: false; error: string };
/** Display names, for places that only have a ProviderId (run records). */
export const PROVIDER_NAMES: Record<ProviderId, string> = { claude: 'Claude', copilot: 'GitHub Copilot' };

export type ProviderStatus = {
  provider: ProviderId;
  /** Runs and planner chat are allowed. */
  ok: boolean;
  /** Status-bar text: "Claude Max", "not signed in", "Copilot", "Copilot not available", "Copilot not allowed". */
  label: string;
  /** Tooltip detail: the account, or the models VS Code reports. */
  detail?: string;
  /** Why runs and chat are refused, shown verbatim. */
  error?: string;
};

export type GraphListItem = { id: string; name: string; error?: string; updatedAt?: string; lastRun?: { status: RunStatus; startedAt: string }; agentChanges?: number };

export type ServerMessage =
  | { type: 'auth'; status: ProviderStatus }
  | { type: 'hello'; status: ProviderStatus; project: string; graphs: GraphListItem[]; approvals: ApprovalRequest[] }
  | { type: 'graphs'; graphs: GraphListItem[] }
  | { type: 'graphDeleted'; graphId: string }
  /** `baseline` is the user's graph before pending agent changes (absent when there are none); `changes` lists them. */
  | { type: 'graphOpened'; graph: Graph; runs: RunSummary[]; run?: RunMeta; variableValues: Record<string, string>; baseline?: Graph; changes: AgentChange[] }
  | { type: 'graph'; graph: Graph; baseline?: Graph; changes: AgentChange[] }
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
  | { type: 'chatOpened'; graphId: string; sessionId: string; chat: ChatEntry[]; busy: boolean; model?: string; effort?: EffortLevel }
  /** The conversation's model and effort choice changed (absent fields: Default). */
  | { type: 'plannerModel'; graphId: string; sessionId: string; model?: string; effort?: EffortLevel }
  /**
   * The models the current provider offers, for the chat's Model menu: sent on openChat, when the provider changes and when
   * the settings' defaults change. `defaultEfforts`: the levels the menu's Default offers (see defaultEffortsFor).
   */
  | { type: 'models'; provider: ProviderId; models: ModelChoice[]; defaultEfforts: EffortLevel[] }
  | { type: 'sessions'; sessions: SessionListItem[] }
  /** Asks the graph's tab to confirm a run. `requestedBy: 'planner'`: the planner's request_run asked for it. */
  | { type: 'confirmRun'; graphId: string; fromNodeId?: string; sourceRunId?: string; requestedBy?: 'planner' }
  | { type: 'runPreview'; preview: RunPreview; requestId?: string }
  | { type: 'variableValues'; graphId: string; values: Record<string, string> }
  /** Where this folder's graphs work and who holds its write lease: after hello, on request, and when a run starts, ends or stops waiting. */
  | { type: 'checkout'; info: CheckoutInfo; lease?: LeaseHolder }
  /** A run was refused because another run is changing files in this checkout (spec §4.5). Not an error. */
  | { type: 'runBlocked'; graphId: string; message: string; holder: LeaseHolder; otherWindow: boolean; checkout: CheckoutInfo; canSetUpTickets: boolean }
  | { type: 'error'; message: string };

export type ClientMessage =
  | { type: 'openGraph'; graphId: string }
  | { type: 'createGraph'; name: string }
  | { type: 'op'; graphId: string; op: Op }
  /** Subscribes this client to one planner conversation; the engine answers with chatOpened. */
  | { type: 'openChat'; graphId: string; sessionId: string }
  | { type: 'chat'; graphId: string; sessionId: string; text: string }
  | { type: 'refineSteps'; graphId: string; sessionId: string; nodeIds: string[] }
  /** Clears the conversation: its chat and the provider session. */
  | { type: 'newChat'; graphId: string; sessionId: string }
  /** Stops the conversation's running planner turn; nothing happens when none is running. */
  | { type: 'stopPlanner'; graphId: string; sessionId: string }
  /** The conversation's model and effort from its next turn; an absent field is Default. */
  | { type: 'setPlannerModel'; graphId: string; sessionId: string; model?: string; effort?: EffortLevel }
  /** `reviewed` is the signature of the run preview the user confirmed; the engine refuses if a re-render differs. */
  | { type: 'startRun'; graphId: string; reviewed: string; fromNodeId?: string; sourceRunId?: string; sequential?: boolean }
  | { type: 'inspectCheckout' }
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
  | { type: 'draftState'; dirty: boolean }
  | { type: 'refineSteps'; nodeIds: string[] }
  | { type: 'setUpParallelTickets' };

export type WebviewMessage = ClientMessage | WebviewHostMessage;

/** Everything a graph tab receives: engine messages plus the extension's own. */
export type HostMessage =
  | ServerMessage
  | { type: 'revealNode'; nodeId: string }
  | { type: 'openRunDialog'; fromNodeId?: string; sourceRunId?: string; requestedBy?: 'planner' }
  | { type: 'openVariables' }
  | { type: 'prefs'; minimap: boolean }
  | { type: 'chatTarget'; target?: ChatTarget };
