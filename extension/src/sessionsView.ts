import * as vscode from 'vscode';
import type { SessionListItem } from '@agent-stream/shared';
import type { Folder } from './engines';
import { FolderItem } from './graphsView';

export class SessionItem extends vscode.TreeItem {
  readonly sessionId: string;
  constructor(
    readonly folder: Folder,
    session: SessionListItem,
    active: boolean,
  ) {
    super(session.name, vscode.TreeItemCollapsibleState.None);
    this.sessionId = session.id;
    this.id = `session:${folder.key}|${session.id}`;
    this.iconPath = new vscode.ThemeIcon(active ? 'check' : 'layers');
    this.contextValue = session.problem ? 'sessionBroken' : 'session';
    if (session.problem) {
      this.description = `Can't be read: ${session.problem}`;
      this.tooltip = session.problem;
      return;
    }
    this.description = `${session.tabCount} ${session.tabCount === 1 ? 'tab' : 'tabs'}`;
    this.command = { command: 'agentStream.switchSession', title: 'Switch Session', arguments: [{ folder, sessionId: session.id }] };
  }
}

export type SessionsSource = { folders(): Folder[]; sessions(folder: Folder): SessionListItem[]; active(folder: Folder): string };

/** The sidebar's Sessions section: one folder's sessions directly, several folders grouped. */
export class SessionsView implements vscode.TreeDataProvider<vscode.TreeItem> {
  private changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(private source: SessionsSource) {}

  refresh(): void {
    this.changed.fire();
  }

  getTreeItem(item: vscode.TreeItem): vscode.TreeItem {
    return item;
  }

  getChildren(parent?: vscode.TreeItem): vscode.TreeItem[] {
    const items = (folder: Folder) => {
      const active = this.source.active(folder);
      return this.source.sessions(folder).map((s) => new SessionItem(folder, s, s.id === active));
    };
    if (parent instanceof FolderItem) return items(parent.folder);
    if (parent) return [];
    const folders = this.source.folders();
    return folders.length === 1 ? items(folders[0]) : folders.map((f) => new FolderItem(f));
  }
}
