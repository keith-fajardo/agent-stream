import type { BrowserContext, Frame, Locator, Page } from 'playwright-core';

/** A ref browser_snapshot gives: e12, or f1e12 inside a frame. Checked before it goes into a selector (never other text). */
export const REF_RE = /^(f\d+)?e\d+$/;

export type ElementInfo = { text: string; attributes: Record<string, string>; html: string };
/** A JavaScript dialog a page shows (`alert`, `confirm`, `prompt`, `beforeunload`): Playwright's Dialog, as far as we use it. */
export type DialogLike = { type(): string; message(): string; accept(): Promise<void>; dismiss(): Promise<void> };
export type ScrollPosition = { y: number; height: number; viewport: number };
/** A screenshot, and whether a whole-page one was cut at FULL_PAGE_MAX_PX. */
export type Shot = { data: Buffer; cut: boolean };
/** A whole-page screenshot keeps at most this many CSS pixels down and across: Claude refuses an image over 8,000 on a side. */
export const FULL_PAGE_MAX_PX = 8_000;
/** The height and width of a PNG, from its header. */
const pngSize = (png: Buffer): { width: number; height: number } => ({ width: png.readUInt32BE(16), height: png.readUInt32BE(20) });

/**
 * The slice of a Playwright page the browser tools use. Everything above this seam is tested with fakes
 * (test/browserFakes.ts); `contextFrom` wraps the real thing, and the real-browser suite tests it.
 */
export interface PageLike {
  url(): string;
  title(): Promise<string>;
  goto(url: string, timeoutMs: number): Promise<void>;
  /** false when the tab has no earlier page. */
  goBack(timeoutMs: number): Promise<boolean>;
  /** The page's readable text: the body's innerText. */
  text(): Promise<string>;
  /** The page's structure with refs (`- button "Go" [ref=e12]`). A new snapshot replaces the refs of the last one. */
  snapshot(): Promise<string>;
  /** undefined when the page has no element with this ref now. */
  inspect(ref: string, timeoutMs: number): Promise<ElementInfo | undefined>;
  /**
   * Where the element a ref names lives, as the browser knows it (never from anything the page says): the URL of its
   * frame, and whether it holds a frame itself (iframe, frame, embed, object). undefined when the element isn't there
   * now: its frame went away, moved to another page or navigated.
   */
  resolve(ref: string, timeoutMs: number): Promise<{ frameUrl: string; embedsFrame: boolean } | undefined>;
  /** The URLs of the frames attached to the page besides its own (a detached frame isn't one). */
  frameUrls(): Promise<string[]>;
  /** The URL of the frame that has focus: the deepest frame whose document's active element is a frame. undefined when that can't be worked out. */
  focusedFrameUrl(): Promise<string | undefined>;
  click(ref: string, timeoutMs: number): Promise<void>;
  type(ref: string, text: string, submit: boolean, timeoutMs: number): Promise<void>;
  select(ref: string, option: string, timeoutMs: number): Promise<void>;
  press(key: string, timeoutMs: number): Promise<void>;
  /** In CSS pixels, whatever the screen's density; a whole page is cut at FULL_PAGE_MAX_PX. */
  screenshot(o: { fullPage: boolean; type: 'png' | 'jpeg' }): Promise<Shot>;
  scroll(dy: number): Promise<ScrollPosition>;
  front(): Promise<void>;
  setContent(html: string): Promise<void>;
  close(): Promise<void>;
  isClosed(): boolean;
  opener(): Promise<PageLike | null>;
  /** Main-frame navigations, with the new URL. Returns what takes the listener off again. */
  onNavigated(fn: (url: string) => void): () => void;
  /** Returns what takes the listener off again. */
  onClose(fn: () => void): () => void;
  /** Clicking a file input opens no file dialog in this tab (spec §4.3: uploads are off). Returns what allows it again. */
  blockFileChooser(): () => void;
  /** The tab's JavaScript dialogs, for the listener to answer. Returns what takes the listener off again. */
  onDialog(fn: (dialog: DialogLike) => void): () => void;
}

