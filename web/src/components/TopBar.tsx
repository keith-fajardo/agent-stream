import { PROVIDER_NAMES, checkoutChip, checkoutTooltip, modelLine, ranIn, statusLabel, waitingText } from '@agent-stream/shared';
import { actions } from '../actions';
import { send } from '../bridge';
import { useStore } from '../store';
import { MenuBar } from './MenuBar';

export function TopBar() {
  const status = useStore((s) => s.status);
  const graph = useStore((s) => s.graph);
  const runs = useStore((s) => s.runs);
  const run = useStore((s) => s.run);
  const graphs = useStore((s) => s.graphs);
  const checkout = useStore((s) => s.checkout);
  const running = run?.status === 'running';
  const graphName = (id: string) => graphs.find((g) => g.id === id)?.name ?? id;
  return (
    <header className="topbar">
      <MenuBar />
      {graph && (
        <span className="graph-name" title={graph.id}>
          {graph.name}
        </span>
      )}
      {checkout && (
        // Where this graph works (spec §7): its branch and worktree, refreshed on every checkout message.
        <span className="checkout-chip" title={checkoutTooltip(checkout.info)}>
          {checkoutChip(checkout.info)}
        </span>
      )}
      <span className="spacer" />
      {runs.length > 0 && (
        <select aria-label="Run" value={run?.id ?? ''} onChange={(e) => send({ type: 'selectRun', runId: e.target.value })}>
          {runs.map((r) => {
            // The selected run's own record is live and lists each change; other runs give the count alone.
            const selected = run?.id === r.id ? run : undefined;
            const n = (selected ? selected.amendments?.length : r.amendments) ?? 0;
            const waiting = selected ? selected.waitingFor : r.waitingFor;
            const ran = selected?.checkout ?? r.checkout;
            const title = [selected?.amendments?.map((a) => a.summary).join('\n'), ran && ranIn(ran), modelLine({ ...(selected ?? r), provider: r.provider })].filter(Boolean).join('\n');
            return (
              <option key={r.id} value={r.id} title={title}>
                {`Run ${r.id} · ${statusLabel(r.status)}${r.provider ? ` · ${PROVIDER_NAMES[r.provider]}` : ''}${n > 0 ? ` · ${n} change${n === 1 ? '' : 's'} by agents` : ''}${waiting ? ` · ${waitingText(waiting, graphName(waiting.graphId))}` : ''}`}
              </option>
            );
          })}
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
