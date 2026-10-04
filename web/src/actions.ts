import { MAX_IMPORT_CHARS, type ApprovalRequest, type ChangeTarget, type HostCommand } from '@agent-stream/shared';
import { post, send, sendHost } from './bridge';
import { layoutPositions, type NodeSize } from './layout';
import { persistLayout } from './panelLayout';
import type { CanvasMode, State, Tab } from './state';
import { dispatch, getState } from './store';

/** Actions that need the canvas viewport; the Canvas registers them while it is mounted. */
type CanvasActions = { addStepInView(): void; measuredSizes(): Map<string, NodeSize> };
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
    for (const [id, position] of layoutPositions(graph, false, canvas?.measuredSizes())) send({ type: 'op', graphId: graph.id, op: { type: 'moveNode', id, position } });
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
    persistLayout();
  },
  /** Shows a change in the Changes tab, which expands a collapsed side panel. */
  selectChange(key: string): void {
    dispatch({ kind: 'selectChange', key });
    persistLayout();
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
    persistLayout();
  },
  toggleSidePanel(): void {
    dispatch({ kind: 'toggleSide' });
    persistLayout();
  },
  showTab(tab: Tab): void {
    dispatch({ kind: 'setTab', tab });
    persistLayout();
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
  /** Asks the planner to split this step into connected steps; the extension runs it in the active session. */
  split(nodeId: string): void {
    post({ type: 'splitStep', nodeId });
  },
  /** Export Run Report: the extension saves the selected run's Markdown report and opens it. */
  exportRunReport(): void {
    const { run } = getState();
    if (run) post({ type: 'exportRunReport', runId: run.id });
  },
  addVariable(): void {
    dispatch({ kind: 'openVariables', addRow: true });
  },
  /** Graph | Markdown. Switching to Graph with unsaved Markdown edits asks first (Save / Discard / Keep editing). */
  showCanvas(mode: CanvasMode): void {
    const s = getState();
    if (mode === s.canvasMode) return;
    if (mode === 'graph' && s.markdown.draft !== undefined) return dispatch({ kind: 'confirmLeaveMarkdown', open: true });
    dispatch({ kind: 'setCanvasMode', mode });
  },
  toggleCanvasMode(): void {
    actions.showCanvas(getState().canvasMode === 'graph' ? 'markdown' : 'graph');
  },
  /**
   * Sends the Markdown editor's unsaved text with the text the editing began from. `force`: Save anyway, over a file that
   * changed since. `thenGraph`: switch to Graph once it saves without errors.
   */
  saveMarkdown(o: { force?: boolean; thenGraph?: boolean } = {}): void {
    const { graph, markdown: m } = getState();
    if (!graph || m.draft === undefined || m.base === undefined || m.saving) return;
    // The engine reads no message this large: refused here, with the reason, rather than left without an answer.
    if (m.draft.length > MAX_IMPORT_CHARS) return dispatch({ kind: 'showToast', message: "This Markdown is larger than 1 MB, so it can't be saved." });
    if (m.base.length > MAX_IMPORT_CHARS) return dispatch({ kind: 'showToast', message: "The file is larger than 1 MB, so it can't be saved from here." });
    send({ type: 'saveGraphMarkdown', graphId: graph.id, text: m.draft, base: m.base, ...(o.force && { force: true }) });
    dispatch({ kind: 'markdownSaving', thenGraph: !!o.thenGraph });
  },
  /** Drops the unsaved Markdown edits: the editor shows the file as it is now. */
  reloadMarkdown(): void {
    dispatch({ kind: 'markdownReload' });
  },
  discardMarkdownAndShowGraph(): void {
    dispatch({ kind: 'markdownReload' });
    dispatch({ kind: 'setCanvasMode', mode: 'graph' });
  },
};
