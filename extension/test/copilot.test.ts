import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { createPlannerGate, type ChatMessage, type GraphTool, type NodeContext, type PlannerEvent, type PlannerTurn, type RunShell, type StepAttachment, type ToolGate, type TurnFile } from '@agent-stream/engine';
import { emptyGraph, type EffortLevel, type GraphNode, type NodeEventBody } from '@agent-stream/shared';
import { COPILOT_CONSENT_LATER, COPILOT_RESUME_FAILED, COPILOT_UNAVAILABLE, createCopilotProvider, type CopilotLimits, type LmAccess, type LmApi } from '../src/providers/copilot';
import { COPILOT_PERMISSION } from '../src/providers/copilotModel';
import { fakeLmModel } from './helpers';

const noShell: RunShell = async () => ({ exitCode: 0, output: '' });
const models = (...list: vscode.LanguageModelChat[]) => ({ selectChatModels: vi.fn(async () => list) });
const text = (value: string) => new vscode.LanguageModelTextPart(value);
const call = (callId: string, name: string, input: object) => new vscode.LanguageModelToolCallPart(callId, name, input);
const allowAll: ToolGate = {
  privacy: () => null,
  isReadOnly: () => true,
  isSelfApproving: () => false,
  approve: async () => ({ allow: true, by: 'user' }),
  decide: async () => ({ allow: true, by: 'user' }),
};

function provider(o: { lm?: LmApi; access?: LmAccess; limits?: Partial<CopilotLimits> } = {}) {
  return createCopilotProvider({ lm: o.lm, access: o.access, runShell: noShell, limits: () => ({ maxRequestsPerStep: 25, maxRequestsPerTurn: 10, ...o.limits }) });
}

function step(o: { model?: string; effort?: EffortLevel; access?: 'read'; graphTools?: GraphTool[]; signal?: AbortSignal; attachments?: StepAttachment[] } = {}) {
  const events: NodeEventBody[] = [];
  const cwd = mkdtempSync(join(tmpdir(), 'copilot-step-'));
  const node: GraphNode = { id: 'n1', title: 'Step', kind: 'agent', prompt: 'p', ...(o.access && { access: o.access }), createdBy: 'user', updatedBy: 'user', updatedAt: 't' };
  const ctx: NodeContext = {
    runId: 'r1',
    graph: emptyGraph('g', 'G', 't'),
    node,
    prompt: 'Do it.',
    cwd,
    signal: o.signal ?? new AbortController().signal,
    emit: (e) => events.push(e),
    ...(o.model && { model: o.model }),
    ...(o.effort && { effort: o.effort }),
    ...(o.graphTools && { graphTools: o.graphTools }),
    ...(o.attachments && { attachments: o.attachments }),
  };
  return { ctx, events, cwd };
}

