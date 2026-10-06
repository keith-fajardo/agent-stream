import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import {
  attachedPrompt,
  builtinTools,
  CLAUDE_IMAGE_MAX_BYTES,
  inlineBudget,
  OVER_BUDGET_IN_CHAT,
  lastAssistantText,
  PDF_MAY_NOT_READ,
  readIfThere,
  runAgentLoop,
  STEP_GRAPH_TOOL_PREFIX,
  toLoopTools,
  type AgentProvider,
  type ChatMessage,
  type ImageData,
  notIncluded,
  type NodeOutcome,
  promptWithNotes,
  type RunShell,
  type TurnFile,
} from '@agent-stream/engine';
import { isWriteCapable, type ModelChoice, type NodeUsage, type ProviderStatus } from '@agent-stream/shared';
import { COPILOT_PERMISSION, ExtensionBlockedModelError, vscodeChatModel } from './copilotModel';

export const COPILOT_UNAVAILABLE = "GitHub Copilot isn't available. Install the GitHub Copilot extension and sign in, or switch to Claude with Agent Stream: Select Provider.";
export const COPILOT_CONSENT_LATER = 'Copilot will ask for permission the first time a run or chat uses it.';
export const COPILOT_RESUME_FAILED = 'The earlier Copilot conversation was not found.';
/** What Default means on Copilot (spec §3). */
export const AUTO_MODEL = 'auto';

export const stepPreamble = (cwd: string) =>
  `You are an agent running one step of a workflow in ${cwd}. Use the tools to do the work; when finished, reply with a summary of what you did.`;
export const copilotCapMessage = (n: number, setting: 'maxRequestsPerStep' | 'maxRequestsPerTurn') =>
  `Stopped after ${n} Copilot requests (agentStream.copilot.${setting}). ` +
  (setting === 'maxRequestsPerTurn'
    ? 'Raise the setting to let planner turns run longer, or type continue to pick up where it stopped.'
    : 'Raise the setting to let steps run longer.');
export const requestLine = (n: number, cap: number) => `Copilot requests: ${n} of ${cap}`;
/**
 * Copilot sends an image up to 5 MB (Claude's limit, since the picked model may be a Claude model) within the request's
 * inline budget. The agent loop's Read can't show an image, so one that isn't sent is said to be unseen.
 */
const MAX_IMAGE_BYTES = CLAUDE_IMAGE_MAX_BYTES;
export const COPILOT_IMAGE_NOT_SENT = {
  tooBig: "image over 5 MB: it couldn't be shown to the model",
  overBudget: "image not sent (too many large images): it couldn't be shown to the model",
};

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

