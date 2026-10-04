import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { GraphStore } from '../src/graphStore';
import { fixedClock, tmpProject } from './helpers';

/** A store with one graph: n1 (agent) --> n2 (command), a goal and a variable, all made by the user. */
function setup() {
  const paths = tmpProject();
  const store = new GraphStore(paths, fixedClock());
  const { id } = store.create('Parity');
  store.apply(id, { type: 'setGoal', goal: 'Prove it.' }, 'user');
  store.apply(id, { type: 'addVariable', name: 'schema', description: 'Where' }, 'user');
  store.apply(id, { type: 'addNode', node: { title: 'Plan', kind: 'agent', prompt: 'Plan it.' } }, 'user');
  store.apply(id, { type: 'addNode', node: { title: 'Build', kind: 'command', command: 'make' } }, 'user');
  store.apply(id, { type: 'connect', from: 'n1', to: 'n2' }, 'user');
  const md = join(paths.graphsDir, `${id}.md`);
  const meta = join(paths.graphsDir, `${id}.meta.json`);
  const text = () => readFileSync(md, 'utf8');
  /** Edits the Markdown file as another editor would. */
  const edit = (from: string, to: string) => {
    const before = text();
    if (!before.includes(from)) throw new Error(`not in the file: ${from}`);
    writeFileSync(md, before.replace(from, to));
  };
  const changed = vi.fn();
  const ops = vi.fn();
  const fileErrors = vi.fn();
  store.on('changed', changed);
  store.on('op', ops);
  store.on('fileErrors', fileErrors);
  return { paths, store, id, md, meta, text, edit, changed, ops, fileErrors };
}

