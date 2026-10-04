import { useEffect } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import { persistCanvasMode } from '../panelLayout';
import { useStore } from '../store';
import { Canvas } from './Canvas';
import { MarkdownEditor } from './MarkdownEditor';

/** The canvas area: the graph, or its Markdown file (Graph | Markdown toggle). The logs and the side panel stay. */
export function CanvasArea() {
  const mode = useStore((s) => s.canvasMode);
  // However the mode changed (the toggle, the View menu, a save from the switch dialog), this tab remembers it.
  useEffect(() => persistCanvasMode(), [mode]);
  if (mode === 'markdown') return <MarkdownEditor />;
  return (
    <ReactFlowProvider>
      <Canvas />
    </ReactFlowProvider>
  );
}
