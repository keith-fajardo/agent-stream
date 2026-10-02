import { describe, expect, it } from 'vitest';
import { applyOp, emptyGraph, type Graph, type Op, type RunMeta } from '@claude-stream/shared';
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
    const problem = 'Command steps need Git Bash on Windows. Install Git for Windows, or set claudeStream.gitBashPath.';
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
