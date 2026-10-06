import { z, type ZodRawShape } from 'zod';
import { BROWSER_CLOSED, EMBEDDED_FRAME, KEPT_TRYING_NON_WEB, allowedActionLine, ONLY_WEB_PAGES, PAGE_CHANGED, RUN_STOPPED, SCREENSHOT_CUT, SCREENSHOT_TOO_LARGE, loggedUrl, searchedLine, untrustedPrefix, type BrowserActionRequest, type NodeEventBody } from '@agent-stream/shared';
import { CLAUDE_IMAGE_MAX_BASE64 } from '../attachedFiles';
import type { AskBrowserAction } from './approval';
import { REF_RE, type PageLike } from './page';
import { NAV_TIMEOUT_MS, type Owner, type StepTabs } from './session';
import { isWebUrl, originOf, siteLabel } from './urls';

/**
 * Claude serves the tools as this in-process MCP server, so the SDK names them mcp__agent_stream_browser__<name>. Not
 * plain `browser`: Claude also loads the project's MCP servers, and one configured under the same name would give tools
 * whose names match the step gate's self-approving set, so they would run without asking.
 */
export const BROWSER_SERVER = 'agent_stream_browser';
/** How the step gate names every browser tool, for every provider (ruling R4). */
export const BROWSER_TOOL_PREFIX = `mcp__${BROWSER_SERVER}__`;
export const READ_PAGE_CHARS = 20_000;
export const OPEN_PREVIEW_CHARS = 3_000;
export const SNAPSHOT_MAX_CHARS = 30_000;
export const INSPECT_MAX_CHARS = 20_000;
/** How long an element action waits for its element. */
export const ACTION_TIMEOUT_MS = 10_000;
export const NO_TAB = 'This step has no open tab. Use browser_open or browser_search first.';
export const staleRef = (ref: string): string => `No element ${ref} on this page now: take a new browser_snapshot.`;
const notARef = (ref: string): string => `"${ref}" isn't a ref from browser_snapshot, such as e12.`;
/** What a tool says when the page didn't answer in time (ruling R9: 30 s). */
const PAGE_TIMEOUT = `The page didn't answer within ${NAV_TIMEOUT_MS / 1000} seconds.`;

export type BrowserImage = { mediaType: 'image/png'; data: string };
export type BrowserReply = { text: string; isError?: boolean; image?: BrowserImage };
/** A browser tool, defined once for every provider (spec §3.3): name, zod shape, handler. */
export type BrowserTool = { name: string; description: string; schema: ZodRawShape; run(input: unknown, signal: AbortSignal): Promise<BrowserReply> };

/** What a step's tools work through: its tabs (undefined after the window closed), the search page, its log. */
export interface StepBrowser {
  readonly owner: Owner;
  tabs(): StepTabs | undefined;
  searchEngine(): string;
  emit(event: NodeEventBody): void;
  /** Pauses until the user presses Done (or Stop); reopens a closed browser on Done (spec §5.3, §5.4). */
  waitForUser(reason: string, signal: AbortSignal): Promise<BrowserReply>;
}
/** `settleMs`: how long an action waits for a tab it opened to show up (tests: 0). */
export type BrowserToolDeps = { step: StepBrowser; ask: AskBrowserAction; settleMs?: number };
/** The card's screenshot is left off above this size (ruling R10). */
export const APPROVAL_SHOT_MAX_BYTES = 400_000;
const ACTION_SETTLE_MS = 250;

/** A snapshot line as the browser writes it: `- <role> "<name>" [attribute] [ref=e12]…`, then its own text after a colon. */
const SNAPSHOT_LINE = /^\s*-\s+([A-Za-z][\w-]*)(?:\s+"((?:[^"\\]|\\.)*)")?((?:\s+\[[^\]]*\])*)/;

/**
 * `button "Easy Apply"`: the role and name of the element a ref names, from the snapshot line whose own attribute list
 * holds the ref. A ref written inside a name, a text or an attribute value (the page's words) never matches, wherever
 * it comes. undefined when no line has it.
 */
