/** The engine's public API: what the VS Code extension uses. */
export { createApp, type App, type AppDeps, type Client, type RunWorkspaceItem } from './app';
export { CHANGED_SINCE_REVIEW } from './app';
export { isGraphId } from './paths';
export { checkAuth, projectSettingsProblem, sanitizedEnv } from './providers/claude/auth';
export { createClaudeProvider } from './providers/claude';
export { createCodexProvider, type CodexProviderDeps } from './providers/codex';
export { CODEX_MISSING, findCodex } from './providers/codex/auth';
export { createPlannerGate, createStepGate, STEP_GRAPH_TOOL_PREFIX, type ToolGate } from './providers/toolGate';
export type { AgentProvider, GraphTool, PlannerEvent, PlannerTurn, PlannerTurnResult, TranscriptStore, TurnFile } from './providers/types';
export { legacyValuesFileFor, valuesFileFor } from './variableValues';
export { CLAUDE_MISSING, findClaude, findGitBash, GIT_BASH_MISSING, type Found } from './platform';
export { envLookup } from './runPreview';
export type { NodeContext, NodeOutcome } from './executors';
export { createRunShell, type RunShell, type RunShellResult } from './shell';
export { ChatModelError, type ChatMessage, type ChatModel, type ChatModelErrorCode, type ChatPart, type ImagePart, type ToolSpec } from './agentLoop/chatModel';
export { notIncluded, promptWithNotes } from './chatAttachments';
export { attachedPrompt, ATTACHED_IMAGE, CLAUDE_IMAGE_MAX_BYTES, IMAGE_NOT_SHOWN, inlineBudget, OVER_BUDGET_IN_CHAT, PDF_MAY_NOT_READ, readIfThere, readImages, TEXT_OVER_2_MB, withAttachedFiles, type ImageData, type StepAttachment } from './attachedFiles';
export { builtinTools, MAX_READ_BYTES, type LoopTool, type ToolOutput } from './agentLoop/tools';
export { toLoopTools } from './agentLoop/graphLoopTools';
export { lastAssistantText, runAgentLoop, type LoopOptions, type LoopResult } from './agentLoop/loop';
export { ALTERNATIVES_RULE, PARALLEL_POLICY, SERIALIZATION_GUIDANCE } from './policy';
export { GIT_MISSING, inspectCheckout, NOT_A_REPO, realGit, realOrResolved, type GitExec, type GitResult } from './git';
export { createWriteLeases, leaseKey, type LeaseBlock, type LeaseResult, type WriteLeases } from './writeLease';
export { createVariantWorkspaces, pruneWorkspaces, removeWorkspace, variantPath } from './variantWorkspaces';
export {
  checkSetup,
  createWorktrees,
  MAX_TICKETS,
  planWorktrees,
  realWorktreeFs,
  ticketSlug,
  ticketSlugs,
  worktreeAddArgs,
  type SetupCheck,
  type WorktreeFs,
  type WorktreeItem,
  type WorktreePlan,
} from './worktrees';
export { CHECK_COMMAND, starterGraph, writeStarterGraph } from './ticketGraph';
export { AB_MEASUREMENT_GUIDANCE, abTestGraph, abVariableName, MAX_VARIANTS, MIN_VARIANTS, variantProblem } from './abTestGraph';
