import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyOp, emptyGraph, expandGraph, type Graph, type GraphLookup, type Op, type ServerMessage } from '@agent-stream/shared';
import { CHANGED_SINCE_REVIEW, createApp } from '../src/app';
import { previewRun } from '../src/runPreview';
import { appTestDeps, signedIn, testGitBash, testProvider, tmpProject, tmpValuesFile } from './helpers';

function graphOf(id: string, name: string, ops: Op[]): Graph {
  let g = emptyGraph(id, name, 't');
  for (const op of ops) {
    const r = applyOp(g, op, 'user', 't');
    if (!r.ok) throw new Error(r.error);
    g = r.graph;
  }
  return g;
}
const env = () => () => undefined;
const agent = (title: string, prompt: string, over: object = {}): Op => ({ type: 'addNode', node: { title, kind: 'agent', prompt, ...over } });
const sub = (title: string, graph: string, values?: Record<string, string>): Op => ({ type: 'addNode', node: { title, kind: 'graph', graph, ...(values && { values }) } });
const link = (from: string, to: string): Op => ({ type: 'connect', from, to });

/** Company research: its own goal and instructions, and two variables. */
const research = graphOf('company-research', 'Company research', [
  { type: 'setGoal', goal: 'Know {{ company }}.' },
  { type: 'setInstructions', instructions: 'Be {{ depth }}.' },
  { type: 'addVariable', name: 'company', description: 'Who to research' },
  { type: 'addVariable', name: 'depth', description: 'quick or thorough' },
  agent('Find site', 'Find the site of {{ company }}.'),
  agent('Summarize', 'Summarize {{ company }}, {{ depth }}.'),
  link('n1', 'n2'),
]);
const hunting = (values: Record<string, string>) =>
  graphOf('job-hunting', 'Job hunting', [{ type: 'setGoal', goal: 'Get a job at {{ target_company }}.' }, { type: 'addVariable', name: 'target_company' }, agent('Plan', 'Plan for {{ target_company }}.'), sub('Research', 'company-research', values), link('n1', 'n2')]);
const lookupOf =
  (...graphs: Graph[]): GraphLookup =>
  (id) => {
    const g = graphs.find((x) => x.id === id);
    return g ? { ok: true, graph: g } : { ok: false, reason: 'missing', error: 'missing' };
  };
const preview = (outer: Graph, values: Record<string, string>, ...inner: Graph[]) => previewRun({ graph: outer, values, env: env(), expansion: expandGraph(outer, lookupOf(...inner)) });