describe('graphFileChanged', () => {
  it("ignores the store's own saves", () => {
    const { store, id, changed } = setup();
    const before = store.readOps(id).length;
    expect(store.graphFileChanged(id)).toBe('unchanged');
    store.apply(id, { type: 'setGoal', goal: 'Again.' }, 'user');
    changed.mockClear();
    expect(store.graphFileChanged(id)).toBe('unchanged');
    expect(changed).not.toHaveBeenCalled();
    expect(store.readOps(id)).toHaveLength(before + 1);
  });

  it('applies an outside edit as user operations recorded via the file', () => {
    const { store, id, md, text, edit, changed, ops } = setup();
    edit('Plan it.', 'Plan it well.');
    edit('  n1["Plan"] --> n2["Build"]', '  n1["Plan"] --> n2["Build"]\n  n2 --> n3');
    edit('# Parity', '# Parity check');
    writeFileSync(md, `${text()}\n## n3 · Report\n\n\`\`\`prompt\nSum up.\n\`\`\`\n`);
    expect(store.graphFileChanged(id)).toBe('applied');
    const g = store.get(id);
    expect(g.name).toBe('Parity check');
    expect(g.nodes.map((n) => [n.id, n.prompt ?? n.command])).toEqual([
      ['n1', 'Plan it well.'],
      ['n2', 'make'],
      ['n3', 'Sum up.'],
    ]);
    expect(g.edges.map((e) => e.id)).toEqual(['n1->n2', 'n2->n3']);
    expect(store.readOps(id).slice(-3)).toEqual([
      { at: expect.any(String), by: 'user', op: { type: 'addNode', node: { id: 'n3', title: 'Report', kind: 'agent', prompt: 'Sum up.' } }, via: 'file' },
      { at: expect.any(String), by: 'user', op: { type: 'updateNode', id: 'n1', patch: { prompt: 'Plan it well.' } }, via: 'file' },
      { at: expect.any(String), by: 'user', op: { type: 'connect', from: 'n2', to: 'n3' }, via: 'file' },
    ]);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(ops.mock.calls.map(([, op]) => op.type)).toEqual(['addNode', 'updateNode', 'connect']);
  });

  it('gives a new step its id and writes the file back in canonical form, which it then ignores', () => {
    const { store, id, text, md } = setup();
    writeFileSync(md, `${text()}\n## Clean up\n- timeout: 5\n\`\`\`bash\nrm -rf tmp\n\`\`\`\n`);
    expect(store.graphFileChanged(id)).toBe('applied');
    expect(text()).toContain('## n3 · Clean up\n\n- kind: command\n- timeout: 5\n\n```sh\nrm -rf tmp\n```\n');
    expect(text()).toContain('  n3["Clean up"]\n```');
    expect(store.graphFileChanged(id)).toBe('unchanged');
  });

  it('keeps the graph and the file as they are when the file has errors, until it is fixed', () => {
    const { store, id, edit, text, fileErrors, changed } = setup();
    const good = store.get(id);
    edit('- kind: command', '- kind: robot');
    const broken = text();
    expect(store.graphFileChanged(id)).toBe('errors');
    expect(store.get(id)).toEqual(good);
    expect(text()).toBe(broken);
    expect(store.fileErrors(id)).toEqual([{ line: expect.any(Number), message: 'kind is "robot"; use agent or command.' }]);
    expect(fileErrors).toHaveBeenLastCalledWith(id, store.fileErrors(id));
    expect(changed).not.toHaveBeenCalled();
    // The canvas can't rewrite a file the user is still fixing; moving a step only touches the side file.
    expect(store.apply(id, { type: 'setGoal', goal: 'x' }, 'user')).toEqual({ ok: false, error: `The file ${id}.md has errors (line ${store.fileErrors(id)[0].line}: kind is "robot"; use agent or command.). Fix it first: until then this graph can't be changed here.` });
    expect(store.rename(id, 'Other').ok).toBe(false);
    expect(store.apply(id, { type: 'moveNode', id: 'n1', position: { x: 1, y: 1 } }, 'user').ok).toBe(true);
    expect(text()).toBe(broken);
    edit('- kind: robot', '- kind: command\n- timeout: 9');
    expect(store.graphFileChanged(id)).toBe('applied');
    expect(store.fileErrors(id)).toEqual([]);
    expect(fileErrors).toHaveBeenLastCalledWith(id, []);
    expect(store.get(id).nodes[1]).toMatchObject({ id: 'n2', timeoutSec: 9 });
    expect(store.get(id).nodes[0].position).toEqual({ x: 1, y: 1 });
  });

  it.each([
    ['with Windows line endings', (t: string) => t.replace(/\n/g, '\r\n')],
    ['formatted by hand', (t: string) => t.replace('## Goal\n\nProve it.', '## Goal\nProve it.')],
  ])('never writes over a broken hand edit when a step moves, in a file read fresh %s', (_how, reformat) => {
    const { paths, id, md, text } = setup();
    writeFileSync(md, reformat(text()));
    const store = new GraphStore(paths, fixedClock());
    expect(store.get(id).goal).toBe('Prove it.');
    const now = readFileSync(md, 'utf8');
    if (!now.includes('- kind: command')) throw new Error('no command step in the file');
    const broken = now.replace('- kind: command', '- kind: robot');
    writeFileSync(md, broken);
    expect(store.graphFileChanged(id)).toBe('errors');
    expect(store.apply(id, { type: 'moveNode', id: 'n1', position: { x: 5, y: 6 } }, 'user').ok).toBe(true);
    expect(readFileSync(md, 'utf8')).toBe(broken);
    expect(store.fileErrors(id)).toEqual([{ line: expect.any(Number), message: 'kind is "robot"; use agent or command.' }]);
    expect(store.load(id).ok).toBe(true);
    expect(store.graphFileChanged(id)).toBe('errors');
    expect(readFileSync(md, 'utf8')).toBe(broken);
    expect(store.fileErrors(id)).toHaveLength(1);
  });

  it('applies all of an edit or none of it', () => {
    const { store, id, edit, text } = setup();
    const before = store.readOps(id).length;
    edit('Prove it.', 'Prove it now.');
    edit('## n2 · Build\n\n- kind: command\n', `## n2 · Build\n\n- kind: command\n\n> ${'x'.repeat(2001)}\n`);
    const written = text();
    expect(store.graphFileChanged(id)).toBe('errors');
    expect(store.fileErrors(id)).toEqual([{ line: written.split('\n').indexOf('## n2 · Build') + 1, message: 'a description can be at most 2000 characters. Nothing from this edit was applied.' }]);
    expect(store.get(id).goal).toBe('Prove it.');
    expect(store.readOps(id)).toHaveLength(before);
    expect(text()).toBe(written);
  });

  it('follows the baseline rules of a canvas edit', () => {
    const { store, id, edit } = setup();
    store.apply(id, { type: 'updateNode', id: 'n2', patch: { command: 'make all' } }, 'agent', { kind: 'planner' });
    edit('Plan it.', 'Plan it by hand.');
    expect(store.graphFileChanged(id)).toBe('applied');
    const base = store.baseline(id);
    expect(base.ok && base.graph?.nodes[0].prompt).toBe('Plan it by hand.');
    expect(store.agentChanges(id)).toMatchObject([{ kind: 'node', change: 'changed', id: 'n2', fields: ['command'] }]);
    edit('make all', 'make');
    expect(store.graphFileChanged(id)).toBe('applied');
    expect(store.agentChanges(id)).toEqual([]);
    expect(store.baseline(id)).toEqual({ ok: true });
  });

  it('turns a renamed variable into a delete and an add', () => {
    const { store, id, edit } = setup();
    edit('- `schema`: Where', '- `target_schema`: Where');
    expect(store.graphFileChanged(id)).toBe('applied');
    expect(store.readOps(id).slice(-2).map((r) => r.op)).toEqual([
      { type: 'deleteVariable', name: 'schema' },
      { type: 'addVariable', name: 'target_schema', description: 'Where' },
    ]);
  });

  it('re-reads positions from a changed side file without recording operations', () => {
    const { store, id, meta, changed } = setup();
    const before = store.readOps(id).length;
    const file = JSON.parse(readFileSync(meta, 'utf8'));
    file.nodes.n2.position = { x: 70, y: 90 };
    writeFileSync(meta, JSON.stringify(file));
    expect(store.graphFileChanged(id)).toBe('meta');
    expect(store.get(id).nodes[1].position).toEqual({ x: 70, y: 90 });
    expect(store.readOps(id)).toHaveLength(before);
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it('notices an outside edit on load, before any watcher reports it', () => {
    const { store, id, edit } = setup();
    edit('Prove it.', 'Proved by hand.');
    expect(store.get(id).goal).toBe('Proved by hand.');
    expect(store.readOps(id).at(-1)).toMatchObject({ op: { type: 'setGoal', goal: 'Proved by hand.' }, via: 'file' });
    expect(store.graphFileChanged(id)).toBe('unchanged');
  });

  it('adds a graph whose file appears, giving its new steps ids', () => {
    const { paths, store } = setup();
    writeFileSync(join(paths.graphsDir, 'notes.md'), '# Notes\n\n## Say hi\n\n```sh\necho hi\n```\n');
    expect(store.graphFileChanged('notes')).toBe('added');
    expect(readFileSync(join(paths.graphsDir, 'notes.md'), 'utf8')).toContain('## n1 · Say hi');
    expect(store.list().map((g) => g.id)).toContain('notes');
  });

  it('gives id-less steps ids above those a later step in the same edit names', () => {
    const { store, id, text, md } = setup();
    writeFileSync(md, `${text()}\n## Clean up\n\n\`\`\`prompt\nTidy.\n\`\`\`\n\n## n3 · Report\n\n\`\`\`prompt\nSum up.\n\`\`\`\n`);
    expect(store.graphFileChanged(id)).toBe('applied');
    expect(store.get(id).nodes.map((n) => [n.id, n.title])).toEqual([['n1', 'Plan'], ['n2', 'Build'], ['n4', 'Clean up'], ['n3', 'Report']]);
    expect(text()).toContain('## n4 · Clean up');
  });

  it('takes a changed side file while the Markdown has errors, so a move keeps the outside positions', () => {
    const { store, id, meta, edit } = setup();
    edit('- kind: command', '- kind: robot');
    expect(store.graphFileChanged(id)).toBe('errors');
    const file = JSON.parse(readFileSync(meta, 'utf8'));
    file.nodes.n2.position = { x: 70, y: 90 };
    writeFileSync(meta, JSON.stringify(file));
    expect(store.graphFileChanged(id)).toBe('errors');
    expect(store.apply(id, { type: 'moveNode', id: 'n1', position: { x: 1, y: 1 } }, 'user').ok).toBe(true);
    expect(JSON.parse(readFileSync(meta, 'utf8')).nodes.n2.position).toEqual({ x: 70, y: 90 });
    expect(store.get(id).nodes[1].position).toEqual({ x: 70, y: 90 });
  });

  it('refuses reverts and agent edits while the file has errors; accept and duplicate still work', () => {
    const { store, id, edit } = setup();
    store.apply(id, { type: 'updateNode', id: 'n2', patch: { command: 'make all' } }, 'agent', { kind: 'planner' });
    edit('Plan it.', 'Plan it by hand.');
    edit('- kind: command', '- kind: robot');
    expect(store.graphFileChanged(id)).toBe('errors');
    const refused = expect.objectContaining({ ok: false, error: expect.stringContaining('has errors') });
    expect(store.apply(id, { type: 'revertChange', target: { kind: 'all' } }, 'user')).toEqual(refused);
    expect(store.apply(id, { type: 'addNode', node: { title: 'X', kind: 'agent', prompt: 'x' } }, 'agent')).toEqual(refused);
    expect(store.duplicate(id).ok).toBe(true);
    expect(store.apply(id, { type: 'acceptChange', target: { kind: 'all' } }, 'user').ok).toBe(true);
  });
});

describe('graphFileDeleted', () => {
  it('drops the graph and keeps its side file, history and baseline; it comes back with its file', () => {
    const { paths, store, id, md, meta, text } = setup();
    store.apply(id, { type: 'moveNode', id: 'n1', position: { x: 3, y: 4 } }, 'user');
    store.apply(id, { type: 'updateNode', id: 'n2', patch: { command: 'make all' } }, 'agent', { kind: 'planner' });
    const saved = text();
    const deleted = vi.fn();
    store.on('fileDeleted', deleted);
    rmSync(md);
    expect(store.graphFileDeleted(id)).toBe('deleted');
    expect(deleted).toHaveBeenCalledWith(id);
    expect(store.list().map((g) => g.id)).toEqual([]);
    expect([existsSync(meta), existsSync(join(paths.graphsDir, `${id}.ops.jsonl`)), existsSync(join(paths.graphsDir, `${id}.baseline.json`))]).toEqual([true, true, true]);
    expect(store.graphFileDeleted(id)).toBe('unchanged');
    writeFileSync(md, saved);
    expect(store.graphFileChanged(id)).toBe('added');
    expect(store.get(id).nodes[0].position).toEqual({ x: 3, y: 4 });
    expect(store.agentChanges(id)).toMatchObject([{ kind: 'node', change: 'changed', id: 'n2', fields: ['command'] }]);
  });

  it('treats a delete report for a file that is there as a change', () => {
    const { store, id, edit } = setup();
    edit('Prove it.', 'Still here.');
    expect(store.graphFileDeleted(id)).toBe('applied');
    expect(store.get(id).goal).toBe('Still here.');
  });

  it('is noticed on load too', () => {
    const { store, id, md } = setup();
    const deleted = vi.fn();
    store.on('fileDeleted', deleted);
    rmSync(md);
    expect(store.load(id)).toEqual({ ok: false, error: `graph "${id}" not found` });
    expect(deleted).toHaveBeenCalledWith(id);
  });
});
