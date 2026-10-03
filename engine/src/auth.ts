import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AuthInfo } from '@agent-stream/shared';

/** Variables that make Claude Code use an API key or send requests (and the login token) to another host. */
const REMOVED_VARS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL'];
/** Provider switches such as CLAUDE_CODE_USE_BEDROCK / _VERTEX. */
const PROVIDER_SWITCH_PREFIX = 'CLAUDE_CODE_USE_';
/** Project settings env keys that would route Claude away from the subscription. */
const SETTINGS_ENV_KEYS = new Set(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL']);
const SETTINGS_ENV_PREFIXES = ['CLAUDE_CODE_USE_', 'ANTHROPIC_BEDROCK', 'ANTHROPIC_VERTEX'];
/** Init-message auth sources that mean "no API key": the subscription login is in use. */
const SUBSCRIPTION_SOURCES = new Set(['none', 'oauth']);

/** Copy of `env` without API-key, base-URL and provider-switch variables, so Claude Code uses the subscription login. */
export function sanitizedEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = { ...env };
  for (const key of Object.keys(out)) {
    if (REMOVED_VARS.includes(key) || key.startsWith(PROVIDER_SWITCH_PREFIX) || key === 'ELECTRON_RUN_AS_NODE') delete out[key];
  }
  return out;
}

/**
 * Sessions load the project's .claude/settings.json after the startup auth check, and its `env`
 * and `apiKeyHelper` would apply to them. Returns why that file would take Claude off the
 * subscription, or null when it is absent or harmless.
 */
export function projectSettingsProblem(projectDir: string): string | null {
  const path = join(projectDir, '.claude', 'settings.json');
  if (!existsSync(path)) return null;
  let settings: unknown;
  try {
    settings = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    return `This project's .claude/settings.json could not be read (${(e as Error).message}), so Agent Stream cannot confirm it keeps Claude on your subscription. Fix it to use Agent Stream here.`;
  }
  if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) {
    return "This project's .claude/settings.json is not a JSON object, so Agent Stream cannot confirm it keeps Claude on your subscription. Fix it to use Agent Stream here.";
  }
  const { env, apiKeyHelper } = settings as { env?: unknown; apiKeyHelper?: unknown };
  const routedAway = (key: string) =>
    `This project's .claude/settings.json sets ${key}, which would route Claude away from your subscription. Remove it to use Agent Stream here.`;
  if (apiKeyHelper !== undefined) return routedAway('apiKeyHelper');
  if (typeof env === 'object' && env !== null) {
    for (const key of Object.keys(env)) {
      if (SETTINGS_ENV_KEYS.has(key) || SETTINGS_ENV_PREFIXES.some((p) => key.startsWith(p))) return routedAway(key);
    }
  }
  return null;
}

export function isSubscriptionAuthSource(source: string): boolean {
  return SUBSCRIPTION_SOURCES.has(source);
}

export function authSourceError(source: string): string {
  return `This Claude session authenticated with "${source}" instead of your Claude subscription. Remove API keys from the environment and sign in with /login in Claude Code.`;
}

/** A session that produced a result without an init message never told us its auth source. */
export const UNVERIFIED_AUTH = 'The Claude session did not report how it authenticated.';

export type ExecFn = (file: string, args: string[]) => Promise<string>;

const execStatus: ExecFn = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { env: sanitizedEnv(), timeout: 15_000 }, (err, stdout) => {
      if (stdout.trim()) resolve(stdout);
      else reject(err ?? new Error('no output'));
    });
  });

export async function checkAuth(claudePath: string, run: ExecFn = execStatus): Promise<AuthInfo> {
  let raw: string;
  try {
    raw = await run(claudePath, ['auth', 'status']);
  } catch (e) {
    return { ok: false, error: `Could not run "claude auth status": ${(e as Error).message}` };
  }
  let status: Record<string, unknown>;
  try {
    status = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { ok: false, error: 'Got unexpected output from "claude auth status".' };
  }
  if (status.loggedIn !== true) {
    return { ok: false, error: 'Not signed in to Claude Code. Run `claude`, then /login with your Claude account.' };
  }
  const info = {
    method: typeof status.authMethod === 'string' ? status.authMethod : undefined,
    plan: typeof status.subscriptionType === 'string' ? status.subscriptionType : undefined,
    email: typeof status.email === 'string' ? status.email : undefined,
  };
  if (typeof status.apiProvider === 'string' && status.apiProvider !== 'firstParty') {
    return { ok: false, ...info, error: `Claude Code is configured for "${status.apiProvider}", not your Claude subscription.` };
  }
  if (info.method !== 'claude.ai') {
    return {
      ok: false,
      ...info,
      error: `Signed in with "${info.method ?? 'unknown'}", which is not a Claude subscription. Sign in with /login using your Claude account.`,
    };
  }
  return { ok: true, ...info };
}
