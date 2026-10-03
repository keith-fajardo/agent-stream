import type { Tab } from '../state';
import { dispatch, useStore } from '../store';
import { ChangesPanel } from './ChangesPanel';
import { GraphPanel } from './GraphPanel';
import { NodePanel } from './NodePanel';

export function RightPanel() {
  const count = useStore((s) => s.changes.length);
  // The Changes tab only exists while agents have changes pending.
  const tab = useStore((s) => (s.tab === 'changes' && s.changes.length === 0 ? 'node' : s.tab));
  const tabs: [Tab, string][] = [['node', 'Node'], ['graph', 'Graph'], ...(count > 0 ? [['changes', `Changes (${count})`] as [Tab, string]] : [])];
  return (
    <aside className="side-panel">
      <nav className="tabs">
        {tabs.map(([t, label]) => (
          <button key={t} className={tab === t ? 'active' : ''} onClick={() => dispatch({ kind: 'setTab', tab: t })}>
            {label}
          </button>
        ))}
      </nav>
      <div className="tab-body">{tab === 'node' ? <NodePanel /> : tab === 'graph' ? <GraphPanel /> : <ChangesPanel />}</div>
    </aside>
  );
}
