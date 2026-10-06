import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { EffortLevel } from '@agent-stream/shared';
import { createPlannerGate } from '../src/providers/toolGate';
import type { GraphTool, PlannerEvent, PlannerTurn, TurnFile } from '../src/providers/types';
import { codexPlanTurn, CODEX_RESUME_FAILED } from '../src/providers/codex/planTurn';
import type { CodexRunDeps } from '../src/providers/codex/runStep';
import { agentMessage, approvalParams, fakeCodex, FakeRpcError, mcpConfig, readAction, toolCallItem, turnHandlers, waitFor, type FakeHandler, type Msg, type TurnScript } from './codexFake';

const cwd = resolve('/', 'work', 'proj');
const values = resolve('/', 'h', '.agent-stream', 'values', 'abc.json');
const zsh = (script: string) => `/bin/zsh -lc '${script}'`;

type PlanOptions = { resume?: string; model?: string; effort?: EffortLevel; signal?: AbortSignal; codexPath?: string | undefined; files?: TurnFile[] };

function setup(handlers: Record<string, FakeHandler>, o: PlanOptions = {}) {
  const fake = fakeCodex(handlers);
  const addStep: GraphTool = { name: 'add_step', description: 'Add a step', schema: { title: z.string() }, run: vi.fn(async () => ({ text: 'Added n5.' })) };
  const events: PlannerEvent[] = [];
  const turn: PlannerTurn = {
    prompt: 'Add a test step',
    systemAppend: 'PLANNER RULES',
    cwd,
    tools: [addStep],
    ...(o.resume && { resume: o.resume }),
    ...(o.model && { model: o.model }),
    ...(o.effort && { effort: o.effort }),
    ...(o.files && { files: o.files }),
    gate: createPlannerGate({ projectDir: cwd, privateFiles: [values], graphToolNames: new Set(['add_step']) }),
    transcript: { load: () => undefined, save: () => {} },
    signal: o.signal ?? new AbortController().signal,
    onEvent: (e) => events.push(e),
  };
  const deps: CodexRunDeps = {
    codexPath: () => ('codexPath' in o ? o.codexPath : '/bin/codex'),
    missing: () => 'Codex is missing.',
    spawn: fake.spawn,
    env: {},
    platform: 'linux',
    knownModels: () => undefined,
    warnOnce: () => {},
    log: () => {},
    interruptWaitMs: 50,
  };
  return { fake, events, addStep, run: () => codexPlanTurn(deps)(turn) };
}
const plan = (script: (t: TurnScript) => unknown, o: PlanOptions & { threadId?: string } = {}) => setup(turnHandlers({ script, threadId: o.threadId }), o);

