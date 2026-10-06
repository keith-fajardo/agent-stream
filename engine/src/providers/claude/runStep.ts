import type { Options, SDKMessage, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import type { EffortLevel, ModelChoice, NodeEventBody, NodeUsage } from '@agent-stream/shared';
import type { NodeContext, NodeOutcome } from '../../executors';
import { ATTACHED_IMAGE, PDF_READ_TOOL, readIfThere, readImages, withAttachedFiles } from '../../attachedFiles';
import { READ_ONLY_TOOLS, STEP_GRAPH_TOOL_PREFIX, type ToolGate } from '../toolGate';
import { authSourceError, isSubscriptionAuthSource, projectSettingsProblem, sanitizedEnv, UNVERIFIED_AUTH } from './auth';
import { modelOptions } from './models';
import { blocksOf, graphServer, toolResultText, userMessage, type QueryFn, type UserBlock } from './sdk';
import { toSdkGate } from './sdkGate';

/** The in-process MCP server that serves a step's graph tools: they are `mcp__run_graph__<name>` (STEP_GRAPH_TOOL_PREFIX). */
export const RUN_GRAPH = 'run_graph';

/** What the Claude provider shares with its steps and planner turns. */
export type ClaudeRunDeps = {
  claudePath: () => string | undefined;
  missing: () => string;
  queryFn: QueryFn;
  env?: NodeJS.ProcessEnv;
  /** The models listed so far (undefined until listModels succeeds), to check an effort against. */
  knownModels?: () => ModelChoice[] | undefined;
  /** Logs a problem once per `key`. */
  warnOnce?: (key: string, message: string) => void;
};

/** The SDK's model and effort options for a turn or step, checked against the models listed so far. */
export const sdkModelOptions = (deps: ClaudeRunDeps, choice: { model?: string; effort?: EffortLevel }) =>
  modelOptions(choice, deps.knownModels?.(), deps.warnOnce ?? (() => {}));

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
export function claudeRunStep(deps: ClaudeRunDeps) {
  return async (ctx: NodeContext, toolGate: ToolGate): Promise<NodeOutcome> => {
    const claudePath = deps.claudePath();
    if (!claudePath) return { ok: false, output: '', error: deps.missing() };
    // Re-checked per node: the project's settings can change while VS Code runs.
    const settingsProblem = projectSettingsProblem(ctx.cwd);
    if (settingsProblem) return { ok: false, output: '', error: settingsProblem };
    const chosen = sdkModelOptions(deps, ctx);
    // Its attachments (spec §6b.5): images go in the step's first message; PDFs and text files are read with the read tools.
    const text = withAttachedFiles(ctx.prompt, ctx.attachments, { image: ATTACHED_IMAGE, pdf: PDF_READ_TOOL });
    const images = readImages(ctx.attachments, readIfThere);
    // The model and effort the step actually runs with: an effort the model doesn't offer is already dropped.
    ctx.emit({ type: 'start', kind: 'agent', cwd: ctx.cwd, prompt: text, ...(chosen.model && { model: chosen.model }), ...(chosen.effort && { effort: chosen.effort as EffortLevel }) });
    const abortController = new AbortController();
    const onAbort = () => abortController.abort();
    ctx.signal.addEventListener('abort', onAbort, { once: true });
    if (ctx.signal.aborted) onAbort();
    const gate = toSdkGate(toolGate);
    const options: Options = {
      cwd: ctx.cwd,
      pathToClaudeCodeExecutable: claudePath,
      env: sanitizedEnv(deps.env ?? process.env),
      permissionMode: 'default',
      settingSources: ['project'],
      allowedTools: [...READ_ONLY_TOOLS],
      disallowedTools: ['Agent', 'AskUserQuestion'],
      hooks: gate.hooks,
      canUseTool: gate.canUseTool,
      abortController,
      ...chosen,
    };
    if (ctx.graphTools?.length) {
      // The step's own graph tools: each asks the user with the exact change (the gate lets them through).
      options.mcpServers = { [RUN_GRAPH]: graphServer(RUN_GRAPH, ctx.graphTools) };
      options.allowedTools = [...options.allowedTools!, `${STEP_GRAPH_TOOL_PREFIX}*`];
    }
    try {
      let sawInit = false;
      const blocks: UserBlock[] = [{ type: 'text', text }, ...images.map((i): UserBlock => ({ type: 'image', source: { type: 'base64', media_type: i.mediaType as 'image/png', data: i.data } }))];
      const prompt = images.length ? userMessage(blocks) : text;
      for await (const message of deps.queryFn({ prompt, options })) {
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
