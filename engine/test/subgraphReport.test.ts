import { describe, expect, it } from 'vitest';
import { applyOp, emptyGraph, expandGraph, type Graph, type GraphLookup, type Op, type RunMeta } from '@agent-stream/shared';
import { buildRunReport } from '../src/runReport';

const graphOf = (id: string, name: string, ops: Op[]): Graph =>
  ops.reduce((g, op) => {
    const r = applyOp(g, op, 'user', 't');
    if (!r.ok) throw new Error(r.error);
    return r.graph;
  }, emptyGraph(id, name, 't'));
const research = graphOf('company-research', 'Company research', [
  { type: 'setGoal', goal: 'Know {{ company }}.' },
  { type: 'setGraphAttachments', names: ['brief.md'] },
  { type: 'addNode', node: { title: 'Find site', kind: 'agent', prompt: 'find' } },
  { type: 'addNode', node: { title: 'Read news', kind: 'agent', prompt: 'read' } },
  { type: 'connect', from: 'n1', to: 'n2' },
]);
const hunting = graphOf('job-hunting', 'Job hunting', [
  { type: 'setGoal', goal: 'Get a job.' },
  { type: 'addNode', node: { title: 'Research the target company', kind: 'graph', graph: 'company-research', values: { company: 'Acme' } } },
  { type: 'addNode', node: { title: 'Letter', kind: 'agent', prompt: 'write' } },
  { type: 'connect', from: 'n1', to: 'n2' },
]);
const lookup: GraphLookup = (id) => (id === research.id ? { ok: true, graph: research } : { ok: false, reason: 'missing', error: 'missing' });
const expanded = expandGraph(hunting, lookup);
if (!expanded.ok) throw new Error('expected an expansion');

const run: RunMeta = {
  id: '20261007-100000-abcd',
  graphId: 'job-hunting',
  status: 'failed',
  startedAt: '2026-10-07T10:00:00.000Z',
  endedAt: '2026-10-07T10:01:00.000Z',
  snapshot: expanded.graph,
  scopes: expanded.scopes,
  nodes: { n1: { status: 'not_run' }, 'n1/n1': { status: 'succeeded' }, 'n1/n2': { status: 'failed', error: 'boom' }, n2: { status: 'not_run' } },
  rendered: { goal: 'Get a job.', instructions: '', nodes: { n1: '', 'n1/n1': 'find', 'n1/n2': 'read', n2: 'write' }, scopes: { n1: { goal: 'Know Acme.', instructions: '' } } },
  attachments: [{ name: 'brief.md', sha256: 'abc123', graphId: 'company-research' }],
};
const report = buildRunReport({ graphName: 'Job hunting', run, steps: { n1: { events: [], output: '' } }, now: 't' });

describe('the Run Report of a run with a sub-graph step (spec §5)', () => {
  it('keeps the outer goal, and lists inner steps under their sub-graph step in the plan', () => {
    expect(report).toContain('## Goal\n\n```\nGet a job.\n```');
    expect(report).toContain(
      ['1. n1 · Research the target company (sub-graph "Company research") — after n1/n2', '   2. n1/n1 · Find site (agent)', '   3. n1/n2 · Read news (agent) — after n1/n1', '4. n2 · Letter (agent) — after n1'].join('\n'),
    );
  });

  it('heads the sub-graph step with its derived status and its inner graph’s goal, and its inner steps one level deeper', () => {
    const headings = report.split('\n').filter((l) => /^#{3,} /.test(l));
    expect(headings).toEqual(['### n1 · Research the target company — Failed', '#### n1/n1 · Find site (Company research) — Succeeded', '#### n1/n2 · Read news (Company research) — Failed', '### n2 · Letter — Not run']);
    expect(report).toContain('### n1 · Research the target company — Failed\n\n**Goal of Company research**\n\n```\nKnow Acme.\n```');
  });

  it('lists an inner step’s attachments from its scope graph', () => {
    expect(report).toContain('#### n1/n1 · Find site (Company research) — Succeeded\n\n**Attachments**\n\n- brief.md · sha256 abc123');
  });
});
