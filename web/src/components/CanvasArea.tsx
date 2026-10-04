import { useEffect } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import { reportDraft } from '../draftState';
import { persistCanvasMode } from '../panelLayout';
import { useStore } from '../store';
import { Canvas } from './Canvas';
import { MarkdownEditor } from './MarkdownEditor';

/** The canvas area: the graph, or its Markdown file (Graph | Markdown toggle). The logs and the side panel stay. */
export function CanvasArea() {
  const mode = useStore((s) => s.canvasMode);
  // However the mode changed (the toggle, the View menu, a save from the switch dialog), this tab remembers it.
  useEffect(() => persistCanvasMode(), [mode]);
  // Unsaved Markdown is unsaved work in this tab, like a step's unsaved edits.
  const markdownDirty = useStore((s) => s.markdown.draft !== undefined);
  useEffect(() => reportDraft('markdown', markdownDirty), [markdownDirty]);
  if (mode === 'markdown') return <MarkdownEditor />;
  return (
    <ReactFlowProvider>
      <Canvas />
    </ReactFlowProvider>
  );
}
