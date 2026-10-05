import { isEffortLevel, modelLine, supportsEffort } from './format';
import { CLI_DEFAULT_MODEL, findModel } from './models';
import { PROVIDER_IDS, PROVIDER_NAMES, type EffortLevel, type Graph, type ModelChoice, type PreviewStep, type ProviderId, type RunMeta, type StepModel, type StepModelUse } from './types';

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

/** The run's own provider, model and effort: what a step without its own uses (spec §3.2's R, M and E). */
export type RunModels = { provider: ProviderId; model?: string; effort?: EffortLevel };

/** A list that names models; an empty one (not listed yet, or the list failed) counts as unknown. */
const listed = (known: readonly ModelChoice[] | undefined) => (known && known.length > 0 ? known : undefined);

/**
 * Why a provider's model can't take `effort`, in the words of the provider's own log note (spec §3.2 rule 4); null when it
 * can, or when the list doesn't say. No model means the provider's default: Claude Code's default row, Codex's default model.
 */
export function effortProblem(provider: ProviderId, model: string | undefined, effort: EffortLevel, known: readonly ModelChoice[] | undefined): string | null {
  if (!supportsEffort(provider)) return `${PROVIDER_NAMES[provider]} has no effort levels; running without an effort level.`;
  if (provider === 'claude' && effort === 'ultra') return 'Claude has no "ultra" effort level; running without an effort level.';
  const list = listed(known);
  const entry = model ? findModel(list, model) : provider === 'claude' ? findModel(list, CLI_DEFAULT_MODEL) : list?.find((m) => m.isDefault);
  if (entry && !entry.efforts.includes(effort)) return `${entry.label} (${model ?? entry.value}) has no "${effort}" effort level; running without an effort level.`;
  return null;
}

/** A step model's note when it can't be used with this run's provider and model list; null when it can (spec §3.2 rules 2 and 3). */
export function stepModelNote(model: StepModel, provider: ProviderId, known: readonly ModelChoice[] | undefined): string | null {
  if (model.provider !== provider) {
    const name = PROVIDER_NAMES[model.provider];
    return `This step is set to ${/^[aeiou]/i.test(name) ? 'an' : 'a'} ${name} model (${model.id}); this run uses ${PROVIDER_NAMES[provider]}, so it uses the default model.`;
  }
  const list = listed(known);
  if (list && !findModel(list, model.id)) {
    if (provider === 'copilot') return `${model.id} isn't in GitHub Copilot's model list here, so this step tries it and uses Auto if Copilot refuses it.`;
    return `${model.id} isn't offered by ${PROVIDER_NAMES[provider]} any more (or on this plan), so this step uses the default model.`;
  }
  return null;
}

/**
 * The model and effort one agent step runs with (spec §3.2). A step without its own gets exactly the run's, as before (the
 * provider then drops an effort its model doesn't offer, with its log note). A step's own model is used when it belongs to
 * the run's provider and the known list offers it, else the run's model with a note; Copilot still tries a model its list
 * doesn't name, and falls back to Auto itself. The effort (the step's, else the run's) is checked against the model the
 * step will use; one it can't take is dropped, with a note when it was the step's own.
 */
export function resolveStepModel(node: { model?: StepModel; effort?: EffortLevel }, run: RunModels, known: readonly ModelChoice[] | undefined): StepModelUse {
  const ownModel = node.model;
  const ownEffort = node.effort;
  if (!ownModel && !ownEffort) return { ...(run.model && { model: run.model }), ...(run.effort && { effort: run.effort }) };
  const notes: string[] = [];
  let model = run.model;
  if (ownModel) {
    const note = stepModelNote(ownModel, run.provider, known);
    if (note) notes.push(note);
    if (!note || (ownModel.provider === run.provider && run.provider === 'copilot')) model = ownModel.id;
  }
  let effort = ownEffort ?? run.effort;
  if (effort) {
    const problem = effortProblem(run.provider, model, effort, known);
    if (problem) {
      if (ownEffort) notes.push(problem);
      effort = undefined;
    }
  }
  return { ...(model && { model }), ...(effort && { effort }), ...(notes.length > 0 && { note: notes.join(' ') }) };
}

/**
 * Every agent step's model and effort for a run that starts now (spec §3.1). A step the run reuses keeps what it ran with in
 * `source`: its own record, or that run's model and effort for a run from before step models.
 */
export function runStepModels(graph: Graph, run: RunModels, known: readonly ModelChoice[] | undefined, reused: ReadonlySet<string> = new Set(), source?: RunMeta): Record<string, StepModelUse> {
  const out: Record<string, StepModelUse> = {};
  for (const n of graph.nodes) {
    if (n.kind !== 'agent') continue;
    if (source && reused.has(n.id)) {
      const before = source.stepModels?.[n.id] ?? { ...(source.model && { model: source.model }), ...(source.effort && { effort: source.effort }) };
      out[n.id] = { ...before };
    } else out[n.id] = resolveStepModel(n, run, known);
  }
  return out;
}

/**
 * The run dialog's per-step lines (spec §3.3): an agent step that will run with its own model or effort gets
 * `Model: <label> · Effort: <label>` when that differs from the run's, and its note as a warning. Labels are the list's
 * display names; a reused step runs nothing, so it gets no line.
 */
export function withStepModelLines(steps: readonly PreviewStep[], graph: Graph, run: RunModels, known: readonly ModelChoice[] | undefined): PreviewStep[] {
  const base = resolveStepModel({}, run, known);
  return steps.map((s) => {
    const n = graph.nodes.find((x) => x.id === s.id);
    if (!n || n.kind !== 'agent' || s.reused || (!n.model && !n.effort)) return s;
    const use = resolveStepModel(n, run, known);
    const differs = use.model !== base.model || use.effort !== base.effort;
    const label = use.model ? findModel(listed(known), use.model)?.label : undefined;
    return {
      ...s,
      ...(differs && { modelLine: modelLine({ model: use.model, label, effort: use.effort, provider: run.provider }) }),
      ...(use.note && { modelNote: use.note }),
    };
  });
}
