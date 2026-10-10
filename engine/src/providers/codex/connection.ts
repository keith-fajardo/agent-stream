import { spawn } from 'node:child_process';
import path from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { envValue, killTree } from '../../platform';
import type { ConfigReadParams, ConfigReadResponse, InitializeParams } from './protocol';

/** `codex app-server`, signed in with ChatGPT only (spec §4.2). The quotes are part of the value Codex parses. */
export const CODEX_ARGS: readonly string[] = ['app-server', '-c', 'forced_login_method="chatgpt"'];
/** Variables that would sign Codex in with an API key or send its requests elsewhere (spec §4.2), and VS Code's process flag (R25). */
const REMOVED_VARS = new Set(['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL', 'ELECTRON_RUN_AS_NODE', 'RIPGREP_CONFIG_PATH', 'GREP_OPTIONS']);
/** The engine's version, sent as clientInfo.version (R21). */
export const CLIENT_VERSION = '0.8.0';
export const INIT_TIMEOUT_MS = 30_000;
const STDERR_TAIL_CHARS = 2000;
const CLOSED = 'The Codex connection was closed.';
export const UNSUPPORTED_REQUEST = "Agent Stream doesn't support this request.";
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

/** A JSON-RPC error: one Codex answered with, or one our server-request handler answers with. */
export class CodexRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = 'CodexRpcError';
  }
}

/** The process ended, or never started: what every pending request rejects with. */
export class CodexExitError extends Error {
  constructor(
    message: string,
    readonly code: number | null,
    readonly tail: string,
    readonly startError?: string,
    /** The signal that ended the process, when one did (M5). */
    readonly signal?: NodeJS.Signals,
  ) {
    super(message);
    this.name = 'CodexExitError';
  }
}

export type CodexProcess = { stdin: Writable; stdout: Readable; stderr: Readable; kill(): void; onExit(cb: (code: number | null, error?: Error, signal?: NodeJS.Signals | null) => void): void };
/** Starts Codex; tests substitute the fake app-server (spec §8). `onExit` also reports a spawn that failed (R4), and the signal that ended the process (M5). */
export type SpawnCodex = (codexPath: string, args: readonly string[], env: NodeJS.ProcessEnv) => CodexProcess;

export interface CodexConnection {
  request<T>(method: string, params: unknown, signal?: AbortSignal): Promise<T>;
  notify(method: string, params?: unknown): void;
  /** One handler (the last one set). Its result answers; a throw answers a JSON-RPC error (a CodexRpcError keeps its code, anything else is -32603). */
  onServerRequest(handler: (method: string, params: unknown) => Promise<unknown>): void;
  onNotification(handler: (method: string, params: unknown) => void): void;
  /** Called once when the process ends by itself, not after close(), with the message pending requests got (R4). */
  onExit(handler: (message: string) => void): void;
  /** Kills the process tree; pending requests reject. */
  close(): void;
}

const isTimeout = (e: unknown) => typeof e === 'object' && e !== null && (e as { name?: unknown }).name === 'TimeoutError';

/** A message for the user: a timed-out request reads as Codex not answering. */
export function errorMessage(e: unknown): string {
  if (isTimeout(e)) return "Codex didn't answer in time.";
  return e instanceof Error ? e.message : String(e);
}

/** Copy of `env` without the variables Codex must not see (spec §4.2, R25), matched without case. */
export function sanitizedCodexEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) if (!REMOVED_VARS.has(key.toUpperCase())) out[key] = value;
  return out;
}

/** One argument quoted as the Microsoft C runtime reads it back: `"` escaped, backslashes doubled before a quote (R15). */
export function windowsQuote(arg: string): string {
  let out = '"';
  let backslashes = 0;
  for (const ch of arg) {
    if (ch === '\\') {
      backslashes++;
      continue;
    }
    out += ch === '"' ? `${'\\'.repeat(backslashes * 2 + 1)}"` : `${'\\'.repeat(backslashes)}${ch}`;
    backslashes = 0;
  }
  return `${out}${'\\'.repeat(backslashes * 2)}"`;
}

