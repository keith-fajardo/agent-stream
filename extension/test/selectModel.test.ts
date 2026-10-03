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
});
