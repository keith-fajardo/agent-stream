import { EventEmitter } from 'node:events';
import { BROWSER_CLOSED, dialogLine, loggedUrl, nowOnLine, openedLine, type NodeEventBody } from '@agent-stream/shared';
import type { ContextLike, DialogLike, PageLike } from './page';
import { isWebUrl } from './urls';

/** Navigations wait at most this long (spec §5.4). */
export const NAV_TIMEOUT_MS = 30_000;
/** A tab is sent back this many times in a row for opening a non-web address; after that it is left on about:blank. */
export const MAX_SEND_BACKS = 3;

/** Whose tabs: one step of one run (spec §3.2). */
export type Owner = { runId: string; nodeId: string };
/** Where a step's browser lines and visited URLs go: its log and its run record. */
export type StepHooks = { emit(event: NodeEventBody): void; record(url: string): void };
export type EndStatus = 'succeeded' | 'failed' | 'cancelled' | 'interrupted';

/** The one key a step is known by: its run and its node. */
export const keyOf = (o: Owner) => `${o.runId}\u0000${o.nodeId}`;
/** Pages Chrome shows itself that a step's tab may be on: never sent back as a blocked navigation. */
const harmless = (url: string) => url === 'about:blank' || url.startsWith('chrome-error:');

/**
 * The browser context of one launch and which of its tabs belong to which step (spec §3.2). Tabs the user opens, and
 * popups of those, belong to nobody and are never touched. Emits 'changed' (the steps using it) and 'closed'.
 */
export class BrowserSession extends EventEmitter {
  private byKey = new Map<string, StepTabs>();
  private ownerOf = new Map<PageLike, StepTabs>();
  private isClosed = false;

  constructor(readonly context: ContextLike) {
    super();
    context.onPage((page) => void this.adopt(page));
    context.onClose(() => {
      this.isClosed = true;
      this.emit('closed');
    });
  }

  get closed(): boolean {
    return this.isClosed;
  }

  /** A step starts using the browser: its own set of tabs, empty until a tool needs one. */
  step(owner: Owner, hooks: StepHooks): StepTabs {
    const key = keyOf(owner);
    const existing = this.byKey.get(key);
    if (existing) return existing;
    const tabs = new StepTabs(this, owner, hooks);
    this.byKey.set(key, tabs);
    this.emit('changed');
    return tabs;
  }

  /** The node ids of the steps using the browser now, in the order they started (the status bar). */
  stepIds(): string[] {
    return [...this.byKey.values()].map((t) => t.owner.nodeId);
  }

  /** For StepTabs: this page is the step's. */
  claim(page: PageLike, tabs: StepTabs): void {
    this.ownerOf.set(page, tabs);
  }

  /** For StepTabs: the step ended, and its pages are nobody's now. */
  forget(tabs: StepTabs, pages: readonly PageLike[]): void {
    for (const page of pages) this.ownerOf.delete(page);
    this.byKey.delete(keyOf(tabs.owner));
    this.emit('changed');
  }

  /** A new tab joins a step when one of that step's tabs opened it (a popup, target=_blank). */
  private async adopt(page: PageLike): Promise<void> {
    let opener: PageLike | null;
    try {
      opener = await page.opener();
    } catch {
      return;
    }
    const tabs = opener ? this.ownerOf.get(opener) : undefined;
    if (tabs && !tabs.ended) tabs.join(page, true);
  }
}

/** The address without its fragment: two addresses that differ only there are the same document. */
const withoutHash = (url: string): string => {
  const at = url.indexOf('#');
  return at < 0 ? url : url.slice(0, at);
};

/** One step's tabs (ruling R7), its page log (ruling R8) and the refs of each tab's last snapshot. */
export class StepTabs {
  private open: PageLike[] = [];
  private currentPage: PageLike | undefined;
  private creating: Promise<PageLike> | undefined;
  private logged = new Map<PageLike, string>();
  private lastGood = new Map<PageLike, string>();
  private quietNext = new Set<PageLike>();
  private snapshots = new Map<PageLike, string>();
  /** Per tab: the listeners and the file chooser block this step put on it, to take off when the step ends. */
  private detach = new Map<PageLike, (() => void)[]>();
  /** Per tab: how many times in a row it was sent back for opening a non-web address. */
  private sendBacks = new Map<PageLike, number>();
  /** Tabs being sent back right now, with how many sends are under way: their next good navigation is ours, not a fresh start. */
  private returning = new Map<PageLike, number>();
  private stuck = new Set<PageLike>();
  private blocked = false;
  /** Dialogs the step's tabs showed and we answered, not yet told to the agent: the page's address and what to say. */
  private dialogs: { url: string; text: string }[] = [];
  /** Set by end(): the tabs are ordinary tabs from then on. */
  ended = false;

