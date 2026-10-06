import { describe, expect, it } from 'vitest';
import { ONLY_AGENT_STEPS_BROWSER } from '@agent-stream/shared';
import { GraphStore } from '../src/graphStore';
import { PLANNER_APPEND, PLANNER_BROWSER_RULE } from '../src/planner';
import { graphTools } from '../src/plannerTools';
import { createPlannerGate } from '../src/providers/toolGate';
import { RunStore } from '../src/runStore';
import { fixedClock, outsideGit, tmpProject } from './helpers';

function setup() {
  const paths = tmpProject();
  const graphStore = new GraphStore(paths, fixedClock());
  const graphId = graphStore.create('G').id;
  const tools = graphTools({ graphStore, runStore: new RunStore(paths), graphId, source: { kind: 'planner', sessionId: 's' }, checkout: outsideGit(paths.root), requestRun: () => null });
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await tools.find((t) => t.name === name)!.run(args);
    return { text: r.text, isError: r.isError === true };
  };
  return { tools, graphStore, graphId, call, paths };
}

describe('planner: the Browser setting', () => {
  it('add_node and update_node take browser: true | false, and get_graph shows it', async () => {
    const s = setup();
    expect(await s.call('add_node', { kind: 'agent', title: 'Research', prompt: 'Find jobs on LinkedIn.', browser: true })).toEqual({ text: 'Added n1.', isError: false });
    expect(s.graphStore.get(s.graphId).nodes[0].browser).toBe(true);
    expect(JSON.parse((await s.call('get_graph')).text).nodes[0].browser).toBe(true);
    expect(await s.call('update_node', { id: 'n1', browser: false })).toEqual({ text: 'Updated n1.', isError: false });
    expect(s.graphStore.get(s.graphId).nodes[0]).not.toHaveProperty('browser');
    expect(JSON.parse((await s.call('get_graph')).text).nodes[0]).not.toHaveProperty('browser');
    expect((await s.call('update_node', { id: 'n1', browser: 'yes' })).isError).toBe(true);
  });

  it('refuses it on a command step', async () => {
    const s = setup();
    expect(await s.call('add_node', { kind: 'command', title: 'List', command: 'ls', browser: true })).toEqual({ text: ONLY_AGENT_STEPS_BROWSER, isError: true });
  });

  it('the tools and the instructions say to switch it on only for steps that need websites', () => {
    const s = setup();
    expect(s.tools.find((t) => t.name === 'add_node')!.description).toContain('`browser` true lets an agent step use the Agent Stream browser');
    expect(s.tools.find((t) => t.name === 'update_node')!.description).toContain('`browser`');
    expect(PLANNER_APPEND).toContain(PLANNER_BROWSER_RULE);
    expect(PLANNER_BROWSER_RULE).toContain('only for an agent step that needs websites');
  });

  it('the planner itself never gets the browser', async () => {
    const s = setup();
    expect(s.tools.map((t) => t.name).some((n) => n.startsWith('browser_'))).toBe(false);
    const gate = createPlannerGate({ projectDir: s.paths.root, privateFiles: [], graphToolNames: new Set(s.tools.map((t) => t.name)) });
    expect((await gate.decide('mcp__agent_stream_browser__browser_open', { url: 'https://example.com/' })).allow).toBe(false);
    expect((await gate.decide('mcp__browser__browser_open', { url: 'https://example.com/' })).allow).toBe(false);
  });
});
