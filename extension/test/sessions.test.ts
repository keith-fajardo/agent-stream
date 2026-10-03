import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createApp, type App } from '@agent-stream/engine';
import type { Folder } from '../src/engines';
import { activeSessionKey, SessionManager, sessionStatusFolder, type GraphTabInfo } from '../src/sessions';
import { signedIn, testProvider } from './helpers';

function world() {
  const folders: Folder[] = ['a', 'b'].map((n) => {
    const path = mkdtempSync(join(tmpdir(), `cs-${n}-`));
    return { key: `file://${path}`, name: n, path };
  });
  const apps = new Map<string, App>(folders.map((f) => [f.key, createApp({ projectDir: f.path, valuesFile: join(mkdtempSync(join(tmpdir(), 'cs-home-')), 'values.json'), provider: testProvider(), status: signedIn, maxParallel: 1 })]));
  let tabs: GraphTabInfo[] = [];
  const calls: string[] = [];
  const memory = new Map<string, string | undefined>();
  const dirty = new Map<string, number>();
  const deps = {
    folders: () => folders,
    app: (f: Folder) => apps.get(f.key)!,
    graphTabs: () => tabs,
    dirtyTabs: (key: string) => dirty.get(key) ?? 0,
    closeGraphTabs: vi.fn(async (key: string) => {
      calls.push(`close ${key}`);
      tabs = tabs.filter((t) => t.folderKey !== key);
    }),
    openGraphTab: vi.fn(async (f: Folder, graphId: string, group: number, preserveFocus: boolean) => {
      calls.push(`open ${graphId}@${group}${preserveFocus ? '' : ' focus'}`);
      if (!tabs.some((t) => t.folderKey === f.key && t.graphId === graphId)) tabs.push({ folderKey: f.key, graphId, group, index: tabs.filter((t) => t.group === group).length, active: !preserveFocus });
    }),
    confirm: vi.fn(async () => true),
    info: vi.fn(),
    memory: { get: (k: string) => memory.get(k), update: async (k: string, v: string | undefined) => void memory.set(k, v) },
    changed: vi.fn(),
    hasEngine: vi.fn(() => true),
    debounceMs: 0,
  };
  const graph = (f: Folder, name: string) => apps.get(f.key)!.createGraph(name).id;
  const setTabs = (t: GraphTabInfo[]) => (tabs = t);
  return { folders, apps, deps, calls, memory, dirty, graph, setTabs, tabs: () => tabs, manager: new SessionManager(deps) };
}

describe('SessionManager', () => {
  it('starts on Default and records only graph tabs of each folder, re-indexed per group', () => {
    const w = world();
    const [a] = w.folders;
    const g1 = w.graph(a, 'One'), g2 = w.graph(a, 'Two');
    w.setTabs([{ folderKey: a.key, graphId: g2, group: 2, index: 3, active: false }, { folderKey: a.key, graphId: g1, group: 1, index: 5, active: true }]);
    w.manager.captureNow();
    expect(w.manager.active(a)).toEqual({ id: 'default', name: 'Default' });
    expect(w.apps.get(a.key)!.sessionStore.get('default')).toMatchObject({ tabs: [{ graphId: g1, group: 1, index: 0 }, { graphId: g2, group: 2, index: 0 }], activeGraphId: g1 });
  });

  it('switches: save, close, remember, open in order, then focus the active tab', async () => {
    const w = world();
    const [a] = w.folders;
    const g1 = w.graph(a, 'One'), g2 = w.graph(a, 'Two');
    const app = w.apps.get(a.key)!;
    const b = app.createSession('B');
    app.saveSessionTabs(b.id, [{ graphId: g2, group: 1, index: 0 }, { graphId: g1, group: 2, index: 0 }], g1);
    w.setTabs([{ folderKey: a.key, graphId: g1, group: 1, index: 0, active: true }]);
    expect(await w.manager.switchTo(a, b.id)).toBe(true);
    expect(w.calls).toEqual([`close ${a.key}`, `open ${g2}@1`, `open ${g1}@2`, `open ${g1}@2 focus`]);
    expect(w.memory.get(activeSessionKey(a.key))).toBe(b.id);
    expect(app.sessionStore.get('default').tabs).toEqual([{ graphId: g1, group: 1, index: 0 }]);
  });

  it('a declined unsaved-edits prompt changes nothing', async () => {
    const w = world();
    const [a] = w.folders;
    const app = w.apps.get(a.key)!;
    const b = app.createSession('B');
    w.dirty.set(a.key, 2);
    w.deps.confirm.mockResolvedValueOnce(false);
    expect(await w.manager.switchTo(a, b.id)).toBe(false);
    expect(w.deps.confirm).toHaveBeenCalledWith('Discard unsaved step edits in 2 tabs?', 'Discard');
    expect(w.calls).toEqual([]);
    expect(w.manager.active(a).id).toBe('default');
  });

  it('switching only touches its folder’s graph tabs', async () => {
    const w = world();
    const [a, bFolder] = w.folders;
    const ga = w.graph(a, 'One'), gb = w.graph(bFolder, 'One');
    w.setTabs([{ folderKey: a.key, graphId: ga, group: 1, index: 0, active: false }, { folderKey: bFolder.key, graphId: gb, group: 1, index: 1, active: true }]);
    const other = w.apps.get(a.key)!.createSession('Other');
    await w.manager.switchTo(a, other.id);
    expect(w.tabs().map((t) => `${t.folderKey === a.key ? 'a' : 'b'}:${t.graphId}`)).toEqual([`b:${gb}`]);
    expect(w.manager.active(bFolder).id).toBe('default');
  });

  it('skips graphs that no longer exist, with one notice', async () => {
    const w = world();
    const [a] = w.folders;
    const app = w.apps.get(a.key)!;
    const b = app.createSession('B');
    app.saveSessionTabs(b.id, [{ graphId: 'gone', group: 1, index: 0 }, { graphId: 'gone-too', group: 1, index: 1 }]);
    await w.manager.switchTo(a, b.id);
    expect(w.deps.info).toHaveBeenCalledWith('2 graphs in this session no longer exist and were skipped.');
    expect(app.sessionStore.get(b.id).tabs).toEqual([]);
  });

  it('deleting the active session switches first; deleting the last leaves an empty Default', async () => {
    const w = world();
    const [a] = w.folders;
    const app = w.apps.get(a.key)!;
    const b = app.createSession('B');
    await w.manager.switchTo(a, b.id);
    await w.manager.delete(a, b.id);
    expect(w.deps.confirm).toHaveBeenCalledWith('Delete B? Its planner chats are removed; graphs and runs stay.', 'Delete');
    expect(w.manager.active(a).id).toBe('default');
    expect(app.listSessions().map((s) => s.id)).toEqual(['default']);
    await w.manager.delete(a, 'default');
    expect(app.listSessions()).toEqual([expect.objectContaining({ id: 'default', name: 'Default', tabCount: 0 })]);
  });
});

