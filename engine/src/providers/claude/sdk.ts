import { createSdkMcpServer, query, tool, type ModelInfo, type Options, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { GraphTool } from '../types';

/** The slice of the SDK's `query` we use; tests substitute a fake. A prompt with images is a stream of one user message. */
export type QueryFn = (params: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options }) => AsyncIterable<SDKMessage>;

export const realQuery: QueryFn = query;

/** The slice of a streaming-input `query` that lists models: control requests only, never a user message. Tests substitute a fake. */
export type ModelQuery = { supportedModels(): Promise<ModelInfo[]>; close(): void };
export type ModelQueryFn = (params: { prompt: AsyncIterable<SDKUserMessage>; options?: Options }) => ModelQuery;

export const realModelQuery: ModelQueryFn = query;

/** A block of a user message: text, an image, or a PDF (a document), in the Messages API's base64 form. */
export type UserBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'; data: string } }
  | { type: 'document'; source: { type: 'base64'; media_type: 'application/pdf'; data: string } };

/** A prompt with images or PDFs (step model spec §6b.5): one user message, as streaming input that then ends. */
export async function* userMessage(blocks: UserBlock[]): AsyncGenerator<SDKUserMessage> {
  yield { type: 'user', message: { role: 'user', content: blocks }, parent_tool_use_id: null };
}

/** A loose view of message content blocks, so we don't depend on every SDK block type. */
export type LooseBlock = {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
};

export function blocksOf(message: unknown): LooseBlock[] {
  const content = (message as { content?: unknown } | undefined)?.content;
  return Array.isArray(content) ? (content as LooseBlock[]) : [];
}

export function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return (content as LooseBlock[]).map((c) => (c.type === 'text' ? (c.text ?? '') : `[${c.type}]`)).join('\n');
  }
  return '';
}

/** Provider-neutral graph tools, served to Claude Code as the in-process MCP server `name` (its tools are `mcp__<name>__*`). */
export function graphServer(name: string, tools: GraphTool[]) {
  return createSdkMcpServer({
    name,
    version: '1.0.0',
    tools: tools.map((t) =>
      tool(t.name, t.description, t.schema, async (args) => {
        const r = await t.run(args);
        return r.isError ? { content: [{ type: 'text' as const, text: r.text }], isError: true } : { content: [{ type: 'text' as const, text: r.text }] };
      }),
    ),
  });
}
