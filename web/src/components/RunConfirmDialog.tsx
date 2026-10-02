import { contentSignature } from '@claude-stream/shared';
import { describeRunPlan } from '../runPlan';
import { send } from '../socket';
import { dispatch, useStore } from '../store';

export function RunConfirmDialog() {
  const confirm = useStore((s) => s.confirm);
  const graph = useStore((s) => s.graph);
  const run = useStore((s) => s.run);
  if (!confirm || !graph) return null;
  const plan = describeRunPlan(graph, confirm, run);
  const close = () => dispatch({ kind: 'closeConfirm' });
  const start = () => {
    send({ type: 'startRun', graphId: graph.id, reviewed: contentSignature(graph), fromNodeId: confirm.fromNodeId, sourceRunId: confirm.sourceRunId });
    close();
  };
  return (
    <div className="modal-backdrop" onClick={close}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>{confirm.fromNodeId ? `Re-run from ${confirm.fromNodeId}` : 'Run workflow'}</h2>
        {plan.problems.length > 0 ? (
          <>
            <p>This graph can't run yet:</p>
            <ul>
              {plan.problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </>
        ) : (
          <>
            <p>
              {plan.agentCount} agent step{plan.agentCount === 1 ? '' : 's'} will run. Every file edit or shell command they attempt waits for your
              approval.
            </p>
            {plan.commands.length > 0 ? (
              <>
                <p>These commands will run exactly as written:</p>
                {plan.commands.map((n) => (
                  <div key={n.id}>
                    <div>
                      {n.id} · {n.title}
                    </div>
                    <pre className="mono">{n.command}</pre>
                  </div>
                ))}
              </>
            ) : (
              <p>No command steps will run.</p>
            )}
            {plan.reused.length > 0 && (
              <p className="muted">
                Reused from run {confirm.sourceRunId}: {plan.reused.join(', ')}
              </p>
            )}
            {!plan.exact && (
              <p className="muted">Showing every command step; steps unchanged since run {confirm.sourceRunId} will be reused instead of run again.</p>
            )}
          </>
        )}
        <div className="modal-actions">
          <button onClick={close}>Cancel</button>
          <button className="primary" disabled={plan.problems.length > 0} onClick={start}>
            Start run
          </button>
        </div>
      </div>
    </div>
  );
}
