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
  /** Agent steps: the step's own model, within its provider (spec §2.1). Missing means the run's model. */
  model?: StepModel;
  /** Agent steps: the step's own effort. Missing means the run's effort. */
  effort?: EffortLevel;
  /** Agent steps: files the step's agent gets every time it runs, by name, in order (step model spec §6b.3). */
  attachments?: string[];
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
  /** Files every agent step gets, after the step's own, by name, in order (step model spec §6b.3). */
  attachments?: string[];
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
  model?: StepModel;
  effort?: EffortLevel;
  attachments?: string[];
  position?: Position;
};

export type NodePatch = {
  title?: string;
  kind?: NodeKind;
  description?: string;
  prompt?: string;
  command?: string;
  /** 0 clears the timeout (a hand edit removed it from the graph's Markdown file). */
  timeoutSec?: number;
  /** 'read': an agent step that only reads and reports (spec §3.1). Missing means it can change files. */
  access?: NodeAccess;
  /** A variant workspace: steps with the same name share one worktree per run (spec §3.1a). Missing means this checkout; '' in a patch clears it. */
  workspace?: string;
  /** null clears the step's model (back to the run's). */
  model?: StepModel | null;
  /** null clears the step's effort (back to the run's). */
  effort?: EffortLevel | null;
  /** The step's whole attachment list; [] clears it. */
  attachments?: string[];
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
  /** The graph's whole attachment list; [] clears it (spec §6b.3). */
  | { type: 'setGraphAttachments'; names: string[] }
  /** `position: null` puts the step back on the automatic layout (only undo does that; clients always send a position). */
  | { type: 'moveNode'; id: string; position: Position | null }
  /** Review of agent changes (agent changes spec §3.4): applied by the graph store, which keeps the baseline. */
  | { type: 'acceptChange'; target: ChangeTarget }
  | { type: 'revertChange'; target: ChangeTarget };

/** Which agent made an edit: the planner (in a work session) or an agent step during a run. */
export type ChangeSource = { kind: 'planner'; sessionId?: string } | { kind: 'step'; runId: string; nodeId: string };

/**
 * `via: 'file'`: the edit came from the graph's Markdown file (Markdown graph files spec §6.3); `via: 'undo'`: Edit › Undo
 * made it (step model spec §6a.2). A history label only.
 */
export type OpRecord = { at: string; by: Actor; op: Op; source?: ChangeSource; via?: 'file' | 'undo' };

/** One problem in a graph's Markdown file: its 1-based line and a message that says how to fix it. */
export type GraphFileError = { line: number; message: string };
/** The largest graph file Import reads, and the largest text the Markdown editor saves: 1 MB. */
export const MAX_IMPORT_CHARS = 1024 * 1024;

export type ChangeTarget = { kind: 'node'; id: string } | { kind: 'edge'; id: string } | { kind: 'all' };

export type ChangedField = 'title' | 'description' | 'kind' | 'prompt' | 'command' | 'timeoutSec' | 'access' | 'workspace' | 'model' | 'effort' | 'attachments';

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

/**
 * `text` is the command or prompt as it will run; it is absent while the step can't be filled in (a variable it uses has no
 * value, or it has a problem).
 * `modelLine`: `Model: … · Effort: …` for an agent step whose own model or effort makes it differ from the run's;
 * `modelNote`: why it doesn't run its own (step model spec §3.3). Both are shown, neither blocks the run.
 */
export type PreviewStep = { id: string; title: string; kind: NodeKind; description?: string; text?: string; reused: boolean; modelLine?: string; modelNote?: string };

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
  /** Each agent step's model and effort, resolved when the run started (step model spec §3.1); absent in runs from before. */
  stepModels?: Record<string, StepModelUse>;
  /** Every attachment the run's steps use, with its SHA-256 when it started; a missing file has none (spec §6b.5). */
  attachments?: RunAttachment[];
};

/** An attachment as a run recorded it: its name, and its SHA-256 (hex) when the file was there. */
export type RunAttachment = { name: string; sha256?: string };

/** What one agent step of a run uses: absent fields are the provider's own default. `note` says why it isn't the step's own choice. */
export type StepModelUse = { model?: string; effort?: EffortLevel; note?: string };

/** One approved change a step agent made to a run in progress: `byNodeId` asked, `nodeId` is the step added or changed. */
export type RunAmendment = { at: string; byNodeId: string; nodeId: string; summary: string };

/** `amendments`: how many changes step agents made to the run, when there were any. */
export type RunSummary = { id: string; graphId: string; status: RunStatus; startedAt: string; endedAt?: string; provider?: ProviderId; amendments?: number; checkout?: RunCheckout; waitingFor?: WaitingFor; model?: string; effort?: EffortLevel };

