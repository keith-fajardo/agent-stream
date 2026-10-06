import { MAX_ATTACHMENTS, type AttachTarget } from '@agent-stream/shared';
import { useState } from 'react';
import { post, send } from '../bridge';
import { dispatch } from '../store';
import { filesOf, readUploads, unreadable } from '../uploads';

/**
 * A step's or the graph's attachments (step model spec §6b.4): each name with Open and Remove, Add… (VS Code's file
 * picker), and files dropped or pasted onto the list. Every change is a graph edit, saved at once.
 */
export function AttachmentList({ graphId, target, names, hint }: { graphId: string; target: AttachTarget; names: string[]; hint: string }) {
  const [over, setOver] = useState(false);
  const attach = async (files: File[]) => {
    if (!files.length) return;
    try {
      const r = await readUploads(files, MAX_ATTACHMENTS - names.length);
      if (!r.ok) return dispatch({ kind: 'showToast', message: r.error });
      send({ type: 'attach', graphId, target, files: r.uploads });
    } catch {
      // A dropped folder, or a file that went away before it was read.
      dispatch({ kind: 'showToast', message: unreadable(files) });
    }
  };
  return (
    <div
      className={`field attachments${over ? ' drop-over' : ''}`}
      onDragOver={(e) => {
        if (![...e.dataTransfer.types].includes('Files')) return;
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        void attach(filesOf(e.dataTransfer));
      }}
      onPaste={(e) => {
        const files = filesOf(e.clipboardData);
        if (!files.length) return;
        e.preventDefault();
        void attach(files);
      }}
      tabIndex={-1}
    >
      <label>Attachments</label>
      {names.length > 0 && (
        <ul className="attachment-list">
          {names.map((name) => (
            <li key={name}>
              <span className="attachment-name" title={name}>
                📎 {name}
              </span>
              <button className="link" onClick={() => post({ type: 'openAttachment', name })}>
                Open
              </button>
              <button className="link" aria-label={`Remove ${name}`} onClick={() => send({ type: 'detach', graphId, target, name })}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="field-row">
        <button disabled={names.length >= MAX_ATTACHMENTS} onClick={() => post({ type: 'pickAttachments', target })}>
          Add…
        </button>
        <span className="muted">{hint}</span>
      </div>
    </div>
  );
}
