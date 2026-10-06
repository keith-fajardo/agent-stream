import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ChatLog } from '../src/chatLog';
import { GraphStore } from '../src/graphStore';
import { Planner, PLANNER_APPEND, describeOp } from '../src/planner';
import type { EffortLevel } from '@agent-stream/shared';
import type { AgentProvider, PlannerTurn, PlannerTurnResult } from '../src/providers/types';
import { RunStore } from '../src/runStore';
import { SessionStore } from '../src/sessionStore';
import { ALTERNATIVES_RULE, PARALLEL_POLICY, PLANNER_AB_RULES, PLANNER_TICKET_RULES, SERIALIZATION_GUIDANCE } from '../src/policy';
import { deferred, fixedClock, outsideGit, signedIn, tmpProject, userText } from './helpers';

const VALUES_FILE = resolve('/', 'home', 'me', '.agent-stream', 'values', '0123456789abcdef.json');
const RESET_NOTE = ' (The previous planner session was reset; send your message again.)';

type Turn = (t: PlannerTurn) => Promise<PlannerTurnResult>;

function fakeProvider(turns: Turn[], over: Partial<AgentProvider> = {}): AgentProvider & { seen: PlannerTurn[] } {
  const seen: PlannerTurn[] = [];
  return {
    id: 'claude',
    name: 'Claude',
    seen,
    status: async () => signedIn,
    runStep: async () => ({ ok: true, output: '' }),
    planTurn: async (t) => {
      seen.push(t);
      return turns.shift()!(t);
    },
    ...over,
  };
}

/** A turn that ran and reported this provider session. */
const ran =
  (sessionId = 'sess-1'): Turn =>
  async () => ({ ok: true, sessionId });
const ok = (id: string): Turn => async () => ({ ok: true, sessionId: id });

