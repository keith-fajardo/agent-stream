/**
 * The Codex app-server messages Agent Stream uses (spec §4.1), copied by hand from
 * `codex app-server generate-ts --experimental` for codex-cli 0.160.0. Only the fields we send or read: the server sends
 * more, and other item types, which the step log shows by type and a short summary (RF1). Nothing reads the generated
 * files at runtime.
 */
export const CODEX_PROTOCOL_VERSION = '0.160.0';

// initialize / initialized
export type ClientInfo = { name: string; title: string | null; version: string };
export type InitializeParams = { clientInfo: ClientInfo; capabilities: { experimentalApi: boolean; requestAttestation: boolean } | null };

// account/read
/** "free" | "go" | "plus" | "pro" | "team" | "business" | "enterprise" | … (kept open: new plans appear). */
export type PlanType = string;
export type Account = { type: 'apiKey' } | { type: 'chatgpt'; email: string | null; planType: PlanType } | { type: 'amazonBedrock'; usesCodexManagedCredentials: boolean };
export type GetAccountResponse = { account: Account | null; requiresOpenaiAuth: boolean };

// model/list
/** "low" | "medium" | "high" | "xhigh" | "max" | "ultra", and others such as "none" or "minimal" that Agent Stream drops. */
export type ReasoningEffort = string;
export type ReasoningEffortOption = { reasoningEffort: ReasoningEffort; description: string };
export type Model = {
  id: string;
  model: string;
  displayName: string;
  description: string;
  hidden: boolean;
  supportedReasoningEfforts: ReasoningEffortOption[];
  defaultReasoningEffort: ReasoningEffort;
  isDefault: boolean;
};
export type ModelListParams = { cursor?: string | null; limit?: number | null; includeHidden?: boolean | null };
export type ModelListResponse = { data: Model[]; nextCursor: string | null };

// config/read: only which MCP servers the effective config (with the folder's project layers) turns on (RF1)
export type ConfigReadParams = { includeLayers?: boolean; cwd?: string | null };
export type ConfigReadResponse = { config: { mcp_servers?: Record<string, { enabled?: boolean } | null> | null } };

// thread/start, thread/resume
export type AskForApproval = 'untrusted' | 'on-request' | 'never';
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';
export type DynamicToolSpec = { type: 'function'; name: string; description: string; inputSchema: unknown };
export type ThreadStartParams = {
  model?: string | null;
  cwd?: string | null;
  approvalPolicy?: AskForApproval | null;
  sandbox?: SandboxMode | null;
  developerInstructions?: string | null;
  ephemeral?: boolean | null;
  dynamicTools?: DynamicToolSpec[] | null;
};
export type ThreadResumeParams = {
  threadId: string;
  model?: string | null;
  cwd?: string | null;
  approvalPolicy?: AskForApproval | null;
  sandbox?: SandboxMode | null;
  developerInstructions?: string | null;
};
/** The part of ThreadStartResponse and ThreadResumeResponse we read. */
export type ThreadResponse = { thread: { id: string } };

// turn/start, turn/interrupt
export type TextElement = { byteRange: { start: number; end: number }; placeholder: string | null };
/** Text, or an image Codex reads from a path on this machine (`localImage`, codex-cli 0.160 generate-ts). */
export type UserInput = { type: 'text'; text: string; text_elements: TextElement[] } | { type: 'localImage'; path: string };
export type TurnStartParams = { threadId: string; input: UserInput[]; effort?: ReasoningEffort | null };
export type TurnStatus = 'completed' | 'interrupted' | 'failed' | 'inProgress';
export type TurnError = { message: string; additionalDetails: string | null };
export type Turn = { id: string; status: TurnStatus; error: TurnError | null };
export type TurnStartResponse = { turn: Turn };
export type TurnInterruptParams = { threadId: string; turnId: string };

