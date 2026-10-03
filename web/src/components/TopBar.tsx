import { statusLabel } from '@agent-stream/shared';
import { actions } from '../actions';
import { send } from '../bridge';
import { useStore } from '../store';
import { MenuBar } from './MenuBar';

export function TopBar() {
  const status = useStore((s) => s.status);
  const graph = useStore((s) => s.graph);
  const runs = useStore((s) => s.runs);
  const run = useStore((s) => s.run);
  const running = run?.status === 'running';
  return (
    <header className="topbar">
      <MenuBar />
      {graph && (
        <span className="graph-name" title={graph.id}>
          {graph.name}
        </span>
      )}
      <span className="spacer" />
      {runs.length > 0 && (
        <select aria-label="Run" value={run?.id ?? ''} onChange={(e) => send({ type: 'selectRun', runId: e.target.value })}>
          {runs.map((r) => (
            <option key={r.id} value={r.id}>
              Run {r.id} · {statusLabel(r.status)}
            </option>
          ))}
        </select>
      )}
      {graph &&
        (running ? (
          <button className="danger" onClick={actions.stop}>
            ■ Stop
          </button>
        ) : (
          <button className="primary" disabled={!status?.ok} onClick={actions.run}>
            ▶ Run
          </button>
        ))}
    </header>
  );
}
