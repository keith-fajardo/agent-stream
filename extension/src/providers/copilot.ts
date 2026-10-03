import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import {
  builtinTools,
  lastAssistantText,
  runAgentLoop,
  STEP_GRAPH_TOOL_PREFIX,
  toLoopTools,
  type AgentProvider,
  type ChatMessage,
  type NodeOutcome,
  type RunShell,
} from '@agent-stream/engine';
import { isWriteCapable, type ModelChoice, type NodeUsage, type ProviderStatus } from '@agent-stream/shared';
import { COPILOT_PERMISSION, vscodeChatModel } from './copilotModel';

export const COPILOT_UNAVAILABLE = "GitHub Copilot isn't available. Install the GitHub Copilot extension and sign in, or switch to Claude with Agent Stream: Select Provider.";
export const COPILOT_CONSENT_LATER = 'Copilot will ask for permission the first time a run or chat uses it.';
export const COPILOT_RESUME_FAILED = 'The earlier Copilot conversation was not found.';
/** What Default means on Copilot (spec §3). */
export const AUTO_MODEL = 'auto';

export const stepPreamble = (cwd: string) =>
  `You are an agent running one step of a workflow in ${cwd}. Use the tools to do the work; when finished, reply with a summary of what you did.`;
export const copilotCapMessage = (n: number, setting: 'maxRequestsPerStep' | 'maxRequestsPerTurn') =>
  `Stopped after ${n} Copilot requests (agentStream.copilot.${setting}). Raise the setting to let steps run longer.`;
export const requestLine = (n: number, cap: number) => `Copilot requests: ${n} of ${cap}`;

/** The slice of vscode.lm the provider uses. */
export type LmApi = { selectChatModels(selector: { vendor: string }): Thenable<readonly vscode.LanguageModelChat[]> };
/** context.languageModelAccessInformation: true allowed, false refused, undefined VS Code will ask on the first request. */
export type LmAccess = { canSendRequest(model: vscode.LanguageModelChat): boolean | undefined };
export type CopilotLimits = { maxRequestsPerStep: number; maxRequestsPerTurn: number };
export type CopilotDeps = {
  /** vscode.lm; an explicit undefined means "no Language Model API" (tests). */
  lm?: LmApi;
  access?: LmAccess;
  runShell: RunShell;
  /** The request caps, read per step and per turn. */
  limits: () => CopilotLimits;
};

/** Not in @types/vscode 1.106, but present at runtime (spec §2, ruling R17). */
type ToolCalling = { capabilities?: { supportsToolCalling?: boolean } };

/** The models Agent Stream can run (spec §5.2): tool calling, no internal copilot-* ids, one per id, Auto first. */
export function usableModels(models: readonly vscode.LanguageModelChat[]): vscode.LanguageModelChat[] {
  const seen = new Set<string>();
  const out: vscode.LanguageModelChat[] = [];
  for (const m of models) {
    if ((m as ToolCalling).capabilities?.supportsToolCalling !== true || m.id.startsWith('copilot-') || seen.has(m.id)) continue;
    seen.add(m.id);
    out.push(m);
  }
  return [...out.filter((m) => m.id === AUTO_MODEL), ...out.filter((m) => m.id !== AUTO_MODEL)];
}

/** The chosen model when listed, else Auto, else the first (spec §5.2). */
export function resolveModel<T>(items: readonly T[], idOf: (item: T) => string, chosen?: string): T | undefined {
  return (chosen ? items.find((m) => idOf(m) === chosen) : undefined) ?? items.find((m) => idOf(m) === AUTO_MODEL) ?? items[0];
}

const choiceOf = (m: vscode.LanguageModelChat): ModelChoice => ({ value: m.id, label: m.name, efforts: [] });
/** Copilot reports no tokens or cost: only the request count (ruling R16). */
const requestUsage = (requests: number): NodeUsage => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, turns: requests });
const userText = (text: string): ChatMessage => ({ role: 'user', content: [{ type: 'text', text }] });
const reason = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * GitHub Copilot through VS Code's Language Model API (spec §5). Steps and planner turns run the engine's agent loop
 * with our own tools, so approvals, read-only steps and privacy work as with Claude. Effort is ignored.
 */
