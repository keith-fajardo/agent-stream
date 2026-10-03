import type { EffortLevel, ModelChoice } from './types';

/** Claude Code's own "Default (recommended)" row: what runs when no model is passed. */
export const CLI_DEFAULT_MODEL = 'default';

/** A model by its value, or a full id by the alias row it resolves to (claude-sonnet-5 → sonnet). */
export function findModel(models: readonly ModelChoice[] | undefined, id: string): ModelChoice | undefined {
  return models?.find((m) => m.value === id) ?? models?.find((m) => m.resolved === id);
}

/** The levels our Default offers: the configured default model's, else Claude Code's default row's; [] when unknown. */
export function defaultEffortsFor(models: readonly ModelChoice[], defaultModel: string | undefined): EffortLevel[] {
  return (defaultModel ? findModel(models, defaultModel) : models.find((m) => m.value === CLI_DEFAULT_MODEL))?.efforts ?? [];
}

/** The models a menu lists after its own Default: Claude Code's default row is left out, since Default stands for it. */
export function menuModels(models: readonly ModelChoice[]): ModelChoice[] {
  return models.filter((m) => m.value !== CLI_DEFAULT_MODEL);
}
