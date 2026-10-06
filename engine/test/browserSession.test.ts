import { describe, expect, it } from 'vitest';
import type { EndStatus } from '../src/browser/session';
import { sessionSetup as setup, settle, type FakePage } from './browserFakes';

describe('BrowserSession: whose tabs are whose', () => {
  it('gives each step its own new tab; two steps never see each other\'s', async () => {
    const { ctx, session, step } = setup();
    const a = step('n3');
    const b = step('n5');
    const pa = (await a.ensureTab()) as FakePage;
    const pb = (await b.ensureTab()) as FakePage;
    expect(pa).not.toBe(pb);
    expect(a.pages()).toEqual([pa]);
    expect(b.pages()).toEqual([pb]);
    expect(ctx.open).toHaveLength(3); // the window's own first tab is nobody's
    expect(await a.ensureTab()).toBe(pa);
    expect(session.stepIds()).toEqual(['n3', 'n5']);
    expect(session.step({ runId: 'r1', nodeId: 'n3' }, { emit: () => {}, record: () => {} })).toBe(a);
    // Uploads are off in a step's tabs (spec §4.3).
    expect(pa.fileChooserBlocked).toBe(true);
  });

  it('a popup or target=_blank tab of the step joins its tabs and becomes current', async () => {
    const { ctx, step, log, records } = setup();
    const a = step('n3');
    const pa = (await a.ensureTab()) as FakePage;
    await a.navigate(pa, 'https://jobs.example/');
    const popup = await ctx.popup(pa, 'https://jobs.example/apply');
    expect(a.pages()).toEqual([pa, popup]);
    expect(a.current()).toBe(popup);
    expect(popup.fileChooserBlocked).toBe(true);
    expect(log('n3')).toEqual(['🌐 opened https://jobs.example/', '🌐 opened https://jobs.example/apply']);
    expect(records.n3).toEqual(['https://jobs.example/', 'https://jobs.example/apply']);
    expect(a.switchTo(1)).toBe(pa);
    expect(a.current()).toBe(pa);
    expect(a.switchTo(3)).toBeUndefined();
  });

  it('never adopts the user\'s tabs or their popups, nor another step\'s', async () => {
    const { ctx, step, log, records } = setup();
    const a = step('n3');
    const b = step('n5');
    await a.ensureTab();
    const pb = (await b.ensureTab()) as FakePage;
    const mine = await ctx.userTab('https://mail.example/');
    const minePopup = await ctx.popup(mine, 'https://mail.example/compose');
    const theirs = await ctx.popup(pb, 'https://b.example/');
    expect(a.pages()).not.toContain(mine);
    expect(a.pages()).not.toContain(minePopup);
    expect(a.pages()).not.toContain(theirs);
    expect(b.pages()).toEqual([pb, theirs]);
    mine.land('https://mail.example/inbox');
    expect(log('n3')).toEqual([]);
    expect(records.n3).toBeUndefined();
    expect(mine.fileChooserBlocked).toBe(false);
  });
});

