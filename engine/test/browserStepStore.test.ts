import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app';
import { GraphStore } from '../src/graphStore';
import { appTestDeps, fixedClock, signedIn, testGitBash, testProvider, tmpProject, tmpValuesFile } from './helpers';

const FENCE = '```';

describe('a browser line on a command step in a graph file', () => {
  it('is removed from the file, and the warning goes to the output channel', () => {
    const paths = tmpProject();
    const file = join(paths.graphsDir, 'g.md');
    writeFileSync(file, ['# G', '', '## n1 · List', '', '- kind: command', '- browser: on', '', `${FENCE}sh`, 'ls', FENCE, ''].join('\n'));
    const log = vi.fn();
    const app = createApp({ ...appTestDeps(), projectDir: paths.root, valuesFile: tmpValuesFile(), provider: testProvider(), status: signedIn, maxParallel: 1, gitBash: testGitBash, log });
    const r = app.graphStore.load('g');
    expect(r.ok && r.graph.nodes[0]).not.toHaveProperty('browser');
    expect(log).toHaveBeenCalledWith("g.md line 6: step n1 is a command step, so it can't use the browser. Agent Stream removed this line.");
    expect(readFileSync(file, 'utf8')).not.toContain('browser');
  });
});

describe('reverting an agent change to the browser setting', () => {
  it('puts the step back as it was', () => {
    const store = new GraphStore(tmpProject(), fixedClock());
    const { id } = store.create('B');
    store.apply(id, { type: 'addNode', node: { id: 'n1', title: 'a', kind: 'agent', prompt: 'p' } }, 'user');
    store.apply(id, { type: 'updateNode', id: 'n1', patch: { browser: true } }, 'agent', { kind: 'planner' });
    expect(store.get(id).nodes[0].browser).toBe(true);
    expect(store.apply(id, { type: 'revertChange', target: { kind: 'node', id: 'n1' } }, 'user').ok).toBe(true);
    expect(store.get(id).nodes[0]).not.toHaveProperty('browser');
    store.apply(id, { type: 'updateNode', id: 'n1', patch: { browser: true } }, 'user');
    store.apply(id, { type: 'updateNode', id: 'n1', patch: { browser: false } }, 'agent', { kind: 'planner' });
    expect(store.apply(id, { type: 'revertChange', target: { kind: 'node', id: 'n1' } }, 'user').ok).toBe(true);
    expect(store.get(id).nodes[0].browser).toBe(true);
  });
});
