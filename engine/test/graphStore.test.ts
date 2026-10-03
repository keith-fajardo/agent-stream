import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ChatLog } from '../src/chatLog';
import { GraphStore } from '../src/graphStore';
import { fixedClock, tmpProject } from './helpers';

describe('GraphStore', () => {
  it('creates graphs with slug ids and unique names', () => {
    const store = new GraphStore(tmpProject(), fixedClock());
    expect(store.create('dbt Parity: orders!').id).toBe('dbt-parity-orders');
    expect(store.create('dbt parity orders').id).toBe('dbt-parity-orders-2');
    expect(store.list().map((g) => g.id)).toEqual(['dbt-parity-orders-2', 'dbt-parity-orders']);
  });

  it('applies ops, persists them, logs them and emits changes', () => {
    const paths = tmpProject();
    const store = new GraphStore(paths, fixedClock());
    const { id } = store.create('G');
    const changed = vi.fn();
    store.on('changed', changed);
    expect(store.apply(id, { type: 'addNode', node: { title: 'a', kind: 'agent', prompt: 'p' } }, 'agent').ok).toBe(true);
    store.apply(id, { type: 'moveNode', id: 'n1', position: { x: 1, y: 2 } }, 'user');
    expect(changed).toHaveBeenCalledTimes(2);
    expect(new GraphStore(paths).get(id).nodes[0]).toMatchObject({ id: 'n1', createdBy: 'agent', position: { x: 1, y: 2 } });
    const ops = store.readOps(id);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ by: 'agent', op: { type: 'addNode', node: { id: 'n1', title: 'a' } } });
  });

  it('leaves the file and the log untouched when an op is rejected', () => {
    const paths = tmpProject();
    const store = new GraphStore(paths, fixedClock());
    const { id } = store.create('G');
    const file = join(paths.graphsDir, `${id}.json`);
    const before = readFileSync(file, 'utf8');
    expect(store.apply(id, { type: 'connect', from: 'n1', to: 'n2' }, 'user')).toEqual({ ok: false, error: 'node n1 does not exist' });
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(store.readOps(id)).toEqual([]);
  });

  it('lists unreadable graph files with their error and never overwrites them', () => {
    const paths = tmpProject();
    const broken = join(paths.graphsDir, 'broken.json');
    writeFileSync(broken, '{ "id": "broken", "name": ');
    writeFileSync(
      join(paths.graphsDir, 'cyclic.json'),
      JSON.stringify({
        id: 'cyclic',
        name: 'C',
        nodes: [{ id: 'n1', title: 'a', kind: 'agent' }, { id: 'n2', title: 'b', kind: 'agent' }],
        edges: [{ id: 'n1->n2', from: 'n1', to: 'n2' }, { id: 'n2->n1', from: 'n2', to: 'n1' }],
      }),
    );
    const store = new GraphStore(paths, fixedClock());
    const list = store.list();
    expect(list.find((g) => g.id === 'broken')?.error).toContain('invalid JSON');
    expect(list.find((g) => g.id === 'cyclic')?.error).toContain('cycle');
    expect(store.apply('broken', { type: 'setGoal', goal: 'x' }, 'user').ok).toBe(false);
    expect(readFileSync(broken, 'utf8')).toBe('{ "id": "broken", "name": ');
  });

  it('sees external edits to a graph file after it was loaded', () => {
    const paths = tmpProject();
    const store = new GraphStore(paths, fixedClock());
    const { id } = store.create('G');
    expect(store.get(id).goal).toBe('');
    const file = join(paths.graphsDir, `${id}.json`);
    const edited = { ...JSON.parse(readFileSync(file, 'utf8')), goal: 'edited by hand outside agent-stream' };
    writeFileSync(file, `${JSON.stringify(edited, null, 2)}\n`);
    expect(store.get(id).goal).toBe('edited by hand outside agent-stream');
  });

  it('reports a graph file broken after it was loaded and never overwrites it', () => {
    const paths = tmpProject();
    const store = new GraphStore(paths, fixedClock());
    const { id } = store.create('G');
    expect(store.load(id).ok).toBe(true);
    const file = join(paths.graphsDir, `${id}.json`);
    const conflicted = '<<<<<<< HEAD\n{ "id": "g" }\n=======\n';
    writeFileSync(file, conflicted);
    expect(store.list().find((g) => g.id === id)?.error).toContain('invalid JSON');
    expect(store.apply(id, { type: 'setGoal', goal: 'x' }, 'user').ok).toBe(false);
    expect(readFileSync(file, 'utf8')).toBe(conflicted);
  });

  it('rejects graph ids that could escape the graphs folder', () => {
    const store = new GraphStore(tmpProject(), fixedClock());
    expect(store.load('../../etc/passwd')).toEqual({ ok: false, error: 'invalid graph id "../../etc/passwd"' });
  });

  it('skips unparseable lines in the op log', () => {
    const paths = tmpProject();
    const store = new GraphStore(paths, fixedClock());
    const { id } = store.create('G');
    store.apply(id, { type: 'setGoal', goal: 'one' }, 'user');
    appendFileSync(join(paths.graphsDir, `${id}.ops.jsonl`), '<<<<<<< HEAD\n');
    store.apply(id, { type: 'setGoal', goal: 'two' }, 'agent');
    expect(store.readOps(id).map((r) => r.op)).toEqual([
      { type: 'setGoal', goal: 'one' },
      { type: 'setGoal', goal: 'two' },
    ]);
  });

  it('rewrites Jinja references when a variable is renamed', () => {
    const store = new GraphStore(tmpProject(), fixedClock());
    const { id } = store.create('G');
    store.apply(id, { type: 'addNode', node: { title: 'a', kind: 'command', command: 'dbt build --target {{ schema }} # schema' } }, 'user');
    store.apply(id, { type: 'addVariable', name: 'schema' }, 'user');
    expect(store.apply(id, { type: 'renameVariable', name: 'schema', newName: 'target_schema' }, 'user').ok).toBe(true);
    expect(store.get(id).nodes[0].command).toBe('dbt build --target {{ target_schema }} # schema');
  });
});

