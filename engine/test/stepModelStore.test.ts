import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GraphStore } from '../src/graphStore';
import { fixedClock, tmpProject } from './helpers';

const opus = { provider: 'claude' as const, id: 'opus' };

function setup() {
  const paths = tmpProject();
  const store = new GraphStore(paths, fixedClock());
  const { id } = store.create('Models');
  const file = join(paths.graphsDir, `${id}.md`);
  return { store, id, file, paths };
}

describe('GraphStore: a step model and effort', () => {
  it('saves them in the Markdown file and reads them back', () => {
    const { store, id, file, paths } = setup();
    store.apply(id, { type: 'addNode', node: { title: 'Plan', kind: 'agent', prompt: 'p', model: opus, effort: 'high' } }, 'user');
    expect(readFileSync(file, 'utf8')).toContain('- model: claude/opus\n- effort: high\n');
    const fresh = new GraphStore(paths, fixedClock());
    expect(fresh.get(id).nodes[0]).toMatchObject({ model: opus, effort: 'high' });
  });

  it('an agent change to them shows as a changed field, and Revert puts the user’s back', () => {
    const { store, id, file } = setup();
    store.apply(id, { type: 'addNode', node: { title: 'Plan', kind: 'agent', prompt: 'p', effort: 'low' } }, 'user');
    store.apply(id, { type: 'updateNode', id: 'n1', patch: { model: opus, effort: 'max' } }, 'agent', { kind: 'planner' });
    expect(store.agentChanges(id)).toMatchObject([{ kind: 'node', change: 'changed', id: 'n1', fields: ['model', 'effort'] }]);
    expect(store.apply(id, { type: 'revertChange', target: { kind: 'node', id: 'n1' } }, 'user').ok).toBe(true);
    const node = store.get(id).nodes[0];
    expect(node).not.toHaveProperty('model');
    expect(node.effort).toBe('low');
    expect(readFileSync(file, 'utf8')).not.toContain('- model:');
    expect(store.agentChanges(id)).toEqual([]);
  });

  it('keeps them in the baseline, so an agent edit to the prompt is not also a model change', () => {
    const { store, id } = setup();
    store.apply(id, { type: 'addNode', node: { title: 'Plan', kind: 'agent', prompt: 'p', model: opus, effort: 'high' } }, 'user');
    store.apply(id, { type: 'updateNode', id: 'n1', patch: { prompt: 'better' } }, 'agent', { kind: 'planner' });
    expect(store.baseline(id)).toMatchObject({ ok: true, graph: { nodes: [{ model: opus, effort: 'high' }] } });
    expect(store.agentChanges(id)).toMatchObject([{ id: 'n1', fields: ['prompt'] }]);
  });

  it('a hand edit of the lines becomes a user edit with model and effort in the patch', () => {
    const { store, id, file } = setup();
    store.apply(id, { type: 'addNode', node: { title: 'Plan', kind: 'agent', prompt: 'p' } }, 'user');
    writeFileSync(file, readFileSync(file, 'utf8').replace('- kind: agent\n', '- kind: agent\n- model: codex/gpt-6-astra\n- effort: ultra\n'));
    expect(store.graphFileChanged(id)).toBe('applied');
    expect(store.readOps(id).at(-1)).toMatchObject({ by: 'user', via: 'file', op: { type: 'updateNode', id: 'n1', patch: { model: { provider: 'codex', id: 'gpt-6-astra' }, effort: 'ultra' } } });
    writeFileSync(file, readFileSync(file, 'utf8').replace('- model: codex/gpt-6-astra\n', ''));
    expect(store.graphFileChanged(id)).toBe('applied');
    expect(store.readOps(id).at(-1)).toMatchObject({ op: { type: 'updateNode', id: 'n1', patch: { model: null } } });
    expect(store.get(id).nodes[0]).not.toHaveProperty('model');
  });
});
