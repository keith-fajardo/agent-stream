import { describe, expect, it, vi } from 'vitest';
import {
  CODEX_ARGS,
  CodexRpcError,
  codexSpawnSpec,
  errorMessage,
  openCodex,
  sanitizedCodexEnv,
  UNSUPPORTED_REQUEST,
  windowsQuote,
} from '../src/providers/codex/connection';
import { fakeCodex, FakeRpcError, waitFor, type FakeHandler } from './codexFake';

const never = () => new Promise<never>(() => {});

async function connected(handlers: Record<string, FakeHandler> = {}, log: (m: string) => void = () => {}) {
  const fake = fakeCodex(handlers);
  const conn = await openCodex({ codexPath: '/bin/codex', spawn: fake.spawn, env: {}, log });
  return { conn, proc: fake.last() };
}

describe('openCodex', () => {
  it('starts codex app-server for ChatGPT sign-in, without API-key variables, and completes the handshake', async () => {
    const fake = fakeCodex();
    const conn = await openCodex({ codexPath: '/bin/codex', spawn: fake.spawn, env: { PATH: '/bin', OPENAI_API_KEY: 'placeholder' } });
    const p = fake.last();
    expect(p.codexPath).toBe('/bin/codex');
    expect(p.args).toEqual(['app-server', '-c', 'forced_login_method="chatgpt"']);
    expect(p.env).toEqual({ PATH: '/bin' });
    await waitFor(() => p.received.length === 2);
    expect(p.received[0]).toMatchObject({
      method: 'initialize',
      params: { clientInfo: { name: 'agent-stream', title: 'Agent Stream', version: '0.2.0' }, capabilities: { experimentalApi: true, requestAttestation: false } },
    });
    expect(p.received[1].method).toBe('initialized');
    expect(p.received[1].id).toBeUndefined();
    conn.close();
  });

  it("says why Codex didn't start: an error answer, no answer in time, an exit, or a failed spawn", async () => {
    const refused = fakeCodex({ initialize: () => { throw new FakeRpcError(-32600, 'bad client'); } });
    await expect(openCodex({ codexPath: '/bin/codex', spawn: refused.spawn })).rejects.toThrow("Codex didn't start: bad client");
    expect(refused.last().killed).toBe(true);

    const silent = fakeCodex({ initialize: never });
    await expect(openCodex({ codexPath: '/bin/codex', spawn: silent.spawn, initTimeoutMs: 20 })).rejects.toThrow("Codex didn't start: no answer within 0.02 s");
    expect(silent.last().killed).toBe(true);

    const exits = fakeCodex({ initialize: (_p, proc) => { void proc.exit(1, 'error: unknown option\n'); return never(); } });
    await expect(openCodex({ codexPath: '/bin/codex', spawn: exits.spawn })).rejects.toThrow("Codex didn't start: exit 1.\nerror: unknown option");

    const missing = fakeCodex({ initialize: (_p, proc) => { void proc.failToStart(new Error('spawn /bin/codex ENOENT')); return never(); } });
    await expect(openCodex({ codexPath: '/bin/codex', spawn: missing.spawn })).rejects.toThrow("Codex didn't start: spawn /bin/codex ENOENT");
  });
});

