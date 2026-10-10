// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyOp, emptyGraph, type Graph, type NodeRunState, type Op, type RunMeta, type RunPreview, type RunSummary } from '@agent-stream/shared';

vi.mock('../src/bridge', () => ({ send: vi.fn(), sendHost: vi.fn(), post: vi.fn() }));
const { send } = await import('../src/bridge');
const { dispatch, getState } = await import('../src/store');
const { buildMenus } = await import('../src/menuModel');
const { initialState, reduce } = await import('../src/state');
const { retryTarget, onlyAvailability } = await import('../src/retry');
const { TopBar } = await import('../src/components/TopBar');
const { NodePanel } = await import('../src/components/NodePanel');
const { RunConfirmDialog } = await import('../src/components/RunConfirmDialog');
const { LogsPanel } = await import('../src/components/LogsPanel');
const { StepNode } = await import('../src/components/StepNode');
const { ReactFlowProvider } = await import('@xyflow/react');
type State = import('../src/state').State;
type MenuAction = import('../src/menuModel').MenuAction;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const T = 't';
function build(ops: Op[]): Graph {
  let g = emptyGraph('g', 'G', T);
  for (const op of ops) {
    const r = applyOp(g, op, 'user', T);
    if (!r.ok) throw new Error(r.error);
    g = r.graph;
  }
  return g;
}
const agent = (title: string): Op => ({ type: 'addNode', node: { title, kind: 'agent', prompt: `do ${title}` } });
const link = (from: string, to: string): Op => ({ type: 'connect', from, to });
// n1 -> n2 -> n3
const graph = build([agent('a'), agent('b'), agent('c'), link('n1', 'n2'), link('n2', 'n3')]);
const ok = (status: NodeRunState['status'] = 'succeeded'): NodeRunState => ({ status });
const runMeta = (id: string, status: RunMeta['status'], nodes: Record<string, NodeRunState>, extra: Partial<RunMeta> = {}): RunMeta => ({ id, graphId: 'g', status, startedAt: T, snapshot: graph, nodes, ...extra });
const summary = (r: RunMeta): RunSummary => ({ id: r.id, graphId: 'g', status: r.status, startedAt: T });

const stoppedRun = runMeta('r1', 'cancelled', { n1: ok(), n2: ok('cancelled'), n3: ok('cancelled') });
const doneRun = runMeta('r1', 'succeeded', { n1: ok(), n2: ok(), n3: ok() });

function open(run: RunMeta | undefined): void {
  dispatch({ kind: 'server', msg: { type: 'hello', status: { provider: 'claude', ok: true, label: 'Claude Max' }, project: '/p', graphs: [{ id: 'g', name: 'G' }], approvals: [] } });
  dispatch({ kind: 'server', msg: { type: 'graphOpened', changes: [], graph, runs: run ? [summary(run)] : [], variableValues: {} } });
  if (run) dispatch({ kind: 'server', msg: { type: 'run', run, select: true } });
}
const stateOf = (run: RunMeta | undefined, extra: Partial<State> = {}): State => {
  const base = [
    { kind: 'server' as const, msg: { type: 'hello' as const, status: { provider: 'claude' as const, ok: true, label: 'Claude Max' }, project: '/p', graphs: [], approvals: [] } },
    { kind: 'server' as const, msg: { type: 'graphOpened' as const, changes: [], graph, runs: run ? [summary(run)] : [], variableValues: {} } },
  ].reduce(reduce, initialState);
  return { ...base, ...(run && { run }), ...extra };
};

let container: HTMLDivElement;
let root: Root;
async function mount(component: Parameters<typeof createElement>[0]) {
  container = document.createElement('div');
  root = createRoot(container);
  await act(async () => root.render(createElement(component as never)));
}
afterEach(async () => {
  await act(async () => root?.unmount());
  dispatch({ kind: 'closeConfirm' });
  dispatch({ kind: 'selectNode' });
  vi.mocked(send).mockClear();
});
beforeEach(() => vi.mocked(send).mockClear());
const button = (label: string) => [...container.querySelectorAll('button')].find((b) => b.textContent === label) as HTMLButtonElement | undefined;