// Items, as item/started and item/completed carry them
export type CommandAction =
  | { type: 'read'; command: string; name: string; path: string }
  | { type: 'listFiles'; command: string; path: string | null }
  | { type: 'search'; command: string; query: string | null; path: string | null }
  | { type: 'unknown'; command: string };
export type PatchChangeKind = { type: 'add' } | { type: 'delete' } | { type: 'update'; move_path: string | null };
export type FileUpdateChange = { path: string; kind: PatchChangeKind; diff: string };
export type DynamicToolContentItem = { type: 'inputText'; text: string } | { type: 'inputImage'; imageUrl: string } | { type: 'inputAudio'; audioUrl: string };
export type ThreadItem =
  | { type: 'agentMessage'; id: string; text: string }
  | { type: 'reasoning'; id: string; summary: string[]; content: string[] }
  | {
      type: 'commandExecution';
      id: string;
      command: string;
      cwd: string;
      status: 'inProgress' | 'completed' | 'failed' | 'declined';
      commandActions: CommandAction[];
      aggregatedOutput: string | null;
      exitCode: number | null;
    }
  | { type: 'fileChange'; id: string; changes: FileUpdateChange[]; status: 'inProgress' | 'completed' | 'failed' | 'declined' }
  | {
      type: 'dynamicToolCall';
      id: string;
      namespace: string | null;
      tool: string;
      arguments: unknown;
      status: 'inProgress' | 'completed' | 'failed';
      contentItems: DynamicToolContentItem[] | null;
      success: boolean | null;
    }
  | { type: 'userMessage'; id: string };

// Notifications: item/started, item/completed, turn/completed, error, thread/tokenUsage/updated
export type ItemNotification = { item: ThreadItem; threadId: string; turnId: string };
export type TurnCompletedNotification = { threadId: string; turn: Turn };
export type ErrorNotification = { error: TurnError; willRetry: boolean; threadId: string; turnId: string };
export type TokenUsageBreakdown = { totalTokens: number; inputTokens: number; cachedInputTokens: number; cacheWriteInputTokens: number; outputTokens: number; reasoningOutputTokens: number };
export type ThreadTokenUsageUpdatedNotification = { threadId: string; turnId: string; tokenUsage: { total: TokenUsageBreakdown; last: TokenUsageBreakdown } };

// Server requests: item/commandExecution/requestApproval, item/fileChange/requestApproval, item/permissions/requestApproval,
// item/tool/call; item/tool/requestUserInput and mcpServer/elicitation/request are refused without reading their params.
export type CommandExecutionRequestApprovalParams = {
  /** "command", or "writeStdin" for input to a running terminal. Older servers leave it out. */
  kind?: 'command' | 'writeStdin';
  threadId: string;
  turnId: string;
  itemId: string;
  approvalId?: string | null;
  reason?: string | null;
  networkApprovalContext?: unknown;
  command?: string | null;
  cwd?: string | null;
  /** "Best-effort parsed command actions for friendly display." */
  commandActions?: CommandAction[] | null;
  additionalPermissions?: unknown;
};
/** We never send acceptForSession or the policy-amendment forms. */
export type CommandExecutionRequestApprovalResponse = { decision: 'accept' | 'decline' };
export type FileChangeRequestApprovalParams = { threadId: string; turnId: string; itemId: string; reason?: string | null; grantRoot?: string | null };
export type FileChangeRequestApprovalResponse = { decision: 'accept' | 'decline' };
export type PermissionsRequestApprovalParams = { threadId: string; turnId: string; itemId: string; reason: string | null; permissions: unknown };
/** An empty grant is the protocol's "no" (ruling R3). */
export type PermissionsRequestApprovalResponse = { permissions: Record<string, never>; scope: 'turn' | 'session' };
export type DynamicToolCallParams = { threadId: string; turnId: string; callId: string; namespace: string | null; tool: string; arguments: unknown };
/** codex-cli 0.160's DynamicToolCallOutputContentItem: text, an image (a data: URL works) or audio. */
export type DynamicToolCallResponse = { contentItems: DynamicToolContentItem[]; success: boolean };
