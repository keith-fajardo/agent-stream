// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyGraph, type Graph } from '@agent-stream/shared';

vi.mock('../src/bridge', () => ({ send: vi.fn(), sendHost: vi.fn(), post: vi.fn() }));
const { send } = await import('../src/bridge');
const { dispatch, getState } = await import('../src/store');
const { NodePanel } = await import('../src/components/NodePanel');
const { onShortcutKey } = await import('../src/shortcuts');
const { buildMenus } = await import('../src/menuModel');
const { actions } = await import('../src/actions');
const { deletionEdit } = await import('../src/selection');
const { GraphPanel } = await import('../src/components/GraphPanel');
type MenuAction = import('../src/menuModel').MenuAction;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const step = { id: 'n1', title: 'Plan', kind: 'agent' as const, prompt: 'p', createdBy: 'user' as const, updatedBy: 'user' as const, updatedAt: 't', position: { x: 0, y: 0 } };
const graph: Graph = { ...emptyGraph('g', 'G', 't'), nodes: [step, { ...step, id: 'n2', title: 'Two', position: undefined }] };
let el: HTMLDivElement;
let root: Root;

/** ⌘ + key (or Ctrl), sent at `target` and bubbling to the document, as a keypress in the tab would. */
function press(key: string, target: EventTarget = document.body, o: { ctrl?: boolean; shift?: boolean } = {}): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { key, metaKey: !o.ctrl, ctrlKey: !!o.ctrl, shiftKey: !!o.shift, bubbles: true, cancelable: true });
  act(() => void target.dispatchEvent(e));
  return e;
}
function type(field: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = field instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(field, value);
  field.dispatchEvent(new Event('input', { bubbles: true }));
}
const menuItem = (menu: string, label: string) => buildMenus(getState()).find((m) => m.id === menu)!.items.find((i): i is MenuAction => 'label' in i && i.label.startsWith(label))!;

beforeEach(async () => {
  dispatch({ kind: 'server', msg: { type: 'hello', status: { provider: 'claude', ok: true, label: 'Claude Max' }, project: '/p', graphs: [], approvals: [] } });
  dispatch({ kind: 'server', msg: { type: 'graphOpened', changes: [], graph, runs: [], variableValues: {} } });
  dispatch({ kind: 'server', msg: { type: 'graphFileErrors', graphId: 'g', errors: [] } });
  dispatch({ kind: 'setCanvasMode', mode: 'graph' });
  dispatch({ kind: 'dismissToast' });
  dispatch({ kind: 'selectNode', id: 'n1' });
  document.addEventListener('keydown', onShortcutKey);
  el = document.createElement('div');
  document.body.appendChild(el);
  root = createRoot(el);
  await act(async () => root.render(createElement(NodePanel)));
  vi.mocked(send).mockClear();
});
afterEach(async () => {
  document.removeEventListener('keydown', onShortcutKey);
  await act(async () => root.unmount());
  el.remove();
});

describe('⌘S (spec §6a.1)', () => {
  it('saves the open step’s draft as Save does, from inside its text fields, with a toast', async () => {
    const title = el.querySelector('input') as HTMLInputElement;
    await act(async () => type(title, 'Plan more'));
    const e = press('s', title);
    expect(e.defaultPrevented).toBe(true);
    expect(vi.mocked(send).mock.calls).toEqual([[{ type: 'op', graphId: 'g', op: { type: 'updateNode', id: 'n1', patch: { title: 'Plan more' } } }]]);
    expect(getState().toast).toBe('Step n1 saved.');
  });

  it('with nothing unsaved, says the graph is saved; Ctrl works as ⌘ does', () => {
    press('s', document.body, { ctrl: true });
    expect(send).not.toHaveBeenCalled();
    expect(getState().toast).toBe('Graph saved.');
  });

  it('keeps the draft while the file has errors, and says why', async () => {
    dispatch({ kind: 'server', msg: { type: 'graphFileErrors', graphId: 'g', errors: [{ line: 3, message: 'x' }] } });
    const title = el.querySelector('input') as HTMLInputElement;
    await act(async () => type(title, 'Plan more'));
    press('s', title);
    expect(send).not.toHaveBeenCalled();
    expect(getState().toast).toBe("Can't save: g.md has errors. Fix the file first.");
    expect((el.querySelector('input') as HTMLInputElement).value).toBe('Plan more');
  });

  it('in Markdown mode saves the Markdown, and says Saved. when it saved without errors', () => {
    dispatch({ kind: 'setCanvasMode', mode: 'markdown' });
    dispatch({ kind: 'server', msg: { type: 'graphMarkdown', graphId: 'g', text: '# G\n' } });
    dispatch({ kind: 'markdownEdited', text: '# G2\n', from: '# G\n' });
    press('s');
    expect(vi.mocked(send).mock.calls).toEqual([[{ type: 'saveGraphMarkdown', graphId: 'g', text: '# G2\n', base: '# G\n' }]]);
    dispatch({ kind: 'server', msg: { type: 'graphMarkdownSaved', graphId: 'g', ok: true, text: '# G2\n' } });
    expect(getState().toast).toBe('Saved.');
    dispatch({ kind: 'dismissToast' });
    dispatch({ kind: 'server', msg: { type: 'graphMarkdownSaved', graphId: 'g', ok: false, text: '# G2\n', errors: [{ line: 1, message: 'x' }] } });
    expect(getState().toast).toBeUndefined();
  });

  it('File › Save does the same', async () => {
    const title = el.querySelector('input') as HTMLInputElement;
    await act(async () => type(title, 'Saved from the menu'));
    const save = menuItem('file', 'Save');
    expect(save.shortcut).toMatch(/^(⌘|Ctrl\+)S$/);
    act(() => save.run());
    expect(vi.mocked(send).mock.calls[0][0]).toMatchObject({ type: 'op', op: { type: 'updateNode', patch: { title: 'Saved from the menu' } } });
    expect(getState().toast).toBe('Step n1 saved.');
  });
});

