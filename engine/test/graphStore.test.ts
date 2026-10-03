import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { NewNodeInput } from '@agent-stream/shared';
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

/** A store with one graph holding `nodes` (and `edges`), all made by the user. */
function withGraph(nodes: NewNodeInput[], edges: [string, string][] = []) {
  const paths = tmpProject();
  const store = new GraphStore(paths, fixedClock());
  const { id } = store.create('G');
  for (const node of nodes) store.apply(id, { type: 'addNode', node }, 'user');
  for (const [from, to] of edges) store.apply(id, { type: 'connect', from, to }, 'user');
  return { store, id, paths, baselineFile: join(paths.graphsDir, `${id}.baseline.json`) };
}

const step = (id: string, over: Partial<NewNodeInput> = {}): NewNodeInput => ({ id, title: id, kind: 'agent', prompt: `do ${id}`, ...over });

describe('agent changes against the baseline', () => {
  it('creates the baseline on the first agent edit; user edits go to both', () => {
    const { store, id } = withGraph([{ id: 'n1', title: 'One', kind: 'agent', prompt: 'p' }]);
    expect(store.baseline(id)).toEqual({ ok: true });
    store.apply(id, { type: 'updateNode', id: 'n1', patch: { prompt: 'agent prompt' } }, 'agent', { kind: 'planner', sessionId: 'default' });
    store.apply(id, { type: 'updateNode', id: 'n1', patch: { title: 'Renamed by me' } }, 'user');
    const changes = store.agentChanges(id);
    expect(changes).toEqual([{ kind: 'node', change: 'changed', id: 'n1', title: 'Renamed by me', fields: ['prompt'], by: { kind: 'planner', sessionId: 'default' }, at: expect.any(String) }]);
    const base = store.baseline(id);
    expect(base.ok && base.graph?.nodes.map((n) => [n.title, n.prompt])).toEqual([['Renamed by me', 'p']]);
    expect(store.readOps(id).at(-2)).toMatchObject({ by: 'agent', source: { kind: 'planner', sessionId: 'default' } });
    expect(store.readOps(id).at(-1)).not.toHaveProperty('source');
  });

  it('keeps an agent-added step marked when the user edits it', () => {
    const { store, id } = withGraph([]);
    store.apply(id, { type: 'addNode', node: { id: 'n1', title: 'Install deps', kind: 'command', command: 'npm ci' } }, 'agent', { kind: 'step', runId: 'r1', nodeId: 'n2' });
    expect(store.apply(id, { type: 'updateNode', id: 'n1', patch: { title: 'Install' } }, 'user').ok).toBe(true);
    expect(store.get(id).nodes[0]).toMatchObject({ id: 'n1', title: 'Install', updatedBy: 'user' });
    expect(store.agentChanges(id)).toMatchObject([{ kind: 'node', change: 'added', id: 'n1', title: 'Install', by: { kind: 'step', runId: 'r1', nodeId: 'n2' } }]);
    const base = store.baseline(id);
    expect(base.ok && base.graph?.nodes).toEqual([]);
  });

  it('accepts and reverts per change and in full, and drops the baseline once they match', () => {
    const { store, id, paths } = withGraph([{ id: 'n1', title: 'One', kind: 'agent', prompt: 'p' }]);
    store.apply(id, { type: 'updateNode', id: 'n1', patch: { prompt: 'x' } }, 'agent', { kind: 'planner' });
    store.apply(id, { type: 'addNode', node: { id: 'n2', title: 'Two', kind: 'agent', prompt: 'q' } }, 'agent', { kind: 'planner' });
    expect(store.apply(id, { type: 'revertChange', target: { kind: 'node', id: 'n1' } }, 'user').ok).toBe(true);
    expect(store.get(id).nodes.find((n) => n.id === 'n1')?.prompt).toBe('p');
    expect(store.apply(id, { type: 'acceptChange', target: { kind: 'all' } }, 'user').ok).toBe(true);
    expect(store.agentChanges(id)).toEqual([]);
    expect(existsSync(join(paths.graphsDir, `${id}.baseline.json`))).toBe(false);
  });

  it('treats an unreadable baseline as no changes and lets Accept all rewrite it', () => {
    const { store, id, baselineFile } = withGraph([step('n1')]);
    writeFileSync(baselineFile, '{ nope');
    const base = store.baseline(id);
    expect(base.ok).toBe(false);
    expect(!base.ok && base.error).toMatch(/baseline/);
    expect(store.agentChanges(id)).toEqual([]);
    expect(store.list()).toEqual([{ id, name: 'G', updatedAt: expect.any(String) }]);
    expect(store.apply(id, { type: 'revertChange', target: { kind: 'node', id: 'n1' } }, 'user')).toEqual({ ok: false, error: 'There are no agent changes to review.' });
    expect(store.apply(id, { type: 'acceptChange', target: { kind: 'all' } }, 'user').ok).toBe(true);
    expect(existsSync(baselineFile)).toBe(false);
    expect(store.baseline(id)).toEqual({ ok: true });
    // The next agent edit starts a fresh baseline.
    store.apply(id, { type: 'updateNode', id: 'n1', patch: { prompt: 'new' } }, 'agent', { kind: 'planner' });
    expect(store.agentChanges(id)).toMatchObject([{ id: 'n1', change: 'changed', fields: ['prompt'] }]);
  });

  it('deletes the baseline with its graph', () => {
    const { store, id, baselineFile } = withGraph([step('n1')]);
    store.apply(id, { type: 'deleteNode', id: 'n1' }, 'agent', { kind: 'planner' });
    expect(existsSync(baselineFile)).toBe(true);
    expect(store.delete(id)).toEqual({ ok: true });
    expect(existsSync(baselineFile)).toBe(false);
    expect(store.baseline(id)).toEqual({ ok: true });
  });

  it('lists the number of agent changes, and never lists a baseline as a graph', () => {
    const { store, id } = withGraph([step('n1')]);
    store.apply(id, { type: 'updateNode', id: 'n1', patch: { title: 'Agent title' } }, 'agent', { kind: 'planner' });
    expect(store.list()).toEqual([{ id, name: 'G', updatedAt: expect.any(String), agentChanges: 1 }]);
  });

  it('has no baseline and no changes when nothing an agent did differs', () => {
    const { store, id, baselineFile } = withGraph([step('n1')]);
    store.apply(id, { type: 'setGoal', goal: 'agent goal' }, 'agent', { kind: 'planner' });
    store.apply(id, { type: 'moveNode', id: 'n1', position: { x: 5, y: 5 } }, 'agent');
    expect(existsSync(baselineFile)).toBe(false);
    store.apply(id, { type: 'updateNode', id: 'n1', patch: { prompt: 'x' } }, 'agent', { kind: 'planner' });
    expect(existsSync(baselineFile)).toBe(true);
    // The user undoing it by hand makes the graph match its baseline again.
    store.apply(id, { type: 'updateNode', id: 'n1', patch: { prompt: 'do n1' } }, 'user');
    expect(existsSync(baselineFile)).toBe(false);
  });

  it('attributes each change to the latest agent op that touched it', () => {
    const { store, id } = withGraph([step('n1'), step('n2'), step('n3')], [['n1', 'n2']]);
    const planner = { kind: 'planner', sessionId: 'a' } as const;
    const runStep = { kind: 'step', runId: 'r1', nodeId: 'n1' } as const;
    store.apply(id, { type: 'updateNode', id: 'n3', patch: { prompt: 'first' } }, 'agent', planner);
    store.apply(id, { type: 'updateNode', id: 'n3', patch: { prompt: 'second' } }, 'agent', runStep);
    store.apply(id, { type: 'disconnect', from: 'n1', to: 'n2' }, 'agent', planner);
    store.apply(id, { type: 'connect', from: 'n2', to: 'n3' }, 'agent', runStep);
    store.apply(id, { type: 'updateNode', id: 'n3', patch: { title: 'Mine' } }, 'user');
    expect(store.agentChanges(id)).toEqual([
      { kind: 'node', change: 'changed', id: 'n3', title: 'Mine', fields: ['prompt'], by: runStep, at: expect.any(String) },
      { kind: 'edge', change: 'removed', id: 'n1->n2', from: 'n1', to: 'n2', by: planner, at: expect.any(String) },
      { kind: 'edge', change: 'added', id: 'n2->n3', from: 'n2', to: 'n3', by: runStep, at: expect.any(String) },
    ]);
  });

  it('reverts a removed step with its connections, and an added step with its connections', () => {
    const { store, id } = withGraph([step('n1'), step('n2', { position: { x: 1, y: 2 } }), step('n3')], [['n1', 'n2'], ['n2', 'n3']]);
    store.apply(id, { type: 'deleteNode', id: 'n2' }, 'agent', { kind: 'planner' });
    store.apply(id, { type: 'addNode', node: step('n4') }, 'agent', { kind: 'planner' });
    store.apply(id, { type: 'connect', from: 'n1', to: 'n4' }, 'agent', { kind: 'planner' });
    store.apply(id, { type: 'connect', from: 'n4', to: 'n3' }, 'agent', { kind: 'planner' });
    expect(store.apply(id, { type: 'revertChange', target: { kind: 'node', id: 'n2' } }, 'user').ok).toBe(true);
    let g = store.get(id);
    expect(g.nodes.find((n) => n.id === 'n2')).toMatchObject({ title: 'n2', prompt: 'do n2', position: { x: 1, y: 2 } });
    expect(g.edges.map((e) => e.id).sort()).toEqual(['n1->n2', 'n1->n4', 'n2->n3', 'n4->n3']);
    expect(store.apply(id, { type: 'revertChange', target: { kind: 'node', id: 'n4' } }, 'user').ok).toBe(true);
    g = store.get(id);
    expect(g.nodes.map((n) => n.id).sort()).toEqual(['n1', 'n2', 'n3']);
    expect(g.edges.map((e) => e.id).sort()).toEqual(['n1->n2', 'n2->n3']);
    expect(store.agentChanges(id)).toEqual([]);
    expect(store.baseline(id)).toEqual({ ok: true });
    expect(store.readOps(id).at(-1)).toMatchObject({ by: 'user', op: { type: 'revertChange', target: { kind: 'node', id: 'n4' } } });
  });

  it('reverts a changed step to its baseline fields, keeping where it is', () => {
    const { store, id } = withGraph([step('n1', { kind: 'command', command: 'make', prompt: undefined, timeoutSec: 30 })]);
    store.apply(id, { type: 'updateNode', id: 'n1', patch: { title: 'Agent', description: 'why', command: 'make all', timeoutSec: 60 } }, 'agent', { kind: 'planner' });
    store.apply(id, { type: 'moveNode', id: 'n1', position: { x: 7, y: 8 } }, 'user');
    expect(store.apply(id, { type: 'revertChange', target: { kind: 'node', id: 'n1' } }, 'user').ok).toBe(true);
    const n1 = store.get(id).nodes[0];
    expect(n1).toEqual({ id: 'n1', title: 'n1', kind: 'command', command: 'make', timeoutSec: 30, position: { x: 7, y: 8 }, createdBy: 'user', updatedBy: 'user', updatedAt: expect.any(String) });
  });

  it('accepts and reverts single connections', () => {
    const { store, id } = withGraph([step('n1'), step('n2'), step('n3')], [['n1', 'n2']]);
    store.apply(id, { type: 'disconnect', from: 'n1', to: 'n2' }, 'agent', { kind: 'planner' });
    store.apply(id, { type: 'connect', from: 'n2', to: 'n3' }, 'agent', { kind: 'planner' });
    expect(store.apply(id, { type: 'revertChange', target: { kind: 'edge', id: 'n1->n2' } }, 'user').ok).toBe(true);
    expect(store.get(id).edges.map((e) => e.id).sort()).toEqual(['n1->n2', 'n2->n3']);
    expect(store.apply(id, { type: 'acceptChange', target: { kind: 'edge', id: 'n2->n3' } }, 'user').ok).toBe(true);
    expect(store.agentChanges(id)).toEqual([]);
    store.apply(id, { type: 'connect', from: 'n1', to: 'n3' }, 'agent', { kind: 'planner' });
    expect(store.apply(id, { type: 'revertChange', target: { kind: 'edge', id: 'n1->n3' } }, 'user').ok).toBe(true);
    expect(store.get(id).edges.map((e) => e.id).sort()).toEqual(['n1->n2', 'n2->n3']);
    expect(store.apply(id, { type: 'revertChange', target: { kind: 'edge', id: 'n1->n3' } }, 'user')).toEqual({ ok: false, error: 'There are no agent changes to review.' });
  });

  it('accepts one step into the baseline and leaves the rest marked', () => {
    const { store, id } = withGraph([step('n1'), step('n2')]);
    store.apply(id, { type: 'updateNode', id: 'n1', patch: { command: 'x' } }, 'agent', { kind: 'planner' });
    store.apply(id, { type: 'deleteNode', id: 'n2' }, 'agent', { kind: 'planner' });
    store.apply(id, { type: 'addNode', node: step('n3') }, 'agent', { kind: 'planner' });
    expect(store.apply(id, { type: 'acceptChange', target: { kind: 'node', id: 'n2' } }, 'user').ok).toBe(true);
    expect(store.apply(id, { type: 'acceptChange', target: { kind: 'node', id: 'n3' } }, 'user').ok).toBe(true);
    expect(store.agentChanges(id)).toMatchObject([{ id: 'n1', change: 'changed', fields: ['command'] }]);
    expect(store.apply(id, { type: 'acceptChange', target: { kind: 'node', id: 'n9' } }, 'user')).toEqual({ ok: false, error: 'node n9 does not exist' });
  });

  it('reverts everything to the baseline, keeping where the steps are', () => {
    const { store, id } = withGraph([step('n1'), step('n2')], [['n1', 'n2']]);
    store.apply(id, { type: 'updateNode', id: 'n1', patch: { title: 'Agent', description: 'why' } }, 'agent', { kind: 'planner' });
    store.apply(id, { type: 'deleteNode', id: 'n2' }, 'agent', { kind: 'planner' });
    store.apply(id, { type: 'addNode', node: step('n3') }, 'agent', { kind: 'planner' });
    store.apply(id, { type: 'moveNode', id: 'n1', position: { x: 40, y: 40 } }, 'user');
    store.rename(id, 'Renamed');
    expect(store.apply(id, { type: 'revertChange', target: { kind: 'all' } }, 'user').ok).toBe(true);
    const g = store.get(id);
    expect(g.name).toBe('Renamed');
    expect(g.nodes.map((n) => [n.id, n.title, n.description, n.position])).toEqual([
      ['n1', 'n1', undefined, { x: 40, y: 40 }],
      ['n2', 'n2', undefined, undefined],
    ]);
    expect(g.edges.map((e) => e.id)).toEqual(['n1->n2']);
    expect(g.nodeSeq).toBe(3);
    expect(store.agentChanges(id)).toEqual([]);
    expect(store.baseline(id)).toEqual({ ok: true });
  });

  it('refuses a revert that would make a cycle, and changes nothing', () => {
    const { store, id, baselineFile } = withGraph([step('n1'), step('n2')], [['n1', 'n2']]);
    store.apply(id, { type: 'disconnect', from: 'n1', to: 'n2' }, 'agent', { kind: 'planner' });
    store.apply(id, { type: 'connect', from: 'n2', to: 'n1' }, 'user');
    const before = readFileSync(baselineFile, 'utf8');
    expect(store.apply(id, { type: 'revertChange', target: { kind: 'edge', id: 'n1->n2' } }, 'user')).toEqual({ ok: false, error: 'the graph has a cycle' });
    expect(store.get(id).edges.map((e) => e.id)).toEqual(['n2->n1']);
    expect(readFileSync(baselineFile, 'utf8')).toBe(before);
  });

  it('emits the change for review ops like any other edit', () => {
    const { store, id } = withGraph([step('n1')]);
    store.apply(id, { type: 'updateNode', id: 'n1', patch: { prompt: 'x' } }, 'agent', { kind: 'planner' });
    const changed = vi.fn();
    const op = vi.fn();
    store.on('changed', changed);
    store.on('op', op);
    const accept = { type: 'acceptChange', target: { kind: 'all' } } as const;
    store.apply(id, accept, 'user');
    expect(changed).toHaveBeenCalledTimes(1);
    expect(op).toHaveBeenCalledWith(id, accept);
    expect(store.readOps(id).at(-1)).toMatchObject({ by: 'user', op: accept });
  });

  it('duplicates without the baseline', () => {
    const { store, id } = withGraph([step('n1')]);
    store.apply(id, { type: 'updateNode', id: 'n1', patch: { prompt: 'x' } }, 'agent', { kind: 'planner' });
    const copy = store.duplicate(id);
    if (!copy.ok) throw new Error(copy.error);
    expect(store.baseline(copy.graph.id)).toEqual({ ok: true });
    expect(store.agentChanges(copy.graph.id)).toEqual([]);
  });
});
