import { actions } from '../actions';
import type { CanvasMode } from '../state';
import { useStore } from '../store';

const MODES: { mode: CanvasMode; label: string }[] = [
  { mode: 'graph', label: 'Graph' },
  { mode: 'markdown', label: 'Markdown' },
];

/** Graph | Markdown, at the left of the canvas toolbar: what the canvas area shows. */
export function CanvasModeToggle() {
  const current = useStore((s) => s.canvasMode);
  return (
    <div className="segmented" role="group" aria-label="Show the graph as">
      {MODES.map(({ mode, label }) => (
        <button key={mode} className={mode === current ? 'on' : ''} aria-pressed={mode === current} onClick={() => actions.showCanvas(mode)}>
          {label}
        </button>
      ))}
    </div>
  );
}
