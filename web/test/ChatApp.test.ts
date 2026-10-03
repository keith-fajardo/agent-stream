// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatApp } from '../src/ChatApp';
import { dispatch, resetStoreForTests } from '../src/store';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const posted: unknown[] = [];
(globalThis as { acquireVsCodeApi?: unknown }).acquireVsCodeApi = () => ({ postMessage: (m: unknown) => posted.push(m) });
Element.prototype.scrollIntoView = vi.fn();

const target = { graphId: 'g1', graphName: 'Orders parity', sessionId: 'default', sessionName: 'Default' };
async function render() {
  const el = document.createElement('div');
  await act(async () => createRoot(el).render(createElement(ChatApp)));
  return el;
}

describe('ChatApp', () => {
  beforeEach(() => {
    posted.length = 0;
    resetStoreForTests();
  });
  it('asks for a graph when there is none', async () => {
    const el = await render();
    expect(el.textContent).toContain('Open a graph to chat with the planner.');
  });
  it('shows the graph, the session and the conversation for its target', async () => {
    const el = await render();
    await act(async () => {
      dispatch({ kind: 'server', msg: { type: 'hello', status: { provider: 'claude', ok: true, label: 'Claude Max' }, project: '/p', graphs: [], approvals: [] } });
      dispatch({ kind: 'server', msg: { type: 'chatTarget', target } });
      dispatch({ kind: 'server', msg: { type: 'chatOpened', graphId: 'g1', sessionId: 'default', chat: [{ at: 't', role: 'user', text: 'hello' }], busy: false } });
    });
    expect(el.querySelector('.chat-head')?.textContent).toContain('Orders parity');
    expect(el.querySelector('.chat-head')?.textContent).toContain('Default');
    expect(el.textContent).toContain('hello');
  });
  it('sends chat for its target and runs the header commands through the extension', async () => {
    const el = await render();
    await act(async () => {
      dispatch({ kind: 'server', msg: { type: 'hello', status: { provider: 'claude', ok: true, label: 'Claude Max' }, project: '/p', graphs: [], approvals: [] } });
      dispatch({ kind: 'server', msg: { type: 'chatTarget', target } });
    });
    const box = el.querySelector('textarea')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
      setter.call(box, 'plan it');
      box.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    expect(posted).toContainEqual({ type: 'chat', graphId: 'g1', sessionId: 'default', text: 'plan it' });
    await act(async () => (el.querySelector('[data-action="newChat"]') as HTMLButtonElement).click());
    await act(async () => (el.querySelector('[data-action="switchSession"]') as HTMLButtonElement).click());
    expect(posted).toContainEqual({ type: 'chatCommand', command: 'newChat' });
    expect(posted).toContainEqual({ type: 'chatCommand', command: 'switchSession' });
  });
  it('disables input with the provider’s reason', async () => {
    const el = await render();
    await act(async () => {
      dispatch({ kind: 'server', msg: { type: 'hello', status: { provider: 'copilot', ok: false, preview: true, label: 'Copilot (preview)', error: "Copilot support isn't implemented yet." }, project: '/p', graphs: [], approvals: [] } });
      dispatch({ kind: 'server', msg: { type: 'chatTarget', target } });
    });
    const box = el.querySelector('textarea')!;
    expect(box.disabled).toBe(true);
    expect(box.placeholder).toBe("Copilot support isn't implemented yet.");
  });
});