describe('retryTarget', () => {
  it('is the newest run once it was cancelled, failed, interrupted or stopped by a stop step', () => {
    for (const status of ['cancelled', 'failed', 'interrupted', 'stopped'] as const) {
      expect(retryTarget(stateOf(runMeta('r1', status, {})))?.id).toBe('r1');
    }
  });
  it('is the newest run once a stop step stopped it', () => {
    const stopped = runMeta('r1', 'stopped', { n1: ok(), n2: ok('skipped'), n3: ok('skipped') }, { stoppedBy: 'n3' });
    expect(retryTarget(stateOf(stopped))?.id).toBe('r1');
  });
  it('is also the newest run after a success that left stale steps, and only when the tab holds that run', () => {
    const stale = runMeta('r1', 'succeeded', { n1: ok(), n2: ok(), n3: { status: 'reused', stale: { reason: 'upstream', nodeId: 'n2', runId: 'r1' } } });
    expect(retryTarget(stateOf(stale))?.id).toBe('r1');
    expect(retryTarget(stateOf(undefined, { runs: [summary(stale)] }))).toBeUndefined();
    expect(retryTarget(stateOf(stale, { runs: [summary(runMeta('r2', 'succeeded', {})), summary(stale)] }))).toBeUndefined();
  });
  it('is nothing after a success, while a run is active, or without a run', () => {
    expect(retryTarget(stateOf(doneRun))).toBeUndefined();
    expect(retryTarget(stateOf(runMeta('r1', 'running', {})))).toBeUndefined();
    expect(retryTarget(stateOf(undefined))).toBeUndefined();
  });
});

describe('onlyAvailability', () => {
  it('is enabled when every earlier step has a current result, naming the run it reuses', () => {
    const a = onlyAvailability(stateOf(doneRun), 'n2');
    expect(a).toEqual({ enabled: true, title: 'Run just this step again, reusing run r1 for everything else; steps after it keep their old results, marked stale' });
  });
  it('is disabled with the reason when an earlier step has no current result', () => {
    expect(onlyAvailability(stateOf(stoppedRun), 'n3')).toEqual({ enabled: false, title: 'Run only n3 needs n2 to have a current result: run it first.' });
  });
  it('is disabled without a previous run, or while a run is active', () => {
    expect(onlyAvailability(stateOf(undefined), 'n1')).toEqual({ enabled: false, title: 'Run the graph once first' });
    expect(onlyAvailability(stateOf(runMeta('r1', 'running', {})), 'n1').enabled).toBe(false);
  });
  it("waits for the engine's answer when the newest run isn't the one shown", () => {
    const s = stateOf(doneRun, { runs: [summary(runMeta('r2', 'succeeded', {})), summary(doneRun)] });
    expect(onlyAvailability(s, 'n3').enabled).toBe(true);
  });
});

describe('state', () => {
  it('keeps the mode of a run request', () => {
    const s = stateOf(undefined);
    expect(reduce(s, { kind: 'server', msg: { type: 'openRunDialog', mode: 'resume', sourceRunId: 'r1' } }).confirm).toEqual({ mode: 'resume', sourceRunId: 'r1' });
    expect(reduce(s, { kind: 'server', msg: { type: 'confirmRun', graphId: 'g', mode: 'only', fromNodeId: 'n2', sourceRunId: 'r1', requestedBy: 'planner' } }).confirm).toEqual({
      mode: 'only',
      fromNodeId: 'n2',
      sourceRunId: 'r1',
      requestedBy: 'planner',
    });
  });
});

