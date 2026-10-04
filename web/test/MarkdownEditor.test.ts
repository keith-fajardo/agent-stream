// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyGraph, type Graph, type HostMessage } from '@agent-stream/shared';

vi.mock('../src/bridge', () => ({ send: vi.fn(), sendHost: vi.fn(), post: vi.fn(), loadViewState: vi.fn(), saveViewState: vi.fn(), bootGraphId: () => 'g' }));
// React Flow needs a real layout: the graph view is a stand-in with the same toggle.
vi.mock('../src/components/Canvas', async () => {
  const { CanvasModeToggle } = await import('../src/components/CanvasModeToggle');
  return { Canvas: () => createElement('div', { className: 'graph-stand-in' }, createElement(CanvasModeToggle)) };
});
const { send, loadViewState, saveViewState } = await import('../src/bridge');
const { dispatch, getState, resetStoreForTests } = await import('../src/store');
const { CanvasArea } = await import('../src/components/CanvasArea');
const { buildMenus } = await import('../src/menuModel');
const { restoreCanvasMode } = await import('../src/panelLayout');
type MenuAction = import('../src/menuModel').MenuAction;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const graph: Graph = emptyGraph('g', 'G', 't');
const FILE = '# G\n\n## Goal\n\nProve it.\n\n## n1 · Plan\n\n- kind: agent\n';
let container: HTMLDivElement;
let root: Root;
const server = (msg: HostMessage) => act(async () => dispatch({ kind: 'server', msg }));
const button = (label: string) => [...container.querySelectorAll('button')].find((b) => b.textContent === label) as HTMLButtonElement | undefined;
const click = (label: string) => act(async () => button(label)!.click());
const editor = () => container.querySelector('textarea[aria-label="Markdown"]') as HTMLTextAreaElement | null;
const sent = (type: string) => vi.mocked(send).mock.calls.map(([m]) => m).filter((m) => m.type === type);
function typeInto(el: HTMLTextAreaElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}
const viewMenu = () => Object.fromEntries(buildMenus(getState()).find((m) => m.id === 'view')!.items.filter((i): i is MenuAction => !('separator' in i)).map((i) => [i.label, i]));

/** In Markdown mode, showing the file. */
async function showMarkdown(text = FILE) {
  await click('Markdown');
  await server({ type: 'graphMarkdown', graphId: 'g', text });
}

