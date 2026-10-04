import { isWriteCapable, type ModelChoice, type NodeEventBody, type NodeUsage } from '@agent-stream/shared';
import { toLoopTools } from '../../agentLoop/graphLoopTools';
import { clipResult } from '../../agentLoop/tools';
import type { NodeContext, NodeOutcome } from '../../executors';
import { STEP_GRAPH_TOOL_PREFIX, type ToolGate } from '../toolGate';
import { changePrivacyReason, createServerRequestHandler, toPatchChanges, type PatchChange } from './approvals';
import { errorMessage, openCodexForThreads, type CodexConnection, type SpawnCodex } from './connection';
import { codexEffort } from './models';
import { pathPrivacy } from './readOnlyCommand';
import type { DynamicToolContentItem, FileUpdateChange, ThreadItem, ThreadResponse, ThreadStartParams } from './protocol';
import { dynamicToolSpecs, runCodexTurn } from './turn';

/** What the Codex provider shares with its steps and planner turns. */
export type CodexRunDeps = {
  /** The Codex found by the last status check; undefined before one, or when it wasn't found. */
  codexPath: () => string | undefined;
  missing: () => string;
  spawn?: SpawnCodex;
  env?: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  /** The models listed so far, to check an effort against (R9). */
  knownModels: () => ModelChoice[] | undefined;
  warnOnce: (key: string, message: string) => void;
  log: (message: string) => void;
  interruptWaitMs?: number;
};

export const stepPreamble = (cwd: string) => `You are an agent running one step of a workflow in ${cwd}. Do the work, then reply with a summary of what you did.`;

const declinedText = (reason: string | undefined) => (reason ? `declined: ${reason}` : 'declined');
const contentText = (items: DynamicToolContentItem[] | null) => (items ?? []).flatMap((c) => (c.type === 'inputText' ? [c.text] : [])).join('\n');

function commandResult(item: Extract<ThreadItem, { type: 'commandExecution' }>, declined: string | undefined): string {
  if (item.status === 'declined') return declinedText(declined);
  const out = clipResult(item.aggregatedOutput ?? '');
  const end = item.exitCode === null ? item.status : `exit ${item.exitCode}`;
  return out ? `${out}${out.endsWith('\n') ? '' : '\n'}${end}` : end;
}

function patchResult(item: Extract<ThreadItem, { type: 'fileChange' }>, declined: string | undefined): string {
  if (item.status === 'declined') return declinedText(declined);
  if (item.status === 'failed') return 'failed';
  return `changed ${item.changes.map((c) => c.path).join(', ')}`;
}

const SUMMARY_CHARS = 200;
/** Fields that carry what an item produced, which may be a file's content: never in a summary. */
const RESULT_FIELDS = new Set(['id', 'type', 'status', 'result', 'output', 'aggregatedOutput', 'content', 'contentItems']);
/** An item type Agent Stream doesn't know (an MCP tool call, a web search): its other fields, clipped. Never its whole payload or result. */
function itemSummary(item: Record<string, unknown>): string {
  const rest = Object.fromEntries(Object.entries(item).filter(([key]) => !RESULT_FIELDS.has(key)));
  const text = JSON.stringify(rest) ?? '';
  return text.length > SUMMARY_CHARS ? `${text.slice(0, SUMMARY_CHARS)}…` : text;
}

/** An item Codex ran that Agent Stream doesn't know, logged so nothing runs out of the log's sight (RF1): a tool call named after its type, then how it ended. */
function unknownItemEvents(phase: 'started' | 'completed', item: Record<string, unknown>): NodeEventBody[] {
  const id = typeof item.id === 'string' ? item.id : '';
  const type = typeof item.type === 'string' ? item.type : 'unknown';
  if (phase === 'started') return [{ type: 'tool_call', toolUseId: id, name: type, input: { summary: itemSummary(item) } }];
  const status = typeof item.status === 'string' ? item.status : undefined;
  return [{ type: 'tool_result', toolUseId: id, content: status ?? 'done', isError: status === 'failed' || status === 'declined' }];
}

/** A change to a private path is logged by path and kind only: Codex builds its diff from the file's current content. */
const withoutDiff = ({ diff: _diff, ...rest }: PatchChange): Omit<PatchChange, 'diff'> => rest;

