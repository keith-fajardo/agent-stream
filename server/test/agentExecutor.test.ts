import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { HookInput, Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { emptyGraph, type ApprovalRequest, type GraphNode, type NodeEventBody } from '@claude-stream/shared';
import { createAgentExecutor } from '../src/agentExecutor';
import { ApprovalBroker } from '../src/approvals';
import type { NodeContext } from '../src/executors';
import type { QueryFn } from '../src/sdk';

const msg = (m: object) => m as unknown as SDKMessage;
const init = (apiKeySource = 'none') => msg({ type: 'system', subtype: 'init', apiKeySource, session_id: 's1' });
const assistant = (...content: object[]) => msg({ type: 'assistant', parent_tool_use_id: null, message: { content }, session_id: 's1' });
const toolResult = (tool_use_id: string, content: unknown, is_error = false) =>
  msg({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id, content, is_error }] }, session_id: 's1' });
const usage = { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 40 };
const success = (result: string) =>
  msg({ type: 'result', subtype: 'success', is_error: false, result, num_turns: 2, total_cost_usd: 0.12, usage, session_id: 's1' });
const failure = (errors: string[]) =>
  msg({ type: 'result', subtype: 'error_during_execution', is_error: true, errors, num_turns: 1, total_cost_usd: 0, usage, session_id: 's1' });

function fake(script: (options: Options) => AsyncGenerator<SDKMessage>) {
  const calls: { prompt: string; options?: Options }[] = [];
  const fn: QueryFn = (params) => {
    calls.push(params);
    return script(params.options ?? {});
  };
  return { fn, calls };
}

function ctx(signal: AbortSignal = new AbortController().signal, cwd = '/proj') {
  const events: NodeEventBody[] = [];
  const node: GraphNode = { id: 'n2', title: 'Write SQL', kind: 'agent', prompt: 'p', createdBy: 'user', updatedBy: 'user', updatedAt: 't' };
  const c: NodeContext = { runId: 'r1', graph: emptyGraph('g', 'G', 't'), node, prompt: 'FULL PROMPT', cwd, signal, emit: (e) => events.push(e) };
  return { c, events };
}

