import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createApp, valuesFileFor, type App, type AppDeps, type Found } from '@agent-stream/engine';
import type { ProviderStatus, ServerMessage } from '@agent-stream/shared';
import { noGit, testProvider } from './helpers';
import { checkingStatus, isChecking, EngineManager, type EngineEvents, type Folder } from '../src/engines';
import type { Settings } from '../src/settings';

const signedIn: ProviderStatus = { provider: 'claude', ok: true, label: 'Claude Max' };
const folder = (name: string): Folder => {
  const path = mkdtempSync(join(tmpdir(), `cs-${name}-`));
  return { key: `file://${path}`, name, path };
};

const defaults = { claudePath: '', gitBashPath: '', maxParallel: 1, provider: 'claude', model: '', effort: '' as const, copilotMaxRequestsPerStep: 25, copilotMaxRequestsPerTurn: 10 };
function baseDeps(events: Partial<EngineEvents> = {}) {
  return {
    platform: 'darwin' as const,
    env: {},
    home: mkdtempSync(join(tmpdir(), 'cs-home-')),
    git: noGit,
    events: { graphs: vi.fn(), approvals: vi.fn(), confirmRun: vi.fn(), graphDeleted: vi.fn(), sessions: vi.fn(), auth: vi.fn(), warning: vi.fn(), ...events } as EngineEvents,
    findClaude: (): Found => ({ ok: true, path: '/bin/claude' }),
    checkAuth: async () => signedIn,
  };
}

function setup(o: { found?: boolean } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'cs-home-'));
  const events: EngineEvents = { graphs: vi.fn(), approvals: vi.fn(), confirmRun: vi.fn(), graphDeleted: vi.fn(), sessions: vi.fn(), auth: vi.fn(), warning: vi.fn() };
  let auth: ProviderStatus = signedIn;
  const checkAuth = vi.fn(async () => auth);
  const apps: App[] = [];
  const manager = new EngineManager({
    settings: () => ({ claudePath: '', gitBashPath: '', maxParallel: 2, provider: 'claude', model: '', effort: '' as const, copilotMaxRequestsPerStep: 25, copilotMaxRequestsPerTurn: 10 }),
    platform: 'darwin',
    env: {},
    home,
    git: noGit,
    events,
    checkAuth,
    findClaude: () => (o.found === false ? { ok: false, error: 'no claude' } : { ok: true, path: '/bin/claude' }),
    createApp: (deps) => {
      const app = createApp(deps);
      apps.push(app);
      return app;
    },
  });
  return { manager, events, checkAuth, apps, home, setAuth: (a: ProviderStatus) => (auth = a) };
}

