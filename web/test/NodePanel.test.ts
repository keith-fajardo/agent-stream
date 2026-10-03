// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { emptyGraph, type Graph } from '@agent-stream/shared';

vi.mock('../src/bridge', () => ({ send: vi.fn(), sendHost: vi.fn(), post: vi.fn() }));
const { post, send } = await import('../src/bridge');
const { dispatch } = await import('../src/store');
const { NodePanel } = await import('../src/components/NodePanel');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const step = { id: 'n1', title: 'Plan', kind: 'agent' as const, prompt: 'p', createdBy: 'user' as const, updatedBy: 'user' as const, updatedAt: 't' };
const graph: Graph = { ...emptyGraph('g', 'G', 't'), nodes: [step] };

describe('NodePanel draftState', () => {
  it('reports when the draft turns dirty or clean, and clean on unmount', async () => {
    dispatch({ kind: 'server', msg: { type: 'graphOpened', graph, runs: [], variableValues: {} } });
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
    dispatch({ kind: 'server', msg: { type: 'graphOpened', graph: described, runs: [], variableValues: {} } });
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
