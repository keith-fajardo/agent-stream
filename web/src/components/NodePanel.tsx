import { useEffect, useRef, useState } from 'react';
import { parseStepModel, refinable, stepModelText, type EffortLevel, type GraphNode, type ModelChoice, type NodeKind, type NodePatch } from '@agent-stream/shared';
import { actions, registerNodeDraft } from '../actions';
import { changedSentence, changeKey } from '../changeLabels';
import { send } from '../bridge';
import { reportDraft } from '../draftState';
import { effortMenu, effortsFor, modelMenu, type MenuOption } from '../stepModelMenus';
import { dispatch, useStore } from '../store';

/** `model`: `<provider>/<id>`, '' for Default; `effort`: a level, '' for Default. */
type Draft = { title: string; description: string; kind: NodeKind; access: 'read' | 'write'; workspace: string; model: string; effort: string; prompt: string; command: string; timeoutSec: string };

const toDraft = (n: GraphNode): Draft => ({
  title: n.title,
  description: n.description ?? '',
  kind: n.kind,
  access: n.access === 'read' ? 'read' : 'write',
  workspace: n.workspace ?? '',
  model: n.model ? stepModelText(n.model) : '',
  effort: n.effort ?? '',
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
  const workspaces = [...new Set(graph.nodes.flatMap((n) => (n.workspace ? [n.workspace] : [])))].sort();
  const changed = changes.find((c) => c.kind === 'node' && c.change === 'changed' && c.id === node.id);
  return (
    <div className="node-panel">
      {changed?.kind === 'node' && (
        <div className="change-banner">
          <span>{changedSentence(changed.by, changed.fields ?? [])}</span>
          <span className="actions">
            <button className="link" onClick={() => actions.selectChange(changeKey(changed))}>
              Show before/after
            </button>
            <button onClick={() => actions.acceptChange({ kind: 'node', id: node.id })}>Accept</button>
            <button onClick={() => actions.revertChange({ kind: 'node', id: node.id })}>Revert</button>
          </span>
        </div>
      )}
      <NodeEditor key={node.id} graphId={graph.id} node={node} workspaces={workspaces} />
    </div>
  );
}

const NO_MODELS: ModelChoice[] = [];
const options = (list: MenuOption[]) =>
  list.map((o) => (
    <option key={o.value} value={o.value} disabled={o.disabled}>
      {o.label}
    </option>
  ));

/** An agent step's own Model and Effort (step model spec §4.1), saved with the panel's other edits. */
function StepModelFields({ model, effort, onChange }: { model: string; effort: string; onChange(next: { model: string; effort: string }): void }) {
  const statusProvider = useStore((s) => s.status?.provider);
  const listProvider = useStore((s) => s.modelsProvider);
  const provider = listProvider ?? statusProvider;
  const models = useStore((s) => (s.modelsProvider === provider ? s.models : NO_MODELS));
  const defaultEfforts = useStore((s) => s.defaultEfforts);
  const menu = modelMenu(provider, models, model);
  const efforts = effortMenu(provider, models, defaultEfforts, model, effort);
  // An effort the new model doesn't offer goes back to Default.
  const pickModel = (next: string) => {
    const levels = provider === 'copilot' ? [] : effortsFor(provider, models, defaultEfforts, next);
    onChange({ model: next, effort: effort && levels && !levels.includes(effort as EffortLevel) ? '' : effort });
  };
  return (
    <>
      <div className="field">
        <label htmlFor="node-model">Model</label>
        <div className="field-row">
          <select id="node-model" value={model} onChange={(e) => pickModel(e.target.value)}>
            {options(menu.options)}
            {menu.pinned.length > 0 && <optgroup label="Pinned versions">{options(menu.pinned)}</optgroup>}
            {menu.extra && options([menu.extra])}
          </select>
          {menu.otherProvider && <button onClick={() => pickModel('')}>Use Default</button>}
        </div>
      </div>
      <div className="field">
        <label htmlFor="node-effort">Effort</label>
        <div className="field-row">
          <select id="node-effort" value={effort} disabled={efforts.disabled} onChange={(e) => onChange({ model, effort: e.target.value })}>
            {options(efforts.options)}
          </select>
          {efforts.disabled && effort && <button onClick={() => onChange({ model, effort: '' })}>Use Default</button>}
        </div>
      </div>
    </>
  );
}

/** Edits a local draft; if someone else changes the node meanwhile, the user decides. */
function NodeEditor({ graphId, node, workspaces }: { graphId: string; node: GraphNode; workspaces: string[] }) {
  const run = useStore((s) => s.run);
  const runs = useStore((s) => s.runs);
  const status = useStore((s) => s.status);
  const [base, setBase] = useState(() => ({ draft: toDraft(node), at: node.updatedAt }));
  const [draft, setDraft] = useState<Draft>(base.draft);
  const dirty = !sameDraft(draft, base.draft);
  const canRefine = refinable({ ...node, title: draft.title, description: draft.description, prompt: draft.prompt, command: draft.command });
  useEffect(() => {
    reportDraft('node', dirty);
  }, [dirty]);
  useEffect(() => () => reportDraft('node', false), []);
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
    if (draft.access !== base.draft.access && draft.kind === 'agent') patch.access = draft.access;
    if (draft.workspace !== base.draft.workspace) patch.workspace = draft.workspace.trim();
    // Only agent steps have a model or effort; becoming a command step drops them in the engine.
    if (draft.kind === 'agent' && draft.model !== base.draft.model) {
      const parsed = draft.model ? parseStepModel(draft.model) : undefined;
      patch.model = parsed?.ok ? parsed.model : null;
    }
    if (draft.kind === 'agent' && draft.effort !== base.draft.effort) patch.effort = (draft.effort || null) as EffortLevel | null;
    if (draft.prompt !== base.draft.prompt) patch.prompt = draft.prompt;
    if (draft.command !== base.draft.command) patch.command = draft.command;
    const timeout = Number(draft.timeoutSec);
    if (draft.timeoutSec !== base.draft.timeoutSec && timeout > 0) patch.timeoutSec = timeout;
    send({ type: 'op', graphId, op: { type: 'updateNode', id: node.id, patch } });
    setBase({ draft, at: node.updatedAt });
  };
  // ⌘S saves this draft exactly as the Save button does (spec §6a.1).
  const draftRef = useRef({ dirty, save });
  draftRef.current = { dirty, save };
  useEffect(() => registerNodeDraft({ nodeId: node.id, dirty: () => draftRef.current.dirty, save: () => draftRef.current.save() }), [node.id]);
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
          <label htmlFor="node-access">Access</label>
          <select id="node-access" value={draft.access} onChange={(e) => setDraft({ ...draft, access: e.target.value as Draft['access'] })}>
            <option value="write">Can edit files</option>
            <option value="read">Read-only</option>
          </select>
        </div>
      ) : (
        <div className="field">
          <label>Access</label>
          <p className="static-note">Command steps can change files</p>
        </div>
      )}
      <div className="field">
        <label htmlFor="node-workspace">Workspace</label>
        <input id="node-workspace" list="workspace-names" value={draft.workspace} placeholder="This checkout" onChange={(e) => setDraft({ ...draft, workspace: e.target.value })} />
        <datalist id="workspace-names">
          {workspaces.map((w) => (
            <option key={w} value={w} />
          ))}
        </datalist>
      </div>
      {draft.kind === 'agent' && <StepModelFields model={draft.model} effort={draft.effort} onChange={(next) => setDraft({ ...draft, ...next })} />}
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
          disabled={!status?.ok || !canRefine}
          title={
            !status?.ok
              ? status?.error
              : canRefine
                ? 'Ask the planner to break this step into several connected steps'
                : 'Write what the step should do first.'
          }
          onClick={() => {
            if (dirty) save();
            actions.split(node.id);
          }}
        >
          {dirty ? 'Save and split' : 'Split into steps'}
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