describe('SessionManager robustness', () => {
  it('keeps the active graph when focus is elsewhere', () => {
    const w = world();
    const [a] = w.folders;
    const g1 = w.graph(a, 'One'), g2 = w.graph(a, 'Two');
    w.setTabs([{ folderKey: a.key, graphId: g1, group: 1, index: 0, active: true }, { folderKey: a.key, graphId: g2, group: 1, index: 1, active: false }]);
    w.manager.captureNow();
    w.setTabs(w.tabs().map((t) => ({ ...t, active: false })));
    w.manager.captureNow();
    expect(w.apps.get(a.key)!.sessionStore.get('default').activeGraphId).toBe(g1);
    w.setTabs([{ folderKey: a.key, graphId: g2, group: 1, index: 0, active: false }]);
    w.manager.captureNow();
    expect(w.apps.get(a.key)!.sessionStore.get('default').activeGraphId).toBeUndefined();
  });

  it('a failing open reports, returns false, saves no partial tab set and still announces', async () => {
    const w = world();
    const [a] = w.folders;
    const g1 = w.graph(a, 'One'), g2 = w.graph(a, 'Two');
    const app = w.apps.get(a.key)!;
    const b = app.createSession('B');
    const stored = [{ graphId: g1, group: 1, index: 0 }, { graphId: g2, group: 1, index: 1 }];
    app.saveSessionTabs(b.id, stored, g1);
    w.deps.openGraphTab.mockImplementationOnce(async () => {}).mockRejectedValueOnce(new Error('boom'));
    expect(await w.manager.switchTo(a, b.id)).toBe(false);
    expect(w.deps.info).toHaveBeenCalledWith('Could not switch to B: boom');
    expect(w.deps.changed).toHaveBeenCalled();
    expect(app.sessionStore.get(b.id).tabs).toEqual(stored);
  });

  it('refuses a second switch while one is running', async () => {
    const w = world();
    const [a] = w.folders;
    const b = w.apps.get(a.key)!.createSession('B');
    let release!: () => void;
    w.deps.closeGraphTabs.mockImplementationOnce(() => new Promise<void>((r) => (release = r)));
    const first = w.manager.switchTo(a, b.id);
    await vi.waitFor(() => expect(w.deps.closeGraphTabs).toHaveBeenCalled());
    expect(await w.manager.switchTo(a, b.id)).toBe(false);
    expect(w.deps.info).toHaveBeenCalledWith('A session switch is already in progress.');
    release();
    expect(await first).toBe(true);
  });

  it('switching to the active session does nothing', async () => {
    const w = world();
    const [a] = w.folders;
    w.dirty.set(a.key, 1);
    expect(await w.manager.switchTo(a, 'default')).toBe(true);
    expect(w.deps.confirm).not.toHaveBeenCalled();
    expect(w.calls).toEqual([]);
  });

  it('skips folders with no graph tabs and no engine', () => {
    const w = world();
    const [a, b] = w.folders;
    const g = w.graph(a, 'One');
    w.deps.hasEngine.mockImplementation(() => false);
    const app = vi.spyOn(w.deps, 'app');
    w.setTabs([{ folderKey: a.key, graphId: g, group: 1, index: 0, active: true }]);
    w.manager.captureNow();
    expect(app.mock.calls.map(([f]) => f.key)).toEqual([a.key, a.key]);
    expect(app.mock.calls.some(([f]) => f.key === b.key)).toBe(false);
  });
});

describe('sessionStatusFolder', () => {
  const f = (n: string) => ({ key: `file:///${n}`, name: n, path: `/${n}` });
  it('is the active graph tab’s folder, else the only folder, else none', () => {
    expect(sessionStatusFolder(f('b'), [f('a'), f('b')])).toEqual(f('b'));
    expect(sessionStatusFolder(undefined, [f('a')])).toEqual(f('a'));
    expect(sessionStatusFolder(undefined, [f('a'), f('b')])).toBeUndefined();
    expect(sessionStatusFolder(undefined, [])).toBeUndefined();
  });
});
