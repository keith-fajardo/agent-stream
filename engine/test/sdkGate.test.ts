import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CanUseTool, HookInput, HookJSONOutput } from '@anthropic-ai/claude-agent-sdk';
import type { NodeEventBody } from '@agent-stream/shared';
import { ApprovalBroker } from '../src/approvals';
import { toSdkGate } from '../src/providers/claude/sdkGate';
import { createStepGate, type StepGateOptions } from '../src/providers/toolGate';

const makeApprovalGate = (options: StepGateOptions) => toSdkGate(createStepGate(options));

const preToolUse = (tool_name: string, tool_input: unknown, tool_use_id = 'tu1') =>
  ({ hook_event_name: 'PreToolUse', tool_name, tool_input, tool_use_id, session_id: 's', transcript_path: '/t', cwd: '/p' }) as HookInput;
const valuesFile = resolve('/', 'home', 'me', '.agent-stream', 'values', '0123456789abcdef.json');

function setup() {
  const broker = new ApprovalBroker();
  const events: NodeEventBody[] = [];
  const ac = new AbortController();
  const gate = makeApprovalGate({ broker, runId: 'r1', graphId: 'g', nodeId: 'n1', nodeTitle: 'Step', signal: ac.signal, projectDir: '/p', privateFiles: [valuesFile], emit: (e) => events.push(e) });
  const hook = (input: HookInput) => gate.hooks.PreToolUse[0].hooks[0](input, 'tu', { signal: ac.signal });
  const canUse = (name: string, input: Record<string, unknown>, toolUseID: string) =>
    gate.canUseTool(name, input, { signal: ac.signal, toolUseID, requestId: 'req' } as Parameters<CanUseTool>[2]);
  return { broker, events, ac, gate, hook, canUse };
}

const decisionOf = (out: HookJSONOutput) =>
  (out as { hookSpecificOutput?: { hookEventName?: string; permissionDecision?: string; permissionDecisionReason?: string } }).hookSpecificOutput;

