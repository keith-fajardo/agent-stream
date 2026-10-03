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
  const auth = useStore((s) => s.auth);
  return (
    <div className="app">
      <TopBar />
      {auth && !auth.ok && <div className="banner">{auth.error} Fix this, then use Retry in the Agent Stream sidebar.</div>}
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
