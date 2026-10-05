import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MAX_UNDO, NOTHING_TO_UNDO, UNDO_CHANGED, type Op, type ServerMessage } from '@agent-stream/shared';
import { createApp } from '../src/app';
import { appTestDeps, signedIn, testGitBash, testProvider, tmpProject, tmpValuesFile } from './helpers';

function setup() {
  const paths = tmpProject();
  const app = createApp({ ...appTestDeps(), projectDir: paths.root, valuesFile: tmpValuesFile(), provider: testProvider(), status: signedIn, maxParallel: 1, gitBash: testGitBash });
  const graphId = app.graphStore.create('G').id;
  const file = join(paths.graphsDir, `${graphId}.md`);
  /** A graph tab: a client of its own, as each webview is. */
  const tab = () => {
    const msgs: ServerMessage[] = [];
    const c = { send: (m: ServerMessage) => void msgs.push(structuredClone(m)) };
    app.connect(c);
    const all = <T extends ServerMessage['type']>(type: T) => msgs.filter((m): m is Extract<ServerMessage, { type: T }> => m.type === type);
    return {
      c,
      all,
      op: (op: Op) => app.handle(c, { type: 'op', graphId, op }),
      ops: (ops: Op[], label: string) => app.handle(c, { type: 'ops', graphId, ops, label }),
      undo: () => app.handle(c, { type: 'undo', graphId }),
      toast: () => all('undone').at(-1)?.message,
      label: () => all('undoState').at(-1)?.label,
    };
  };
  const graph = () => app.graphStore.get(graphId);
  return { app, graphId, file, tab, graph };
}
const add = (id: string, extra: object = {}): Op => ({ type: 'addNode', node: { id, title: id, kind: 'agent', prompt: 'p', position: { x: 0, y: 0 }, ...extra } });

