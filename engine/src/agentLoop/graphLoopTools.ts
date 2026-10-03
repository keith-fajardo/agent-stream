import { z } from 'zod';
import type { GraphTool } from '../providers/types';
import type { LoopTool } from './tools';

/**
 * Graph tools for the agent loop (spec §4.4). `gatePrefix` names them for the gate: STEP_GRAPH_TOOL_PREFIX for a step's
 * tools, so the step gate's self-approving set matches; '' for the planner, so its gate's graphToolNames match.
 */
export function toLoopTools(tools: GraphTool[], gatePrefix: string): LoopTool[] {
  return tools.map((t) => ({
    spec: { name: t.name, description: t.description, inputSchema: z.toJSONSchema(z.object(t.schema)) },
    gateName: gatePrefix + t.name,
    run: t.run,
  }));
}
