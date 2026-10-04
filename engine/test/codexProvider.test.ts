import { describe, expect, it, vi } from 'vitest';
import { emptyGraph, type GraphNode, type NodeEventBody } from '@agent-stream/shared';
import type { NodeContext } from '../src/executors';
import type { Found } from '../src/platform';
import { createCodexProvider } from '../src/providers/codex';
import { CODEX_MISSING } from '../src/providers/codex/auth';
import type { Model } from '../src/providers/codex/protocol';
import { agentMessage, fakeCodex, turnHandlers, type FakeHandler } from './codexFake';
import { allowAll } from './helpers';

const gptA: Model = {
  id: 'gpt-a',
  model: 'gpt-a',
  displayName: 'GPT A',
  description: '',
  hidden: false,
  supportedReasoningEfforts: [{ reasoningEffort: 'low', description: '' }],
  defaultReasoningEffort: 'low',
  isDefault: true,
};
const signedIn: Record<string, FakeHandler> = {
  'account/read': () => ({ account: { type: 'chatgpt', email: null, planType: 'plus' }, requiresOpenaiAuth: true }),
  'model/list': () => ({ data: [gptA], nextCursor: null }),
  ...turnHandlers({
    script: (t) => {
      t.item(agentMessage('Done.'));
      t.end();
    },
  }),
};

function provider(found: Found, handlers: Record<string, FakeHandler> = signedIn) {
  const fake = fakeCodex(handlers);
  const findCodex = vi.fn(() => found);
  const log = vi.fn();
  const p = createCodexProvider({ findCodex, spawn: fake.spawn, env: {}, platform: 'linux', log });
  return { p, fake, findCodex, log };
}

function ctx(o: { model?: string; effort?: 'low' | 'ultra' } = {}): NodeContext {
  const events: NodeEventBody[] = [];
  const node: GraphNode = { id: 'n1', title: 'Step', kind: 'agent', prompt: 'p', createdBy: 'user', updatedBy: 'user', updatedAt: 't' };
  return { runId: 'r1', graph: emptyGraph('g', 'G', 't'), node, prompt: 'Do it', cwd: '/w', signal: new AbortController().signal, emit: (e) => events.push(e), ...o };
}

describe('createCodexProvider', () => {
  it('is OpenAI Codex', () => {
    const { p } = provider({ ok: true, path: '/bin/codex' });
    expect(p.id).toBe('codex');
    expect(p.name).toBe('OpenAI Codex');
  });

  it('reports a missing Codex without starting anything, and refuses steps with the reason (R6)', async () => {
    const { p, fake } = provider({ ok: false, error: CODEX_MISSING });
    expect(await p.runStep(ctx(), allowAll)).toEqual({ ok: false, output: '', error: 'Agent Stream has not checked for Codex yet.' });
    expect(await p.status()).toEqual({ provider: 'codex', ok: false, label: 'Codex: not found', error: CODEX_MISSING });
    expect(await p.runStep(ctx(), allowAll)).toEqual({ ok: false, output: '', error: CODEX_MISSING });
    expect(await p.listModels?.()).toEqual([]);
    expect(fake.procs).toHaveLength(0);
  });

  it('reads the sign-in with the Codex it found, again on every check, sharing a check in flight (R5)', async () => {
    const { p, fake, findCodex } = provider({ ok: true, path: '/bin/codex' });
    expect(await p.status()).toEqual({ provider: 'codex', ok: true, label: 'Codex (Plus)', detail: 'Signed in with ChatGPT.' });
    expect(fake.last().codexPath).toBe('/bin/codex');
    await Promise.all([p.status(), p.status()]);
    expect(fake.procs).toHaveLength(2);
    await p.status();
    expect(fake.procs).toHaveLength(3);
    expect(findCodex).toHaveBeenCalledTimes(3);
    expect(fake.procs.every((proc) => proc.killed)).toBe(true);
  });

  it('lists the models with the Codex it found, once', async () => {
    const { p, fake } = provider({ ok: true, path: '/bin/codex' });
    expect(await p.listModels?.()).toEqual([]);
    expect(fake.procs).toHaveLength(0);
    await p.status();
    const models = [{ value: 'gpt-a', label: 'GPT A', efforts: ['low'], isDefault: true }];
    expect(await p.listModels?.()).toEqual(models);
    expect(await p.listModels?.()).toEqual(models);
    expect(p.knownModels?.()).toEqual(models);
    expect(fake.procs).toHaveLength(2);
  });

  it('runs steps on the found Codex, dropping an effort the listed model lacks with one warning', async () => {
    const { p, fake, log } = provider({ ok: true, path: '/bin/codex' });
    await p.status();
    await p.listModels?.();
    expect(await p.runStep(ctx({ model: 'gpt-a', effort: 'ultra' }), allowAll)).toEqual({ ok: true, output: 'Done.' });
    expect(await p.runStep(ctx({ model: 'gpt-a', effort: 'ultra' }), allowAll)).toEqual({ ok: true, output: 'Done.' });
    expect(fake.last().paramsOf('turn/start')).not.toHaveProperty('effort');
    expect(log.mock.calls.filter(([m]) => String(m).includes('no "ultra" effort level'))).toHaveLength(1);
  });
});
