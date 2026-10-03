import type { ToolGate } from '../providers/toolGate';
import type { ChatMessage, ChatModel, ChatPart } from './chatModel';
import type { LoopTool, ToolOutput } from './tools';

export type LoopResult =
  | { ok: true; text: string; requests: number; messages: ChatMessage[] }
  | { ok: false; error: string; requests: number; messages: ChatMessage[]; cancelled?: boolean; capped?: boolean };

export type LoopOptions = {
  model: ChatModel;
  system: string;
  messages: ChatMessage[];
  tools: LoopTool[];
  gate: ToolGate;
  maxRequests: number;
  signal: AbortSignal;
  /** The error when the cap is reached: the provider names its own setting (default: `Stopped after <n> model requests.`). */
  capMessage?: string;
  onText(text: string): void;
  onToolCall(callId: string, name: string, input: unknown): void;
  onToolResult(callId: string, text: string, isError: boolean): void;
};

type ToolCall = Extract<ChatPart, { type: 'toolCall' }>;
type ToolResult = { type: 'toolResult'; callId: string; text: string; isError?: boolean };

const userText = (text: string): ChatMessage => ({ role: 'user', content: [{ type: 'text', text }] });
const textOf = (parts: ChatPart[]) => parts.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('');

/** Streamed text arrives a few tokens at a time: adjacent text parts become one. */
function joinText(parts: ChatPart[]): ChatPart[] {
  const out: ChatPart[] = [];
  for (const p of parts) {
    const last = out.at(-1);
    if (p.type === 'text' && last?.type === 'text') out[out.length - 1] = { type: 'text', text: last.text + p.text };
    else out.push(p);
  }
  return out;
}

/** The newest assistant text (a step's output when it stopped early); '' when there is none. */
export function lastAssistantText(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'assistant') continue;
    const text = textOf(m.content);
    if (text.trim()) return text;
  }
  return '';
}

/** Every call of a reply gets a non-empty callId unique within that reply: a missing, empty or repeated one gets `call_<n>`. */
function withCallIds(parts: ChatPart[], next: () => number): ChatPart[] {
  const given = new Set(parts.flatMap((p) => (p.type === 'toolCall' && typeof p.callId === 'string' ? [p.callId] : [])));
  const seen = new Set<string>();
  return parts.map((p) => {
    if (p.type !== 'toolCall') return p;
    let callId = p.callId;
    if (typeof callId !== 'string' || callId === '' || seen.has(callId)) {
      do callId = `call_${next()}`;
      while (given.has(callId) || seen.has(callId));
    }
    seen.add(callId);
    return callId === p.callId ? p : { ...p, callId };
  });
}

/**
 * The provider-neutral agent loop (spec §4.5): send, record, run each tool call through the gate, send the results,
 * until a reply has no tool calls, the request cap is reached, the model fails, or the signal aborts.
 * The returned messages are always well-formed: every recorded tool call has a result.
 */
export async function runAgentLoop(o: LoopOptions): Promise<LoopResult> {
  const byName = new Map<string, LoopTool>();
  for (const t of o.tools) {
    if (byName.has(t.spec.name)) throw new Error(`Two tools are named ${t.spec.name}.`);
    byName.set(t.spec.name, t);
  }
  const specs = o.tools.map((t) => t.spec);
  // Fail closed: a cap that isn't a number of at least 1 allows one request.
  const maxRequests = Number.isFinite(o.maxRequests) && o.maxRequests >= 1 ? Math.floor(o.maxRequests) : 1;
  let messages = [...o.messages];
  let requests = 0;
  let generated = 0;
  /** The tool calls of the reply being answered, and the results so far; null between rounds. */
  let round: { calls: ToolCall[]; results: ToolResult[] } | null = null;

  async function runCall(call: ToolCall): Promise<ToolOutput> {
    const tool = byName.get(call.name);
    if (!tool) return { text: `Unknown tool ${call.name}.`, isError: true };
    const decision = await o.gate.decide(tool.gateName, call.input, o.signal);
    if (!decision.allow) return { text: decision.reason, isError: true };
    o.signal.throwIfAborted();
    try {
      return await tool.run(call.input, o.signal);
    } catch (e) {
      if (o.signal.aborted) throw e;
      return { text: e instanceof Error ? e.message : String(e), isError: true };
    }
  }

  /** Leaving mid-round: the calls still unanswered get a cancelled result, so the history can be sent again. */
  function closeRound() {
    if (!round) return;
    const answered = new Set(round.results.map((r) => r.callId));
    const cancelled = round.calls
      .filter((c) => !answered.has(c.callId))
      .map((c): ToolResult => ({ type: 'toolResult', callId: c.callId, text: 'Cancelled.', isError: true }));
    messages = [...messages, { role: 'user', content: [...round.results, ...cancelled] }];
    round = null;
  }

  try {
    for (;;) {
      o.signal.throwIfAborted();
      const parts: ChatPart[] = [];
      requests++;
      for await (const part of o.model.send([userText(o.system), ...messages], specs, o.signal)) parts.push(part);
      o.signal.throwIfAborted();
      const content = withCallIds(joinText(parts), () => ++generated);
      const calls = content.filter((p): p is ToolCall => p.type === 'toolCall');
      if (calls.length === 0 && textOf(content) === '') return { ok: true, text: '', requests, messages };
      messages = [...messages, { role: 'assistant', content }];
      if (calls.length > 0) round = { calls, results: [] };
      for (const p of content) {
        if (p.type === 'toolCall') o.onToolCall(p.callId, p.name, p.input);
        else if (p.text.trim()) o.onText(p.text);
      }
      if (!round) return { ok: true, text: textOf(content), requests, messages };
      for (const call of calls) {
        const r = await runCall(call);
        o.signal.throwIfAborted();
        round.results.push(r.isError ? { type: 'toolResult', callId: call.callId, text: r.text, isError: true } : { type: 'toolResult', callId: call.callId, text: r.text });
        o.onToolResult(call.callId, r.text, r.isError === true);
      }
      closeRound();
      if (requests >= maxRequests) return { ok: false, capped: true, error: o.capMessage ?? `Stopped after ${requests} model requests.`, requests, messages };
    }
  } catch (e) {
    closeRound();
    if (o.signal.aborted) return { ok: false, cancelled: true, error: 'cancelled', requests, messages };
    return { ok: false, error: e instanceof Error ? e.message : String(e), requests, messages };
  }
}