export type SpawnSpec = { file: string; args: string[]; verbatim: boolean };

/**
 * How to start Codex: directly, or (Windows) a .cmd/.bat launcher such as npm's through cmd.exe, named by its full path
 * like killTree's taskkill, with the whole line quoted for `/s` (spec §4.2, R15).
 */
export function codexSpawnSpec(codexPath: string, args: readonly string[], platform: NodeJS.Platform, env: NodeJS.ProcessEnv): SpawnSpec {
  if (platform === 'win32' && /\.(cmd|bat)$/i.test(codexPath)) {
    const cmd = path.win32.join(envValue(env, 'SystemRoot', 'win32') ?? 'C:\\Windows', 'System32', 'cmd.exe');
    return { file: cmd, args: ['/d', '/s', '/c', `"${[codexPath, ...args].map(windowsQuote).join(' ')}"`], verbatim: true };
  }
  return { file: codexPath, args: [...args], verbatim: false };
}

/** The real process. Never called in tests. */
export const realSpawnCodex: SpawnCodex = (codexPath, args, env) => {
  const platform = process.platform;
  const spec = codexSpawnSpec(codexPath, args, platform, env);
  // Its own process group outside Windows, so close() stops everything Codex started (killTree).
  const child = spawn(spec.file, spec.args, { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, windowsVerbatimArguments: spec.verbatim, detached: platform !== 'win32' });
  return {
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr,
    kill: () => {
      if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
      killTree(child.pid, { platform, signal: 'SIGTERM' });
    },
    onExit: (cb) => {
      let done = false;
      const once = (code: number | null, error?: Error, signal?: NodeJS.Signals | null) => {
        if (done) return;
        done = true;
        cb(code, error, signal);
      };
      // 'close', not 'exit': stdout is fully read by then, so a last turn/completed isn't lost.
      child.once('close', (code, signal) => once(code, undefined, signal));
      child.once('error', (error) => once(null, error));
    },
  };
};

/** `exit 3`, or `signal SIGKILL` when a signal ended the process (M5). */
const exitReason = (code: number | null, signal?: NodeJS.Signals | null) => (code === null && signal ? `signal ${signal}` : `exit ${code ?? 'unknown'}`);

type RpcMessage = { id?: unknown; method?: unknown; params?: unknown; result?: unknown; error?: { code?: unknown; message?: unknown } };
type Pending = { resolve: (value: unknown) => void; reject: (error: unknown) => void; cleanup: () => void };

