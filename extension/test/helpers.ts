import type { AgentProvider } from '@agent-stream/engine';
import type { ProviderStatus } from '@agent-stream/shared';

export const signedIn: ProviderStatus = { provider: 'claude', ok: true, label: 'Claude Max' };
export function testProvider(over: Partial<AgentProvider> = {}): AgentProvider {
  return { id: 'claude', name: 'Claude', status: async () => signedIn, runStep: async () => ({ ok: true, output: '' }), planTurn: async () => ({ ok: true }), ...over };
}
