import { describe, expect, it } from 'vitest';
import { CHECKING } from '../src/engines';
import { statusBarText } from '../src/statusBar';

describe('statusBarText', () => {
  it('shows the plan when signed in with the subscription', () => {
    expect(statusBarText({ ok: true, plan: 'max', email: 'me@example.com' })).toEqual({
      text: '$(check) Claude Max',
      tooltip: 'Agent Stream runs on your Claude Max subscription (me@example.com).',
    });
  });

  it('warns otherwise, with the reason in the tooltip', () => {
    expect(statusBarText({ ok: false, error: 'Not signed in to Claude Code.' })).toEqual({
      text: '$(warning) Agent Stream: not signed in',
      tooltip: 'Not signed in to Claude Code.',
    });
  });

  it('shows the check in progress', () => {
    expect(statusBarText(CHECKING).text).toBe('$(sync~spin) Agent Stream');
  });
});