export interface ContextLike {
  pages(): PageLike[];
  newPage(): Promise<PageLike>;
  /** Every new tab: the session's own, the user's, and popups. */
  onPage(fn: (page: PageLike) => void): void;
  onClose(fn: () => void): void;
  close(): Promise<void>;
}

/** The engine has no DOM types: the element our own read-out code sees, typed by what it uses. */
type ElementView = { innerText?: string; textContent: string | null; attributes: ArrayLike<{ name: string; value: string }>; outerHTML: string };

function wrapPage(p: Page, pageOf: (page: Page) => PageLike): PageLike {
  const element = (ref: string): Locator => {
    if (!REF_RE.test(ref)) throw new Error(`"${ref}" isn't a ref from browser_snapshot, such as e12.`);
    return p.locator(`aria-ref=${ref}`);
  };
  return {
    url: () => p.url(),
    title: () => p.title(),
    goto: async (url, timeout) => {
      await p.goto(url, { timeout, waitUntil: 'domcontentloaded' });
    },
    goBack: async (timeout) => (await p.goBack({ timeout, waitUntil: 'domcontentloaded' })) !== null,
    // Only a page with no body is empty; a closed page or a navigation that destroyed the context is an error the tool reports.
    text: () => p.evaluate(() => (globalThis as unknown as { document: { body: { innerText: string } | null } }).document.body?.innerText ?? ''),
    // Only `ai` mode, and only here: any other ariaSnapshot call would replace the refs the agent holds.
    snapshot: () => p.ariaSnapshot({ mode: 'ai', timeout: 10_000 }),
    inspect: async (ref, timeout) => {
      const loc = element(ref);
      if ((await loc.count()) === 0) return undefined;
      // Our own read-out, not the agent's: the agent never gets to run code in the page (spec §4.3).
      return loc.evaluate(
        (el: ElementView) => ({ text: el.innerText ?? el.textContent ?? '', attributes: Object.fromEntries(Array.from(el.attributes, (a) => [a.name, a.value])), html: el.outerHTML }),
        undefined,
        { timeout },
      );
    },
    // From the browser's own record of the element's frame (ownerFrame, contentFrame), never from what the page says.
    resolve: async (ref, timeout) => {
      const loc = element(ref);
      // No wait for an element that isn't there: a ref whose frame navigated or went away is stale at once.
      if ((await loc.count().catch(() => 0)) === 0) return undefined;
      const handle = await loc.elementHandle({ timeout: Math.min(timeout, 2_000) }).catch(() => null);
      if (!handle) return undefined;
      try {
        const frame = await handle.ownerFrame();
        if (!frame || frame.isDetached() || frame.page() !== p) return undefined;
        // An embed or object can hold a document too, and the page could lie about its own tag name: ask the browser first.
        const embedsFrame = (await handle.contentFrame()) !== null || (await handle.evaluate((el: { tagName: string }) => ['IFRAME', 'FRAME', 'EMBED', 'OBJECT'].includes(String(el.tagName).toUpperCase())).catch(() => true));
        return { frameUrl: frame.url(), embedsFrame };
      } catch {
        return undefined;
      } finally {
        await handle.dispose().catch(() => {});
      }
    },
    frameUrls: async () =>
      p
        .frames()
        .filter((f) => f !== p.mainFrame() && !f.isDetached())
        .map((f) => f.url()),
    // Our own walk down through the frames that hold focus; a page's script can't pick the answer for the browser's frames,
    // but it can answer for `activeElement`, so anything odd is "can't tell" and the user is asked.
    focusedFrameUrl: async () => {
      try {
        let frame = p.mainFrame();
        for (let depth = 0; depth < 10; depth++) {
          const active = await frame.evaluateHandle(() => (globalThis as unknown as { document: { activeElement: unknown } }).document.activeElement);
          const el = active.asElement();
          const child = el ? await el.contentFrame() : null;
          await active.dispose().catch(() => {});
          if (!child) return frame.url();
          frame = child;
        }
        return undefined;
      } catch {
        return undefined;
      }
    },
    click: (ref, timeout) => element(ref).click({ timeout }),
    type: async (ref, text, submit, timeout) => {
      const loc = element(ref);
      await loc.fill(text, { timeout });
      if (submit) await loc.press('Enter', { timeout });
    },
    select: async (ref, option, timeout) => {
      await element(ref).selectOption(option, { timeout });
    },
    press: (key) => p.keyboard.press(key),
    // CSS pixels: on a 2x screen the device scale would double every side. A whole page is clipped to the limit (Playwright
    // trims the clip to the page's own size, measured by the browser, not by the page); an image that reaches it was cut.
    screenshot: async ({ fullPage, type }) => {
      const data = await p.screenshot({
        fullPage,
        type,
        scale: 'css',
        ...(type === 'jpeg' && { quality: 50 }),
        ...(fullPage && { clip: { x: 0, y: 0, width: FULL_PAGE_MAX_PX, height: FULL_PAGE_MAX_PX } }),
        timeout: 15_000,
      });
      const size = fullPage && type === 'png' ? pngSize(data) : undefined;
      return { data, cut: size !== undefined && (size.height >= FULL_PAGE_MAX_PX || size.width >= FULL_PAGE_MAX_PX) };
    },
    scroll: async (dy) => {
      await p.evaluate((by: number) => (globalThis as unknown as { scrollBy(x: number, y: number): void }).scrollBy(0, by), dy);
      return p.evaluate(() => {
        const w = globalThis as unknown as { scrollY: number; innerHeight: number; document: { documentElement: { scrollHeight: number } } };
        return { y: Math.round(w.scrollY), height: w.document.documentElement.scrollHeight, viewport: w.innerHeight };
      });
    },
    front: () => p.bringToFront(),
    setContent: (html) => p.setContent(html),
    close: () => p.close(),
    isClosed: () => p.isClosed(),
    opener: async () => {
      const o = await p.opener();
      return o ? pageOf(o) : null;
    },
    onNavigated: (fn) => {
      const listener = (frame: Frame) => {
        if (frame === p.mainFrame()) fn(frame.url());
      };
      p.on('framenavigated', listener);
      return () => void p.off('framenavigated', listener);
    },
    onClose: (fn) => {
      const listener = () => fn();
      p.on('close', listener);
      return () => void p.off('close', listener);
    },
    // With a listener, Playwright takes the file chooser and no dialog opens; we never set files.
    blockFileChooser: () => {
      const listener = () => {};
      p.on('filechooser', listener);
      return () => void p.off('filechooser', listener);
    },
    onDialog: (fn) => {
      const listener = (dialog: DialogLike) => fn(dialog);
      p.on('dialog', listener);
      return () => void p.off('dialog', listener);
    },
  };
}

/** The real browser context behind the seam. One wrapper per Playwright page, so pages compare by identity. */
export function contextFrom(context: BrowserContext): ContextLike {
  // With no dialog listener at all, Playwright answers every dialog itself (dismisses alert, confirm and prompt, accepts
  // "Leave site?"), in the user's own tabs too. This one does nothing, so Chrome shows the dialog and the user answers it;
  // a step's tabs answer theirs with a listener of their own (StepTabs).
  context.on('dialog', () => {});
  const wrapped = new WeakMap<Page, PageLike>();
  const pageOf = (p: Page): PageLike => {
    let page = wrapped.get(p);
    if (!page) wrapped.set(p, (page = wrapPage(p, pageOf)));
    return page;
  };
  return {
    pages: () => context.pages().map(pageOf),
    newPage: async () => pageOf(await context.newPage()),
    onPage: (fn) => {
      context.on('page', (p) => fn(pageOf(p)));
    },
    onClose: (fn) => {
      context.on('close', () => fn());
    },
    close: () => context.close(),
  };
}
