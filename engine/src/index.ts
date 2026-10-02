/** The engine's public API: what the VS Code extension uses. */
export { createApp, type App, type AppDeps, type Client } from './app';
export { checkAuth, projectSettingsProblem, sanitizedEnv } from './auth';
