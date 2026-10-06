import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { emptyGraph, type EffortLevel, type GraphNode, type ModelChoice, type NodeEventBody } from '@agent-stream/shared';
import { ApprovalBroker } from '../src/approvals';
import type { StepAttachment } from '../src/attachedFiles';
import type { NodeContext } from '../src/executors';
import { createStepGate, STEP_GRAPH_TOOL_PREFIX } from '../src/providers/toolGate';
import type { GraphTool } from '../src/providers/types';
import { codexRunStep, stepItemEvents, stepPreamble, type CodexRunDeps } from '../src/providers/codex/runStep';
import type { CommandAction, ThreadItem } from '../src/providers/codex/protocol';
import {
  agentMessage,
  approvalParams,
  commandItem,
  fakeCodex,
  FakeRpcError,
  fileChangeItem,
  mcpConfig,
  readAction,
  reasoning,
  toolCallItem,
  turnHandlers,
  waitFor,
  type FakeHandler,
  type Msg,
  type TurnScript,
} from './codexFake';

const cwd = resolve('/', 'work', 'proj');
const values = resolve('/', 'h', '.agent-stream', 'values', 'abc.json');
const zsh = (script: string) => `/bin/zsh -lc '${script}'`;
const addStep = (): GraphTool => ({ name: 'add_step', description: 'Add a step', schema: { title: z.string() }, run: vi.fn(async () => ({ text: 'Added n5.' })) });

type StepOptions = { access?: 'read'; cwd?: string; model?: string; effort?: EffortLevel; graphTools?: GraphTool[]; signal?: AbortSignal; known?: ModelChoice[]; codexPath?: string | undefined; attachments?: StepAttachment[] };

/** A step on the fake app-server, with the gate the App builds for it (runs recorded in the folder's own .agent-stream). */
function setup(handlers: Record<string, FakeHandler>, o: StepOptions = {}) {
  const fake = fakeCodex(handlers);
  const broker = new ApprovalBroker();
  const events: NodeEventBody[] = [];
  const readOnly = o.access === 'read';
  const graphTools = readOnly ? [] : (o.graphTools ?? []);
  const node: GraphNode = { id: 'n2', title: 'Fix bug', kind: 'agent', prompt: 'p', createdBy: 'user', updatedBy: 'user', updatedAt: 't', ...(o.access && { access: o.access }) };
  const ctx: NodeContext = {
    runId: 'r1',
    graph: emptyGraph('g', 'G', 't'),
    node,
    prompt: 'FULL PROMPT',
    cwd: o.cwd ?? cwd,
    signal: o.signal ?? new AbortController().signal,
    emit: (e) => events.push(e),
    graphTools,
    ...(o.model && { model: o.model }),
    ...(o.effort && { effort: o.effort }),
    ...(o.attachments && { attachments: o.attachments }),
  };
  const gate = createStepGate({
    broker,
    runId: 'r1',
    graphId: 'g',
    nodeId: 'n2',
    nodeTitle: 'Fix bug',
    projectDir: ctx.cwd,
    runsRoot: cwd,
    privateFiles: [values],
    signal: ctx.signal,
    emit: ctx.emit,
    readOnly,
    selfApproving: new Set(graphTools.map((t) => STEP_GRAPH_TOOL_PREFIX + t.name)),
  });
  const warnings: string[] = [];
  const deps: CodexRunDeps = {
    codexPath: () => ('codexPath' in o ? o.codexPath : '/bin/codex'),
    missing: () => 'Codex is missing.',
    spawn: fake.spawn,
    env: {},
    platform: 'linux',
    knownModels: () => o.known,
    warnOnce: (_key, message) => warnings.push(message),
    log: () => {},
    interruptWaitMs: 50,
  };
  return { fake, broker, events, warnings, run: () => codexRunStep(deps)(ctx, gate) };
}
const step = (script: (t: TurnScript) => unknown, o: StepOptions = {}) => setup(turnHandlers({ script }), o);
const logged = (events: NodeEventBody[]) => events.filter((e) => e.type !== 'start' && e.type !== 'approval_requested' && e.type !== 'approval_decided');

