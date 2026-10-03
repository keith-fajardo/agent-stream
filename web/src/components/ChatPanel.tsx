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
  const sendButton = useRef<HTMLButtonElement>(null);
  const prev = useRef({ busy, key: `${target?.graphId}/${target?.sessionId}` });
  // True while Stop holds focus. A blur with no relatedTarget (e.g. Stop unmounting) leaves it set on purpose.
  const stopFocused = useRef(false);
  // Only on a busy transition (never on mount or a session switch) and only if focus is already in the chat:
  // just sent (box/Send focused) -> Stop, so Esc/Enter work after a mouse-clicked Send; Stop focused -> back to the box.
  useEffect(() => {
    const key = `${target?.graphId}/${target?.sessionId}`;
    const was = prev.current;
    prev.current = { busy, key };
    if (was.key !== key || was.busy === busy) return;
    const active = document.activeElement;
    if (busy) {
      stopFocused.current = false;
      if (active && (active === box.current || active === sendButton.current || active === stopButton.current)) {
        // React may reuse the focused Send node as Stop, in which case focus() fires no event.
        stopButton.current?.focus();
        stopFocused.current = document.activeElement === stopButton.current;
      }
    } else if (stopFocused.current) {
      stopFocused.current = false;
      // React may reuse the same <button> node for Send, so focus can still sit on it rather than fall to body.
      if (!active || active === document.body || active === sendButton.current) box.current?.focus();
    }
  }, [busy, target?.graphId, target?.sessionId]);
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
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) {
              e.preventDefault();
              submit();
            }
          }}
        />
        {busy ? (
          <button
            ref={stopButton}
            onFocus={() => (stopFocused.current = true)}
            onBlur={(e) => {
              if (e.relatedTarget) stopFocused.current = false;
            }}
            aria-label="Stop the planner" title="Stop the planner (Esc)" disabled={!target} onClick={stop}>
            ■ Stop
          </button>
        ) : (
          <button ref={sendButton} className="primary" disabled={!canType || !text.trim()} onClick={submit}>
            Send
          </button>
        )}
      </div>
    </div>
  );
}
