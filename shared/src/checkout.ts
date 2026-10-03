import type { CheckoutInfo, RunCheckout, WaitingFor } from './types';

const sha7 = (sha?: string): string => (sha ? sha.slice(0, 7) : '');

/** The last folder of a path, whichever separator it uses. */
export function folderName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

export function toRunCheckout(info: CheckoutInfo): RunCheckout {
  if (!info.git) return { root: info.root, linkedWorktree: false };
  return { root: info.root, ...(info.branch && { branch: info.branch }), ...(info.head && { head: info.head }), linkedWorktree: info.linkedWorktree };
}

/** The graph tab's chip (spec §7): `⎇ main`, `⎇ detached abc1234`, `… · worktree <folder>`, or why there is no Git. */
export function checkoutChip(info: CheckoutInfo): string {
  if (!info.git) return info.reason;
  const where = info.branch ? `⎇ ${info.branch}` : `⎇ detached ${sha7(info.head)}`.trimEnd();
  return info.linkedWorktree ? `${where} · worktree ${folderName(info.root)}` : where;
}

/** The chip's tooltip: the root, the HEAD commit and the other worktrees. */
export function checkoutTooltip(info: CheckoutInfo): string {
  if (!info.git) return `${info.root}\n${info.reason}`;
  const others = info.worktrees.filter((w) => !w.current);
  return [
    `Root: ${info.root}`,
    `HEAD: ${info.head ?? 'no commits yet'}`,
    ...(others.length ? ['Other worktrees:', ...others.map((w) => `  ${w.path} · ${w.branch ?? `detached ${sha7(w.head)}`}`)] : []),
  ].join('\n');
}

/** A run's tooltip line (spec §7): `Ran in <root> on <branch> at <sha7>`. */
export function ranIn(c: RunCheckout): string {
  return `Ran in ${c.root}${c.branch ? ` on ${c.branch}` : ''}${c.head ? ` at ${sha7(c.head)}` : ''}`;
}

export function waitingText(w: WaitingFor, graphName: string): string {
  return `Waiting for run ${w.runId} ("${graphName}") to finish changing files`;
}