/** Not in @types/vscode 1.106, but present at runtime (spec §2, ruling R17): whether a model calls tools, and takes images. */
type ToolCalling = { capabilities?: { supportsToolCalling?: boolean; supportsImageToText?: boolean } };
/** Whether VS Code says this model takes images (step model spec §6b.5); a model that doesn't say, doesn't. */
export const takesImages = (m: vscode.LanguageModelChat): boolean => (m as ToolCalling).capabilities?.supportsImageToText === true;

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
/** A user message with images after its text. */
const userWithImages = (text: string, images: readonly ImageData[]): ChatMessage => ({
  role: 'user',
  content: [{ type: 'text', text }, ...images.map((i) => ({ type: 'image' as const, mediaType: i.mediaType, data: i.data }))],
});
/** A conversation as it is saved: each image a short text line instead of its bytes. */
const withoutImages = (messages: ChatMessage[]): ChatMessage[] =>
  messages.map((m) => (m.role === 'user' && m.content.some((c) => c.type === 'image') ? { ...m, content: m.content.map((c) => (c.type === 'image' ? { type: 'text' as const, text: '[An image was attached here.]' } : c)) } : m));
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
  /** Models VS Code lists but refused us (core-only), for this session. */
  const blocked = new Set<string>();

  const unavailable = (why?: string): ProviderStatus => ({
    provider: 'copilot',
    ok: false,
    label: 'Copilot not available',
    error: why ? `${COPILOT_UNAVAILABLE} (${why})` : COPILOT_UNAVAILABLE,
  });

  /** The usable models now ([] without the API); throws what VS Code throws. Never a model request. */
  async function select(): Promise<vscode.LanguageModelChat[]> {
    if (!lm?.selectChatModels) return [];
    const models = usableModels(await lm.selectChatModels({ vendor: 'copilot' })).filter((m) => !blocked.has(m.id));
    if (models.length) {
      known = models.map(choiceOf);
      failed = false;
    }
    return models;
  }

  /** The model behind the engine's ChatModel; a core-only refusal blocks it, and the failure still surfaces. */
  function chatModel(m: vscode.LanguageModelChat) {
    const inner = vscodeChatModel(m);
    return {
      ...inner,
      async *send(...args: Parameters<typeof inner.send>) {
        try {
          yield* inner.send(...args);
        } catch (e) {
          if (e instanceof ExtensionBlockedModelError) {
            blocked.add(m.id);
            if (known) known = known.filter((c) => c.value !== m.id);
          }
          throw e;
        }
      },
    };
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
      const picked = await pick(ctx.model);
      // Attached images go to a model that takes them; for any other the list says so (step model spec §6b.5).
      // Each image's line says what happened to it: sent, or (for a model that takes none) not shown; one that vanished is left out.
      const { text: prompt, images } = attachedPrompt(ctx.prompt, ctx.attachments, ctx.readAttachment ?? readIfThere, {
        send: 'model' in picked && takesImages(picked.model),
        maxBytes: MAX_IMAGE_BYTES,
        notSent: COPILOT_IMAGE_NOT_SENT,
        pdf: PDF_MAY_NOT_READ,
      });
      // The model the step actually runs on (Auto for one that is gone). Copilot has no effort levels, so ctx.effort is never sent (step model spec §6).
      ctx.emit({ type: 'start', kind: 'agent', cwd: ctx.cwd, prompt, ...('model' in picked && { model: picked.model.id }) });
      if ('error' in picked) return { ok: false, output: '', error: picked.error };
      if (picked.note) ctx.emit({ type: 'text', text: picked.note });
      const cap = d.limits().maxRequestsPerStep;
      const r = await runAgentLoop({
        model: chatModel(picked.model),
        system: stepPreamble(ctx.cwd),
        messages: [images.length ? userWithImages(prompt, images) : userText(prompt)],
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
      // A chat message's images go to a model that takes them, up to 5 MB each and within the request's inline budget (in
      // message order); PDFs can't be sent here (step model spec §6b.5).
      const takes = takesImages(picked.model);
      const budget = inlineBudget();
      const images: TurnFile[] = [];
      const notes: string[] = [];
      for (const f of turn.files ?? []) {
        const size = Buffer.byteLength(f.data, 'base64');
        if (f.kind === 'pdf') notes.push(notIncluded(f.name, "GitHub Copilot can't read PDFs in the chat"));
        else if (!takes) notes.push(notIncluded(f.name, `${picked.model.name} doesn't take images`));
        else if (size > MAX_IMAGE_BYTES) notes.push(notIncluded(f.name, 'it is too large to send (images up to 5 MB are sent)'));
        else if (!budget.take(size, true)) notes.push(notIncluded(f.name, OVER_BUDGET_IN_CHAT));
        else images.push(f);
      }
      // Said in the chat and in the message itself, so the model knows.
      for (const note of notes) turn.onEvent({ type: 'note', text: note });
      const prompt = promptWithNotes(turn.prompt, notes);
      const message = images.length ? userWithImages(prompt, images.map((f) => ({ name: f.name, mediaType: f.mediaType as ImageData['mediaType'], data: f.data }))) : userText(prompt);
      const cap = d.limits().maxRequestsPerTurn;
      const graphToolNames = new Set(turn.tools.map((t) => t.name));
      const r = await runAgentLoop({
        model: chatModel(picked.model),
        system: turn.systemAppend,
        messages: [...history, message],
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
        // Images are kept out of the saved conversation: the files stay in the session, the messages name them.
        turn.transcript.save(id, withoutImages(r.messages));
      } catch (e) {
        console.error(`Agent Stream: couldn't save the Copilot conversation ${id}: ${reason(e)}`);
      }
      return r.ok ? { ok: true, sessionId: id } : { ok: true, sessionId: id, error: r.error };
    },
  };
}
