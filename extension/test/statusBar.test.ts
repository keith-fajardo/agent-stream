import { describe, expect, it } from 'vitest';
import { checkingStatus } from '../src/engines';
import { sessionStatusText, statusBarText } from '../src/statusBar';

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

  it('marks a preview provider', () => {
    expect(statusBarText({ provider: 'copilot', ok: false, preview: true, label: 'Copilot (preview)', detail: 'Models: GPT-5.', error: 'x' })).toEqual({
      text: '$(beaker) Copilot (preview)',
      tooltip: 'Models: GPT-5.',
    });
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
