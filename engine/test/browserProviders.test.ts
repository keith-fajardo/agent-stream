import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { HookInput, McpSdkServerConfigWithInstance, Options, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { EARLIER_SCREENSHOT_REMOVED, emptyGraph, NEWEST_SCREENSHOT_NOT_SENT, RUN_STOPPED, SCREENSHOT_TOO_LARGE, type GraphNode, type NodeEventBody } from '@agent-stream/shared';
import type { ChatMessage } from '../src/agentLoop/chatModel';
import { runAgentLoop } from '../src/agentLoop/loop';
import { CLAUDE_IMAGE_MAX_BYTES, inlineBudget } from '../src/attachedFiles';
import { ApprovalBroker } from '../src/approvals';
import { createBrowserAsk } from '../src/browser/approval';
import { browserLoopTools } from '../src/browser/loopTools';
import type { BrowserTool } from '../src/browser/tools';
import type { NodeContext } from '../src/executors';
import { createClaudeProvider } from '../src/providers/claude';
import type { QueryFn } from '../src/providers/claude/sdk';
import type { GraphTool } from '../src/providers/types';
import { codexRunStep, type CodexRunDeps } from '../src/providers/codex/runStep';
import { createStepGate } from '../src/providers/toolGate';
import { toolSetup } from './browserFakes';
import { fakeCodex, mcpConfig, turnHandlers, waitFor, type FakeHandler, type TurnScript } from './codexFake';
import { allowAll, fakeChatModel, signedIn, textPart, toolCallPart, userText } from './helpers';

const JOBS = 'https://jobs.example/';
const SNAP = '- button "Easy Apply" [ref=e3]';
const BROWSER_NAMES = ['browser_search', 'browser_open', 'browser_read', 'browser_snapshot', 'browser_inspect', 'browser_screenshot', 'browser_scroll', 'browser_back', 'browser_tabs', 'browser_switch_tab', 'browser_wait_for_you', 'browser_click', 'browser_type', 'browser_select', 'browser_press'];

/** A Browser step's real tools on a fake window, a tab already on the jobs page with a snapshot; actions ask through `broker`. */
async function browserStep(broker: ApprovalBroker, access?: 'read', o: { shotBytes?: number } = {}) {
  const node: GraphNode = { id: 'n2', title: 'Research', kind: 'agent', prompt: 'p', browser: true, ...(access && { access }), createdBy: 'user', updatedBy: 'user', updatedAt: 't' };
  const events: NodeEventBody[] = [];
  /** Stop: aborts the step's signal. */
  const stop = new AbortController();
  const signal = stop.signal;
  const ctxBase = { runId: 'r1', graph: emptyGraph('g', 'G', 't'), node, emit: (e: NodeEventBody) => void events.push(e), signal };
  const s = toolSetup({ ask: createBrowserAsk({ broker, ctx: ctxBase }) });
  s.ctx.sites[JOBS] = { title: 'Jobs', text: 'A job', snapshot: SNAP, elements: { e3: { text: 'Easy Apply', attributes: {}, html: '<button>Easy Apply</button>' } }, ...(o.shotBytes !== undefined && { screenshotBytes: o.shotBytes }) };
  await s.call('browser_open', { url: JOBS });
  await s.call('browser_snapshot');
  const ctx: NodeContext = { ...ctxBase, prompt: 'FULL PROMPT', cwd: resolve('/', 'proj'), graphTools: [], browserTools: s.tools };
  const gate = createStepGate({
    broker,
    runId: 'r1',
    graphId: 'g',
    nodeId: 'n2',
    nodeTitle: 'Research',
    projectDir: ctx.cwd,
    privateFiles: [],
    signal,
    emit: ctx.emit,
    readOnly: access === 'read',
    selfApproving: new Set(s.tools.map((t) => `mcp__agent_stream_browser__${t.name}`)),
  });
  return { ctx, gate, events, tools: s.tools, tabs: s.tabs, stop };
}
/** A raw screenshot just over the 5 MB image limit. */
const OVER_5_MB = CLAUDE_IMAGE_MAX_BYTES + 1;
const approveNext = async (broker: ApprovalBroker) => {
  await vi.waitFor(() => expect(broker.pending()).toHaveLength(1));
  broker.decide(broker.pending()[0].id, { decision: 'approve' });
};

describe('Claude: the browser MCP server', () => {
  const msg = (m: object) => m as unknown as SDKMessage;
  const init = msg({ type: 'system', subtype: 'init', apiKeySource: 'none', session_id: 's1' });
  const success = msg({ type: 'result', subtype: 'success', is_error: false, result: 'ok', num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, session_id: 's1' });
  function fake(during: (options: Options) => Promise<void> = async () => {}, first: SDKMessage = init) {
    const calls: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options }[] = [];
    const fn: QueryFn = (params) => {
      calls.push(params);
      return (async function* () {
        yield first;
        await during(params.options ?? {});
        yield success;
      })();
    };
    return { fn, calls };
  }
  /** An MCP client on the browser server a run handed Claude. */
  async function connect(options: Options) {
    const server = options.mcpServers!.agent_stream_browser as McpSdkServerConfigWithInstance;
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.instance.connect(serverSide);
    const client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(clientSide);
    return client;
  }
  const run = async (fn: QueryFn, ctx: NodeContext, gate: ReturnType<typeof createStepGate>) => {
    const provider = createClaudeProvider({ findClaude: () => ({ ok: true, path: 'claude' }), checkAuth: async () => signedIn, queryFn: fn, env: {} });
    await provider.status();
    return provider.runStep(ctx, gate);
  };

  it('serves the tools as the "agent_stream_browser" server only when the step has them, allowed like the graph tools', async () => {
    const broker = new ApprovalBroker();
    const b = await browserStep(broker);
    const { fn, calls } = fake();
    expect((await run(fn, b.ctx, b.gate)).ok).toBe(true);
    const options = calls[0].options!;
    expect(options.allowedTools).toEqual(['Read', 'Glob', 'Grep', 'mcp__agent_stream_browser__*']);
    const server = options.mcpServers!.agent_stream_browser as McpSdkServerConfigWithInstance;
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.instance.connect(serverSide);
    const client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(clientSide);
    try {
      expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual([...BROWSER_NAMES].sort());
      const shot = await client.callTool({ name: 'browser_screenshot', arguments: {} });
      expect(shot.content).toEqual([
        { type: 'text', text: expect.stringContaining('Screenshot of "Jobs"') },
        { type: 'image', data: Buffer.from(`png:${JOBS}`).toString('base64'), mimeType: 'image/png' },
      ]);
      // An action tool asks the user through the broker, with its card, and runs only once approved.
      const click = client.callTool({ name: 'browser_click', arguments: { ref: 'e3' } });
      await approveNext(broker);
      expect((await click).content).toEqual([{ type: 'text', text: expect.stringContaining('Clicked button "Easy Apply".') }]);
    } finally {
      await client.close();
    }
    // Without browser tools: no server, nothing allowed.
    const plain = fake();
    await run(plain.fn, { ...b.ctx, browserTools: undefined }, b.gate);
    expect(plain.calls[0].options!.mcpServers).toBeUndefined();
    expect(plain.calls[0].options!.allowedTools).toEqual(['Read', 'Glob', 'Grep']);
  });

  it('the PreToolUse gate and canUseTool let browser tools through, even on a read-only step', async () => {
    const broker = new ApprovalBroker();
    const b = await browserStep(broker, 'read');
    let hookResult: unknown;
    let canUse: unknown;
    const { fn } = fake(async (options) => {
      const hook = options.hooks!.PreToolUse![0].hooks[0];
      const input = { hook_event_name: 'PreToolUse', tool_name: 'mcp__agent_stream_browser__browser_click', tool_input: { ref: 'e3' }, tool_use_id: 'tu1', session_id: 's1', transcript_path: '/t', cwd: '/proj' } as HookInput;
      hookResult = await hook(input, 'tu1', { signal: new AbortController().signal });
      canUse = await options.canUseTool!('mcp__agent_stream_browser__browser_click', { ref: 'e3' }, { signal: new AbortController().signal, toolUseID: 'tu1' } as never);
    });
    await run(fn, b.ctx, b.gate);
    // No generic card: the tool shows its own browser card when it runs.
    expect(hookResult).toEqual({});
    expect(canUse).toEqual({ behavior: 'allow', updatedInput: { ref: 'e3' } });
    expect(broker.pending()).toEqual([]);
  });

  it('a tool of another MCP server named "browser" (a project .mcp.json) is not ours: the gate asks about it like any tool', async () => {
    const broker = new ApprovalBroker();
    const b = await browserStep(broker);
    // Claude loads the project's servers, so a server named "browser" gives tools named mcp__browser__<name>.
    const theirs = 'mcp__browser__browser_click';
    expect(b.gate.isSelfApproving(theirs)).toBe(false);
    let hookResult: unknown;
    const { fn } = fake(async (options) => {
      const hook = options.hooks!.PreToolUse![0].hooks[0];
      const input = { hook_event_name: 'PreToolUse', tool_name: theirs, tool_input: { ref: 'e3' }, tool_use_id: 'tu1', session_id: 's1', transcript_path: '/t', cwd: '/proj' } as HookInput;
      const asked = hook(input, 'tu1', { signal: new AbortController().signal });
      await vi.waitFor(() => expect(broker.pending()).toHaveLength(1));
      // The generic card, not the browser card: this tool isn't one of the step's browser tools.
      expect(broker.pending()[0]).toMatchObject({ toolName: theirs });
      expect(broker.pending()[0].browserAction).toBeUndefined();
      broker.decide(broker.pending()[0].id, { decision: 'deny' });
      hookResult = await asked;
    });
    await run(fn, b.ctx, b.gate);
    expect(hookResult).toMatchObject({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny' } });
  });

  it('a screenshot over 5 MB comes back as text only, saying it was too large', async () => {
    const b = await browserStep(new ApprovalBroker(), undefined, { shotBytes: OVER_5_MB });
    const { fn, calls } = fake();
    await run(fn, b.ctx, b.gate);
    const client = await connect(calls[0].options!);
    try {
      const shot = await client.callTool({ name: 'browser_screenshot', arguments: { fullPage: true } });
      expect(shot.content).toEqual([{ type: 'text', text: expect.stringContaining(SCREENSHOT_TOO_LARGE) }]);
    } finally {
      await client.close();
    }
  });

  it('a call Claude cancels withdraws the browser card it opened', async () => {
    const broker = new ApprovalBroker();
    const b = await browserStep(broker);
    const { fn, calls } = fake();
    await run(fn, b.ctx, b.gate);
    const client = await connect(calls[0].options!);
    try {
      const cancel = new AbortController();
      const click = client.callTool({ name: 'browser_click', arguments: { ref: 'e3' } }, undefined, { signal: cancel.signal });
      await vi.waitFor(() => expect(broker.pending()).toHaveLength(1));
      cancel.abort();
      await expect(click).rejects.toThrow();
      await vi.waitFor(() => expect(broker.pending()).toEqual([]));
      expect(b.ctx.signal.aborted).toBe(false);
    } finally {
      await client.close();
    }
  });

  it('Stop while a browser card is pending withdraws it, and the call says the run was stopped', async () => {
    const broker = new ApprovalBroker();
    const b = await browserStep(broker);
    const { fn, calls } = fake();
    await run(fn, b.ctx, b.gate);
    const client = await connect(calls[0].options!);
    try {
      const click = client.callTool({ name: 'browser_click', arguments: { ref: 'e3' } });
      await vi.waitFor(() => expect(broker.pending()).toHaveLength(1));
      b.stop.abort();
      expect((await click).content).toEqual([{ type: 'text', text: expect.stringContaining(RUN_STOPPED) }]);
      expect(broker.pending()).toEqual([]);
    } finally {
      await client.close();
    }
  });

  describe('a configured MCP server under a name Agent Stream reserves', () => {
    const initWith = (servers: object[]) => msg({ type: 'system', subtype: 'init', apiKeySource: 'none', session_id: 's1', mcp_servers: servers });
    const ours = { name: 'agent_stream_browser', status: 'connected', source: 'sdk' };
    const graphTool: GraphTool = { name: 'add_node', description: 'Add a step.', schema: {}, run: async () => ({ text: 'ok' }) };

    it('fails a Browser step when the server is named agent_stream_browser', async () => {
      const b = await browserStep(new ApprovalBroker());
      const theirs = fake(async () => {}, initWith([{ name: 'agent_stream_browser', status: 'connected', source: 'project' }]));
      expect(await run(theirs.fn, b.ctx, b.gate)).toEqual({ ok: false, output: '', error: 'An MCP server in your settings is named agent_stream_browser, which Agent Stream reserves: rename it.' });
      // Listed twice: ours and one from the user's config.
      const both = fake(async () => {}, initWith([ours, { name: 'agent_stream_browser', status: 'connected' }]));
      expect((await run(both.fn, b.ctx, b.gate)).ok).toBe(false);
      // Only ours: fine.
      const fine = fake(async () => {}, initWith([ours]));
      expect((await run(fine.fn, b.ctx, b.gate)).ok).toBe(true);
    });

    it('fails a step with graph tools when the server is named run_graph; a step that registers neither name runs', async () => {
      const b = await browserStep(new ApprovalBroker());
      const theirs = initWith([{ name: 'run_graph', status: 'connected', source: 'user' }]);
      const graphStep = { ...b.ctx, browserTools: undefined, graphTools: [graphTool] };
      expect(await run(fake(async () => {}, theirs).fn, graphStep, b.gate)).toEqual({ ok: false, output: '', error: 'An MCP server in your settings is named run_graph, which Agent Stream reserves: rename it.' });
      // Without graph tools the step serves no run_graph, so no tool of that server is self-approving.
      expect((await run(fake(async () => {}, theirs).fn, { ...graphStep, graphTools: [] }, b.gate)).ok).toBe(true);
    });
  });
});

describe('Codex: browser dynamic tools', () => {
  function codexStep(script: (t: TurnScript) => unknown, ctx: NodeContext, gate: ReturnType<typeof createStepGate>, handlers: Record<string, FakeHandler> = {}) {
    const fake = fakeCodex({ ...turnHandlers({ script }), ...handlers });
    const deps: CodexRunDeps = { codexPath: () => '/bin/codex', missing: () => 'missing', spawn: fake.spawn, env: {}, platform: 'linux', knownModels: () => undefined, warnOnce: () => {}, log: () => {}, interruptWaitMs: 50 };
    return { fake, run: () => codexRunStep(deps)(ctx, gate) };
  }
  const call = (tool: string, args: object, callId = 'd1') => ({ callId, namespace: null, tool, arguments: args });

  it('offers them on any Browser step (read-only too), and answers a screenshot with text and an image', async () => {
    const broker = new ApprovalBroker();
    const b = await browserStep(broker, 'read');
    const answers: unknown[] = [];
    const s = codexStep(async (t) => {
      answers.push((await t.ask('item/tool/call', call('browser_screenshot', {}))).result);
      t.end();
    }, b.ctx, b.gate);
    expect((await s.run()).ok).toBe(true);
    const start = s.fake.last().paramsOf('thread/start');
    expect(start.sandbox).toBe('read-only');
    expect(start.dynamicTools.map((d: { name: string }) => d.name).sort()).toEqual([...BROWSER_NAMES].sort());
    expect(answers[0]).toEqual({
      contentItems: [
        { type: 'inputText', text: expect.stringContaining('Screenshot of "Jobs"') },
        { type: 'inputImage', imageUrl: `data:image/png;base64,${Buffer.from(`png:${JOBS}`).toString('base64')}` },
      ],
      success: true,
    });
  });

  it('runs an action only after the user approves its card', async () => {
    const broker = new ApprovalBroker();
    const b = await browserStep(broker);
    const answers: { contentItems: { text: string }[]; success: boolean }[] = [];
    const s = codexStep(async (t) => {
      answers.push((await t.ask('item/tool/call', call('browser_click', { ref: 'e3' }))).result);
      t.end();
    }, b.ctx, b.gate);
    const outcome = s.run();
    await waitFor(() => broker.pending().length === 1);
    expect(broker.pending()[0].browserAction?.element).toBe('button "Easy Apply"');
    broker.decide(broker.pending()[0].id, { decision: 'approve' });
    expect((await outcome).ok).toBe(true);
    expect(answers[0].success).toBe(true);
    expect(answers[0].contentItems[0].text).toContain('Clicked button "Easy Apply".');
  });

  it('a step without Browser gets no browser tools', async () => {
    const b = await browserStep(new ApprovalBroker());
    const s = codexStep((t) => t.end(), { ...b.ctx, browserTools: undefined }, b.gate);
    await s.run();
    expect(s.fake.last().paramsOf('thread/start')).not.toHaveProperty('dynamicTools');
  });

  it('a screenshot over 5 MB is answered with text only, saying it was too large', async () => {
    const b = await browserStep(new ApprovalBroker(), undefined, { shotBytes: OVER_5_MB });
    const answers: unknown[] = [];
    const s = codexStep(async (t) => {
      answers.push((await t.ask('item/tool/call', call('browser_screenshot', { fullPage: true }))).result);
      t.end();
    }, b.ctx, b.gate);
    expect((await s.run()).ok).toBe(true);
    expect(answers[0]).toEqual({ contentItems: [{ type: 'inputText', text: expect.stringContaining(SCREENSHOT_TOO_LARGE) }], success: true });
  });

  it('Stop while a browser card is pending withdraws it, and the call says the run was stopped', async () => {
    const broker = new ApprovalBroker();
    const b = await browserStep(broker);
    const answers: { contentItems: { text: string }[]; success: boolean }[] = [];
    const s = codexStep(async (t) => {
      answers.push((await t.ask('item/tool/call', call('browser_click', { ref: 'e3' }))).result);
    }, b.ctx, b.gate);
    const outcome = s.run();
    await waitFor(() => broker.pending().length === 1);
    b.stop.abort();
    expect(await outcome).toMatchObject({ ok: false, error: 'cancelled' });
    expect(broker.pending()).toEqual([]);
    await waitFor(() => answers.length === 1);
    expect(answers[0].contentItems[0].text).toContain(RUN_STOPPED);
  });

  it("turns off the user's own MCP servers (one named browser too), so the step's browser tools are only ours", async () => {
    const b = await browserStep(new ApprovalBroker());
    const s = codexStep((t) => t.end(), b.ctx, b.gate, { 'config/read': mcpConfig({ browser: { command: 'their-browser-mcp' } }) });
    expect((await s.run()).ok).toBe(true);
    expect(s.fake.last().args).toEqual(expect.arrayContaining(['-c', 'mcp_servers.browser.enabled=false']));
    expect(s.fake.last().paramsOf('thread/start').dynamicTools.map((d: { name: string }) => d.name).sort()).toEqual([...BROWSER_NAMES].sort());
  });
});

describe('the agent loop (Copilot): browser tools', () => {
  it('names them for the gate as mcp__agent_stream_browser__<name>, and says when a screenshot can\'t be shown', async () => {
    const b = await browserStep(new ApprovalBroker());
    const withImages = browserLoopTools(b.tools, { images: true });
    expect(withImages.map((t) => t.gateName)).toContain('mcp__agent_stream_browser__browser_click');
    const shot = withImages.find((t) => t.spec.name === 'browser_screenshot')!;
    expect((await shot.run({}, new AbortController().signal)).images).toEqual([{ type: 'image', mediaType: 'image/png', data: Buffer.from(`png:${JOBS}`).toString('base64') }]);
    const noImages = browserLoopTools(b.tools, { images: false }).find((t) => t.spec.name === 'browser_screenshot')!;
    const r = await noImages.run({}, new AbortController().signal);
    expect(r.images).toBeUndefined();
    expect(r.text.endsWith("\n\nThe screenshot couldn't be shown to this model.")).toBe(true);
  });

  it('keeps the 3 newest screenshots as images; older ones become a line saying they were removed', async () => {
    const b = await browserStep(new ApprovalBroker());
    const shot = (n: number) => [toolCallPart(`c${n}`, 'browser_screenshot', {})];
    const { model, requests } = fakeChatModel([shot(1), shot(2), shot(3), shot(4), shot(5), [textPart('Seen.')]]);
    const r = await runAgentLoop({
      model,
      system: 'sys',
      messages: [userText('Look.')],
      tools: browserLoopTools(b.tools, { images: true }),
      gate: allowAll,
      maxRequests: 10,
      signal: new AbortController().signal,
      toolImages: { keep: 3, budget: inlineBudget },
      onText: () => {},
      onToolCall: () => {},
      onToolResult: () => {},
    });
    expect(r.ok).toBe(true);
    // The last request: per round, an image or the removed line, after that round's result.
    const rounds = requests.at(-1)!.messages.filter((m): m is Extract<ChatMessage, { role: 'user' }> => m.role === 'user' && m.content.some((c) => c.type === 'toolResult'));
    expect(rounds.map((m) => m.content.map((c) => (c.type === 'text' ? c.text : c.type)))).toEqual([
      ['toolResult', EARLIER_SCREENSHOT_REMOVED],
      ['toolResult', EARLIER_SCREENSHOT_REMOVED],
      ['toolResult', 'image'],
      ['toolResult', 'image'],
      ['toolResult', 'image'],
    ]);
  });

  it("keeps screenshots within the request's inline budget, counting the attached images first", async () => {
    const b = await browserStep(new ApprovalBroker());
    const shot = (n: number) => [toolCallPart(`c${n}`, 'browser_screenshot', {})];
    const { model, requests } = fakeChatModel([shot(1), shot(2), [textPart('Seen.')]]);
    const attached: ChatMessage = { role: 'user', content: [{ type: 'text', text: 'Look.' }, { type: 'image', mediaType: 'image/png', data: 'aGk=' }] };
    await runAgentLoop({
      model,
      system: 'sys',
      messages: [attached],
      tools: browserLoopTools(b.tools, { images: true }),
      gate: allowAll,
      maxRequests: 10,
      signal: new AbortController().signal,
      // Room for two images: the attachment and the newest screenshot.
      toolImages: { keep: 3, budget: () => inlineBudget({ bytes: 1_000_000, images: 2 }) },
      onText: () => {},
      onToolCall: () => {},
      onToolResult: () => {},
    });
    const last = requests.at(-1)!.messages;
    // The system text goes first, then the attached message, unchanged.
    expect(last[1]).toEqual(attached);
    const kinds = last.flatMap((m) => (m.role === 'user' ? m.content.map((c) => (c.type === 'text' ? c.text : c.type)) : []));
    expect(kinds).toEqual(['sys', 'Look.', 'image', 'toolResult', EARLIER_SCREENSHOT_REMOVED, 'toolResult', 'image']);
  });

  it('says the newest screenshot itself wasn\'t sent when the budget has no room for it, not that it was an earlier one', async () => {
    const b = await browserStep(new ApprovalBroker());
    const shot = (n: number) => [toolCallPart(`c${n}`, 'browser_screenshot', {})];
    const { model, requests } = fakeChatModel([shot(1), shot(2), [textPart('Seen.')]]);
    const attached: ChatMessage = { role: 'user', content: [{ type: 'text', text: 'Look.' }, { type: 'image', mediaType: 'image/png', data: 'aGk=' }] };
    await runAgentLoop({
      model,
      system: 'sys',
      messages: [attached],
      tools: browserLoopTools(b.tools, { images: true }),
      gate: allowAll,
      maxRequests: 10,
      signal: new AbortController().signal,
      // Room for one image: the attachment takes it.
      toolImages: { keep: 3, budget: () => inlineBudget({ bytes: 1_000_000, images: 1 }) },
      onText: () => {},
      onToolCall: () => {},
      onToolResult: () => {},
    });
    const kinds = requests.at(-1)!.messages.flatMap((m) => (m.role === 'user' ? m.content.map((c) => (c.type === 'text' ? c.text : c.type)) : []));
    // Neither screenshot was ever sent, each in the request right after it: neither is called an earlier one that was removed.
    expect(kinds).toEqual(['sys', 'Look.', 'image', 'toolResult', NEWEST_SCREENSHOT_NOT_SENT, 'toolResult', NEWEST_SCREENSHOT_NOT_SENT]);
    expect(requests[1].messages.flatMap((m) => (m.role === 'user' ? m.content.map((c) => (c.type === 'text' ? c.text : c.type)) : []))).toEqual(['sys', 'Look.', 'image', 'toolResult', NEWEST_SCREENSHOT_NOT_SENT]);
    expect(NEWEST_SCREENSHOT_NOT_SENT).toBe("(this screenshot wasn't sent: this request has no room for it)");
  });

  it('sends a tool\'s images in the user message after the tool results', async () => {
    const b = await browserStep(new ApprovalBroker());
    const { model, requests } = fakeChatModel([[toolCallPart('c1', 'browser_screenshot', {})], [textPart('Seen.')]]);
    const r = await runAgentLoop({
      model,
      system: 'sys',
      messages: [userText('Look.')],
      tools: browserLoopTools(b.tools, { images: true }),
      gate: allowAll,
      maxRequests: 5,
      signal: new AbortController().signal,
      onText: () => {},
      onToolCall: () => {},
      onToolResult: () => {},
    });
    expect(r.ok).toBe(true);
    const last = requests[1].messages.at(-1) as Extract<ChatMessage, { role: 'user' }>;
    expect(last.content.map((c) => c.type)).toEqual(['toolResult', 'image']);
  });
});
