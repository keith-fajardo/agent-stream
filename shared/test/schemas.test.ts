import { describe, expect, it } from 'vitest';
import { authLabel, fmtDuration } from '../src/format';
import { parseClientMessage, parseGraph } from '../src/schemas';

const node = (id: string) => ({ id, title: id, kind: 'agent' });
const edge = (from: string, to: string) => ({ id: `${from}->${to}`, from, to });

describe('parseGraph', () => {
  it('fills defaults for a minimal file', () => {
    expect(parseGraph({ id: 'g', name: 'G' })).toEqual({
      ok: true,
      graph: { id: 'g', name: 'G', goal: '', nodes: [], edges: [], nodeSeq: 0, updatedAt: '' },
    });
  });

  it('fills node defaults', () => {
    const r = parseGraph({ id: 'g', name: 'G', nodes: [node('n1')] });
    expect(r.ok && r.graph.nodes[0]).toEqual({ id: 'n1', title: 'n1', kind: 'agent', createdBy: 'user', updatedBy: 'user', updatedAt: '' });
  });

  it('rejects wrong shapes with a readable error', () => {
    const r = parseGraph({ id: 'g', name: 'G', nodes: [{ id: 'n1', title: 't', kind: 'robot' }] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('kind');
  });

  it.each([
    [{ nodes: [node('n1'), node('n1')] }, 'duplicate node id'],
    [{ nodes: [node('n1')], edges: [edge('n1', 'n2')] }, 'missing node'],
    [{ nodes: [node('n1'), node('n2')], edges: [edge('n1', 'n2'), edge('n1', 'n2')] }, 'duplicate edge'],
    [{ nodes: [node('n1'), node('n2')], edges: [edge('n1', 'n2'), edge('n2', 'n1')] }, 'cycle'],
  ])('rejects structurally broken graphs (%#)', (extra, message) => {
    const r = parseGraph({ id: 'g', name: 'G', ...extra });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(message);
  });
});

describe('parseClientMessage', () => {
  it('accepts a valid message', () => {
    const msg = { type: 'op', graphId: 'g', op: { type: 'connect', from: 'n1', to: 'n2' } };
    expect(parseClientMessage(JSON.stringify(msg))).toEqual({ ok: true, msg });
  });

  it('rejects invalid JSON, unknown types and bad fields', () => {
    expect(parseClientMessage('{nope').ok).toBe(false);
    expect(parseClientMessage(JSON.stringify({ type: 'format_disk' })).ok).toBe(false);
    expect(parseClientMessage(JSON.stringify({ type: 'decide', approvalId: 'a', decision: 'maybe' })).ok).toBe(false);
    expect(parseClientMessage(JSON.stringify({ type: 'op', graphId: 'g', op: { type: 'moveNode', id: 'n1' } })).ok).toBe(false);
  });
});

describe('format', () => {
  it('labels the signed-in account', () => {
    expect(authLabel({ ok: true, plan: 'max', email: 'me@example.com' })).toBe('Claude Max · me@example.com');
    expect(authLabel({ ok: false, error: 'Not signed in.' })).toBe('⚠ Not signed in.');
  });

  it('formats durations', () => {
    expect(fmtDuration(450)).toBe('450 ms');
    expect(fmtDuration(42_100)).toBe('42.1 s');
    expect(fmtDuration(125_000)).toBe('2m 5s');
  });
});
