import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { lstatSync, readdirSync, readlinkSync, rmdirSync, rmSync, unlinkSync } from 'node:fs';
import { hostname as osHostname } from 'node:os';
import { join, posix, win32 } from 'node:path';
import { BROWSER_CLOSED, DEFAULT_SEARCH_ENGINE, PROFILE_STILL_OPEN, RUN_STOPPED, USER_DONE, waitingLine, type NodeEventBody } from '@agent-stream/shared';
import { processAlive } from '../writeLease';
import { browserDir, createBrowserLock, findBrowser, launchBrowser, type BrowserLock, type FoundBrowser } from './launcher';
import { contextFrom, type ContextLike } from './page';
import { BrowserSession, keyOf, type EndStatus, type Owner, type StepHooks, type StepTabs } from './session';
import { errorText, type BrowserReply, type StepBrowser } from './tools';

/** A step waiting for the user (spec §5.3): what the notification shows. */
/** How a wait ended: Done; Stop or the step's end; the window's disposal. */
export type WaitEnd = 'done' | 'stopped' | 'closed';
export type BrowserWait = { waitId: string; runId: string; nodeId: string; reason: string };

export type BrowserSettings = { path: string; searchEngine: string };
/** For the status bar (ruling R15): whether the window is open, and the node ids of the steps using it. */
export type BrowserState = { open: boolean; steps: string[] };
export type OpenResult = { ok: true } | { ok: false; error: string };
export type BrowserServiceDeps = {
  home: string;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  /** agentStream.browser.*, read on every use so a settings change reaches the next step. */
  settings(): BrowserSettings;
  /** The start page Open Browser shows (spec §5.1), HTML from the extension. */
  startPage?: string;
  /** Test seams: the launch (default: launchBrowser over Playwright), the file check, the lock. */
  launch?: (o: { executablePath: string; userDataDir: string }) => Promise<ContextLike>;
  exists?: (path: string) => boolean;
  lock?: BrowserLock;
  /** How long a window with no page left waits before it counts as closed (default 500 ms): a popup may be on its way. */
  emptyWindowMs?: number;
  /** For Clear Browser Data's look at Chrome's SingletonLock: this computer's name, and whether a process is alive. */
  hostname?: () => string;
  isAlive?: (pid: number) => boolean;
};
const EMPTY_WINDOW_MS = 500;
/** Our own lock files (the owner lock, its take-over marker, a lock being written): Clear Browser Data leaves them to the lock. */
const OWN_FILE_PREFIX = 'agent-stream-owner';

/**
 * The markers of a browser still running on the profile (from a crashed window, or one the user opened), as Playwright and
 * Chrome word them: Playwright's "Opening in existing browser session" / "profile is already in use", Chrome's
 * ProcessSingleton and "profile appears to be in use", and a SingletonLock that exists. Tested on the raw message, call log
 * included, because that is where Playwright says it. Anything broader (a bare "already in use", a SingletonLock we couldn't
 * write) is some other failure and keeps its own reason.
 */
const PROFILE_IN_USE = /ProcessSingleton|profile appears to be in use|profile is already in use|user data directory is already in use|opening in existing browser session|SingletonLock[^\n]*(file exists|in use)/i;

/** Why the browser didn't open (spec §5.4): the profile being held gets its own sentence. */
export const openFailed = (e: unknown): string => {
  const raw = e instanceof Error ? e.message : String(e);
  return PROFILE_IN_USE.test(raw) ? PROFILE_STILL_OPEN : `The browser couldn't be opened: ${errorText(e)}`;
};
const closedResult = { ok: false as const, error: BROWSER_CLOSED };
const deleteFailed = (why: string): { ok: false; error: string } => ({ ok: false, error: `The browser's data couldn't be deleted: ${why}` });

/** One Browser step's handle on the service: its tabs in the window that is open now, or none once it closed. */
export class ServiceStep implements StepBrowser {
  private tabsNow: StepTabs | undefined;
  private sessionNow: BrowserSession | undefined;
  private ended = false;

