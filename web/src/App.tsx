import { ReactFlowProvider } from '@xyflow/react';
import { Canvas } from './components/Canvas';
import { LogsPanel } from './components/LogsPanel';
import { RightPanel } from './components/RightPanel';
import { RunConfirmDialog } from './components/RunConfirmDialog';
import { Toast } from './components/Toast';
import { TopBar } from './components/TopBar';
import { useStore } from './store';

export function App() {
  const auth = useStore((s) => s.auth);
  return (
    <div className="app">
      <TopBar />
      {auth && !auth.ok && <div className="banner">{auth.error} Restart claude-stream once this is fixed.</div>}
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
      <Toast />
    </div>
  );
}