describe('CodexConnection', () => {
  it('matches each answer to its request, even out of order, and turns error answers into CodexRpcError', async () => {
    let releaseSlow!: () => void;
    const slowGate = new Promise<void>((r) => (releaseSlow = r));
    const { conn } = await connected({
      slow: async () => {
        await slowGate;
        return { n: 1 };
      },
      fast: (p: { x: number }) => ({ n: p.x }),
      bad: () => { throw new FakeRpcError(-32001, 'model refused'); },
    });
    const slow = conn.request<{ n: number }>('slow', {});
    expect(await conn.request<{ n: number }>('fast', { x: 2 })).toEqual({ n: 2 });
    releaseSlow();
    expect(await slow).toEqual({ n: 1 });
    const error = await conn.request('bad', {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CodexRpcError);
    expect(error).toMatchObject({ code: -32001, message: 'model refused' });
    conn.close();
  });

  it("answers server requests with the handler's result, or a JSON-RPC error", async () => {
    const { conn, proc } = await connected();
    expect(await proc.request('item/tool/requestUserInput', {})).toMatchObject({ error: { code: -32601, message: UNSUPPORTED_REQUEST } });
    conn.onServerRequest(async (method, params) => {
      if (method === 'echo') return { got: params };
      if (method === 'refuse') throw new CodexRpcError(-32601, UNSUPPORTED_REQUEST);
      throw new Error('boom');
    });
    expect(await proc.request('echo', { a: 1 })).toMatchObject({ result: { got: { a: 1 } } });
    expect(await proc.request('refuse', {})).toMatchObject({ error: { code: -32601, message: UNSUPPORTED_REQUEST } });
    expect(await proc.request('other', {})).toMatchObject({ error: { code: -32603, message: 'boom' } });
    conn.close();
  });

  it('delivers notifications in order, and ignores a malformed line without logging its text', async () => {
    const log = vi.fn();
    const { conn, proc } = await connected({}, log);
    const seen: [string, unknown][] = [];
    conn.onNotification((method, params) => seen.push([method, params]));
    proc.notify('a', { n: 1 });
    proc.writeRaw('SECRET-LINE not json\n');
    proc.writeRaw('42\n');
    proc.notify('b', { n: 2 });
    await waitFor(() => seen.length === 2);
    expect(seen).toEqual([['a', { n: 1 }], ['b', { n: 2 }]]);
    expect(log).toHaveBeenCalledTimes(2);
    expect(log.mock.calls[0][0]).toContain("isn't JSON-RPC");
    expect(log.mock.calls[0][0]).not.toContain('SECRET-LINE');
    conn.close();
  });

  it('rejects every pending request when Codex exits, with the exit code and the stderr tail, and tells onExit', async () => {
    const { conn, proc } = await connected({ hang: never });
    const exits: string[] = [];
    conn.onExit((message) => exits.push(message));
    const pending = conn.request('hang', {});
    await proc.exit(3, '\u001b[2m2026-10-04\u001b[0m \u001b[31mERROR\u001b[0m model refused\n');
    const message = 'Codex stopped unexpectedly (exit 3).\n2026-10-04 ERROR model refused';
    await expect(pending).rejects.toThrow(message);
    expect(exits).toEqual([message]);
    await expect(conn.request('later', {})).rejects.toThrow(message);
  });

  it('keeps only the last 2,000 characters of stderr', async () => {
    const { conn, proc } = await connected({ hang: never });
    const pending = conn.request('hang', {});
    await proc.exit(1, `${'x'.repeat(5000)}END\n`);
    const error = (await pending.catch((e: unknown) => e)) as Error;
    const tail = error.message.split('\n')[1];
    expect(tail.length).toBe(2000);
    expect(tail.endsWith('END')).toBe(true);
  });

  it('close() kills the process and rejects pending requests, without reporting an exit', async () => {
    const { conn, proc } = await connected({ hang: never });
    const exits: string[] = [];
    conn.onExit((m) => exits.push(m));
    const pending = conn.request('hang', {});
    conn.close();
    await expect(pending).rejects.toThrow('The Codex connection was closed.');
    expect(proc.killed).toBe(true);
    await new Promise((r) => setImmediate(r));
    expect(exits).toEqual([]);
    conn.close(); // twice is harmless
  });

  it("rejects a request whose signal aborts, and the connection keeps working", async () => {
    const { conn } = await connected({ hang: never, ok: () => ({ fine: true }) });
    const ac = new AbortController();
    const pending = conn.request('hang', {}, ac.signal);
    ac.abort(new Error('stopped'));
    await expect(pending).rejects.toThrow('stopped');
    expect(await conn.request('ok', {})).toEqual({ fine: true });
    conn.close();
  });
});

describe('errorMessage', () => {
  it('reads a timeout as Codex not answering', () => {
    expect(errorMessage(new DOMException('The operation was aborted due to timeout', 'TimeoutError'))).toBe("Codex didn't answer in time.");
    expect(errorMessage(new Error('x'))).toBe('x');
    expect(errorMessage('y')).toBe('y');
  });
});

describe('sanitizedCodexEnv', () => {
  it('removes the API-key and base-URL variables in any case, and VS Code’s process flag, keeping the rest', () => {
    const env = { PATH: '/bin', HOME: '/h', OPENAI_API_KEY: 'a', CODEX_API_KEY: 'b', OPENAI_BASE_URL: 'c', openai_api_key: 'd', ELECTRON_RUN_AS_NODE: '1' };
    expect(sanitizedCodexEnv(env)).toEqual({ PATH: '/bin', HOME: '/h' });
    expect(env.OPENAI_API_KEY).toBe('a');
  });

  it('removes the ripgrep config path, which could make rg search hidden and ignored folders', () => {
    expect(sanitizedCodexEnv({ PATH: '/bin', RIPGREP_CONFIG_PATH: '/h/.ripgreprc', ripgrep_config_path: 'x' })).toEqual({ PATH: '/bin' });
  });
});

describe('codexSpawnSpec', () => {
  it('runs a binary directly', () => {
    expect(codexSpawnSpec('/bin/codex', CODEX_ARGS, 'darwin', {})).toEqual({ file: '/bin/codex', args: [...CODEX_ARGS], verbatim: false });
    expect(codexSpawnSpec('C:\\tools\\codex.exe', CODEX_ARGS, 'win32', {})).toEqual({ file: 'C:\\tools\\codex.exe', args: [...CODEX_ARGS], verbatim: false });
  });

  it('runs a Windows .cmd or .bat launcher through cmd.exe by its full path, each argument quoted', () => {
    expect(codexSpawnSpec('C:\\Users\\A B\\npm\\codex.cmd', CODEX_ARGS, 'win32', { SYSTEMROOT: 'D:\\Win' })).toEqual({
      file: 'D:\\Win\\System32\\cmd.exe',
      args: ['/d', '/s', '/c', '""C:\\Users\\A B\\npm\\codex.cmd" "app-server" "-c" "forced_login_method=\\"chatgpt\\"""'],
      verbatim: true,
    });
    expect(codexSpawnSpec('C:\\npm\\CODEX.BAT', ['x'], 'win32', {}).file).toBe('C:\\Windows\\System32\\cmd.exe');
    // Only on Windows: elsewhere a .cmd name is just a file name.
    expect(codexSpawnSpec('/opt/codex.cmd', ['x'], 'linux', {})).toEqual({ file: '/opt/codex.cmd', args: ['x'], verbatim: false });
  });

  it('quotes as the C runtime reads it back: quotes escaped, backslashes doubled only before a quote', () => {
    expect(windowsQuote('a b')).toBe('"a b"');
    expect(windowsQuote('x="y"')).toBe('"x=\\"y\\""');
    expect(windowsQuote('C:\\dir\\')).toBe('"C:\\dir\\\\"');
    expect(windowsQuote('a\\"b')).toBe('"a\\\\\\"b"');
    expect(windowsQuote('')).toBe('""');
  });
});
