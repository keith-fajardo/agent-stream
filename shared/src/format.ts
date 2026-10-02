import type { AuthInfo, NodeStatus, RunStatus } from './types';

export function authLabel(auth: AuthInfo): string {
  if (!auth.ok) return `⚠ ${auth.error ?? 'Not signed in.'}`;
  const plan = auth.plan ? auth.plan.charAt(0).toUpperCase() + auth.plan.slice(1) : 'subscription';
  return `Claude ${plan}${auth.email ? ` · ${auth.email}` : ''}`;
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
