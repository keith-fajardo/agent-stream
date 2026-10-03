import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ChatLog } from '../src/chatLog';
import { GraphStore } from '../src/graphStore';
import { Planner, PLANNER_APPEND, describeOp } from '../src/planner';
import type { AgentProvider, PlannerTurn, PlannerTurnResult } from '../src/providers/types';
import { RunStore } from '../src/runStore';
import { deferred, fixedClock, signedIn, tmpProject } from './helpers';

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

function setup(turns: Turn[] = [], over: Partial<AgentProvider> = {}) {
  const paths = tmpProject();
  const graphStore = new GraphStore(paths, fixedClock());
  const runStore = new RunStore(paths);
  const chatLog = new ChatLog(paths);
  const graphId = graphStore.create('G').id;
  const provider = fakeProvider(turns, over);
  const planner = new Planner({
    graphStore,
    runStore,
    chatLog,
    projectDir: paths.root,
    provider: () => provider,
    privateFiles: () => [VALUES_FILE],
    requestRun: () => null,
    clock: fixedClock(),
  });
  const busy: boolean[] = [];
  planner.on('busy', (_graphId: string, b: boolean) => busy.push(b));
  const chat = () => chatLog.read(graphId);
  return { paths, graphStore, chatLog, graphId, planner, provider, seen: provider.seen, busy, chat };
}

