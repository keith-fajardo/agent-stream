import { describe, expect, it } from 'vitest';
import { emptyGraph, type Graph, type GraphNode } from '@agent-stream/shared';
import { buildNodePrompt, MAX_UPSTREAM_CHARS } from '../src/prompt';

const node = (id: string, kind: 'agent' | 'command', extra: Partial<GraphNode> = {}): GraphNode => ({
  id,
  title: `Title ${id}`,
  kind,
  createdBy: 'user',
  updatedBy: 'user',
  updatedAt: 't',
  ...extra,
});
const graph = (goal: string): Graph => ({ ...emptyGraph('g', 'G', 't'), goal });

describe('buildNodePrompt', () => {
  it('includes the goal, the step and the upstream results', () => {
    const prompt = buildNodePrompt(graph('Prove the new model is equivalent'), node('n3', 'agent', { title: 'Compare', prompt: 'Compare the results.' }), [
      { node: node('n1', 'agent', { title: 'Plan' }), state: { status: 'succeeded' }, output: 'wrote parity.sql', outputPath: '.agent-stream/runs/r/nodes/n1/output.md' },
      {
        node: node('n2', 'command', { title: 'Build', command: 'dbt build -s x' }),
        state: { status: 'succeeded', exitCode: 0, durationMs: 42_100 },
        output: 'OK\n',
        outputPath: '.agent-stream/runs/r/nodes/n2/output.md',
      },
    ]);
    expect(prompt).toBe(`# Workflow goal
Prove the new model is equivalent

# Your step: Compare
Compare the results.

# Results from earlier steps
## n1 · Plan (agent, succeeded)
wrote parity.sql
Full output: .agent-stream/runs/r/nodes/n1/output.md

## n2 · Build (command \`dbt build -s x\`, exit 0, 42.1 s)
OK
Full output: .agent-stream/runs/r/nodes/n2/output.md
`);
  });

  it('puts the step\u2019s description above its prompt, and earlier steps\u2019 descriptions in their headings', () => {
    const g = graph('');
    const n1 = node('n1', 'command', { title: 'Build old', command: 'dbt build -s orders', description: 'Builds the current orders model.' });
    const n2 = node('n2', 'agent', { title: 'Compare', prompt: 'Compare row counts.', description: 'Checks the new model matches.' });
    const text = buildNodePrompt(g, n2, [{ node: n1, state: { status: 'succeeded', exitCode: 0, durationMs: 3200 }, output: 'ok', outputPath: 'out.md' }]);
    expect(text).toContain('# Your step: Compare\nIn short: Checks the new model matches.\nCompare row counts.');
    expect(text).toContain('## n1 \u00b7 Build old: Builds the current orders model. (command `dbt build -s orders`, exit 0, 3.2 s)');
  });

  it('puts an agent step\u2019s description in its heading, and ignores a blank one', () => {
    const text = buildNodePrompt(graph(''), node('n3', 'agent', { prompt: 'x' }), [
      { node: node('n1', 'agent', { title: 'Plan', description: 'Plans the work.' }), state: { status: 'succeeded' }, output: 'o', outputPath: 'p1' },
      { node: node('n2', 'agent', { title: 'Do', description: '   ' }), state: { status: 'succeeded' }, output: 'o', outputPath: 'p2' },
    ]);
    expect(text).toContain('## n1 \u00b7 Plan: Plans the work. (agent, succeeded)');
    expect(text).toContain('## n2 \u00b7 Do (agent, succeeded)');
    expect(buildNodePrompt(graph(''), node('n1', 'agent', { prompt: 'x', description: ' ' }), [])).not.toContain('In short');
  });

  it('omits empty sections and marks missing output', () => {
    expect(buildNodePrompt(graph('  '), node('n1', 'agent', { prompt: 'Do it.' }), [])).toBe('# Your step: Title n1\nDo it.\n');
    const prompt = buildNodePrompt(graph(''), node('n2', 'agent', { prompt: 'x' }), [
      { node: node('n1', 'agent'), state: { status: 'succeeded' }, output: '', outputPath: 'o' },
    ]);
    expect(prompt).toContain('(no output)');
  });

  it('keeps the start of agent output and the end of command output', () => {
    const big = `START${'a'.repeat(60_000)}END`;
    const prompt = buildNodePrompt(graph(''), node('n3', 'agent', { prompt: 'x' }), [
      { node: node('n1', 'agent'), state: { status: 'succeeded' }, output: big, outputPath: 'o1' },
      { node: node('n2', 'command', { command: 'dbt run' }), state: { status: 'failed', exitCode: 1 }, output: big, outputPath: 'o2' },
    ]);
    const [agentPart, commandPart] = prompt.split('## n2');
    expect(agentPart).toContain('START');
    expect(agentPart).not.toContain('END');
    expect(agentPart).toContain('[truncated');
    expect(commandPart).toContain('END');
    expect(commandPart).not.toContain('START');
    expect(commandPart).toContain('(command `dbt run`, exit 1)');
    expect(prompt.length).toBeLessThan(2 * MAX_UPSTREAM_CHARS + 2_000);
  });

  it('puts the instructions between the goal and the step', () => {
    const g = { ...graph('Prove parity'), instructions: 'Use target dev.\nNever touch prod.' };
    expect(buildNodePrompt(g, node('n1', 'agent', { title: 'Plan', prompt: 'Plan it.' }), [])).toBe(
      '# Workflow goal\nProve parity\n\n# Instructions & context\nUse target dev.\nNever touch prod.\n\n# Your step: Plan\nPlan it.\n',
    );
  });

  it('leaves out blank instructions', () => {
    const g = { ...graph('Prove parity'), instructions: '   ' };
    expect(buildNodePrompt(g, node('n1', 'agent', { title: 'Plan', prompt: 'Plan it.' }), [])).not.toContain('Instructions');
  });
});
