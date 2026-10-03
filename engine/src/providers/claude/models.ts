import type { ModelInfo, Options, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { isEffortLevel, type EffortLevel, type ModelChoice } from '@agent-stream/shared';
import { sanitizedEnv } from './auth';
import type { ModelQueryFn } from './sdk';

export function toModelChoice(info: ModelInfo): ModelChoice {
  const efforts = info.supportsEffort === false ? [] : (info.supportedEffortLevels ?? []).filter(isEffortLevel);
  return { value: info.value, label: info.displayName || info.value, ...(info.description && { description: info.description }), efforts };
}

const MODELS_TIMEOUT_MS = 30_000;

/** A streaming input that never sends a message, so the query only answers control requests: no model turn runs. */
function silentInput(): AsyncIterable<SDKUserMessage> {
  return { [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<SDKUserMessage>>(() => {}) }) };
}

/**
 * Claude Code's models, read from its initialize answer (`supportedModels()`): starts the CLI with streaming input,
 * asks, and closes it before any message is sent. Loads no settings files and saves no session.
 */
export async function fetchModels(queryFn: ModelQueryFn, claudePath: string, env: NodeJS.ProcessEnv, timeoutMs = MODELS_TIMEOUT_MS): Promise<ModelChoice[]> {
  const options: Options = { pathToClaudeCodeExecutable: claudePath, env: sanitizedEnv(env), settingSources: [], persistSession: false, tools: [] };
  const q = queryFn({ prompt: silentInput(), options });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Claude Code did not answer within ${timeoutMs / 1000} s`)), timeoutMs);
  });
  try {
    return (await Promise.race([q.supportedModels(), timeout])).map(toModelChoice);
  } finally {
    clearTimeout(timer);
    try {
      q.close();
    } catch {
      // Already closed: nothing left to clean up.
    }
  }
}

/**
 * The SDK's model and effort options for a choice: only what is set. An effort the model's known levels don't include
 * is dropped (`warn` is told), never failing the turn; with the list unknown, or a model it doesn't name, it is kept.
 */
export function modelOptions(choice: { model?: string; effort?: EffortLevel }, known: ModelChoice[] | undefined, warn: (key: string, message: string) => void): Pick<Options, 'model' | 'effort'> {
  const out: Pick<Options, 'model' | 'effort'> = {};
  if (choice.model) out.model = choice.model;
  if (choice.effort) {
    const entry = choice.model ? known?.find((m) => m.value === choice.model) : undefined;
    if (entry && !entry.efforts.includes(choice.effort)) {
      warn(`${choice.model}|${choice.effort}`, `[agent-stream] ${entry.label} (${choice.model}) has no "${choice.effort}" effort level; running without an effort level.`);
    } else out.effort = choice.effort;
  }
  return out;
}