describe('BrowserSession: the page log', () => {
  it('logs each new page once and records every visit; a quiet navigation records without logging', async () => {
    const { step, log, records } = setup();
    const a = step('n3');
    const page = await a.ensureTab();
    await a.navigate(page, 'https://a.example/');
    await a.navigate(page, 'https://a.example/');
    await a.navigate(page, 'https://www.google.com/search?q=jobs', { quiet: true });
    await a.navigate(page, 'https://b.example/');
    expect(log('n3')).toEqual(['🌐 opened https://a.example/', '🌐 opened https://b.example/']);
    expect(records.n3).toEqual(['https://a.example/', 'https://a.example/', 'https://www.google.com/search?q=jobs', 'https://b.example/']);
  });

  it('sends a page-started navigation to a non-web address back, and says so once', async () => {
    const { step, records } = setup();
    const a = step('n3');
    const page = (await a.ensureTab()) as FakePage;
    await a.navigate(page, 'https://a.example/');
    const bads = ['data:text/html,hi', 'javascript:alert(1)', 'file:///etc/hosts', 'chrome://settings', 'edge://settings', 'about:version'];
    for (const [i, bad] of bads.entries()) {
      page.land(bad);
      await settle();
      // Sent back 3 times in a row; after that the tab is left on about:blank (a page that keeps trying is stopped).
      expect(page.url()).toBe(i < 3 ? 'https://a.example/' : 'about:blank');
      expect(a.takeBlocked()).toBe(true);
      expect(a.takeBlocked()).toBe(false);
    }
    expect(a.isStuck(page)).toBe(true);
    expect(records.n3?.some((u) => !u.startsWith('https://'))).toBe(false);
  });

  it('leaves about:blank and Chrome\'s error page alone', async () => {
    const { step, records, log } = setup();
    const a = step('n3');
    const page = (await a.ensureTab()) as FakePage;
    page.land('chrome-error://chromewebdata/');
    page.land('about:blank');
    await settle();
    expect(page.url()).toBe('about:blank');
    expect(a.takeBlocked()).toBe(false);
    expect(records.n3).toBeUndefined();
    expect(log('n3')).toEqual([]);
  });

  it('a ref belongs to its tab: the snapshots are all dropped when the current tab changes, whichever way', async () => {
    const { ctx, step } = setup();
    const a = step('n3');
    const first = (await a.ensureTab()) as FakePage;
    const popup = await ctx.popup(first, 'https://p.example/'); // becomes current
    a.setSnapshot(popup, '- link "P" [ref=e1]');
    expect(a.snapshotOf(popup)).toBeDefined();
    a.switchTo(popup === a.current() ? 1 : 2);
    expect(a.current()).toBe(first);
    expect(a.snapshotOf(popup)).toBeUndefined();
    a.setSnapshot(first, '- link "F" [ref=e1]');
    a.switchTo(1); // already current: refs stay
    expect(a.snapshotOf(first)).toBeDefined();
    // The current tab closing falls back to another: no refs carry over.
    a.switchTo(2);
    a.setSnapshot(popup, '- link "P" [ref=e1]');
    await popup.close();
    expect(a.current()).toBe(first);
    expect(a.snapshotOf(first)).toBeUndefined();
    expect(a.snapshotOf(popup)).toBeUndefined();
  });

  it('forgets a page\'s snapshot when the page changes (refs are valid until then)', async () => {
    const { step } = setup();
    const a = step('n3');
    const page = await a.ensureTab();
    a.setSnapshot(page, '- button "Go" [ref=e1]');
    expect(a.snapshotOf(page)).toBe('- button "Go" [ref=e1]');
    await a.navigate(page, 'https://a.example/');
    expect(a.snapshotOf(page)).toBeUndefined();
  });
});

describe('BrowserSession: closing', () => {
  it('a tab the user closes leaves the step\'s tabs; the current one falls back to the newest left', async () => {
    const { ctx, step } = setup();
    const a = step('n3');
    const pa = (await a.ensureTab()) as FakePage;
    const popup = await ctx.popup(pa, 'https://x.example/');
    await popup.close();
    expect(a.pages()).toEqual([pa]);
    expect(a.current()).toBe(pa);
    await pa.close();
    expect(a.current()).toBeUndefined();
    const fresh = await a.ensureTab();
    expect(fresh).not.toBe(pa);
  });

  it.each<[EndStatus, boolean]>([
    ['succeeded', true],
    ['failed', false],
    ['cancelled', false],
    ['interrupted', false],
  ])('a step that ends %s closes its tabs: %s', async (status, closes) => {
    const { ctx, session, step, log } = setup();
    const a = step('n3');
    const page = (await a.ensureTab()) as FakePage;
    await a.navigate(page, 'https://a.example/');
    await a.end(status);
    expect(page.isClosed()).toBe(closes);
    expect(session.stepIds()).toEqual([]);
    // From now on it is an ordinary tab: nothing it does is logged, and its popups join nobody.
    if (!closes) {
      page.land('https://later.example/');
      const popup = await ctx.popup(page, 'https://later.example/popup');
      expect(a.pages()).not.toContain(popup);
      expect(log('n3')).toEqual(['🌐 opened https://a.example/']);
    }
    await a.end('succeeded');
    expect(page.isClosed()).toBe(closes);
  });

  it.each<EndStatus>(['failed', 'cancelled', 'interrupted'])('a step that ends %s leaves its kept tab as an ordinary tab: no listeners, uploads allowed', async (status) => {
    const { step } = setup();
    const a = step('n3');
    const page = (await a.ensureTab()) as FakePage;
    expect(page.fileChooserBlocked).toBe(true);
    expect(page.listenerCount()).toBeGreaterThan(0);
    await a.end(status);
    expect(page.isClosed()).toBe(false);
    expect(page.fileChooserBlocked).toBe(false);
    expect(page.listenerCount()).toBe(0);
  });

  it("answers a dialog in a step's tab (alert accepted; confirm, prompt and leave-page dismissed) and never one in the user's tabs", async () => {
    const { ctx, step } = setup();
    const a = step('n3');
    const page = (await a.ensureTab()) as FakePage;
    await a.navigate(page, 'https://jobs.example/');
    expect(page.showDialog('alert', 'Saved')).toBe('accepted');
    expect(page.showDialog('confirm', 'Delete everything?')).toBe('dismissed');
    expect(page.showDialog('prompt', 'Your name?')).toBe('dismissed');
    expect(page.showDialog('beforeunload', '')).toBe('dismissed');
    expect(a.takeDialogs()).toEqual([
      { url: 'https://jobs.example/', text: 'The page showed an alert dialog: "Saved". Agent Stream accepted it.' },
      { url: 'https://jobs.example/', text: 'The page showed a confirm dialog: "Delete everything?". Agent Stream dismissed it.' },
      { url: 'https://jobs.example/', text: 'The page showed a prompt dialog: "Your name?". Agent Stream dismissed it.' },
      { url: 'https://jobs.example/', text: 'The page showed a beforeunload dialog: "". Agent Stream dismissed it.' },
    ]);
    expect(a.takeDialogs()).toEqual([]);
    // The user's own tab: the dialog is left for them to answer.
    const mine = await ctx.userTab('https://mail.example/');
    expect(mine.showDialog('confirm', 'Leave?')).toBe('open');
    expect(a.takeDialogs()).toEqual([]);
  });

  it.each<EndStatus>(['failed', 'cancelled'])("a tab kept after the step ends %s is the user's: its dialogs are left for them", async (status) => {
    const { step } = setup();
    const a = step('n3');
    const page = (await a.ensureTab()) as FakePage;
    page.showDialog('alert', 'before');
    await a.end(status);
    expect(page.showDialog('confirm', 'Leave?')).toBe('open');
    expect(a.takeDialogs()).toEqual([]);
  });

  it('knows when the window is closed', async () => {
    const { ctx, session, step } = setup();
    const a = step('n3');
    await a.ensureTab();
    let heard = false;
    session.on('closed', () => (heard = true));
    await ctx.close();
    expect(session.closed).toBe(true);
    expect(a.closed).toBe(true);
    expect(heard).toBe(true);
  });
});

