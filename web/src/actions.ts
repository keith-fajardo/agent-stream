import type { ApprovalRequest, ChangeTarget, HostCommand } from '@agent-stream/shared';
import { post, send, sendHost } from './bridge';
import { layoutPositions } from './layout';
import type { State, Tab } from './state';
import { dispatch, getState } from './store';

/** Actions that need the canvas viewport; the Canvas registers them while it is mounted. */
type CanvasActions = { addStepInView(): void };
let canvas: CanvasActions | undefined;
export function registerCanvas(c: CanvasActions | undefined): void {
  canvas = c;
}

/** This graph's pending approvals: Run › Approve all acts on these only; the sidebar's covers every graph. */
export function graphApprovals(s: State): ApprovalRequest[] {
  const id = s.graph?.id;
  return id ? s.approvals.filter((a) => a.graphId === id) : [];
}

/** What Run › Approve all will approve: this graph's pending requests, except graph changes, which each need their own approval. */
export function approvableApprovals(s: State): ApprovalRequest[] {
  return graphApprovals(s).filter((a) => !a.graphChange);
}

/** One code path per action: the menu bar, toolbar buttons and panels all call these. */
export const actions = {
  addStep(): void {
    canvas?.addStepInView();
  },
  deleteSelectedStep(): void {
    const { graph, selectedNodeId } = getState();
    if (graph && selectedNodeId) send({ type: 'op', graphId: graph.id, op: { type: 'deleteNode', id: selectedNodeId } });
  },
  tidy(): void {
    const { graph } = getState();
    if (!graph) return;
    for (const [id, position] of layoutPositions(graph, false)) send({ type: 'op', graphId: graph.id, op: { type: 'moveNode', id, position } });
  },
  run(): void {
    dispatch({ kind: 'openConfirm', request: {} });
  },
  rerunFromSelected(): void {
    const { selectedNodeId, runs } = getState();
    const latest = runs[0];
    if (selectedNodeId && latest) dispatch({ kind: 'openConfirm', request: { fromNodeId: selectedNodeId, sourceRunId: latest.id } });
  },
  stop(): void {
    const { run } = getState();
    if (run?.status === 'running') send({ type: 'stopRun', runId: run.id });
  },
  approveAll(): void {
    for (const a of approvableApprovals(getState())) send({ type: 'decide', approvalId: a.id, decision: 'approve' });
  },
  reviewChanges(): void {
    dispatch({ kind: 'setTab', tab: 'changes' });
  },
  acceptChange(target: ChangeTarget): void {
    const { graph } = getState();
    if (graph) send({ type: 'op', graphId: graph.id, op: { type: 'acceptChange', target } });
  },
  revertChange(target: ChangeTarget): void {
    const { graph } = getState();
    if (graph) send({ type: 'op', graphId: graph.id, op: { type: 'revertChange', target } });
  },
  /** Accept all / Revert all ask first (the dialog calls acceptChange or revertChange with the `all` target on Confirm). */
  confirmAllChanges(mode: 'accept' | 'revert'): void {
    dispatch({ kind: 'openChangeConfirm', mode });
  },
  toggleMinimap(): void {
    const value = !getState().minimap;
    dispatch({ kind: 'setMinimap', value });
    post({ type: 'setMinimap', value });
  },
  toggleLogs(): void {
    dispatch({ kind: 'toggleLogs' });
  },
  showTab(tab: Tab): void {
    dispatch({ kind: 'setTab', tab });
  },
  host(command: HostCommand): void {
    sendHost(command);
  },
  openVariables(focus?: string): void {
    dispatch({ kind: 'openVariables', focus });
  },
  /** Asks the planner to refine these steps; the extension runs it in the active session. */
  refine(nodeIds: string[]): void {
    post({ type: 'refineSteps', nodeIds });
  },
  addVariable(): void {
    dispatch({ kind: 'openVariables', addRow: true });
  },
};
