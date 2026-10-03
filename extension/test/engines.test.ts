import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createApp, valuesFileFor, type App, type AppDeps, type Found } from '@agent-stream/engine';
import type { ProviderStatus, ServerMessage } from '@agent-stream/shared';
import { CHECKING, EngineManager, type EngineEvents, type Folder } from '../src/engines';

const signedIn: ProviderStatus = { provider: 'claude', ok: true, label: 'Claude Max' };
const folder = (name: string): Folder => {
  const path = mkdtempSync(join(tmpdir(), `cs-${name}-`));
  return { key: `file://${path}`, name, path };
};

function setup(o: { found?: boolean } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'cs-home-'));
  const events: EngineEvents = { graphs: vi.fn(), approvals: vi.fn(), confirmRun: vi.fn(), graphDeleted: vi.fn(), auth: vi.fn(), warning: vi.fn() };
  let auth: ProviderStatus = signedIn;
  const checkAuth = vi.fn(async () => auth);
  const apps: App[] = [];
  const manager = new EngineManager({
    settings: () => ({ claudePath: '', gitBashPath: '', maxParallel: 2 }),
    platform: 'darwin',
    env: {},
    home,
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
    expect(manager.status).toBe(CHECKING);
    expect(await manager.checkSignIn()).toEqual(signedIn);
    expect(checkAuth).toHaveBeenCalledWith('/bin/claude');
    expect(events.auth).toHaveBeenCalledWith(signedIn);
  });

  it('reports a missing Claude Code without running anything', async () => {
    const { manager, checkAuth } = setup({ found: false });
    expect(await manager.checkSignIn()).toEqual({ provider: 'claude', ok: false, label: 'not signed in', error: 'no claude' });
    expect(checkAuth).not.toHaveBeenCalled();
  });

  it('creates one engine per folder and reports its graphs', async () => {
    const { manager, events } = setup();
    await manager.checkSignIn();
    const a = folder('a');
    const app = manager.get(a);
    expect(manager.get(a)).toBe(app);
    expect(events.graphs).toHaveBeenCalledWith(a, []);
    app.createGraph('G');
    expect(events.graphs).toHaveBeenLastCalledWith(a, [expect.objectContaining({ id: 'g', name: 'G' })]);
  });

  it('disables only a folder whose project settings reroute Claude', async () => {
    const { manager } = setup();
    await manager.checkSignIn();
    const bad = folder('bad');
    mkdirSync(join(bad.path, '.claude'));
    writeFileSync(join(bad.path, '.claude', 'settings.json'), JSON.stringify({ env: { ANTHROPIC_API_KEY: 'x' } }));
    expect(manager.folderStatus(bad)).toMatchObject({ ok: false, error: expect.stringContaining('ANTHROPIC_API_KEY') });
    expect(manager.folderStatus(folder('good')).ok).toBe(true);
  });

  it('passes a new sign-in state to engines that already exist', async () => {
    const { manager, setAuth } = setup();
    setAuth({ provider: 'claude', ok: false, label: 'not signed in', error: 'Not signed in.' });
    await manager.checkSignIn();
    const msgs: ServerMessage[] = [];
    manager.get(folder('a')).connect({ send: (m) => void msgs.push(m) });
    setAuth(signedIn);
    await manager.checkSignIn();
    expect(msgs.at(-1)).toEqual({ type: 'auth', status: signedIn });
  });

  it('keeps approvals apart per folder even when graph ids match', async () => {
    const { manager, events } = setup();
    await manager.checkSignIn();
    const a = folder('a');
    const b = folder('b');
    for (const f of [a, b]) manager.get(f).broker.request({ runId: 'r', graphId: 'g', nodeId: 'n1', nodeTitle: 'Build', toolName: 'Bash', input: { command: 'x' } });
    expect(manager.approvals().map((x) => [x.folder.name, x.request.graphId])).toEqual([['a', 'g'], ['b', 'g']]);
    expect(events.approvals).toHaveBeenCalled();
  });

  it('keeps variable values under the home folder, outside the project', async () => {
    const { manager, home } = setup();
    await manager.checkSignIn();
    const a = folder('a');
    manager.get(a).values.set('g', 'name', 'v');
    const file = valuesFileFor(a.path, home);
    expect(file.startsWith(join(home, '.agent-stream', 'values'))).toBe(true);
    expect(existsSync(file)).toBe(true);
    expect(existsSync(join(a.path, '.agent-stream', 'values'))).toBe(false);
  });

  it('disposes every engine', async () => {
    const { manager, apps } = setup();
    await manager.checkSignIn();
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
        settings: () => ({ claudePath: '', gitBashPath: 'X', maxParallel: 2 }),
        platform,
        env: {},
        home: mkdtempSync(join(tmpdir(), 'cs-home-')),
        events: { graphs: vi.fn(), approvals: vi.fn(), confirmRun: vi.fn(), graphDeleted: vi.fn(), auth: vi.fn(), warning: vi.fn() },
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
    const a = manager.checkSignIn();
    const b = manager.checkSignIn();
    expect(await b).toEqual(signedIn);
    release({ provider: 'claude', ok: false, label: 'not signed in', error: 'old' });
    expect(await a).toEqual(signedIn);
    expect(manager.status).toEqual(signedIn);
    expect(events.auth).toHaveBeenCalledTimes(1);
    expect(events.auth).not.toHaveBeenCalledWith({ provider: 'claude', ok: false, label: 'not signed in', error: 'old' });
  });
});
