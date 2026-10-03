import { PROVIDER_IDS, type ProviderId } from '@agent-stream/shared';

export function parseProviderSetting(value: unknown): { id: ProviderId; warning?: string } {
  if (value === undefined || value === null || value === '') return { id: 'claude' };
  if (typeof value === 'string' && (PROVIDER_IDS as readonly string[]).includes(value)) return { id: value as ProviderId };
  return { id: 'claude', warning: `Unknown agentStream.provider '${String(value)}'; using Claude.` };
}
