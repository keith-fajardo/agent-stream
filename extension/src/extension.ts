import { homedir } from 'node:os';
import * as vscode from 'vscode';
import { PROVIDER_IDS, providerLabel, type HostCommand, type ProviderId, type ProviderStatus } from '@agent-stream/shared';
import { ApprovalsView, approvalsBadge } from './approvalsView';
import { graphCommands } from './commands';
import { EngineManager, isChecking, type EngineEvents, type Folder } from './engines';
import { folderFor, workspaceFolders } from './folders';
import { GRAPH_VIEW_TYPE, GraphEditorProvider, GraphPanels, hostCommandArgs, openAndSend, openGraphTab, type GraphPanel } from './graphEditor';
import { GraphsView } from './graphsView';
import { ApprovalNotifier } from './notifications';
import { runCommands } from './runCommands';
import { selectProvider } from './selectProvider';
import { readSettings } from './settings';
import { statusBarText } from './statusBar';
import { vscodeUi } from './ui';

let engines: EngineManager | undefined;

export async function activate(context: vscode.ExtensionContext) {
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  status.command = 'agentStream.selectProvider';
  context.subscriptions.push(status);
  const showAuth = (providerStatus: ProviderStatus) => {
    const t = statusBarText(providerStatus);
    status.text = t.text;
    status.tooltip = t.tooltip;
    status.show();
  };

  // Views and tabs replace these no-ops as they are wired up below.
  const events: EngineEvents = {
    graphs: () => {},
    approvals: () => {},
    confirmRun: () => {},
    graphDeleted: () => {},
    auth: showAuth,
    warning: (message) => void vscode.window.showWarningMessage(message),
  };
  const manager = new EngineManager({ settings: readSettings, platform: process.platform, env: process.env, home: homedir(), events });
  engines = manager;
  showAuth(manager.status);

  const panels = new GraphPanels();
  const runHostCommand = (command: HostCommand, panel: GraphPanel) =>
    void vscode.commands.executeCommand(`agentStream.${command}`, ...hostCommandArgs(command, panel));
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      GRAPH_VIEW_TYPE,
      new GraphEditorProvider({
        extensionUri: context.extensionUri,
        engines: manager,
        panels,
        folderFor,
        runHostCommand,
        minimap: () => context.globalState.get<boolean>('minimap', true),
        setMinimap: (value) => void context.globalState.update('minimap', value),
      }),
      { webviewOptions: { retainContextWhenHidden: true }, supportsMultipleEditorsPerDocument: false },
    ),
  );
  const graphsView = new GraphsView({ folders: workspaceFolders, graphs: (f) => manager.get(f).listGraphs(), status: () => manager.status });
  const graphsTree = vscode.window.createTreeView('agentStream.graphs', { treeDataProvider: graphsView });
  events.graphs = () => graphsView.refresh();
  events.auth = (next) => {
    showAuth(next);
    graphsTree.message = next.ok || isChecking(next) ? undefined : next.error;
    graphsView.refresh();
  };
  const graph = graphCommands({
    engines: manager,
    folders: workspaceFolders,
    ui: vscodeUi,
    open: (t) => openGraphTab(t.folder, t.graphId),
    activeTarget: () => {
      const p = panels.active();
      return p && { folder: p.folder, graphId: p.graphId };
    },
  });
  for (const [name, run] of Object.entries(graph.commands)) context.subscriptions.push(vscode.commands.registerCommand(`agentStream.${name}`, run));
  context.subscriptions.push(graphsTree, vscode.workspace.onDidChangeWorkspaceFolders(() => graphsView.refresh()));
  const approvalsView = new ApprovalsView(() => manager.approvals());
  const approvalsTree = vscode.window.createTreeView('agentStream.approvals', { treeDataProvider: approvalsView });
  const decideApproval = (folder: Folder, id: string, decision: 'approve' | 'deny') =>
    manager.get(folder).broker.decide(id, decision === 'approve' ? { decision: 'approve' } : { decision: 'deny' });
  const notifier = new ApprovalNotifier({
    pending: () => manager.approvals(),
    isVisible: (folder, graphId) => panels.isVisible(folder.key, graphId),
    ask: async (message, ...actions) => vscode.window.showInformationMessage(message, ...actions),
    decide: decideApproval,
    reveal: (folder, request) => void openAndSend(panels, folder, request.graphId, { type: 'revealNode', nodeId: request.nodeId }),
  });
  events.approvals = () => {
    approvalsView.refresh();
    approvalsTree.badge = approvalsBadge(manager.approvals().length);
    notifier.update();
  };
  const run = runCommands({
    engines: manager,
    panels,
    pickGraph: graph.pickGraph,
    openAndSend: (t, msg) => openAndSend(panels, t.folder, t.graphId, msg),
    info: (message) => void vscode.window.showInformationMessage(message),
    showSidebar: () => void vscode.commands.executeCommand('workbench.view.extension.agentStream'),
  });
  for (const [name, command] of Object.entries(run)) context.subscriptions.push(vscode.commands.registerCommand(`agentStream.${name}`, command));
  context.subscriptions.push(approvalsTree);
  events.confirmRun = (folder, graphId, fromNodeId, sourceRunId) => {
    // An open tab already got confirmRun from the engine; a closed one is opened first.
    if (!panels.get(folder.key, graphId)) void openAndSend(panels, folder, graphId, { type: 'openRunDialog', fromNodeId, sourceRunId });
  };
  events.graphDeleted = (folder, graphId) => {
    const panel = panels.get(folder.key, graphId);
    if (!panel) return;
    panel.view.close();
    void vscode.window.showInformationMessage(`The graph ${graphId} was deleted, so its tab was closed.`);
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('agentStream.retrySignIn', () => manager.checkProvider()),
    vscode.commands.registerCommand('agentStream.selectProvider', () =>
      selectProvider({
        providers: PROVIDER_IDS.map((id) => manager.providerFor(id)),
        current: () => manager.currentProvider().id,
        pick: async (items, placeHolder) => vscode.window.showQuickPick(items, { placeHolder }),
        recheck: () => manager.checkProvider(),
        write: async (id: ProviderId) => {
          const config = vscode.workspace.getConfiguration('agentStream');
          const target = config.inspect<string>('provider')?.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
          await config.update('provider', id, target);
        },
      }),
    ),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('agentStream.provider') || e.affectsConfiguration('agentStream.claudePath')) void manager.checkProvider();
    }),
    vscode.commands.registerCommand('agentStream.signInDetails', async () => {
      const current = manager.status;
      if (current.ok) {
        void vscode.window.showInformationMessage(`Agent Stream runs on ${providerLabel(current)}.`);
        return;
      }
      if ((await vscode.window.showWarningMessage(current.error ?? 'Not signed in.', 'Retry')) === 'Retry') await manager.checkProvider();
    }),
    vscode.workspace.onDidChangeWorkspaceFolders((e) => {
      for (const f of e.removed) manager.remove(f.uri.toString());
    }),
  );

  await manager.checkProvider();
  return { engines: manager, panels };
}

export function deactivate(): void {
  engines?.dispose();
  engines = undefined;
}