export type Decision = { decision: 'approve' } | { decision: 'deny'; note?: string } | { decision: 'cancelled' };

export type NodeEventBody =
  /** `model`/`effort`: what an agent step actually ran with, as the provider sent it (absent: the provider's default). */
  | { type: 'start'; kind: NodeKind; cwd: string; command?: string; prompt?: string; model?: string; effort?: EffortLevel }
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

export type ProviderId = 'claude' | 'copilot' | 'codex';
export const PROVIDER_IDS: readonly ProviderId[] = ['claude', 'copilot', 'codex'];

/** How hard the model thinks: the Claude Agent SDK's levels, plus Codex's `ultra`. A model offers only some of them. */
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
export const EFFORT_LEVELS: readonly EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
/**
 * A model a provider offers. `efforts` is empty when the model has no effort levels; `unavailable` when the provider can't
 * run it yet; `resolved` the full id an alias row stands for (sonnet → claude-sonnet-5); `isDefault` the model the provider
 * runs when none is chosen (Codex marks one; Claude Code has a `default` row instead).
 */
export type ModelChoice = { value: string; label: string; description?: string; efforts: EffortLevel[]; unavailable?: boolean; resolved?: string; isDefault?: boolean };
/** Where an attachment goes: the whole graph, or one agent step (step model spec §6b.1). */
export type AttachTarget = { kind: 'graph' } | { kind: 'step'; nodeId: string };
/** A file a tab sends: its own name, and its bytes as base64. */
export type AttachmentUpload = { name: string; data: string };
/** A step's own model: the provider's model id exactly as its model list reports it, tagged with the provider (spec §2.1). */
export type StepModel = { provider: ProviderId; id: string };
/** A model and effort choice; an absent field means Default. */
export type ModelSelection = { model?: string; effort?: EffortLevel };

export type SessionTab = { graphId: string; group: number; index: number };
/** `model`/`effort`: the conversation's own choice (absent: Default, the settings' default). */
export type SessionPlannerState = { sessionId?: string; provider?: ProviderId; opCursor?: number; model?: string; effort?: EffortLevel };
export type Session = { id: string; name: string; createdAt: string; updatedAt: string; tabs: SessionTab[]; activeGraphId?: string; planner: Record<string, SessionPlannerState> };
export type SessionListItem = { id: string; name: string; updatedAt?: string; tabCount: number; problem?: string };
export type SessionResult = { ok: true; session: Session } | { ok: false; error: string };
/** Display names, for places that only have a ProviderId (run records). */
export const PROVIDER_NAMES: Record<ProviderId, string> = { claude: 'Claude', copilot: 'GitHub Copilot', codex: 'OpenAI Codex' };

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
  /** `reason: 'file'`: the graph's Markdown file disappeared (deleted, or a branch switch); the tab stays open and the graph comes back with the file. */
  | { type: 'graphDeleted'; graphId: string; reason?: 'file' }
  /** `baseline` is the user's graph before pending agent changes (absent when there are none); `changes` lists them. */
  | { type: 'graphOpened'; graph: Graph; runs: RunSummary[]; run?: RunMeta; variableValues: Record<string, string>; baseline?: Graph; changes: AgentChange[]; fileErrors?: GraphFileError[] }
  /** The graph's Markdown file has these problems, so the graph shown is the last good version; [] when they are fixed. */
  | { type: 'graphFileErrors'; graphId: string; errors: GraphFileError[] }
  | { type: 'graph'; graph: Graph; baseline?: Graph; changes: AgentChange[] }
  /** The graph's Markdown file exactly as it is on disk, even with errors: the answer to getGraphMarkdown, then again whenever the text changes. */
  | { type: 'graphMarkdown'; graphId: string; text: string }
  /**
   * The answer to saveGraphMarkdown. `ok`: written and read without errors; `text` is the file as Agent Stream wrote it
   * back. `errors`: written, but the file has these problems, so the last good graph stays. `conflict`: the file changed
   * since the editing began, so nothing was written. `error`: it couldn't be saved.
   */
  | { type: 'graphMarkdownSaved'; graphId: string; ok: boolean; text?: string; errors?: GraphFileError[]; conflict?: boolean; error?: string }
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
  /** The Markdown run report asked for with exportRunReport, and the file name to suggest when saving it. */
  | { type: 'runReport'; runId: string; markdown: string; suggestedName: string }
  /** What Edit › Undo would undo in this tab (absent: nothing): after the graph opens, and after each edit or undo here. */
  | { type: 'undoState'; graphId: string; label?: string }
  /** The answer to undo, for the toast: `Undid moved 2 steps.`, `Nothing to undo.`, or why it can't. */
  | { type: 'undone'; graphId: string; message: string }
  /** Files were attached under these names; `notice`: the one-time notice for a graph's first attachment (spec §6b.2). */
  | { type: 'attached'; graphId: string; target: AttachTarget; names: string[]; notice?: string }
  | { type: 'error'; message: string };

