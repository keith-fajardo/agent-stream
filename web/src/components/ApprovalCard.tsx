import { useState } from 'react';
import { ALLOW_ALL_FOR_STEP, ALLOW_ALL_HINT, ALLOW_ON_SITE, ALLOW_ONCE, approvalStepLabel, browserActionText, DENY, THEN_PRESSES_ENTER, type ApprovalRequest, type BrowserActionRequest } from '@agent-stream/shared';
import { describeApprovalInput, patchLineClass } from '../approvalView';
import { send } from '../bridge';
import { dispatch } from '../store';

/** The browser card's details (spec §4.2): only the rows the action has. */
function BrowserDetails({ action: b }: { action: BrowserActionRequest }) {
  const rows: [string, string | undefined][] = [
    ['Site', b.site || b.url],
    ['Page', b.title],
    ['Element', b.element],
    ['Text', b.text],
    ['Then', b.submit ? THEN_PRESSES_ENTER : undefined],
    ['Option', b.option],
    ['Key', b.key],
  ];
  return (
    <>
      <dl className="browser-action">
        {rows
          .filter(([, value]) => value !== undefined && value !== '')
          .map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{label === 'Text' ? <pre className="mono">{value}</pre> : value}</dd>
            </div>
          ))}
      </dl>
      {b.screenshot && <img className="browser-shot" alt={`The page: ${b.title}`} src={`data:image/jpeg;base64,${b.screenshot}`} />}
    </>
  );
}

export function ApprovalCard({ request: a }: { request: ApprovalRequest }) {
  const [note, setNote] = useState('');
  const view = describeApprovalInput(a.toolName, a.input);
  const allowAll = () => send({ type: 'decide', approvalId: a.id, decision: 'approve', scope: 'step' });
  const deny = () => send({ type: 'decide', approvalId: a.id, decision: 'deny', note: note.trim() || undefined });
  const who = (
    <button className="link" onClick={() => dispatch({ kind: 'selectNode', id: a.nodeId })}>
      {approvalStepLabel(a)}
    </button>
  );
  if (a.browserAction) {
    return (
      <div className="approval-card">
        <div>
          {who} wants to {browserActionText(a.toolName, a.browserAction)}
        </div>
        <input placeholder="Note for the agent (optional, sent when you deny)" value={note} onChange={(e) => setNote(e.target.value)} />
        <div className="approval-actions">
          <button className="danger" onClick={deny}>
            {DENY}
          </button>
          <button onClick={() => send({ type: 'decide', approvalId: a.id, decision: 'approve', scope: 'site' })}>{ALLOW_ON_SITE}</button>
          <button className="primary" onClick={() => send({ type: 'decide', approvalId: a.id, decision: 'approve' })}>
            {ALLOW_ONCE}
          </button>
          <button className="caution" title={ALLOW_ALL_HINT} onClick={allowAll}>
            {ALLOW_ALL_FOR_STEP}
          </button>
        </div>
        <BrowserDetails action={a.browserAction} />
      </div>
    );
  }
  return (
    <div className="approval-card">
      {a.graphChange ? (
        <div className="approval-title">{a.graphChange.summary}</div>
      ) : (
        <div>
          {who} wants to use <b>{a.toolName}</b>
        </div>
      )}
      <input placeholder="Note for the agent (optional, sent when you deny)" value={note} onChange={(e) => setNote(e.target.value)} />
      <div className="approval-actions">
        <button className="danger" onClick={deny}>
          Deny
        </button>
        <button className="primary" onClick={() => send({ type: 'decide', approvalId: a.id, decision: 'approve' })}>
          Approve
        </button>
        <button className="caution" title={ALLOW_ALL_HINT} onClick={allowAll}>
          {ALLOW_ALL_FOR_STEP}
        </button>
      </div>
      {a.graphChange && (
        <details open>
          <summary>Exactly what would change</summary>
          <pre className="mono">{a.graphChange.detail}</pre>
        </details>
      )}
      {!a.graphChange && view.primary.map((b, i) => (
        <div key={`${i}:${b.label}`}>
          <div className="approval-label">{b.label}</div>
          {b.diff ? (
            <pre className="diff-block">
              {b.text.split('\n').map((line, j) => (
                <div key={j} className={patchLineClass(line)}>
                  {line || ' '}
                </div>
              ))}
            </pre>
          ) : (
            <pre className={b.tone ? `diff ${b.tone}` : 'mono'}>{b.text}</pre>
          )}
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
