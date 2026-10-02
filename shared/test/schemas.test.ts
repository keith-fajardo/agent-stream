import { describe, expect, it } from 'vitest';
import { authLabel, fmtDuration, statusLabel } from '../src/format';
import { parseClientMessage, parseGraph } from '../src/schemas';

const node = (id: string) => ({ id, title: id, kind: 'agent' });
const edge = (from: string, to: string) => ({ id: `${from}->${to}`, from, to });

describe('parseGraph', () => {
  it('fills defaults for a minimal file', () => {
    expect(parseGraph({ id: 'g', name: 'G' })).toEqual({
      ok: true,
      graph: { id: 'g', name: 'G', goal: '', instructions: '', variables: [], nodes: [], edges: [], nodeSeq: 0, updatedAt: '' },
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

  it('requires startRun to say which graph content the user reviewed', () => {
    expect(parseClientMessage(JSON.stringify({ type: 'startRun', graphId: 'g' })).ok).toBe(false);
    const msg = { type: 'startRun', graphId: 'g', reviewed: 'sig' };
    expect(parseClientMessage(JSON.stringify(msg))).toEqual({ ok: true, msg });
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

  it('labels every step and run status for people', () => {
    expect(
      (['queued', 'running', 'waiting_approval', 'succeeded', 'failed', 'not_run', 'cancelled', 'reused', 'interrupted'] as const).map(statusLabel),
    ).toEqual(['Queued', 'Running', 'Waiting approval', 'Succeeded', 'Failed', 'Not run', 'Cancelled', 'Reused', 'Interrupted']);
  });

  it('loads graph files written before instructions existed', () => {
    const r = parseGraph({ id: 'g', name: 'G' });
    expect(r.ok && r.graph.instructions).toBe('');
  });

  it('defaults variables and rejects invalid variable names in graph files', () => {
    const ok = parseGraph({ id: 'g', name: 'G' });
    expect(ok.ok && ok.graph.variables).toEqual([]);
    const withDescriptionDefault = parseGraph({ id: 'g', name: 'G', variables: [{ name: 'schema' }] });
    expect(withDescriptionDefault.ok && withDescriptionDefault.graph.variables).toEqual([{ name: 'schema', description: '' }]);
    expect(parseGraph({ id: 'g', name: 'G', variables: [{ name: 'env_var' }] })).toEqual({ ok: false, error: 'invalid variable: "env_var" is a reserved word.' });
    expect(parseGraph({ id: 'g', name: 'G', variables: [{ name: 'a' }, { name: 'a' }] })).toEqual({ ok: false, error: 'invalid variable: A variable named "a" already exists.' });
  });

  it('accepts preview and variable value messages', () => {
    expect(parseClientMessage(JSON.stringify({ type: 'previewRun', graphId: 'g', fromNodeId: 'n2', sourceRunId: 'r' })).ok).toBe(true);
    expect(parseClientMessage(JSON.stringify({ type: 'setVariableValue', graphId: 'g', name: 'schema', value: 'dev' })).ok).toBe(true);
    expect(parseClientMessage(JSON.stringify({ type: 'setVariableValue', graphId: 'g', name: 'schema', value: 'x'.repeat(10_001) })).ok).toBe(false);
  });

describe('unsafe step ids', () => {
  it.each(['__proto__', 'constructor', 'toString', 'con', 'LPT1'])('parseGraph rejects %s', (id) => {
    const r = parseGraph({ id: 'g', name: 'G', nodes: [node(id)] });
    expect(r).toEqual({ ok: false, error: `"${id}" can't be used as a step id.` });
  });
  it('still accepts normal ids', () => {
    expect(parseGraph({ id: 'g', name: 'G', nodes: [node('n1'), node('build_old'), node('my-step')] }).ok).toBe(true);
  });
});
});
