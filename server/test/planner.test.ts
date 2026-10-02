import { describe, expect, it } from 'vitest';
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { ChatLog } from '../src/chatLog';
import { GraphStore } from '../src/graphStore';
import { Planner, PLANNER_APPEND } from '../src/planner';
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
  return { paths, graphStore, graphId, planner, calls, busy, chat };
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
});
