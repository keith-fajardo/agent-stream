import { EventEmitter } from 'node:events';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { Session, SessionListItem, SessionPlannerState, SessionResult, SessionTab } from '@agent-stream/shared';
import { ChatLog } from './chatLog';
import { systemClock, type Clock } from './clock';
import { writeFileAtomic } from './fsutil';
import { slugify } from './graphStore';
import { isGraphId, isSessionId, type ProjectPaths } from './paths';

export const DEFAULT_SESSION_ID = 'default';

const sessionSchema = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  tabs: z.array(z.object({ graphId: z.string(), group: z.number().int().min(1).max(9), index: z.number().int().min(0) })),
  activeGraphId: z.string().optional(),
  planner: z.record(z.string(), z.object({ sessionId: z.string().optional(), provider: z.enum(['claude', 'copilot']).optional(), opCursor: z.number().int().nonnegative().optional() })),
});

/** Personal work sessions (sessions spec §3): one folder each, git-ignored. Events: 'changed'. */
export class SessionStore extends EventEmitter {
  constructor(
    private paths: ProjectPaths,
    private clock: Clock = systemClock,
  ) {
    super();
  }

  private dir(id: string): string {
    return join(this.paths.sessionsDir, id);
  }
  private file(id: string): string {
    return join(this.dir(id), 'session.json');
  }

  list(): SessionListItem[] {
    if (!existsSync(this.paths.sessionsDir)) return [];
    const items = readdirSync(this.paths.sessionsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && isSessionId(d.name))
      .map((d): SessionListItem => {
        const r = this.load(d.name);
        return r.ok ? { id: r.session.id, name: r.session.name, updatedAt: r.session.updatedAt, tabCount: r.session.tabs.length } : { id: d.name, name: d.name, tabCount: 0, problem: r.error };
      });
    return items.sort((a, b) => Number(!!a.problem) - Number(!!b.problem) || (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '') || a.name.localeCompare(b.name));
  }

  load(id: string): SessionResult {
    if (!isSessionId(id)) return { ok: false, error: `invalid session id "${id}"` };
    if (!existsSync(this.file(id))) return { ok: false, error: `session "${id}" not found` };
    try {
      const parsed = sessionSchema.safeParse(JSON.parse(readFileSync(this.file(id), 'utf8')));
      if (!parsed.success) return { ok: false, error: `session.json is invalid: ${z.prettifyError(parsed.error)}` };
      return { ok: true, session: { ...parsed.data, id } as Session };
    } catch (e) {
      return { ok: false, error: `session.json is not valid JSON (${(e as Error).message})` };
    }
  }

  get(id: string): Session {
    const r = this.load(id);
    if (!r.ok) throw new Error(r.error);
    return r.session;
  }

  private save(session: Session): void {
    mkdirSync(this.dir(session.id), { recursive: true });
    writeFileAtomic(this.file(session.id), `${JSON.stringify(session, null, 2)}\n`);
  }

  private uniqueId(name: string): string {
    const base = slugify(name) === 'graph' ? 'session' : slugify(name);
    let id = base;
    for (let i = 2; existsSync(this.dir(id)); i++) id = `${base}-${i}`;
    return id;
  }

  create(name: string, id?: string): Session {
    const trimmed = name.trim();
    if (!trimmed) throw new Error('A session needs a name.');
    const at = this.clock();
    const session: Session = { id: id ?? this.uniqueId(trimmed), name: trimmed, createdAt: at, updatedAt: at, tabs: [], planner: {} };
    this.save(session);
    this.emit('changed');
    return session;
  }

  ensureDefault(): Session {
    const r = this.load(DEFAULT_SESSION_ID);
    return r.ok ? r.session : this.create('Default', DEFAULT_SESSION_ID);
  }

  rename(id: string, name: string): SessionResult {
    const r = this.load(id);
    if (!r.ok) return r;
    if (!name.trim()) return { ok: false, error: 'A session needs a name.' };
    const session = { ...r.session, name: name.trim(), updatedAt: this.clock() };
    this.save(session);
    this.emit('changed');
    return { ok: true, session };
  }

  duplicate(id: string): SessionResult {
    const r = this.load(id);
    if (!r.ok) return r;
    const names = new Set(this.list().map((s) => s.name));
    let name = `${r.session.name} copy`;
    for (let i = 2; names.has(name); i++) name = `${r.session.name} copy ${i}`;
    const copy = this.create(name);
    const session = { ...copy, tabs: r.session.tabs, ...(r.session.activeGraphId && { activeGraphId: r.session.activeGraphId }) };
    this.save(session);
    return { ok: true, session };
  }

  delete(id: string): { ok: true } | { ok: false; error: string } {
    if (!isSessionId(id)) return { ok: false, error: `invalid session id "${id}"` };
    if (!existsSync(this.dir(id))) return { ok: false, error: `session "${id}" not found` };
    rmSync(this.dir(id), { recursive: true, force: true });
    this.emit('changed');
    return { ok: true };
  }

