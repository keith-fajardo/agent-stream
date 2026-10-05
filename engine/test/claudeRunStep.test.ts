import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { HookInput, McpSdkServerConfigWithInstance, Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { emptyGraph, type ApprovalRequest, type GraphNode, type NodeEventBody } from '@agent-stream/shared';
import { ApprovalBroker } from '../src/approvals';
import type { NodeContext } from '../src/executors';
import type { GraphTool } from '../src/providers/types';
import { createClaudeProvider } from '../src/providers/claude';
import type { QueryFn } from '../src/providers/claude/sdk';
import { createStepGate } from '../src/providers/toolGate';
import { signedIn } from './helpers';

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

/** The step gate the App builds for one node. */
function gateFor(c: NodeContext, o: { broker?: ApprovalBroker; privateFiles?: string[] } = {}) {
  return createStepGate({
    broker: o.broker ?? new ApprovalBroker(),
    runId: c.runId,
    graphId: c.graph.id,
    nodeId: c.node.id,
    nodeTitle: c.node.title,
    projectDir: c.cwd,
    privateFiles: o.privateFiles ?? [],
    signal: c.signal,
    emit: c.emit,
  });
}

type StepDeps = { claudePath?: string; queryFn: QueryFn; env?: NodeJS.ProcessEnv; broker?: ApprovalBroker; privateFiles?: string[] };

/** Runs one step on the Claude provider, set up as the extension does: the CLI found and signed in first. */
async function runStep(d: StepDeps, c: NodeContext) {
  const provider = createClaudeProvider({ findClaude: () => ({ ok: true, path: d.claudePath ?? 'claude' }), checkAuth: async () => signedIn, queryFn: d.queryFn, env: d.env });
  await provider.status(); // records the CLI path, as the extension does on sign-in
  return provider.runStep(c, gateFor(c, d));
}

describe('Claude provider: steps', () => {
  it('runs the node through the SDK with subscription-safe options', async () => {
    const { fn, calls } = fake(async function* () {
      yield init();
      yield assistant({ type: 'text', text: 'Working.' }, { type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: 'a.sql' } });
      yield toolResult('tu1', [{ type: 'text', text: 'select 1' }]);
      yield success('Done: wrote b.sql');
    });
    const deps: StepDeps = {
      claudePath: '/opt/homebrew/bin/claude',
      queryFn: fn,
      env: { PATH: '/bin', ANTHROPIC_API_KEY: 'sk-ant-xxx', ANTHROPIC_AUTH_TOKEN: 't' },
    };
    const { c, events } = ctx();
    expect(await runStep(deps, c)).toEqual({
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

  it('serves the step graph tools as the run_graph server and allows them', async () => {
    const calls: unknown[] = [];
    const graphTools: GraphTool[] = [
      { name: 'add_step', description: 'Add a step.', schema: {}, run: async (input) => (calls.push(input), { text: 'Applied: added' }) },
      { name: 'change_step', description: 'Change a step.', schema: {}, run: async () => ({ text: 'n3 already started; the change was not applied.', isError: true }) },
    ];
    const { fn, calls: queries } = fake(async function* () {
      yield init();
      yield success('ok');
    });
    const { c } = ctx();
    expect((await runStep({ queryFn: fn }, { ...c, graphTools })).ok).toBe(true);
    const options = queries[0].options!;
    expect(options.allowedTools).toEqual(['Read', 'Glob', 'Grep', 'mcp__run_graph__*']);
    const server = options.mcpServers!.run_graph as McpSdkServerConfigWithInstance;
    expect(server).toBeDefined();
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.instance.connect(serverSide);
    const client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(clientSide);
    try {
      expect((await client.listTools()).tools.map((t) => t.name)).toEqual(['add_step', 'change_step']);
      expect(await client.callTool({ name: 'add_step', arguments: {} })).toEqual({ content: [{ type: 'text', text: 'Applied: added' }] });
      expect(await client.callTool({ name: 'change_step', arguments: {} })).toEqual({ content: [{ type: 'text', text: 'n3 already started; the change was not applied.' }], isError: true });
    } finally {
      await client.close();
    }
  });

  it('adds no graph server when the step has no graph tools', async () => {
    const { fn, calls } = fake(async function* () {
      yield init();
      yield success('ok');
    });
    await runStep({ queryFn: fn }, { ...ctx().c, graphTools: [] });
    expect(calls[0].options!.mcpServers).toBeUndefined();
    expect(calls[0].options!.allowedTools).toEqual(['Read', 'Glob', 'Grep']);
  });

  it('refuses to continue when the session is not on the subscription', async () => {
    let continued = false;
    const { fn } = fake(async function* () {
      yield init('ANTHROPIC_API_KEY');
      continued = true;
      yield success('should not get here');
    });
    const out = await runStep({ queryFn: fn }, ctx().c);
    expect(out.ok).toBe(false);
    expect(out.error).toContain('"ANTHROPIC_API_KEY"');
    expect(continued).toBe(false);
  });

  it('fails with the SDK’s errors', async () => {
    const { fn } = fake(async function* () {
      yield init();
      yield failure(['boom', 'worse']);
    });
    const out = await runStep({ queryFn: fn }, ctx().c);
    expect(out).toMatchObject({ ok: false, error: 'boom\nworse' });
  });

  it('fails when the session ends without a result', async () => {
    const { fn } = fake(async function* () {
      yield init();
    });
    const out = await runStep({ queryFn: fn }, ctx().c);
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
    const seen: ApprovalRequest[] = [];
    broker.on('changed', (pending: ApprovalRequest[]) => seen.push(...pending));
    const out = await runStep({ broker, queryFn: fn }, c);
    expect(out.ok).toBe(true);
    expect(seen[0].graphId).toBe(c.graph.id);
    expect(hookResult).toMatchObject({ hookSpecificOutput: { permissionDecision: 'allow' } });
    expect(events.map((e) => e.type)).toEqual(['start', 'approval_requested', 'approval_decided']);
  });

  it('also denies reading the legacy variable values file', async () => {
    const legacyValuesFile = resolve('/', 'home', 'me', '.claude-stream', 'values', '0123456789abcdef.json');
    const results: unknown[] = [];
    const { fn } = fake(async function* (options) {
      yield init();
      const hook = options.hooks!.PreToolUse![0].hooks[0];
      const input = { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: legacyValuesFile }, tool_use_id: 'tu9', session_id: 's1', transcript_path: '/t', cwd: '/proj' } as HookInput;
      results.push(await hook(input, 'tu9', { signal: new AbortController().signal }));
      yield success('ok');
    });
    const { c } = ctx();
    expect((await runStep({ queryFn: fn, privateFiles: [legacyValuesFile] }, c)).ok).toBe(true);
    expect(results[0]).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
  });

  it('denies reading the variable values file without asking', async () => {
    const valuesFile = resolve('/', 'home', 'me', '.agent-stream', 'values', '0123456789abcdef.json');
    const broker = new ApprovalBroker();
    const results: unknown[] = [];
    const { fn } = fake(async function* (options) {
      yield init();
      const hook = options.hooks!.PreToolUse![0].hooks[0];
      for (const file_path of [valuesFile, 'a.sql']) {
        const input = { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path }, tool_use_id: 'tu8', session_id: 's1', transcript_path: '/t', cwd: '/proj' } as HookInput;
        results.push(await hook(input, 'tu8', { signal: new AbortController().signal }));
      }
      yield success('ok');
    });
    const { c, events } = ctx();
    expect((await runStep({ broker, queryFn: fn, privateFiles: [valuesFile] }, c)).ok).toBe(true);
    expect(results[0]).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: expect.stringContaining('the variable values file') } });
    expect(results[1]).toEqual({});
    expect(broker.pending()).toEqual([]);
    expect(events.map((e) => e.type)).toEqual(['start']);
  });

  it('reports cancellation when the run is stopped', async () => {
    const ac = new AbortController();
    const { fn } = fake(async function* (options) {
      yield init();
      await new Promise((_, reject) => options.abortController!.signal.addEventListener('abort', () => reject(new Error('aborted'))));
    });
    const pending = runStep({ queryFn: fn }, ctx(ac.signal).c);
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
    const out = await runStep({ queryFn: fn }, ctx(undefined, dir).c);
    expect(out).toMatchObject({ ok: false, error: expect.stringContaining('sets CLAUDE_CODE_USE_BEDROCK') });
    expect(calls).toHaveLength(0);
  });

  it('fails when a result arrives without the session reporting how it authenticated', async () => {
    const { fn } = fake(async function* () {
      yield success('unverified');
    });
    const out = await runStep({ queryFn: fn }, ctx().c);
    expect(out).toEqual({ ok: false, output: '', error: 'The Claude session did not report how it authenticated.' });
  });

  it('refuses to run before the CLI has been found', async () => {
    const { fn: queryFn, calls } = fake(async function* () {
      yield init();
      yield success('should not run');
    });
    const p = createClaudeProvider({ findClaude: () => ({ ok: false, error: 'Claude Code not found.' }), queryFn });
    const { c } = ctx();
    expect(await p.runStep(c, gateFor(c))).toEqual({ ok: false, output: '', error: 'Agent Stream has not checked for Claude Code yet.' });
    await p.status();
    expect(await p.runStep(c, gateFor(c))).toEqual({ ok: false, output: '', error: 'Claude Code not found.' });
    expect(calls).toHaveLength(0);
  });

  it('reports status through the CLI it found', async () => {
    const p = createClaudeProvider({ findClaude: () => ({ ok: true, path: '/c' }), checkAuth: async (path) => ({ provider: 'claude', ok: path === '/c', label: 'Claude Max' }) });
    expect(await p.status()).toEqual({ provider: 'claude', ok: true, label: 'Claude Max' });
    expect(p.id).toBe('claude');
    expect(p.name).toBe('Claude');
  });

  it('reports a missing CLI as not signed in', async () => {
    const p = createClaudeProvider({ findClaude: () => ({ ok: false, error: 'Claude Code not found.' }) });
    expect(await p.status()).toEqual({ provider: 'claude', ok: false, label: 'not signed in', error: 'Claude Code not found.' });
  });

  it('names a folder whose .claude/settings.json reroutes Claude', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cs-'));
    mkdirSync(join(dir, '.claude'));
    writeFileSync(join(dir, '.claude', 'settings.json'), JSON.stringify({ apiKeyHelper: 'x' }));
    expect(createClaudeProvider({ findClaude: () => ({ ok: true, path: '/c' }) }).folderProblem?.(dir)).toMatch(/apiKeyHelper/);
    expect(createClaudeProvider({ findClaude: () => ({ ok: true, path: '/c' }) }).folderProblem?.(mkdtempSync(join(tmpdir(), 'cs-')))).toBeUndefined();
  });
});

describe('Claude provider: the model and effort a step runs with', () => {
  it('logs them in the start event as they are sent, an effort Claude lacks left out', async () => {
    const script = () =>
      fake(async function* () {
        yield init();
        yield success('ok');
      });
    const kept = script();
    const a = ctx();
    await runStep({ queryFn: kept.fn }, { ...a.c, model: 'opus', effort: 'high' });
    expect(a.events[0]).toEqual({ type: 'start', kind: 'agent', cwd: '/proj', prompt: 'FULL PROMPT', model: 'opus', effort: 'high' });
    expect(kept.calls[0].options).toMatchObject({ model: 'opus', effort: 'high' });
    const dropped = script();
    const b = ctx();
    await runStep({ queryFn: dropped.fn }, { ...b.c, model: 'opus', effort: 'ultra' });
    expect(b.events[0]).toEqual({ type: 'start', kind: 'agent', cwd: '/proj', prompt: 'FULL PROMPT', model: 'opus' });
    expect(dropped.calls[0].options).not.toHaveProperty('effort');
  });
});
