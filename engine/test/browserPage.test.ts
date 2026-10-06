import type { BrowserContext, Page } from 'playwright-core';
import { describe, expect, it, vi } from 'vitest';
import { contextFrom } from '../src/browser/page';

/** Just enough of a Playwright page for the wrapper's text(), listeners and file chooser. */
function stubPage(evaluate: () => Promise<unknown>) {
  const listeners = new Map<string, Set<unknown>>();
  const page = {
    evaluate: vi.fn(evaluate),
    on: (event: string, fn: unknown) => void (listeners.get(event) ?? listeners.set(event, new Set()).get(event)!).add(fn),
    off: (event: string, fn: unknown) => void listeners.get(event)?.delete(fn),
    mainFrame: () => ({}),
  } as unknown as Page;
  const count = (event: string) => listeners.get(event)?.size ?? 0;
  const context = { pages: () => [page], on: () => {}, newPage: async () => page, close: async () => {} } as unknown as BrowserContext;
  return { page: contextFrom(context).pages()[0]!, count };
}

describe('contextFrom: text()', () => {
  it('returns the page text', async () => {
    const { page } = stubPage(async () => 'Hello');
    expect(await page.text()).toBe('Hello');
  });

  it('rejects when the page is closed or fails, instead of reporting an empty page', async () => {
    const { page } = stubPage(async () => {
      throw new Error('page.evaluate: Target page, context or browser has been closed');
    });
    await expect(page.text()).rejects.toThrow('has been closed');
  });
});

describe('contextFrom: listeners can be removed', () => {
  it('onNavigated, onClose and blockFileChooser each return what takes them off again', () => {
    const { page, count } = stubPage(async () => '');
    const offNav = page.onNavigated(() => {});
    const offClose = page.onClose(() => {});
    const unblock = page.blockFileChooser();
    expect([count('framenavigated'), count('close'), count('filechooser')]).toEqual([1, 1, 1]);
    offNav();
    offClose();
    unblock();
    expect([count('framenavigated'), count('close'), count('filechooser')]).toEqual([0, 0, 0]);
  });
});
