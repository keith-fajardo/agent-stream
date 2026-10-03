import { describe, expect, it } from 'vitest';
import { ChatModelError, type ChatMessage } from '../src/agentLoop/chatModel';
import { compactIfNeeded, DROPPED_NOTE, estimateTokens, SUMMARY_PREFIX, SUMMARY_PROMPT } from '../src/agentLoop/compact';
import { runAgentLoop } from '../src/agentLoop/loop';
import { allowAll, fakeChatModel, textPart, toolCallPart, untilAborted, userText } from './helpers';

const signal = new AbortController().signal;

/** The task, then `pairs` tool rounds: an assistant tool call and its result of `size` characters (about 155 tokens a round). */
function conversation(pairs: number, size = 400): ChatMessage[] {
  const out: ChatMessage[] = [userText('The task.')];
  for (let i = 1; i <= pairs; i++) {
    out.push({ role: 'assistant', content: [textPart(`Step ${i}.`), toolCallPart(`c${i}`, 'Read', { file_path: `f${i}.txt` })] });
    out.push({ role: 'user', content: [{ type: 'toolResult', callId: `c${i}`, text: String(i % 10).repeat(size) }] });
  }
  return out;
}

const callIds = (m: ChatMessage | undefined) => (m?.role === 'assistant' ? m.content.flatMap((p) => (p.type === 'toolCall' ? [p.callId] : [])) : []);
const resultIds = (m: ChatMessage | undefined) => (m?.role === 'user' ? m.content.flatMap((c) => (c.type === 'toolResult' ? [c.callId] : [])) : []);

/** Every tool call is answered right after it, and no result comes without its call. */
function pairsIntact(messages: ChatMessage[]): boolean {
  return messages.every((m, i) => {
    const calls = callIds(m);
    const results = resultIds(m);
    if (calls.length && calls.some((id) => !resultIds(messages[i + 1]).includes(id))) return false;
    if (results.length && results.some((id) => !callIds(messages[i - 1]).includes(id))) return false;
    return true;
  });
}

