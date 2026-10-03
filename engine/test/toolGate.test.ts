import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ApprovalBroker } from '../src/approvals';
import { createPlannerGate, createStepGate, withDecide } from '../src/providers/toolGate';

const VALUES = resolve('/', 'home', 'me', '.agent-stream', 'values', '0123456789abcdef.json');
const PROJECT = resolve('/', 'work', 'proj');

function stepGate(signal = new AbortController().signal) {
  const broker = new ApprovalBroker(() => 't');
  const emit = vi.fn();
  const gate = createStepGate({ broker, runId: 'r', graphId: 'g', nodeId: 'n1', nodeTitle: 'Step', projectDir: PROJECT, privateFiles: [VALUES], signal, emit });
  return { broker, emit, gate };
}

describe('step gate', () => {
  it('refuses private files before anything else', async () => {
    const { gate, broker } = stepGate();
    expect(gate.privacy('Read', { file_path: VALUES })).toMatch(/private to this machine/);
    expect(await gate.decide('Read', { file_path: VALUES })).toEqual({ allow: false, reason: expect.stringMatching(/private to this machine/) });
    expect(broker.pending()).toEqual([]);
  });

  it('lets read-only tools through without asking', async () => {
    const { gate, broker } = stepGate();
    expect(gate.isReadOnly('Grep')).toBe(true);
    expect(await gate.decide('Grep', { pattern: 'x', path: join(PROJECT, 'src') })).toEqual({ allow: true, by: 'readOnly' });
    expect(broker.pending()).toEqual([]);
  });

  it('asks the user for everything else and reports both events', async () => {
    const { gate, broker, emit } = stepGate();
    const decision = gate.decide('Bash', { command: 'ls' });
    const [request] = broker.pending();
    expect(request).toMatchObject({ runId: 'r', graphId: 'g', nodeId: 'n1', nodeTitle: 'Step', toolName: 'Bash' });
    broker.decide(request.id, { decision: 'approve' });
    expect(await decision).toEqual({ allow: true, by: 'user' });
    expect(emit.mock.calls.map((c) => c[0].type)).toEqual(['approval_requested', 'approval_decided']);
  });

  it('turns a denial note into the reason', async () => {
    const { gate, broker } = stepGate();
    const decision = gate.decide('Edit', { file_path: 'a' });
    broker.decide(broker.pending()[0].id, { decision: 'deny', note: 'not now' });
    expect(await decision).toEqual({ allow: false, reason: 'Denied by the user: not now' });
  });

  it('says the run was stopped when its signal aborts', async () => {
    const run = new AbortController();
    const { gate } = stepGate(run.signal);
    const decision = gate.decide('Bash', { command: 'ls' });
    run.abort();
    expect(await decision).toEqual({ allow: false, reason: 'The run was stopped.' });
  });

  it('lets self-approving tools through without asking, after the privacy check', async () => {
    const broker = new ApprovalBroker(() => 't');
    const gate = createStepGate({ broker, runId: 'r', graphId: 'g', nodeId: 'n1', nodeTitle: 'Step', projectDir: PROJECT, privateFiles: [VALUES], signal: new AbortController().signal, emit: vi.fn(), selfApproving: new Set(['mcp__run_graph__add_step']) });
    expect(gate.isSelfApproving('mcp__run_graph__add_step')).toBe(true);
    expect(gate.isSelfApproving('Bash')).toBe(false);
    expect(await gate.decide('mcp__run_graph__add_step', {})).toEqual({ allow: true, by: 'graphTool' });
    expect(broker.pending()).toEqual([]);
    expect(stepGate().gate.isSelfApproving('mcp__run_graph__add_step')).toBe(false);
  });

  it("keeps the folder's run records private from a step in a workspace (Review Focus 4)", () => {
    const workspace = resolve('/', 'home', 'me', '.agent-stream', 'worktrees', '0123456789abcdef', '20261003-000000-0001', 'wh_a');
    const gate = createStepGate({ broker: new ApprovalBroker(() => 't'), runId: 'r', graphId: 'g', nodeId: 'n1', nodeTitle: 'Step', projectDir: workspace, runsRoot: PROJECT, privateFiles: [VALUES], signal: new AbortController().signal, emit: vi.fn() });
    const runDir = join(PROJECT, '.agent-stream', 'runs', '20261003-000000-0001');
    expect(gate.privacy('Read', { file_path: join(runDir, 'run.json') })).toMatch(/Run records contain variable values/);
    expect(gate.privacy('Read', { file_path: join(runDir, 'nodes', 'n1', 'events.jsonl') })).toMatch(/Run records contain variable values/);
    expect(gate.privacy('Read', { file_path: join(runDir, 'nodes', 'n1', 'output.md') })).toBeNull();
    expect(gate.privacy('Read', { file_path: join(workspace, 'models', 'orders.sql') })).toBeNull();
  });
});

describe('planner gate', () => {
  const gate = createPlannerGate({ projectDir: PROJECT, privateFiles: [VALUES], graphToolNames: new Set(['add_node']) });
  it('allows read-only and graph tools, refuses the rest, and keeps privacy first', async () => {
    expect(await gate.decide('Glob', { pattern: '*' })).toEqual({ allow: true, by: 'readOnly' });
    expect(await gate.decide('add_node', { kind: 'agent', title: 't' })).toEqual({ allow: true, by: 'graphTool' });
    expect(await gate.decide('Bash', { command: 'ls' })).toEqual({ allow: false, reason: 'The planner can only read files and edit the graph.' });
    expect(await gate.decide('Grep', { pattern: 'x', path: '/' })).toMatchObject({ allow: false });
  });
});

describe('decide', () => {
  it('fails closed when the privacy check throws', async () => {
    const gate = withDecide({ privacy: () => { throw new Error('boom'); }, isReadOnly: () => false, approve: async () => ({ allow: true, by: 'user' }) });
    expect(await gate.decide('Bash', {})).toEqual({ allow: false, reason: 'Agent Stream could not ask for approval: boom' });
  });
});
