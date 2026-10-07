import * as vscode from 'vscode';
import { isSharedHome, relativeTime, statusLabel, type GraphListItem, type ProviderStatus } from '@agent-stream/shared';
import { isChecking, type Folder } from './engines';

export class FolderItem extends vscode.TreeItem {
  constructor(readonly folder: Folder) {
    super(folder.name, vscode.TreeItemCollapsibleState.Expanded);
    this.id = `folder:${folder.key}`;
    this.contextValue = 'folder';
  }
}

export class SharedItem extends vscode.TreeItem {
  constructor(readonly folder: Folder) {
    super('Shared', vscode.TreeItemCollapsibleState.Expanded);
    this.id = `shared:${folder.key}`;
    this.contextValue = 'shared';
    this.iconPath = new vscode.ThemeIcon('references');
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
      // Its errors are in the Problems panel; the file is where to fix them.
      this.command = { command: 'agentStream.openGraphMarkdown', title: 'Open as Markdown', arguments: [{ folder, graphId: graph.id }] };
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

export type GraphsSource = {
  folders(): Folder[];
  graphs(folder: Folder): GraphListItem[];
  active(folder: Folder): string;
  status(): ProviderStatus;
  now?: () => number;
};

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
    if (parent instanceof SharedItem) return this.graphsIn(parent.folder, now, (h) => isSharedHome(h));
    if (parent instanceof FolderItem) return this.sessionGroups(parent.folder, now);
    if (parent) return [];
    const status = this.source.status();
    const top: vscode.TreeItem[] = status.ok || isChecking(status) ? [] : [new RetryItem()];
    const folders = this.source.folders();
    if (folders.length === 1) return [...top, ...this.sessionGroups(folders[0], now)];
    return [...top, ...folders.map((f) => new FolderItem(f))];
  }

  /** The active session's graphs, then the Shared group when it has any. */
  private sessionGroups(folder: Folder, now: number): vscode.TreeItem[] {
    const active = this.source.active(folder);
    const own = this.graphsIn(folder, now, (h) => h === active);
    const shared = this.source.graphs(folder).some((g) => isSharedHome(g.home ?? ''));
    return shared ? [...own, new SharedItem(folder)] : own;
  }

  private graphsIn(folder: Folder, now: number, match: (home: string) => boolean): vscode.TreeItem[] {
    return this.source
      .graphs(folder)
      .filter((g) => match(g.home ?? ''))
      .map((g) => new GraphItem(folder, g, now));
  }
}
