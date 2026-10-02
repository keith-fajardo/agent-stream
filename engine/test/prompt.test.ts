import { describe, expect, it } from 'vitest';
import { emptyGraph, type Graph, type GraphNode } from '@claude-stream/shared';
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
      { node: node('n1', 'agent', { title: 'Plan' }), state: { status: 'succeeded' }, output: 'wrote parity.sql', outputPath: '.claude-stream/runs/r/nodes/n1/output.md' },
      {
        node: node('n2', 'command', { title: 'Build', command: 'dbt build -s x' }),
        state: { status: 'succeeded', exitCode: 0, durationMs: 42_100 },
        output: 'OK\n',
        outputPath: '.claude-stream/runs/r/nodes/n2/output.md',
      },
    ]);
    expect(prompt).toBe(`# Workflow goal
Prove the new model is equivalent

# Your step: Compare
Compare the results.

# Results from earlier steps
## n1 · Plan (agent, succeeded)
wrote parity.sql
Full output: .claude-stream/runs/r/nodes/n1/output.md

## n2 · Build (command \`dbt build -s x\`, exit 0, 42.1 s)
OK
Full output: .claude-stream/runs/r/nodes/n2/output.md
`);
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
});
