import { MARKDOWN_SAVED } from './toasts';
import type {
  AgentChange,
  ApprovalRequest,
  ChatEntry,
  ChatTarget,
  EffortLevel,
  CheckoutInfo,
  Graph,
  GraphFileError,
  GraphListItem,
  HostMessage,
  LeaseHolder,
  ModelChoice,
  ModelSelection,
  NodeEvent,
  ProviderId,
  ProviderStatus,
  RunMeta,
  RunMode,
  RunPreview,
  RunSummary,
  SubgraphEntry,
} from '@agent-stream/shared';
import { changeKey } from './changeLabels';
import { shownGraph } from './scope';

export type Tab = 'node' | 'graph' | 'changes';
/** Size and collapsed state of the side panel and the logs panel; `logsHeight` null is the stylesheet default. */
export type PanelLayout = { sideWidth: number; sideCollapsed: boolean; logsHeight: number | null; logsCollapsed: boolean };
/** `requestedBy: 'planner'`: the planner's request_run asked for this run. */
export type ConfirmRequest = { mode?: RunMode; fromNodeId?: string; sourceRunId?: string; requestedBy?: 'planner' };
export type StartRequest = { graphId: string; reviewed: string; mode?: RunMode; fromNodeId?: string; sourceRunId?: string };
/** A start the engine refused because another run is changing files in this checkout (spec §7). */
export type Blocked = { message: string; canSetUpTickets: boolean; start?: StartRequest };
/** What the canvas area shows: the graph, or its Markdown file in an editor (the Graph | Markdown toggle). */
export type CanvasMode = 'graph' | 'markdown';
/** The Markdown editor. With no unsaved edits it shows, and follows, the file. */
export type MarkdownEditorState = {
  /** The graph's Markdown file as the engine last sent it; undefined until asked for, and again after the engine says hello. */
  disk?: string;
  /** Unsaved edits; undefined while the editor shows the file. */
  draft?: string;
  /** The file's text when the editing began: the engine refuses a save once the file is no longer this. */
  base?: string;
  /** The file changed since the editing began, or a save was refused for that. */
  conflict: boolean;
  /** A save on its way; `thenGraph`: switch to Graph when it succeeds (Save in the dialog that asks before switching). */
  saving?: { thenGraph: boolean };
  /** Switching to Graph with unsaved edits asks first: Save / Discard / Keep editing. */
  confirmLeave: boolean;
};

