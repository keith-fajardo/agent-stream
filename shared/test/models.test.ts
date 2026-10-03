import { describe, expect, it } from 'vitest';
import { isEffortLevel, modelLine, supportsEffort } from '../src/format';
import { defaultEffortsFor, findModel, menuModels } from '../src/models';
import type { ModelChoice } from '../src/types';
import { parseWebviewMessage } from '../src/schemas';

describe('supportsEffort', () => {
  it('is false for Copilot only', () => {
    expect(supportsEffort('copilot')).toBe(false);
    expect(supportsEffort('claude')).toBe(true);
  });
});

describe('modelLine', () => {
  it('names the model by its label, else its id, else Default', () => {
    expect(modelLine({})).toBe('Model: Default · Effort: Default');
    expect(modelLine({ model: 'opus', label: 'Opus', effort: 'high' })).toBe('Model: Opus · Effort: high');
    expect(modelLine({ model: 'claude-x' })).toBe('Model: claude-x · Effort: Default');
  });

  it('says Copilot runs do not support effort, whatever was configured', () => {
    expect(modelLine({ provider: 'copilot', model: 'auto', label: 'Auto', effort: 'high' })).toBe('Model: Auto · Effort: not supported');
    expect(modelLine({ provider: 'claude', effort: 'high' })).toBe('Model: Default · Effort: high');
  });
});

describe('isEffortLevel', () => {
  it('accepts the SDK levels only', () => {
    for (const l of ['low', 'medium', 'high', 'xhigh', 'max']) expect(isEffortLevel(l)).toBe(true);
    for (const l of ['', 'huge', 3, undefined]) expect(isEffortLevel(l)).toBe(false);
  });
});

describe('setPlannerModel', () => {
  it('parses a choice, and Default as no fields', () => {
    const msg = { type: 'setPlannerModel', graphId: 'g', sessionId: 's', model: 'opus', effort: 'max' };
    expect(parseWebviewMessage(msg)).toEqual({ ok: true, kind: 'engine', msg });
    const plain = { type: 'setPlannerModel', graphId: 'g', sessionId: 's' };
    expect(parseWebviewMessage(plain)).toEqual({ ok: true, kind: 'engine', msg: plain });
  });
  it('refuses an unknown effort', () => {
    expect(parseWebviewMessage({ type: 'setPlannerModel', graphId: 'g', sessionId: 's', effort: 'huge' }).ok).toBe(false);
  });
});

describe('model lookup', () => {
  const MODELS: ModelChoice[] = [
    { value: 'default', label: 'Default (recommended)', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
    { value: 'sonnet', label: 'Sonnet', resolved: 'claude-sonnet-5', efforts: ['low', 'high'] },
    { value: 'claude-opus-4-6', label: 'Opus 4.6', efforts: ['low', 'medium', 'high', 'max'] },
    { value: 'haiku', label: 'Haiku', efforts: [] },
  ];
  it('finds a model by its value, or a full id by the alias row it resolves to', () => {
    expect(findModel(MODELS, 'sonnet')?.label).toBe('Sonnet');
    expect(findModel(MODELS, 'claude-sonnet-5')?.label).toBe('Sonnet');
    expect(findModel(MODELS, 'claude-opus-4-6')?.label).toBe('Opus 4.6');
    expect(findModel(MODELS, 'nope')).toBeUndefined();
    expect(findModel(undefined, 'sonnet')).toBeUndefined();
  });
  it("gives Default the configured model's levels, else Claude Code's default row's", () => {
    expect(defaultEffortsFor(MODELS, undefined)).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(defaultEffortsFor(MODELS, 'claude-sonnet-5')).toEqual(['low', 'high']);
    expect(defaultEffortsFor(MODELS, 'haiku')).toEqual([]);
    expect(defaultEffortsFor(MODELS, 'unknown')).toEqual([]);
    expect(defaultEffortsFor([], undefined)).toEqual([]);
  });
  it("leaves Claude Code's own default row out of the menus: our Default stands for it", () => {
    expect(menuModels(MODELS).map((m) => m.value)).toEqual(['sonnet', 'claude-opus-4-6', 'haiku']);
  });
});