describe('Planner', () => {
  it('runs a turn with the graph tools and records the chat', async () => {
    const s = setup([
      async (t) => {
        t.onEvent({ type: 'text', text: 'Here is a plan.' });
        t.onEvent({ type: 'tool', name: 'add_node', input: { kind: 'agent', title: 'Plan' } });
        return { ok: true, sessionId: 'sess-1' };
      },
    ]);
    await s.planner.send(s.graphId, 'Plan a parity test');
    const t = s.seen[0];
    expect(t).toMatchObject({ prompt: 'Plan a parity test', systemAppend: PLANNER_APPEND, cwd: s.paths.root });
    expect(t.resume).toBeUndefined();
    expect(t.tools.map((x) => x.name)).toEqual([
      'get_graph', 'add_node', 'update_node', 'delete_node', 'connect', 'disconnect', 'set_goal', 'set_instructions', 'set_variable', 'delete_variable', 'request_run', 'get_run',
    ]);
    expect(s.chat().map((e) => [e.role, e.text])).toEqual([
      ['user', 'Plan a parity test'],
      ['assistant', 'Here is a plan.'],
      ['tool', 'add_node {"kind":"agent","title":"Plan"}'],
    ]);
    expect(s.graphStore.get(s.graphId)).toMatchObject({ plannerSessionId: 'sess-1', plannerOpCursor: 0 });
    expect(s.busy).toEqual([true, false]);
  });

  it('describes the planner job without naming a model vendor', () => {
    expect(PLANNER_APPEND).not.toMatch(/Claude|Anthropic/);
    expect(PLANNER_APPEND).toContain('kind "agent" is a separate AI agent run');
  });

  it('resumes the session and tells the planner about user edits since its last turn', async () => {
    const s = setup([ran(), ran()]);
    await s.planner.send(s.graphId, 'first');
    s.graphStore.apply(s.graphId, { type: 'addNode', node: { title: 'Mine', kind: 'command', command: 'ls' } }, 'user');
    s.graphStore.apply(s.graphId, { type: 'updateNode', id: 'n1', patch: { title: 'Agent touch' } }, 'agent');
    s.graphStore.apply(s.graphId, { type: 'setGoal', goal: 'ship' }, 'user');
    await s.planner.send(s.graphId, 'second');
    expect(s.seen[1].resume).toBe('sess-1');
    expect(s.seen[1].prompt).toBe(
      '[Since your last turn, the user edited the graph:\n- added n1 "Mine" (command)\n- set the goal to "ship"\nCall get_graph for the full current state.]\n\nsecond',
    );
    expect(s.graphStore.get(s.graphId).plannerOpCursor).toBe(3);
  });

  it('lists only the user edits made since the cursor', async () => {
    const s = setup([ran(), ran(), ran()]);
    s.graphStore.apply(s.graphId, { type: 'setGoal', goal: 'before' }, 'user');
    await s.planner.send(s.graphId, 'first');
    expect(s.seen[0].prompt).toBe('[Since your last turn, the user edited the graph:\n- set the goal to "before"\nCall get_graph for the full current state.]\n\nfirst');
    await s.planner.send(s.graphId, 'second');
    expect(s.seen[1].prompt).toBe('second');
    s.graphStore.apply(s.graphId, { type: 'setGoal', goal: 'after' }, 'user');
    await s.planner.send(s.graphId, 'third');
    expect(s.seen[2].prompt).toBe('[Since your last turn, the user edited the graph:\n- set the goal to "after"\nCall get_graph for the full current state.]\n\nthird');
  });

  it('rejects a second message while the planner is busy', async () => {
    const gate = deferred<void>();
    const s = setup([
      async () => {
        await gate.promise;
        return { ok: true, sessionId: 'sess-1' };
      },
    ]);
    const first = s.planner.send(s.graphId, 'one');
    expect(s.planner.isBusy(s.graphId)).toBe(true);
    await s.planner.send(s.graphId, 'two');
    gate.resolve();
    await first;
    expect(s.seen).toHaveLength(1);
    expect(s.chat().map((e) => e.role)).toEqual(['user', 'error']);
    expect(s.planner.isBusy(s.graphId)).toBe(false);
  });

  it('stops when the session is not on the subscription', async () => {
    const s = setup([async () => ({ ok: false, error: 'This Claude session authenticated with "apiKeyHelper" instead of your Claude subscription.' })]);
    await s.planner.send(s.graphId, 'hi');
    expect(s.chat().map((e) => e.role)).toEqual(['user', 'error']);
    expect(s.chat()[1].text).toContain('"apiKeyHelper"');
    expect(s.graphStore.get(s.graphId).plannerSessionId).toBeUndefined();
  });

  it('resets a broken session so the next message starts fresh', async () => {
    const s = setup([
      ran(),
      async () => {
        throw new Error('No conversation found');
      },
    ]);
    await s.planner.send(s.graphId, 'one');
    await s.planner.send(s.graphId, 'two');
    expect(s.graphStore.get(s.graphId).plannerSessionId).toBeUndefined();
    const last = s.chat().at(-1)!;
    expect(last.role).toBe('error');
    expect(last.text).toContain('No conversation found');
    expect(last.text).toContain('reset');
  });

  it('resets a session that no longer exists, as the real CLI reports it', async () => {
    const s = setup([ran(), async (t) => ({ ok: false, error: `No conversation found with session ID: ${t.resume}`, resumeFailed: true }), ran()]);
    await s.planner.send(s.graphId, 'one');
    expect(s.graphStore.get(s.graphId).plannerSessionId).toBe('sess-1');
    await s.planner.send(s.graphId, 'two');
    const last = s.chat().at(-1)!;
    expect(last.role).toBe('error');
    expect(last.text).toContain('No conversation found with session ID: sess-1');
    expect(last.text).toContain('reset');
    expect(s.graphStore.get(s.graphId).plannerSessionId).toBeUndefined();
    await s.planner.send(s.graphId, 'three');
    expect(s.seen[2].resume).toBeUndefined();
    expect(s.graphStore.get(s.graphId).plannerSessionId).toBe('sess-1');
  });

  it('clears the session and adds the reset note when resuming failed', async () => {
    const s = setup([ran(), async () => ({ ok: false, error: 'gone', resumeFailed: true })]);
    await s.planner.send(s.graphId, 'one');
    s.graphStore.apply(s.graphId, { type: 'setGoal', goal: 'ship' }, 'user');
    await s.planner.send(s.graphId, 'two');
    expect(s.chat().at(-1)).toMatchObject({ role: 'error', text: `gone${RESET_NOTE}` });
    expect(s.graphStore.get(s.graphId).plannerSessionId).toBeUndefined();
    expect(s.graphStore.get(s.graphId).plannerOpCursor).toBe(0);
  });

  it('shows the real error when a session fails before it starts', async () => {
    const s = setup([async () => ({ ok: false, error: 'No conversation found with session ID: x' })]);
    await s.planner.send(s.graphId, 'hi');
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
    const first = s.planner.send(s.graphId, 'one');
    s.chatLog.append = () => {
      throw new Error('ENOSPC: no space left on device, write');
    };
    await expect(s.planner.send(s.graphId, 'two')).resolves.toBeUndefined();
    gate.resolve();
    await expect(first).resolves.toBeUndefined();
    await expect(s.planner.send(s.graphId, 'three')).resolves.toBeUndefined();
    expect(s.busy).toEqual([true, false, true, false]);
    expect(s.planner.isBusy(s.graphId)).toBe(false);
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });

  it('stops the turn before the provider runs when the folder has a problem', async () => {
    const s = setup([ran()], { folderProblem: (dir) => (dir === s.paths.root ? 'This folder reroutes the provider.' : undefined) });
    await s.planner.send(s.graphId, 'hi');
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
    await s.planner.send(s.graphId, 'hi');
    expect(s.chat().map((e) => [e.role, e.text])).toEqual([
      ['user', 'hi'],
      ['assistant', 'unverified reply'],
      ['error', 'The Claude session did not report how it authenticated.'],
    ]);
    expect(s.graphStore.get(s.graphId).plannerSessionId).toBeUndefined();
  });

  it('saves the cursor and shows the error when a turn ran but the model reported one', async () => {
    const s = setup([async () => ({ ok: true, sessionId: 'sess-2', error: 'boom' })]);
    s.graphStore.apply(s.graphId, { type: 'setGoal', goal: 'ship' }, 'user');
    await s.planner.send(s.graphId, 'hi');
    expect(s.chat().map((e) => [e.role, e.text])).toEqual([
      ['user', 'hi'],
      ['error', 'boom'],
    ]);
    expect(s.graphStore.get(s.graphId)).toMatchObject({ plannerSessionId: 'sess-2', plannerOpCursor: 1 });
  });

  it('gives the provider a gate that keeps the values file private and allows only the graph tools', async () => {
    const s = setup([ran()]);
    await s.planner.send(s.graphId, 'hi');
    const gate = s.seen[0].gate;
    expect(gate.privacy('Read', { file_path: VALUES_FILE })).toContain('the variable values file');
    expect(gate.privacy('Read', { file_path: 'models/a.sql' })).toBeNull();
    expect(await gate.decide('Read', { file_path: 'models/a.sql' })).toEqual({ allow: true, by: 'readOnly' });
    expect(await gate.decide('add_node', {})).toEqual({ allow: true, by: 'graphTool' });
    expect(await gate.decide('mcp__graph__add_node', {})).toMatchObject({ allow: false });
    expect(await gate.decide('Bash', { command: 'ls' })).toEqual({ allow: false, reason: 'The planner can only read files and edit the graph.' });
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