describe('EngineManager', () => {
  it('starts as "checking" and checks sign-in with the Claude Code it finds', async () => {
    const { manager, events, checkAuth } = setup();
    expect(isChecking(manager.status)).toBe(true);
    expect(manager.status).toEqual(checkingStatus({ id: 'claude', name: 'Claude' }));
    expect(await manager.checkProvider()).toEqual(signedIn);
    expect(checkAuth).toHaveBeenCalledWith('/bin/claude');
    expect(events.auth).toHaveBeenCalledWith(signedIn);
  });

  it('reports a missing Claude Code without running anything', async () => {
    const { manager, checkAuth } = setup({ found: false });
    expect(await manager.checkProvider()).toEqual({ provider: 'claude', ok: false, label: 'not signed in', error: 'no claude' });
    expect(checkAuth).not.toHaveBeenCalled();
  });

  it('creates one engine per folder and reports its graphs', async () => {
    const { manager, events } = setup();
    await manager.checkProvider();
    const a = folder('a');
    const app = manager.get(a);
    expect(manager.get(a)).toBe(app);
    expect(events.graphs).toHaveBeenCalledWith(a, []);
    app.createGraph('G');
    expect(events.graphs).toHaveBeenLastCalledWith(a, [expect.objectContaining({ id: 'g', name: 'G' })]);
  });

  it('disables only a folder whose project settings reroute Claude', async () => {
    const { manager } = setup();
    await manager.checkProvider();
    const bad = folder('bad');
    mkdirSync(join(bad.path, '.claude'));
    writeFileSync(join(bad.path, '.claude', 'settings.json'), JSON.stringify({ env: { ANTHROPIC_API_KEY: 'x' } }));
    expect(manager.folderStatus(bad)).toMatchObject({ ok: false, error: expect.stringContaining('ANTHROPIC_API_KEY') });
    expect(manager.folderStatus(folder('good')).ok).toBe(true);
  });

  it('passes a new sign-in state to engines that already exist', async () => {
    const { manager, setAuth } = setup();
    setAuth({ provider: 'claude', ok: false, label: 'not signed in', error: 'Not signed in.' });
    await manager.checkProvider();
    const msgs: ServerMessage[] = [];
    manager.get(folder('a')).connect({ send: (m) => void msgs.push(m) });
    setAuth(signedIn);
    await manager.checkProvider();
    expect(msgs.at(-1)).toEqual({ type: 'auth', status: signedIn });
  });

  it('gives every engine the one Claude provider, and keeps it through a new check', async () => {
    const { manager } = setup();
    await manager.checkProvider();
    const a = manager.get(folder('a'));
    const b = manager.get(folder('b'));
    expect(a.provider().id).toBe('claude');
    expect(b.provider()).toBe(a.provider());
    const before = a.provider();
    await manager.checkProvider();
    expect(a.provider()).toBe(before);
    expect(a.status()).toEqual(signedIn);
  });

  it('reports the session list of a folder when it connects, and when it changes', async () => {
    const { manager, events } = setup();
    await manager.checkProvider();
    const a = folder('a');
    const app = manager.get(a);
    expect(events.sessions).toHaveBeenCalledWith(a, [expect.objectContaining({ id: 'default', name: 'Default' })]);
    app.createSession('Review');
    const [where, sessions] = vi.mocked(events.sessions).mock.calls.at(-1)!;
    expect(where).toBe(a);
    expect(sessions.map((x) => x.id).sort()).toEqual(['default', 'review']);
  });

  it('keeps approvals apart per folder even when graph ids match', async () => {
    const { manager, events } = setup();
    await manager.checkProvider();
    const a = folder('a');
    const b = folder('b');
    for (const f of [a, b]) manager.get(f).broker.request({ runId: 'r', graphId: 'g', nodeId: 'n1', nodeTitle: 'Build', toolName: 'Bash', input: { command: 'x' } });
    expect(manager.approvals().map((x) => [x.folder.name, x.request.graphId])).toEqual([['a', 'g'], ['b', 'g']]);
    expect(events.approvals).toHaveBeenCalled();
  });

  it('keeps variable values under the home folder, outside the project', async () => {
    const { manager, home } = setup();
    await manager.checkProvider();
    const a = folder('a');
    manager.get(a).values.set('g', 'name', 'v');
    const file = valuesFileFor(a.path, home);
    expect(file.startsWith(join(home, '.agent-stream', 'values'))).toBe(true);
    expect(existsSync(file)).toBe(true);
    expect(existsSync(join(a.path, '.agent-stream', 'values'))).toBe(false);
  });

  it('disposes every engine', async () => {
    const { manager, apps } = setup();
    await manager.checkProvider();
    manager.get(folder('a'));
    manager.get(folder('b'));
    const spies = apps.map((app) => vi.spyOn(app, 'dispose'));
    manager.dispose();
    for (const spy of spies) expect(spy).toHaveBeenCalled();
  });

  it('passes Git Bash to the engine on Windows only', () => {
    const make = (platform: NodeJS.Platform, found: Found) => {
      const findGitBash = vi.fn(() => found);
      const seen: AppDeps[] = [];
      const manager = new EngineManager({
        settings: () => ({ claudePath: '', gitBashPath: 'X', maxParallel: 2, provider: 'claude', model: '', effort: '' as const, copilotMaxRequestsPerStep: 25, copilotMaxRequestsPerTurn: 10 }),
        platform,
        env: {},
        home: mkdtempSync(join(tmpdir(), 'cs-home-')),
        git: noGit,
        events: { graphs: vi.fn(), approvals: vi.fn(), confirmRun: vi.fn(), graphDeleted: vi.fn(), sessions: vi.fn(), auth: vi.fn(), warning: vi.fn() },
        findGitBash,
        createApp: (deps) => {
          seen.push(deps);
          return createApp(deps);
        },
      });
      manager.get(folder('w'));
      return { findGitBash, seen };
    };
    const ok: Found = { ok: true, path: 'C:\\Git\\bin\\bash.exe' };
    const win = make('win32', ok);
    expect(win.findGitBash).toHaveBeenCalledWith({ env: {}, setting: 'X' });
    expect(win.seen[0].gitBash).toEqual(ok);
    const missing: Found = { ok: false, error: 'no bash' };
    expect(make('win32', missing).seen[0].gitBash).toEqual(missing);
    const mac = make('darwin', ok);
    expect(mac.findGitBash).not.toHaveBeenCalled();
    expect(mac.seen[0].gitBash).toBeUndefined();
  });

  it('drops a stale sign-in check that finishes after a newer one', async () => {
    const { manager, events, checkAuth } = setup();
    let release!: (a: ProviderStatus) => void;
    checkAuth.mockImplementationOnce(() => new Promise<ProviderStatus>((r) => (release = r)));
    const a = manager.checkProvider();
    const b = manager.checkProvider();
    expect(await b).toEqual(signedIn);
    release({ provider: 'claude', ok: false, label: 'not signed in', error: 'old' });
    expect(await a).toEqual(signedIn);
    expect(manager.status).toEqual(signedIn);
    expect(vi.mocked(events.auth).mock.calls.filter(([s]) => !isChecking(s))).toEqual([[signedIn]]);
    expect(events.auth).not.toHaveBeenCalledWith({ provider: 'claude', ok: false, label: 'not signed in', error: 'old' });
  });

  it('uses the provider named in the setting, and swaps when it changes', async () => {
    let provider = 'claude';
    const copilot = testProvider({ id: 'copilot', name: 'GitHub Copilot', status: async () => ({ provider: 'copilot', ok: false, label: 'Copilot not available', error: 'nope' }) });
    const manager = new EngineManager({ ...baseDeps(), settings: () => ({ ...defaults, provider }), providers: { copilot: () => copilot } });
    const app = manager.get(folder('a'));
    await manager.checkProvider();
    expect(app.provider().id).toBe('claude');
    provider = 'copilot';
    await manager.checkProvider();
    expect(app.provider()).toBe(copilot);
    expect(app.status()).toMatchObject({ provider: 'copilot', ok: false, error: 'nope' });
  });

  it('warns once about an unknown provider and uses Claude', async () => {
    const warning = vi.fn();
    const manager = new EngineManager({ ...baseDeps({ warning }), settings: () => ({ ...defaults, provider: 'gemini' }) });
    await manager.checkProvider();
    await manager.checkProvider();
    expect(manager.currentProvider().id).toBe('claude');
    expect(warning.mock.calls).toEqual([["Unknown agentStream.provider 'gemini'; using Claude."]]);
  });

  it('builds the Copilot provider with the request caps from the settings, read when asked', () => {
    let perStep = 7;
    const manager = new EngineManager({ ...baseDeps(), settings: () => ({ ...defaults, provider: 'copilot', copilotMaxRequestsPerStep: perStep }) });
    const copilot = manager.providerFor('copilot');
    expect(copilot).toMatchObject({ id: 'copilot', name: 'GitHub Copilot' });
    expect(copilot.stepRequestCap!()).toBe(7);
    perStep = 30;
    expect(copilot.stepRequestCap!()).toBe(30);
  });
});

