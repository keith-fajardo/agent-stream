import { useEffect, useRef, useState } from 'react';
import { buildMenus, type Menu } from '../menuModel';
import { useStore } from '../store';

/** File · Edit · Run · Variables · View inside the graph tab (VS Code doesn't let extensions add top-level menus). */
export function MenuBar() {
  const state = useStore((s) => s);
  const [open, setOpen] = useState<Menu['id'] | undefined>();
  const bar = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      if (!bar.current?.contains(e.target as Node)) setOpen(undefined);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(undefined);
    };
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <nav className="menubar" ref={bar} aria-label="Menu bar">
      {buildMenus(state).map((m) => (
        <div key={m.id} className="menu">
          <button
            className={open === m.id ? 'open' : ''}
            aria-haspopup="menu"
            aria-expanded={open === m.id}
            onClick={() => setOpen(open === m.id ? undefined : m.id)}
            onMouseEnter={() => {
              if (open && open !== m.id) setOpen(m.id);
            }}
          >
            {m.label}
          </button>
          {open === m.id && (
            <div className="menu-items" role="menu">
              {m.items.map((entry, i) =>
                'separator' in entry ? (
                  <hr key={i} />
                ) : (
                  <button
                    key={i}
                    role="menuitem"
                    disabled={!entry.enabled}
                    className={entry.warn ? 'warn' : ''}
                    data-shortcut={entry.shortcut}
                    aria-keyshortcuts={entry.shortcut?.replace('⌘', 'Meta+')}
                    onClick={() => {
                      setOpen(undefined);
                      entry.run();
                    }}
                  >
                    <span className="check">{entry.checked ? '✓' : ''}</span>
                    {entry.label}
                  </button>
                ),
              )}
            </div>
          )}
        </div>
      ))}
    </nav>
  );
}
