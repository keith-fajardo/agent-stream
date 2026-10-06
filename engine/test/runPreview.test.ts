import { describe, expect, it } from 'vitest';
import { applyOp, emptyGraph, type CheckoutInfo, type Graph, type Op, type RunMeta } from '@agent-stream/shared';
import { envLookup, looksLikeCredential, previewRun } from '../src/runPreview';

function graphOf(ops: Op[]): Graph {
  let g = emptyGraph('g', 'G', 't');
  for (const op of ops) {
    const r = applyOp(g, op, 'user', 't');
    if (!r.ok) throw new Error(r.error);
    g = r.graph;
  }
  return g;
}
const env =
  (vars: Record<string, string> = {}) =>
  (name: string): string | undefined =>
    vars[name];
const cmd = (title: string, command: string): Op => ({ type: 'addNode', node: { title, kind: 'command', command } });
const agent = (title: string, prompt: string): Op => ({ type: 'addNode', node: { title, kind: 'agent', prompt } });
const variable = (name: string): Op => ({ type: 'addVariable', name });
const link = (from: string, to: string): Op => ({ type: 'connect', from, to });

describe('previewRun', () => {
  it('renders quoted commands and plain prompts, and lists the variables used', () => {
    const g = graphOf([variable('model'), variable('unused'), cmd('Build', 'dbt build -s {{ model }}'), agent('Check', `Check {{ model }} in {{ env_var('DBT_SCHEMA', 'dev') }}`)]);
    const { preview, rendered } = previewRun({ graph: g, values: { model: 'orders v2' }, env: env() });
    expect(preview.problems).toEqual([]);
    expect(preview.steps.map((s) => [s.id, s.kind, s.text, s.reused])).toEqual([
      ['n1', 'command', "dbt build -s 'orders v2'", false],
      ['n2', 'agent', 'Check orders v2 in dev', false],
    ]);
    expect(preview.variables).toEqual([{ name: 'model', value: 'orders v2' }]);
    expect(rendered).toEqual({ goal: '', instructions: '', nodes: { n1: "dbt build -s 'orders v2'", n2: 'Check orders v2 in dev' } });
  });

  it('carries a step description into the preview only when it is not blank', () => {
    const g = graphOf([
      { type: 'addNode', node: { title: 'A', kind: 'agent', prompt: 'a', description: '  Does a.  ' } },
      { type: 'addNode', node: { title: 'B', kind: 'command', command: 'ls', description: '   ' } },
      cmd('C', 'ls'),
    ]);
    const { preview } = previewRun({ graph: g, values: {}, env: env() });
    expect(preview.steps[0].description).toBe('Does a.');
    expect(preview.steps[1]).not.toHaveProperty('description');
    expect(preview.steps[2]).not.toHaveProperty('description');
  });

  it('changes the signature when a value or an environment variable changes', () => {
    const g = graphOf([variable('model'), cmd('Build', `dbt build -s {{ model }} --target {{ env_var('T') }}`)]);
    const sig = (model: string, t: string) => previewRun({ graph: g, values: { model }, env: env({ T: t }) }).preview.signature;
    expect(sig('a', 'dev')).toBe(sig('a', 'dev'));
    expect(sig('b', 'dev')).not.toBe(sig('a', 'dev'));
    expect(sig('a', 'prod')).not.toBe(sig('a', 'dev'));
  });

  it('asks once for each variable without a value and renders nothing', () => {
    const g = graphOf([variable('schema'), cmd('A', 'echo {{ schema }}'), agent('B', 'Use {{ schema }}')]);
    const out = previewRun({ graph: g, values: {}, env: env() });
    expect(out.preview.problems).toEqual(['Set a value for schema (Variables menu).']);
    expect(out.rendered).toBeUndefined();
  });

  it('leaves out the text of a step it could not fill in, unlike an empty command', () => {
    const g = graphOf([variable('schema'), cmd('A', 'echo {{ schema }}'), agent('B', 'Use {{ schema }}'), cmd('C', '')]);
    const steps = previewRun({ graph: g, values: {}, env: env() }).preview.steps;
    expect(steps.map((s) => [s.id, 'text' in s ? s.text : 'no text'])).toEqual([
      ['n1', 'no text'],
      ['n2', 'no text'],
      ['n3', ''],
    ]);
  });

  it('names unknown variables and hints at dbt Jinja', () => {
    const g = graphOf([cmd('A', `dbt run -s {{ ref('orders') }} {{ oops }}`)]);
    expect(previewRun({ graph: g, values: {}, env: env() }).preview.problems).toEqual([
      'n1: unknown variable `oops`',
      'n1: unknown variable `ref`. This looks like dbt Jinja. Wrap it in {% raw %}…{% endraw %}.',
    ]);
    const raw = graphOf([agent('A', `Use {% raw %}{{ ref('orders') }}{% endraw %} here`)]);
    expect(previewRun({ graph: raw, values: {}, env: env() }).preview.steps[0].text).toBe(`Use {{ ref('orders') }} here`);
  });

  it('reports missing environment variables and syntax errors per step', () => {
    const g = graphOf([agent('A', `{{ env_var('NOPE') }}`), cmd('B', 'echo {{ x')]);
    expect(previewRun({ graph: g, values: {}, env: env() }).preview.problems).toEqual([
      'n1: environment variable NOPE is not set on this machine',
      'n2: Jinja syntax error: expected variable end',
    ]);
  });

  it('lets a value use env_var() but not another variable', () => {
    const g = graphOf([variable('schema'), variable('other'), cmd('A', 'echo {{ schema }} {{ other }}')]);
    const out = previewRun({ graph: g, values: { schema: `{{ env_var('DBT_SCHEMA', 'dev') }}`, other: '{{ schema }}' }, env: env({ DBT_SCHEMA: 'analytics' }) });
    expect(out.preview.problems).toEqual(['Variable other: a value can only use env_var(), not `schema`.']);
    const fixed = previewRun({ graph: g, values: { schema: `{{ env_var('DBT_SCHEMA', 'dev') }}`, other: 'x' }, env: env({ DBT_SCHEMA: 'analytics' }) });
    expect(fixed.preview.steps[0].text).toBe(`echo 'analytics' 'x'`);
  });

  it('ignores names inherited from Object.prototype', () => {
    const g = graphOf([variable('toString'), cmd('A', 'echo {{ toString }}')]);
    const unset = previewRun({ graph: g, values: {}, env: env() });
    expect(unset.preview.problems).toEqual(['Set a value for toString (Variables menu).']);
    expect(unset.rendered).toBeUndefined();
    expect(previewRun({ graph: g, values: { toString: 'x' }, env: env() }).preview.steps[0].text).toBe("echo 'x'");
  });

  it('treats true and false as booleans', () => {
    const g = graphOf([variable('full'), cmd('A', 'dbt run{% if full %} --full-refresh{% endif %}')]);
    expect(previewRun({ graph: g, values: { full: 'false' }, env: env() }).preview.steps[0].text).toBe('dbt run');
    expect(previewRun({ graph: g, values: { full: ' TRUE ' }, env: env() }).preview.steps[0].text).toBe('dbt run --full-refresh');
  });

  it('warns about credential-looking environment variables and unquoted values', () => {
    const g = graphOf([variable('flags'), agent('Connect', `Use {{ env_var('SNOWFLAKE_PASSWORD') }}`), cmd('Run', 'dbt run {{ flags | unquoted }}')]);
    const out = previewRun({ graph: g, values: { flags: '--full-refresh' }, env: env({ SNOWFLAKE_PASSWORD: 'hunter2' }) });
    expect(out.preview.problems).toEqual([]);
    expect(out.preview.warnings).toEqual([
      "`SNOWFLAKE_PASSWORD` looks like a credential. Its value will appear in this dialog and in the step's logs (and is sent to Claude in agent step n1). Steps already inherit your environment, so tools like dbt can read it directly.",
      'n2 inserts a value without quotes (| unquoted). Check its command below.',
    ]);
  });

  it('adds the command shell problem only when the graph has command steps', () => {
    const problem = 'Command steps need Git Bash on Windows. Install Git for Windows, or set agentStream.gitBashPath.';
    expect(previewRun({ graph: graphOf([agent('A', 'a')]), values: {}, env: env(), commandShellProblem: problem }).preview.problems).toEqual([]);
    expect(previewRun({ graph: graphOf([cmd('A', 'a')]), values: {}, env: env(), commandShellProblem: problem }).preview.problems).toEqual([problem]);
  });

  it('reuses steps whose rendered text is unchanged since the source run', () => {
    const g = graphOf([variable('model'), cmd('Build', 'dbt build -s {{ model }}'), agent('Check', 'check'), link('n1', 'n2')]);
    const first = previewRun({ graph: g, values: { model: 'a' }, env: env() });
    const source: RunMeta = {
      id: '20261002-100000-aaaa',
      graphId: 'g',
      status: 'succeeded',
      startedAt: 't',
      snapshot: g,
      nodes: { n1: { status: 'succeeded' }, n2: { status: 'succeeded' } },
      rendered: first.rendered,
    };
    const same = previewRun({ graph: g, values: { model: 'a' }, env: env(), source, fromNodeId: 'n2' });
    expect(same.preview.steps.map((s) => [s.id, s.reused])).toEqual([['n1', true], ['n2', false]]);
    expect(same.preview.sourceRunId).toBe(source.id);
    const changed = previewRun({ graph: g, values: { model: 'b' }, env: env(), source, fromNodeId: 'n2' });
    expect(changed.preview.steps.map((s) => s.reused)).toEqual([false, false]);
  });
});