describe('undo (step model spec §6a.2)', () => {
  it('undoes each of the tab’s own actions, newest first, one step each, with its label', async () => {
    const s = setup();
    const t = s.tab();
    await s.app.handle(t.c, { type: 'openGraph', graphId: s.graphId });
    expect(t.all('undoState')).toEqual([{ type: 'undoState', graphId: s.graphId }]);
    await t.op(add('n1'));
    await t.op(add('n2'));
    await t.op({ type: 'connect', from: 'n1', to: 'n2' });
    await t.ops([{ type: 'moveNode', id: 'n1', position: { x: 10, y: 10 } }, { type: 'moveNode', id: 'n2', position: { x: 20, y: 20 } }], 'moved 2 steps');
    await t.op({ type: 'updateNode', id: 'n2', patch: { model: { provider: 'claude', id: 'opus' }, effort: 'high' } });
    await t.ops([{ type: 'deleteNode', id: 'n1' }], 'deleted n1');
    expect(t.label()).toBe('deleted n1');
    const labels: string[] = [];
    for (let i = 0; i < 6; i++) {
      await t.undo();
      labels.push(t.toast()!);
    }
    expect(labels).toEqual(['Undid deleted n1.', 'Undid saved n2.', 'Undid moved 2 steps.', 'Undid connected n1 → n2.', 'Undid added n2.', 'Undid added n1.']);
    expect(s.graph().nodes).toEqual([]);
    await t.undo();
    expect(t.toast()).toBe(NOTHING_TO_UNDO);
    expect(t.label()).toBeUndefined();
  });

  it('restores through user edits recorded via undo, in the Markdown file too', async () => {
    const s = setup();
    const t = s.tab();
    await t.op(add('n1', { title: 'Keep me' }));
    await t.op({ type: 'deleteNode', id: 'n1' });
    expect(readFileSync(s.file, 'utf8')).not.toContain('Keep me');
    await t.undo();
    expect(s.graph().nodes[0]).toMatchObject({ id: 'n1', title: 'Keep me', position: { x: 0, y: 0 } });
    expect(readFileSync(s.file, 'utf8')).toContain('## n1 · Keep me');
    expect(s.app.graphStore.readOps(s.graphId).at(-1)).toMatchObject({ by: 'user', via: 'undo', op: { type: 'addNode', node: { id: 'n1' } } });
  });

  it('keeps at most 50 steps', async () => {
    const s = setup();
    const t = s.tab();
    await t.op(add('n1'));
    for (let i = 1; i <= MAX_UNDO + 5; i++) await t.op({ type: 'moveNode', id: 'n1', position: { x: i, y: 0 } });
    for (let i = 0; i < MAX_UNDO; i++) await t.undo();
    expect(t.toast()).toBe('Undid moved n1.');
    expect(s.graph().nodes[0].position).toEqual({ x: 5, y: 0 });
    await t.undo();
    expect(t.toast()).toBe(NOTHING_TO_UNDO);
  }, 30_000);

  it('records nothing for an action that changed nothing, and no step for a review of agent changes', async () => {
    const s = setup();
    const t = s.tab();
    await t.op(add('n1'));
    await t.ops([{ type: 'moveNode', id: 'n1', position: { x: 0, y: 0 } }], 'moved n1');
    s.app.graphStore.apply(s.graphId, { type: 'updateNode', id: 'n1', patch: { prompt: 'agent' } }, 'agent', { kind: 'planner' });
    await t.op({ type: 'acceptChange', target: { kind: 'all' } });
    expect(t.label()).toBe('added n1');
  });

  it('refuses after a change by the planner, another tab or the file, and clears the stack', async () => {
    for (const change of ['planner', 'tab', 'file'] as const) {
      const s = setup();
      const t = s.tab();
      await t.op(add('n1'));
      await t.op(add('n2'));
      if (change === 'planner') s.app.graphStore.apply(s.graphId, { type: 'updateNode', id: 'n1', patch: { prompt: 'better' } }, 'agent', { kind: 'planner' });
      if (change === 'tab') await s.tab().op({ type: 'moveNode', id: 'n1', position: { x: 9, y: 9 } });
      if (change === 'file') {
        writeFileSync(s.file, readFileSync(s.file, 'utf8').replace('## n2 · n2', '## n2 · Renamed'));
        s.app.graphFileChanged(s.graphId);
      }
      await t.undo();
      expect(t.toast(), change).toBe(UNDO_CHANGED);
      expect(t.label(), change).toBeUndefined();
      expect(s.graph().nodes.map((n) => n.id), change).toEqual(['n1', 'n2']);
      await t.undo();
      expect(t.toast(), change).toBe(NOTHING_TO_UNDO);
    }
  });

  it('refuses while the file has errors, and keeps the step for later', async () => {
    const s = setup();
    const t = s.tab();
    await t.op(add('n1'));
    const good = readFileSync(s.file, 'utf8');
    writeFileSync(s.file, `${good}\n## n2 · Broken\n`);
    s.app.graphFileChanged(s.graphId);
    await t.undo();
    expect(t.toast()).toBe(`Can't undo: ${s.graphId}.md has errors. Fix the file first.`);
    writeFileSync(s.file, good);
    s.app.graphFileChanged(s.graphId);
    await t.undo();
    expect(t.toast()).toBe('Undid added n1.');
  });

  it('a tab only undoes its own actions', async () => {
    const s = setup();
    const a = s.tab();
    const b = s.tab();
    await a.op(add('n1'));
    await b.undo();
    expect(b.toast()).toBe(NOTHING_TO_UNDO);
    expect(s.graph().nodes).toHaveLength(1);
  });

  it('follows the agent-change baseline rules of a canvas edit', async () => {
    const s = setup();
    const t = s.tab();
    await t.op(add('n1'));
    await t.op(add('n2'));
    s.app.graphStore.apply(s.graphId, { type: 'updateNode', id: 'n1', patch: { prompt: 'agent' } }, 'agent', { kind: 'planner' });
    await t.op({ type: 'deleteNode', id: 'n2' });
    await t.undo();
    expect(t.toast()).toBe('Undid deleted n2.');
    // n2 came back as the user's: still only the planner's prompt change is pending.
    expect(s.app.graphStore.agentChanges(s.graphId)).toMatchObject([{ kind: 'node', change: 'changed', id: 'n1', fields: ['prompt'] }]);
  });

  it('a Markdown save in this tab is one step', async () => {
    const s = setup();
    const t = s.tab();
    await t.op(add('n1'));
    const text = readFileSync(s.file, 'utf8');
    await s.app.handle(t.c, { type: 'saveGraphMarkdown', graphId: s.graphId, text: text.replace('## n1 · n1', '## n1 · Hand edit').replace('```prompt\np', '```prompt\nedited'), base: text });
    expect(t.label()).toBe('saved the Markdown');
    await t.undo();
    expect(t.toast()).toBe('Undid saved the Markdown.');
    expect(s.graph().nodes[0]).toMatchObject({ title: 'n1', prompt: 'p' });
  });

  it('a revert of agent changes in this tab clears its stack', async () => {
    const s = setup();
    const t = s.tab();
    await t.op(add('n1'));
    s.app.graphStore.apply(s.graphId, { type: 'updateNode', id: 'n1', patch: { prompt: 'agent' } }, 'agent', { kind: 'planner' });
    await t.op({ type: 'revertChange', target: { kind: 'all' } });
    expect(t.label()).toBeUndefined();
  });

  it('a batch applies all or none', async () => {
    const s = setup();
    const t = s.tab();
    await t.op(add('n1'));
    await t.ops([{ type: 'deleteNode', id: 'n1' }, { type: 'deleteNode', id: 'n9' }], 'deleted 2 steps');
    expect(t.all('opRejected').at(-1)).toEqual({ type: 'opRejected', graphId: s.graphId, error: 'node n9 does not exist' });
    expect(s.graph().nodes).toHaveLength(1);
    expect(t.label()).toBe('added n1');
  });

  it('refuses after an agent step changed the graph', async () => {
    const s = setup();
    const t = s.tab();
    await t.op(add('n1'));
    s.app.graphStore.apply(s.graphId, { type: 'updateNode', id: 'n1', patch: { prompt: 'from a run' } }, 'agent', { kind: 'step', runId: 'r1', nodeId: 'n1' });
    await t.undo();
    expect(t.toast()).toBe(UNDO_CHANGED);
    expect(s.graph().nodes).toHaveLength(1);
  });

  it('undoing a lone variable rename keeps the saved value', async () => {
    const s = setup();
    const t = s.tab();
    await t.op({ type: 'addVariable', name: 'x' });
    await s.app.handle(t.c, { type: 'setVariableValue', graphId: s.graphId, name: 'x', value: 'secret' });
    await t.op({ type: 'renameVariable', name: 'x', newName: 'y' });
    expect(s.app.values.get(s.graphId)).toEqual({ y: 'secret' });
    await t.undo();
    expect(s.graph().variables.map((v) => v.name)).toEqual(['x']);
    expect(s.app.values.get(s.graphId)).toEqual({ x: 'secret' });
  });

  it('undoing a dialog-style batch (rename and describe) brings the variable and its value back', async () => {
    const s = setup();
    const t = s.tab();
    await t.op({ type: 'addVariable', name: 'x' });
    await s.app.handle(t.c, { type: 'setVariableValue', graphId: s.graphId, name: 'x', value: 'secret' });
    await t.ops([{ type: 'renameVariable', name: 'x', newName: 'y' }, { type: 'setVariableDescription', name: 'y', description: 'Why' }], 'edited the variables');
    await t.undo();
    expect(s.graph().variables).toMatchObject([{ name: 'x', description: '' }]);
    expect(s.app.values.get(s.graphId)).toEqual({ x: 'secret' });
  });

  it('undoing a variable delete restores its saved value', async () => {
    const s = setup();
    const t = s.tab();
    await t.op({ type: 'addVariable', name: 'x' });
    await s.app.handle(t.c, { type: 'setVariableValue', graphId: s.graphId, name: 'x', value: 'secret' });
    await t.op({ type: 'deleteVariable', name: 'x' });
    expect(s.app.values.get(s.graphId)).toEqual({});
    await t.undo();
    expect(s.graph().variables.map((v) => v.name)).toEqual(['x']);
    expect(s.app.values.get(s.graphId)).toEqual({ x: 'secret' });
  });
});