  constructor(
    private session: BrowserSession,
    readonly owner: Owner,
    private hooks: StepHooks,
  ) {}

  /** The window these tabs lived in was closed. */
  get closed(): boolean {
    return this.session.closed;
  }

  pages(): PageLike[] {
    return this.open.filter((p) => !p.isClosed());
  }

  /**
   * The tab the step's tools act on: the one it switched to or that opened last; the newest left when that one closed.
   * The fallback is logged here, when the step next asks (PF10), not when the tab closes: a window closing tab by tab
   * has settled by then.
   */
  current(): PageLike | undefined {
    if (this.currentPage && !this.currentPage.isClosed()) return this.currentPage;
    this.makeCurrent(this.pages().at(-1));
    if (this.currentPage && !this.ended) this.announce(this.currentPage);
    return this.currentPage;
  }

  /** The current tab changes: refs belong to the tab they were taken on, so none carry over to the new one. */
  private makeCurrent(page: PageLike | undefined): void {
    if (page !== this.currentPage) this.snapshots.clear();
    this.currentPage = page;
  }

  /** `🌐 now on <url>` for a current tab that changed without a navigation; a tab with nothing loaded has no page to name. */
  private announce(page: PageLike): void {
    const url = page.url();
    if (isWebUrl(url)) this.hooks.emit({ type: 'browser', text: nowOnLine(loggedUrl(url)) });
  }

  /** What stops a tool using the tabs of a step that ended or of a window that closed. */
  private assertUsable(): void {
    if (this.ended || this.session.closed) throw new Error(BROWSER_CLOSED);
  }

  /** The current tab, or a new one when the step has none. Parallel calls share the one new tab. */
  async ensureTab(): Promise<PageLike> {
    this.assertUsable();
    const page = this.current();
    if (page) return page;
    this.creating ??= this.openTab().finally(() => (this.creating = undefined));
    return this.creating;
  }

  private async openTab(): Promise<PageLike> {
    const created = await this.session.context.newPage();
    if (this.ended) {
      // The step ended while the tab was opening: it is nobody's, and it was only ever meant for the step.
      await created.close().catch(() => {});
      throw new Error(BROWSER_CLOSED);
    }
    this.join(created, true);
    return created;
  }

  /** 1-based, in the order the step got its tabs. Logs where the step is now when the current tab changes. */
  switchTo(index: number): PageLike | undefined {
    this.assertUsable();
    const page = Number.isInteger(index) && index >= 1 ? this.pages()[index - 1] : undefined;
    const was = this.currentPage && !this.currentPage.isClosed() ? this.currentPage : undefined;
    if (page && page !== was) {
      this.makeCurrent(page);
      this.announce(page);
    }
    return page;
  }

  join(page: PageLike, makeCurrent: boolean): void {
    if (this.ended || this.open.includes(page)) return;
    this.open.push(page);
    this.session.claim(page, this);
    this.detach.set(page, [page.blockFileChooser(), page.onNavigated((url) => this.navigated(page, url)), page.onDialog((dialog) => this.answer(page, dialog))]);
    if (makeCurrent || !this.currentPage || this.currentPage.isClosed()) this.makeCurrent(page);
    // A popup may have loaded before it was adopted.
    if (page.url() !== 'about:blank') this.navigated(page, page.url());
  }

  /** Goes to `url` in `page`; `quiet`: record the visit but don't log it (browser_search logs its own line). */
  async navigate(page: PageLike, url: string, o: { quiet?: boolean } = {}): Promise<void> {
    if (o.quiet) this.quietNext.add(page);
    // The step's own navigation is a fresh start for a tab that was being sent back.
    this.sendBacks.delete(page);
    this.stuck.delete(page);
    try {
      await page.goto(url, NAV_TIMEOUT_MS);
    } finally {
      this.quietNext.delete(page);
    }
  }

  /**
   * An action tool (click, type, select, press) is about to act on this tab. What it does may take the page somewhere, so
   * like the step's own navigation it is a fresh start for the send-back count (ruling T3#2: tool-started navigations reset it).
   */
  startAction(page: PageLike): void {
    this.sendBacks.delete(page);
    this.stuck.delete(page);
  }

