import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { BROWSER_CLOSED, RUN_STOPPED, USER_DONE, parseWebviewMessage, waitingLine, type NodeEventBody } from '@agent-stream/shared';
import { createApp } from '../src/app';
import { browserDir, createBrowserLock } from '../src/browser/launcher';
import { BrowserService, type BrowserWait } from '../src/browser/service';
import { createBrowserTools } from '../src/browser/tools';
import { FakeContext } from './browserFakes';
import { appTestDeps, signedIn, testGitBash, testProvider, tmpProject, tmpValuesFile } from './helpers';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

function setup(o: { launchGate?: Promise<void> } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'agent-stream-home-'));
  const contexts: FakeContext[] = [];
  const service = new BrowserService({
    home,
    platform: 'darwin',
    env: {},
    settings: () => ({ path: '', searchEngine: '' }),
    exists: (p) => p === CHROME,
    lock: createBrowserLock({ dir: browserDir(home), pid: 100, isAlive: (pid) => pid === 100 }),
    launch: async () => {
      if (contexts.length > 0) await o.launchGate;
      const c = new FakeContext();
      c.sites['https://a.example/'] = { title: 'A' };
      contexts.push(c);
      return c;
    },
  });
  const waits: BrowserWait[] = [];
  const ended: string[] = [];
  service.on('wait', (w: BrowserWait) => void waits.push(w));
  service.on('waitEnded', (id: string) => void ended.push(id));
  const events: NodeEventBody[] = [];
  const stop = new AbortController();
  const start = async (nodeId = 'n3') => {
    const s = await service.startStep({ runId: 'r1', nodeId }, { emit: (e) => void events.push(e), record: () => {} });
    if (!s.ok) throw new Error(s.error);
    const tools = createBrowserTools({ step: s.step, ask: async () => ({ allow: true, site: false }), settleMs: 0 });
    const call = (name: string, input: unknown = {}) => tools.find((t) => t.name === name)!.run(input, stop.signal);
    return { step: s.step, call };
  };
  return { service, contexts, waits, ended, events, stop, start };
}