export type State = {
  connected: boolean;
  status?: ProviderStatus;
  project?: string;
  graphs: GraphListItem[];
  graph?: Graph;
  /** Problems in the graph's Markdown file: the graph shown is the last good version (Markdown graph files spec §6.3). */
  fileErrors: GraphFileError[];
  /** The graph's Markdown file was deleted (spec §6.5): the tab stays open and shows the graph again when the file returns. */
  graphGone?: boolean;
  /** The user's accepted version of the graph, and what agents changed since (spec §3). */
  baseline?: Graph;
  changes: AgentChange[];
  /** The change picked in the Changes tab, as `node:<id>` or `edge:<id>`. */
  selectedChange?: string;
  /** Where this folder's graphs work and who holds its write lease. */
  checkout?: { info: CheckoutInfo; lease?: LeaseHolder };
  /** The last Start the run dialog sent: Run after it finishes re-sends it. */
  lastStart?: StartRequest;
  blocked?: Blocked;
  /** An Accept all / Revert all waiting for the user's confirmation. */
  changeConfirm?: 'accept' | 'revert';
  runs: RunSummary[];
  /** The run shown on the canvas and in the logs: the latest by default, or one the user picked. */
  run?: RunMeta;
  /** Node logs loaded on demand, keyed by logKey(runId, nodeId). */
  logs: Record<string, NodeEvent[]>;
  approvals: ApprovalRequest[];
  chat: ChatEntry[];
  chatBusy: boolean;
  /** The planner conversation the chat view shows; the extension picks it. */
  chatTarget?: ChatTarget;
  /** The current provider's models, for the chat's and the Node panel's Model menus. */
  models: ModelChoice[];
  /** The provider `models` belongs to. */
  modelsProvider?: ProviderId;
  /** The levels the chat's Default offers: the settings' model's, else Claude Code's default row's. */
  defaultEfforts: EffortLevel[];
  /** The shown conversation's own model and effort choice, as the engine last confirmed it (absent fields: Default). */
  plannerModel: ModelSelection;
  confirm?: ConfirmRequest;
  variableValues: Record<string, string>;
  preview?: RunPreview;
  /** Id of the previewRun request whose reply is the only one the dialog will show. */
  previewRequestId?: string;
  selectedNodeId?: string;
  tab: Tab;
  toast?: string;
  minimap: boolean;
  layout: PanelLayout;
  variablesDialog?: { focus?: string; addRow?: boolean };
  /** Each tab keeps its own (webview state); never saved in the graph or the session. */
  canvasMode: CanvasMode;
  markdown: MarkdownEditorState;
  /** What Edit › Undo would undo in this tab, as the engine names it; undefined: nothing (step model spec §6a.2). */
  undoLabel?: string;
  /** How many edits the engine has refused: the canvas forgets its unconfirmed moves on each. */
  rejections: number;
  /** Every graph the tab's graph reaches through sub-graph steps, or why one can't be used (sub-graphs spec §6.3). */
  subgraphs: Record<string, SubgraphEntry>;
  /** Each inner graph's agent-change review, for editing inside it. */
  subReviews: Record<string, { baseline?: Graph; changes: AgentChange[] }>;
  /** The sub-graph steps the canvas is inside, from the tab's graph down (`['n4', 'n2']`); [] shows the tab's graph. */
  scope: string[];
  /** What Edit › Undo would undo in each inner graph this tab edited (the engine keeps a stack per tab and graph). */
  subUndo: Record<string, string>;
};

function confirmRequest(msg: ConfirmRequest): ConfirmRequest {
  return { ...(msg.mode && { mode: msg.mode }), fromNodeId: msg.fromNodeId, sourceRunId: msg.sourceRunId, ...(msg.requestedBy && { requestedBy: msg.requestedBy }) };
}

const initialMarkdown: MarkdownEditorState = { conflict: false, confirmLeave: false };

export const initialState: State = { subgraphs: {}, subReviews: {}, scope: [], subUndo: {}, rejections: 0, connected: false, graphs: [], fileErrors: [], changes: [], runs: [], logs: {}, approvals: [], chat: [], chatBusy: false, models: [], defaultEfforts: [], plannerModel: {}, variableValues: {}, tab: 'node', minimap: true, canvasMode: 'graph', markdown: initialMarkdown, layout: { sideWidth: 440, sideCollapsed: false, logsHeight: null, logsCollapsed: false } };

export type Action =
  | { kind: 'server'; msg: HostMessage }
  | { kind: 'disconnected' }
  | { kind: 'selectNode'; id?: string }
  | { kind: 'setTab'; tab: Tab }
  | { kind: 'selectChange'; key: string }
  | { kind: 'openChangeConfirm'; mode: 'accept' | 'revert' }
  | { kind: 'closeChangeConfirm' }
  | { kind: 'openConfirm'; request: ConfirmRequest }
  | { kind: 'closeConfirm' }
  | { kind: 'previewRequested'; requestId: string }
  | { kind: 'dismissToast' }
  | { kind: 'setMinimap'; value: boolean }
  | { kind: 'toggleLogs' }
  | { kind: 'toggleSide' }
  | { kind: 'setLayout'; layout: Partial<PanelLayout> }
  | { kind: 'openVariables'; focus?: string; addRow?: boolean }
  | { kind: 'closeVariables' }
  | { kind: 'startRequested'; start: StartRequest }
  | { kind: 'closeBlocked' }
  | { kind: 'setCanvasMode'; mode: CanvasMode }
  /** `from`: the text the editor showed when the edit was typed, the base when a draft starts. */
  | { kind: 'markdownEdited'; text: string; from: string }
  | { kind: 'markdownSaving'; thenGraph: boolean }
  /** Drops the unsaved edits: the editor shows the file again. */
  | { kind: 'markdownReload' }
  | { kind: 'confirmLeaveMarkdown'; open: boolean }
  | { kind: 'showToast'; message: string }
  /** Goes inside sub-graph step `stepId` of the shown graph (double-click, Go inside). */
  | { kind: 'enterScope'; stepId: string }
  /** Climbs to `depth` levels below the tab's graph (0: the tab's graph): the breadcrumb and ↑ Back. */
  | { kind: 'climbScope'; depth: number }
  /** Shows a step by its expanded id (`n4/n2`): goes inside `n4` and selects `n2` (spec §6.1). */
  | { kind: 'reveal'; nodeId: string };

