import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, posix, win32 } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BROWSER_IN_USE, NO_BROWSER_FOUND } from '@agent-stream/shared';
import { browserCandidates, browserDir, createBrowserLock, findBrowser, launchBrowser, launchOptions, LOCK_FILE, TAKEOVER_FILE, type ChromiumLauncher } from '../src/browser/launcher';

// The real file system; rmSync is watched, to see what the lock deletes when two windows race (nothing else changes).
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  return { ...real, rmSync: vi.fn(real.rmSync) };
});

const made: string[] = [];
const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-stream-browser-'));
  made.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const only = (...paths: string[]) => (p: string) => paths.includes(p);

describe('finding the browser', () => {
  const home = '/Users/me';
  const mac = (exists: (p: string) => boolean, setting = '') => findBrowser({ setting, platform: 'darwin', env: {}, home, exists });

  it('uses agentStream.browser.path when that file exists, else looks in the standard places', () => {
    expect(mac(only('/opt/my/chrome'), '/opt/my/chrome')).toEqual({ ok: true, path: '/opt/my/chrome' });
    expect(mac(only('/Applications/Chromium.app/Contents/MacOS/Chromium'), '/missing/chrome')).toEqual({ ok: true, path: '/Applications/Chromium.app/Contents/MacOS/Chromium' });
  });

  it('prefers Chrome, then Edge, then Chromium (macOS, including ~/Applications)', () => {
    const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    const edge = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
    const userChromium = posix.join(home, 'Applications', 'Chromium.app', 'Contents', 'MacOS', 'Chromium');
    expect(mac(only(edge, chrome))).toEqual({ ok: true, path: chrome });
    expect(mac(only(edge, userChromium))).toEqual({ ok: true, path: edge });
    expect(mac(only(userChromium))).toEqual({ ok: true, path: userChromium });
  });

  it('knows the Windows install folders, whatever the letter case of the variables', () => {
    const env = { PROGRAMFILES: 'D:\\Apps', 'programfiles(x86)': 'D:\\Apps86', LocalAppData: 'C:\\Users\\me\\AppData\\Local' };
    const list = browserCandidates('win32', env, 'C:\\Users\\me');
    expect(list[0]).toBe(win32.join('D:\\Apps', 'Google', 'Chrome', 'Application', 'chrome.exe'));
    expect(list).toContain(win32.join('D:\\Apps86', 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
    expect(list.at(-1)).toBe(win32.join('C:\\Users\\me\\AppData\\Local', 'Chromium', 'Application', 'chrome.exe'));
    const edge = win32.join('D:\\Apps86', 'Microsoft', 'Edge', 'Application', 'msedge.exe');
    expect(findBrowser({ setting: '', platform: 'win32', env, home: 'C:\\Users\\me', exists: only(edge) })).toEqual({ ok: true, path: edge });
  });

  it('uses the setting only when it is an absolute path to a file', () => {
    // A relative path would resolve against the extension host's working directory.
    expect(mac(() => true, 'chrome')).toEqual({ ok: true, path: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
    expect(findBrowser({ setting: 'bin\\chrome.exe', platform: 'win32', env: {}, home: 'C:\\Users\\me', exists: () => true })).not.toMatchObject({ path: 'bin\\chrome.exe' });
    // A folder (such as an .app bundle) is not an executable.
    const folder = tmp();
    expect(findBrowser({ setting: folder, platform: process.platform, env: {}, home })).not.toEqual({ ok: true, path: folder });
    const file = join(folder, 'chrome');
    writeFileSync(file, '');
    expect(findBrowser({ setting: file, platform: process.platform, env: {}, home })).toEqual({ ok: true, path: file });
  });

  it('falls back to the Windows default folders when the variables are missing or empty', () => {
    const list = browserCandidates('win32', { ProgramFiles: '  ', LOCALAPPDATA: '' }, 'C:\\Users\\me');
    expect(list).toContain(win32.join('C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'));
    expect(list).toContain(win32.join('C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
    expect(list.at(-1)).toBe(win32.join('C:\\Users\\me', 'AppData', 'Local', 'Chromium', 'Application', 'chrome.exe'));
  });

  it('knows the Linux paths (for CI) and says how to fix it when nothing is found', () => {
    expect(browserCandidates('linux', {}, '/home/me')).toContain('/usr/bin/google-chrome');
    expect(mac(() => false)).toEqual({ ok: false, error: NO_BROWSER_FOUND });
    expect(NO_BROWSER_FOUND).toBe('No Chrome, Edge or Chromium found: install one or set agentStream.browser.path.');
  });

  it('keeps its profile in ~/.agent-stream/browser', () => {
    expect(browserDir(join('h', 'me'))).toBe(join('h', 'me', '.agent-stream', 'browser'));
  });
});

describe('the one-window lock', () => {
  const lockAt = (dir: string, pid: number, alive: number[] = [], isAlive = (p: number) => alive.includes(p)) => createBrowserLock({ dir, pid, isAlive, clock: () => 't' });
  const named = (dir: string) => (JSON.parse(readFileSync(join(dir, LOCK_FILE), 'utf8')) as { pid: number }).pid;
  const refusal = (dir: string) => `${BROWSER_IN_USE} (lock: ${join(dir, LOCK_FILE)})`;
  const writeLock = (dir: string, pid: number, startedAt = 'x') => writeFileSync(join(dir, LOCK_FILE), JSON.stringify({ version: 1, pid, startedAt }));
  const writeMarker = (dir: string, pid: number) => writeFileSync(join(dir, TAKEOVER_FILE), JSON.stringify({ version: 1, pid, startedAt: 'x' }));
  /** Makes a file look as if it was written `seconds` ago. */
  const age = (path: string, seconds: number) => utimesSync(path, new Date(Date.now() - seconds * 1000), new Date(Date.now() - seconds * 1000));
  const files = (dir: string) => readdirSync(dir).sort();

  it('is a file in the profile folder naming this process, removed on release', () => {
    const dir = join(tmp(), 'browser');
    const lock = lockAt(dir, 100, [100]);
    expect(lock.acquire()).toEqual({ ok: true });
    expect(JSON.parse(readFileSync(join(dir, LOCK_FILE), 'utf8'))).toEqual({ version: 1, pid: 100, startedAt: 't' });
    expect(lock.held()).toBe(true);
    expect(lock.acquire()).toEqual({ ok: true });
    // No temporary file is left next to it.
    expect(files(dir)).toEqual([LOCK_FILE]);
    lock.release();
    expect(existsSync(join(dir, LOCK_FILE))).toBe(false);
    expect(lock.held()).toBe(false);
  });

  it('refuses while another window (a live process) holds it, naming the lock file', () => {
    const dir = tmp();
    expect(lockAt(dir, 100, [100, 200]).acquire()).toEqual({ ok: true });
    const other = lockAt(dir, 200, [100, 200]);
    expect(other.acquire()).toEqual({ ok: false, error: refusal(dir) });
    expect(other.inUseElsewhere()).toBe(true);
    expect(BROWSER_IN_USE).toBe('The Agent Stream browser is in use by another VS Code window.');
    expect(refusal(dir).startsWith(BROWSER_IN_USE)).toBe(true);
    expect(named(dir)).toBe(100);
    expect(files(dir)).toEqual([LOCK_FILE]);
  });

  it('releases only a lock that names this process and this start', () => {
    const dir = tmp();
    const first = lockAt(dir, 100, [200]);
    expect(first.acquire()).toEqual({ ok: true });
    // Another window took the lock over (this process was thought gone) and now holds it.
    writeLock(dir, 200);
    first.release();
    expect(first.held()).toBe(false);
    expect(named(dir)).toBe(200);
    // The same pid but not this start (an earlier run of the host): not this lock either.
    const second = lockAt(dir, 300, [200, 300]);
    expect(second.acquire()).toEqual({ ok: false, error: refusal(dir) });
    rmSync(join(dir, LOCK_FILE));
    expect(second.acquire()).toEqual({ ok: true });
    writeLock(dir, 300, 'earlier');
    second.release();
    expect(JSON.parse(readFileSync(join(dir, LOCK_FILE), 'utf8'))).toMatchObject({ pid: 300, startedAt: 'earlier' });
  });

  it('takes over a stale lock: its process is gone, or this process left it behind', () => {
    const dir = tmp();
    writeLock(dir, 300);
    const lock = lockAt(dir, 200, [200]);
    expect(lock.inUseElsewhere()).toBe(false);
    expect(lock.acquire()).toEqual({ ok: true });
    expect(named(dir)).toBe(200);
    expect(files(dir)).toEqual([LOCK_FILE]);
    const leftover = tmp();
    writeLock(leftover, 200);
    expect(lockAt(leftover, 200, [200]).acquire()).toEqual({ ok: true });
    expect(files(leftover)).toEqual([LOCK_FILE]);
  });

  it('takes over an unreadable lock only once it is old enough not to be one being written', () => {
    const dir = tmp();
    writeFileSync(join(dir, LOCK_FILE), '{ torn');
    expect(lockAt(dir, 200, [200]).acquire()).toEqual({ ok: false, error: refusal(dir) });
    age(join(dir, LOCK_FILE), 11);
    const lock = lockAt(dir, 200, [200]);
    expect(lock.acquire()).toEqual({ ok: true });
    expect(named(dir)).toBe(200);
    expect(files(dir)).toEqual([LOCK_FILE]);
  });

  it('lets at most one of three windows that take over the same stale lock hold it', () => {
    const dir = tmp();
    writeLock(dir, 300);
    const live = [100, 200, 400];
    const window = (pid: number, whenStaleSeen?: () => void) =>
      lockAt(dir, pid, [], (p) => {
        if (p === 300) {
          // This window has just found the lock stale; the next one runs its whole acquire before it goes on.
          const run = whenStaleSeen;
          whenStaleSeen = undefined;
          run?.();
          return false;
        }
        return live.includes(p);
      });
    const c = window(400);
    const b = window(200, () => expect(c.acquire()).toEqual({ ok: true }));
    const a = window(100, () => expect(b.acquire()).toEqual({ ok: false, error: refusal(dir) }));
    expect(a.acquire()).toEqual({ ok: false, error: refusal(dir) });
    expect([a.held(), b.held(), c.held()]).toEqual([false, false, true]);
    expect(named(dir)).toBe(400);
    // Nobody left a take-over marker or a temporary file behind.
    expect(files(dir)).toEqual([LOCK_FILE]);
  });

  it('leaves no window blocked by a dead lock when the holder releases during a take-over', () => {
    const dir = tmp();
    const holder = lockAt(dir, 100, [100, 200]);
    expect(holder.acquire()).toEqual({ ok: true });
    let seen = false;
    // The other window wrongly sees the holder as gone (a recycled pid, say) and starts taking over; the holder releases meanwhile.
    const other = lockAt(dir, 200, [], (p) => {
      if (p === 100 && !seen) {
        seen = true;
        holder.release();
        return false;
      }
      return p === 200;
    });
    expect(other.acquire()).toEqual({ ok: true });
    expect(named(dir)).toBe(200);
    expect(files(dir)).toEqual([LOCK_FILE]);
    other.release();
    expect(files(dir)).toEqual([]);
  });

  it('takes the lock when a stale one is replaced by another stale one while it decides', () => {
    const dir = tmp();
    writeLock(dir, 300);
    let seen = false;
    const b = lockAt(dir, 200, [], (p) => {
      if (p === 300 && !seen) {
        seen = true;
        rmSync(join(dir, LOCK_FILE));
        writeLock(dir, 301);
      }
      return p === 200;
    });
    expect(b.acquire()).toEqual({ ok: true });
    expect(named(dir)).toBe(200);
    expect(files(dir)).toEqual([LOCK_FILE]);
  });

  it("a take-over that finds the stale lock already gone deletes nothing: another window's new lock could be there by then", () => {
    const dir = tmp();
    writeLock(dir, 300);
    // The stale lock goes away (its holder's leftovers cleared) right after this window found it stale.
    const lock = lockAt(dir, 200, [], (p) => {
      if (p === 300) unlinkSync(join(dir, LOCK_FILE));
      return p === 200;
    });
    vi.mocked(rmSync).mockClear();
    expect(lock.acquire()).toEqual({ ok: true });
    expect(named(dir)).toBe(200);
    // Between the take-over's look and its own create, another window may link a lock: one the take-over must never delete.
    expect(vi.mocked(rmSync).mock.calls.map(([path]) => path)).not.toContain(join(dir, LOCK_FILE));
  });

  it('refuses while a live window is taking over, and clears the marker of a take-over that crashed', () => {
    const dir = tmp();
    writeLock(dir, 300);
    writeMarker(dir, 100);
    const lock = lockAt(dir, 200, [100, 200]);
    expect(lock.acquire()).toEqual({ ok: false, error: refusal(dir) });
    expect(named(dir)).toBe(300);
    // The marker's process died ...
    expect(lockAt(dir, 200, [200]).acquire()).toEqual({ ok: true });
    expect(files(dir)).toEqual([LOCK_FILE]);
    // ... or it is alive but has held the marker far too long.
    const old = tmp();
    writeLock(old, 300);
    writeMarker(old, 100);
    age(join(old, TAKEOVER_FILE), 31);
    expect(lockAt(old, 200, [100, 200]).acquire()).toEqual({ ok: true });
    expect(files(old)).toEqual([LOCK_FILE]);
  });

  it('acquires after a take-over crashed between removing the stale lock and creating its own', () => {
    const dir = tmp();
    // What a crash there leaves: no lock, and the crashed window's marker.
    writeMarker(dir, 400);
    expect(lockAt(dir, 200, [200]).acquire()).toEqual({ ok: true });
    expect(named(dir)).toBe(200);
    // The marker doesn't block a later take-over either.
    const later = lockAt(dir, 500, [200, 500]);
    expect(later.acquire()).toEqual({ ok: false, error: refusal(dir) });
    writeLock(dir, 300);
    expect(lockAt(dir, 500, [500]).acquire()).toEqual({ ok: true });
    expect(files(dir)).toEqual([LOCK_FILE]);
  });

  it('refuses instead of throwing when the lock can not be written', () => {
    const dir = tmp();
    // A file where the folder should be.
    const blocker = join(dir, 'browser');
    writeFileSync(blocker, '');
    const result = lockAt(blocker, 100, [100]).acquire();
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ error: expect.stringContaining("The browser's lock couldn't be taken") });
  });

  it('creates its folder private to the user', () => {
    if (process.platform === 'win32') return;
    const dir = join(tmp(), 'a', 'browser');
    lockAt(dir, 100, [100]).acquire();
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });
});

describe('launching', () => {
  it('opens a visible window with downloads off, the sandbox on and the OS keychain, over a pipe', () => {
    const o = launchOptions({ executablePath: '/bin/chrome', userDataDir: '/p' });
    expect(o).toEqual({
      executablePath: '/bin/chrome',
      headless: false,
      acceptDownloads: false,
      viewport: null,
      chromiumSandbox: true,
      // The two keychain flags, and the defaults that switch off the browser's own protections (phishing and Safe Browsing
      // updates, popup blocking, the self-XSS warning). `--disable-features` stays: it is one argument that also holds
      // flags Playwright needs.
      ignoreDefaultArgs: [
        '--password-store=basic',
        '--use-mock-keychain',
        '--disable-client-side-phishing-detection',
        '--disable-background-networking',
        '--disable-component-update',
        '--disable-popup-blocking',
        '--unsafely-disable-devtools-self-xss-warnings',
        '--disable-prompt-on-repost',
      ],
    });
    // No debugging port: Playwright's own pipe is the only control connection (spec §3.1, §6).
    expect(JSON.stringify(o)).not.toMatch(/remote-debugging|cdpPort|channel/);
    expect(launchOptions({ executablePath: '/c', userDataDir: '/p', headless: true, sandbox: false })).toMatchObject({ headless: true, chromiumSandbox: false });
  });

  it('passes a test its extra arguments, and the product has none', () => {
    expect(launchOptions({ executablePath: '/c', userDataDir: '/p' })).not.toHaveProperty('args');
    expect(launchOptions({ executablePath: '/c', userDataDir: '/p', args: ['--a', '--b=1'] })).toMatchObject({ args: ['--a', '--b=1'] });
  });

  it('creates the profile folder and hands both to launchPersistentContext', async () => {
    const dir = join(tmp(), 'nested', 'browser');
    const calls: [string, unknown][] = [];
    const fake = { launchPersistentContext: async (d: string, options: unknown) => (calls.push([d, options]), {} as never) } as unknown as ChromiumLauncher;
    await launchBrowser({ executablePath: '/bin/chrome', userDataDir: dir }, fake);
    expect(existsSync(dir)).toBe(true);
    if (process.platform !== 'win32') expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(calls).toEqual([[dir, launchOptions({ executablePath: '/bin/chrome', userDataDir: dir })]]);
  });

  it('depends on playwright-core, which downloads no browser when installed', () => {
    const require = createRequire(import.meta.url);
    const manifest = JSON.parse(readFileSync(require.resolve('playwright-core/package.json'), 'utf8')) as { scripts?: Record<string, string> };
    expect(manifest.scripts?.install).toBeUndefined();
    expect(manifest.scripts?.postinstall).toBeUndefined();
  });
});
