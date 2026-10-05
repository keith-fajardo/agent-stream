import { isEffortLevel } from './format';
import { PROVIDER_IDS, type EffortLevel, type ProviderId, type StepModel } from './types';

/** The longest model id a step can store. */
export const MAX_MODEL_ID_CHARS = 200;
/** applyOp's refusal for a model or effort on a command step (spec §2.1). */
export const ONLY_AGENT_STEPS_MODEL = 'Only agent steps have a model or effort.';
/** A provider's own model id: 1 to 200 characters, no whitespace; `/` is allowed (spec §2.1). */
const MODEL_ID_RE = /^\S{1,200}$/;

export const isProviderId = (value: string): value is ProviderId => (PROVIDER_IDS as readonly string[]).includes(value);
export const isModelId = (id: string): boolean => MODEL_ID_RE.test(id);
/** `claude/opus`: how the graph file, the planner and the Changes tab write a step's model. */
export const stepModelText = (m: StepModel): string => `${m.provider}/${m.id}`;

/** Why `<provider>/<id>` text can't be a step's model, without the text itself; null when it can. */
function modelTextProblem(provider: string, id: string): string | null {
  if (!isProviderId(provider)) return 'the provider must be claude, codex or copilot, as in claude/opus.';
  if (!isModelId(id)) return `write the model id after "${provider}/" (1 to ${MAX_MODEL_ID_CHARS} characters, no spaces), as in claude/opus.`;
  return null;
}

/** `claude/opus` as a step model: the provider is everything before the first `/`, the id everything after it. */
export function parseStepModel(text: string): { ok: true; model: StepModel } | { ok: false; error: string } {
  const slash = text.indexOf('/');
  const provider = slash < 0 ? text : text.slice(0, slash);
  const id = slash < 0 ? '' : text.slice(slash + 1);
  const problem = modelTextProblem(provider, id);
  if (problem) return { ok: false, error: `model "${text}": ${problem}` };
  return { ok: true, model: { provider: provider as ProviderId, id } };
}

/** Why a step can't have this model or effort, or null (applyOp's check, for input that didn't come through a schema). */
export function stepModelProblem(model: StepModel | undefined, effort: EffortLevel | undefined): string | null {
  if (model) {
    const problem = modelTextProblem(model.provider, model.id);
    if (problem) return `model "${stepModelText(model)}": ${problem}`;
  }
  if (effort !== undefined && !isEffortLevel(effort)) return `effort "${String(effort)}": use low, medium, high, xhigh, max or ultra.`;
  return null;
}
