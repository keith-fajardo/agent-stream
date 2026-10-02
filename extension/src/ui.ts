import * as vscode from 'vscode';
import type { Ui } from './commands';

const filters = { 'Claude Stream graph': ['json'] };

export const vscodeUi: Ui = {
  inputBox: async (o) => vscode.window.showInputBox({ prompt: o.prompt, value: o.value, validateInput: o.validate }),
  pickGraph: async (items) => (await vscode.window.showQuickPick(items, { placeHolder: 'Open a graph' }))?.target,
  pickFolder: async (folders) => (await vscode.window.showQuickPick(folders.map((folder) => ({ label: folder.name, folder })), { placeHolder: 'Which folder?' }))?.folder,
  confirm: async (message, action) => (await vscode.window.showWarningMessage(message, { modal: true }, action)) === action,
  openFile: async () => {
    const [uri] = (await vscode.window.showOpenDialog({ canSelectMany: false, filters })) ?? [];
    if (!uri) return undefined;
    const stat = await vscode.workspace.fs.stat(uri);
    return { size: stat.size, read: async () => new TextDecoder().decode(await vscode.workspace.fs.readFile(uri)) };
  },
  saveFile: async (defaultPath) => {
    const uri = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(defaultPath), filters });
    return uri && { write: async (content: string) => vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(content)) };
  },
  info: (message) => void vscode.window.showInformationMessage(message),
  error: (message) => void vscode.window.showErrorMessage(message),
};
