import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import type { ClientMessage } from '@claude-stream/shared';
import type { Client } from '../src/app';
import { parseCookies, startHttpServer } from '../src/httpServer';

const TOKEN = 'test-token-0123456789abcdef';
let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

async function start() {
  const staticDir = mkdtempSync(join(tmpdir(), 'web-'));
  writeFileSync(join(staticDir, 'index.html'), '<html>claude-stream</html>');
  mkdirSync(join(staticDir, 'assets'));
  writeFileSync(join(staticDir, 'assets', 'app.js'), 'console.log(1)');
  const received: ClientMessage[] = [];
  const app = {
    connect: (c: Client) => {
      c.send({ type: 'error', message: 'hello-from-fake' });
      return () => {};
    },
    handle: async (_c: Client, m: ClientMessage) => {
      received.push(m);
    },
  };
  const server = await startHttpServer({ app, port: 0, staticDir, token: TOKEN });
  close = server.close;
  const origin = `http://127.0.0.1:${server.port}`;
  return { server, origin, cookie: `cs_${server.port}=${TOKEN}`, received };
}

describe('http server', () => {
  it('parses cookies', () => {
    expect(parseCookies('a=1; cs_4317=abc; b=%20x')).toEqual({ a: '1', cs_4317: 'abc', b: ' x' });
    expect(parseCookies(undefined)).toEqual({});
  });

  it('requires the launch token', async () => {
    const { server, origin, cookie } = await start();
    expect(server.url).toBe(`${origin}/?token=${TOKEN}`);
    expect((await fetch(`${origin}/`)).status).toBe(401);
    expect((await fetch(`${origin}/?token=wrong`, { redirect: 'manual' })).status).toBe(403);
    const login = await fetch(`${origin}/?token=${TOKEN}`, { redirect: 'manual' });
    expect(login.status).toBe(302);
    expect(login.headers.get('set-cookie')).toBe(`${cookie}; HttpOnly; SameSite=Strict; Path=/`);
    const page = await fetch(`${origin}/`, { headers: { cookie } });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('claude-stream');
    const js = await fetch(`${origin}/assets/app.js`, { headers: { cookie } });
    expect(js.headers.get('content-type')).toContain('text/javascript');
  });

  it('does not serve files outside the web folder', async () => {
    const { origin, cookie } = await start();
    expect((await fetch(`${origin}/..%2f..%2f..%2fetc%2fpasswd`, { headers: { cookie } })).status).toBe(404);
  });

  it('rejects requests with a foreign Host header', async () => {
    const { server, cookie } = await start();
    const status = await new Promise<number>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: server.port, path: '/', headers: { host: 'evil.example', cookie } }, (res) => resolve(res.statusCode ?? 0));
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(403);
  });

  it('accepts WebSocket connections only with the cookie and our origin', async () => {
    const { server, origin, cookie, received } = await start();
    const messages: unknown[] = [];
    const good = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, { origin, headers: { cookie } });
    good.on('message', (data) => messages.push(JSON.parse(data.toString())));
    await new Promise((resolve, reject) => {
      good.once('open', resolve);
      good.once('error', reject);
    });
    await vi.waitFor(() => expect(messages).toEqual([{ type: 'error', message: 'hello-from-fake' }]));
    good.send(JSON.stringify({ type: 'openGraph', graphId: 'g' }));
    good.send('not json');
    await vi.waitFor(() => expect(received).toEqual([{ type: 'openGraph', graphId: 'g' }]));
    await vi.waitFor(() => expect(messages.at(-1)).toEqual({ type: 'error', message: 'message is not valid JSON' }));
    good.close();

    for (const options of [{ origin: 'http://evil.example', headers: { cookie } }, { origin }]) {
      const bad = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, options);
      const status = await new Promise<number>((resolve) => {
        bad.once('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
        bad.once('error', () => resolve(-1));
      });
      expect(status).toBe(403);
    }
  });

  it('survives a client that resets a rejected upgrade', async () => {
    const { server, origin } = await start();
    const raw = `GET /ws HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nOrigin: http://evil.example\r\n\r\n`;
    for (const afterData of [false, true]) {
      const socket = connect(server.port, '127.0.0.1');
      await new Promise((resolve) => socket.once('connect', resolve));
      socket.on('error', () => {});
      socket.write(raw);
      if (afterData) await new Promise((resolve) => socket.once('data', resolve));
      socket.resetAndDestroy();
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect((await fetch(`${origin}/`)).status).toBe(401);
    }
  });

  it('survives an invalid WebSocket frame', async () => {
    const { server, origin, cookie } = await start();
    const good = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, { origin, headers: { cookie } });
    good.on('error', () => {});
    await new Promise((resolve, reject) => {
      good.once('open', resolve);
      good.once('error', reject);
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (good as any)._socket.write(Buffer.from([0x81, 0x82, 0x00, 0x00, 0x00, 0x00, 0xff, 0xfe]));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect((await fetch(`${origin}/`, { headers: { cookie } })).status).toBe(200);
    good.terminate();
  });
});