  /** Whether a page-started navigation was blocked since the last call (an action tool says so). */
  takeBlocked(): boolean {
    const was = this.blocked;
    this.blocked = false;
    return was;
  }

  /**
   * Whether this tab kept opening non-web addresses and was left on about:blank. The step's next tool on it says
   * KEPT_TRYING_NON_WEB. A navigation of the step's own to a web page makes the tab usable again.
   */
  isStuck(page: PageLike): boolean {
    return this.stuck.has(page);
  }

  /**
   * A dialog in one of the step's tabs: an alert is accepted, anything that asks (confirm, prompt, "Leave site?") is
   * dismissed, so an agent never says yes to the page. The agent is told with its next tool result (takeDialogs).
   */
  private answer(page: PageLike, dialog: DialogLike): void {
    const accept = dialog.type() === 'alert';
    void (accept ? dialog.accept() : dialog.dismiss()).catch(() => {});
    this.dialogs.push({ url: page.url(), text: dialogLine(dialog.type(), dialog.message(), accept) });
  }

  /** The dialogs answered since the last call, each with the address of the page that showed it. */
  takeDialogs(): { url: string; text: string }[] {
    return this.dialogs.splice(0);
  }

  setSnapshot(page: PageLike, text: string): void {
    this.snapshots.set(page, text);
  }

  /**
   * The last snapshot of this tab, while its refs are valid: until the page changes, and until the step's current tab
   * changes (a ref belongs to the tab it was taken on). undefined: the refs are stale, so a tool refuses them.
   */
  snapshotOf(page: PageLike): string | undefined {
    return this.snapshots.get(page);
  }

  private navigated(page: PageLike, url: string): void {
    if (this.ended) return;
    // Refs are valid until the page changes (spec §4.1).
    this.snapshots.delete(page);
    if (!isWebUrl(url)) {
      if (harmless(url)) return;
      this.sendBack(page);
      return;
    }
    const before = this.lastGood.get(page);
    // A fresh start: the page went somewhere new by itself. Our own send-back arriving at the last good page, or the page
    // reloading it, is part of the loop, however long the page waited before sending the tab out again.
    if (!this.returning.has(page) && url !== before) {
      this.sendBacks.delete(page);
      this.stuck.delete(page);
    }
    this.lastGood.set(page, url);
    // Only the fragment changed (a carousel, an anchor link): the same page, not a visit.
    if (before !== undefined && before !== url && withoutHash(before) === withoutHash(url)) {
      this.quietNext.delete(page);
      return;
    }
    const shown = loggedUrl(url);
    this.hooks.record(shown);
    const quiet = this.quietNext.delete(page);
    if (this.logged.get(page) === shown) return;
    this.logged.set(page, shown);
    if (!quiet) this.hooks.emit({ type: 'browser', text: openedLine(shown) });
  }

  /** A page sent its tab to a non-web address (spec §4.3): back to where it was, a few times, then to about:blank. */
  private sendBack(page: PageLike): void {
    this.blocked = true;
    // In a row: no fresh start (a tool's navigation, or a page going somewhere new) since the last send-back.
    const count = (this.sendBacks.get(page) ?? 0) + 1;
    this.sendBacks.set(page, count);
    const giveUp = count > MAX_SEND_BACKS;
    if (giveUp) this.stuck.add(page);
    this.returning.set(page, (this.returning.get(page) ?? 0) + 1);
    const target = giveUp ? undefined : this.lastGood.get(page);
    void page
      .goto(target ?? 'about:blank', NAV_TIMEOUT_MS)
      .catch(() => {})
      .finally(() => {
        const left = (this.returning.get(page) ?? 1) - 1;
        if (left > 0) this.returning.set(page, left);
        else this.returning.delete(page);
      });
  }

  /** The step ended (spec §3.2): `succeeded` closes its tabs; any other end leaves them for the user. Idempotent. */
  async end(status: EndStatus): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    const pages = this.pages();
    // Kept tabs are ordinary tabs: uploads work again, and nothing of ours listens to them or holds this step alive.
    for (const undo of this.detach.values()) for (const fn of undo) fn();
    this.detach.clear();
    this.session.forget(this, this.open);
    this.open = [];
    this.currentPage = undefined;
    for (const map of [this.logged, this.lastGood, this.snapshots, this.sendBacks]) map.clear();
    this.quietNext.clear();
    this.dialogs = [];
    this.returning.clear();
    this.stuck.clear();
    if (status === 'succeeded') await Promise.all(pages.map((p) => p.close().catch(() => {})));
  }
}
