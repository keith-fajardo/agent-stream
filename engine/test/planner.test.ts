import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { ChatLog } from '../src/chatLog';
import { GraphStore } from '../src/graphStore';
import { Planner, PLANNER_APPEND, describeOp } from '../src/planner';
import { RunStore } from '../src/runStore';
import type { QueryFn } from '../src/sdk';
import { fixedClock, tmpProject } from './helpers';

const msg = (m: object) => m as unknown as SDKMessage;
const init = (apiKeySource = 'none') => msg({ type: 'system', subtype: 'init', apiKeySource, session_id: 'sess-1' });
const say = (...content: object[]) => msg({ type: 'assistant', parent_tool_use_id: null, message: { content }, session_id: 'sess-1' });
const done = () =>
  msg({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'ok',
    num_turns: 1,
    total_cost_usd: 0,
    usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    session_id: 'sess-1',
  });

function setup(script: (options: Options) => AsyncGenerator<SDKMessage>) {
  const paths = tmpProject();
  const graphStore = new GraphStore(paths, fixedClock());
  const runStore = new RunStore(paths);
  const chatLog = new ChatLog(paths);
  const graphId = graphStore.create('G').id;
  const calls: { prompt: string; options: Options }[] = [];
  const queryFn: QueryFn = ({ prompt, options }) => {
    calls.push({ prompt, options: options! });
    return script(options!);
  };
  const planner = new Planner({
    graphStore,
    runStore,
    chatLog,
    projectDir: paths.root,
    claudePath: '/usr/local/bin/claude',
    requestRun: () => null,
    queryFn,
    clock: fixedClock(),
    env: { PATH: '/bin', ANTHROPIC_API_KEY: 'sk' },
  });
  const busy: boolean[] = [];
  planner.on('busy', (_graphId: string, b: boolean) => busy.push(b));
  const chat = () => chatLog.read(graphId);
  return { paths, graphStore, chatLog, graphId, planner, calls, busy, chat };
}

