import { describe, expect, it, vi } from 'vitest';
import type { ModelChoice } from '@agent-stream/shared';
import { openCodex } from '../src/providers/codex/connection';
import { codexEffort, createModelList, fetchCodexModels, toModelChoice } from '../src/providers/codex/models';
import type { Model } from '../src/providers/codex/protocol';
import { deferred } from './helpers';
import { fakeCodex } from './codexFake';

const model = (id: string, efforts: string[], o: Partial<Model> = {}): Model => ({
  id,
  model: id,
  displayName: id.toUpperCase(),
  description: '',
  hidden: false,
  supportedReasoningEfforts: efforts.map((reasoningEffort) => ({ reasoningEffort, description: '' })),
  defaultReasoningEffort: 'medium',
  isDefault: false,
  ...o,
});

describe('toModelChoice', () => {
  it('maps a Codex model: id, display name (else id), description, known efforts, and the default mark', () => {
    expect(toModelChoice(model('gpt-a', ['none', 'minimal', 'low', 'high', 'xhigh', 'max', 'ultra'], { description: 'Fast', isDefault: true }))).toEqual({
      value: 'gpt-a',
      label: 'GPT-A',
      description: 'Fast',
      efforts: ['low', 'high', 'xhigh', 'max', 'ultra'],
      isDefault: true,
    });
    expect(toModelChoice(model('gpt-b', [], { displayName: '' }))).toEqual({ value: 'gpt-b', label: 'gpt-b', efforts: [] });
  });
});

describe('fetchCodexModels', () => {
  it('reads every page of model/list without hidden models', async () => {
    const pages: Record<string, { data: Model[]; nextCursor: string | null }> = {
      first: { data: [model('gpt-a', ['low']), model('gpt-secret', ['low'], { hidden: true })], nextCursor: 'p2' },
      p2: { data: [model('gpt-b', ['ultra'])], nextCursor: null },
    };
    const fake = fakeCodex({ 'model/list': (p: { cursor?: string }) => pages[p.cursor ?? 'first'] });
    const conn = await openCodex({ codexPath: '/bin/codex', spawn: fake.spawn });
    expect((await fetchCodexModels(conn)).map((m) => m.value)).toEqual(['gpt-a', 'gpt-b']);
    expect(fake.last().received.filter((m) => m.method === 'model/list').map((m) => m.params)).toEqual([{ includeHidden: false }, { includeHidden: false, cursor: 'p2' }]);
    conn.close();
  });

  it('stops after 10 pages', async () => {
    let n = 0;
    const fake = fakeCodex({ 'model/list': () => ({ data: [model(`m${++n}`, [])], nextCursor: 'more' }) });
    const conn = await openCodex({ codexPath: '/bin/codex', spawn: fake.spawn });
    expect(await fetchCodexModels(conn)).toHaveLength(10);
    conn.close();
  });
});

describe('createModelList', () => {
  const list: ModelChoice[] = [{ value: 'gpt-a', label: 'A', efforts: ['low'] }];

  it('loads once for concurrent callers, then answers from the cache', async () => {
    const d = deferred<ModelChoice[]>();
    const load = vi.fn(() => d.promise);
    const models = createModelList(load, () => {});
    expect(models.known()).toBeUndefined();
    const a = models.list();
    const b = models.list();
    d.resolve(list);
    expect(await a).toEqual(list);
    expect(await b).toEqual(list);
    expect(await models.list()).toEqual(list);
    expect(models.known()).toEqual(list);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('remembers a failure for the window, logs it once, and tries again once when asked', async () => {
    const load = vi.fn<() => Promise<ModelChoice[]>>().mockRejectedValueOnce(new Error('offline')).mockRejectedValueOnce(new Error('still offline')).mockResolvedValue(list);
    const log = vi.fn();
    const models = createModelList(load, log);
    expect(await models.list()).toEqual([]);
    expect(log).toHaveBeenCalledWith('[agent-stream] Could not list Codex models; the menus offer only Default (offline).');
    expect(await models.list()).toEqual([]);
    expect(load).toHaveBeenCalledTimes(1);
    expect(await models.list({ retry: true })).toEqual([]);
    expect(load).toHaveBeenCalledTimes(2);
    expect(await models.list({ retry: true })).toEqual([]);
    expect(load).toHaveBeenCalledTimes(2);
  });
});

describe('codexEffort', () => {
  const known: ModelChoice[] = [
    { value: 'gpt-a', label: 'A', efforts: ['low', 'high'] },
    { value: 'gpt-b', label: 'B', efforts: ['low', 'ultra'], isDefault: true },
  ];

  it('passes an effort the model offers, and keeps it when the list is unknown or does not name the model (R9)', () => {
    const warn = vi.fn();
    expect(codexEffort({ model: 'gpt-a', effort: 'high' }, known, warn)).toBe('high');
    expect(codexEffort({ effort: 'ultra' }, known, warn)).toBe('ultra');
    expect(codexEffort({ model: 'gpt-z', effort: 'max' }, known, warn)).toBe('max');
    expect(codexEffort({ effort: 'max' }, undefined, warn)).toBe('max');
    expect(codexEffort({ model: 'gpt-a' }, known, warn)).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it("drops an effort the model doesn't offer, with a line naming it; Default checks the model marked default", () => {
    const warn = vi.fn();
    expect(codexEffort({ model: 'gpt-a', effort: 'ultra' }, known, warn)).toBeUndefined();
    expect(warn).toHaveBeenCalledWith('gpt-a|ultra', '[agent-stream] A (gpt-a) has no "ultra" effort level; running without an effort level.');
    expect(codexEffort({ effort: 'high' }, known, warn)).toBeUndefined();
    expect(warn).toHaveBeenLastCalledWith('gpt-b|high', '[agent-stream] B (gpt-b) has no "high" effort level; running without an effort level.');
  });
});
