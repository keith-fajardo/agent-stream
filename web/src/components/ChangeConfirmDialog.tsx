import { actions } from '../actions';
import { dispatch, useStore } from '../store';

/** Accept all / Revert all ask first, in the page itself: a webview can't show the browser's confirm box. */
export function ChangeConfirmDialog() {
  const mode = useStore((s) => s.changeConfirm);
  const count = useStore((s) => s.changes.length);
  if (!mode) return null;
  const close = () => dispatch({ kind: 'closeChangeConfirm' });
  const confirm = () => {
    if (mode === 'accept') actions.acceptChange({ kind: 'all' });
    else actions.revertChange({ kind: 'all' });
    close();
  };
  return (
    <div className="modal-backdrop" onClick={close}>
      <div className="modal" role="dialog" aria-label="Confirm" onClick={(e) => e.stopPropagation()}>
        <h2>{mode === 'accept' ? `Accept all ${count} agent changes into your graph?` : `Revert all ${count} agent changes?`}</h2>
        <div className="modal-actions">
          <button onClick={close}>Cancel</button>
          <button className="primary" onClick={confirm}>
            Confirm
          </button>
        </div>
      </div>
    </div>
  );
}