describe('menus', () => {
  const runMenu = (s: State) => Object.fromEntries(buildMenus(s).find((m) => m.id === 'run')!.items.filter((i): i is MenuAction => !('separator' in i)).map((i) => [i.label, i]));
  it('lists the retry items beside Re-run from selected step…', () => {
    const labels = Object.keys(runMenu(stateOf(stoppedRun)));
    const at = labels.indexOf('Re-run from selected step…');
    expect(labels.slice(at - 1, at + 2)).toEqual(['Retry from where it stopped', 'Re-run from selected step…', 'Run only selected step…']);
  });
  it('enables Retry from where it stopped after a stopped run only', () => {
    expect(runMenu(stateOf(stoppedRun))['Retry from where it stopped'].enabled).toBe(true);
    expect(runMenu(stateOf(doneRun))['Retry from where it stopped'].enabled).toBe(false);
    expect(runMenu(stateOf(undefined))['Retry from where it stopped'].enabled).toBe(false);
  });
  it('enables Run only selected step… by selection and the ancestor rule', () => {
    expect(runMenu(stateOf(doneRun))['Run only selected step…'].enabled).toBe(false);
    expect(runMenu(stateOf(doneRun, { selectedNodeId: 'n2' }))['Run only selected step…'].enabled).toBe(true);
    expect(runMenu(stateOf(stoppedRun, { selectedNodeId: 'n3' }))['Run only selected step…'].enabled).toBe(false);
  });
  it('opens the confirm dialog with the mode', async () => {
    open(stoppedRun);
    runMenu(getState())['Retry from where it stopped'].run();
    expect(getState().confirm).toEqual({ mode: 'resume', sourceRunId: 'r1' });
    dispatch({ kind: 'closeConfirm' });
    open(doneRun);
    dispatch({ kind: 'selectNode', id: 'n2' });
    runMenu(getState())['Run only selected step…'].run();
    expect(getState().confirm).toEqual({ mode: 'only', fromNodeId: 'n2', sourceRunId: 'r1' });
  });
});

describe('TopBar', () => {
  it('offers Retry from where it stopped next to Run after a stopped run, with its tooltip', async () => {
    open(stoppedRun);
    await mount(TopBar);
    const retry = button('↻ Retry from where it stopped')!;
    expect(retry.title).toBe("Run the steps that didn't finish in run r1, and everything after them; reuse the rest");
    expect(retry.nextElementSibling?.textContent).toBe('▶ Run');
    await act(async () => retry.click());
    expect(getState().confirm).toEqual({ mode: 'resume', sourceRunId: 'r1' });
  });

  it('offers it with its own tooltip after a success that left stale steps', async () => {
    open(runMeta('r1', 'succeeded', { n1: ok(), n2: ok(), n3: { status: 'reused', stale: { reason: 'upstream', nodeId: 'n2', runId: 'r1' } } }));
    await mount(TopBar);
    expect(button('↻ Retry from where it stopped')!.title).toBe('Refresh the stale steps in run r1, and everything after them; reuse the rest');
  });

  it('does not offer it after a success or while a run is active', async () => {
    open(doneRun);
    await mount(TopBar);
    expect(button('↻ Retry from where it stopped')).toBeUndefined();
    await act(async () => root.unmount());
    open(runMeta('r2', 'running', { n1: ok('running') }));
    await mount(TopBar);
    expect(button('↻ Retry from where it stopped')).toBeUndefined();
  });
});

