import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Decision } from '@agent-stream/shared';
import { ApprovalBroker } from '../src/approvals';
import type { LoopTool } from '../src/agentLoop/tools';
import { createPlannerGate, createStepGate, STEP_GRAPH_TOOL_PREFIX, type ToolGate } from '../src/providers/toolGate';
import { aliasedPathDeclined, changePrivacyReason, createServerRequestHandler, grantRootDeclined, toPatchChanges, UNNAMED_CHANGE, type ApprovalContext } from '../src/providers/codex/approvals';
import { UNSUPPORTED_REQUEST } from '../src/providers/codex/connection';
import type { CommandAction, FileUpdateChange } from '../src/providers/codex/protocol';
import { approvalParams, readAction, waitFor } from './codexFake';
import { pathPrivacy } from '../src/providers/codex/readOnlyCommand';

const cwd = resolve('/', 'work', 'proj');
const values = resolve('/', 'h', '.agent-stream', 'values', 'abc.json');
const VALUES_REASON = "Variable values are private to this machine; Agent Stream doesn't let Claude read the variable values file.";
const RUN_REASON = "Run records contain variable values; Agent Stream doesn't let Claude read .agent-stream/runs/*/run.json or events.jsonl.";
const at = { threadId: 'thread-1', turnId: 'turn-1', startedAtMs: 0 };

function stepGate(o: { readOnly?: boolean; selfApproving?: string[] } = {}) {
  const broker = new ApprovalBroker();
  const gate = createStepGate({
    broker,
    runId: 'r1',
    graphId: 'g',
    nodeId: 'n1',
    nodeTitle: 'Step',
    projectDir: cwd,
    privateFiles: [values],
    signal: new AbortController().signal,
    emit: () => {},
    readOnly: o.readOnly,
    selfApproving: new Set(o.selfApproving ?? []),
  });
  return { gate, broker };
}
const plannerGate = (graphToolNames: string[] = []) => createPlannerGate({ projectDir: cwd, privateFiles: [values], graphToolNames: new Set(graphToolNames) });

function handlerFor(gate: ToolGate, over: Partial<ApprovalContext> = {}) {
  const declined = new Map<string, string>();
  const notes: string[] = [];
  const fileChanges = new Map<string, FileUpdateChange[]>();
  const handle = createServerRequestHandler({
    gate,
    cwd,
    platform: 'linux',
    tools: new Map(),
    signal: new AbortController().signal,
    fileChanges,
    onDeclined: (id, reason) => declined.set(id, reason),
    note: (text) => notes.push(text),
    ...over,
  });
  return { handle, declined, notes, fileChanges };
}

const zsh = (script: string) => `/bin/zsh -lc '${script}'`;
const command = (script: string, actions: CommandAction[] = [{ type: 'unknown', command: script }], reason?: string) =>
  approvalParams({ command: zsh(script), cwd, actions, ...(reason !== undefined && { reason }) });
const plainRead = command('cat notes.txt', [readAction('cat notes.txt', resolve(cwd, 'notes.txt'))]);

async function decideNext(broker: ApprovalBroker, decision: Decision) {
  await waitFor(() => broker.pending().length === 1);
  const [request] = broker.pending();
  broker.decide(request.id, decision);
  return request;
}

