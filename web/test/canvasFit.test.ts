// @vitest-environment jsdom
import { act, createElement, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { emptyGraph, type Graph, type GraphNode } from '@agent-stream/shared';

vi.mock('../src/bridge', () => ({ send: vi.fn(), sendHost: vi.fn(), post: vi.fn() }));
// React Flow only fits the view when it mounts (fitView, @xyflow/react 12), so what matters is when it mounts and which nodes it has then.
const mounts: string[][] = [];
vi.mock('@xyflow/react', async (original) => {
  const real = await original<typeof import('@xyflow/react')>();
  return {
    ...real,
    ReactFlow: (props: { nodes: { id: string }[] }) => {
      const ids = props.nodes.map((n) => n.id);
      useEffect(() => void mounts.push(ids), []); // eslint-disable-line react-hooks/exhaustive-deps
      return null;
    },
  };
});
const { dispatch } = await import('../src/store');
const { Canvas } = await import('../src/components/Canvas');
const { ReactFlowProvider } = await import('@xyflow/react');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const step = (id: string, extra: Partial<GraphNode> = {}): GraphNode => ({ id, title: id, kind: 'agent', prompt: 'p', createdBy: 'user', updatedBy: 'user', updatedAt: 't', ...extra });
const research: Graph = { ...emptyGraph('company-research', 'Company research', 't'), nodes: [step('n1'), step('n2')] };
const hunting: Graph = { ...emptyGraph('job-hunting', 'Job hunting', 't'), nodes: [step('n1'), step('n4', { kind: 'graph', graph: 'company-research', prompt: undefined })] };

describe('fitting the view when the canvas goes inside a sub-graph step', () => {
  it('mounts a fresh React Flow, with no steps yet, on a scope change, and not on an ordinary graph update', async () => {
    dispatch({ kind: 'server', msg: { type: 'graphOpened', changes: [], graph: hunting, runs: [], variableValues: {} } });
    dispatch({ kind: 'server', msg: { type: 'subgraphs', graphId: 'job-hunting', graphs: { 'company-research': research }, reviews: {} } });
    const container = document.createElement('div');
    const root = createRoot(container);
    await act(async () => root.render(createElement(ReactFlowProvider, null, createElement(Canvas))));
    expect(mounts).toEqual([[]]);

    await act(async () => dispatch({ kind: 'server', msg: { type: 'graph', changes: [], graph: { ...hunting, goal: 'A new goal', updatedAt: 't2' } } }));
    expect(mounts).toHaveLength(1);

    // The steps of the graph we are leaving must not be what the new view is fitted to.
    await act(async () => dispatch({ kind: 'enterScope', stepId: 'n4' }));
    expect(mounts).toEqual([[], []]);
    await act(async () => dispatch({ kind: 'climbScope', depth: 0 }));
    expect(mounts).toEqual([[], [], []]);
    await act(async () => root.unmount());
  });
});
