import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { toLoopTools } from '../src/agentLoop/graphLoopTools';
import { GraphStore } from '../src/graphStore';
import { defineTool, graphTools, reply } from '../src/plannerTools';
import { STEP_GRAPH_TOOL_PREFIX } from '../src/providers/toolGate';
import { RunStore } from '../src/runStore';
import { fixedClock, outsideGit, tmpProject } from './helpers';

const signal = new AbortController().signal;

describe('toLoopTools', () => {
  it('turns a graph tool into a loop tool, named for the gate with the prefix', async () => {
    const addStep = defineTool('add_step', 'Add a step to this run.', { title: z.string() }, async (a) => reply(`added ${a.title}`));
    // Claude's run_graph MCP server, the step gate and Copilot all name a step's graph tools with this one prefix.
    expect(STEP_GRAPH_TOOL_PREFIX).toBe('mcp__run_graph__');
    const [t] = toLoopTools([addStep], STEP_GRAPH_TOOL_PREFIX);
    expect(t.spec).toEqual({ name: 'add_step', description: 'Add a step to this run.', inputSchema: z.toJSONSchema(z.object({ title: z.string() })) });
    expect(t.gateName).toBe('mcp__run_graph__add_step');
    expect(await t.run({ title: 'Lint' }, signal)).toEqual({ text: 'added Lint' });
    expect(await t.run({}, signal)).toMatchObject({ isError: true });
  });

  it("keeps the planner's tool names for its gate and converts every one to a JSON Schema object", () => {
    const paths = tmpProject();
    const graphStore = new GraphStore(paths, fixedClock());
    const graphId = graphStore.create('G').id;
    const tools = graphTools({ graphStore, runStore: new RunStore(paths), graphId, source: { kind: 'planner', sessionId: 'default' }, requestRun: () => null, checkout: outsideGit(paths.root) });
    const loop = toLoopTools(tools, '');
    expect(loop.map((t) => t.gateName)).toEqual(tools.map((t) => t.name));
    expect(loop.map((t) => t.spec.name)).toEqual(tools.map((t) => t.name));
    for (const t of loop) expect(t.spec.inputSchema).toMatchObject({ type: 'object' });
  });
});
