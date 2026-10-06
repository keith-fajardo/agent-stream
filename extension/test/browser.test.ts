import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { createApp, type AppDeps, type BrowserService, type BrowserWait } from '@agent-stream/engine';
import { CLEAR_BROWSER_QUESTION, START_PAGE_TEXT } from '@agent-stream/shared';
import { browserCommands, browserStatusText, notifyWait, readBrowserSettings, startPageHtml, type BrowserUi } from '../src/browser';
import { EngineManager } from '../src/engines';
import { noGit, signedIn } from './helpers';

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  contributes: { commands: { command: string; title: string; category: string }[]; configuration: { properties: Record<string, { type: string; default: unknown; description: string; scope?: string }> } };
};

function fakeBrowser(o: { waiting?: BrowserWait[] } = {}) {
  return {
    show: vi.fn(async () => ({ ok: true as const })),
    clearData: vi.fn(async () => ({ ok: true as const })),
    done: vi.fn(() => true),
    waiting: vi.fn(() => o.waiting ?? []),
  };
}
function ui(answers: (string | undefined)[] = [], confirm = true) {
  const asked: { message: string; actions: string[] }[] = [];
  const u: BrowserUi & { asked: typeof asked; errors: string[] } = {
    asked,
    errors: [],
    info: (message, ...actions) => {
      asked.push({ message, actions });
      return Promise.resolve(answers.shift());
    },
    error: (message) => void u.errors.push(message),
    confirm: vi.fn(async () => confirm),
  };
  return u;
}
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('the browser commands and settings', () => {
  it('contributes Agent Stream: Open Browser, Clear Browser Data and the two settings', () => {
    const commands = manifest.contributes.commands.filter((c) => c.command.startsWith('agentStream.') && /Browser/.test(c.title));
    expect(commands).toEqual([
      { command: 'agentStream.openBrowser', title: 'Open Browser', category: 'Agent Stream' },
      { command: 'agentStream.clearBrowserData', title: 'Clear Browser Data', category: 'Agent Stream' },
    ]);
    const props = manifest.contributes.configuration.properties;
    expect(props['agentStream.browser.path']).toMatchObject({ type: 'string', default: '' });
    // Machine scope: a workspace's settings file can't point it at an executable that would get the logged-in profile.
    expect(props['agentStream.browser.path'].scope).toBe('machine');
    expect(props['agentStream.browser.searchEngine']).toMatchObject({ type: 'string', default: 'https://www.google.com/search?q=' });
  });

  it('reads the settings, trimmed; a value that isn\'t text reads as empty', () => {
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValueOnce({ get: (key: string) => (key === 'browser.path' ? '  /opt/chrome  ' : 42) } as never);
    expect(readBrowserSettings()).toEqual({ path: '/opt/chrome', searchEngine: '' });
  });

  it('the start page says what the browser is for, escaped', () => {
    const html = startPageHtml();
    expect(html).toContain('<title>Agent Stream browser</title>');
    expect(html).toContain(START_PAGE_TEXT.replace(/'/g, '&#39;'));
  });

  it('Open Browser shows (or opens) it, and says why it couldn\'t', async () => {
    const browser = fakeBrowser();
    const u = ui();
    await browserCommands({ browser: browser as unknown as BrowserService, ui: u }).openBrowser();
    expect(browser.show).toHaveBeenCalledWith();
    browser.show.mockResolvedValueOnce({ ok: false, error: 'No Chrome, Edge or Chromium found: install one or set agentStream.browser.path.' } as never);
    await browserCommands({ browser: browser as unknown as BrowserService, ui: u }).openBrowser();
    expect(u.errors).toEqual(['No Chrome, Edge or Chromium found: install one or set agentStream.browser.path.']);
  });

  it('Clear Browser Data asks first, and deletes only on Delete', async () => {
    const browser = fakeBrowser();
    const no = ui([], false);
    await browserCommands({ browser: browser as unknown as BrowserService, ui: no }).clearBrowserData();
    expect(no.confirm).toHaveBeenCalledWith(CLEAR_BROWSER_QUESTION, 'Delete');
    expect(browser.clearData).not.toHaveBeenCalled();
    await browserCommands({ browser: browser as unknown as BrowserService, ui: ui() }).clearBrowserData();
    expect(browser.clearData).toHaveBeenCalledTimes(1);
    expect(CLEAR_BROWSER_QUESTION).toBe("Delete the Agent Stream browser's data? This logs you out of every site in it.");
  });
});

describe('the status bar item', () => {
  it('is hidden while the browser is closed and unused, names the steps using it, else says Browser', () => {
    expect(browserStatusText({ open: false, steps: [] })).toBeUndefined();
    expect(browserStatusText({ open: true, steps: [] })).toEqual({ text: '🌐 Browser', tooltip: 'The Agent Stream browser is open. Click to show it.' });
    expect(browserStatusText({ open: true, steps: ['n3', 'n5'] })).toEqual({ text: '🌐 n3, n5', tooltip: 'Steps using the Agent Stream browser: n3, n5. Click to show it.' });
  });
});

describe('the wait notification', () => {
  const wait: BrowserWait = { waitId: 'w1', runId: 'r1', nodeId: 'n3', reason: 'Log in to LinkedIn.' };

  it('asks with Show browser and Done; Done ends the wait', async () => {
    const browser = fakeBrowser({ waiting: [wait] });
    const u = ui(['Done']);
    notifyWait({ browser: browser as unknown as BrowserService, ui: u }, wait);
    await flush();
    expect(u.asked).toEqual([{ message: 'Step n3 is waiting for you in the browser: Log in to LinkedIn.', actions: ['Show browser', 'Done'] }]);
    expect(browser.done).toHaveBeenCalledWith('w1');
  });

  it('Show browser brings the step\'s tab to the front and asks again', async () => {
    const browser = fakeBrowser({ waiting: [wait] });
    const u = ui(['Show browser', 'Done']);
    notifyWait({ browser: browser as unknown as BrowserService, ui: u }, wait);
    await flush();
    await flush();
    expect(browser.show).toHaveBeenCalledWith({ runId: 'r1', nodeId: 'n3' });
    expect(u.asked).toHaveLength(2);
    expect(browser.done).toHaveBeenCalledWith('w1');
  });

  it('does nothing when the wait already ended elsewhere (the step log, Stop)', async () => {
    const browser = fakeBrowser({ waiting: [] });
    notifyWait({ browser: browser as unknown as BrowserService, ui: ui(['Done']) }, wait);
    await flush();
    expect(browser.done).not.toHaveBeenCalled();
  });
});

describe('EngineManager and the browser', () => {
  it('hands the window\'s one browser, and the output channel, to every folder\'s engine', () => {
    const browser = fakeBrowser() as unknown as BrowserService;
    const seen: AppDeps[] = [];
    const log = vi.fn();
    const manager = new EngineManager({
      settings: () => ({ claudePath: '', codexPath: '', gitBashPath: '', maxParallel: 1, provider: 'claude', model: '', effort: '' as const, copilotMaxRequestsPerStep: 25, copilotMaxRequestsPerTurn: 10 }),
      platform: 'darwin',
      env: {},
      home: mkdtempSync(join(tmpdir(), 'cs-home-')),
      git: noGit,
      events: { graphs: vi.fn(), approvals: vi.fn(), confirmRun: vi.fn(), graphDeleted: vi.fn(), sessions: vi.fn(), auth: vi.fn(), warning: vi.fn(), log },
      findClaude: () => ({ ok: true, path: '/bin/claude' }),
      checkAuth: async () => signedIn,
      browser,
      createApp: (deps) => {
        seen.push(deps);
        return createApp(deps);
      },
    });
    for (const name of ['a', 'b']) {
      const path = mkdtempSync(join(tmpdir(), `cs-${name}-`));
      manager.get({ key: `file://${path}`, name, path });
    }
    expect(seen.map((d) => d.browser)).toEqual([browser, browser]);
    seen[0].log!('g.md line 6: x');
    expect(log).toHaveBeenCalledWith('g.md line 6: x');
    manager.dispose();
  });
});