describe('Planner', () => {
  it('runs a turn with read-only tools plus graph tools and records the chat', async () => {
    const s = setup(async function* () {
      yield init();
      yield say({ type: 'text', text: 'Here is a plan.' }, { type: 'tool_use', id: 't1', name: 'mcp__graph__add_node', input: { kind: 'agent', title: 'Plan' } });
      yield done();
    });
    await s.planner.send(s.graphId, 'Plan a parity test');
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
    expect(s.chat().map((e) => [e.role, e.text])).toEqual([
      ['user', 'Plan a parity test'],
      ['assistant', 'Here is a plan.'],
      ['tool', 'add_node {"kind":"agent","title":"Plan"}'],
    ]);
    expect(s.graphStore.get(s.graphId)).toMatchObject({ plannerSessionId: 'sess-1', plannerOpCursor: 0 });
    expect(s.busy).toEqual([true, false]);
  });

  it('resumes the session and tells the planner about user edits since its last turn', async () => {
    const s = setup(async function* () {
      yield init();
      yield done();
    });
    await s.planner.send(s.graphId, 'first');
    s.graphStore.apply(s.graphId, { type: 'addNode', node: { title: 'Mine', kind: 'command', command: 'ls' } }, 'user');
    s.graphStore.apply(s.graphId, { type: 'updateNode', id: 'n1', patch: { title: 'Agent touch' } }, 'agent');
    s.graphStore.apply(s.graphId, { type: 'setGoal', goal: 'ship' }, 'user');
    await s.planner.send(s.graphId, 'second');
    expect(s.calls[1].options.resume).toBe('sess-1');
    expect(s.calls[1].prompt).toBe(
      '[Since your last turn, the user edited the graph:\n- added n1 "Mine" (command)\n- set the goal to "ship"\nCall get_graph for the full current state.]\n\nsecond',
    );
    expect(s.graphStore.get(s.graphId).plannerOpCursor).toBe(3);
  });

  it('rejects a second message while the planner is busy', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const s = setup(async function* () {
      yield init();
      await gate;
      yield done();
    });
    const first = s.planner.send(s.graphId, 'one');
    expect(s.planner.isBusy(s.graphId)).toBe(true);
    await s.planner.send(s.graphId, 'two');
    release();
    await first;
    expect(s.calls).toHaveLength(1);
    expect(s.chat().map((e) => e.role)).toEqual(['user', 'error']);
    expect(s.planner.isBusy(s.graphId)).toBe(false);
  });

  it('stops when the session is not on the subscription', async () => {
    const s = setup(async function* () {
      yield init('apiKeyHelper');
      yield say({ type: 'text', text: 'should not appear' });
      yield done();
    });
    await s.planner.send(s.graphId, 'hi');
    expect(s.chat().map((e) => e.role)).toEqual(['user', 'error']);
    expect(s.chat()[1].text).toContain('"apiKeyHelper"');
    expect(s.graphStore.get(s.graphId).plannerSessionId).toBeUndefined();
  });

  it('resets a broken session so the next message starts fresh', async () => {
    let fail = false;
    const s = setup(async function* () {
      if (fail) throw new Error('No conversation found');
      yield init();
      yield done();
    });
    await s.planner.send(s.graphId, 'one');
    fail = true;
    await s.planner.send(s.graphId, 'two');
    expect(s.graphStore.get(s.graphId).plannerSessionId).toBeUndefined();
    const last = s.chat().at(-1)!;
    expect(last.role).toBe('error');
    expect(last.text).toContain('No conversation found');
    expect(last.text).toContain('reset');
  });

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
      usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      session_id: sessionId,
    });

  it('resets a session that no longer exists, as the real CLI reports it', async () => {
    let stale = false;
    const s = setup(async function* (options) {
      if (stale) {
        yield missingSession(options.resume);
        throw new Error(`Claude Code returned an error result: No conversation found with session ID: ${options.resume}`);
      }
      yield init();
      yield done();
    });
    await s.planner.send(s.graphId, 'one');
    expect(s.graphStore.get(s.graphId).plannerSessionId).toBe('sess-1');
    stale = true;
    await s.planner.send(s.graphId, 'two');
    const last = s.chat().at(-1)!;
    expect(last.role).toBe('error');
    expect(last.text).toContain('No conversation found with session ID: sess-1');
    expect(last.text).toContain('reset');
    expect(s.graphStore.get(s.graphId).plannerSessionId).toBeUndefined();
    stale = false;
    await s.planner.send(s.graphId, 'three');
    expect(s.calls[2].options.resume).toBeUndefined();
    expect(s.graphStore.get(s.graphId).plannerSessionId).toBe('sess-1');
  });

  it('shows the real error when a session fails before it starts', async () => {
    const s = setup(async function* () {
      yield missingSession('x');
    });
    await s.planner.send(s.graphId, 'hi');
    expect(s.chat().map((e) => [e.role, e.text])).toEqual([
      ['user', 'hi'],
      ['error', 'No conversation found with session ID: x'],
    ]);
  });

  it('never rejects, even when the chat log cannot be written', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const s = setup(async function* () {
      yield init();
      await gate;
      yield done();
    });
    const first = s.planner.send(s.graphId, 'one');
    s.chatLog.append = () => {
      throw new Error('ENOSPC: no space left on device, write');
    };
    await expect(s.planner.send(s.graphId, 'two')).resolves.toBeUndefined();
    release();
    await expect(first).resolves.toBeUndefined();
    await expect(s.planner.send(s.graphId, 'three')).resolves.toBeUndefined();
    expect(s.busy).toEqual([true, false, true, false]);
    expect(s.planner.isBusy(s.graphId)).toBe(false);
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });

  it('does not start a session when the project settings would leave the subscription', async () => {
    const s = setup(async function* () {
      yield init();
      yield done();
    });
    mkdirSync(join(s.paths.root, '.claude'));
    writeFileSync(join(s.paths.root, '.claude', 'settings.json'), JSON.stringify({ apiKeyHelper: 'get-key.sh' }));
    await s.planner.send(s.graphId, 'hi');
    expect(s.calls).toHaveLength(0);
    expect(s.chat().map((e) => e.role)).toEqual(['user', 'error']);
    expect(s.chat()[1].text).toContain('sets apiKeyHelper');
    expect(s.busy).toEqual([true, false]);
  });

  it('stops when a result arrives without the session reporting how it authenticated', async () => {
    const s = setup(async function* () {
      yield say({ type: 'text', text: 'unverified reply' });
      yield done();
    });
    await s.planner.send(s.graphId, 'hi');
    expect(s.chat().map((e) => [e.role, e.text])).toEqual([
      ['user', 'hi'],
      ['assistant', 'unverified reply'],
      ['error', 'The Claude session did not report how it authenticated.'],
    ]);
    expect(s.graphStore.get(s.graphId).plannerSessionId).toBeUndefined();
  });
});

describe('describeOp for instructions', () => {
  it('reports an instructions change without quoting it', () => {
    expect(describeOp({ type: 'setInstructions', instructions: 'long text' })).toBe('changed the instructions');
  });
});

describe('describeOp for variables', () => {
  it('names the variable', () => {
    expect(describeOp({ type: 'addVariable', name: 'schema' })).toBe('added variable schema');
    expect(describeOp({ type: 'renameVariable', name: 'schema', newName: 'target' })).toBe('renamed variable schema to target');
    expect(describeOp({ type: 'setVariableDescription', name: 'schema', description: 'x' })).toBe('changed the description of variable schema');
    expect(describeOp({ type: 'deleteVariable', name: 'schema' })).toBe('deleted variable schema');
  });
});
