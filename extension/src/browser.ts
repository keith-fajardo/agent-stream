import * as vscode from 'vscode';
import { CLEAR_BROWSER_QUESTION, DONE, SHOW_BROWSER, START_PAGE_TEXT, waitingLine } from '@agent-stream/shared';
import type { BrowserService, BrowserSettings, BrowserState, BrowserWait } from '@agent-stream/engine';
import { escapeHtml } from './webviewHtml';

/** agentStream.browser.path and agentStream.browser.searchEngine (spec §5.1), read on every use; '' means the default. */
export function readBrowserSettings(): BrowserSettings {
  const config = vscode.workspace.getConfiguration('agentStream');
  const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
  return { path: text(config.get<unknown>('browser.path', '')), searchEngine: text(config.get<unknown>('browser.searchEngine', '')) };
}

/** The page Open Browser shows on a fresh launch (spec §5.1), set as the first tab's content: no file: URL. */
export function startPageHtml(): string {
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head><meta charset="utf-8"><title>Agent Stream browser</title>',
    '<style>body{font:16px/1.5 system-ui,sans-serif;max-width:40em;margin:4em auto;padding:0 1em;color:#222}h1{font-size:1.4em}</style>',
    '</head>',
    '<body>',
    '<h1>Agent Stream browser</h1>',
    `<p>${escapeHtml(START_PAGE_TEXT)}</p>`,
    '</body>',
    '</html>',
  ].join('\n');
}

/** The status bar item (ruling R15): hidden while closed and unused. */
export function browserStatusText(state: BrowserState): { text: string; tooltip: string } | undefined {
  if (state.steps.length) return { text: `🌐 ${state.steps.join(', ')}`, tooltip: `Steps using the Agent Stream browser: ${state.steps.join(', ')}. Click to show it.` };
  if (state.open) return { text: '🌐 Browser', tooltip: 'The Agent Stream browser is open. Click to show it.' };
  return undefined;
}

export type BrowserUi = {
  info(message: string, ...actions: string[]): Thenable<string | undefined>;
  error(message: string): void;
  confirm(message: string, action: string): Promise<boolean>;
};

/** Agent Stream: Open Browser and Clear Browser Data (spec §5.1). */
export function browserCommands(d: { browser: BrowserService; ui: BrowserUi }) {
  return {
    /** Brings the window to the front, or opens it with the start page. The status bar item runs this too. */
    async openBrowser(): Promise<void> {
      const r = await d.browser.show();
      if (!r.ok) d.ui.error(r.error);
    },
    async clearBrowserData(): Promise<void> {
      if (!(await d.ui.confirm(CLEAR_BROWSER_QUESTION, 'Delete'))) return;
      const r = await d.browser.clearData();
      if (!r.ok) d.ui.error(r.error);
    },
  };
}

/**
 * The notification for a step waiting for the user (spec §5.3). Show browser brings the step's tab to the front and asks
 * again, so Done stays one click away; a wait that already ended (the step log's Done, Stop) ignores the answer.
 */
export function notifyWait(d: { browser: BrowserService; ui: BrowserUi }, wait: BrowserWait): void {
  const ask = (): void => {
    void d.ui.info(waitingLine(wait.nodeId, wait.reason), SHOW_BROWSER, DONE).then((choice) => {
      if (!d.browser.waiting().some((w) => w.waitId === wait.waitId)) return;
      if (choice === DONE) d.browser.done(wait.waitId);
      else if (choice === SHOW_BROWSER) {
        void d.browser.show({ runId: wait.runId, nodeId: wait.nodeId });
        ask();
      }
    });
  };
  ask();
}
