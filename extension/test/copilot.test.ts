import { describe, expect, it, vi } from 'vitest';
import { COPILOT_NOT_IMPLEMENTED, COPILOT_UNAVAILABLE, createCopilotProvider } from '../src/providers/copilot';

const lm = (impl: () => Promise<{ name: string }[]>) => ({ selectChatModels: vi.fn(impl) });

describe('Copilot provider (scaffold)', () => {
  it('is a preview when VS Code reports Copilot models', async () => {
    const p = createCopilotProvider(lm(async () => [{ name: 'GPT-5' }, { name: 'Claude Sonnet' }, { name: 'GPT-5' }]));
    expect(p.id).toBe('copilot');
    expect(p.name).toBe('GitHub Copilot');
    expect(await p.status()).toEqual({
      provider: 'copilot', ok: false, preview: true, label: 'Copilot (preview)',
      detail: "Models: GPT-5, Claude Sonnet. Running steps with Copilot isn't implemented yet.", error: COPILOT_NOT_IMPLEMENTED,
    });
  });
  it('is not available without models', async () => {
    expect(await createCopilotProvider(lm(async () => [])).status()).toEqual({ provider: 'copilot', ok: false, label: 'Copilot not available', error: COPILOT_UNAVAILABLE });
  });
  it('is not available when the API is missing or throws, with the reason', async () => {
    expect((await createCopilotProvider(undefined).status()).error).toBe(`${COPILOT_UNAVAILABLE} (This version of VS Code has no Language Model API.)`);
    expect((await createCopilotProvider(lm(async () => { throw new Error('no consent'); })).status()).error).toBe(`${COPILOT_UNAVAILABLE} (no consent)`);
  });
  it('refuses steps and planner turns, and never sends a model request', async () => {
    const api = lm(async () => [{ name: 'GPT-5' }]);
    const p = createCopilotProvider(api);
    expect(await p.runStep({} as never, {} as never)).toEqual({ ok: false, output: '', error: COPILOT_NOT_IMPLEMENTED });
    expect(await p.planTurn({} as never)).toEqual({ ok: false, error: COPILOT_NOT_IMPLEMENTED });
    expect(api.selectChatModels).not.toHaveBeenCalled();
  });
});
