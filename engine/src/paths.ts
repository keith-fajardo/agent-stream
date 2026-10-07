import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GRAPH_ID_RE, isGraphId } from '@agent-stream/shared';

/** Graph ids become file names, so they are restricted to a safe slug alphabet (the rule lives in shared/src/subgraphStep.ts). */
export { isGraphId };

/** `attachmentsDir`: each graph's attachments, in a folder per graph id; not ignored by Git (step model spec §6b.2). */
export type ProjectPaths = { root: string; dataDir: string; graphsDir: string; runsDir: string; sessionsDir: string; attachmentsDir: string };

export function projectPaths(root: string): ProjectPaths {
  const dataDir = join(root, '.agent-stream');
  return { root, dataDir, graphsDir: join(dataDir, 'graphs'), runsDir: join(dataDir, 'runs'), sessionsDir: join(dataDir, 'sessions'), attachmentsDir: join(dataDir, 'attachments') };
}

/** Where a graph's attachments are: `.agent-stream/attachments/<graph id>/`. */
export const graphAttachmentsDir = (paths: ProjectPaths, graphId: string): string => join(paths.attachmentsDir, graphId);

/** Run records and personal work sessions stay out of git. */
const GITIGNORE_LINES = ['runs/', 'sessions/'];

export function ensureDataDirs(paths: ProjectPaths): void {
  mkdirSync(paths.graphsDir, { recursive: true });
  mkdirSync(paths.runsDir, { recursive: true });
  mkdirSync(paths.sessionsDir, { recursive: true });
  const gitignore = join(paths.dataDir, '.gitignore');
  const existing = existsSync(gitignore) ? readFileSync(gitignore, 'utf8') : '';
  const present = new Set(existing.split(/\r?\n/).map((l) => l.trim()));
  const missing = GITIGNORE_LINES.filter((l) => !present.has(l));
  if (missing.length === 0) return;
  const sep = existing && !existing.endsWith('\n') ? '\n' : '';
  writeFileSync(gitignore, `${existing}${sep}${missing.join('\n')}\n`);
}

export function isSessionId(id: string): boolean {
  return GRAPH_ID_RE.test(id);
}
