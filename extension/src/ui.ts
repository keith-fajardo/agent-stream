import * as vscode from 'vscode';
import type { Ui } from './commands';

const filters = { 'Agent Stream graph': ['json'] };
const saveFilters = { graph: filters, markdown: { Markdown: ['md'] } };

export const vscodeUi: Ui = {
  inputBox: async (o) => vscode.window.showInputBox({ prompt: o.prompt, value: o.value, placeHolder: o.placeHolder, validateInput: o.validate }),
  pickGraph: async (items) => (await vscode.window.showQuickPick(items, { placeHolder: 'Open a graph' }))?.target,
  pickFolder: async (folders) => (await vscode.window.showQuickPick(folders.map((folder) => ({ label: folder.name, folder })), { placeHolder: 'Which folder?' }))?.folder,
  confirm: async (message, action, detail) => (await vscode.window.showWarningMessage(message, { modal: true, detail }, action)) === action,
  quickPick: async (items, placeHolder) => (await vscode.window.showQuickPick(items, { placeHolder }))?.value,
  quickPickMany: async (items, placeHolder) => (await vscode.window.showQuickPick(items, { placeHolder, canPickMany: true }))?.map((i) => i.value),
  pickParentFolder: async (defaultPath) =>
    (await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false, defaultUri: vscode.Uri.file(defaultPath), openLabel: 'Put the worktrees here' }))?.[0]?.fsPath,
  openInNewWindow: async (path) => {
    await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(path), { forceNewWindow: true });
  },
  withProgress: (title, task) => Promise.resolve(vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, () => task())),
  infoAction: async (message, action) => (await vscode.window.showInformationMessage(message, action)) === action,
  openFile: async () => {
    const [uri] = (await vscode.window.showOpenDialog({ canSelectMany: false, filters })) ?? [];
    if (!uri) return undefined;
    const stat = await vscode.workspace.fs.stat(uri);
    return { size: stat.size, read: async () => new TextDecoder().decode(await vscode.workspace.fs.readFile(uri)) };
  },
  saveFile: async (defaultPath, kind = 'graph') => {
    const uri = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(defaultPath), filters: saveFilters[kind] });
    return (
      uri && {
        write: async (content: string) => vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(content)),
        open: async () => void (await vscode.window.showTextDocument(uri)),
      }
    );
  },
  info: (message) => void vscode.window.showInformationMessage(message),
  error: (message) => void vscode.window.showErrorMessage(message),
};

/** Opens a link from rendered Markdown in the browser: only http(s) (the webview is not trusted with other schemes). */
export function openExternalUrl(url: string): void {
  if (!/^https?:\/\//.test(url)) return;
  void vscode.env.openExternal(vscode.Uri.parse(url));
}