export const logKey = (runId: string, nodeId: string) => `${runId}:${nodeId}`;

export { contentSignature } from '@agent-stream/shared';

const selection = (m: ModelSelection): ModelSelection => ({ ...(m.model && { model: m.model }), ...(m.effort && { effort: m.effort }) });
const sameTarget = (a?: ChatTarget, b?: ChatTarget) => !!a && !!b && a.graphId === b.graphId && a.sessionId === b.sessionId;
const forTarget = (s: State, graphId: string, sessionId: string) => s.chatTarget?.graphId === graphId && s.chatTarget.sessionId === sessionId;

/** The state showing step `nodeId` (an expanded id): inside each sub-graph step on its way, when they all still are ones. */
function revealed(state: State, nodeId: string): State {
  const parts = nodeId.split('/');
  const scope = parts.slice(0, -1);
  const target = shownGraph({ ...state, scope });
  if (!target?.nodes.some((n) => n.id === parts.at(-1))) return state;
  return { ...state, scope, selectedNodeId: parts.at(-1), tab: 'node' };
}

export function reduce(state: State, action: Action): State {
  switch (action.kind) {
    case 'enterScope': {
      const step = shownGraph(state)?.nodes.find((n) => n.id === action.stepId);
      return step?.kind === 'graph' ? { ...state, scope: [...state.scope, action.stepId], selectedNodeId: undefined } : state;
    }
    case 'climbScope':
      return action.depth >= state.scope.length ? state : { ...state, scope: state.scope.slice(0, Math.max(0, action.depth)), selectedNodeId: state.scope[Math.max(0, action.depth)] };
    case 'reveal':
      return revealed(state, action.nodeId);
    case 'disconnected':
      // No answer will come for a save on its way.
      return { ...state, connected: false, markdown: { ...state.markdown, saving: undefined } };
    case 'selectNode':
      return { ...state, selectedNodeId: action.id, tab: action.id ? 'node' : state.tab };
    case 'setTab':
      return { ...state, tab: action.tab, layout: { ...state.layout, sideCollapsed: false } };
    case 'selectChange': {
      // A step that still exists is selected too; a ghost (removed step) has nothing to select.
      const id = action.key.startsWith('node:') ? action.key.slice('node:'.length) : undefined;
      const exists = id !== undefined && !!state.graph?.nodes.some((n) => n.id === id);
      return { ...state, tab: 'changes', layout: { ...state.layout, sideCollapsed: false }, selectedChange: action.key, ...(exists && { selectedNodeId: id }) };
    }
    case 'openChangeConfirm':
      return { ...state, changeConfirm: action.mode };
    case 'closeChangeConfirm':
      return { ...state, changeConfirm: undefined };
    case 'openConfirm':
      return { ...state, confirm: action.request, preview: undefined, previewRequestId: undefined };
    case 'closeConfirm':
      return { ...state, confirm: undefined, preview: undefined, previewRequestId: undefined };
    case 'previewRequested':
      return { ...state, preview: undefined, previewRequestId: action.requestId };
    case 'dismissToast':
      return { ...state, toast: undefined };
    case 'toggleLogs':
      return { ...state, layout: { ...state.layout, logsCollapsed: !state.layout.logsCollapsed } };
    case 'toggleSide':
      return { ...state, layout: { ...state.layout, sideCollapsed: !state.layout.sideCollapsed } };
    case 'setLayout':
      return { ...state, layout: { ...state.layout, ...action.layout } };
    case 'setMinimap':
      return { ...state, minimap: action.value };
    case 'openVariables':
      return { ...state, variablesDialog: { ...(action.focus !== undefined && { focus: action.focus }), ...(action.addRow && { addRow: true }) } };
    case 'closeVariables':
      return { ...state, variablesDialog: undefined };
    case 'startRequested':
      return { ...state, lastStart: action.start };
    case 'closeBlocked':
      return { ...state, blocked: undefined };
    case 'setCanvasMode':
      return { ...state, canvasMode: action.mode, markdown: { ...state.markdown, confirmLeave: false } };
    case 'markdownEdited': {
      const m = state.markdown;
      if (m.disk === undefined && m.draft === undefined) return state;
      // A draft starts from the text the editor showed: a newer file that arrived before the keystroke is a conflict.
      const base = m.draft === undefined ? action.from : m.base;
      const conflict = m.draft === undefined ? m.disk !== undefined && m.disk !== base : m.conflict;
      // Typed back to the file's text: nothing unsaved, so the editor follows the file again.
      if (action.text === base && !conflict) return { ...state, markdown: { ...m, draft: undefined, base: undefined } };
      return { ...state, markdown: { ...m, draft: action.text, base, conflict } };
    }
    case 'markdownSaving':
      return { ...state, markdown: { ...state.markdown, saving: { thenGraph: action.thenGraph }, confirmLeave: false } };
    case 'markdownReload':
      return { ...state, markdown: { ...state.markdown, draft: undefined, base: undefined, conflict: false, confirmLeave: false, saving: undefined } };
    case 'confirmLeaveMarkdown':
      return { ...state, markdown: { ...state.markdown, confirmLeave: action.open } };
    case 'showToast':
      return { ...state, toast: action.message };
    case 'server':
      return reduceServer(state, action.msg);
  }
}