export type ClientMessage =
  | { type: 'openGraph'; graphId: string }
  | { type: 'createGraph'; name: string }
  | { type: 'op'; graphId: string; op: Op }
  /** Several edits that are one user action (a drag of several steps, deleting a selection, Tidy): applied all or none, one undo step named `label`. */
  | { type: 'ops'; graphId: string; ops: Op[]; label: string }
  /** Edit › Undo (⌘Z): reverses this tab's newest graph edit, if the graph is still as that edit left it. */
  | { type: 'undo'; graphId: string }
  /** Copies files into the graph's attachments folder and adds them to the target's list (spec §6b.4). */
  | { type: 'attach'; graphId: string; target: AttachTarget; files: AttachmentUpload[] }
  /** Removes one name from the target's list; its file goes when nothing in the graph uses it any more (spec §6b.2). */
  | { type: 'detach'; graphId: string; target: AttachTarget; name: string }
  /** Asks for the graph's Markdown file as it is on disk; the engine answers with graphMarkdown and keeps sending it as the text changes. */
  | { type: 'getGraphMarkdown'; graphId: string }
  /**
   * Writes the Markdown editor's text to the graph's file and reads it like any outside edit. `base`: the file's text when
   * the editing began; the engine refuses (conflict) when the file is no longer that, unless `force`.
   */
  | { type: 'saveGraphMarkdown'; graphId: string; text: string; base: string; force?: boolean }
  /** Subscribes this client to one planner conversation; the engine answers with chatOpened. */
  | { type: 'openChat'; graphId: string; sessionId: string }
  | { type: 'chat'; graphId: string; sessionId: string; text: string }
  | { type: 'refineSteps'; graphId: string; sessionId: string; nodeIds: string[] }
  | { type: 'splitStep'; graphId: string; sessionId: string; nodeId: string }
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
  /** Asks for the run's Markdown report; the engine answers with runReport. */
  | { type: 'exportRunReport'; graphId: string; runId: string }
  | { type: 'decide'; approvalId: string; decision: 'approve' | 'deny'; note?: string };

/** Graph actions that need VS Code's own UI (input box, file dialogs, confirmations, quick pick). */
export type ChatTarget = { graphId: string; graphName: string; sessionId: string; sessionName: string };

export type HostCommand = 'newGraph' | 'openGraph' | 'importGraph' | 'exportGraph' | 'renameGraph' | 'duplicateGraph' | 'deleteGraph' | 'showSidebar' | 'focusChat' | 'openGraphMarkdown';

/** Messages a graph tab sends that the extension handles itself (not the engine). */
export type WebviewHostMessage =
  | { type: 'ready' }
  | { type: 'opened'; graphId: string }
  | { type: 'host'; command: HostCommand }
  | { type: 'setMinimap'; value: boolean }
  | { type: 'chatCommand'; command: 'switchSession' | 'newChat' }
  | { type: 'draftState'; dirty: boolean }
  | { type: 'refineSteps'; nodeIds: string[] }
  | { type: 'splitStep'; nodeId: string }
  /** Export Run Report: the extension saves the selected run's report to a file and opens it. */
  | { type: 'exportRunReport'; runId: string }
  | { type: 'setUpParallelTickets' }
  | { type: 'openExternal'; url: string }
  /** Add…: the extension shows VS Code's file picker and attaches the files picked (spec §6b.4). */
  | { type: 'pickAttachments'; target: AttachTarget }
  /** Open: the extension opens the graph's attachment in VS Code (images in its image viewer). */
  | { type: 'openAttachment'; name: string };

export type WebviewMessage = ClientMessage | WebviewHostMessage;

/** Everything a graph tab receives: engine messages plus the extension's own. */
export type HostMessage =
  | ServerMessage
  | { type: 'revealNode'; nodeId: string }
  | { type: 'openRunDialog'; fromNodeId?: string; sourceRunId?: string; requestedBy?: 'planner' }
  | { type: 'openVariables' }
  | { type: 'prefs'; minimap: boolean }
  | { type: 'chatTarget'; target?: ChatTarget };