  constructor(
    private service: BrowserService,
    readonly owner: Owner,
    private hooks: StepHooks,
  ) {}

  /** For the service: the step's tabs in this session. */
  bind(session: BrowserSession): void {
    if (this.ended) return;
    this.sessionNow = session;
    this.tabsNow = session.step(this.owner, this.hooks);
  }

  tabs(): StepTabs | undefined {
    return this.tabsNow && !this.tabsNow.closed && !this.tabsNow.ended ? this.tabsNow : undefined;
  }

  searchEngine(): string {
    return this.service.searchEngine();
  }

  emit(event: NodeEventBody): void {
    this.hooks.emit(event);
  }

  /**
   * browser_wait_for_you (spec §5.3): no timeout; Stop, the step ending and the window's disposal end it; Done reopens a
   * closed browser (spec §5.4, ruling R12), through the service's queue, so it launches after any close or Clear Browser Data
   * under way. Never throws. The done line is logged as the wait ends, so it comes before the tool's answer.
   */
  async waitForUser(reason: string, signal: AbortSignal): Promise<BrowserReply> {
    const waitId = randomUUID();
    this.hooks.emit({ type: 'browser_wait', waitId, text: waitingLine(this.owner.nodeId, reason) });
    const how = await this.service.waitFor({ waitId, runId: this.owner.runId, nodeId: this.owner.nodeId, reason }, signal, (by) =>
      this.hooks.emit({ type: 'browser_wait_done', waitId, by: by === 'done' ? 'user' : 'stopped' }),
    );
    if (how === 'stopped') return { text: RUN_STOPPED, isError: true };
    if (how === 'closed') return { text: BROWSER_CLOSED, isError: true };
    if (!this.tabs()) {
      const opened = await this.service.open();
      // Stop, or the step's end, during the reopen: this step takes no tabs in the new window.
      if (signal.aborted || this.ended) return { text: RUN_STOPPED, isError: true };
      if (!opened.ok) return { text: opened.error, isError: true };
      this.service.rebind(this);
    }
    return { text: USER_DONE };
  }

  /** The step ended: its tabs close when it succeeded (spec §3.2), and it leaves the status bar. Idempotent. */
  async end(status: EndStatus): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    // A wait still pending ends with the step, whatever happened to its signal.
    this.service.endWaits(this.owner, 'stopped');
    const tabs = this.tabsNow;
    if (tabs && this.sessionNow) await this.service.closingStepTabs(this.sessionNow, tabs, status);
    this.service.stepEnded(this);
  }
}

type StepStart = { ok: true; step: ServiceStep } | { ok: false; error: string };

/**
 * The Agent Stream browser of one VS Code window (spec §3): every folder's engine shares it. It opens when a Browser step
 * starts (or Open Browser runs), holds the profile's lock while open, and emits 'state' for the status bar.
 *
 * Launching, closing and Clear Browser Data run one at a time, in the order they were asked for (`serial`): a step that
 * starts while the browser is closing or being cleared waits, then launches a new browser after the lock was released.
 */
export class BrowserService extends EventEmitter {
  private session: BrowserSession | undefined;
  /** The session being closed: not open any more, though its close event hasn't arrived. */
  private closingSession: BrowserSession | undefined;
  private opening: Promise<OpenResult> | undefined;
  private startPageWanted = false;
  private tail: Promise<unknown> = Promise.resolve();
  private lock: BrowserLock;
  private steps = new Map<string, ServiceStep>();
  private waits = new Map<string, { wait: BrowserWait; finish: (how: WaitEnd) => void }>();
  private readonly dir: string;
  private disposed = false;
  /** Clear Browser Data is under way: the browser closing then keeps the lock until the delete is done. */
  private clearing = false;
  /** Tabs a step is closing itself (its end): never taken for the user closing the window. */
  private ownCloses = 0;

  constructor(private d: BrowserServiceDeps) {
    super();
    this.dir = browserDir(d.home);
    this.lock = d.lock ?? createBrowserLock({ dir: this.dir });
  }

