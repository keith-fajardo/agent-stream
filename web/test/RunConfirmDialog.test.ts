// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyGraph, type RunPreview } from '@claude-stream/shared';

vi.mock('../src/bridge', () => ({ send: vi.fn(), sendHost: vi.fn(), post: vi.fn() }));
const { send } = await import('../src/bridge');
const { dispatch, getState } = await import('../src/store');
const { RunConfirmDialog } = await import('../src/components/RunConfirmDialog');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const preview = (patch: Partial<RunPreview> = {}): RunPreview => ({
  graphId: 'g',
  problems: [],
  warnings: [],
  steps: [
    { id: 'n1', title: 'Build', kind: 'command', text: "dbt build -s 'orders v2'", reused: false },
    { id: 'n2', title: 'Check', kind: 'agent', text: 'Compare orders and orders_v2.', reused: false },
  ],
  variables: [{ name: 'model', value: 'orders v2' }],
  signature: 'sig-1',
  ...patch,
});
let container: HTMLDivElement;
let root: Root;
const button = (label: string) => [...container.querySelectorAll('button')].find((b) => b.textContent === label) as HTMLButtonElement;

beforeEach(async () => {
  vi.mocked(send).mockClear();
  dispatch({ kind: 'server', msg: { type: 'hello', auth: { ok: true }, project: '/p', graphs: [], approvals: [] } });
  dispatch({ kind: 'server', msg: { type: 'graphOpened', graph: emptyGraph('g', 'G', 't'), chat: [], chatBusy: false, runs: [], variableValues: {} } });
  container = document.createElement('div');
  root = createRoot(container);
  await act(async () => root.render(createElement(RunConfirmDialog)));
});
afterEach(async () => act(async () => root.unmount()));

describe('RunConfirmDialog', () => {
  it('asks the engine for a preview when it opens', async () => {
    await act(async () => dispatch({ kind: 'openConfirm', request: { fromNodeId: 'n2', sourceRunId: 'r1' } }));
    expect(send).toHaveBeenCalledWith({ type: 'previewRun', graphId: 'g', fromNodeId: 'n2', sourceRunId: 'r1' });
    expect(container.textContent).toContain('Checking the run…');
    expect(button('Start run').disabled).toBe(true);
  });

  it('shows commands in full, agent prompts folded, the variables used, then starts with the signature', async () => {
    await act(async () => dispatch({ kind: 'openConfirm', request: {} }));
    await act(async () => dispatch({ kind: 'server', msg: { type: 'runPreview', preview: preview() } }));
    expect(container.querySelector('pre.mono')?.textContent).toBe("dbt build -s 'orders v2'");
    expect(container.querySelector('details summary')?.textContent).toBe('n2 · Check');
    expect(container.querySelector('details pre')?.textContent).toBe('Compare orders and orders_v2.');
    expect(container.querySelector('.variables-used')?.textContent).toContain('orders v2');
    await act(async () => button('Start run').click());
    expect(send).toHaveBeenLastCalledWith({ type: 'startRun', graphId: 'g', reviewed: 'sig-1', fromNodeId: undefined, sourceRunId: undefined });
    expect(getState().confirm).toBeUndefined();
  });

  it('lists problems first and blocks Start, and shows warnings', async () => {
    await act(async () => dispatch({ kind: 'openConfirm', request: {} }));
    await act(async () =>
      dispatch({ kind: 'server', msg: { type: 'runPreview', preview: preview({ problems: ['Set a value for model (Variables menu).'], warnings: ['n1 inserts a value without quotes (| unquoted). Check its command below.'] }) } }),
    );
    const text = container.textContent ?? '';
    expect(text.indexOf('Set a value for model (Variables menu).')).toBeLessThan(text.indexOf('dbt build'));
    expect(text).toContain('⚠ n1 inserts a value without quotes');
    expect(button('Start run').disabled).toBe(true);
  });
});