describe('commands', () => {
  it('asks the user, showing the command and its reason, and accepts when approved', async () => {
    const { gate, broker } = stepGate();
    const { handle } = handlerFor(gate);
    const answer = handle('item/commandExecution/requestApproval', command('npm test', undefined, 'Run the tests'));
    const request = await decideNext(broker, { decision: 'approve' });
    expect(request).toMatchObject({ toolName: 'Bash', input: { command: zsh('npm test'), description: 'Run the tests' } });
    expect(await answer).toEqual({ decision: 'accept' });
  });

  it('declines a denied command and remembers why, for its log line (R13)', async () => {
    const { gate, broker } = stepGate();
    const { handle, declined } = handlerFor(gate);
    const answer = handle('item/commandExecution/requestApproval', command('rm -rf build'));
    await decideNext(broker, { decision: 'deny', note: 'not now' });
    expect(await answer).toEqual({ decision: 'decline' });
    expect(declined.get('cmd-1')).toBe('Denied by the user: not now');
  });

  it('runs a plain read without asking', async () => {
    const { gate, broker } = stepGate();
    const { handle } = handlerFor(gate);
    expect(await handle('item/commandExecution/requestApproval', plainRead)).toEqual({ decision: 'accept' });
    expect(broker.pending()).toEqual([]);
  });

  it('declines a private-path command without asking, with the privacy reason', async () => {
    const { gate, broker } = stepGate();
    const { handle, declined } = handlerFor(gate);
    expect(await handle('item/commandExecution/requestApproval', command(`cat ${values}`, [readAction(`cat ${values}`, values)]))).toEqual({ decision: 'decline' });
    expect(declined.get('cmd-1')).toBe(VALUES_REASON);
    expect(broker.pending()).toEqual([]);
  });

  it('declines everything that would change something in a read-only step without asking, but lets plain reads run (R2)', async () => {
    const { gate, broker } = stepGate({ readOnly: true });
    const { handle, declined } = handlerFor(gate);
    expect(await handle('item/commandExecution/requestApproval', command('touch x'))).toEqual({ decision: 'decline' });
    expect(declined.get('cmd-1')).toBe('This step is read-only, so Bash isn\'t allowed. Mark the step "Can edit files" if it needs to change something.');
    expect(await handle('item/commandExecution/requestApproval', plainRead)).toEqual({ decision: 'accept' });
    expect(broker.pending()).toEqual([]);
  });

  it('never asks in the planner: changes are refused, reads run', async () => {
    const { handle, declined } = handlerFor(plannerGate());
    expect(await handle('item/commandExecution/requestApproval', command('touch x'))).toEqual({ decision: 'decline' });
    expect(declined.get('cmd-1')).toBe('The planner can only read files and edit the graph.');
    expect(await handle('item/commandExecution/requestApproval', plainRead)).toEqual({ decision: 'accept' });
  });

  it('withdraws an open approval card when its signal aborts (R18)', async () => {
    const { gate, broker } = stepGate();
    const ac = new AbortController();
    const { handle, declined } = handlerFor(gate, { signal: ac.signal });
    const answer = handle('item/commandExecution/requestApproval', command('npm test'));
    await waitFor(() => broker.pending().length === 1);
    ac.abort();
    expect(await answer).toEqual({ decision: 'decline' });
    expect(broker.pending()).toEqual([]);
    expect(declined.get('cmd-1')).toBe('The approval request expired or was withdrawn.');
  });
});

