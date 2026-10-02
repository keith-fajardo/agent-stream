import { execFile } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';
import type { AuthInfo } from '@claude-stream/shared';

const API_KEY_VARS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'];
/** Init-message auth sources that mean "no API key": the subscription login is in use. */
const SUBSCRIPTION_SOURCES = new Set(['none', 'oauth']);

export function resolveClaudePath(env: NodeJS.ProcessEnv = process.env): string | null {
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, 'claude');
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // not in this folder; keep looking
    }
  }
  return null;
}

/** Copy of `env` without API-key variables, so Claude Code uses the subscription login. */
export function sanitizedEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = { ...env };
  for (const key of API_KEY_VARS) delete out[key];
  return out;
}

export function isSubscriptionAuthSource(source: string): boolean {
  return SUBSCRIPTION_SOURCES.has(source);
}

export function authSourceError(source: string): string {
  return `This Claude session authenticated with "${source}" instead of your Claude subscription. Remove API keys from the environment and sign in with /login in Claude Code.`;
}

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
