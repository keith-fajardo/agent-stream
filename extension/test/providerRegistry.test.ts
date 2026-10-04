import { describe, expect, it } from 'vitest';
import { parseProviderSetting } from '../src/providers/registry';

describe('parseProviderSetting', () => {
  it('accepts the known providers and defaults to Claude', () => {
    expect(parseProviderSetting('copilot')).toEqual({ id: 'copilot' });
    expect(parseProviderSetting('claude')).toEqual({ id: 'claude' });
    expect(parseProviderSetting(undefined)).toEqual({ id: 'claude' });
    expect(parseProviderSetting('')).toEqual({ id: 'claude' });
  });
  it('falls back to Claude with a warning for anything else', () => {
    expect(parseProviderSetting('gemini')).toEqual({ id: 'claude', warning: "Unknown agentStream.provider 'gemini'; using Claude." });
  });
});

describe('parseProviderSetting and Codex', () => {
  it('accepts codex', () => {
    expect(parseProviderSetting('codex')).toEqual({ id: 'codex' });
  });
});
