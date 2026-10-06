import { USER_DENIED, type BrowserActionRequest, type Decision } from '@agent-stream/shared';
import { requestApproval, type ApprovalBroker } from '../approvals';
import type { NodeContext } from '../executors';
import { couldNotAsk, denialReason } from '../providers/toolGate';

export type BrowserAskResult = { allow: true; site: boolean } | { allow: false; reason: string };
/** Asks the user about one browser action, with its card (spec §4.2). Never throws. */
export type AskBrowserAction = (o: { toolName: string; input: unknown; action: BrowserActionRequest; signal: AbortSignal }) => Promise<BrowserAskResult>;

/**
 * The browser action card through the step's approval broker (ruling R4), logged on the step like any approval. So Stop
 * cancels it (the broker's cancelRun and the step's signal), the canvas shows the step waiting, and Approve all approves
 * it once. A denial says `The user denied this action.` (with the user's note when there is one).
 */
export function createBrowserAsk(d: { broker: ApprovalBroker; ctx: Pick<NodeContext, 'runId' | 'graph' | 'node' | 'emit' | 'signal'> }): AskBrowserAction {
  const { broker, ctx } = d;
  return async ({ toolName, input, action, signal }) => {
    let decided: Decision;
    try {
      decided = await requestApproval({ broker, ctx, toolName, input, card: { browserAction: action }, signal: AbortSignal.any([ctx.signal, signal]) });
    } catch (error) {
      return { allow: false, reason: couldNotAsk(error) };
    }
    if (decided.decision === 'approve') return { allow: true, site: decided.scope === 'site' };
    if (decided.decision === 'deny') {
      const note = decided.note?.trim();
      return { allow: false, reason: note ? `${USER_DENIED} Their note: ${note}` : USER_DENIED };
    }
    return { allow: false, reason: denialReason(decided, ctx.signal.aborted) };
  };
}
