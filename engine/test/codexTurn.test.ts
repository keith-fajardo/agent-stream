import { describe, expect, it } from 'vitest';
import type { LoopTool } from '../src/agentLoop/tools';
import { openCodex } from '../src/providers/codex/connection';
import type { ThreadItem } from '../src/providers/codex/protocol';
import { dynamicToolSpecs, runCodexTurn, usageOf, type RunTurnOptions } from '../src/providers/codex/turn';
import { agentMessage, fakeCodex, turnHandlers, waitFor, type FakeHandler, type TurnScript } from './codexFake';

async function turn(handlers: Record<string, FakeHandler>, o: Partial<RunTurnOptions> = {}) {
  const fake = fakeCodex(handlers);
  const conn = await openCodex({ codexPath: '/bin/codex', spawn: fake.spawn });
  const items: [string, ThreadItem][] = [];
  const retries: string[] = [];
  const outcome = runCodexTurn({
    conn,
    threadId: 'thread-1',
    text: 'Do it',
    signal: new AbortController().signal,
    onItem: (phase, item) => items.push([phase, item]),
    onRetry: (text) => retries.push(text),
    ...o,
  });
  return { outcome, items, retries, proc: fake.last(), conn };
}
const scripted = (script: (t: TurnScript) => unknown, o: Partial<RunTurnOptions> = {}) => turn(turnHandlers({ script }), o);

