import { describe, expect, it } from 'vitest';
import type { Probe } from '../src/platform';
import { accountStatus, CODEX_API_KEY, CODEX_MISSING, CODEX_NOT_SIGNED_IN, findCodex, planName, readCodexStatus } from '../src/providers/codex/auth';
import { fakeCodex, FakeRpcError } from './codexFake';

/** Only these files exist, and all of them can be run. */
const probe = (files: string[]): Probe => ({ exists: (p) => files.includes(p), executable: (p) => files.includes(p) });
const mac = (files: string[], o: { env?: NodeJS.ProcessEnv; setting?: string } = {}) => findCodex({ platform: 'darwin', env: o.env ?? { PATH: '/usr/bin:/opt/x/bin' }, home: '/h', setting: o.setting, probe: probe(files) });
const win = (files: string[], o: { env?: NodeJS.ProcessEnv; setting?: string } = {}) => findCodex({ platform: 'win32', env: o.env ?? { Path: 'C:\\a;C:\\b' }, home: 'C:\\h', setting: o.setting, probe: probe(files) });

describe('findCodex', () => {
  it('uses agentStream.codexPath when it can be run, and says so when it cannot', () => {
    expect(mac(['/tools/codex'], { setting: ' /tools/codex ' })).toEqual({ ok: true, path: '/tools/codex' });
    expect(mac([], { setting: '/tools/codex' })).toEqual({ ok: false, error: "agentStream.codexPath points to /tools/codex, which doesn't exist or can't be run." });
    expect(win(['C:\\npm\\codex.cmd'], { setting: 'C:\\npm\\codex.cmd' })).toEqual({ ok: true, path: 'C:\\npm\\codex.cmd' });
  });

  it('finds codex on PATH, in PATH order', () => {
    expect(mac(['/opt/x/bin/codex'])).toEqual({ ok: true, path: '/opt/x/bin/codex' });
    expect(mac(['/usr/bin/codex', '/opt/x/bin/codex'])).toEqual({ ok: true, path: '/usr/bin/codex' });
  });

  it('finds codex.exe, codex.cmd or codex.bat on the Windows Path, matching the variable without case', () => {
    expect(win(['C:\\b\\codex.cmd'])).toEqual({ ok: true, path: 'C:\\b\\codex.cmd' });
    expect(win(['C:\\b\\codex.cmd', 'C:\\b\\codex.exe'])).toEqual({ ok: true, path: 'C:\\b\\codex.exe' });
    expect(win(['C:\\a\\codex.bat'], { env: { PATH: 'C:\\a' } })).toEqual({ ok: true, path: 'C:\\a\\codex.bat' });
  });

  it('falls back to the usual npm global and Homebrew locations', () => {
    for (const p of ['/opt/homebrew/bin/codex', '/usr/local/bin/codex', '/h/.local/bin/codex', '/h/.npm-global/bin/codex']) {
      expect(mac([p], { env: {} })).toEqual({ ok: true, path: p });
    }
    expect(win(['C:\\h\\AppData\\Roaming\\npm\\codex.cmd'], { env: {} })).toEqual({ ok: true, path: 'C:\\h\\AppData\\Roaming\\npm\\codex.cmd' });
    expect(win(['D:\\roam\\npm\\codex.cmd'], { env: { APPDATA: 'D:\\roam' } })).toEqual({ ok: true, path: 'D:\\roam\\npm\\codex.cmd' });
  });

  it('says how to install Codex when it is nowhere', () => {
    expect(mac([])).toEqual({ ok: false, error: CODEX_MISSING });
    expect(win([])).toEqual({ ok: false, error: CODEX_MISSING });
    expect(CODEX_MISSING).toBe('Could not find Codex (codex). Install it from https://developers.openai.com/codex and sign in with ChatGPT, or set agentStream.codexPath.');
  });

  it('needs an executable file outside Windows', () => {
    const notExecutable: Probe = { exists: () => true, executable: () => false };
    expect(findCodex({ platform: 'linux', env: { PATH: '/usr/bin' }, home: '/h', probe: notExecutable })).toEqual({ ok: false, error: CODEX_MISSING });
  });
});

describe('accountStatus', () => {
  it('maps each account to its status (spec §4.3)', () => {
    expect(accountStatus({ account: { type: 'chatgpt', email: 'someone@example.com', planType: 'plus' }, requiresOpenaiAuth: true })).toEqual({
      ok: true,
      label: 'Codex (Plus)',
      detail: 'Signed in with ChatGPT.',
    });
    expect(accountStatus({ account: null, requiresOpenaiAuth: true })).toEqual({ ok: false, label: 'Codex: not signed in', error: CODEX_NOT_SIGNED_IN });
    expect(accountStatus({ account: { type: 'apiKey' }, requiresOpenaiAuth: true })).toEqual({ ok: false, label: 'Codex: API key', error: CODEX_API_KEY });
    expect(accountStatus({ account: { type: 'amazonBedrock', usesCodexManagedCredentials: true }, requiresOpenaiAuth: false })).toEqual({ ok: false, label: 'Codex: API key', error: CODEX_API_KEY });
    expect(CODEX_API_KEY).toBe('Agent Stream uses your ChatGPT subscription for Codex. Run codex logout, then codex login and choose ChatGPT.');
  });

  it('never shows the account email', () => {
    expect(JSON.stringify(accountStatus({ account: { type: 'chatgpt', email: 'someone@example.com', planType: 'pro' }, requiresOpenaiAuth: true }))).not.toContain('example.com');
  });
});

describe('planName', () => {
  it('capitalises the plan, with underscores as spaces (R7)', () => {
    expect(planName('plus')).toBe('Plus');
    expect(planName('self_serve_business_prolite')).toBe('Self serve business prolite');
    expect(planName('')).toBe('ChatGPT');
    expect(planName(undefined)).toBe('ChatGPT');
  });
});

describe('readCodexStatus', () => {
  it('asks account/read on a short-lived connection and closes it', async () => {
    const fake = fakeCodex({ 'account/read': () => ({ account: { type: 'chatgpt', email: null, planType: 'pro' }, requiresOpenaiAuth: true }) });
    expect(await readCodexStatus({ codexPath: '/bin/codex', spawn: fake.spawn })).toEqual({ ok: true, label: 'Codex (Pro)', detail: 'Signed in with ChatGPT.' });
    expect(fake.last().methods()).toEqual(['initialize', 'initialized', 'account/read']);
    expect(fake.last().paramsOf('account/read')).toEqual({});
    expect(fake.last().killed).toBe(true);
  });

  it('reports a connection that fails with its message (R6)', async () => {
    const fake = fakeCodex({ initialize: () => { throw new FakeRpcError(-32600, 'unsupported client'); } });
    expect(await readCodexStatus({ codexPath: '/bin/codex', spawn: fake.spawn })).toEqual({ ok: false, label: 'Codex: not available', error: "Codex didn't start: unsupported client" });
    const silent = fakeCodex({ 'account/read': () => new Promise(() => {}) });
    expect(await readCodexStatus({ codexPath: '/bin/codex', spawn: silent.spawn, timeoutMs: 20 })).toEqual({ ok: false, label: 'Codex: not available', error: "Codex didn't answer in time." });
    expect(silent.last().killed).toBe(true);
  });
});
