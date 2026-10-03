import * as vscode from 'vscode';
import type { AgentProvider } from '@agent-stream/engine';
import type { ProviderStatus } from '@agent-stream/shared';

export const COPILOT_NOT_IMPLEMENTED = "Copilot support isn't implemented yet. Switch to Claude with Agent Stream: Select Provider.";
export const COPILOT_UNAVAILABLE = "GitHub Copilot isn't available. Install the GitHub Copilot extension and sign in, or switch to Claude with Agent Stream: Select Provider.";

export type LmApi = { selectChatModels(selector: { vendor: string }): Thenable<readonly { name: string }[]> };

/**
 * GitHub Copilot through VS Code's Language Model API (provider spec §3.5). This round only
 * detects the models; it never sends a request, so VS Code's consent prompt doesn't appear.
 */
export function createCopilotProvider(...args: [lm?: LmApi]): AgentProvider {
  // An explicit `undefined` means "no API" (tests), so a default parameter value can't be used here.
  const lm = args.length > 0 ? args[0] : (vscode as { lm?: LmApi }).lm;
  const unavailable = (reason?: string): ProviderStatus => ({
    provider: 'copilot',
    ok: false,
    label: 'Copilot not available',
    error: reason ? `${COPILOT_UNAVAILABLE} (${reason})` : COPILOT_UNAVAILABLE,
  });
  return {
    id: 'copilot',
    name: 'GitHub Copilot',
    async status() {
      if (!lm?.selectChatModels) return unavailable('This version of VS Code has no Language Model API.');
      try {
        const models = await lm.selectChatModels({ vendor: 'copilot' });
        if (models.length === 0) return unavailable();
        const names = [...new Set(models.map((m) => m.name))].join(', ');
        return { provider: 'copilot', ok: false, preview: true, label: 'Copilot (preview)', detail: `Models: ${names}. Running steps with Copilot isn't implemented yet.`, error: COPILOT_NOT_IMPLEMENTED };
      } catch (e) {
        return unavailable(e instanceof Error ? e.message : String(e));
      }
    },
    runStep: async () => ({ ok: false, output: '', error: COPILOT_NOT_IMPLEMENTED }),
    planTurn: async () => ({ ok: false, error: COPILOT_NOT_IMPLEMENTED }),
  };
}
