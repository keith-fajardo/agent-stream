import type { ModelChoice, ProviderStatus } from '@agent-stream/shared';
import type { Found } from '../../platform';
import type { AgentProvider } from '../types';
import { checkAuth as realCheckAuth, projectSettingsProblem } from './auth';
import { fetchModels } from './models';
import { claudePlanTurn } from './planTurn';
import { claudeRunStep, type ClaudeRunDeps } from './runStep';
import { realModelQuery, realQuery, type ModelQueryFn, type QueryFn } from './sdk';

export type ClaudeProviderDeps = {
  findClaude: () => Found;
  checkAuth?: (claudePath: string) => Promise<ProviderStatus>;
  queryFn?: QueryFn;
  /** Lists the models (listModels); tests substitute a fake. */
  modelQueryFn?: ModelQueryFn;
  /** Where problems worth a line go (a model list that failed, an effort dropped). Default: console.warn. */
  log?: (message: string) => void;
  env?: NodeJS.ProcessEnv;
};

/** Claude Code on the user's Claude subscription (spec §3.4); every subscription rule stays here. */
export function createClaudeProvider(d: ClaudeProviderDeps): AgentProvider {
  let path: string | undefined;
  let missing = 'Agent Stream has not checked for Claude Code yet.';
  const log = d.log ?? ((message: string) => console.warn(message));
  const warned = new Set<string>();
  const warnOnce = (key: string, message: string) => {
    if (warned.has(key)) return;
    warned.add(key);
    log(message);
  };
  /** The model list, once it was read. A failed read stands for this provider's life (one window), bar one retry when asked. */
  let models: ModelChoice[] | undefined;
  let pending: Promise<ModelChoice[]> | undefined;
  let failed = false;
  let retried = false;
  const shared: ClaudeRunDeps = { claudePath: () => path, missing: () => missing, queryFn: d.queryFn ?? realQuery, env: d.env, knownModels: () => models, warnOnce };
  return {
    id: 'claude',
    name: 'Claude',
    async status() {
      const found = d.findClaude();
      if (!found.ok) {
        path = undefined;
        missing = found.error;
        return { provider: 'claude', ok: false, label: 'not signed in', error: found.error };
      }
      path = found.path;
      return (d.checkAuth ?? realCheckAuth)(found.path);
    },
    folderProblem: (dir) => projectSettingsProblem(dir) ?? undefined,
    runStep: claudeRunStep(shared),
    planTurn: claudePlanTurn(shared),
    knownModels: () => models,
    async listModels(o) {
      if (models) return models;
      if (pending) return pending;
      const claudePath = path;
      if (!claudePath) return [];
      if (failed) {
        // A failing CLI isn't started again for every preview or chat: one retry, and only when asked.
        if (!o?.retry || retried) return [];
        retried = true;
      }
      pending = fetchModels(d.modelQueryFn ?? realModelQuery, claudePath, d.env ?? process.env)
        .then(
          (list) => (models = list),
          (e: unknown) => {
            failed = true;
            warnOnce('listModels', `[agent-stream] Could not list Claude models; the menus offer only Default (${e instanceof Error ? e.message : String(e)}).`);
            return [];
          },
        )
        .finally(() => (pending = undefined));
      return pending;
    },
  };
}
