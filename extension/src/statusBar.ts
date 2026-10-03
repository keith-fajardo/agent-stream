import { providerLabel, type ModelSelection, type ProviderStatus } from '@agent-stream/shared';
import { isChecking } from './engines';

/** `defaults`: the settings' default model and effort ('' = Default), named in the tooltip. */
export function statusBarText(status: ProviderStatus, defaults?: { model?: string; effort?: ModelSelection['effort'] | '' }): { text: string; tooltip: string } {
  if (isChecking(status)) return { text: '$(sync~spin) Agent Stream', tooltip: status.error ?? '' };
  const modelLine = defaults ? `\nDefault model: ${defaults.model || 'Default'} · Effort: ${defaults.effort || 'Default'}` : '';
  if (status.ok) return { text: `$(check) ${status.label}`, tooltip: `Agent Stream runs on ${status.label}${status.detail ? ` (${status.detail})` : ''}.${modelLine}` };
  return { text: `$(warning) Agent Stream: ${status.label}`, tooltip: status.error ?? status.label };
}

export function sessionStatusText(name: string): { text: string; tooltip: string } {
  return { text: `$(layers) ${name}`, tooltip: `Agent Stream session: ${name}. Click to switch.` };
}

/** The status bar's click: what the provider runs on, or why it can't run, with Check again. */
export async function signInDetails(
  status: ProviderStatus,
  d: { info(message: string): void; warn(message: string, action: string): Thenable<string | undefined>; recheck(): Promise<unknown> },
): Promise<void> {
  if (status.ok) {
    d.info(`Agent Stream runs on ${providerLabel(status)}.`);
    return;
  }
  if ((await d.warn(status.error ?? status.label, 'Check again')) === 'Check again') await d.recheck();
}