/** What the review state becomes when the changes become `changes`: the Changes tab and a picked change only exist while they do. */
function reviewing(state: State, changes: AgentChange[]): Pick<State, 'tab' | 'selectedChange' | 'changeConfirm'> {
  return {
    tab: changes.length === 0 && state.tab === 'changes' ? 'node' : state.tab,
    selectedChange: changes.some((c) => changeKey(c) === state.selectedChange) ? state.selectedChange : undefined,
    changeConfirm: changes.length === 0 ? undefined : state.changeConfirm,
  };
}

function reduceServer(state: State, msg: HostMessage): State {
  const current = state.graph?.id;
  switch (msg.type) {
    case 'hello':
      // A new engine connection follows no file yet, and won't answer an earlier save: the Markdown editor asks for the file again.
      return { ...state, connected: true, status: msg.status, project: msg.project, graphs: msg.graphs, approvals: msg.approvals, markdown: { ...state.markdown, disk: undefined, saving: undefined } };
    case 'auth':
      return { ...state, status: msg.status };
    case 'graphs':
      return { ...state, graphs: msg.graphs };
    case 'graphDeleted': {
      if (msg.graphId !== current) return state;
      // A deleted file shows a notice that stays (the graph may come back); a deleted graph's tab closes.
      const gone = msg.reason === 'file' ? { graphGone: true } : { toast: 'This graph was deleted.' };
      return { ...state, ...reviewing(state, []), ...gone, graph: undefined, baseline: undefined, changes: [], fileErrors: [], run: undefined, runs: [], logs: {}, selectedNodeId: undefined, confirm: undefined, preview: undefined, previewRequestId: undefined };
    }
    case 'graphFileErrors':
      return msg.graphId === current ? { ...state, fileErrors: msg.errors } : state;
    case 'graphOpened':
      return {
        ...state,
        ...reviewing(state, msg.changes),
        // Another graph's review (a picked change, a pending Accept all) doesn't carry over.
        ...(current !== msg.graph.id && { selectedChange: undefined, changeConfirm: undefined, blocked: undefined, markdown: initialMarkdown, undoLabel: undefined }),
        graph: msg.graph,
        graphGone: false,
        fileErrors: msg.fileErrors ?? [],
        baseline: msg.baseline,
        changes: msg.changes,
        runs: msg.runs,
        run: msg.run,
        logs: {},
        confirm: undefined,
        variableValues: msg.variableValues,
        preview: undefined,
        previewRequestId: undefined,
        selectedNodeId: current === msg.graph.id ? state.selectedNodeId : undefined,
        // The engine sends the inner graphs again right after. The same graph keeps the ones it has until then, so its
        // sub-graph steps don't flash as missing; another graph starts with none, and at its own top.
        ...(current !== msg.graph.id && { subgraphs: {}, subReviews: {} }),
        ...(current !== msg.graph.id && { scope: [], subUndo: {} }),
      };
    case 'subgraphs':
      return msg.graphId === current ? { ...state, subgraphs: msg.graphs, subReviews: msg.reviews } : state;
    case 'graph': {
      if (msg.graph.id !== current) return state;
      // Inside a sub-graph the selected step belongs to the shown (inner) graph, not to the one that changed.
      const stillThere = !!shownGraph({ graph: msg.graph, scope: state.scope, subgraphs: state.subgraphs })?.nodes.some((n) => n.id === state.selectedNodeId);
      return { ...state, ...reviewing(state, msg.changes), graph: msg.graph, baseline: msg.baseline, changes: msg.changes, selectedNodeId: stillThere ? state.selectedNodeId : undefined, preview: undefined };
    }
    case 'graphMarkdown': {
      if (msg.graphId !== current) return state;
      const m = { ...state.markdown, disk: msg.text };
      // A save on its way answers for itself (graphMarkdownSaved): the text it sends now is that save's.
      if (m.draft === undefined || m.saving) return { ...state, markdown: m };
      if (msg.text === m.draft) return { ...state, markdown: { ...m, draft: undefined, base: undefined, conflict: false } };
      // Unsaved edits are never replaced: the editor says the file changed.
      return { ...state, markdown: { ...m, conflict: msg.text !== m.base } };
    }
    case 'graphMarkdownSaved': {
      if (msg.graphId !== current) return state;
      const m = { ...state.markdown, saving: undefined };
      if (msg.conflict) return { ...state, markdown: { ...m, conflict: true } };
      if (msg.error !== undefined) return { ...state, markdown: m, toast: msg.error };
      // Written (with or without errors): the editor shows the file as it is now. Saved without errors: a toast says so (spec §6a.1).
      const markdown = { ...m, disk: msg.text ?? m.disk, draft: undefined, base: undefined, conflict: false };
      return { ...state, markdown, canvasMode: msg.ok && state.markdown.saving?.thenGraph ? 'graph' : state.canvasMode, ...(msg.ok && { toast: MARKDOWN_SAVED }) };
    }
    case 'opRejected':
      // An edit inside a sub-graph is refused under the inner graph's id.
      return msg.graphId === current || Object.hasOwn(state.subgraphs, msg.graphId) ? { ...state, toast: msg.error, rejections: state.rejections + 1 } : state;
    case 'runs':
      return msg.graphId === current ? { ...state, runs: msg.runs } : state;
    case 'run': {
      if (msg.run.graphId !== current) return state;
      const isCurrent = msg.run.id === state.run?.id;
      if (isCurrent || msg.select || msg.run.status === 'running') return { ...state, run: msg.run, logs: isCurrent ? state.logs : {} };
      return state;
    }
    case 'runNode': {
      const run = state.run;
      if (!run || run.id !== msg.runId) return state;
      return { ...state, run: { ...run, nodes: { ...run.nodes, [msg.nodeId]: msg.state } } };
    }
    case 'nodeEvent': {
      const key = logKey(msg.runId, msg.nodeId);
      const existing = state.logs[key];
      return existing ? { ...state, logs: { ...state.logs, [key]: [...existing, msg.event] } } : state;
    }
    case 'nodeLogs':
      return { ...state, logs: { ...state.logs, [logKey(msg.runId, msg.nodeId)]: msg.events } };
    case 'approvals':
      return { ...state, approvals: msg.approvals };
    case 'chatTarget':
      return sameTarget(state.chatTarget, msg.target) ? { ...state, chatTarget: msg.target } : { ...state, chatTarget: msg.target, chat: [], chatBusy: false, plannerModel: {} };
    case 'chatOpened':
      return forTarget(state, msg.graphId, msg.sessionId) ? { ...state, chat: msg.chat, chatBusy: msg.busy, plannerModel: selection(msg) } : state;
    case 'plannerModel':
      return forTarget(state, msg.graphId, msg.sessionId) ? { ...state, plannerModel: selection(msg) } : state;
    case 'models':
      return { ...state, models: msg.models, modelsProvider: msg.provider, defaultEfforts: msg.defaultEfforts ?? [] };
    case 'chatEntry':
      return forTarget(state, msg.graphId, msg.sessionId) ? { ...state, chat: [...state.chat, msg.entry] } : state;
    case 'chatBusy':
      return forTarget(state, msg.graphId, msg.sessionId) ? { ...state, chatBusy: msg.busy } : state;
    case 'sessions':
      return state;
    case 'checkout':
      return { ...state, checkout: { info: msg.info, ...(msg.lease && { lease: msg.lease }) } };
    case 'runBlocked':
      return msg.graphId === current
        ? { ...state, blocked: { message: msg.message, canSetUpTickets: msg.canSetUpTickets, ...(state.lastStart?.graphId === msg.graphId && { start: state.lastStart }) } }
        : state;
    case 'confirmRun':
      return msg.graphId === current ? { ...state, confirm: confirmRequest(msg) } : state;
    case 'variableValues':
      return msg.graphId === current ? { ...state, variableValues: msg.values, preview: undefined } : state;
    case 'runPreview':
      return state.confirm &&
        state.previewRequestId !== undefined &&
        msg.requestId === state.previewRequestId &&
        msg.preview.graphId === current &&
        msg.preview.fromNodeId === state.confirm.fromNodeId
        ? { ...state, preview: msg.preview }
        : state;
    case 'runReport':
      // The extension saves the report itself; a tab has nothing to show.
      return state;
    case 'undoState': {
      if (msg.graphId === current) return { ...state, undoLabel: msg.label };
      // This tab's undo steps inside a sub-graph (spec §6.1): kept per inner graph.
      const { [msg.graphId]: _gone, ...rest } = state.subUndo;
      return { ...state, subUndo: msg.label === undefined ? rest : { ...rest, [msg.graphId]: msg.label } };
    }
    case 'undone':
      return msg.graphId === current || Object.hasOwn(state.subgraphs, msg.graphId) ? { ...state, toast: msg.message } : state;
    case 'attached':
      // The graph's first attachment: the one-time notice (spec §6b.2).
      return msg.graphId === current && msg.notice ? { ...state, toast: msg.notice } : state;
    case 'error':
      // A save the engine or the extension refused before it could answer (a message too large, a throw) is over too.
      return { ...state, toast: msg.message, ...(state.markdown.saving && { markdown: { ...state.markdown, saving: undefined } }) };
    case 'revealNode':
      // An approval inside a sub-graph (`n4/n2`) goes inside n4 and selects n2.
      if (msg.nodeId.includes('/')) return revealed(state, msg.nodeId);
      return state.graph?.nodes.some((n) => n.id === msg.nodeId) ? { ...state, scope: [], selectedNodeId: msg.nodeId, tab: 'node' } : state;
    case 'openRunDialog':
      return { ...state, confirm: confirmRequest(msg), preview: undefined, previewRequestId: undefined };
    case 'openVariables':
      return { ...state, variablesDialog: {} };
    case 'prefs':
      return { ...state, minimap: msg.minimap };
  }
}
