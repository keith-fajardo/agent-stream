// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { ReactFlowProvider, type NodeProps } from '@xyflow/react';
import { describe, expect, it } from 'vitest';
import type { GraphNode, NodeRunState } from '@agent-stream/shared';
import { StepNode, type StepFlowNode } from '../src/components/StepNode';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const node: GraphNode = { id: 'n2', title: 'Build new', kind: 'command', command: 'dbt build', createdBy: 'user', updatedBy: 'user', updatedAt: 't' };

async function renderCardEl(n: GraphNode, state?: NodeRunState, waiting = false): Promise<{ container: HTMLDivElement; done: () => Promise<void> }> {
  const container = document.createElement('div');
  const root = createRoot(container);
  const props = { id: n.id, data: { node: n, state, waiting }, selected: false } as unknown as NodeProps<StepFlowNode>;
  await act(async () => root.render(createElement(ReactFlowProvider, null, createElement(StepNode, props))));
  return { container, done: () => act(async () => root.unmount()) };
}

async function renderCard(state?: NodeRunState, waiting = false): Promise<string> {
  const { container, done } = await renderCardEl(node, state, waiting);
  const text = container.textContent ?? '';
  await done();
  return text;
}

describe('StepNode', () => {
  it('shows statuses with their human labels', async () => {
    expect(await renderCard({ status: 'not_run' })).toContain('Not run');
    expect(await renderCard({ status: 'waiting_approval' })).toContain('Waiting approval');
    expect(await renderCard({ status: 'queued' })).toContain('Queued');
  });

  it('shows the description under the title, with the full text as a tooltip, and nothing when blank', async () => {
    const described = { ...node, description: 'Builds the new model in dev.' };
    const a = await renderCardEl(described);
    const desc = a.container.querySelector('.step-desc');
    expect(desc?.textContent).toBe('Builds the new model in dev.');
    expect(desc?.getAttribute('title')).toBe('Builds the new model in dev.');
    await a.done();
    const b = await renderCardEl({ ...node, description: '   ' });
    expect(b.container.querySelector('.step-desc')).toBeNull();
    await b.done();
    const c = await renderCardEl(node);
    expect(c.container.querySelector('.step-desc')).toBeNull();
    await c.done();
  });

  it('flags a step that is waiting for approval', async () => {
    expect(await renderCard({ status: 'waiting_approval' }, true)).toContain('⏸ Needs approval');
    expect(await renderCard({ status: 'running' }, false)).not.toContain('Needs approval');
  });
});
