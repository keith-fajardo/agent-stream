import { checkoutChip, modelLine, type PreviewStep } from '@agent-stream/shared';
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

/** A step in the run's outline: `n4 · Research (sub-graph "Company research", 3 steps)`, or `n4/n1 · Find site` with its kind. */
export function outlineLabel(s: PreviewStep): string {
  if (s.subgraph) return `${s.id} · ${s.title} (sub-graph "${s.subgraph.graphName}", ${s.subgraph.steps} step${s.subgraph.steps === 1 ? '' : 's'})`;
  return `${s.id} · ${s.title}`;
}

/** Shows exactly what will run, as the engine rendered it (spec §7.6); Start sends the preview's signature. */
export function RunConfirmDialog() {
  const confirm = useStore((s) => s.confirm);
  const graph = useStore((s) => s.graph);
  const preview = useStore((s) => s.preview);
  const variableValues = useStore((s) => s.variableValues);
  const blocked = useStore((s) => s.blocked);
  // A new model list changes which steps run their own model, so the preview's per-step notes are asked for again.
  const models = useStore((s) => s.models);

  useEffect(() => {
    if (confirm && graph) {
      const requestId = `preview-${++requestCounter}`;
      dispatch({ kind: 'previewRequested', requestId });
      send({ type: 'previewRun', graphId: graph.id, mode: confirm.mode, fromNodeId: confirm.fromNodeId, sourceRunId: confirm.sourceRunId, requestId });
    }
  }, [confirm, graph, variableValues, models]);

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
    const request = { graphId: graph.id, reviewed: preview.signature, mode: confirm.mode, fromNodeId: confirm.fromNodeId, sourceRunId: confirm.sourceRunId };
    send({ type: 'startRun', ...request });
    dispatch({ kind: 'startRequested', start: request });
    close();
  };
  // What the run is, in words: a retry names the run it continues; Run only and a re-run name their step.
  const what =
    confirm.mode === 'resume'
      ? `Retry run ${confirm.sourceRunId}`
      : confirm.mode === 'only' && confirm.fromNodeId
        ? `Run only ${confirm.fromNodeId}`
        : confirm.fromNodeId
          ? `Re-run from ${confirm.fromNodeId}`
          : undefined;
  const executing = preview?.steps.filter((s) => !s.reused && !s.notRun) ?? [];
  const commands = executing.filter((s) => s.kind === 'command');
  const agents = executing.filter((s) => s.kind === 'agent');
  const reused = preview?.steps.filter((s) => s.reused && !s.stale) ?? [];
  const kept = preview?.steps.filter((s) => s.reused && s.stale) ?? [];
  const notRun = preview?.steps.filter((s) => s.notRun) ?? [];

  return (
    <div className="modal-backdrop" onClick={close}>
      <div className="modal" role="dialog" aria-label="Run confirmation" onClick={(e) => e.stopPropagation()}>
        <h2>{confirm.requestedBy === 'planner' ? 'The planner asks to run this graph' : (what ?? 'Run workflow')}</h2>
        {confirm.requestedBy === 'planner' && what && <p className="muted">{what}</p>}
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
            {preview.steps.some((s) => s.subgraph) && (
              <ul className="run-steps" aria-label="Steps">
                {preview.steps.map((s) => (
                  <li key={s.id} className={`run-step kind-${s.kind}${s.reused ? ' reused' : ''}${s.notRun ? ' not-run' : ''}`} style={{ paddingLeft: `${(s.depth ?? 0) * 16}px` }}>
                    {outlineLabel(s)}
                    {!s.subgraph && <span className="muted"> {s.kind}</span>}
                  </li>
                ))}
              </ul>
            )}
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
                  <div key={s.id}>
                    <details>
                      <summary>
                        {s.id} · {s.title}
                      </summary>
                      <StepBrief text={s.description} />
                      <StepText text={s.text} />
                    </details>
                    {/* The step's own model and effort, under its prompt; a note never blocks the run. */}
                    {s.modelLine && <p className="step-model-line">{s.modelLine}</p>}
                    {s.modelNote && <p className="approval-warning">⚠ {s.modelNote}</p>}
                  </div>
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
                      <td className="mono">{v.label ?? v.name}</td>
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
            {kept.length > 0 && <p className="muted">Kept, marked stale: {kept.map((s) => s.id).join(', ')}</p>}
            {notRun.length > 0 && <p className="muted">Not run: {notRun.map((s) => s.id).join(', ')}</p>}
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
