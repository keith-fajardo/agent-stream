// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { emptyGraph, type Graph, type GraphListItem, type GraphNode } from '@agent-stream/shared';

vi.mock('../src/bridge', () => ({ send: vi.fn(), sendHost: vi.fn(), post: vi.fn() }));
const { send } = await import('../src/bridge');
const { dispatch, getState } = await import('../src/store');
const { actions } = await import('../src/actions');
const { NodePanel } = await import('../src/components/NodePanel');
const { SubgraphPicker } = await import('../src/components/SubgraphPicker');
const { pickerOptions } = await import('../src/subgraphPicker');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const step = (id: string, extra: Partial<GraphNode> = {}): GraphNode => ({ id, title: id, kind: 'agent', prompt: 'p', createdBy: 'user', updatedBy: 'user', updatedAt: 't', ...extra });
const research: Graph = {
  ...emptyGraph('company-research', 'Company research', 't'),
  goal: 'Know the company.',
  variables: [
    { name: 'company', description: 'Who to research' },
    { name: 'depth', description: '' },
  ],
  nodes: [step('n1'), step('n2'), step('n3')],
};
const hunting: Graph = { ...emptyGraph('job-hunting', 'Job hunting', 't'), nodes: [step('n1'), step('n4', { title: 'Research', kind: 'graph', graph: 'company-research', values: { company: 'Acme', old: 'x' }, prompt: undefined })] };
const list: GraphListItem[] = [
  { id: 'job-hunting', name: 'Job hunting', steps: 2 },
  { id: 'company-research', name: 'Company research', steps: 3, usedBy: ['job-hunting', 'weekly-report'] },
  { id: 'weekly-report', name: 'Weekly report', steps: 1 },
  { id: 'uses-hunting', name: 'Uses job hunting', steps: 1 },
  { id: 'hunting-user', name: 'Job hunting user', steps: 1, usedBy: ['uses-hunting'] },
  { id: 'broken', name: 'broken', error: 'line 3: kind is "robot"; use agent or command.' },
];
// uses-hunting uses job-hunting, so picking it from job-hunting would be a loop.
list[0] = { ...list[0], usedBy: ['uses-hunting'] };

