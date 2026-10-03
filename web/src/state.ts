import type {
  AgentChange,
  ApprovalRequest,
  ChatEntry,
  ChatTarget,
  EffortLevel,
  CheckoutInfo,
  Graph,
  GraphListItem,
  HostMessage,
  LeaseHolder,
  ModelChoice,
  ModelSelection,
  NodeEvent,
  ProviderStatus,
  RunMeta,
  RunPreview,
  RunSummary,
} from '@agent-stream/shared';
import { changeKey } from './changeLabels';

export type Tab = 'node' | 'graph' | 'changes';
/** Size and collapsed state of the side panel and the logs panel; `logsHeight` null is the stylesheet default. */
export type PanelLayout = { sideWidth: number; sideCollapsed: boolean; logsHeight: number | null; logsCollapsed: boolean };
export type ConfirmRequest = { fromNodeId?: string; sourceRunId?: string };
export type StartRequest = { graphId: string; reviewed: string; fromNodeId?: string; sourceRunId?: string };
/** A start the engine refused because another run is changing files in this checkout (spec §7). */
export type Blocked = { message: string; canSetUpTickets: boolean; start?: StartRequest };

export type State = {
  connected: boolean;
  status?: ProviderStatus;
  project?: string;
  graphs: GraphListItem[];
  graph?: Graph;
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
  /** The current provider's models, for the chat's Model menu. */
  models: ModelChoice[];
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
};

export const initialState: State = { connected: false, graphs: [], changes: [], runs: [], logs: {}, approvals: [], chat: [], chatBusy: false, models: [], defaultEfforts: [], plannerModel: {}, variableValues: {}, tab: 'node', minimap: true, layout: { sideWidth: 440, sideCollapsed: false, logsHeight: null, logsCollapsed: false } };

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
  | { kind: 'closeBlocked' };

export const logKey = (runId: string, nodeId: string) => `${runId}:${nodeId}`;

export { contentSignature } from '@agent-stream/shared';

const selection = (m: ModelSelection): ModelSelection => ({ ...(m.model && { model: m.model }), ...(m.effort && { effort: m.effort }) });
const sameTarget = (a?: ChatTarget, b?: ChatTarget) => !!a && !!b && a.graphId === b.graphId && a.sessionId === b.sessionId;
const forTarget = (s: State, graphId: string, sessionId: string) => s.chatTarget?.graphId === graphId && s.chatTarget.sessionId === sessionId;

export function reduce(state: State, action: Action): State {
  switch (action.kind) {
    case 'disconnected':
      return { ...state, connected: false };
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
      return { ...state, connected: true, status: msg.status, project: msg.project, graphs: msg.graphs, approvals: msg.approvals };
    case 'auth':
      return { ...state, status: msg.status };
    case 'graphs':
      return { ...state, graphs: msg.graphs };
    case 'graphDeleted':
      return msg.graphId === current
        ? { ...state, ...reviewing(state, []), graph: undefined, baseline: undefined, changes: [], run: undefined, runs: [], logs: {}, selectedNodeId: undefined, confirm: undefined, preview: undefined, previewRequestId: undefined, toast: 'This graph was deleted.' }
        : state;
    case 'graphOpened':
      return {
        ...state,
        ...reviewing(state, msg.changes),
        // Another graph's review (a picked change, a pending Accept all) doesn't carry over.
        ...(current !== msg.graph.id && { selectedChange: undefined, changeConfirm: undefined, blocked: undefined }),
        graph: msg.graph,
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
      };
    case 'graph': {
      if (msg.graph.id !== current) return state;
      const stillThere = msg.graph.nodes.some((n) => n.id === state.selectedNodeId);
      return { ...state, ...reviewing(state, msg.changes), graph: msg.graph, baseline: msg.baseline, changes: msg.changes, selectedNodeId: stillThere ? state.selectedNodeId : undefined, preview: undefined };
    }
    case 'opRejected':
      return msg.graphId === current ? { ...state, toast: msg.error } : state;
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
      return { ...state, models: msg.models, defaultEfforts: msg.defaultEfforts ?? [] };
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
      return msg.graphId === current ? { ...state, confirm: { fromNodeId: msg.fromNodeId, sourceRunId: msg.sourceRunId } } : state;
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
    case 'error':
      return { ...state, toast: msg.message };
    case 'revealNode':
      return state.graph?.nodes.some((n) => n.id === msg.nodeId) ? { ...state, selectedNodeId: msg.nodeId, tab: 'node' } : state;
    case 'openRunDialog':
      return { ...state, confirm: { fromNodeId: msg.fromNodeId, sourceRunId: msg.sourceRunId }, preview: undefined, previewRequestId: undefined };
    case 'openVariables':
      return { ...state, variablesDialog: {} };
    case 'prefs':
      return { ...state, minimap: msg.minimap };
  }
}
