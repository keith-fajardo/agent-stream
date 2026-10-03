import { useEffect, useState } from 'react';
import { refinable, type GraphNode, type NodeKind, type NodePatch } from '@agent-stream/shared';
import { actions } from '../actions';
import { changedSentence, changeKey } from '../changeLabels';
import { post, send } from '../bridge';
import { dispatch, useStore } from '../store';

type Draft = { title: string; description: string; kind: NodeKind; prompt: string; command: string; timeoutSec: string };

const toDraft = (n: GraphNode): Draft => ({
  title: n.title,
  description: n.description ?? '',
  kind: n.kind,
  prompt: n.prompt ?? '',
  command: n.command ?? '',
  timeoutSec: n.timeoutSec ? String(n.timeoutSec) : '',
});
const sameDraft = (a: Draft, b: Draft) => JSON.stringify(a) === JSON.stringify(b);

export function NodePanel() {
  const graph = useStore((s) => s.graph);
  const selectedId = useStore((s) => s.selectedNodeId);
  const changes = useStore((s) => s.changes);
  const node = graph?.nodes.find((n) => n.id === selectedId);
  if (!graph || !node) return <p className="muted pad">Select a step on the canvas, or double-click empty canvas to add one.</p>;
  const changed = changes.find((c) => c.kind === 'node' && c.change === 'changed' && c.id === node.id);
  return (
    <div className="node-panel">
      {changed?.kind === 'node' && (
        <div className="change-banner">
          <span>{changedSentence(changed.by, changed.fields ?? [])}</span>
          <span className="actions">
            <button className="link" onClick={() => dispatch({ kind: 'selectChange', key: changeKey(changed) })}>
              Show before/after
            </button>
            <button onClick={() => actions.acceptChange({ kind: 'node', id: node.id })}>Accept</button>
            <button onClick={() => actions.revertChange({ kind: 'node', id: node.id })}>Revert</button>
          </span>
        </div>
      )}
      <NodeEditor key={node.id} graphId={graph.id} node={node} />
    </div>
  );
}

/** Edits a local draft; if someone else changes the node meanwhile, the user decides. */
function NodeEditor({ graphId, node }: { graphId: string; node: GraphNode }) {
  const run = useStore((s) => s.run);
  const runs = useStore((s) => s.runs);
  const status = useStore((s) => s.status);
  const [base, setBase] = useState(() => ({ draft: toDraft(node), at: node.updatedAt }));
  const [draft, setDraft] = useState<Draft>(base.draft);
  const dirty = !sameDraft(draft, base.draft);
  const canRefine = refinable({ ...node, title: draft.title, description: draft.description, prompt: draft.prompt, command: draft.command });
  useEffect(() => {
    post({ type: 'draftState', dirty });
  }, [dirty]);
  useEffect(() => () => post({ type: 'draftState', dirty: false }), []);
  const changedUnderneath = node.updatedAt !== base.at;

  useEffect(() => {
    if (changedUnderneath && !dirty) {
      const fresh = toDraft(node);
      setBase({ draft: fresh, at: node.updatedAt });
      setDraft(fresh);
    }
  }, [changedUnderneath, dirty, node]);

  const discard = () => {
    const fresh = toDraft(node);
    setBase({ draft: fresh, at: node.updatedAt });
    setDraft(fresh);
  };
  const save = () => {
    const patch: NodePatch = {};
    if (draft.title !== base.draft.title) patch.title = draft.title;
    if (draft.description !== base.draft.description) patch.description = draft.description;
    if (draft.kind !== base.draft.kind) patch.kind = draft.kind;
    if (draft.prompt !== base.draft.prompt) patch.prompt = draft.prompt;
    if (draft.command !== base.draft.command) patch.command = draft.command;
    const timeout = Number(draft.timeoutSec);
    if (draft.timeoutSec !== base.draft.timeoutSec && timeout > 0) patch.timeoutSec = timeout;
    send({ type: 'op', graphId, op: { type: 'updateNode', id: node.id, patch } });
    setBase({ draft, at: node.updatedAt });
  };
  const latest = runs[0];
  const running = run?.status === 'running';

  return (
    <>
      {changedUnderneath && dirty && (
        <p className="notice">
          This step changed since you started editing; saving overwrites those changes.{' '}
          <button className="link" onClick={discard}>
            Discard my edits
          </button>
        </p>
      )}
      <div className="field">
        <label>Title</label>
        <input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
      </div>
      <div className="field">
        <label htmlFor="node-description">Description</label>
        <textarea
          id="node-description"
          rows={3}
          maxLength={2000}
          value={draft.description}
          placeholder="In plain words: what this step does and why"
          onChange={(e) => setDraft({ ...draft, description: e.target.value })}
        />
      </div>
      <div className="field">
        <label>Kind</label>
        <select value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value as NodeKind })}>
          <option value="agent">Agent: an AI agent run</option>
          <option value="command">Command: an exact shell command</option>
        </select>
      </div>
      {draft.kind === 'agent' ? (
        <div className="field">
          <label>Prompt</label>
          <textarea
            rows={12}
            value={draft.prompt}
            placeholder="What this step should do, where, and what it should output."
            onChange={(e) => setDraft({ ...draft, prompt: e.target.value })}
          />
        </div>
      ) : (
        <>
          <div className="field">
            <label>Command (runs in the project folder)</label>
            <textarea rows={4} className="mono" value={draft.command} onChange={(e) => setDraft({ ...draft, command: e.target.value })} />
          </div>
          <div className="field">
            <label>Timeout in seconds (default 1800)</label>
            <input value={draft.timeoutSec} inputMode="numeric" onChange={(e) => setDraft({ ...draft, timeoutSec: e.target.value })} />
          </div>
        </>
      )}
      <p className="muted">
        {node.id} · created by {node.createdBy} · last edited by {node.updatedBy}
      </p>
      <div className="actions">
        <button className="primary" disabled={!dirty} onClick={save}>
          Save
        </button>
        <button
          disabled={!status?.ok || !canRefine}
          title={
            !status?.ok
              ? status?.error
              : canRefine
                ? 'Ask the planner to turn this step into a precise prompt or command, with a plain-language description'
                : 'Write what the step should do first.'
          }
          onClick={() => {
            if (dirty) save();
            actions.refine([node.id]);
          }}
        >
          {dirty ? 'Save and refine' : 'Refine with planner'}
        </button>
        <button
          disabled={!latest || running}
          title={latest ? `Run this step and everything after it again, reusing run ${latest.id} for the rest` : 'Run the graph once first'}
          onClick={actions.rerunFromSelected}
        >
          Re-run from here
        </button>
        <button className="danger" onClick={actions.deleteSelectedStep}>
          Delete
        </button>
      </div>
    </>
  );
}
