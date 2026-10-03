import * as vscode from 'vscode';
import { ChatModelError, type ChatMessage, type ChatModel, type ChatModelErrorCode, type ChatPart, type ToolSpec } from '@agent-stream/engine';

export const JUSTIFICATION = 'Agent Stream runs your workflow steps on Copilot.';
export const COPILOT_PERMISSION = "Agent Stream isn't allowed to use Copilot. Run the step again and choose Allow, or enable it under Accounts › Manage Language Model Access.";

/** The text the user sees for each Copilot error (spec §5.4). */
export function copilotErrorMessage(code: ChatModelErrorCode, detail: string, modelId: string): string {
  switch (code) {
    case 'permission':
      return COPILOT_PERMISSION;
    case 'blocked':
      return `Copilot refused the request (quota or policy): ${detail}`;
    case 'notFound':
      return `The Copilot model ${modelId} is no longer available. Pick another model.`;
    case 'other':
      return `Copilot failed: ${detail}`;
  }
}

const CODES: Record<string, ChatModelErrorCode> = { NoPermissions: 'permission', Blocked: 'blocked', NotFound: 'notFound' };

/** A vscode.LanguageModelError by its code; anything else is `other` (spec §5.1). */
export function toChatModelError(e: unknown, modelId: string): ChatModelError {
  if (e instanceof ChatModelError) return e;
  const code = e instanceof vscode.LanguageModelError ? (CODES[e.code] ?? 'other') : 'other';
  const detail = (e instanceof Error && e.message) || String(e);
  return new ChatModelError(code, copilotErrorMessage(code, detail, modelId));
}

const asObject = (input: unknown): object => (typeof input === 'object' && input !== null ? input : {});

/** One of our messages as a Language Model message (spec §5.1). Tool errors travel as plain text (ruling R26). */
export function toLanguageModelMessage(m: ChatMessage): vscode.LanguageModelChatMessage {
  if (m.role === 'assistant') {
    return vscode.LanguageModelChatMessage.Assistant(
      m.content.map((p) => (p.type === 'text' ? new vscode.LanguageModelTextPart(p.text) : new vscode.LanguageModelToolCallPart(p.callId, p.name, asObject(p.input)))),
    );
  }
  return vscode.LanguageModelChatMessage.User(
    m.content.map((c) => (c.type === 'text' ? new vscode.LanguageModelTextPart(c.text) : new vscode.LanguageModelToolResultPart(c.callId, [new vscode.LanguageModelTextPart(c.text)]))),
  );
}

/** z.toJSONSchema adds a `$schema` key; the Language Model API takes a bare schema, so it is dropped. */
function toLanguageModelTool(t: ToolSpec): vscode.LanguageModelChatTool {
  const { $schema: _dropped, ...inputSchema } = t.inputSchema as Record<string, unknown>;
  return { name: t.name, description: t.description, inputSchema };
}

/** A Copilot model behind the engine's ChatModel (spec §5.1). Thinking and data parts are ignored. */
export function vscodeChatModel(model: vscode.LanguageModelChat): ChatModel {
  return {
    id: model.id,
    maxInputTokens: model.maxInputTokens,
    async *send(messages: ChatMessage[], tools: ToolSpec[], signal: AbortSignal): AsyncGenerator<ChatPart> {
      // A step already stopped sends nothing: no request, so no consent prompt and no quota used.
      signal.throwIfAborted();
      const cancellation = new vscode.CancellationTokenSource();
      const onAbort = () => cancellation.cancel();
      signal.addEventListener('abort', onAbort, { once: true });
      try {
        let stream: AsyncIterable<unknown>;
        try {
          const response = await model.sendRequest(
            messages.map(toLanguageModelMessage),
            { tools: tools.map(toLanguageModelTool), justification: JUSTIFICATION },
            cancellation.token,
          );
          stream = response.stream;
        } catch (e) {
          signal.throwIfAborted();
          throw toChatModelError(e, model.id);
        }
        const parts = stream[Symbol.asyncIterator]();
        for (;;) {
          signal.throwIfAborted();
          let next: IteratorResult<unknown>;
          try {
            next = await parts.next();
          } catch (e) {
            signal.throwIfAborted();
            throw toChatModelError(e, model.id);
          }
          if (next.done) break;
          const part = next.value;
          if (part instanceof vscode.LanguageModelTextPart) yield { type: 'text', text: part.value };
          else if (part instanceof vscode.LanguageModelToolCallPart) yield { type: 'toolCall', callId: part.callId, name: part.name, input: part.input };
        }
        signal.throwIfAborted();
      } finally {
        signal.removeEventListener('abort', onAbort);
        cancellation.dispose();
      }
    },
  };
}
