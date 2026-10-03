import { ReactFlowProvider } from '@xyflow/react';
import { Canvas } from './components/Canvas';
import { LogsPanel } from './components/LogsPanel';
import { RightPanel } from './components/RightPanel';
import { RunConfirmDialog } from './components/RunConfirmDialog';
import { Toast } from './components/Toast';
import { TopBar } from './components/TopBar';
import { VariablesDialog } from './components/VariablesDialog';
import { useStore } from './store';

export function App() {
  const status = useStore((s) => s.status);
  return (
    <div className="app">
      <TopBar />
      {status && !status.ok && <div className="banner">{status.preview ? status.error : `${status.error} Fix this, then use Check again in the Agent Stream sidebar.`}</div>}
      <main className="main">
        <div className="workspace">
          <ReactFlowProvider>
            <Canvas />
          </ReactFlowProvider>
          <LogsPanel />
        </div>
        <RightPanel />
      </main>
      <RunConfirmDialog />
      <VariablesDialog />
      <Toast />
    </div>
  );
}
