import { findModel, isEffortLevel, type EffortLevel, type ModelChoice } from '@agent-stream/shared';
import { errorMessage, type CodexConnection } from './connection';
import type { Model, ModelListParams, ModelListResponse } from './protocol';

const MODELS_TIMEOUT_MS = 30_000;
const MAX_PAGES = 10;

/** A Codex model for the Model menus (spec §4.4): efforts Agent Stream doesn't know (none, minimal) are dropped. */
export function toModelChoice(m: Model): ModelChoice {
  return {
    value: m.id,
    label: m.displayName || m.id,
    ...(m.description && { description: m.description }),
    efforts: m.supportedReasoningEfforts.map((o) => o.reasoningEffort).filter(isEffortLevel),
    ...(m.isDefault && { isDefault: true }),
  };
}

/** model/list, page by page through nextCursor (at most 10 pages, 30 s in all), hidden models left out (R19). */
export async function fetchCodexModels(conn: CodexConnection, timeoutMs = MODELS_TIMEOUT_MS): Promise<ModelChoice[]> {
  const signal = AbortSignal.timeout(timeoutMs);
  const out: ModelChoice[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const params: ModelListParams = cursor ? { includeHidden: false, cursor } : { includeHidden: false };
    const r: ModelListResponse = await conn.request<ModelListResponse>('model/list', params, signal);
    for (const m of r.data) if (!m.hidden) out.push(toModelChoice(m));
    cursor = r.nextCursor;
    if (!cursor) break;
  }
  return out;
}

export type ModelList = {
  list(o?: { retry?: boolean }): Promise<ModelChoice[]>;
  known(): ModelChoice[] | undefined;
  /** Forgets the list and any failure (a sign-in just succeeded); a load still in flight is ignored (M3). */
  reset(): void;
};

/**
 * The model list, cached like Claude's (spec §4.4): one load at a time, kept once it succeeds; a failure stands for the
 * window, bar one retry when asked (chat open, Select Model).
 */
export function createModelList(load: () => Promise<ModelChoice[]>, log: (message: string) => void): ModelList {
  let models: ModelChoice[] | undefined;
  let pending: Promise<ModelChoice[]> | undefined;
  let failed = false;
  let retried = false;
  let generation = 0;
  return {
    known: () => models,
    reset() {
      generation++;
      models = undefined;
      pending = undefined;
      failed = false;
      retried = false;
    },
    async list(o) {
      if (models) return models;
      if (pending) return pending;
      if (failed) {
        if (!o?.retry || retried) return [];
        retried = true;
      }
      const current = generation;
      const loading = load()
        .then(
          (list) => {
            if (current === generation) models = list;
            return list;
          },
          (e: unknown) => {
            if (current !== generation) return [];
            if (!failed) log(`[agent-stream] Could not list Codex models; the menus offer only Default (${errorMessage(e)}).`);
            failed = true;
            return [];
          },
        )
        .finally(() => {
          if (pending === loading) pending = undefined;
        });
      pending = loading;
      return loading;
    },
  };
}

/**
 * The effort to send on turn/start (R9): the chosen one, unless the listed model (or, for Default, the model Codex marks
 * as its default) doesn't offer it. Then it is dropped and `warn` is told. Kept when the list is unknown or doesn't name the model.
 */
export function codexEffort(choice: { model?: string; effort?: EffortLevel }, known: ModelChoice[] | undefined, warn: (key: string, message: string) => void): EffortLevel | undefined {
  if (!choice.effort) return undefined;
  const entry = choice.model ? findModel(known, choice.model) : known?.find((m) => m.isDefault);
  if (entry && !entry.efforts.includes(choice.effort)) {
    warn(`${entry.value}|${choice.effort}`, `[agent-stream] ${entry.label} (${entry.value}) has no "${choice.effort}" effort level; running without an effort level.`);
    return undefined;
  }
  return choice.effort;
}
