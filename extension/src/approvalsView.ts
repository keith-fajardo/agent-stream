import * as vscode from 'vscode';
import { approvalSummary, type ApprovalRequest } from '@agent-stream/shared';
import type { Folder, FolderApproval } from './engines';

const TOOLTIP_CHARS = 2000;

export class ApprovalItem extends vscode.TreeItem {
  constructor(
    readonly folder: Folder,
    readonly request: ApprovalRequest,
  ) {
    super(`${request.nodeId} · ${request.nodeTitle}`, vscode.TreeItemCollapsibleState.None);
    this.id = `approval:${request.id}`;
    this.description = approvalSummary(request.toolName, request.input, request.graphChange);
    const full = JSON.stringify(request.input, null, 2) ?? '';
    this.tooltip = full.length > TOOLTIP_CHARS ? `${full.slice(0, TOOLTIP_CHARS)}…` : full;
    this.contextValue = 'approval';
    this.iconPath = new vscode.ThemeIcon('question');
    this.command = { command: 'agentStream.revealApproval', title: 'Show step', arguments: [this] };
  }
}

/** The sidebar's Approvals section: pending requests from every graph (spec §4.1). */
export class ApprovalsView implements vscode.TreeDataProvider<ApprovalItem> {
  private changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(private pending: () => FolderApproval[]) {}

  refresh(): void {
    this.changed.fire();
  }

  getTreeItem(item: ApprovalItem): ApprovalItem {
    return item;
  }

  getChildren(): ApprovalItem[] {
    return [...this.pending()].sort((x, y) => x.request.createdAt.localeCompare(y.request.createdAt)).map((x) => new ApprovalItem(x.folder, x.request));
  }
}

export function approvalsBadge(n: number): { value: number; tooltip: string } | undefined {
  return n ? { value: n, tooltip: `${n} approval${n === 1 ? '' : 's'} waiting` } : undefined;
}
