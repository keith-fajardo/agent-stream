import { describe, expect, it } from 'vitest';
import { emptyGraph, type Graph, type RunMeta, type ServerMessage } from '@claude-stream/shared';
import { initialState, logKey, reduce, type Action, type State } from '../src/state';

const T = 't';
const graph = (id: string, nodes: string[] = []): Graph => ({
  ...emptyGraph(id, id.toUpperCase(), T),
  nodes: nodes.map((n) => ({ id: n, title: n, kind: 'agent' as const, prompt: 'p', createdBy: 'user' as const, updatedBy: 'user' as const, updatedAt: T })),
});
const run = (id: string, graphId: string, status: RunMeta['status'] = 'running'): RunMeta => ({
  id,
  graphId,
  status,
  startedAt: T,
  snapshot: graph(graphId, ['n1']),
  nodes: { n1: { status: 'queued' } },
});
const server = (msg: ServerMessage): Action => ({ kind: 'server', msg });
const opened = (g: Graph, extra: Partial<Extract<ServerMessage, { type: 'graphOpened' }>> = {}): Action =>
  server({ type: 'graphOpened', graph: g, chat: [], chatBusy: false, runs: [], variableValues: {}, ...extra });
const apply = (...actions: Action[]): State => actions.reduce(reduce, initialState);

