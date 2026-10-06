import { mkdirSync, writeFileSync } from 'node:fs';
import { join, parse, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { HookInput, McpSdkServerConfigWithInstance, Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { GraphStore } from '../src/graphStore';
import { Planner, PLANNER_APPEND } from '../src/planner';
import { graphTools } from '../src/plannerTools';
import { createClaudeProvider } from '../src/providers/claude';
import { authSourceError, UNVERIFIED_AUTH } from '../src/providers/claude/auth';
import type { QueryFn } from '../src/providers/claude/sdk';
import { couldNotAsk, createPlannerGate } from '../src/providers/toolGate';
import type { PlannerEvent, PlannerTurn } from '../src/providers/types';
import { RunStore } from '../src/runStore';
import { SessionStore } from '../src/sessionStore';
import { fixedClock, outsideGit, signedIn, tmpProject } from './helpers';

const msg = (m: object) => m as unknown as SDKMessage;
const VALUES_FILE = resolve('/', 'home', 'me', '.agent-stream', 'values', '0123456789abcdef.json');
const init = (apiKeySource = 'none') => msg({ type: 'system', subtype: 'init', apiKeySource, session_id: 'sess-1' });
const say = (...content: object[]) => msg({ type: 'assistant', parent_tool_use_id: null, message: { content }, session_id: 'sess-1' });
const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
const done = () => msg({ type: 'result', subtype: 'success', is_error: false, result: 'ok', num_turns: 1, total_cost_usd: 0, usage, session_id: 'sess-1' });
// What Claude Code 2.1.287 actually does for a missing session: one error result
// with no system/init message, then the SDK throws.
const missingSession = (sessionId?: string) =>
  msg({
    type: 'result',
    subtype: 'error_during_execution',
    is_error: true,
    errors: [`No conversation found with session ID: ${sessionId}`],
    num_turns: 0,
    total_cost_usd: 0,
    usage,
    session_id: sessionId,
  });

async function setup(script: (options: Options) => AsyncGenerator<SDKMessage>) {
  const paths = tmpProject();
  const graphStore = new GraphStore(paths, fixedClock());
  const runStore = new RunStore(paths);
  const graphId = graphStore.create('G').id;
  const calls: { prompt: string; options: Options }[] = [];
  const queryFn: QueryFn = ({ prompt, options }) => {
    calls.push({ prompt: prompt as string, options: options! });
    return script(options!);
  };
  const provider = createClaudeProvider({
    findClaude: () => ({ ok: true, path: '/usr/local/bin/claude' }),
    checkAuth: async () => signedIn,
    queryFn,
    env: { PATH: '/bin', ANTHROPIC_API_KEY: 'sk' },
  });
  await provider.status(); // records the CLI path, as the extension does on sign-in
  const events: PlannerEvent[] = [];
  const turn = (over: Partial<PlannerTurn> = {}): PlannerTurn => ({
    prompt: 'hi',
    systemAppend: PLANNER_APPEND,
    cwd: paths.root,
    tools: graphTools({ graphStore, runStore, graphId, source: { kind: 'planner', sessionId: 'default' }, requestRun: () => null, checkout: outsideGit(paths.root) }),
    gate: createPlannerGate({ projectDir: paths.root, privateFiles: [VALUES_FILE], graphToolNames: new Set(['add_node']) }),
    signal: new AbortController().signal,
    onEvent: (e) => events.push(e),
    transcript: { load: () => undefined, save: () => {} },
    ...over,
  });
  return { paths, graphStore, runStore, graphId, provider, calls, events, turn };
}

/** Calls the PreToolUse hook the turn gave the SDK, as Claude Code would before a tool runs. */
function preToolUse(options: Options, cwd: string) {
  const matchers = options.hooks?.PreToolUse ?? [];
  expect(matchers).toHaveLength(1);
  return (tool_name: string, tool_input: unknown) =>
    matchers[0].hooks[0]({ hook_event_name: 'PreToolUse', tool_name, tool_input, tool_use_id: 't', session_id: 's', transcript_path: '/t', cwd } as HookInput, 't', {
      signal: new AbortController().signal,
    });
}

describe('Claude provider: planner turns', () => {
  it('runs a turn with read-only tools plus graph tools and reports what the model said', async () => {
    const s = await setup(async function* () {
      yield init();
      yield say({ type: 'text', text: 'Here is a plan.' }, { type: 'tool_use', id: 't1', name: 'mcp__graph__add_node', input: { kind: 'agent', title: 'Plan' } });
      yield done();
    });
    expect(await s.provider.planTurn(s.turn({ prompt: 'Plan a parity test' }))).toEqual({ ok: true, sessionId: 'sess-1' });
    const o = s.calls[0].options;
    expect(o).toMatchObject({
      cwd: s.paths.root,
      pathToClaudeCodeExecutable: '/usr/local/bin/claude',
      tools: ['Read', 'Glob', 'Grep'],
      allowedTools: ['Read', 'Glob', 'Grep', 'mcp__graph__*'],
      permissionMode: 'dontAsk',
      settingSources: ['project'],
      systemPrompt: { type: 'preset', preset: 'claude_code', append: PLANNER_APPEND },
    });
    expect(o.env).toEqual({ PATH: '/bin' });
    expect(o.resume).toBeUndefined();
    expect(o.mcpServers?.graph).toBeDefined();
    expect(s.calls[0].prompt).toBe('Plan a parity test');
    expect(s.events).toEqual([
      { type: 'text', text: 'Here is a plan.' },
      { type: 'tool', name: 'add_node', input: { kind: 'agent', title: 'Plan' } },
    ]);
  });

  it("reports a turn the user stopped as cancelled with its session, so the conversation can continue", async () => {
    const stop = new AbortController();
    const s = await setup(async function* (options) {
      yield init();
      yield say({ type: 'text', text: 'Working.' });
      stop.abort();
      expect(options.abortController?.signal.aborted).toBe(true);
      throw Object.assign(new Error('Claude Code process aborted by user'), { name: 'AbortError' });
    });
    expect(await s.provider.planTurn(s.turn({ signal: stop.signal }))).toEqual({ ok: true, sessionId: 'sess-1', error: 'cancelled' });
  });

  it('still throws a failure that was not a stop', async () => {
    const s = await setup(async function* () {
      yield init();
      throw new Error('boom');
    });
    await expect(s.provider.planTurn(s.turn())).rejects.toThrow('boom');
  });

  it('serves the graph tools to Claude Code through the graph MCP server', async () => {
    const s = await setup(async function* () {
      yield init();
      yield done();
    });
    await s.provider.planTurn(s.turn());
    const server = s.calls[0].options.mcpServers!.graph as McpSdkServerConfigWithInstance;
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.instance.connect(serverSide);
    const client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(clientSide);
    try {
      expect((await client.listTools()).tools.map((t) => t.name)).toEqual(s.turn().tools.map((t) => t.name));
      expect(await client.callTool({ name: 'add_node', arguments: { kind: 'command', title: 'Build', command: 'make' } })).toEqual({ content: [{ type: 'text', text: 'Added n1.' }] });
      expect(await client.callTool({ name: 'connect', arguments: { from: 'n1', to: 'n9' } })).toEqual({ content: [{ type: 'text', text: 'node n9 does not exist' }], isError: true });
      expect(s.graphStore.get(s.graphId).nodes.map((n) => [n.id, n.createdBy])).toEqual([['n1', 'agent']]);
    } finally {
      await client.close();
    }
  });

  it('reports only top-level text and graph tool calls', async () => {
    const s = await setup(async function* () {
      yield init();
      yield say({ type: 'text', text: '  ' }, { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'a.sql' } });
      yield msg({ type: 'assistant', parent_tool_use_id: 't0', message: { content: [{ type: 'text', text: 'from a subagent' }] }, session_id: 'sess-1' });
      yield done();
    });
    expect(await s.provider.planTurn(s.turn())).toEqual({ ok: true, sessionId: 'sess-1' });
    expect(s.events).toEqual([]);
  });

  it('continues the conversation it is given', async () => {
    const s = await setup(async function* () {
      yield init();
      yield done();
    });
    await s.provider.planTurn(s.turn({ resume: 'sess-1', prompt: 'second' }));
    expect(s.calls[0].options.resume).toBe('sess-1');
    expect(s.calls[0].prompt).toBe('second');
  });

  it('stops when the session is not on the subscription', async () => {
    const s = await setup(async function* () {
      yield init('apiKeyHelper');
      yield say({ type: 'text', text: 'should not appear' });
      yield done();
    });
    const r = await s.provider.planTurn(s.turn());
    expect(r).toEqual({ ok: false, error: authSourceError('apiKeyHelper') });
    expect(r.error).toContain('"apiKeyHelper"');
    expect(s.events).toEqual([]);
    expect(s.calls[0].options.abortController?.signal.aborted).toBe(true);
  });

  it('lets a failing query throw, so the planner can reset the session', async () => {
    const s = await setup(async function* () {
      throw new Error('No conversation found');
    });
    await expect(s.provider.planTurn(s.turn({ resume: 'sess-1' }))).rejects.toThrow('No conversation found');
  });

  it('reports a session that no longer exists, as the real CLI reports it', async () => {
    const s = await setup(async function* (options) {
      yield missingSession(options.resume);
      throw new Error(`Claude Code returned an error result: No conversation found with session ID: ${options.resume}`);
    });
    expect(await s.provider.planTurn(s.turn({ resume: 'sess-1' }))).toEqual({ ok: false, error: 'No conversation found with session ID: sess-1', resumeFailed: true });
  });

  it('shows the real error when a session fails before it starts', async () => {
    const s = await setup(async function* () {
      yield missingSession('x');
    });
    expect(await s.provider.planTurn(s.turn())).toEqual({ ok: false, error: 'No conversation found with session ID: x' });
  });

  it('stops when a result arrives without the session reporting how it authenticated', async () => {
    const s = await setup(async function* () {
      yield say({ type: 'text', text: 'unverified reply' });
      yield done();
    });
    expect(await s.provider.planTurn(s.turn())).toEqual({ ok: false, error: UNVERIFIED_AUTH });
    expect(UNVERIFIED_AUTH).toBe('The Claude session did not report how it authenticated.');
    expect(s.events).toEqual([{ type: 'text', text: 'unverified reply' }]);
  });

  it('reports a model error after the session started as a turn that ran', async () => {
    const failed = await setup(async function* () {
      yield init();
      yield msg({ type: 'result', subtype: 'error_max_turns', is_error: true, errors: ['boom', 'worse'], num_turns: 9, total_cost_usd: 0, usage, session_id: 'sess-1' });
    });
    expect(await failed.provider.planTurn(failed.turn())).toEqual({ ok: true, sessionId: 'sess-1', error: 'boom\nworse' });
    const reported = await setup(async function* () {
      yield init();
      yield msg({ type: 'result', subtype: 'success', is_error: true, result: '', num_turns: 1, total_cost_usd: 0, usage, session_id: 'sess-1' });
    });
    expect(await reported.provider.planTurn(reported.turn())).toEqual({ ok: true, sessionId: 'sess-1', error: 'The planner reported an error.' });
  });

  it('stops the session when the turn is aborted', async () => {
    const ac = new AbortController();
    const s = await setup(async function* (options) {
      yield init();
      ac.abort();
      expect(options.abortController?.signal.aborted).toBe(true);
      yield done();
    });
    expect(await s.provider.planTurn(s.turn({ signal: ac.signal }))).toEqual({ ok: true, sessionId: 'sess-1' });
    expect(s.calls[0].options.abortController?.signal.aborted).toBe(true);
  });

  it('refuses to start before the CLI has been found', async () => {
    const p = createClaudeProvider({ findClaude: () => ({ ok: false, error: 'Claude Code not found.' }), queryFn: () => { throw new Error('should not run'); } });
    await p.status();
    const s = await setup(async function* () {});
    expect(await p.planTurn(s.turn())).toEqual({ ok: false, error: 'Claude Code not found.' });
  });

  it('denies reading the variable values file through a PreToolUse hook', async () => {
    const s = await setup(async function* () {
      yield init();
      yield done();
    });
    await s.provider.planTurn(s.turn());
    const run = preToolUse(s.calls[0].options, s.paths.root);
    expect(await run('Read', { file_path: VALUES_FILE })).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: "Variable values are private to this machine; Agent Stream doesn't let Claude read the variable values file.",
      },
    });
    expect(await run('Grep', { pattern: 'x', path: parse(VALUES_FILE).root, glob: '*' })).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
    expect(await run('Glob', { pattern: '**/*', path: resolve('/', 'home', 'me', '.agent-stream') })).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
    expect(await run('Grep', { pattern: 'x', path: join(s.paths.root, 'src') })).toEqual({});
    expect(await run('Read', { file_path: join(s.paths.root, '.agent-stream', 'variables.local.json') })).toEqual({});
    expect(await run('Read', { file_path: 'models/a.sql' })).toEqual({});
  });

  it('denies the tool when the privacy check throws', async () => {
    const s = await setup(async function* () {
      yield init();
      yield done();
    });
    const gate = createPlannerGate({ projectDir: s.paths.root, privateFiles: [VALUES_FILE], graphToolNames: new Set() });
    const error = new Error('disk unreadable');
    await s.provider.planTurn(
      s.turn({
        gate: {
          ...gate,
          privacy: () => {
            throw error;
          },
        },
      }),
    );
    const run = preToolUse(s.calls[0].options, s.paths.root);
    expect(await run('Read', { file_path: 'models/a.sql' })).toEqual({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: couldNotAsk(error) },
    });
  });
});

