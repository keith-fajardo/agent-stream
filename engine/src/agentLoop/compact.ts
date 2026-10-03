import type { ChatMessage, ChatModel, ToolSpec } from './chatModel';
import { clipResult } from './tools';

export const SUMMARY_PROMPT = 'Summarise the conversation so far for yourself: decisions, files changed, open questions. Keep it under 300 words.';
export const SUMMARY_PREFIX = 'Summary of earlier turns: ';
export const DROPPED_NOTE = "Earlier turns were dropped to fit the model's context.";

const COMPACT_AT = 0.75;
const KEEP_RECENT = 0.4;
/** How much of the input limit the summary request's transcript may use (ruling R6). */
const SUMMARY_INPUT_SHARE = 0.6;
const RESULT_CHARS_IN_SUMMARY = 2000;

const tokens = (chars: number) => Math.ceil(chars / 4);
const userText = (text: string): ChatMessage => ({ role: 'user', content: [{ type: 'text', text }] });

/** ceil(chars / 4) over the system text, the messages and the tool specs (spec §4.6, ruling R7). */
export function estimateTokens(system: string, messages: ChatMessage[], tools: ToolSpec[]): number {
  return tokens(system.length + JSON.stringify(messages).length + JSON.stringify(tools).length);
}

/** Messages grouped so a tool call and its results stay together: an assistant message with calls and the results after it. */
function rounds(messages: ChatMessage[]): ChatMessage[][] {
  const out: ChatMessage[][] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const next = messages[i + 1];
    const calls = m.role === 'assistant' && m.content.some((p) => p.type === 'toolCall');
    if (calls && next?.role === 'user' && next.content.some((c) => c.type === 'toolResult')) {
      out.push([m, next]);
      i++;
    } else out.push([m]);
  }
  return out;
}

/** The older turns as plain text for the summary request (ruling R6): no tool parts, so a request without tools is valid everywhere. */
function transcriptText(messages: ChatMessage[]): string {
  return messages
    .map((m) =>
      m.role === 'assistant'
        ? m.content.map((p) => (p.type === 'text' ? `Assistant: ${p.text}` : `Assistant called ${p.name} ${JSON.stringify(p.input)}`)).join('\n')
        : m.content.map((c) => (c.type === 'text' ? `User: ${c.text}` : `Tool result${c.isError ? ' (error)' : ''}: ${clipResult(c.text, RESULT_CHARS_IN_SUMMARY)}`)).join('\n'),
    )
    .join('\n\n');
}

/** The summary text, or undefined when the request failed or came back empty. A Stop is passed on. */
async function summarise(model: ChatModel, system: string, messages: ChatMessage[], signal: AbortSignal): Promise<string | undefined> {
  const conversation = clipResult(transcriptText(messages), Math.floor(model.maxInputTokens * SUMMARY_INPUT_SHARE * 4));
  try {
    let text = '';
    for await (const part of model.send([userText(system), userText(`${conversation}\n\n${SUMMARY_PROMPT}`)], [], signal)) if (part.type === 'text') text += part.text;
    return text.trim() || undefined;
  } catch (e) {
    if (signal.aborted) throw e;
    return undefined;
  }
}

/**
 * Compaction (spec §4.6): over 75 % of the model's input limit, keep the first message (the task) and the most recent
 * rounds up to 40 % of the limit, and replace the older ones with one summary. Still too long, or no summary (it failed,
 * or `canSummarise` is false because the request cap has no room for it): drop the oldest kept rounds, with a note.
 * The newest round is always kept, and a tool call is never separated from its results.
 */
export async function compactIfNeeded(o: {
  model: ChatModel;
  system: string;
  messages: ChatMessage[];
  tools: ToolSpec[];
  signal: AbortSignal;
  canSummarise: boolean;
}): Promise<{ messages: ChatMessage[]; requests: number }> {
  const limit = o.model.maxInputTokens;
  const fits = (messages: ChatMessage[]) => estimateTokens(o.system, messages, o.tools) <= COMPACT_AT * limit;
  if (o.messages.length < 2 || fits(o.messages)) return { messages: o.messages, requests: 0 };
  const [first, ...rest] = o.messages;
  const all = rounds(rest);
  let kept = 0;
  let budget = KEEP_RECENT * limit;
  for (let i = all.length - 1; i >= 0; i--) {
    const cost = tokens(JSON.stringify(all[i]).length);
    if (kept > 0 && cost > budget) break;
    kept++;
    budget -= cost;
  }
  const older = all.slice(0, all.length - kept).flat();
  let tail = all.slice(all.length - kept);
  let requests = 0;
  let summary: string | undefined;
  if (older.length > 0 && o.canSummarise) {
    requests = 1;
    summary = await summarise(o.model, o.system, [first, ...older], o.signal);
  }
  const head: ChatMessage[] = summary === undefined ? [first] : [first, userText(SUMMARY_PREFIX + summary)];
  const build = () => [...head, ...tail.flat()];
  if (summary !== undefined && fits(build())) return { messages: build(), requests };
  head.push(userText(DROPPED_NOTE));
  while (tail.length > 1 && !fits(build())) tail = tail.slice(1);
  return { messages: build(), requests };
}
