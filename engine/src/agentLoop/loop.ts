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

/**
 * The provider-neutral agent loop (spec §4.5): send, record, run each tool call through the gate, send the results,
 * until a reply has no tool calls, the request cap is reached, the model fails, or the signal aborts.
 */
export async function runAgentLoop(o: LoopOptions): Promise<LoopResult> {
  let messages = [...o.messages];
  let requests = 0;
  const specs = o.tools.map((t) => t.spec);
  const byName = new Map(o.tools.map((t) => [t.spec.name, t]));

  async function runCall(call: ToolCall): Promise<ToolOutput> {
    const tool = byName.get(call.name);
    if (!tool) return { text: `Unknown tool ${call.name}.`, isError: true };
    const decision = await o.gate.decide(tool.gateName, call.input, o.signal);
    if (!decision.allow) return { text: decision.reason, isError: true };
    try {
      return await tool.run(call.input, o.signal);
    } catch (e) {
      if (o.signal.aborted) throw e;
      return { text: e instanceof Error ? e.message : String(e), isError: true };
    }
  }

  try {
    for (;;) {
      o.signal.throwIfAborted();
      const parts: ChatPart[] = [];
      requests++;
      for await (const part of o.model.send([userText(o.system), ...messages], specs, o.signal)) parts.push(part);
      o.signal.throwIfAborted();
      const content = joinText(parts);
      messages = [...messages, { role: 'assistant', content }];
      for (const p of content) {
        if (p.type === 'toolCall') o.onToolCall(p.callId, p.name, p.input);
        else if (p.text.trim()) o.onText(p.text);
      }
      const calls = content.filter((p): p is ToolCall => p.type === 'toolCall');
      if (calls.length === 0) return { ok: true, text: textOf(content), requests, messages };
      const results: ToolResult[] = [];
      for (const call of calls) {
        const r = await runCall(call);
        o.signal.throwIfAborted();
        o.onToolResult(call.callId, r.text, r.isError === true);
        results.push(r.isError ? { type: 'toolResult', callId: call.callId, text: r.text, isError: true } : { type: 'toolResult', callId: call.callId, text: r.text });
      }
      messages = [...messages, { role: 'user', content: results }];
      if (requests >= o.maxRequests) return { ok: false, capped: true, error: o.capMessage ?? `Stopped after ${requests} model requests.`, requests, messages };
    }
  } catch (e) {
    if (o.signal.aborted) return { ok: false, cancelled: true, error: 'cancelled', requests, messages };
    return { ok: false, error: e instanceof Error ? e.message : String(e), requests, messages };
  }
}
