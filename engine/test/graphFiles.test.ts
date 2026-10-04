import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { canonicalGraph, diffToOps, parseGraphMarkdown, serializeGraphMarkdown, type Graph } from '@agent-stream/shared';
import { abTestGraph } from '../src/abTestGraph';
import { GraphStore } from '../src/graphStore';
import { starterGraph } from '../src/ticketGraph';
import { fixedClock, tmpProject } from './helpers';

function setup() {
  const paths = tmpProject();
  const store = new GraphStore(paths, fixedClock());
  const { id } = store.create('Parity');
  const md = join(paths.graphsDir, `${id}.md`);
  const meta = join(paths.graphsDir, `${id}.meta.json`);
  return { paths, store, id, md, meta, read: (f: string) => readFileSync(f, 'utf8') };
}

describe('graph files', () => {
  it('keeps the meaning in <id>.md and positions and bookkeeping in <id>.meta.json', () => {
    const { paths, store, id, md, meta, read } = setup();
    store.apply(id, { type: 'addNode', node: { title: 'Build', kind: 'command', command: 'make' } }, 'agent');
    store.apply(id, { type: 'addNode', node: { title: 'Check', kind: 'agent', prompt: 'Look.' } }, 'user');
    store.apply(id, { type: 'connect', from: 'n1', to: 'n2' }, 'user');
    const text = read(md);
    expect(text).toBe(serializeGraphMarkdown(store.get(id)));
    expect(text).not.toMatch(/position|createdBy|updatedAt|2026-/);
    expect(JSON.parse(read(meta))).toMatchObject({ version: 1, nodeSeq: 2, nodes: { n1: { createdBy: 'agent' }, n2: { createdBy: 'user' } } });
    store.apply(id, { type: 'moveNode', id: 'n1', position: { x: 40, y: 80 } }, 'user');
    expect(read(md)).toBe(text);
    expect(JSON.parse(read(meta)).nodes.n1.position).toEqual({ x: 40, y: 80 });
    expect(new GraphStore(paths, fixedClock()).get(id)).toEqual(store.get(id));
    expect(readdirSync(paths.graphsDir).filter((f) => f.includes('.tmp-'))).toEqual([]);
  });

  it('falls back to defaults without a side file, or with a broken one', () => {
    const { paths, store, id, meta } = setup();
    store.apply(id, { type: 'addNode', node: { title: 'A', kind: 'agent', prompt: 'p', position: { x: 1, y: 1 } } }, 'agent');
    rmSync(meta);
    const g = new GraphStore(paths, fixedClock()).get(id);
    expect(g.nodes[0]).toMatchObject({ id: 'n1', createdBy: 'user', updatedBy: 'user' });
    expect(g.nodes[0].position).toBeUndefined();
    expect(g.nodeSeq).toBe(1);
    writeFileSync(meta, '{ not json');
    expect(new GraphStore(paths, fixedClock()).load(id).ok).toBe(true);
  });

  it('gives a step written without an id the next number when the graph is read', () => {
    const { paths, store, id, md, read } = setup();
    store.apply(id, { type: 'addNode', node: { title: 'A', kind: 'agent', prompt: 'p' } }, 'user');
    writeFileSync(md, `${read(md)}\n## Clean up\n\n\`\`\`sh\nrm -rf tmp\n\`\`\`\n`);
    const g = new GraphStore(paths, fixedClock()).get(id);
    expect(g.nodes.map((n) => [n.id, n.title])).toEqual([
      ['n1', 'A'],
      ['n2', 'Clean up'],
    ]);
    expect(g.nodeSeq).toBe(2);
  });

  it('saves the canonical form: only the text of the step kind, whole-second timeouts, one-line titles', () => {
    const { store, id, md, read } = setup();
    store.apply(id, { type: 'addNode', node: { title: 'A', kind: 'agent', prompt: 'p', timeoutSec: 1.5 } }, 'user');
    const r = store.apply(id, { type: 'updateNode', id: 'n1', patch: { command: 'stale', title: 'Two\nlines' } }, 'agent');
    expect(r.ok && r.graph.nodes[0]).toMatchObject({ title: 'Two lines', prompt: 'p', timeoutSec: 2 });
    expect(r.ok && 'command' in r.graph.nodes[0]).toBe(false);
    expect(read(md)).toContain('## n1 · Two lines\n\n- kind: agent\n- timeout: 2\n');
    const base = store.baseline(id);
    expect(base.ok && base.graph && 'command' in base.graph.nodes[0]).toBe(false);
  });

  it('exports the stored Markdown and imports Markdown or a legacy export as a new graph', () => {
    const { store, id, md, read } = setup();
    store.apply(id, { type: 'addNode', node: { id: 'n4', title: 'A', kind: 'agent', prompt: 'p' } }, 'user');
    const exported = store.exportGraph(id);
    expect(exported).toEqual({ ok: true, fileName: 'parity.md', content: read(md) });
    const imported = store.importGraph(`﻿${read(md).replace(/\n/g, '\r\n')}\n## Next\n\n\`\`\`prompt\n\`\`\`\n`);
    if (!imported.ok) throw new Error(imported.error);
    expect(imported.graph.id).toBe('parity-2');
    expect(imported.graph.nodes.map((n) => n.id)).toEqual(['n4', 'n5']);
    expect(imported.graph.nodeSeq).toBe(5);
    const legacy = store.importGraph(JSON.stringify(abTestGraph('A/B', ['wh_small', 'wh_large'])));
    expect(legacy.ok && legacy.graph.id).toBe('a-b');
    expect(store.importGraph('# Bad\n## n1 · A\n')).toEqual({ ok: false, error: 'The file is not a valid Agent Stream graph: line 2: step n1 has no code block. Add a ```prompt block for an agent step or a ```sh block for a command step.' });
  });

  it('gives the built-in templates back unchanged after a reload', () => {
    const { paths, store } = setup();
    for (const content of [JSON.stringify(abTestGraph('A/B', ['wh_small', 'wh_large', 'wh-x'])), JSON.stringify(starterGraph('ABC-1 Fix login', '2026-10-04T00:00:00.000Z'))]) {
      const r = store.importGraph(content);
      if (!r.ok) throw new Error(r.error);
      expect(new GraphStore(paths, fixedClock()).get(r.graph.id)).toEqual(canonicalGraph(r.graph));
      expect(canonicalGraph(r.graph)).toEqual(r.graph);
    }
  });

  it('renames step ids the Markdown refuses and names untitled steps when importing a legacy export', () => {
    const { paths, store } = setup();
    const step = (id: string, title: string) => ({ id, title, kind: 'agent', prompt: 'p' });
    const legacy = { format: 'agent-stream/graph', version: 1, exportedAt: '', graph: { name: 'Old', nodes: [step('a--b', ''), step('n1', 'One'), step('fix-', 'Fix')], edges: [{ from: 'a--b', to: 'n1' }, { from: 'n1', to: 'fix-' }] } };
    const r = store.importGraph(JSON.stringify(legacy));
    if (!r.ok) throw new Error(r.error);
    expect(r.graph.nodes.map((n) => [n.id, n.title])).toEqual([
      ['a-b', 'Untitled step'],
      ['n1', 'One'],
      ['fix', 'Fix'],
    ]);
    expect(r.graph.edges.map((e) => e.id)).toEqual(['a-b->n1', 'n1->fix']);
    expect(new GraphStore(paths, fixedClock()).get(r.graph.id)).toEqual(r.graph);
  });

  it('keeps the canonical graph after every write, so a kind switch drops the other kind\'s text everywhere', () => {
    const { paths, store, id, md, read } = setup();
    const changed = vi.fn();
    store.on('changed', changed);
    store.apply(id, { type: 'addNode', node: { title: 'A', kind: 'agent', prompt: 'p' } }, 'user');
    const r = store.apply(id, { type: 'updateNode', id: 'n1', patch: { kind: 'command', command: 'make' } }, 'user');
    if (!r.ok) throw new Error(r.error);
    expect(r.graph.nodes[0]).not.toHaveProperty('prompt');
    expect(r.graph).toEqual(canonicalGraph(r.graph));
    expect(changed).toHaveBeenLastCalledWith(r.graph);
    expect(store.get(id)).toEqual(r.graph);
    expect(new GraphStore(paths, fixedClock()).get(id)).toEqual(r.graph);
    const doc = parseGraphMarkdown(read(md));
    expect(doc.ok && diffToOps(store.get(id), doc.doc)).toEqual([]);
    // An agent's switch reverted by the user: the restored step is canonical too.
    store.apply(id, { type: 'updateNode', id: 'n1', patch: { kind: 'agent', prompt: 'q' } }, 'agent');
    const reverted = store.apply(id, { type: 'revertChange', target: { kind: 'node', id: 'n1' } }, 'user');
    if (!reverted.ok) throw new Error(reverted.error);
    expect(reverted.graph.nodes[0]).toMatchObject({ kind: 'command', command: 'make' });
    expect(reverted.graph.nodes[0]).not.toHaveProperty('prompt');
    for (const g of [reverted.graph, store.get(id), new GraphStore(paths, fixedClock()).get(id)] as Graph[]) expect(g).toEqual(canonicalGraph(reverted.graph));
    const renamed = store.rename(id, 'Two\nlines');
    expect(renamed.ok && renamed.graph.name).toBe('Two lines');
    const copy = store.duplicate(id);
    expect(copy.ok && copy.graph).toEqual(copy.ok && canonicalGraph(copy.graph));
  });
});
