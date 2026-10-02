import { ReactFlowProvider } from '@xyflow/react';
import { Canvas } from './components/Canvas';
import { TopBar } from './components/TopBar';
import { useStore } from './store';

export function App() {
  const auth = useStore((s) => s.auth);
  return (
    <div className="app">
      <TopBar />
      {auth && !auth.ok && <div className="banner">{auth.error} Restart claude-stream after signing in.</div>}
      <main className="main">
        <ReactFlowProvider>
          <Canvas />
        </ReactFlowProvider>
      </main>
    </div>
  );
}
