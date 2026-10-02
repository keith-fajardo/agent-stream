import { useEffect, useRef, useState } from 'react';
import { send } from '../socket';
import { useStore } from '../store';

export function ChatPanel() {
  const chat = useStore((s) => s.chat);
  const busy = useStore((s) => s.chatBusy);
  const graph = useStore((s) => s.graph);
  const auth = useStore((s) => s.auth);
  const [text, setText] = useState('');
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => end.current?.scrollIntoView({ block: 'end' }), [chat.length, busy]);
  const canType = !!graph && !!auth?.ok;
  const submit = () => {
    const t = text.trim();
    if (!t || !graph || !canType || busy) return;
    send({ type: 'chat', graphId: graph.id, text: t });
    setText('');
  };
  return (
    <div className="chat">
      <div className="chat-log">
        {chat.length === 0 && (
          <p className="muted">Describe what you want done. The planner draws the plan on the canvas; edit it freely, then press Run.</p>
        )}
        {chat.map((e, i) => (
          <div key={i} className={`msg ${e.role}`}>
            {e.role === 'tool' ? <code>{e.text}</code> : e.text}
          </div>
        ))}
        {busy && <div className="msg busy">Planner is working…</div>}
        <div ref={end} />
      </div>
      <div className="chat-input">
        <textarea
          value={text}
          disabled={!canType}
          placeholder={canType ? 'Ask the planner… (Enter to send, Shift+Enter for a new line)' : 'Chat is unavailable until you sign in to Claude.'}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <button className="primary" disabled={!canType || busy || !text.trim()} onClick={submit}>
          Send
        </button>
      </div>
    </div>
  );
}
