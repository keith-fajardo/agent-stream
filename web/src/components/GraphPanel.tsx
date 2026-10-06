import { useEffect, useRef, useState } from 'react';
import type { Graph, Op } from '@agent-stream/shared';
import { registerGraphDraft, sendEdit } from '../actions';
import { useStore } from '../store';
import { AttachmentList } from './AttachmentList';

type Draft = { goal: string; instructions: string };
const draftOf = (g: Graph): Draft => ({ goal: g.goal, instructions: g.instructions });
const same = (a: Draft, b: Draft) => a.goal === b.goal && a.instructions === b.instructions;

export function GraphPanel() {
  const graph = useStore((s) => s.graph);
  if (!graph) return null;
  return <GraphEditor key={graph.id} graph={graph} />;
}

/** Edits a local draft like the Node editor; Save sends only the fields that changed (spec §6). */
function GraphEditor({ graph }: { graph: Graph }) {
  const current = draftOf(graph);
  const [base, setBase] = useState(current);
  const [draft, setDraft] = useState(current);
  const dirty = !same(draft, base);
  const changedUnderneath = !same(current, base);

  useEffect(() => {
    if (changedUnderneath && !dirty) {
      setBase(current);
      setDraft(current);
    }
  }, [changedUnderneath, dirty, graph.goal, graph.instructions]);

  const discard = () => {
    setBase(current);
    setDraft(current);
  };
  const save = () => {
    const ops: Op[] = [];
    if (draft.goal !== base.goal) ops.push({ type: 'setGoal', goal: draft.goal });
    if (draft.instructions !== base.instructions) ops.push({ type: 'setInstructions', instructions: draft.instructions });
    // One Save, one undo step (step model spec §6a.2).
    sendEdit(graph.id, ops, 'edited the goal and instructions');
    setBase(draft);
  };
  // ⌘S saves this draft exactly as the Save button does (ruling R10a).
  const draftRef = useRef({ dirty, save });
  draftRef.current = { dirty, save };
  useEffect(() => registerGraphDraft({ dirty: () => draftRef.current.dirty, save: () => draftRef.current.save() }), []);

  return (
    <div className="node-panel">
      {changedUnderneath && dirty && (
        <p className="notice">
          The goal or instructions changed since you started editing; saving overwrites those changes.{' '}
          <button className="link" onClick={discard}>
            Discard my edits
          </button>
        </p>
      )}
      <div className="field">
        <label htmlFor="graph-goal">Goal</label>
        <input id="graph-goal" aria-label="Goal" value={draft.goal} placeholder="One line: what this workflow proves or produces" onChange={(e) => setDraft({ ...draft, goal: e.target.value })} />
      </div>
      <div className="field">
        <label htmlFor="graph-instructions">Instructions &amp; context</label>
        <textarea
          id="graph-instructions"
          aria-label="Instructions & context"
          rows={14}
          value={draft.instructions}
          placeholder="Guidance every agent step receives: targets, conventions, what never to touch."
          onChange={(e) => setDraft({ ...draft, instructions: e.target.value })}
        />
      </div>
      <p className="muted">Every agent step and the planner receive the goal and these instructions. Both can use variables, e.g. {'{{ target_schema }}'}.</p>
      <AttachmentList graphId={graph.id} target={{ kind: 'graph' }} names={graph.attachments ?? []} hint="Drop or paste files here. Every agent step gets them, after its own." />
      <div className="actions">
        <button className="primary" disabled={!dirty} onClick={save}>
          Save
        </button>
      </div>
    </div>
  );
}
