import { useEffect, useRef } from 'react';
import { PROVIDER_NAMES, fmtDuration, statusLabel, waitingText } from '@agent-stream/shared';
import { actions } from '../actions';
import { send } from '../bridge';
import { logKey } from '../state';
import { dispatch, useStore } from '../store';
import { ApprovalCard } from './ApprovalCard';
import { LogView } from './LogView';
import { ResizeHandle } from './ResizeHandle';

/** Logs of the selected step in the selected run, shown below the canvas while a step is selected. */
export function LogsPanel() {
  const graph = useStore((s) => s.graph);
  const selectedId = useStore((s) => s.selectedNodeId);
  const run = useStore((s) => s.run);
  const approvals = useStore((s) => s.approvals);
  const graphs = useStore((s) => s.graphs);
  const { logsHeight, logsCollapsed } = useStore((s) => s.layout);
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

  if (!graph || !node) return null;
  const sourceRunId = run?.sourceRunId;
  const waiting = run ? approvals.filter((a) => a.nodeId === node.id && a.runId === run.id) : [];
  const changedBy = [...new Set((run?.amendments ?? []).filter((a) => a.nodeId === node.id).map((a) => a.byNodeId))];
  // The step as it ran: its workspace and that run's worktree (spec §7).
  const ranAs = run?.snapshot.nodes.find((n) => n.id === node.id);
  const place = ranAs?.workspace ? run?.workspaces?.[ranAs.workspace] : undefined;
  const waitingFor = run?.waitingFor;
  const title = `Logs · ${node.id} ${node.title}`;
  if (logsCollapsed)
    return (
      <section className="logs-panel collapsed" aria-label="Step logs (collapsed)">
        <header className="logs-head">
          <span>{title}</span>
          <button className="link" aria-label="Expand logs panel" onClick={() => actions.toggleLogs()}>
            ▴
          </button>
        </header>
      </section>
    );
  return (
    <section className="logs-panel" aria-label="Step logs" style={logsHeight === null ? undefined : { height: logsHeight }}>
      <ResizeHandle panel="logs" />
      <header className="logs-head">
        <span>
          {title}
          {state && ` · ${statusLabel(state.status)}`}
          {state?.durationMs !== undefined && ` · ${fmtDuration(state.durationMs)}`}
          {run?.provider && ` · ${PROVIDER_NAMES[run.provider]}`}
          {changedBy.length > 0 && ` · changed during the run by ${changedBy.join(', ')}`}
        </span>
        {ranAs?.workspace && place && (
          <span className="logs-workspace">
            workspace {ranAs.workspace} · {place.path}
          </span>
        )}
        {waitingFor && <span className="logs-waiting">{waitingText(waitingFor, graphs.find((g) => g.id === waitingFor.graphId)?.name ?? waitingFor.graphId)}</span>}
        <button className="link" aria-label="Collapse logs panel" onClick={() => actions.toggleLogs()}>
          ▾
        </button>
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
