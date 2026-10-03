// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { ReactFlowProvider, type NodeProps } from '@xyflow/react';
import { describe, expect, it } from 'vitest';
import type { GraphNode, NodeRunState } from '@agent-stream/shared';
import type { StepData } from '../src/components/StepNode';
import { StepNode, type StepFlowNode } from '../src/components/StepNode';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const node: GraphNode = { id: 'n2', title: 'Build new', kind: 'command', command: 'dbt build', createdBy: 'user', updatedBy: 'user', updatedAt: 't' };

async function renderCardEl(n: GraphNode, state?: NodeRunState, waiting = false, extra: Partial<StepData> = {}): Promise<{ container: HTMLDivElement; done: () => Promise<void> }> {
  const container = document.createElement('div');
  const root = createRoot(container);
  const props = { id: n.id, data: { node: n, state, waiting, ...extra }, selected: false } as unknown as NodeProps<StepFlowNode>;
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

  describe('agent changes', () => {
    const planner = { kind: 'planner' as const };
    const fromStep = { kind: 'step' as const, runId: 'r1', nodeId: 'n2' };
    const badge = (c: HTMLElement) => c.querySelector('.change-badge') as HTMLElement | null;

    it('badges an added step with who added it', async () => {
      const a = await renderCardEl(node, undefined, false, { change: 'added', changeBy: planner });
      expect(a.container.firstElementChild!.classList.contains('change-added')).toBe(true);
      expect(badge(a.container)!.textContent).toBe('＋ planner');
      await a.done();
    });

    it('badges a changed step and lists the changed fields in its tooltip', async () => {
      const a = await renderCardEl({ ...node, updatedBy: 'agent' }, undefined, false, { change: 'changed', changeBy: fromStep, changeFields: ['prompt', 'title'] });
      expect(a.container.firstElementChild!.classList.contains('change-changed')).toBe(true);
      expect(badge(a.container)!.textContent).toBe('✎ n2 · run r1');
      expect(badge(a.container)!.getAttribute('title')).toBe('Changed: prompt, title');
      // The badge replaces the old "by agent" marker.
      expect(a.container.querySelector('.by-agent')).toBeNull();
      await a.done();
    });

    it('uses neutral wording when nobody is recorded as the author', async () => {
      const changed = await renderCardEl(node, undefined, false, { change: 'changed' });
      expect(badge(changed.container)!.textContent).toBe('✎ changed');
      await changed.done();
      const added = await renderCardEl(node, undefined, false, { change: 'added' });
      expect(badge(added.container)!.textContent).toBe('＋ added');
      await added.done();
    });

    it('draws a removed step as a ghost', async () => {
      const a = await renderCardEl(node, undefined, false, { change: 'removed', changeBy: planner, ghost: true });
      expect(a.container.firstElementChild!.classList.contains('change-removed')).toBe(true);
      expect(badge(a.container)!.textContent).toBe('removed by planner');
      await a.done();
      const b = await renderCardEl(node, undefined, false, { change: 'removed', ghost: true });
      expect(badge(b.container)!.textContent).toBe('removed');
      await b.done();
    });

    it('keeps the by-agent marker for a step that is not in the changes', async () => {
      const a = await renderCardEl({ ...node, updatedBy: 'agent' });
      expect(a.container.querySelector('.by-agent')).not.toBeNull();
      expect(badge(a.container)).toBeNull();
      await a.done();
    });
  });
});