/** One item as step log events (spec §4.6): text when an item completes, a tool call when it starts and its result when it completes; an item type it doesn't know too (RF1). */
export function stepItemEvents(phase: 'started' | 'completed', item: ThreadItem, declined: ReadonlyMap<string, string>, isPrivate: (change: FileUpdateChange) => boolean = () => false): NodeEventBody[] {
  switch (item.type) {
    case 'agentMessage':
      return phase === 'completed' && item.text.trim() ? [{ type: 'text', text: item.text }] : [];
    case 'reasoning': {
      const summary = item.summary.join('\n').trim();
      return phase === 'completed' && summary ? [{ type: 'text', text: `Thinking: ${summary}` }] : [];
    }
    case 'commandExecution':
      return phase === 'started'
        ? [{ type: 'tool_call', toolUseId: item.id, name: 'Bash', input: { command: item.command } }]
        : [{ type: 'tool_result', toolUseId: item.id, content: commandResult(item, declined.get(item.id)), isError: item.status !== 'completed' }];
    case 'fileChange':
      return phase === 'started'
        ? [{ type: 'tool_call', toolUseId: item.id, name: 'Patch', input: { changes: toPatchChanges(item.changes).map((p, i) => (isPrivate(item.changes[i]) ? withoutDiff(p) : p)) } }]
        : [{ type: 'tool_result', toolUseId: item.id, content: patchResult(item, declined.get(item.id)), isError: item.status !== 'completed' }];
    case 'dynamicToolCall':
      return phase === 'started'
        ? [{ type: 'tool_call', toolUseId: item.id, name: item.tool, input: item.arguments }]
        : [{ type: 'tool_result', toolUseId: item.id, content: contentText(item.contentItems), isError: item.success === false || item.status === 'failed' }];
    case 'userMessage':
      return [];
    default:
      return unknownItemEvents(phase, item as unknown as Record<string, unknown>);
  }
}

/** One agent step = one ephemeral Codex thread with one turn, every action through the step's gate (spec §4.6). */
export function codexRunStep(deps: CodexRunDeps) {
  return async (ctx: NodeContext, gate: ToolGate): Promise<NodeOutcome> => {
    const codexPath = deps.codexPath();
    if (!codexPath) return { ok: false, output: '', error: deps.missing() };
    ctx.emit({ type: 'start', kind: 'agent', cwd: ctx.cwd, prompt: ctx.prompt });
    const readOnly = !isWriteCapable(ctx.node);
    const tools = readOnly ? [] : toLoopTools(ctx.graphTools ?? [], STEP_GRAPH_TOOL_PREFIX);
    /** Aborted when the step ends or Codex exits: approval cards still open are withdrawn (R18). */
    const ended = new AbortController();
    const fileChanges = new Map<string, FileUpdateChange[]>();
    const declined = new Map<string, string>();
    const privacy = pathPrivacy(gate);
    const isPrivate = (change: FileUpdateChange) => changePrivacyReason(privacy, ctx.cwd, change, deps.platform) !== undefined;
    let conn: CodexConnection | undefined;
    let usage: NodeUsage | undefined;
    const cancelled = (): NodeOutcome => ({ ok: false, output: '', error: 'cancelled', ...(usage && { usage }) });
    try {
      if (ctx.signal.aborted) return cancelled();
      conn = await openCodexForThreads({ codexPath, spawn: deps.spawn, env: deps.env, log: deps.log, cwd: ctx.cwd });
      conn.onExit(() => ended.abort());
      conn.onServerRequest(
        createServerRequestHandler({
          gate,
          cwd: ctx.cwd,
          platform: deps.platform,
          tools: new Map(tools.map((t) => [t.spec.name, t])),
          signal: AbortSignal.any([ctx.signal, ended.signal]),
          fileChanges,
          onDeclined: (itemId, reason) => declined.set(itemId, reason),
          note: (text) => ctx.emit({ type: 'text', text }),
        }),
      );
      const start: ThreadStartParams = {
        cwd: ctx.cwd,
        approvalPolicy: 'untrusted',
        sandbox: readOnly ? 'read-only' : 'workspace-write',
        ephemeral: true,
        developerInstructions: stepPreamble(ctx.cwd),
        ...(ctx.model && { model: ctx.model }),
        ...(tools.length > 0 && { dynamicTools: dynamicToolSpecs(tools) }),
      };
      const thread = await conn.request<ThreadResponse>('thread/start', start, ctx.signal);
      const outcome = await runCodexTurn({
        conn,
        threadId: thread.thread.id,
        text: ctx.prompt,
        effort: codexEffort(ctx, deps.knownModels(), deps.warnOnce),
        signal: ctx.signal,
        onItem: (phase, item) => {
          // Recorded before Codex's approval request for it arrives: notifications are handled in order (R14).
          if (phase === 'started' && item.type === 'fileChange') fileChanges.set(item.id, item.changes);
          for (const e of stepItemEvents(phase, item, declined, isPrivate)) ctx.emit(e);
        },
        onRetry: (text) => ctx.emit({ type: 'text', text }),
        interruptWaitMs: deps.interruptWaitMs,
      });
      usage = outcome.usage;
      if (outcome.status === 'cancelled') return cancelled();
      if (outcome.status === 'completed') return { ok: true, output: outcome.lastText, ...(usage && { usage }) };
      return { ok: false, output: outcome.lastText, error: outcome.error, ...(usage && { usage }) };
    } catch (e) {
      if (ctx.signal.aborted) return cancelled();
      return { ok: false, output: '', error: errorMessage(e) };
    } finally {
      ended.abort();
      conn?.close();
    }
  };
}