  find(): FoundBrowser {
    return findBrowser({ setting: this.d.settings().path, platform: this.d.platform, env: this.d.env, home: this.d.home, exists: this.d.exists });
  }

  searchEngine(): string {
    return this.d.settings().searchEngine.trim() || DEFAULT_SEARCH_ENGINE;
  }

  isOpen(): boolean {
    return !!this.session && !this.session.closed && this.closingSession !== this.session;
  }

  state(): BrowserState {
    return { open: this.isOpen(), steps: [...this.steps.values()].map((s) => s.owner.nodeId) };
  }

  private changed(): void {
    this.emit('state', this.state());
  }

  /** Runs `fn` after everything asked for before it has finished, whatever way that ended. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * Opens the window when it is closed; one launch at a time, shared by everyone who asks meanwhile. `startPage`: a fresh
   * launch shows the start page, whoever of those sharing it asked for it.
   */
  open(o: { startPage?: boolean } = {}): Promise<OpenResult> {
    if (this.disposed) return Promise.resolve(closedResult);
    if (this.isOpen()) return Promise.resolve({ ok: true });
    if (o.startPage) this.startPageWanted = true;
    this.opening ??= this.serial(() => this.launch()).finally(() => {
      this.opening = undefined;
      this.startPageWanted = false;
    });
    return this.opening;
  }

  private async launch(): Promise<OpenResult> {
    if (this.disposed) return closedResult;
    if (this.isOpen()) return { ok: true };
    const found = this.find();
    if (!found.ok) return found;
    let locked: ReturnType<BrowserLock['acquire']>;
    try {
      locked = this.lock.acquire();
    } catch (e) {
      return { ok: false, error: openFailed(e) };
    }
    if (!locked.ok) return locked;
    let context: ContextLike;
    try {
      context = this.d.launch
        ? await this.d.launch({ executablePath: found.path, userDataDir: this.dir })
        : contextFrom(await launchBrowser({ executablePath: found.path, userDataDir: this.dir }));
    } catch (e) {
      this.lock.release();
      return { ok: false, error: openFailed(e) };
    }
    const session = new BrowserSession(context);
    this.session = session;
    // Closed by the user, by Clear Browser Data or by dispose: the lock goes with it (spec §3), except while Clear Browser
    // Data is deleting the profile: it gives the lock back last.
    session.on('closed', () => {
      if (this.session === session) this.session = undefined;
      if (this.closingSession === session) this.closingSession = undefined;
      if (!this.clearing) this.lock.release();
      this.changed();
    });
    // macOS keeps Chrome running when its last window closes, and Playwright then fires no context 'close' (checked with a real
    // Chrome: only the pages' close events fire; a killed or quit browser fires 'close' and 'disconnected' together). So the
    // browser is closed here once its last page is gone: the profile and the lock are released as on Windows and Linux.
    const watch = (page: { onClose(fn: () => void): () => void }) => void page.onClose(() => this.pageClosed(session));
    for (const page of context.pages()) watch(page);
    context.onPage(watch);
    if (this.startPageWanted && this.d.startPage) {
      try {
        await context.pages()[0]?.setContent(this.d.startPage);
      } catch {
        /* the page may be gone: the window is checked below */
      }
    }
    // The window can close while it is being set up (R12): nothing is open then, and nothing throws.
    if (!this.isOpen()) return closedResult;
    this.changed();
    return { ok: true };
  }

  /**
   * A page of `session` closed. A window left with no page is closed after a short wait, once, unless the page was closed by a
   * step ending (those never are the user closing the window) or a new page showed up meanwhile (a popup flow).
   */
  private pageClosed(session: BrowserSession): void {
    if (this.ownCloses > 0 || session.closed) return;
    const timer = setTimeout(() => {
      if (this.disposed || session.closed || this.closingSession === session || this.session !== session) return;
      if (session.context.pages().some((p) => !p.isClosed())) return;
      this.closingSession = session;
      this.changed();
      void this.serial(() => this.closeNow());
    }, this.d.emptyWindowMs ?? EMPTY_WINDOW_MS);
    timer.unref?.();
  }

