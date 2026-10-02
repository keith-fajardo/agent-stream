import { EventEmitter } from 'node:events';
import { appendFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  applyOp,
  emptyGraph,
  nextNodeId,
  parseGraph,
  type Actor,
  type Graph,
  type GraphListItem,
  type GraphResult,
  type Op,
  type OpRecord,
} from '@claude-stream/shared';
import { systemClock, type Clock } from './clock';
import { writeFileAtomic } from './fsutil';
import { isGraphId, type ProjectPaths } from './paths';

export function slugify(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return slug || 'graph';
}

/** Single source of truth for graphs. Every change goes through `apply`. */
export class GraphStore extends EventEmitter {
  private cache = new Map<string, Graph>();

  constructor(
    private paths: ProjectPaths,
    private clock: Clock = systemClock,
  ) {
    super();
  }

  private file(id: string): string {
    return join(this.paths.graphsDir, `${id}.json`);
  }

  private opsFile(id: string): string {
    return join(this.paths.graphsDir, `${id}.ops.jsonl`);
  }

  list(): GraphListItem[] {
    const ids = readdirSync(this.paths.graphsDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.slice(0, -'.json'.length))
      .sort();
    return ids.map((id) => {
      const r = this.load(id);
      return r.ok ? { id, name: r.graph.name } : { id, name: id, error: r.error };
    });
  }

  load(id: string): GraphResult {
    const cached = this.cache.get(id);
    if (cached) return { ok: true, graph: cached };
    if (!isGraphId(id)) return { ok: false, error: `invalid graph id "${id}"` };
    const path = this.file(id);
    if (!existsSync(path)) return { ok: false, error: `graph "${id}" not found` };
    let json: unknown;
    try {
      json = JSON.parse(readFileSync(path, 'utf8'));
    } catch (e) {
      return { ok: false, error: `invalid JSON: ${(e as Error).message}` };
    }
    const r = parseGraph(json);
    if (!r.ok) return r;
    const graph = { ...r.graph, id };
    this.cache.set(id, graph);
    return { ok: true, graph };
  }

  get(id: string): Graph {
    const r = this.load(id);
    if (!r.ok) throw new Error(r.error);
    return r.graph;
  }

  create(name: string): Graph {
    const base = slugify(name);
    let id = base;
    for (let i = 2; existsSync(this.file(id)); i++) id = `${base}-${i}`;
    const graph = emptyGraph(id, name.trim() || id, this.clock());
    this.save(graph);
    return graph;
  }

  apply(graphId: string, op: Op, by: Actor): GraphResult {
    const current = this.load(graphId);
    if (!current.ok) return current;
    const at = this.clock();
    const resolved: Op =
      op.type === 'addNode' && !op.node.id ? { ...op, node: { ...op.node, id: nextNodeId(current.graph) } } : op;
    const r = applyOp(current.graph, resolved, by, at);
    if (!r.ok) return r;
    this.save(r.graph);
    if (resolved.type !== 'moveNode') {
      const record: OpRecord = { at, by, op: resolved };
      appendFileSync(this.opsFile(graphId), `${JSON.stringify(record)}\n`);
    }
    this.emit('changed', r.graph);
    return r;
  }

  /** Planner bookkeeping: not content, so it is neither logged nor broadcast. */
  setPlannerState(graphId: string, patch: { plannerSessionId?: string; plannerOpCursor?: number }): Graph {
    const graph = { ...this.get(graphId), ...patch };
    this.save(graph);
    return graph;
  }

  readOps(graphId: string): OpRecord[] {
    if (!isGraphId(graphId)) return [];
    const path = this.opsFile(graphId);
    if (!existsSync(path)) return [];
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as OpRecord);
  }

  private save(graph: Graph): void {
    writeFileAtomic(this.file(graph.id), `${JSON.stringify(graph, null, 2)}\n`);
    this.cache.set(graph.id, graph);
  }
}
