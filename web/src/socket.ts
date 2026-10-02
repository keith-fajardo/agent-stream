import type { ClientMessage, ServerMessage } from '@claude-stream/shared';
import { dispatch, getState } from './store';

let ws: WebSocket | undefined;
let attempt = 0;
const queue: string[] = [];

export function connect(): void {
  const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws = socket;
  socket.onopen = () => {
    attempt = 0;
    const graphId = getState().graph?.id;
    if (graphId) socket.send(JSON.stringify({ type: 'openGraph', graphId } satisfies ClientMessage));
    while (queue.length) socket.send(queue.shift()!);
  };
  socket.onmessage = (event) => {
    const msg = JSON.parse(String(event.data)) as ServerMessage;
    dispatch({ kind: 'server', msg });
    if (msg.type === 'hello' && !getState().graph) {
      const first = msg.graphs.find((g) => !g.error);
      if (first) send({ type: 'openGraph', graphId: first.id });
    }
  };
  socket.onclose = () => {
    dispatch({ kind: 'disconnected' });
    setTimeout(connect, Math.min(10_000, 500 * 2 ** attempt++));
  };
}

export function send(msg: ClientMessage): void {
  const data = JSON.stringify(msg);
  if (ws?.readyState === WebSocket.OPEN) ws.send(data);
  else queue.push(data);
}