describe('runCodexTurn', () => {
  it('sends turn/start and ends on turn/completed with the last agent message', async () => {
    const t = await scripted((s) => {
      s.item(agentMessage('Working.', 'm1'));
      s.item(agentMessage('Done.', 'm2'));
      s.end();
    });
    expect(await t.outcome).toEqual({ status: 'completed', lastText: 'Done.' });
    expect(t.proc.paramsOf('turn/start')).toEqual({ threadId: 'thread-1', input: [{ type: 'text', text: 'Do it', text_elements: [] }] });
    expect(t.items.map(([phase, item]) => `${phase} ${item.id}`)).toEqual(['started m1', 'completed m1', 'started m2', 'completed m2']);
    t.conn.close();
  });

  it('sends the effort when one is given', async () => {
    const t = await scripted((s) => s.end(), { effort: 'ultra' });
    await t.outcome;
    expect(t.proc.paramsOf('turn/start').effort).toBe('ultra');
    t.conn.close();
  });

  it("reports the turn's tokens, with cached input counted apart (R11)", async () => {
    const t = await scripted((s) => {
      s.usage({ inputTokens: 1000, cachedInputTokens: 600, cacheWriteInputTokens: 100, outputTokens: 50 });
      s.end();
    });
    expect((await t.outcome).usage).toEqual({ inputTokens: 300, outputTokens: 50, cacheReadTokens: 600, cacheWriteTokens: 100, costUsd: 0, turns: 1 });
    expect(usageOf({ totalTokens: 0, inputTokens: 10, cachedInputTokens: 20, cacheWriteInputTokens: 0, outputTokens: 1, reasoningOutputTokens: 0 }).inputTokens).toBe(0);
    t.conn.close();
  });

  it('fails a turn that failed or was interrupted, with the reason (R22)', async () => {
    const failed = await scripted((s) => s.end('failed', 'rate limited'));
    expect(await failed.outcome).toEqual({ status: 'failed', lastText: '', error: 'Codex failed: rate limited' });
    const bare = await scripted((s) => s.end('failed'));
    expect((await bare.outcome).error).toBe('Codex failed: the turn failed.');
    const interrupted = await scripted((s) => s.end('interrupted'));
    expect(await interrupted.outcome).toEqual({ status: 'interrupted', lastText: '', error: 'Codex failed: the turn was interrupted.' });
    for (const t of [failed, bare, interrupted]) t.conn.close();
  });

  it('logs a retrying error and fails on a final one (R12)', async () => {
    const t = await scripted((s) => {
      s.error('stream dropped', true);
      s.error('model refused');
      s.end('completed');
    });
    expect(await t.outcome).toEqual({ status: 'failed', lastText: '', error: 'Codex failed: model refused' });
    expect(t.retries).toEqual(['Codex: stream dropped (retrying)']);
    t.conn.close();
  });

  it("ignores another thread's notifications", async () => {
    const t = await scripted((s) => {
      s.proc.notify('item/completed', { threadId: 'other', turnId: 'x', item: agentMessage('not mine', 'o1') });
      s.proc.notify('turn/completed', { threadId: 'other', turn: { id: 'x', status: 'failed', error: null, items: [] } });
      s.item(agentMessage('mine', 'm1'));
      s.end();
    });
    expect(await t.outcome).toEqual({ status: 'completed', lastText: 'mine' });
    expect(t.items.map(([, item]) => item.id)).toEqual(['m1', 'm1']);
    t.conn.close();
  });

  it('Stop interrupts the turn, waits for it to end, and returns cancelled', async () => {
    const ac = new AbortController();
    const t = await scripted((s) => s.item(agentMessage('Starting.')), { signal: ac.signal });
    await waitFor(() => t.items.length === 2);
    ac.abort();
    expect(await t.outcome).toEqual({ status: 'cancelled', lastText: 'Starting.' });
    expect(t.proc.paramsOf('turn/interrupt')).toEqual({ threadId: 'thread-1', turnId: 'turn-1' });
    t.conn.close();
  });

  it('Stop returns after the wait when Codex never ends the turn', async () => {
    const ac = new AbortController();
    const t = await turn(turnHandlers({ onInterrupt: 'ignore' }), { signal: ac.signal, interruptWaitMs: 30 });
    await waitFor(() => t.proc.methods().includes('turn/start'));
    ac.abort();
    expect((await t.outcome).status).toBe('cancelled');
    t.conn.close();
  });

  it('Stop before turn/start is answered interrupts the turn once its id arrives', async () => {
    let answer!: () => void;
    const answered = new Promise<void>((r) => (answer = r));
    const ac = new AbortController();
    const t = await turn(
      {
        'turn/start': async () => {
          await answered;
          return { turn: { id: 'turn-9', status: 'inProgress', error: null, items: [] } };
        },
        'turn/interrupt': (p: { threadId: string; turnId: string }, proc) => {
          setImmediate(() => proc.notify('turn/completed', { threadId: p.threadId, turn: { id: p.turnId, status: 'interrupted', error: null, items: [] } }));
          return {};
        },
      },
      { signal: ac.signal },
    );
    await waitFor(() => t.proc.methods().includes('turn/start'));
    ac.abort();
    answer();
    expect((await t.outcome).status).toBe('cancelled');
    expect(t.proc.paramsOf('turn/interrupt')).toEqual({ threadId: 'thread-1', turnId: 'turn-9' });
    t.conn.close();
  });

  it('Stop before the turn starts returns cancelled without sending turn/start (M2)', async () => {
    const ac = new AbortController();
    ac.abort();
    const t = await scripted((s) => s.end(), { signal: ac.signal });
    expect(await t.outcome).toEqual({ status: 'cancelled', lastText: '' });
    expect(t.proc.methods()).not.toContain('turn/start');
    t.conn.close();
  });

  it('rejects with the exit message when Codex exits mid-turn', async () => {
    const t = await scripted((s) => {
      s.item(agentMessage('Hi'));
      void s.proc.exit(2, 'panic\n');
    });
    await expect(t.outcome).rejects.toThrow('Codex stopped unexpectedly (exit 2).\npanic');
  });
});

describe('dynamicToolSpecs', () => {
  it("offers each loop tool as a function, without zod's $schema key (R17)", () => {
    const tool: LoopTool = {
      spec: { name: 'add_step', description: 'Add a step', inputSchema: { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', properties: { title: { type: 'string' } } } },
      gateName: 'add_step',
      run: async () => ({ text: '' }),
    };
    expect(dynamicToolSpecs([tool])).toEqual([{ type: 'function', name: 'add_step', description: 'Add a step', inputSchema: { type: 'object', properties: { title: { type: 'string' } } } }]);
  });
});
