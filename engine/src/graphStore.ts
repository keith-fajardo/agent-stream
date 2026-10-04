import { EventEmitter } from 'node:events';
import { appendFileSync, existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  applyOp,
  canonicalGraph,
  diffGraphs,
  edgeId,
  emptyGraph,
  formatFileErrors,
  graphFromDoc,
  legacyGraphForMarkdown,
  MAX_IMPORT_CHARS,
  nextNodeId,
  parseExportFile,
  parseGraph,
  parseGraphMarkdown,
  parseGraphMeta,
  serializeGraphMarkdown,
  serializeGraphMeta,
  type Actor,
  type AgentChange,
  type ChangeSource,
  type ChangeTarget,
  type Graph,
  type GraphFileError,
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

/** A file's modification time and size: a cached graph is valid while both of its files keep theirs. */
type Stamp = { mtimeMs: number; size: number };
/** A graph as last read or written, with the exact text of its two files. */
type Cached = { graph: Graph; text: string; metaText?: string; md: Stamp; meta?: Stamp };

function stampOf(path: string): Stamp | undefined {
  const s = statSync(path, { throwIfNoEntry: false });
  return s && { mtimeMs: s.mtimeMs, size: s.size };
}
const sameStamp = (a: Stamp | undefined, b: Stamp | undefined) => a?.mtimeMs === b?.mtimeMs && a?.size === b?.size;
const readIfExists = (path: string): string | undefined => (existsSync(path) ? readFileSync(path, 'utf8') : undefined);

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

/**
 * Single source of truth for graphs. Every change goes through `apply`. A graph is two files (Markdown graph files spec
 * §5.1): `<id>.md`, its meaning, and `<id>.meta.json`, positions and bookkeeping.
 */
export class GraphStore extends EventEmitter {
  private cache = new Map<string, Cached>();
  /** Markdown files that didn't parse, so an unchanged broken file isn't read again on every list. */
  private failed = new Map<string, { md: Stamp; meta?: Stamp; error: string }>();
  /** The problems in each graph's Markdown file. */
  private errors = new Map<string, GraphFileError[]>();

  constructor(
    private paths: ProjectPaths,
    private clock: Clock = systemClock,
  ) {
    super();
  }

  private file(id: string): string {
    return join(this.paths.graphsDir, `${id}.md`);
  }

  private metaFile(id: string): string {
    return join(this.paths.graphsDir, `${id}.meta.json`);
  }

  /** A graph file from before Markdown, not converted yet: its id stays taken. */
  private legacyFile(id: string): string {
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
    for (let i = 2; existsSync(this.file(id)) || existsSync(this.legacyFile(id)); i++) id = `${base}-${i}`;
    return id;
  }

  list(): GraphListItem[] {
    const ids = readdirSync(this.paths.graphsDir)
      .filter((f) => f.endsWith('.md'))
      .map((f) => f.slice(0, -'.md'.length))
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
    const md = stampOf(this.file(id));
    if (!md) {
      this.forget(id);
      return { ok: false, error: `graph "${id}" not found` };
    }
    const meta = stampOf(this.metaFile(id));
    const cached = this.cache.get(id);
    if (cached && sameStamp(cached.md, md) && sameStamp(cached.meta, meta)) return { ok: true, graph: cached.graph };
    const failed = this.failed.get(id);
    if (!cached && failed && sameStamp(failed.md, md) && sameStamp(failed.meta, meta)) return { ok: false, error: failed.error };
    // The files changed on disk (hand edit, git checkout, ...) or were never read: read them.
    return this.read(id, md, meta);
  }

  /** Reads the graph's two files. A Markdown file that doesn't parse is reported and never overwritten. */
  private read(id: string, md: Stamp, meta: Stamp | undefined): GraphResult {
    const text = readFileSync(this.file(id), 'utf8');
    const metaText = readIfExists(this.metaFile(id));
    const parsed = parseGraphMarkdown(text);
    if (!parsed.ok) {
      const error = formatFileErrors(parsed.errors);
      this.cache.delete(id);
      this.failed.set(id, { md, meta, error });
      this.setErrors(id, parsed.errors);
      return { ok: false, error };
    }
    const graph = canonicalGraph(graphFromDoc(parsed.doc, parseGraphMeta(metaText), id, this.clock()));
    this.cache.set(id, { graph, text, metaText, md, meta });
    this.failed.delete(id);
    this.setErrors(id, []);
    return { ok: true, graph };
  }

  /** Writes a graph converted from a file in the old JSON format (spec §5.2), in canonical form. */
  writeConverted(graph: Graph): Graph {
    return this.save(graph);
  }

  /** The problems in the graph's Markdown file: [] when it reads. */
  fileErrors(id: string): GraphFileError[] {
    return this.errors.get(id) ?? [];
  }

  private setErrors(id: string, errors: GraphFileError[]): void {
    if (JSON.stringify(this.errors.get(id) ?? []) === JSON.stringify(errors)) return;
    if (errors.length) this.errors.set(id, errors);
    else this.errors.delete(id);
    this.emit('fileErrors', id, errors);
  }

  /** Drops what the store remembers about a graph whose Markdown file is gone. */
  private forget(id: string): void {
    this.cache.delete(id);
    this.failed.delete(id);
    this.setErrors(id, []);
  }

  get(id: string): Graph {
    const r = this.load(id);
    if (!r.ok) throw new Error(r.error);
    return r.graph;
  }

  create(name: string): Graph {
    const id = this.uniqueId(name);
    return this.save(emptyGraph(id, name.trim() || id, this.clock()));
  }

  /** Changes the display name only; the id (file name) stays, so runs keep pointing at it. */
  rename(id: string, name: string): GraphResult {
    const trimmed = name.trim();
    if (!trimmed) return { ok: false, error: 'A graph needs a name.' };
    const r = this.load(id);
    if (!r.ok) return r;
    const graph = this.save({ ...r.graph, name: trimmed, updatedAt: this.clock() });
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
    const graph = this.save({ ...r.graph, id: this.uniqueId(name), name, updatedAt: this.clock() });
    return { ok: true, graph };
  }

  /** Removes the graph, its side file, its agent-change baseline, its edit history and its chat. Run logs stay on disk. */
  delete(id: string): { ok: true } | { ok: false; error: string } {
    if (!isGraphId(id)) return { ok: false, error: `invalid graph id "${id}"` };
    if (!existsSync(this.file(id))) return { ok: false, error: `graph "${id}" not found` };
    for (const f of [this.file(id), this.metaFile(id), this.baselineFile(id), this.opsFile(id), this.chatFile(id)]) rmSync(f, { force: true });
    this.forget(id);
    return { ok: true };
  }

  /** The graph's Markdown, as `<id>.md` (spec §5.4): the stored file's text, so never a variable value. */
  exportGraph(id: string): { ok: true; fileName: string; content: string } | { ok: false; error: string } {
    const r = this.load(id);
    if (!r.ok) return r;
    return { ok: true, fileName: `${id}.md`, content: serializeGraphMarkdown(r.graph) };
  }

  /** A graph file in the Markdown format, or an `.agent-stream.json` export (content starting with `{`), as a new graph. */
  importGraph(content: string): GraphResult {
    if (content.length > MAX_IMPORT_CHARS) return { ok: false, error: 'The file is larger than 1 MB.' };
    const text = content.replace(/^\uFEFF/, '');
    if (text.trimStart().startsWith('{')) {
      const legacy = parseExportFile(text, 'import', this.clock());
      if (!legacy.ok) return legacy;
      return { ok: true, graph: this.save(legacyGraphForMarkdown({ ...legacy.graph, id: this.uniqueId(legacy.graph.name) }).graph) };
    }
    const parsed = parseGraphMarkdown(text);
    if (!parsed.ok) return { ok: false, error: `The file is not a valid Agent Stream graph: ${formatFileErrors(parsed.errors, 3)}` };
    return { ok: true, graph: this.save(graphFromDoc(parsed.doc, undefined, this.uniqueId(parsed.doc.name), this.clock())) };
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
    const saved = this.save(r.graph);
    if (resolved.type !== 'moveNode') {
      this.dropBaselineIfSame(saved);
      this.record(graphId, { at, by, op: resolved, ...(source && { source }) });
    }
    this.emit('changed', saved);
    this.emit('op', graphId, resolved);
    return { ok: true, graph: saved };
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
    return { ok: true, graph: canonicalGraph({ ...r.graph, id }) };
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
    if (op.type === 'acceptChange') {
      this.writeBaseline(r.graph);
      return this.finishReview(graphId, op, graph, at);
    }
    return this.finishReview(graphId, op, this.save(r.graph), at);
  }

  private finishReview(graphId: string, op: ReviewOp, graph: Graph, at: string): GraphResult {
    this.dropBaselineIfSame(graph);
    this.record(graphId, { at, by: 'user', op });
    this.emit('changed', graph);
    this.emit('op', graphId, op);
    return { ok: true, graph };
  }

  private writeBaseline(graph: Graph): void {
    writeFileAtomic(this.baselineFile(graph.id), `${JSON.stringify(canonicalGraph(graph), null, 2)}\n`);
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

  /**
   * Writes the graph in canonical form (spec §4.3), each file as a temp file renamed into place: the side file first,
   * then the Markdown. A file whose text wouldn't change isn't rewritten, so a move leaves the Markdown alone.
   */
  private save(graph: Graph): Graph {
    const g = canonicalGraph(graph);
    const text = serializeGraphMarkdown(g);
    const metaText = serializeGraphMeta(g);
    const mdPath = this.file(g.id);
    const metaPath = this.metaFile(g.id);
    const cached = this.cache.get(g.id);
    if (cached?.metaText !== metaText || !existsSync(metaPath)) writeFileAtomic(metaPath, metaText);
    if (cached?.text !== text || !existsSync(mdPath)) writeFileAtomic(mdPath, text);
    this.cache.set(g.id, { graph: g, text, metaText, md: stampOf(mdPath)!, meta: stampOf(metaPath) });
    this.failed.delete(g.id);
    return g;
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
