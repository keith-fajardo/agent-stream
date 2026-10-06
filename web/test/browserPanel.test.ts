// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { ReactFlowProvider, type NodeProps } from '@xyflow/react';
import { describe, expect, it, vi } from 'vitest';
import { emptyGraph, type Graph, type GraphNode } from '@agent-stream/shared';

vi.mock('../src/bridge', () => ({ send: vi.fn(), sendHost: vi.fn(), post: vi.fn() }));
const { send } = await import('../src/bridge');
const { dispatch } = await import('../src/store');
const { NodePanel } = await import('../src/components/NodePanel');
const { StepNode } = await import('../src/components/StepNode');
type StepFlowNode = import('../src/components/StepNode').StepFlowNode;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const step = (over: Partial<GraphNode> = {}): GraphNode => ({ id: 'n1', title: 'Research', kind: 'agent', prompt: 'p', createdBy: 'user', updatedBy: 'user', updatedAt: 't', ...over });
const graphWith = (node: GraphNode): Graph => ({ ...emptyGraph('g', 'G', 't'), nodes: [node] });

async function panel(node: GraphNode) {
  dispatch({ kind: 'server', msg: { type: 'graphOpened', changes: [], graph: graphWith(node), runs: [], variableValues: {} } });
  dispatch({ kind: 'selectNode', id: node.id });
  const el = document.createElement('div');
  const root = createRoot(el);
  await act(async () => root.render(createElement(NodePanel)));
  return { el, done: () => act(async () => root.unmount()) };
}
const save = (el: HTMLElement) => [...el.querySelectorAll('button')].find((b) => b.textContent === 'Save') as HTMLButtonElement;

describe('Node panel: Browser', () => {
  it('an agent step has a Browser switch with its hint, after Model and Effort', async () => {
    const { el, done } = await panel(step());
    const sw = el.querySelector('#node-browser') as HTMLInputElement;
    expect(sw.type).toBe('checkbox');
    expect(sw.getAttribute('role')).toBe('switch');
    expect(sw.checked).toBe(false);
    const labels = [...el.querySelectorAll('.field label')].map((l) => l.textContent);
    expect(labels.indexOf('Browser')).toBeGreaterThan(labels.indexOf('Effort'));
    expect(el.textContent).toContain('Lets this step use the Agent Stream browser, with your logins. Clicking and typing ask you first.');
    await done();
  });

  it('turning it on and saving sends browser: true; off sends false', async () => {
    const on = await panel(step());
    vi.mocked(send).mockClear();
    await act(async () => (on.el.querySelector('#node-browser') as HTMLInputElement).click());
    await act(async () => save(on.el).click());
    expect(send).toHaveBeenCalledWith({ type: 'op', graphId: 'g', op: { type: 'updateNode', id: 'n1', patch: { browser: true } } });
    await on.done();
    const off = await panel(step({ browser: true }));
    expect((off.el.querySelector('#node-browser') as HTMLInputElement).checked).toBe(true);
    vi.mocked(send).mockClear();
    await act(async () => (off.el.querySelector('#node-browser') as HTMLInputElement).click());
    await act(async () => save(off.el).click());
    expect(send).toHaveBeenCalledWith({ type: 'op', graphId: 'g', op: { type: 'updateNode', id: 'n1', patch: { browser: false } } });
    await off.done();
  });

  it('a command step has no Browser switch', async () => {
    const { el, done } = await panel(step({ kind: 'command', command: 'ls', prompt: undefined }));
    expect(el.querySelector('#node-browser')).toBeNull();
    await done();
  });
});

describe('canvas card: 🌐', () => {
  async function card(node: GraphNode) {
    const el = document.createElement('div');
    const root = createRoot(el);
    const props = { id: node.id, data: { node, waiting: false }, selected: false } as unknown as NodeProps<StepFlowNode>;
    await act(async () => root.render(createElement(ReactFlowProvider, null, createElement(StepNode, props))));
    const badge = el.querySelector('.browser-badge');
    await act(async () => root.unmount());
    return badge;
  }

  it('shows a small 🌐 on a step with Browser on, and nothing otherwise', async () => {
    const badge = await card(step({ browser: true }));
    expect(badge?.textContent).toBe('🌐');
    expect(badge?.getAttribute('title')).toBe('Browser on: this step uses the Agent Stream browser');
    expect(await card(step())).toBeNull();
  });
});
