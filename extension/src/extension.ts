import { homedir } from 'node:os';
import * as vscode from 'vscode';
import { PROVIDER_IDS, type HostCommand, type ProviderId, type ProviderStatus } from '@agent-stream/shared';
import { ApprovalsView, approvalsBadge } from './approvalsView';
import { ChatViewController, ChatViewProvider, type ChatSource } from './chatView';
import { graphCommands } from './commands';
import { EngineManager, isChecking, type EngineEvents, type Folder } from './engines';
import { folderFor, workspaceFolders } from './folders';
import { GRAPH_VIEW_TYPE, GraphEditorProvider, GraphPanels, graphTarget, graphUri, hostCommandArgs, openAndSend, openGraphTab, type GraphPanel } from './graphEditor';
import { FolderItem, GraphsView } from './graphsView';
import { ApprovalNotifier } from './notifications';
import { runCommands } from './runCommands';
import { selectProvider } from './selectProvider';
import { readSettings } from './settings';
import { SessionManager, sessionStatusFolder, type GraphTabInfo } from './sessions';
import { SessionItem, SessionsView } from './sessionsView';
import { sessionStatusText, signInDetails, statusBarText } from './statusBar';
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
    sessions: () => {},
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
        activeSession: (folder) => sessions.active(folder).id,
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

  // Work sessions: each folder's set of graph tabs (sessions spec §5).
  const sessionStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
  sessionStatus.command = 'agentStream.switchSession';
  context.subscriptions.push(sessionStatus);
  const tabSource = (tab: vscode.Tab): ChatSource | undefined => {
    if (!(tab.input instanceof vscode.TabInputCustom) || tab.input.viewType !== GRAPH_VIEW_TYPE) return undefined;
    const folder = folderFor(tab.input.uri);
    const graphId = folder && graphTarget(folder.path, tab.input.uri.fsPath);
    return folder && graphId ? { folder, graphId } : undefined;
  };
  const graphTabs = (): GraphTabInfo[] => {
    const out: GraphTabInfo[] = [];
    for (const group of vscode.window.tabGroups.all)
      group.tabs.forEach((tab, index) => {
        if (!(tab.input instanceof vscode.TabInputCustom) || tab.input.viewType !== GRAPH_VIEW_TYPE) return;
        const folder = folderFor(tab.input.uri);
        const graphId = folder && graphTarget(folder.path, tab.input.uri.fsPath);
        if (folder && graphId) out.push({ folderKey: folder.key, graphId, group: group.viewColumn, index, active: group.isActive && tab.isActive });
      });
    return out;
  };
  const graphSources = (): ChatSource[] => {
    const out: ChatSource[] = [];
    for (const group of vscode.window.tabGroups.all)
      for (const tab of group.tabs) {
        const source = tabSource(tab);
        if (source) out.push(source);
      }
    return out;
  };
  const activeGraphSource = (): ChatSource | undefined => {
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    return tab && tabSource(tab);
  };
  const chat: ChatViewController = new ChatViewController({
    app: (f) => manager.get(f),
    sessions: { active: (f) => sessions.active(f) },
    confirm: async (message, action) => (await vscode.window.showWarningMessage(message, { modal: true }, action)) === action,
    switchSession: (folder) => void vscode.commands.executeCommand('agentStream.switchSession', { folder }),
    error: (message) => void vscode.window.showErrorMessage(message),
  });
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('agentStream.chat', new ChatViewProvider(context.extensionUri, chat), { webviewOptions: { retainContextWhenHidden: true } }),
    { dispose: () => chat.dispose() },
    vscode.commands.registerCommand('agentStream.focusChat', () => vscode.commands.executeCommand('agentStream.chat.focus')),
  );
  const sessionsView = new SessionsView({
    folders: workspaceFolders,
    sessions: (f) => manager.get(f).listSessions(),
    active: (f) => sessions.active(f).id,
  });
  const sessionsTree = vscode.window.createTreeView('agentStream.sessions', { treeDataProvider: sessionsView });
  const showSession = () => {
    const folder = sessionStatusFolder(panels.active()?.folder, workspaceFolders());
    if (!folder) {
      sessionStatus.hide();
      return;
    }
    const t = sessionStatusText(sessions.active(folder).name);
    sessionStatus.text = t.text;
    sessionStatus.tooltip = t.tooltip;
    sessionStatus.show();
  };
  const sessions: SessionManager = new SessionManager({
    folders: workspaceFolders,
    app: (f) => manager.get(f),
    graphTabs,
    dirtyTabs: (key) => panels.all().filter((p) => p.folder.key === key && p.dirty).length,
    closeGraphTabs: async (key) => {
      const tabs = vscode.window.tabGroups.all.flatMap((g) =>
        g.tabs.filter((tab) => {
          if (!(tab.input instanceof vscode.TabInputCustom) || tab.input.viewType !== GRAPH_VIEW_TYPE) return false;
          return folderFor(tab.input.uri)?.key === key;
        }),
      );
      await vscode.window.tabGroups.close(tabs);
    },
    openGraphTab: async (folder, graphId, group, preserveFocus) => {
      await vscode.commands.executeCommand('vscode.openWith', graphUri(folder, graphId), GRAPH_VIEW_TYPE, { viewColumn: group, preview: false, preserveFocus });
    },
    confirm: async (message, action) => (await vscode.window.showWarningMessage(message, { modal: true }, action)) === action,
    info: (message) => void vscode.window.showInformationMessage(message),
    memory: context.workspaceState,
    hasEngine: (f) => manager.has(f.key),
    changed: () => {
      sessionsView.refresh();
      showSession();
      chat.refresh(graphSources());
    },
  });
  events.sessions = () => {
    sessionsView.refresh();
    showSession();
    chat.refresh(graphSources());
  };
  const baseGraphs = events.graphs;
  events.graphs = (folder, graphs) => {
    baseGraphs(folder, graphs);
    chat.refresh(graphSources());
  };
  const baseDeleted = events.graphDeleted;
  events.graphDeleted = (folder, graphId) => {
    baseDeleted(folder, graphId);
    chat.refresh(graphSources());
  };
  chat.activate(activeGraphSource(), graphSources());
  showSession();

  type SessionArg = { folder?: Folder; sessionId?: string } | undefined;
  const pickFolder = async (arg: SessionArg): Promise<Folder | undefined> => {
    if (arg?.folder) return arg.folder;
    const folders = workspaceFolders();
    const p = panels.active();
    if (p) return p.folder;
    if (folders.length === 1) return folders[0];
    const picked = await vscode.window.showQuickPick(
      folders.map((f) => ({ label: f.name, folder: f })),
      { placeHolder: 'Which folder?' },
    );
    return picked?.folder;
  };
  const pickSession = async (folder: Folder, arg: SessionArg, withNew: boolean): Promise<string | undefined> => {
    if (arg?.sessionId) return arg.sessionId;
    const NEW = '\u0000new';
    const items = manager
      .get(folder)
      .listSessions()
      .filter((s) => !(withNew && s.problem))
      .map((s) => ({ label: s.name, description: s.problem ? `Can't be read: ${s.problem}` : `${s.tabCount} ${s.tabCount === 1 ? 'tab' : 'tabs'}`, id: s.id }));
    if (withNew) items.push({ label: 'New Session…', description: '', id: NEW });
    const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Session' });
    return picked?.id;
  };
  const resolveArg = (a: unknown): SessionArg => (a instanceof SessionItem ? { folder: a.folder, sessionId: a.sessionId } : a instanceof FolderItem ? { folder: a.folder } : (a as SessionArg));
  const nameBox = (value: string | undefined, prompt: string) =>
    vscode.window.showInputBox({ prompt, value, validateInput: (v) => (v.trim() ? undefined : 'A session needs a name.') });
  const newSession = async (folder: Folder) => {
    const name = await nameBox(undefined, 'Session name');
    if (name) await sessions.create(folder, name);
  };
  const withSession = (run: (folder: Folder, sessionId: string, arg: SessionArg) => Promise<void> | void) => async (raw?: unknown) => {
    const arg = resolveArg(raw);
    const folder = await pickFolder(arg);
    if (!folder) return;
    const id = await pickSession(folder, arg, false);
    if (id === undefined) return;
    await run(folder, id, arg);
  };
  const failure = (r: { ok: true } | { ok: false; error: string }) => {
    if (!r.ok) void vscode.window.showErrorMessage(r.error);
  };
  context.subscriptions.push(
    sessionsTree,
    vscode.commands.registerCommand('agentStream.newSession', async (raw?: unknown) => {
      const folder = await pickFolder(resolveArg(raw));
      if (folder) await newSession(folder);
    }),
    vscode.commands.registerCommand('agentStream.switchSession', async (raw?: unknown) => {
      const arg = resolveArg(raw);
      const folder = await pickFolder(arg);
      if (!folder) return;
      const id = await pickSession(folder, arg, true);
      if (id === undefined) return;
      if (id === '\u0000new') await newSession(folder);
      else await sessions.switchTo(folder, id);
    }),
    vscode.commands.registerCommand(
      'agentStream.renameSession',
      withSession(async (folder, id) => {
        const current = manager.get(folder).listSessions().find((s) => s.id === id);
        const name = await nameBox(current?.name, 'New session name');
        if (name) failure(sessions.rename(folder, id, name));
      }),
    ),
    vscode.commands.registerCommand(
      'agentStream.duplicateSession',
      withSession((folder, id) => failure(sessions.duplicate(folder, id))),
    ),
    vscode.commands.registerCommand(
      'agentStream.deleteSession',
      withSession((folder, id) => sessions.delete(folder, id)),
    ),
    vscode.window.tabGroups.onDidChangeTabs(() => {
      sessions.scheduleCapture();
      showSession();
      chat.activate(activeGraphSource(), graphSources());
    }),
    vscode.window.tabGroups.onDidChangeTabGroups(() => {
      sessions.scheduleCapture();
      showSession();
      chat.activate(activeGraphSource(), graphSources());
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      sessionsView.refresh();
      showSession();
    }),
  );

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
    vscode.commands.registerCommand('agentStream.signInDetails', () =>
      signInDetails(manager.status, {
        info: (message) => void vscode.window.showInformationMessage(message),
        warn: (message, action) => vscode.window.showWarningMessage(message, action),
        recheck: () => manager.checkProvider(),
      }),
    ),
    vscode.workspace.onDidChangeWorkspaceFolders((e) => {
      for (const f of e.removed) manager.remove(f.uri.toString());
    }),
  );

  await manager.checkProvider();
  return { engines: manager, panels, sessions };
}

export function deactivate(): void {
  engines?.dispose();
  engines = undefined;
}
