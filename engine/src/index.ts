/** The engine's public API: what the VS Code extension uses. */
export { createApp, type App, type AppDeps, type Client } from './app';
export { CHANGED_SINCE_REVIEW } from './app';
export { isGraphId } from './paths';
export { checkAuth, projectSettingsProblem, sanitizedEnv } from './providers/claude/auth';
export { createClaudeProvider } from './providers/claude';
export { createPlannerGate, createStepGate, type ToolGate } from './providers/toolGate';
export type { AgentProvider, GraphTool, PlannerTurn, PlannerTurnResult } from './providers/types';
export { legacyValuesFileFor, valuesFileFor } from './variableValues';
export { CLAUDE_MISSING, findClaude, findGitBash, GIT_BASH_MISSING, type Found } from './platform';
export { envLookup } from './runPreview';
export type { NodeOutcome } from './executors';
export { GIT_MISSING, inspectCheckout, NOT_A_REPO, realGit, realOrResolved, type GitExec, type GitResult } from './git';
export { createWriteLeases, leaseKey, type LeaseResult, type WriteLeases } from './writeLease';
export { createVariantWorkspaces, pruneWorkspaces, removeWorkspace, variantPath } from './variantWorkspaces';