describe('ChatLog', () => {
  it('appends and reads entries per graph', () => {
    const log = new ChatLog(tmpProject().graphsDir);
    log.append('g', { at: 't1', role: 'user', text: 'hi' });
    log.append('g', { at: 't2', role: 'assistant', text: 'hello' });
    expect(log.read('g').map((e) => e.text)).toEqual(['hi', 'hello']);
    expect(log.read('other')).toEqual([]);
    expect(log.read('../x')).toEqual([]);
  });

  it('skips unparseable lines such as merge-conflict markers', () => {
    const paths = tmpProject();
    const log = new ChatLog(paths.graphsDir);
    log.append('g', { at: 't1', role: 'user', text: 'hi' });
    appendFileSync(join(paths.graphsDir, 'g.chat.jsonl'), '<<<<<<< HEAD\n');
    log.append('g', { at: 't2', role: 'assistant', text: 'hello' });
    expect(log.read('g').map((e) => e.text)).toEqual(['hi', 'hello']);
  });

  describe('management', () => {
    it('lists the newest graph first with its update time', () => {
      const store = new GraphStore(tmpProject(), fixedClock());
      store.create('Old');
      store.create('New');
      expect(store.list().map((g) => g.id)).toEqual(['new', 'old']);
      expect(store.list()[0].updatedAt).toEqual(expect.any(String));
    });

    it('renames the display name only and refuses blank names', () => {
      const store = new GraphStore(tmpProject(), fixedClock());
      const { id } = store.create('First');
      expect(store.rename(id, '  ')).toEqual({ ok: false, error: 'A graph needs a name.' });
      const r = store.rename(id, 'Parity check');
      expect(r.ok && r.graph).toMatchObject({ id: 'first', name: 'Parity check' });
      expect(store.get('first').name).toBe('Parity check');
    });

    it('duplicates the definition without planner state', () => {
      const paths = tmpProject();
      const store = new GraphStore(paths, fixedClock());
      const { id } = store.create('G');
      store.apply(id, { type: 'addNode', node: { title: 'a', kind: 'agent', prompt: 'p' } }, 'user');
      // A graph file from before work sessions still carries planner state.
      const file = join(paths.graphsDir, `${id}.json`);
      writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), plannerSessionId: 's', plannerOpCursor: 1 }));
      const first = store.duplicate(id);
      const second = store.duplicate(id);
      if (!first.ok || !second.ok) throw new Error('duplicate failed');
      expect([first.graph.name, second.graph.name]).toEqual(['G copy', 'G copy 2']);
      expect(first.graph.nodes).toHaveLength(1);
      expect((first.graph as Record<string, unknown>).plannerSessionId).toBeUndefined();
      expect(store.readOps(first.graph.id)).toEqual([]);
    });

    it('deletes the graph, its edit history and its chat', () => {
      const paths = tmpProject();
      const store = new GraphStore(paths, fixedClock());
      const { id } = store.create('G');
      store.apply(id, { type: 'setGoal', goal: 'x' }, 'user');
      new ChatLog(paths.graphsDir).append(id, { at: 't', role: 'user', text: 'hi' });
      expect(store.delete(id)).toEqual({ ok: true });
      expect(store.list()).toEqual([]);
      expect(store.load(id)).toEqual({ ok: false, error: `graph "${id}" not found` });
      expect(new ChatLog(paths.graphsDir).read(id)).toEqual([]);
      expect(store.delete(id)).toEqual({ ok: false, error: `graph "${id}" not found` });
    });

    it('exports and imports under a new, unique id', () => {
      const store = new GraphStore(tmpProject(), fixedClock());
      const { id } = store.create('Parity');
      const exported = store.exportGraph(id);
      if (!exported.ok) throw new Error(exported.error);
      expect(exported.fileName).toBe('parity.agent-stream.json');
      const imported = store.importGraph(exported.content);
      expect(imported.ok && imported.graph.id).toBe('parity-2');
      expect(store.importGraph('nope')).toEqual({ ok: false, error: 'The file is not valid JSON.' });
    });
  });
});
