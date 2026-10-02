import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { authSourceError, checkAuth, isSubscriptionAuthSource, projectSettingsProblem, resolveClaudePath, sanitizedEnv } from '../src/auth';

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

  it('removes variables that switch Claude to another provider or host', () => {
    const env = {
      PATH: '/bin',
      ANTHROPIC_BASE_URL: 'https://gateway.example.com',
      CLAUDE_CODE_USE_BEDROCK: '1',
      CLAUDE_CODE_USE_VERTEX: '1',
      CLAUDE_CODE_USE_FOUNDRY: '1',
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: '8000',
    };
    expect(sanitizedEnv(env)).toEqual({ PATH: '/bin', CLAUDE_CODE_MAX_OUTPUT_TOKENS: '8000' });
  });

  it('accepts only subscription auth sources', () => {
    expect(isSubscriptionAuthSource('none')).toBe(true);
    expect(isSubscriptionAuthSource('oauth')).toBe(true);
    expect(isSubscriptionAuthSource('ANTHROPIC_API_KEY')).toBe(false);
    expect(isSubscriptionAuthSource('apiKeyHelper')).toBe(false);
    expect(authSourceError('apiKeyHelper')).toContain('"apiKeyHelper"');
  });
});

describe('projectSettingsProblem', () => {
  function projectWith(settings?: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'proj-'));
    if (settings !== undefined) {
      mkdirSync(join(dir, '.claude'));
      writeFileSync(join(dir, '.claude', 'settings.json'), settings);
    }
    return dir;
  }
  const routedAway = (key: string) =>
    `This project's .claude/settings.json sets ${key}, which would route Claude away from your subscription. Remove it to use claude-stream here.`;

  it.each([
    ['CLAUDE_CODE_USE_BEDROCK', { env: { CLAUDE_CODE_USE_BEDROCK: '1' } }],
    ['ANTHROPIC_BASE_URL', { env: { ANTHROPIC_BASE_URL: 'https://gateway.example.com' } }],
    ['ANTHROPIC_API_KEY', { env: { ANTHROPIC_API_KEY: 'sk-ant' } }],
    ['ANTHROPIC_AUTH_TOKEN', { env: { ANTHROPIC_AUTH_TOKEN: 't' } }],
    ['ANTHROPIC_VERTEX_PROJECT_ID', { env: { ANTHROPIC_VERTEX_PROJECT_ID: 'p' } }],
    ['ANTHROPIC_BEDROCK_BASE_URL', { env: { ANTHROPIC_BEDROCK_BASE_URL: 'https://b' } }],
    ['apiKeyHelper', { apiKeyHelper: '~/bin/get-key.sh' }],
  ])('flags settings that set %s', (key, settings) => {
    expect(projectSettingsProblem(projectWith(JSON.stringify(settings)))).toBe(routedAway(key));
  });

  it('accepts a project without settings or with harmless settings', () => {
    expect(projectSettingsProblem(projectWith())).toBeNull();
    const clean = { env: { DBT_PROFILES_DIR: '.', CLAUDE_CODE_MAX_OUTPUT_TOKENS: '8000' }, permissions: { allow: ['Bash(ls)'] } };
    expect(projectSettingsProblem(projectWith(JSON.stringify(clean)))).toBeNull();
  });

  it('refuses a settings file it cannot parse', () => {
    expect(projectSettingsProblem(projectWith('{ "env": {'))).toContain("This project's .claude/settings.json");
  });
});
