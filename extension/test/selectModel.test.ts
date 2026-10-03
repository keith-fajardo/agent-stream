import { describe, expect, it, vi } from 'vitest';
import type { ModelChoice } from '@agent-stream/shared';
import { selectModel, type SelectModelDeps } from '../src/selectModel';

const MODELS: ModelChoice[] = [
  { value: 'sonnet', label: 'Sonnet', description: 'Everyday tasks', efforts: ['low', 'high'] },
  { value: 'haiku', label: 'Haiku', efforts: [] },
  { value: 'gpt', label: 'GPT', efforts: [], unavailable: true },
];

/** A fake Ui quick pick that answers each call in turn with the item whose value matches. */
function deps(answers: (string | undefined)[], current = { model: '', effort: '' }) {
  const quickPick = vi.fn(async (items: { value: string }[]) => {
    const answer = answers.shift();
    return answer === undefined ? undefined : items.find((i) => i.value === answer)?.value;
  });
  const d = { models: vi.fn(async () => MODELS), current: () => current, ui: { quickPick }, write: vi.fn(async () => {}) };
  return { d: d as unknown as SelectModelDeps & typeof d, quickPick };
}

describe('selectModel', () => {
  it('picks a model, then one of its effort levels, and writes both settings', async () => {
    const { d, quickPick } = deps(['sonnet', 'high']);
    await selectModel(d);
    const [models, modelPlaceholder] = quickPick.mock.calls[0] as unknown as [{ label: string; description?: string; value: string }[], string];
    expect(models.map((i) => [i.label, i.value])).toEqual([
      ['$(check) Default', ''],
      ['Sonnet', 'sonnet'],
      ['Haiku', 'haiku'],
    ]);
    expect(modelPlaceholder).toContain('model');
    const [efforts] = quickPick.mock.calls[1] as unknown as [{ label: string; value: string }[]];
    expect(efforts.map((i) => i.value)).toEqual(['', 'low', 'high']);
    expect(d.write).toHaveBeenCalledWith('sonnet', 'high');
  });

  it("writes an empty effort for a model without levels, without asking", async () => {
    const { d, quickPick } = deps(['haiku'], { model: 'sonnet', effort: 'high' });
    await selectModel(d);
    expect(quickPick).toHaveBeenCalledTimes(1);
    expect(d.write).toHaveBeenCalledWith('haiku', '');
  });

  it('writes Default as empty settings, and nothing when cancelled', async () => {
    const def = deps(['']);
    await selectModel(def.d);
    expect(def.d.write).toHaveBeenCalledWith('', '');
    const cancelModel = deps([undefined]);
    await selectModel(cancelModel.d);
    const cancelEffort = deps(['sonnet', undefined]);
    await selectModel(cancelEffort.d);
    expect(cancelModel.d.write).not.toHaveBeenCalled();
    expect(cancelEffort.d.write).not.toHaveBeenCalled();
  });

  it('keeps offering a saved model the provider no longer lists, and marks the current choices', async () => {
    const { d, quickPick } = deps(['old', ''], { model: 'old', effort: 'low' });
    d.models.mockResolvedValueOnce([]);
    await selectModel(d);
    const [models] = quickPick.mock.calls[0] as unknown as [{ label: string; value: string }[]];
    expect(models.map((i) => [i.label, i.value])).toEqual([
      ['Default', ''],
      ['$(check) old', 'old'],
    ]);
    expect(d.write).toHaveBeenCalledWith('old', '');
  });

  it("merges Claude Code's default row into Default, which then offers that row's levels", async () => {
    const { d, quickPick } = deps(['', 'max']);
    d.models.mockResolvedValueOnce([{ value: 'default', label: 'Default (recommended)', efforts: ['low', 'max'] }, ...MODELS]);
    await selectModel(d);
    const [models] = quickPick.mock.calls[0] as unknown as [{ value: string }[]];
    expect(models.map((i) => i.value)).toEqual(['', 'sonnet', 'haiku']);
    const [efforts] = quickPick.mock.calls[1] as unknown as [{ value: string }[]];
    expect(efforts.map((i) => i.value)).toEqual(['', 'low', 'max']);
    expect(d.write).toHaveBeenCalledWith('', 'max');
  });

  it('marks the alias row a saved full id resolves to, offering its levels', async () => {
    const { d, quickPick } = deps(['claude-sonnet-5', 'low'], { model: 'claude-sonnet-5', effort: 'high' });
    d.models.mockResolvedValueOnce([{ ...MODELS[0], resolved: 'claude-sonnet-5' }, MODELS[1]]);
    await selectModel(d);
    const [models] = quickPick.mock.calls[0] as unknown as [{ label: string; value: string }[]];
    expect(models.map((i) => [i.label, i.value])).toEqual([
      ['Default', ''],
      ['$(check) Sonnet', 'sonnet'],
      ['Haiku', 'haiku'],
    ]);
    // The fake picks by value; a saved id that isn't listed as such is not offered twice.
    expect(d.write).not.toHaveBeenCalled();
    const again = deps(['sonnet', 'low'], { model: 'claude-sonnet-5', effort: 'high' });
    again.d.models.mockResolvedValueOnce([{ ...MODELS[0], resolved: 'claude-sonnet-5' }, MODELS[1]]);
    await selectModel(again.d);
    const [efforts] = again.quickPick.mock.calls[1] as unknown as [{ label: string; value: string }[]];
    expect(efforts.map((i) => i.label)).toEqual(['Default', 'low', '$(check) high']);
    expect(again.d.write).toHaveBeenCalledWith('sonnet', 'low');
  });
});
