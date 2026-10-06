import { randomBytes } from 'node:crypto';
import { linkSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, posix, win32 } from 'node:path';
import type { BrowserContext, BrowserType } from 'playwright-core';
import { BROWSER_IN_USE, NO_BROWSER_FOUND } from '@agent-stream/shared';
import { processAlive } from '../writeLease';

/** The Agent Stream browser's own profile, with the user's logins: outside every project, so never committed (spec §6). */
export const browserDir = (home: string): string => join(home, '.agent-stream', 'browser');
/** The one-window lock, kept in the profile folder (spec §3 "One owner per machine", ruling R14). */
export const LOCK_FILE = 'agent-stream-owner.json';
/** Held by the one window that is replacing a stale lock, so two windows never do it at once. */
export const TAKEOVER_FILE = 'agent-stream-owner.takeover';
/** A lock that can't be read is taken to be one still being written until it is this old. */
const UNREADABLE_LOCK_MS = 10_000;
/** A take-over marker older than this is from a window that crashed or hung. */
const TAKEOVER_MARKER_MS = 30_000;

export type FoundBrowser = { ok: true; path: string } | { ok: false; error: string };
export type FindBrowserOptions = { setting: string; platform: NodeJS.Platform; env: NodeJS.ProcessEnv; home: string; exists?: (path: string) => boolean };

/** An environment variable in any letter case (Windows has ProgramFiles, PROGRAMFILES, …); undefined when empty. */
function envVar(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase());
  const value = key === undefined ? undefined : env[key];
  return value?.trim() ? value : undefined;
}

/** Chrome, then Edge, then Chromium, where their installers put them (spec §3.1); the Linux paths are for CI. */
export function browserCandidates(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, home: string): string[] {
  if (platform === 'win32') {
    const pf = envVar(env, 'ProgramFiles') ?? 'C:\\Program Files';
    const pf86 = envVar(env, 'ProgramFiles(x86)') ?? 'C:\\Program Files (x86)';
    const local = envVar(env, 'LOCALAPPDATA') ?? win32.join(home, 'AppData', 'Local');
    return [
      win32.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      win32.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      win32.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      win32.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      win32.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      win32.join(local, 'Chromium', 'Application', 'chrome.exe'),
    ];
  }
  if (platform === 'darwin') {
    const dirs = ['/Applications', posix.join(home, 'Applications')];
    const app = (name: string) => dirs.map((dir) => posix.join(dir, `${name}.app`, 'Contents', 'MacOS', name));
    return [...app('Google Chrome'), ...app('Microsoft Edge'), ...app('Chromium')];
  }
  return [
    '/opt/google/chrome/chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/opt/microsoft/msedge/msedge',
    '/usr/bin/microsoft-edge',
    '/usr/bin/microsoft-edge-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
  ];
}

/** A regular file, not a folder (an .app bundle) and not missing. */
const isFile = (path: string): boolean => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

/**
 * The agentStream.browser.path setting when it is an absolute path to a file, then the standard places (spec §3.1,
 * ruling R16). A relative path would resolve against the extension host's working directory, so it is not used.
 */
export function findBrowser(o: FindBrowserOptions): FoundBrowser {
  const exists = o.exists ?? isFile;
  const setting = o.setting.trim();
  if (setting && (o.platform === 'win32' ? win32 : posix).isAbsolute(setting) && exists(setting)) return { ok: true, path: setting };
  const path = browserCandidates(o.platform, o.env, o.home).find((p) => exists(p));
  return path ? { ok: true, path } : { ok: false, error: NO_BROWSER_FOUND };
}

export type BrowserLock = {
  /** Takes the lock for this process; refused while another window's live process holds it. */
  acquire(): { ok: true } | { ok: false; error: string };
  /** Removes the lock file, if this process holds it. */
  release(): void;
  held(): boolean;
  /** Another window's live process holds it now (Clear Browser Data must not delete its profile). */
  inUseElsewhere(): boolean;
};

type LockRead = { kind: 'none' } | { kind: 'unreadable'; ageMs: number } | { kind: 'held'; pid: number; startedAt: string; ageMs: number };

