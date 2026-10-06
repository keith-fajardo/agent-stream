import { describe, expect, it } from 'vitest';
import type { EffortLevel, ModelChoice } from '@agent-stream/shared';
import { DEFAULT_MODEL_OPTION, effortMenu, modelMenu, NOT_SUPPORTED } from '../src/stepModelMenus';

const all: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const CLAUDE: ModelChoice[] = [
  { value: 'default', label: 'Default (recommended)', efforts: all },
  { value: 'claude-opus-4-6', label: 'Opus 4.6', efforts: ['low', 'medium', 'high', 'max'] },
  { value: 'sonnet', label: 'Sonnet', efforts: all, resolved: 'claude-sonnet-5' },
  { value: 'opus', label: 'Opus', efforts: all },
  { value: 'haiku', label: 'Haiku', efforts: [] },
  { value: 'claude-opus-5', label: 'Opus 5', efforts: all },
];
const CODEX: ModelChoice[] = [
  { value: 'gpt-6.1-sol', label: 'GPT-6.1-Sol', efforts: [...all, 'ultra'], isDefault: true },
  { value: 'gpt-6-astra', label: 'GPT-6-Astra', efforts: [...all, 'ultra'] },
];
const COPILOT: ModelChoice[] = [{ value: 'auto', label: 'Auto', efforts: [] }, { value: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', efforts: [] }];

describe('a step’s Model menu (spec §4.1)', () => {
  it('Claude: Default, the aliases in the list’s order, then the pinned versions', () => {
    const menu = modelMenu('claude', CLAUDE, '');
    expect(menu.options.map((o) => o.label)).toEqual([DEFAULT_MODEL_OPTION, 'Default (recommended)', 'Sonnet', 'Opus', 'Haiku']);
    expect(menu.options.map((o) => o.value)).toEqual(['', 'claude/default', 'claude/sonnet', 'claude/opus', 'claude/haiku']);
    expect(menu.pinned).toEqual([
      { value: 'claude/claude-opus-4-6', label: 'Opus 4.6' },
      { value: 'claude/claude-opus-5', label: 'Opus 5' },
    ]);
    expect(menu.extra).toBeUndefined();
  });

  it('Codex and Copilot: the list’s order, no pinned group (Copilot’s Auto comes first in its list)', () => {
    expect(modelMenu('codex', CODEX, '').options.map((o) => o.value)).toEqual(['', 'codex/gpt-6.1-sol', 'codex/gpt-6-astra']);
    expect(modelMenu('copilot', COPILOT, '').options.map((o) => o.label)).toEqual([DEFAULT_MODEL_OPTION, 'Auto', 'GPT-5.6 Sol']);
    expect(modelMenu('codex', CODEX, '').pinned).toEqual([]);
  });

  it('another provider’s model shows disabled, with Use Default', () => {
    const menu = modelMenu('claude', CLAUDE, 'codex/gpt-6-astra');
    expect(menu.extra).toEqual({ value: 'codex/gpt-6-astra', label: 'OpenAI Codex · gpt-6-astra (not the current provider)', disabled: true });
    expect(menu.otherProvider).toBe(true);
  });

  it('a model the known list doesn’t contain shows as not offered; a full id an alias stands for, or any id without a list, as itself', () => {
    expect(modelMenu('claude', CLAUDE, 'claude/claude-opus-4-1').extra).toEqual({ value: 'claude/claude-opus-4-1', label: 'claude-opus-4-1 (not offered)' });
    expect(modelMenu('claude', CLAUDE, 'claude/claude-sonnet-5').extra).toEqual({ value: 'claude/claude-sonnet-5', label: 'claude-sonnet-5' });
    expect(modelMenu('claude', [], 'claude/opus')).toMatchObject({ extra: { value: 'claude/opus', label: 'opus' }, otherProvider: false });
  });
});

describe('a step’s Effort menu (spec §4.1, §6)', () => {
  it('offers Default and the levels the chosen model offers', () => {
    expect(effortMenu('claude', CLAUDE, all, 'claude/claude-opus-4-6', '').options.map((o) => o.value)).toEqual(['', 'low', 'medium', 'high', 'max']);
    expect(effortMenu('codex', CODEX, [...all, 'ultra'], 'codex/gpt-6-astra', 'ultra')).toEqual({ disabled: false, options: expect.arrayContaining([{ value: 'ultra', label: 'ultra' }]) });
  });

  it('on Default, the levels the provider reports for its default model', () => {
    expect(effortMenu('claude', CLAUDE, ['low', 'high'], '', '').options.map((o) => o.value)).toEqual(['', 'low', 'high']);
    // A model the step won't run (another provider's) also falls back to the default's levels.
    expect(effortMenu('claude', CLAUDE, ['low'], 'codex/gpt-6-astra', '').options.map((o) => o.value)).toEqual(['', 'low']);
  });

  it('is disabled and reads Not supported for a model with no levels, and on Copilot', () => {
    expect(effortMenu('claude', CLAUDE, all, 'claude/haiku', '')).toEqual({ disabled: true, options: [{ value: '', label: NOT_SUPPORTED }] });
    expect(effortMenu('copilot', COPILOT, [], 'copilot/auto', 'high')).toEqual({ disabled: true, options: [{ value: 'high', label: NOT_SUPPORTED }] });
    expect(effortMenu('copilot', [], [], '', '')).toEqual({ disabled: true, options: [{ value: '', label: NOT_SUPPORTED }] });
  });

  it('keeps a stored level the model doesn’t offer visible, and offers only Default and it while the list is unknown', () => {
    expect(effortMenu('claude', CLAUDE, all, 'claude/claude-opus-4-6', 'xhigh').options.at(-1)).toEqual({ value: 'xhigh', label: 'xhigh (not offered)' });
    expect(effortMenu('claude', [], [], 'claude/opus', 'high')).toEqual({ disabled: false, options: [{ value: '', label: 'Default' }, { value: 'high', label: 'high' }] });
  });
});
