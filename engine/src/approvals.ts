import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { ApprovalRequest, Decision, Graph, GraphNode, NodeEventBody } from '@agent-stream/shared';
import { systemClock, type Clock } from './clock';

type Pending = { request: ApprovalRequest; resolve: (decision: Decision) => void };
export type ApprovalInput = Omit<ApprovalRequest, 'id' | 'createdAt'>;
const stepKey = (runId: string, nodeId: string): string => `${runId}\0${nodeId}`;

/** Agent tool calls waiting for the user. Emits 'changed' with the full pending list. */
export class ApprovalBroker extends EventEmitter {
  private pendingById = new Map<string, Pending>();
  /** Steps (run id + step id) the user allowed everything for, until the step ends (Allow all for this step). */
  private allowedSteps = new Set<string>();
  /** The requests the user pressed Allow all on, until their wait logs it: one line per press, not one per request approved. */
  private pressed = new Set<string>();

  constructor(private clock: Clock = systemClock) {
    super();
  }

  request(input: ApprovalInput, signal?: AbortSignal): { id: string; decision: Promise<Decision> } {
    const request: ApprovalRequest = { ...input, id: randomUUID(), createdAt: this.clock() };
    let resolveDecision: (decision: Decision) => void;
    const decision = new Promise<Decision>((resolve) => {
      if (signal?.aborted) {
        resolve({ decision: 'cancelled' });
        return;
      }
      resolveDecision = resolve;
      this.pendingById.set(request.id, { request, resolve });
      signal?.addEventListener('abort', () => this.settle(request.id, { decision: 'cancelled' }), { once: true });
    });
    if (this.pendingById.has(request.id)) {
      try {
        this.emit('changed', this.pending());
      } catch (error) {
        this.pendingById.delete(request.id);
        resolveDecision!({ decision: 'cancelled' });
        throw error;
      }
    }
    return { id: request.id, decision };
  }

  /**
   * `scope: 'step'` (Allow all for this step) approves the request and everything else its step has pending, and allows
   * the step's later requests until endStep. Only an approval does: a denial's scope means nothing.
   */
  decide(id: string, decision: Decision): boolean {
    const p = this.pendingById.get(id);
    if (!p || decision.decision !== 'approve' || decision.scope !== 'step') return this.settle(id, decision);
    const { runId, nodeId } = p.request;
    this.allowedSteps.add(stepKey(runId, nodeId));
    this.pressed.add(id);
    this.settle(id, decision);
    for (const [otherId, other] of [...this.pendingById]) {
      if (other.request.runId === runId && other.request.nodeId === nodeId) this.settle(otherId, { decision: 'approve', scope: 'step' });
    }
    return true;
  }

  /** Whether the user allowed everything for this step of this run, and it has not ended. */
  isStepAllowed(runId: string, nodeId: string): boolean {
    return this.allowedSteps.has(stepKey(runId, nodeId));
  }

  /** The step ended (succeeded, failed, cancelled or stopped): its allowance ends with it. */
  endStep(runId: string, nodeId: string): void {
    this.allowedSteps.delete(stepKey(runId, nodeId));
  }

  /** Whether the user pressed Allow all on this request (once: the caller logs the press). */
  takePress(id: string): boolean {
    return this.pressed.delete(id);
  }

  cancelRun(runId: string): void {
    for (const key of [...this.allowedSteps]) if (key.startsWith(`${runId}\0`)) this.allowedSteps.delete(key);
    for (const [id, p] of [...this.pendingById]) {
      if (p.request.runId === runId) this.settle(id, { decision: 'cancelled' });
    }
  }

  pending(): ApprovalRequest[] {
    return [...this.pendingById.values()].map((p) => p.request);
  }

  private settle(id: string, decision: Decision): boolean {
    const p = this.pendingById.get(id);
    if (!p) return false;
    this.pendingById.delete(id);
    p.resolve(decision);
    try {
      this.emit('changed', this.pending());
    } catch (error) {
      throw error;
    }
    return true;
  }
}

/**
 * One approval request of a step, logged on the step like any other: the request goes to the broker and onto the step's
 * log, the wait ends with the user's decision (or a cancel: Stop, or the signal), and the decision is logged with its
 * note or scope. A request that can't be logged is cancelled and the error thrown. The caller words what a refusal means.
 */
export async function requestApproval(o: {
  broker: ApprovalBroker;
  ctx: { runId: string; graph: Pick<Graph, 'id'>; node: Pick<GraphNode, 'id' | 'title'>; emit: (event: NodeEventBody) => void };
  toolName: string;
  input: unknown;
  /** The card: a graph change or a browser action. */
  card: Pick<ApprovalInput, 'graphChange' | 'browserAction'>;
  signal: AbortSignal;
}): Promise<Decision> {
  const { broker, ctx, toolName, input } = o;
  const logDecision = (approvalId: string, decided: Decision): void =>
    ctx.emit({
      type: 'approval_decided',
      approvalId,
      decision: decided.decision,
      ...(decided.decision === 'deny' && decided.note && { note: decided.note }),
      ...(decided.decision === 'approve' && decided.scope && { scope: decided.scope }),
    });
  // Allow all for this step: every request of the step is approved here, whichever provider or card it comes from. It is
  // still logged as asked and decided, with the step scope, but never reaches the user. A run that was stopped asks no more.
  if (!o.signal.aborted && broker.isStepAllowed(ctx.runId, ctx.node.id)) {
    const approvalId = randomUUID();
    const decided: Decision = { decision: 'approve', scope: 'step' };
    ctx.emit({ type: 'approval_requested', approvalId, toolName, input });
    logDecision(approvalId, decided);
    return decided;
  }
  const { id, decision } = broker.request({ runId: ctx.runId, graphId: ctx.graph.id, nodeId: ctx.node.id, nodeTitle: ctx.node.title, toolName, input, ...o.card }, o.signal);
  try {
    ctx.emit({ type: 'approval_requested', approvalId: id, toolName, input });
  } catch (error) {
    broker.decide(id, { decision: 'cancelled' });
    throw error;
  }
  const decided = await decision;
  if (broker.takePress(id)) ctx.emit({ type: 'approval_allowed_all' });
  logDecision(id, decided);
  return decided;
}
