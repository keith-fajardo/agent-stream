// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { emptyGraph, type Graph } from '@agent-stream/shared';

vi.mock('../src/bridge', () => ({ send: vi.fn(), sendHost: vi.fn(), post: vi.fn() }));
const { post } = await import('../src/bridge');
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
