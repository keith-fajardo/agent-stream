import type { ProviderStatus } from '@agent-stream/shared';
import { isChecking } from './engines';

export function statusBarText(status: ProviderStatus): { text: string; tooltip: string } {
  if (isChecking(status)) return { text: '$(sync~spin) Agent Stream', tooltip: status.error ?? '' };
  if (status.ok) return { text: `$(check) ${status.label}`, tooltip: `Agent Stream runs on ${status.label}${status.detail ? ` (${status.detail})` : ''}.` };
  if (status.preview) return { text: `$(beaker) ${status.label}`, tooltip: status.detail ?? status.error ?? status.label };
  return { text: `$(warning) Agent Stream: ${status.label}`, tooltip: status.error ?? status.label };
}
