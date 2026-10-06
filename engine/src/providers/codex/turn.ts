import { setTimeout as sleep } from 'node:timers/promises';
import type { EffortLevel, NodeUsage } from '@agent-stream/shared';
import type { LoopTool } from '../../agentLoop/tools';
import type { CodexConnection } from './connection';
import type {
  DynamicToolSpec,
  ErrorNotification,
  ItemNotification,
  ThreadItem,
  ThreadTokenUsageUpdatedNotification,
  TokenUsageBreakdown,
  Turn,
  TurnCompletedNotification,
  TurnStartParams,
  TurnStartResponse,
  UserInput,
} from './protocol';

/** How long Stop waits for the turn id, then for turn/completed, before closing anyway (spec §4.6). */
export const INTERRUPT_WAIT_MS = 5000;
export const codexFailure = (message: string) => `Codex failed: ${message}`;

/** The thread's token totals (R11). Codex counts cached input inside inputTokens; Agent Stream counts it apart. No cost is reported. */
export function usageOf(t: TokenUsageBreakdown): NodeUsage {
  return {
    inputTokens: Math.max(0, t.inputTokens - t.cachedInputTokens - t.cacheWriteInputTokens),
    outputTokens: t.outputTokens,
    cacheReadTokens: t.cachedInputTokens,
    cacheWriteTokens: t.cacheWriteInputTokens,
    costUsd: 0,
    turns: 1,
  };
}

/** Loop tools as Codex dynamic tools (spec §4.6, §4.7); zod's `$schema` key is dropped (R17). */
export function dynamicToolSpecs(tools: readonly LoopTool[]): DynamicToolSpec[] {
  return tools.map((t) => {
    const { $schema: _schema, ...inputSchema } = t.spec.inputSchema as Record<string, unknown>;
    return { type: 'function', name: t.spec.name, description: t.spec.description, inputSchema };
  });
}

export type TurnOutcome = { status: 'completed' | 'failed' | 'interrupted' | 'cancelled'; lastText: string; error?: string; usage?: NodeUsage };

export type RunTurnOptions = {
  conn: CodexConnection;
  threadId: string;
  text: string;
  /** Images to send with the text, as files Codex reads (step model spec §6b.5). */
  images?: string[];
  effort?: EffortLevel;
  /** Stop. */
  signal: AbortSignal;
  onItem(phase: 'started' | 'completed', item: ThreadItem): void;
  /** A Codex error it will retry (R12). */
  onRetry?(text: string): void;
  interruptWaitMs?: number;
};

function settleable<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  promise.catch(() => {}); // a rejection nobody waits for (after Stop) is not an error
  return { promise, resolve, reject };
}

/**
 * One turn (spec §4.6, §4.7): sends turn/start, passes items on as they start and complete, and resolves on
 * turn/completed. Stop sends turn/interrupt and waits up to `interruptWaitMs` for the turn to end. Codex exiting
 * rejects with the connection's message.
 */
export async function runCodexTurn(o: RunTurnOptions): Promise<TurnOutcome> {
  // Stopped already: no turn is started that would only be interrupted (M2).
  if (o.signal.aborted) return { status: 'cancelled', lastText: '' };
  const waitMs = o.interruptWaitMs ?? INTERRUPT_WAIT_MS;
  let lastText = '';
  let usage: NodeUsage | undefined;
  let failure: string | undefined;
  const completed = settleable<Turn>();
  const started = settleable<string>();
  o.conn.onNotification((method, params) => {
    const threadId = (params as { threadId?: unknown } | null | undefined)?.threadId;
    if (threadId !== undefined && threadId !== o.threadId) return;
    switch (method) {
      case 'item/started':
        o.onItem('started', (params as ItemNotification).item);
        return;
      case 'item/completed': {
        const { item } = params as ItemNotification;
        if (item.type === 'agentMessage' && item.text.trim()) lastText = item.text;
        o.onItem('completed', item);
        return;
      }
      case 'thread/tokenUsage/updated':
        usage = usageOf((params as ThreadTokenUsageUpdatedNotification).tokenUsage.total);
        return;
      case 'error': {
        const e = params as ErrorNotification;
        if (e.willRetry) o.onRetry?.(`Codex: ${e.error.message} (retrying)`);
        else failure = codexFailure(e.error.message);
        return;
      }
      case 'turn/completed':
        completed.resolve((params as TurnCompletedNotification).turn);
        return;
    }
  });
  o.conn.onExit((message) => {
    const error = new Error(message);
    completed.reject(error);
    started.reject(error);
  });

  const input: UserInput[] = [{ type: 'text', text: o.text, text_elements: [] }, ...(o.images ?? []).map((path): UserInput => ({ type: 'localImage', path }))];
  const params: TurnStartParams = { threadId: o.threadId, input, ...(o.effort && { effort: o.effort }) };
  o.conn.request<TurnStartResponse>('turn/start', params).then(
    (r) => started.resolve(r.turn.id),
    (e: unknown) => started.reject(e),
  );
  const finished = started.promise.then(() => completed.promise);
  finished.catch(() => {});
  let onAbort: (() => void) | undefined;
  const stop = new Promise<'stop'>((resolve) => {
    onAbort = () => resolve('stop');
    if (o.signal.aborted) onAbort();
    else o.signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    const first = await Promise.race([finished, stop]);
    if (first === 'stop') {
      const turnId = await Promise.race([started.promise.catch(() => undefined), sleep(waitMs, undefined, { ref: false })]);
      if (turnId) {
        o.conn.request('turn/interrupt', { threadId: o.threadId, turnId }).catch(() => {});
        await Promise.race([completed.promise.catch(() => undefined), sleep(waitMs, undefined, { ref: false })]);
      }
      return { status: 'cancelled', lastText, ...(usage && { usage }) };
    }
    if (first.status === 'completed' && !failure) return { status: 'completed', lastText, ...(usage && { usage }) };
    const error =
      failure ?? (first.error?.message ? codexFailure(first.error.message) : codexFailure(first.status === 'interrupted' ? 'the turn was interrupted.' : 'the turn failed.'));
    return { status: first.status === 'interrupted' ? 'interrupted' : 'failed', lastText, error, ...(usage && { usage }) };
  } finally {
    if (onAbort) o.signal.removeEventListener('abort', onAbort);
  }
}