/** Newline-delimited JSON-RPC 2.0 over the process's stdio (spec §4.2). */
function connect(proc: CodexProcess, log: (message: string) => void): CodexConnection {
  let nextId = 1;
  const pending = new Map<number, Pending>();
  const notificationHandlers: ((method: string, params: unknown) => void)[] = [];
  const exitHandlers: ((message: string) => void)[] = [];
  let serverRequestHandler: ((method: string, params: unknown) => Promise<unknown>) | undefined;
  let closed = false;
  let ended: CodexExitError | undefined;
  let stderr = '';
  let buffer = '';

  const write = (message: object) => {
    if (!closed) proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  };
  const rejectAll = (error: unknown) => {
    for (const p of pending.values()) {
      p.cleanup();
      p.reject(error);
    }
    pending.clear();
  };

  async function answer(id: number | string, method: string, params: unknown): Promise<void> {
    let reply: object;
    try {
      if (!serverRequestHandler) throw new CodexRpcError(-32601, UNSUPPORTED_REQUEST);
      reply = { id, result: (await serverRequestHandler(method, params)) ?? null };
    } catch (e) {
      reply = { id, error: e instanceof CodexRpcError ? { code: e.code, message: e.message } : { code: -32603, message: e instanceof Error ? e.message : String(e) } };
    }
    write(reply);
  }

  function handle(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      parsed = undefined;
    }
    if (typeof parsed !== 'object' || parsed === null) {
      // Never the line itself: it may hold a command's output.
      log(`[agent-stream] Codex sent a line that isn't JSON-RPC (${line.length} characters); ignored.`);
      return;
    }
    const m = parsed as RpcMessage;
    const id = typeof m.id === 'number' || typeof m.id === 'string' ? m.id : undefined;
    if (typeof m.method === 'string') {
      if (id !== undefined) {
        void answer(id, m.method, m.params);
        return;
      }
      for (const h of notificationHandlers) {
        try {
          h(m.method, m.params);
        } catch (e) {
          log(`[agent-stream] Handling the Codex notification ${m.method} failed: ${errorMessage(e)}`);
        }
      }
      return;
    }
    const p = typeof id === 'number' ? pending.get(id) : undefined;
    if (!p || typeof id !== 'number') return;
    pending.delete(id);
    p.cleanup();
    if (m.error) p.reject(new CodexRpcError(typeof m.error.code === 'number' ? m.error.code : -32603, typeof m.error.message === 'string' ? m.error.message : 'Codex answered with an error.'));
    else p.resolve(m.result);
  }

  proc.stdin.on('error', () => {
    // A write after Codex exited: the exit itself is reported.
  });
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    for (let i = buffer.indexOf('\n'); i >= 0; i = buffer.indexOf('\n')) {
      const line = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 1);
      if (line) handle(line);
    }
  });
  proc.stderr.setEncoding('utf8');
  proc.stderr.on('data', (chunk: string) => {
    stderr = (stderr + chunk).slice(-4 * STDERR_TAIL_CHARS);
  });
  proc.onExit((code, error, signal) => {
    if (closed) return;
    closed = true;
    const tail = stderr.replace(ANSI, '').trim().slice(-STDERR_TAIL_CHARS);
    const message = error ? `Codex didn't start: ${error.message}` : `Codex stopped unexpectedly (${exitReason(code, signal)}).${tail ? `\n${tail}` : ''}`;
    ended = new CodexExitError(message, code, tail, error?.message, signal ?? undefined);
    rejectAll(ended);
    for (const h of exitHandlers) {
      // One handler that throws must not keep the others from learning that Codex ended (M7).
      try {
        h(message);
      } catch (e) {
        console.error(`[agent-stream] Handling the end of Codex failed: ${errorMessage(e)}`);
      }
    }
  });

  return {
    request<T>(method: string, params: unknown, signal?: AbortSignal): Promise<T> {
      if (ended) return Promise.reject(ended);
      if (closed) return Promise.reject(new Error(CLOSED));
      return new Promise<T>((resolve, reject) => {
        if (signal?.aborted) {
          reject(signal.reason);
          return;
        }
        const id = nextId++;
        const onAbort = () => {
          pending.delete(id);
          reject(signal?.reason);
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        pending.set(id, { resolve: resolve as (value: unknown) => void, reject, cleanup: () => signal?.removeEventListener('abort', onAbort) });
        write({ id, method, params });
      });
    },
    notify(method, params) {
      write(params === undefined ? { method } : { method, params });
    },
    onServerRequest(handler) {
      serverRequestHandler = handler;
    },
    onNotification(handler) {
      notificationHandlers.push(handler);
    },
    onExit(handler) {
      exitHandlers.push(handler);
    },
    close() {
      if (closed) return;
      closed = true;
      rejectAll(new Error(CLOSED));
      try {
        proc.stdin.end();
      } catch {
        // already gone
      }
      proc.kill();
    },
  };
}

function startReason(e: unknown, timeoutMs: number): string {
  if (e instanceof CodexExitError) return e.startError ?? `${exitReason(e.code, e.signal)}.${e.tail ? `\n${e.tail}` : ''}`;
  if (isTimeout(e)) return `no answer within ${timeoutMs / 1000} s`;
  return errorMessage(e);
}

/**
 * Starts `codex app-server` and completes the handshake (spec §4.2): `initialize`, then `initialized`. A failure or
 * timeout rejects with `Codex didn't start: <reason>` and leaves no process behind.
 */
export type OpenCodexOptions = {
  codexPath: string;
  spawn?: SpawnCodex;
  env?: NodeJS.ProcessEnv;
  initTimeoutMs?: number;
  log?: (message: string) => void;
  /** More `-c` overrides after CODEX_ARGS (RF1). */
  extraArgs?: readonly string[];
};

