import type { ProviderStatus } from '@agent-stream/shared';
import type { Found } from '../../platform';
import type { AgentProvider } from '../types';
import { checkAuth as realCheckAuth, projectSettingsProblem } from './auth';
import { claudePlanTurn } from './planTurn';
import { claudeRunStep } from './runStep';
import { realQuery, type QueryFn } from './sdk';

export type ClaudeProviderDeps = { findClaude: () => Found; checkAuth?: (claudePath: string) => Promise<ProviderStatus>; queryFn?: QueryFn; env?: NodeJS.ProcessEnv };

/** Claude Code on the user's Claude subscription (spec §3.4); every subscription rule stays here. */
export function createClaudeProvider(d: ClaudeProviderDeps): AgentProvider {
  let path: string | undefined;
  let missing = 'Agent Stream has not checked for Claude Code yet.';
  const shared = { claudePath: () => path, missing: () => missing, queryFn: d.queryFn ?? realQuery, env: d.env };
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
  };
}