describe('Copilot models', () => {
  it('lists the tool-calling models, Auto first, without internal copilot-* ids or duplicates', async () => {
    const lm = models(
      fakeLmModel({ id: 'gpt-4o-mini', name: 'GPT-4o mini' }).model,
      fakeLmModel({ id: 'copilot-utility', name: 'Utility' }).model,
      fakeLmModel({ id: 'auto', name: 'Auto' }).model,
      fakeLmModel({ id: 'no-tools', name: 'No tools', toolCalling: false }).model,
      fakeLmModel({ id: 'auto', name: 'Auto' }).model,
    );
    const p = provider({ lm });
    expect(p.knownModels!()).toBeUndefined();
    const listed = [
      { value: 'auto', label: 'Auto', efforts: [] },
      { value: 'gpt-4o-mini', label: 'GPT-4o mini', efforts: [] },
    ];
    expect(await p.listModels!()).toEqual(listed);
    expect(p.knownModels!()).toEqual(listed);
  });

  it('lists nothing without the API, and retries a failed list once when asked', async () => {
    expect(await provider({ lm: undefined }).listModels!()).toEqual([]);
    const lm = { selectChatModels: vi.fn(async (): Promise<vscode.LanguageModelChat[]> => Promise.reject(new Error('not signed in'))) };
    const p = provider({ lm });
    expect(await p.listModels!()).toEqual([]);
    expect(await p.listModels!()).toEqual([]);
    expect(lm.selectChatModels).toHaveBeenCalledTimes(1);
    lm.selectChatModels.mockResolvedValue([fakeLmModel({ id: 'auto', name: 'Auto' }).model]);
    expect(await p.listModels!({ retry: true })).toEqual([{ value: 'auto', label: 'Auto', efforts: [] }]);
  });

  it('runs Default on Auto, a listed model on itself, and a vanished model on Auto with a note', async () => {
    const auto = fakeLmModel({ id: 'auto', name: 'Auto' });
    const mini = fakeLmModel({ id: 'gpt-4o-mini', name: 'GPT-4o mini' });
    const p = provider({ lm: models(mini.model, auto.model) });
    await p.runStep(step().ctx, allowAll);
    expect(auto.sendRequest).toHaveBeenCalledTimes(1);
    await p.runStep(step({ model: 'gpt-4o-mini' }).ctx, allowAll);
    expect(mini.sendRequest).toHaveBeenCalledTimes(1);
    const gone = step({ model: 'gpt-9' });
    await p.runStep(gone.ctx, allowAll);
    expect(auto.sendRequest).toHaveBeenCalledTimes(2);
    expect(gone.events).toContainEqual({ type: 'text', text: 'The Copilot model gpt-9 is no longer available; using Auto.' });
    expect(p.modelInUse!(undefined)).toEqual({ value: 'auto', label: 'Auto', efforts: [] });
    expect(p.modelInUse!('gpt-9')).toEqual({ value: 'auto', label: 'Auto', efforts: [] });
    expect(p.modelInUse!('gpt-4o-mini')).toEqual({ value: 'gpt-4o-mini', label: 'GPT-4o mini', efforts: [] });
  });
});

