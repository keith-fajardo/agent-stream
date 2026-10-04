import { basename } from 'node:path';
import { PassThrough } from 'node:stream';
import type { CodexProcess, SpawnCodex } from '../src/providers/codex/connection';
import type { CommandAction, FileUpdateChange, ThreadItem, TokenUsageBreakdown, TurnStatus } from '../src/providers/codex/protocol';

/** One JSON-RPC message, either way. Params are `any` so tests can read them without casts. */
export type Msg = { jsonrpc?: string; id?: number | string; method?: string; params?: any; result?: any; error?: { code: number; message: string } };
/** Answers one client request: the return value is the result; a throw is an error answer. */
export type FakeHandler = (params: any, proc: FakeProc) => unknown;

/** A handler throws this to answer with a specific JSON-RPC error code. */
export class FakeRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

export const INIT_RESULT = { userAgent: 'fake-codex/0.160.0', codexHome: '/fake-codex-home', platformFamily: 'unix', platformOs: 'linux' };

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * The fake `codex app-server` process: in-memory stdio speaking newline-delimited JSON-RPC (spec §8). It answers the
 * client's requests from `handlers`, records everything the client sent, and lets a test send notifications and server
 * requests, write raw lines, or end the process. No real Codex, no network.
 */
export class FakeProc implements CodexProcess {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  /** Everything the client sent, in order. */
  readonly received: Msg[] = [];
  killed = false;
  exited = false;
  private exitCallbacks: ((code: number | null, error?: Error, signal?: NodeJS.Signals | null) => void)[] = [];
  private answers = new Map<number, (m: Msg) => void>();
  private nextId = 1000;

