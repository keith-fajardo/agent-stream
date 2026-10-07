import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isSharedHome } from '@agent-stream/shared';
import { writeFileAtomic } from './fsutil';
import type { ProjectPaths } from './paths';

const FILE = 'graph-homes.json';

/**
 * Which session (or Shared) each graph belongs to (graph homes spec, Data). Personal: the file sits in the git-ignored
 * sessions folder. A graph with no entry, or an entry pointing at a session that no longer exists, is in Default.
 */
export class GraphHomes {
  constructor(
    private paths: ProjectPaths,
    private log: (message: string) => void = () => {},
  ) {}

  private get file(): string {
    return join(this.paths.sessionsDir, FILE);
  }

  read(): Record<string, string> {
    if (!existsSync(this.file)) return {};
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.file, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
      return Object.fromEntries(Object.entries(parsed).filter((e): e is [string, string] => typeof e[1] === 'string'));
    } catch (e) {
      this.log(`${FILE} could not be read, so every graph is in Default for now (${(e as Error).message}).`);
      return {};
    }
  }

  private write(map: Record<string, string>): void {
    writeFileAtomic(this.file, `${JSON.stringify(map, null, 2)}\n`);
  }

  /** Resolves a graph's home: its entry when that is Shared or a known session, else `defaultId`. */
  resolver(knownSessionIds: string[], defaultId: string): (graphId: string) => string {
    const map = this.read();
    const known = new Set(knownSessionIds);
    return (graphId) => {
      const home = map[graphId];
      return home !== undefined && (isSharedHome(home) || known.has(home)) ? home : defaultId;
    };
  }

  move(graphId: string, home: string, defaultId: string): void {
    const map = this.read();
    if (home === defaultId) delete map[graphId];
    else map[graphId] = home;
    this.write(map);
  }

  forget(graphId: string): void {
    const map = this.read();
    if (!(graphId in map)) return;
    delete map[graphId];
    this.write(map);
  }

  releaseSession(sessionId: string): void {
    const map = this.read();
    const kept = Object.fromEntries(Object.entries(map).filter(([, home]) => home !== sessionId));
    if (Object.keys(kept).length === Object.keys(map).length) return;
    this.write(kept);
  }
}
