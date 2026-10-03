// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { emptyGraph, type Graph } from '@agent-stream/shared';

vi.mock('../src/bridge', () => ({ send: vi.fn(), sendHost: vi.fn(), post: vi.fn() }));
const { post, send } = await import('../src/bridge');
const { dispatch, getState } = await import('../src/store');
const { NodePanel } = await import('../src/components/NodePanel');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const step = { id: 'n1', title: 'Plan', kind: 'agent' as const, prompt: 'p', createdBy: 'user' as const, updatedBy: 'user' as const, updatedAt: 't' };
const graph: Graph = { ...emptyGraph('g', 'G', 't'), nodes: [step] };

describe('NodePanel draftState', () => {
  it('reports when the draft turns dirty or clean, and clean on unmount', async () => {
    dispatch({ kind: 'server', msg: { type: 'graphOpened', changes: [], graph, runs: [], variableValues: {} } });
    dispatch({ kind: 'selectNode', id: 'n1' });
    const el = document.createElement('div');
    const root = createRoot(el);
    await act(async () => root.render(createElement(NodePanel)));
    const title = el.querySelector('input') as HTMLInputElement;
    const set = (v: string) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(title, v);
      title.dispatchEvent(new Event('input', { bubbles: true }));
    };
    await act(async () => set('Plan more'));
    expect(vi.mocked(post)).toHaveBeenLastCalledWith({ type: 'draftState', dirty: true });
    await act(async () => set('Plan'));
    expect(vi.mocked(post)).toHaveBeenLastCalledWith({ type: 'draftState', dirty: false });
    await act(async () => set('Plan again'));
    await act(async () => root.unmount());
    expect(vi.mocked(post)).toHaveBeenLastCalledWith({ type: 'draftState', dirty: false });
  });
});

describe('NodePanel description', () => {
  it('shows the description and saves only it when only it changed', async () => {
    const described: Graph = { ...graph, nodes: [{ ...step, description: 'Plans the work.' }] };
    dispatch({ kind: 'server', msg: { type: 'graphOpened', changes: [], graph: described, runs: [], variableValues: {} } });
    dispatch({ kind: 'selectNode', id: 'n1' });
    vi.mocked(send).mockClear();
    const el = document.createElement('div');
    const root = createRoot(el);
    await act(async () => root.render(createElement(NodePanel)));
    const field = el.querySelector('textarea#node-description') as HTMLTextAreaElement;
    expect(field.value).toBe('Plans the work.');
    expect(field.maxLength).toBe(2000);
    expect(field.placeholder).toBe('In plain words: what this step does and why');
    const labels = [...el.querySelectorAll('.field label')].map((l) => l.textContent);
    expect(labels.slice(0, 3)).toEqual(['Title', 'Description', 'Kind']);
    const save = [...el.querySelectorAll('button')].find((b) => b.textContent === 'Save') as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, 'Plans the work for the new model.');
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => save.click());
    expect(vi.mocked(send).mock.calls).toEqual([
      [{ type: 'op', graphId: 'g', op: { type: 'updateNode', id: 'n1', patch: { description: 'Plans the work for the new model.' } } }],
    ]);
    await act(async () => root.unmount());
  });
});

