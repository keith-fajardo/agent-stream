import { describe, expect, it, vi } from 'vitest';
import { emptyGraph, type ApprovalRequest, type Graph, type RunMeta, type ServerMessage } from '@agent-stream/shared';

vi.mock('../src/bridge', () => ({ send: vi.fn(), sendHost: vi.fn(), post: vi.fn() }));
const { sendHost, post } = await import('../src/bridge');
const { buildMenus } = await import('../src/menuModel');
const { initialState, reduce } = await import('../src/state');
type State = import('../src/state').State;
type MenuAction = import('../src/menuModel').MenuAction;

const step = (id: string) => ({ id, title: id, kind: 'agent' as const, prompt: 'p', createdBy: 'user' as const, updatedBy: 'user' as const, updatedAt: 't' });
const graph: Graph = { ...emptyGraph('g', 'G', 't'), nodes: [step('n1')] };
const server = (msg: ServerMessage) => ({ kind: 'server' as const, msg });
const base = (extra: Partial<State> = {}): State => ({
  ...[
    server({ type: 'hello', status: { provider: 'claude', ok: true, label: 'Claude Max' }, project: '/p', graphs: [], approvals: [] }),
    server({ type: 'graphOpened', graph, runs: [], variableValues: {} }),
  ].reduce(reduce, initialState),
  ...extra,
});
const items = (s: State, menu: string) => {
  const m = buildMenus(s).find((x) => x.id === menu)!;
  return Object.fromEntries(m.items.filter((i): i is MenuAction => !('separator' in i)).map((i) => [i.label, i]));
};
const run = (status: RunMeta['status']): RunMeta => ({ id: 'r1', graphId: 'g', status, startedAt: 't', snapshot: graph, nodes: {} });
const approval = (id: string, graphId: string): ApprovalRequest => ({ id, runId: 'r', graphId, nodeId: 'n1', nodeTitle: 'n1', toolName: 'Bash', input: {}, createdAt: 't' });

describe('menus', () => {
  it('has File, Edit, Run, Variables and View in order', () => {
    expect(buildMenus(base()).map((m) => m.label)).toEqual(['File', 'Edit', 'Run', 'Variables', 'View']);
  });

  it('enables File items from the spec, and Delete only when nothing runs', () => {
    expect(Object.values(items(base(), 'file')).map((i) => [i.label, i.enabled])).toEqual([
      ['New graph…', true],
      ['Open…', true],
      ['Import…', true],
      ['Export…', true],
      ['Rename…', true],
      ['Duplicate', true],
      ['Delete…', true],
    ]);
    expect(items(base({ run: run('running') }), 'file')['Delete…'].enabled).toBe(false);
    items(base(), 'file')['Export…'].run();
    expect(sendHost).toHaveBeenCalledWith('exportGraph');
  });

  it('enables Edit items for a graph, and Delete selected step only with a selection', () => {
    expect(items(base(), 'edit')['Delete selected step'].enabled).toBe(false);
    expect(items(base({ selectedNodeId: 'n1' }), 'edit')['Delete selected step'].enabled).toBe(true);
    expect(items(base({ graph: undefined }), 'edit')['Add step'].enabled).toBe(false);
  });

  it('has Refine items in Edit: the selected step needs content and a provider, the changed count is user-edited refinable steps', () => {
    const planned = { ...step('n2'), prompt: undefined, description: 'Compare', updatedBy: 'agent' as const };
    const withNodes = { ...graph, nodes: [step('n1'), { ...step('n3'), prompt: undefined }, planned, { ...step('n4'), updatedBy: 'user' as const }] };
    const edit = (extra: Partial<State>) => items(base({ graph: withNodes, ...extra }), 'edit');
    expect(edit({})['Refine selected step'].enabled).toBe(false);
    expect(edit({ selectedNodeId: 'n1' })['Refine selected step'].enabled).toBe(true);
    expect(edit({ selectedNodeId: 'n3' })['Refine selected step'].enabled).toBe(false);
    expect(edit({ selectedNodeId: 'n1', status: { provider: 'claude', ok: false, label: 'not signed in', error: 'x' } })['Refine selected step'].enabled).toBe(false);
    expect(edit({})['Refine steps you changed (2)'].enabled).toBe(true);
    expect(edit({ status: { provider: 'claude', ok: false, label: 'not signed in', error: 'x' } })['Refine steps you changed (2)'].enabled).toBe(false);
    expect(items(base({ graph: { ...graph, nodes: [planned] } }), 'edit')['Refine steps you changed (0)'].enabled).toBe(false);
    vi.mocked(post).mockClear();
    edit({ selectedNodeId: 'n1' })['Refine selected step'].run();
    edit({})['Refine steps you changed (2)'].run();
    expect(vi.mocked(post).mock.calls).toEqual([[{ type: 'refineSteps', nodeIds: ['n1'] }], [{ type: 'refineSteps', nodeIds: ['n1', 'n4'] }]]);
  });

  it('enables Run items by sign-in, run state, selection and history', () => {
    const idle = items(base(), 'run');
    expect([idle['Run…'].enabled, idle['Stop'].enabled, idle['Re-run from selected step…'].enabled]).toEqual([true, false, false]);
    const running = items(base({ run: run('running') }), 'run');
    expect([running['Run…'].enabled, running['Stop'].enabled]).toEqual([false, true]);
    expect(items(base({ status: { provider: 'claude', ok: false, label: 'not signed in', error: 'x' } }), 'run')['Run…'].enabled).toBe(false);
    const rerun = items(base({ selectedNodeId: 'n1', runs: [{ id: 'r1', graphId: 'g', status: 'failed', startedAt: 't' }] }), 'run');
    expect(rerun['Re-run from selected step…'].enabled).toBe(true);
  });

  it("counts only this graph's approvals in Approve all", () => {
    const s = base({ approvals: [approval('a1', 'g'), approval('a2', 'other'), approval('a3', 'g')] });
    expect(items(s, 'run')['Approve all (2)'].enabled).toBe(true);
    expect(items(base(), 'run')['Approve all (0)'].enabled).toBe(false);
  });

  it('checks the View toggles', () => {
    const v = items(base({ selectedNodeId: 'n1', tab: 'graph', minimap: false }), 'view');
    expect([v['Logs panel'].checked, v['Minimap'].checked, v['Graph'].checked]).toEqual([true, false, true]);
    vi.mocked(sendHost).mockClear();
    v['Chat'].run();
    expect(vi.mocked(sendHost)).toHaveBeenCalledWith('focusChat');
    expect(items(base(), 'view')['Logs panel'].enabled).toBe(false);
  });

  it('lists variables with their values and flags the ones not set', () => {
    const withVars = { ...graph, variables: [{ name: 'schema', description: '' }, { name: 'model', description: '' }] };
    const s = base({ graph: withVars, variableValues: { schema: 'analytics_dev' } });
    const entries = buildMenus(s).find((m) => m.id === 'variables')!.items;
    expect(entries.map((e) => ('separator' in e ? '—' : `${e.label}${e.warn ? ' [warn]' : ''}`))).toEqual([
      'schema = analytics_dev',
      '⚠ model — not set [warn]',
      '—',
      'Add variable…',
      'Edit variables…',
    ]);
  });
});
