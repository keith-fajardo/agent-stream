// @vitest-environment jsdom
import { act, createElement, Fragment } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyGraph, type AgentChange, type Graph, type GraphNode } from '@agent-stream/shared';

vi.mock('../src/bridge', () => ({ send: vi.fn(), sendHost: vi.fn(), post: vi.fn() }));
const { send } = await import('../src/bridge');
const { dispatch, getState } = await import('../src/store');
const { ChangesPanel } = await import('../src/components/ChangesPanel');
const { sourceLabel } = await import('../src/changeLabels');
const { ChangeConfirmDialog } = await import('../src/components/ChangeConfirmDialog');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const step = (id: string, prompt: string, extra: Partial<GraphNode> = {}): GraphNode => ({ id, title: id, kind: 'agent', prompt, createdBy: 'user', updatedBy: 'user', updatedAt: 't', ...extra });
const baseline: Graph = { ...emptyGraph('g', 'G', 't'), nodes: [step('n1', 'line one\nline two'), step('n3', 'gone')] };
const graph: Graph = { ...emptyGraph('g', 'G', 't'), nodes: [step('n1', 'line one\nline 2'), step('n4', 'fresh', { title: 'Fresh' })], edges: [{ id: 'n1->n4', from: 'n1', to: 'n4' }] };
const now = Date.parse('2026-10-03T12:00:00Z');
const changes: AgentChange[] = [
  { kind: 'node', change: 'changed', id: 'n1', title: 'n1', fields: ['prompt'], by: { kind: 'planner' }, at: '2026-10-03T10:00:00Z' },
  { kind: 'node', change: 'added', id: 'n4', title: 'Fresh', by: { kind: 'step', runId: 'r1', nodeId: 'n2' }, at: '2026-10-03T11:30:00Z' },
  { kind: 'edge', change: 'added', id: 'n1->n4', from: 'n1', to: 'n4', by: { kind: 'step', runId: 'r1', nodeId: 'n2' }, at: '2026-10-03T11:00:00Z' },
  { kind: 'node', change: 'removed', id: 'n3', title: 'n3' },
];

let container: HTMLDivElement;
let root: Root;
const buttons = (label: string, within: ParentNode = container) => [...within.querySelectorAll('button')].filter((b) => b.textContent === label) as HTMLButtonElement[];
const rows = () => [...container.querySelectorAll('.change-row')] as HTMLElement[];

beforeEach(async () => {
  vi.spyOn(Date, 'now').mockReturnValue(now);
  vi.mocked(send).mockClear();
  dispatch({ kind: 'server', msg: { type: 'graphOpened', graph, baseline, changes, runs: [], variableValues: {} } });
  dispatch({ kind: 'setTab', tab: 'changes' });
  container = document.createElement('div');
  root = createRoot(container);
  await act(async () => root.render(createElement(Fragment, null, createElement(ChangesPanel), createElement(ChangeConfirmDialog))));
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.restoreAllMocks();
});

describe('sourceLabel', () => {
  it('names the planner or the step and run, and is neutral when unknown', () => {
    expect(sourceLabel({ kind: 'planner', sessionId: 's' })).toBe('planner');
    expect(sourceLabel({ kind: 'step', runId: 'r1', nodeId: 'n2' })).toBe('n2 · run r1');
    expect(sourceLabel(undefined)).toBe('changed');
  });
});