describe('agent executor', () => {
  it('runs the node through the SDK with subscription-safe options', async () => {
    const { fn, calls } = fake(async function* () {
      yield init();
      yield assistant({ type: 'text', text: 'Working.' }, { type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: 'a.sql' } });
      yield toolResult('tu1', [{ type: 'text', text: 'select 1' }]);
      yield success('Done: wrote b.sql');
    });
    const exec = createAgentExecutor({
      claudePath: '/opt/homebrew/bin/claude',
      broker: new ApprovalBroker(),
      queryFn: fn,
      env: { PATH: '/bin', ANTHROPIC_API_KEY: 'sk-ant-xxx', ANTHROPIC_AUTH_TOKEN: 't' },
    });
    const { c, events } = ctx();
    expect(await exec(c)).toEqual({
      ok: true,
      output: 'Done: wrote b.sql',
      usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 40, costUsd: 0.12, turns: 2 },
    });
    expect(calls[0].prompt).toBe('FULL PROMPT');
    const options = calls[0].options!;
    expect(options).toMatchObject({
      cwd: '/proj',
      pathToClaudeCodeExecutable: '/opt/homebrew/bin/claude',
      permissionMode: 'default',
      settingSources: ['project'],
      allowedTools: ['Read', 'Glob', 'Grep'],
      disallowedTools: ['Agent', 'AskUserQuestion'],
    });
    expect(options.env).toEqual({ PATH: '/bin' });
    expect(options.hooks?.PreToolUse).toHaveLength(1);
    expect(typeof options.canUseTool).toBe('function');
    expect(events).toEqual([
      { type: 'start', kind: 'agent', cwd: '/proj', prompt: 'FULL PROMPT' },
      { type: 'text', text: 'Working.' },
      { type: 'tool_call', toolUseId: 'tu1', name: 'Read', input: { file_path: 'a.sql' } },
      { type: 'tool_result', toolUseId: 'tu1', content: 'select 1', isError: false },
    ]);
  });

  it('refuses to continue when the session is not on the subscription', async () => {
    let continued = false;
    const { fn } = fake(async function* () {
      yield init('ANTHROPIC_API_KEY');
      continued = true;
      yield success('should not get here');
    });
    const out = await createAgentExecutor({ claudePath: 'claude', broker: new ApprovalBroker(), queryFn: fn })(ctx().c);
    expect(out.ok).toBe(false);
    expect(out.error).toContain('"ANTHROPIC_API_KEY"');
    expect(continued).toBe(false);
  });

  it('fails with the SDK’s errors', async () => {
    const { fn } = fake(async function* () {
      yield init();
      yield failure(['boom', 'worse']);
    });
    const out = await createAgentExecutor({ claudePath: 'claude', broker: new ApprovalBroker(), queryFn: fn })(ctx().c);
    expect(out).toMatchObject({ ok: false, error: 'boom\nworse' });
  });

  it('fails when the session ends without a result', async () => {
    const { fn } = fake(async function* () {
      yield init();
    });
    const out = await createAgentExecutor({ claudePath: 'claude', broker: new ApprovalBroker(), queryFn: fn })(ctx().c);
    expect(out).toMatchObject({ ok: false, error: 'The agent session ended without a result.' });
  });

  it('routes non-read-only tool calls through the approval queue', async () => {
    const broker = new ApprovalBroker();
    broker.on('changed', (pending: ApprovalRequest[]) => {
      for (const p of pending) queueMicrotask(() => broker.decide(p.id, { decision: 'approve' }));
    });
    let hookResult: unknown;
    const { fn } = fake(async function* (options) {
      yield init();
      const hook = options.hooks!.PreToolUse![0].hooks[0];
      const input = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'dbt build' }, tool_use_id: 'tu7', session_id: 's1', transcript_path: '/t', cwd: '/proj' } as HookInput;
      hookResult = await hook(input, 'tu7', { signal: new AbortController().signal });
      yield success('ok');
    });
    const { c, events } = ctx();
    const out = await createAgentExecutor({ claudePath: 'claude', broker, queryFn: fn })(c);
    expect(out.ok).toBe(true);
    expect(hookResult).toMatchObject({ hookSpecificOutput: { permissionDecision: 'allow' } });
    expect(events.map((e) => e.type)).toEqual(['start', 'approval_requested', 'approval_decided']);
  });

  it('reports cancellation when the run is stopped', async () => {
    const ac = new AbortController();
    const { fn } = fake(async function* (options) {
      yield init();
      await new Promise((_, reject) => options.abortController!.signal.addEventListener('abort', () => reject(new Error('aborted'))));
    });
    const pending = createAgentExecutor({ claudePath: 'claude', broker: new ApprovalBroker(), queryFn: fn })(ctx(ac.signal).c);
    await new Promise((r) => setTimeout(r, 10));
    ac.abort();
    expect(await pending).toMatchObject({ ok: false, error: 'cancelled' });
  });

  it('does not start a session when the project settings would leave the subscription', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'proj-'));
    mkdirSync(join(dir, '.claude'));
    writeFileSync(join(dir, '.claude', 'settings.json'), JSON.stringify({ env: { CLAUDE_CODE_USE_BEDROCK: '1' } }));
    const { fn, calls } = fake(async function* () {
      yield init();
      yield success('should not run');
    });
    const out = await createAgentExecutor({ claudePath: 'claude', broker: new ApprovalBroker(), queryFn: fn })(ctx(undefined, dir).c);
    expect(out).toMatchObject({ ok: false, error: expect.stringContaining('sets CLAUDE_CODE_USE_BEDROCK') });
    expect(calls).toHaveLength(0);
  });

  it('fails when a result arrives without the session reporting how it authenticated', async () => {
    const { fn } = fake(async function* () {
      yield success('unverified');
    });
    const out = await createAgentExecutor({ claudePath: 'claude', broker: new ApprovalBroker(), queryFn: fn })(ctx().c);
    expect(out).toEqual({ ok: false, output: '', error: 'The Claude session did not report how it authenticated.' });
  });
});
