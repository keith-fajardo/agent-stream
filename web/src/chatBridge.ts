import type { HostMessage } from '@agent-stream/shared';
import { post } from './bridge';
import { dispatch } from './store';

/** The chat view: the extension picks the conversation (chatTarget) and relays the engine. */
export function connectChat(): void {
  window.addEventListener('message', (event: MessageEvent) => {
    const msg: unknown = event.data;
    if (typeof msg === 'object' && msg !== null && typeof (msg as { type?: unknown }).type === 'string') dispatch({ kind: 'server', msg: msg as HostMessage });
  });
  post({ type: 'ready' });
}
