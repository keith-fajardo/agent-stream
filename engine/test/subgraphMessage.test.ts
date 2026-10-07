import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ServerMessage } from '@agent-stream/shared';
import { createApp } from '../src/app';
import { appTestDeps, signedIn, testGitBash, testProvider, tmpProject, tmpValuesFile } from './helpers';

function setup() {
  const paths = tmpProject();
  const app = createApp({ ...appTestDeps(), projectDir: paths.root, valuesFile: tmpValuesFile(), provider: testProvider(), status: signedIn, maxParallel: 1, gitBash: testGitBash });
  const msgs: ServerMessage[] = [];
  const c = { send: (m: ServerMessage) => void msgs.push(structuredClone(m)) };
  app.connect(c);
  const s = app.graphStore;
  const deep = s.create('Deep').id;
  s.apply(deep, { type: 'addNode', node: { title: 'Dig', kind: 'agent', prompt: 'dig' } }, 'user');
  const research = s.create('Company research').id;
  s.apply(research, { type: 'addNode', node: { title: 'Deeper', kind: 'graph', graph: deep } }, 'user');
  const hunting = s.create('Job hunting').id;
  s.apply(hunting, { type: 'addNode', node: { title: 'Research', kind: 'graph', graph: research } }, 'user');
  const subgraphs = () => msgs.filter((m): m is Extract<ServerMessage, { type: 'subgraphs' }> => m.type === 'subgraphs');
  return { app, c, paths, deep, research, hunting, subgraphs, msgs };
}

describe('the subgraphs message (spec §6.3)', () => {
  it('follows openGraph with every graph reachable through sub-graph steps, transitively, with their reviews', async () => {
    const t = setup();
    await t.app.handle(t.c, { type: 'openGraph', graphId: t.hunting });
    const types = t.msgs.map((m) => m.type);
    expect(types.indexOf('subgraphs')).toBe(types.indexOf('graphOpened') + 1);
    const m = t.subgraphs().at(-1)!;
    expect(m.graphId).toBe(t.hunting);
    expect(Object.keys(m.graphs).sort()).toEqual([t.research, t.deep].sort());
    expect(m.reviews[t.research]).toEqual({ changes: [] });
  });

  it('is not sent for a graph without sub-graph steps', async () => {
    const t = setup();
    await t.app.handle(t.c, { type: 'openGraph', graphId: t.deep });
    expect(t.subgraphs()).toEqual([]);
  });

  it('is sent again when an inner graph changes, breaks or goes, and when a sub-graph step points elsewhere', async () => {
    const t = setup();
    await t.app.handle(t.c, { type: 'openGraph', graphId: t.hunting });
    const count = () => t.subgraphs().length;
    const before = count();
    t.app.graphStore.apply(t.deep, { type: 'addNode', node: { title: 'More', kind: 'agent', prompt: 'more' } }, 'user');
    expect(count()).toBe(before + 1);
    const deep = t.subgraphs().at(-1)!.graphs[t.deep];
    expect('nodes' in deep && deep.nodes.map((n) => n.title)).toEqual(['Dig', 'More']);
    // An unrelated graph changing sends nothing.
    const other = t.app.graphStore.create('Other').id;
    t.app.graphStore.apply(other, { type: 'setGoal', goal: 'x' }, 'user');
    expect(count()).toBe(before + 1);
    const file = join(t.paths.graphsDir, `${t.deep}.md`);
    writeFileSync(file, readFileSync(file, 'utf8').replace('- kind: agent', '- kind: robot'));
    t.app.graphFileChanged(t.deep);
    expect(t.subgraphs().at(-1)!.graphs[t.deep]).toEqual({ error: expect.stringMatching(/^line \d+: kind is "robot"/), reason: 'broken', name: 'Deep' });
    rmSync(file);
    t.app.graphFileDeleted(t.deep);
    expect(t.subgraphs().at(-1)!.graphs[t.deep]).toEqual({ error: `graph "${t.deep}" not found`, reason: 'missing' });
    t.app.graphStore.apply(t.hunting, { type: 'updateNode', id: 'n1', patch: { graph: other } }, 'user');
    expect(Object.keys(t.subgraphs().at(-1)!.graphs)).toEqual([other]);
  });

  it('lists each graph’s step count for the picker', () => {
    const t = setup();
    const byId = new Map(t.app.listGraphs().map((g) => [g.id, g]));
    expect(byId.get(t.deep)?.steps).toBe(1);
    expect(t.app.graphStore.create('Empty') && t.app.listGraphs().find((g) => g.name === 'Empty')).not.toHaveProperty('steps');
  });
});