describe('previewRun retry modes', () => {
  const g = graphOf([cmd('A', 'a'), cmd('B', 'b'), cmd('C', 'c'), link('n1', 'n2'), link('n2', 'n3')]);
  const first = previewRun({ graph: g, values: {}, env: env() });
  const source = (nodes: RunMeta['nodes']): RunMeta => ({ id: '20261002-100000-aaaa', graphId: 'g', status: 'cancelled', startedAt: 't', snapshot: g, nodes, rendered: first.rendered });
  const stopped = source({ n1: { status: 'succeeded' }, n2: { status: 'cancelled' }, n3: { status: 'cancelled' } });
  const done = source({ n1: { status: 'succeeded' }, n2: { status: 'succeeded' }, n3: { status: 'succeeded' } });
  const flags = (steps: { id: string; reused: boolean; stale?: boolean; notRun?: boolean }[]) => steps.map((s) => [s.id, s.reused, !!s.stale, !!s.notRun]);

  it('retries from where it stopped: keeps what succeeded, runs the rest', () => {
    const out = previewRun({ graph: g, values: {}, env: env(), source: stopped, mode: 'resume' });
    expect(out.preview.mode).toBe('resume');
    expect(flags(out.preview.steps)).toEqual([['n1', true, false, false], ['n2', false, false, false], ['n3', false, false, false]]);
  });

  it('shows what Run only keeps stale and what it does not run', () => {
    const out = previewRun({ graph: g, values: {}, env: env(), source: done, mode: 'only', fromNodeId: 'n2' });
    expect(out.preview.problems).toEqual([]);
    expect(flags(out.preview.steps)).toEqual([['n1', true, false, false], ['n2', false, false, false], ['n3', true, true, false]]);
    const partial = previewRun({ graph: g, values: {}, env: env(), source: stopped, mode: 'only', fromNodeId: 'n1' });
    expect(flags(partial.preview.steps)).toEqual([['n1', false, false, false], ['n2', false, false, true], ['n3', false, false, true]]);
  });

  it('lists a reused step that already carries a stale mark as kept stale', () => {
    const carried = source({ n1: { status: 'succeeded' }, n2: { status: 'succeeded' }, n3: { status: 'succeeded', stale: { reason: 'edited', nodeId: 'n3', runId: 'r0' } } });
    // n3 is reused with its old mark; n2 is not after n3, so only n3 shows as kept stale when the chosen step is n2.
    const out = previewRun({ graph: g, values: {}, env: env(), source: carried, mode: 'only', fromNodeId: 'n2' });
    expect(flags(out.preview.steps)).toEqual([['n1', true, false, false], ['n2', false, false, false], ['n3', true, true, false]]);
    const clean = previewRun({ graph: g, values: {}, env: env(), source: done, mode: 'only', fromNodeId: 'n2' });
    expect(out.preview.signature).toBe(clean.preview.signature);
    // A branch the chosen step isn't on: the carried mark alone makes it stale, and the review says so.
    const wide = graphOf([cmd('A', 'a'), cmd('B', 'b'), cmd('C', 'c'), link('n1', 'n2'), link('n1', 'n3')]);
    const wideFirst = previewRun({ graph: wide, values: {}, env: env() });
    const wideSource: RunMeta = { ...carried, snapshot: wide, rendered: wideFirst.rendered, nodes: { n1: { status: 'succeeded' }, n2: { status: 'succeeded' }, n3: { status: 'succeeded', stale: { reason: 'edited', nodeId: 'n3', runId: 'r0' } } } };
    const branch = previewRun({ graph: wide, values: {}, env: env(), source: wideSource, mode: 'only', fromNodeId: 'n2' });
    expect(flags(branch.preview.steps)).toEqual([['n1', true, false, false], ['n2', false, false, false], ['n3', true, true, false]]);
  });

  it('blocks Run only when an earlier step has no current result', () => {
    const out = previewRun({ graph: g, values: {}, env: env(), source: stopped, mode: 'only', fromNodeId: 'n3' });
    expect(out.preview.problems).toEqual(['Run only n3 needs n2 to have a current result: run it first.']);
    expect(out.rendered).toBeUndefined();
  });

  it('blocks a mode without the run or step it needs', () => {
    expect(previewRun({ graph: g, values: {}, env: env(), mode: 'resume' }).preview.problems).toEqual(['There is no previous run to retry.']);
    expect(previewRun({ graph: g, values: {}, env: env(), source: done, mode: 'only' }).preview.problems).toEqual(['Run only needs a step.']);
  });

  it("covers the mode in the signature, so one mode's review can't start another", () => {
    const sig = (mode: 'resume' | 'from' | 'only', fromNodeId?: string) => previewRun({ graph: g, values: {}, env: env(), source: done, mode, fromNodeId }).preview.signature;
    expect(new Set([sig('from', 'n3'), sig('only', 'n3'), sig('resume')]).size).toBe(3);
    // A request without a mode is a re-run from the step.
    expect(previewRun({ graph: g, values: {}, env: env(), source: done, fromNodeId: 'n3' }).preview.signature).toBe(sig('from', 'n3'));
  });
});