describe('NodePanel', () => {
  it('has Run only this step beside Re-run from here, with the tooltip', async () => {
    open(doneRun);
    dispatch({ kind: 'selectNode', id: 'n2' });
    await mount(NodePanel);
    const only = button('Run only this step')!;
    expect(only.disabled).toBe(false);
    expect(only.title).toBe('Run just this step again, reusing run r1 for everything else; steps after it keep their old results, marked stale');
    expect(only.previousElementSibling?.textContent).toBe('Re-run from here');
    await act(async () => only.click());
    expect(getState().confirm).toEqual({ mode: 'only', fromNodeId: 'n2', sourceRunId: 'r1' });
  });

  it("is disabled with the engine's reason, or with no previous run", async () => {
    open(stoppedRun);
    dispatch({ kind: 'selectNode', id: 'n3' });
    await mount(NodePanel);
    expect(button('Run only this step')!.disabled).toBe(true);
    expect(button('Run only this step')!.title).toBe('Run only n3 needs n2 to have a current result: run it first.');
    await act(async () => root.unmount());
    open(undefined);
    dispatch({ kind: 'server', msg: { type: 'graphOpened', changes: [], graph, runs: [], variableValues: {} } });
    dispatch({ kind: 'selectNode', id: 'n1' });
    await mount(NodePanel);
    expect(button('Run only this step')!.disabled).toBe(true);
    expect(button('Run only this step')!.title).toBe('Run the graph once first');
  });

  it('makes Re-run from here a re-run from the step', async () => {
    open(doneRun);
    dispatch({ kind: 'selectNode', id: 'n2' });
    await mount(NodePanel);
    await act(async () => button('Re-run from here')!.click());
    expect(getState().confirm).toEqual({ mode: 'from', fromNodeId: 'n2', sourceRunId: 'r1' });
  });
});

describe('RunConfirmDialog', () => {
  const preview = (patch: Partial<RunPreview> = {}): RunPreview => ({
    graphId: 'g',
    sourceRunId: 'r1',
    problems: [],
    warnings: [],
    variables: [],
    signature: 'sig',
    steps: [
      { id: 'n1', title: 'a', kind: 'agent', text: 'do a', reused: true },
      { id: 'n2', title: 'b', kind: 'agent', text: 'do b', reused: false },
      { id: 'n3', title: 'c', kind: 'agent', text: 'do c', reused: true, stale: true },
      { id: 'n4', title: 'd', kind: 'agent', text: 'do d', reused: false, notRun: true },
    ],
    ...patch,
  });
  const requestId = () => (vi.mocked(send).mock.calls.filter(([m]) => m.type === 'previewRun').at(-1)![0] as { requestId?: string }).requestId;

  it('titles a retry "Retry run <id>" and asks for a preview with the mode', async () => {
    open(stoppedRun);
    await mount(RunConfirmDialog);
    await act(async () => dispatch({ kind: 'openConfirm', request: { mode: 'resume', sourceRunId: 'r1' } }));
    expect(container.querySelector('h2')?.textContent).toBe('Retry run r1');
    expect(send).toHaveBeenCalledWith({ type: 'previewRun', graphId: 'g', mode: 'resume', fromNodeId: undefined, sourceRunId: 'r1', requestId: expect.any(String) });
  });

  it('titles Run only "Run only <step>", lists the kept stale steps, and starts with the mode', async () => {
    open(doneRun);
    await mount(RunConfirmDialog);
    await act(async () => dispatch({ kind: 'openConfirm', request: { mode: 'only', fromNodeId: 'n2', sourceRunId: 'r1' } }));
    expect(container.querySelector('h2')?.textContent).toBe('Run only n2');
    await act(async () => dispatch({ kind: 'server', msg: { type: 'runPreview', preview: preview({ mode: 'only', fromNodeId: 'n2' }), requestId: requestId() } }));
    const text = container.textContent ?? '';
    expect(text).toContain('Reused from run r1: n1');
    expect(text).not.toContain('Reused from run r1: n1, n3');
    expect(text).toContain('Kept, marked stale: n3');
    expect(text).toContain('Not run: n4');
    await act(async () => button('Start run')!.click());
    expect(send).toHaveBeenLastCalledWith({ type: 'startRun', graphId: 'g', reviewed: 'sig', mode: 'only', fromNodeId: 'n2', sourceRunId: 'r1' });
  });

  it('keeps Re-run from <step> for a re-run, and names a planner-requested mode under the heading', async () => {
    open(doneRun);
    await mount(RunConfirmDialog);
    await act(async () => dispatch({ kind: 'openConfirm', request: { mode: 'from', fromNodeId: 'n2', sourceRunId: 'r1' } }));
    expect(container.querySelector('h2')?.textContent).toBe('Re-run from n2');
    await act(async () => dispatch({ kind: 'openConfirm', request: { mode: 'resume', sourceRunId: 'r1', requestedBy: 'planner' } }));
    const h2 = container.querySelector('h2')!;
    expect(h2.textContent).toBe('The planner asks to run this graph');
    expect(h2.nextElementSibling?.textContent).toBe('Retry run r1');
  });
});