describe('ChangesPanel', () => {
  it('lists the changes newest first with their fields, author and age', () => {
    const text = rows().map((r) => r.textContent ?? '');
    expect(text).toHaveLength(4);
    expect(text[0]).toContain('Fresh');
    expect(text[0]).toContain('n2 · run r1');
    expect(text[0]).toContain('30m ago');
    expect(text[1]).toContain('n1 → n4');
    expect(text[2]).toContain('n1');
    expect(text[2]).toContain('prompt');
    expect(text[2]).toContain('planner');
    expect(text[2]).toContain('2h ago');
    // A change with no time sorts last and shows no age.
    expect(text[3]).toContain('n3');
    expect(text[3]).not.toContain('ago');
  });

  it('accepts or reverts one change', async () => {
    const first = rows()[0]!;
    await act(async () => buttons('Accept', first)[0]!.click());
    await act(async () => buttons('Revert', first)[0]!.click());
    expect(vi.mocked(send).mock.calls).toEqual([
      [{ type: 'op', graphId: 'g', op: { type: 'acceptChange', target: { kind: 'node', id: 'n4' } } }],
      [{ type: 'op', graphId: 'g', op: { type: 'revertChange', target: { kind: 'node', id: 'n4' } } }],
    ]);
    await act(async () => buttons('Accept', rows()[1]!)[0]!.click());
    expect(vi.mocked(send).mock.calls.at(-1)).toEqual([{ type: 'op', graphId: 'g', op: { type: 'acceptChange', target: { kind: 'edge', id: 'n1->n4' } } }]);
  });

  it('asks before accepting or reverting everything, then posts the all target', async () => {
    await act(async () => buttons('Accept all')[0]!.click());
    expect(container.textContent).toContain('Accept all 4 agent changes into your graph?');
    expect(send).not.toHaveBeenCalled();
    await act(async () => buttons('Cancel')[0]!.click());
    expect(container.textContent).not.toContain('Accept all 4 agent changes');
    expect(send).not.toHaveBeenCalled();
    await act(async () => buttons('Accept all')[0]!.click());
    await act(async () => buttons('Confirm')[0]!.click());
    expect(vi.mocked(send).mock.calls).toEqual([[{ type: 'op', graphId: 'g', op: { type: 'acceptChange', target: { kind: 'all' } } }]]);
    expect(container.querySelector('[role="dialog"]')).toBeNull();

    vi.mocked(send).mockClear();
    await act(async () => buttons('Revert all')[0]!.click());
    expect(container.textContent).toContain('Revert all 4 agent changes?');
    await act(async () => buttons('Confirm')[0]!.click());
    expect(vi.mocked(send).mock.calls).toEqual([[{ type: 'op', graphId: 'g', op: { type: 'revertChange', target: { kind: 'all' } } }]]);
  });

  it('shows a before/after of the selected step, with removed and added lines marked', async () => {
    expect(container.querySelector('.diff-removed')).toBeNull();
    const changed = rows().find((r) => r.textContent?.includes('prompt'))!;
    await act(async () => changed.click());
    expect(getState().selectedNodeId).toBe('n1');
    expect([...container.querySelectorAll('.diff-removed')].map((e) => e.textContent)).toEqual(['line two']);
    expect([...container.querySelectorAll('.diff-added')].map((e) => e.textContent)).toEqual(['line 2']);
    expect(container.querySelector('.change-detail')!.textContent).toContain('line one');
  });

  it('shows what an added or removed step contains', async () => {
    await act(async () => rows()[0]!.click());
    expect([...container.querySelectorAll('.diff-added')].map((e) => e.textContent)).toContain('fresh');
    const removed = rows().find((r) => r.textContent?.includes('n3'))!;
    await act(async () => removed.click());
    expect([...container.querySelectorAll('.diff-removed')].map((e) => e.textContent)).toContain('gone');
  });

  it('opens a change from the keyboard', async () => {
    const row = rows()[2]!;
    expect(row.getAttribute('role')).toBe('button');
    expect(row.tabIndex).toBe(0);
    await act(async () => row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    expect(getState().selectedChange).toBe('node:n1');
  });

  it('closes the confirmation with Escape, posting nothing', async () => {
    await act(async () => buttons('Revert all')[0]!.click());
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    await act(async () => void document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(getState().changeConfirm).toBeUndefined();
    expect(send).not.toHaveBeenCalled();
  });

  it('says so when there is nothing to review', async () => {
    await act(async () => dispatch({ kind: 'server', msg: { type: 'graph', graph, baseline, changes: [] } }));
    expect(container.textContent).toContain('No agent changes to review.');
  });
});