export async function openCodex(o: OpenCodexOptions): Promise<CodexConnection> {
  const timeoutMs = o.initTimeoutMs ?? INIT_TIMEOUT_MS;
  let conn: CodexConnection;
  try {
    conn = connect((o.spawn ?? realSpawnCodex)(o.codexPath, [...CODEX_ARGS, ...(o.extraArgs ?? [])], sanitizedCodexEnv(o.env ?? process.env)), o.log ?? ((m) => console.warn(m)));
  } catch (e) {
    throw new Error(`Codex didn't start: ${errorMessage(e)}`);
  }
  const params: InitializeParams = { clientInfo: { name: 'agent-stream', title: 'Agent Stream', version: CLIENT_VERSION }, capabilities: { experimentalApi: true, requestAttestation: false } };
  try {
    await conn.request('initialize', params, AbortSignal.timeout(timeoutMs));
  } catch (e) {
    conn.close();
    throw new Error(`Codex didn't start: ${startReason(e, timeoutMs)}`);
  }
  conn.notify('initialized');
  return conn;
}

const CONFIG_TIMEOUT_MS = 30_000;
/** The MCP server names a `-c mcp_servers.<name>.enabled=false` override can reach: Codex splits the key at every dot. */
const MCP_SERVER_NAME = /^[A-Za-z0-9_-]+$/;
export const mcpServersUnread = (reason: string) => `Codex didn't start: Agent Stream couldn't read which MCP servers your Codex config turns on (${reason}).`;
export const mcpServerNotOff = (name: string) =>
  `Codex didn't start: Agent Stream can't turn off the MCP server ${JSON.stringify(name)} from your Codex config. Its tools would run without asking, so Codex isn't used until the server is renamed (letters, digits, - and _) or removed.`;

/** The MCP servers Codex's effective config for `cwd` (user and project layers, and our overrides) turns on. */
async function mcpServersOn(conn: CodexConnection, cwd: string): Promise<string[]> {
  const params: ConfigReadParams = { includeLayers: false, cwd };
  let r: ConfigReadResponse | null | undefined;
  try {
    r = await conn.request<ConfigReadResponse | null>('config/read', params, AbortSignal.timeout(CONFIG_TIMEOUT_MS));
  } catch (e) {
    throw new Error(mcpServersUnread(errorMessage(e)));
  }
  const servers = r?.config?.mcp_servers;
  if (servers === undefined || servers === null) return [];
  if (typeof servers !== 'object') throw new Error(mcpServersUnread('mcp_servers is not a table'));
  return Object.entries(servers).flatMap(([name, s]) => (s?.enabled === false ? [] : [name]));
}

/**
 * Codex for a thread (spec §6, RF1): the MCP servers in the user's or the folder's Codex config are turned off, since an
 * MCP tool call is no command or file change and would run without the ToolGate. `-c mcp_servers={}` merges and leaves
 * them on (0.160.0 probe), so Codex is asked which servers are on and, if any are, started again with each one turned
 * off by name, then checked. A server that can't be turned off, or a config that can't be read, fails the start.
 */
export async function openCodexForThreads(o: OpenCodexOptions & { cwd: string }): Promise<CodexConnection> {
  const first = await openCodex(o);
  let on: string[];
  try {
    on = await mcpServersOn(first, o.cwd);
  } catch (e) {
    first.close();
    throw e;
  }
  if (on.length === 0) return first;
  first.close();
  const unreachable = on.find((name) => !MCP_SERVER_NAME.test(name));
  if (unreachable !== undefined) throw new Error(mcpServerNotOff(unreachable));
  const conn = await openCodex({ ...o, extraArgs: [...(o.extraArgs ?? []), ...on.flatMap((name) => ['-c', `mcp_servers.${name}.enabled=false`])] });
  try {
    const still = await mcpServersOn(conn, o.cwd);
    if (still.length > 0) throw new Error(mcpServerNotOff(still[0]));
  } catch (e) {
    conn.close();
    throw e;
  }
  return conn;
}
