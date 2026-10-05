import { MAX_IMPORT_CHARS, TIDY_LABEL, type ApprovalRequest, type ChangeTarget, type HostCommand, type Op } from '@agent-stream/shared';
import { post, send, sendHost } from './bridge';
import { layoutPositions, type NodeSize } from './layout';
import { persistLayout } from './panelLayout';
import type { CanvasMode, State, Tab } from './state';
import { dispatch, getState } from './store';
import { cantSaveToast, GRAPH_PANEL_SAVED, GRAPH_SAVED, stepSavedToast } from './toasts';

/** Actions that need the canvas viewport; the Canvas registers them while it is mounted. */
type CanvasActions = { addStepInView(): void; measuredSizes(): Map<string, NodeSize>; flushMoves(): void };
let canvas: CanvasActions | undefined;
export function registerCanvas(c: CanvasActions | undefined): void {
  canvas = c;
}

/** The Node panel's open step and its unsaved edits, for ⌘S (step model spec §6a.1); the panel registers it while it shows a step. */
export type NodeDraft = { nodeId: string; dirty(): boolean; save(): void };
let nodeDraft: NodeDraft | undefined;
/** Registers the open step's draft; the returned function unregisters it (if it is still the one registered). */
export function registerNodeDraft(d: NodeDraft): () => void {
  nodeDraft = d;
  return () => {
    if (nodeDraft === d) nodeDraft = undefined;
  };
}

/** The Graph panel's goal and instructions draft, for ⌘S; the panel registers it while it is mounted (ruling R10a). */
export type GraphDraft = { dirty(): boolean; save(): void };
let graphDraft: GraphDraft | undefined;
export function registerGraphDraft(d: GraphDraft): () => void {
  graphDraft = d;
  return () => {
    if (graphDraft === d) graphDraft = undefined;
  };
}

/** Sends edits that are one user action as one undo step (spec §6a.2); a single edit goes as it is. */
export function sendEdit(graphId: string, ops: Op[], label: string): void {
  if (ops.length === 1) send({ type: 'op', graphId, op: ops[0] });
  else if (ops.length > 1) send({ type: 'ops', graphId, ops, label });
}

export * from './toasts';

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
    const ops: Op[] = [...layoutPositions(graph, false, canvas?.measuredSizes())].map(([id, position]) => ({ type: 'moveNode', id, position }));
    // One undo step for the whole layout, even for a single step.
    if (ops.length) send({ type: 'ops', graphId: graph.id, ops, label: TIDY_LABEL });
  },
  /**
   * File › Save and ⌘S (spec §6a.1). Markdown mode saves the Markdown. Graph mode saves the open step's unsaved edits as
   * its Save button does, or, with none, sends any move not confirmed yet: everything else is saved as it happens.
   */
  save(): void {
    const s = getState();
    if (!s.graph) return;
    if (s.canvasMode === 'markdown') return actions.saveMarkdown();
    // Whichever open panel has unsaved edits (only one is shown at a time) saves them as its own Save button does.
    const open = nodeDraft?.dirty() ? { draft: nodeDraft, toast: stepSavedToast(nodeDraft.nodeId) } : graphDraft?.dirty() ? { draft: graphDraft, toast: GRAPH_PANEL_SAVED } : undefined;
    if (open) {
      // The file has errors: the edit would be refused (R6), so the draft stays as it is.
      if (s.fileErrors.length) return dispatch({ kind: 'showToast', message: cantSaveToast(s.graph.id) });
      open.draft.save();
      return dispatch({ kind: 'showToast', message: open.toast });
    }
    canvas?.flushMoves();
    dispatch({ kind: 'showToast', message: GRAPH_SAVED });
  },
  /** Edit › Undo and ⌘Z: the engine undoes this tab's newest graph edit and answers with a toast. */
  undo(): void {
    const { graph } = getState();
    if (graph) send({ type: 'undo', graphId: graph.id });
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