describe('previewRun on a graph with a sub-graph step', () => {
  it('renders inner steps with values set on the step, from the outer variables, and each sub-graph’s own goal and instructions', () => {
    const outer = hunting({ company: '{{ target_company }} Inc.', depth: 'quick' });
    const { preview: p, rendered, expanded, scopes } = preview(outer, { target_company: 'Acme' }, research);
    expect(p.problems).toEqual([]);
    expect(rendered).toEqual({
      goal: 'Get a job at Acme.',
      instructions: '',
      nodes: { n1: 'Plan for Acme.', n2: '', 'n2/n1': 'Find the site of Acme Inc..', 'n2/n2': 'Summarize Acme Inc., quick.' },
      scopes: { n2: { goal: 'Know Acme Inc..', instructions: 'Be quick.' } },
    });
    expect(expanded?.nodes.map((n) => n.id)).toEqual(['n1', 'n2', 'n2/n1', 'n2/n2']);
    expect(scopes?.n2.graphName).toBe('Company research');
    // The run dialog's table shows every value the run uses, inner ones by their run-form label.
    expect(p.variables).toEqual([
      { name: 'n2/company', value: 'Acme Inc.', label: 'n2 · company' },
      { name: 'n2/depth', value: 'quick', label: 'n2 · depth' },
      { name: 'target_company', value: 'Acme' },
    ]);
  });

  it('lists the steps in run order, inner steps under their sub-graph step with their depth', () => {
    const { preview: p } = preview(hunting({ company: 'Acme', depth: 'quick' }), {}, research);
    expect(p.steps.map((s) => [s.id, s.kind, s.depth, s.subgraph])).toEqual([
      ['n1', 'agent', undefined, undefined],
      ['n2', 'graph', undefined, { graphName: 'Company research', steps: 2 }],
      ['n2/n1', 'agent', 1, undefined],
      ['n2/n2', 'agent', 1, undefined],
    ]);
  });

  it('asks for an empty value in the run form as <step>/<name>, and uses the value typed there', () => {
    const outer = hunting({ company: 'Acme' });
    expect(preview(outer, { target_company: 'Acme' }, research).preview.problems).toEqual(['Set a value for n2 · depth (Variables menu).']);
    const { preview: p, rendered } = preview(outer, { target_company: 'Acme', 'n2/depth': 'thorough' }, research);
    expect(p.problems).toEqual([]);
    expect(rendered?.nodes['n2/n2']).toBe('Summarize Acme, thorough.');
    expect(p.variables).toEqual([
      { name: 'n2/company', value: 'Acme', label: 'n2 · company' },
      { name: 'n2/depth', value: 'thorough', label: 'n2 · depth' },
      { name: 'target_company', value: 'Acme' },
    ]);
  });

  it('asks for the outer variable a set value uses, and reports a value that uses an unknown one', () => {
    expect(preview(hunting({ company: '{{ target_company }}', depth: 'quick' }), {}, research).preview.problems).toEqual(['Set a value for target_company (Variables menu).']);
    expect(preview(hunting({ company: '{{ nope }}', depth: 'quick' }), { target_company: 'Acme' }, research).preview.problems).toEqual(['n2 · company: unknown variable `nope`']);
  });

  it('gives two uses of the same graph their own values (Review Focus 2)', () => {
    const outer = graphOf('o', 'O', [{ type: 'addVariable', name: 'target_company' }, sub('A', 'company-research', { company: 'Acme', depth: 'quick' }), sub('B', 'company-research', { company: '{{ target_company }}' })]);
    const { preview: p, rendered } = preview(outer, { target_company: 'Initech', 'n2/depth': 'thorough' }, research);
    expect(p.problems).toEqual([]);
    expect(rendered?.nodes['n1/n2']).toBe('Summarize Acme, quick.');
    expect(rendered?.nodes['n2/n2']).toBe('Summarize Initech, thorough.');
    expect(rendered?.scopes).toEqual({ n1: { goal: 'Know Acme.', instructions: 'Be quick.' }, n2: { goal: 'Know Initech.', instructions: 'Be thorough.' } });
  });

  it('an expansion problem blocks the run and is listed; a graph with no expansion given reports its inner graphs missing', () => {
    const outer = hunting({ company: 'Acme', depth: 'quick' });
    const { preview: p, rendered } = preview(outer, {});
    expect(p.problems).toEqual(['Step n2 uses graph "company-research", which isn\'t in this folder.']);
    expect(rendered).toBeUndefined();
    expect(p.steps.map((s) => s.id)).toEqual(['n1', 'n2']);
    expect(previewRun({ graph: outer, values: {}, env: env() }).preview.problems).toEqual(['Step n2 uses graph "company-research", which isn\'t in this folder.']);
  });

  it('follows a chain of sub-graph values back to the outer variable it needs', () => {
    const b = graphOf('b', 'B', [{ type: 'addVariable', name: 'b' }, agent('Do', 'Do {{ b }}.')]);
    const a = graphOf('a', 'A', [{ type: 'addVariable', name: 'a' }, sub('Use B', 'b', { b: '{{ a }}' })]);
    const o = graphOf('o', 'O', [{ type: 'addVariable', name: 't' }, sub('Use A', 'a', { a: '{{ t }}' })]);
    const empty = preview(o, {}, a, b);
    expect(empty.preview.problems).toEqual(['Set a value for t (Variables menu).']);
    expect(empty.rendered).toBeUndefined();
    expect(preview(o, { t: 'X' }, a, b).rendered?.nodes['n1/n1/n1']).toBe('Do X.');
  });

  it('warns about a missing attachment of an inner graph, naming its own folder', () => {
    const withFile = { ...research, attachments: ['brief.md'] };
    const outer = hunting({ company: 'Acme', depth: 'quick' });
    const p = previewRun({ graph: outer, values: {}, env: env(), expansion: expandGraph(outer, lookupOf(withFile)), attachments: [{ name: 'brief.md', graphId: 'company-research' }] }).preview;
    expect(p.warnings).toEqual(["Company research's attachment brief.md is missing from .agent-stream/attachments/company-research/, so the agent steps in n2 run without it."]);
  });
});

