import { useState } from 'react';
import type { ApprovalRequest } from '@agent-stream/shared';
import { describeApprovalInput } from '../approvalView';
import { send } from '../bridge';
import { dispatch } from '../store';

export function ApprovalCard({ request: a }: { request: ApprovalRequest }) {
  const [note, setNote] = useState('');
  const view = describeApprovalInput(a.toolName, a.input);
  return (
    <div className="approval-card">
      {a.graphChange ? (
        <div className="approval-title">{a.graphChange.summary}</div>
      ) : (
        <div>
          <button className="link" onClick={() => dispatch({ kind: 'selectNode', id: a.nodeId })}>
            {a.nodeId} · {a.nodeTitle}
          </button>{' '}
          wants to use <b>{a.toolName}</b>
        </div>
      )}
      <input placeholder="Note for the agent (optional, sent when you deny)" value={note} onChange={(e) => setNote(e.target.value)} />
      <div className="approval-actions">
        <button className="danger" onClick={() => send({ type: 'decide', approvalId: a.id, decision: 'deny', note: note.trim() || undefined })}>
          Deny
        </button>
        <button className="primary" onClick={() => send({ type: 'decide', approvalId: a.id, decision: 'approve' })}>
          Approve
        </button>
      </div>
      {a.graphChange && (
        <details open>
          <summary>Exactly what would change</summary>
          <pre className="mono">{a.graphChange.detail}</pre>
        </details>
      )}
      {!a.graphChange && view.primary.map((b) => (
        <div key={b.label}>
          <div className="approval-label">{b.label}</div>
          <pre className={b.tone ? `diff ${b.tone}` : 'mono'}>{b.text}</pre>
        </div>
      ))}
      {!a.graphChange && view.warnings.map((w) => (
        <p key={w} className="approval-warning">
          ⚠ {w}
        </p>
      ))}
      {!a.graphChange && view.rest !== undefined && (
        <div>
          <div className="approval-label">Other input</div>
          <pre>{view.rest}</pre>
        </div>
      )}
    </div>
  );
}
