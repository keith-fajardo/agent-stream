import { toLoopTools } from '../../agentLoop/graphLoopTools';
import { notIncluded } from '../../chatAttachments';
import type { PlannerTurn, PlannerTurnResult } from '../types';
import { createServerRequestHandler } from './approvals';
import { CodexRpcError, errorMessage, openCodexForThreads, type CodexConnection } from './connection';
import { codexEffort } from './models';
import type { ThreadResponse, ThreadResumeParams, ThreadStartParams } from './protocol';
import type { CodexRunDeps } from './runStep';
import { dynamicToolSpecs, runCodexTurn } from './turn';

export const CODEX_RESUME_FAILED = 'The earlier Codex conversation was not found.';

/**
 * One planner turn (spec §4.7): one persistent Codex thread per planner conversation, whose id is the planner's
 * sessionId. Read-only sandbox, graph tools as dynamic tools, every request through the planner gate, which never asks.
 */
export function codexPlanTurn(deps: CodexRunDeps) {
  return async (turn: PlannerTurn): Promise<PlannerTurnResult> => {
    const codexPath = deps.codexPath();
    if (!codexPath) return { ok: false, error: deps.missing() };
    const tools = toLoopTools(turn.tools, '');
    const graphToolNames = new Set(turn.tools.map((t) => t.name));
    const ended = new AbortController();
    let conn: CodexConnection | undefined;
    let threadId: string | undefined;
    /** Stopped: a conversation that exists is kept, so "continue" works (R24). */
    const stopped = (): PlannerTurnResult => {
      const id = threadId ?? turn.resume;
      return id ? { ok: true, sessionId: id, error: 'cancelled' } : { ok: false, error: 'cancelled' };
    };
    try {
      if (turn.signal.aborted) return stopped();
      conn = await openCodexForThreads({ codexPath, spawn: deps.spawn, env: deps.env, log: deps.log, cwd: turn.cwd });
      conn.onExit(() => ended.abort());
      conn.onServerRequest(
        createServerRequestHandler({
          gate: turn.gate,
          cwd: turn.cwd,
          platform: deps.platform,
          tools: new Map(tools.map((t) => [t.spec.name, t])),
          signal: AbortSignal.any([turn.signal, ended.signal]),
          fileChanges: new Map(),
          onDeclined: () => {},
          note: (text) => deps.log(`[agent-stream] ${text}`),
        }),
      );
      // Sent on resume too, so a resumed thread can't fall back to the user's own Codex settings (R10).
      const settings = {
        cwd: turn.cwd,
        approvalPolicy: 'untrusted',
        sandbox: 'read-only',
        developerInstructions: turn.systemAppend,
        ...(turn.model && { model: turn.model }),
      } satisfies ThreadStartParams;
      if (turn.resume) {
        const resume: ThreadResumeParams = { threadId: turn.resume, ...settings };
        try {
          await conn.request<ThreadResponse>('thread/resume', resume, turn.signal);
        } catch (e) {
          // Codex answered with an error: the thread is gone or refused (R27).
          if (e instanceof CodexRpcError) return { ok: false, error: CODEX_RESUME_FAILED, resumeFailed: true };
          throw e;
        }
        threadId = turn.resume;
      } else {
        const start: ThreadStartParams = { ...settings, ephemeral: false, dynamicTools: dynamicToolSpecs(tools) };
        threadId = (await conn.request<ThreadResponse>('thread/start', start, turn.signal)).thread.id;
      }
      // A chat message's images go with turn/start; Codex reads no PDFs here (step model spec §6b.5).
      const files = turn.files ?? [];
      for (const f of files) if (f.kind === 'pdf') turn.onEvent({ type: 'note', text: notIncluded(f.name, "OpenAI Codex can't read PDFs in the chat") });
      const images = files.filter((f) => f.kind === 'image').map((f) => f.path);
      const outcome = await runCodexTurn({
        conn,
        threadId,
        text: turn.prompt,
        ...(images.length > 0 && { images }),
        effort: codexEffort(turn, deps.knownModels(), deps.warnOnce),
        signal: turn.signal,
        onItem: (phase, item) => {
          if (phase === 'completed' && item.type === 'agentMessage' && item.text.trim()) turn.onEvent({ type: 'text', text: item.text });
          else if (phase === 'started' && item.type === 'dynamicToolCall' && graphToolNames.has(item.tool)) turn.onEvent({ type: 'tool', name: item.tool, input: item.arguments });
        },
        // Not a chat line: it would be saved as the planner's answer (R30).
        onRetry: (text) => deps.log(`[agent-stream] ${text}`),
        interruptWaitMs: deps.interruptWaitMs,
      });
      if (outcome.status === 'cancelled') return stopped();
      return outcome.status === 'completed' ? { ok: true, sessionId: threadId } : { ok: true, sessionId: threadId, error: outcome.error };
    } catch (e) {
      if (turn.signal.aborted) return stopped();
      // The turn started: the conversation is kept and the error shown.
      if (threadId) return { ok: true, sessionId: threadId, error: errorMessage(e) };
      return { ok: false, error: errorMessage(e) };
    } finally {
      ended.abort();
      conn?.close();
    }
  };
}
