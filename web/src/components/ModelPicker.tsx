import type { EffortLevel, ModelSelection } from '@agent-stream/shared';
import { send } from '../bridge';
import { useStore } from '../store';

/** The chat header's Model and Effort menus: the conversation's own choice, sent to the engine, which confirms it. */
export function ModelPicker({ graphId, sessionId }: { graphId: string; sessionId: string }) {
  const models = useStore((s) => s.models);
  const choice = useStore((s) => s.plannerModel);
  const entry = choice.model ? models.find((m) => m.value === choice.model) : undefined;
  const efforts = entry?.efforts ?? [];
  const choose = (next: ModelSelection) =>
    send({ type: 'setPlannerModel', graphId, sessionId, ...(next.model && { model: next.model }), ...(next.effort && { effort: next.effort }) });
  const pickModel = (model: string) => {
    // An effort the new model doesn't offer goes back to Default.
    const offered = models.find((m) => m.value === model)?.efforts ?? [];
    choose({ model, effort: choice.effort && offered.includes(choice.effort) ? choice.effort : undefined });
  };
  return (
    <>
      <select className="chat-model" aria-label="Model" title="Model for this conversation" value={choice.model ?? ''} onChange={(e) => pickModel(e.target.value)}>
        <option value="">Default</option>
        {models.map((m) => (
          <option key={m.value} value={m.value} title={m.description} disabled={m.unavailable}>
            {m.unavailable ? `${m.label} (unavailable)` : m.label}
          </option>
        ))}
        {/* A saved choice the list no longer offers (or couldn't be listed) still shows as chosen. */}
        {choice.model && !entry && <option value={choice.model}>{choice.model}</option>}
      </select>
      {efforts.length > 0 && (
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