describe('approval gate', () => {
  it('denies reading the private values file without asking, and lets other reads pass', async () => {
    const { broker, hook, events } = setup();
    const out = await hook(preToolUse('Read', { file_path: valuesFile }));
    expect(decisionOf(out)).toEqual({
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: "Variable values are private to this machine; Agent Stream doesn't let Claude read the variable values file.",
    });
    expect(decisionOf(await hook(preToolUse('Grep', { pattern: 'x', path: valuesFile })))?.permissionDecision).toBe('deny');
    expect(decisionOf(await hook(preToolUse('Grep', { pattern: 'x', path: '/', glob: '*' })))?.permissionDecision).toBe('deny');
    expect(decisionOf(await hook(preToolUse('Glob', { pattern: '**/*.json', path: resolve('/', 'home', 'me') })))?.permissionDecision).toBe('deny');
    expect(broker.pending()).toEqual([]);
    expect(events).toEqual([]);
    expect(await hook(preToolUse('Read', { file_path: '/p/.agent-stream/graphs/a.json' }))).toEqual({});
    expect(await hook(preToolUse('Read', { file_path: '/p/.agent-stream/variables.local.json' }))).toEqual({});
    expect(await hook(preToolUse('Grep', { pattern: 'x', path: '/p/src' }))).toEqual({});
  });

  it('lets read-only tools through without asking', async () => {
    const { broker, hook, events } = setup();
    expect(await hook(preToolUse('Read', { file_path: 'a.sql' }))).toEqual({});
    expect(await hook(preToolUse('Grep', { pattern: 'x' }))).toEqual({});
    expect(broker.pending()).toEqual([]);
    expect(events).toEqual([]);
  });

  it('asks before any other tool and allows it on approve', async () => {
    const { broker, hook, events } = setup();
    const out = hook(preToolUse('Bash', { command: 'dbt build' }));
    const [pending] = broker.pending();
    expect(pending).toMatchObject({ runId: 'r1', graphId: 'g', nodeId: 'n1', nodeTitle: 'Step', toolName: 'Bash', input: { command: 'dbt build' } });
    broker.decide(pending.id, { decision: 'approve' });
    expect(decisionOf(await out)).toMatchObject({ hookEventName: 'PreToolUse', permissionDecision: 'allow' });
    expect(events).toEqual([
      { type: 'approval_requested', approvalId: pending.id, toolName: 'Bash', input: { command: 'dbt build' } },
      { type: 'approval_decided', approvalId: pending.id, decision: 'approve' },
    ]);
  });

  it('denies with the note', async () => {
    const { broker, hook, events } = setup();
    const out = hook(preToolUse('Write', { file_path: 'x.sql', content: '' }));
    const [pending] = broker.pending();
    broker.decide(pending.id, { decision: 'deny', note: 'use the dev target' });
    expect(decisionOf(await out)).toMatchObject({ permissionDecision: 'deny', permissionDecisionReason: 'Denied by the user: use the dev target' });
    expect(events.at(-1)).toEqual({ type: 'approval_decided', approvalId: pending.id, decision: 'deny', note: 'use the dev target' });
  });

  it('denies when the run is stopped', async () => {
    const { ac, hook } = setup();
    const out = hook(preToolUse('Bash', { command: 'sleep 100' }));
    ac.abort();
    expect(decisionOf(await out)).toMatchObject({ permissionDecision: 'deny', permissionDecisionReason: 'The run was stopped.' });
  });

  it('lets canUseTool allow a call the hook already approved, and asks otherwise', async () => {
    const { broker, hook, canUse } = setup();
    const out = hook(preToolUse('Edit', { file_path: 'x' }, 'tu9'));
    broker.decide(broker.pending()[0].id, { decision: 'approve' });
    await out;
    expect(await canUse('Edit', { file_path: 'x' }, 'tu9')).toEqual({ behavior: 'allow', updatedInput: { file_path: 'x' } });
    expect(broker.pending()).toEqual([]);
    const second = canUse('Bash', { command: 'rm -rf build' }, 'tu10');
    broker.decide(broker.pending()[0].id, { decision: 'deny' });
    expect(await second).toEqual({ behavior: 'deny', message: 'Denied by the user.' });
  });

  it('gates every tool with a day-long hook timeout', () => {
    const { gate } = setup();
    expect(gate.hooks.PreToolUse).toHaveLength(1);
    expect(gate.hooks.PreToolUse[0].matcher).toBeUndefined();
    expect(gate.hooks.PreToolUse[0].timeout).toBe(86400);
  });

  it('denies when emitting the log event throws', async () => {
    const broker = new ApprovalBroker();
    const ac = new AbortController();
    const gate = makeApprovalGate({
      broker,
      runId: 'r1',
      graphId: 'g',
      nodeId: 'n1',
      nodeTitle: 'Step',
      projectDir: '/p',
      privateFiles: [],
      signal: ac.signal,
      emit: () => {
        throw new Error('log service down');
      },
    });
    const hook = (input: HookInput) => gate.hooks.PreToolUse[0].hooks[0](input, 'tu', { signal: ac.signal });
    const out = hook(preToolUse('Bash', { command: 'ls' }));
    const decision = decisionOf(await out);
    expect(decision?.permissionDecision).toBe('deny');
    expect(decision?.permissionDecisionReason).toContain('could not ask for approval');
    expect(broker.pending()).toEqual([]);
  });

  it('denies when the brokers listeners throw', async () => {
    const broker = new ApprovalBroker();
    broker.on('changed', () => {
      throw new Error('ws down');
    });
    const ac = new AbortController();
    const gate = makeApprovalGate({ broker, runId: 'r1', graphId: 'g', nodeId: 'n1', nodeTitle: 'Step', signal: ac.signal, projectDir: '/p', privateFiles: [], emit: () => {} });
    const hook = (input: HookInput) => gate.hooks.PreToolUse[0].hooks[0](input, 'tu', { signal: ac.signal });
    const out = hook(preToolUse('Bash', { command: 'ls' }));
    const decision = decisionOf(await out);
    expect(decision?.permissionDecision).toBe('deny');
    expect(decision?.permissionDecisionReason).toContain('could not ask for approval');
    expect(broker.pending()).toEqual([]);
  });

  it('cancels the approval when the SDK withdraws the request', async () => {
    const broker = new ApprovalBroker();
    const ac = new AbortController();
    const gate = makeApprovalGate({ broker, runId: 'r1', graphId: 'g', nodeId: 'n1', nodeTitle: 'Step', signal: ac.signal, projectDir: '/p', privateFiles: [], emit: () => {} });
    const sdkAc = new AbortController();
    const preToolUseFunc = gate.hooks.PreToolUse[0].hooks[0];
    const out = preToolUseFunc(preToolUse('Bash', { command: 'ls' }), 'tu', { signal: sdkAc.signal });
    sdkAc.abort();
    const decision = decisionOf(await out);
    expect(decision?.permissionDecision).toBe('deny');
    expect(decision?.permissionDecisionReason).toBe('The approval request expired or was withdrawn.');
    expect(broker.pending()).toEqual([]);
  });

  it('cancels canUseTool when SDK signal aborts', async () => {
    const broker = new ApprovalBroker();
    const ac = new AbortController();
    const gate = makeApprovalGate({ broker, runId: 'r1', graphId: 'g', nodeId: 'n1', nodeTitle: 'Step', signal: ac.signal, projectDir: '/p', privateFiles: [], emit: () => {} });
    const sdkAc = new AbortController();
    const out = gate.canUseTool('Bash', { command: 'rm' }, { signal: sdkAc.signal, toolUseID: 'tu1', requestId: 'req' } as Parameters<CanUseTool>[2]);
    sdkAc.abort();
    const result = await out;
    expect((result as any).behavior).toBe('deny');
    expect((result as any).message).toBe('The approval request expired or was withdrawn.');
    expect(broker.pending()).toEqual([]);
  });
});