describe('codexRunStep', () => {
  it('starts an ephemeral, untrusted thread in the step folder, with the preamble and its graph tools, and closes Codex after', async () => {
    const s = step(
      (t) => {
        t.item(agentMessage('Done.'));
        t.end();
      },
      { graphTools: [addStep()] },
    );
    expect(await s.run()).toEqual({ ok: true, output: 'Done.' });
    const proc = s.fake.last();
    const start = proc.paramsOf('thread/start');
    expect(start).toMatchObject({ cwd, approvalPolicy: 'untrusted', sandbox: 'workspace-write', ephemeral: true, developerInstructions: stepPreamble(cwd) });
    expect(start).not.toHaveProperty('model');
    expect(start.dynamicTools).toHaveLength(1);
    expect(start.dynamicTools[0]).toMatchObject({ type: 'function', name: 'add_step', description: 'Add a step', inputSchema: { type: 'object', properties: { title: { type: 'string' } } } });
    expect(start.dynamicTools[0].inputSchema).not.toHaveProperty('$schema');
    expect(proc.paramsOf('turn/start')).toEqual({ threadId: 'thread-1', input: [{ type: 'text', text: 'FULL PROMPT', text_elements: [] }] });
    expect(s.events[0]).toEqual({ type: 'start', kind: 'agent', cwd, prompt: 'FULL PROMPT' });
    expect(stepPreamble(cwd)).toBe(`You are an agent running one step of a workflow in ${cwd}. Do the work, then reply with a summary of what you did.`);
    expect(proc.killed).toBe(true);
  });

  it('runs the thread on a Codex started with the MCP servers of its folder turned off (RF1)', async () => {
    const s = setup({ ...turnHandlers({ script: (t) => t.end() }), 'config/read': mcpConfig({ files: { command: 'x' } }) });
    expect(await s.run()).toEqual({ ok: true, output: '' });
    expect(s.fake.procs).toHaveLength(2);
    expect(s.fake.procs[0].paramsOf('config/read')).toEqual({ includeLayers: false, cwd });
    expect(s.fake.procs[0].methods()).not.toContain('thread/start');
    expect(s.fake.procs[1].args).toContain('mcp_servers.files.enabled=false');
    expect(s.fake.procs[1].methods()).toContain('thread/start');
    expect(s.fake.procs.every((p) => p.killed)).toBe(true);
  });

  it('starts a read-only step in the read-only sandbox, without graph tools', async () => {
    const s = step((t) => t.end(), { access: 'read', graphTools: [addStep()] });
    await s.run();
    const start = s.fake.last().paramsOf('thread/start');
    expect(start.sandbox).toBe('read-only');
    expect(start).not.toHaveProperty('dynamicTools');
  });

  it('works in a variant worktree when the step does', async () => {
    const worktree = resolve('/', 'work', 'proj-wt', 'wh_small');
    const s = step((t) => t.end(), { cwd: worktree });
    await s.run();
    expect(s.fake.last().paramsOf('thread/start')).toMatchObject({ cwd: worktree, developerInstructions: stepPreamble(worktree) });
  });

  it('passes the model and effort through, dropping an effort the listed model lacks (R9)', async () => {
    const known: ModelChoice[] = [{ value: 'gpt-a', label: 'A', efforts: ['high'] }];
    const kept = step((t) => t.end(), { model: 'gpt-a', effort: 'high', known });
    await kept.run();
    expect(kept.fake.last().paramsOf('thread/start').model).toBe('gpt-a');
    expect(kept.fake.last().paramsOf('turn/start').effort).toBe('high');
    const dropped = step((t) => t.end(), { model: 'gpt-a', effort: 'ultra', known });
    await dropped.run();
    expect(dropped.fake.last().paramsOf('turn/start')).not.toHaveProperty('effort');
    expect(dropped.warnings).toEqual(['[agent-stream] A (gpt-a) has no "ultra" effort level; running without an effort level.']);
  });

  it('logs each item the way the step log shows tools and text (spec §4.6)', async () => {
    const change = { path: resolve(cwd, 'a.ts'), kind: { type: 'update' as const, move_path: null }, diff: '-old\n+new' };
    const cat = zsh('cat a.ts');
    const s = step((t) => {
      t.item(reasoning(['Looking at the bug']));
      t.started(commandItem({ id: 'c1', command: cat, status: 'inProgress' }));
      t.completed(commandItem({ id: 'c1', command: cat, status: 'completed', output: 'old\n', exitCode: 0 }));
      t.started(fileChangeItem({ id: 'p1', changes: [change], status: 'inProgress' }));
      t.completed(fileChangeItem({ id: 'p1', changes: [change], status: 'completed' }));
      t.started(toolCallItem({ id: 'd1', tool: 'add_step', args: { title: 'x' }, status: 'inProgress' }));
      t.completed(toolCallItem({ id: 'd1', tool: 'add_step', args: { title: 'x' }, status: 'completed', text: 'Added n5.', success: true }));
      t.item(agentMessage('Fixed.'));
      t.end();
    });
    expect(await s.run()).toEqual({ ok: true, output: 'Fixed.' });
    expect(logged(s.events)).toEqual([
      { type: 'text', text: 'Thinking: Looking at the bug' },
      { type: 'tool_call', toolUseId: 'c1', name: 'Bash', input: { command: cat } },
      { type: 'tool_result', toolUseId: 'c1', content: 'old\nexit 0', isError: false },
      { type: 'tool_call', toolUseId: 'p1', name: 'Patch', input: { changes: [{ path: resolve(cwd, 'a.ts'), kind: 'update', diff: '-old\n+new' }] } },
      { type: 'tool_result', toolUseId: 'p1', content: `changed ${resolve(cwd, 'a.ts')}`, isError: false },
      { type: 'tool_call', toolUseId: 'd1', name: 'add_step', input: { title: 'x' } },
      { type: 'tool_result', toolUseId: 'd1', content: 'Added n5.', isError: false },
      { type: 'text', text: 'Fixed.' },
    ]);
  });

  it('reports the usage, and a failed turn with what the agent said', async () => {
    const ok = step((t) => {
      t.usage({ inputTokens: 1000, cachedInputTokens: 600, cacheWriteInputTokens: 100, outputTokens: 50 });
      t.item(agentMessage('Done.'));
      t.end();
    });
    expect(await ok.run()).toEqual({ ok: true, output: 'Done.', usage: { inputTokens: 300, outputTokens: 50, cacheReadTokens: 600, cacheWriteTokens: 100, costUsd: 0, turns: 1 } });
    const failed = step((t) => {
      t.item(agentMessage('Partial.'));
      t.end('failed', 'rate limited');
    });
    expect(await failed.run()).toEqual({ ok: false, output: 'Partial.', error: 'Codex failed: rate limited' });
  });

  it('asks before a command, and logs why it was declined', async () => {
    const s = step(async (t) => {
      const command = zsh('npm test');
      t.started(commandItem({ id: 'c1', command, status: 'inProgress' }));
      const answer = await t.ask('item/commandExecution/requestApproval', approvalParams({ itemId: 'c1', command, cwd, actions: [{ type: 'unknown', command: 'npm test' }] }));
      t.completed(commandItem({ id: 'c1', command, status: answer.result.decision === 'accept' ? 'completed' : 'declined' }));
      t.end();
    });
    const outcome = s.run();
    await waitFor(() => s.broker.pending().length === 1);
    s.broker.decide(s.broker.pending()[0].id, { decision: 'deny' });
    expect(await outcome).toEqual({ ok: true, output: '' });
    expect(s.events.map((e) => e.type)).toEqual(['start', 'tool_call', 'approval_requested', 'approval_decided', 'tool_result']);
    expect(s.events.at(-1)).toEqual({ type: 'tool_result', toolUseId: 'c1', content: 'declined: Denied by the user.', isError: true });
  });

  it('runs plain reads without asking and declines private reads without asking', async () => {
    const answers: Msg[] = [];
    const ask = (t: TurnScript, script: string, actions: CommandAction[]) =>
      t.ask('item/commandExecution/requestApproval', approvalParams({ command: zsh(script), cwd, actions })).then((a) => answers.push(a));
    const s = step(async (t) => {
      await ask(t, 'cat notes.txt', [readAction('cat notes.txt', resolve(cwd, 'notes.txt'))]);
      await ask(t, `cat ${values}`, [readAction(`cat ${values}`, values)]);
      t.end();
    });
    const changed = vi.fn();
    s.broker.on('changed', changed);
    await s.run();
    expect(answers.map((a) => a.result.decision)).toEqual(['accept', 'decline']);
    expect(changed).not.toHaveBeenCalled();
  });

  it('declines everything but plain reads in a read-only step, without asking', async () => {
    const answers: Msg[] = [];
    const s = step(
      async (t) => {
        answers.push(await t.ask('item/commandExecution/requestApproval', approvalParams({ command: zsh('touch x'), cwd, actions: [{ type: 'unknown', command: 'touch x' }] })));
        answers.push(await t.ask('item/commandExecution/requestApproval', approvalParams({ command: zsh('cat notes.txt'), cwd, actions: [readAction('cat notes.txt', resolve(cwd, 'notes.txt'))] })));
        t.end();
      },
      { access: 'read' },
    );
    const changed = vi.fn();
    s.broker.on('changed', changed);
    await s.run();
    expect(answers.map((a) => a.result.decision)).toEqual(['decline', 'accept']);
    expect(changed).not.toHaveBeenCalled();
  });

  it('Stop interrupts the turn and returns cancelled', async () => {
    const ac = new AbortController();
    const s = step((t) => t.item(agentMessage('Working.')), { signal: ac.signal });
    const outcome = s.run();
    await waitFor(() => s.events.some((e) => e.type === 'text'));
    ac.abort();
    expect(await outcome).toEqual({ ok: false, output: '', error: 'cancelled' });
    expect(s.fake.last().methods()).toContain('turn/interrupt');
    expect(s.fake.last().killed).toBe(true);
  });

  it('fails with the exit message when Codex exits mid-turn', async () => {
    const s = step((t) => void t.proc.exit(2, 'panic\n'));
    expect(await s.run()).toEqual({ ok: false, output: '', error: 'Codex stopped unexpectedly (exit 2).\npanic' });
  });

  it('withdraws a pending approval when Codex exits', async () => {
    const s = step((t) => {
      t.started(commandItem({ id: 'c1', command: zsh('npm test'), status: 'inProgress' }));
      void t.ask('item/commandExecution/requestApproval', approvalParams({ itemId: 'c1', command: zsh('npm test'), cwd, actions: [{ type: 'unknown', command: 'npm test' }] }));
    });
    const outcome = s.run();
    await waitFor(() => s.broker.pending().length === 1);
    await s.fake.last().exit(1);
    expect(await outcome).toEqual({ ok: false, output: '', error: 'Codex stopped unexpectedly (exit 1).' });
    expect(s.broker.pending()).toEqual([]);
  });

  it('keeps the diff of a private file out of the step log, but not an ordinary one (F1)', async () => {
    const runFile = resolve(cwd, '.agent-stream', 'runs', 'r1', 'run.json');
    const mk = (path: string, diff: string) => ({ path, kind: { type: 'update' as const, move_path: null }, diff });
    const changes = [mk(values, ' SECRETMARK1\n-old'), mk(runFile, '-SECRETMARK2'), mk(resolve(cwd, 'a.ts'), '-ordinary diff')];
    const s = step((t) => {
      t.started(fileChangeItem({ id: 'p1', changes, status: 'inProgress' }));
      t.end();
    });
    await s.run();
    const call = s.events.find((e) => e.type === 'tool_call');
    const text = JSON.stringify(call);
    expect(text).not.toContain('SECRETMARK');
    expect(call).toMatchObject({ input: { changes: [{ path: values, kind: 'update' }, { path: runFile, kind: 'update' }, { path: resolve(cwd, 'a.ts'), kind: 'update', diff: '-ordinary diff' }] } });
  });

  it('keeps the diff of a path that could be another spelling of a private folder out of the step log (RF3)', async () => {
    const folded = resolve(cwd, '.agent-\u017ftream', 'runs', 'r1', 'run.json');
    const s = step((t) => {
      t.started(fileChangeItem({ id: 'p1', changes: [{ path: folded, kind: { type: 'update', move_path: null }, diff: '-SECRETMARK' }], status: 'inProgress' }));
      t.end();
    });
    await s.run();
    const call = s.events.find((e) => e.type === 'tool_call');
    expect(JSON.stringify(call)).not.toContain('SECRETMARK');
    expect(call).toMatchObject({ input: { changes: [{ path: folded, kind: 'update' }] } });
  });

  it('withdraws a pending approval when the turn completes normally (R18)', async () => {
    const s = step((t) => {
      t.started(commandItem({ id: 'c1', command: zsh('npm test'), status: 'inProgress' }));
      void t.ask('item/commandExecution/requestApproval', approvalParams({ itemId: 'c1', command: zsh('npm test'), cwd, actions: [{ type: 'unknown', command: 'npm test' }] }));
      t.end();
    });
    expect(await s.run()).toEqual({ ok: true, output: '' });
    expect(s.broker.pending()).toEqual([]);
  });

  it("closes Codex when the thread can't start, and doesn't start Codex without a path", async () => {
    const refused = setup({ ...turnHandlers({}), 'thread/start': () => { throw new FakeRpcError(-32602, 'bad cwd'); } });
    expect(await refused.run()).toEqual({ ok: false, output: '', error: 'bad cwd' });
    expect(refused.fake.last().killed).toBe(true);
    const missing = setup(turnHandlers({}), { codexPath: undefined });
    expect(await missing.run()).toEqual({ ok: false, output: '', error: 'Codex is missing.' });
    expect(missing.fake.procs).toHaveLength(0);
    const broken = setup({ initialize: () => { throw new FakeRpcError(-32600, 'unsupported client'); } });
    expect(await broken.run()).toEqual({ ok: false, output: '', error: "Codex didn't start: unsupported client" });
  });
});