export function createCopilotProvider(d: CopilotDeps): AgentProvider {
  // An explicit `lm: undefined` means "no API" (tests), so `??` can't be used here.
  const lm = 'lm' in d ? d.lm : (vscode as { lm?: LmApi }).lm;
  /** The model list once one was non-empty (ruling R18); refreshed by status, steps and turns. */
  let known: ModelChoice[] | undefined;
  let pending: Promise<ModelChoice[]> | undefined;
  let failed = false;
  let retried = false;

  const unavailable = (why?: string): ProviderStatus => ({
    provider: 'copilot',
    ok: false,
    label: 'Copilot not available',
    error: why ? `${COPILOT_UNAVAILABLE} (${why})` : COPILOT_UNAVAILABLE,
  });

  /** The usable models now ([] without the API); throws what VS Code throws. Never a model request. */
  async function select(): Promise<vscode.LanguageModelChat[]> {
    if (!lm?.selectChatModels) return [];
    const models = usableModels(await lm.selectChatModels({ vendor: 'copilot' }));
    if (models.length) {
      known = models.map(choiceOf);
      failed = false;
    }
    return models;
  }

  /** The model a step or turn runs on, with a note when the chosen one is gone (ruling R20). */
  async function pick(chosen: string | undefined): Promise<{ model: vscode.LanguageModelChat; note?: string } | { error: string }> {
    let models: vscode.LanguageModelChat[];
    try {
      models = await select();
    } catch (e) {
      return { error: `${COPILOT_UNAVAILABLE} (${reason(e)})` };
    }
    const model = resolveModel(models, (m) => m.id, chosen);
    if (!model) return { error: COPILOT_UNAVAILABLE };
    return chosen && model.id !== chosen ? { model, note: `The Copilot model ${chosen} is no longer available; using ${model.name}.` } : { model };
  }

  return {
    id: 'copilot',
    name: 'GitHub Copilot',
    async status() {
      if (!lm?.selectChatModels) return unavailable('This version of VS Code has no Language Model API.');
      let models: vscode.LanguageModelChat[];
      try {
        models = await select();
      } catch (e) {
        return unavailable(reason(e));
      }
      const model = resolveModel(models, (m) => m.id);
      if (!model) return unavailable();
      const detail = `Models: ${models.map((m) => m.name).join(', ')}.`;
      const allowed = d.access?.canSendRequest(model);
      if (allowed === false) return { provider: 'copilot', ok: false, label: 'Copilot not allowed', detail, error: COPILOT_PERMISSION };
      return { provider: 'copilot', ok: true, label: 'Copilot', detail: allowed === undefined ? `${detail} ${COPILOT_CONSENT_LATER}` : detail };
    },
    knownModels: () => known,
    async listModels(o) {
      if (known) return known;
      if (pending) return pending;
      if (failed) {
        // An empty or failing list isn't asked again for every preview or chat: one retry, and only when asked.
        if (!o?.retry || retried) return [];
        retried = true;
      }
      pending = select()
        .then(
          (models) => {
            if (!models.length) failed = true;
            return known ?? [];
          },
          () => {
            failed = true;
            return [];
          },
        )
        .finally(() => (pending = undefined));
      return pending;
    },
    modelInUse: (model) => (known ? resolveModel(known, (c) => c.value, model) : undefined),
    stepRequestCap: () => d.limits().maxRequestsPerStep,

    async runStep(ctx, gate): Promise<NodeOutcome> {
      ctx.emit({ type: 'start', kind: 'agent', cwd: ctx.cwd, prompt: ctx.prompt });
      const picked = await pick(ctx.model);
      if ('error' in picked) return { ok: false, output: '', error: picked.error };
      if (picked.note) ctx.emit({ type: 'text', text: picked.note });
      const cap = d.limits().maxRequestsPerStep;
      const r = await runAgentLoop({
        model: vscodeChatModel(picked.model),
        system: stepPreamble(ctx.cwd),
        messages: [userText(ctx.prompt)],
        tools: [
          ...builtinTools({ cwd: ctx.cwd, runShell: d.runShell, readOnly: !isWriteCapable(ctx.node) }),
          ...toLoopTools(ctx.graphTools ?? [], STEP_GRAPH_TOOL_PREFIX),
        ],
        gate,
        maxRequests: cap,
        signal: ctx.signal,
        capMessage: copilotCapMessage(cap, 'maxRequestsPerStep'),
        onText: (text) => ctx.emit({ type: 'text', text }),
        onToolCall: (callId, name, input) => ctx.emit({ type: 'tool_call', toolUseId: callId, name, input }),
        onToolResult: (callId, content, isError) => ctx.emit({ type: 'tool_result', toolUseId: callId, content, isError }),
      });
      ctx.emit({ type: 'text', text: requestLine(r.requests, cap) });
      if (r.ok) return { ok: true, output: r.text, usage: requestUsage(r.requests) };
      if (r.cancelled) return { ok: false, output: '', error: 'cancelled', usage: requestUsage(r.requests) };
      return { ok: false, output: lastAssistantText(r.messages), error: r.error, usage: requestUsage(r.requests) };
    },

    async planTurn(turn) {
      let history: ChatMessage[] = [];
      if (turn.resume) {
        const loaded = turn.transcript.load(turn.resume);
        if (!loaded) return { ok: false, error: COPILOT_RESUME_FAILED, resumeFailed: true };
        history = loaded;
      }
      const picked = await pick(turn.model);
      if ('error' in picked) return { ok: false, error: picked.error };
      const cap = d.limits().maxRequestsPerTurn;
      const graphToolNames = new Set(turn.tools.map((t) => t.name));
      const r = await runAgentLoop({
        model: vscodeChatModel(picked.model),
        system: turn.systemAppend,
        messages: [...history, userText(turn.prompt)],
        tools: [...builtinTools({ cwd: turn.cwd, runShell: d.runShell, readOnly: true }), ...toLoopTools(turn.tools, '')],
        gate: turn.gate,
        maxRequests: cap,
        signal: turn.signal,
        capMessage: copilotCapMessage(cap, 'maxRequestsPerTurn'),
        onText: (text) => turn.onEvent({ type: 'text', text }),
        onToolCall: (_callId, name, input) => {
          if (graphToolNames.has(name)) turn.onEvent({ type: 'tool', name, input });
        },
        onToolResult: () => {},
      });
      // Saved whatever happened, so the conversation and its error stay (spec §5.3, ruling R25). The loop's messages are
      // saved as returned, compacted when it compacted. A failed save is logged, never the turn's failure: the turn ran.
      const id = turn.resume ?? randomUUID();
      try {
        turn.transcript.save(id, r.messages);
      } catch (e) {
        console.error(`Agent Stream: couldn't save the Copilot conversation ${id}: ${reason(e)}`);
      }
      return r.ok ? { ok: true, sessionId: id } : { ok: true, sessionId: id, error: r.error };
    },
  };
}
