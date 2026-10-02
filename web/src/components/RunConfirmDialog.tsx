import { useEffect } from 'react';
import { send } from '../bridge';
import { dispatch, useStore } from '../store';

let requestCounter = 0;

/** Shows exactly what will run, as the engine rendered it (spec §7.6); Start sends the preview's signature. */
export function RunConfirmDialog() {
  const confirm = useStore((s) => s.confirm);
  const graph = useStore((s) => s.graph);
  const preview = useStore((s) => s.preview);
  const variableValues = useStore((s) => s.variableValues);

  useEffect(() => {
    if (confirm && graph) {
      const requestId = `preview-${++requestCounter}`;
      dispatch({ kind: 'previewRequested', requestId });
      send({ type: 'previewRun', graphId: graph.id, fromNodeId: confirm.fromNodeId, sourceRunId: confirm.sourceRunId, requestId });
    }
  }, [confirm, graph, variableValues]);

  if (!confirm || !graph) return null;
  const close = () => dispatch({ kind: 'closeConfirm' });
  const start = () => {
    if (!preview) return;
    send({ type: 'startRun', graphId: graph.id, reviewed: preview.signature, fromNodeId: confirm.fromNodeId, sourceRunId: confirm.sourceRunId });
    close();
  };
  const executing = preview?.steps.filter((s) => !s.reused) ?? [];
  const commands = executing.filter((s) => s.kind === 'command');
  const agents = executing.filter((s) => s.kind === 'agent');
  const reused = preview?.steps.filter((s) => s.reused) ?? [];

  return (
    <div className="modal-backdrop" onClick={close}>
      <div className="modal" role="dialog" aria-label="Run confirmation" onClick={(e) => e.stopPropagation()}>
        <h2>{confirm.fromNodeId ? `Re-run from ${confirm.fromNodeId}` : 'Run workflow'}</h2>
        {!preview ? (
          <p className="muted">Checking the run…</p>
        ) : (
          <>
            {preview.problems.length > 0 && (
              <div className="problems">
                <p>This run can't start yet:</p>
                <ul>
                  {preview.problems.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              </div>
            )}
            {preview.warnings.map((w) => (
              <p key={w} className="approval-warning">
                ⚠ {w}
              </p>
            ))}
            <p>
              {agents.length} agent step{agents.length === 1 ? '' : 's'} will run. Every file edit or shell command they attempt waits for your approval.
            </p>
            {commands.length > 0 ? (
              <>
                <p>These commands will run exactly as shown:</p>
                {commands.map((s) => (
                  <div key={s.id}>
                    <div>
                      {s.id} · {s.title}
                    </div>
                    <pre className="mono">{s.text}</pre>
                  </div>
                ))}
              </>
            ) : (
              <p>No command steps will run.</p>
            )}
            {agents.length > 0 && (
              <div className="agent-prompts">
                {agents.map((s) => (
                  <details key={s.id}>
                    <summary>
                      {s.id} · {s.title}
                    </summary>
                    <pre>{s.text}</pre>
                  </details>
                ))}
              </div>
            )}
            {preview.variables.length > 0 && (
              <table className="variables-used">
                <thead>
                  <tr>
                    <th>Variable</th>
                    <th>Value</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.variables.map((v) => (
                    <tr key={v.name}>
                      <td className="mono">{v.name}</td>
                      <td className="mono">{v.value}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {reused.length > 0 && (
              <p className="muted">
                Reused from run {preview.sourceRunId}: {reused.map((s) => s.id).join(', ')}
              </p>
            )}
          </>
        )}
        <div className="modal-actions">
          <button onClick={close}>Cancel</button>
          <button className="primary" disabled={!preview || preview.problems.length > 0} onClick={start}>
            Start run
          </button>
        </div>
      </div>
    </div>
  );
}
