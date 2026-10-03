import type { Tab } from '../state';
import { actions } from '../actions';
import { persistLayout } from '../panelLayout';
import { dispatch, useStore } from '../store';
import { ChangesPanel } from './ChangesPanel';
import { GraphPanel } from './GraphPanel';
import { NodePanel } from './NodePanel';
import { ResizeHandle } from './ResizeHandle';

export function RightPanel() {
  const count = useStore((s) => s.changes.length);
  // The Changes tab only exists while agents have changes pending.
  const tab = useStore((s) => (s.tab === 'changes' && s.changes.length === 0 ? 'node' : s.tab));
  const tabs: [Tab, string][] = [['node', 'Node'], ['graph', 'Graph'], ...(count > 0 ? [['changes', `Changes (${count})`] as [Tab, string]] : [])];
  const { sideWidth, sideCollapsed } = useStore((s) => s.layout);
  const show = (t: Tab) => {
    dispatch({ kind: 'setTab', tab: t });
    persistLayout();
  };
  if (sideCollapsed)
    return (
      <aside className="side-panel collapsed" aria-label="Side panel (collapsed)">
        <button className="edge-toggle" aria-label="Expand side panel" aria-expanded={false} onClick={() => actions.toggleSidePanel()}>
          ‹
        </button>
        <nav className="side-rail">
          {tabs.map(([t, label]) => (
            <button key={t} aria-expanded={false} onClick={() => show(t)}>
              {label}
            </button>
          ))}
        </nav>
      </aside>
    );
  return (
    <aside className="side-panel" style={{ width: sideWidth }}>
      <ResizeHandle panel="side" />
      <button className="edge-toggle" aria-label="Collapse side panel" aria-expanded={true} onClick={() => actions.toggleSidePanel()}>
        ›
      </button>
      <nav className="tabs">
        {tabs.map(([t, label]) => (
          <button key={t} className={tab === t ? 'active' : ''} onClick={() => show(t)}>
            {label}
          </button>
        ))}
      </nav>
      <div className="tab-body">{tab === 'node' ? <NodePanel /> : tab === 'graph' ? <GraphPanel /> : <ChangesPanel />}</div>
    </aside>
  );
}
