import { EventEmitter } from 'node:events';
import { appendFileSync, existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  applyOp,
  emptyGraph,
  nextNodeId,
  parseExportFile,
  parseGraph,
  toExportFile,
  type Actor,
  type Graph,
  type GraphListItem,
  type GraphResult,
  type Op,
  type OpRecord,
} from '@agent-stream/shared';
import { systemClock, type Clock } from './clock';
import { readJsonLines, writeFileAtomic } from './fsutil';
import { isGraphId, type ProjectPaths } from './paths';
import { renameReferences } from './templates';

export function slugify(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return slug || 'graph';
}

/** Single source of truth for graphs. Every change goes through `apply`. */
export class GraphStore extends EventEmitter {
  /** Parsed graphs keyed by id, valid only while the file's mtime and size are unchanged. */
  private cache = new Map<string, { graph: Graph; mtimeMs: number; size: number }>();

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

  private chatFile(id: string): string {
    return join(this.paths.graphsDir, `${id}.chat.jsonl`);
  }

  private uniqueId(name: string): string {
    const base = slugify(name);
    let id = base;
    for (let i = 2; existsSync(this.file(id)); i++) id = `${base}-${i}`;
    return id;
  }

  list(): GraphListItem[] {
    const ids = readdirSync(this.paths.graphsDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.slice(0, -'.json'.length))
      .sort();
    const items = ids.map((id): GraphListItem => {
      const r = this.load(id);
      return r.ok ? { id, name: r.graph.name, updatedAt: r.graph.updatedAt } : { id, name: id, error: r.error };
    });
    return items.sort(
      (a, b) => Number(!!a.error) - Number(!!b.error) || (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '') || a.id.localeCompare(b.id),
    );
  }

  load(id: string): GraphResult {
    if (!isGraphId(id)) return { ok: false, error: `invalid graph id "${id}"` };
    const path = this.file(id);
    const stat = statSync(path, { throwIfNoEntry: false });
    if (!stat) {
      this.cache.delete(id);
      return { ok: false, error: `graph "${id}" not found` };
    }
    const cached = this.cache.get(id);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return { ok: true, graph: cached.graph };
    // The file changed on disk (hand edit, git checkout, ...) or was never loaded: re-read it.
    this.cache.delete(id);
    let json: unknown;
    try {
      json = JSON.parse(readFileSync(path, 'utf8'));
    } catch (e) {
      return { ok: false, error: `invalid JSON: ${(e as Error).message}` };
    }
    const r = parseGraph(json);
    if (!r.ok) return r;
    const graph = { ...r.graph, id };
    this.cache.set(id, { graph, mtimeMs: stat.mtimeMs, size: stat.size });
    return { ok: true, graph };
  }

  get(id: string): Graph {
    const r = this.load(id);
    if (!r.ok) throw new Error(r.error);
    return r.graph;
  }

  create(name: string): Graph {
    const id = this.uniqueId(name);
    const graph = emptyGraph(id, name.trim() || id, this.clock());
    this.save(graph);
    return graph;
  }

  /** Changes the display name only; the id (file name) stays, so runs keep pointing at it. */
  rename(id: string, name: string): GraphResult {
    const trimmed = name.trim();
    if (!trimmed) return { ok: false, error: 'A graph needs a name.' };
    const r = this.load(id);
    if (!r.ok) return r;
    const graph = { ...r.graph, name: trimmed, updatedAt: this.clock() };
    this.save(graph);
    this.emit('changed', graph);
    return { ok: true, graph };
  }

  /** "<name> copy" with the same definition; no planner session, chat, edit history or runs. */
  duplicate(id: string): GraphResult {
    const r = this.load(id);
    if (!r.ok) return r;
    const names = new Set(this.list().map((g) => g.name));
    let name = `${r.graph.name} copy`;
    for (let i = 2; names.has(name); i++) name = `${r.graph.name} copy ${i}`;
    const graph: Graph = { ...r.graph, id: this.uniqueId(name), name, updatedAt: this.clock() };
    this.save(graph);
    return { ok: true, graph };
  }

  /** Removes the graph, its edit history and its chat. Run logs stay on disk. */
  delete(id: string): { ok: true } | { ok: false; error: string } {
    if (!isGraphId(id)) return { ok: false, error: `invalid graph id "${id}"` };
    if (!existsSync(this.file(id))) return { ok: false, error: `graph "${id}" not found` };
    for (const f of [this.file(id), this.opsFile(id), this.chatFile(id)]) rmSync(f, { force: true });
    this.cache.delete(id);
    return { ok: true };
  }

  exportGraph(id: string): { ok: true; fileName: string; content: string } | { ok: false; error: string } {
    const r = this.load(id);
    if (!r.ok) return r;
    return { ok: true, fileName: `${id}.agent-stream.json`, content: `${JSON.stringify(toExportFile(r.graph, this.clock()), null, 2)}\n` };
  }

  importGraph(content: string): GraphResult {
    const parsed = parseExportFile(content, 'import', this.clock());
    if (!parsed.ok) return parsed;
    const graph = { ...parsed.graph, id: this.uniqueId(parsed.graph.name) };
    this.save(graph);
    return { ok: true, graph };
  }

  apply(graphId: string, op: Op, by: Actor): GraphResult {
    const current = this.load(graphId);
    if (!current.ok) return current;
    const at = this.clock();
    const resolved: Op =
      op.type === 'addNode' && !op.node.id ? { ...op, node: { ...op.node, id: nextNodeId(current.graph) } } : op;
    const r = applyOp(current.graph, resolved, by, at, { rewriteReferences: renameReferences });
    if (!r.ok) return r;
    this.save(r.graph);
    if (resolved.type !== 'moveNode') {
      const record: OpRecord = { at, by, op: resolved };
      appendFileSync(this.opsFile(graphId), `${JSON.stringify(record)}\n`);
    }
    this.emit('changed', r.graph);
    this.emit('op', graphId, resolved);
    return r;
  }

  readOps(graphId: string): OpRecord[] {
    if (!isGraphId(graphId)) return [];
    return readJsonLines<OpRecord>(this.opsFile(graphId));
  }

  private save(graph: Graph): void {
    const path = this.file(graph.id);
    writeFileAtomic(path, `${JSON.stringify(graph, null, 2)}\n`);
    const { mtimeMs, size } = statSync(path);
    this.cache.set(graph.id, { graph, mtimeMs, size });
  }
}
