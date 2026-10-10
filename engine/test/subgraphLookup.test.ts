import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app';
import { GraphStore } from '../src/graphStore';
import { appTestDeps, fixedClock, signedIn, testGitBash, testProvider, tmpProject, tmpValuesFile } from './helpers';

function storeWithResearch() {
  const paths = tmpProject();
  const store = new GraphStore(paths, fixedClock());
  const research = store.create('Company research');
  store.apply(research.id, { type: 'addNode', node: { title: 'Find site', kind: 'agent', prompt: 'Find it.' } }, 'user');
  return { paths, store, id: research.id, file: join(paths.graphsDir, `${research.id}.md`) };
}

describe('GraphStore.lookup: the inner graph of a sub-graph step', () => {
  it('finds a graph whose file reads', () => {
    const { store, id } = storeWithResearch();
    const r = store.lookup(id);
    expect(r.ok && r.graph.nodes.map((n) => n.title)).toEqual(['Find site']);
  });

  it('reports a missing graph without the side effects of a deleted file', () => {
    const { store, id, file } = storeWithResearch();
    const deleted = vi.fn();
    store.on('fileDeleted', deleted);
    rmSync(file);
    expect(store.lookup(id)).toEqual({ ok: false, reason: 'missing', error: `graph "${id}" not found` });
    expect(store.lookup('Not An Id')).toEqual({ ok: false, reason: 'missing', error: 'graph "Not An Id" not found' });
    expect(deleted).not.toHaveBeenCalled();
  });

  it('reports a graph whose file has errors as broken, with its first error and last good name, never its last good version', () => {
    const { store, id, file } = storeWithResearch();
    writeFileSync(file, readFileSync(file, 'utf8').replace('- kind: agent', '- kind: robot'));
    const r = store.lookup(id);
    expect(r).toEqual({ ok: false, reason: 'broken', error: expect.stringMatching(/^line \d+: kind is "robot"; use agent, command, graph, condition or stop\.$/), name: 'Company research' });
    // load still gives the last good graph for the tab that shows it; only a sub-graph step refuses it.
    expect(store.load(id).ok).toBe(true);
  });

  it('reports a file that never read as broken, by id', () => {
    const paths = tmpProject();
    writeFileSync(join(paths.graphsDir, 'bad.md'), '# Bad\n\n## n1 · A\n\n- kind: robot\n');
    expect(new GraphStore(paths, fixedClock()).lookup('bad')).toEqual({ ok: false, reason: 'broken', error: expect.stringMatching(/^line \d+: /) });
  });
});

describe('GraphStore.list: a graph whose file has errors now', () => {
  it('carries broken (not error), keeps its last good name, and is clear again once the file reads', () => {
    const { store, id, file } = storeWithResearch();
    const good = readFileSync(file, 'utf8');
    expect(store.list().find((g) => g.id === id)).not.toHaveProperty('broken');
    writeFileSync(file, good.replace('- kind: agent', '- kind: robot'));
    // load() still gives the last good version, but the list must not offer the graph as a sub-graph (spec §6.2).
    expect(store.load(id).ok).toBe(true);
    expect(store.list().find((g) => g.id === id)).toMatchObject({ id, name: 'Company research', broken: expect.stringMatching(/kind is "robot"; use agent, command, graph, condition or stop\./) });
    // `error` still means never readable: the sidebar, chat and pickers keep working with the last good version.
    expect(store.list().find((g) => g.id === id)).not.toHaveProperty('error');
    writeFileSync(file, good);
    store.load(id);
    expect(store.list().find((g) => g.id === id)).not.toHaveProperty('broken');
  });
});

describe('GraphListItem.usedBy', () => {
  it('lists the graphs with a sub-graph step pointing at each graph', () => {
    const paths = tmpProject();
    const app = createApp({ ...appTestDeps(), projectDir: paths.root, valuesFile: tmpValuesFile(), provider: testProvider(), status: signedIn, maxParallel: 1, gitBash: testGitBash });
    const research = app.graphStore.create('Company research').id;
    const hunting = app.graphStore.create('Job hunting').id;
    const weekly = app.graphStore.create('Weekly report').id;
    for (const g of [hunting, weekly]) app.graphStore.apply(g, { type: 'addNode', node: { title: 'Research', kind: 'graph', graph: research } }, 'user');
    const byId = new Map(app.listGraphs().map((g) => [g.id, g]));
    expect(byId.get(research)?.usedBy).toEqual([hunting, weekly]);
    expect(byId.get(hunting)).not.toHaveProperty('usedBy');
  });
});
