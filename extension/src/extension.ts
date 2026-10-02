import { homedir } from 'node:os';
import * as vscode from 'vscode';
import { authLabel, type AuthInfo } from '@claude-stream/shared';
import { EngineManager, type EngineEvents } from './engines';
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
  return { engines: manager };
}

export function deactivate(): void {
  engines?.dispose();
  engines = undefined;
}
