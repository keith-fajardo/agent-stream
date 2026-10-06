import { DEFAULT_SEARCH_ENGINE, USER_DONE, type NodeEventBody } from '@agent-stream/shared';
import type { ContextLike, DialogLike, ElementInfo, PageLike, ScrollPosition, Shot } from '../src/browser/page';
import type { AskBrowserAction } from '../src/browser/approval';
import { BrowserSession } from '../src/browser/session';
import { createBrowserTools, type BrowserReply, type StepBrowser } from '../src/browser/tools';

/** What a fake URL shows: its title, readable text, snapshot, and the elements its refs name. */
/**
 * `frames`: for a ref inside an iframe, the URL of that frame (a ref with no entry is in the page's own frame). `embeds`:
 * refs of elements that hold a frame (iframe, embed, object). `detached`: refs whose frame is gone. `focus`: the URL of the
 * frame that has focus (default: the page's); `focusUnknown`: the focused frame can't be worked out. `subframes`: the URLs
 * of the frames attached to the page besides its own.
 */
export type FakeSite = { title?: string; text?: string; snapshot?: string; elements?: Record<string, ElementInfo>; frames?: Record<string, string>; embeds?: string[]; detached?: string[]; focus?: string; focusUnknown?: boolean; subframes?: string[]; screenshotBytes?: number; screenshotCut?: boolean };

/** Lets queued callbacks (a popup's adoption, which awaits its opener) run. */
export const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** A tab: no browser, no network. `land` is a navigation the page starts itself (a link, a redirect, a script). */
export class FakePage implements PageLike {
  current = 'about:blank';
  history: string[] = [];
  openerPage: FakePage | null = null;
  actions: string[] = [];
  fileChooserBlocked = false;
  frameUrlCalls = 0;
  scrollY = 0;
  content?: string;
  private closedFlag = false;
  private navigatedFns: ((url: string) => void)[] = [];
  private closeFns: (() => void)[] = [];
  private dialogFns: ((dialog: DialogLike) => void)[] = [];

  constructor(readonly ctx: FakeContext) {}

  private site(): FakeSite {
    return this.ctx.sites[this.current] ?? {};
  }
  private need(ref: string): void {
    if (!this.site().elements?.[ref]) throw new Error(`locator.click: Timeout 10000ms exceeded.\nCall log:\n  - waiting for locator('aria-ref=${ref}')`);
  }
  private async did(action: string): Promise<void> {
    this.actions.push(action);
    await this.ctx.onAction?.(this, action);
  }