describe('⌘Z (spec §6a.2)', () => {
  it('asks the engine to undo, and shows its answer', () => {
    const e = press('z');
    expect(e.defaultPrevented).toBe(true);
    expect(vi.mocked(send).mock.calls).toEqual([[{ type: 'undo', graphId: 'g' }]]);
    dispatch({ kind: 'server', msg: { type: 'undone', graphId: 'g', message: 'Undid moved 2 steps.' } });
    expect(getState().toast).toBe('Undid moved 2 steps.');
  });

  it('is the field’s own text undo inside a text field, and ⇧⌘Z does nothing here', () => {
    const prompt = el.querySelector('textarea') as HTMLTextAreaElement;
    expect(press('z', prompt).defaultPrevented).toBe(false);
    expect(press('z', el.querySelector('input')!).defaultPrevented).toBe(false);
    expect(press('z', document.body, { shift: true }).defaultPrevented).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it('Edit › Undo names what it undoes, and is disabled with nothing to undo', () => {
    expect(menuItem('edit', 'Undo')).toMatchObject({ label: 'Undo', enabled: false });
    dispatch({ kind: 'server', msg: { type: 'undoState', graphId: 'g', label: 'moved 2 steps' } });
    const undo = menuItem('edit', 'Undo');
    expect(undo).toMatchObject({ label: 'Undo moved 2 steps', enabled: true });
    expect(undo.shortcut).toMatch(/^(⌘|Ctrl\+)Z$/);
    act(() => undo.run());
    expect(vi.mocked(send).mock.calls).toEqual([[{ type: 'undo', graphId: 'g' }]]);
    dispatch({ kind: 'server', msg: { type: 'undoState', graphId: 'g' } });
    expect(menuItem('edit', 'Undo').enabled).toBe(false);
  });
});

describe('one action, one undo step', () => {
  it('Tidy sends its moves as one edit', () => {
    actions.tidy();
    const calls = vi.mocked(send).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toMatchObject({ type: 'ops', graphId: 'g', label: 'tidied the layout' });
  });

  it('the Graph panel’s Save of the goal and the instructions is one edit', async () => {
    const panel = document.createElement('div');
    const r = createRoot(panel);
    await act(async () => r.render(createElement(GraphPanel)));
    await act(async () => type(panel.querySelector('#graph-goal') as HTMLInputElement, 'New goal'));
    await act(async () => type(panel.querySelector('#graph-instructions') as HTMLTextAreaElement, 'New instructions'));
    await act(async () => ([...panel.querySelectorAll('button')].find((b) => b.textContent === 'Save') as HTMLButtonElement).click());
    expect(vi.mocked(send).mock.calls).toEqual([
      [{ type: 'ops', graphId: 'g', ops: [{ type: 'setGoal', goal: 'New goal' }, { type: 'setInstructions', instructions: 'New instructions' }], label: 'edited the goal and instructions' }],
    ]);
    await act(async () => r.unmount());
  });

  it('deleting a selection is one edit with its label', () => {
    expect(deletionEdit(['n1', 'n2'], [{ id: 'e', source: 'n3', target: 'n4' }])).toEqual({
      ops: [{ type: 'disconnect', from: 'n3', to: 'n4' }, { type: 'deleteNode', id: 'n1' }, { type: 'deleteNode', id: 'n2' }],
      label: 'deleted 2 steps and 1 connection',
    });
  });
});
