import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWriteLeases, leaseFile, leaseKey, UNKNOWN_HOLDER } from '../src/writeLease';

const ROOT = join(tmpdir(), 'agent-stream-some-checkout');
const locks = () => mkdtempSync(join(tmpdir(), 'agent-stream-locks-'));
const holder = (runId: string) => ({ runId, graphId: 'g', folder: join(tmpdir(), 'proj'), startedAt: '2026-10-03T00:00:00.000Z' });

describe('write leases', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('acquires by writing the lock file, and releases by deleting it', () => {
    const dir = locks();
    const leases = createWriteLeases({ locksDir: dir, pid: 100, isAlive: () => true });
    expect(leases.acquire(ROOT, holder('r1'))).toEqual({ ok: true });
    expect(leaseKey(ROOT)).toMatch(/^[0-9a-f]{16}$/);
    const file = leaseFile(dir, ROOT);
    expect(file).toBe(join(dir, `${leaseKey(ROOT)}.json`));
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ version: 1, ...holder('r1'), pid: 100, checkout: ROOT });
    expect(leases.holder(ROOT)).toEqual({ ...holder('r1'), pid: 100 });
    leases.release(ROOT, 'r1');
    expect(existsSync(file)).toBe(false);
    expect(leases.holder(ROOT)).toBeUndefined();
  });

  it('refuses another run of this process, and lets the holder acquire again', () => {
    const leases = createWriteLeases({ locksDir: locks(), pid: 100, isAlive: () => true });
    leases.acquire(ROOT, holder('r1'));
    expect(leases.acquire(ROOT, holder('r2'))).toEqual({ ok: false, holder: { ...holder('r1'), pid: 100 }, otherWindow: false });
    expect(leases.acquire(ROOT, holder('r1'))).toEqual({ ok: true });
  });

  it('refuses while a live process in another window holds the lock', () => {
    const dir = locks();
    createWriteLeases({ locksDir: dir, pid: 100, isAlive: () => true }).acquire(ROOT, holder('r1'));
    const other = createWriteLeases({ locksDir: dir, pid: 200, isAlive: () => true });
    expect(other.acquire(ROOT, holder('r2'))).toEqual({ ok: false, holder: { ...holder('r1'), pid: 100 }, otherWindow: true });
    expect(other.holder(ROOT)).toEqual({ ...holder('r1'), pid: 100 });
  });

  it('reclaims a lock whose process is gone', () => {
    const dir = locks();
    createWriteLeases({ locksDir: dir, pid: 100, isAlive: () => true }).acquire(ROOT, holder('r1'));
    const next = createWriteLeases({ locksDir: dir, pid: 200, isAlive: (pid) => pid !== 100 });
    expect(next.holder(ROOT)).toBeUndefined();
    expect(next.acquire(ROOT, holder('r2'))).toEqual({ ok: true });
    expect(JSON.parse(readFileSync(leaseFile(dir, ROOT), 'utf8'))).toMatchObject({ runId: 'r2', pid: 200 });
  });

  it('reclaims a lock this process left behind without an active run', () => {
    const dir = locks();
    writeFileSync(leaseFile(dir, ROOT), JSON.stringify({ version: 1, ...holder('old'), pid: 100, checkout: ROOT }));
    const leases = createWriteLeases({ locksDir: dir, pid: 100, isAlive: () => true });
    expect(leases.holder(ROOT)).toBeUndefined();
    expect(leases.acquire(ROOT, holder('r1'))).toEqual({ ok: true });
  });

  it('treats an unreadable lock file as held by an unknown run, and names the file', () => {
    const dir = locks();
    writeFileSync(leaseFile(dir, ROOT), 'not json');
    const leases = createWriteLeases({ locksDir: dir, pid: 100, isAlive: () => true });
    expect(UNKNOWN_HOLDER).toEqual({ runId: 'unknown', graphId: 'unknown', folder: '', pid: 0, startedAt: '' });
    expect(leases.acquire(ROOT, holder('r1'))).toEqual({ ok: false, holder: UNKNOWN_HOLDER, otherWindow: true, lockFile: leaseFile(dir, ROOT) });
    expect(leases.holder(ROOT)).toEqual(UNKNOWN_HOLDER);
    expect(readFileSync(leaseFile(dir, ROOT), 'utf8')).toBe('not json');
  });

  it('releases only for the run that holds the lease', () => {
    const dir = locks();
    const leases = createWriteLeases({ locksDir: dir, pid: 100, isAlive: () => true });
    leases.acquire(ROOT, holder('r1'));
    leases.release(ROOT, 'r2');
    expect(existsSync(leaseFile(dir, ROOT))).toBe(true);
    expect(leases.holder(ROOT)?.runId).toBe('r1');
  });

  it('tells listeners when a lease is released, in the order they subscribed, until they unsubscribe', () => {
    const leases = createWriteLeases({ locksDir: locks(), pid: 100, isAlive: () => true });
    const seen: string[] = [];
    const offA = leases.onRelease((root) => seen.push(`a:${root}`));
    leases.onRelease((root) => seen.push(`b:${root}`));
    leases.acquire(ROOT, holder('r1'));
    leases.release(ROOT, 'r1');
    expect(seen).toEqual([`a:${ROOT}`, `b:${ROOT}`]);
    offA();
    leases.acquire(ROOT, holder('r2'));
    leases.release(ROOT, 'r2');
    expect(seen).toEqual([`a:${ROOT}`, `b:${ROOT}`, `b:${ROOT}`]);
  });

  it('fails closed, naming the file, when a stale lock file cannot be removed (a Windows file lock)', () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const dir = locks();
    createWriteLeases({ locksDir: dir, pid: 100, isAlive: () => true }).acquire(ROOT, holder('r1'));
    const busy = () => {
      throw Object.assign(new Error('EBUSY: resource busy or locked, unlink'), { code: 'EBUSY' });
    };
    const next = createWriteLeases({ locksDir: dir, pid: 200, isAlive: (pid) => pid !== 100, removeFile: busy });
    expect(next.acquire(ROOT, holder('r2'))).toEqual({ ok: false, holder: UNKNOWN_HOLDER, otherWindow: true, lockFile: leaseFile(dir, ROOT) });
    expect(JSON.parse(readFileSync(leaseFile(dir, ROOT), 'utf8'))).toMatchObject({ runId: 'r1', pid: 100 });
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('[agent-stream]'), leaseFile(dir, ROOT), expect.any(Error));
  });

  it('still forgets the lease and tells listeners when its lock file cannot be removed', () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const dir = locks();
    const denied = () => {
      throw Object.assign(new Error('EPERM: operation not permitted, unlink'), { code: 'EPERM' });
    };
    const leases = createWriteLeases({ locksDir: dir, pid: 100, isAlive: () => true, removeFile: denied });
    const seen: string[] = [];
    leases.onRelease((root) => seen.push(root));
    leases.acquire(ROOT, holder('r1'));
    expect(() => leases.release(ROOT, 'r1')).not.toThrow();
    expect(seen).toEqual([ROOT]);
    expect(leases.holder(ROOT)).toBeUndefined();
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('[agent-stream]'), leaseFile(dir, ROOT), expect.any(Error));
  });

  it('keeps separate checkouts apart', () => {
    const leases = createWriteLeases({ locksDir: locks(), pid: 100, isAlive: () => true });
    const other = join(tmpdir(), 'agent-stream-other-checkout');
    expect(leaseKey(other)).not.toBe(leaseKey(ROOT));
    expect(leases.acquire(ROOT, holder('r1'))).toEqual({ ok: true });
    expect(leases.acquire(other, holder('r2'))).toEqual({ ok: true });
  });
});
