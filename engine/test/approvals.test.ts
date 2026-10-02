import { describe, expect, it } from 'vitest';
import { ApprovalBroker } from '../src/approvals';
import { fixedClock } from './helpers';

const req = (runId = 'r1', nodeId = 'n1') => ({ runId, nodeId, nodeTitle: 'Step', toolName: 'Bash', input: { command: 'ls' } });

describe('ApprovalBroker', () => {
  it('holds a request until it is decided', async () => {
    const broker = new ApprovalBroker(fixedClock());
    const sizes: number[] = [];
    broker.on('changed', (list: unknown[]) => sizes.push(list.length));
    const { id, decision } = broker.request(req());
    expect(broker.pending()).toMatchObject([{ id, runId: 'r1', toolName: 'Bash', createdAt: '2026-10-02T00:00:01.000Z' }]);
    expect(broker.decide(id, { decision: 'approve' })).toBe(true);
    await expect(decision).resolves.toEqual({ decision: 'approve' });
    expect(broker.pending()).toEqual([]);
    expect(sizes).toEqual([1, 0]);
    expect(broker.decide(id, { decision: 'approve' })).toBe(false);
  });

  it('resolves concurrent requests independently, in any order', async () => {
    const broker = new ApprovalBroker();
    const a = broker.request(req('r1', 'n1'));
    const b = broker.request(req('r1', 'n2'));
    broker.decide(b.id, { decision: 'deny', note: 'no' });
    broker.decide(a.id, { decision: 'approve' });
    await expect(a.decision).resolves.toEqual({ decision: 'approve' });
    await expect(b.decision).resolves.toEqual({ decision: 'deny', note: 'no' });
  });

  it('cancels on abort and per run', async () => {
    const broker = new ApprovalBroker();
    const ac = new AbortController();
    const a = broker.request(req('r1'), ac.signal);
    const b = broker.request(req('r2'));
    broker.request(req('r3'));
    ac.abort();
    broker.cancelRun('r2');
    await expect(a.decision).resolves.toEqual({ decision: 'cancelled' });
    await expect(b.decision).resolves.toEqual({ decision: 'cancelled' });
    expect(broker.pending().map((p) => p.runId)).toEqual(['r3']);
  });

  it('cancels at once when the signal is already aborted', async () => {
    const broker = new ApprovalBroker();
    const ac = new AbortController();
    ac.abort();
    const r = broker.request(req(), ac.signal);
    await expect(r.decision).resolves.toEqual({ decision: 'cancelled' });
    expect(broker.pending()).toEqual([]);
  });
});
