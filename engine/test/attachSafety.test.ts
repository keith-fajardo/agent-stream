import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { ServerMessage } from '@agent-stream/shared';
import { createApp } from '../src/app';
import { AttachmentStore } from '../src/attachmentStore';
import { GraphStore } from '../src/graphStore';
import { UndoStacks } from '../src/undoStacks';
import { appTestDeps, fixedClock, signedIn, testGitBash, testProvider, tmpProject, tmpValuesFile } from './helpers';

/** Whether this machine lets a test make a symlink (a Windows runner may not have the privilege). */
const canLink = (() => {
  const d = mkdtempSync(join(tmpdir(), 'linkprobe-'));
  try {
    symlinkSync(d, join(d, 'l'));
    return true;
  } catch {
    return false;
  }
})();

const bytes = (t: string) => new TextEncoder().encode(t);
const b64 = (t: string) => Buffer.from(t).toString('base64');
const outside = () => mkdtempSync(join(tmpdir(), 'cs-outside-'));

function appSetup() {
  const paths = tmpProject();
  const app = createApp({ ...appTestDeps(), projectDir: paths.root, valuesFile: tmpValuesFile(), provider: testProvider(), status: signedIn, maxParallel: 1, gitBash: testGitBash });
  const graphId = app.graphStore.create('G').id;
  app.graphStore.apply(graphId, { type: 'addNode', node: { id: 'n1', title: 'Design', kind: 'agent', prompt: 'p' } }, 'user');
  const msgs: ServerMessage[] = [];
  const c = { send: (m: ServerMessage) => void msgs.push(m) };
  app.connect(c);
  const attach = (target: { kind: 'graph' } | { kind: 'step'; nodeId: string }, ...files: [string, string][]) =>
    app.handle(c, { type: 'attach', graphId, target, files: files.map(([name, t]) => ({ name, data: b64(t) })) });
  return { app, graphId, c, msgs, attach, paths, graph: () => app.graphStore.get(graphId) };
}

describe('F1: still referenced compares names like the file system (any letter case)', () => {
  it('Remove keeps a file a case-variant name in another list still uses; undo of an Add too', async () => {
    const s = appSetup();
    await s.attach({ kind: 'step', nodeId: 'n1' }, ['Mockup.png', 'png']);
    s.app.graphStore.apply(s.graphId, { type: 'setGraphAttachments', names: ['mockup.png'] }, 'user');
    await s.app.handle(s.c, { type: 'detach', graphId: s.graphId, target: { kind: 'graph' }, name: 'mockup.png' });
    expect(s.app.attachments.exists(s.graphId, 'Mockup.png')).toBe(true);
    await s.app.handle(s.c, { type: 'undo', graphId: s.graphId });
    // the undo of the Remove restored nothing deleted; the step still uses its file
    expect(s.app.attachments.exists(s.graphId, 'Mockup.png')).toBe(true);
  });
  it('F4: a name in the agent-change baseline counts as in use', async () => {
    const s = appSetup();
    await s.attach({ kind: 'step', nodeId: 'n1' }, ['a.md', 'x']);
    s.app.graphStore.apply(s.graphId, { type: 'updateNode', id: 'n1', patch: { attachments: [] } }, 'agent');
    expect(s.app.graphStore.baseline(s.graphId)).toMatchObject({ ok: true });
    s.app.graphStore.apply(s.graphId, { type: 'setGraphAttachments', names: ['a.md'] }, 'user');
    await s.app.handle(s.c, { type: 'detach', graphId: s.graphId, target: { kind: 'graph' }, name: 'a.md' });
    expect(s.app.attachments.exists(s.graphId, 'a.md')).toBe(true);
  });
});

describe('F2: the store refuses unsafe names and ids', () => {
  it('never leaves the graph folder', () => {
    const paths = tmpProject();
    const store = new AttachmentStore(paths);
    store.add('g', [{ name: 'ok.md', bytes: bytes('x') }]);
    const target = join(paths.dataDir, 'x.png');
    writeFileSync(target, 'keep');
    for (const name of ['../x.png', '/etc/x.png', 'a\\b.png', '..']) {
      expect(() => store.path('g', name)).toThrow();
      expect(store.exists('g', name)).toBe(false);
      expect(store.read('g', name)).toBeUndefined();
      expect(store.hash('g', name)).toBeUndefined();
      store.remove('g', name);
      store.restore('g', { name, bytes: bytes('bad') });
    }
    expect(readFileSync(target, 'utf8')).toBe('keep');
    expect(() => store.dir('../g')).toThrow();
    expect(store.add('../g', [{ name: 'a.md', bytes: bytes('x') }])).toMatchObject({ ok: false });
    expect(store.exists('../g', 'ok.md')).toBe(false);
    expect(store.names('../g')).toEqual([]);
  });
});

