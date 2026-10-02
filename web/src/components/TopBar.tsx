import { useEffect, useState } from 'react';
import { authLabel, statusLabel } from '@claude-stream/shared';
import { send } from '../bridge';
import { dispatch, useStore } from '../store';

export function TopBar() {
  const connected = useStore((s) => s.connected);
  const auth = useStore((s) => s.auth);
  const graphs = useStore((s) => s.graphs);
  const graph = useStore((s) => s.graph);
  const runs = useStore((s) => s.runs);
  const run = useStore((s) => s.run);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [goal, setGoal] = useState(graph?.goal ?? '');
  useEffect(() => setGoal(graph?.goal ?? ''), [graph?.id, graph?.goal]);
  const running = run?.status === 'running';

  const create = () => {
    if (name.trim()) send({ type: 'createGraph', name: name.trim() });
    setCreating(false);
    setName('');
  };
  const commitGoal = () => {
    if (graph && goal !== graph.goal) send({ type: 'op', graphId: graph.id, op: { type: 'setGoal', goal } });
  };

  return (
    <header className="topbar">
      <span className="brand">claude-stream</span>
      {creating ? (
        <span className="new-graph">
          <input
            autoFocus
            placeholder="Graph name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') create();
              if (e.key === 'Escape') setCreating(false);
            }}
          />
          <button onClick={create}>Create</button>
        </span>
      ) : (
        <>
          <select value={graph?.id ?? ''} onChange={(e) => send({ type: 'openGraph', graphId: e.target.value })}>
            {!graph && <option value="">No graph</option>}
            {graphs.map((g) => (
              <option key={g.id} value={g.id} disabled={!!g.error} title={g.error}>
                {g.name}
                {g.error ? ' (unreadable)' : ''}
              </option>
            ))}
          </select>
          <button onClick={() => setCreating(true)}>+ New</button>
        </>
      )}
      {graph && (
        <input
          className="goal"
          placeholder="Workflow goal: shared context for every agent step"
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          onBlur={commitGoal}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
          }}
        />
      )}
      {graph &&
        (running ? (
          <button className="danger" onClick={() => run && send({ type: 'stopRun', runId: run.id })}>
            Stop
          </button>
        ) : (
          <button className="primary" disabled={!auth?.ok} onClick={() => dispatch({ kind: 'openConfirm', request: {} })}>
            Run
          </button>
        ))}
      {runs.length > 0 && (
        <select value={run?.id ?? ''} onChange={(e) => send({ type: 'selectRun', runId: e.target.value })}>
          {runs.map((r) => (
            <option key={r.id} value={r.id}>
              {r.id} · {statusLabel(r.status)}
            </option>
          ))}
        </select>
      )}
      <span className={`auth ${auth?.ok ? 'ok' : 'bad'}`} title={auth?.error}>
        {connected ? (auth ? authLabel(auth) : '…') : 'Disconnected, reconnecting…'}
      </span>
    </header>
  );
}
