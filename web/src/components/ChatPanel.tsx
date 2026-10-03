import { useEffect, useRef, useState } from 'react';
import { send } from '../bridge';
import { Markdown } from '../markdown';
import { useStore } from '../store';

export function ChatPanel() {
  const chat = useStore((s) => s.chat);
  const busy = useStore((s) => s.chatBusy);
  const target = useStore((s) => s.chatTarget);
  const status = useStore((s) => s.status);
  const [text, setText] = useState('');
  const end = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const stopButton = useRef<HTMLButtonElement>(null);
  const wasBusy = useRef(busy);
  // Busy: focus Stop so Esc and Enter work right after a mouse-clicked Send. Idle again: back to the message box.
  useEffect(() => {
    if (busy) stopButton.current?.focus();
    else if (wasBusy.current) box.current?.focus();
    wasBusy.current = busy;
  }, [busy]);
  // Block body on purpose: Chrome 154+ returns a Promise from scrollIntoView(), and an
  // effect must not return anything but a cleanup function.
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [chat.length, busy]);
  const canType = !!target && !!status?.ok;
  const submit = () => {
    const t = text.trim();
    if (!t || !target || !canType || busy) return;
    send({ type: 'chat', graphId: target.graphId, sessionId: target.sessionId, text: t });
    setText('');
  };
  const stop = () => {
    if (target && busy) send({ type: 'stopPlanner', graphId: target.graphId, sessionId: target.sessionId });
  };
  return (
    // Esc anywhere in the chat stops a running turn; while idle it does nothing (the typed text stays).
    <div
      className="chat"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && busy && !e.nativeEvent.isComposing && e.keyCode !== 229) {
          e.preventDefault();
          stop();
        }
      }}
    >
      <div className="chat-log">
        {chat.length === 0 && (
          <p className="muted">Describe what you want done. The planner draws the plan on the canvas; edit it freely, then press Run.</p>
        )}
        {chat.map((e, i) => (
          <div key={i} className={`msg ${e.role}`}>
            {e.role === 'tool' ? <code>{e.text}</code> : e.role === 'assistant' ? <Markdown text={e.text} /> : e.text}
          </div>
        ))}
        {busy && <div className="msg busy">Planner is working…</div>}
        <div ref={end} />
      </div>
      <div className="chat-input">
        <textarea
          ref={box}
          value={text}
          disabled={!canType}
          placeholder={canType ? 'Ask the planner… (Enter to send, Shift+Enter for a new line)' : status?.error ?? 'Chat is unavailable.'}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />
        {busy ? (
          <button ref={stopButton} aria-label="Stop the planner" title="Stop the planner (Esc)" disabled={!target} onClick={stop}>
            ■ Stop
          </button>
        ) : (
          <button className="primary" disabled={!canType || !text.trim()} onClick={submit}>
            Send
          </button>
        )}
      </div>
    </div>
  );
}