describe('file changes', () => {
  const changes: FileUpdateChange[] = [
    { path: resolve(cwd, 'a.ts'), kind: { type: 'update', move_path: null }, diff: '@@ -1 +1 @@\n-old\n+new' },
    { path: resolve(cwd, 'b.ts'), kind: { type: 'add' }, diff: '+hi' },
  ];

  it('asks with the changes from the item Codex started, and answers the decision', async () => {
    const { gate, broker } = stepGate();
    const { handle, fileChanges } = handlerFor(gate);
    fileChanges.set('patch-1', changes);
    const approved = handle('item/fileChange/requestApproval', { ...at, itemId: 'patch-1', reason: 'Fix the bug' });
    const request = await decideNext(broker, { decision: 'approve' });
    expect(request).toMatchObject({
      toolName: 'Patch',
      input: {
        description: 'Fix the bug',
        changes: [
          { path: resolve(cwd, 'a.ts'), kind: 'update', diff: '@@ -1 +1 @@\n-old\n+new' },
          { path: resolve(cwd, 'b.ts'), kind: 'add', diff: '+hi' },
        ],
      },
    });
    expect(await approved).toEqual({ decision: 'accept' });
    const denied = handle('item/fileChange/requestApproval', { ...at, itemId: 'patch-1' });
    await decideNext(broker, { decision: 'deny' });
    expect(await denied).toEqual({ decision: 'decline' });
  });

  it("declines without asking a change it never saw, a request for a whole folder, and a change to a private path (R14, R26)", async () => {
    const { gate, broker } = stepGate();
    const { handle, fileChanges, declined } = handlerFor(gate);
    expect(await handle('item/fileChange/requestApproval', { ...at, itemId: 'nope' })).toEqual({ decision: 'decline' });
    expect(declined.get('nope')).toBe(UNNAMED_CHANGE);
    fileChanges.set('patch-1', changes);
    expect(await handle('item/fileChange/requestApproval', { ...at, itemId: 'patch-1', grantRoot: cwd })).toEqual({ decision: 'decline' });
    expect(declined.get('patch-1')).toBe(grantRootDeclined(cwd));
    fileChanges.set('patch-2', [{ path: resolve(cwd, '.agent-stream', 'runs', 'r1', 'run.json'), kind: { type: 'update', move_path: null }, diff: '' }]);
    expect(await handle('item/fileChange/requestApproval', { ...at, itemId: 'patch-2' })).toEqual({ decision: 'decline' });
    expect(declined.get('patch-2')).toBe(RUN_REASON);
    expect(broker.pending()).toEqual([]);
  });

  it('declines a change to an upstream output.md and a move into the runs folder without asking (R6a)', async () => {
    const { gate, broker } = stepGate();
    // A real file: a step may read an existing upstream output.md, but may not change it.
    const root = mkdtempSync(join(tmpdir(), 'codex-approvals-'));
    const out = join(root, '.agent-stream', 'runs', 'r1', 'nodes', 'n1', 'output.md');
    mkdirSync(join(out, '..'), { recursive: true });
    writeFileSync(out, 'x');
    const { handle, fileChanges, declined } = handlerFor(gate, { cwd: root });
    fileChanges.set('p-out', [{ path: out, kind: { type: 'update', move_path: null }, diff: '' }]);
    expect(await handle('item/fileChange/requestApproval', { ...at, itemId: 'p-out' })).toEqual({ decision: 'decline' });
    expect(declined.get('p-out')).toMatch(/run records and sessions/);
    fileChanges.set('p-mv', [{ path: resolve(cwd, 'a.ts'), kind: { type: 'update', move_path: resolve(cwd, '.agent-stream', 'runs', 'r1', 'x.md') }, diff: '' }]);
    expect(await handle('item/fileChange/requestApproval', { ...at, itemId: 'p-mv' })).toEqual({ decision: 'decline' });
    expect(declined.has('p-mv')).toBe(true);
    expect(broker.pending()).toEqual([]);
  });

  it('declines without asking a change whose path could be another spelling of a private folder (RF3)', async () => {
    const update = (path: string, move_path: string | null = null): FileUpdateChange => ({ path, kind: { type: 'update', move_path }, diff: '' });
    const folded = resolve(cwd, '.agent-\u017ftream', 'runs', 'r1', 'run.json');
    const shortName = resolve(cwd, 'AGENT-~1', 'runs', 'r1', 'run.json');
    const { gate, broker } = stepGate();
    const { handle, fileChanges, declined } = handlerFor(gate);
    fileChanges.set('p-fold', [update(folded)]);
    expect(await handle('item/fileChange/requestApproval', { ...at, itemId: 'p-fold' })).toEqual({ decision: 'decline' });
    expect(declined.get('p-fold')).toBe(aliasedPathDeclined(folded));
    const cafe = resolve(cwd, 'caf\u00e9.md');
    fileChanges.set('p-mv', [update(resolve(cwd, 'a.ts'), cafe)]);
    expect(await handle('item/fileChange/requestApproval', { ...at, itemId: 'p-mv' })).toEqual({ decision: 'decline' });
    expect(declined.get('p-mv')).toBe(aliasedPathDeclined(cafe));
    const win = handlerFor(gate, { platform: 'win32' });
    win.fileChanges.set('p-short', [update(shortName)]);
    expect(await win.handle('item/fileChange/requestApproval', { ...at, itemId: 'p-short' })).toEqual({ decision: 'decline' });
    expect(win.declined.get('p-short')).toBe(aliasedPathDeclined(shortName));
    expect(broker.pending()).toEqual([]);
    // Outside Windows a ~ is an ordinary character in a name: the change asks.
    const privacy = pathPrivacy(gate);
    expect(changePrivacyReason(privacy, cwd, update(shortName), 'linux')).toBeUndefined();
    expect(changePrivacyReason(privacy, cwd, update(resolve(cwd, 'notes~')), 'win32')).toBe(aliasedPathDeclined(resolve(cwd, 'notes~')));
    // The folder the step works in, and its parents, may have such names: only what lies past it counts.
    const accented = resolve('/', 'work', 'D\u00e9veloppement', 'proj');
    expect(changePrivacyReason(privacy, accented, update(resolve(accented, 'a.ts')), 'linux')).toBeUndefined();
    const short = resolve('/', 'KEITHF~1', 'proj');
    expect(changePrivacyReason(privacy, short, update(resolve(short, 'a.ts')), 'win32')).toBeUndefined();
    expect(changePrivacyReason(privacy, short, update(resolve(short, 'AGENT-~1', 'runs', 'r1', 'run.json')), 'win32')).toBeDefined();
  });

  it('treats an empty change list as one Codex never named (R6b)', async () => {
    const { gate, broker } = stepGate();
    const { handle, fileChanges, declined } = handlerFor(gate);
    fileChanges.set('empty', []);
    expect(await handle('item/fileChange/requestApproval', { ...at, itemId: 'empty' })).toEqual({ decision: 'decline' });
    expect(declined.get('empty')).toBe(UNNAMED_CHANGE);
    expect(broker.pending()).toEqual([]);
  });

  it('declines a Patch without asking in a read-only step and in the planner', async () => {
    for (const gate of [stepGate({ readOnly: true }).gate, plannerGate()]) {
      const { handle, fileChanges, declined } = handlerFor(gate);
      fileChanges.set('p1', changes);
      expect(await handle('item/fileChange/requestApproval', { ...at, itemId: 'p1' })).toEqual({ decision: 'decline' });
      expect(declined.get('p1')).toBeTruthy();
    }
  });

  it('lists each change with its kind, and a move target', () => {
    expect(
      toPatchChanges([
        { path: 'a', kind: { type: 'update', move_path: 'b' }, diff: 'd' },
        { path: 'c', kind: { type: 'delete' }, diff: '' },
      ]),
    ).toEqual([
      { path: 'a', kind: 'update', diff: 'd', movePath: 'b' },
      { path: 'c', kind: 'delete', diff: '' },
    ]);
  });
});

