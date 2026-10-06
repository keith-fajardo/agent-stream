// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyGraph, type Graph } from '@agent-stream/shared';

vi.mock('../src/bridge', () => ({ send: vi.fn(), sendHost: vi.fn(), post: vi.fn() }));
const { post, send } = await import('../src/bridge');
const { dispatch, getState } = await import('../src/store');
const { NodePanel } = await import('../src/components/NodePanel');
const { GraphPanel } = await import('../src/components/GraphPanel');
const { ChatPanel } = await import('../src/components/ChatPanel');
const { readUploads } = await import('../src/uploads');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// jsdom lays nothing out: the chat's scroll to its last line does nothing here.
Element.prototype.scrollIntoView = () => {};

const agent = { id: 'n1', title: 'Design', kind: 'agent' as const, prompt: 'p', attachments: ['mockup.png'], createdBy: 'user' as const, updatedBy: 'user' as const, updatedAt: 't' };
const graph: Graph = { ...emptyGraph('g', 'G', 't'), attachments: ['brief.pdf'], nodes: [agent, { ...agent, id: 'n2', kind: 'command', prompt: undefined, command: 'ls', attachments: undefined }] };
let el: HTMLDivElement | undefined;
let root: Root | undefined;
async function mount(c: () => React.ReactElement | null): Promise<HTMLDivElement> {
  const div = document.createElement('div');
  document.body.appendChild(div);
  const r = createRoot(div);
  el = div;
  root = r;
  await act(async () => r.render(createElement(c)));
  return div;
}
const button = (label: string) => [...el!.querySelectorAll('button')].find((b) => b.textContent === label || b.getAttribute('aria-label') === label) as HTMLButtonElement | undefined;
/** A drop of files, as a browser sends it. */
function drop(target: Element, files: File[]) {
  const e = new Event('drop', { bubbles: true, cancelable: true }) as Event & { dataTransfer: unknown };
  e.dataTransfer = { files, types: ['Files'] };
  target.dispatchEvent(e);
}
const flush = () => act(async () => new Promise((r) => setTimeout(r, 0)));

beforeEach(() => {
  vi.mocked(send).mockClear();
  vi.mocked(post).mockClear();
  dispatch({ kind: 'server', msg: { type: 'hello', status: { provider: 'claude', ok: true, label: 'Claude Max' }, project: '/p', graphs: [], approvals: [] } });
  dispatch({ kind: 'server', msg: { type: 'graphOpened', changes: [], graph, runs: [], variableValues: {} } });
  dispatch({ kind: 'dismissToast' });
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  el?.remove();
  root = undefined;
  el = undefined;
});

describe('files checked in the tab before sending (step model spec §6b.4)', () => {
  it('reads files as base64, and refuses a type, a size or one too many', async () => {
    expect(await readUploads([new File(['hi'], 'notes.md')], 20)).toEqual({ ok: true, uploads: [{ name: 'notes.md', data: btoa('hi') }] });
    expect(await readUploads([new File(['MZ'], 'tool.exe')], 20)).toEqual({ ok: false, error: expect.stringContaining("tool.exe can't be attached.") });
    const big = new File(['x'], 'big.pdf');
    Object.defineProperty(big, 'size', { value: 5 * 1024 * 1024 + 1 });
    expect(await readUploads([big], 20)).toEqual({ ok: false, error: 'big.pdf is larger than 5 MB.' });
    expect(await readUploads([new File(['a'], 'a.md'), new File(['b'], 'b.md')], 1)).toEqual({ ok: false, error: 'Only 1 more can be attached here (at most 20).' });
  });
});