describe('BrowserSession: the log names the current page (PF10)', () => {
  it('switching tabs logs where the step is now, and only when the current tab changes', async () => {
    const { ctx, step, log } = setup();
    const a = step('n3');
    const pa = (await a.ensureTab()) as FakePage;
    await a.navigate(pa, 'https://a.example/');
    const popup = await ctx.popup(pa, 'https://a.example/apply');
    expect(log('n3')).toEqual(['🌐 opened https://a.example/', '🌐 opened https://a.example/apply']);
    a.switchTo(1);
    expect(log('n3').at(-1)).toBe('🌐 now on https://a.example/');
    a.switchTo(1);
    a.switchTo(9);
    expect(log('n3')).toHaveLength(3);
    a.switchTo(2);
    expect(log('n3').at(-1)).toBe('🌐 now on https://a.example/apply');
    expect(a.current()).toBe(popup);
  });

  it('a tab with nothing loaded is not announced when the step switches to it or falls back to it', async () => {
    const { ctx, step, log } = setup();
    const b = step('n4');
    const first = (await b.ensureTab()) as FakePage;
    await b.navigate(first, 'https://a.example/');
    const blank = (await ctx.newPage()) as FakePage;
    b.join(blank, false);
    expect(b.switchTo(2)).toBe(blank);
    expect(log('n4')).toEqual(['🌐 opened https://a.example/']);
    await first.close();
    expect(b.current()).toBe(blank);
    expect(log('n4')).toEqual(['🌐 opened https://a.example/']);
  });

  it('ensureTab reuses the one tab and logs nothing', async () => {
    const { step, log } = setup();
    const a = step('n3');
    const first = (await a.ensureTab()) as FakePage;
    await a.navigate(first, 'https://a.example/');
    const second = await a.ensureTab();
    expect(second).toBe(first);
    expect(log('n3')).toEqual(['🌐 opened https://a.example/']);
  });

  it('when the current tab closes, the fallback to the newest remaining one is logged once, when the step next asks', async () => {
    const { ctx, step, log } = setup();
    const a = step('n3');
    const pa = (await a.ensureTab()) as FakePage;
    await a.navigate(pa, 'https://a.example/');
    const popup = await ctx.popup(pa, 'https://a.example/apply');
    await popup.close();
    expect(log('n3')).toHaveLength(2);
    expect(a.current()).toBe(pa);
    expect(log('n3').at(-1)).toBe('🌐 now on https://a.example/');
    expect(a.current()).toBe(pa);
    expect(log('n3')).toHaveLength(3);
    // Closing the last tab leaves nowhere to be: no line.
    await pa.close();
    expect(a.current()).toBeUndefined();
    expect(log('n3')).toHaveLength(3);
  });

  it('a window closing tab by tab logs no fallback lines', async () => {
    const { ctx, step, log } = setup();
    const a = step('n3');
    const pa = (await a.ensureTab()) as FakePage;
    await a.navigate(pa, 'https://a.example/');
    await ctx.popup(pa, 'https://a.example/apply');
    await ctx.popup(pa, 'https://a.example/other');
    a.switchTo(1);
    const before = log('n3').length;
    await ctx.close();
    expect(a.current()).toBeUndefined();
    expect(log('n3')).toHaveLength(before);
  });

  it('closing a tab that is not the current one logs nothing', async () => {
    const { ctx, step, log } = setup();
    const a = step('n3');
    const pa = (await a.ensureTab()) as FakePage;
    await a.navigate(pa, 'https://a.example/');
    await ctx.popup(pa, 'https://a.example/apply');
    a.switchTo(1);
    const before = log('n3').length;
    await a.pages()[1]!.close();
    expect(log('n3')).toHaveLength(before);
  });

  it('a step that ended logs no fallback when its kept tabs close', async () => {
    const { ctx, step, log } = setup();
    const a = step('n3');
    const pa = (await a.ensureTab()) as FakePage;
    await a.navigate(pa, 'https://a.example/');
    const popup = await ctx.popup(pa, 'https://a.example/apply');
    await a.end('failed');
    await popup.close();
    expect(log('n3').filter((l) => l.includes('now on'))).toEqual([]);
  });
});

