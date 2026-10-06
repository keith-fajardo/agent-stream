import type { HookJSONOutput, Options } from '@anthropic-ai/claude-agent-sdk';
import { CLAUDE_IMAGE_MAX_BASE64, inlineBudget, OVER_BUDGET_IN_CHAT } from '../../attachedFiles';
import { notIncluded, promptWithNotes } from '../../chatAttachments';
import { couldNotAsk } from '../toolGate';
import type { PlannerTurn, PlannerTurnResult } from '../types';
import { authSourceError, isSubscriptionAuthSource, sanitizedEnv, UNVERIFIED_AUTH } from './auth';
import { sdkModelOptions, type ClaudeRunDeps } from './runStep';
import { blocksOf, graphServer, userMessage, type UserBlock } from './sdk';

const GRAPH_PREFIX = 'mcp__graph__';

const deny = (reason: string): HookJSONOutput => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });

/** One planner turn = one resumable SDK query: read-only tools plus the graph tools, never asking the user. */
export function claudePlanTurn(deps: ClaudeRunDeps) {
  return async (turn: PlannerTurn): Promise<PlannerTurnResult> => {
    const claudePath = deps.claudePath();
    if (!claudePath) return { ok: false, error: deps.missing() };
    const abortController = new AbortController();
    const onAbort = () => abortController.abort();
    turn.signal.addEventListener('abort', onAbort, { once: true });
    if (turn.signal.aborted) onAbort();
    const options: Options = {
      cwd: turn.cwd,
      pathToClaudeCodeExecutable: claudePath,
      env: sanitizedEnv(deps.env ?? process.env),
      tools: ['Read', 'Glob', 'Grep'],
      allowedTools: ['Read', 'Glob', 'Grep', `${GRAPH_PREFIX}*`],
      permissionMode: 'dontAsk',
      settingSources: ['project'],
      mcpServers: { graph: graphServer('graph', turn.tools) },
      systemPrompt: { type: 'preset', preset: 'claude_code', append: turn.systemAppend },
      hooks: {
        PreToolUse: [
          {
            hooks: [
              async (input) => {
                if (input.hook_event_name !== 'PreToolUse') return {};
                // Fail closed: a check that throws denies the tool.
                try {
                  const reason = turn.gate.privacy(input.tool_name, input.tool_input);
                  return reason ? deny(reason) : {};
                } catch (error) {
                  return deny(couldNotAsk(error));
                }
              },
            ],
          },
        ],
      },
      abortController,
      ...sdkModelOptions(deps, turn),
    };
    if (turn.resume) options.resume = turn.resume;
    // A chat message's images and PDFs go with it, as images and documents (step model spec §6b.5). The API refuses an image
    // block whose base64 is over 5 MB (3.75 MB of image), so a larger image gets a note in the chat instead; so does a file past the request's inline budget
    // (filled in message order).
    const fileBlocks: UserBlock[] = [];
    const notes: string[] = [];
    const budget = inlineBudget();
    for (const f of turn.files ?? []) {
      const size = Buffer.byteLength(f.data, 'base64');
      if (f.kind === 'image' && f.data.length > CLAUDE_IMAGE_MAX_BASE64) notes.push(notIncluded(f.name, 'it is too large to send (Claude takes images up to 3.75 MB)'));
      else if (!budget.take(size, f.kind === 'image')) notes.push(notIncluded(f.name, OVER_BUDGET_IN_CHAT));
      else if (f.kind === 'pdf') fileBlocks.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: f.data } });
      else fileBlocks.push({ type: 'image', source: { type: 'base64', media_type: f.mediaType as 'image/png', data: f.data } });
    }
    // Said in the chat and in the message itself, so the model doesn't answer as if it had seen the file.
    for (const note of notes) turn.onEvent({ type: 'note', text: note });
    const text = promptWithNotes(turn.prompt, notes);
    const prompt = fileBlocks.length ? userMessage([{ type: 'text', text }, ...fileBlocks]) : text;
    let sessionId: string | undefined;
    let sawInit = false;
    let error: string | undefined;
    try {
      for await (const message of deps.queryFn({ prompt, options })) {
        const m = message as unknown as { type: string; subtype?: string; apiKeySource?: string; session_id?: string; parent_tool_use_id?: string | null; message?: unknown };
        if (m.session_id) sessionId = m.session_id;
        if (m.type === 'system' && m.subtype === 'init') {
          sawInit = true;
          if (m.apiKeySource !== undefined && !isSubscriptionAuthSource(m.apiKeySource)) {
            abortController.abort();
            return { ok: false, error: authSourceError(m.apiKeySource) };
          }
        }
        if (message.type === 'result' && !sawInit) {
          abortController.abort();
          if (message.subtype !== 'success' || message.is_error) {
            // Failed before it started (e.g. resuming a session that no longer exists): no model turn ran.
            const detail = (message.subtype !== 'success' ? message.errors.join('\n') : message.result) || message.subtype;
            return turn.resume ? { ok: false, error: detail, resumeFailed: true } : { ok: false, error: detail };
          }
          return { ok: false, error: UNVERIFIED_AUTH };
        }
        if (message.type === 'assistant' && !m.parent_tool_use_id) {
          for (const b of blocksOf(m.message)) {
            if (b.type === 'text' && b.text?.trim()) turn.onEvent({ type: 'text', text: b.text });
            else if (b.type === 'tool_use' && b.name?.startsWith(GRAPH_PREFIX)) turn.onEvent({ type: 'tool', name: b.name.slice(GRAPH_PREFIX.length), input: b.input });
          }
        }
        if (message.type === 'result') {
          if (message.subtype !== 'success') error = message.errors.join('\n') || message.subtype;
          else if (message.is_error) error = message.result || 'The planner reported an error.';
        }
      }
      return error ? { ok: true, sessionId, error } : { ok: true, sessionId };
    } catch (e) {
      // The user stopped the turn: Claude Code saved what it did, so the session can be resumed with "continue".
      if (turn.signal.aborted) return { ok: true, sessionId, error: 'cancelled' };
      throw e;
    } finally {
      turn.signal.removeEventListener('abort', onAbort);
    }
  };
}
