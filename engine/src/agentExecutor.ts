import type { Options, SDKMessage, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import type { NodeEventBody, NodeUsage } from '@claude-stream/shared';
import type { ApprovalBroker } from './approvals';
import { authSourceError, isSubscriptionAuthSource, projectSettingsProblem, sanitizedEnv, UNVERIFIED_AUTH } from './auth';
import type { NodeExecutor, NodeOutcome } from './executors';
import { makeApprovalGate, READ_ONLY_TOOLS } from './gate';
import { blocksOf, realQuery, toolResultText, type QueryFn } from './sdk';

export type AgentExecutorDeps = {
  claudePath: string | (() => string);
  broker: ApprovalBroker;
  queryFn?: QueryFn;
  env?: NodeJS.ProcessEnv;
  /** The variable values file; agents are denied reading it. */
  valuesFile?: string;
};

function usageOf(msg: SDKResultMessage): NodeUsage {
  return {
    inputTokens: msg.usage.input_tokens ?? 0,
    outputTokens: msg.usage.output_tokens ?? 0,
    cacheReadTokens: msg.usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: msg.usage.cache_creation_input_tokens ?? 0,
    costUsd: msg.total_cost_usd ?? 0,
    turns: msg.num_turns ?? 0,
  };
}

/** Turns one SDK message into node log events; `stop` ends the node with that outcome. */
export function translateMessage(msg: SDKMessage, emit: (event: NodeEventBody) => void): { stop?: NodeOutcome } {
  switch (msg.type) {
    case 'system': {
      const sys = msg as unknown as { subtype?: string; apiKeySource?: string; attempt?: number; max_retries?: number; error?: unknown };
      if (sys.subtype === 'init' && sys.apiKeySource !== undefined && !isSubscriptionAuthSource(sys.apiKeySource)) {
        return { stop: { ok: false, output: '', error: authSourceError(sys.apiKeySource) } };
      }
      if (sys.subtype === 'api_retry') {
        emit({ type: 'retry', attempt: sys.attempt ?? 0, maxRetries: sys.max_retries ?? 0, error: String(sys.error ?? 'unknown') });
      }
      return {};
    }
    case 'assistant': {
      const m = msg as unknown as { parent_tool_use_id?: string | null; message?: unknown };
      if (m.parent_tool_use_id) return {};
      for (const b of blocksOf(m.message)) {
        if (b.type === 'text' && b.text?.trim()) emit({ type: 'text', text: b.text });
        else if (b.type === 'tool_use') emit({ type: 'tool_call', toolUseId: b.id ?? '', name: b.name ?? '', input: b.input });
      }
      return {};
    }
    case 'user': {
      const m = msg as unknown as { parent_tool_use_id?: string | null; message?: unknown };
      if (m.parent_tool_use_id) return {};
      for (const b of blocksOf(m.message)) {
        if (b.type === 'tool_result') {
          emit({ type: 'tool_result', toolUseId: b.tool_use_id ?? '', content: toolResultText(b.content), isError: b.is_error === true });
        }
      }
      return {};
    }
    case 'result': {
      const usage = usageOf(msg);
      if (msg.subtype === 'success') {
        return {
          stop: msg.is_error
            ? { ok: false, output: msg.result, error: msg.result || 'The agent reported an error.', usage }
            : { ok: true, output: msg.result, usage },
        };
      }
      return { stop: { ok: false, output: '', error: msg.errors.join('\n') || msg.subtype, usage } };
    }
    default:
      return {};
  }
}

/** One agent node = one SDK query on the user's Claude subscription (spec §3, §7.3). */
export function createAgentExecutor(deps: AgentExecutorDeps): NodeExecutor {
  const queryFn = deps.queryFn ?? realQuery;
  return async (ctx) => {
    // Re-checked per node: the project's settings can change while the server runs.
    const settingsProblem = projectSettingsProblem(ctx.cwd);
    if (settingsProblem) return { ok: false, output: '', error: settingsProblem };
    ctx.emit({ type: 'start', kind: 'agent', cwd: ctx.cwd, prompt: ctx.prompt });
    const abortController = new AbortController();
    const onAbort = () => abortController.abort();
    ctx.signal.addEventListener('abort', onAbort, { once: true });
    if (ctx.signal.aborted) onAbort();
    const gate = makeApprovalGate({
      broker: deps.broker,
      runId: ctx.runId,
      graphId: ctx.graph.id,
      nodeId: ctx.node.id,
      nodeTitle: ctx.node.title,
      projectDir: ctx.cwd,
      privateFiles: deps.valuesFile ? [deps.valuesFile] : [],
      signal: abortController.signal,
      emit: ctx.emit,
    });
    const options: Options = {
      cwd: ctx.cwd,
      pathToClaudeCodeExecutable: typeof deps.claudePath === 'function' ? deps.claudePath() : deps.claudePath,
      env: sanitizedEnv(deps.env ?? process.env),
      permissionMode: 'default',
      settingSources: ['project'],
      allowedTools: [...READ_ONLY_TOOLS],
      disallowedTools: ['Agent', 'AskUserQuestion'],
      hooks: gate.hooks,
      canUseTool: gate.canUseTool,
      abortController,
    };
    try {
      let sawInit = false;
      for await (const message of queryFn({ prompt: ctx.prompt, options })) {
        if (message.type === 'system' && (message as { subtype?: string }).subtype === 'init') sawInit = true;
        // Fail closed: a result we cannot tie to a checked auth source is not trusted.
        if (message.type === 'result' && !sawInit) return { ok: false, output: '', error: UNVERIFIED_AUTH };
        const step = translateMessage(message, ctx.emit);
        if (step.stop) return step.stop;
      }
      return { ok: false, output: '', error: ctx.signal.aborted ? 'cancelled' : 'The agent session ended without a result.' };
    } catch (e) {
      if (ctx.signal.aborted) return { ok: false, output: '', error: 'cancelled' };
      return { ok: false, output: '', error: e instanceof Error ? e.message : String(e) };
    } finally {
      ctx.signal.removeEventListener('abort', onAbort);
    }
  };
}