describe('engines and the checkout', () => {
  it('gives every folder engine the same write leases, Git and home folder', () => {
    const seen: AppDeps[] = [];
    const home = mkdtempSync(join(tmpdir(), 'cs-home-'));
    const manager = new EngineManager({
      ...baseDeps(),
      home,
      git: noGit,
      settings: () => defaults,
      createApp: (deps) => {
        seen.push(deps);
        return createApp(deps);
      },
    });
    manager.get(folder('a'));
    manager.get(folder('b'));
    expect(seen).toHaveLength(2);
    expect(seen[0].leases).toBe(seen[1].leases);
    expect(seen[0].git).toBe(noGit);
    expect(seen[0].home).toBe(home);
  });
});

describe('engines and the default model', () => {
  it("gives every engine the settings' current model and effort, read when asked", () => {
    const seen: AppDeps[] = [];
    let settings: Settings = { ...defaults, model: 'sonnet', effort: 'high' };
    const manager = new EngineManager({
      ...baseDeps(),
      settings: () => settings,
      createApp: (deps) => {
        seen.push(deps);
        return createApp(deps);
      },
    });
    manager.get(folder('a'));
    expect(seen[0].modelDefaults?.()).toEqual({ model: 'sonnet', effort: 'high' });
    settings = { ...settings, model: '', effort: '' };
    expect(seen[0].modelDefaults?.()).toEqual({});
  });

  it("tells every engine when the settings' default model or effort changes", () => {
    const apps: App[] = [];
    const manager = new EngineManager({
      ...baseDeps(),
      settings: () => defaults,
      createApp: (deps) => {
        const app = createApp(deps);
        apps.push(app);
        return app;
      },
    });
    manager.get(folder('a'));
    manager.get(folder('b'));
    const spies = apps.map((a) => vi.spyOn(a, 'modelDefaultsChanged'));
    manager.modelDefaultsChanged();
    for (const spy of spies) expect(spy).toHaveBeenCalledTimes(1);
  });
});
