// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyGraph, type Graph } from '@claude-stream/shared';

vi.mock('../src/bridge', () => ({ send: vi.fn(), sendHost: vi.fn(), post: vi.fn() }));
const { send } = await import('../src/bridge');
const { dispatch } = await import('../src/store');
const { GraphPanel } = await import('../src/components/GraphPanel');
const { RightPanel } = await import('../src/components/RightPanel');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
Element.prototype.scrollIntoView = vi.fn() as unknown as Element['scrollIntoView'];

const graph = (patch: Partial<Graph> = {}): Graph => ({ ...emptyGraph('g', 'G', 't'), goal: 'Prove parity', instructions: 'Use dev', ...patch });
const open = (g: Graph) => dispatch({ kind: 'server', msg: { type: 'graphOpened', graph: g, chat: [], chatBusy: false, runs: [], variableValues: {} } });
/** Sets a controlled field's value the way React notices. */
function typeInto(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

let container: HTMLDivElement;
let root: Root;
const button = (label: string) => [...container.querySelectorAll('button')].find((b) => b.textContent === label) as HTMLButtonElement;

beforeEach(async () => {
  vi.mocked(send).mockClear();
  open(graph());
  container = document.createElement('div');
  root = createRoot(container);
  await act(async () => root.render(createElement(GraphPanel)));
});
afterEach(async () => act(async () => root.unmount()));

describe('GraphPanel', () => {
  it('shows the goal and instructions and saves only what changed', async () => {
    const goal = container.querySelector('input[aria-label="Goal"]') as HTMLInputElement;
    const instructions = container.querySelector('textarea#graph-instructions') as HTMLTextAreaElement;
    expect(goal.value).toBe('Prove parity');
    expect(instructions.value).toBe('Use dev');
    expect(button('Save').disabled).toBe(true);
    await act(async () => typeInto(instructions, 'Use dev. Never touch prod.'));
    await act(async () => button('Save').click());
    expect(vi.mocked(send).mock.calls).toEqual([[{ type: 'op', graphId: 'g', op: { type: 'setInstructions', instructions: 'Use dev. Never touch prod.' } }]]);
  });

  it('offers to discard your edits when someone else changes a field meanwhile', async () => {
    await act(async () => typeInto(container.querySelector('input[aria-label="Goal"]') as HTMLInputElement, 'Mine'));
    await act(async () => dispatch({ kind: 'server', msg: { type: 'graph', graph: graph({ instructions: 'Planner text', updatedAt: 't2' }) } }));
    expect(container.textContent).toContain('The goal or instructions changed since you started editing; saving overwrites those changes.');
    await act(async () => button('Discard my edits').click());
    expect((container.querySelector('input[aria-label="Goal"]') as HTMLInputElement).value).toBe('Prove parity');
    expect((container.querySelector('textarea#graph-instructions') as HTMLTextAreaElement).value).toBe('Planner text');
  });
});

describe('RightPanel', () => {
  it('has Chat, Node and Graph tabs', async () => {
    const c = document.createElement('div');
    const r = createRoot(c);
    await act(async () => r.render(createElement(RightPanel)));
    expect([...c.querySelectorAll('.tabs button')].map((b) => b.textContent)).toEqual(['Chat', 'Node', 'Graph']);
    await act(async () => r.unmount());
  });
});
