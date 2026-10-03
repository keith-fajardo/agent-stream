import type { ProviderStatus } from '@agent-stream/shared';
import { CHECKING } from './engines';

export function statusBarText(status: ProviderStatus): { text: string; tooltip: string } {
  if (status === CHECKING) return { text: '$(sync~spin) Agent Stream', tooltip: status.error ?? '' };
  if (status.ok) return { text: `$(check) ${status.label}`, tooltip: `Agent Stream runs on ${status.label}${status.detail ? ` (${status.detail})` : ''}.` };
  if (status.preview) return { text: `$(beaker) ${status.label}`, tooltip: status.detail ?? status.error ?? status.label };
  return { text: `$(warning) Agent Stream: ${status.label}`, tooltip: status.error ?? status.label };
}