describe('NodePanel Refine with planner', () => {
  const hello = (ok: boolean) =>
    dispatch({
      kind: 'server',
      msg: { type: 'hello', status: ok ? { provider: 'claude', ok, label: 'Claude Max' } : { provider: 'claude', ok, label: 'not signed in', error: 'x' }, project: '/p', graphs: [], approvals: [] },
    });
  async function mount(node: Graph['nodes'][number]) {
    dispatch({ kind: 'server', msg: { type: 'graphOpened', changes: [], graph: { ...graph, nodes: [node] }, runs: [], variableValues: {} } });
    dispatch({ kind: 'selectNode', id: node.id });
    vi.mocked(send).mockClear();
    vi.mocked(post).mockClear();
    const el = document.createElement('div');
    const root = createRoot(el);
    await act(async () => root.render(createElement(NodePanel)));
    const button = (label: string) => [...el.querySelectorAll('button')].find((b) => b.textContent === label) as HTMLButtonElement | undefined;
    return { el, root, button };
  }

  it('asks the planner to refine the selected step', async () => {
    hello(true);
    const { root, button } = await mount(step);
    await act(async () => button('Refine with planner')!.click());
    expect(vi.mocked(post)).toHaveBeenCalledWith({ type: 'refineSteps', nodeIds: ['n1'] });
    expect(vi.mocked(send)).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });

  it('saves first when there are unsaved edits, then asks to refine', async () => {
    hello(true);
    const { el, root, button } = await mount(step);
    const field = el.querySelector('textarea#node-description') as HTMLTextAreaElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, 'Compare the tables.');
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(button('Refine with planner')).toBeUndefined();
    await act(async () => button('Save and refine')!.click());
    expect(vi.mocked(send).mock.calls).toEqual([[{ type: 'op', graphId: 'g', op: { type: 'updateNode', id: 'n1', patch: { description: 'Compare the tables.' } } }]]);
    expect(vi.mocked(post)).toHaveBeenCalledWith({ type: 'refineSteps', nodeIds: ['n1'] });
    expect(vi.mocked(send).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(post).mock.invocationCallOrder.at(-1)!);
    await act(async () => root.unmount());
  });

  it('is disabled for a title-only step and when the provider is not signed in', async () => {
    hello(true);
    const titleOnly = await mount({ ...step, prompt: undefined });
    expect(titleOnly.button('Refine with planner')!.disabled).toBe(true);
    expect(titleOnly.button('Refine with planner')!.title).toBe('Write what the step should do first.');
    await act(async () => titleOnly.root.unmount());
    hello(false);
    const signedOut = await mount(step);
    expect(signedOut.button('Refine with planner')!.disabled).toBe(true);
    expect(signedOut.button('Refine with planner')!.title).toBe('x');
    await act(async () => signedOut.root.unmount());
    hello(true);
  });
});

describe('NodePanel agent-change banner', () => {
  const baseline: Graph = { ...graph, nodes: [{ ...step, prompt: 'old' }] };
  const changed = { ...step, prompt: 'new' };
  const changes = (by?: import('@agent-stream/shared').ChangeSource) => [{ kind: 'node' as const, change: 'changed' as const, id: 'n1', title: 'Plan', fields: ['prompt' as const, 'title' as const], ...(by ? { by } : {}) }];
  async function mount(c: ReturnType<typeof changes>) {
    dispatch({ kind: 'server', msg: { type: 'graphOpened', graph: { ...graph, nodes: [changed] }, baseline, changes: c, runs: [], variableValues: {} } });
    dispatch({ kind: 'selectNode', id: 'n1' });
    dispatch({ kind: 'setTab', tab: 'node' });
    vi.mocked(send).mockClear();
    const el = document.createElement('div');
    const root = createRoot(el);
    await act(async () => root.render(createElement(NodePanel)));
    const button = (label: string) => [...el.querySelectorAll('button')].find((b) => b.textContent === label) as HTMLButtonElement | undefined;
    return { el, root, button };
  }

  it('says who changed the step and what, and lets you review, accept or revert it', async () => {
    const { el, root, button } = await mount(changes({ kind: 'planner' }));
    expect(el.querySelector('.change-banner')!.textContent).toContain('Changed by planner: prompt, title');
    await act(async () => button('Accept')!.click());
    await act(async () => button('Revert')!.click());
    expect(vi.mocked(send).mock.calls).toEqual([
      [{ type: 'op', graphId: 'g', op: { type: 'acceptChange', target: { kind: 'node', id: 'n1' } } }],
      [{ type: 'op', graphId: 'g', op: { type: 'revertChange', target: { kind: 'node', id: 'n1' } } }],
    ]);
    await act(async () => button('Show before/after')!.click());
    expect(getState().tab).toBe('changes');
    expect(getState().selectedChange).toBe('node:n1');
    await act(async () => root.unmount());
  });

  it('never says "by planner" when the author is unknown', async () => {
    const { el, root } = await mount(changes());
    const text = el.querySelector('.change-banner')!.textContent!;
    expect(text).toContain('Changed: prompt, title');
    expect(text).not.toContain('planner');
    await act(async () => root.unmount());
  });

  it('shows no banner for a step with no change', async () => {
    const { el, root } = await mount([]);
    expect(el.querySelector('.change-banner')).toBeNull();
    await act(async () => root.unmount());
  });
});

