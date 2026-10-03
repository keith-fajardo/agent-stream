import * as vscode from 'vscode';
import { relativeTime, statusLabel, type GraphListItem, type ProviderStatus } from '@agent-stream/shared';
import { isChecking, type Folder } from './engines';

export class FolderItem extends vscode.TreeItem {
  constructor(readonly folder: Folder) {
    super(folder.name, vscode.TreeItemCollapsibleState.Expanded);
    this.id = `folder:${folder.key}`;
    this.contextValue = 'folder';
  }
}

export class GraphItem extends vscode.TreeItem {
  readonly graphId: string;
  constructor(
    readonly folder: Folder,
    graph: GraphListItem,
    now: number,
  ) {
    super(graph.name, vscode.TreeItemCollapsibleState.None);
    this.graphId = graph.id;
    this.id = `graph:${folder.key}|${graph.id}`;
    if (graph.error) {
      this.description = "Can't be read";
      this.tooltip = graph.error;
      this.contextValue = 'graphUnreadable';
      this.iconPath = new vscode.ThemeIcon('warning');
      return;
    }
    const lastRun = graph.lastRun ? `${statusLabel(graph.lastRun.status)} · ${relativeTime(graph.lastRun.startedAt, now)}` : 'Never run';
    const n = graph.agentChanges ?? 0;
    this.description = n > 0 ? `${lastRun} · ${n} agent ${n === 1 ? 'change' : 'changes'}` : lastRun;
    this.contextValue = 'graph';
    this.iconPath = new vscode.ThemeIcon('type-hierarchy');
    this.command = { command: 'agentStream.openGraph', title: 'Open', arguments: [{ folder, graphId: graph.id }] };
  }
}

export class RetryItem extends vscode.TreeItem {
  constructor() {
    super('Check again', vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon('refresh');
    this.contextValue = 'retry';
    this.command = { command: 'agentStream.retrySignIn', title: 'Check again' };
  }
}

export type GraphsSource = { folders(): Folder[]; graphs(folder: Folder): GraphListItem[]; status(): ProviderStatus; now?: () => number };

/** The sidebar's Graphs section (spec §4.1). The engine already sorts graphs newest first, unreadable last. */
export class GraphsView implements vscode.TreeDataProvider<vscode.TreeItem> {
  private changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(private source: GraphsSource) {}

  refresh(): void {
    this.changed.fire();
  }

  getTreeItem(item: vscode.TreeItem): vscode.TreeItem {
    return item;
  }

  getChildren(parent?: vscode.TreeItem): vscode.TreeItem[] {
    const now = this.source.now?.() ?? Date.now();
    if (parent instanceof FolderItem) return this.source.graphs(parent.folder).map((g) => new GraphItem(parent.folder, g, now));
    if (parent) return [];
    const status = this.source.status();
    const top: vscode.TreeItem[] = status.ok || isChecking(status) ? [] : [new RetryItem()];
    const folders = this.source.folders();
    if (folders.length === 1) return [...top, ...this.source.graphs(folders[0]).map((g) => new GraphItem(folders[0], g, now))];
    return [...top, ...folders.map((f) => new FolderItem(f))];
  }
}
