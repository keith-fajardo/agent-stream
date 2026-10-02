import type { Tab } from '../state';
import { dispatch, useStore } from '../store';
import { ChatPanel } from './ChatPanel';
import { GraphPanel } from './GraphPanel';
import { NodePanel } from './NodePanel';

const LABELS: Record<Tab, string> = { chat: 'Chat', node: 'Node', graph: 'Graph' };

export function RightPanel() {
  const tab = useStore((s) => s.tab);
  return (
    <aside className="side-panel">
      <nav className="tabs">
        {(Object.keys(LABELS) as Tab[]).map((t) => (
          <button key={t} className={tab === t ? 'active' : ''} onClick={() => dispatch({ kind: 'setTab', tab: t })}>
            {LABELS[t]}
          </button>
        ))}
      </nav>
      <div className="tab-body">{tab === 'chat' ? <ChatPanel /> : tab === 'node' ? <NodePanel /> : <GraphPanel />}</div>
    </aside>
  );
}