  /** For ServiceStep: a step's tabs close. When that would leave the window with no page, a blank tab keeps it open first. */
  async closingStepTabs(session: BrowserSession, tabs: StepTabs, status: EndStatus): Promise<void> {
    this.ownCloses++;
    try {
      if (status === 'succeeded' && !session.closed) {
        const mine = new Set<unknown>(tabs.pages());
        const open = session.context.pages().filter((p) => !p.isClosed());
        if (open.length > 0 && open.every((p) => mine.has(p))) await session.context.newPage().catch(() => undefined);
      }
      await tabs.end(status);
    } finally {
      this.ownCloses--;
    }
  }

  /**
   * Brings the window to the front (a step's current tab when given), or opens it with its start page when closed. A browser
   * left running with no tab (macOS keeps it when its last window closes under steps that end together) gets a blank one, so
   * there is always a window to show.
   */
  async show(owner?: Owner): Promise<OpenResult> {
    if (!this.isOpen()) return this.open({ startPage: true });
    const context = this.session!.context;
    const tab = owner ? this.steps.get(keyOf(owner))?.tabs()?.current() : undefined;
    const page = tab ?? context.pages().find((p) => !p.isClosed()) ?? (await context.newPage().catch(() => undefined));
    await page?.front().catch(() => {});
    return { ok: true };
  }

  /** A Browser step starts (spec §5.2): the browser opens first when it is closed (ruling R3). */
  async startStep(owner: Owner, hooks: StepHooks): Promise<StepStart> {
    const opened = await this.open();
    if (!opened.ok) return opened;
    // The window can have closed since (while its start page was set, or Clear Browser Data took it): the R12 answer.
    const session = this.session;
    if (!session || !this.isOpen()) return closedResult;
    const step = new ServiceStep(this, owner, hooks);
    step.bind(session);
    this.steps.set(keyOf(owner), step);
    this.changed();
    return { ok: true, step };
  }

  /**
   * Waits for Done (`done`), the signal (Stop), the step's end or the service's disposal; emits 'wait' for the notification
   * and 'waitEnded' after. `onEnd` runs as the wait ends, before the answer reaches the one waiting.
   */
  waitFor(wait: BrowserWait, signal: AbortSignal, onEnd: (how: WaitEnd) => void = () => {}): Promise<WaitEnd> {
    return new Promise((resolve) => {
      // The hook logs the end: a log that can't be written must not leave the step waiting for an answer.
      const ending = (how: WaitEnd) => {
        try {
          onEnd(how);
        } catch (e) {
          console.error('Agent Stream: ending a browser wait failed', e);
        }
      };
      if (signal.aborted) {
        ending('stopped');
        return resolve('stopped');
      }
      const onAbort = () => finish('stopped');
      const finish = (how: WaitEnd) => {
        if (!this.waits.delete(wait.waitId)) return;
        signal.removeEventListener('abort', onAbort);
        ending(how);
        resolve(how);
        this.emit('waitEnded', wait.waitId);
      };
      this.waits.set(wait.waitId, { wait, finish });
      signal.addEventListener('abort', onAbort, { once: true });
      this.emit('wait', wait);
    });
  }

  /** For ServiceStep: ends the waits of a step that ended (or of every step, with no owner). */
  endWaits(owner: Owner | undefined, how: 'stopped' | 'closed'): void {
    for (const w of [...this.waits.values()]) if (!owner || (w.wait.runId === owner.runId && w.wait.nodeId === owner.nodeId)) w.finish(how);
  }

  /** Done, from the notification or the step log: false when that wait already ended. */
  done(waitId: string): boolean {
    const w = this.waits.get(waitId);
    if (!w) return false;
    w.finish('done');
    return true;
  }

  waiting(): BrowserWait[] {
    return [...this.waits.values()].map((w) => w.wait);
  }

  /** For ServiceStep: fresh tabs in the window that is open now. */
  rebind(step: ServiceStep): void {
    if (this.session && !this.session.closed) step.bind(this.session);
  }