describe('Copilot models that extensions cannot use', () => {
  const coreOnly = () => new Error('Model gpt-5.6-luna is only available to VS Code core.');

  it('fails the run clearly, then drops the model from the list and falls back to Auto', async () => {
    const auto = fakeLmModel({ id: 'auto', name: 'Auto' });
    const luna = fakeLmModel({ id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna', replies: [coreOnly()] });
    const p = provider({ lm: models(auto.model, luna.model) });
    expect((await p.listModels!()).map((m) => m.value)).toEqual(['auto', 'gpt-5.6-luna']);
    const first = step({ model: 'gpt-5.6-luna' });
    const out = await p.runStep(first.ctx, allowAll);
    expect(out).toMatchObject({ ok: false, error: "The Copilot model gpt-5.6-luna can't be used by extensions. Pick Auto or another model." });
    expect(p.knownModels!()!.map((m) => m.value)).toEqual(['auto']);
    expect((await p.listModels!()).map((m) => m.value)).toEqual(['auto']);
    const second = step({ model: 'gpt-5.6-luna' });
    await p.runStep(second.ctx, allowAll);
    expect(luna.sendRequest).toHaveBeenCalledTimes(1);
    expect(auto.sendRequest).toHaveBeenCalledTimes(1);
    expect(second.events).toContainEqual({ type: 'text', text: 'The Copilot model gpt-5.6-luna is no longer available; using Auto.' });
  });

  it('does the same for a planner turn', async () => {
    const auto = fakeLmModel({ id: 'auto', name: 'Auto' });
    const luna = fakeLmModel({ id: 'gpt-5.6-luna', replies: [coreOnly()] });
    const p = provider({ lm: models(auto.model, luna.model) });
    await p.listModels!();
    const store = new Map<string, ChatMessage[]>();
    const turn = (model: string) =>
      ({
        prompt: 'hi',
        cwd: '/tmp',
        model,
        systemAppend: 's',
        tools: [],
        gate: allowAll,
        signal: new AbortController().signal,
        onEvent: () => {},
        transcript: { load: (id: string) => store.get(id), save: (id: string, m: ChatMessage[]) => void store.set(id, m) },
      }) as unknown as PlannerTurn;
    const r = await p.planTurn!(turn('gpt-5.6-luna'));
    expect(r).toMatchObject({ ok: true, error: "The Copilot model gpt-5.6-luna can't be used by extensions. Pick Auto or another model." });
    expect(p.knownModels!()!.map((m) => m.value)).toEqual(['auto']);
  });
});

describe('Copilot status', () => {
  const lm = () => models(fakeLmModel({ id: 'auto', name: 'Auto' }).model, fakeLmModel({ id: 'gpt-4o-mini', name: 'GPT-4o mini' }).model);

  it('can run, and says Copilot will ask for permission while consent is unknown', async () => {
    expect(COPILOT_CONSENT_LATER).toBe('Copilot will ask for permission the first time a run or chat uses it.');
    expect(await provider({ lm: lm(), access: { canSendRequest: () => undefined } }).status()).toEqual({
      provider: 'copilot',
      ok: true,
      label: 'Copilot',
      detail: `Models: Auto, GPT-4o mini. ${COPILOT_CONSENT_LATER}`,
    });
  });

  it('can run without that sentence once consent is given', async () => {
    expect(await provider({ lm: lm(), access: { canSendRequest: () => true } }).status()).toEqual({ provider: 'copilot', ok: true, label: 'Copilot', detail: 'Models: Auto, GPT-4o mini.' });
  });

  it('cannot run when consent was refused', async () => {
    expect(await provider({ lm: lm(), access: { canSendRequest: () => false } }).status()).toEqual({
      provider: 'copilot',
      ok: false,
      label: 'Copilot not allowed',
      detail: 'Models: Auto, GPT-4o mini.',
      error: COPILOT_PERMISSION,
    });
  });

  it('asks about the model Default runs on, and never sends a request', async () => {
    const auto = fakeLmModel({ id: 'auto', name: 'Auto' });
    const canSendRequest = vi.fn(() => true);
    await provider({ lm: models(fakeLmModel({ id: 'gpt-4o-mini' }).model, auto.model), access: { canSendRequest } }).status();
    expect(canSendRequest).toHaveBeenCalledWith(auto.model);
    expect(auto.sendRequest).not.toHaveBeenCalled();
  });

  it('is not available without the API or models, or when listing fails, with the reason', async () => {
    expect(await provider({ lm: models() }).status()).toEqual({ provider: 'copilot', ok: false, label: 'Copilot not available', error: COPILOT_UNAVAILABLE });
    expect((await provider({ lm: undefined }).status()).error).toBe(`${COPILOT_UNAVAILABLE} (This version of VS Code has no Language Model API.)`);
    const failing = { selectChatModels: vi.fn(async (): Promise<vscode.LanguageModelChat[]> => Promise.reject(new Error('no consent'))) };
    expect((await provider({ lm: failing }).status()).error).toBe(`${COPILOT_UNAVAILABLE} (no consent)`);
  });
});

describe('Copilot runStep', () => {
  it('logs the start, tool calls and results, text and the request count, and returns the output with usage', async () => {
    const s = step();
    writeFileSync(join(s.cwd, 'a.txt'), 'hello\n');
    const m = fakeLmModel({ id: 'auto', name: 'Auto', replies: [[call('c1', 'Read', { file_path: 'a.txt' })], [text('The file says '), text('hello.')]] });
    const out = await provider({ lm: models(m.model) }).runStep(s.ctx, allowAll);
    expect(s.events).toEqual([
      { type: 'start', kind: 'agent', cwd: s.cwd, prompt: 'Do it.', model: 'auto' },
      { type: 'tool_call', toolUseId: 'c1', name: 'Read', input: { file_path: 'a.txt' } },
      { type: 'tool_result', toolUseId: 'c1', content: '     1\thello', isError: false },
      { type: 'text', text: 'The file says hello.' },
      { type: 'text', text: 'Copilot requests: 2 of 25' },
    ]);
    expect(out).toEqual({ ok: true, output: 'The file says hello.', usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, turns: 2 } });
    const preamble = `You are an agent running one step of a workflow in ${s.cwd}. Use the tools to do the work; when finished, reply with a summary of what you did.`;
    expect(m.requests[0].messages).toEqual([vscode.LanguageModelChatMessage.User([text(preamble)]), vscode.LanguageModelChatMessage.User([text('Do it.')])]);
  });

  it('gives a read-only step only the read tools, and a write step the edit tools and its graph tools under mcp__run_graph__', async () => {
    const ro = fakeLmModel({ id: 'auto' });
    await provider({ lm: models(ro.model) }).runStep(step({ access: 'read' }).ctx, allowAll);
    expect(ro.requests[0].options?.tools?.map((t) => t.name)).toEqual(['Read', 'Grep', 'Glob']);
    const addStep: GraphTool = { name: 'add_step', description: 'Add a step.', schema: {}, run: async () => ({ text: 'added' }) };
    const rw = fakeLmModel({ id: 'auto', replies: [[call('c1', 'add_step', {})], [text('Added.')]] });
    const decide = vi.fn(allowAll.decide);
    await provider({ lm: models(rw.model) }).runStep(step({ graphTools: [addStep] }).ctx, { ...allowAll, decide });
    expect(rw.requests[0].options?.tools?.map((t) => t.name)).toEqual(['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash', 'add_step']);
    expect(decide).toHaveBeenCalledWith('mcp__run_graph__add_step', {}, expect.any(AbortSignal));
  });

  it('stops at agentStream.copilot.maxRequestsPerStep with the cap message and the last text', async () => {
    const s = step();
    writeFileSync(join(s.cwd, 'a.txt'), 'x');
    const read = () => [text('Looking.'), call('c', 'Read', { file_path: 'a.txt' })];
    const m = fakeLmModel({ id: 'auto', replies: [read(), read(), read()] });
    const p = provider({ lm: models(m.model), limits: { maxRequestsPerStep: 2 } });
    expect(await p.runStep(s.ctx, allowAll)).toEqual({
      ok: false,
      output: 'Looking.',
      error: 'Stopped after 2 Copilot requests (agentStream.copilot.maxRequestsPerStep). Raise the setting to let steps run longer.',
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, turns: 2 },
    });
    expect(m.sendRequest).toHaveBeenCalledTimes(2);
    expect(s.events.at(-1)).toEqual({ type: 'text', text: 'Copilot requests: 2 of 2' });
    expect(p.stepRequestCap!()).toBe(2);
  });

  it('still reports the requests a failed step made as its turns', async () => {
    const s = step();
    writeFileSync(join(s.cwd, 'a.txt'), 'x');
    const m = fakeLmModel({ id: 'auto', replies: [[call('c', 'Read', { file_path: 'a.txt' })], new Error('boom')] });
    expect(await provider({ lm: models(m.model) }).runStep(s.ctx, allowAll)).toMatchObject({
      ok: false,
      error: 'Copilot failed: boom',
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, turns: 2 },
    });
  });

  it('fails with the permission message when consent is declined, and is cancelled by Stop', async () => {
    const m = fakeLmModel({ id: 'auto', replies: [vscode.LanguageModelError.NoPermissions('declined')] });
    expect(await provider({ lm: models(m.model) }).runStep(step().ctx, allowAll)).toEqual({ ok: false, output: '', error: COPILOT_PERMISSION, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, turns: 1 } });
    const ac = new AbortController();
    ac.abort();
    expect(await provider({ lm: models(fakeLmModel({ id: 'auto' }).model) }).runStep(step({ signal: ac.signal }).ctx, allowAll)).toEqual({ ok: false, output: '', error: 'cancelled', usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, turns: 0 } });
  });

  it('reports the requests a Stopped step already spent', async () => {
    const ac = new AbortController();
    const m = fakeLmModel({ id: 'auto', replies: [[call('c1', 'Read', { path: 'a.txt' })]] });
    const stopOnTool: ToolGate = { ...allowAll, decide: async () => { ac.abort(); return { allow: true, by: 'user' }; } };
    const r = await provider({ lm: models(m.model) }).runStep(step({ signal: ac.signal }).ctx, stopOnTool);
    expect(r).toEqual({ ok: false, output: '', error: 'cancelled', usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, turns: 1 } });
  });

  it('fails without models, after the start event and without a request line', async () => {
    const s = step();
    expect(await provider({ lm: models() }).runStep(s.ctx, allowAll)).toEqual({ ok: false, output: '', error: COPILOT_UNAVAILABLE });
    expect(s.events.map((e) => e.type)).toEqual(['start']);
  });
});