export function refLabel(snapshot: string | undefined, ref: string): string | undefined {
  if (!snapshot) return undefined;
  for (const line of snapshot.split('\n')) {
    const m = SNAPSHOT_LINE.exec(line);
    if (!m) continue;
    if (![...m[3].matchAll(/\[([^\]]*)\]/g)].some((attribute) => attribute[1] === `ref=${ref}`)) continue;
    return m[2] !== undefined ? `${m[1]} "${m[2]}"` : m[1];
  }
  return undefined;
}

/** Elements that hold another document: their refs are never acted on, the refs inside them are. */
const EMBEDDING_ROLES = new Set(['iframe', 'frame', 'embed', 'object']);
const UNKNOWN_FRAME = 'a frame that could not be identified';

const failed = (text: string): BrowserReply => ({ text, isError: true });
/** A thrown error as the agent reads it: Playwright's message without its call log (ruling R9). */
export const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e)).split('\nCall log:')[0].trim();
/** Page content, marked as information only (spec §4). */
export const untrusted = (url: string, body: string): string => `${untrustedPrefix(url)}\n\n${body}`;
/** The first `max` characters, without splitting a surrogate pair. */
const head = (text: string, max: number): string => {
  let end = Math.min(text.length, max);
  const code = text.charCodeAt(end - 1);
  if (end < text.length && code >= 0xd800 && code <= 0xdbff) end -= 1;
  return text.slice(0, end);
};
/** At most `max` characters, `…` marking a cut. */
const capped = (text: string, max: number): string => (text.length > max ? `${head(text, max)}…` : text);
/** A number the page reported, for the agent to read: `?` for anything that isn't one (a page can answer with any text). */
const pixels = (v: unknown): string => {
  const n = Number(v);
  return Number.isFinite(n) ? String(Math.round(n)) : '?';
};

/**
 * What a page's own code made fail (a read evaluated in the page): its message may be the page's words, so the reply
 * carries it inside the untrusted wrapper, labelled with the address the read started on (spec §4).
 */
class PageError extends Error {
  constructor(message: string, readonly url: string) {
    super(message);
  }
}
/** Reads from `page` (evaluated in the page, or in a locator of it): a failure other than our timeout is the page's. */
async function fromPage<T>(url: string, work: () => Promise<T>): Promise<T> {
  try {
    return await bounded(work);
  } catch (e) {
    if (e instanceof TimedOut) throw e;
    throw new PageError(errorText(e), url);
  }
}

/** Page work that must not hold the step: it fails with PAGE_TIMEOUT when the page hasn't answered in 30 s (ruling R9). */
class TimedOut extends Error {}
function bounded<T>(work: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimedOut(PAGE_TIMEOUT)), NAV_TIMEOUT_MS);
    // The work may still settle after the timeout: that is no one's unhandled rejection.
    Promise.resolve()
      .then(work)
      .then(resolve, reject)
      .finally(() => clearTimeout(timer));
  });
}

/** A tool whose input is checked with zod first; a throw becomes an error reply. */
export function browserTool<S extends ZodRawShape>(name: string, description: string, schema: S, run: (input: z.infer<z.ZodObject<S>>, signal: AbortSignal) => Promise<BrowserReply>): BrowserTool {
  const parser = z.object(schema);
  return {
    name,
    description,
    schema,
    async run(input, signal) {
      const parsed = parser.safeParse(input ?? {});
      if (!parsed.success) return failed(z.prettifyError(parsed.error));
      if (signal.aborted) return failed(RUN_STOPPED);
      // Stop ends the tool at once; what its page work does after that is dropped.
      let onAbort = () => {};
      const stopped = new Promise<BrowserReply>((resolve) => {
        onAbort = () => resolve(failed(RUN_STOPPED));
        signal.addEventListener('abort', onAbort, { once: true });
      });
      try {
        return await Promise.race([run(parsed.data, signal), stopped]);
      } catch (e) {
        return failed(e instanceof PageError ? untrusted(e.url, errorText(e)) : errorText(e));
      } finally {
        signal.removeEventListener('abort', onAbort);
      }
    },
  };
}

