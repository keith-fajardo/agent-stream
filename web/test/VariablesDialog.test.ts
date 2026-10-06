// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyGraph, type Graph } from '@agent-stream/shared';

vi.mock('../src/bridge', () => ({ send: vi.fn(), sendHost: vi.fn(), post: vi.fn() }));
const { send } = await import('../src/bridge');
const { dispatch, getState } = await import('../src/store');
const { VariablesDialog } = await import('../src/components/VariablesDialog');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const graph: Graph = { ...emptyGraph('g', 'G', 't'), variables: [{ name: 'schema', description: 'Target schema' }] };
function typeInto(el: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}
let container: HTMLDivElement;
let root: Root;
const inputs = (label: string) => [...container.querySelectorAll(`input[aria-label="${label}"]`)] as HTMLInputElement[];
const button = (label: string) => [...container.querySelectorAll('button')].find((b) => b.textContent === label) as HTMLButtonElement;

async function openDialog(request: { focus?: string; addRow?: boolean } = {}) {
  await act(async () => dispatch({ kind: 'openVariables', ...request }));
}

beforeEach(async () => {
  vi.mocked(send).mockClear();
  dispatch({ kind: 'closeVariables' });
  dispatch({ kind: 'server', msg: { type: 'graphOpened', changes: [], graph, runs: [], variableValues: { schema: 'dev' } } });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root.render(createElement(VariablesDialog)));
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe('VariablesDialog', () => {
  it('stays closed until asked, then shows names, values and descriptions, focused on the requested value', async () => {
    expect(container.innerHTML).toBe('');
    await openDialog({ focus: 'schema' });
    expect(inputs('Name').map((i) => i.value)).toEqual(['schema']);
    expect(inputs('Value').map((i) => i.value)).toEqual(['dev']);
    expect(inputs('Description').map((i) => i.value)).toEqual(['Target schema']);
    expect(document.activeElement).toBe(inputs('Value')[0]);
  });

  it('saves a changed value only', async () => {
    await openDialog();
    await act(async () => typeInto(inputs('Value')[0], 'prod'));
    await act(async () => button('Save').click());
    expect(vi.mocked(send).mock.calls).toEqual([[{ type: 'setVariableValue', graphId: 'g', name: 'schema', value: 'prod' }]]);
    expect(getState().variablesDialog).toBeUndefined();
  });

  it('renames and re-describes with ops', async () => {
    await openDialog();
    await act(async () => typeInto(inputs('Name')[0], 'target_schema'));
    await act(async () => typeInto(inputs('Description')[0], 'Where to build'));
    await act(async () => button('Save').click());
    expect(vi.mocked(send).mock.calls).toEqual([
      [
        {
          type: 'ops',
          graphId: 'g',
          ops: [
            { type: 'renameVariable', name: 'schema', newName: 'target_schema' },
            { type: 'setVariableDescription', name: 'target_schema', description: 'Where to build' },
          ],
          label: 'edited the variables',
        },
      ],
    ]);
  });

  it('adds and deletes variables', async () => {
    await openDialog({ addRow: true });
    expect(document.activeElement).toBe(inputs('Name')[1]);
    await act(async () => typeInto(inputs('Name')[1], 'model'));
    await act(async () => typeInto(inputs('Value')[1], 'orders_v2'));
    await act(async () => (container.querySelector('button[aria-label="Delete schema"]') as HTMLButtonElement).click());
    await act(async () => button('Save').click());
    expect(vi.mocked(send).mock.calls).toEqual([
      [{ type: 'ops', graphId: 'g', ops: [{ type: 'deleteVariable', name: 'schema' }, { type: 'addVariable', name: 'model' }], label: 'edited the variables' }],
      [{ type: 'setVariableValue', graphId: 'g', name: 'model', value: 'orders_v2' }],
    ]);
  });

  it('shows name problems inline and blocks Save', async () => {
    await openDialog({ addRow: true });
    await act(async () => typeInto(inputs('Name')[1], 'env_var'));
    expect(container.textContent).toContain('"env_var" is a reserved word.');
    expect(button('Save').disabled).toBe(true);
    await act(async () => typeInto(inputs('Name')[1], 'schema'));
    expect(container.textContent).toContain('A variable named "schema" already exists.');
  });

  describe('save safety', () => {
    const two: Graph = { ...graph, variables: [{ name: 'a', description: '' }, { name: 'b', description: '' }] };
    const reopen = async (g: Graph, values: Record<string, string> = {}) => {
      await act(async () => dispatch({ kind: 'server', msg: { type: 'graphOpened', changes: [], graph: g, runs: [], variableValues: values } }));
    };
    const ambiguity = (n: string) => `Another variable is called "${n}" until you save. Rename that one first, then save again.`;

    it('blocks swapped renames', async () => {
      await reopen(two);
      await openDialog();
      await act(async () => typeInto(inputs('Name')[0], 'b'));
      await act(async () => typeInto(inputs('Name')[1], 'a'));
      expect(container.textContent).toContain(ambiguity('b'));
      expect(container.textContent).toContain(ambiguity('a'));
      expect(button('Save').disabled).toBe(true);
    });

    it('blocks chained renames on the first row', async () => {
      await reopen(two);
      await openDialog();
      await act(async () => typeInto(inputs('Name')[0], 'b'));
      await act(async () => typeInto(inputs('Name')[1], 'c'));
      expect(container.textContent).toContain(ambiguity('b'));
      expect(container.textContent).not.toContain(ambiguity('c'));
      expect(button('Save').disabled).toBe(true);
    });

    it('allows re-adding the name of a deleted variable', async () => {
      await openDialog({ addRow: true });
      await act(async () => (container.querySelector('button[aria-label="Delete schema"]') as HTMLButtonElement).click());
      await act(async () => typeInto(inputs('Name')[0], 'schema'));
      await act(async () => typeInto(inputs('Value')[0], 'x'));
      await act(async () => button('Save').click());
      expect(vi.mocked(send).mock.calls).toEqual([
        [{ type: 'ops', graphId: 'g', ops: [{ type: 'deleteVariable', name: 'schema' }, { type: 'addVariable', name: 'schema' }], label: 'edited the variables' }],
        [{ type: 'setVariableValue', graphId: 'g', name: 'schema', value: 'x' }],
      ]);
    });

    it('sends rename then value for the new name, without a description', async () => {
      await openDialog();
      await act(async () => typeInto(inputs('Name')[0], 'target'));
      await act(async () => typeInto(inputs('Value')[0], 'prod'));
      await act(async () => button('Save').click());
      expect(vi.mocked(send).mock.calls).toEqual([
        [{ type: 'op', graphId: 'g', op: { type: 'renameVariable', name: 'schema', newName: 'target' } }],
        [{ type: 'setVariableValue', graphId: 'g', name: 'target', value: 'prod' }],
      ]);
    });

    const plannerEdit = async () => {
      await openDialog();
      const changed: Graph = { ...graph, variables: [{ name: 'schema', description: 'Planner text' }] };
      await act(async () => dispatch({ kind: 'server', msg: { type: 'graph', changes: [], graph: changed } }));
    };

    it('warns when the variables change while open and saves nothing untouched', async () => {
      await plannerEdit();
      expect(container.textContent).toContain('The variables changed while you were editing; saving overwrites those changes.');
      await act(async () => button('Save').click());
      expect(vi.mocked(send).mock.calls).toEqual([]);
    });

    it('Reload re-seeds the rows from the current graph', async () => {
      await plannerEdit();
      await act(async () => button('Reload').click());
      expect(inputs('Description').map((i) => i.value)).toEqual(['Planner text']);
      expect(container.textContent).not.toContain('The variables changed while');
    });

    it('sends nothing for a row the planner deleted meanwhile', async () => {
      await openDialog();
      await act(async () => dispatch({ kind: 'server', msg: { type: 'graph', changes: [], graph: { ...graph, variables: [] } } }));
      await act(async () => typeInto(inputs('Value')[0], 'prod'));
      await act(async () => button('Save').click());
      expect(vi.mocked(send).mock.calls).toEqual([]);
    });
  });
});
