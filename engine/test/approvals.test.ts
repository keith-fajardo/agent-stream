import { describe, expect, it } from 'vitest';
import { emptyGraph, type GraphNode, type NodeEventBody } from '@agent-stream/shared';
import { ApprovalBroker, requestApproval } from '../src/approvals';
import { fixedClock } from './helpers';

const req = (runId = 'r1', nodeId = 'n1') => ({ runId, graphId: 'g', nodeId, nodeTitle: 'Step', toolName: 'Bash', input: { command: 'ls' } });

describe('ApprovalBroker', () => {
  it('holds a request until it is decided', async () => {
    const broker = new ApprovalBroker(fixedClock());
    const sizes: number[] = [];
    broker.on('changed', (list: unknown[]) => sizes.push(list.length));
    const { id, decision } = broker.request(req());
    expect(broker.pending()).toMatchObject([{ id, runId: 'r1', graphId: 'g', toolName: 'Bash', createdAt: '2026-10-02T00:00:01.000Z' }]);
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

describe('requestApproval', () => {
  const node: GraphNode = { id: 'n3', title: 'Research', kind: 'agent', prompt: 'p', createdBy: 'user', updatedBy: 'user', updatedAt: 't' };
  const setup = () => {
    const broker = new ApprovalBroker();
    const events: NodeEventBody[] = [];
    const stop = new AbortController();
    const ctx = { runId: 'r1', graph: emptyGraph('g', 'G', 't'), node, emit: (e: NodeEventBody) => void events.push(e) };
    const ask = (card = { graphChange: { summary: 's', detail: 'd' } }) => requestApproval({ broker, ctx, toolName: 'T', input: { a: 1 }, card, signal: stop.signal });
    return { broker, events, stop, ask };
  };

  it('puts the request on the broker with its card, logs it on the step, and logs and returns the decision', async () => {
    const { broker, events, ask } = setup();
    const asked = ask();
    expect(broker.pending()).toMatchObject([{ runId: 'r1', graphId: 'g', nodeId: 'n3', nodeTitle: 'Research', toolName: 'T', input: { a: 1 }, graphChange: { summary: 's', detail: 'd' } }]);
    const id = broker.pending()[0].id;
    expect(events).toEqual([{ type: 'approval_requested', approvalId: id, toolName: 'T', input: { a: 1 } }]);
    broker.decide(id, { decision: 'deny', note: 'no' });
    expect(await asked).toEqual({ decision: 'deny', note: 'no' });
    expect(events[1]).toEqual({ type: 'approval_decided', approvalId: id, decision: 'deny', note: 'no' });
  });

  it('logs the scope of an approval', async () => {
    const { broker, events, ask } = setup();
    const asked = ask();
    broker.decide(broker.pending()[0].id, { decision: 'approve', scope: 'site' });
    expect(await asked).toEqual({ decision: 'approve', scope: 'site' });
    expect(events[1]).toMatchObject({ decision: 'approve', scope: 'site' });
  });

  it('cancels the request when it can not be logged, and throws', async () => {
    const { broker } = setup();
    const ctx = { runId: 'r1', graph: emptyGraph('g', 'G', 't'), node, emit: () => { throw new Error('log failed'); } };
    await expect(requestApproval({ broker, ctx, toolName: 'T', input: {}, card: {}, signal: new AbortController().signal })).rejects.toThrow('log failed');
    expect(broker.pending()).toEqual([]);
  });

  it('is cancelled by the signal', async () => {
    const { broker, stop, ask } = setup();
    const asked = ask();
    stop.abort();
    expect(await asked).toEqual({ decision: 'cancelled' });
    expect(broker.pending()).toEqual([]);
  });
});
