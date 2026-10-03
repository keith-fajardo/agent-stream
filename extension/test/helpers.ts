import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWriteLeases, type AgentProvider } from '@agent-stream/engine';
import type { ProviderStatus } from '@agent-stream/shared';

export const signedIn: ProviderStatus = { provider: 'claude', ok: true, label: 'Claude Max' };
export function testProvider(over: Partial<AgentProvider> = {}): AgentProvider {
  return { id: 'claude', name: 'Claude', status: async () => signedIn, runStep: async () => ({ ok: true, output: '' }), planTurn: async () => ({ ok: true }), ...over };
}

// Shared with the engine's tests so the fake git and its checkout answers stay in one place.
export { fakeGit, noGit, repoAnswers, type GitAnswer } from '../../engine/test/helpers';
import { noGit } from '../../engine/test/helpers';

/** What createApp needs besides the folder: no real Git, leases and a home folder in temp folders. */
export function engineTestDeps() {
  return { git: noGit, leases: createWriteLeases({ locksDir: mkdtempSync(join(tmpdir(), 'cs-locks-')), isAlive: () => true }), home: mkdtempSync(join(tmpdir(), 'cs-home-')) };
}