describe('Copilot planTurn', () => {
  function turn(o: Partial<PlannerTurn> & { store?: Map<string, ChatMessage[]> } = {}) {
    const { store: given, ...over } = o;
    const store = given ?? new Map<string, ChatMessage[]>();
    const events: PlannerEvent[] = [];
    const cwd = mkdtempSync(join(tmpdir(), 'copilot-plan-'));
    const addNode: GraphTool = { name: 'add_node', description: 'Add a step.', schema: {}, run: async () => ({ text: 'added n1' }) };
    const t: PlannerTurn = {
      prompt: 'Plan a build.',
      systemAppend: 'You are the planner.',
      cwd,
      tools: [addNode],
      gate: createPlannerGate({ projectDir: cwd, privateFiles: [], graphToolNames: new Set(['add_node']) }),
      signal: new AbortController().signal,
      onEvent: (e) => events.push(e),
      transcript: { load: (id) => store.get(id), save: (id, messages) => void store.set(id, structuredClone(messages)) },
      ...over,
    };
    return { t, events, store };
  }

  it('starts a conversation under a new id, shows text and graph tool calls, and continues it from the transcript', async () => {
    const m = fakeLmModel({
      id: 'auto',
      replies: [[call('c1', 'add_node', { title: 'Build' }), call('c2', 'Read', { file_path: 'package.json' })], [text('Added a build step.')], [text('Sure.')]],
    });
    const p = provider({ lm: models(m.model) });
    const first = turn();
    const r1 = await p.planTurn(first.t);
    expect(r1).toEqual({ ok: true, sessionId: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    const id = (r1 as { sessionId: string }).sessionId;
    expect(first.events).toEqual([{ type: 'tool', name: 'add_node', input: { title: 'Build' } }, { type: 'text', text: 'Added a build step.' }]);
    expect(m.requests[0].messages[0]).toEqual(vscode.LanguageModelChatMessage.User([text('You are the planner.')]));
    expect(m.requests[0].options?.tools?.map((t) => t.name)).toEqual(['Read', 'Grep', 'Glob', 'add_node']);
    const second = turn({ store: first.store, resume: id, prompt: 'And a test step?' });
    expect(await p.planTurn(second.t)).toEqual({ ok: true, sessionId: id });
    const sent = m.requests[2].messages;
    expect(sent[1]).toEqual(vscode.LanguageModelChatMessage.User([text('Plan a build.')]));
    expect(sent.at(-1)).toEqual(vscode.LanguageModelChatMessage.User([text('And a test step?')]));
    // Prompt, tool calls, results, reply; then the second prompt and reply.
    expect(first.store.get(id)).toHaveLength(6);
  });

  it("reports resumeFailed when the conversation's transcript is gone, without a request", async () => {
    const m = fakeLmModel({ id: 'auto' });
    expect(await provider({ lm: models(m.model) }).planTurn(turn({ resume: 'gone' }).t)).toEqual({ ok: false, error: COPILOT_RESUME_FAILED, resumeFailed: true });
    expect(COPILOT_RESUME_FAILED).toBe('The earlier Copilot conversation was not found.');
    expect(m.sendRequest).not.toHaveBeenCalled();
  });

  it('keeps the conversation when a request fails, and shows the error', async () => {
    const m = fakeLmModel({ id: 'auto', replies: [vscode.LanguageModelError.Blocked('quota')] });
    const t = turn();
    const r = await provider({ lm: models(m.model) }).planTurn(t.t);
    expect(r).toEqual({ ok: true, sessionId: expect.any(String), error: 'Copilot refused the request (quota or policy): quota' });
    expect(t.store.get((r as { sessionId: string }).sessionId)).toEqual([{ role: 'user', content: [{ type: 'text', text: 'Plan a build.' }] }]);
  });

  it('saves the transcript the loop returns, with compacted history in place of the old turns', async () => {
    // A long stored history on a small model: the loop summarises it before the request (spec §4.6).
    const store = new Map<string, ChatMessage[]>();
    const long = 'x'.repeat(4000);
    store.set('conv-1', Array.from({ length: 10 }, (_, i): ChatMessage => (i % 2 ? { role: 'assistant', content: [{ type: 'text', text: long }] } : { role: 'user', content: [{ type: 'text', text: long }] })));
    const m = fakeLmModel({ id: 'auto', maxInputTokens: 4000, replies: [[text('Earlier: a build.')], [text('Sure.')]] });
    const r = await provider({ lm: models(m.model) }).planTurn(turn({ store, resume: 'conv-1', prompt: 'And a test step?' }).t);
    expect(r).toEqual({ ok: true, sessionId: 'conv-1' });
    const saved = store.get('conv-1')!;
    expect(saved.length).toBeLessThan(12);
    expect(JSON.stringify(saved)).toContain('Summary of earlier turns: Earlier: a build.');
    expect(saved.at(-1)).toEqual({ role: 'assistant', content: [{ type: 'text', text: 'Sure.' }] });
  });

  it('still returns the turn when saving the transcript fails, and logs why', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const m = fakeLmModel({ id: 'auto', replies: [[text('Done.')]] });
      const save = vi.fn(() => {
        throw new Error('disk full');
      });
      const t = turn({ transcript: { load: () => undefined, save } });
      const r = await provider({ lm: models(m.model) }).planTurn(t.t);
      expect(r).toEqual({ ok: true, sessionId: expect.stringMatching(/^[0-9a-f-]{36}$/) });
      expect(save).toHaveBeenCalledTimes(1);
      expect(t.events).toEqual([{ type: 'text', text: 'Done.' }]);
      expect(logged).toHaveBeenCalledWith(expect.stringContaining('disk full'));
    } finally {
      logged.mockRestore();
    }
  });

  it('stops at agentStream.copilot.maxRequestsPerTurn', async () => {
    const m = fakeLmModel({ id: 'auto', replies: [[call('c1', 'add_node', {})]] });
    const r = await provider({ lm: models(m.model), limits: { maxRequestsPerTurn: 1 } }).planTurn(turn().t);
    expect(r).toEqual({ ok: true, sessionId: expect.any(String), error: 'Stopped after 1 Copilot requests (agentStream.copilot.maxRequestsPerTurn). Raise the setting to let planner turns run longer, or type continue to pick up where it stopped.' });
  });
});

