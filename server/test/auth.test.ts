import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { authSourceError, checkAuth, isSubscriptionAuthSource, resolveClaudePath, sanitizedEnv } from '../src/auth';

describe('resolveClaudePath', () => {
  it('finds an executable named claude on PATH', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bin-'));
    const file = join(dir, 'claude');
    writeFileSync(file, '#!/bin/sh\n');
    chmodSync(file, 0o755);
    expect(resolveClaudePath({ PATH: ['/nonexistent', dir].join(delimiter) })).toBe(file);
    expect(resolveClaudePath({ PATH: '/nonexistent' })).toBeNull();
  });
});

describe('checkAuth', () => {
  const status = (s: object) => async () => JSON.stringify(s);

  it('accepts a claude.ai subscription login', async () => {
    const s = { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', email: 'me@example.com', subscriptionType: 'max' };
    expect(await checkAuth('claude', status(s))).toEqual({ ok: true, method: 'claude.ai', plan: 'max', email: 'me@example.com' });
  });

  it.each([
    [{ loggedIn: false }, 'Not signed in'],
    [{ loggedIn: true, authMethod: 'api_key', apiProvider: 'firstParty' }, 'not a Claude subscription'],
    [{ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'bedrock' }, 'bedrock'],
  ])('rejects %j', async (s, message) => {
    const r = await checkAuth('claude', status(s));
    expect(r.ok).toBe(false);
    expect(r.error).toContain(message);
  });

  it('reports unreadable output and failures to run', async () => {
    expect((await checkAuth('claude', async () => 'not json')).error).toContain('unexpected output');
    const failing = async (): Promise<string> => {
      throw new Error('spawn claude ENOENT');
    };
    expect((await checkAuth('claude', failing)).error).toContain('ENOENT');
  });
});

describe('subscription safety helpers', () => {
  it('removes API-key variables and keeps everything else', () => {
    expect(sanitizedEnv({ PATH: '/bin', HOME: '/h', ANTHROPIC_API_KEY: 'sk', ANTHROPIC_AUTH_TOKEN: 't' })).toEqual({ PATH: '/bin', HOME: '/h' });
  });

  it('accepts only subscription auth sources', () => {
    expect(isSubscriptionAuthSource('none')).toBe(true);
    expect(isSubscriptionAuthSource('oauth')).toBe(true);
    expect(isSubscriptionAuthSource('ANTHROPIC_API_KEY')).toBe(false);
    expect(isSubscriptionAuthSource('apiKeyHelper')).toBe(false);
    expect(authSourceError('apiKeyHelper')).toContain('"apiKeyHelper"');
  });
});
