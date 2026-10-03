import { findModel, menuModels, type EffortLevel, type ModelSelection } from '@agent-stream/shared';
import { send } from '../bridge';
import { useStore } from '../store';

/**
 * The chat header's Model and Effort menus: the conversation's own choice, sent to the engine, which confirms it.
 * Default stands for Claude Code's own default row (left out of the list) and offers the levels `defaultEfforts` names.
 */
export function ModelPicker({ graphId, sessionId }: { graphId: string; sessionId: string }) {
  const models = useStore((s) => s.models);
  const defaultEfforts = useStore((s) => s.defaultEfforts);
  const choice = useStore((s) => s.plannerModel);
  const listed = menuModels(models);
  const effortsOf = (model: string | undefined) => (model ? (findModel(models, model)?.efforts ?? []) : defaultEfforts);
  const efforts = effortsOf(choice.model);
  const choose = (next: ModelSelection) =>
    send({ type: 'setPlannerModel', graphId, sessionId, ...(next.model && { model: next.model }), ...(next.effort && { effort: next.effort }) });
  // An effort the new model doesn't offer goes back to Default.
  const pickModel = (model: string) => choose({ model, effort: choice.effort && effortsOf(model || undefined).includes(choice.effort) ? choice.effort : undefined });
  return (
    <>
      <select className="chat-model" aria-label="Model" title="Model for this conversation" value={choice.model ?? ''} onChange={(e) => pickModel(e.target.value)}>
        <option value="">Default</option>
        {listed.map((m) => (
          <option key={m.value} value={m.value} title={m.description} disabled={m.unavailable}>
            {m.unavailable ? `${m.label} (unavailable)` : m.label}
          </option>
        ))}
        {/* A saved choice the menu doesn't list (a full id, a model gone, or no list) still shows as chosen. */}
        {choice.model && !listed.some((m) => m.value === choice.model) && <option value={choice.model}>{choice.model}</option>}
      </select>
      {/* Shown when the choice offers levels, and whenever an effort is saved, so it can always be seen and cleared. */}
      {(efforts.length > 0 || choice.effort) && (
        <select className="chat-effort" aria-label="Effort" title="Effort for this conversation" value={choice.effort ?? ''} onChange={(e) => choose({ model: choice.model, effort: (e.target.value || undefined) as EffortLevel | undefined })}>
          <option value="">Default</option>
          {efforts.map((l) => (
            <option key={l} value={l}>
              {l}
            </option>
          ))}
          {choice.effort && !efforts.includes(choice.effort) && <option value={choice.effort}>{choice.effort}</option>}
        </select>
      )}
    </>
  );
}