describe('the App previews and starts the expanded graph', () => {
  function setup() {
    const paths = tmpProject();
    const app = createApp({ ...appTestDeps(), projectDir: paths.root, valuesFile: tmpValuesFile(), provider: testProvider(), status: signedIn, maxParallel: 1, gitBash: testGitBash });
    const msgs: ServerMessage[] = [];
    const c = { send: (m: ServerMessage) => void msgs.push(structuredClone(m)) };
    app.connect(c);
    const store = app.graphStore;
    const inner = store.create('Company research').id;
    store.apply(inner, { type: 'addVariable', name: 'depth' }, 'user');
    store.apply(inner, { type: 'addNode', node: { title: 'Find site', kind: 'agent', prompt: 'Find it, {{ depth }}.' } }, 'user');
    const outer = store.create('Job hunting').id;
    store.apply(outer, { type: 'addNode', node: { title: 'Research', kind: 'graph', graph: inner } }, 'user');
    const last = <T extends ServerMessage['type']>(type: T) => msgs.filter((m): m is Extract<ServerMessage, { type: T }> => m.type === type).at(-1)!;
    return { app, c, store, inner, outer, paths, last };
  }

  it('remembers a run-form value under the outer graph as <step>/<name>, and refuses one no sub-graph has', async () => {
    const s = setup();
    await s.app.handle(s.c, { type: 'setVariableValue', graphId: s.outer, name: 'n1/depth', value: 'quick' });
    expect(s.app.values.get(s.outer)).toEqual({ 'n1/depth': 'quick' });
    await s.app.handle(s.c, { type: 'setVariableValue', graphId: s.outer, name: 'n1/nope', value: 'x' });
    expect(s.last('error').message).toBe('variable n1/nope does not exist');
    await s.app.handle(s.c, { type: 'previewRun', graphId: s.outer });
    expect(s.last('runPreview').preview.problems).toEqual([]);
    expect(s.last('runPreview').preview.steps.find((x) => x.id === 'n1/n1')?.text).toBe('Find it, quick.');
  });

  it('refuses an inner graph whose file has errors, not its last good version', async () => {
    const s = setup();
    const file = join(s.paths.graphsDir, `${s.inner}.md`);
    writeFileSync(file, readFileSync(file, 'utf8').replace('- kind: agent', '- kind: robot'));
    await s.app.handle(s.c, { type: 'previewRun', graphId: s.outer });
    expect(s.last('runPreview').preview.problems).toEqual([expect.stringMatching(/^Step n1 uses graph "Company research", whose file has errors: line \d+: kind is "robot"; use agent, command, graph, condition or stop\.$/)]);
  });

  it('refuses Start when the inner graph changed since the review (Review Focus 1)', async () => {
    const s = setup();
    await s.app.handle(s.c, { type: 'setVariableValue', graphId: s.outer, name: 'n1/depth', value: 'quick' });
    await s.app.handle(s.c, { type: 'previewRun', graphId: s.outer });
    const reviewed = s.last('runPreview').preview.signature;
    s.store.apply(s.inner, { type: 'updateNode', id: 'n1', patch: { prompt: 'Find it all.' } }, 'user');
    await s.app.handle(s.c, { type: 'startRun', graphId: s.outer, reviewed });
    expect(s.last('error').message).toBe(CHANGED_SINCE_REVIEW);
    expect(s.app.runStore.list(s.outer)).toEqual([]);
  });

  it('refuses Start when an attachment was added to the inner graph since the review', async () => {
    const s = setup();
    await s.app.handle(s.c, { type: 'setVariableValue', graphId: s.outer, name: 'n1/depth', value: 'quick' });
    await s.app.handle(s.c, { type: 'previewRun', graphId: s.outer });
    const reviewed = s.last('runPreview').preview.signature;
    s.store.apply(s.inner, { type: 'setGraphAttachments', names: ['brief.md'] }, 'user');
    await s.app.handle(s.c, { type: 'startRun', graphId: s.outer, reviewed });
    expect(s.last('error').message).toBe(CHANGED_SINCE_REVIEW);
    expect(s.app.runStore.list(s.outer)).toEqual([]);
  });
});