describe('codexPlanTurn', () => {
  it('starts a persistent read-only thread with the planner instructions and graph tools, and returns its id', async () => {
    const p = plan(
      (t) => {
        t.item(agentMessage('Added it.'));
        t.end();
      },
      { threadId: 'thread-7' },
    );
    expect(await p.run()).toEqual({ ok: true, sessionId: 'thread-7' });
    const proc = p.fake.last();
    const start = proc.paramsOf('thread/start');
    expect(start).toMatchObject({ cwd, approvalPolicy: 'untrusted', sandbox: 'read-only', developerInstructions: 'PLANNER RULES', ephemeral: false });
    expect(start).not.toHaveProperty('model');
    expect(start.dynamicTools.map((d: { name: string }) => d.name)).toEqual(['add_step']);
    expect(proc.methods()).not.toContain('thread/resume');
    expect(proc.paramsOf('turn/start')).toMatchObject({ threadId: 'thread-7', input: [{ type: 'text', text: 'Add a test step', text_elements: [] }] });
    expect(p.events).toEqual([{ type: 'text', text: 'Added it.' }]);
    expect(proc.killed).toBe(true);
  });

  it('starts and resumes threads on a Codex started with the MCP servers of its folder turned off (RF1)', async () => {
    for (const resume of [undefined, 'thread-7']) {
      const p = setup({ ...turnHandlers({ script: (t) => t.end() }), 'config/read': mcpConfig({ files: { command: 'x' } }) }, { resume });
      expect((await p.run()).ok).toBe(true);
      expect(p.fake.procs).toHaveLength(2);
      expect(p.fake.procs[0].paramsOf('config/read')).toEqual({ includeLayers: false, cwd });
      expect(p.fake.procs[1].args).toContain('mcp_servers.files.enabled=false');
      expect(p.fake.procs[1].methods()).toContain(resume ? 'thread/resume' : 'thread/start');
    }
  });

  it('resumes with the safety settings sent again', async () => {
    const p = plan((t) => t.end(), { resume: 'thread-7', model: 'gpt-a', effort: 'high' });
    expect(await p.run()).toEqual({ ok: true, sessionId: 'thread-7' });
    const proc = p.fake.last();
    expect(proc.methods()).not.toContain('thread/start');
    expect(proc.paramsOf('thread/resume')).toEqual({ threadId: 'thread-7', cwd, approvalPolicy: 'untrusted', sandbox: 'read-only', developerInstructions: 'PLANNER RULES', model: 'gpt-a' });
    expect(proc.paramsOf('turn/start')).toMatchObject({ threadId: 'thread-7', effort: 'high' });
  });

  it('drops a conversation Codex no longer has (R27)', async () => {
    const p = setup({ ...turnHandlers({}), 'thread/resume': () => { throw new FakeRpcError(-32600, 'thread not found'); } }, { resume: 'thread-gone' });
    expect(await p.run()).toEqual({ ok: false, error: CODEX_RESUME_FAILED, resumeFailed: true });
    expect(p.fake.last().methods()).not.toContain('turn/start');
    expect(CODEX_RESUME_FAILED).toBe('The earlier Codex conversation was not found.');
  });

  it('shows graph tool calls and runs them through the planner gate', async () => {
    const answers: Msg[] = [];
    const p = plan(async (t) => {
      t.started(toolCallItem({ id: 'd1', tool: 'add_step', args: { title: 'Test' }, status: 'inProgress' }));
      answers.push(await t.ask('item/tool/call', { callId: 'd1', namespace: null, tool: 'add_step', arguments: { title: 'Test' } }));
      t.completed(toolCallItem({ id: 'd1', tool: 'add_step', args: { title: 'Test' }, status: 'completed', text: 'Added n5.', success: true }));
      t.end();
    });
    await p.run();
    expect(p.events).toEqual([{ type: 'tool', name: 'add_step', input: { title: 'Test' } }]);
    expect(answers[0].result).toEqual({ contentItems: [{ type: 'inputText', text: 'Added n5.' }], success: true });
    expect(p.addStep.run).toHaveBeenCalledWith({ title: 'Test' }, expect.any(AbortSignal));
  });

  it('refuses changes without asking, and lets reads run', async () => {
    const answers: Msg[] = [];
    const p = plan(async (t) => {
      answers.push(await t.ask('item/commandExecution/requestApproval', approvalParams({ command: zsh('touch x'), cwd, actions: [{ type: 'unknown', command: 'touch x' }] })));
      answers.push(await t.ask('item/commandExecution/requestApproval', approvalParams({ command: zsh('cat notes.txt'), cwd, actions: [readAction('cat notes.txt', resolve(cwd, 'notes.txt'))] })));
      answers.push(await t.ask('item/fileChange/requestApproval', { itemId: 'patch-1' }));
      t.end();
    });
    await p.run();
    expect(answers.map((a) => a.result.decision)).toEqual(['decline', 'accept', 'decline']);
  });

  it('keeps the conversation when the turn fails, showing why', async () => {
    const p = plan((t) => t.end('failed', 'rate limited'));
    expect(await p.run()).toEqual({ ok: true, sessionId: 'thread-1', error: 'Codex failed: rate limited' });
    const exits = plan((t) => void t.proc.exit(1));
    expect(await exits.run()).toEqual({ ok: true, sessionId: 'thread-1', error: 'Codex stopped unexpectedly (exit 1).' });
  });

  it('Stop interrupts the turn and keeps the conversation', async () => {
    const ac = new AbortController();
    const p = plan((t) => t.item(agentMessage('Thinking about it.')), { signal: ac.signal });
    const result = p.run();
    await waitFor(() => p.events.length === 1);
    ac.abort();
    expect(await result).toEqual({ ok: true, sessionId: 'thread-1', error: 'cancelled' });
    expect(p.fake.last().methods()).toContain('turn/interrupt');
  });

  it('Stop before a thread exists returns cancelled; while resuming it keeps the conversation (R24)', async () => {
    const hang = () => new Promise(() => {});
    const ac1 = new AbortController();
    const fresh = setup({ ...turnHandlers({}), 'thread/start': hang }, { signal: ac1.signal });
    const r1 = fresh.run();
    await waitFor(() => fresh.fake.procs.length === 1 && fresh.fake.last().methods().includes('thread/start'));
    ac1.abort();
    expect(await r1).toEqual({ ok: false, error: 'cancelled' });
    const ac2 = new AbortController();
    const resumed = setup({ ...turnHandlers({}), 'thread/resume': hang }, { resume: 'thread-7', signal: ac2.signal });
    const r2 = resumed.run();
    await waitFor(() => resumed.fake.procs.length === 1 && resumed.fake.last().methods().includes('thread/resume'));
    ac2.abort();
    expect(await r2).toEqual({ ok: true, sessionId: 'thread-7', error: 'cancelled' });
  });

  it("doesn't start Codex without a path", async () => {
    const p = setup(turnHandlers({}), { codexPath: undefined });
    expect(await p.run()).toEqual({ ok: false, error: 'Codex is missing.' });
    expect(p.fake.procs).toHaveLength(0);
  });
});

describe('codexPlanTurn: chat attachments (step model spec §6b.5)', () => {
  it('sends a message’s images with turn/start, and says a PDF couldn’t be included', async () => {
    const image: TurnFile = { name: 'shot.png', kind: 'image', path: resolve(cwd, '.agent-stream', 'sessions', 'default', 'attachments', 'shot.png'), mediaType: 'image/png', data: 'UE5H' };
    const pdf: TurnFile = { name: 'spec.pdf', kind: 'pdf', path: resolve(cwd, 'spec.pdf'), mediaType: 'application/pdf', data: 'JVBE' };
    const p = plan((t) => t.end(), { files: [image, pdf] });
    await p.run();
    expect(p.fake.last().paramsOf('turn/start').input).toEqual([
      { type: 'text', text: "Add a test step\n\nNote: spec.pdf couldn't be included: OpenAI Codex can't read PDFs in the chat.\n", text_elements: [] },
      { type: 'localImage', path: image.path },
    ]);
    expect(p.events).toContainEqual({ type: 'note', text: "spec.pdf couldn't be included: OpenAI Codex can't read PDFs in the chat." });
  });
});
