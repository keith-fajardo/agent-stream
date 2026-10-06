import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AttachmentStore } from '../src/attachmentStore';
import { GraphStore } from '../src/graphStore';
import { fixedClock, tmpProject } from './helpers';

const bytes = (text: string) => new TextEncoder().encode(text);

describe('AttachmentStore (step model spec §6b.2)', () => {
  it('copies files into .agent-stream/attachments/<graph id>/ under their own names made safe', () => {
    const paths = tmpProject();
    const store = new AttachmentStore(paths);
    const r = store.add('g', [{ name: '/Users/me/My Mockup (v2).png', bytes: bytes('png') }, { name: 'C:\\notes\\spec.md', bytes: bytes('# Spec') }]);
    expect(r).toEqual({ ok: true, names: ['My Mockup _v2_.png', 'spec.md'], firstInFolder: true });
    expect(readFileSync(join(paths.dataDir, 'attachments', 'g', 'spec.md'), 'utf8')).toBe('# Spec');
    expect(store.names('g').sort()).toEqual(['My Mockup _v2_.png', 'spec.md']);
    expect(store.add('g', [{ name: 'other.md', bytes: bytes('x') }])).toMatchObject({ ok: true, firstInFolder: false });
  });

  it('gives a clash -2, -3: with files there, names the graph uses, and the same batch', () => {
    const store = new AttachmentStore(tmpProject());
    store.add('g', [{ name: 'mockup.png', bytes: bytes('1') }]);
    const r = store.add('g', [{ name: 'Mockup.png', bytes: bytes('2') }, { name: 'mockup.png', bytes: bytes('3') }, { name: 'brief.pdf', bytes: bytes('4') }], ['brief.pdf']);
    expect(r).toMatchObject({ ok: true, names: ['Mockup-2.png', 'mockup-3.png', 'brief-2.pdf'] });
  });

  it('refuses a type it doesn’t take or a file over the limit, and then writes none of the batch', () => {
    const paths = tmpProject();
    const store = new AttachmentStore(paths);
    expect(store.add('g', [{ name: 'ok.md', bytes: bytes('x') }, { name: 'tool.exe', bytes: bytes('MZ') }])).toEqual({ ok: false, error: expect.stringContaining("tool.exe can't be attached.") });
    expect(store.add('g', [{ name: 'huge.pdf', bytes: new Uint8Array(5 * 1024 * 1024 + 1) }])).toEqual({ ok: false, error: 'huge.pdf is larger than 5 MB.' });
    expect(existsSync(join(paths.dataDir, 'attachments', 'g'))).toBe(false);
  });

  it('hashes a file, says when one is missing, removes and restores', () => {
    const store = new AttachmentStore(tmpProject());
    store.add('g', [{ name: 'a.txt', bytes: bytes('abc') }]);
    expect(store.hash('g', 'a.txt')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(store.hash('g', 'gone.txt')).toBeUndefined();
    const saved = store.read('g', 'a.txt')!;
    store.remove('g', 'a.txt');
    expect(store.exists('g', 'a.txt')).toBe(false);
    store.restore('g', { name: 'a.txt', bytes: saved });
    expect(store.hash('g', 'a.txt')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('a graph’s delete removes its folder, and its duplicate copies it', () => {
    const paths = tmpProject();
    const graphs = new GraphStore(paths, fixedClock());
    const files = new AttachmentStore(paths);
    const { id } = graphs.create('Shots');
    files.add(id, [{ name: 'a.png', bytes: bytes('png') }]);
    const copy = graphs.duplicate(id);
    if (!copy.ok) throw new Error(copy.error);
    expect(files.names(copy.graph.id)).toEqual(['a.png']);
    writeFileSync(files.path(copy.graph.id, 'a.png'), 'changed');
    expect(readFileSync(files.path(id, 'a.png'), 'utf8')).toBe('png');
    expect(graphs.delete(id)).toEqual({ ok: true });
    expect(existsSync(files.dir(id))).toBe(false);
    expect(files.names(copy.graph.id)).toEqual(['a.png']);
  });
});
