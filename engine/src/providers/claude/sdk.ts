import { createSdkMcpServer, query, tool, type Options, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { GraphTool } from '../types';

/** The slice of the SDK's `query` we use; tests substitute a fake. */
export type QueryFn = (params: { prompt: string; options?: Options }) => AsyncIterable<SDKMessage>;

export const realQuery: QueryFn = query;

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
