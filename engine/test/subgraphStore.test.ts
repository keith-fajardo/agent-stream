import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app';
import { GraphStore } from '../src/graphStore';
import { appTestDeps, fixedClock, signedIn, testGitBash, testProvider, tmpProject, tmpValuesFile } from './helpers';

const FENCE = '```';

describe('a sub-graph step in a graph file', () => {
  it('loads, saves and reads back through the store', () => {
    const paths = tmpProject();
    const store = new GraphStore(paths, fixedClock());
    const { id } = store.create('Job hunting');
    const r = store.apply(id, { type: 'addNode', node: { title: 'Research the target company', kind: 'graph', graph: 'company-research', values: { company: 'Acme' } } }, 'user');
    expect(r.ok).toBe(true);
    const fresh = new GraphStore(paths, fixedClock());
    expect(fresh.get(id).nodes[0]).toMatchObject({ kind: 'graph', graph: 'company-research', values: { company: 'Acme' } });
  });

  it('drops an agent field from it, writes the file back without the line, and logs the warning', () => {
    const paths = tmpProject();
    const file = join(paths.graphsDir, 'g.md');
    writeFileSync(file, ['# G', '', '## n1 · S', '', '- kind: graph', '- graph: company-research', '- model: claude/opus', ''].join('\n'));
    const log = vi.fn();
    const app = createApp({ ...appTestDeps(), projectDir: paths.root, valuesFile: tmpValuesFile(), provider: testProvider(), status: signedIn, maxParallel: 1, gitBash: testGitBash, log });
    const r = app.graphStore.load('g');
    expect(r.ok && r.graph.nodes[0]).toMatchObject({ kind: 'graph', graph: 'company-research' });
    expect(log).toHaveBeenCalledWith("g.md line 7: step n1 is a sub-graph step, so it can't have model. Agent Stream removed this line.");
    expect(readFileSync(file, 'utf8')).not.toContain('model');
  });

  it('a Revert of an agent change puts its graph and values back', () => {
    const store = new GraphStore(tmpProject(), fixedClock());
    const { id } = store.create('J');
    store.apply(id, { type: 'addNode', node: { id: 'n1', title: 'S', kind: 'graph', graph: 'company-research', values: { company: 'Acme' } } }, 'user');
    store.apply(id, { type: 'updateNode', id: 'n1', patch: { graph: 'tailor-cv', values: {} } }, 'agent', { kind: 'planner' });
    expect(store.get(id).nodes[0]).not.toHaveProperty('values');
    expect(store.apply(id, { type: 'revertChange', target: { kind: 'node', id: 'n1' } }, 'user').ok).toBe(true);
    expect(store.get(id).nodes[0]).toMatchObject({ graph: 'company-research', values: { company: 'Acme' } });
  });

  it('a value block in a hand edit reaches the graph', () => {
    const paths = tmpProject();
    const store = new GraphStore(paths, fixedClock());
    const { id } = store.create('J');
    store.apply(id, { type: 'addNode', node: { id: 'n1', title: 'S', kind: 'graph', graph: 'company-research' } }, 'user');
    const file = join(paths.graphsDir, `${id}.md`);
    writeFileSync(file, `${readFileSync(file, 'utf8')}\n${FENCE}value company\nAcme\n${FENCE}\n`);
    expect(store.graphFileChanged(id)).toBe('applied');
    expect(store.get(id).nodes[0].values).toEqual({ company: 'Acme' });
  });
});
