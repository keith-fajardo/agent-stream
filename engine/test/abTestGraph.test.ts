import { describe, expect, it } from 'vitest';
import { parallelWriteSteps, parseExportFile, upstream, validateRunnable, WORKSPACE_NAME_PROBLEM } from '@agent-stream/shared';
import { AB_MEASUREMENT_GUIDANCE, abTestGraph, variantProblem } from '../src/abTestGraph';

const T = '2026-10-03T00:00:00.000Z';
function parsed(variants: string[]) {
  const r = parseExportFile(JSON.stringify(abTestGraph('Warehouse cost test', variants, T)), 'ab', T);
  if (!r.ok) throw new Error(r.error);
  return r.graph;
}

describe('A/B test template', () => {
  it.each([[['wh_small', 'wh_large']], [['a', 'b', 'c', 'd', 'e', 'f']]])('is a valid graph for %j', (variants) => {
    const g = parsed(variants);
    expect(g.name).toBe('Warehouse cost test');
    expect(validateRunnable(g)).toEqual([]);
    expect(g.nodes).toHaveLength(2 + 2 * variants.length);
    expect(g.variables.map((v) => v.name)).toEqual(['setup_command', ...variants.map((v) => `run_${v}`)]);
  });

  it("puts each variant's setup and run steps in its own workspace", () => {
    const g = parsed(['wh_small', 'wh_large']);
    expect(g.nodes.map((n) => [n.id, n.title, n.workspace ?? null, n.command ?? null])).toEqual([
      ['n1', 'Plan the comparison', null, null],
      ['n2', 'Set up wh_small', 'wh_small', '{{ setup_command | unquoted }}'],
      ['n3', 'Run wh_small', 'wh_small', '{{ run_wh_small | unquoted }}'],
      ['n4', 'Set up wh_large', 'wh_large', '{{ setup_command | unquoted }}'],
      ['n5', 'Run wh_large', 'wh_large', '{{ run_wh_large | unquoted }}'],
      ['n6', 'Compare and recommend', null, null],
    ]);
    expect(g.edges.map((e) => e.id).sort()).toEqual(['n1->n2', 'n1->n4', 'n2->n3', 'n3->n6', 'n4->n5', 'n5->n6']);
    expect(parallelWriteSteps(g)).toEqual([]);
  });

  it('makes compare depend on every run step, with plan and compare read-only', () => {
    const g = parsed(['a', 'b', 'c']);
    expect(upstream(g, 'n8').sort()).toEqual(['n3', 'n5', 'n7']);
    expect(g.nodes.filter((n) => n.access === 'read').map((n) => n.id)).toEqual(['n1', 'n8']);
  });

  it('carries the measurement guidance in its instructions and in the compare prompt', () => {
    expect(AB_MEASUREMENT_GUIDANCE).toBe(
      'Worktrees separate files only. Give every variant its own external resources: for dbt, a separate target and schema per variant, so variants never build the same tables. Measure fairly: turn off result caches (for Snowflake, `ALTER SESSION SET USE_CACHED_RESULT = FALSE` via a pre-hook or session parameter); start each variant\'s warehouse suspended so local caches are cold; tag each variant\'s queries (`query_tag`) and read cost and runtime from the warehouse\'s query and metering history; repeat short runs, because minimum billing per resume skews them. Compare runtime, cost and failures per variant, and say how confident the result is.',
    );
    const g = parsed(['wh_small', 'wh_large']);
    expect(g.instructions).toBe(AB_MEASUREMENT_GUIDANCE);
    const compare = g.nodes.find((n) => n.id === 'n6')!;
    expect(compare.prompt).toContain(AB_MEASUREMENT_GUIDANCE);
    expect(compare.prompt).toContain('Recommend one variant and explain why.');
    expect(g.variables[0].description).toBe('Prepares a fresh worktree, e.g. dbt deps (new worktrees have no untracked files such as .venv, dbt_packages or node_modules)');
    expect(g.variables[1].description).toBe('The command for variant wh_small, e.g. dbt build --target wh_small');
  });

  it('fans out: plan on the left, one row per variant, compare on the right', () => {
    const g = parsed(['wh_small', 'wh_large']);
    expect(Object.fromEntries(g.nodes.map((n) => [n.id, n.position]))).toEqual({
      n1: { x: 0, y: 80 },
      n2: { x: 280, y: 0 },
      n3: { x: 560, y: 0 },
      n4: { x: 280, y: 160 },
      n5: { x: 560, y: 160 },
      n6: { x: 840, y: 80 },
    });
  });

  it('turns - into _ in variable names (ruling R11)', () => {
    expect(parsed(['wh-small', 'wh-large']).nodes.find((n) => n.id === 'n3')!.command).toBe('{{ run_wh_small | unquoted }}');
  });

  it('refuses fewer than 2 or more than 6 variants, bad names, repeats and clashing variables', () => {
    expect(() => abTestGraph('x', ['a'])).toThrow('An A/B test needs 2 to 6 variants.');
    expect(() => abTestGraph('x', ['a', 'b', 'c', 'd', 'e', 'f', 'g'])).toThrow('An A/B test needs 2 to 6 variants.');
    expect(variantProblem('Bad', [])).toBe(WORKSPACE_NAME_PROBLEM);
    expect(variantProblem('a', ['a'])).toBe('Variant 2 repeats a.');
    expect(variantProblem('wh_small', ['wh-small'])).toBe('Variants wh-small and wh_small would both use the variable run_wh_small.');
    expect(variantProblem('wh_large', ['wh_small'])).toBeNull();
  });
});
