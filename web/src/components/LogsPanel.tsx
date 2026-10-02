import { useEffect, useRef } from 'react';
import { fmtDuration, statusLabel } from '@claude-stream/shared';
import { send } from '../bridge';
import { logKey } from '../state';
import { dispatch, useStore } from '../store';
import { ApprovalCard } from './ApprovalCard';
import { LogView } from './LogView';

/** Logs of the selected step in the selected run, shown below the canvas while a step is selected. */
export function LogsPanel() {
  const graph = useStore((s) => s.graph);
  const selectedId = useStore((s) => s.selectedNodeId);
  const run = useStore((s) => s.run);
  const approvals = useStore((s) => s.approvals);
  const logsHidden = useStore((s) => s.logsHidden);
  const node = graph?.nodes.find((n) => n.id === selectedId);
  const state = node && run ? run.nodes[node.id] : undefined;
  const key = run && node ? logKey(run.id, node.id) : '';
  const events = useStore((s) => (key ? s.logs[key] : undefined));
  const body = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);

  const runId = run?.id;
  const nodeId = node?.id;
  const hasState = state !== undefined;
  const loaded = events !== undefined;
  useEffect(() => {
    if (runId && nodeId && hasState && !loaded) send({ type: 'getNodeLogs', runId, nodeId });
  }, [runId, nodeId, hasState, loaded]);

  // Follow new lines while the step runs, unless the user scrolled up to read.
  const eventCount = events?.length ?? 0;
  useEffect(() => {
    atBottom.current = true;
  }, [runId, nodeId]);
  useEffect(() => {
    const el = body.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [eventCount, runId, nodeId]);

  if (!graph || !node || logsHidden) return null;
  const sourceRunId = run?.sourceRunId;
  const waiting = run ? approvals.filter((a) => a.nodeId === node.id && a.runId === run.id) : [];
  return (
    <section className="logs-panel" aria-label="Step logs">
      <header className="logs-head">
        <span>
          Logs · {node.id} {node.title}
          {state && ` · ${statusLabel(state.status)}`}
          {state?.durationMs !== undefined && ` · ${fmtDuration(state.durationMs)}`}
        </span>
        <button className="link" aria-label="Close logs" onClick={() => dispatch({ kind: 'selectNode' })}>
          ✕
        </button>
      </header>
      {waiting.length > 0 && (
        <div className="logs-pinned">
          {waiting.map((a) => (
            <ApprovalCard key={a.id} request={a} />
          ))}
        </div>
      )}
      <div
        className="logs-body"
        ref={body}
        onScroll={(e) => {
          const el = e.currentTarget;
          atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
      >
        {!run || !state ? (
          <p className="muted">This step hasn't run in the selected run.</p>
        ) : (
          <>
            {state.error && <div className="error">{state.error}</div>}
            {state.status === 'reused' && sourceRunId && (
              <div>
                Reused from run {sourceRunId}.{' '}
                <button className="link" onClick={() => send({ type: 'selectRun', runId: sourceRunId })}>
                  Open that run
                </button>
              </div>
            )}
            {events ? <LogView events={events} /> : <p className="muted">Loading…</p>}
          </>
        )}
      </div>
    </section>
  );
}
