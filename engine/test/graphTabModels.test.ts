import { describe, expect, it, vi } from 'vitest';
import type { ModelChoice, ModelSelection, ServerMessage } from '@agent-stream/shared';
import { createApp } from '../src/app';
import { appTestDeps, signedIn, testGitBash, testProvider, tmpProject, tmpValuesFile } from './helpers';

const MODELS: ModelChoice[] = [{ value: 'sonnet', label: 'Sonnet', efforts: ['low', 'high'] }];

describe('graph tabs get the provider’s models (step model spec §4.1)', () => {
  it('sends them after the graph opens, again when the provider or the settings change, and stops when the tab goes', async () => {
    const defaults: ModelSelection = {};
    const paths = tmpProject();
    const app = createApp({ ...appTestDeps(), projectDir: paths.root, valuesFile: tmpValuesFile(), provider: testProvider({ listModels: async () => MODELS }), status: signedIn, maxParallel: 1, gitBash: testGitBash, modelDefaults: () => defaults });
    const graphId = app.graphStore.create('G').id;
    const msgs: ServerMessage[] = [];
    const tab = { send: (m: ServerMessage) => void msgs.push(m) };
    const detach = app.connect(tab);
    const models = () => msgs.filter((m): m is Extract<ServerMessage, { type: 'models' }> => m.type === 'models');
    expect(models()).toEqual([]);
    await app.handle(tab, { type: 'openGraph', graphId });
    await vi.waitFor(() => expect(models()).toEqual([{ type: 'models', provider: 'claude', models: MODELS, defaultEfforts: [] }]), { timeout: 5000 });
    expect(msgs.findIndex((m) => m.type === 'graphOpened')).toBeLessThan(msgs.findIndex((m) => m.type === 'models'));
    defaults.model = 'sonnet';
    app.modelDefaultsChanged();
    await vi.waitFor(() => expect(models().at(-1)?.defaultEfforts).toEqual(['low', 'high']), { timeout: 5000 });
    app.setProvider(testProvider({ id: 'codex', name: 'OpenAI Codex', listModels: async () => [] }), signedIn);
    await vi.waitFor(() => expect(models().at(-1)).toEqual({ type: 'models', provider: 'codex', models: [], defaultEfforts: [] }), { timeout: 5000 });
    const count = models().length;
    detach();
    app.modelDefaultsChanged();
    await new Promise((r) => setTimeout(r, 10));
    expect(models()).toHaveLength(count);
  });
});
