import { homedir } from 'node:os';
import * as vscode from 'vscode';
import { authLabel, type AuthInfo, type HostCommand } from '@claude-stream/shared';
import { EngineManager, type EngineEvents } from './engines';
import { folderFor } from './folders';
import { GRAPH_VIEW_TYPE, GraphEditorProvider, GraphPanels, hostCommandArgs, openAndSend, type GraphPanel } from './graphEditor';
import { readSettings } from './settings';
import { statusBarText } from './statusBar';

let engines: EngineManager | undefined;

export async function activate(context: vscode.ExtensionContext) {
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  status.command = 'claudeStream.signInDetails';
  context.subscriptions.push(status);
  const showAuth = (auth: AuthInfo) => {
    const t = statusBarText(auth);
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
  showAuth(manager.auth);

  const panels = new GraphPanels();
  const runHostCommand = (command: HostCommand, panel: GraphPanel) =>
    void vscode.commands.executeCommand(`claudeStream.${command}`, ...hostCommandArgs(command, panel));
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
    vscode.commands.registerCommand('claudeStream.retrySignIn', () => manager.checkSignIn()),
    vscode.commands.registerCommand('claudeStream.signInDetails', async () => {
      const auth = manager.auth;
      if (auth.ok) {
        void vscode.window.showInformationMessage(`Claude Stream runs on ${authLabel(auth)}.`);
        return;
      }
      if ((await vscode.window.showWarningMessage(auth.error ?? 'Not signed in.', 'Retry')) === 'Retry') await manager.checkSignIn();
    }),
    vscode.workspace.onDidChangeWorkspaceFolders((e) => {
      for (const f of e.removed) manager.remove(f.uri.toString());
    }),
  );

  await manager.checkSignIn();
  return { engines: manager, panels };
}

export function deactivate(): void {
  engines?.dispose();
  engines = undefined;
}
