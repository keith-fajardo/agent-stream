import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type ProjectPaths = { root: string; dataDir: string; graphsDir: string; runsDir: string };

export function projectPaths(root: string): ProjectPaths {
  const dataDir = join(root, '.claude-stream');
  return { root, dataDir, graphsDir: join(dataDir, 'graphs'), runsDir: join(dataDir, 'runs') };
}

export function ensureDataDirs(paths: ProjectPaths): void {
  mkdirSync(paths.graphsDir, { recursive: true });
  mkdirSync(paths.runsDir, { recursive: true });
  const gitignore = join(paths.dataDir, '.gitignore');
  if (!existsSync(gitignore)) writeFileSync(gitignore, 'runs/\n');
}

const GRAPH_ID_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;

/** Graph ids become file names, so they are restricted to a safe slug alphabet. */
export function isGraphId(id: string): boolean {
  return GRAPH_ID_RE.test(id);
}
