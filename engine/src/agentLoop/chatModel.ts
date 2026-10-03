/** A provider-neutral chat model (spec §4.1): the agent loop talks to every model through this. */
export type ChatPart = { type: 'text'; text: string } | { type: 'toolCall'; callId: string; name: string; input: unknown };
export type ChatMessage =
  | { role: 'user'; content: Array<{ type: 'text'; text: string } | { type: 'toolResult'; callId: string; text: string; isError?: boolean }> }
  | { role: 'assistant'; content: ChatPart[] };
/** `inputSchema` is a JSON Schema object. */
export type ToolSpec = { name: string; description: string; inputSchema: object };

export interface ChatModel {
  readonly id: string;
  readonly maxInputTokens: number;
  /** Throws ChatModelError for provider errors; a cancellation surfaces as an abort. */
  send(messages: ChatMessage[], tools: ToolSpec[], signal: AbortSignal): AsyncIterable<ChatPart>;
}

export type ChatModelErrorCode = 'permission' | 'blocked' | 'notFound' | 'other';

/** A provider's refusal or failure. `message` is shown to the user as it is, so the provider writes it (spec §5.4). */
export class ChatModelError extends Error {
  constructor(
    readonly code: ChatModelErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ChatModelError';
  }
}