  /** Records a session's graph tabs; an unreadable session is left untouched. */
  saveTabs(id: string, tabs: SessionTab[], activeGraphId?: string): void {
    const r = this.load(id);
    if (!r.ok) return;
    const same = JSON.stringify(r.session.tabs) === JSON.stringify(tabs) && r.session.activeGraphId === activeGraphId;
    if (same) return;
    const { activeGraphId: _old, ...rest } = r.session;
    this.save({ ...rest, tabs, ...(activeGraphId && { activeGraphId }), updatedAt: this.clock() });
    this.emit('changed');
  }

  plannerState(id: string, graphId: string): SessionPlannerState {
    const r = this.load(id);
    return r.ok ? (r.session.planner[graphId] ?? {}) : {};
  }

  setPlannerState(id: string, graphId: string, patch: SessionPlannerState): void {
    const session = this.get(id);
    const next = { ...session.planner[graphId], ...patch };
    for (const k of Object.keys(next) as (keyof SessionPlannerState)[]) if (next[k] === undefined) delete next[k];
    this.save({ ...session, planner: { ...session.planner, [graphId]: next } });
  }

  /** "New chat": forget this graph's conversation in this session. */
  clearPlanner(id: string, graphId: string): void {
    const session = this.get(id);
    const { [graphId]: _gone, ...planner } = session.planner;
    this.save({ ...session, planner });
    this.chatLog(id).clear(graphId);
  }

  chatLog(id: string): ChatLog {
    if (!isSessionId(id)) throw new Error(`invalid session id "${id}"`);
    return new ChatLog(join(this.dir(id), 'chats'));
  }

  removeGraph(graphId: string): void {
    if (!isGraphId(graphId)) return;
    for (const item of this.list()) {
      if (item.problem) continue;
      const s = this.get(item.id);
      const tabs = s.tabs.filter((t) => t.graphId !== graphId);
      const groups = new Map<number, number>();
      const reindexed = tabs.map((t) => {
        const index = groups.get(t.group) ?? 0;
        groups.set(t.group, index + 1);
        return { ...t, index };
      });
      const { [graphId]: _gone, ...planner } = s.planner;
      const { activeGraphId, ...rest } = s;
      this.save({ ...rest, tabs: reindexed, planner, ...(activeGraphId && activeGraphId !== graphId && { activeGraphId }) });
      this.chatLog(s.id).clear(graphId);
    }
    this.emit('changed');
  }
}

export type MigrationIo = { writeGraph: (path: string, content: string) => void };

/**
 * Moves pre-sessions planner state (graph-file fields) and chats (graphs/<id>.chat.jsonl) into
 * the Default session (sessions spec §3.3). Idempotent and resumable; failures become warnings.
 */
export function migrateLegacy(paths: ProjectPaths, store: SessionStore, io: MigrationIo = { writeGraph: writeFileAtomic }): string[] {
  const warnings: string[] = [];
  if (!existsSync(paths.graphsDir)) return warnings;
  store.ensureDefault();
  const ids = readdirSync(paths.graphsDir)
    .filter((f) => f.endsWith('.json') && !f.endsWith('.chat.jsonl') && !f.endsWith('.ops.jsonl'))
    .map((f) => f.slice(0, -'.json'.length))
    .filter(isGraphId);
  for (const id of ids) {
    try {
      const legacyChat = join(paths.graphsDir, `${id}.chat.jsonl`);
      if (existsSync(legacyChat)) {
        const dest = join(paths.sessionsDir, DEFAULT_SESSION_ID, 'chats', `${id}.chat.jsonl`);
        mkdirSync(join(paths.sessionsDir, DEFAULT_SESSION_ID, 'chats'), { recursive: true });
        if (!existsSync(dest)) renameSync(legacyChat, dest);
        else {
          writeFileAtomic(dest, readFileSync(legacyChat, 'utf8') + readFileSync(dest, 'utf8'));
          rmSync(legacyChat, { force: true });
        }
      }
      const graphFile = join(paths.graphsDir, `${id}.json`);
      const raw = JSON.parse(readFileSync(graphFile, 'utf8')) as Record<string, unknown>;
      if (!('plannerSessionId' in raw) && !('plannerOpCursor' in raw)) continue;
      const existing = store.plannerState(DEFAULT_SESSION_ID, id);
      if (existing.sessionId === undefined && existing.opCursor === undefined) {
        store.setPlannerState(DEFAULT_SESSION_ID, id, {
          ...(typeof raw.plannerSessionId === 'string' && { sessionId: raw.plannerSessionId }),
          provider: 'claude',
          ...(typeof raw.plannerOpCursor === 'number' && { opCursor: raw.plannerOpCursor }),
        });
      }
      const { plannerSessionId: _s, plannerOpCursor: _c, ...definition } = raw;
      io.writeGraph(graphFile, `${JSON.stringify(definition, null, 2)}\n`);
    } catch (e) {
      warnings.push(`Could not move the planner conversation of graph ${id} into the Default session (${(e as Error).message}); it stays where it is and will be retried next time.`);
    }
  }
  return warnings;
}