describe('Claude provider with the planner', () => {
  it('does not start a session when the project settings would leave the subscription', async () => {
    const paths = tmpProject();
    const graphStore = new GraphStore(paths, fixedClock());
    const sessions = new SessionStore(paths, fixedClock());
    const sessionId = sessions.ensureDefault().id;
    const chatLog = sessions.chatLog(sessionId);
    const graphId = graphStore.create('G').id;
    const calls: unknown[] = [];
    const provider = createClaudeProvider({
      findClaude: () => ({ ok: true, path: '/usr/local/bin/claude' }),
      checkAuth: async () => signedIn,
      queryFn: (params) => {
        calls.push(params);
        return (async function* () {
          yield init();
          yield done();
        })();
      },
    });
    await provider.status();
    const planner = new Planner({
      graphStore,
      runStore: new RunStore(paths),
      sessions,
      projectDir: paths.root,
      provider: () => provider,
      privateFiles: () => [VALUES_FILE],
      requestRun: () => null,
      checkout: outsideGit(paths.root),
      clock: fixedClock(),
    });
    const busy: boolean[] = [];
    planner.on('busy', (_sessionId: string, _graphId: string, b: boolean) => busy.push(b));
    mkdirSync(join(paths.root, '.claude'));
    writeFileSync(join(paths.root, '.claude', 'settings.json'), JSON.stringify({ apiKeyHelper: 'get-key.sh' }));
    await planner.send(sessionId, graphId, 'hi');
    expect(calls).toHaveLength(0);
    const chat = chatLog.read(graphId);
    expect(chat.map((e) => e.role)).toEqual(['user', 'error']);
    expect(chat[1].text).toContain('sets apiKeyHelper');
    expect(busy).toEqual([true, false]);
  });
});