/**
 * The lock that lets one VS Code window at a time use the profile (spec §3, ruling R14).
 *
 * Two windows must never both hold it, so a lock is never written in place, never moved and never deleted by a window
 * that doesn't know it is stale:
 * - It is created whole: written to a temporary file, then hard-linked to the lock's name, which fails when a lock exists.
 *   No reader sees it empty or half written, and whoever's link succeeds holds it.
 * - A stale lock (its process is gone, this process left it behind, or it is unreadable and not new) is replaced by one
 *   window at a time, the one holding the take-over marker (also created by link). Under the marker the lock is read
 *   again: a lock a live window holds now is left alone. Only a stale one is deleted, and the window then links its own;
 *   nobody else can create a lock in between except through the same link, which then fails for one of the two.
 * - A marker left by a crashed take-over (dead process, or older than 30 s) is cleared.
 * Residual: two windows clearing the same stale marker in the same instant can both enter the take-over.
 */
export function createBrowserLock(o: { dir: string; pid?: number; isAlive?: (pid: number) => boolean; clock?: () => string; now?: () => number }): BrowserLock {
  const pid = o.pid ?? process.pid;
  const isAlive = o.isAlive ?? processAlive;
  const clock = o.clock ?? (() => new Date().toISOString());
  const now = o.now ?? Date.now;
  const file = join(o.dir, LOCK_FILE);
  const marker = join(o.dir, TAKEOVER_FILE);
  const inUse = { ok: false as const, error: `${BROWSER_IN_USE} (lock: ${file})` };
  let mine: string | undefined;
  const read = (path: string): LockRead => {
    let content: string;
    try {
      content = readFileSync(path, 'utf8');
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === 'ENOENT' ? { kind: 'none' } : { kind: 'unreadable', ageMs: 0 };
    }
    let ageMs = 0;
    try {
      ageMs = now() - statSync(path).mtimeMs;
    } catch {
      /* gone since the read: treated as new */
    }
    try {
      const j = JSON.parse(content) as { version?: unknown; pid?: unknown; startedAt?: unknown };
      if (j.version === 1 && typeof j.pid === 'number' && Number.isInteger(j.pid) && j.pid > 0) return { kind: 'held', pid: j.pid, startedAt: typeof j.startedAt === 'string' ? j.startedAt : '', ageMs };
    } catch {
      /* unreadable below */
    }
    return { kind: 'unreadable', ageMs };
  };
  const liveOther = (r: LockRead): boolean => r.kind === 'held' && r.pid !== pid && isAlive(r.pid);
  /** Someone holds the lock for real: a live process, or a file that may still be being written. */
  const lockBusy = (r: LockRead): boolean => liveOther(r) || (r.kind === 'unreadable' && r.ageMs < UNREADABLE_LOCK_MS);
  const markerBusy = (r: LockRead): boolean => (r.kind === 'held' && liveOther(r) && r.ageMs < TAKEOVER_MARKER_MS) || (r.kind === 'unreadable' && r.ageMs < TAKEOVER_MARKER_MS);
  /** Creates `path` whole, naming this process; its startedAt, or undefined when the file already exists. */
  const create = (path: string): string | undefined => {
    const startedAt = clock();
    const tmp = join(o.dir, `agent-stream-owner.tmp.${pid}.${randomBytes(4).toString('hex')}`);
    try {
      writeFileSync(tmp, `${JSON.stringify({ version: 1, pid, startedAt }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
      linkSync(tmp, path);
      return startedAt;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') return undefined;
      throw e;
    } finally {
      rmSync(tmp, { force: true });
    }
  };
  /** Replaces a stale lock; the new lock's startedAt, or undefined when a live window has it or is replacing it. */
  const takeOver = (): string | undefined => {
    let have = false;
    for (let attempt = 0; attempt < 2 && !have; attempt++) {
      if (create(marker) !== undefined) {
        have = true;
        break;
      }
      const seen = read(marker);
      if (markerBusy(seen)) return undefined;
      // Stale marker (crashed take-over): clear it, unless it was replaced since it was read.
      const again = read(marker);
      if (again.kind === seen.kind && (again.kind !== 'held' || (seen.kind === 'held' && again.pid === seen.pid && again.startedAt === seen.startedAt))) rmSync(marker, { force: true });
    }
    if (!have) return undefined;
    try {
      const current = read(file);
      if (lockBusy(current)) return undefined;
      // Only a stale lock is deleted: when it is already gone, another window may link a new one any moment, and that is
      // never ours to delete (create then fails, and this window is refused).
      if (current.kind !== 'none') rmSync(file, { force: true });
      return create(file);
    } finally {
      rmSync(marker, { force: true });
    }
  };
  return {
    acquire() {
      if (mine !== undefined) return { ok: true };
      try {
        mkdirSync(o.dir, { recursive: true, mode: 0o700 });
        // Two rounds: the lock may vanish (its holder released) between the failed create and the look at it.
        for (let round = 0; round < 2; round++) {
          let startedAt = create(file);
          if (startedAt === undefined) {
            const seen = read(file);
            if (seen.kind === 'none') continue;
            if (lockBusy(seen)) return inUse;
            startedAt = takeOver();
            if (startedAt === undefined) return inUse;
          }
          mine = startedAt;
          return { ok: true };
        }
        // Still contended with nobody to name: say so rather than blame another window.
        return lockBusy(read(file)) ? inUse : { ok: false, error: "The browser's lock couldn't be taken: it kept changing. Try again." };
      } catch (e) {
        return { ok: false, error: `The browser's lock couldn't be taken: ${e instanceof Error ? e.message : String(e)}` };
      }
    },
    release() {
      if (mine === undefined) return;
      const startedAt = mine;
      mine = undefined;
      const seen = read(file);
      if (seen.kind !== 'held' || seen.pid !== pid || seen.startedAt !== startedAt) return;
      try {
        rmSync(file, { force: true });
      } catch (e) {
        // Windows can refuse a delete (EPERM/EBUSY). The file then still names this live process, so other windows are
        // refused until this window closes.
        console.error('[agent-stream] could not delete the browser lock file', file, e);
      }
    },
    held: () => mine !== undefined,
    inUseElsewhere: () => lockBusy(read(file)),
  };
}

export type LaunchOptions = {
  executablePath: string;
  userDataDir: string;
  /** Tests only: no window. The product always shows it (spec §8, ruling R18). */
  headless?: boolean;
  /** Tests only: Linux CI runners can't give Chrome's sandbox the user namespaces it needs (ruling R18). */
  sandbox?: boolean;
  /**
   * Tests only: extra browser arguments, so the suite's Chrome makes no outside connections and never waits on a real keychain
   * (ruling R18, PF18). The product never sets it: its launch has no `args`.
   */
  args?: string[];
};
export type ChromiumLauncher = Pick<BrowserType, 'launchPersistentContext'>;
type PersistentOptions = NonNullable<Parameters<BrowserType['launchPersistentContext']>[1]>;

/**
 * Playwright's test defaults that the user's own browser doesn't get: the keychain stand-ins (cookies stay encrypted by the OS
 * keychain, spec §6) and the switches that turn off its phishing and Safe Browsing protection, certificate-revocation updates,
 * popup blocking, the self-XSS warning and the question before a reload sends a form again. `--disable-features` is left
 * alone: it is one argument that also holds flags Playwright needs, and losing HttpsUpgrades is accepted.
 */
const IGNORED_DEFAULT_ARGS = [
  '--password-store=basic',
  '--use-mock-keychain',
  '--disable-client-side-phishing-detection',
  '--disable-background-networking',
  '--disable-component-update',
  '--disable-popup-blocking',
  '--unsafely-disable-devtools-self-xss-warnings',
  '--disable-prompt-on-repost',
];

/**
 * The options for the user's own browser (spec §3.1, §6): a visible window, downloads off, the window's own size, the
 * sandbox on, and the cookies kept in the OS keychain as the browser normally does — Playwright's test defaults
 * that get in the way of that are dropped. No `args` (only a test sets them), no port: Playwright's pipe is the only connection.
 */
export function launchOptions(o: LaunchOptions): PersistentOptions {
  return {
    executablePath: o.executablePath,
    headless: o.headless ?? false,
    acceptDownloads: false,
    viewport: null,
    chromiumSandbox: o.sandbox ?? true,
    ignoreDefaultArgs: IGNORED_DEFAULT_ARGS,
    ...(o.args && { args: o.args }),
  };
}

/**
 * Starts the browser on the profile. playwright-core is loaded here, not at import, so activating the extension doesn't
 * load it (ruling R17). `chromium` is a test seam.
 */
export async function launchBrowser(o: LaunchOptions, chromium?: ChromiumLauncher): Promise<BrowserContext> {
  mkdirSync(o.userDataDir, { recursive: true, mode: 0o700 });
  const launcher = chromium ?? (await import('playwright-core')).chromium;
  return launcher.launchPersistentContext(o.userDataDir, launchOptions(o));
}
