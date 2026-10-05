// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { emptyGraph, type EffortLevel, type Graph, type GraphNode, type ModelChoice, type ProviderId } from '@agent-stream/shared';

vi.mock('../src/bridge', () => ({ send: vi.fn(), sendHost: vi.fn(), post: vi.fn() }));
const { send } = await import('../src/bridge');
const { dispatch } = await import('../src/store');
const { NodePanel } = await import('../src/components/NodePanel');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const all: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const CLAUDE: ModelChoice[] = [
  { value: 'sonnet', label: 'Sonnet', efforts: all },
  { value: 'opus', label: 'Opus', efforts: all },
  { value: 'haiku', label: 'Haiku', efforts: [] },
  { value: 'claude-opus-4-6', label: 'Opus 4.6', efforts: ['low', 'medium', 'high', 'max'] },
];
const step: GraphNode = { id: 'n1', title: 'Plan', kind: 'agent', prompt: 'p', createdBy: 'user', updatedBy: 'user', updatedAt: 't' };

let root: Root | undefined;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
});

async function mount(node: Partial<GraphNode>, provider: ProviderId = 'claude', models: ModelChoice[] = CLAUDE, defaultEfforts: EffortLevel[] = all) {
  const graph: Graph = { ...emptyGraph('g', 'G', 't'), nodes: [{ ...step, ...node }] };
  dispatch({ kind: 'server', msg: { type: 'hello', status: { provider, ok: true, label: 'x' }, project: '/p', graphs: [], approvals: [] } });
  dispatch({ kind: 'server', msg: { type: 'graphOpened', changes: [], graph, runs: [], variableValues: {} } });
  dispatch({ kind: 'server', msg: { type: 'models', provider, models, defaultEfforts } });
  dispatch({ kind: 'selectNode', id: 'n1' });
  vi.mocked(send).mockClear();
  const el = document.createElement('div');
  root = createRoot(el);
  await act(async () => root!.render(createElement(NodePanel)));
  const select = (id: string) => el.querySelector(`select#${id}`) as HTMLSelectElement;
  const pick = async (id: string, value: string) =>
    act(async () => {
      select(id).value = value;
      select(id).dispatchEvent(new Event('change', { bubbles: true }));
    });
  const button = (label: string) => [...el.querySelectorAll('button')].find((b) => b.textContent === label) as HTMLButtonElement | undefined;
  const labels = (id: string) => [...select(id).options].map((o) => o.textContent);
  return { el, select, pick, button, labels };
}

describe('NodePanel: a step’s model and effort', () => {
  it('shows Model and Effort below Workspace, for agent steps only', async () => {
    const p = await mount({});
    const labels = [...p.el.querySelectorAll('.field label')].map((l) => l.textContent);
    expect(labels.slice(labels.indexOf('Workspace'), labels.indexOf('Workspace') + 3)).toEqual(['Workspace', 'Model', 'Effort']);
    expect(p.select('node-model').value).toBe('');
    expect(p.labels('node-model')).toEqual(["Default (the run's model)", 'Sonnet', 'Opus', 'Haiku', 'Opus 4.6']);
    expect(p.el.querySelector('optgroup')?.getAttribute('label')).toBe('Pinned versions');
    await act(async () => root!.unmount());
    root = undefined;
    const cmd = await mount({ kind: 'command', prompt: undefined, command: 'ls' });
    expect(cmd.select('node-model')).toBeNull();
    expect(cmd.select('node-effort')).toBeNull();
  });

  it('offers only the chosen model’s levels, drops a level the new model lacks, and saves both as one step edit', async () => {
    const p = await mount({ effort: 'xhigh' });
    await p.pick('node-model', 'claude/claude-opus-4-6');
    expect(p.select('node-effort').value).toBe('');
    expect(p.labels('node-effort')).toEqual(['Default', 'low', 'medium', 'high', 'max']);
    await p.pick('node-effort', 'max');
    await act(async () => p.button('Save')!.click());
    expect(vi.mocked(send).mock.calls).toEqual([[{ type: 'op', graphId: 'g', op: { type: 'updateNode', id: 'n1', patch: { model: { provider: 'claude', id: 'claude-opus-4-6' }, effort: 'max' } } }]]);
  });

  it('clears them with null when set back to Default', async () => {
    const p = await mount({ model: { provider: 'claude', id: 'opus' }, effort: 'high' });
    expect(p.select('node-model').value).toBe('claude/opus');
    await p.pick('node-model', '');
    await p.pick('node-effort', '');
    await act(async () => p.button('Save')!.click());
    expect(vi.mocked(send).mock.calls[0][0]).toEqual({ type: 'op', graphId: 'g', op: { type: 'updateNode', id: 'n1', patch: { model: null, effort: null } } });
  });

  it('shows another provider’s model disabled, with Use Default', async () => {
    const p = await mount({ model: { provider: 'codex', id: 'gpt-6-astra' } });
    const chosen = p.select('node-model').selectedOptions[0];
    expect(chosen.textContent).toBe('OpenAI Codex · gpt-6-astra (not the current provider)');
    expect(chosen.disabled).toBe(true);
    await act(async () => p.button('Use Default')!.click());
    expect(p.select('node-model').value).toBe('');
    expect(p.button('Use Default')).toBeUndefined();
  });

  it('shows a model the list doesn’t offer as not offered', async () => {
    const p = await mount({ model: { provider: 'claude', id: 'claude-opus-4-1' } });
    expect(p.select('node-model').selectedOptions[0].textContent).toBe('claude-opus-4-1 (not offered)');
  });

  it('reads Not supported, disabled, for a model with no levels and on Copilot', async () => {
    const haiku = await mount({ model: { provider: 'claude', id: 'haiku' } });
    expect(haiku.select('node-effort').disabled).toBe(true);
    expect(haiku.labels('node-effort')).toEqual(['Not supported']);
    await act(async () => root!.unmount());
    root = undefined;
    const copilot = await mount({ effort: 'high' }, 'copilot', [{ value: 'auto', label: 'Auto', efforts: [] }], []);
    expect(copilot.labels('node-model')).toEqual(["Default (the run's model)", 'Auto']);
    expect(copilot.select('node-effort').disabled).toBe(true);
    expect(copilot.labels('node-effort')).toEqual(['Not supported']);
    // A stored effort Copilot ignores can still be cleared.
    await act(async () => copilot.button('Use Default')!.click());
    await act(async () => copilot.button('Save')!.click());
    expect(vi.mocked(send).mock.calls[0][0]).toEqual({ type: 'op', graphId: 'g', op: { type: 'updateNode', id: 'n1', patch: { effort: null } } });
  });
});