beforeEach(async () => {
  vi.mocked(send).mockClear();
  vi.mocked(saveViewState).mockClear();
  vi.mocked(loadViewState).mockReset();
  localStorage.clear();
  resetStoreForTests();
  dispatch({ kind: 'server', msg: { type: 'graphOpened', changes: [], graph, runs: [], variableValues: {} } });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root.render(createElement(CanvasArea)));
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe('Graph | Markdown toggle', () => {
  it('starts on Graph, switches the canvas area, and remembers the choice in this tab only', async () => {
    expect(container.querySelector('.graph-stand-in')).not.toBeNull();
    expect(button('Graph')!.getAttribute('aria-pressed')).toBe('true');
    await click('Markdown');
    expect(container.querySelector('.graph-stand-in')).toBeNull();
    expect(editor()).not.toBeNull();
    expect(button('Markdown')!.getAttribute('aria-pressed')).toBe('true');
    expect(sent('getGraphMarkdown')).toEqual([{ type: 'getGraphMarkdown', graphId: 'g' }]);
    expect(vi.mocked(saveViewState)).toHaveBeenLastCalledWith({ layout: getState().layout, canvasMode: 'markdown' });
    await click('Graph');
    expect(container.querySelector('.graph-stand-in')).not.toBeNull();
    expect(vi.mocked(saveViewState)).toHaveBeenLastCalledWith({ layout: getState().layout });
    // Not shared with other tabs.
    expect(localStorage.length).toBe(0);
  });

  it('comes back in Markdown mode when the tab was left there', () => {
    vi.mocked(loadViewState).mockReturnValue({ canvasMode: 'markdown' });
    restoreCanvasMode();
    expect(getState().canvasMode).toBe('markdown');
    vi.mocked(loadViewState).mockReturnValue({ canvasMode: 'nonsense' });
    restoreCanvasMode();
    expect(getState().canvasMode).toBe('graph');
  });

  it('has a View menu item named for the mode it switches to', async () => {
    expect(viewMenu()['Show as Markdown'].enabled).toBe(true);
    await act(async () => viewMenu()['Show as Markdown'].run());
    expect(editor()).not.toBeNull();
    expect(viewMenu()['Show as Markdown']).toBeUndefined();
    await act(async () => viewMenu()['Show as Graph'].run());
    expect(container.querySelector('.graph-stand-in')).not.toBeNull();
  });
});

describe('Markdown editor', () => {
  it('shows the file exactly, with line numbers, and follows it while there are no unsaved edits', async () => {
    await showMarkdown();
    expect(editor()!.value).toBe(FILE);
    expect(container.querySelector('.markdown-gutter')!.textContent).toBe('1\n2\n3\n4\n5\n6\n7\n8\n9\n10');
    await server({ type: 'graphMarkdown', graphId: 'g', text: FILE.replace('Prove it.', 'Prove it again.') });
    expect(editor()!.value).toContain('Prove it again.');
    await server({ type: 'graphMarkdown', graphId: 'other', text: '# Other\n' });
    expect(editor()!.value).toContain('Prove it again.');
  });

  it('saves with the Save button and with Ctrl+S or Cmd+S, sending the text the editing started from', async () => {
    await showMarkdown();
    expect(button('Save')!.disabled).toBe(true);
    const mine = FILE.replace('Prove it.', 'Prove it well.');
    await act(async () => typeInto(editor()!, mine));
    expect(button('Save')!.disabled).toBe(false);
    await click('Save');
    expect(sent('saveGraphMarkdown')).toEqual([{ type: 'saveGraphMarkdown', graphId: 'g', text: mine, base: FILE }]);
    // The editor shows the file as Agent Stream wrote it back.
    await server({ type: 'graphMarkdown', graphId: 'g', text: `${mine}\n` });
    expect(container.textContent).not.toContain('The file changed since you started editing.');
    await server({ type: 'graphMarkdownSaved', graphId: 'g', ok: true, text: `${mine}\n` });
    expect(editor()!.value).toBe(`${mine}\n`);
    expect(button('Save')!.disabled).toBe(true);
    let base = `${mine}\n`;
    for (const k of [{ ctrlKey: true }, { metaKey: true }]) {
      vi.mocked(send).mockClear();
      await act(async () => typeInto(editor()!, `${base}x`));
      await act(async () => void editor()!.dispatchEvent(new KeyboardEvent('keydown', { key: 's', bubbles: true, cancelable: true, ...k })));
      expect(sent('saveGraphMarkdown')).toEqual([{ type: 'saveGraphMarkdown', graphId: 'g', text: `${base}x`, base }]);
      await server({ type: 'graphMarkdownSaved', graphId: 'g', ok: true, text: `${base}x\n` });
      base = `${base}x\n`;
    }
  });

  it('keeps unsaved edits when the file changes, with Reload and Save anyway', async () => {
    await showMarkdown();
    const mine = FILE.replace('Prove it.', 'Mine.');
    await act(async () => typeInto(editor()!, mine));
    const theirs = FILE.replace('Prove it.', 'Theirs.');
    await server({ type: 'graphMarkdown', graphId: 'g', text: theirs });
    expect(editor()!.value).toBe(mine);
    expect(container.textContent).toContain('The file changed since you started editing.');
    await click('Save anyway');
    expect(sent('saveGraphMarkdown')).toEqual([{ type: 'saveGraphMarkdown', graphId: 'g', text: mine, base: FILE, force: true }]);
    await server({ type: 'graphMarkdownSaved', graphId: 'g', ok: true, text: mine });
    expect(container.textContent).not.toContain('The file changed since you started editing.');
    await act(async () => typeInto(editor()!, `${mine}more`));
    await server({ type: 'graphMarkdown', graphId: 'g', text: theirs });
    await click('Reload');
    expect(editor()!.value).toBe(theirs);
    expect(container.textContent).not.toContain('The file changed since you started editing.');
  });

  it('shows the note when the engine refuses a save because the file changed', async () => {
    await showMarkdown();
    await act(async () => typeInto(editor()!, `${FILE}x`));
    await click('Save');
    await server({ type: 'graphMarkdownSaved', graphId: 'g', ok: false, conflict: true });
    expect(editor()!.value).toBe(`${FILE}x`);
    expect(container.textContent).toContain('The file changed since you started editing.');
    expect(button('Save anyway')).toBeDefined();
  });

  it('lists the file’s errors under the editor, and clicking one puts the cursor on its line', async () => {
    await showMarkdown();
    await server({ type: 'graphFileErrors', graphId: 'g', errors: [{ line: 7, message: 'kind is "robot"; use agent or command.' }] });
    const error = button('line 7: kind is "robot"; use agent or command.');
    expect(error).toBeDefined();
    await act(async () => error!.click());
    const lineStart = FILE.split('\n').slice(0, 6).join('\n').length + 1;
    expect(editor()!.selectionStart).toBe(lineStart);
    expect(document.activeElement).toBe(editor());
  });

  it('asks Save / Discard / Keep editing before switching to Graph with unsaved edits', async () => {
    await showMarkdown();
    await act(async () => typeInto(editor()!, `${FILE}x`));
    await click('Graph');
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    expect([dialogButton('Save'), button('Discard'), button('Keep editing')].every(Boolean)).toBe(true);
    await click('Keep editing');
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(editor()!.value).toBe(`${FILE}x`);

    await click('Graph');
    await act(async () => dialogButton('Save').click());
    expect(sent('saveGraphMarkdown')).toEqual([{ type: 'saveGraphMarkdown', graphId: 'g', text: `${FILE}x`, base: FILE }]);
    expect(editor()).not.toBeNull();
    await server({ type: 'graphMarkdownSaved', graphId: 'g', ok: true, text: `${FILE}x\n` });
    expect(container.querySelector('.graph-stand-in')).not.toBeNull();

    await click('Markdown');
    await act(async () => typeInto(editor()!, `${FILE}y`));
    await act(async () => viewMenu()['Show as Graph'].run());
    await click('Discard');
    expect(container.querySelector('.graph-stand-in')).not.toBeNull();
    await click('Markdown');
    expect(editor()!.value).toBe(`${FILE}x\n`);
  });
});

describe('Markdown editor, after a save with errors or a new engine connection', () => {
  it('stays in Markdown, showing the saved text, when Save from the switch dialog finds errors', async () => {
    await showMarkdown();
    const broken = FILE.replace('- kind: agent', '- kind: robot');
    await act(async () => typeInto(editor()!, broken));
    await click('Graph');
    await act(async () => dialogButton('Save').click());
    await server({ type: 'graphFileErrors', graphId: 'g', errors: [{ line: 9, message: 'kind is "robot"; use agent or command.' }] });
    await server({ type: 'graphMarkdownSaved', graphId: 'g', ok: false, text: broken, errors: [{ line: 9, message: 'kind is "robot"; use agent or command.' }] });
    expect(editor()!.value).toBe(broken);
    expect(button('Save')!.disabled).toBe(true);
    expect(button('line 9: kind is "robot"; use agent or command.')).toBeDefined();
  });

  it('asks for the file again when the engine says hello, keeping unsaved edits', async () => {
    await showMarkdown();
    await act(async () => typeInto(editor()!, `${FILE}x`));
    vi.mocked(send).mockClear();
    await server({ type: 'hello', status: { provider: 'claude', ok: true, label: 'Claude Max' }, project: '/p', graphs: [], approvals: [] });
    expect(sent('getGraphMarkdown')).toEqual([{ type: 'getGraphMarkdown', graphId: 'g' }]);
    expect(editor()!.value).toBe(`${FILE}x`);
  });
});

function dialogButton(label: string): HTMLButtonElement {
  return [...container.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent === label) as HTMLButtonElement;
}