describe('browser_wait_for_you', () => {
  it('pauses the step until the user presses Done', async () => {
    const { service, waits, ended, events, start } = setup();
    const { call } = await start();
    let settled = false;
    const result = call('browser_wait_for_you', { reason: 'Log in to LinkedIn, then press Done.' }).finally(() => (settled = true));
    await vi.waitFor(() => expect(waits).toHaveLength(1));
    const wait = waits[0];
    expect(wait).toEqual({ waitId: wait.waitId, runId: 'r1', nodeId: 'n3', reason: 'Log in to LinkedIn, then press Done.' });
    expect(service.waiting()).toEqual([wait]);
    expect(events).toEqual([{ type: 'browser_wait', waitId: wait.waitId, text: waitingLine('n3', 'Log in to LinkedIn, then press Done.') }]);
    // No timeout: it waits as long as it takes.
    await new Promise((r) => setTimeout(r, 30));
    expect(settled).toBe(false);
    expect(service.done(wait.waitId)).toBe(true);
    expect(await result).toEqual({ text: USER_DONE });
    expect(events.at(-1)).toEqual({ type: 'browser_wait_done', waitId: wait.waitId, by: 'user' });
    expect(ended).toEqual([wait.waitId]);
    expect(service.done(wait.waitId)).toBe(false);
    expect(service.waiting()).toEqual([]);
  });

  it('a wait whose end hook throws still ends: the step gets its answer', async () => {
    const { service, waits } = setup();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = service.waitFor({ waitId: 'w1', runId: 'r1', nodeId: 'n3', reason: 'Log in.' }, new AbortController().signal, () => {
      throw new Error('the log could not be written');
    });
    await vi.waitFor(() => expect(waits).toHaveLength(1));
    expect(service.done('w1')).toBe(true);
    expect(await result).toBe('done');
    expect(service.waiting()).toEqual([]);
    // Already stopped: the same.
    const stopped = new AbortController();
    stopped.abort();
    expect(
      await service.waitFor({ waitId: 'w2', runId: 'r1', nodeId: 'n3', reason: 'Log in.' }, stopped.signal, () => {
        throw new Error('the log could not be written');
      }),
    ).toBe('stopped');
    expect(errors).toHaveBeenCalledTimes(2);
    errors.mockRestore();
  });

  it('Stop ends the wait', async () => {
    const { service, waits, events, stop, start } = setup();
    const { call } = await start();
    const result = call('browser_wait_for_you', { reason: 'Solve the CAPTCHA.' });
    await vi.waitFor(() => expect(waits).toHaveLength(1));
    stop.abort();
    expect(await result).toEqual({ text: RUN_STOPPED, isError: true });
    expect(events.at(-1)).toEqual({ type: 'browser_wait_done', waitId: waits[0].waitId, by: 'stopped' });
    expect(service.waiting()).toEqual([]);
  });

  it('Done reopens a browser that was closed, with fresh tabs for the step', async () => {
    const { service, contexts, waits, start } = setup();
    const { call } = await start();
    await call('browser_open', { url: 'https://a.example/' });
    await contexts[0].close();
    expect(await call('browser_read')).toEqual({ text: BROWSER_CLOSED, isError: true });
    const result = call('browser_wait_for_you', { reason: 'Open the browser again.' });
    await vi.waitFor(() => expect(waits).toHaveLength(1));
    service.done(waits[0].waitId);
    expect(await result).toEqual({ text: USER_DONE });
    expect(contexts).toHaveLength(2);
    expect(service.isOpen()).toBe(true);
    expect((await call('browser_open', { url: 'https://a.example/' })).isError).toBeUndefined();
    expect(contexts[1].open.some((p) => p.url() === 'https://a.example/')).toBe(true);
  });

  it('Done after the window is gone for good answers with the closed message instead of throwing', async () => {
    const { service, contexts, waits, events, start } = setup();
    const { call } = await start();
    await contexts[0].close();
    const result = call('browser_wait_for_you', { reason: 'Open the browser again.' });
    await vi.waitFor(() => expect(waits).toHaveLength(1));
    service.done(waits[0].waitId);
    await service.dispose();
    expect(await result).toEqual({ text: BROWSER_CLOSED, isError: true });
    expect(contexts).toHaveLength(1);
    expect(events.at(-1)).toEqual({ type: 'browser_wait_done', waitId: waits[0].waitId, by: 'user' });
  });

  it('Stop emits the done line before the tool answers, not after', async () => {
    const { waits, events, stop, start } = setup();
    const { call } = await start();
    const result = call('browser_wait_for_you', { reason: 'Solve the CAPTCHA.' });
    await vi.waitFor(() => expect(waits).toHaveLength(1));
    stop.abort();
    expect(events.at(-1)).toEqual({ type: 'browser_wait_done', waitId: waits[0].waitId, by: 'stopped' });
    expect(await result).toEqual({ text: RUN_STOPPED, isError: true });
  });

  it('the step ending ends its wait, even when its signal is never aborted', async () => {
    const { service, waits, ended, events, start } = setup();
    const { step, call } = await start();
    const other = await start('n4');
    const result = call('browser_wait_for_you', { reason: 'Log in.' });
    const otherResult = other.call('browser_wait_for_you', { reason: 'Log in too.' });
    await vi.waitFor(() => expect(waits).toHaveLength(2));
    await step.end('cancelled');
    expect(await result).toEqual({ text: RUN_STOPPED, isError: true });
    expect(events.at(-1)).toEqual({ type: 'browser_wait_done', waitId: waits[0].waitId, by: 'stopped' });
    expect(ended).toEqual([waits[0].waitId]);
    // The other step's wait is its own.
    expect(service.waiting()).toEqual([waits[1]]);
    expect(service.done(waits[1].waitId)).toBe(true);
    expect(await otherResult).toEqual({ text: USER_DONE });
  });

  it('disposing the service ends every wait with the closed message', async () => {
    const { service, waits, ended, events, start } = setup();
    const { call } = await start();
    const result = call('browser_wait_for_you', { reason: 'Log in.' });
    await vi.waitFor(() => expect(waits).toHaveLength(1));
    await service.dispose();
    expect(await result).toEqual({ text: BROWSER_CLOSED, isError: true });
    expect(events.at(-1)).toEqual({ type: 'browser_wait_done', waitId: waits[0].waitId, by: 'stopped' });
    expect(ended).toEqual([waits[0].waitId]);
    expect(service.waiting()).toEqual([]);
  });

  it('Stop while the browser reopens leaves the ended step without tabs', async () => {
    let release = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const { service, contexts, waits, stop, start } = setup({ launchGate: gate });
    const { step, call } = await start();
    await contexts[0].close();
    const result = call('browser_wait_for_you', { reason: 'Open the browser again.' });
    await vi.waitFor(() => expect(waits).toHaveLength(1));
    service.done(waits[0].waitId);
    stop.abort();
    expect(await result).toEqual({ text: RUN_STOPPED, isError: true });
    await step.end('cancelled');
    release();
    await vi.waitFor(() => expect(contexts).toHaveLength(2));
    await vi.waitFor(() => expect(service.isOpen()).toBe(true));
    await new Promise((r) => setTimeout(r, 30));
    expect(step.tabs()).toBeUndefined();
    expect(service.state().steps).toEqual([]);
  });

  it('a Done for an unknown id, or for another step, leaves a live wait alone; a second Done changes nothing', async () => {
    const { service, waits, ended, events, start } = setup();
    const a = await start('n3');
    const b = await start('n4');
    const resultA = a.call('browser_wait_for_you', { reason: 'A' });
    const resultB = b.call('browser_wait_for_you', { reason: 'B' });
    await vi.waitFor(() => expect(waits).toHaveLength(2));
    expect(service.done('no-such-wait')).toBe(false);
    expect(service.waiting()).toHaveLength(2);
    expect(service.done(waits[1].waitId)).toBe(true);
    expect(await resultB).toEqual({ text: USER_DONE });
    expect(service.done(waits[1].waitId)).toBe(false);
    expect(service.waiting()).toEqual([waits[0]]);
    expect(ended).toEqual([waits[1].waitId]);
    expect(events.filter((e) => e.type === 'browser_wait_done')).toHaveLength(1);
    service.done(waits[0].waitId);
    expect(await resultA).toEqual({ text: USER_DONE });
  });

  it('the browserDone message needs a string waitId of at most 100 characters', () => {
    expect(parseWebviewMessage({ type: 'browserDone', waitId: 5 }).ok).toBe(false);
    expect(parseWebviewMessage({ type: 'browserDone', waitId: 'x'.repeat(101) }).ok).toBe(false);
    expect(parseWebviewMessage({ type: 'browserDone', waitId: 'x'.repeat(100) }).ok).toBe(true);
    expect(parseWebviewMessage({ type: 'browserDone' }).ok).toBe(false);
  });

  it('the step log\'s Done button (a browserDone message) ends it through the App', async () => {
    const { service, waits, start } = setup();
    const { call } = await start();
    const paths = tmpProject();
    const app = createApp({ ...appTestDeps(), projectDir: paths.root, valuesFile: tmpValuesFile(), provider: testProvider(), status: signedIn, maxParallel: 1, gitBash: testGitBash, browser: service });
    const result = call('browser_wait_for_you', { reason: 'Log in.' });
    await vi.waitFor(() => expect(waits).toHaveLength(1));
    const msg = { type: 'browserDone', waitId: waits[0].waitId };
    expect(parseWebviewMessage(msg)).toEqual({ ok: true, kind: 'engine', msg });
    await app.handle({ send: () => {} }, msg as never);
    expect(await result).toEqual({ text: USER_DONE });
  });
});