describe('Copilot effort (step model spec §6)', () => {
  it('has no effort option for extensions: a step’s effort is never sent, and its start names the model it ran on', async () => {
    const s = step({ model: 'gpt-4o-mini', effort: 'high' });
    const auto = fakeLmModel({ id: 'auto', name: 'Auto' });
    const mini = fakeLmModel({ id: 'gpt-4o-mini', name: 'GPT-4o mini' });
    await provider({ lm: models(auto.model, mini.model) }).runStep(s.ctx, allowAll);
    expect(s.events[0]).toEqual({ type: 'start', kind: 'agent', cwd: s.cwd, prompt: 'Do it.', model: 'gpt-4o-mini' });
    const options = mini.requests[0].options!;
    expect(options).not.toHaveProperty('modelOptions');
    expect(JSON.stringify(options)).not.toContain('high');
  });

  it('names Auto in the start event of a step whose model is gone', async () => {
    const s = step({ model: 'gpt-9' });
    const auto = fakeLmModel({ id: 'auto', name: 'Auto' });
    await provider({ lm: models(auto.model) }).runStep(s.ctx, allowAll);
    expect(s.events.slice(0, 2)).toEqual([
      { type: 'start', kind: 'agent', cwd: s.cwd, prompt: 'Do it.', model: 'auto' },
      { type: 'text', text: 'The Copilot model gpt-9 is no longer available; using Auto.' },
    ]);
  });
});

