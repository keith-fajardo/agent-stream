import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ApprovalBroker } from '../src/approvals';
import { ChatModelError } from '../src/agentLoop/chatModel';
import { toLoopTools } from '../src/agentLoop/graphLoopTools';
import { lastAssistantText, runAgentLoop } from '../src/agentLoop/loop';
import { builtinTools, type LoopTool } from '../src/agentLoop/tools';
import { defineTool, reply } from '../src/plannerTools';
import { createStepGate, readOnlyRefusal, type ToolGate } from '../src/providers/toolGate';
import type { RunShell } from '../src/shell';
import { allowAll, deferred, fakeChatModel, textPart, toolCallPart, untilAborted, userText, type FakeReply } from './helpers';

const noShell: RunShell = async () => ({ exitCode: 0, output: '' });
const tmp = () => mkdtempSync(join(tmpdir(), 'loop-'));

function loop(o: { replies: FakeReply[]; tools?: LoopTool[]; gate?: ToolGate; maxRequests?: number; signal?: AbortSignal; cwd?: string }) {
  const cwd = o.cwd ?? tmp();
  const { model, requests } = fakeChatModel(o.replies);
  const log: unknown[][] = [];
  const result = runAgentLoop({
    model,
    system: 'You are a test agent.',
    messages: [userText('Do the task.')],
    tools: o.tools ?? builtinTools({ cwd, runShell: noShell, readOnly: false }),
    gate: o.gate ?? allowAll,
    maxRequests: o.maxRequests ?? 10,
    signal: o.signal ?? new AbortController().signal,
    capMessage: 'Stopped: cap reached.',
    onText: (text) => log.push(['text', text]),
    onToolCall: (callId, name, input) => log.push(['call', callId, name, input]),
    onToolResult: (callId, text, isError) => log.push(['result', callId, text, isError]),
  });
  return { result, requests, log, cwd };
}

function stepGate(cwd: string, o: { readOnly?: boolean; selfApproving?: string[]; privateFiles?: string[] } = {}) {
  const broker = new ApprovalBroker(() => 't');
  const gate = createStepGate({
    broker,
    runId: 'r',
    graphId: 'g',
    nodeId: 'n1',
    nodeTitle: 'Step',
    projectDir: cwd,
    privateFiles: o.privateFiles ?? [],
    signal: new AbortController().signal,
    emit: () => {},
    readOnly: o.readOnly,
    selfApproving: new Set(o.selfApproving ?? []),
  });
  return { broker, gate };
}

