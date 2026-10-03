import { EventEmitter } from 'node:events';
import { appendFileSync, existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  applyOp,
  diffGraphs,
  edgeId,
  emptyGraph,
  nextNodeId,
  parseExportFile,
  parseGraph,
  toExportFile,
  type Actor,
  type AgentChange,
  type ChangeSource,
  type ChangeTarget,
  type Graph,
  type GraphNode,
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

type ReviewOp = Extract<Op, { type: 'acceptChange' | 'revertChange' }>;
type BaselineResult = { ok: true; graph?: Graph } | { ok: false; error: string };

const NO_CHANGES = 'There are no agent changes to review.';
const ONLY_USER_REVIEWS = 'Only you can accept or revert agent changes.';
const BASELINE_SUFFIX = '.baseline.json';

/** Whether an agent op made or touched this change (for attribution). */
function touches(op: Op, change: AgentChange): boolean {
  if (change.kind === 'node') {
    return (op.type === 'addNode' && op.node.id === change.id) || ((op.type === 'updateNode' || op.type === 'deleteNode') && op.id === change.id);
  }
  if (op.type === 'connect' || op.type === 'disconnect') return op.from === change.from && op.to === change.to;
  return op.type === 'deleteNode' && (op.id === change.from || op.id === change.to);
}

/** `node` with `source`'s content fields (absent ones removed), keeping its id, position and authorship. */
function withContentOf(node: GraphNode, source: GraphNode): GraphNode {
  const { description: _d, prompt: _p, command: _c, timeoutSec: _t, access: _a, workspace: _w, ...rest } = node;
  const optional = { description: source.description, prompt: source.prompt, command: source.command, timeoutSec: source.timeoutSec, access: source.access, workspace: source.workspace };
  return { ...rest, title: source.title, kind: source.kind, ...Object.fromEntries(Object.entries(optional).filter(([, v]) => v !== undefined)) };
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

  private baselineFile(id: string): string {
    return join(this.paths.graphsDir, `${id}${BASELINE_SUFFIX}`);
  }

  private uniqueId(name: string): string {
    const base = slugify(name);
    let id = base;
    for (let i = 2; existsSync(this.file(id)); i++) id = `${base}-${i}`;
    return id;
  }

  list(): GraphListItem[] {
    const ids = readdirSync(this.paths.graphsDir)
      .filter((f) => f.endsWith('.json') && !f.endsWith(BASELINE_SUFFIX))
      .map((f) => f.slice(0, -'.json'.length))
      .sort();
    const items = ids.map((id): GraphListItem => {
      const r = this.load(id);
      if (!r.ok) return { id, name: id, error: r.error };
      const agentChanges = this.agentChanges(id).length;
      return { id, name: r.graph.name, updatedAt: r.graph.updatedAt, ...(agentChanges > 0 && { agentChanges }) };
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

  /** Removes the graph, its agent-change baseline, its edit history and its chat. Run logs stay on disk. */
  delete(id: string): { ok: true } | { ok: false; error: string } {
    if (!isGraphId(id)) return { ok: false, error: `invalid graph id "${id}"` };
    if (!existsSync(this.file(id))) return { ok: false, error: `graph "${id}" not found` };
    for (const f of [this.file(id), this.baselineFile(id), this.opsFile(id), this.chatFile(id)]) rmSync(f, { force: true });
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

  /**
   * Applies one edit. Agent edits keep the user's graph as it was in `<id>.baseline.json` (created by
   * the first one); user edits go to the baseline too, when they fit there (agent changes spec §3.1).
   */
  apply(graphId: string, op: Op, by: Actor, source?: ChangeSource): GraphResult {
    if (op.type === 'acceptChange' || op.type === 'revertChange') {
      // Reviewing agent changes is the user's call: no agent may accept (or revert) its own.
      if (by !== 'user') return { ok: false, error: ONLY_USER_REVIEWS };
      return this.reviewOp(graphId, op);
    }
    const current = this.load(graphId);
    if (!current.ok) return current;
    const at = this.clock();
    const resolved: Op =
      op.type === 'addNode' && !op.node.id ? { ...op, node: { ...op.node, id: nextNodeId(current.graph) } } : op;
    const r = applyOp(current.graph, resolved, by, at, { rewriteReferences: renameReferences });
    if (!r.ok) return r;
    // Positions are layout, not content: moves never touch the baseline.
    if (resolved.type !== 'moveNode') {
      const base = this.baseline(graphId);
      if (by === 'agent' && base.ok && !base.graph) this.writeBaseline(current.graph);
      if (by === 'user' && base.ok && base.graph) {
        // An edit that doesn't fit the baseline (renaming a step an agent added) leaves it as it is.
        const mirrored = applyOp(base.graph, resolved, 'user', at, { rewriteReferences: renameReferences });
        if (mirrored.ok) this.writeBaseline(mirrored.graph);
      }
    }
    this.save(r.graph);
    if (resolved.type !== 'moveNode') {
      this.dropBaselineIfSame(r.graph);
      this.record(graphId, { at, by, op: resolved, ...(source && { source }) });
    }
    this.emit('changed', r.graph);
    this.emit('op', graphId, resolved);
    return r;
  }

  /** The user's graph before pending agent changes: none when the file is absent. */
  baseline(id: string): BaselineResult {
    if (!isGraphId(id)) return { ok: true };
    const file = this.baselineFile(id);
    if (!existsSync(file)) return { ok: true };
    let r: GraphResult;
    try {
      r = parseGraph(JSON.parse(readFileSync(file, 'utf8')));
    } catch (e) {
      r = { ok: false, error: (e as Error).message };
    }
    if (!r.ok) return { ok: false, error: `The agent-change baseline ${file} could not be read (${r.error}).` };
    return { ok: true, graph: { ...r.graph, id } };
  }

  /** What agents changed since the baseline, each attributed to the latest agent op that touched it. */
  agentChanges(id: string): AgentChange[] {
    const base = this.baseline(id);
    if (!base.ok || !base.graph) return [];
    const current = this.load(id);
    if (!current.ok) return [];
    const changes = diffGraphs(base.graph, current.graph);
    if (changes.length === 0) return changes;
    const agentOps = this.readOps(id).filter((r) => r.by === 'agent').reverse();
    return changes.map((change) => {
      const record = agentOps.find((r) => touches(r.op, change));
      return record ? { ...change, ...(record.source && { by: record.source }), at: record.at } : change;
    });
  }

  /** Accept copies the graph's version of the target into the baseline; Revert copies the baseline's back (spec §3.4). */
  private reviewOp(graphId: string, op: ReviewOp): GraphResult {
    const current = this.load(graphId);
    if (!current.ok) return current;
    const graph = current.graph;
    const at = this.clock();
    const base = this.baseline(graphId);
    if (!base.ok) {
      if (op.type !== 'acceptChange' || op.target.kind !== 'all') return { ok: false, error: NO_CHANGES };
      // Accepting everything resolves an unreadable baseline: the graph is the user's again.
      rmSync(this.baselineFile(graphId), { force: true });
      return this.finishReview(graphId, op, graph, at);
    }
    // No baseline: nothing an agent did differs.
    if (!base.graph) return { ok: false, error: NO_CHANGES };
    const pending = pendingProblem(base.graph, graph, op.target);
    if (pending) return { ok: false, error: pending };
    const r = op.type === 'acceptChange' ? accept(base.graph, graph, op.target) : revert(base.graph, graph, op.target, at);
    if (!r.ok) return r;
    if (op.type === 'acceptChange') this.writeBaseline(r.graph);
    else this.save(r.graph);
    return this.finishReview(graphId, op, op.type === 'acceptChange' ? graph : r.graph, at);
  }

  private finishReview(graphId: string, op: ReviewOp, graph: Graph, at: string): GraphResult {
    this.dropBaselineIfSame(graph);
    this.record(graphId, { at, by: 'user', op });
    this.emit('changed', graph);
    this.emit('op', graphId, op);
    return { ok: true, graph };
  }

  private writeBaseline(graph: Graph): void {
    writeFileAtomic(this.baselineFile(graph.id), `${JSON.stringify(graph, null, 2)}\n`);
  }

  /** No differences left means no pending agent changes: the graph is its own baseline again. */
  private dropBaselineIfSame(graph: Graph): void {
    const base = this.baseline(graph.id);
    if (base.ok && base.graph && diffGraphs(base.graph, graph).length === 0) rmSync(this.baselineFile(graph.id), { force: true });
  }

  private record(graphId: string, record: OpRecord): void {
    appendFileSync(this.opsFile(graphId), `${JSON.stringify(record)}\n`);
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

const sameEnds = (a: { from: string; to: string }, b: { from: string; to: string }) => a.from === b.from && a.to === b.to;

/** The edge `id` names, from the graph or the baseline. */
function findEdge(baseline: Graph, graph: Graph, id: string) {
  return graph.edges.find((e) => e.id === id) ?? baseline.edges.find((e) => e.id === id);
}

/** Why `target` can't be reviewed: it doesn't exist, or no agent changed it. Null when it has a pending change. */
function pendingProblem(baseline: Graph, graph: Graph, target: ChangeTarget): string | null {
  const changes = diffGraphs(baseline, graph);
  if (target.kind === 'all') return changes.length ? null : NO_CHANGES;
  if (target.kind === 'node') {
    if (!graph.nodes.some((n) => n.id === target.id) && !baseline.nodes.some((n) => n.id === target.id)) return `node ${target.id} does not exist`;
    return changes.some((c) => c.kind === 'node' && c.id === target.id) ? null : NO_CHANGES;
  }
  const edge = findEdge(baseline, graph, target.id);
  if (!edge) return `edge ${target.id} does not exist`;
  return changes.some((c) => c.kind === 'edge' && sameEnds(c, edge)) ? null : NO_CHANGES;
}

/** Validated like a graph file, so a result with a cycle or a dangling edge is refused. */
function checked(graph: Graph): GraphResult {
  const r = parseGraph(graph);
  return r.ok ? { ok: true, graph: { ...r.graph, id: graph.id } } : r;
}

/** The new baseline: the graph's version of the target. */
function accept(baseline: Graph, graph: Graph, target: ChangeTarget): GraphResult {
  if (target.kind === 'all') return { ok: true, graph: { ...graph } };
  if (target.kind === 'node') {
    const node = graph.nodes.find((n) => n.id === target.id);
    const had = baseline.nodes.some((n) => n.id === target.id);
    if (!node && !had) return { ok: false, error: `node ${target.id} does not exist` };
    if (!node) {
      return checked({
        ...baseline,
        nodes: baseline.nodes.filter((n) => n.id !== target.id),
        edges: baseline.edges.filter((e) => e.from !== target.id && e.to !== target.id),
      });
    }
    const nodes = had ? baseline.nodes.map((n) => (n.id === target.id ? node : n)) : [...baseline.nodes, node];
    return checked({ ...baseline, nodes, nodeSeq: Math.max(baseline.nodeSeq, graph.nodeSeq) });
  }
  const edge = findEdge(baseline, graph, target.id);
  if (!edge) return { ok: false, error: `edge ${target.id} does not exist` };
  const inGraph = graph.edges.find((e) => sameEnds(e, edge));
  const edges = baseline.edges.filter((e) => !sameEnds(e, edge));
  return checked({ ...baseline, edges: inGraph ? [...edges, inGraph] : edges });
}

/** The new graph: the baseline's version of the target, keeping where steps are on the canvas. */
function revert(baseline: Graph, graph: Graph, target: ChangeTarget, at: string): GraphResult {
  const nodeSeq = Math.max(baseline.nodeSeq, graph.nodeSeq);
  if (target.kind === 'all') {
    const position = new Map(graph.nodes.map((n) => [n.id, n.position]));
    const nodes = baseline.nodes.map((n) => {
      const p = position.get(n.id);
      return position.has(n.id) ? (p ? { ...n, position: p } : withoutPosition(n)) : n;
    });
    return checked({ ...baseline, id: graph.id, name: graph.name, nodes, nodeSeq, updatedAt: at });
  }
  if (target.kind === 'node') {
    const before = baseline.nodes.find((n) => n.id === target.id);
    const node = graph.nodes.find((n) => n.id === target.id);
    if (!before && !node) return { ok: false, error: `node ${target.id} does not exist` };
    if (!before) {
      // An added step goes, with its connections (none of them can be in the baseline).
      return checked({
        ...graph,
        nodes: graph.nodes.filter((n) => n.id !== target.id),
        edges: graph.edges.filter((e) => e.from !== target.id && e.to !== target.id),
        updatedAt: at,
      });
    }
    if (!node) {
      const nodes = [...graph.nodes, before];
      const ids = new Set(nodes.map((n) => n.id));
      const restored = baseline.edges.filter(
        (e) => (e.from === target.id || e.to === target.id) && ids.has(e.from) && ids.has(e.to) && !graph.edges.some((g) => sameEnds(g, e)),
      );
      return checked({ ...graph, nodes, edges: [...graph.edges, ...restored], nodeSeq, updatedAt: at });
    }
    const restored: GraphNode = { ...withContentOf(node, before), updatedBy: 'user', updatedAt: at };
    return checked({ ...graph, nodes: graph.nodes.map((n) => (n.id === target.id ? restored : n)), updatedAt: at });
  }
  const edge = findEdge(baseline, graph, target.id);
  if (!edge) return { ok: false, error: `edge ${target.id} does not exist` };
  const wasThere = baseline.edges.some((e) => sameEnds(e, edge));
  const edges = graph.edges.filter((e) => !sameEnds(e, edge));
  return checked({ ...graph, edges: wasThere ? [...edges, { id: edgeId(edge.from, edge.to), from: edge.from, to: edge.to }] : edges, updatedAt: at });
}

function withoutPosition(node: GraphNode): GraphNode {
  const { position: _position, ...rest } = node;
  return rest;
}
