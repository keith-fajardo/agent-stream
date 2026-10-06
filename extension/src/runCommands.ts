import type { ApprovalRequest, HostMessage } from '@agent-stream/shared';
import type { GraphTarget } from './commands';
import type { EngineManager, Folder } from './engines';
import type { GraphPanels } from './graphEditor';

/** What the sidebar and the Command Palette say instead of approving a browser action (it is approved on the step's card). */
const BROWSER_CARD_ONLY = "A browser action is approved on the step's card, where you can see what it will do. Open the graph and use Show.";

type ApprovalTarget = { folder: Folder; request: ApprovalRequest };

export type RunCommandDeps = {
  engines: EngineManager;
  panels: GraphPanels;
  pickGraph(): Promise<GraphTarget | undefined>;
  openAndSend(target: GraphTarget, msg: HostMessage): Promise<void>;
  info(message: string): void;
  showSidebar(): void;
};

/**
 * Approve or deny one request, once: the one place the notification, the sidebar and the commands decide. None of them
 * can allow the rest of a step; that is offered on the approval card only.
 */
export function decideApproval(engines: Pick<RunCommandDeps['engines'], 'get'>, folder: Folder, id: string, decision: 'approve' | 'deny'): boolean {
  return engines.get(folder).broker.decide(id, decision === 'approve' ? { decision: 'approve' } : { decision: 'deny' });
}

/** Run, approval and view commands for the Command Palette, the sidebar and notifications. */
export function runCommands(d: RunCommandDeps) {
  const current = async (target?: GraphTarget): Promise<GraphTarget | undefined> => {
    if (target?.graphId) return target;
    const panel = d.panels.active();
    return panel ? { folder: panel.folder, graphId: panel.graphId } : d.pickGraph();
  };
  const isItem = (item: unknown): item is ApprovalTarget => !!item && typeof item === 'object' && 'folder' in item && 'request' in item;
  const decide = (item: ApprovalTarget, decision: 'approve' | 'deny') => decideApproval(d.engines, item.folder, item.request.id, decision);

  return {
    async runGraph(target?: GraphTarget): Promise<void> {
      const t = await current(target);
      if (t) await d.openAndSend(t, { type: 'openRunDialog' });
    },
    async stopRun(target?: GraphTarget): Promise<void> {
      const t = await current(target);
      if (!t) return;
      const app = d.engines.get(t.folder);
      const run = app.runner.activeFor(t.graphId);
      if (run) app.runner.stop(run.id);
      else d.info('Nothing is running in this graph.');
    },
    async editVariables(target?: GraphTarget): Promise<void> {
      const t = await current(target);
      if (t) await d.openAndSend(t, { type: 'openVariables' });
    },
    approve(item: ApprovalTarget): void {
      if (!isItem(item)) return;
      // A browser action is approved only on the step's card, where its details (the exact text, the screenshot) show.
      if (item.request.browserAction) return d.info(BROWSER_CARD_ONLY);
      decide(item, 'approve');
    },
    deny(item: ApprovalTarget): void {
      if (isItem(item)) decide(item, 'deny');
    },
    /** Approves every request listed now, in every graph; anything arriving later still waits. A graph change always needs its own approval. */
    approveAll(): void {
      for (const item of d.engines.approvals()) if (!item.request.graphChange) decide(item, 'approve');
    },
    async revealApproval(item: ApprovalTarget): Promise<void> {
      if (!isItem(item)) return;
      await d.openAndSend({ folder: item.folder, graphId: item.request.graphId }, { type: 'revealNode', nodeId: item.request.nodeId });
    },
    showSidebar(): void {
      d.showSidebar();
    },
  };
}
