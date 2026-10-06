import { z } from 'zod';
import { SCREENSHOT_NOT_SHOWN } from '@agent-stream/shared';
import type { LoopTool } from '../agentLoop/tools';
import { BROWSER_TOOL_PREFIX, type BrowserTool } from './tools';

/**
 * The browser tools as agent-loop tools (Copilot) and Codex dynamic tools (spec §3.4). The gate knows them as
 * mcp__agent_stream_browser__<name>, in the step's self-approving set (ruling R4). `images`: whether the model takes
 * images; when it doesn't, a screenshot's result says so instead (spec §4.1).
 */
export function browserLoopTools(tools: readonly BrowserTool[], o: { images: boolean }): LoopTool[] {
  return tools.map((t) => ({
    spec: { name: t.name, description: t.description, inputSchema: z.toJSONSchema(z.object(t.schema)) },
    gateName: BROWSER_TOOL_PREFIX + t.name,
    async run(input, signal) {
      const r = await t.run(input, signal);
      const base = { text: r.text, ...(r.isError && { isError: true }) };
      if (!r.image) return base;
      if (!o.images) return { ...base, text: `${r.text}\n\n${SCREENSHOT_NOT_SHOWN}` };
      return { ...base, images: [{ type: 'image' as const, mediaType: r.image.mediaType, data: r.image.data }] };
    },
  }));
}
