// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { ReactFlowProvider, type NodeProps } from '@xyflow/react';
import { describe, expect, it } from 'vitest';
import { applyOp, emptyGraph, type GraphNode, type ModelChoice, type Position } from '@agent-stream/shared';
import { StepNode, type StepFlowNode } from '../src/components/StepNode';
import { buildFlowNodes } from '../src/flowNodes';
import { modelChip } from '../src/stepModelMenus';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CLAUDE: ModelChoice[] = [{ value: 'opus', label: 'Opus', efforts: ['high'] }];
const CODEX: ModelChoice[] = [{ value: 'gpt-6-astra', label: 'GPT-6-Astra', efforts: ['high'] }];
const agent = (over: Partial<GraphNode> = {}): GraphNode => ({ id: 'n1', title: 'Plan', kind: 'agent', prompt: 'p', createdBy: 'user', updatedBy: 'user', updatedAt: 't', ...over });

describe('the model chip (spec §4.2)', () => {
  it('names the model by its display name and the effort', () => {
    expect(modelChip(agent({ model: { provider: 'claude', id: 'opus' }, effort: 'high' }), 'claude', CLAUDE)).toEqual({ text: 'Opus · high' });
    expect(modelChip(agent({ model: { provider: 'codex', id: 'gpt-6-astra' } }), 'codex', CODEX)).toEqual({ text: 'GPT-6-Astra' });
    expect(modelChip(agent({ effort: 'max' }), 'claude', CLAUDE)).toEqual({ text: '· max' });
    // No list yet: the id, and no warning.
    expect(modelChip(agent({ model: { provider: 'claude', id: 'opus' } }), 'claude', [])).toEqual({ text: 'opus' });
  });

  it('has none for a step without its own, and for a command step', () => {
    expect(modelChip(agent(), 'claude', CLAUDE)).toBeUndefined();
    expect(modelChip({ kind: 'command' }, 'claude', CLAUDE)).toBeUndefined();
  });

  it('warns, with the note, for another provider’s model and one the list doesn’t offer', () => {
    expect(modelChip(agent({ model: { provider: 'codex', id: 'gpt-6-astra' }, effort: 'high' }), 'claude', CLAUDE)).toEqual({
      text: 'gpt-6-astra · high',
      warning: 'This step is set to an OpenAI Codex model (gpt-6-astra); this run uses Claude, so it uses the default model.',
    });
    expect(modelChip(agent({ model: { provider: 'claude', id: 'claude-opus-4-1' } }), 'claude', CLAUDE)).toEqual({
      text: 'claude-opus-4-1',
      warning: "claude-opus-4-1 isn't offered by Claude any more (or on this plan), so this step uses the default model.",
    });
  });

  it('reaches the card through buildFlowNodes, which shows it struck through when it warns', async () => {
    let g = emptyGraph('g', 'G', 't');
    for (const node of [{ title: 'own', model: { provider: 'claude' as const, id: 'opus' } }, { title: 'other', model: { provider: 'codex' as const, id: 'gpt-6-astra' } }]) {
      const r = applyOp(g, { type: 'addNode', node: { kind: 'agent', prompt: 'p', ...node } }, 'user', 't');
      if (!r.ok) throw new Error(r.error);
      g = r.graph;
    }
    const nodes = buildFlowNodes({ graph: g, approvals: [], selectionChanged: true, current: [], dragging: new Set(), pendingMoves: new Map<string, Position>(), provider: 'claude', models: CLAUDE });
    expect(nodes.map((n) => n.data.modelChip?.text)).toEqual(['Opus', 'gpt-6-astra']);
    const container = document.createElement('div');
    const root = createRoot(container);
    const props = { id: 'n2', data: nodes[1].data, selected: false } as unknown as NodeProps<StepFlowNode>;
    await act(async () => root.render(createElement(ReactFlowProvider, null, createElement(StepNode, props))));
    const chip = container.querySelector('.model-chip') as HTMLElement;
    expect(chip.textContent).toBe('gpt-6-astra');
    expect(chip.classList.contains('model-chip-warning')).toBe(true);
    expect(chip.title).toBe('This step is set to an OpenAI Codex model (gpt-6-astra); this run uses Claude, so it uses the default model.');
    await act(async () => root.unmount());
  });
});