  url(): string {
    return this.current;
  }
  async title(): Promise<string> {
    return this.site().title ?? '';
  }
  async goto(url: string): Promise<void> {
    const failure = this.ctx.failures[url];
    if (failure) throw new Error(failure);
    this.history.push(this.current);
    this.land(url);
  }
  land(url: string): void {
    this.current = url;
    for (const fn of [...this.navigatedFns]) fn(url);
  }
  async goBack(): Promise<boolean> {
    const prev = this.history.pop();
    if (prev === undefined || prev === 'about:blank') return false;
    this.land(prev);
    return true;
  }
  async text(): Promise<string> {
    if (this.closedFlag) throw new Error('page.evaluate: Target page, context or browser has been closed');
    return this.site().text ?? '';
  }
  async snapshot(): Promise<string> {
    this.ctx.snapshots++;
    return this.site().snapshot ?? '';
  }
  async inspect(ref: string): Promise<ElementInfo | undefined> {
    return this.site().elements?.[ref];
  }
  async resolve(ref: string): Promise<{ frameUrl: string; embedsFrame: boolean } | undefined> {
    const site = this.site();
    if (!site.elements?.[ref] || site.detached?.includes(ref)) return undefined;
    return { frameUrl: site.frames?.[ref] ?? this.current, embedsFrame: site.embeds?.includes(ref) ?? false };
  }
  /** Every frame the site says it has: the listed ones, the frames its refs live in, and the one that has focus. */
  async frameUrls(): Promise<string[]> {
    this.frameUrlCalls++;
    this.ctx.onFrameUrls?.(this, this.frameUrlCalls);
    const site = this.site();
    return [...new Set([...(site.subframes ?? []), ...Object.values(site.frames ?? {}), ...(site.focus && site.focus !== this.current ? [site.focus] : [])])];
  }
  async focusedFrameUrl(): Promise<string | undefined> {
    return this.site().focusUnknown ? undefined : (this.site().focus ?? this.current);
  }
  async click(ref: string): Promise<void> {
    this.need(ref);
    await this.did(`click ${ref}`);
  }
  async type(ref: string, text: string, submit: boolean): Promise<void> {
    this.need(ref);
    await this.did(`type ${ref} ${text}${submit ? ' +Enter' : ''}`);
  }
  async select(ref: string, option: string): Promise<void> {
    this.need(ref);
    await this.did(`select ${ref} ${option}`);
  }
  async press(key: string): Promise<void> {
    await this.did(`press ${key}`);
  }
  async screenshot(o: { fullPage: boolean; type: 'png' | 'jpeg' }): Promise<Shot> {
    this.actions.push(`screenshot ${o.type}${o.fullPage ? ' full' : ''}`);
    // A site can ask for a screenshot of a given size (one over the image limit), or one cut at the height limit.
    const size = this.site().screenshotBytes;
    return { data: size === undefined ? Buffer.from(`${o.type}:${this.current}`) : Buffer.alloc(size, 1), cut: o.fullPage && this.site().screenshotCut === true };
  }
  async scroll(dy: number): Promise<ScrollPosition> {
    this.scrollY = Math.min(4000, Math.max(0, this.scrollY + dy));
    return { y: this.scrollY, height: 5000, viewport: 1000 };
  }
  async front(): Promise<void> {
    this.ctx.front = this;
  }
  async setContent(html: string): Promise<void> {
    this.content = html;
  }
  async close(): Promise<void> {
    if (this.closedFlag) return;
    this.closedFlag = true;
    this.ctx.open = this.ctx.open.filter((p) => p !== this);
    for (const fn of this.closeFns) fn();
  }
  isClosed(): boolean {
    return this.closedFlag;
  }
  async opener(): Promise<PageLike | null> {
    return this.openerPage;
  }
  onNavigated(fn: (url: string) => void): () => void {
    this.navigatedFns.push(fn);
    return () => void (this.navigatedFns = this.navigatedFns.filter((f) => f !== fn));
  }
  onClose(fn: () => void): () => void {
    this.closeFns.push(fn);
    return () => void (this.closeFns = this.closeFns.filter((f) => f !== fn));
  }
  blockFileChooser(): () => void {
    this.fileChooserBlocked = true;
    return () => void (this.fileChooserBlocked = false);
  }
  onDialog(fn: (dialog: DialogLike) => void): () => void {
    this.dialogFns.push(fn);
    return () => void (this.dialogFns = this.dialogFns.filter((f) => f !== fn));
  }
  /** The page shows a JavaScript dialog: what was done with it, or `open` when nobody answered it (Chrome shows it to the user). */
  showDialog(type: string, message: string): 'accepted' | 'dismissed' | 'open' {
    let outcome: 'accepted' | 'dismissed' | 'open' = 'open';
    const dialog: DialogLike = { type: () => type, message: () => message, accept: async () => void (outcome = 'accepted'), dismiss: async () => void (outcome = 'dismissed') };
    for (const fn of [...this.dialogFns]) fn(dialog);
    return outcome;
  }
  /** How many listeners are attached to this tab (navigation, close and dialogs): 0 for an ordinary tab nobody watches. */
  listenerCount(): number {
    return this.navigatedFns.length + this.closeFns.length + this.dialogFns.length;
  }
}

