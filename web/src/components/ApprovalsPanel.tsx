import { useState, type ReactNode } from 'react';
import type { ApprovalRequest } from '@claude-stream/shared';
import { send } from '../socket';
import { dispatch, useStore } from '../store';

function ApprovalCard({ request: a }: { request: ApprovalRequest }) {
  const [note, setNote] = useState('');
  const input = (a.input ?? {}) as Record<string, unknown>;
  const str = (key: string) => (typeof input[key] === 'string' ? (input[key] as string) : undefined);
  let body: ReactNode;
  if (a.toolName === 'Bash') {
    body = (
      <>
        {str('description') && <p>{str('description')}</p>}
        <pre className="mono">{str('command')}</pre>
      </>
    );
  } else if (a.toolName === 'Edit') {
    body = (
      <>
        <p>
          <code>{str('file_path')}</code>
        </p>
        <pre className="diff del">{str('old_string')}</pre>
        <pre className="diff add">{str('new_string')}</pre>
      </>
    );
  } else if (a.toolName === 'Write') {
    body = (
      <>
        <p>
          <code>{str('file_path')}</code>
        </p>
        <pre className="diff add">{str('content')}</pre>
      </>
    );
  } else {
    body = <pre>{JSON.stringify(a.input, null, 2)}</pre>;
  }
  return (
    <div className="approval-card">
      <div>
        <button className="link" onClick={() => dispatch({ kind: 'selectNode', id: a.nodeId })}>
          {a.nodeId} · {a.nodeTitle}
        </button>{' '}
        wants to use <b>{a.toolName}</b>
      </div>
      {body}
      <input placeholder="Note for the agent (optional, sent when you deny)" value={note} onChange={(e) => setNote(e.target.value)} />
      <div className="approval-actions">
        <button className="danger" onClick={() => send({ type: 'decide', approvalId: a.id, decision: 'deny', note: note.trim() || undefined })}>
          Deny
        </button>
        <button className="primary" onClick={() => send({ type: 'decide', approvalId: a.id, decision: 'approve' })}>
          Approve
        </button>
      </div>
    </div>
  );
}

export function ApprovalsPanel() {
  const approvals = useStore((s) => s.approvals);
  if (approvals.length === 0) return <p className="muted pad">Nothing is waiting for approval.</p>;
  return (
    <div className="approvals">
      {approvals.map((a) => (
        <ApprovalCard key={a.id} request={a} />
      ))}
    </div>
  );
}
