import { checkoutChip, modelLine } from '@agent-stream/shared';
import { useEffect } from 'react';
import { post, send } from '../bridge';
import { dispatch, useStore } from '../store';

let requestCounter = 0;

/** A step's command or prompt, or a note while the engine can't fill it in yet. */
function StepText({ text, className }: { text?: string; className?: string }) {
  if (text === undefined) return <p className="muted">Shown here once every variable it uses has a value.</p>;
  return <pre className={className}>{text}</pre>;
}

function StepBrief({ text }: { text?: string }) {
  return text ? <p className="muted step-brief">In short: {text}</p> : null;
}

/** Shows exactly what will run, as the engine rendered it (spec §7.6); Start sends the preview's signature. */
export function RunConfirmDialog() {
  const confirm = useStore((s) => s.confirm);
  const graph = useStore((s) => s.graph);
  const preview = useStore((s) => s.preview);
  const variableValues = useStore((s) => s.variableValues);
  const blocked = useStore((s) => s.blocked);

  useEffect(() => {
    if (confirm && graph) {
      const requestId = `preview-${++requestCounter}`;
      dispatch({ kind: 'previewRequested', requestId });
      send({ type: 'previewRun', graphId: graph.id, fromNodeId: confirm.fromNodeId, sourceRunId: confirm.sourceRunId, requestId });
    }
  }, [confirm, graph, variableValues]);

  if (blocked && graph) {
    // Another run is changing files in this checkout (spec §7): separate tickets, or wait for it.
    const dismiss = () => dispatch({ kind: 'closeBlocked' });
    const runAfter = () => {
      if (blocked.start) send({ type: 'startRun', ...blocked.start, sequential: true });
      dismiss();
    };
    return (
      <div className="modal-backdrop" onClick={dismiss}>
        <div className="modal" role="dialog" aria-label="Run blocked" onClick={(e) => e.stopPropagation()}>
          <h2>Can't start yet</h2>
          <p>{blocked.message}</p>
          <div className="modal-actions">
            <button onClick={dismiss}>Cancel</button>
            {blocked.canSetUpTickets && (
              <button
                onClick={() => {
                  post({ type: 'setUpParallelTickets' });
                  dismiss();
                }}
              >
                Set Up Parallel Tickets
              </button>
            )}
            <button className="primary" disabled={!blocked.start} onClick={runAfter}>
              Run after it finishes
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (!confirm || !graph) return null;
  const close = () => dispatch({ kind: 'closeConfirm' });
  const start = () => {
    if (!preview) return;
    const request = { graphId: graph.id, reviewed: preview.signature, fromNodeId: confirm.fromNodeId, sourceRunId: confirm.sourceRunId };
    send({ type: 'startRun', ...request });
    dispatch({ kind: 'startRequested', start: request });
    close();
  };
  const executing = preview?.steps.filter((s) => !s.reused) ?? [];
  const commands = executing.filter((s) => s.kind === 'command');
  const agents = executing.filter((s) => s.kind === 'agent');
  const reused = preview?.steps.filter((s) => s.reused) ?? [];

  return (
    <div className="modal-backdrop" onClick={close}>
      <div className="modal" role="dialog" aria-label="Run confirmation" onClick={(e) => e.stopPropagation()}>
        <h2>{confirm.requestedBy === 'planner' ? 'The planner asks to run this graph' : confirm.fromNodeId ? `Re-run from ${confirm.fromNodeId}` : 'Run workflow'}</h2>
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
            {preview.checkout && (
              <p className="checkout-line">
                Checkout: {checkoutChip(preview.checkout)} · {preview.checkout.root}
              </p>
            )}
            {preview.notes?.map((n) => (
              <p key={n} className="run-note">
                ℹ {n}
              </p>
            ))}
            {preview.warnings.map((w) => (
              <p key={w} className="approval-warning">
                ⚠ {w}
              </p>
            ))}
            {agents.length > 0 && <p className="model-line">{modelLine({ model: preview.model?.value, label: preview.model?.label, effort: preview.effort, provider: preview.provider })}</p>}
            {agents.length > 0 && preview.copilotRequestsPerStep !== undefined && <p className="cap-line">Copilot requests per step: up to {preview.copilotRequestsPerStep}</p>}
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
                    <StepBrief text={s.description} />
                    <StepText className="mono" text={s.text} />
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
                    <StepBrief text={s.description} />
                    <StepText text={s.text} />
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
          <button onClick={close}>{confirm.requestedBy === 'planner' ? 'Not now' : 'Cancel'}</button>
          <button className="primary" disabled={!preview || preview.problems.length > 0} onClick={start}>
            Start run
          </button>
        </div>
      </div>
    </div>
  );
}