describe('F3: symlinks', () => {
  it.skipIf(!canLink)('refuses to write or delete through a symlinked attachments folder or graph folder', () => {
    const paths = tmpProject();
    const out = outside();
    writeFileSync(join(out, 'a.md'), 'precious');
    symlinkSync(out, paths.attachmentsDir);
    const store = new AttachmentStore(paths);
    expect(store.add('g', [{ name: 'a.md', bytes: bytes('x') }])).toEqual({ ok: false, error: expect.stringContaining('is a link to somewhere else') });
    store.remove('g', 'a.md');
    expect(existsSync(join(out, 'g'))).toBe(false);
    const paths2 = tmpProject();
    mkdirSync(paths2.attachmentsDir, { recursive: true });
    const out2 = outside();
    writeFileSync(join(out2, 'a.md'), 'precious');
    symlinkSync(out2, join(paths2.attachmentsDir, 'g'));
    const s2 = new AttachmentStore(paths2);
    expect(s2.add('g', [{ name: 'b.md', bytes: bytes('x') }])).toMatchObject({ ok: false });
    s2.remove('g', 'a.md');
    expect(readFileSync(join(out2, 'a.md'), 'utf8')).toBe('precious');
    expect(s2.exists('g', 'a.md')).toBe(false);
    expect(s2.read('g', 'a.md')).toBeUndefined();
    expect(s2.names('g')).toEqual([]);
    expect(s2.problem('g')).toContain('is a link to somewhere else');
  });
  it.skipIf(!canLink)('a symlinked file counts as missing and unreadable', () => {
    const paths = tmpProject();
    const store = new AttachmentStore(paths);
    store.add('g', [{ name: 'ok.md', bytes: bytes('x') }]);
    const out = outside();
    writeFileSync(join(out, 'secret.txt'), 'secret');
    symlinkSync(join(out, 'secret.txt'), join(store.dir('g'), 'link.txt'));
    expect(store.exists('g', 'link.txt')).toBe(false);
    expect(store.read('g', 'link.txt')).toBeUndefined();
    expect(store.hash('g', 'link.txt')).toBeUndefined();
    expect(store.names('g')).toEqual(['ok.md']);
  });
  it.skipIf(!canLink)('duplicate refuses a symlinked source folder; delete removes only a link', () => {
    const paths = tmpProject();
    const graphs = new GraphStore(paths, fixedClock());
    const { id } = graphs.create('Shots');
    const out = outside();
    writeFileSync(join(out, 'x.md'), 'precious');
    mkdirSync(paths.attachmentsDir, { recursive: true });
    symlinkSync(out, join(paths.attachmentsDir, id));
    const r = graphs.duplicate(id);
    expect(r).toMatchObject({ ok: false });
    expect(graphs.list().map((g) => g.name)).toEqual(['Shots']);
    expect(graphs.delete(id)).toEqual({ ok: true });
    expect(readFileSync(join(out, 'x.md'), 'utf8')).toBe('precious');
  });
  it('duplicate replaces a stale destination folder', () => {
    const paths = tmpProject();
    const graphs = new GraphStore(paths, fixedClock());
    // a stale folder where the copy will go is cleared, not merged into
    const files = new AttachmentStore(paths);
    const g2 = graphs.create('Two').id;
    files.add(g2, [{ name: 'a.md', bytes: bytes('a') }]);
    mkdirSync(join(paths.attachmentsDir, 'two-copy'), { recursive: true });
    writeFileSync(join(paths.attachmentsDir, 'two-copy', 'stale.md'), 'stale');
    const copy = graphs.duplicate(g2);
    if (!copy.ok) throw new Error(copy.error);
    expect(copy.graph.id).toBe('two-copy');
    expect(files.names('two-copy')).toEqual(['a.md']);
  });
});

describe('F5: undo keeps at most a capped number of file bytes', () => {
  it('drops the oldest entries that hold bytes, and what came before them', () => {
    const stacks = new UndoStacks(100);
    const tab = {};
    const g = (n: string) => ({ id: 'g', name: n, goal: n, instructions: '', variables: [], nodes: [], edges: [], createdAt: 0, updatedAt: 0 }) as never;
    const entry = (label: string, size: number) => ({ before: g(label + 'b'), after: g(label + 'a'), label, ops: [], ...(size && { files: { deleted: [{ name: 'f.md', bytes: new Uint8Array(size) }] } }) });
    stacks.record(tab, 'g', entry('one', 60));
    stacks.record(tab, 'g', entry('two', 0));
    stacks.record(tab, 'g', entry('three', 60));
    expect(stacks.top(tab, 'g')?.label).toBe('three');
    stacks.pop(tab, 'g');
    expect(stacks.top(tab, 'g')?.label).toBe('two');
    stacks.pop(tab, 'g');
    expect(stacks.top(tab, 'g')).toBeUndefined();
  });
});

describe('F6: a failed Add removes the files it wrote', () => {
  it('store: a write that throws removes the earlier files of the batch', () => {
    const paths = tmpProject();
    const store = new AttachmentStore(paths);
    store.add('g', [{ name: 'seed.md', bytes: bytes('x') }]);
    mkdirSync(join(store.dir('g'), 'b.md'));
    expect(store.add('g', [{ name: 'a.md', bytes: bytes('1') }, { name: 'b.md', bytes: bytes('2') }])).toMatchObject({ ok: false });
    expect(store.names('g')).toEqual(['seed.md']);
  });
  it('app: graphStore.apply throwing removes the files', async () => {
    const s = appSetup();
    vi.spyOn(s.app.graphStore, 'apply').mockImplementation(() => {
      throw new Error('disk full');
    });
    await expect(s.attach({ kind: 'graph' }, ['a.md', 'x'])).rejects.toThrow('disk full');
    expect(s.app.attachments.names(s.graphId)).toEqual([]);
  });
});
