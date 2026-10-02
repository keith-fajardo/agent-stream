import type {
  ApprovalRequest,
  AuthInfo,
  ChatEntry,
  Graph,
  GraphListItem,
  NodeEvent,
  RunMeta,
  RunPreview,
  RunSummary,
  ServerMessage,
} from '@claude-stream/shared';

export type Tab = 'chat' | 'node' | 'approvals';
export type ConfirmRequest = { fromNodeId?: string; sourceRunId?: string };

export type State = {
  connected: boolean;
  auth?: AuthInfo;
  project?: string;
  graphs: GraphListItem[];
  graph?: Graph;
  runs: RunSummary[];
  /** The run shown on the canvas and in the logs: the latest by default, or one the user picked. */
  run?: RunMeta;
  /** Node logs loaded on demand, keyed by logKey(runId, nodeId). */
  logs: Record<string, NodeEvent[]>;
  approvals: ApprovalRequest[];
  chat: ChatEntry[];
  chatBusy: boolean;
  confirm?: ConfirmRequest;
  variableValues: Record<string, string>;
  preview?: RunPreview;
  selectedNodeId?: string;
  tab: Tab;
  toast?: string;
};

export const initialState: State = { connected: false, graphs: [], runs: [], logs: {}, approvals: [], chat: [], chatBusy: false, variableValues: {}, tab: 'chat' };

export type Action =
  | { kind: 'server'; msg: ServerMessage }
  | { kind: 'disconnected' }
  | { kind: 'selectNode'; id?: string }
  | { kind: 'setTab'; tab: Tab }
  | { kind: 'openConfirm'; request: ConfirmRequest }
  | { kind: 'closeConfirm' }
  | { kind: 'dismissToast' };

export const logKey = (runId: string, nodeId: string) => `${runId}:${nodeId}`;

export { contentSignature } from '@claude-stream/shared';

export function reduce(state: State, action: Action): State {
  switch (action.kind) {
    case 'disconnected':
      return { ...state, connected: false };
    case 'selectNode':
      return { ...state, selectedNodeId: action.id, tab: action.id ? 'node' : state.tab };
    case 'setTab':
      return { ...state, tab: action.tab };
    case 'openConfirm':
      return { ...state, confirm: action.request, preview: undefined };
    case 'closeConfirm':
      return { ...state, confirm: undefined, preview: undefined };
    case 'dismissToast':
      return { ...state, toast: undefined };
    case 'server':
      return reduceServer(state, action.msg);
  }
}

function reduceServer(state: State, msg: ServerMessage): State {
  const current = state.graph?.id;
  switch (msg.type) {
    case 'hello':
      return { ...state, connected: true, auth: msg.auth, project: msg.project, graphs: msg.graphs, approvals: msg.approvals };
    case 'graphs':
      return { ...state, graphs: msg.graphs };
    case 'graphDeleted':
      return msg.graphId === current
        ? { ...state, graph: undefined, run: undefined, runs: [], chat: [], logs: {}, selectedNodeId: undefined, confirm: undefined, preview: undefined, toast: 'This graph was deleted.' }
        : state;
    case 'graphOpened':
      return {
        ...state,
        graph: msg.graph,
        chat: msg.chat,
        chatBusy: msg.chatBusy,
        runs: msg.runs,
        run: msg.run,
        logs: {},
        confirm: undefined,
        variableValues: msg.variableValues,
        preview: undefined,
        selectedNodeId: current === msg.graph.id ? state.selectedNodeId : undefined,
      };
    case 'graph': {
      if (msg.graph.id !== current) return state;
      const stillThere = msg.graph.nodes.some((n) => n.id === state.selectedNodeId);
      return { ...state, graph: msg.graph, selectedNodeId: stillThere ? state.selectedNodeId : undefined };
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
    case 'chatEntry':
      return msg.graphId === current ? { ...state, chat: [...state.chat, msg.entry] } : state;
    case 'chatBusy':
      return msg.graphId === current ? { ...state, chatBusy: msg.busy } : state;
    case 'confirmRun':
      return msg.graphId === current ? { ...state, confirm: { fromNodeId: msg.fromNodeId, sourceRunId: msg.sourceRunId } } : state;
    case 'variableValues':
      return msg.graphId === current ? { ...state, variableValues: msg.values } : state;
    case 'runPreview':
      return state.confirm && msg.preview.graphId === current && msg.preview.fromNodeId === state.confirm.fromNodeId ? { ...state, preview: msg.preview } : state;
    case 'error':
      return { ...state, toast: msg.message };
  }
}
