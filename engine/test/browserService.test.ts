import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { BROWSER_CLOSED, BROWSER_IN_USE, NO_BROWSER_FOUND, PROFILE_STILL_OPEN, type NodeEventBody } from '@agent-stream/shared';
import { browserCandidates, browserDir, createBrowserLock, LOCK_FILE } from '../src/browser/launcher';
import { BrowserService, type BrowserState } from '../src/browser/service';
import { createBrowserTools } from '../src/browser/tools';
import { FakeContext } from './browserFakes';

/**
 * The host's own platform, so paths are the host's: Clear Browser Data checks the home folder is absolute by the platform's
 * rules, and a temp folder on Windows is `C:\…`. The browser found is the platform's first standard place.
 */
const PLATFORM = process.platform;
const chromeIn = (home: string) => browserCandidates(PLATFORM, {}, home)[0];
/** Making a symbolic link needs a right Windows doesn't give everyone (GitHub's runners have it). */
const canLink = (() => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-stream-link-'));
  try {
    symlinkSync('target', join(dir, 'link'));
    return true;
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();

/** A service on a temp home, this process being pid 100; pid 200 is another live window. */
type SetupOptions = {
  found?: boolean;
  launchFails?: boolean;
  launchError?: string;
  /** The first launch fails with this; later ones go through. */
  launchErrorOnce?: string;
  searchEngine?: string;
  launchGate?: Promise<void>;
  /** Runs on each new fake window before the service sees it. */
  launchHook?: (c: FakeContext, n: number) => void;
};
function setup(o: SetupOptions = {}) {
  const home = mkdtempSync(join(tmpdir(), 'agent-stream-home-'));
  const contexts: FakeContext[] = [];
  const launches: { executablePath: string; userDataDir: string }[] = [];
  const service = new BrowserService({
    home,
    platform: PLATFORM,
    env: {},
    settings: () => ({ path: '', searchEngine: o.searchEngine ?? '' }),
    startPage: '<h1>Start</h1>',
    exists: (p) => o.found !== false && p === chromeIn(home),
    lock: createBrowserLock({ dir: browserDir(home), pid: 100, isAlive: (pid) => pid === 100 || pid === 200 }),
    // A short wait before an empty window counts as closed (the real one is 500 ms); this host, with process 4242 alive.
    emptyWindowMs: 20,
    hostname: () => 'myhost',
    isAlive: (pid) => pid === 4242,
    launch: async (l) => {
      launches.push(l);
      await o.launchGate;
      if (o.launchError) throw new Error(o.launchError);
      if (o.launchErrorOnce && launches.length === 1) throw new Error(o.launchErrorOnce);
      if (o.launchFails) throw new Error('spawn ENOENT\nCall log:\n  - launching');
      const c = new FakeContext();
      contexts.push(c);
      o.launchHook?.(c, contexts.length);
      return c;
    },
  });
  const states: BrowserState[] = [];
  service.on('state', (s: BrowserState) => void states.push(s));
  const events: NodeEventBody[] = [];
  const records: string[] = [];
  const hooks = { emit: (e: NodeEventBody) => void events.push(e), record: (url: string) => void records.push(url) };
  const lockFile = join(browserDir(home), LOCK_FILE);
  const otherWindow = () => {
    mkdirSync(browserDir(home), { recursive: true });
    writeFileSync(lockFile, JSON.stringify({ version: 1, pid: 200, startedAt: 'x' }));
  };
  const readLockPid = () => (existsSync(lockFile) ? (JSON.parse(readFileSync(lockFile, 'utf8')) as { pid: number }).pid : undefined);
  return { home, service, contexts, launches, states, events, records, hooks, lockFile, otherWindow, readLockPid };
}
const owner = (nodeId: string) => ({ runId: 'r1', nodeId });

describe('BrowserService', () => {
  it('a Browser step opens the browser when it is closed, once, taking the lock', async () => {
    const { service, launches, home, lockFile, hooks, states } = setup();
    const [a, b] = await Promise.all([service.startStep(owner('n3'), hooks), service.startStep(owner('n5'), hooks)]);
    expect(a.ok && b.ok).toBe(true);
    expect(launches).toEqual([{ executablePath: chromeIn(home), userDataDir: browserDir(home) }]);
    expect(JSON.parse(readFileSync(lockFile, 'utf8')).pid).toBe(100);
    expect(service.state()).toEqual({ open: true, steps: ['n3', 'n5'] });
    expect(states.at(-1)).toEqual({ open: true, steps: ['n3', 'n5'] });
    // Already open in this window: reused.
    await service.startStep(owner('n7'), hooks);
    expect(launches).toHaveLength(1);
  });

  it('fails the step before it starts when no browser is found', async () => {
    const { service, launches, lockFile, hooks } = setup({ found: false });
    expect(await service.startStep(owner('n3'), hooks)).toEqual({ ok: false, error: NO_BROWSER_FOUND });
    expect(launches).toEqual([]);
    expect(existsSync(lockFile)).toBe(false);
    expect(service.find()).toEqual({ ok: false, error: NO_BROWSER_FOUND });
  });

  it('fails the step when another VS Code window owns the browser, and takes over a stale lock', async () => {
    const { service, launches, lockFile, hooks, otherWindow } = setup();
    otherWindow();
    // The lock's refusal is the spec sentence, then where the lock is (Task 2).
    expect(await service.startStep(owner('n3'), hooks)).toEqual({ ok: false, error: `${BROWSER_IN_USE} (lock: ${lockFile})` });
    expect(launches).toEqual([]);
    writeFileSync(lockFile, JSON.stringify({ version: 1, pid: 300, startedAt: 'x' }));
    expect((await service.startStep(owner('n3'), hooks)).ok).toBe(true);
    expect(JSON.parse(readFileSync(lockFile, 'utf8')).pid).toBe(100);
  });

  it('a launch that fails releases the lock and says why', async () => {
    const { service, lockFile, hooks } = setup({ launchFails: true });
    expect(await service.startStep(owner('n3'), hooks)).toEqual({ ok: false, error: "The browser couldn't be opened: spawn ENOENT" });
    expect(existsSync(lockFile)).toBe(false);
    expect(service.isOpen()).toBe(false);
  });

  it('the user closing the window releases the lock and the next tool says The browser was closed.', async () => {
    const { service, contexts, lockFile, hooks, launches } = setup();
    const started = await service.startStep(owner('n3'), hooks);
    if (!started.ok) throw new Error(started.error);
    const tools = createBrowserTools({ step: started.step, ask: async () => ({ allow: true, site: false }), settleMs: 0 });
    const call = (name: string, input: unknown = {}) => tools.find((t) => t.name === name)!.run(input, new AbortController().signal);
    contexts[0].sites['https://a.example/'] = { title: 'A' };
    expect((await call('browser_open', { url: 'https://a.example/' })).isError).toBeUndefined();
    await contexts[0].close();
    expect(existsSync(lockFile)).toBe(false);
    expect(service.state()).toEqual({ open: false, steps: ['n3'] });
    expect(await call('browser_read')).toEqual({ text: BROWSER_CLOSED, isError: true });
    expect(await call('browser_open', { url: 'https://a.example/' })).toEqual({ text: BROWSER_CLOSED, isError: true });
    // The next step opens it again.
    expect((await service.startStep(owner('n5'), hooks)).ok).toBe(true);
    expect(launches).toHaveLength(2);
    // The first step's tools stay closed: its tabs were in the window that closed.
    expect(await call('browser_read')).toEqual({ text: BROWSER_CLOSED, isError: true });
  });

  it('a step\'s end leaves the status bar list, and succeeded closes its tabs', async () => {
    const { service, contexts, hooks } = setup();
    const a = await service.startStep(owner('n3'), hooks);
    const b = await service.startStep(owner('n5'), hooks);
    if (!a.ok || !b.ok) throw new Error('not started');
    const pa = await a.step.tabs()!.ensureTab();
    const pb = await b.step.tabs()!.ensureTab();
    await a.step.end('succeeded');
    await b.step.end('failed');
    expect(pa.isClosed()).toBe(true);
    expect(pb.isClosed()).toBe(false);
    expect(service.state()).toEqual({ open: true, steps: [] });
    expect(a.step.tabs()).toBeUndefined();
    expect(contexts[0].open).toContain(pb);
  });

  it('Open Browser shows the start page on a fresh launch; when open it only comes to the front', async () => {
    const { service, contexts, hooks } = setup();
    expect(await service.open({ startPage: true })).toEqual({ ok: true });
    expect(contexts[0].open[0].content).toBe('<h1>Start</h1>');
    expect(await service.show()).toEqual({ ok: true });
    expect(contexts[0].front).toBe(contexts[0].open[0]);
    // Show for a step brings that step's tab to the front.
    const s = await service.startStep(owner('n3'), hooks);
    if (!s.ok) throw new Error(s.error);
    const tab = await s.step.tabs()!.ensureTab();
    await service.show(owner('n3'));
    expect(contexts[0].front).toBe(tab);
    // A step's own launch shows no start page.
    const fresh = setup();
    await fresh.service.startStep(owner('n3'), fresh.hooks);
    expect(fresh.contexts[0].open[0].content).toBeUndefined();
  });

  it('show() opens a blank tab, and brings it to the front, when the open browser has no tab left', async () => {
    const { service, contexts } = setup();
    await service.open();
    // Chrome on macOS can be left running with no window: two Browser steps that succeed together each see the other's tab
    // still open, so neither keeps a blank one. Here the window simply has no tab left, with nothing closing it.
    contexts[0].open = [];
    expect(service.isOpen()).toBe(true);
    expect(await service.show()).toEqual({ ok: true });
    expect(contexts[0].open).toHaveLength(1);
    expect(contexts[0].front).toBe(contexts[0].open[0]);
  });

  it('show() opens the browser, with its start page, when it is closed', async () => {
    const { service, contexts } = setup();
    expect(await service.show()).toEqual({ ok: true });
    expect(contexts[0].open[0].content).toBe('<h1>Start</h1>');
  });

  it('searches with the setting, or the default when it is empty', () => {
    expect(setup().service.searchEngine()).toBe('https://www.google.com/search?q=');
    expect(setup({ searchEngine: ' https://duckduckgo.com/html/?q= ' }).service.searchEngine()).toBe('https://duckduckgo.com/html/?q=');
  });

  it('Clear Browser Data closes the browser and deletes the profile; refused while another window owns it', async () => {
    const { service, contexts, home, otherWindow } = setup();
    await service.open();
    writeFileSync(join(browserDir(home), 'Cookies'), 'x');
    expect(await service.clearData()).toEqual({ ok: true });
    expect(contexts[0].closed).toBe(true);
    expect(existsSync(browserDir(home))).toBe(false);
    otherWindow();
    expect(await service.clearData()).toEqual({ ok: false, error: `${BROWSER_IN_USE} (lock: ${join(browserDir(home), LOCK_FILE)})` });
    expect(existsSync(browserDir(home))).toBe(true);
  });

  it('dispose (the VS Code window closing) closes the browser and releases the lock', async () => {
    const { service, contexts, lockFile } = setup();
    await service.open();
    await service.dispose();
    expect(contexts[0].closed).toBe(true);
    expect(existsSync(lockFile)).toBe(false);
  });

  // Chrome still running from a crashed window keeps the profile: the next launch fails with Playwright's generic error.
  it.each([
    ['Playwright on a profile Chrome still holds', 'browserType.launchPersistentContext: Opening in existing browser session. This usually means that the profile is already in use by another instance of Chromium.\nCall log:\n  - <launching> chrome'],
    ['the generic closed error with the existing-session hint in its log', 'browserType.launchPersistentContext: Target page, context or browser has been closed\nCall log:\n  - [pid=1][out] Opening in existing browser session.'],
    ['a SingletonLock error', 'Failed to create /x/browser/SingletonLock: File exists (17)'],
    ['Chrome saying the profile appears to be in use', 'The profile appears to be in use by another Chromium process (123) on another computer.'],
    ['Playwright\'s ProcessSingleton failure', 'Failed to create a ProcessSingleton for your profile directory.'],
    ['the user data directory message', 'The user data directory is already in use, please specify a unique value for --user-data-dir'],
  ])('a launch that fails on a profile still in use (%s) says so and releases the lock', async (_name, launchError) => {
    const { service, lockFile, hooks } = setup({ launchError });
    expect(await service.startStep(owner('n3'), hooks)).toEqual({ ok: false, error: PROFILE_STILL_OPEN });
    expect(PROFILE_STILL_OPEN).toBe("The Agent Stream browser's profile is still open in another browser window: close it and try again.");
    expect(existsSync(lockFile)).toBe(false);
    expect(service.isOpen()).toBe(false);
    expect(await service.open()).toEqual({ ok: false, error: PROFILE_STILL_OPEN });
  });

  it('a launch that fails for another reason keeps the plan wording, and a retry then opens it', async () => {
    const { service, lockFile, launches } = setup({ launchErrorOnce: "Executable doesn't exist at /x\nCall log:\n  - a" });
    expect(await service.open()).toEqual({ ok: false, error: "The browser couldn't be opened: Executable doesn't exist at /x" });
    expect(existsSync(lockFile)).toBe(false);
    expect(await service.open()).toEqual({ ok: true });
    expect(launches).toHaveLength(2);
    expect(existsSync(lockFile)).toBe(true);
  });

  it.each([
    ['an unwritable profile', 'Failed to create /x/browser/SingletonLock: Permission denied (13)'],
    ['a port in use', 'bind() failed: Address already in use (98)'],
  ])('a launch that fails on %s keeps its own reason instead of the profile sentence', async (_name, launchError) => {
    const { service } = setup({ launchError });
    expect(await service.open()).toEqual({ ok: false, error: `The browser couldn't be opened: ${launchError}` });
  });

  // On macOS closing the last window does not quit Chrome and Playwright fires no context 'close' (checked with a real Chrome:
  // only the pages' close events fire), so the service closes the browser itself when its last page is gone.
  it('closing the last page closes the browser (macOS keeps Chrome running with no window), releasing the lock', async () => {
    const { service, contexts, lockFile, hooks } = setup();
    const started = await service.startStep(owner('n3'), hooks);
    if (!started.ok) throw new Error(started.error);
    const tab = await started.step.tabs()!.ensureTab();
    await contexts[0].open[0].close();
    expect(service.isOpen()).toBe(true);
    expect(contexts[0].closed).toBe(false);
    await tab.close();
    expect(service.isOpen()).toBe(true);
    await vi.waitFor(() => expect(contexts[0].closed).toBe(true));
    expect(existsSync(lockFile)).toBe(false);
    expect(service.state()).toEqual({ open: false, steps: ['n3'] });
    const tools = createBrowserTools({ step: started.step, ask: async () => ({ allow: true, site: false }), settleMs: 0 });
    expect(await tools.find((t) => t.name === 'browser_read')!.run({}, new AbortController().signal)).toEqual({ text: BROWSER_CLOSED, isError: true });
  });

  it('a step succeeding closes its tab without closing a browser that still has a page', async () => {
    const { service, contexts, hooks } = setup();
    const started = await service.startStep(owner('n3'), hooks);
    if (!started.ok) throw new Error(started.error);
    await started.step.tabs()!.ensureTab();
    await started.step.end('succeeded');
    expect(contexts[0].closed).toBe(false);
    expect(service.isOpen()).toBe(true);
  });

  it('dispose while the browser is still launching waits for it, closes it and leaves no lock behind', async () => {
    let release!: () => void;
    const { service, contexts, lockFile } = setup({ launchGate: new Promise<void>((r) => (release = r)) });
    const opening = service.open();
    await vi.waitFor(() => expect(existsSync(lockFile)).toBe(true));
    const disposed = service.dispose();
    release();
    await disposed;
    expect(await opening).toEqual({ ok: true });
    expect(contexts[0].closed).toBe(true);
    expect(service.isOpen()).toBe(false);
    expect(existsSync(lockFile)).toBe(false);
  });

  it('Clear Browser Data while the browser is still launching waits for it before deleting the profile', async () => {
    let release!: () => void;
    const { service, contexts, home } = setup({ launchGate: new Promise<void>((r) => (release = r)) });
    void service.open();
    const cleared = service.clearData();
    release();
    expect(await cleared).toEqual({ ok: true });
    expect(contexts[0].closed).toBe(true);
    expect(existsSync(browserDir(home))).toBe(false);
  });

  /** A fake window whose close waits for `gate`, and notes whether the lock file was still there when the browser had gone. */
  function slowClose(gate: Promise<void>, lockFile: string, notes: { lockAfterClose?: boolean } = {}) {
    return (c: FakeContext) => {
      const close = c.close.bind(c);
      c.close = async () => {
        await gate;
        await close();
        notes.lockAfterClose = existsSync(lockFile);
      };
    };
  }
  const later = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it("a step's own succeeded end never closes the browser, even when its tab was the last page, and another step goes on", async () => {
    const { service, contexts, hooks, lockFile } = setup();
    const a = await service.startStep(owner('n3'), hooks);
    const b = await service.startStep(owner('n5'), hooks);
    if (!a.ok || !b.ok) throw new Error('not started');
    await a.step.tabs()!.ensureTab();
    await contexts[0].open[0].close(); // the user closed the window's first tab: a's tab is the only page
    expect(contexts[0].open).toHaveLength(1);
    await a.step.end('succeeded');
    await later(80);
    expect(contexts[0].closed).toBe(false);
    expect(service.isOpen()).toBe(true);
    expect(existsSync(lockFile)).toBe(true);
    // The step that is still running opens its first tab and reads a page.
    contexts[0].sites['https://a.example/'] = { title: 'A' };
    const tools = createBrowserTools({ step: b.step, ask: async () => ({ allow: true, site: false }), settleMs: 0 });
    const opened = await tools.find((t) => t.name === 'browser_open')!.run({ url: 'https://a.example/' }, new AbortController().signal);
    expect(opened.isError).toBeUndefined();
  });

  it('a popup that opens and closes in a window.open/window.close flow does not close the browser: the empty window is checked again after a wait', async () => {
    const { service, contexts } = setup();
    await service.open();
    const first = contexts[0].open[0];
    await first.close(); // no page for an instant ...
    await contexts[0].newPage(); // ... and the popup shows up
    await later(80);
    expect(contexts[0].closed).toBe(false);
    expect(service.isOpen()).toBe(true);
  });

  it('while the browser is closing it is not open, and a step that starts then gets a new browser, after the lock is released', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const notes: { lockAfterClose?: boolean } = {};
    let lockFile = '';
    const { service, contexts, launches, hooks, readLockPid, lockFile: lf } = setup({ launchHook: (c, n) => void (n === 1 && slowClose(gate, lockFile, notes)(c)) });
    lockFile = lf;
    const first = await service.startStep(owner('n3'), hooks);
    if (!first.ok) throw new Error(first.error);
    const tab = await first.step.tabs()!.ensureTab();
    await contexts[0].open[0].close();
    await tab.close(); // the last page: the close starts after the wait
    await vi.waitFor(() => expect(service.isOpen()).toBe(false));
    expect(contexts[0].closed).toBe(false);
    const second = service.startStep(owner('n5'), hooks);
    await later(40);
    expect(launches).toHaveLength(1); // waiting for the close
    release();
    const started = await second;
    if (!started.ok) throw new Error(started.error);
    expect(contexts[0].closed).toBe(true);
    expect(notes.lockAfterClose).toBe(false); // the old browser's lock was gone before the new launch
    expect(launches).toHaveLength(2);
    expect(readLockPid()).toBe(100);
    const page = await started.step.tabs()!.ensureTab();
    expect(contexts[1].open).toContain(page);
    // The first step stays on the window that closed.
    expect(first.step.tabs()).toBeUndefined();
  });

  describe('Clear Browser Data', () => {
    const profileFile = (home: string, name = 'Cookies') => join(browserDir(home), name);

    it('holds the lock through the close and the delete, and releases it last; a step starting meanwhile waits and launches into the fresh profile', async () => {
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const notes: { lockAfterClose?: boolean } = {};
      let lockFile = '';
      const { service, contexts, launches, home, hooks, readLockPid, lockFile: lf } = setup({ launchHook: (c, n) => void (n === 1 && slowClose(gate, lockFile, notes)(c)) });
      lockFile = lf;
      await service.open();
      writeFileSync(profileFile(home), 'x');
      mkdirSync(join(browserDir(home), 'Default'));
      writeFileSync(profileFile(home, join('Default', 'Login Data')), 'x');
      const cleared = service.clearData();
      await later(10);
      const step = service.startStep(owner('n3'), hooks);
      await later(40);
      expect(readLockPid()).toBe(100); // still ours, browser still closing
      expect(launches).toHaveLength(1);
      expect(existsSync(profileFile(home))).toBe(true);
      release();
      expect(await cleared).toEqual({ ok: true });
      expect(notes.lockAfterClose).toBe(true); // the lock outlived the browser's exit
      const started = await step;
      if (!started.ok) throw new Error(started.error);
      expect(launches).toHaveLength(2);
      expect(existsSync(profileFile(home))).toBe(false);
      expect(existsSync(profileFile(home, 'Default'))).toBe(false);
      expect(readLockPid()).toBe(100);
      expect(contexts[1].closed).toBe(false);
    });

    it('with nothing open it takes the lock itself, deletes the folder and leaves no lock', async () => {
      const { service, home, lockFile } = setup();
      mkdirSync(browserDir(home), { recursive: true });
      writeFileSync(profileFile(home), 'x');
      expect(await service.clearData()).toEqual({ ok: true });
      expect(existsSync(browserDir(home))).toBe(false);
      expect(existsSync(lockFile)).toBe(false);
    });

    it('is refused, with the lock path, while another window owns the browser', async () => {
      const { service, home, lockFile, otherWindow } = setup();
      otherWindow();
      writeFileSync(profileFile(home), 'x');
      expect(await service.clearData()).toEqual({ ok: false, error: `${BROWSER_IN_USE} (lock: ${lockFile})` });
      expect(existsSync(profileFile(home))).toBe(true);
    });

    it.skipIf(!canLink)("is refused while Chrome's own SingletonLock names a live process on this host, and deletes nothing", async () => {
      const { service, home, lockFile } = setup();
      mkdirSync(browserDir(home), { recursive: true });
      writeFileSync(profileFile(home), 'x');
      symlinkSync('myhost-4242', join(browserDir(home), 'SingletonLock'));
      expect(await service.clearData()).toEqual({ ok: false, error: PROFILE_STILL_OPEN });
      expect(existsSync(profileFile(home))).toBe(true);
      expect(existsSync(lockFile)).toBe(false); // the lock it took for the check is given back
    });

    it.skipIf(!canLink)("goes on when the SingletonLock is a dead process's, or another computer's", async () => {
      for (const target of ['myhost-9999', 'elsewhere-4242', 'garbage']) {
        const { service, home } = setup();
        mkdirSync(browserDir(home), { recursive: true });
        writeFileSync(profileFile(home), 'x');
        symlinkSync(target, join(browserDir(home), 'SingletonLock'));
        expect(await service.clearData(), target).toEqual({ ok: true });
        expect(existsSync(browserDir(home))).toBe(false);
      }
    });

    it('is refused when the browser did not close, and leaves the profile, the window and the lock alone', async () => {
      const { service, contexts, home, readLockPid } = setup({
        launchHook: (c) => {
          c.close = async () => {
            throw new Error('stuck');
          };
        },
      });
      await service.open();
      writeFileSync(profileFile(home), 'x');
      expect(await service.clearData()).toEqual({ ok: false, error: PROFILE_STILL_OPEN });
      expect(existsSync(profileFile(home))).toBe(true);
      expect(contexts[0].closed).toBe(false);
      expect(service.isOpen()).toBe(true);
      expect(readLockPid()).toBe(100);
    });

    it.skipIf(!canLink)('refuses a profile folder that is a link, and deletes nothing', async () => {
      const { service, home } = setup();
      const target = mkdtempSync(join(tmpdir(), 'agent-stream-target-'));
      writeFileSync(join(target, 'Cookies'), 'x');
      mkdirSync(join(home, '.agent-stream'), { recursive: true });
      symlinkSync(target, browserDir(home));
      expect(await service.clearData()).toEqual({ ok: false, error: "The browser's data couldn't be deleted: the profile folder is a link." });
      expect(existsSync(join(target, 'Cookies'))).toBe(true);
      expect(existsSync(browserDir(home))).toBe(true);
    });

    it.each([[''], ['relative/home']])('refuses a home folder that is not an absolute path (%j)', async (home) => {
      const service = new BrowserService({ home, platform: PLATFORM, env: {}, settings: () => ({ path: '', searchEngine: '' }), exists: () => true });
      expect(await service.clearData()).toEqual({ ok: false, error: "The browser's data couldn't be deleted: the home folder isn't an absolute path." });
      expect(existsSync(join(process.cwd(), '.agent-stream'))).toBe(false);
    });
  });

  it('shows the start page when anyone who shares a launch asked for it', async () => {
    let release!: () => void;
    const { service, contexts, hooks } = setup({ launchGate: new Promise<void>((r) => (release = r)) });
    const step = service.startStep(owner('n3'), hooks);
    const shown = service.open({ startPage: true });
    release();
    expect((await step).ok).toBe(true);
    expect(await shown).toEqual({ ok: true });
    expect(contexts[0].open[0].content).toBe('<h1>Start</h1>');
  });

  it('a window closed while the start page is set returns The browser was closed. instead of throwing, and releases the lock', async () => {
    const { service, lockFile, hooks, launches } = setup({
      launchHook: (c) => {
        c.open[0].setContent = async () => {
          await c.close();
        };
      },
    });
    const shown = service.open({ startPage: true });
    const step = service.startStep(owner('n3'), hooks);
    expect(await step).toEqual({ ok: false, error: BROWSER_CLOSED });
    expect(await shown).toEqual({ ok: false, error: BROWSER_CLOSED });
    expect(existsSync(lockFile)).toBe(false);
    expect(launches).toHaveLength(1);
  });

  it('after dispose nothing launches: a step gets The browser was closed.', async () => {
    const { service, launches, hooks, lockFile } = setup();
    await service.dispose();
    expect(await service.startStep(owner('n3'), hooks)).toEqual({ ok: false, error: BROWSER_CLOSED });
    expect(await service.open()).toEqual({ ok: false, error: BROWSER_CLOSED });
    expect(await service.show()).toEqual({ ok: false, error: BROWSER_CLOSED });
    expect(launches).toEqual([]);
    expect(existsSync(lockFile)).toBe(false);
  });

  it('a launch queued behind dispose never starts', async () => {
    let release!: () => void;
    const { service, launches, contexts, lockFile } = setup({ launchGate: new Promise<void>((r) => (release = r)) });
    const first = service.open();
    await vi.waitFor(() => expect(launches).toHaveLength(1));
    const second = service.startStep(owner('n3'), { emit() {}, record() {} });
    const disposed = service.dispose();
    release();
    await disposed;
    await first;
    expect(await second).toEqual({ ok: false, error: BROWSER_CLOSED });
    expect(contexts).toHaveLength(1);
    expect(contexts[0].closed).toBe(true);
    expect(existsSync(lockFile)).toBe(false);
  });
});
