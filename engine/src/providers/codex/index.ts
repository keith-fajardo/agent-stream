import { PROVIDER_NAMES, type ProviderStatus } from '@agent-stream/shared';
import type { Found } from '../../platform';
import type { AgentProvider } from '../types';
import { readCodexStatus } from './auth';
import { openCodex, type SpawnCodex } from './connection';
import { createModelList, fetchCodexModels } from './models';
import { codexPlanTurn } from './planTurn';
import { codexRunStep, type CodexRunDeps } from './runStep';

export type CodexProviderDeps = {
  findCodex: () => Found;
  /** Tests substitute the fake app-server; default: the real `codex app-server`. */
  spawn?: SpawnCodex;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** Where problems worth a line go (a model list that failed, an effort dropped). Default: console.warn. */
  log?: (message: string) => void;
  interruptWaitMs?: number;
};

/**
 * OpenAI Codex on the user's ChatGPT subscription, through their own `codex app-server` (spec §3, §4). Every
 * ChatGPT-only rule lives in auth.ts and connection.ts; every approval goes through the ToolGate.
 */
export function createCodexProvider(d: CodexProviderDeps): AgentProvider {
  let path: string | undefined;
  let missing = 'Agent Stream has not checked for Codex yet.';
  const log = d.log ?? ((message: string) => console.warn(message));
  const warned = new Set<string>();
  const warnOnce = (key: string, message: string) => {
    if (warned.has(key)) return;
    warned.add(key);
    log(message);
  };
  const models = createModelList(async () => {
    const codexPath = path;
    if (!codexPath) return [];
    const conn = await openCodex({ codexPath, spawn: d.spawn, env: d.env, log });
    try {
      return await fetchCodexModels(conn);
    } finally {
      conn.close();
    }
  }, log);
  /** Checked again on every call (startup, a setting change, Check again, Select Provider); callers at once share one check (R5). */
  let checking: Promise<ProviderStatus> | undefined;
  async function check(): Promise<ProviderStatus> {
    const found = d.findCodex();
    if (!found.ok) {
      path = undefined;
      missing = found.error;
      return { provider: 'codex', ok: false, label: 'Codex: not found', error: found.error };
    }
    path = found.path;
    return { provider: 'codex', ...(await readCodexStatus({ codexPath: found.path, spawn: d.spawn, env: d.env })) };
  }
  const shared: CodexRunDeps = {
    codexPath: () => path,
    missing: () => missing,
    spawn: d.spawn,
    env: d.env,
    platform: d.platform ?? process.platform,
    knownModels: () => models.known(),
    warnOnce,
    log,
    interruptWaitMs: d.interruptWaitMs,
  };
  return {
    id: 'codex',
    name: PROVIDER_NAMES.codex,
    status() {
      checking ??= check().finally(() => (checking = undefined));
      return checking;
    },
    runStep: codexRunStep(shared),
    planTurn: codexPlanTurn(shared),
    knownModels: () => models.known(),
    listModels: (o) => (path ? models.list(o) : Promise.resolve([])),
  };
}
