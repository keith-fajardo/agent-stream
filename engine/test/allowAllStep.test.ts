import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { CanUseTool, HookInput } from '@anthropic-ai/claude-agent-sdk';
import { ALLOWED_EVERYTHING_LINE, emptyGraph, type GraphNode, type NodeEventBody } from '@agent-stream/shared';
import { ApprovalBroker, requestApproval } from '../src/approvals';
import { runAgentLoop } from '../src/agentLoop/loop';
import { builtinTools } from '../src/agentLoop/tools';
import { toSdkGate } from '../src/providers/claude/sdkGate';
import { createServerRequestHandler } from '../src/providers/codex/approvals';
import { createStepGate } from '../src/providers/toolGate';
import type { RunShell } from '../src/shell';
import { approvalParams, waitFor } from './codexFake';
import { fakeChatModel, textPart, toolCallPart, userText } from './helpers';

const STEP = { decision: 'approve', scope: 'step' } as const;
const node = (id: string): GraphNode => ({ id, title: `Step ${id}`, kind: 'agent', prompt: 'p', createdBy: 'user', updatedBy: 'user', updatedAt: 't' });
const input = (runId = 'r1', nodeId = 'n1') => ({ runId, graphId: 'g', nodeId, nodeTitle: 'Step', toolName: 'Bash', input: { command: 'ls' } });

function ask(broker: ApprovalBroker, o: { runId?: string; nodeId?: string; card?: Parameters<typeof requestApproval>[0]['card']; signal?: AbortSignal; events?: NodeEventBody[] } = {}) {
  const events = o.events ?? [];
  const ctx = { runId: o.runId ?? 'r1', graph: emptyGraph('g', 'G', 't'), node: node(o.nodeId ?? 'n1'), emit: (e: NodeEventBody) => void events.push(e) };
  return requestApproval({ broker, ctx, toolName: 'T', input: { a: 1 }, card: o.card ?? { graphChange: { summary: 's', detail: 'd' } }, signal: o.signal ?? new AbortController().signal });
}

describe('Allow all for this step: the broker', () => {
  it('approves the pressed request and everything else the same step has pending, and no other step', async () => {
    const broker = new ApprovalBroker();
    const a = broker.request(input('r1', 'n1'));
    const b = broker.request(input('r1', 'n1'));
    const otherStep = broker.request(input('r1', 'n2'));
    const otherRun = broker.request(input('r2', 'n1'));
    expect(broker.decide(a.id, STEP)).toBe(true);
    await expect(a.decision).resolves.toEqual(STEP);
    await expect(b.decision).resolves.toEqual(STEP);
    expect(broker.pending().map((p) => p.id)).toEqual([otherStep.id, otherRun.id]);
  });

  it('is gone once the step ends, and when the run is cancelled', () => {
    const broker = new ApprovalBroker();
    const a = broker.request(input('r1', 'n1'));
    broker.decide(a.id, STEP);
    expect(broker.isStepAllowed('r1', 'n1')).toBe(true);
    expect(broker.isStepAllowed('r1', 'n2')).toBe(false);
    expect(broker.isStepAllowed('r2', 'n1')).toBe(false);
    broker.endStep('r1', 'n1');
    expect(broker.isStepAllowed('r1', 'n1')).toBe(false);
    const b = broker.request(input('r3', 'n1'));
    broker.decide(b.id, STEP);
    broker.cancelRun('r3');
    expect(broker.isStepAllowed('r3', 'n1')).toBe(false);
  });

  it('a decision that is not an approval with the step scope allows nothing', async () => {
    const broker = new ApprovalBroker();
    const a = broker.request(input());
    broker.decide(a.id, { decision: 'approve', scope: 'site' });
    expect(broker.isStepAllowed('r1', 'n1')).toBe(false);
    const b = broker.request(input());
    broker.decide(b.id, { decision: 'deny' });
    expect(broker.isStepAllowed('r1', 'n1')).toBe(false);
  });
});