/** The readable text in pages of `size` characters; a surrogate pair is never split. */
export function textPages(text: string, size: number = READ_PAGE_CHARS): string[] {
  if (!text) return [''];
  const pages: string[] = [];
  let i = 0;
  while (i < text.length) {
    let end = Math.min(text.length, i + size);
    const code = text.charCodeAt(end - 1);
    if (end < text.length && code >= 0xd800 && code <= 0xdbff) end -= 1;
    pages.push(text.slice(i, end));
    i = end;
  }
  return pages;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** browser_back's own navigation timeout: a little under the one bound around the whole call, so the browser's message wins. */
const BACK_TIMEOUT_MS = NAV_TIMEOUT_MS - 2_000;

/** The browser tools a Browser step gets (spec §4). Every read is of the step's own current tab. */
export function createBrowserTools(d: BrowserToolDeps): BrowserTool[] {
  const { step } = d;
  const settleMs = d.settleMs ?? ACTION_SETTLE_MS;
  /** A tool of this set: when it fails because the window went away under it, it says so (ruling R12). */
  const tool = <S extends ZodRawShape>(name: string, description: string, schema: S, run: (input: z.infer<z.ZodObject<S>>, signal: AbortSignal) => Promise<BrowserReply>): BrowserTool =>
    browserTool(name, description, schema, async (input, signal) => {
      try {
        return await run(input, signal);
      } catch (e) {
        if (!step.tabs()) return failed(BROWSER_CLOSED);
        throw e;
      }
    });
  /**
   * Runs `fn` on the step's current tab, or says why there is none. `url` is the address the tab showed when the tool
   * started: what the content is labelled with, even if the page moves on while it is read. A tab that kept opening
   * non-web addresses is refused, except for the tools that get the step off it (`stuckOk`).
   */
  const onPage = async (fn: (tabs: StepTabs, page: PageLike, url: string) => Promise<BrowserReply>, o: { stuckOk?: boolean } = {}): Promise<BrowserReply> => {
    const tabs = step.tabs();
    if (!tabs) return failed(BROWSER_CLOSED);
    const page = tabs.current();
    if (!page) return failed(NO_TAB);
    if (!o.stuckOk && tabs.isStuck(page)) return failed(KEPT_TRYING_NON_WEB);
    return fn(tabs, page, page.url());
  };
  const where = async (page: PageLike, url: string = page.url()) => `URL: ${url}\nTitle: ${await bounded(() => page.title())}`;

  /**
   * Origins (scheme, host and port) the user allowed for the rest of this step (spec §4.2 "Allow on this site for this
   * step"). http and https, ports and subdomains are different sites. An address that isn't on the web has no origin, so
   * it is never allowed and never added.
   */
  const allowedOrigins = new Set<string>();
  const NOT_WEB = 'a page that is not on the web';
  /** The element a ref names on the current page now, or why it can't be used: refs are checked before anyone is asked. */
  const target = (tabs: StepTabs, page: PageLike, ref: string): { label: string } | BrowserReply => {
    if (!REF_RE.test(ref)) return failed(notARef(ref));
    const label = refLabel(tabs.snapshotOf(page), ref);
    if (!label) return failed(staleRef(ref));
    // A frame is acted on through the elements inside it; act() also asks the live page.
    return EMBEDDING_ROLES.has(label.split(' ')[0]) ? failed(EMBEDDED_FRAME) : { label };
  };
  /**
   * One action on `page`, the current tab (spec §4.2): ask with the card unless the origin it acts on is allowed for this
   * step, then act only if the tab still shows what the user was asked about (ruling R6: the same page, the same element
   * for its ref, the same origin for a frame's ref). Says when a new tab opened or the page tried to leave the web.
   *
   * The origin is the page's, or for a ref inside an iframe (`f1e2`) the frame's own, as the browser reports it: the card
   * then names both (`accounts.example (inside jobs.example)`) and an allowance for one never covers the other.
   *
   * A key press goes to whatever has focus; its Site is the focused frame's origin as a best guess. No action runs under an
   * allowance while the page has a frame of another origin (see foreignFrames).
   *
   * Limits: the element's role and name come from the agent's last snapshot, so they are the page's words; the card's
   * screenshot is the viewport and doesn't mark the element; `browser_press` goes to whatever has focus, in whichever
   * frame; and Playwright's wait for an element to be ready runs after the last check.
   */
  const act = async (
    tabs: StepTabs,
    page: PageLike,
    url: string,
    signal: AbortSignal,
    a: {
      name: string;
      input: unknown;
      detail: Omit<BrowserActionRequest, 'site' | 'url' | 'title' | 'screenshot'>;
      ref?: { ref: string; label: string };
      perform: (page: PageLike) => Promise<void>;
      done: string;
      /** What the step log says when this ran without a card: `clicked button "Go"`. */
      did: string;
    },
  ): Promise<BrowserReply> => {
    const moved = (): boolean => page.isClosed() || tabs.current() !== page || page.url() !== url || (a.ref !== undefined && refLabel(tabs.snapshotOf(page), a.ref.ref) !== a.ref.label);
    // Where the action lands, from the browser: the frame of the element a ref names, or for a key press the frame that has
    // focus. undefined for the frame URL: can't tell, so the user is asked and nothing is ever allowed.
    const look = async (): Promise<{ frameUrl: string | undefined; embedsFrame: boolean } | undefined> => {
      if (a.ref) return bounded(() => page.resolve(a.ref!.ref, ACTION_TIMEOUT_MS));
      return { frameUrl: await bounded(() => page.focusedFrameUrl()).catch(() => undefined), embedsFrame: false };
    };
    const seen = await look();
    if (!seen) return failed(staleRef(a.ref!.ref));
    if (seen.embedsFrame) return failed(EMBEDDED_FRAME);
    const origin = originOf(seen.frameUrl ?? '');
    const topSite = siteLabel(url);
    const site = seen.frameUrl !== undefined && origin !== '' && origin === originOf(url) ? topSite : `${seen.frameUrl === undefined ? UNKNOWN_FRAME : siteLabel(seen.frameUrl) || NOT_WEB} (inside ${topSite || NOT_WEB})`;
    // The one rule for every action: a site allowance covers it only while the page has no attached frame of another
    // origin, and none whose origin can't be read. A page can steer a click, a key or typed text into a frame (a focus
    // handler, an overlay), so with such a frame there the user always sees the card. Checked when the allowance would be
    // used and again right before acting.
    const foreignFrames = (): Promise<boolean> =>
      bounded(() => page.frameUrls()).then(
        (urls) => urls.some((u) => originOf(u) === '' || originOf(u) !== originOf(url)),
        () => true,
      );
    const askUser = async (): Promise<BrowserReply | undefined> => {
      // Whether the page the card shows has such a frame: one that appears while the user decides was never seen.
      const framedBefore = await foreignFrames();
      // Under Allow all for this step the card is never shown: no screenshot is taken for it.
      const shot = d.ask.allowedAll?.() ? undefined : (await bounded(() => page.screenshot({ fullPage: false, type: 'jpeg' })).catch(() => undefined))?.data;
      const action: BrowserActionRequest = { site, url, title: await bounded(() => page.title()), ...a.detail, ...(shot && shot.length <= APPROVAL_SHOT_MAX_BYTES && { screenshot: shot.toString('base64') }) };
      const decision = await d.ask({ toolName: a.name, input: a.input, action, signal });
      if (!decision.allow) return failed(decision.reason);
      // Recorded as asked, even where it can't be used now (the page has a foreign frame): it covers this origin on pages without one.
      if (decision.site && origin) allowedOrigins.add(origin);
      // The user took their time: the window may have closed or the page moved on (a reload gives the refs to other
      // elements), the element may have become a frame, and its frame (or the focus) may have gone elsewhere.
      if (!step.tabs()) return failed(BROWSER_CLOSED);
      if (moved()) return failed(PAGE_CHANGED);
      const now = await look();
      if (!now) return failed(staleRef(a.ref!.ref));
      if (now.embedsFrame) return failed(EMBEDDED_FRAME);
      if (originOf(now.frameUrl ?? '') !== origin) return failed(PAGE_CHANGED);
      // A frame of another origin that appeared under the card could catch the approved click, key or text (ruling T5).
      if (!framedBefore && (await foreignFrames())) return failed(PAGE_CHANGED);
      return undefined;
    };
    const covered = origin !== '' && allowedOrigins.has(origin);
    let asked = false;
    if (!covered || (await foreignFrames())) {
      const refused = await askUser();
      if (refused) return refused;
      asked = true;
    }
    // Right before acting: a frame that appeared since turns an allowance-covered action into a card. An action the user
    // already answered was checked for new frames when they answered (askUser).
    if (!asked && (await foreignFrames())) {
      const refused = await askUser();
      if (refused) return refused;
      asked = true;
    }
    if (!step.tabs()) return failed(BROWSER_CLOSED);
    if (moved()) return failed(PAGE_CHANGED);
    // An action that needed no card leaves its line: the log shows what ran without asking.
    if (!asked) step.emit({ type: 'browser', text: allowedActionLine(a.did, origin) });
    // What the action does may take the page somewhere: a tool-started navigation, a fresh start for the send-back count.
    tabs.startAction(page);
    tabs.takeBlocked();
    await fromPage(url, () => a.perform(page));
    if (settleMs) await new Promise((resolve) => setTimeout(resolve, settleMs));
    const notes: string[] = [];
    if (tabs.takeBlocked()) notes.push(ONLY_WEB_PAGES);
    const now = tabs.current() ?? page;
    if (now !== page) notes.push(`A new tab opened and is now the current one: ${now.url()}`);
    return { text: untrusted(now.url(), [a.done, ...notes, `Now on: ${await bounded(() => now.title())} — ${now.url()}`].join('\n')) };
  };

  /** Every tool's result also says what dialogs the step's tabs showed since the last one, as page content. */
  const withDialogs = (t: BrowserTool): BrowserTool => ({
    ...t,
    async run(input, signal) {
      const reply = await t.run(input, signal);
      const dialogs = step.tabs()?.takeDialogs() ?? [];
      return dialogs.length ? { ...reply, text: [reply.text, ...dialogs.map((x) => untrusted(x.url, x.text))].join('\n\n') } : reply;
    },
  });

  return [
    tool(
      'browser_search',
      "Search the web in the Agent Stream browser, which has the user's logins. Opens the search results page in this step's tab and returns its text.",
      { query: z.string().min(1).max(500) },
      async ({ query }) => {
        const tabs = step.tabs();
        if (!tabs) return failed(BROWSER_CLOSED);
        const url = `${step.searchEngine()}${encodeURIComponent(query)}`;
        if (!isWebUrl(url)) return failed(ONLY_WEB_PAGES);
        const page = await bounded(() => tabs.ensureTab());
        step.emit({ type: 'browser', text: searchedLine(loggedUrl(query)) });
        await tabs.navigate(page, url, { quiet: true });
        const at = page.url();
        const pages = textPages(await fromPage(at, () => page.text()));
        if (tabs.isStuck(page)) return failed(KEPT_TRYING_NON_WEB);
        return { text: untrusted(at, `${await where(page, at)}\npage 1 of ${pages.length}\n\n${pages[0]}`) };
      },
    ),
    tool(
      'browser_open',
      "Open an http or https address in this step's tab of the Agent Stream browser (the user is logged in to sites there). Returns the final URL, the title and the start of the page's text.",
      { url: z.string().min(1).max(4096) },
      async ({ url }) => {
        if (!isWebUrl(url) && url !== 'about:blank') return failed(ONLY_WEB_PAGES);
        const tabs = step.tabs();
        if (!tabs) return failed(BROWSER_CLOSED);
        const page = await bounded(() => tabs.ensureTab());
        await tabs.navigate(page, url);
        const at = page.url();
        const text = await fromPage(at, () => page.text());
        if (tabs.isStuck(page)) return failed(KEPT_TRYING_NON_WEB);
        const count = textPages(text).length;
        const more = text.length > OPEN_PREVIEW_CHARS ? `\n\n… browser_read gives the whole page (${plural(count, 'page', 'pages')} of about 20,000 characters).` : '';
        return { text: untrusted(at, `${await where(page, at)}\n\n${head(text, OPEN_PREVIEW_CHARS)}${more}`) };
      },
    ),
    tool(
      'browser_read',
      'The current page as readable text, in pages of about 20,000 characters (`page` is 1-based; default 1).',
      { page: z.number().int().min(1).optional() },
      async (a) =>
        onPage(async (_tabs, page, url) => {
          const pages = textPages(await fromPage(url, () => page.text()));
          const n = a.page ?? 1;
          if (n > pages.length) return failed(`This page has ${plural(pages.length, 'page', 'pages')} of text.`);
          return { text: untrusted(url, `page ${n} of ${pages.length}\n\n${pages[n - 1]}`) };
        }),
    ),
    tool(
      'browser_snapshot',
      "The current page's structure: headings, links, buttons and fields, each with a short ref such as e12 for browser_inspect, browser_click, browser_type and browser_select. Refs are valid until the page changes.",
      {},
      async () =>
        onPage(async (tabs, page, url) => {
          const snap = await bounded(() => page.snapshot());
          // The page moved on while it was read: these refs belong to no page the agent can name.
          if (page.url() !== url) return failed('The page changed while the snapshot was taken: take a new browser_snapshot.');
          tabs.setSnapshot(page, snap);
          const shown = snap.length > SNAPSHOT_MAX_CHARS ? `${head(snap, SNAPSHOT_MAX_CHARS)}\n… (cut: the page has more; scroll down and take another snapshot)` : snap;
          return { text: untrusted(url, `${shown}\n\nRefs such as e12 work with browser_inspect, browser_click, browser_type and browser_select until the page changes.`) };
        }),
    ),
    tool(
      'browser_inspect',
      'One element of the current page by its ref from browser_snapshot: its text, attributes and outer HTML (at most 20,000 characters each).',
      { ref: z.string().min(1).max(100) },
      async ({ ref }) =>
        onPage(async (tabs, page, url) => {
          if (!REF_RE.test(ref)) return failed(notARef(ref));
          if (!tabs.snapshotOf(page)) return failed(staleRef(ref));
          const info = await fromPage(url, () => page.inspect(ref, ACTION_TIMEOUT_MS));
          if (!info) return failed(staleRef(ref));
          const attributes = capped(JSON.stringify(info.attributes), INSPECT_MAX_CHARS);
          return { text: untrusted(url, `Text: ${capped(info.text, INSPECT_MAX_CHARS)}\nAttributes: ${attributes}\n\nHTML:\n${capped(info.html, INSPECT_MAX_CHARS)}`) };
        }),
    ),
    tool(
      'browser_screenshot',
      'A PNG screenshot of what the window shows, or of the whole page with fullPage: true.',
      { fullPage: z.boolean().optional() },
      async ({ fullPage }) =>
        onPage(async (_tabs, page, url) => {
          const shot = await bounded(() => page.screenshot({ fullPage: fullPage === true, type: 'png' }));
          const what = fullPage ? 'the whole page' : 'what the window shows';
          const text = untrusted(url, `Screenshot of "${await bounded(() => page.title())}": ${what}.${shot.cut ? `\n\n${SCREENSHOT_CUT}` : ''}`);
          // Claude takes no image whose base64 is over 5 MB (and it is Copilot's limit too): one that size would make every
          // later request of the step fail.
          const data = shot.data.toString('base64');
          if (data.length > CLAUDE_IMAGE_MAX_BASE64) return { text: `${text}\n\n${SCREENSHOT_TOO_LARGE}` };
          return { text, image: { mediaType: 'image/png', data } };
        }),
    ),
    tool(
      'browser_scroll',
      'Scroll the current page up or down, by `amount` pixels (default: most of a window). Returns the new position.',
      { direction: z.enum(['up', 'down']), amount: z.number().int().min(1).max(100_000).optional() },
      async ({ direction, amount }) =>
        onPage(async (_tabs, page, url) => {
          const viewport = Number((await fromPage(url, () => page.scroll(0))).viewport);
          const by = amount ?? Math.round((Number.isFinite(viewport) ? viewport : 1000) * 0.8);
          const pos = await fromPage(url, () => page.scroll(direction === 'down' ? by : -by));
          return { text: `Scrolled ${direction} to ${pixels(pos.y)} of ${pixels(pos.height)} pixels (the window shows ${pixels(pos.viewport)}).` };
        }),
    ),
    tool('browser_back', 'Go back to the previous page in the current tab. Returns its URL and title.', {}, async () =>
      onPage(async (_tabs, page) => {
        // One bound around the whole call; the navigation's own timeout is a little shorter.
        const result = await bounded(async () => ((await page.goBack(BACK_TIMEOUT_MS)) ? await where(page) : undefined));
        if (result === undefined) return failed('There is no earlier page in this tab.');
        return { text: untrusted(page.url(), result) };
      }),
    ),
    tool(
      'browser_tabs',
      "List this step's own tabs (never the user's), with the current one marked.",
      {},
      async () =>
        onPage(
          async (tabs, page, url) => {
            const lines = await Promise.all(tabs.pages().map(async (p, i) => `${i + 1}. ${await bounded(() => p.title())} — ${p.url()}${p === page ? ' (current)' : ''}`));
            return { text: untrusted(url, lines.join('\n')) };
          },
          { stuckOk: true },
        ),
    ),
    tool(
      'browser_switch_tab',
      "Make another of this step's tabs the current one, by its number in browser_tabs.",
      { index: z.number().int().min(1) },
      async ({ index }) =>
        onPage(
          async (tabs) => {
            // The session logs the new current page itself (PF10).
            const page = tabs.switchTo(index);
            if (!page) return failed(`This step has ${plural(tabs.pages().length, 'tab', 'tabs')}.`);
            await bounded(() => page.front());
            return { text: untrusted(page.url(), `Tab ${index}: ${await bounded(() => page.title())} — ${page.url()}`) };
          },
          { stuckOk: true },
        ),
    ),
    // Not `tool(...)`: the wait works with no tabs (a closed browser), and Done reopens it (ruling R12). Stop ends it through browserTool's race.
    browserTool(
      'browser_wait_for_you',
      "Pause this step until the user says they're done in the Agent Stream browser: to log in, solve a CAPTCHA, or do anything only they should do. `reason` tells them what to do. If the browser was closed, it opens again when they're done.",
      { reason: z.string().min(1).max(500) },
      async ({ reason }, signal) => step.waitForUser(reason, signal),
    ),
    tool('browser_click', 'Click an element of the current page by its ref from browser_snapshot. The user is asked first.', { ref: z.string().min(1).max(100) }, async (input, signal) =>
      onPage(async (tabs, page, url) => {
        const t = target(tabs, page, input.ref);
        if (!('label' in t)) return t;
        return act(tabs, page, url, signal, { name: 'browser_click', input, detail: { element: t.label }, ref: { ref: input.ref, label: t.label }, perform: (p) => p.click(input.ref, ACTION_TIMEOUT_MS), done: `Clicked ${t.label}.`, did: `clicked ${t.label}` });
      }),
    ),
    tool(
      'browser_type',
      'Type text into a field of the current page by its ref from browser_snapshot, replacing what is there; submit: true presses Enter after. The user is asked first and sees the exact text.',
      { ref: z.string().min(1).max(100), text: z.string().max(10_000), submit: z.boolean().optional() },
      async (input, signal) =>
        onPage(async (tabs, page, url) => {
          const t = target(tabs, page, input.ref);
          if (!('label' in t)) return t;
          const submit = input.submit === true;
          return act(tabs, page, url, signal, {
            name: 'browser_type',
            input,
            detail: { element: t.label, text: input.text, ...(submit && { submit: true as const }) },
            ref: { ref: input.ref, label: t.label },
            perform: (p) => p.type(input.ref, input.text, submit, ACTION_TIMEOUT_MS),
            done: `Typed into ${t.label}${submit ? ' and pressed Enter' : ''}.`,
            did: `typed into ${t.label}${submit ? ' and pressed Enter' : ''}`,
          });
        }),
    ),
    tool(
      'browser_select',
      'Pick an option, by its label or value, in a list of the current page by its ref from browser_snapshot. The user is asked first.',
      { ref: z.string().min(1).max(100), option: z.string().min(1).max(1000) },
      async (input, signal) =>
        onPage(async (tabs, page, url) => {
          const t = target(tabs, page, input.ref);
          if (!('label' in t)) return t;
          return act(tabs, page, url, signal, {
            name: 'browser_select',
            input,
            detail: { element: t.label, option: input.option },
            ref: { ref: input.ref, label: t.label },
            perform: (p) => p.select(input.ref, input.option, ACTION_TIMEOUT_MS),
            done: `Selected "${input.option}" in ${t.label}.`,
            did: `selected in ${t.label}`,
          });
        }),
    ),
    tool(
      'browser_press',
      'Press a key on the current page, such as Enter, Escape, Tab, ArrowDown or Control+A. The user is asked first.',
      { key: z.string().regex(/^\S{1,40}$/) },
      async (input, signal) => onPage((tabs, page, url) => act(tabs, page, url, signal, { name: 'browser_press', input, detail: { key: input.key }, perform: (p) => p.press(input.key, ACTION_TIMEOUT_MS), done: `Pressed ${input.key}.`, did: `pressed ${input.key}` })),
    ),
  ].map(withDialogs);
}