describe('other requests', () => {
  it('declines extra permissions with an empty grant, and says so in the log (R3)', async () => {
    const { gate } = stepGate();
    const { handle, notes } = handlerFor(gate);
    expect(await handle('item/permissions/requestApproval', { ...at, itemId: 'p1', reason: 'network', permissions: { network: { enabled: true } } })).toEqual({ permissions: {}, scope: 'turn' });
    expect(notes).toEqual(['Codex asked for extra permissions; declined.']);
  });

  it('runs a step graph tool through the gate without a second approval, and reports its result', async () => {
    const run = vi.fn(async (_input: unknown, _signal: AbortSignal): Promise<{ text: string; isError?: boolean }> => ({ text: 'Added n5.' }));
    const tool: LoopTool = { spec: { name: 'add_step', description: 'Add a step', inputSchema: {} }, gateName: `${STEP_GRAPH_TOOL_PREFIX}add_step`, run };
    const { gate, broker } = stepGate({ selfApproving: [`${STEP_GRAPH_TOOL_PREFIX}add_step`] });
    const { handle } = handlerFor(gate, { tools: new Map([['add_step', tool]]) });
    const call = (name: string) => handle('item/tool/call', { ...at, callId: 'c1', namespace: null, tool: name, arguments: { title: 'x' } });
    expect(await call('add_step')).toEqual({ contentItems: [{ type: 'inputText', text: 'Added n5.' }], success: true });
    expect(run).toHaveBeenCalledWith({ title: 'x' }, expect.any(AbortSignal));
    expect(broker.pending()).toEqual([]);
    run.mockResolvedValueOnce({ text: 'No such step.', isError: true });
    expect(await call('add_step')).toEqual({ contentItems: [{ type: 'inputText', text: 'No such step.' }], success: false });
    expect(await call('nope')).toEqual({ contentItems: [{ type: 'inputText', text: 'Unknown tool nope.' }], success: false });
  });

  it('passes the same arguments to the gate and the tool, and reports a throw as a failure (R6c)', async () => {
    const run = vi.fn(async (_input: unknown, _signal: AbortSignal): Promise<{ text: string }> => {
      throw new Error('boom');
    });
    const tool: LoopTool = { spec: { name: 't', description: '', inputSchema: {} }, gateName: 't', run };
    const gate: ToolGate = { ...plannerGate(['t']), decide: vi.fn(async () => ({ allow: true as const, by: 'graphTool' as const })) };
    const { handle } = handlerFor(gate, { tools: new Map([['t', tool]]) });
    expect(await handle('item/tool/call', { ...at, callId: 'c', namespace: null, tool: 't', arguments: null })).toEqual({ contentItems: [{ type: 'inputText', text: 'boom' }], success: false });
    expect(gate.decide).toHaveBeenCalledWith('t', {}, expect.any(AbortSignal));
    expect(run).toHaveBeenCalledWith({}, expect.any(AbortSignal));
  });

  it("lets the planner gate decide on graph tools by their plain names", async () => {
    const run = vi.fn(async (_input: unknown, _signal: AbortSignal) => ({ text: 'ok' }));
    const tools = new Map<string, LoopTool>([
      ['add_step', { spec: { name: 'add_step', description: '', inputSchema: {} }, gateName: 'add_step', run }],
      ['other', { spec: { name: 'other', description: '', inputSchema: {} }, gateName: 'other', run }],
    ]);
    const { handle } = handlerFor(plannerGate(['add_step']), { tools });
    expect(await handle('item/tool/call', { ...at, callId: 'c1', namespace: null, tool: 'add_step', arguments: {} })).toEqual({ contentItems: [{ type: 'inputText', text: 'ok' }], success: true });
    expect(await handle('item/tool/call', { ...at, callId: 'c2', namespace: null, tool: 'other', arguments: {} })).toEqual({
      contentItems: [{ type: 'inputText', text: 'The planner can only read files and edit the graph.' }],
      success: false,
    });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("answers requests Agent Stream doesn't support with a JSON-RPC error (R16)", async () => {
    const { gate } = stepGate();
    const { handle } = handlerFor(gate);
    for (const method of ['item/tool/requestUserInput', 'mcpServer/elicitation/request', 'execCommandApproval', 'applyPatchApproval', 'currentTime/read', 'attestation/generate', 'account/chatgptAuthTokens/refresh', 'something/new']) {
      await expect(handle(method, {}), method).rejects.toMatchObject({ code: -32601, message: UNSUPPORTED_REQUEST });
    }
  });
});
