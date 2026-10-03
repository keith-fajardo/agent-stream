// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelChoice } from '@agent-stream/shared';
import { ChatApp } from '../src/ChatApp';
import { dispatch, resetStoreForTests } from '../src/store';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const posted: unknown[] = [];
(globalThis as { acquireVsCodeApi?: unknown }).acquireVsCodeApi = () => ({ postMessage: (m: unknown) => posted.push(m) });
Element.prototype.scrollIntoView = vi.fn();

const target = { graphId: 'g1', graphName: 'Orders parity', sessionId: 'default', sessionName: 'Default' };
const MODELS: ModelChoice[] = [
  { value: 'sonnet', label: 'Sonnet', efforts: ['low', 'high'] },
  { value: 'haiku', label: 'Haiku', efforts: [] },
];
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
      dispatch({ kind: 'server', msg: { type: 'hello', status: { provider: 'copilot', ok: false, label: 'Copilot not available', error: "Copilot support isn't implemented yet." }, project: '/p', graphs: [], approvals: [] } });
      dispatch({ kind: 'server', msg: { type: 'chatTarget', target } });
    });
    const box = el.querySelector('textarea')!;
    expect(box.disabled).toBe(true);
    expect(box.placeholder).toBe("Copilot support isn't implemented yet.");
  });
  it('offers Default plus the provider’s models, and Effort only for a model with levels', async () => {
    const el = await render();
    await act(async () => {
      dispatch({ kind: 'server', msg: { type: 'hello', status: { provider: 'claude', ok: true, label: 'Claude Max' }, project: '/p', graphs: [], approvals: [] } });
      dispatch({ kind: 'server', msg: { type: 'chatTarget', target } });
      dispatch({ kind: 'server', msg: { type: 'chatOpened', graphId: 'g1', sessionId: 'default', chat: [], busy: false } });
      dispatch({ kind: 'server', msg: { type: 'models', provider: 'claude', models: MODELS, defaultEfforts: [] } });
    });
    const model = el.querySelector('select[aria-label="Model"]') as HTMLSelectElement;
    expect([...model.options].map((o) => o.textContent)).toEqual(['Default', 'Sonnet', 'Haiku']);
    expect(model.value).toBe('');
    expect(el.querySelector('select[aria-label="Effort"]')).toBeNull();
    // The engine confirms a choice; the menus follow it.
    await act(async () => dispatch({ kind: 'server', msg: { type: 'plannerModel', graphId: 'g1', sessionId: 'default', model: 'sonnet', effort: 'high' } }));
    const effort = el.querySelector('select[aria-label="Effort"]') as HTMLSelectElement;
    expect(model.value).toBe('sonnet');
    expect([...effort.options].map((o) => o.textContent)).toEqual(['Default', 'low', 'high']);
    expect(effort.value).toBe('high');
    await act(async () => dispatch({ kind: 'server', msg: { type: 'plannerModel', graphId: 'g1', sessionId: 'default', model: 'haiku' } }));
    expect(el.querySelector('select[aria-label="Effort"]')).toBeNull();
  });

  it('sends the choice for its conversation, dropping an effort the new model lacks', async () => {
    const el = await render();
    await act(async () => {
      dispatch({ kind: 'server', msg: { type: 'chatTarget', target } });
      dispatch({ kind: 'server', msg: { type: 'chatOpened', graphId: 'g1', sessionId: 'default', chat: [], busy: false, model: 'sonnet', effort: 'low' } });
      dispatch({ kind: 'server', msg: { type: 'models', provider: 'claude', models: MODELS, defaultEfforts: [] } });
    });
    const pick = async (label: string, value: string) => {
      const select = el.querySelector(`select[aria-label="${label}"]`) as HTMLSelectElement;
      await act(async () => {
        select.value = value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
      });
    };
    await pick('Effort', 'high');
    expect(posted.at(-1)).toEqual({ type: 'setPlannerModel', graphId: 'g1', sessionId: 'default', model: 'sonnet', effort: 'high' });
    await pick('Model', 'haiku');
    expect(posted.at(-1)).toEqual({ type: 'setPlannerModel', graphId: 'g1', sessionId: 'default', model: 'haiku' });
    await pick('Model', '');
    expect(posted.at(-1)).toEqual({ type: 'setPlannerModel', graphId: 'g1', sessionId: 'default' });
    await pick('Effort', '');
    expect(posted.at(-1)).toEqual({ type: 'setPlannerModel', graphId: 'g1', sessionId: 'default', model: 'sonnet' });
  });

  it('keeps showing a saved model the list no longer offers, and marks models that can’t run', async () => {
    const el = await render();
    await act(async () => {
      dispatch({ kind: 'server', msg: { type: 'chatTarget', target } });
      dispatch({ kind: 'server', msg: { type: 'chatOpened', graphId: 'g1', sessionId: 'default', chat: [], busy: false, model: 'old-model' } });
      dispatch({ kind: 'server', msg: { type: 'models', provider: 'copilot', models: [{ value: 'gpt', label: 'GPT', efforts: [], unavailable: true }], defaultEfforts: [] } });
    });
    const model = el.querySelector('select[aria-label="Model"]') as HTMLSelectElement;
    expect(model.value).toBe('old-model');
    expect([...model.options].map((o) => [o.textContent, o.disabled])).toEqual([
      ['Default', false],
      ['GPT (unavailable)', true],
      ['old-model', false],
    ]);
  });
  const pickIn = (el: HTMLElement) => async (label: string, value: string) => {
    const select = el.querySelector(`select[aria-label="${label}"]`) as HTMLSelectElement;
    await act(async () => {
      select.value = value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
  };
  const options = (el: HTMLElement, label: string) => [...(el.querySelector(`select[aria-label="${label}"]`) as HTMLSelectElement).options].map((o) => o.textContent);

  it("merges Claude Code's default row into Default, which offers that row's levels", async () => {
    const el = await render();
    const listed: ModelChoice[] = [{ value: 'default', label: 'Default (recommended)', efforts: ['low', 'max'] }, ...MODELS];
    await act(async () => {
      dispatch({ kind: 'server', msg: { type: 'chatTarget', target } });
      dispatch({ kind: 'server', msg: { type: 'chatOpened', graphId: 'g1', sessionId: 'default', chat: [], busy: false } });
      dispatch({ kind: 'server', msg: { type: 'models', provider: 'claude', models: listed, defaultEfforts: ['low', 'max'] } });
    });
    expect(options(el, 'Model')).toEqual(['Default', 'Sonnet', 'Haiku']);
    expect(options(el, 'Effort')).toEqual(['Default', 'low', 'max']);
    await pickIn(el)('Effort', 'max');
    expect(posted.at(-1)).toEqual({ type: 'setPlannerModel', graphId: 'g1', sessionId: 'default', effort: 'max' });
    // Back to Default from a model: an effort Default offers is kept.
    await act(async () => dispatch({ kind: 'server', msg: { type: 'plannerModel', graphId: 'g1', sessionId: 'default', model: 'sonnet', effort: 'low' } }));
    await pickIn(el)('Model', '');
    expect(posted.at(-1)).toEqual({ type: 'setPlannerModel', graphId: 'g1', sessionId: 'default', effort: 'low' });
  });

  it('never hides a saved effort: a model the list lacks still shows it, so it can be cleared', async () => {
    const el = await render();
    await act(async () => {
      dispatch({ kind: 'server', msg: { type: 'chatTarget', target } });
      dispatch({ kind: 'server', msg: { type: 'chatOpened', graphId: 'g1', sessionId: 'default', chat: [], busy: false, model: 'old-model', effort: 'high' } });
      dispatch({ kind: 'server', msg: { type: 'models', provider: 'claude', models: [], defaultEfforts: [] } });
    });
    expect(options(el, 'Effort')).toEqual(['Default', 'high']);
    expect((el.querySelector('select[aria-label="Effort"]') as HTMLSelectElement).value).toBe('high');
    await pickIn(el)('Effort', '');
    expect(posted.at(-1)).toEqual({ type: 'setPlannerModel', graphId: 'g1', sessionId: 'default', model: 'old-model' });
  });

  it('gives a full model id the levels of the alias row it resolves to', async () => {
    const el = await render();
    const listed: ModelChoice[] = [{ value: 'sonnet', label: 'Sonnet', resolved: 'claude-sonnet-5', efforts: ['low', 'high'] }];
    await act(async () => {
      dispatch({ kind: 'server', msg: { type: 'chatTarget', target } });
      dispatch({ kind: 'server', msg: { type: 'chatOpened', graphId: 'g1', sessionId: 'default', chat: [], busy: false, model: 'claude-sonnet-5' } });
      dispatch({ kind: 'server', msg: { type: 'models', provider: 'claude', models: listed, defaultEfforts: [] } });
    });
    expect((el.querySelector('select[aria-label="Model"]') as HTMLSelectElement).value).toBe('claude-sonnet-5');
    expect(options(el, 'Effort')).toEqual(['Default', 'low', 'high']);
  });
});