function setup(turns: Turn[] = [], over: Partial<AgentProvider> = {}) {
  const paths = tmpProject();
  const graphStore = new GraphStore(paths, fixedClock());
  const runStore = new RunStore(paths);
  const sessions = new SessionStore(paths, fixedClock());
  sessions.create('A', 'a');
  sessions.create('B', 'b');
  const graphId = graphStore.create('G').id;
  const provider = fakeProvider(turns, over);
  /** The settings' default model and effort, read per turn. */
  const defaults: { model?: string; effort?: EffortLevel } = {};
  const planner = new Planner({
    modelDefaults: () => defaults,
    graphStore,
    runStore,
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
  const chat = () => sessions.chatLog('a').read(graphId);
  /** Session a's planner state for the graph. */
  const state = () => sessions.plannerState('a', graphId);
  return { paths, graphStore, sessions, graphId, planner, provider, seen: provider.seen, busy, chat, state, defaults };
}

describe('Planner', () => {
  it("sends the conversation's model and effort on every turn, falling back to the settings per field", async () => {
    const s = setup([ran('s1'), ran('s1'), ran('s1'), ran('s1')]);
    await s.planner.send('a', s.graphId, 'one');
    expect(s.seen[0].model).toBeUndefined();
    expect(s.seen[0].effort).toBeUndefined();
    s.defaults.model = 'haiku';
    s.defaults.effort = 'low';
    await s.planner.send('a', s.graphId, 'two');
    expect(s.seen[1]).toMatchObject({ model: 'haiku', effort: 'low' });
    // A choice made mid-conversation applies from the next turn, and survives the turn's own state update.
    s.sessions.setPlannerState('a', s.graphId, { model: 'sonnet' });
    await s.planner.send('a', s.graphId, 'three');
    expect(s.seen[2]).toMatchObject({ model: 'sonnet', effort: 'low' });
    expect(s.state()).toMatchObject({ sessionId: 's1', model: 'sonnet' });
    s.sessions.setPlannerState('a', s.graphId, { effort: 'max' });
    s.defaults.model = '';
    await s.planner.send('a', s.graphId, 'four');
    expect(s.seen[3]).toMatchObject({ model: 'sonnet', effort: 'max' });
  });

  it('passes nothing for Default when the settings are empty too', async () => {
    const s = setup([ran()]);
    s.defaults.model = '';
    await s.planner.send('a', s.graphId, 'hi');
    expect('model' in s.seen[0]).toBe(false);
    expect('effort' in s.seen[0]).toBe(false);
  });

  it('runs a turn with the graph tools and records the chat', async () => {
    const s = setup([
      async (t) => {
        t.onEvent({ type: 'text', text: 'Here is a plan.' });
        t.onEvent({ type: 'tool', name: 'add_node', input: { kind: 'agent', title: 'Plan' } });
        return { ok: true, sessionId: 'sess-1' };
      },
    ]);
    await s.planner.send('a', s.graphId, 'Plan a parity test');
    const t = s.seen[0];
    expect(t).toMatchObject({ prompt: 'Plan a parity test', systemAppend: PLANNER_APPEND, cwd: s.paths.root });
    expect(t.resume).toBeUndefined();
    expect(t.tools.map((x) => x.name)).toEqual([
      'get_graph', 'list_models', 'add_node', 'update_node', 'delete_node', 'connect', 'disconnect', 'set_goal', 'set_instructions', 'set_variable', 'delete_variable', 'request_run', 'get_run', 'checkout_info', 'check_tickets',
    ]);
    expect(s.chat().map((e) => [e.role, e.text])).toEqual([
      ['user', 'Plan a parity test'],
      ['assistant', 'Here is a plan.'],
      ['tool', 'add_node {"kind":"agent","title":"Plan"}'],
    ]);
    expect(s.state()).toMatchObject({ sessionId: 'sess-1', opCursor: 0 });
    expect(s.busy).toEqual([true, false]);
  });

  it('attributes the planner’s graph edits to its work session', async () => {
    const s = setup([
      async (t) => {
        await t.tools.find((x) => x.name === 'add_node')!.run({ kind: 'agent', title: 'Plan', prompt: 'p' });
        return { ok: true, sessionId: 'sess-1' };
      },
    ]);
    await s.planner.send('a', s.graphId, 'Plan it');
    expect(s.graphStore.readOps(s.graphId)).toMatchObject([{ by: 'agent', source: { kind: 'planner', sessionId: 'a' } }]);
  });

  it('logs a short display line for the user while the provider gets the full text', async () => {
    const s = setup([ran()]);
    await s.planner.send('a', s.graphId, 'long text', { display: 'short' });
    expect(s.chat().map((e) => [e.role, e.text])).toEqual([['user', 'short']]);
    expect(s.seen[0].prompt.endsWith('long text')).toBe(true);
  });

  it('describes the planner job without naming a model vendor', () => {
    expect(PLANNER_APPEND).not.toMatch(/Claude|Anthropic/);
    expect(PLANNER_APPEND).toContain('kind "agent" is a separate AI agent run');
  });

  it('tells the planner to write a description for every step', () => {
    expect(PLANNER_APPEND).toContain('Every step has a short plain-language description for people');
  });

  it('tells the planner to decompose a plan and order steps by their dependencies', () => {
    const graphTools = PLANNER_APPEND.indexOf('- Build and change plans only through the graph tools');
    expect(graphTools).toBeGreaterThanOrEqual(0);
    for (const line of [
      '- Decompose. When asked for a plan, create one node per distinct step or scenario — for example setup, each test scenario, each check, and a summary — connected by edges in the order they must run. Never put a whole multi-step plan into a single node\'s prompt.',
      "- The graph is the plan. When asked for a plan to test or verify something, build steps that carry out the tests: set up the starting state, run what is being tested, check the result. Do not build steps that only write test descriptions; write a test document only when the user asks for one.",
      "- Give each test case its own steps; do not group several cases into one step. Then apply the dependency rule below: cases that share state (the same table, database or files) run in the order they build on each other.",
      "- Work out dependencies before adding edges. For each step, list what it needs before it starts and what it changes or produces: files, code, build outputs, database or warehouse objects, services, environment, settings, accounts, test data. Connect step A → B when B uses something A produces (its output, a file, a build, a record); when B checks or relies on a state A creates or changes; when A and B change the same thing, so running them together could interfere; or when the result depends on their order, such as test cases where each starts from the state the previous one left.",
      "- Run steps in parallel (no edges between them) only when none of that applies: each starts from its own state and doesn't touch what the others read or change. When unsure, run them in sequence and say why in one chat line.",
      "- Test plans are often stateful sequences, for example create → update → delete; migrate → verify; deploy → smoke test; table absent → first run → new row → changed row.",
      "- Mark steps that only read, query or compare as read-only (access: read). That only lets them run alongside file-changing steps in the same workspace; edges still decide their order.",
      "- If the project doesn't contain what the user names (for example no such model yet), still build the full graph of steps that would run: add a first step that locates or creates it, and say in one chat line what is missing. Something missing never turns the plan into steps that only write documents.",
    ]) {
      expect(PLANNER_APPEND).toContain(line);
      expect(PLANNER_APPEND.indexOf(line)).toBeGreaterThan(graphTools);
    }
    expect(PLANNER_APPEND).not.toContain('Let independent scenarios run in parallel');
    const order = ['- Decompose.', '- The graph is the plan.', '- Give each test case its own steps', '- Work out dependencies before adding edges.'].map((l) => PLANNER_APPEND.indexOf(l));
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('calls request_run only when the user asks for a run', () => {
    expect(PLANNER_APPEND).toContain(
      '- You cannot start runs. Only call request_run when the user asks you to run or test the graph; after building or changing a plan, stop and let the user review it. Use get_run to read results when debugging.',
    );
    expect(PLANNER_APPEND).not.toContain('Use request_run to ask the user');
  });

  it('resumes the session and tells the planner about user edits since its last turn', async () => {
    const s = setup([ran(), ran()]);
    await s.planner.send('a', s.graphId, 'first');
    s.graphStore.apply(s.graphId, { type: 'addNode', node: { title: 'Mine', kind: 'command', command: 'ls' } }, 'user');
    s.graphStore.apply(s.graphId, { type: 'updateNode', id: 'n1', patch: { title: 'Agent touch' } }, 'agent');
    s.graphStore.apply(s.graphId, { type: 'setGoal', goal: 'ship' }, 'user');
    await s.planner.send('a', s.graphId, 'second');
    expect(s.seen[1].resume).toBe('sess-1');
    expect(s.seen[1].prompt).toBe(
      '[Since your last turn, the user edited the graph:\n- added n1 "Mine" (command)\n- set the goal to "ship"\nCall get_graph for the full current state.]\n\nsecond',
    );
    expect(s.state().opCursor).toBe(3);
  });

  it('lists only the user edits made since the cursor', async () => {
    const s = setup([ran(), ran(), ran()]);
    s.graphStore.apply(s.graphId, { type: 'setGoal', goal: 'before' }, 'user');
    await s.planner.send('a', s.graphId, 'first');
    // A fresh conversation has no last turn, so it gets no list; its cursor still moves past the edits.
    expect(s.seen[0].prompt).toBe('first');
    expect(s.state().opCursor).toBe(1);
    await s.planner.send('a', s.graphId, 'second');
    expect(s.seen[1].prompt).toBe('second');
    s.graphStore.apply(s.graphId, { type: 'setGoal', goal: 'after' }, 'user');
    await s.planner.send('a', s.graphId, 'third');
    expect(s.seen[2].prompt).toBe('[Since your last turn, the user edited the graph:\n- set the goal to "after"\nCall get_graph for the full current state.]\n\nthird');
  });

  it('lists no user edits in a fresh conversation after New chat or a provider switch, and saves its cursor', async () => {
    const s = setup([ran(), ran()]);
    await s.planner.send('a', s.graphId, 'first');
    s.graphStore.apply(s.graphId, { type: 'setGoal', goal: 'ship' }, 'user');
    expect(s.planner.newChat('a', s.graphId)).toEqual({ ok: true });
    await s.planner.send('a', s.graphId, 'again');
    expect(s.seen[1]).toMatchObject({ prompt: 'again', resume: undefined });
    expect(s.state().opCursor).toBe(1);

    const other = setup([ok('new')], { id: 'copilot', name: 'GitHub Copilot' });
    other.graphStore.apply(other.graphId, { type: 'setGoal', goal: 'ship' }, 'user');
    other.sessions.setPlannerState('a', other.graphId, { sessionId: 'claude-sess', provider: 'claude', opCursor: 0 });
    await other.planner.send('a', other.graphId, 'hi');
    expect(other.seen[0]).toMatchObject({ prompt: 'hi', resume: undefined });
    expect(other.state()).toMatchObject({ sessionId: 'new', provider: 'copilot', opCursor: 1 });
  });

  it('rejects a second message while the planner is busy', async () => {
    const gate = deferred<void>();
    const s = setup([
      async () => {
        await gate.promise;
        return { ok: true, sessionId: 'sess-1' };
      },
    ]);
    const first = s.planner.send('a', s.graphId, 'one');
    expect(s.planner.isBusy('a', s.graphId)).toBe(true);
    await s.planner.send('a', s.graphId, 'two');
    gate.resolve();
    await first;
    expect(s.seen).toHaveLength(1);
    expect(s.chat().map((e) => e.role)).toEqual(['user', 'error']);
    expect(s.planner.isBusy('a', s.graphId)).toBe(false);
  });

  it('stops when the session is not on the subscription', async () => {
    const s = setup([async () => ({ ok: false, error: 'This Claude session authenticated with "apiKeyHelper" instead of your Claude subscription.' })]);
    await s.planner.send('a', s.graphId, 'hi');
    expect(s.chat().map((e) => e.role)).toEqual(['user', 'error']);
    expect(s.chat()[1].text).toContain('"apiKeyHelper"');
    expect(s.state().sessionId).toBeUndefined();
  });

  it('resets a broken session so the next message starts fresh', async () => {
    const s = setup([
      ran(),
      async () => {
        throw new Error('No conversation found');
      },
    ]);
    await s.planner.send('a', s.graphId, 'one');
    await s.planner.send('a', s.graphId, 'two');
    expect(s.state().sessionId).toBeUndefined();
    const last = s.chat().at(-1)!;
    expect(last.role).toBe('error');
    expect(last.text).toContain('No conversation found');
    expect(last.text).toContain('reset');
  });

  it('resets a session that no longer exists, as the real CLI reports it', async () => {
    const s = setup([ran(), async (t) => ({ ok: false, error: `No conversation found with session ID: ${t.resume}`, resumeFailed: true }), ran()]);
    await s.planner.send('a', s.graphId, 'one');
    expect(s.state().sessionId).toBe('sess-1');
    await s.planner.send('a', s.graphId, 'two');
    const last = s.chat().at(-1)!;
    expect(last.role).toBe('error');
    expect(last.text).toContain('No conversation found with session ID: sess-1');
    expect(last.text).toContain('reset');
    expect(s.state().sessionId).toBeUndefined();
    await s.planner.send('a', s.graphId, 'three');
    expect(s.seen[2].resume).toBeUndefined();
    expect(s.state().sessionId).toBe('sess-1');
  });

  it('clears the session and adds the reset note when resuming failed', async () => {
    const s = setup([ran(), async () => ({ ok: false, error: 'gone', resumeFailed: true })]);
    await s.planner.send('a', s.graphId, 'one');
    s.graphStore.apply(s.graphId, { type: 'setGoal', goal: 'ship' }, 'user');
    await s.planner.send('a', s.graphId, 'two');
    expect(s.chat().at(-1)).toMatchObject({ role: 'error', text: `gone${RESET_NOTE}` });
    expect(s.state().sessionId).toBeUndefined();
    expect(s.state().opCursor).toBe(0);
  });

  it('shows the real error when a session fails before it starts', async () => {
    const s = setup([async () => ({ ok: false, error: 'No conversation found with session ID: x' })]);
    await s.planner.send('a', s.graphId, 'hi');
    expect(s.chat().map((e) => [e.role, e.text])).toEqual([
      ['user', 'hi'],
      ['error', 'No conversation found with session ID: x'],
    ]);
  });

  it('never rejects, even when the chat log cannot be written', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const gate = deferred<void>();
    const s = setup([
      async () => {
        await gate.promise;
        return { ok: true, sessionId: 'sess-1' };
      },
      ran(),
    ]);
    const first = s.planner.send('a', s.graphId, 'one');
    const append = vi.spyOn(ChatLog.prototype, 'append').mockImplementation(() => {
      throw new Error('ENOSPC: no space left on device, write');
    });
    try {
      await expect(s.planner.send('a', s.graphId, 'two')).resolves.toBeUndefined();
      gate.resolve();
      await expect(first).resolves.toBeUndefined();
      await expect(s.planner.send('a', s.graphId, 'three')).resolves.toBeUndefined();
      expect(s.busy).toEqual([true, false, true, false]);
      expect(s.planner.isBusy('a', s.graphId)).toBe(false);
      expect(logged).toHaveBeenCalled();
    } finally {
      // Restored even when an assertion fails, so later tests can still write their chat.
      logged.mockRestore();
      append.mockRestore();
    }
  });

  it('stops the turn before the provider runs when the folder has a problem', async () => {
    const s = setup([ran()], { folderProblem: (dir) => (dir === s.paths.root ? 'This folder reroutes the provider.' : undefined) });
    await s.planner.send('a', s.graphId, 'hi');
    expect(s.seen).toHaveLength(0);
    expect(s.chat().map((e) => [e.role, e.text])).toEqual([
      ['user', 'hi'],
      ['error', 'This folder reroutes the provider.'],
    ]);
    expect(s.busy).toEqual([true, false]);
  });

  it('stops when a result arrives without the session reporting how it authenticated', async () => {
    const s = setup([
      async (t) => {
        t.onEvent({ type: 'text', text: 'unverified reply' });
        return { ok: false, error: 'The Claude session did not report how it authenticated.' };
      },
    ]);
    await s.planner.send('a', s.graphId, 'hi');
    expect(s.chat().map((e) => [e.role, e.text])).toEqual([
      ['user', 'hi'],
      ['assistant', 'unverified reply'],
      ['error', 'The Claude session did not report how it authenticated.'],
    ]);
    expect(s.state().sessionId).toBeUndefined();
  });

  it('saves the cursor and shows the error when a turn ran but the model reported one', async () => {
    const s = setup([async () => ({ ok: true, sessionId: 'sess-2', error: 'boom' })]);
    s.graphStore.apply(s.graphId, { type: 'setGoal', goal: 'ship' }, 'user');
    await s.planner.send('a', s.graphId, 'hi');
    expect(s.chat().map((e) => [e.role, e.text])).toEqual([
      ['user', 'hi'],
      ['error', 'boom'],
    ]);
    expect(s.state()).toMatchObject({ sessionId: 'sess-2', opCursor: 1 });
  });

  it('gives the provider a gate that keeps the values file private and allows only the graph tools', async () => {
    const s = setup([ran()]);
    await s.planner.send('a', s.graphId, 'hi');
    const gate = s.seen[0].gate;
    expect(gate.privacy('Read', { file_path: VALUES_FILE })).toContain('the variable values file');
    expect(gate.privacy('Read', { file_path: 'models/a.sql' })).toBeNull();
    expect(await gate.decide('Read', { file_path: 'models/a.sql' })).toEqual({ allow: true, by: 'readOnly' });
    expect(await gate.decide('add_node', {})).toEqual({ allow: true, by: 'graphTool' });
    expect(await gate.decide('mcp__graph__add_node', {})).toMatchObject({ allow: false });
    expect(await gate.decide('Bash', { command: 'ls' })).toEqual({ allow: false, reason: 'The planner can only read files and edit the graph.' });
  });

  it('keeps each session’s conversation and edit cursor separate', async () => {
    const s = setup([ok('s-a'), ok('s-b'), ok('s-a2')]);
    await s.planner.send('a', s.graphId, 'first in a');
    s.graphStore.apply(s.graphId, { type: 'setGoal', goal: 'g' }, 'user');
    await s.planner.send('b', s.graphId, 'first in b');
    await s.planner.send('a', s.graphId, 'second in a');
    expect(s.sessions.chatLog('a').read(s.graphId).filter((e) => e.role === 'user').map((e) => e.text)).toEqual(['first in a', 'second in a']);
    expect(s.sessions.chatLog('b').read(s.graphId).filter((e) => e.role === 'user').map((e) => e.text)).toEqual(['first in b']);
    expect(s.provider.seen[1].prompt).toBe('first in b'); // b's conversation is fresh: no last turn to compare with
    expect(s.provider.seen[2].prompt).toMatch(/set the goal to "g"/); // a's cursor predates it
    expect(s.provider.seen[2].resume).toBe('s-a');
  });

  it('runs turns for two sessions on one graph at once, but one at a time per session', async () => {
    const gate = deferred<PlannerTurnResult>();
    const s = setup([() => gate.promise, ok('s-b')]);
    const first = s.planner.send('a', s.graphId, 'slow');
    await s.planner.send('a', s.graphId, 'again');
    await s.planner.send('b', s.graphId, 'other');
    // b's turn ran while a's was still held.
    expect(s.seen).toHaveLength(2);
    expect(s.sessions.chatLog('b').read(s.graphId).map((e) => [e.role, e.text])).toEqual([['user', 'other']]);
    expect(s.sessions.plannerState('b', s.graphId).sessionId).toBe('s-b');
    expect(s.sessions.chatLog('a').read(s.graphId).at(-1)).toMatchObject({ role: 'error', text: 'The planner is still working on your previous message.' });
    expect(s.planner.isBusyInGraph(s.graphId)).toBe(true);
    gate.resolve({ ok: true, sessionId: 's-a' });
    await first;
    expect(s.planner.isBusyInGraph(s.graphId)).toBe(false);
  });

  it('starts fresh with a note when the stored conversation belongs to another provider', async () => {
    const s = setup([ok('new')], { id: 'copilot', name: 'GitHub Copilot' });
    s.sessions.setPlannerState('a', s.graphId, { sessionId: 'claude-sess', provider: 'claude', opCursor: 0 });
    await s.planner.send('a', s.graphId, 'hi');
    expect(s.provider.seen[0].resume).toBeUndefined();
    expect(s.sessions.chatLog('a').read(s.graphId).map((e) => [e.role, e.text])).toContainEqual(['note', "Started a new planner conversation with GitHub Copilot; it doesn't see earlier messages."]);
    expect(s.sessions.plannerState('a', s.graphId)).toMatchObject({ sessionId: 'new', provider: 'copilot' });
  });

  it('reads planner state saved without a provider as Claude’s', async () => {
    const claude = setup([ok('next')]);
    claude.sessions.setPlannerState('a', claude.graphId, { sessionId: 'old-sess', opCursor: 0 });
    await claude.planner.send('a', claude.graphId, 'hi');
    expect(claude.provider.seen[0].resume).toBe('old-sess');
    expect(claude.chat().map((e) => e.role)).not.toContain('note');
    expect(claude.state()).toEqual({ sessionId: 'next', provider: 'claude', opCursor: 0 });

    const copilot = setup([ok('new')], { id: 'copilot', name: 'GitHub Copilot' });
    copilot.sessions.setPlannerState('a', copilot.graphId, { sessionId: 'old-sess', opCursor: 0 });
    await copilot.planner.send('a', copilot.graphId, 'hi');
    expect(copilot.provider.seen[0].resume).toBeUndefined();
    expect(copilot.chat().map((e) => e.role)).toContain('note');
  });

  it('New chat clears this session’s conversation for the graph only', async () => {
    const s = setup([ok('s-a'), ok('s-b')]);
    await s.planner.send('a', s.graphId, 'x');
    await s.planner.send('b', s.graphId, 'y');
    expect(s.planner.newChat('a', s.graphId)).toEqual({ ok: true });
    expect(s.sessions.chatLog('a').read(s.graphId)).toEqual([]);
    expect(s.sessions.plannerState('a', s.graphId)).toEqual({});
    expect(s.sessions.chatLog('b').read(s.graphId)).not.toEqual([]);
  });

  it('refuses New chat while that session’s turn runs, and reports the clear when it is done', async () => {
    const gate = deferred<PlannerTurnResult>();
    const s = setup([() => gate.promise]);
    const cleared: string[][] = [];
    s.planner.on('cleared', (sessionId: string, graphId: string) => cleared.push([sessionId, graphId]));
    const first = s.planner.send('a', s.graphId, 'slow');
    expect(s.planner.newChat('a', s.graphId)).toEqual({ ok: false, error: 'The planner is still working on your previous message.' });
    expect(s.planner.isBusyInSession('a')).toBe(true);
    expect(s.planner.isBusyInSession('b')).toBe(false);
    gate.resolve({ ok: true, sessionId: 's-a' });
    await first;
    expect(s.planner.isBusyInSession('a')).toBe(false);
    expect(s.planner.newChat('a', s.graphId)).toEqual({ ok: true });
    expect(cleared).toEqual([['a', s.graphId]]);
  });
});

describe('Planner.stop', () => {
  /** A turn that waits until its signal aborts, then ends the way `onAbort` says. */
  const untilStopped =
    (onAbort: (t: PlannerTurn) => PlannerTurnResult | Promise<PlannerTurnResult>): Turn =>
    (t) =>
      new Promise<PlannerTurnResult>((resolve, reject) => {
        t.onEvent({ type: 'text', text: 'Working on it.' });
        t.signal.addEventListener('abort', () => Promise.resolve().then(() => onAbort(t)).then(resolve, reject), { once: true });
      });

  it('stops a provider that throws on abort: one Stopped. note, no error, busy clears, the resumed conversation is kept', async () => {
    const s = setup([
      untilStopped(() => {
        throw Object.assign(new Error('Claude Code process aborted by user'), { name: 'AbortError' });
      }),
    ]);
    s.sessions.setPlannerState('a', s.graphId, { sessionId: 'sess-old', provider: 'claude', opCursor: 0 });
    const turn = s.planner.send('a', s.graphId, 'plan it');
    expect(s.planner.isBusy('a', s.graphId)).toBe(true);
    s.planner.stop('a', s.graphId);
    await turn;
    expect(s.chat().map((e) => [e.role, e.text])).toEqual([
      ['user', 'plan it'],
      ['assistant', 'Working on it.'],
      ['note', 'Stopped.'],
    ]);
    expect(s.planner.isBusy('a', s.graphId)).toBe(false);
    expect(s.busy).toEqual([true, false]);
    expect(s.state()).toMatchObject({ sessionId: 'sess-old' });
  });

  it("stops a provider that returns error 'cancelled' and saves its conversation so the user can continue", async () => {
    const s = setup([untilStopped(() => ({ ok: true, sessionId: 'sess-2', error: 'cancelled' }))]);
    const turn = s.planner.send('a', s.graphId, 'plan it');
    s.planner.stop('a', s.graphId);
    await turn;
    expect(s.chat().map((e) => e.role)).toEqual(['user', 'assistant', 'note']);
    expect(s.chat().at(-1)).toMatchObject({ role: 'note', text: 'Stopped.' });
    expect(s.state()).toMatchObject({ sessionId: 'sess-2', provider: 'claude', opCursor: 0 });
    expect(s.planner.isBusy('a', s.graphId)).toBe(false);
  });

  it("aborts only that session and graph's turn", async () => {
    const other = deferred<PlannerTurnResult>();
    const s = setup([untilStopped(() => ({ ok: true, sessionId: 's-a', error: 'cancelled' })), (t) => (t.signal.aborted ? Promise.reject(new Error('aborted')) : other.promise)]);
    const a = s.planner.send('a', s.graphId, 'one');
    const b = s.planner.send('b', s.graphId, 'two');
    s.planner.stop('a', s.graphId);
    await a;
    expect(s.seen[1].signal.aborted).toBe(false);
    expect(s.planner.isBusy('b', s.graphId)).toBe(true);
    other.resolve({ ok: true, sessionId: 's-b' });
    await b;
    expect(s.sessions.chatLog('b').read(s.graphId).map((e) => e.role)).toEqual(['user']);
    expect(s.sessions.plannerState('b', s.graphId).sessionId).toBe('s-b');
  });

  it('does nothing when no turn is running', async () => {
    const s = setup([ran('s1'), ran('s1')]);
    s.planner.stop('a', s.graphId);
    await s.planner.send('a', s.graphId, 'one');
    s.planner.stop('a', s.graphId);
    await s.planner.send('a', s.graphId, 'two');
    expect(s.seen[1].signal.aborted).toBe(false);
    expect(s.chat().map((e) => e.role)).toEqual(['user', 'user']);
    expect(s.busy).toEqual([true, false, true, false]);
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

describe('describeOp for reviewed agent changes', () => {
  it('names what the user accepted or reverted', () => {
    expect(describeOp({ type: 'acceptChange', target: { kind: 'node', id: 'n2' } })).toBe('accepted the agent change to n2');
    expect(describeOp({ type: 'revertChange', target: { kind: 'edge', id: 'n1->n2' } })).toBe('reverted the agent change to n1->n2');
    expect(describeOp({ type: 'acceptChange', target: { kind: 'all' } })).toBe('accepted all agent changes');
    expect(describeOp({ type: 'revertChange', target: { kind: 'all' } })).toBe('reverted all agent changes');
  });

  it('carries the parallel tickets policy, the alternatives rule and the serialization guidance verbatim', () => {
    for (const text of [PARALLEL_POLICY, ALTERNATIVES_RULE, PLANNER_TICKET_RULES, SERIALIZATION_GUIDANCE, PLANNER_AB_RULES]) expect(PLANNER_APPEND).toContain(text);
    expect(PLANNER_APPEND.indexOf(ALTERNATIVES_RULE)).toBe(PLANNER_APPEND.indexOf(PARALLEL_POLICY) + PARALLEL_POLICY.length + '\n- '.length);
  });

  it('gives each turn a transcript store kept per session, graph and provider', async () => {
    const history = [userText('first'), { role: 'assistant' as const, content: [{ type: 'text' as const, text: 'ok' }] }];
    const s = setup([
      async (t) => {
        t.transcript.save('conv-1', history);
        return { ok: true, sessionId: 'conv-1' };
      },
      async (t) => ({ ok: true, sessionId: t.resume }),
      async () => ({ ok: true, sessionId: 'other' }),
    ]);
    await s.planner.send('a', s.graphId, 'one');
    expect(existsSync(join(s.paths.sessionsDir, 'a', 'transcripts', `${s.graphId}.claude.conv-1.json`))).toBe(true);
    await s.planner.send('a', s.graphId, 'two');
    expect(s.seen[1].resume).toBe('conv-1');
    expect(s.seen[1].transcript.load('conv-1')).toEqual(history);
    await s.planner.send('b', s.graphId, 'three');
    expect(s.seen[2].transcript.load('conv-1')).toBeUndefined();
  });

  it("New chat deletes the conversation's transcripts", async () => {
    const s = setup([
      async (t) => {
        t.transcript.save('conv-1', [userText('first')]);
        return { ok: true, sessionId: 'conv-1' };
      },
    ]);
    await s.planner.send('a', s.graphId, 'one');
    const file = join(s.paths.sessionsDir, 'a', 'transcripts', `${s.graphId}.claude.conv-1.json`);
    expect(existsSync(file)).toBe(true);
    expect(s.planner.newChat('a', s.graphId)).toEqual({ ok: true });
    expect(existsSync(file)).toBe(false);
  });

  it('starts fresh when the provider finds no transcript to resume', async () => {
    const s = setup([
      async () => ({ ok: true, sessionId: 'conv-1' }),
      async (t) => (t.resume && !t.transcript.load(t.resume) ? { ok: false, error: 'The earlier Copilot conversation was not found.', resumeFailed: true } : { ok: true }),
    ]);
    await s.planner.send('a', s.graphId, 'one');
    await s.planner.send('a', s.graphId, 'two');
    expect(s.chat().at(-1)).toMatchObject({ role: 'error', text: `The earlier Copilot conversation was not found.${RESET_NOTE}` });
    expect(s.state().sessionId).toBeUndefined();
  });
});
