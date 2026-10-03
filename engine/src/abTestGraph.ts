import { applyOp, emptyGraph, toExportFile, workspaceNameProblem, type ExportFile, type Graph, type NewNodeInput, type Op } from '@agent-stream/shared';

export const MIN_VARIANTS = 2;
export const MAX_VARIANTS = 6;
/** Spec §5.4: the template's instructions, repeated in the compare step's prompt. */
export const AB_MEASUREMENT_GUIDANCE =
  "Worktrees separate files only. Give every variant its own external resources: for dbt, a separate target and schema per variant, so variants never build the same tables. Measure fairly: turn off result caches (for Snowflake, `ALTER SESSION SET USE_CACHED_RESULT = FALSE` via a pre-hook or session parameter); start each variant's warehouse suspended so local caches are cold; tag each variant's queries (`query_tag`) and read cost and runtime from the warehouse's query and metering history; repeat short runs, because minimum billing per resume skews them. Compare runtime, cost and failures per variant, and say how confident the result is.";
const SETUP_COMMAND = 'setup_command';
const X = 280;
const ROW = 160;

/** `run_<variant>`: workspace names allow `-`, variable names don't (ruling R11). */
export const abVariableName = (variant: string): string => `run_${variant.replace(/-/g, '_')}`;

/** Why `variant` can't follow `earlier` in an A/B test, or null (used by the wizard, one name at a time). */
export function variantProblem(variant: string, earlier: string[]): string | null {
  const name = variant.trim();
  const problem = workspaceNameProblem(name);
  if (problem) return problem;
  if (earlier.includes(name)) return `Variant ${earlier.length + 1} repeats ${name}.`;
  const clash = earlier.find((v) => abVariableName(v) === abVariableName(name));
  return clash ? `Variants ${clash} and ${name} would both use the variable ${abVariableName(name)}.` : null;
}

/** The A/B test template (spec §5.4): a read-only plan step, a setup and a run step per variant in its own workspace, and a read-only compare step. */
export function abTestGraph(name: string, variants: string[], now: string = new Date().toISOString()): ExportFile {
  if (variants.length < MIN_VARIANTS || variants.length > MAX_VARIANTS) throw new Error(`An A/B test needs ${MIN_VARIANTS} to ${MAX_VARIANTS} variants.`);
  variants.forEach((v, i) => {
    const problem = variantProblem(v, variants.slice(0, i));
    if (problem) throw new Error(problem);
  });
  const list = variants.join(', ');
  const mid = ((variants.length - 1) * ROW) / 2;
  const compareId = `n${2 + 2 * variants.length}`;
  const steps: NewNodeInput[] = [
    {
      id: 'n1',
      title: 'Plan the comparison',
      kind: 'agent',
      access: 'read',
      description: 'Plans a fair comparison of the variants.',
      prompt: `Plan how to compare these variants fairly: ${list}. Check how the project is configured (for dbt: profiles, targets and schemas) and confirm that every variant uses its own external resources, so variants never write to the same tables. Say what setup_command and each variant's run command should be, and what the compare step should measure. Don't change anything.`,
      position: { x: 0, y: mid },
    },
    ...variants.flatMap((v, i): NewNodeInput[] => [
      { id: `n${2 + 2 * i}`, title: `Set up ${v}`, kind: 'command', workspace: v, description: `Prepares the ${v} worktree.`, command: `{{ ${SETUP_COMMAND} | unquoted }}`, position: { x: X, y: i * ROW } },
      { id: `n${3 + 2 * i}`, title: `Run ${v}`, kind: 'command', workspace: v, description: `Runs the ${v} variant.`, command: `{{ ${abVariableName(v)} | unquoted }}`, position: { x: 2 * X, y: i * ROW } },
    ]),
    {
      id: compareId,
      title: 'Compare and recommend',
      kind: 'agent',
      access: 'read',
      description: 'Compares the runtime, cost and failures of every variant and recommends one.',
      // Read-only (spec §5.4 table), so it can't run commands itself (ruling R12).
      prompt: `Compare the variants ${list} from each run step's output and duration above. ${AB_MEASUREMENT_GUIDANCE} If you need the warehouse's query or metering history, say which read-only query to run: this step can't run commands, so the user can add a command step, or mark this step "Can edit files" so each command asks for approval. Recommend one variant and explain why.`,
      position: { x: 3 * X, y: mid },
    },
  ];
  const edges: [string, string][] = variants.flatMap((_, i): [string, string][] => [
    ['n1', `n${2 + 2 * i}`],
    [`n${2 + 2 * i}`, `n${3 + 2 * i}`],
    [`n${3 + 2 * i}`, compareId],
  ]);
  let g: Graph = {
    ...emptyGraph('ab-test', name.trim(), now),
    goal: `Compare ${list} and recommend one.`,
    instructions: AB_MEASUREMENT_GUIDANCE,
    variables: [
      { name: SETUP_COMMAND, description: 'Prepares a fresh worktree, e.g. dbt deps (new worktrees have no untracked files such as .venv, dbt_packages or node_modules)' },
      ...variants.map((v) => ({ name: abVariableName(v), description: `The command for variant ${v}, e.g. dbt build --target ${v}` })),
    ],
  };
  for (const op of [...steps.map((node): Op => ({ type: 'addNode', node })), ...edges.map(([from, to]): Op => ({ type: 'connect', from, to }))]) {
    const r = applyOp(g, op, 'user', now);
    if (!r.ok) throw new Error(r.error);
    g = r.graph;
  }
  return toExportFile(g, now);
}
