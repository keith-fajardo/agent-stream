import { useEffect } from 'react';
import { CanvasArea } from './components/CanvasArea';
import { ChangeConfirmDialog } from './components/ChangeConfirmDialog';
import { GraphFileNotice } from './components/GraphFileNotice';
import { LogsPanel } from './components/LogsPanel';
import { RightPanel } from './components/RightPanel';
import { RunConfirmDialog } from './components/RunConfirmDialog';
import { Toast } from './components/Toast';
import { TopBar } from './components/TopBar';
import { VariablesDialog } from './components/VariablesDialog';
import { onShortcutKey } from './shortcuts';
import { useStore } from './store';

export function App() {
  const status = useStore((s) => s.status);
  useEffect(() => {
    document.addEventListener('keydown', onShortcutKey);
    return () => document.removeEventListener('keydown', onShortcutKey);
  }, []);
  return (
    <div className="app">
      <TopBar />
      {status && !status.ok && <div className="banner">{`${status.error} Fix this, then use Check again in the Agent Stream sidebar.`}</div>}
      <GraphFileNotice />
      <main className="main">
        <div className="workspace">
          <CanvasArea />
          <LogsPanel />
        </div>
        <RightPanel />
      </main>
      <RunConfirmDialog />
      <ChangeConfirmDialog />
      <VariablesDialog />
      <Toast />
    </div>
  );
}