describe('stepItemEvents', () => {
  it('shows a declined or failed command, and clips long output to 30,000 characters', () => {
    const declined = new Map([['c1', 'Denied by the user.']]);
    expect(stepItemEvents('completed', commandItem({ id: 'c1', command: 'x', status: 'declined' }), declined)).toEqual([{ type: 'tool_result', toolUseId: 'c1', content: 'declined: Denied by the user.', isError: true }]);
    expect(stepItemEvents('completed', commandItem({ id: 'c2', command: 'x', status: 'declined' }), declined)).toEqual([{ type: 'tool_result', toolUseId: 'c2', content: 'declined', isError: true }]);
    expect(stepItemEvents('completed', commandItem({ id: 'c3', command: 'x', status: 'failed', output: 'boom', exitCode: 2 }), declined)).toEqual([{ type: 'tool_result', toolUseId: 'c3', content: 'boom\nexit 2', isError: true }]);
    const [long] = stepItemEvents('completed', commandItem({ id: 'c4', command: 'x', status: 'completed', output: 'x'.repeat(40_000), exitCode: 0 }), declined);
    expect(long.type === 'tool_result' && long.content.length).toBeLessThan(31_000);
  });

  it('logs an item type it does not know as a tool call named after the type, with a short summary, and its end (RF1)', () => {
    const none = new Map<string, string>();
    const mcp = { type: 'mcpToolCall', id: 'm1', server: 'files', tool: 'read', status: 'inProgress', arguments: { path: 'x'.repeat(500) }, result: null, error: null } as unknown as ThreadItem;
    const [call] = stepItemEvents('started', mcp, none);
    expect(call).toMatchObject({ type: 'tool_call', toolUseId: 'm1', name: 'mcpToolCall' });
    const summary = call.type === 'tool_call' ? (call.input as { summary: string }).summary : '';
    expect(summary.startsWith('{"server":"files","tool":"read","arguments":{"path":"xxx')).toBe(true);
    expect(summary.length).toBeLessThanOrEqual(201);
    const done = { ...mcp, status: 'completed', result: { content: [{ type: 'text', text: 'SECRETMARK' }] } } as unknown as ThreadItem;
    expect(stepItemEvents('completed', done, none)).toEqual([{ type: 'tool_result', toolUseId: 'm1', content: 'completed', isError: false }]);
    const failed = { ...mcp, status: 'failed' } as unknown as ThreadItem;
    expect(stepItemEvents('completed', failed, none)).toEqual([{ type: 'tool_result', toolUseId: 'm1', content: 'failed', isError: true }]);
    const search = { type: 'webSearch', id: 'w1', query: 'codex docs' } as unknown as ThreadItem;
    expect(stepItemEvents('started', search, none)).toEqual([{ type: 'tool_call', toolUseId: 'w1', name: 'webSearch', input: { summary: '{"query":"codex docs"}' } }]);
    expect(stepItemEvents('completed', search, none)).toEqual([{ type: 'tool_result', toolUseId: 'w1', content: 'done', isError: false }]);
    const output = { type: 'functionCallOutput', id: 'f1', callId: 'c1', output: 'SECRETMARK', result: 'SECRETMARK', content: ['SECRETMARK'] } as unknown as ThreadItem;
    expect(stepItemEvents('started', output, none)).toEqual([{ type: 'tool_call', toolUseId: 'f1', name: 'functionCallOutput', input: { summary: '{"callId":"c1"}' } }]);
  });

  it('skips empty text, other phases and item types it does not show', () => {
    const none = new Map<string, string>();
    expect(stepItemEvents('started', agentMessage('Hi'), none)).toEqual([]);
    expect(stepItemEvents('completed', agentMessage('  '), none)).toEqual([]);
    expect(stepItemEvents('completed', reasoning([]), none)).toEqual([]);
    expect(stepItemEvents('completed', { type: 'userMessage', id: 'u1' }, none)).toEqual([]);
  });
});

