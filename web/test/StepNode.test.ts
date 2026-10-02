// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { ReactFlowProvider, type NodeProps } from '@xyflow/react';
import { describe, expect, it } from 'vitest';
import type { GraphNode, NodeRunState } from '@claude-stream/shared';
import { StepNode, type StepFlowNode } from '../src/components/StepNode';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const node: GraphNode = { id: 'n2', title: 'Build new', kind: 'command', command: 'dbt build', createdBy: 'user', updatedBy: 'user', updatedAt: 't' };

async function renderCard(state?: NodeRunState, waiting = false): Promise<string> {
  const container = document.createElement('div');
  const root = createRoot(container);
  const props = { id: node.id, data: { node, state, waiting }, selected: false } as unknown as NodeProps<StepFlowNode>;
  await act(async () => root.render(createElement(ReactFlowProvider, null, createElement(StepNode, props))));
  const text = container.textContent ?? '';
  await act(async () => root.unmount());
  return text;
}

describe('StepNode', () => {
  it('shows statuses with their human labels', async () => {
    expect(await renderCard({ status: 'not_run' })).toContain('Not run');
    expect(await renderCard({ status: 'waiting_approval' })).toContain('Waiting approval');
    expect(await renderCard({ status: 'queued' })).toContain('Queued');
  });

  it('flags a step that is waiting for approval', async () => {
    expect(await renderCard({ status: 'waiting_approval' }, true)).toContain('⏸ Needs approval');
    expect(await renderCard({ status: 'running' }, false)).not.toContain('Needs approval');
  });
});
