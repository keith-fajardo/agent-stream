import { useEffect, useRef, useState } from 'react';
import { variableNameProblem, type Op, type VariableDef } from '@claude-stream/shared';
import { send } from '../bridge';
import { dispatch, useStore } from '../store';

type Row = { key: number; original?: string; name: string; value: string; description: string; deleted: boolean };

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
  const blank = (): Row => ({ key: nextKey.current++, name: '', value: '', description: '', deleted: false });
  const [rows, setRows] = useState<Row[]>(() => {
    const existing = p.variables.map((v) => ({ key: nextKey.current++, original: v.name, name: v.name, value: p.values[v.name] ?? '', description: v.description, deleted: false }));
    return p.addRow ? [...existing, blank()] : existing;
  });
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
  }
  const update = (key: number, patch: Partial<Row>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const close = () => dispatch({ kind: 'closeVariables' });
  const save = () => {
    const op = (o: Op) => send({ type: 'op', graphId: p.graphId, op: o });
    const before = new Map(p.variables.map((v) => [v.name, v]));
    for (const r of rows) if (r.deleted && r.original) op({ type: 'deleteVariable', name: r.original });
    for (const r of live) {
      if (r.original) {
        if (r.name !== r.original) op({ type: 'renameVariable', name: r.original, newName: r.name });
        if (r.description.trim() !== (before.get(r.original)?.description ?? '')) op({ type: 'setVariableDescription', name: r.name, description: r.description.trim() });
        if (r.value !== (p.values[r.original] ?? '')) send({ type: 'setVariableValue', graphId: p.graphId, name: r.name, value: r.value });
      } else {
        op(r.description.trim() ? { type: 'addVariable', name: r.name, description: r.description.trim() } : { type: 'addVariable', name: r.name });
        if (r.value !== '') send({ type: 'setVariableValue', graphId: p.graphId, name: r.name, value: r.value });
      }
    }
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