describe('NodePanel access and workspace', () => {
  const change = (el: HTMLInputElement | HTMLSelectElement, value: string) => {
    const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
  };
  async function render(g: Graph, id = 'n1') {
    dispatch({ kind: 'server', msg: { type: 'graphOpened', changes: [], graph: g, runs: [], variableValues: {} } });
    dispatch({ kind: 'selectNode', id });
    vi.mocked(send).mockClear();
    const el = document.createElement('div');
    const root = createRoot(el);
    await act(async () => root.render(createElement(NodePanel)));
    const save = () => [...el.querySelectorAll('button')].find((b) => b.textContent === 'Save') as HTMLButtonElement;
    return { el, root, save };
  }

  it('puts the Access select after Kind and the Workspace field after it, and saves Read-only in the draft', async () => {
    const { el, root, save } = await render(graph);
    expect([...el.querySelectorAll('.field label')].map((l) => l.textContent).slice(0, 5)).toEqual(['Title', 'Description', 'Kind', 'Access', 'Workspace']);
    const access = el.querySelector('select#node-access') as HTMLSelectElement;
    expect([...access.options].map((o) => o.textContent)).toEqual(['Can edit files', 'Read-only']);
    expect(access.value).toBe('write');
    await act(async () => change(access, 'read'));
    expect(save().disabled).toBe(false);
    await act(async () => save().click());
    expect(send).toHaveBeenCalledWith({ type: 'op', graphId: 'g', op: { type: 'updateNode', id: 'n1', patch: { access: 'read' } } });
    await act(async () => root.unmount());
  });

  it('says command steps can change files instead of offering the select', async () => {
    const commandGraph: Graph = { ...graph, nodes: [{ id: 'n1', title: 'Build', kind: 'command', command: 'make', createdBy: 'user', updatedBy: 'user', updatedAt: 't' }] };
    const { el, root } = await render(commandGraph);
    expect(el.querySelector('select#node-access')).toBeNull();
    expect(el.querySelector('.static-note')?.textContent).toBe('Command steps can change files');
    await act(async () => root.unmount());
  });

  it("edits the workspace in the draft, suggests the graph's workspace names, and clears it with an empty value", async () => {
    const g: Graph = { ...graph, nodes: [{ ...step, workspace: 'wh_small' }, { ...step, id: 'n2', workspace: 'wh_large' }, { ...step, id: 'n3' }] };
    const { el, root, save } = await render(g);
    const field = el.querySelector('input#node-workspace') as HTMLInputElement;
    expect(field.value).toBe('wh_small');
    expect(field.placeholder).toBe('This checkout');
    expect(field.getAttribute('list')).toBe('workspace-names');
    expect([...el.querySelectorAll('datalist#workspace-names option')].map((o) => (o as HTMLOptionElement).value)).toEqual(['wh_large', 'wh_small']);
    await act(async () => change(field, ''));
    await act(async () => save().click());
    expect(send).toHaveBeenCalledWith({ type: 'op', graphId: 'g', op: { type: 'updateNode', id: 'n1', patch: { workspace: '' } } });
    await act(async () => root.unmount());
  });
});
