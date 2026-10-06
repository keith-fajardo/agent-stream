import { useEffect, useRef, useState } from 'react';
import { attachmentFileProblem, MAX_ATTACH_PAYLOAD_CHARS, MAX_ATTACHMENTS, safeAttachmentName, type AttachmentUpload } from '@agent-stream/shared';
import { send } from '../bridge';
import { Markdown } from '../markdown';
import { useStore } from '../store';
import { base64Chars, filesOf, readUploads, unreadable } from '../uploads';

export function ChatPanel() {
  const chat = useStore((s) => s.chat);
  const busy = useStore((s) => s.chatBusy);
  const target = useStore((s) => s.chatTarget);
  const status = useStore((s) => s.status);
  const [text, setText] = useState('');
  /** Files for the next message only (step model spec §6b.1), checked when added; `problem`: why some couldn't be. */
  const [pending, setPending] = useState<AttachmentUpload[]>([]);
  const [problem, setProblem] = useState<string | undefined>();
  const picker = useRef<HTMLInputElement>(null);
  const addFiles = async (files: File[]) => {
    if (!files.length) return;
    // Files go in order until one would take the message past what the engine accepts; that one and any after are refused.
    let chars = pending.reduce((n, f) => n + f.data.length, 0);
    const fits: File[] = [];
    let tooLarge: File | undefined;
    for (const f of files) {
      // A file of a type or size that can't be attached is readUploads's to refuse, with its own words.
      if (attachmentFileProblem(safeAttachmentName(f.name), f.size)) {
        fits.push(f);
        continue;
      }
      chars += base64Chars(f.size);
      if (chars > MAX_ATTACH_PAYLOAD_CHARS) {
        tooLarge = f;
        break;
      }
      fits.push(f);
    }
    try {
      const r = await readUploads(fits, MAX_ATTACHMENTS - pending.length);
      if (r.ok) setPending((p) => [...p, ...r.uploads]);
      setProblem(!r.ok ? r.error : tooLarge ? `${tooLarge.name} would make this message's files too large to send. Send these first, or attach fewer or smaller files.` : undefined);
    } catch {
      setProblem(unreadable(fits));
    }
  };
  const end = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const stopButton = useRef<HTMLButtonElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const prev = useRef({ busy, key: `${target?.graphId}/${target?.sessionId}` });
  // True from the moment this user sends until focus leaves the chat (or the target changes). It is the only
  // thing that ever lets us move focus, so mount, chatOpened for a busy session and session switches never do.
  const sentHere = useRef(false);
  useEffect(() => {
    const leave = (e: FocusEvent) => {
      if (!(e.target instanceof Node) || !root.current?.contains(e.target)) sentHere.current = false;
    };
    const blur = () => (sentHere.current = false);
    document.addEventListener('focusin', leave);
    window.addEventListener('blur', blur);
    return () => {
      document.removeEventListener('focusin', leave);
      window.removeEventListener('blur', blur);
    };
  }, []);
  // Sent -> Stop takes focus (Esc/Enter work after a mouse-clicked Send); turn over -> back to the message box.
  useEffect(() => {
    const key = `${target?.graphId}/${target?.sessionId}`;
    const was = prev.current;
    prev.current = { busy, key };
    if (was.key !== key) {
      sentHere.current = false;
      return;
    }
    if (was.busy === busy || !sentHere.current) return;
    if (busy) {
      stopButton.current?.focus();
    } else {
      sentHere.current = false;
      const active = document.activeElement;
      if (!active || active === document.body || root.current?.contains(active)) box.current?.focus();
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
    sentHere.current = true;
    send({ type: 'chat', graphId: target.graphId, sessionId: target.sessionId, text: t, ...(pending.length > 0 && { attachments: pending }) });
    setText('');
    setPending([]);
    setProblem(undefined);
  };
  const stop = () => {
    if (target && busy) send({ type: 'stopPlanner', graphId: target.graphId, sessionId: target.sessionId });
  };
  return (
    // Esc anywhere in the chat stops a running turn; while idle it does nothing (the typed text stays).
    <div
      ref={root}
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
            {e.attachments?.length ? (
              <div className="attachment-chips">
                {e.attachments.map((name) => (
                  <span key={name} className="attachment-chip">
                    📎 {name}
                  </span>
                ))}
              </div>
            ) : null}
          </div>
        ))}
        {busy && <div className="msg busy">Planner is working…</div>}
        <div ref={end} />
      </div>
      {(pending.length > 0 || problem) && (
        <div className="attachment-chips chat-pending">
          {pending.map((f, i) => (
            <span key={`${f.name}-${i}`} className="attachment-chip">
              📎 {f.name}{' '}
              <button className="link" aria-label={`Remove ${f.name}`} onClick={() => setPending((p) => p.filter((_, j) => j !== i))}>
                ×
              </button>
            </span>
          ))}
          {problem && <span className="field-error">{problem}</span>}
        </div>
      )}
      <div
        className="chat-input"
        onDragOver={(e) => {
          if ([...e.dataTransfer.types].includes('Files')) e.preventDefault();
        }}
        onDrop={(e) => {
          e.preventDefault();
          if (canType) void addFiles(filesOf(e.dataTransfer));
        }}
        onPaste={(e) => {
          // Text on the clipboard pastes into the box as usual, even when a file came with it (cells copied from a sheet).
          const files = filesOf(e.clipboardData);
          if (!files.length || e.clipboardData.getData('text/plain')) return;
          e.preventDefault();
          if (canType) void addFiles(files);
        }}
      >
        <input
          ref={picker}
          type="file"
          multiple
          hidden
          aria-label="Attach files"
          onChange={(e) => {
            void addFiles([...(e.target.files ?? [])]);
            e.target.value = '';
          }}
        />
        <button aria-label="Attach files" title="Attach files to this message" disabled={!canType} onClick={() => picker.current?.click()}>
          📎
        </button>
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
            aria-label="Stop the planner" title="Stop the planner (Esc)" disabled={!target} onClick={stop}>
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
