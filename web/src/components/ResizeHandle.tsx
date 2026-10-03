import { useEffect, useRef, useState } from 'react';
import { BIG_STEP, LOGS_MIN, MAX_SHARE, SIDE_DEFAULT, SIDE_MIN, STEP, clampLogs, clampSide, persistLayout } from '../panelLayout';
import { dispatch, getState, useStore } from '../store';

type Props = { panel: 'side' | 'logs' };

/** The drag handle on the side panel's left edge or the logs panel's top edge; also resizable with the arrow keys. */
export function ResizeHandle({ panel }: Props) {
  const side = panel === 'side';
  const drag = useRef<{ start: number; size: number } | undefined>(undefined);
  const el = useRef<HTMLDivElement>(null);
  const layout = useStore((s) => s.layout);
  // For aria-valuenow/max: what the panel measures now and the area it may use (re-measured when the window resizes).
  const [measured, setMeasured] = useState({ size: 0, area: 0 });
  useEffect(() => {
    const read = () => {
      if (!el.current) return;
      const next = measure(el.current);
      setMeasured((m) => (m.size === next.size && m.area === next.area ? m : next));
    };
    read();
    window.addEventListener('resize', read);
    return () => window.removeEventListener('resize', read);
  });

  /** The panel being resized, and the area it may use (the graph tab's workspace). */
  const measure = (el: HTMLElement) => {
    const panelEl = el.parentElement!;
    const area = side ? panelEl.closest<HTMLElement>('.main') : panelEl.closest<HTMLElement>('.workspace');
    return { size: side ? panelEl.getBoundingClientRect().width : panelEl.getBoundingClientRect().height, area: (side ? area?.clientWidth : area?.clientHeight) ?? 0 };
  };
  const set = (size: number, area: number) => {
    dispatch({ kind: 'setLayout', layout: side ? { sideWidth: clampSide(size, area) } : { logsHeight: clampLogs(size, area) } });
  };

  /** Ends a drag however it ended (release, cancel, lost capture, button already up): release, then remember the layout once. */
  const end = (target: HTMLElement, pointerId: number) => {
    if (!drag.current) return;
    drag.current = undefined;
    target.releasePointerCapture?.(pointerId);
    persistLayout();
  };
  const value = side ? layout.sideWidth : (layout.logsHeight ?? Math.round(measured.size));
  return (
    <div
      ref={el}
      className={`resize-handle ${side ? 'resize-side' : 'resize-logs'}`}
      role="separator"
      aria-orientation={side ? 'vertical' : 'horizontal'}
      aria-label={side ? 'Resize side panel' : 'Resize logs panel'}
      tabIndex={0}
      aria-valuenow={value}
      aria-valuemin={side ? SIDE_MIN : LOGS_MIN}
      aria-valuemax={Math.round(Math.max(side ? SIDE_MIN : LOGS_MIN, measured.area * MAX_SHARE))}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        const { size } = measure(e.currentTarget);
        drag.current = { start: side ? e.clientX : e.clientY, size };
        e.currentTarget.setPointerCapture?.(e.pointerId);
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        if (e.buttons === 0) return end(e.currentTarget, e.pointerId);
        // Dragging toward the canvas (left for the side panel, up for logs) grows the panel.
        const delta = side ? d.start - e.clientX : d.start - e.clientY;
        set(d.size + delta, measure(e.currentTarget).area);
      }}
      onPointerUp={(e) => end(e.currentTarget, e.pointerId)}
      onPointerCancel={(e) => end(e.currentTarget, e.pointerId)}
      onLostPointerCapture={(e) => end(e.currentTarget, e.pointerId)}
      onDoubleClick={() => {
        dispatch({ kind: 'setLayout', layout: side ? { sideWidth: SIDE_DEFAULT } : { logsHeight: null } });
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
