import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProviderStatus } from '@agent-stream/shared';
import type { Clock } from '../src/clock';
import type { Found } from '../src/platform';
import { ensureDataDirs, projectPaths, type ProjectPaths } from '../src/paths';
import type { AgentProvider } from '../src/providers/types';

/** A found Git Bash, so command steps aren't refused on Windows (ignored elsewhere). */
export const testGitBash: Found = { ok: true, path: 'C:\\Program Files\\Git\\bin\\bash.exe' };

export function tmpProject(): ProjectPaths {
  const paths = projectPaths(mkdtempSync(join(tmpdir(), 'agent-stream-')));
  ensureDataDirs(paths);
  return paths;
}

/** A variable values file in a fresh temp folder (the file itself doesn't exist yet), so no test writes into the real home folder. */
export function tmpValuesFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'agent-stream-values-')), 'values.json');
}

export function fixedClock(start = Date.parse('2026-10-02T00:00:00.000Z')): Clock {
  let t = start;
  return () => new Date((t += 1000)).toISOString();
}

export const signedIn: ProviderStatus = { provider: 'claude', ok: true, label: 'Claude Max' };

/** A provider whose steps and planner turns are given by the test. */
export function testProvider(over: Partial<AgentProvider> = {}): AgentProvider {
  return { id: 'claude', name: 'Claude', status: async () => signedIn, runStep: async () => ({ ok: true, output: '' }), planTurn: async () => ({ ok: true }), ...over };
}

/** A promise the test settles by hand. */
export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}
