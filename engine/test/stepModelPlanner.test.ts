import { describe, expect, it, vi } from 'vitest';
import type { ModelChoice, ProviderId } from '@agent-stream/shared';
import { createApp } from '../src/app';
import { GraphStore } from '../src/graphStore';
import type { PlannerTurn } from '../src/providers/types';
import { PLANNER_APPEND } from '../src/planner';
import { graphTools, NO_MODEL_LIST } from '../src/plannerTools';
import { RunStore } from '../src/runStore';
import { appTestDeps, fixedClock, outsideGit, signedIn, testGitBash, testProvider, tmpProject, tmpValuesFile } from './helpers';

function setup(models?: () => Promise<{ provider: ProviderId; models: ModelChoice[] }>) {
  const paths = tmpProject();
  const graphStore = new GraphStore(paths, fixedClock());
  const graphId = graphStore.create('G').id;
  const tools = graphTools({ graphStore, runStore: new RunStore(paths), graphId, source: { kind: 'planner', sessionId: 's' }, checkout: outsideGit(paths.root), requestRun: () => null, ...(models && { models }) });
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await tools.find((t) => t.name === name)!.run(args);
    return { text: r.text, isError: r.isError === true };
  };
  return { graphStore, graphId, call };
}

describe('planner tools: a step’s model and effort (step model spec §5)', () => {
  it('add_node takes model "<provider>/<id>" and effort, and get_graph shows them', async () => {
    const s = setup();
    expect(await s.call('add_node', { kind: 'agent', title: 'Check', prompt: 'p', model: 'claude/haiku', effort: 'low' })).toEqual({ text: 'Added n1.', isError: false });
    expect(s.graphStore.get(s.graphId).nodes[0]).toMatchObject({ model: { provider: 'claude', id: 'haiku' }, effort: 'low' });
    const graph = JSON.parse((await s.call('get_graph')).text);
    expect(graph.nodes[0]).toMatchObject({ id: 'n1', model: 'claude/haiku', effort: 'low' });
    expect(s.graphStore.readOps(s.graphId)[0]).toMatchObject({ by: 'agent', source: { kind: 'planner', sessionId: 's' } });
  });

  it('refuses a bad model, a bad effort and either on a command step, changing nothing', async () => {
    const s = setup();
    expect(await s.call('add_node', { kind: 'agent', title: 'x', prompt: 'p', model: 'opus' })).toEqual({ text: 'model "opus": the provider must be claude, codex or copilot, as in claude/opus.', isError: true });
    expect((await s.call('add_node', { kind: 'agent', title: 'x', prompt: 'p', effort: 'turbo' })).isError).toBe(true);
    expect(await s.call('add_node', { kind: 'command', title: 'x', command: 'ls', effort: 'low' })).toEqual({ text: 'Only agent steps have a model or effort.', isError: true });
    expect(s.graphStore.get(s.graphId).nodes).toEqual([]);
  });

  it('update_node sets them, and "" puts each back on the run’s', async () => {
    const s = setup();
    await s.call('add_node', { kind: 'agent', title: 'Plan', prompt: 'p' });
    expect(await s.call('update_node', { id: 'n1', model: 'codex/gpt-6-astra', effort: 'ultra' })).toEqual({ text: 'Updated n1.', isError: false });
    expect(s.graphStore.get(s.graphId).nodes[0]).toMatchObject({ model: { provider: 'codex', id: 'gpt-6-astra' }, effort: 'ultra' });
    await s.call('update_node', { id: 'n1', model: '' });
    expect(s.graphStore.get(s.graphId).nodes[0]).not.toHaveProperty('model');
    expect(s.graphStore.get(s.graphId).nodes[0].effort).toBe('ultra');
    await s.call('update_node', { id: 'n1', effort: '' });
    expect(s.graphStore.get(s.graphId).nodes[0]).not.toHaveProperty('effort');
    expect((await s.call('update_node', { id: 'n1', model: 'claude/two words' })).isError).toBe(true);
  });

  it('list_models returns the current provider’s models with their levels and the default', async () => {
    const models: ModelChoice[] = [
      { value: 'default', label: 'Default (recommended)', efforts: ['low', 'high'] },
      { value: 'haiku', label: 'Haiku', efforts: [] },
    ];
    const s = setup(async () => ({ provider: 'claude', models }));
    expect(JSON.parse((await s.call('list_models')).text)).toEqual({
      provider: 'claude',
      models: [
        { id: 'default', name: 'Default (recommended)', efforts: ['low', 'high'], default: true },
        { id: 'haiku', name: 'Haiku', efforts: [] },
      ],
    });
    const codex = setup(async () => ({ provider: 'codex', models: [{ value: 'gpt-6.1-sol', label: 'GPT-6.1-Sol', efforts: ['low'], isDefault: true }] }));
    expect(JSON.parse((await codex.call('list_models')).text).models).toEqual([{ id: 'gpt-6.1-sol', name: 'GPT-6.1-Sol', efforts: ['low'], default: true }]);
  });

  it('list_models says so when there is no list', async () => {
    expect(await setup(async () => ({ provider: 'copilot', models: [] })).call('list_models')).toEqual({ text: NO_MODEL_LIST, isError: false });
    expect(await setup(async () => Promise.reject(new Error('down'))).call('list_models')).toEqual({ text: NO_MODEL_LIST, isError: false });
    expect(await setup().call('list_models')).toEqual({ text: NO_MODEL_LIST, isError: false });
  });

  it('PLANNER_APPEND tells the planner when to set them and how to compare models', () => {
    expect(PLANNER_APPEND).toContain(
      '- Each agent step can have its own model and effort (add_node/update_node: model "<provider>/<id>", effort). Leave them on Default unless the user asks, or a step is clearly simple (checks, summaries — a small model or low effort) or clearly hard. Use only models list_models returns for the current provider.',
    );
    expect(PLANNER_APPEND).toContain(
      '- To compare models, add one step per model/effort with the same prompt; let them run in parallel (read-only, or each in its own workspace when they write), then a read-only compare step that reports quality, time and tokens from their outputs.',
    );
  });
});

describe('the planner’s list_models', () => {
  it('lists the models of the provider the turn runs on', async () => {
    const models: ModelChoice[] = [{ value: 'auto', label: 'Auto', efforts: [] }];
    let reply = '';
    const provider = testProvider({
      id: 'copilot',
      name: 'GitHub Copilot',
      listModels: async () => models,
      planTurn: async (t: PlannerTurn) => {
        reply = (await t.tools.find((x) => x.name === 'list_models')!.run({})).text;
        return { ok: true };
      },
    });
    const paths = tmpProject();
    const app = createApp({ ...appTestDeps(), projectDir: paths.root, valuesFile: tmpValuesFile(), provider, status: signedIn, maxParallel: 1, gitBash: testGitBash });
    const graphId = app.graphStore.create('G').id;
    await app.handle({ send: () => {} }, { type: 'chat', graphId, sessionId: 'default', text: 'Which models?' });
    await vi.waitFor(() => expect(reply).not.toBe(''), { timeout: 5000 });
    expect(JSON.parse(reply)).toEqual({ provider: 'copilot', models: [{ id: 'auto', name: 'Auto', efforts: [] }] });
  });
});
