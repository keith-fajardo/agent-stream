import { EventEmitter } from 'node:events';
import { chmodSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MAX_VARIABLE_VALUE_CHARS } from '@claude-stream/shared';
import { writeFileAtomic } from './fsutil';
import type { ProjectPaths } from './paths';

export const VALUES_FILE = 'variables.local.json';
type Values = Record<string, string>;
type FileShape = { version: 1; graphs: Record<string, Values> };

/** A copy with no prototype, so no variable name can reach Object.prototype. */
const plain = (src: Record<string, string> = {}): Values => Object.assign(Object.create(null) as Values, src);

/**
 * Variable values for this machine only (spec §7.1): never in the graph file, an export or the
 * planner. Emits 'changed' (graphId, values) after every write.
 */
export class VariableValues extends EventEmitter {
  private data: FileShape | undefined;
  /** Set when the file exists but can't be read; it is left untouched until a value is saved. */
  problem: string | undefined;

  constructor(
    private paths: ProjectPaths,
    private platform: NodeJS.Platform = process.platform,
  ) {
    super();
  }

  private file(): string {
    return join(this.paths.dataDir, VALUES_FILE);
  }

  private load(): FileShape {
    if (this.data) return this.data;
    const data: FileShape = { version: 1, graphs: Object.create(null) as Record<string, Values> };
    this.data = data;
    if (!existsSync(this.file())) return data;
    try {
      const json = JSON.parse(readFileSync(this.file(), 'utf8')) as { graphs?: unknown };
      if (typeof json !== 'object' || json === null || typeof json.graphs !== 'object' || json.graphs === null) throw new Error('unexpected format');
      for (const [graphId, values] of Object.entries(json.graphs as Record<string, unknown>)) {
        if (typeof values !== 'object' || values === null) continue;
        data.graphs[graphId] = plain(Object.fromEntries(Object.entries(values).filter(([, v]) => typeof v === 'string')) as Values);
      }
    } catch (e) {
      this.problem = `${VALUES_FILE} could not be read (${(e as Error).message}); variable values are treated as empty until you save one.`;
    }
    return data;
  }

  get(graphId: string): Record<string, string> {
    const graphs = this.load().graphs;
    return plain(Object.hasOwn(graphs, graphId) ? graphs[graphId] : {});
  }

  set(graphId: string, name: string, value: string): void {
    if (value.length > MAX_VARIABLE_VALUE_CHARS) throw new Error(`A value can be at most ${MAX_VARIABLE_VALUE_CHARS} characters.`);
    const values = this.get(graphId);
    if (value === '') delete values[name];
    else values[name] = value;
    this.write(graphId, values);
  }

  rename(graphId: string, from: string, to: string): void {
    const values = this.get(graphId);
    if (!Object.hasOwn(values, from)) return;
    values[to] = values[from];
    delete values[from];
    this.write(graphId, values);
  }

  delete(graphId: string, name: string): void {
    const values = this.get(graphId);
    if (!Object.hasOwn(values, name)) return;
    delete values[name];
    this.write(graphId, values);
  }

  copyGraph(fromId: string, toId: string): void {
    const values = this.get(fromId);
    if (Object.keys(values).length) this.write(toId, values);
  }

  deleteGraph(graphId: string): void {
    if (Object.hasOwn(this.load().graphs, graphId)) this.write(graphId, {});
  }

  private write(graphId: string, values: Values): void {
    const current = this.load();
    const next: FileShape = { version: 1, graphs: Object.assign(Object.create(null) as Record<string, Values>, current.graphs) };
    if (Object.keys(values).length) next.graphs[graphId] = values;
    else delete next.graphs[graphId];
    writeFileAtomic(this.file(), `${JSON.stringify(next, null, 2)}\n`, 0o600);
    this.data = next;
    if (this.platform !== 'win32') {
      try {
        chmodSync(this.file(), 0o600);
      } catch {
        // the temp file was created 0600 already
      }
    }
    this.problem = undefined;
    this.emit('changed', graphId, plain(values));
  }
}
