import { describe, expect, it } from 'vitest';
import { emptyGraph } from '../src/graph';
import { effortProblem, resolveStepModel, runStepModels, stepModelNote, type RunModels } from '../src/stepModels';
import type { EffortLevel, Graph, GraphNode, ModelChoice, RunMeta } from '../src/types';

const all: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];
/** Claude Code's list, as the research appendix found it (spec §8), cut down. */
const CLAUDE: ModelChoice[] = [
  { value: 'default', label: 'Default (recommended)', efforts: all },
  { value: 'sonnet', label: 'Sonnet', efforts: all, resolved: 'claude-sonnet-5' },
  { value: 'opus', label: 'Opus', efforts: all, resolved: 'claude-opus-5' },
  { value: 'haiku', label: 'Haiku', efforts: [] },
  { value: 'claude-opus-4-6', label: 'Opus 4.6', efforts: ['low', 'medium', 'high', 'max'] },
];
const CODEX: ModelChoice[] = [
  { value: 'gpt-6.1-sol', label: 'GPT-6.1-Sol', efforts: [...all, 'ultra'], isDefault: true },
  { value: 'gpt-6-luna', label: 'GPT-6-Luna', efforts: all },
];
const COPILOT: ModelChoice[] = [
  { value: 'auto', label: 'Auto', efforts: [] },
  { value: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', efforts: [] },
];
const claudeRun: RunModels = { provider: 'claude', model: 'sonnet', effort: 'high' };
const opus = { provider: 'claude' as const, id: 'opus' };

describe('resolveStepModel (spec §3.2)', () => {
  it('rule 1: a step without its own gets exactly the run’s model and effort', () => {
    expect(resolveStepModel({}, claudeRun, CLAUDE)).toEqual({ model: 'sonnet', effort: 'high' });
    expect(resolveStepModel({}, { provider: 'claude' }, CLAUDE)).toEqual({});
    // As before step models: the provider drops an effort its model lacks, with its own log note.
    expect(resolveStepModel({}, { provider: 'claude', model: 'haiku', effort: 'high' }, CLAUDE)).toEqual({ model: 'haiku', effort: 'high' });
  });

  it('rule 2: the step’s own model of the run’s provider, when the list offers it or isn’t known', () => {
    expect(resolveStepModel({ model: opus }, claudeRun, CLAUDE)).toEqual({ model: 'opus', effort: 'high' });
    expect(resolveStepModel({ model: { provider: 'claude', id: 'claude-opus-5' } }, claudeRun, CLAUDE)).toEqual({ model: 'claude-opus-5', effort: 'high' });
    expect(resolveStepModel({ model: { provider: 'claude', id: 'claude-fable-9' } }, claudeRun, undefined)).toEqual({ model: 'claude-fable-9', effort: 'high' });
    expect(resolveStepModel({ model: { provider: 'claude', id: 'claude-fable-9' } }, claudeRun, [])).toEqual({ model: 'claude-fable-9', effort: 'high' });
  });

  it('rule 2: a model the known list doesn’t offer runs the run’s model, with a note', () => {
    expect(resolveStepModel({ model: { provider: 'claude', id: 'claude-opus-4-1' } }, claudeRun, CLAUDE)).toEqual({
      model: 'sonnet',
      effort: 'high',
      note: "claude-opus-4-1 isn't offered by Claude any more (or on this plan), so this step uses the default model.",
    });
  });

  it('rule 2: Copilot still tries a model its list doesn’t name, with the same note', () => {
    expect(resolveStepModel({ model: { provider: 'copilot', id: 'grok-4.7' } }, { provider: 'copilot' }, COPILOT)).toEqual({
      model: 'grok-4.7',
      note: "grok-4.7 isn't offered by GitHub Copilot any more (or on this plan), so this step uses the default model.",
    });
    expect(resolveStepModel({ model: { provider: 'copilot', id: 'gpt-5.6-sol' } }, { provider: 'copilot' }, COPILOT)).toEqual({ model: 'gpt-5.6-sol' });
  });

  it('rule 3: a model of another provider runs the run’s model, with a note', () => {
    expect(resolveStepModel({ model: { provider: 'codex', id: 'gpt-6-astra' } }, claudeRun, CLAUDE)).toEqual({
      model: 'sonnet',
      effort: 'high',
      note: 'This step is set to an OpenAI Codex model (gpt-6-astra); this run uses Claude, so it uses the default model.',
    });
    expect(resolveStepModel({ model: opus }, { provider: 'codex' }, undefined)).toEqual({
      note: 'This step is set to a Claude model (opus); this run uses OpenAI Codex, so it uses the default model.',
    });
  });

  it('rule 4: the step’s effort, else the run’s, checked against the model the step uses', () => {
    expect(resolveStepModel({ effort: 'low' }, claudeRun, CLAUDE)).toEqual({ model: 'sonnet', effort: 'low' });
    expect(resolveStepModel({ model: opus, effort: 'max' }, claudeRun, CLAUDE)).toEqual({ model: 'opus', effort: 'max' });
    // The step's own effort dropped: the provider's own wording, as a note.
    expect(resolveStepModel({ model: { provider: 'claude', id: 'claude-opus-4-6' }, effort: 'xhigh' }, claudeRun, CLAUDE)).toEqual({
      model: 'claude-opus-4-6',
      note: 'Opus 4.6 (claude-opus-4-6) has no "xhigh" effort level; running without an effort level.',
    });
    expect(resolveStepModel({ effort: 'ultra' }, claudeRun, CLAUDE)).toEqual({ model: 'sonnet', note: 'Claude has no "ultra" effort level; running without an effort level.' });
    // The run's effort dropped for the step's own model: no note, the line shows it.
    expect(resolveStepModel({ model: { provider: 'claude', id: 'haiku' } }, claudeRun, CLAUDE)).toEqual({ model: 'haiku' });
    // Codex with no model: its default model's levels.
    expect(resolveStepModel({ effort: 'ultra' }, { provider: 'codex' }, CODEX)).toEqual({ effort: 'ultra' });
    expect(resolveStepModel({ model: { provider: 'codex', id: 'gpt-6-luna' }, effort: 'ultra' }, { provider: 'codex' }, CODEX)).toEqual({
      model: 'gpt-6-luna',
      note: 'GPT-6-Luna (gpt-6-luna) has no "ultra" effort level; running without an effort level.',
    });
  });

  it('Copilot has no effort levels: a step’s own effort is ignored, with a note', () => {
    expect(resolveStepModel({ effort: 'high' }, { provider: 'copilot' }, COPILOT)).toEqual({ note: 'GitHub Copilot has no effort levels; running without an effort level.' });
    expect(effortProblem('copilot', 'auto', 'low', undefined)).toBe('GitHub Copilot has no effort levels; running without an effort level.');
  });

  it('joins a model note and an effort note', () => {
    expect(resolveStepModel({ model: { provider: 'codex', id: 'gpt-6-astra' }, effort: 'ultra' }, claudeRun, CLAUDE).note).toBe(
      'This step is set to an OpenAI Codex model (gpt-6-astra); this run uses Claude, so it uses the default model. Claude has no "ultra" effort level; running without an effort level.',
    );
  });

  it('stepModelNote is null for a model the run can use', () => {
    expect(stepModelNote(opus, 'claude', CLAUDE)).toBeNull();
    expect(stepModelNote(opus, 'claude', undefined)).toBeNull();
  });
});

describe('runStepModels (spec §3.1)', () => {
  const node = (id: string, over: Partial<GraphNode> = {}): GraphNode => ({ id, title: id, kind: 'agent', prompt: 'p', createdBy: 'user', updatedBy: 'user', updatedAt: 't', ...over });
  const graph: Graph = {
    ...emptyGraph('g', 'G', 't'),
    nodes: [node('n1', { model: opus }), node('n2', { kind: 'command', prompt: undefined, command: 'ls' }), node('n3', { effort: 'low' }), node('n4')],
  };

  it('resolves every agent step, and leaves command steps out', () => {
    expect(runStepModels(graph, claudeRun, CLAUDE)).toEqual({
      n1: { model: 'opus', effort: 'high' },
      n3: { model: 'sonnet', effort: 'low' },
      n4: { model: 'sonnet', effort: 'high' },
    });
  });

  it('a reused step keeps what it ran with: its record, or the source run’s model and effort', () => {
    const source = { id: 'r0', model: 'haiku', effort: 'medium', stepModels: { n1: { model: 'claude-opus-4-6', note: 'x' } } } as unknown as RunMeta;
    expect(runStepModels(graph, claudeRun, CLAUDE, new Set(['n1', 'n4']), source)).toEqual({
      n1: { model: 'claude-opus-4-6', note: 'x' },
      n3: { model: 'sonnet', effort: 'low' },
      n4: { model: 'haiku', effort: 'medium' },
    });
  });
});