describe('codexRunStep: the model and effort a step runs with', () => {
  it('logs them in the start event as they are sent, an effort the model lacks left out', async () => {
    const known: ModelChoice[] = [{ value: 'gpt-a', label: 'A', efforts: ['high'] }];
    const kept = step((t) => t.end(), { model: 'gpt-a', effort: 'high', known });
    await kept.run();
    expect(kept.events[0]).toEqual({ type: 'start', kind: 'agent', cwd, prompt: 'FULL PROMPT', model: 'gpt-a', effort: 'high' });
    const dropped = step((t) => t.end(), { model: 'gpt-a', effort: 'ultra', known });
    await dropped.run();
    expect(dropped.events[0]).toEqual({ type: 'start', kind: 'agent', cwd, prompt: 'FULL PROMPT', model: 'gpt-a' });
  });
});

describe('codexRunStep: attachments (step model spec §6b.5)', () => {
  it('sends images with turn/start for Codex to read, and lists every file with a note for PDFs', async () => {
    const at = (name: string, kind: StepAttachment['kind'], missing = false): StepAttachment => ({ name, kind, missing, path: resolve(cwd, '.agent-stream', 'attachments', 'g', name), shown: `.agent-stream/attachments/g/${name}` });
    const s = step((t) => t.end(), { attachments: [at('mockup.png', 'image'), at('spec.pdf', 'pdf'), at('gone.png', 'image', true)] });
    await s.run();
    const text = 'FULL PROMPT\n\nAttached files:\n- .agent-stream/attachments/g/mockup.png (image, attached to this message)\n- .agent-stream/attachments/g/spec.pdf (PDF: the model may not be able to read PDFs)\n';
    expect(s.fake.last().paramsOf('turn/start').input).toEqual([
      { type: 'text', text, text_elements: [] },
      { type: 'localImage', path: resolve(cwd, '.agent-stream', 'attachments', 'g', 'mockup.png') },
    ]);
    expect(s.events[0]).toMatchObject({ type: 'start', prompt: text });
  });
});
