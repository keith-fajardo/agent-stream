import { describe, expect, it } from 'vitest';
import { emptyGraph } from '../src/graph';
import { withStepModelLines } from '../src/stepModels';
import type { EffortLevel, Graph, GraphNode, ModelChoice, PreviewStep } from '../src/types';

const all: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const CLAUDE: ModelChoice[] = [
  { value: 'sonnet', label: 'Sonnet', efforts: all },
  { value: 'opus', label: 'Opus', efforts: all },
  { value: 'haiku', label: 'Haiku', efforts: [] },
];
const node = (id: string, over: Partial<GraphNode> = {}): GraphNode => ({ id, title: id, kind: 'agent', prompt: 'p', createdBy: 'user', updatedBy: 'user', updatedAt: 't', ...over });
const step = (id: string, over: Partial<PreviewStep> = {}): PreviewStep => ({ id, title: id, kind: 'agent', text: 'p', reused: false, ...over });

describe('withStepModelLines (spec §3.3)', () => {
  const graph: Graph = {
    ...emptyGraph('g', 'G', 't'),
    nodes: [
      node('n1', { model: { provider: 'claude', id: 'opus' }, effort: 'max' }),
      node('n2', { effort: 'high' }),
      node('n3'),
      node('n4', { model: { provider: 'codex', id: 'gpt-6-astra' } }),
      node('n5', { model: { provider: 'claude', id: 'opus' } }),
      node('n6', { kind: 'command', prompt: undefined, command: 'ls' }),
    ],
  };
  const steps = [step('n1'), step('n2'), step('n3'), step('n4'), step('n5', { reused: true }), step('n6', { kind: 'command', text: 'ls' })];

  it('gives a line to each step that differs from the run, with display names, and a warning to each note', () => {
    const out = withStepModelLines(steps, graph, { provider: 'claude', model: 'sonnet', effort: 'high' }, CLAUDE);
    expect(out[0]).toMatchObject({ modelLine: 'Model: Opus · Effort: max' });
    // Its own effort equals the run's: nothing differs, so no line.
    expect(out[1]).not.toHaveProperty('modelLine');
    expect(out[2]).toEqual(steps[2]);
    expect(out[3]).toEqual({
      ...steps[3],
      modelNote: 'This step is set to an OpenAI Codex model (gpt-6-astra); this run uses Claude, so it uses the default model.',
    });
    // A reused step and a command step run no model.
    expect(out[4]).toEqual(steps[4]);
    expect(out[5]).toEqual(steps[5]);
  });

  it('names an unlisted model by its id, Default for none, and says Copilot has no effort', () => {
    const own: Graph = { ...graph, nodes: [node('n1', { model: { provider: 'claude', id: 'claude-fable-5' } }), node('n2', { effort: 'low' })] };
    const out = withStepModelLines([step('n1'), step('n2')], own, { provider: 'claude' }, undefined);
    expect(out.map((s) => s.modelLine)).toEqual(['Model: claude-fable-5 · Effort: Default', 'Model: Default · Effort: low']);
    const copilot: Graph = { ...graph, nodes: [node('n1', { model: { provider: 'copilot', id: 'gpt-5.6-sol' } })] };
    const listed: ModelChoice[] = [{ value: 'auto', label: 'Auto', efforts: [] }, { value: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', efforts: [] }];
    expect(withStepModelLines([step('n1')], copilot, { provider: 'copilot' }, listed)[0].modelLine).toBe('Model: GPT-5.6 Sol · Effort: not supported');
  });
});