describe('BrowserSession: blocked schemes that keep coming back', () => {
  /** A page that, each time it loads, sends its tab to a blob: address: at once (a microtask) or once its load is long over (a timer). */
  const trap = (page: FakePage, landings: string[], later: boolean) => {
    page.onNavigated((url) => {
      if (url !== 'https://trap.example/') return;
      landings.push(url);
      const leave = () => page.land('blob:https://trap.example/x');
      if (later) setTimeout(leave, 0);
      else void Promise.resolve().then(leave);
    });
  };

  it.each([false, true])('stops sending a tab back after 3 times in a row and leaves it on about:blank (leaves once the load is over: %s)', async (later) => {
    const { step } = setup();
    const a = step('n3');
    const page = (await a.ensureTab()) as FakePage;
    await a.navigate(page, 'https://trap.example/');
    const landings: string[] = [];
    trap(page, landings, later);
    page.land('blob:https://trap.example/x');
    for (let i = 0; i < 8; i++) await settle();
    expect(landings).toHaveLength(3);
    expect(page.url()).toBe('about:blank');
    expect(a.takeBlocked()).toBe(true);
    expect(a.isStuck(page)).toBe(true);
    // The step's own next navigation is a fresh start.
    await a.navigate(page, 'https://b.example/');
    expect(a.isStuck(page)).toBe(false);
  });

  it('an action tool starting resets the count, like a navigation of the step\'s own', async () => {
    const { step } = setup();
    const a = step('n3');
    const page = (await a.ensureTab()) as FakePage;
    await a.navigate(page, 'https://trap.example/');
    // Two send-backs so far: the page keeps bouncing.
    for (let i = 0; i < 2; i++) {
      page.land('blob:https://trap.example/x');
      await settle();
    }
    expect(page.url()).toBe('https://trap.example/');
    a.startAction(page);
    const landings: string[] = [];
    trap(page, landings, false);
    page.land('blob:https://trap.example/x');
    for (let i = 0; i < 8; i++) await settle();
    // A fresh count: three more send-backs before the tab is left on about:blank (without the reset: one).
    expect(landings).toHaveLength(3);
    expect(page.url()).toBe('about:blank');
    expect(a.isStuck(page)).toBe(true);
    // An action on a tab that is not stuck leaves it usable.
    await a.navigate(page, 'https://b.example/');
    a.startAction(page);
    expect(a.isStuck(page)).toBe(false);
  });

  it('a page that goes somewhere new by itself resets the count', async () => {
    const { step } = setup();
    const a = step('n3');
    const page = (await a.ensureTab()) as FakePage;
    await a.navigate(page, 'https://a.example/');
    for (let round = 0; round < 3; round++) {
      page.land('data:text/html,1');
      page.land('data:text/html,2');
      await settle();
      expect(page.url()).toBe(round === 0 ? 'https://a.example/' : `https://c${round - 1}.example/`);
      page.land(`https://c${round}.example/`);
      page.land('data:text/html,3');
      await settle();
      expect(page.url()).toBe(`https://c${round}.example/`);
      expect(a.isStuck(page)).toBe(false);
    }
  });

  it('a good navigation in between resets the count', async () => {
    const { step } = setup();
    const a = step('n3');
    const page = (await a.ensureTab()) as FakePage;
    for (let i = 0; i < 5; i++) {
      await a.navigate(page, 'https://a.example/');
      page.land('data:text/html,hi');
      await settle();
      expect(page.url()).toBe('https://a.example/');
      expect(a.isStuck(page)).toBe(false);
    }
  });

  it('with no good page to go back to, the tab goes to about:blank', async () => {
    const { ctx, step, records } = setup();
    const a = step('n3');
    const pa = (await a.ensureTab()) as FakePage;
    const popup = await ctx.popup(pa, 'data:text/html,hi');
    await settle();
    expect(a.pages()).toContain(popup);
    expect(popup.url()).toBe('about:blank');
    expect(a.takeBlocked()).toBe(true);
    expect(a.isStuck(popup)).toBe(false);
    expect(records.n3).toBeUndefined();
  });
});

