import type { AuthInfo } from '@claude-stream/shared';
import { CHECKING } from './engines';

export function statusBarText(auth: AuthInfo): { text: string; tooltip: string } {
  if (auth === CHECKING) return { text: '$(sync~spin) Claude Stream', tooltip: CHECKING.error ?? '' };
  if (auth.ok) {
    const plan = auth.plan ? auth.plan.charAt(0).toUpperCase() + auth.plan.slice(1) : 'subscription';
    return { text: `$(check) Claude ${plan}`, tooltip: `Claude Stream runs on your Claude ${plan} subscription${auth.email ? ` (${auth.email})` : ''}.` };
  }
  return { text: '$(warning) Claude Stream: not signed in', tooltip: auth.error ?? 'Not signed in.' };
}