describe('Copilot: attachments (step model spec §6b.5)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'copilot-attach-'));
  writeFileSync(join(dir, 'mockup.png'), 'PNG');
  const files: StepAttachment[] = [
    { name: 'mockup.png', kind: 'image', missing: false, path: join(dir, 'mockup.png'), shown: '.agent-stream/attachments/g/mockup.png' },
    { name: 'spec.pdf', kind: 'pdf', missing: false, path: join(dir, 'spec.pdf'), shown: '.agent-stream/attachments/g/spec.pdf' },
  ];
  const withImages = (id: string, images: boolean) => {
    const m = fakeLmModel({ id, name: id });
    (m.model as unknown as { capabilities: Record<string, boolean> }).capabilities.supportsImageToText = images;
    return m;
  };

  it('sends images as data parts to a model that takes them', async () => {
    const s = step({ attachments: files });
    const m = withImages('auto', true);
    await provider({ lm: models(m.model) }).runStep(s.ctx, allowAll);
    const user = m.requests[0].messages[1];
    expect(user.content).toEqual([
      text('Do it.\n\nAttached files:\n- .agent-stream/attachments/g/mockup.png (image, attached to this message)\n- .agent-stream/attachments/g/spec.pdf (PDF: the model may not be able to read PDFs)\n'),
      new vscode.LanguageModelDataPart(Buffer.from('PNG'), 'image/png'),
    ]);
  });

  it('for a model that doesn’t take images, says so in the list and sends none', async () => {
    const s = step({ attachments: files });
    const m = withImages('auto', false);
    await provider({ lm: models(m.model) }).runStep(s.ctx, allowAll);
    const user = m.requests[0].messages[1];
    expect(user.content).toEqual([text("Do it.\n\nAttached files:\n- .agent-stream/attachments/g/mockup.png (This image couldn't be shown to the model.)\n- .agent-stream/attachments/g/spec.pdf (PDF: the model may not be able to read PDFs)\n")]);
  });

  it('labels each image by what was read: one that vanished is left out, the others stay attached', async () => {
    const s = step({ attachments: [...files, { name: 'gone.png', kind: 'image', missing: false, path: join(dir, 'gone.png'), shown: '.agent-stream/attachments/g/gone.png' }] });
    const m = withImages('auto', true);
    await provider({ lm: models(m.model) }).runStep(s.ctx, allowAll);
    const user = m.requests[0].messages[1];
    expect(user.content).toEqual([
      text('Do it.\n\nAttached files:\n- .agent-stream/attachments/g/mockup.png (image, attached to this message)\n- .agent-stream/attachments/g/spec.pdf (PDF: the model may not be able to read PDFs)\n'),
      new vscode.LanguageModelDataPart(Buffer.from('PNG'), 'image/png'),
    ]);
  });
});

