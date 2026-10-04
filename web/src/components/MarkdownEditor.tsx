import { useEffect, useMemo, useRef, type KeyboardEvent } from 'react';
import { actions } from '../actions';
import { send } from '../bridge';
import { dispatch, useStore } from '../store';
import { CanvasModeToggle } from './CanvasModeToggle';

/** Where line `line` (1-based) starts in `text`. */
function lineStart(text: string, line: number): number {
  let at = 0;
  for (let i = 1; i < line; i++) {
    const next = text.indexOf('\n', at);
    if (next < 0) return text.length;
    at = next + 1;
  }
  return at;
}

/**
 * The canvas area in Markdown mode: the graph's Markdown file in a plain editor with line numbers. Save writes it through
 * the engine, which reads it like any outside edit; with no unsaved edits the text follows the file.
 */
export function MarkdownEditor() {
  const graphId = useStore((s) => s.graph?.id);
  const m = useStore((s) => s.markdown);
  const errors = useStore((s) => s.fileErrors);
  const editor = useRef<HTMLTextAreaElement>(null);
  const gutter = useRef<HTMLPreElement>(null);
  const loaded = m.disk !== undefined;
  useEffect(() => {
    if (graphId && !loaded) send({ type: 'getGraphMarkdown', graphId });
  }, [graphId, loaded]);
  const text = m.draft ?? m.disk ?? '';
  const lineCount = text.split('\n').length;
  const numbers = useMemo(() => Array.from({ length: lineCount }, (_, i) => i + 1).join('\n'), [lineCount]);

  if (!graphId) return <div className="empty">Loading the graph…</div>;
  const dirty = m.draft !== undefined;

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 's') {
      e.preventDefault();
      actions.saveMarkdown();
    }
  };
  const goToLine = (line: number) => {
    const el = editor.current;
    if (!el) return;
    const at = lineStart(el.value, line);
    el.focus();
    el.setSelectionRange(at, at);
    const lineHeight = parseFloat(getComputedStyle(el).lineHeight);
    if (Number.isFinite(lineHeight)) el.scrollTop = Math.max(0, (line - 3) * lineHeight);
  };

  return (
    <div className="canvas markdown-editor">
      <div className="markdown-toolbar">
        <CanvasModeToggle />
        <button className="primary" disabled={!dirty || !!m.saving} onClick={() => actions.saveMarkdown()} title="Save (Ctrl+S or ⌘S)">
          Save
        </button>
      </div>
      {m.conflict && (
        <div className="markdown-conflict">
          The file changed since you started editing.
          <button onClick={actions.reloadMarkdown}>Reload</button>
          <button onClick={() => actions.saveMarkdown({ force: true })} disabled={!!m.saving}>
            Save anyway
          </button>
        </div>
      )}
      <div className="markdown-body">
        <pre className="markdown-gutter" ref={gutter} aria-hidden="true">
          {numbers}
        </pre>
        <textarea
          ref={editor}
          aria-label="Markdown"
          spellCheck={false}
          wrap="off"
          value={text}
          readOnly={(!loaded && !dirty) || !!m.saving}
          onChange={(e) => dispatch({ kind: 'markdownEdited', text: e.target.value, from: text })}
          onKeyDown={onKeyDown}
          onScroll={(e) => {
            if (gutter.current) gutter.current.scrollTop = e.currentTarget.scrollTop;
          }}
        />
      </div>
      {errors.length > 0 && (
        <ul className="markdown-errors">
          {errors.map((e, i) => (
            <li key={i}>
              <button className="link" onClick={() => goToLine(e.line)}>{`line ${e.line}: ${e.message}`}</button>
            </li>
          ))}
        </ul>
      )}
      {m.confirmLeave && <LeaveMarkdownDialog />}
    </div>
  );
}

/** Switching to Graph with unsaved edits: an in-page dialog, since a webview can't show the browser's confirm box. */
function LeaveMarkdownDialog() {
  const keepEditing = () => dispatch({ kind: 'confirmLeaveMarkdown', open: false });
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') keepEditing();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  return (
    <div className="modal-backdrop" onClick={keepEditing}>
      <div className="modal" role="dialog" aria-label="Unsaved Markdown" onClick={(e) => e.stopPropagation()}>
        <h2>Save your Markdown changes before showing the graph?</h2>
        <div className="modal-actions">
          <button onClick={keepEditing}>Keep editing</button>
          <button onClick={actions.discardMarkdownAndShowGraph}>Discard</button>
          <button className="primary" onClick={() => actions.saveMarkdown({ thenGraph: true })}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