describe('runAgentLoop', () => {
  it('ends on a reply without tool calls, joining streamed text into one part', async () => {
    const { result, requests, log } = loop({ replies: [[textPart('All '), textPart('done.'), textPart('  ')]] });
    expect(await result).toEqual({
      ok: true,
      text: 'All done.  ',
      requests: 1,
      messages: [userText('Do the task.'), { role: 'assistant', content: [textPart('All done.  ')] }],
    });
    expect(log).toEqual([['text', 'All done.  ']]);
    // The system text goes first, as a user message; the tools are offered by their specs.
    expect(requests[0].messages).toEqual([userText('You are a test agent.'), userText('Do the task.')]);
    expect(requests[0].tools.map((t) => t.name)).toEqual(['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash']);
  });

  it('asks the gate, runs an approved tool, sends its result and ends on the final reply', async () => {
    const cwd = tmp();
    const { broker, gate } = stepGate(cwd);
    const { result, requests, log } = loop({ cwd, gate, replies: [[toolCallPart('c1', 'Write', { file_path: 'out.txt', content: 'hi' })], [textPart('Wrote it.')]] });
    await vi.waitFor(() => expect(broker.pending()).toHaveLength(1));
    expect(broker.pending()[0]).toMatchObject({ toolName: 'Write', input: { file_path: 'out.txt', content: 'hi' } });
    broker.decide(broker.pending()[0].id, { decision: 'approve' });
    expect(await result).toMatchObject({ ok: true, text: 'Wrote it.', requests: 2 });
    expect(readFileSync(join(cwd, 'out.txt'), 'utf8')).toBe('hi');
    const wrote = `Wrote ${join(cwd, 'out.txt')} (2 bytes).`;
    expect(log).toEqual([['call', 'c1', 'Write', { file_path: 'out.txt', content: 'hi' }], ['result', 'c1', wrote, false], ['text', 'Wrote it.']]);
    expect(requests[1].messages.at(-1)).toEqual({ role: 'user', content: [{ type: 'toolResult', callId: 'c1', text: wrote }] });
  });

  it('sends a denial back as an error result and carries on', async () => {
    const cwd = tmp();
    const { broker, gate } = stepGate(cwd);
    const { result, requests, log } = loop({ cwd, gate, replies: [[toolCallPart('c1', 'Write', { file_path: 'out.txt', content: 'hi' })], [textPart('OK, skipped.')]] });
    await vi.waitFor(() => expect(broker.pending()).toHaveLength(1));
    broker.decide(broker.pending()[0].id, { decision: 'deny', note: 'not now' });
    expect(await result).toMatchObject({ ok: true, text: 'OK, skipped.' });
    expect(existsSync(join(cwd, 'out.txt'))).toBe(false);
    expect(log).toContainEqual(['result', 'c1', 'Denied by the user: not now', true]);
    expect(requests[1].messages.at(-1)).toEqual({ role: 'user', content: [{ type: 'toolResult', callId: 'c1', text: 'Denied by the user: not now', isError: true }] });
  });

  it('refuses a write tool in a read-only step without asking', async () => {
    const cwd = tmp();
    const { broker, gate } = stepGate(cwd, { readOnly: true });
    const { result, log } = loop({ cwd, gate, replies: [[toolCallPart('c1', 'Edit', { file_path: 'a.txt', old_string: 'a', new_string: 'b' })], [textPart('I could not edit.')]] });
    expect(await result).toMatchObject({ ok: true, text: 'I could not edit.' });
    expect(log).toContainEqual(['result', 'c1', readOnlyRefusal('Edit'), true]);
    expect(broker.pending()).toEqual([]);
  });

  it('answers an unknown tool with an error, without asking the gate', async () => {
    const decide = vi.fn(allowAll.decide);
    const { result, log } = loop({ gate: { ...allowAll, decide }, replies: [[toolCallPart('c1', 'Delete', {})], [textPart('Sorry.')]] });
    expect(await result).toMatchObject({ ok: true, text: 'Sorry.' });
    expect(log).toContainEqual(['result', 'c1', 'Unknown tool Delete.', true]);
    expect(decide).not.toHaveBeenCalled();
  });

  it('lets a step graph tool through under its mcp__run_graph__ name, without a second approval', async () => {
    const cwd = tmp();
    const ran = vi.fn(async (a: { title: string }) => reply(`added ${a.title}`));
    const tools = toLoopTools([defineTool('add_step', 'Add a step.', { title: z.string() }, ran)], 'mcp__run_graph__');
    const { broker, gate } = stepGate(cwd, { selfApproving: ['mcp__run_graph__add_step'] });
    const { result, log } = loop({ cwd, gate, tools, replies: [[toolCallPart('c1', 'add_step', { title: 'Lint' })], [textPart('Added.')]] });
    expect(await result).toMatchObject({ ok: true, text: 'Added.' });
    expect(ran).toHaveBeenCalledWith({ title: 'Lint' });
    expect(log).toContainEqual(['result', 'c1', 'added Lint', false]);
    expect(broker.pending()).toEqual([]);
  });

  it('returns a malformed tool input as a validation error and carries on', async () => {
    const { result, log } = loop({ replies: [[toolCallPart('c1', 'Read', { file_path: 42 })], [textPart('Retrying later.')]] });
    expect(await result).toMatchObject({ ok: true, text: 'Retrying later.' });
    expect(log).toContainEqual(['result', 'c1', expect.stringContaining('file_path'), true]);
  });

  it('stops after exactly maxRequests requests while the model still wants tools', async () => {
    const cwd = tmp();
    writeFileSync(join(cwd, 'a.txt'), 'x');
    const read = () => [toolCallPart('c', 'Read', { file_path: 'a.txt' })];
    const { result, requests } = loop({ cwd, maxRequests: 3, replies: [read(), read(), read(), [textPart('never sent')]] });
    expect(await result).toMatchObject({ ok: false, capped: true, error: 'Stopped: cap reached.', requests: 3 });
    expect(requests).toHaveLength(3);
  });

  it('is cancelled by a Stop during a request', async () => {
    const ac = new AbortController();
    const { result } = loop({ signal: ac.signal, replies: [(_messages, _tools, signal) => untilAborted(signal)] });
    setTimeout(() => ac.abort(), 10);
    expect(await result).toMatchObject({ ok: false, cancelled: true, error: 'cancelled', requests: 1 });
  });

  it('is cancelled by a Stop during a tool, without reporting its result', async () => {
    const ac = new AbortController();
    const started = deferred<void>();
    const slow: LoopTool = {
      spec: { name: 'Slow', description: 'Waits.', inputSchema: { type: 'object' } },
      gateName: 'Slow',
      run: async (_input, signal) => {
        started.resolve();
        return untilAborted(signal);
      },
    };
    const { result, log } = loop({ signal: ac.signal, tools: [slow], replies: [[toolCallPart('c1', 'Slow', {})]] });
    await started.promise;
    ac.abort();
    expect(await result).toMatchObject({ ok: false, cancelled: true, error: 'cancelled' });
    expect(log).toEqual([['call', 'c1', 'Slow', {}]]);
  });

  it("returns a ChatModelError's message as the error", async () => {
    const message = 'Copilot refused the request (quota or policy): monthly limit';
    const { result } = loop({ replies: [new ChatModelError('blocked', message)] });
    expect(await result).toEqual({ ok: false, error: message, requests: 1, messages: [userText('Do the task.')] });
  });

  it('refuses Read, Grep and Glob on private files through a real step gate, without asking', async () => {
    const cwd = tmp();
    const valuesDir = mkdtempSync(join(tmpdir(), 'values-'));
    const values = join(valuesDir, 'v.json');
    writeFileSync(values, '{"token":"s3cret"}');
    const { broker, gate } = stepGate(cwd, { privateFiles: [values] });
    const { result, requests, log } = loop({
      cwd,
      gate,
      replies: [
        [toolCallPart('c1', 'Read', { file_path: values }), toolCallPart('c2', 'Glob', { pattern: '*', path: valuesDir }), toolCallPart('c3', 'Grep', { pattern: 's3cret', path: dirname(valuesDir) })],
        [textPart('Nothing to see.')],
      ],
    });
    expect(await result).toMatchObject({ ok: true });
    const privateResult = (id: string) => ['result', id, expect.stringContaining('private to this machine'), true];
    expect(log.filter((e) => e[0] === 'result')).toEqual([privateResult('c1'), privateResult('c2'), privateResult('c3')]);
    // All three results travel back in one user message.
    expect(requests[1].messages.at(-1)?.content).toHaveLength(3);
    expect(broker.pending()).toEqual([]);
  });
});

describe('lastAssistantText', () => {
  it('is the newest assistant text, skipping replies that only call tools', () => {
    expect(lastAssistantText([userText('a'), { role: 'assistant', content: [textPart('first')] }, { role: 'assistant', content: [toolCallPart('c', 'Read', {})] }])).toBe('first');
    expect(lastAssistantText([userText('a')])).toBe('');
  });
});
