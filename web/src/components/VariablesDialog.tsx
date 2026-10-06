import { useEffect, useRef, useState } from 'react';
import { variableNameProblem, type Op, type VariableDef } from '@agent-stream/shared';
import { sendEdit } from '../actions';
import { send } from '../bridge';
import { dispatch, useStore } from '../store';

type Row = {
  key: number;
  original?: string;
  originalValue: string;
  originalDescription: string;
  name: string;
  value: string;
  description: string;
  deleted: boolean;
};

export function VariablesDialog() {
  const request = useStore((s) => s.variablesDialog);
  const graph = useStore((s) => s.graph);
  const values = useStore((s) => s.variableValues);
  if (!request || !graph) return null;
  return <VariablesEditor graphId={graph.id} variables={graph.variables} values={values} focus={request.focus} addRow={request.addRow} />;
}

/** Edits every variable at once; Save sends only what changed (spec §7.3). Values never leave this machine. */
function VariablesEditor(p: { graphId: string; variables: VariableDef[]; values: Record<string, string>; focus?: string; addRow?: boolean }) {
  const nextKey = useRef(0);
  const blank = (): Row => ({ key: nextKey.current++, originalValue: '', originalDescription: '', name: '', value: '', description: '', deleted: false });
  const seed = (): Row[] =>
    p.variables.map((v) => {
      const value = p.values[v.name] ?? '';
      return { key: nextKey.current++, original: v.name, originalValue: value, originalDescription: v.description, name: v.name, value, description: v.description, deleted: false };
    });
  const snapshotOf = () => JSON.stringify([p.variables.map((v) => [v.name, v.description]), p.values]);
  const [rows, setRows] = useState<Row[]>(() => (p.addRow ? [...seed(), blank()] : seed()));
  const [opened, setOpened] = useState(snapshotOf);
  const changedMeanwhile = snapshotOf() !== opened;
  const reload = () => {
    setRows(seed());
    setOpened(snapshotOf());
  };
  const focusTarget = useRef<HTMLInputElement>(null);
  // Block body: an effect must never return what a DOM call returns (Chrome 154's scrollIntoView returns a Promise).
  useEffect(() => {
    focusTarget.current?.focus();
  }, []);

  const live = rows.filter((r) => !r.deleted);
  const errors = new Map<number, string>();
  for (const r of live) {
    const others = live.filter((o) => o.key !== r.key).map((o) => ({ name: o.name, description: '' }));
    const problem = variableNameProblem(r.name, others);
    if (problem) errors.set(r.key, problem);
    else if (r.name !== r.original && live.some((o) => o.key !== r.key && o.original === r.name))
      errors.set(r.key, `Another variable is called "${r.name}" until you save. Rename that one first, then save again.`);
  }
  const update = (key: number, patch: Partial<Row>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const close = () => dispatch({ kind: 'closeVariables' });
  const save = () => {
    // The dialog's Save is one action, so one undo step (step model spec §6a.2); values are sent after the edits they follow.
    const ops: Op[] = [];
    const values: { name: string; value: string }[] = [];
    const op = (o: Op) => ops.push(o);
    const current = new Set(p.variables.map((v) => v.name));
    // A variable the planner renamed or deleted meanwhile no longer exists under its opened name: skip it.
    const stillThere = (r: Row) => r.original !== undefined && current.has(r.original);
    for (const r of rows) if (r.deleted && r.original !== undefined && stillThere(r)) op({ type: 'deleteVariable', name: r.original });
    for (const r of live) {
      if (r.original !== undefined) {
        if (!stillThere(r)) continue;
        if (r.name !== r.original) op({ type: 'renameVariable', name: r.original, newName: r.name });
        if (r.description.trim() !== r.originalDescription) op({ type: 'setVariableDescription', name: r.name, description: r.description.trim() });
        if (r.value !== r.originalValue) values.push({ name: r.name, value: r.value });
      } else {
        op(r.description.trim() ? { type: 'addVariable', name: r.name, description: r.description.trim() } : { type: 'addVariable', name: r.name });
        if (r.value !== '') values.push({ name: r.name, value: r.value });
      }
    }
    sendEdit(p.graphId, ops, 'edited the variables');
    for (const v of values) send({ type: 'setVariableValue', graphId: p.graphId, name: v.name, value: v.value });
    close();
  };
  const lastNew = [...live].reverse().find((r) => !r.original);

  return (
    <div
      className="modal-backdrop"
      onClick={close}
      onKeyDown={(e) => {
        if (e.key === 'Escape') close();
      }}
    >
      <div className="modal variables-dialog" role="dialog" aria-label="Variables" onClick={(e) => e.stopPropagation()}>
        <h2>Variables</h2>
        <p className="muted">
          Use them in steps as {'{{ name }}'}. Values stay on this machine: they are never saved in the graph file or exported. A value can read an
          environment variable: {"{{ env_var('NAME', 'default') }}"}.
        </p>
        {changedMeanwhile && (
          <div className="banner">
            The variables changed while you were editing; saving overwrites those changes. <button onClick={reload}>Reload</button>
          </div>
        )}
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Value</th>
              <th>Description</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {live.map((r) => (
              <tr key={r.key}>
                <td>
                  <input
                    aria-label="Name"
                    className="mono"
                    value={r.name}
                    ref={p.addRow && r === lastNew ? focusTarget : undefined}
                    onChange={(e) => update(r.key, { name: e.target.value })}
                  />
                  {errors.has(r.key) && <div className="field-error">{errors.get(r.key)}</div>}
                </td>
                <td>
                  <input
                    aria-label="Value"
                    className="mono"
                    value={r.value}
                    placeholder="not set"
                    ref={!p.addRow && r.original !== undefined && r.original === p.focus ? focusTarget : undefined}
                    onChange={(e) => update(r.key, { value: e.target.value })}
                  />
                </td>
                <td>
                  <input aria-label="Description" value={r.description} onChange={(e) => update(r.key, { description: e.target.value })} />
                </td>
                <td>
                  <button className="link" aria-label={`Delete ${r.name || 'new variable'}`} onClick={() => update(r.key, { deleted: true })}>
                    ✕
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <button onClick={() => setRows((rs) => [...rs, blank()])}>Add variable</button>
        <div className="modal-actions">
          <button onClick={close}>Cancel</button>
          <button className="primary" disabled={errors.size > 0} onClick={save}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