describe('Copilot: the 5 MB image rule and the inline budget per request (ruling on I-2)', () => {
  const MB = 1024 * 1024;
  const dir = mkdtempSync(join(tmpdir(), 'copilot-budget-'));
  const image = (name: string, size: number): StepAttachment => {
    writeFileSync(join(dir, name), Buffer.alloc(size, 1));
    return { name, kind: 'image', missing: false, path: join(dir, name), shown: name };
  };
  const takingImages = () => {
    const m = fakeLmModel({ id: 'auto', name: 'Auto' });
    (m.model as unknown as { capabilities: Record<string, boolean> }).capabilities.supportsImageToText = true;
    return m;
  };

  it('a step sends no image over 5 MB and at most 20 images, filling 20 MB in order; the list says why for the rest', async () => {
    const s = step({ attachments: [image('huge.png', 5 * MB + 1), ...Array.from({ length: 21 }, (_, i) => image(`i${i}.png`, 10))] });
    const m = takingImages();
    await provider({ lm: models(m.model) }).runStep(s.ctx, allowAll);
    const content = m.requests[0].messages[1].content;
    expect(content.filter((c) => c instanceof vscode.LanguageModelDataPart)).toHaveLength(20);
    const listText = (content[0] as vscode.LanguageModelTextPart).value;
    expect(listText).toContain("- huge.png (image over 5 MB: it couldn't be shown to the model)");
    expect(listText).toContain('- i19.png (image, attached to this message)');
    expect(listText).toContain("- i20.png (image not sent (too many large images): it couldn't be shown to the model)");

    const bytes = step({ attachments: ['b1', 'b2', 'b3', 'b4', 'b5'].map((n) => image(`${n}.png`, Math.floor(4.5 * MB))) });
    const m2 = takingImages();
    await provider({ lm: models(m2.model) }).runStep(bytes.ctx, allowAll);
    expect(m2.requests[0].messages[1].content.filter((c) => c instanceof vscode.LanguageModelDataPart)).toHaveLength(4);
  });

  it('a chat message leaves out an image over 5 MB and any image past the budget, with a line for each', async () => {
    const png = (name: string, size: number): TurnFile => ({ name, kind: 'image', path: name, mediaType: 'image/png', data: Buffer.alloc(size).toString('base64') });
    const m = takingImages();
    const events: PlannerEvent[] = [];
    const cwd = mkdtempSync(join(tmpdir(), 'copilot-chat-budget-'));
    await provider({ lm: models(m.model) }).planTurn({
      prompt: 'Look.',
      systemAppend: '',
      cwd,
      tools: [],
      files: [png('huge.png', 5 * MB + 1), ...Array.from({ length: 21 }, (_, i) => png(`i${i}.png`, 10))],
      gate: createPlannerGate({ projectDir: cwd, privateFiles: [], graphToolNames: new Set() }),
      signal: new AbortController().signal,
      onEvent: (e) => events.push(e),
      transcript: { load: () => undefined, save: () => {} },
    });
    const content = m.requests[0].messages.at(-1)!.content;
    expect(content.filter((c) => c instanceof vscode.LanguageModelDataPart)).toHaveLength(20);
    expect(content[0]).toEqual(
      text("Look.\n\nNote: huge.png couldn't be included: it is too large to send (images up to 5 MB are sent).\nNote: i20.png couldn't be included: the message's files were too large to send together.\n"),
    );
    expect(events).toContainEqual({ type: 'note', text: "i20.png couldn't be included: the message's files were too large to send together." });
  });
});

