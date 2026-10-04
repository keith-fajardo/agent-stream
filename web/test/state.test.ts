import { describe, expect, it } from 'vitest';
import { emptyGraph, type Graph, type HostMessage, type RunMeta, type ServerMessage } from '@agent-stream/shared';
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
const server = (msg: HostMessage): Action => ({ kind: 'server', msg });
const opened = (g: Graph, extra: Partial<Extract<ServerMessage, { type: 'graphOpened' }>> = {}): Action =>
  server({ type: 'graphOpened', changes: [], graph: g, runs: [], variableValues: {}, ...extra });
const apply = (...actions: Action[]): State => actions.reduce(reduce, initialState);

describe('client state', () => {
  it("keeps the provider's models and the open conversation's model choice", () => {
    const target = { graphId: 'g', graphName: 'G', sessionId: 's', sessionName: 'S' };
    const models = [{ value: 'sonnet', label: 'Sonnet', efforts: ['high' as const] }];
    let s = apply(server({ type: 'chatTarget', target }), server({ type: 'models', provider: 'claude', models, defaultEfforts: ['low'] }));
    expect(s.models).toEqual(models);
    expect(s.defaultEfforts).toEqual(['low']);
    expect(s.plannerModel).toEqual({});
    s = reduce(s, server({ type: 'chatOpened', graphId: 'g', sessionId: 's', chat: [], busy: false, model: 'sonnet', effort: 'high' }));
    expect(s.plannerModel).toEqual({ model: 'sonnet', effort: 'high' });
    // Another conversation's choice is not this one's.
    expect(reduce(s, server({ type: 'plannerModel', graphId: 'g', sessionId: 'other', model: 'x' })).plannerModel).toEqual({ model: 'sonnet', effort: 'high' });
    s = reduce(s, server({ type: 'plannerModel', graphId: 'g', sessionId: 's' }));
    expect(s.plannerModel).toEqual({});
    s = reduce(s, server({ type: 'plannerModel', graphId: 'g', sessionId: 's', model: 'sonnet' }));
    // A different conversation starts at Default until its chatOpened arrives.
    s = reduce(s, server({ type: 'chatTarget', target: { ...target, graphId: 'h' } }));
    expect(s.plannerModel).toEqual({});
    expect(s.models).toEqual(models);
  });

  it('tracks the connection and account', () => {
    const s = apply(server({ type: 'hello', status: { provider: 'claude', ok: true, label: 'Claude Max' }, project: '/p', graphs: [{ id: 'a', name: 'A' }], approvals: [] }));
    expect(s).toMatchObject({ connected: true, status: { provider: 'claude', ok: true, label: 'Claude Max' }, project: '/p', graphs: [{ id: 'a', name: 'A' }] });
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
    expect(reduce(s, server({ type: 'graph', changes: [], graph: graph('b', ['x']) })).graph?.id).toBe('a');
    const updated = reduce(s, server({ type: 'graph', changes: [], graph: graph('a', ['n1']) }));
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

  it('scopes run confirmations to the open graph', () => {
    const s = apply(opened(graph('a')));
    expect(reduce(s, server({ type: 'confirmRun', graphId: 'a', fromNodeId: 'n2', sourceRunId: 'r1' })).confirm).toEqual({ fromNodeId: 'n2', sourceRunId: 'r1' });
    expect(reduce(s, server({ type: 'confirmRun', graphId: 'b' })).confirm).toBeUndefined();
    expect(reduce(s, server({ type: 'confirmRun', graphId: 'a', requestedBy: 'planner' })).confirm).toEqual({ requestedBy: 'planner' });
  });

  it('follows its chat target: new target clears, other conversations are ignored', () => {
    const entry = { at: T, role: 'assistant' as const, text: 'plan' };
    let s = reduce(initialState, server({ type: 'chatTarget', target: { graphId: 'g', graphName: 'G', sessionId: 'a', sessionName: 'A' } }));
    s = reduce(s, server({ type: 'chatOpened', graphId: 'g', sessionId: 'a', chat: [entry], busy: true }));
    expect([s.chat, s.chatBusy]).toEqual([[entry], true]);
    expect(reduce(s, server({ type: 'chatEntry', graphId: 'g', sessionId: 'b', entry })).chat).toEqual([entry]);
    expect(reduce(s, server({ type: 'chatOpened', graphId: 'h', sessionId: 'a', chat: [], busy: false })).chat).toEqual([entry]);
    const moved = reduce(s, server({ type: 'chatTarget', target: { graphId: 'g', graphName: 'G', sessionId: 'b', sessionName: 'B' } }));
    expect([moved.chat, moved.chatBusy]).toEqual([[], false]);
    expect(reduce(s, server({ type: 'chatTarget' })).chatTarget).toBeUndefined();
    expect(reduce(s, server({ type: 'sessions', sessions: [{ id: 'default', name: 'Default', tabCount: 0 }] }))).toBe(s);
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
    const s = apply(opened(graph('a'), { variableValues: { schema: 'dev' } }), { kind: 'openConfirm', request: {} }, { kind: 'previewRequested', requestId: 'p1' });
    expect(s.variableValues).toEqual({ schema: 'dev' });
    expect(reduce(s, server({ type: 'variableValues', graphId: 'b', values: {} })).variableValues).toEqual({ schema: 'dev' });
    expect(reduce(s, server({ type: 'variableValues', graphId: 'a', values: { schema: 'prod' } })).variableValues).toEqual({ schema: 'prod' });
    const withPreview = reduce(s, server({ type: 'runPreview', preview, requestId: 'p1' }));
    expect(withPreview.preview).toEqual(preview);
    expect(reduce(withPreview, { kind: 'closeConfirm' }).preview).toBeUndefined();
    expect(reduce(apply(opened(graph('a'))), server({ type: 'runPreview', preview, requestId: 'p1' })).preview).toBeUndefined(); // no dialog open
  });

  it('never keeps a stale preview', () => {
    const preview = { graphId: 'a', problems: [], warnings: [], steps: [], variables: [], signature: 's' };
    const open = apply(opened(graph('a')), { kind: 'openConfirm', request: {} }, { kind: 'previewRequested', requestId: 'p1' });
    const shown = reduce(open, server({ type: 'runPreview', preview, requestId: 'p1' }));
    expect(shown.preview).toEqual(preview);
    expect(reduce(shown, server({ type: 'graph', changes: [], graph: graph('a', ['n1']) })).preview).toBeUndefined();
    expect(reduce(shown, server({ type: 'variableValues', graphId: 'a', values: { x: '1' } })).preview).toBeUndefined();
    expect(reduce(shown, server({ type: 'variableValues', graphId: 'b', values: {} })).preview).toEqual(preview);
    const closed = apply(opened(graph('a')));
    expect(reduce(closed, server({ type: 'graph', changes: [], graph: graph('a', ['n1']) })).preview).toBeUndefined();
    expect(reduce(closed, { kind: 'previewRequested', requestId: 'p9' }).previewRequestId).toBe('p9');
    expect(reduce(shown, { kind: 'closeConfirm' }).previewRequestId).toBeUndefined();
  });

  it('accepts only the reply to the latest preview request', () => {
    const preview = { graphId: 'a', problems: [], warnings: [], steps: [], variables: [], signature: 's' };
    const s1 = apply(opened(graph('a')), { kind: 'openConfirm', request: {} }, { kind: 'previewRequested', requestId: 'p1' });
    const s2 = reduce(s1, { kind: 'previewRequested', requestId: 'p2' });
    expect(reduce(s2, server({ type: 'runPreview', preview, requestId: 'p1' })).preview).toBeUndefined();
    expect(reduce(s2, server({ type: 'runPreview', preview })).preview).toBeUndefined();
    expect(reduce(s2, server({ type: 'runPreview', preview, requestId: 'p2' })).preview).toEqual(preview);
  });

  it('drops the open graph when it is deleted', () => {
    const s = apply(opened(graph('a', ['n1'])), { kind: 'selectNode', id: 'n1' });
    expect(reduce(s, server({ type: 'graphDeleted', graphId: 'b' })).graph?.id).toBe('a');
    const gone = reduce(s, server({ type: 'graphDeleted', graphId: 'a' }));
    expect(gone).toMatchObject({ graph: undefined, selectedNodeId: undefined, toast: 'This graph was deleted.' });
  });

  it('follows sign-in changes', () => {
    const s = apply(server({ type: 'hello', status: { provider: 'claude', ok: false, label: 'not signed in', error: 'x' }, project: '/p', graphs: [], approvals: [] }));
    expect(reduce(s, server({ type: 'auth', status: { provider: 'claude', ok: true, label: 'Claude Max' } })).status).toEqual({ provider: 'claude', ok: true, label: 'Claude Max' });
  });

  it('handles the extension’s own messages', () => {
    const s = apply(opened(graph('a', ['n1'])));
    expect(reduce(s, server({ type: 'revealNode', nodeId: 'n1' }))).toMatchObject({ selectedNodeId: 'n1', tab: 'node' });
    expect(reduce(s, server({ type: 'revealNode', nodeId: 'missing' })).selectedNodeId).toBeUndefined();
    expect(reduce(s, server({ type: 'openRunDialog', fromNodeId: 'n1', sourceRunId: 'r' })).confirm).toEqual({ fromNodeId: 'n1', sourceRunId: 'r' });
    expect(reduce(s, server({ type: 'openRunDialog', requestedBy: 'planner' })).confirm).toEqual({ requestedBy: 'planner' });
    expect(reduce(s, server({ type: 'openVariables' })).variablesDialog).toEqual({});
    expect(reduce(s, server({ type: 'prefs', minimap: false })).minimap).toBe(false);
    expect(reduce(s, { kind: 'openVariables', focus: 'schema' }).variablesDialog).toEqual({ focus: 'schema' });
    expect(reduce(reduce(s, { kind: 'openVariables' }), { kind: 'closeVariables' }).variablesDialog).toBeUndefined();
    expect(reduce(s, { kind: 'setMinimap', value: false }).minimap).toBe(false);
  });

  describe('agent changes', () => {
    const baseline = graph('a', ['n1', 'n2']);
    const one: import('@agent-stream/shared').AgentChange[] = [{ kind: 'node', change: 'removed', id: 'n2', title: 'n2' }];

    it('stores the baseline and changes from graphOpened and graph', () => {
      const s = apply(opened(graph('a', ['n1']), { baseline, changes: one }));
      expect([s.baseline, s.changes]).toEqual([baseline, one]);
      const next = reduce(s, server({ type: 'graph', graph: graph('a', ['n1']), baseline: graph('a', ['n1']), changes: [] }));
      expect([next.baseline?.nodes.length, next.changes]).toEqual([1, []]);
      expect(reduce(s, server({ type: 'graph', graph: graph('b'), baseline: graph('b'), changes: [] })).changes).toEqual(one);
    });

    it('drops them when the graph is deleted', () => {
      const s = reduce(apply(opened(graph('a', ['n1']), { baseline, changes: one })), server({ type: 'graphDeleted', graphId: 'a' }));
      expect([s.baseline, s.changes]).toEqual([undefined, []]);
    });

    it('leaves the Changes tab when the count drops to 0', () => {
      const s = apply(opened(graph('a', ['n1']), { baseline, changes: one }), { kind: 'setTab', tab: 'changes' });
      expect(s.tab).toBe('changes');
      expect(reduce(s, server({ type: 'graph', graph: graph('a', ['n1']), changes: one })).tab).toBe('changes');
      expect(reduce(s, server({ type: 'graph', graph: graph('a', ['n1']), changes: [] })).tab).toBe('node');
      expect(reduce(s, opened(graph('a', ['n1']))).tab).toBe('node');
      const graphTab = apply(opened(graph('a'), { changes: one }), { kind: 'setTab', tab: 'graph' });
      expect(reduce(graphTab, server({ type: 'graph', graph: graph('a'), changes: [] })).tab).toBe('graph');
    });

    it('selects a change: opens the tab, and selects the step when it still exists', () => {
      const s = apply(opened(graph('a', ['n1']), { baseline, changes: one }));
      const ghost = reduce(s, { kind: 'selectChange', key: 'node:n2' });
      expect([ghost.tab, ghost.selectedChange, ghost.selectedNodeId]).toEqual(['changes', 'node:n2', undefined]);
      const real = reduce(s, { kind: 'selectChange', key: 'node:n1' });
      expect([real.tab, real.selectedChange, real.selectedNodeId]).toEqual(['changes', 'node:n1', 'n1']);
      // Selecting a step on the canvas moves to the Node tab but leaves the change selection alone.
      expect(reduce(real, { kind: 'selectNode', id: 'n1' }).tab).toBe('node');
    });

    it('forgets a selected change that is no longer pending', () => {
      const s = apply(opened(graph('a', ['n1']), { baseline, changes: one }), { kind: 'selectChange', key: 'node:n2' });
      expect(reduce(s, server({ type: 'graph', graph: graph('a', ['n1']), changes: [] })).selectedChange).toBeUndefined();
      expect(reduce(s, server({ type: 'graph', graph: graph('a', ['n1']), changes: one })).selectedChange).toBe('node:n2');
    });

    it('does not carry a picked change or a pending confirmation over to another graph', () => {
      const s = apply(opened(graph('a', ['n1']), { baseline, changes: one }), { kind: 'selectChange', key: 'node:n2' }, { kind: 'openChangeConfirm', mode: 'accept' });
      const other = reduce(s, opened(graph('b', ['n1']), { changes: one }));
      expect([other.selectedChange, other.changeConfirm]).toEqual([undefined, undefined]);
      // Re-opening the same graph keeps them.
      const same = reduce(s, opened(graph('a', ['n1']), { baseline, changes: one }));
      expect([same.selectedChange, same.changeConfirm]).toEqual(['node:n2', 'accept']);
    });

    it('asks to confirm accepting or reverting everything', () => {
      const s = reduce(apply(opened(graph('a'), { changes: one })), { kind: 'openChangeConfirm', mode: 'revert' });
      expect(s.changeConfirm).toBe('revert');
      expect(reduce(s, { kind: 'closeChangeConfirm' }).changeConfirm).toBeUndefined();
      expect(reduce(s, server({ type: 'graph', graph: graph('a'), changes: [] })).changeConfirm).toBeUndefined();
    });
  });
});

describe('checkout and blocked runs', () => {
  const info = { git: false as const, root: '/p', reason: 'Not a Git repository' };
  const holder = { runId: '20261003-090000-aaaa', graphId: 'other', folder: '/p', pid: 1, startedAt: 't' };

  it('keeps the latest checkout and lease', () => {
    const s = apply(server({ type: 'checkout', info, lease: holder }));
    expect(s.checkout).toEqual({ info, lease: holder });
    expect(reduce(s, server({ type: 'checkout', info })).checkout).toEqual({ info });
  });

  it("shows a blocked run for this graph with the start it refused, and forgets it on close", () => {
    const start = { graphId: 'a', reviewed: 'sig', fromNodeId: undefined, sourceRunId: undefined };
    const blocked = { type: 'runBlocked' as const, graphId: 'a', message: 'no', holder, otherWindow: false, checkout: info, canSetUpTickets: false };
    const s = apply(opened(graph('a')), { kind: 'startRequested', start }, server(blocked));
    expect(s.blocked).toEqual({ message: 'no', canSetUpTickets: false, start });
    expect(reduce(s, { kind: 'closeBlocked' }).blocked).toBeUndefined();
    expect(apply(opened(graph('b')), server(blocked)).blocked).toBeUndefined();
  });
});

describe('the graph file', () => {
  const errors = [{ line: 4, message: 'kind is "robot"; use agent or command.' }];

  it("keeps the open graph's file errors until they clear or another graph opens", () => {
    const s = apply(opened(graph('a')), server({ type: 'graphFileErrors', graphId: 'a', errors }));
    expect(s.fileErrors).toEqual(errors);
    expect(reduce(s, server({ type: 'graphFileErrors', graphId: 'b', errors: [] })).fileErrors).toEqual(errors);
    expect(reduce(s, server({ type: 'graphFileErrors', graphId: 'a', errors: [] })).fileErrors).toEqual([]);
    expect(reduce(s, opened(graph('a'), { fileErrors: errors })).fileErrors).toEqual(errors);
    expect(reduce(s, opened(graph('b'))).fileErrors).toEqual([]);
  });

  it('marks the graph gone, without a toast, when its file is deleted; opening it again clears that', () => {
    const s = apply(opened(graph('a', ['n1'])), server({ type: 'graphFileErrors', graphId: 'a', errors }));
    const gone = reduce(s, server({ type: 'graphDeleted', graphId: 'a', reason: 'file' }));
    expect([gone.graph, gone.graphGone, gone.fileErrors, gone.toast]).toEqual([undefined, true, [], undefined]);
    expect(reduce(gone, opened(graph('a'))).graphGone).toBe(false);
  });
});

describe('Markdown editor state', () => {
  const FILE = '# G\n';
  const THEIRS = '# G changed\n';
  const shown = (...more: Action[]) => apply(opened(graph('g')), server({ type: 'graphMarkdown', graphId: 'g', text: FILE }), ...more);

  it('starts a draft from the text the editor showed, so an edit landing after a newer file still sees the change', () => {
    // The file changed, but the keystroke was typed into the text rendered before it arrived.
    const s = shown(server({ type: 'graphMarkdown', graphId: 'g', text: THEIRS }), { kind: 'markdownEdited', text: '# Mine\n', from: FILE });
    expect(s.markdown).toMatchObject({ draft: '# Mine\n', base: FILE, conflict: true, disk: THEIRS });
    // Typed into the current text: no conflict.
    expect(shown({ kind: 'markdownEdited', text: '# Mine\n', from: FILE }).markdown).toMatchObject({ draft: '# Mine\n', base: FILE, conflict: false });
  });

  it('never leaves a save waiting for good: hello, a lost connection, an error, Reload and Discard all end it', () => {
    const saving = shown({ kind: 'markdownEdited', text: '# Mine\n', from: FILE }, { kind: 'markdownSaving', thenGraph: false });
    expect(saving.markdown.saving).toEqual({ thenGraph: false });
    const hello = server({ type: 'hello', status: { provider: 'claude', ok: true, label: 'Claude Max' }, project: '/p', graphs: [], approvals: [] });
    for (const action of [hello, { kind: 'disconnected' } as Action, server({ type: 'error', message: 'Invalid message' }), { kind: 'markdownReload' } as Action]) {
      expect(reduce(saving, action).markdown.saving).toBeUndefined();
    }
    const afterError = reduce(saving, server({ type: 'error', message: 'Invalid message' }));
    expect(afterError.markdown.draft).toBe('# Mine\n');
    expect(afterError.toast).toBe('Invalid message');
  });

  it('keeps the draft and shows the reason when a save fails', () => {
    const s = shown({ kind: 'setCanvasMode', mode: 'markdown' }, { kind: 'markdownEdited', text: '# Mine\n', from: FILE }, { kind: 'markdownSaving', thenGraph: true }, server({ type: 'graphMarkdownSaved', graphId: 'g', ok: false, error: 'Could not save g.md (EACCES).' }));
    expect(s.markdown).toMatchObject({ draft: '# Mine\n', base: FILE, saving: undefined });
    expect(s.toast).toBe('Could not save g.md (EACCES).');
    expect(s.canvasMode).toBe('markdown');
  });
});