describe('compactIfNeeded', () => {
  it('leaves a conversation at 75 % of the input limit alone, and compacts one just over it', async () => {
    const messages = conversation(10);
    const estimate = estimateTokens('System.', messages, []);
    const under = fakeChatModel([], { maxInputTokens: Math.ceil(estimate / 0.75) });
    expect(await compactIfNeeded({ model: under.model, system: 'System.', messages, tools: [], signal, canSummarise: true })).toEqual({ messages, requests: 0 });
    expect(under.requests).toHaveLength(0);
    const over = fakeChatModel([[textPart('We read ten files.')]], { maxInputTokens: Math.floor(estimate / 0.75) - 1 });
    const r = await compactIfNeeded({ model: over.model, system: 'System.', messages, tools: [], signal, canSummarise: true });
    expect(r.requests).toBe(1);
    expect(r.messages.length).toBeLessThan(messages.length);
  });

  it('keeps the task and the most recent rounds, and replaces the older ones with one summary', async () => {
    const messages = conversation(10);
    const { model, requests } = fakeChatModel([[textPart('We read files 1 to 8.')]], { maxInputTokens: 1000 });
    const r = await compactIfNeeded({ model, system: 'System.', messages, tools: [], signal, canSummarise: true });
    // 40 % of 1,000 tokens holds the last two rounds (about 155 tokens each).
    expect(r).toEqual({ messages: [messages[0], userText(`${SUMMARY_PREFIX}We read files 1 to 8.`), ...messages.slice(-4)], requests: 1 });
    // One request with no tools: the system text, then the older turns as text with the summary prompt.
    expect(requests[0].tools).toEqual([]);
    expect(requests[0].messages[0]).toEqual(userText('System.'));
    expect(requests[0].messages[1].content[0]).toMatchObject({ type: 'text', text: expect.stringContaining(SUMMARY_PROMPT) });
    expect(requests[0].messages[1].content[0]).toMatchObject({ text: expect.stringContaining('User: The task.') });
  });

  it('never splits a tool call from its results, whatever the limit', async () => {
    const messages = conversation(12);
    for (let limit = 600; limit <= 2400; limit += 50) {
      const { model } = fakeChatModel([[textPart('Summary.')]], { maxInputTokens: limit });
      const r = await compactIfNeeded({ model, system: 'System.', messages, tools: [], signal, canSummarise: true });
      expect(pairsIntact(r.messages)).toBe(true);
      expect(r.messages[0]).toEqual(messages[0]);
    }
  });

  it('drops the oldest rounds with a note when the summary request fails', async () => {
    const messages = conversation(10);
    const { model } = fakeChatModel([new ChatModelError('other', 'Copilot failed: overloaded')], { maxInputTokens: 1000 });
    const r = await compactIfNeeded({ model, system: 'System.', messages, tools: [], signal, canSummarise: true });
    expect(r).toEqual({ messages: [messages[0], userText(DROPPED_NOTE), ...messages.slice(-4)], requests: 1 });
    expect(estimateTokens('System.', r.messages, [])).toBeLessThanOrEqual(750);
  });

  it('drops without a summary request when the cap leaves no room for one', async () => {
    const messages = conversation(10);
    const { model, requests } = fakeChatModel([], { maxInputTokens: 1000 });
    const r = await compactIfNeeded({ model, system: 'System.', messages, tools: [], signal, canSummarise: false });
    expect(r).toEqual({ messages: [messages[0], userText(DROPPED_NOTE), ...messages.slice(-4)], requests: 0 });
    expect(requests).toHaveLength(0);
  });

  it('passes a Stop during the summary request on', async () => {
    const ac = new AbortController();
    const { model } = fakeChatModel([(_m, _t, s) => untilAborted(s)], { maxInputTokens: 1000 });
    const pending = compactIfNeeded({ model, system: 'System.', messages: conversation(10), tools: [], signal: ac.signal, canSummarise: true });
    ac.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('trims a dropped history to the 40 % keep target, not just under the trigger', async () => {
    const messages = conversation(10);
    const system = 'S'.repeat(400);
    const { model } = fakeChatModel([], { maxInputTokens: 1000 });
    const r = await compactIfNeeded({ model, system, messages, tools: [], signal, canSummarise: false });
    expect(r).toEqual({ messages: [messages[0], userText(DROPPED_NOTE), ...messages.slice(-2)], requests: 0 });
    expect(estimateTokens(system, r.messages, [])).toBeLessThanOrEqual(400);
  });

  it('drops the oldest kept rounds with a note when the history is still too long after a summary', async () => {
    const messages = conversation(10);
    const summary = 'x'.repeat(1900);
    const { model } = fakeChatModel([[textPart(summary)]], { maxInputTokens: 1000 });
    const r = await compactIfNeeded({ model, system: 'System.', messages, tools: [], signal, canSummarise: true });
    expect(r).toEqual({ messages: [messages[0], userText(`${SUMMARY_PREFIX}${summary}`), userText(DROPPED_NOTE), ...messages.slice(-2)], requests: 1 });
    expect(pairsIntact(r.messages)).toBe(true);
    expect(estimateTokens('System.', r.messages, [])).toBeLessThanOrEqual(750);
  });

  it('clips a long summary to 2,000 characters, keeping its head', async () => {
    const { model } = fakeChatModel([[textPart(`${'a'.repeat(2000)}${'b'.repeat(1000)}`)]], { maxInputTokens: 10_000 });
    const r = await compactIfNeeded({ model, system: 'System.', messages: conversation(60), tools: [], signal, canSummarise: true });
    const summary = r.messages[1];
    expect(summary.role).toBe('user');
    const text = summary.content[0].type === 'text' ? summary.content[0].text : '';
    expect(text.startsWith(`${SUMMARY_PREFIX}${'a'.repeat(2000)}`)).toBe(true);
    expect(text).not.toContain('b');
    expect(text.length).toBeLessThan(SUMMARY_PREFIX.length + 2100);
  });

  it('adds no drop note when nothing was dropped', async () => {
    // The system text alone is over the limit; the one round is the newest and is always kept.
    const messages = conversation(1);
    const { model, requests } = fakeChatModel([], { maxInputTokens: 1000 });
    const r = await compactIfNeeded({ model, system: 'S'.repeat(4000), messages, tools: [], signal, canSummarise: true });
    expect(r).toEqual({ messages, requests: 0 });
    expect(requests).toHaveLength(0);
  });
});

describe('runAgentLoop and compaction', () => {
  const quiet = { onText: () => {}, onToolCall: () => {}, onToolResult: () => {} };

  it('compacts before a request and counts the summary toward the cap', async () => {
    const { model, requests } = fakeChatModel([[textPart('Summary.')], [toolCallPart('c99', 'Read', { file_path: 'x' })]], { maxInputTokens: 1000 });
    const r = await runAgentLoop({ model, system: 'System.', messages: conversation(10), tools: [], gate: allowAll, maxRequests: 2, signal, ...quiet });
    expect(requests).toHaveLength(2);
    expect(requests[1].messages[2]).toEqual(userText(`${SUMMARY_PREFIX}Summary.`));
    expect(r).toMatchObject({ ok: false, capped: true, requests: 2, error: 'Stopped after 2 model requests.' });
  });

  it('never sends more than maxRequests when compaction is due at the last request', async () => {
    const { model, requests } = fakeChatModel([[textPart('Done.')]], { maxInputTokens: 1000 });
    const r = await runAgentLoop({ model, system: 'System.', messages: conversation(10), tools: [], gate: allowAll, maxRequests: 1, signal, ...quiet });
    expect(requests).toHaveLength(1);
    expect(requests[0].messages[2]).toEqual(userText(DROPPED_NOTE));
    expect(r).toMatchObject({ ok: true, text: 'Done.', requests: 1 });
  });

  it('judges room for a summary against the normalised cap, so a fractional cap still allows one request', async () => {
    const { model, requests } = fakeChatModel([[textPart('Done.')]], { maxInputTokens: 1000 });
    const r = await runAgentLoop({ model, system: 'System.', messages: conversation(10), tools: [], gate: allowAll, maxRequests: 1.5, signal, ...quiet });
    expect(requests).toHaveLength(1);
    expect(requests[0].messages[2]).toEqual(userText(DROPPED_NOTE));
    expect(r).toMatchObject({ ok: true, text: 'Done.', requests: 1 });
  });

  it('treats an Infinity cap as 1 when judging room for a summary', async () => {
    const { model, requests } = fakeChatModel([[textPart('Done.')]], { maxInputTokens: 1000 });
    const r = await runAgentLoop({ model, system: 'System.', messages: conversation(10), tools: [], gate: allowAll, maxRequests: Infinity, signal, ...quiet });
    expect(requests).toHaveLength(1);
    expect(requests[0].messages[2]).toEqual(userText(DROPPED_NOTE));
    expect(r).toMatchObject({ ok: true, text: 'Done.', requests: 1 });
  });

  it('counts a summary request that Stop interrupts', async () => {
    const ac = new AbortController();
    const { model } = fakeChatModel([(_m, _t, s) => untilAborted(s)], { maxInputTokens: 1000 });
    const pending = runAgentLoop({ model, system: 'System.', messages: conversation(10), tools: [], gate: allowAll, maxRequests: 3, signal: ac.signal, ...quiet });
    ac.abort();
    expect(await pending).toMatchObject({ ok: false, cancelled: true, requests: 1 });
  });

  it('compacts once, then sends the next rounds without compacting again', async () => {
    // A long system text: dropping only to just under 75 % would re-trigger within a couple of rounds.
    const read = (id: string) => [toolCallPart(id, 'Read', { file_path: 'x' })];
    const { model, requests } = fakeChatModel([new ChatModelError('other', 'Copilot failed: overloaded'), read('n1'), read('n2'), read('n3'), [textPart('Done.')]], { maxInputTokens: 1000 });
    const r = await runAgentLoop({ model, system: 'S'.repeat(1200), messages: conversation(10), tools: [], gate: allowAll, maxRequests: 10, signal, ...quiet });
    const summaryRequests = requests.filter((q) => q.messages.some((m) => m.content.some((c) => c.type === 'text' && c.text.includes(SUMMARY_PROMPT))));
    expect(summaryRequests).toHaveLength(1);
    expect(r).toMatchObject({ ok: true, text: 'Done.', requests: 5 });
  });
});