  /** For ServiceStep. */
  stepEnded(step: ServiceStep): void {
    if (this.steps.get(keyOf(step.owner)) !== step) return;
    this.steps.delete(keyOf(step.owner));
    this.changed();
  }

  /** Closes the browser that is open when this turn comes (after any launch under way). A close that fails leaves it open. */
  private async closeNow(): Promise<void> {
    const session = this.session;
    if (!session || session.closed) return;
    this.closingSession = session;
    this.changed();
    await session.context.close().catch(() => {});
    if (!session.closed && this.closingSession === session) {
      this.closingSession = undefined;
      this.changed();
    }
  }

  async close(): Promise<void> {
    await this.serial(() => this.closeNow());
  }

  /**
   * Clear Browser Data (spec §5.1): closes the browser and empties ~/.agent-stream/browser/. It runs in turn with launches, so a
   * step starting meanwhile waits and then launches into the fresh profile. The lock stays ours until everything is deleted.
   */
  clearData(): Promise<OpenResult> {
    return this.serial(() => this.clear());
  }

  private async clear(): Promise<OpenResult> {
    const pathApi = this.d.platform === 'win32' ? win32 : posix;
    if (!this.d.home || !pathApi.isAbsolute(this.d.home)) return deleteFailed("the home folder isn't an absolute path.");
    try {
      if (lstatSync(this.dir).isSymbolicLink()) return deleteFailed('the profile folder is a link.');
    } catch {
      /* no profile folder yet */
    }
    let locked: ReturnType<BrowserLock['acquire']>;
    try {
      locked = this.lock.acquire();
    } catch (e) {
      return deleteFailed(errorText(e));
    }
    if (!locked.ok) return locked;
    this.clearing = true;
    let result: OpenResult;
    try {
      await this.closeNow();
      if (this.session && !this.session.closed) result = { ok: false, error: PROFILE_STILL_OPEN };
      else if (this.chromeStillRunning()) result = { ok: false, error: PROFILE_STILL_OPEN };
      else result = this.emptyProfile();
    } finally {
      this.clearing = false;
      // Last: nobody else can take the profile before everything in it is gone. A browser that would not close keeps its lock.
      if (!this.session || this.session.closed) this.lock.release();
    }
    if (result.ok) {
      try {
        rmdirSync(this.dir);
      } catch {
        /* another window may already have taken the lock and filled it again */
      }
    }
    return result;
  }

  /** Chrome's own SingletonLock, a link named `<host>-<pid>`, names a process still alive on this computer (Task 2's carry). */
  private chromeStillRunning(): boolean {
    let target: string;
    try {
      target = readlinkSync(join(this.dir, 'SingletonLock'));
    } catch {
      return false;
    }
    const at = target.lastIndexOf('-');
    const pid = Number(target.slice(at + 1));
    if (at <= 0 || !Number.isInteger(pid) || pid <= 0) return false;
    if (target.slice(0, at) !== (this.d.hostname ?? osHostname)()) return false;
    return (this.d.isAlive ?? processAlive)(pid);
  }

  /** Everything in the profile folder but the owner lock's own files (a link in it is removed, never followed). */
  private emptyProfile(): OpenResult {
    try {
      for (const name of readdirSync(this.dir)) {
        if (name.startsWith(OWN_FILE_PREFIX)) continue;
        const path = join(this.dir, name);
        // Chrome's SingletonLock is a link to nothing (`host-pid`), and rmSync leaves a dangling link alone.
        if (lstatSync(path).isSymbolicLink()) unlinkSync(path);
        else rmSync(path, { recursive: true, force: true });
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') return deleteFailed(errorText(e));
    }
    return { ok: true };
  }

  /** The VS Code window is closing: the browser closes with it, and its lock goes (spec §3). Nothing launches after this. */
  async dispose(): Promise<void> {
    this.disposed = true;
    // Nobody is left to press Done: every wait ends with the closed message.
    this.endWaits(undefined, 'closed');
    await this.serial(async () => {
      await this.closeNow();
      this.lock.release();
    });
  }
}

export const createBrowserService = (d: BrowserServiceDeps): BrowserService => new BrowserService(d);
