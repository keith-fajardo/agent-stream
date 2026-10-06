import { useState, type ReactNode } from 'react';
import { Markdown } from '../markdown';
import { DONE, fmtDuration, type NodeEvent } from '@agent-stream/shared';
import { send } from '../bridge';

export const LOG_STREAM_CAP = 200_000;

const pretty = (value: unknown) => {
  try {
    return JSON.stringify(value, null, 2) ?? '';
  } catch {
    return String(value);
  }
};

function Collapsible({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > 600;
  return (
    <div className="collapsible">
      <pre>{open || !long ? text : `${text.slice(0, 600)}…`}</pre>
      {long && (
        <button className="link" onClick={() => setOpen(!open)}>
          {open ? 'Show less' : `Show all (${text.length} chars)`}
        </button>
      )}
    </div>
  );
}

function LogEvent({ event: e, ended, live }: { event: NodeEvent; ended: ReadonlySet<string>; live: boolean }) {
  const time = <span className="t">{new Date(e.at).toLocaleTimeString()}</span>;
  switch (e.type) {
    case 'start':
      return (
        <div className="ev start">
          {time}Started {e.kind} step in <code>{e.cwd}</code>
          {e.command && <pre>{e.command}</pre>}
          {e.prompt && (
            <details>
              <summary>Prompt sent to the agent</summary>
              <Markdown text={e.prompt} />
            </details>
          )}
        </div>
      );
    case 'text':
      return (
        <div className="ev text">
          {time}
          <div className="body">
            <Markdown text={e.text} />
          </div>
        </div>
      );
    case 'tool_call':
      return (
        <div className="ev tool">
          {time}→ <b>{e.name}</b>
          <Collapsible text={pretty(e.input)} />
        </div>
      );
    case 'tool_result':
      return (
        <div className={`ev result ${e.isError ? 'error' : ''}`}>
          {time}← result
          <Collapsible text={e.content} />
        </div>
      );
    case 'approval_requested':
      return (
        <div className="ev approval">
          {time}⏸ Waiting for your approval: <b>{e.toolName}</b>
        </div>
      );
    case 'approval_decided':
      return (
        <div className={`ev approval ${e.decision}`}>
          {time}
          {e.decision === 'approve' ? `✔ Approved${e.scope === 'site' ? ': on this site for this step' : ''}` : e.decision === 'deny' ? `✖ Denied${e.note ? `: ${e.note}` : ''}` : '■ Cancelled (run stopped)'}
        </div>
      );
    case 'browser':
      return (
        <div className="ev browser">
          {time}
          {e.text}
        </div>
      );
    case 'browser_wait':
      return (
        <div className="ev browser-wait">
          {time}⏸ {e.text}
          {live && !ended.has(e.waitId) && (
            <button className="primary" onClick={() => send({ type: 'browserDone', waitId: e.waitId })}>
              {DONE}
            </button>
          )}
        </div>
      );
    case 'browser_wait_done':
      return (
        <div className="ev browser-wait">
          {time}
          {e.by === 'user' ? '✔ Done' : '■ Stopped (run stopped)'}
        </div>
      );
    case 'retry':
      return (
        <div className="ev retry">
          {time}↻ API retry {e.attempt}/{e.maxRetries}: {e.error}
        </div>
      );
    case 'result': {
      const u = e.usage;
      // A provider that reports no tokens or cost (Copilot) shows only its request count; one that reports no cost (Codex), no cost.
      const counted = u ? u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens > 0 || u.costUsd > 0 : false;
      const usage = !u
        ? ''
        : counted
          ? ` · ${u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens} in / ${u.outputTokens} out tokens · ${u.turns} turns${u.costUsd > 0 ? ` · ~$${u.costUsd.toFixed(2)} API-equivalent` : ''}`
          : ` · ${u.turns} turns`;
      const exit = e.exitCode !== undefined && e.exitCode !== null ? ` · exit ${e.exitCode}` : '';
      return (
        <div className={`ev final ${e.ok ? 'ok' : 'error'}`}>
          {time}
          {e.ok ? '✔ Succeeded' : `✖ Failed${e.error ? `: ${e.error}` : ''}`} · {fmtDuration(e.durationMs)}
          {exit}
          {usage}
        </div>
      );
    }
    case 'error':
      return (
        <div className="ev error">
          {time}
          {e.message}
        </div>
      );
    default:
      return null;
  }
}

/** Renders a node's events; consecutive stdout/stderr chunks merge into one block. */
/** `live`: the step is still running, so a wait without its done event is still going on (default: yes). */
export function LogView({ events, live = true }: { events: NodeEvent[]; live?: boolean }) {
  const items: ReactNode[] = [];
  /** Waits that already ended: their line keeps no Done button. */
  const ended = new Set(events.flatMap((e) => (e.type === 'browser_wait_done' ? [e.waitId] : [])));
  let stream: { kind: 'stdout' | 'stderr'; text: string } | undefined;
  const flush = (key: number) => {
    if (!stream) return;
    const text =
      stream.text.length > LOG_STREAM_CAP
        ? `…[earlier output hidden; the full output is in output.md]\n${stream.text.slice(-LOG_STREAM_CAP)}`
        : stream.text;
    items.push(
      <pre key={`s${key}`} className={`stream ${stream.kind}`}>
        {text}
      </pre>,
    );
    stream = undefined;
  };
  events.forEach((e, i) => {
    if (e.type === 'stdout' || e.type === 'stderr') {
      if (stream && stream.kind === e.type) stream.text += e.chunk;
      else {
        flush(i);
        stream = { kind: e.type, text: e.chunk };
      }
      return;
    }
    flush(i);
    items.push(<LogEvent key={i} event={e} ended={ended} live={live} />);
  });
  flush(events.length);
  return <div className="logview">{items}</div>;
}
