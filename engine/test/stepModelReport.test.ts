import { describe, expect, it } from 'vitest';
import type { EffortLevel, Graph, ModelChoice, RunMeta, ServerMessage } from '@agent-stream/shared';
import { createApp } from '../src/app';
import { buildRunReport } from '../src/runReport';
import { appTestDeps, signedIn, testGitBash, testProvider, tmpProject, tmpValuesFile } from './helpers';

const all: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const MODELS: ModelChoice[] = [
  { value: 'sonnet', label: 'Sonnet', efforts: all },
  { value: 'opus', label: 'Opus', efforts: all },
];

describe('the run dialog: each step’s model', () => {
  it('sends a line for a step whose own model differs, and its note as a warning, never a problem', async () => {
    const provider = testProvider({ knownModels: () => MODELS, listModels: async () => MODELS });
    const paths = tmpProject();
    const app = createApp({ ...appTestDeps(), projectDir: paths.root, valuesFile: tmpValuesFile(), provider, status: signedIn, maxParallel: 1, gitBash: testGitBash, modelDefaults: () => ({ model: 'sonnet' }) });
    const graphId = app.graphStore.create('G').id;
    app.graphStore.apply(graphId, { type: 'addNode', node: { id: 'n1', title: 'own', kind: 'agent', prompt: 'p', model: { provider: 'claude', id: 'opus' }, effort: 'high' } }, 'user');
    app.graphStore.apply(graphId, { type: 'addNode', node: { id: 'n2', title: 'gone', kind: 'agent', prompt: 'p', model: { provider: 'claude', id: 'claude-opus-4-1' } } }, 'user');
    const msgs: ServerMessage[] = [];
    const client = { send: (m: ServerMessage) => void msgs.push(m) };
    await app.handle(client, { type: 'previewRun', graphId });
    const preview = msgs.filter((m) => m.type === 'runPreview').at(-1)!.preview;
    expect(preview.problems).toEqual([]);
    expect(preview.model).toEqual({ value: 'sonnet', label: 'Sonnet' });
    expect(preview.steps).toEqual([
      expect.objectContaining({ id: 'n1', modelLine: 'Model: Opus · Effort: high' }),
      expect.objectContaining({ id: 'n2', modelNote: "claude-opus-4-1 isn't offered by Claude any more (or on this plan), so this step uses the default model." }),
    ]);
    expect(preview.steps[1]).not.toHaveProperty('modelLine');
  });
});

describe('Run Report: each step’s model and effort', () => {
  const node = (id: string, kind: 'agent' | 'command'): Graph['nodes'][number] => ({ id, title: id, kind, ...(kind === 'agent' ? { prompt: 'p' } : { command: 'ls' }), createdBy: 'user', updatedBy: 'user', updatedAt: 't' });
  const snapshot: Graph = { id: 'g', name: 'G', goal: '', instructions: '', variables: [], nodes: [node('n1', 'agent'), node('n2', 'agent'), node('n3', 'command')], edges: [], nodeSeq: 3, updatedAt: 't' };
  const base: RunMeta = { id: 'r1', graphId: 'g', status: 'succeeded', startedAt: 't0', endedAt: 't1', snapshot, nodes: { n1: { status: 'succeeded' }, n2: { status: 'succeeded' }, n3: { status: 'succeeded' } }, provider: 'claude', model: 'sonnet' };
  const report = (run: RunMeta) => buildRunReport({ graphName: 'G', run, steps: {}, now: 't2' });

  it('writes a line under each agent step’s heading, with its note, and none for command steps', () => {
    const md = report({ ...base, stepModels: { n1: { model: 'claude-opus-4-6', effort: 'max' }, n2: { model: 'sonnet', note: 'This step is set to an OpenAI Codex model (gpt-6-astra); this run uses Claude, so it uses the default model.' } } });
    expect(md).toContain('### n1 · n1 — Succeeded\n\nModel: claude-opus-4-6 · Effort: max\n');
    expect(md).toContain('### n2 · n2 — Succeeded\n\nModel: sonnet · Effort: Default\n\n_Note:_ This step is set to an OpenAI Codex model (gpt-6-astra); this run uses Claude, so it uses the default model.\n');
    expect(md).toContain('### n3 · n3 — Succeeded\n\n**Command**');
    // The run-level lines are unchanged.
    expect(md).toContain('- Model: sonnet\n- Effort: Default\n');
  });

  it('says not supported for Copilot, and writes no line for a run from before step models', () => {
    expect(report({ ...base, provider: 'copilot', stepModels: { n1: { model: 'auto' } } })).toContain('Model: auto · Effort: not supported');
    expect(report(base)).not.toContain('Model: sonnet · Effort');
  });
});
