import path from 'node:path';
import type { ProviderStatus } from '@agent-stream/shared';
import { envValue, pathDirs, realProbe, type Found, type Probe } from '../../platform';
import { errorMessage, openCodex, type CodexConnection, type SpawnCodex } from './connection';
import type { GetAccountResponse } from './protocol';

export const CODEX_MISSING =
  'Could not find Codex (codex). Install it from https://developers.openai.com/codex and sign in with ChatGPT, or set agentStream.codexPath.';
export const CODEX_NOT_SIGNED_IN = 'Run codex login in a terminal and sign in with ChatGPT.';
export const CODEX_API_KEY = 'Agent Stream uses your ChatGPT subscription for Codex. Run codex logout, then codex login and choose ChatGPT.';
export const CODEX_SIGNED_IN = 'Signed in with ChatGPT.';
const STATUS_TIMEOUT_MS = 30_000;

/** A Codex status before the provider adds `provider: 'codex'` (R28). */
export type CodexStatus = Omit<ProviderStatus, 'provider'>;

/**
 * The Codex CLI (spec §4.3), like findClaude: the setting, then PATH, then the usual npm global and Homebrew places.
 * VS Code started from the Dock or Start menu may not share the terminal's PATH. On Windows npm installs codex.cmd,
 * which openCodex runs through cmd.exe.
 */
export function findCodex(o: { platform: NodeJS.Platform; env: NodeJS.ProcessEnv; home: string; setting?: string; probe?: Probe }): Found {
  const probe = o.probe ?? realProbe;
  const win = o.platform === 'win32';
  const p = win ? path.win32 : path.posix;
  const usable = (c: string) => (win ? probe.exists(c) : probe.executable(c));
  const setting = o.setting?.trim();
  if (setting) {
    return usable(setting) ? { ok: true, path: setting } : { ok: false, error: `agentStream.codexPath points to ${setting}, which doesn't exist or can't be run.` };
  }
  const names = win ? ['codex.exe', 'codex.cmd', 'codex.bat'] : ['codex'];
  for (const dir of pathDirs(o.env, o.platform)) {
    for (const name of names) {
      const c = p.join(dir, name);
      if (usable(c)) return { ok: true, path: c };
    }
  }
  const fallbacks = win
    ? [p.join(envValue(o.env, 'APPDATA', 'win32') ?? p.join(o.home, 'AppData', 'Roaming'), 'npm', 'codex.cmd')]
    : ['/opt/homebrew/bin/codex', '/usr/local/bin/codex', p.join(o.home, '.local', 'bin', 'codex'), p.join(o.home, '.npm-global', 'bin', 'codex')];
  for (const c of fallbacks) if (usable(c)) return { ok: true, path: c };
  return { ok: false, error: CODEX_MISSING };
}

/** "plus" → "Plus", "self_serve_business_prolite" → "Self serve business prolite" (R7). */
export function planName(plan: unknown): string {
  if (typeof plan !== 'string' || plan.trim() === '') return 'ChatGPT';
  const words = plan.trim().replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** account/read → the status (spec §4.3). Only a ChatGPT sign-in can run; the email is never shown. */
export function accountStatus(r: GetAccountResponse): CodexStatus {
  const account = r.account;
  if (!account) return { ok: false, label: 'Codex: not signed in', error: CODEX_NOT_SIGNED_IN };
  if (account.type !== 'chatgpt') return { ok: false, label: 'Codex: API key', error: CODEX_API_KEY };
  return { ok: true, label: `Codex (${planName(account.planType)})`, detail: CODEX_SIGNED_IN };
}

/** Opens a connection, asks account/read, closes it (spec §4.3). A failure is a status, never a throw (R6). */
export async function readCodexStatus(o: { codexPath: string; spawn?: SpawnCodex; env?: NodeJS.ProcessEnv; timeoutMs?: number }): Promise<CodexStatus> {
  let conn: CodexConnection | undefined;
  try {
    conn = await openCodex({ codexPath: o.codexPath, spawn: o.spawn, env: o.env });
    return accountStatus(await conn.request<GetAccountResponse>('account/read', {}, AbortSignal.timeout(o.timeoutMs ?? STATUS_TIMEOUT_MS)));
  } catch (e) {
    return { ok: false, label: 'Codex: not available', error: errorMessage(e) };
  } finally {
    conn?.close();
  }
}
