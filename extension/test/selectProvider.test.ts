import { describe, expect, it, vi } from 'vitest';
import type { ProviderStatus } from '@agent-stream/shared';
import { selectProvider } from '../src/selectProvider';

const claude = { id: 'claude' as const, name: 'Claude', status: async (): Promise<ProviderStatus> => ({ provider: 'claude', ok: true, label: 'Claude Max', detail: 'me@example.com' }) };
const copilot = { id: 'copilot' as const, name: 'GitHub Copilot', status: async (): Promise<ProviderStatus> => ({ provider: 'copilot', ok: false, label: 'Copilot not available', error: 'x' }) };

function deps(choice: (items: { id: string }[]) => { id: string } | undefined) {
  return { providers: [claude, copilot], current: () => 'claude' as const, pick: vi.fn(async (items: { id: string }[]) => choice(items)), write: vi.fn(async () => {}), recheck: vi.fn(async () => {}) };
}

describe('selectProvider', () => {
  it('lists each provider with its fresh status, plus Check again', async () => {
    const d = deps(() => undefined);
    await selectProvider(d as never);
    expect(d.pick.mock.calls[0][0]).toEqual([
      { id: 'claude', label: '$(check) Claude', description: 'Claude Max', detail: 'me@example.com' },
      { id: 'copilot', label: 'GitHub Copilot', description: 'Copilot not available', detail: 'x' },
      { id: 'recheck', label: '$(refresh) Check again' },
    ]);
    expect(d.write).not.toHaveBeenCalled();
  });
  it('writes a different provider, and re-checks the same one', async () => {
    const pickCopilot = deps((items) => items[1]);
    await selectProvider(pickCopilot as never);
    expect(pickCopilot.write).toHaveBeenCalledWith('copilot');
    const pickSame = deps((items) => items[0]);
    await selectProvider(pickSame as never);
    expect(pickSame.write).not.toHaveBeenCalled();
    expect(pickSame.recheck).toHaveBeenCalled();
  });
});

describe('selectProvider with OpenAI Codex', () => {
  const codex = {
    id: 'codex' as const,
    name: 'OpenAI Codex',
    status: async (): Promise<ProviderStatus> => ({ provider: 'codex', ok: false, label: 'Codex: not signed in', error: 'Run codex login in a terminal and sign in with ChatGPT.' }),
  };

  it('lists Codex with its status, and writes it when picked', async () => {
    const pick = vi.fn(async (items: { id: string }[]) => items.find((i) => i.id === 'codex'));
    const write = vi.fn(async () => {});
    await selectProvider({ providers: [claude, copilot, codex], current: () => 'claude', pick, write, recheck: vi.fn(async () => {}) } as never);
    expect(pick.mock.calls[0][0][2]).toEqual({ id: 'codex', label: 'OpenAI Codex', description: 'Codex: not signed in', detail: 'Run codex login in a terminal and sign in with ChatGPT.' });
    expect(write).toHaveBeenCalledWith('codex');
  });
});