  constructor(
    readonly codexPath: string,
    readonly args: readonly string[],
    readonly env: NodeJS.ProcessEnv,
    private handlers: Record<string, FakeHandler>,
  ) {
    let buffer = '';
    this.stdin.setEncoding('utf8');
    this.stdin.on('data', (chunk: string) => {
      buffer += chunk;
      for (let i = buffer.indexOf('\n'); i >= 0; i = buffer.indexOf('\n')) {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 1);
        if (line.trim()) void this.onMessage(JSON.parse(line) as Msg);
      }
    });
  }

  private async onMessage(m: Msg): Promise<void> {
    this.received.push(m);
    if (m.method !== undefined && m.id !== undefined) {
      const handler = this.handlers[m.method];
      if (!handler) return this.send({ id: m.id, error: { code: -32601, message: `fake: no handler for ${m.method}` } });
      try {
        this.send({ id: m.id, result: (await handler(m.params, this)) ?? {} });
      } catch (e) {
        this.send({ id: m.id, error: { code: e instanceof FakeRpcError ? e.code : -32603, message: e instanceof Error ? e.message : String(e) } });
      }
      return;
    }
    if (m.method === undefined && typeof m.id === 'number') {
      this.answers.get(m.id)?.(m);
      this.answers.delete(m.id);
    }
  }

  send(m: Msg): void {
    if (!this.exited) this.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`);
  }

  notify(method: string, params: unknown): void {
    this.send({ method, params });
  }

  /** A server request; resolves with the client's answer (`result` or `error`). */
  request(method: string, params: unknown): Promise<Msg> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.answers.set(id, resolve);
      this.send({ id, method, params });
    });
  }

  writeRaw(text: string): void {
    this.stdout.write(text);
  }

  /** The process ends by itself: stderr first, then the exit (or the signal that killed it), as a real process reports it. */
  async exit(code: number | null, stderr = '', signal?: NodeJS.Signals): Promise<void> {
    if (this.exited) return;
    if (stderr) this.stderr.write(stderr);
    await tick();
    this.exited = true;
    for (const cb of this.exitCallbacks) cb(code, undefined, signal ?? null);
  }

  /** The process could not be started at all (ENOENT). */
  async failToStart(error: Error): Promise<void> {
    await tick();
    this.exited = true;
    for (const cb of this.exitCallbacks) cb(null, error);
  }

  kill(): void {
    this.killed = true;
    void this.exit(null);
  }

  onExit(cb: (code: number | null, error?: Error, signal?: NodeJS.Signals | null) => void): void {
    this.exitCallbacks.push(cb);
  }

  /** The methods of the client's requests and notifications, in order. */
  methods(): string[] {
    return this.received.flatMap((m) => (m.method ? [m.method] : []));
  }

  /** The params of the client's first message with this method. */
    paramsOf(method: string): any {
    return this.received.find((m) => m.method === method)?.params;
  }
}

/**
 * A `config/read` answer whose user config has these MCP servers, each turned off when the process was started with
 * `-c mcp_servers.<name>.enabled=false`, as Codex 0.160.0 does (RF1 probe).
 */
export function mcpConfig(servers: Record<string, object>): FakeHandler {
  return (_params, proc) => {
    const off = new Set(proc.args.flatMap((a) => /^mcp_servers\.([^.]+)\.enabled=false$/.exec(a)?.[1] ?? []));
    return { config: { mcp_servers: Object.fromEntries(Object.entries(servers).map(([name, s]) => [name, off.has(name) ? { ...s, enabled: false } : s])) }, origins: {} };
  };
}

/** A SpawnCodex that starts a FakeProc answering `initialize`, `config/read` (no MCP servers) and `handlers`. */
export function fakeCodex(handlers: Record<string, FakeHandler> = {}) {
  const procs: FakeProc[] = [];
  const spawn: SpawnCodex = (codexPath, args, env) => {
    const p = new FakeProc(codexPath, args, env, { initialize: () => INIT_RESULT, 'config/read': mcpConfig({}), ...handlers });
    procs.push(p);
    return p;
  };
  const last = (): FakeProc => {
    const p = procs.at(-1);
    if (!p) throw new Error('fakeCodex: nothing was spawned');
    return p;
  };
  return { spawn, procs, last };
}

/** What a scripted turn can do once `turn/start` was answered. */
export type TurnScript = {
  proc: FakeProc;
  threadId: string;
  turnId: string;
  /** item/started with `item`, then item/completed with `done` (default: the same item). */
  item(item: ThreadItem, done?: ThreadItem): void;
  started(item: ThreadItem): void;
  completed(item: ThreadItem): void;
  /** A server request for this turn; resolves with the client's answer. */
  ask(method: string, params: object): Promise<Msg>;
  usage(total: Partial<TokenUsageBreakdown>): void;
  error(message: string, willRetry?: boolean): void;
  /** turn/completed. */
  end(status?: TurnStatus, error?: string): void;
};

/**
 * Handlers for one scripted turn: thread/start answers `threadId`, thread/resume echoes its id, turn/start answers
 * `turnId` and then runs `script` (after the answer is written), and turn/interrupt completes the turn as interrupted
 * unless `onInterrupt` is 'ignore'.
 */
export function turnHandlers(o: { threadId?: string; turnId?: string; script?: (t: TurnScript) => unknown; onInterrupt?: 'complete' | 'ignore' }): Record<string, FakeHandler> {
  const threadId = o.threadId ?? 'thread-1';
  const turnId = o.turnId ?? 'turn-1';
  return {
    'thread/start': () => ({ thread: { id: threadId } }),
    'thread/resume': (p: { threadId: string }) => ({ thread: { id: p.threadId } }),
    'turn/start': (p: { threadId: string }, proc) => {
      const t = turnScript(proc, p.threadId, turnId);
      setImmediate(() => void o.script?.(t));
      return { turn: { id: turnId, status: 'inProgress', error: null, items: [] } };
    },
    'turn/interrupt': (p: { threadId: string; turnId: string }, proc) => {
      if (o.onInterrupt !== 'ignore') setImmediate(() => proc.notify('turn/completed', { threadId: p.threadId, turn: { id: p.turnId, status: 'interrupted', error: null, items: [] } }));
      return {};
    },
  };
}

function turnScript(proc: FakeProc, threadId: string, turnId: string): TurnScript {
  const at = { threadId, turnId };
  const t: TurnScript = {
    proc,
    threadId,
    turnId,
    started: (item) => proc.notify('item/started', { ...at, item, startedAtMs: 0 }),
    completed: (item) => proc.notify('item/completed', { ...at, item, completedAtMs: 0 }),
    item: (item, done) => {
      t.started(item);
      t.completed(done ?? item);
    },
    ask: (method, params) => proc.request(method, { ...at, ...params }),
    usage: (total) => {
      const full = { totalTokens: 0, inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, ...total };
      proc.notify('thread/tokenUsage/updated', { ...at, tokenUsage: { total: full, last: full, modelContextWindow: null } });
    },
    error: (message, willRetry = false) => proc.notify('error', { ...at, willRetry, error: { message, codexErrorInfo: null, additionalDetails: null } }),
    end: (status = 'completed', error) =>
      proc.notify('turn/completed', { threadId, turn: { id: turnId, status, error: error ? { message: error, codexErrorInfo: null, additionalDetails: null } : null, items: [] } }),
  };
  return t;
}

export const agentMessage = (text: string, id = 'msg-1'): ThreadItem => ({ type: 'agentMessage', id, text });
export const reasoning = (summary: string[], id = 'rs-1'): ThreadItem => ({ type: 'reasoning', id, summary, content: [] });
export const readAction = (command: string, path: string): CommandAction => ({ type: 'read', command, name: basename(path), path });

export function commandItem(o: {
  id?: string;
  command: string;
  cwd?: string;
  status: 'inProgress' | 'completed' | 'failed' | 'declined';
  output?: string | null;
  exitCode?: number | null;
  actions?: CommandAction[];
}): ThreadItem {
  return { type: 'commandExecution', id: o.id ?? 'cmd-1', command: o.command, cwd: o.cwd ?? '/w', status: o.status, commandActions: o.actions ?? [], aggregatedOutput: o.output ?? null, exitCode: o.exitCode ?? null };
}

export function fileChangeItem(o: { id?: string; changes: FileUpdateChange[]; status: 'inProgress' | 'completed' | 'failed' | 'declined' }): ThreadItem {
  return { type: 'fileChange', id: o.id ?? 'patch-1', changes: o.changes, status: o.status };
}

export function toolCallItem(o: { id?: string; tool: string; args: unknown; status: 'inProgress' | 'completed' | 'failed'; text?: string; success?: boolean | null }): ThreadItem {
  return {
    type: 'dynamicToolCall',
    id: o.id ?? 'tool-1',
    namespace: null,
    tool: o.tool,
    arguments: o.args,
    status: o.status,
    contentItems: o.text === undefined ? null : [{ type: 'inputText', text: o.text }],
    success: o.success ?? null,
  };
}

/** The params of an item/commandExecution/requestApproval, as Codex 0.160.0 sends them (§2 probe 2). */
export function approvalParams(o: { itemId?: string; command: string; cwd: string; actions?: CommandAction[] | null; reason?: string; kind?: 'command' | 'writeStdin'; extra?: object }) {
  return {
    kind: o.kind ?? 'command',
    threadId: 'thread-1',
    turnId: 'turn-1',
    itemId: o.itemId ?? 'cmd-1',
    startedAtMs: 0,
    environmentId: 'local',
    command: o.command,
    cwd: o.cwd,
    commandActions: o.actions === undefined ? [] : o.actions,
    ...(o.reason !== undefined && { reason: o.reason }),
    ...o.extra,
  };
}

export async function waitFor(check: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
