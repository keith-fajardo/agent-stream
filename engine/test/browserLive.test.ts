import { mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { RunMeta, ServerMessage } from '@agent-stream/shared';
import { createApp } from '../src/app';
import { findBrowser } from '../src/browser/launcher';
import { BrowserService } from '../src/browser/service';
import { findClaude } from '../src/platform';
import { createClaudeProvider } from '../src/providers/claude';
import { appTestDeps, testGitBash, tmpProject, tmpValuesFile } from './helpers';

const live = process.env.AGENT_STREAM_LIVE === '1';
const found = findBrowser({ setting: process.env.AGENT_STREAM_BROWSER_PATH ?? '', platform: process.platform, env: process.env, home: homedir() });

describe.skipIf(!live || !found.ok)('live: a Browser step on real Claude', { timeout: 300_000 }, () => {
  it('opens a public page and reads it, and the run records the page', async () => {
    const provider = createClaudeProvider({ findClaude: () => findClaude({ platform: process.platform, env: process.env, home: homedir() }) });
    const status = await provider.status();
    expect(status.ok, status.error).toBe(true);
    // Its own profile in a temp folder: the user's Agent Stream browser data is never touched.
    const home = mkdtempSync(join(tmpdir(), 'agent-stream-live-'));
    const browser = new BrowserService({ home, platform: process.platform, env: process.env, settings: () => ({ path: process.env.AGENT_STREAM_BROWSER_PATH ?? '', searchEngine: '' }) });
    const paths = tmpProject();
    const app = createApp({ ...appTestDeps(), projectDir: paths.root, valuesFile: tmpValuesFile(), provider, status, maxParallel: 1, gitBash: testGitBash, browser });
    // Whatever happens, the window closes and the profile goes: a failed live run leaves nothing running.
    try {
      const graphId = app.graphStore.create('Live browser').id;
      app.graphStore.apply(graphId, { type: 'addNode', node: { title: 'Read example.com', kind: 'agent', access: 'read', browser: true, prompt: 'Use the browser_open tool to open https://example.com/ and reply with the page title only.' } }, 'user');
      const msgs: ServerMessage[] = [];
      const c = { send: (m: ServerMessage) => void msgs.push(structuredClone(m)) };
      app.connect(c);
      await app.handle(c, { type: 'previewRun', graphId });
      await app.handle(c, { type: 'startRun', graphId, reviewed: msgs.filter((m) => m.type === 'runPreview').at(-1)!.preview.signature });
      // The one wait over 5 s in the suite (ruling PF4): a real model run with a real page load takes minutes, not milliseconds.
      await vi.waitFor(() => expect(['succeeded', 'failed', 'cancelled']).toContain(msgs.filter((m) => m.type === 'run').at(-1)?.run.status), { timeout: 240_000, interval: 1000 });
      const run: RunMeta = app.runStore.get(msgs.filter((m) => m.type === 'run').at(-1)!.run.id)!;
      expect(run.status, run.nodes.n1.error).toBe('succeeded');
      expect(run.nodes.n1.browserPages).toContain('https://example.com/');
      expect(app.runStore.readOutput(run.id, 'n1')).toMatch(/Example Domain/);
    } finally {
      app.dispose();
      await browser.dispose();
      rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  });
});
