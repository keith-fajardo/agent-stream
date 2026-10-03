import { EFFORT_LEVELS, type ApprovalRequest, type EffortLevel, type GraphChangeRequest, type ProviderStatus, type NodeStatus, type ProviderId, type RunStatus } from './types';

export const isEffortLevel = (value: unknown): value is EffortLevel => typeof value === 'string' && (EFFORT_LEVELS as readonly string[]).includes(value);

/** "Model: Opus · Effort: high": the run dialog's and run tooltip's line; a missing model or effort is Default. */
export function modelLine(o: { model?: string; label?: string; effort?: EffortLevel; provider?: ProviderId }): string {
  // Copilot ignores effort, so a configured level isn't shown as if it applied.
  return `Model: ${o.label ?? o.model ?? 'Default'} · Effort: ${o.provider === 'copilot' ? 'not supported' : (o.effort ?? 'Default')}`;
}

export function providerLabel(status: ProviderStatus): string {
  if (!status.ok) return `⚠ ${status.error ?? status.label}`;
  return status.detail ? `${status.label} · ${status.detail}` : status.label;
}

export function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s - m * 60)}s`;
}

const STATUS_LABELS: Record<NodeStatus | RunStatus, string> = {
  queued: 'Queued',
  running: 'Running',
  waiting_approval: 'Waiting approval',
  succeeded: 'Succeeded',
  failed: 'Failed',
  not_run: 'Not run',
  cancelled: 'Cancelled',
  reused: 'Reused',
  interrupted: 'Interrupted',
};

export function statusLabel(status: NodeStatus | RunStatus): string {
  return STATUS_LABELS[status] ?? status;
}

/** "just now", "45m ago", "2h ago", "yesterday", "4d ago", then the date. */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const minutes = Math.floor(Math.max(0, now - t) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days}d ago`;
  return new Date(t).toISOString().slice(0, 10);
}

/** The first non-empty line, capped, with a note when more lines follow, so nothing is hidden silently. */
const firstLine = (text: string, max = 80) => {
  const lines = text.split(/\r\n|\n|\r/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return '(empty command)';
  const shown = lines[0].length > max ? `${lines[0].slice(0, max - 1)}…` : lines[0];
  const more = lines.length - 1;
  return more ? `${shown} … (+${more} more line${more === 1 ? '' : 's'})` : shown;
};
const fieldsOf = (input: unknown) => (typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {});

/** One line for lists: "Bash: dbt build …", "Edit: models/x.sql", or a graph change's own summary. */
export function approvalSummary(toolName: string, input: unknown, graphChange?: GraphChangeRequest): string {
  if (graphChange) return graphChange.summary;
  const f = fieldsOf(input);
  if ((toolName === 'Bash' || toolName === 'PowerShell') && typeof f.command === 'string') return `${toolName}: ${firstLine(f.command)}`;
  if (typeof f.file_path === 'string') return `${toolName}: ${f.file_path}`;
  return toolName;
}

/** A sentence for notifications: "n2 Build new wants to run: dbt build". */
export function approvalSentence(a: ApprovalRequest): string {
  if (a.graphChange) return a.graphChange.summary;
  const f = fieldsOf(a.input);
  const who = `${a.nodeId} ${a.nodeTitle}`;
  if ((a.toolName === 'Bash' || a.toolName === 'PowerShell') && typeof f.command === 'string') return `${who} wants to run: ${firstLine(f.command)}`;
  if (a.toolName === 'Edit' && typeof f.file_path === 'string') return `${who} wants to edit ${f.file_path}`;
  if (a.toolName === 'Write' && typeof f.file_path === 'string') return `${who} wants to write ${f.file_path}`;
  return `${who} wants to use ${a.toolName}`;
}
