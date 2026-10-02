import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { ApprovalRequest, Decision } from '@claude-stream/shared';
import { systemClock, type Clock } from './clock';

type Pending = { request: ApprovalRequest; resolve: (decision: Decision) => void };
export type ApprovalInput = Omit<ApprovalRequest, 'id' | 'createdAt'>;

/** Agent tool calls waiting for the user. Emits 'changed' with the full pending list. */
export class ApprovalBroker extends EventEmitter {
  private pendingById = new Map<string, Pending>();

  constructor(private clock: Clock = systemClock) {
    super();
  }

  request(input: ApprovalInput, signal?: AbortSignal): { id: string; decision: Promise<Decision> } {
    const request: ApprovalRequest = { ...input, id: randomUUID(), createdAt: this.clock() };
    const decision = new Promise<Decision>((resolve) => {
      if (signal?.aborted) {
        resolve({ decision: 'cancelled' });
        return;
      }
      this.pendingById.set(request.id, { request, resolve });
      signal?.addEventListener('abort', () => this.settle(request.id, { decision: 'cancelled' }), { once: true });
    });
    if (this.pendingById.has(request.id)) this.emit('changed', this.pending());
    return { id: request.id, decision };
  }

  decide(id: string, decision: Decision): boolean {
    return this.settle(id, decision);
  }

  cancelRun(runId: string): void {
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
    this.emit('changed', this.pending());
    return true;
  }
}
