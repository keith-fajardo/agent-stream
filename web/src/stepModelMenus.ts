import { findModel, parseStepModel, PROVIDER_NAMES, type EffortLevel, type ModelChoice, type ProviderId } from '@agent-stream/shared';

/** One option of a step's Model or Effort menu. Values are `<provider>/<id>` and effort levels; '' is Default. */
export type MenuOption = { value: string; label: string; disabled?: boolean };
export type ModelMenu = {
  /** Default, then the provider's models in the list's order (Claude: its aliases). */
  options: MenuOption[];
  /** Claude's pinned versions (ids starting `claude-`), shown in their own group. */
  pinned: MenuOption[];
  /** The step's own model when no option stands for it: another provider's, or one the list doesn't offer. */
  extra?: MenuOption;
  /** The step's model belongs to another provider than the current one: the panel offers Use Default. */
  otherProvider: boolean;
};
export type EffortMenu = { disabled: boolean; options: MenuOption[] };

export const DEFAULT_MODEL_OPTION = "Default (the run's model)";
export const NOT_SUPPORTED = 'Not supported';

const option = (provider: ProviderId, m: ModelChoice): MenuOption => ({
  value: `${provider}/${m.value}`,
  label: m.unavailable ? `${m.label} (unavailable)` : m.label,
  ...(m.unavailable && { disabled: true }),
});

/**
 * An agent step's Model menu (step model spec §4.1). `value` is the step's model as `<provider>/<id>`, '' for Default.
 * `models` is the current provider's list; [] while it isn't known.
 */
export function modelMenu(provider: ProviderId | undefined, models: readonly ModelChoice[], value: string): ModelMenu {
  const listed = provider ? models.map((m) => option(provider, m)) : [];
  const isPinned = (o: MenuOption) => provider === 'claude' && o.value.startsWith('claude/claude-');
  const options = [{ value: '', label: DEFAULT_MODEL_OPTION }, ...listed.filter((o) => !isPinned(o))];
  const pinned = listed.filter(isPinned);
  if (!value || listed.some((o) => o.value === value)) return { options, pinned, otherProvider: false };
  const parsed = parseStepModel(value);
  if (!parsed.ok) return { options, pinned, extra: { value, label: value }, otherProvider: false };
  const { provider: own, id } = parsed.model;
  if (provider && own !== provider) {
    return { options, pinned, extra: { value, label: `${PROVIDER_NAMES[own]} · ${id} (not the current provider)`, disabled: true }, otherProvider: true };
  }
  // A full id the list names through an alias (claude-sonnet-5 → sonnet) is offered; with no list we can't tell.
  const offered = models.length === 0 || !!findModel(models, id);
  return { options, pinned, extra: { value, label: offered ? id : `${id} (not offered)` }, otherProvider: false };
}

/**
 * The levels the step's model offers: its row's, or `defaultEfforts` (the provider's default model's) for Default and for a
 * model the step won't run (another provider's, or one not offered). Undefined while the list isn't known.
 */
export function effortsFor(provider: ProviderId | undefined, models: readonly ModelChoice[], defaultEfforts: readonly EffortLevel[], model: string): readonly EffortLevel[] | undefined {
  if (models.length === 0) return undefined;
  if (!model) return defaultEfforts;
  const parsed = parseStepModel(model);
  if (!parsed.ok || parsed.model.provider !== provider) return defaultEfforts;
  return findModel(models, parsed.model.id)?.efforts ?? defaultEfforts;
}

/**
 * An agent step's Effort menu (spec §4.1): Default and the levels the chosen model offers. Disabled, reading Not supported,
 * on Copilot (spec §6) and for a model with no levels. A stored level the menu doesn't offer still shows, so it can be seen.
 */
export function effortMenu(provider: ProviderId | undefined, models: readonly ModelChoice[], defaultEfforts: readonly EffortLevel[], model: string, effort: string): EffortMenu {
  const levels = provider === 'copilot' ? [] : effortsFor(provider, models, defaultEfforts, model);
  if (levels && levels.length === 0) return { disabled: true, options: [{ value: effort, label: NOT_SUPPORTED }] };
  const options: MenuOption[] = [{ value: '', label: 'Default' }, ...(levels ?? []).map((l) => ({ value: l, label: l }))];
  if (effort && !options.some((o) => o.value === effort)) options.push({ value: effort, label: levels ? `${effort} (not offered)` : effort });
  return { disabled: false, options };
}
