import { approvalSentence, type ApprovalRequest } from '@claude-stream/shared';
import type { Folder, FolderApproval } from './engines';

export type NotifierDeps = {
  pending(): FolderApproval[];
  isVisible(folder: Folder, graphId: string): boolean;
  ask(message: string, ...actions: string[]): Promise<string | undefined>;
  decide(folder: Folder, approvalId: string, decision: 'approve' | 'deny'): void;
  reveal(folder: Folder, request: ApprovalRequest): void;
};

/** A notification for each new approval whose graph tab isn't visible (spec §4.4). */
export class ApprovalNotifier {
  private seen = new Set<string>();

  constructor(private d: NotifierDeps) {}

  update(): void {
    const pending = this.d.pending();
    const ids = new Set(pending.map((p) => p.request.id));
    for (const id of [...this.seen]) if (!ids.has(id)) this.seen.delete(id);
    for (const { folder, request } of pending) {
      if (this.seen.has(request.id)) continue;
      this.seen.add(request.id);
      if (this.d.isVisible(folder, request.graphId)) continue;
      void this.d.ask(approvalSentence(request), 'Approve', 'Deny', 'Show').then((choice) => {
        // Approved or denied elsewhere (the tab, the sidebar) while the notification was up.
        if (!this.d.pending().some((p) => p.request.id === request.id)) return;
        if (choice === 'Approve') this.d.decide(folder, request.id, 'approve');
        else if (choice === 'Deny') this.d.decide(folder, request.id, 'deny');
        else if (choice === 'Show') this.d.reveal(folder, request);
      });
    }
  }
}