describe('Allow all for this step: requestApproval (the one path every step approval takes)', () => {
  it('logs the press, approves what is pending, and answers later requests of the step without a card', async () => {
    const broker = new ApprovalBroker();
    const events: NodeEventBody[] = [];
    const first = ask(broker, { events });
    const second = ask(broker, { events, card: {} });
    const [r1, r2] = broker.pending();
    broker.decide(r1.id, STEP);
    expect(await first).toEqual(STEP);
    expect(await second).toEqual(STEP);
    expect(events.map((e) => e.type)).toEqual(['approval_requested', 'approval_requested', 'approval_allowed_all', 'approval_decided', 'approval_decided']);
    expect(events[2]).toEqual({ type: 'approval_allowed_all' });
    expect(events[3]).toEqual({ type: 'approval_decided', approvalId: r1.id, decision: 'approve', scope: 'step' });
    expect(events[4]).toEqual({ type: 'approval_decided', approvalId: r2.id, decision: 'approve', scope: 'step' });
    // A graph change and a plain tool call after the press are approved at once: logged as asked and decided with scope step.
    events.length = 0;
    expect(await ask(broker, { events })).toEqual(STEP);
    expect(await ask(broker, { events, card: { browserAction: { site: 's', url: 'u', title: 't' } } })).toEqual(STEP);
    expect(broker.pending()).toEqual([]);
    expect(events.map((e) => e.type)).toEqual(['approval_requested', 'approval_decided', 'approval_requested', 'approval_decided']);
    expect(events[1]).toMatchObject({ decision: 'approve', scope: 'step' });
    expect(events[0]).toMatchObject({ approvalId: (events[1] as { approvalId: string }).approvalId });
  });

  it('still asks for another step, for the same step in a new run, and after the step ended', async () => {
    const broker = new ApprovalBroker();
    const first = ask(broker);
    broker.decide(broker.pending()[0].id, STEP);
    await first;
    void ask(broker, { nodeId: 'n2' });
    void ask(broker, { runId: 'r2' });
    expect(broker.pending().map((p) => `${p.runId}/${p.nodeId}`)).toEqual(['r1/n2', 'r2/n1']);
    broker.endStep('r1', 'n1');
    void ask(broker);
    expect(broker.pending().map((p) => `${p.runId}/${p.nodeId}`)).toEqual(['r1/n2', 'r2/n1', 'r1/n1']);
  });

  it('Stop still cancels: a pending request and the signal of the run', async () => {
    const broker = new ApprovalBroker();
    const stop = new AbortController();
    const first = ask(broker, { signal: stop.signal });
    broker.decide(broker.pending()[0].id, STEP);
    await first;
    const pending = ask(broker, { nodeId: 'n2', signal: stop.signal });
    broker.cancelRun('r1');
    expect(await pending).toEqual({ decision: 'cancelled' });
    // After Stop the allowance is gone, and an aborted signal is never approved.
    expect(broker.isStepAllowed('r1', 'n1')).toBe(false);
    const again = broker.request(input());
    broker.decide(again.id, STEP);
    stop.abort();
    expect(await ask(broker, { signal: stop.signal })).toEqual({ decision: 'cancelled' });
  });
});