function open() {
  dispatch({ kind: 'server', msg: { type: 'graphOpened', changes: [], graph: hunting, runs: [], variableValues: {} } });
  dispatch({ kind: 'server', msg: { type: 'graphs', graphs: list } });
  dispatch({ kind: 'server', msg: { type: 'subgraphs', graphId: 'job-hunting', graphs: { 'company-research': research }, reviews: {} } });
}
async function render(el: ReturnType<typeof createElement>) {
  const container = document.createElement('div');
  const root = createRoot(container);
  await act(async () => root.render(el));
  return { container, done: () => act(async () => root.unmount()) };
}
const type = (field: HTMLTextAreaElement | HTMLSelectElement, value: string) => {
  const proto = field instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLTextAreaElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(field, value);
  field.dispatchEvent(new Event(field instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
};

describe('the picker (spec §6.2)', () => {
  it('leaves out the graph itself and every graph that would make a loop, and disables a broken graph with its error', () => {
    expect(pickerOptions(list, 'job-hunting')).toEqual([
      { id: 'company-research', label: 'Company research · 3 steps', disabled: false },
      { id: 'weekly-report', label: 'Weekly report · 1 step', disabled: false },
      { id: 'hunting-user', label: 'Job hunting user · 1 step', disabled: false },
      { id: 'broken', label: 'broken · 0 steps', disabled: true, title: 'line 3: kind is "robot"; use agent or command.' },
    ]);
  });

  it('disables a graph whose file has errors now, though it still loads its last good version', () => {
    const options = pickerOptions([{ id: 'job-hunting', name: 'Job hunting' }, { id: 'company-research', name: 'Company research', steps: 3, broken: 'line 5: kind is "robot"; use agent or command.' }], 'job-hunting');
    expect(options).toEqual([{ id: 'company-research', label: 'Company research · 3 steps', disabled: true, title: 'line 5: kind is "robot"; use agent or command.' }]);
  });

  it('+ Sub-graph adds a sub-graph step titled with the chosen graph’s name', async () => {
    open();
    vi.mocked(send).mockClear();
    const r = await render(createElement(SubgraphPicker, { onClose: () => {} }));
    const button = [...r.container.querySelectorAll('button')].find((b) => b.textContent === 'Company research · 3 steps')!;
    await act(async () => button.click());
    expect(send).toHaveBeenCalledWith({ type: 'op', graphId: 'job-hunting', op: { type: 'addNode', node: { id: 'n5', title: 'Company research', kind: 'graph', graph: 'company-research' } } });
    expect(getState().selectedNodeId).toBe('n5');
    await r.done();
  });
});

describe('the Node panel for a sub-graph step (spec §6.2)', () => {
  it('shows the inner graph, its goal, a value box per inner variable, the unused values and where else it is used', async () => {
    open();
    dispatch({ kind: 'selectNode', id: 'n4' });
    const r = await render(createElement(NodePanel));
    expect((r.container.querySelector('select#node-subgraph') as HTMLSelectElement).value).toBe('company-research');
    expect(r.container.querySelector('.subgraph-goal')?.textContent).toBe('Know the company.');
    const company = r.container.querySelector('textarea#node-value-company') as HTMLTextAreaElement;
    expect(company.value).toBe('Acme');
    expect(r.container.querySelector('label[for="node-value-company"]')?.textContent).toBe('Who to research');
    const depth = r.container.querySelector('textarea#node-value-depth') as HTMLTextAreaElement;
    expect([depth.value, depth.placeholder]).toEqual(['', 'Asked when the run starts']);
    expect(r.container.querySelector('label[for="node-value-depth"]')?.textContent).toBe('depth');
    expect(r.container.querySelector('.subgraph-unused')?.textContent).toContain('old');
    expect(r.container.querySelector('.subgraph-used-in')?.textContent).toBe('Used in: Weekly report');
    // No agent or command fields.
    expect(r.container.querySelector('#node-workspace')).toBeNull();
    expect(r.container.querySelector('#node-access')).toBeNull();
    vi.mocked(send).mockClear();
    await act(async () => type(depth, 'quick'));
    await act(async () => (r.container.querySelector('button[aria-label="Remove old"]') as HTMLButtonElement).click());
    await act(async () => ([...r.container.querySelectorAll('button')].find((b) => b.textContent === 'Save') as HTMLButtonElement).click());
    expect(send).toHaveBeenCalledWith({ type: 'op', graphId: 'job-hunting', op: { type: 'updateNode', id: 'n4', patch: { values: { company: 'Acme', depth: 'quick' } } } });
    await r.done();
  });

  it('says under the value boxes that the values are saved in the graph file', async () => {
    open();
    dispatch({ kind: 'selectNode', id: 'n4' });
    const r = await render(createElement(NodePanel));
    const note = r.container.querySelector('.subgraph-values-note');
    expect(note?.textContent).toBe("Saved in this graph's file. Leave a value empty to be asked when the run starts (kept on this machine), or use {{ variable }} to pass one of this graph's variables.");
    expect(note?.querySelector('code')?.textContent).toBe('{{ variable }}');
    // It follows the value boxes.
    expect(r.container.querySelector('textarea#node-value-depth')?.closest('.field')?.nextElementSibling).toBe(note);
    await r.done();
  });

  it('making an agent step a sub-graph step needs a graph before it can be saved', async () => {
    open();
    dispatch({ kind: 'selectNode', id: 'n1' });
    const r = await render(createElement(NodePanel));
    await act(async () => type([...r.container.querySelectorAll('select')][0] as HTMLSelectElement, 'graph'));
    const save = () => [...r.container.querySelectorAll('button')].find((b) => b.textContent === 'Save') as HTMLButtonElement;
    expect(save().disabled).toBe(true);
    await act(async () => type(r.container.querySelector('select#node-subgraph') as HTMLSelectElement, 'weekly-report'));
    expect(save().disabled).toBe(false);
    vi.mocked(send).mockClear();
    await act(async () => save().click());
    expect(send).toHaveBeenCalledWith({ type: 'op', graphId: 'job-hunting', op: { type: 'updateNode', id: 'n1', patch: { kind: 'graph', graph: 'weekly-report' } } });
    await r.done();
  });

  it('⌘S does not save a sub-graph step that has no graph, and the draft stays unsaved', async () => {
    open();
    dispatch({ kind: 'selectNode', id: 'n1' });
    const r = await render(createElement(NodePanel));
    await act(async () => type([...r.container.querySelectorAll('select')][0] as HTMLSelectElement, 'graph'));
    vi.mocked(send).mockClear();
    dispatch({ kind: 'dismissToast' });
    await act(async () => actions.save());
    expect(vi.mocked(send).mock.calls.filter(([m]) => m.type === 'op')).toEqual([]);
    // It says what is missing, not that the graph was saved.
    expect(getState().toast).toBe('Choose a graph first.');
    const save = [...r.container.querySelectorAll('button')].find((b) => b.textContent === 'Save') as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    // Choosing a graph makes ⌘S save it.
    await act(async () => type(r.container.querySelector('select#node-subgraph') as HTMLSelectElement, 'weekly-report'));
    await act(async () => actions.save());
    expect(send).toHaveBeenCalledWith({ type: 'op', graphId: 'job-hunting', op: { type: 'updateNode', id: 'n1', patch: { kind: 'graph', graph: 'weekly-report' } } });
    await r.done();
  });
});