describe('a step’s attachments in the Node panel', () => {
  it('lists them with Open and Remove, and Add… asks the extension for VS Code’s file picker', async () => {
    dispatch({ kind: 'selectNode', id: 'n1' });
    const el = await mount(NodePanel);
    expect(el.querySelector('.attachment-list')?.textContent).toContain('mockup.png');
    await act(async () => button('Open')!.click());
    expect(post).toHaveBeenCalledWith({ type: 'openAttachment', name: 'mockup.png' });
    await act(async () => button('Remove mockup.png')!.click());
    expect(send).toHaveBeenCalledWith({ type: 'detach', graphId: 'g', target: { kind: 'step', nodeId: 'n1' }, name: 'mockup.png' });
    await act(async () => button('Add…')!.click());
    expect(post).toHaveBeenCalledWith({ type: 'pickAttachments', target: { kind: 'step', nodeId: 'n1' } });
  });

  it('attaches dropped files, and refuses one it can’t take with a toast, sending nothing', async () => {
    dispatch({ kind: 'selectNode', id: 'n1' });
    const el = await mount(NodePanel);
    const list = el.querySelector('.attachments')!;
    await act(async () => drop(list, [new File(['png'], 'shot.png')]));
    await flush();
    expect(send).toHaveBeenCalledWith({ type: 'attach', graphId: 'g', target: { kind: 'step', nodeId: 'n1' }, files: [{ name: 'shot.png', data: btoa('png') }] });
    vi.mocked(send).mockClear();
    await act(async () => drop(list, [new File(['MZ'], 'tool.exe')]));
    await flush();
    expect(send).not.toHaveBeenCalled();
    expect(getState().toast).toContain("tool.exe can't be attached.");
  });

  it('has none for a command step', async () => {
    dispatch({ kind: 'selectNode', id: 'n2' });
    const el = await mount(NodePanel);
    expect(el.querySelector('.attachments')).toBeNull();
  });

  it('shows the one-time notice the engine sends with the first attachment', () => {
    dispatch({ kind: 'server', msg: { type: 'attached', graphId: 'g', target: { kind: 'graph' }, names: ['a.png'], notice: "Attachments are saved with the graph (and committed) and sent to your AI provider. Don't attach secrets." } });
    expect(getState().toast).toBe("Attachments are saved with the graph (and committed) and sent to your AI provider. Don't attach secrets.");
  });
});

describe('the graph’s attachments in the Graph panel', () => {
  it('lists them and removes one from the graph', async () => {
    const el = await mount(GraphPanel);
    expect(el.querySelector('.attachment-list')?.textContent).toContain('brief.pdf');
    await act(async () => button('Remove brief.pdf')!.click());
    expect(send).toHaveBeenCalledWith({ type: 'detach', graphId: 'g', target: { kind: 'graph' }, name: 'brief.pdf' });
  });
});

describe('chat attachments', () => {
  beforeEach(() => {
    dispatch({ kind: 'server', msg: { type: 'chatTarget', target: { graphId: 'g', graphName: 'G', sessionId: 'default', sessionName: 'Default' } } });
  });

  it('sends picked files with the next message only, and the chat shows them on it', async () => {
    const el = await mount(ChatPanel);
    const input = el.querySelector('input[type=file]') as HTMLInputElement;
    Object.defineProperty(input, 'files', { value: [new File(['png'], 'shot.png')], configurable: true });
    await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
    await flush();
    expect(el.querySelector('.chat-pending')?.textContent).toContain('shot.png');
    const box = el.querySelector('textarea') as HTMLTextAreaElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(box, 'What is this?');
      box.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => button('Send')!.click());
    expect(send).toHaveBeenCalledWith({ type: 'chat', graphId: 'g', sessionId: 'default', text: 'What is this?', attachments: [{ name: 'shot.png', data: btoa('png') }] });
    expect(el.querySelector('.chat-pending')).toBeNull();
    await act(async () => dispatch({ kind: 'server', msg: { type: 'chatEntry', graphId: 'g', sessionId: 'default', entry: { at: 't', role: 'user', text: 'What is this?', attachments: ['shot.png'] } } }));
    expect(el.querySelector('.msg.user .attachment-chip')?.textContent).toBe('📎 shot.png');
  });

  it('refuses a file it can’t take before sending, and a pending file can be removed', async () => {
    const el = await mount(ChatPanel);
    const inputArea = el.querySelector('.chat-input')!;
    await act(async () => drop(inputArea, [new File(['MZ'], 'tool.exe')]));
    await flush();
    expect(el.querySelector('.chat-pending .field-error')?.textContent).toContain("tool.exe can't be attached.");
    await act(async () => drop(inputArea, [new File(['a'], 'a.md')]));
    await flush();
    await act(async () => button('Remove a.md')!.click());
    expect(el.querySelector('.chat-pending')).toBeNull();
  });
});