describe('stale marks', () => {
  it('says why a kept result is stale in the step logs', async () => {
    const run = runMeta('r2', 'succeeded', { n1: ok('reused'), n2: ok(), n3: { status: 'reused', stale: { reason: 'upstream', nodeId: 'n2', runId: 'r2' } } }, { sourceRunId: 'r1' });
    open(run);
    dispatch({ kind: 'selectNode', id: 'n3' });
    await mount(LogsPanel);
    expect(container.textContent).toContain('Stale: built on an older result of n2');
    await act(async () => root.unmount());
    // A step built on an edited step says so; only the edited step itself was edited.
    open(runMeta('r2', 'succeeded', { n1: ok('reused'), n2: { status: 'reused', stale: { reason: 'edited', nodeId: 'n3', runId: 'r2' } }, n3: { status: 'reused', stale: { reason: 'edited', nodeId: 'n3', runId: 'r2' } } }, { sourceRunId: 'r1' }));
    dispatch({ kind: 'selectNode', id: 'n2' });
    await mount(LogsPanel);
    expect(container.textContent).toContain('Stale: built on an older result of n3');
    await act(async () => root.unmount());
    dispatch({ kind: 'selectNode', id: 'n3' });
    await mount(LogsPanel);
    expect(container.textContent).toContain('Stale: edited since this result');
    await act(async () => root.unmount());
    open(run);
    dispatch({ kind: 'selectNode', id: 'n1' });
    await mount(LogsPanel);
    expect(container.textContent).not.toContain('Stale:');
    await act(async () => root.unmount());
    open(runMeta('r2', 'succeeded', { n1: ok('reused'), n2: { status: 'reused', stale: { reason: 'edited', nodeId: 'n2', runId: 'r2' } }, n3: ok() }, { sourceRunId: 'r1' }));
    dispatch({ kind: 'selectNode', id: 'n2' });
    await mount(LogsPanel);
    expect(container.textContent).toContain('Stale: edited since this result');
  });

  it('shows a stale badge on the canvas chip', async () => {
    const render = async (state: NodeRunState) => {
      const c = document.createElement('div');
      const r = createRoot(c);
      const props = { id: 'n3', data: { node: graph.nodes[2], state, waiting: false }, selected: false };
      await act(async () => r.render(createElement(ReactFlowProvider, null, createElement(StepNode as never, props))));
      const badge = c.querySelector('.stale-badge') as HTMLElement | null;
      await act(async () => r.unmount());
      return badge;
    };
    const stale = await render({ status: 'reused', stale: { reason: 'upstream', nodeId: 'n2', runId: 'r2' } });
    expect(stale?.textContent).toBe('stale');
    expect(stale?.title).toBe('Stale: built on an older result of n2');
    expect(await render({ status: 'reused' })).toBeNull();
    // The chip is on n3 here: a mark naming another edited step reads as built on it.
    expect((await render({ status: 'reused', stale: { reason: 'edited', nodeId: 'n2', runId: 'r2' } }))?.title).toBe('Stale: built on an older result of n2');
    expect((await render({ status: 'reused', stale: { reason: 'edited', nodeId: 'n3', runId: 'r2' } }))?.title).toBe('Stale: edited since this result');
  });
});