describe('envLookup', () => {
  it('ignores case only on Windows', () => {
    expect(envLookup({ Path: 'x' }, 'win32')('PATH')).toBe('x');
    expect(envLookup({ Path: 'x' }, 'darwin')('PATH')).toBeUndefined();
  });
});

describe('looksLikeCredential', () => {
  it('flags passwords, tokens, secrets and keys', () => {
    for (const name of ['SNOWFLAKE_PASSWORD', 'DB_PASSWD', 'GITHUB_TOKEN', 'CLIENT_SECRET', 'API_KEY', 'PRIVATE_KEY_PATH', 'KEY']) expect(looksLikeCredential(name)).toBe(true);
    for (const name of ['DBT_SCHEMA', 'KEYCHAIN_DIR', 'MONKEY']) expect(looksLikeCredential(name)).toBe(false);
  });
});

describe('previewRun notes and workspaces', () => {
  const SHA = '0123456789abcdef0123456789abcdef01234567';
  const repo = (over: Partial<Extract<CheckoutInfo, { git: true }>> = {}): CheckoutInfo => ({ git: true, root: 'repo', linkedWorktree: false, branch: 'main', head: SHA, dirty: false, worktrees: [], ...over });
  const inWs = (title: string, workspace: string): Op => ({ type: 'addNode', node: { title, kind: 'command', command: 'make', workspace } });

  it('notes write-capable steps of one workspace that will take turns, without blocking', () => {
    const g = graphOf([agent('A', 'a'), agent('B', 'b'), { type: 'addNode', node: { title: 'C', kind: 'agent', prompt: 'c', access: 'read' } }]);
    const { preview, rendered } = previewRun({ graph: g, values: {}, env: env() });
    expect(preview.notes).toEqual(['n1 and n2 can both change files in the same workspace; they will run one at a time.']);
    expect(preview.problems).toEqual([]);
    expect(rendered).toBeDefined();
  });

  it('notes that workspaces start from HEAD when the checkout has uncommitted changes', () => {
    const g = graphOf([inWs('A', 'wh_a')]);
    expect(previewRun({ graph: g, values: {}, env: env(), checkout: repo({ dirty: true }) }).preview.notes).toEqual([
      "Workspaces start from 0123456; uncommitted changes in this checkout aren't included.",
    ]);
    expect(previewRun({ graph: g, values: {}, env: env(), checkout: repo() }).preview.notes).toEqual([]);
    expect(previewRun({ graph: graphOf([agent('A', 'a')]), values: {}, env: env(), checkout: repo({ dirty: true }) }).preview.notes).toEqual([]);
  });

  it('refuses steps with a workspace outside Git and before the first commit, naming each step', () => {
    const g = graphOf([inWs('A', 'wh_a'), inWs('B', 'wh_b'), agent('C', 'c')]);
    const problems = ['Step n1 uses workspace "wh_a", which needs a Git repository with at least one commit.', 'Step n2 uses workspace "wh_b", which needs a Git repository with at least one commit.'];
    for (const checkout of [{ git: false as const, root: 'plain', reason: 'Not a Git repository' }, repo({ head: undefined })]) {
      const out = previewRun({ graph: g, values: {}, env: env(), checkout });
      expect(out.preview.problems).toEqual(problems);
      expect(out.rendered).toBeUndefined();
    }
    expect(previewRun({ graph: g, values: {}, env: env(), checkout: repo() }).preview.problems).toEqual([]);
  });

  it("signs the checkout's HEAD when steps use workspaces, and only then", () => {
    const sig = (g: Graph, checkout?: CheckoutInfo) => previewRun({ graph: g, values: {}, env: env(), ...(checkout && { checkout }) }).preview.signature;
    const other = 'f'.repeat(40);
    const ws = graphOf([inWs('A', 'wh_a')]);
    expect(sig(ws, repo())).toBe(sig(ws, repo()));
    expect(sig(ws, repo({ head: other }))).not.toBe(sig(ws, repo()));
    const plain = graphOf([agent('A', 'a')]);
    expect(sig(plain, repo({ head: other }))).toBe(sig(plain, repo()));
    expect(sig(plain, repo())).toBe(sig(plain));
  });

  it('carries the checkout for the Checkout line', () => {
    expect(previewRun({ graph: graphOf([agent('A', 'a')]), values: {}, env: env(), checkout: repo() }).preview.checkout).toEqual(repo());
    expect(previewRun({ graph: graphOf([agent('A', 'a')]), values: {}, env: env() }).preview).not.toHaveProperty('checkout');
  });
});
