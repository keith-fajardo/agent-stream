import { readFileSync, writeFileSync } from 'node:fs';
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
    expect(store.list().map((g) => g.id)).toEqual(['dbt-parity-orders', 'dbt-parity-orders-2']);
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
    const edited = { ...JSON.parse(readFileSync(file, 'utf8')), goal: 'edited by hand outside claude-stream' };
    writeFileSync(file, `${JSON.stringify(edited, null, 2)}\n`);
    expect(store.get(id).goal).toBe('edited by hand outside claude-stream');
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

  it('stores planner state without logging an op or emitting a change', () => {
    const paths = tmpProject();
    const store = new GraphStore(paths, fixedClock());
    const { id } = store.create('G');
    const changed = vi.fn();
    store.on('changed', changed);
    store.setPlannerState(id, { plannerSessionId: 'sess-1', plannerOpCursor: 3 });
    expect(new GraphStore(paths).get(id)).toMatchObject({ plannerSessionId: 'sess-1', plannerOpCursor: 3 });
    expect(changed).not.toHaveBeenCalled();
    expect(store.readOps(id)).toEqual([]);
  });
});

describe('ChatLog', () => {
  it('appends and reads entries per graph', () => {
    const log = new ChatLog(tmpProject());
    log.append('g', { at: 't1', role: 'user', text: 'hi' });
    log.append('g', { at: 't2', role: 'assistant', text: 'hello' });
    expect(log.read('g').map((e) => e.text)).toEqual(['hi', 'hello']);
    expect(log.read('other')).toEqual([]);
    expect(log.read('../x')).toEqual([]);
  });
});
