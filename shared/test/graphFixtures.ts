import { applyOp, emptyGraph } from '../src/graph';
import { EFFORT_LEVELS, type Graph, type NewNodeInput, type Op, type StepModel } from '../src/types';

export const T0 = '2026-10-04T00:00:00.000Z';

/** Builds a graph through applyOp, so it is valid by construction. */
export function build(name: string, ops: Op[], at = T0): Graph {
  let g = emptyGraph('g', name, at);
  for (const op of ops) {
    const r = applyOp(g, op, 'user', at);
    if (!r.ok) throw new Error(`${op.type}: ${r.error}`);
    g = r.graph;
  }
  return g;
}

const add = (node: NewNodeInput): Op => ({ type: 'addNode', node });
const connect = (from: string, to: string): Op => ({ type: 'connect', from, to });

/** Hand-picked graphs: what each one stresses is in its name. */
export const FIXTURES: Record<string, Graph> = {
  empty: build('Empty', []),
  example: build('scd2_tests', [
    { type: 'setGoal', goal: 'Prove the SCD2 model works.' },
    { type: 'setInstructions', instructions: 'Use the dev target. Never touch prod.' },
    { type: 'addVariable', name: 'target_schema', description: 'Schema the tests write to' },
    add({ title: 'Check table absent', kind: 'command', command: "dbt run-operation table_exists --args '{table: dim_customer}'", timeoutSec: 120, description: "Confirms the target table doesn't exist before the first run." }),
    add({ title: 'Run model', kind: 'agent', workspace: 'wh_a', prompt: 'Run `dbt run -s dim_customer` and report the row count.', description: 'Builds the model for the first time.' }),
    add({ title: 'Check table exists', kind: 'command', command: 'dbt run-operation table_exists' }),
    connect('n1', 'n2'),
    connect('n2', 'n3'),
  ]),
  fencesAndJinja: build('Fences', [
    add({ title: 'Inner fences', kind: 'agent', prompt: 'Write:\n```sql\nselect 1\n```\nand\n````md\nx\n````' }),
    add({ title: 'Jinja', kind: 'command', command: "dbt run --vars '{{ vars }}' {% raw %}{{ keep }}{% endraw %}\n" }),
    add({ title: 'Empty prompt', kind: 'agent' }),
    add({ title: 'Only newlines', kind: 'agent', prompt: '\n\n' }),
    connect('n1', 'n3'),
    connect('n2', 'n3'),
  ]),
  unicodeAndQuotes: build('Größe "quoted" ✓', [
    { type: 'setGoal', goal: '## Looks like a section\n# and a name\n```\nunclosed block' },
    { type: 'setInstructions', instructions: '\\## already escaped\n````\n## inside\n````' },
    add({ title: 'Prüfen · "日本語" #1', kind: 'agent', access: 'read', prompt: 'p', timeoutSec: 30 }),
    add({ id: 'custom-id_1', title: 'Custom', kind: 'command', command: '~~~\n```' }),
    connect('n1', 'custom-id_1'),
  ]),
};

/** A small seeded random generator (mulberry32), so failures can be replayed. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TEXTS = ['', 'plain', '```', '````js\nx\n````', '{% raw %}{{ x }}{% endraw %}', '## not a heading', '# H1', '\n', ' leading space', 'trailing  ', '~~~', '> quote', '- kind: command', '\\## esc', '日本語 ✓', 'a · b', '"q"', '```\nunclosed', '\r\nwindows'];
const TITLES = ['Build', 'Prüfen · 日本語', 'Say "hi"', '# hash', 'Goal', 'a\nb', '  padded  ', 'end'];
const MODELS: StepModel[] = [
  { provider: 'claude', id: 'opus' },
  { provider: 'claude', id: 'claude-opus-4-8' },
  { provider: 'codex', id: 'gpt-6-astra' },
  { provider: 'copilot', id: 'auto' },
  { provider: 'codex', id: 'org/model_1.5:beta' },
];

/** A random valid graph: steps, fields, edges (always forward, so no cycles), variables and tricky text. */
export function randomGraph(seed: number): Graph {
  const r = rng(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
  const text = () => Array.from({ length: Math.floor(r() * 3) }, () => pick(TEXTS)).join(pick(['\n', ' ', '']));
  const ops: Op[] = [{ type: 'setGoal', goal: text() }, { type: 'setInstructions', instructions: text() }];
  const varCount = Math.floor(r() * 3);
  for (let v = 0; v < varCount; v++) ops.push({ type: 'addVariable', name: `var_${v}`, description: pick(['', 'Some value', 'two\nlines', ' x ']) });
  const count = Math.floor(r() * 6);
  for (let i = 0; i < count; i++) {
    const kind = r() < 0.5 ? 'agent' : 'command';
    ops.push(
      add({
        title: pick(TITLES),
        kind,
        ...(kind === 'agent' ? { prompt: text() } : { command: text() }),
        ...(r() < 0.3 && { description: pick(['Why it runs.', 'multi\nline', ' spaced ']) }),
        ...(r() < 0.3 && { timeoutSec: 1 + Math.floor(r() * 600) }),
        ...(kind === 'agent' && r() < 0.3 && { access: 'read' as const }),
        ...(r() < 0.2 && { workspace: pick(['wh_a', 'wh-b']) }),
        ...(r() < 0.3 && { position: { x: Math.floor(r() * 500), y: Math.floor(r() * 500) } }),
        ...(kind === 'agent' && r() < 0.4 && { model: pick(MODELS) }),
        ...(kind === 'agent' && r() < 0.4 && { effort: pick(EFFORT_LEVELS) }),
      }),
    );
  }
  for (let a = 1; a <= count; a++) for (let b = a + 1; b <= count; b++) if (r() < 0.3) ops.push(connect(`n${a}`, `n${b}`));
  return build(pick(['G', 'Graph · 1', 'Ünïcode']), ops);
}
