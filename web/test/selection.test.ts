import { describe, expect, it } from 'vitest';
import { addsToSelection, deletionOps, selectedForDelete } from '../src/selection';

const node = (id: string, selected: boolean, ghost = false) => ({ id, selected, data: { ghost } });
const edge = (id: string, source: string, target: string, selected: boolean) => ({ id, source, target, selected });

describe('selection', () => {
  it('deletes every selected step and only the selected connections between steps that stay', () => {
    const ops = deletionOps(['n1', 'n2'], [edge('e1', 'n1', 'n3', true), edge('e2', 'n3', 'n4', true)]);
    expect(ops).toEqual([
      { type: 'disconnect', from: 'n3', to: 'n4' },
      { type: 'deleteNode', id: 'n1' },
      { type: 'deleteNode', id: 'n2' },
    ]);
  });

  it('collects the selected steps and connections, never a removed step drawn as a ghost', () => {
    const picked = selectedForDelete(
      [node('n1', true), node('n2', false), node('ghost:n3', true, true)],
      [edge('e1', 'n1', 'n2', true), edge('e2', 'n2', 'n4', false), { ...edge('ghost:e3', 'n1', 'n4', true), deletable: false }],
    );
    expect(picked.nodeIds).toEqual(['n1']);
    expect(picked.edges.map((e) => e.id)).toEqual(['e1']);
    expect(picked.count).toBe(2);
  });

  it('treats Cmd, Ctrl and Shift clicks as adding to the selection', () => {
    expect(addsToSelection({ metaKey: true, ctrlKey: false, shiftKey: false })).toBe(true);
    expect(addsToSelection({ metaKey: false, ctrlKey: true, shiftKey: false })).toBe(true);
    expect(addsToSelection({ metaKey: false, ctrlKey: false, shiftKey: true })).toBe(true);
    expect(addsToSelection({ metaKey: false, ctrlKey: false, shiftKey: false })).toBe(false);
  });
});
