import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LeaseHolder } from '@agent-stream/shared';

export type { LeaseHolder } from '@agent-stream/shared';
/** `lockFile` is set when the lock file can't be read, so the message can name it (ruling R6). */
export type LeaseResult = { ok: true } | { ok: false; holder: LeaseHolder; otherWindow: boolean; lockFile?: string };

/** The checkout's write lease (spec §4.2): one instance per extension host, shared by every folder's engine. */
export interface WriteLeases {
  acquire(checkoutRoot: string, holder: Omit<LeaseHolder, 'pid'>): LeaseResult;
  release(checkoutRoot: string, runId: string): void;
  holder(checkoutRoot: string): LeaseHolder | undefined;
  onRelease(listener: (checkoutRoot: string) => void): () => void;
}

/** Who holds a lock file that can't be read. */
export const UNKNOWN_HOLDER: LeaseHolder = { runId: 'unknown', graphId: 'unknown', folder: '', pid: 0, startedAt: '' };

export function leaseKey(checkoutRoot: string): string {
  return createHash('sha256').update(checkoutRoot).digest('hex').slice(0, 16);
}

export function leaseFile(locksDir: string, checkoutRoot: string): string {
  return join(locksDir, `${leaseKey(checkoutRoot)}.json`);
}

/** Alive means `process.kill(pid, 0)` didn't throw ESRCH (EPERM: alive, owned by someone else). */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

type LockRead = { kind: 'none' } | { kind: 'unreadable' } | { kind: 'held'; holder: LeaseHolder };

function readLock(file: string): LockRead {
  let content: string;
  try {
    content = readFileSync(file, 'utf8');
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? { kind: 'none' } : { kind: 'unreadable' };
  }
  try {
    const j = JSON.parse(content) as Record<string, unknown>;
    if (j.version !== 1 || typeof j.runId !== 'string' || typeof j.graphId !== 'string' || typeof j.folder !== 'string' || typeof j.pid !== 'number') return { kind: 'unreadable' };
    return { kind: 'held', holder: { runId: j.runId, graphId: j.graphId, folder: j.folder, pid: j.pid, startedAt: typeof j.startedAt === 'string' ? j.startedAt : '' } };
  } catch {
    return { kind: 'unreadable' };
  }
}

export function createWriteLeases(o: { locksDir: string; pid?: number; isAlive?: (pid: number) => boolean; clock?: () => string }): WriteLeases {
  const pid = o.pid ?? process.pid;
  const isAlive = o.isAlive ?? processAlive;
  /** The leases this process holds, by checkout root. */
  const held = new Map<string, LeaseHolder>();
  /** A Set keeps subscription order: waiting runs acquire in the order they started (ruling R5). */
  const listeners = new Set<(checkoutRoot: string) => void>();
  /** Stale: its process is gone, or it is this process's pid but no active run of this process holds it. */
  const stale = (h: LeaseHolder, root: string) => !isAlive(h.pid) || (h.pid === pid && held.get(root)?.runId !== h.runId);

  return {
    acquire(root, h) {
      const mine = held.get(root);
      if (mine) return mine.runId === h.runId ? { ok: true } : { ok: false, holder: mine, otherWindow: false };
      const file = leaseFile(o.locksDir, root);
      const holder: LeaseHolder = { ...h, pid };
      // Two attempts: a stale lock is removed once, then the exclusive create is tried again.
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          mkdirSync(o.locksDir, { recursive: true });
          writeFileSync(file, `${JSON.stringify({ version: 1, ...holder, checkout: root }, null, 2)}\n`, { flag: 'wx' });
          held.set(root, holder);
          return { ok: true };
        } catch (e) {
          // Fail closed: a lock we can neither create nor read blocks like an unreadable one.
          if ((e as NodeJS.ErrnoException).code !== 'EEXIST') return { ok: false, holder: UNKNOWN_HOLDER, otherWindow: true, lockFile: file };
        }
        const lock = readLock(file);
        if (lock.kind === 'none') continue;
        if (lock.kind === 'unreadable') return { ok: false, holder: UNKNOWN_HOLDER, otherWindow: true, lockFile: file };
        if (!stale(lock.holder, root)) return { ok: false, holder: lock.holder, otherWindow: lock.holder.pid !== pid };
        rmSync(file, { force: true });
      }
      return { ok: false, holder: UNKNOWN_HOLDER, otherWindow: true, lockFile: file };
    },

    release(root, runId) {
      const mine = held.get(root);
      if (!mine || mine.runId !== runId) return;
      held.delete(root);
      const file = leaseFile(o.locksDir, root);
      const lock = readLock(file);
      if (lock.kind === 'held' && lock.holder.runId === runId && lock.holder.pid === pid) rmSync(file, { force: true });
      for (const listener of [...listeners]) {
        try {
          listener(root);
        } catch (e) {
          console.error('[agent-stream] a lease listener failed', e);
        }
      }
    },

    holder(root) {
      const mine = held.get(root);
      if (mine) return mine;
      const lock = readLock(leaseFile(o.locksDir, root));
      if (lock.kind === 'unreadable') return UNKNOWN_HOLDER;
      return lock.kind === 'held' && !stale(lock.holder, root) ? lock.holder : undefined;
    },

    onRelease(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}