describe('BrowserSession: an ended step and parallel tool calls', () => {
  it('after end, ensureTab and switchTo fail with The browser was closed. and open nothing', async () => {
    const { ctx, step } = setup();
    const a = step('n3');
    await a.ensureTab();
    await a.end('failed');
    const tabs = ctx.open.length;
    await expect(a.ensureTab()).rejects.toThrow('The browser was closed.');
    expect(() => a.switchTo(1)).toThrow('The browser was closed.');
    expect(ctx.open).toHaveLength(tabs);
  });

  it('a step that ends while its tab is being opened does not leave an ownerless tab', async () => {
    const { ctx, step } = setup();
    const a = step('n3');
    const pending = a.ensureTab();
    const outcome = expect(pending).rejects.toThrow('The browser was closed.');
    await a.end('failed');
    await outcome;
    expect(ctx.open).toHaveLength(1);
  });

  it('two parallel ensureTab calls share one new tab', async () => {
    const { ctx, step } = setup();
    const a = step('n3');
    const [x, y] = await Promise.all([a.ensureTab(), a.ensureTab()]);
    expect(x).toBe(y);
    expect(a.pages()).toEqual([x]);
    expect(ctx.open).toHaveLength(2);
  });

  it('ensureTab fails once the window is closed', async () => {
    const { ctx, step } = setup();
    const a = step('n3');
    await ctx.close();
    await expect(a.ensureTab()).rejects.toThrow('The browser was closed.');
  });
});

describe('BrowserSession: what a visit is', () => {
  it('a change to the hash only is not a visit; pushState to a new path is', async () => {
    const { step, log, records } = setup();
    const a = step('n3');
    const page = (await a.ensureTab()) as FakePage;
    await a.navigate(page, 'https://a.example/page');
    page.land('https://a.example/page#slide-2');
    page.land('https://a.example/page#slide-3');
    expect(log('n3')).toEqual(['🌐 opened https://a.example/page']);
    expect(records.n3).toEqual(['https://a.example/page']);
    page.land('https://a.example/page/two');
    expect(log('n3')).toEqual(['🌐 opened https://a.example/page', '🌐 opened https://a.example/page/two']);
    expect(records.n3).toEqual(['https://a.example/page', 'https://a.example/page/two']);
  });

  it('logs and records a URL without its username, password and fragment', async () => {
    const { ctx, step, log, records } = setup();
    const a = step('n3');
    const page = (await a.ensureTab()) as FakePage;
    await a.navigate(page, 'https://user:secret@a.example/cb?x=1#access_token=abc');
    const popup = await ctx.popup(page, 'https://b.example/#id_token=zzz');
    await a.switchTo(1);
    expect(log('n3')).toEqual(['🌐 opened https://a.example/cb?x=1', '🌐 opened https://b.example/', '🌐 now on https://a.example/cb?x=1']);
    expect(records.n3).toEqual(['https://a.example/cb?x=1', 'https://b.example/']);
    expect(popup.url()).toBe('https://b.example/#id_token=zzz');
  });
});
