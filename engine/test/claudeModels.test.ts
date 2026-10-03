import { describe, expect, it, vi } from 'vitest';
import type { ModelInfo, Options, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { emptyGraph, type GraphNode } from '@agent-stream/shared';
import { ApprovalBroker } from '../src/approvals';
import type { NodeContext } from '../src/executors';
import { PLANNER_APPEND } from '../src/planner';
import { createClaudeProvider } from '../src/providers/claude';
import { fetchModels } from '../src/providers/claude/models';
import type { ModelQueryFn, QueryFn } from '../src/providers/claude/sdk';
import { createPlannerGate, createStepGate } from '../src/providers/toolGate';
import type { PlannerTurn } from '../src/providers/types';
import { signedIn } from './helpers';

const msg = (m: object) => m as unknown as SDKMessage;
const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
const init = () => msg({ type: 'system', subtype: 'init', apiKeySource: 'none', session_id: 's1' });
const done = () => msg({ type: 'result', subtype: 'success', is_error: false, result: 'ok', num_turns: 1, total_cost_usd: 0, usage, session_id: 's1' });

const INFOS: ModelInfo[] = [
  { value: 'default', displayName: 'Default (recommended)', description: 'The most capable model', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { value: 'sonnet', resolvedModel: 'claude-sonnet-5', displayName: 'Sonnet', description: 'Everyday tasks', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high'] },
  { value: 'haiku', displayName: 'Haiku', description: '', supportsEffort: false },
  // Levels listed but effort not supported: no levels offered.
  { value: 'old', displayName: 'Old', description: 'Legacy', supportsEffort: false, supportedEffortLevels: ['low'] },
];

function setup(o: { infos?: () => Promise<ModelInfo[]>; signIn?: boolean } = {}) {
  const calls: { prompt: string; options: Options }[] = [];
  const queryFn: QueryFn = ({ prompt, options }) => {
    calls.push({ prompt, options: options! });
    return (async function* () {
      yield init();
      yield done();
    })();
  };
  const modelCalls: { prompt: AsyncIterable<SDKUserMessage>; options: Options }[] = [];
  const close = vi.fn();
  const modelQueryFn: ModelQueryFn = ({ prompt, options }) => {
    modelCalls.push({ prompt, options: options! });
    return { supportedModels: o.infos ?? (async () => INFOS), close };
  };
  const log = vi.fn();
  const provider = createClaudeProvider({
    findClaude: () => ({ ok: true, path: '/usr/local/bin/claude' }),
    checkAuth: async () => signedIn,
    queryFn,
    modelQueryFn,
    log,
    env: { PATH: '/bin', ANTHROPIC_API_KEY: 'sk' },
  });
  return { provider, calls, modelCalls, close, log, signIn: () => provider.status() };
}

const turn = (over: Partial<PlannerTurn> = {}): PlannerTurn => ({
  prompt: 'hi',
  systemAppend: PLANNER_APPEND,
  cwd: '/proj',
  tools: [],
  gate: createPlannerGate({ projectDir: '/proj', privateFiles: [], graphToolNames: new Set() }),
  signal: new AbortController().signal,
  onEvent: () => {},
  transcript: { load: () => undefined, save: () => {} },
  ...over,
});

function ctx(over: Partial<NodeContext> = {}): NodeContext {
  const node: GraphNode = { id: 'n1', title: 'Write', kind: 'agent', prompt: 'p', createdBy: 'user', updatedBy: 'user', updatedAt: 't' };
  return { runId: 'r1', graph: emptyGraph('g', 'G', 't'), node, prompt: 'P', cwd: '/proj', signal: new AbortController().signal, emit: () => {}, ...over };
}
const gateFor = (c: NodeContext) =>
  createStepGate({ broker: new ApprovalBroker(), runId: c.runId, graphId: c.graph.id, nodeId: c.node.id, nodeTitle: c.node.title, projectDir: c.cwd, privateFiles: [], signal: c.signal, emit: c.emit });

describe('Claude provider: model and effort', () => {
  it('passes the model and effort into a planner turn when given, and omits them otherwise', async () => {
    const s = setup();
    await s.signIn();
    await s.provider.planTurn(turn({ model: 'sonnet', effort: 'high' }));
    expect(s.calls[0].options).toMatchObject({ model: 'sonnet', effort: 'high' });
    await s.provider.planTurn(turn());
    expect('model' in s.calls[1].options).toBe(false);
    expect('effort' in s.calls[1].options).toBe(false);
  });

  it('passes the model and effort into an agent step when given, and omits them otherwise', async () => {
    const s = setup();
    await s.signIn();
    const withChoice = ctx({ model: 'sonnet', effort: 'low' });
    expect((await s.provider.runStep(withChoice, gateFor(withChoice))).ok).toBe(true);
    expect(s.calls[0].options).toMatchObject({ model: 'sonnet', effort: 'low' });
    const plain = ctx();
    await s.provider.runStep(plain, gateFor(plain));
    expect('model' in s.calls[1].options).toBe(false);
    expect('effort' in s.calls[1].options).toBe(false);
  });

  it("drops an effort the chosen model doesn't offer, logs it once, and still runs", async () => {
    const s = setup();
    await s.signIn();
    await s.provider.listModels!();
    expect((await s.provider.planTurn(turn({ model: 'haiku', effort: 'high' }))).ok).toBe(true);
    expect(s.calls[0].options.model).toBe('haiku');
    expect('effort' in s.calls[0].options).toBe(false);
    const c = ctx({ model: 'sonnet', effort: 'max' });
    expect((await s.provider.runStep(c, gateFor(c))).ok).toBe(true);
    expect(s.calls[1].options.model).toBe('sonnet');
    expect('effort' in s.calls[1].options).toBe(false);
    await s.provider.planTurn(turn({ model: 'haiku', effort: 'high' }));
    expect(s.log).toHaveBeenCalledTimes(2);
    expect(s.log.mock.calls[0][0]).toContain('haiku');
    // An offered level, a model the list doesn't know, and no model at all keep the effort.
    await s.provider.planTurn(turn({ model: 'sonnet', effort: 'medium' }));
    await s.provider.planTurn(turn({ model: 'claude-custom', effort: 'xhigh' }));
    await s.provider.planTurn(turn({ effort: 'max' }));
    expect(s.calls.slice(3).map((c) => c.options.effort)).toEqual(['medium', 'xhigh', 'max']);
  });

  it("checks a full model id against the alias row it resolves to, and no model against Claude Code's default row", async () => {
    const s = setup({ infos: async () => [...INFOS.slice(1), { value: 'default', displayName: 'Default (recommended)', description: '', supportsEffort: true, supportedEffortLevels: ['low', 'high'] }] });
    await s.signIn();
    await s.provider.listModels!();
    await s.provider.planTurn(turn({ model: 'claude-sonnet-5', effort: 'high' }));
    await s.provider.planTurn(turn({ model: 'claude-sonnet-5', effort: 'max' }));
    await s.provider.planTurn(turn({ effort: 'max' }));
    await s.provider.planTurn(turn({ effort: 'high' }));
    expect(s.calls.map((c) => [c.options.model, c.options.effort])).toEqual([
      ['claude-sonnet-5', 'high'],
      ['claude-sonnet-5', undefined],
      [undefined, undefined],
      [undefined, 'high'],
    ]);
    expect(s.log).toHaveBeenCalledTimes(2);
  });

  it('keeps the effort while the model list is unknown', async () => {
    const s = setup();
    await s.signIn();
    await s.provider.planTurn(turn({ model: 'haiku', effort: 'high' }));
    expect(s.calls[0].options).toMatchObject({ model: 'haiku', effort: 'high' });
  });
});

describe('Claude provider: listModels', () => {
  it("maps the SDK's models without a model turn, and closes the query", async () => {
    const s = setup();
    await s.signIn();
    expect(await s.provider.listModels!()).toEqual([
      { value: 'default', label: 'Default (recommended)', description: 'The most capable model', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
      { value: 'sonnet', label: 'Sonnet', description: 'Everyday tasks', efforts: ['low', 'medium', 'high'], resolved: 'claude-sonnet-5' },
      { value: 'haiku', label: 'Haiku', efforts: [] },
      { value: 'old', label: 'Old', description: 'Legacy', efforts: [] },
    ]);
    expect(s.modelCalls).toHaveLength(1);
    expect(s.modelCalls[0].options).toMatchObject({ pathToClaudeCodeExecutable: '/usr/local/bin/claude', settingSources: [], persistSession: false, tools: [] });
    expect(s.modelCalls[0].options.env).toEqual({ PATH: '/bin' });
    // Streaming input that never sends a message: nothing reaches the model.
    const next = s.modelCalls[0].prompt[Symbol.asyncIterator]().next();
    const first = await Promise.race([next.then(() => 'message'), new Promise((r) => setTimeout(() => r('none'), 20))]);
    expect(first).toBe('none');
    expect(s.close).toHaveBeenCalledTimes(1);
    expect(s.calls).toHaveLength(0);
  });

  it('is cached for the life of the provider', async () => {
    const s = setup();
    await s.signIn();
    const [a, b] = await Promise.all([s.provider.listModels!(), s.provider.listModels!()]);
    const c = await s.provider.listModels!();
    expect(b).toEqual(a);
    expect(c).toEqual(a);
    expect(s.modelCalls).toHaveLength(1);
  });

  it('returns [] on failure and logs once; the failure stays for the window, with one retry when asked', async () => {
    let fail = true;
    const s = setup({ infos: async () => (fail ? Promise.reject(new Error('boom')) : INFOS) });
    await s.signIn();
    expect(await s.provider.listModels!()).toEqual([]);
    expect(await s.provider.listModels!()).toEqual([]);
    expect(s.modelCalls).toHaveLength(1);
    expect(s.log).toHaveBeenCalledTimes(1);
    expect(s.log.mock.calls[0][0]).toContain('boom');
    expect(s.close).toHaveBeenCalledTimes(1);
    // Select Model or a chat opening may try once more; after that the failure stands.
    expect(await s.provider.listModels!({ retry: true })).toEqual([]);
    expect(await s.provider.listModels!({ retry: true })).toEqual([]);
    expect(s.modelCalls).toHaveLength(2);
    expect(s.log).toHaveBeenCalledTimes(1);
    expect(s.provider.knownModels!()).toBeUndefined();
  });

  it('succeeds on the one retry, and knows the list from then on', async () => {
    let fail = true;
    const s = setup({ infos: async () => (fail ? Promise.reject(new Error('boom')) : INFOS) });
    await s.signIn();
    expect(s.provider.knownModels!()).toBeUndefined();
    await s.provider.listModels!();
    fail = false;
    expect(await s.provider.listModels!({ retry: true })).toHaveLength(4);
    expect(s.provider.knownModels!()).toHaveLength(4);
    expect(await s.provider.listModels!({ retry: true })).toHaveLength(4);
    expect(s.modelCalls).toHaveLength(2);
  });

  it('returns [] before Claude Code is found, without starting it', async () => {
    const s = setup();
    expect(await s.provider.listModels!()).toEqual([]);
    expect(s.modelCalls).toHaveLength(0);
  });

  it('gives up on a CLI that never answers, and closes it', async () => {
    const close = vi.fn();
    const hang: ModelQueryFn = () => ({ supportedModels: () => new Promise(() => {}), close });
    await expect(fetchModels(hang, '/bin/claude', {}, 10)).rejects.toThrow('did not answer');
    expect(close).toHaveBeenCalledTimes(1);
  });
});