describe('Copilot planner: chat attachments (step model spec §6b.5)', () => {
  const image: TurnFile = { name: 'shot.png', kind: 'image', path: 'shot.png', mediaType: 'image/png', data: Buffer.from('PNG').toString('base64') };
  const pdf: TurnFile = { name: 'spec.pdf', kind: 'pdf', path: 'spec.pdf', mediaType: 'application/pdf', data: 'JVBE' };
  function chatTurn(files: TurnFile[]) {
    const events: PlannerEvent[] = [];
    const saved = new Map<string, ChatMessage[]>();
    const cwd = mkdtempSync(join(tmpdir(), 'copilot-chat-'));
    const t: PlannerTurn = {
      prompt: 'What is this?',
      systemAppend: 'You are the planner.',
      cwd,
      tools: [],
      files,
      gate: createPlannerGate({ projectDir: cwd, privateFiles: [], graphToolNames: new Set() }),
      signal: new AbortController().signal,
      onEvent: (e) => events.push(e),
      transcript: { load: (id) => saved.get(id), save: (id, messages) => void saved.set(id, structuredClone(messages)) },
    };
    return { t, events, saved };
  }
  const model = (images: boolean) => {
    const m = fakeLmModel({ id: 'auto', name: 'Auto' });
    (m.model as unknown as { capabilities: Record<string, boolean> }).capabilities.supportsImageToText = images;
    return m;
  };

  it('sends images to a model that takes them, says a PDF couldn’t be included, and saves no image bytes', async () => {
    const m = model(true);
    const c = chatTurn([image, pdf]);
    await provider({ lm: models(m.model) }).planTurn(c.t);
    expect(m.requests[0].messages.at(-1)?.content).toEqual([text("What is this?\n\nNote: spec.pdf couldn't be included: GitHub Copilot can't read PDFs in the chat.\n"), new vscode.LanguageModelDataPart(Buffer.from('PNG'), 'image/png')]);
    expect(c.events).toContainEqual({ type: 'note', text: "spec.pdf couldn't be included: GitHub Copilot can't read PDFs in the chat." });
    const savedConversation = JSON.stringify([...c.saved.values()]);
    expect(savedConversation).not.toContain(image.data);
    expect(savedConversation).toContain('[An image was attached here.]');
  });

  it('says an image couldn’t be included for a model that doesn’t take images', async () => {
    const m = model(false);
    const c = chatTurn([image]);
    await provider({ lm: models(m.model) }).planTurn(c.t);
    expect(m.requests[0].messages.at(-1)?.content).toEqual([text("What is this?\n\nNote: shot.png couldn't be included: Auto doesn't take images.\n")]);
    expect(c.events).toContainEqual({ type: 'note', text: "shot.png couldn't be included: Auto doesn't take images." });
  });
});
