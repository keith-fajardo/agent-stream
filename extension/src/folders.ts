import * as vscode from 'vscode';
import type { Folder } from './engines';

export function toFolder(f: vscode.WorkspaceFolder): Folder {
  return { key: f.uri.toString(), name: f.name, path: f.uri.fsPath };
}

export function workspaceFolders(): Folder[] {
  return (vscode.workspace.workspaceFolders ?? []).map(toFolder);
}

export function folderFor(uri: vscode.Uri): Folder | undefined {
  const f = vscode.workspace.getWorkspaceFolder(uri);
  return f && toFolder(f);
}

/** Works for remote folders too (SSH, WSL, Dev Containers), unlike Uri.file(path). */
export function folderUri(folder: Folder): vscode.Uri {
  return vscode.Uri.parse(folder.key);
}
