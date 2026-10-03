import { describe, expect, it } from 'vitest';
import { CHECKING } from '../src/engines';
import { statusBarText } from '../src/statusBar';

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
    expect(statusBarText(CHECKING).text).toBe('$(sync~spin) Agent Stream');
  });
});
