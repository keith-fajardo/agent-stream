import { useEffect, useState } from 'react';
import { fmtDuration, statusLabel, type GraphNode, type NodeKind, type NodePatch } from '@claude-stream/shared';
import { send } from '../socket';
import { logKey } from '../state';
import { dispatch, useStore } from '../store';
import { LogView } from './LogView';

type Draft = { title: string; kind: NodeKind; prompt: string; command: string; timeoutSec: string };

const toDraft = (n: GraphNode): Draft => ({
  title: n.title,
  kind: n.kind,
  prompt: n.prompt ?? '',
  command: n.command ?? '',
  timeoutSec: n.timeoutSec ? String(n.timeoutSec) : '',
});
const sameDraft = (a: Draft, b: Draft) => JSON.stringify(a) === JSON.stringify(b);

export function NodePanel() {
  const graph = useStore((s) => s.graph);
  const selectedId = useStore((s) => s.selectedNodeId);
  const [view, setView] = useState<'edit' | 'logs'>('edit');
  const node = graph?.nodes.find((n) => n.id === selectedId);
  if (!graph || !node) return <p className="muted pad">Select a step on the canvas, or double-click empty canvas to add one.</p>;
  return (
    <div className="node-panel">
      <div className="subtabs">
        <button className={view === 'edit' ? 'active' : ''} onClick={() => setView('edit')}>
          Edit
        </button>
        <button className={view === 'logs' ? 'active' : ''} onClick={() => setView('logs')}>
          Logs
        </button>
      </div>
      {view === 'edit' ? <NodeEditor key={node.id} graphId={graph.id} node={node} /> : <NodeLogs node={node} />}
    </div>
  );
}

/** Edits a local draft; if someone else changes the node meanwhile, the user decides. */
function NodeEditor({ graphId, node }: { graphId: string; node: GraphNode }) {
  const run = useStore((s) => s.run);
  const runs = useStore((s) => s.runs);
  const [base, setBase] = useState(() => ({ draft: toDraft(node), at: node.updatedAt }));
  const [draft, setDraft] = useState<Draft>(base.draft);
  const dirty = !sameDraft(draft, base.draft);
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
        <label>Kind</label>
        <select value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value as NodeKind })}>
          <option value="agent">Agent: a Claude agent run</option>
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
          disabled={!latest || running}
          title={latest ? `Run this step and everything after it again, reusing run ${latest.id} for the rest` : 'Run the graph once first'}
          onClick={() => latest && dispatch({ kind: 'openConfirm', request: { fromNodeId: node.id, sourceRunId: latest.id } })}
        >
          Re-run from here
        </button>
        <button className="danger" onClick={() => send({ type: 'op', graphId, op: { type: 'deleteNode', id: node.id } })}>
          Delete
        </button>
      </div>
    </>
  );
}

function NodeLogs({ node }: { node: GraphNode }) {
  const run = useStore((s) => s.run);
  const state = run?.nodes[node.id];
  const key = run ? logKey(run.id, node.id) : '';
  const events = useStore((s) => (key ? s.logs[key] : undefined));
  const runId = run?.id;
  const hasState = state !== undefined;
  const loaded = events !== undefined;
  useEffect(() => {
    if (runId && hasState && !loaded) send({ type: 'getNodeLogs', runId, nodeId: node.id });
  }, [runId, node.id, hasState, loaded]);

  if (!run || !state) return <p className="muted">This step has no logs in the selected run.</p>;
  const sourceRunId = run.sourceRunId;
  return (
    <div className="logs">
      <div className="log-status">
        Run {run.id} · <b>{statusLabel(state.status)}</b>
        {state.durationMs !== undefined && ` · ${fmtDuration(state.durationMs)}`}
        {state.error && <div className="error">{state.error}</div>}
        {state.status === 'reused' && sourceRunId && (
          <div>
            Reused from run {sourceRunId}.{' '}
            <button className="link" onClick={() => send({ type: 'selectRun', runId: sourceRunId })}>
              Open that run
            </button>
          </div>
        )}
      </div>
      {events ? <LogView events={events} /> : <p className="muted">Loading…</p>}
    </div>
  );
}
