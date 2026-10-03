import type { EffortLevel, ModelChoice } from '@agent-stream/shared';
import type { Ui } from './commands';

export type SelectModelDeps = {
  /** The current provider's models ([] when they can't be listed). */
  models(): Promise<ModelChoice[]>;
  /** The settings now ('' = Default). */
  current(): { model: string; effort: EffortLevel | '' };
  ui: Pick<Ui, 'quickPick'>;
  /** Writes agentStream.model and agentStream.effort. */
  write(model: string, effort: EffortLevel | ''): Promise<void>;
};

const mark = (label: string, current: boolean) => (current ? `$(check) ${label}` : label);

/** Agent Stream: Select Model: the default model, then (when it has levels) its effort, written to the settings. */
export async function selectModel(d: SelectModelDeps): Promise<void> {
  const current = d.current();
  const models = (await d.models()).filter((m) => !m.unavailable);
  const items = [
    { label: mark('Default', current.model === ''), description: "Claude Code's own default", value: '' },
    ...models.map((m) => ({ label: mark(m.label, m.value === current.model), ...(m.description && { description: m.description }), value: m.value })),
    // A saved model the provider doesn't list (any more) stays pickable.
    ...(current.model && !models.some((m) => m.value === current.model) ? [{ label: mark(current.model, true), value: current.model }] : []),
  ];
  const model = await d.ui.quickPick(items, 'Default model for runs and new planner conversations');
  if (model === undefined) return;
  const efforts = models.find((m) => m.value === model)?.efforts ?? [];
  if (efforts.length === 0) return d.write(model, '');
  const same = model === current.model;
  const effort = await d.ui.quickPick<EffortLevel | ''>(
    [{ label: mark('Default', same && current.effort === ''), value: '' }, ...efforts.map((l) => ({ label: mark(l, same && current.effort === l), value: l }))],
    'Effort level',
  );
  if (effort === undefined) return;
  await d.write(model, effort);
}
