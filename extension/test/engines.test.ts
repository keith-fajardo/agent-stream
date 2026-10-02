import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createApp, valuesFileFor, type App } from '@claude-stream/engine';
import type { AuthInfo, ServerMessage } from '@claude-stream/shared';
import { CHECKING, EngineManager, type EngineEvents, type Folder } from '../src/engines';

const signedIn: AuthInfo = { ok: true, method: 'claude.ai', plan: 'max' };
const folder = (name: string): Folder => {
  const path = mkdtempSync(join(tmpdir(), `cs-${name}-`));
  return { key: `file://${path}`, name, path };
};

function setup(o: { found?: boolean } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'cs-home-'));
  const events: EngineEvents = { graphs: vi.fn(), approvals: vi.fn(), confirmRun: vi.fn(), graphDeleted: vi.fn(), auth: vi.fn(), warning: vi.fn() };
  let auth: AuthInfo = signedIn;
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
  return { manager, events, checkAuth, apps, home, setAuth: (a: AuthInfo) => (auth = a) };
}

describe('EngineManager', () => {
  it('starts as "checking" and checks sign-in with the Claude Code it finds', async () => {
    const { manager, events, checkAuth } = setup();
    expect(manager.auth).toBe(CHECKING);
    expect(await manager.checkSignIn()).toEqual(signedIn);
    expect(checkAuth).toHaveBeenCalledWith('/bin/claude');
    expect(events.auth).toHaveBeenCalledWith(signedIn);
  });

  it('reports a missing Claude Code without running anything', async () => {
    const { manager, checkAuth } = setup({ found: false });
    expect(await manager.checkSignIn()).toEqual({ ok: false, error: 'no claude' });
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
    expect(manager.folderAuth(bad)).toMatchObject({ ok: false, error: expect.stringContaining('ANTHROPIC_API_KEY') });
    expect(manager.folderAuth(folder('good')).ok).toBe(true);
  });

  it('passes a new sign-in state to engines that already exist', async () => {
    const { manager, setAuth } = setup();
    setAuth({ ok: false, error: 'Not signed in.' });
    await manager.checkSignIn();
    const msgs: ServerMessage[] = [];
    manager.get(folder('a')).connect({ send: (m) => void msgs.push(m) });
    setAuth(signedIn);
    await manager.checkSignIn();
    expect(msgs.at(-1)).toEqual({ type: 'auth', auth: signedIn });
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
    expect(file.startsWith(join(home, '.claude-stream', 'values'))).toBe(true);
    expect(existsSync(file)).toBe(true);
    expect(existsSync(join(a.path, '.claude-stream', 'values'))).toBe(false);
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
});
