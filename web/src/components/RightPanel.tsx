import type { Tab } from '../state';
import { dispatch, useStore } from '../store';
import { ApprovalsPanel } from './ApprovalsPanel';
import { ChatPanel } from './ChatPanel';
import { NodePanel } from './NodePanel';

const LABELS: Record<Tab, string> = { chat: 'Chat', node: 'Node', approvals: 'Approvals' };

export function RightPanel() {
  const tab = useStore((s) => s.tab);
  const approvals = useStore((s) => s.approvals);
  return (
    <aside className="side-panel">
      <nav className="tabs">
        {(Object.keys(LABELS) as Tab[]).map((t) => (
          <button
            key={t}
            className={[tab === t ? 'active' : '', t === 'approvals' && approvals.length > 0 ? 'attention' : ''].filter(Boolean).join(' ')}
            onClick={() => dispatch({ kind: 'setTab', tab: t })}
          >
            {LABELS[t]}
            {t === 'approvals' && approvals.length > 0 ? ` (${approvals.length})` : ''}
          </button>
        ))}
      </nav>
      <div className="tab-body">{tab === 'chat' ? <ChatPanel /> : tab === 'node' ? <NodePanel /> : <ApprovalsPanel />}</div>
    </aside>
  );
}
