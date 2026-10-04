import { describe, expect, it, vi } from 'vitest';

const writes: string[] = [];
vi.mock('../src/fsutil', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/fsutil')>();
  return { ...real, writeFileAtomic: (path: string, data: string, mode?: number) => (writes.push(path), real.writeFileAtomic(path, data, mode)) };
});
const { GraphStore } = await import('../src/graphStore');
const { fixedClock, tmpProject } = await import('./helpers');

describe('graph file writes', () => {
  it('write the side file first, then the Markdown, each through a temp file', () => {
    const store = new GraphStore(tmpProject(), fixedClock());
    const { id } = store.create('G');
    writes.length = 0;
    store.apply(id, { type: 'addNode', node: { title: 'A', kind: 'agent', prompt: 'p' } }, 'user');
    expect(writes.map((p) => p.slice(p.lastIndexOf(id)))).toEqual([`${id}.meta.json`, `${id}.md`]);
    writes.length = 0;
    store.apply(id, { type: 'moveNode', id: 'n1', position: { x: 1, y: 2 } }, 'user');
    expect(writes.map((p) => p.slice(p.lastIndexOf(id)))).toEqual([`${id}.meta.json`]);
  });
});