describe('Allow all for this step: every provider path ends in the same place', () => {
  function stepGate(broker: ApprovalBroker, events: NodeEventBody[], o: { readOnly?: boolean } = {}) {
    return createStepGate({
      broker,
      runId: 'r1',
      graphId: 'g',
      nodeId: 'n1',
      nodeTitle: 'Step',
      projectDir: '/p',
      privateFiles: [],
      signal: new AbortController().signal,
      emit: (e) => void events.push(e),
      ...o,
    });
  }

  it('the tool gate (shell commands and file edits) approves through the broker, and logs it', async () => {
    const broker = new ApprovalBroker();
    const events: NodeEventBody[] = [];
    const gate = stepGate(broker, events);
    const first = gate.decide('Bash', { command: 'ls' });
    await vi.waitFor(() => expect(broker.pending()).toHaveLength(1));
    const second = gate.decide('Edit', { file_path: 'a.txt' });
    await vi.waitFor(() => expect(broker.pending()).toHaveLength(2));
    broker.decide(broker.pending()[0].id, STEP);
    expect(await first).toEqual({ allow: true, by: 'user' });
    expect(await second).toEqual({ allow: true, by: 'user' });
    expect(await gate.decide('Write', { file_path: 'b.txt', content: '' })).toEqual({ allow: true, by: 'user' });
    expect(broker.pending()).toEqual([]);
    const decided = events.filter((e) => e.type === 'approval_decided');
    expect(decided).toHaveLength(3);
    expect(decided.every((e) => e.type === 'approval_decided' && e.decision === 'approve' && e.scope === 'step')).toBe(true);
    expect(events.filter((e) => e.type === 'approval_allowed_all')).toHaveLength(1);
    broker.endStep('r1', 'n1');
    void gate.decide('Bash', { command: 'ls' });
    await vi.waitFor(() => expect(broker.pending()).toHaveLength(1));
  });

  it('a read-only step still refuses what changes things', async () => {
    const broker = new ApprovalBroker();
    const gate = stepGate(broker, [], { readOnly: true });
    broker.decide(broker.request(input()).id, STEP);
    expect(await gate.decide('Bash', { command: 'rm x' })).toMatchObject({ allow: false });
  });

  it('Claude: the PreToolUse hook and canUseTool allow without a card', async () => {
    const broker = new ApprovalBroker();
    const ac = new AbortController();
    const gate = toSdkGate(stepGate(broker, []));
    const hook = (id: string) =>
      gate.hooks.PreToolUse[0].hooks[0]({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: id, session_id: 's', transcript_path: '/t', cwd: '/p' } as HookInput, 'tu', { signal: ac.signal });
    const first = hook('t1');
    await vi.waitFor(() => expect(broker.pending()).toHaveLength(1));
    broker.decide(broker.pending()[0].id, STEP);
    expect(await first).toMatchObject({ hookSpecificOutput: { permissionDecision: 'allow' } });
    expect(await hook('t2')).toMatchObject({ hookSpecificOutput: { permissionDecision: 'allow' } });
    const out = await gate.canUseTool('Write', { file_path: 'a' }, { signal: ac.signal, toolUseID: 't3', requestId: 'req' } as Parameters<CanUseTool>[2]);
    expect(out).toMatchObject({ behavior: 'allow' });
    expect(broker.pending()).toEqual([]);
  });

  it('Codex: command and patch requests are accepted without a card', async () => {
    const broker = new ApprovalBroker();
    const gate = stepGate(broker, []);
    const handle = createServerRequestHandler({ gate, cwd: resolve('/', 'p'), platform: 'linux', tools: new Map(), signal: new AbortController().signal, fileChanges: new Map(), onDeclined: () => {}, note: () => {} });
    const command = approvalParams({ command: `/bin/zsh -lc 'npm test'`, cwd: resolve('/', 'p'), actions: [{ type: 'unknown', command: 'npm test' }] });
    const first = handle('item/commandExecution/requestApproval', command);
    await waitFor(() => broker.pending().length === 1);
    broker.decide(broker.pending()[0].id, STEP);
    expect(await first).toEqual({ decision: 'accept' });
    expect(await handle('item/commandExecution/requestApproval', command)).toEqual({ decision: 'accept' });
    expect(broker.pending()).toEqual([]);
  });

  it('the agent loop (Copilot and the other loop providers): a tool call after the press runs without a card', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'allow-all-'));
    const broker = new ApprovalBroker();
    const noShell: RunShell = async () => ({ exitCode: 0, output: '' });
    const { model } = fakeChatModel([[toolCallPart('c1', 'Write', { file_path: 'a.txt', content: 'one' })], [toolCallPart('c2', 'Write', { file_path: 'b.txt', content: 'two' })], [textPart('Done.')]]);
    const gate = createStepGate({ broker, runId: 'r1', graphId: 'g', nodeId: 'n1', nodeTitle: 'Step', projectDir: cwd, privateFiles: [], signal: new AbortController().signal, emit: () => {} });
    const result = runAgentLoop({
      model,
      system: 's',
      messages: [userText('go')],
      tools: builtinTools({ cwd, runShell: noShell, readOnly: false }),
      gate,
      maxRequests: 10,
      signal: new AbortController().signal,
      capMessage: 'cap',
      onText: () => {},
      onToolCall: () => {},
      onToolResult: () => {},
    });
    await vi.waitFor(() => expect(broker.pending()).toHaveLength(1));
    broker.decide(broker.pending()[0].id, STEP);
    expect(await result).toMatchObject({ ok: true, text: 'Done.' });
    expect(readFileSync(join(cwd, 'b.txt'), 'utf8')).toBe('two');
    expect(broker.pending()).toEqual([]);
  });
});

describe('Allow all for this step: the log line', () => {
  it('says what it did', () => {
    expect(ALLOWED_EVERYTHING_LINE).toBe('Allowed everything for the rest of this step');
  });
});
