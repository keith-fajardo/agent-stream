import * as vscode from 'vscode';
import { approvalSummary, THEN_PRESSES_ENTER, type ApprovalRequest, type BrowserActionRequest } from '@agent-stream/shared';
import type { Folder, FolderApproval } from './engines';

const TOOLTIP_CHARS = 2000;

/** What the browser card shows, as text and uncut (the typed text is what the user decides on). */
function browserTooltip(b: BrowserActionRequest): string {
  const rows: [string, string | undefined][] = [['Site', b.site || b.url], ['Page', b.title], ['Element', b.element], ['Text', b.text], ['Then', b.submit ? THEN_PRESSES_ENTER : undefined], ['Option', b.option], ['Key', b.key]];
  return rows.filter(([, value]) => value).map(([label, value]) => `${label}: ${value}`).join('\n');
}

export class ApprovalItem extends vscode.TreeItem {
  constructor(
    readonly folder: Folder,
    readonly request: ApprovalRequest,
  ) {
    super(`${request.nodeId} · ${request.nodeTitle}`, vscode.TreeItemCollapsibleState.None);
    this.id = `approval:${request.id}`;
    this.description = approvalSummary(request.toolName, request.input, request.graphChange, request.browserAction);
    const full = JSON.stringify(request.input, null, 2) ?? '';
    // A graph change shows the exact text that would run, uncut; other tools their (capped) input.
    this.tooltip = request.graphChange ? request.graphChange.detail : request.browserAction ? browserTooltip(request.browserAction) : full.length > TOOLTIP_CHARS ? `${full.slice(0, TOOLTIP_CHARS)}…` : full;
    // A graph change or a browser action is approved only on the step's card, where its exact text (and for the browser, the
    // screenshot) shows: the sidebar offers Show and Deny.
    this.contextValue = request.graphChange ? 'graphChange' : request.browserAction ? 'browserApproval' : 'approval';
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
