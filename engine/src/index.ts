/** The engine's public API: what the VS Code extension uses. */
export { createApp, type App, type AppDeps, type Client } from './app';
export { CHANGED_SINCE_REVIEW } from './app';
export { isGraphId } from './paths';
export { checkAuth, projectSettingsProblem, sanitizedEnv } from './auth';
export { valuesFileFor } from './variableValues';
export { CLAUDE_MISSING, findClaude, findGitBash, GIT_BASH_MISSING, type Found } from './platform';
export { envLookup } from './runPreview';
