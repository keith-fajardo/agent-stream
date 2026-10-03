import { describe, expect, it, vi } from 'vitest';
import type { ProviderStatus } from '@agent-stream/shared';
import { checkingStatus } from '../src/engines';
import { sessionStatusText, signInDetails, statusBarText } from '../src/statusBar';

describe('statusBarText', () => {
  it('shows the provider and plan when it can run', () => {
    expect(statusBarText({ provider: 'claude', ok: true, label: 'Claude Max', detail: 'me@example.com' })).toEqual({
      text: '$(check) Claude Max',
      tooltip: 'Agent Stream runs on Claude Max (me@example.com).',
    });
  });

  it('warns otherwise, with the reason in the tooltip', () => {
    expect(statusBarText({ provider: 'claude', ok: false, label: 'not signed in', error: 'Not signed in to Claude Code.' })).toEqual({
      text: '$(warning) Agent Stream: not signed in',
      tooltip: 'Not signed in to Claude Code.',
    });
  });

  it('shows Copilot like any provider that can run', () => {
    expect(statusBarText({ provider: 'copilot', ok: true, label: 'Copilot', detail: 'Models: Auto.' })).toEqual({
      text: '$(check) Copilot',
      tooltip: 'Agent Stream runs on Copilot (Models: Auto.).',
    });
  });

  it('names the default model and effort in the tooltip', () => {
    const ok: ProviderStatus = { provider: 'claude', ok: true, label: 'Claude Max', detail: 'me@example.com' };
    expect(statusBarText(ok, { model: 'sonnet', effort: 'high' }).tooltip).toBe('Agent Stream runs on Claude Max (me@example.com).\nDefault model: sonnet · Effort: high');
    expect(statusBarText(ok, { model: '', effort: '' }).tooltip).toBe('Agent Stream runs on Claude Max (me@example.com).\nDefault model: Default · Effort: Default');
  });

  it('shows the check in progress', () => {
    expect(statusBarText(checkingStatus({ id: 'claude', name: 'Claude' })).text).toBe('$(sync~spin) Agent Stream');
  });
});

describe('sessionStatusText', () => {
  it('shows the active session', () => {
    expect(sessionStatusText('Default')).toEqual({ text: '$(layers) Default', tooltip: 'Agent Stream session: Default. Click to switch.' });
  });
});

describe('signInDetails', () => {
  const deps = (choice?: string) => ({ info: vi.fn(), warn: vi.fn(async () => choice), recheck: vi.fn(async () => {}) });

  it('names the provider when it can run', async () => {
    const d = deps();
    await signInDetails({ provider: 'claude', ok: true, label: 'Claude Max', detail: 'me@example.com' }, d);
    expect(d.info).toHaveBeenCalledWith('Agent Stream runs on Claude Max · me@example.com.');
    expect(d.warn).not.toHaveBeenCalled();
  });

  it('shows the reason with Check again, which checks again', async () => {
    const d = deps('Check again');
    await signInDetails({ provider: 'claude', ok: false, label: 'not signed in', error: 'Not signed in to Claude Code.' }, d);
    expect(d.warn).toHaveBeenCalledWith('Not signed in to Claude Code.', 'Check again');
    expect(d.recheck).toHaveBeenCalledTimes(1);
  });

  it("falls back to the status's own label, never a Claude sign-in message", async () => {
    const d = deps();
    const copilot: ProviderStatus = { provider: 'copilot', ok: false, label: 'Copilot unavailable' };
    await signInDetails(copilot, d);
    expect(d.warn).toHaveBeenCalledWith('Copilot unavailable', 'Check again');
    expect(d.recheck).not.toHaveBeenCalled();
  });
});
