import { describe, expect, it } from 'vitest';
import { fmtDuration, providerLabel, statusLabel } from '../src/format';
import { parseGraph, parseWebviewMessage } from '../src/schemas';

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

describe('parseWebviewMessage', () => {
  it('accepts engine messages', () => {
    const msg = { type: 'op', graphId: 'g', op: { type: 'connect', from: 'n1', to: 'n2' } };
    expect(parseWebviewMessage(msg)).toEqual({ ok: true, kind: 'engine', msg });
    expect(parseWebviewMessage({ type: 'previewRun', graphId: 'g', fromNodeId: 'n2', sourceRunId: 'r' }).ok).toBe(true);
    expect(parseWebviewMessage({ type: 'previewRun', graphId: 'g', requestId: 'p1' }).ok).toBe(true);
    expect(parseWebviewMessage({ type: 'previewRun', graphId: 'g', requestId: 'x'.repeat(65) }).ok).toBe(false);
    expect(parseWebviewMessage({ type: 'setVariableValue', graphId: 'g', name: 'schema', value: 'dev' }).ok).toBe(true);
  });

  it('accepts the tab’s own messages for the extension', () => {
    expect(parseWebviewMessage({ type: 'ready' })).toEqual({ ok: true, kind: 'host', msg: { type: 'ready' } });
    expect(parseWebviewMessage({ type: 'opened', graphId: 'g' })).toEqual({ ok: true, kind: 'host', msg: { type: 'opened', graphId: 'g' } });
    expect(parseWebviewMessage({ type: 'host', command: 'exportGraph' })).toEqual({ ok: true, kind: 'host', msg: { type: 'host', command: 'exportGraph' } });
    expect(parseWebviewMessage({ type: 'setMinimap', value: false }).ok).toBe(true);
    expect(parseWebviewMessage({ type: 'chatCommand', command: 'switchSession' }).ok).toBe(true);
    expect(parseWebviewMessage({ type: 'chatCommand', command: 'newChat' }).ok).toBe(true);
    expect(parseWebviewMessage({ type: 'draftState', dirty: true })).toEqual({ ok: true, kind: 'host', msg: { type: 'draftState', dirty: true } });
    expect(parseWebviewMessage({ type: 'host', command: 'focusChat' }).ok).toBe(true);
  });

  it('parses refineSteps as a tab message and as an engine message, and bounds its steps', () => {
    expect(parseWebviewMessage({ type: 'refineSteps', nodeIds: ['n1'] })).toEqual({ ok: true, kind: 'host', msg: { type: 'refineSteps', nodeIds: ['n1'] } });
    const engine = { type: 'refineSteps', graphId: 'g', sessionId: 's', nodeIds: ['n1'] };
    expect(parseWebviewMessage(engine)).toEqual({ ok: true, kind: 'engine', msg: engine });
    expect(parseWebviewMessage({ type: 'refineSteps', nodeIds: [] }).ok).toBe(false);
    expect(parseWebviewMessage({ type: 'refineSteps', nodeIds: Array.from({ length: 51 }, (_, i) => `n${i}`) }).ok).toBe(false);
  });

  it('rejects unknown types, bad fields and oversized values', () => {
    expect(parseWebviewMessage('{nope').ok).toBe(false);
    expect(parseWebviewMessage({ type: 'format_disk' }).ok).toBe(false);
    expect(parseWebviewMessage({ type: 'host', command: 'rm' }).ok).toBe(false);
    expect(parseWebviewMessage({ type: 'chatCommand', command: 'other' }).ok).toBe(false);
    expect(parseWebviewMessage({ type: 'decide', approvalId: 'a', decision: 'maybe' }).ok).toBe(false);
    expect(parseWebviewMessage({ type: 'startRun', graphId: 'g' }).ok).toBe(false);
    expect(parseWebviewMessage({ type: 'setVariableValue', graphId: 'g', name: 'schema', value: 'x'.repeat(10_001) }).ok).toBe(false);
  });

  it('accepts chat messages for a work session, and refuses chat without one', () => {
    for (const msg of [
      { type: 'openChat', graphId: 'g', sessionId: 'default' },
      { type: 'chat', graphId: 'g', sessionId: 'default', text: 'hi' },
      { type: 'newChat', graphId: 'g', sessionId: 'default' },
    ]) {
      expect(parseWebviewMessage(msg)).toEqual({ ok: true, kind: 'engine', msg });
    }
    expect(parseWebviewMessage({ type: 'chat', graphId: 'g', text: 'hi' }).ok).toBe(false);
  });
});

describe('graph files from before work sessions', () => {
  it('parses an old graph file with planner fields and drops them', () => {
    const r = parseGraph({ id: 'g', name: 'G', plannerSessionId: 's', plannerOpCursor: 2 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.graph).not.toHaveProperty('plannerSessionId');
      expect(r.graph).not.toHaveProperty('plannerOpCursor');
    }
  });
});

describe('format', () => {
  it('labels a provider that can run', () => {
    expect(providerLabel({ provider: 'claude', ok: true, label: 'Claude Max', detail: 'me@example.com' })).toBe('Claude Max · me@example.com');
    expect(providerLabel({ provider: 'claude', ok: true, label: 'Claude Pro' })).toBe('Claude Pro');
  });

  it('gives the reason when a provider cannot run', () => {
    expect(providerLabel({ provider: 'claude', ok: false, label: 'not signed in', error: 'Not signed in to Claude Code.' })).toBe('⚠ Not signed in to Claude Code.');
    expect(providerLabel({ provider: 'copilot', ok: false, label: 'Copilot not available' })).toBe('⚠ Copilot not available');
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

  it('loads graph files with and without step descriptions, and caps their length', () => {
    const n = (extra: object) => ({ id: 'n1', title: 'T', kind: 'agent', ...extra });
    const ok = parseGraph({ id: 'g', name: 'G', nodes: [n({}), { ...n({ description: 'Does a thing.' }), id: 'n2' }] });
    expect(ok.ok && ok.graph.nodes.map((x) => x.description)).toEqual([undefined, 'Does a thing.']);
    expect(parseGraph({ id: 'g', name: 'G', nodes: [n({ description: 'x'.repeat(2001) })] }).ok).toBe(false);
  });

  it('accepts a description in addNode and updateNode ops', () => {
    const add = { type: 'op', graphId: 'g', op: { type: 'addNode', node: { title: 'T', kind: 'agent', description: 'd' } } };
    const upd = { type: 'op', graphId: 'g', op: { type: 'updateNode', id: 'n1', patch: { description: 'd' } } };
    expect(parseWebviewMessage(add)).toEqual({ ok: true, kind: 'engine', msg: add });
    expect(parseWebviewMessage(upd)).toEqual({ ok: true, kind: 'engine', msg: upd });
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
