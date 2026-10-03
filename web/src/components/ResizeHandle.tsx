import { useRef } from 'react';
import { BIG_STEP, STEP, clampLogs, clampSide, persistLayout } from '../panelLayout';
import { dispatch, getState } from '../store';

type Props = { panel: 'side' | 'logs' };

/** The drag handle on the side panel's left edge or the logs panel's top edge; also resizable with the arrow keys. */
export function ResizeHandle({ panel }: Props) {
  const side = panel === 'side';
  const drag = useRef<{ start: number; size: number } | undefined>(undefined);

  /** The panel being resized, and the area it may use (the graph tab's workspace). */
  const measure = (el: HTMLElement) => {
    const panelEl = el.parentElement!;
    const area = side ? panelEl.closest<HTMLElement>('.main') : panelEl.closest<HTMLElement>('.workspace');
    return { size: side ? panelEl.getBoundingClientRect().width : panelEl.getBoundingClientRect().height, area: (side ? area?.clientWidth : area?.clientHeight) ?? 0 };
  };
  const set = (size: number, area: number) => {
    dispatch({ kind: 'setLayout', layout: side ? { sideWidth: clampSide(size, area) } : { logsHeight: clampLogs(size, area) } });
  };

  return (
    <div
      className={`resize-handle ${side ? 'resize-side' : 'resize-logs'}`}
      role="separator"
      aria-orientation={side ? 'vertical' : 'horizontal'}
      aria-label={side ? 'Resize side panel' : 'Resize logs panel'}
      tabIndex={0}
      onPointerDown={(e) => {
        const { size } = measure(e.currentTarget);
        drag.current = { start: side ? e.clientX : e.clientY, size };
        e.currentTarget.setPointerCapture?.(e.pointerId);
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        // Dragging toward the canvas (left for the side panel, up for logs) grows the panel.
        const delta = side ? d.start - e.clientX : d.start - e.clientY;
        set(d.size + delta, measure(e.currentTarget).area);
      }}
      onPointerUp={(e) => {
        if (!drag.current) return;
        drag.current = undefined;
        e.currentTarget.releasePointerCapture?.(e.pointerId);
        persistLayout();
      }}
      onDoubleClick={() => {
        dispatch({ kind: 'setLayout', layout: side ? { sideWidth: 440 } : { logsHeight: null } });
        persistLayout();
      }}
      onKeyDown={(e) => {
        const grow = side ? e.key === 'ArrowLeft' : e.key === 'ArrowUp';
        const shrink = side ? e.key === 'ArrowRight' : e.key === 'ArrowDown';
        if (!grow && !shrink) return;
        e.preventDefault();
        const step = (e.shiftKey ? BIG_STEP : STEP) * (grow ? 1 : -1);
        const { size, area } = measure(e.currentTarget);
        const layout = getState().layout;
        set((side ? layout.sideWidth : (layout.logsHeight ?? size)) + step, area);
        persistLayout();
      }}
    />
  );
}