describe('client state', () => {
  it('tracks the connection and account', () => {
    const s = apply(server({ type: 'hello', auth: { ok: true, plan: 'max' }, project: '/p', graphs: [{ id: 'a', name: 'A' }], approvals: [] }));
    expect(s).toMatchObject({ connected: true, auth: { ok: true }, project: '/p', graphs: [{ id: 'a', name: 'A' }] });
    expect(reduce(s, { kind: 'disconnected' }).connected).toBe(false);
  });

  it('switches graphs and resets graph-scoped state', () => {
    const s1 = apply(opened(graph('a', ['n1'])), { kind: 'selectNode', id: 'n1' }, server({ type: 'nodeLogs', runId: 'r', nodeId: 'n1', events: [] }));
    expect(s1).toMatchObject({ selectedNodeId: 'n1', tab: 'node' });
    const same = reduce(s1, opened(graph('a', ['n1'])));
    expect(same.selectedNodeId).toBe('n1');
    expect(same.logs).toEqual({});
    const other = reduce(s1, opened(graph('b')));
    expect(other.graph?.id).toBe('b');
    expect(other.selectedNodeId).toBeUndefined();
  });

  it('applies graph updates only to the open graph', () => {
    const s = apply(opened(graph('a', ['n1', 'n2'])), { kind: 'selectNode', id: 'n2' });
    expect(reduce(s, server({ type: 'graph', graph: graph('b', ['x']) })).graph?.id).toBe('a');
    const updated = reduce(s, server({ type: 'graph', graph: graph('a', ['n1']) }));
    expect(updated.graph?.nodes).toHaveLength(1);
    expect(updated.selectedNodeId).toBeUndefined();
  });

  it('follows new runs, keeps the selected run current and ignores unrelated runs', () => {
    const s = apply(opened(graph('a', ['n1']), { run: run('r1', 'a', 'succeeded') }));
    expect(reduce(s, server({ type: 'run', run: run('r0', 'a', 'failed') })).run?.id).toBe('r1');
    expect(reduce(s, server({ type: 'run', run: run('r0', 'a', 'failed'), select: true })).run?.id).toBe('r0');
    expect(reduce(s, server({ type: 'run', run: run('r9', 'b') })).run?.id).toBe('r1');
    const s2 = reduce(s, server({ type: 'run', run: run('r2', 'a') }));
    expect(s2.run?.id).toBe('r2');
    const s3 = reduce(s2, server({ type: 'runNode', runId: 'r2', nodeId: 'n1', state: { status: 'running' } }));
    expect(s3.run?.nodes.n1.status).toBe('running');
    expect(reduce(s3, server({ type: 'runNode', runId: 'r1', nodeId: 'n1', state: { status: 'failed' } })).run?.nodes.n1.status).toBe('running');
  });

  it('appends live log events only once the log is loaded', () => {
    const event = { at: T, type: 'text' as const, text: 'hi' };
    const s = apply(opened(graph('a')));
    expect(reduce(s, server({ type: 'nodeEvent', runId: 'r', nodeId: 'n1', event })).logs).toEqual({});
    const loaded = reduce(s, server({ type: 'nodeLogs', runId: 'r', nodeId: 'n1', events: [event] }));
    const appended = reduce(loaded, server({ type: 'nodeEvent', runId: 'r', nodeId: 'n1', event: { ...event, text: 'more' } }));
    expect(appended.logs[logKey('r', 'n1')].map((e) => (e.type === 'text' ? e.text : ''))).toEqual(['hi', 'more']);
  });

  it('scopes chat and run confirmations to the open graph', () => {
    const entry = { at: T, role: 'assistant' as const, text: 'plan' };
    const s = apply(opened(graph('a')));
    expect(reduce(s, server({ type: 'chatEntry', graphId: 'b', entry })).chat).toEqual([]);
    expect(reduce(s, server({ type: 'chatEntry', graphId: 'a', entry })).chat).toEqual([entry]);
    expect(reduce(s, server({ type: 'chatBusy', graphId: 'a', busy: true })).chatBusy).toBe(true);
    expect(reduce(s, server({ type: 'confirmRun', graphId: 'a', fromNodeId: 'n2', sourceRunId: 'r1' })).confirm).toEqual({ fromNodeId: 'n2', sourceRunId: 'r1' });
    expect(reduce(s, server({ type: 'confirmRun', graphId: 'b' })).confirm).toBeUndefined();
  });

  it('shows errors and rejected edits as a toast', () => {
    const s = apply(opened(graph('a')));
    expect(reduce(s, server({ type: 'opRejected', graphId: 'a', error: 'cycle' })).toast).toBe('cycle');
    const errored = reduce(s, server({ type: 'error', message: 'boom' }));
    expect(errored.toast).toBe('boom');
    expect(reduce(errored, { kind: 'dismissToast' }).toast).toBeUndefined();
  });

  it('keeps the open graph’s variable values and the preview for the open dialog', () => {
    const preview = { graphId: 'a', problems: [], warnings: [], steps: [], variables: [], signature: 's' };
    const s = apply(opened(graph('a'), { variableValues: { schema: 'dev' } }), { kind: 'openConfirm', request: {} });
    expect(s.variableValues).toEqual({ schema: 'dev' });
    expect(reduce(s, server({ type: 'variableValues', graphId: 'b', values: {} })).variableValues).toEqual({ schema: 'dev' });
    expect(reduce(s, server({ type: 'variableValues', graphId: 'a', values: { schema: 'prod' } })).variableValues).toEqual({ schema: 'prod' });
    const withPreview = reduce(s, server({ type: 'runPreview', preview }));
    expect(withPreview.preview).toEqual(preview);
    expect(reduce(withPreview, { kind: 'closeConfirm' }).preview).toBeUndefined();
    expect(reduce(apply(opened(graph('a'))), server({ type: 'runPreview', preview })).preview).toBeUndefined(); // no dialog open
  });

  it('drops the open graph when it is deleted', () => {
    const s = apply(opened(graph('a', ['n1'])), { kind: 'selectNode', id: 'n1' });
    expect(reduce(s, server({ type: 'graphDeleted', graphId: 'b' })).graph?.id).toBe('a');
    const gone = reduce(s, server({ type: 'graphDeleted', graphId: 'a' }));
    expect(gone).toMatchObject({ graph: undefined, selectedNodeId: undefined, toast: 'This graph was deleted.' });
  });
});