/** A browser window: it starts with one blank tab, as a persistent context does. */
export class FakeContext implements ContextLike {
  open: FakePage[] = [];
  sites: Record<string, FakeSite> = {};
  failures: Record<string, string> = {};
  front?: FakePage;
  snapshots = 0;
  closed = false;
  onAction?: (page: FakePage, action: string) => void | Promise<void>;
  /** Called as a page's frames are listed, with how many times that page has been asked: a frame can appear between two asks. */
  onFrameUrls?: (page: FakePage, call: number) => void;
  private pageFns: ((page: PageLike) => void)[] = [];
  private closeFns: (() => void)[] = [];

  constructor() {
    this.open.push(new FakePage(this));
  }
  private add(page: FakePage): FakePage {
    this.open.push(page);
    for (const fn of this.pageFns) fn(page);
    return page;
  }
  pages(): PageLike[] {
    return [...this.open];
  }
  async newPage(): Promise<PageLike> {
    return this.add(new FakePage(this));
  }
  /** A tab the user opens and browses in themselves. */
  async userTab(url: string): Promise<FakePage> {
    const page = this.add(new FakePage(this));
    page.land(url);
    return page;
  }
  /** A tab `opener` opens (a popup, a target=_blank link); it has loaded before anyone looks at it. */
  async popup(opener: FakePage, url: string): Promise<FakePage> {
    const page = new FakePage(this);
    page.openerPage = opener;
    this.add(page);
    page.land(url);
    await settle();
    return page;
  }
  onPage(fn: (page: PageLike) => void): void {
    this.pageFns.push(fn);
  }
  onClose(fn: () => void): void {
    this.closeFns.push(fn);
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const page of [...this.open]) await page.close();
    for (const fn of this.closeFns) fn();
  }
}

/**
 * A session over a fake window, with a log and a visit record per step id: the setup every browser test shares.
 * `step(id)` starts that step of run r1; `log(id)` is its `browser` log lines.
 */
export function sessionSetup() {
  const ctx = new FakeContext();
  const session = new BrowserSession(ctx);
  const events: Record<string, NodeEventBody[]> = {};
  const records: Record<string, string[]> = {};
  const step = (nodeId: string) =>
    session.step({ runId: 'r1', nodeId }, { emit: (e) => void (events[nodeId] ??= []).push(e), record: (url) => void (records[nodeId] ??= []).push(url) });
  const log = (nodeId: string) => (events[nodeId] ?? []).map((e) => (e.type === 'browser' ? e.text : e.type));
  return { ctx, session, step, events, records, log };
}

/** One Browser step's tools over a fake window: what it logged and recorded, and a way to call each tool by name. */
export function toolSetup(o: { searchEngine?: string; ask?: AskBrowserAction } = {}) {
  const base = sessionSetup();
  const { ctx, session } = base;
  // The step's own log and record, created up front so a test can hold on to them.
  const events: NodeEventBody[] = (base.events.n3 = []);
  const records: string[] = (base.records.n3 = []);
  const tabs = base.step('n3');
  const step: StepBrowser = {
    owner: tabs.owner,
    tabs: () => (tabs.closed ? undefined : tabs),
    searchEngine: () => o.searchEngine ?? DEFAULT_SEARCH_ENGINE,
    emit: (e) => void events.push(e),
    waitForUser: async () => ({ text: USER_DONE }),
  };
  const tools = createBrowserTools({ step, ask: o.ask ?? (async () => ({ allow: false, reason: 'No approvals in this test.' })), settleMs: 0 });
  const call = (name: string, input: unknown = {}, signal: AbortSignal = new AbortController().signal): Promise<BrowserReply> => {
    const tool = tools.find((t) => t.name === name);
    if (!tool) throw new Error(`no tool ${name}`);
    return tool.run(input, signal);
  };
  return { ctx, session, tabs, step, events, records, call, tools, closeWindow: () => ctx.close() };
}
