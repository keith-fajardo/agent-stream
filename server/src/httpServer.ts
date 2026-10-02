import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, resolve, sep } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { parseClientMessage, type ServerMessage } from '@claude-stream/shared';
import type { App, Client } from './app';

const HOST = '127.0.0.1';
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

export type HttpServerOptions = { app: Pick<App, 'connect' | 'handle'>; port: number; staticDir: string; token?: string };
export type RunningServer = { url: string; port: number; token: string; close(): Promise<void> };

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const raw = part.slice(i + 1).trim();
    let value = raw;
    try {
      value = decodeURIComponent(raw);
    } catch {
      // keep the raw value
    }
    out[part.slice(0, i).trim()] = value;
  }
  return out;
}

async function serveStatic(root: string, pathname: string, res: ServerResponse): Promise<void> {
  let path: string;
  try {
    path = decodeURIComponent(pathname);
  } catch {
    res.writeHead(400).end('Bad request');
    return;
  }
  const base = resolve(root);
  const file = resolve(base, `.${path === '/' ? '/index.html' : path}`);
  if (!file.startsWith(base + sep)) {
    res.writeHead(404).end('Not found');
    return;
  }
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' }).end(data);
  } catch {
    if (extname(file)) {
      res.writeHead(404).end('Not found');
      return;
    }
    try {
      const html = await readFile(join(base, 'index.html'));
      res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' }).end(html);
    } catch {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }).end('The web UI is not built. Run `npm run build` in the claude-stream folder.');
    }
  }
}

/**
 * Serves the UI and the WebSocket on 127.0.0.1 only (spec §10). The per-launch token in the
 * printed URL is swapped for an HttpOnly cookie; every request must carry it and our Host,
 * and WebSocket upgrades must also come from our Origin.
 */
export async function startHttpServer(o: HttpServerOptions): Promise<RunningServer> {
  const token = o.token ?? randomBytes(24).toString('hex');
  let port = o.port;
  const hostHeader = () => `${HOST}:${port}`;
  const cookieName = () => `cs_${port}`;
  const tokenMatches = (value: string | null | undefined) => {
    if (!value) return false;
    const a = Buffer.from(value);
    const b = Buffer.from(token);
    return a.length === b.length && timingSafeEqual(a, b);
  };
  const plain = { 'Content-Type': 'text/plain; charset=utf-8' };

  const server = createServer((req, res) => {
    void (async () => {
      if (req.headers.host !== hostHeader()) {
        res.writeHead(403, plain).end('Forbidden');
        return;
      }
      const url = new URL(req.url ?? '/', `http://${hostHeader()}`);
      if (url.searchParams.has('token')) {
        if (!tokenMatches(url.searchParams.get('token'))) {
          res.writeHead(403, plain).end('Invalid token');
          return;
        }
        res.writeHead(302, { 'Set-Cookie': `${cookieName()}=${token}; HttpOnly; SameSite=Strict; Path=/`, Location: '/' }).end();
        return;
      }
      if (!tokenMatches(parseCookies(req.headers.cookie)[cookieName()])) {
        res.writeHead(401, plain).end('Open the URL printed in the terminal where you started claude-stream.');
        return;
      }
      await serveStatic(o.staticDir, url.pathname, res);
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500, plain).end('Internal error');
    });
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const allowed =
      req.url === '/ws' &&
      req.headers.host === hostHeader() &&
      req.headers.origin === `http://${hostHeader()}` &&
      tokenMatches(parseCookies(req.headers.cookie)[cookieName()]);
    if (!allowed) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => attach(ws));
  });

  function attach(ws: WebSocket): void {
    const client: Client = {
      send: (msg: ServerMessage) => {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
      },
    };
    const disconnect = o.app.connect(client);
    ws.on('message', (data) => {
      const parsed = parseClientMessage(data.toString());
      if (!parsed.ok) {
        client.send({ type: 'error', message: parsed.error });
        return;
      }
      o.app.handle(client, parsed.msg).catch((e: unknown) => client.send({ type: 'error', message: e instanceof Error ? e.message : String(e) }));
    });
    ws.on('close', disconnect);
  }

  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(o.port, HOST, () => {
      server.off('error', reject);
      resolveListen();
    });
  });
  port = (server.address() as AddressInfo).port;

  return {
    url: `http://${HOST}:${port}/?token=${token}`,
    port,
    token,
    close: () =>
      new Promise<void>((resolveClose) => {
        for (const ws of wss.clients) ws.terminate();
        wss.close();
        server.closeAllConnections();
        server.close(() => resolveClose());
      }),
  };
}
