import type { App } from '@agent-stream/engine';
import type { Folder } from './engines';

export type GraphTabInfo = { folderKey: string; graphId: string; group: number; index: number; active: boolean };
export type SessionApp = Pick<App, 'listSessions' | 'createSession' | 'renameSession' | 'duplicateSession' | 'deleteSession' | 'saveSessionTabs' | 'sessionStore' | 'listGraphs'>;
export type SessionsDeps = {
  folders(): Folder[];
  app(folder: Folder): SessionApp;
  graphTabs(): GraphTabInfo[];
  dirtyTabs(folderKey: string): number;
  closeGraphTabs(folderKey: string): Promise<void>;
  openGraphTab(folder: Folder, graphId: string, group: number, preserveFocus: boolean): Promise<void>;
  confirm(message: string, action: string): Promise<boolean>;
  info(message: string): void;
  memory: { get(key: string): string | undefined; update(key: string, value: string | undefined): PromiseLike<void> };
  changed(): void;
  hasEngine(folder: Folder): boolean;
  debounceMs?: number;
};

export const activeSessionKey = (folderKey: string) => `agentStream.activeSession:${folderKey}`;
/** The folder whose session the status bar shows: the active graph tab's, else the only folder. */
export function sessionStatusFolder(activeGraphFolder: Folder | undefined, folders: Folder[]): Folder | undefined {
  return activeGraphFolder ?? (folders.length === 1 ? folders[0] : undefined);
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** Work sessions for every folder (sessions spec §5): which one is active, its tabs, and switching. */
export class SessionManager {
  private switching = false;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private d: SessionsDeps) {}

  active(folder: Folder): { id: string; name: string } {
    const app = this.d.app(folder);
    const remembered = this.d.memory.get(activeSessionKey(folder.key));
    const hit = app.listSessions().find((s) => s.id === remembered && !s.problem);
    if (hit) return { id: hit.id, name: hit.name };
    const fresh = app.sessionStore.ensureDefault();
    return { id: fresh.id, name: fresh.name };
  }

  scheduleCapture(): void {
    if (this.switching) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.captureNow(), this.d.debounceMs ?? 500);
  }

  captureNow(): void {
    if (this.switching) return;
    clearTimeout(this.timer);
    const tabs = this.d.graphTabs();
    for (const folder of this.d.folders()) {
      const mine = tabs.filter((t) => t.folderKey === folder.key).sort((x, y) => x.group - y.group || x.index - y.index);
      const next = new Map<number, number>();
      const sessionTabs = mine.map((t) => {
        const index = next.get(t.group) ?? 0;
        next.set(t.group, index + 1);
        return { graphId: t.graphId, group: t.group, index };
      });
      if (mine.length === 0 && !this.d.hasEngine(folder)) continue;
      const app = this.d.app(folder);
      const id = this.active(folder).id;
      let activeGraphId = mine.find((t) => t.active)?.graphId;
      if (!activeGraphId) {
        const kept = app.sessionStore.load(id);
        const prev = kept.ok ? kept.session.activeGraphId : undefined;
        if (prev && mine.some((t) => t.graphId === prev)) activeGraphId = prev;
      }
      app.saveSessionTabs(id, sessionTabs, activeGraphId);
    }
  }

  async switchTo(folder: Folder, sessionId: string): Promise<boolean> {
    if (this.switching) {
      this.d.info('A session switch is already in progress.');
      return false;
    }
    const app = this.d.app(folder);
    const target = app.sessionStore.load(sessionId);
    if (!target.ok) {
      this.d.info(target.error);
      return false;
    }
    if (this.active(folder).id === sessionId) return true;
    if (!(await this.confirmDiscard(folder))) return false;
    if (this.switching) {
      this.d.info('A session switch is already in progress.');
      return false;
    }
    this.captureNow();
    this.switching = true;
    let skipped = 0;
    let failed = false;
    try {
      await this.d.closeGraphTabs(folder.key);
      await this.d.memory.update(activeSessionKey(folder.key), sessionId);
      const existing = new Set(app.listGraphs().filter((g) => !g.error).map((g) => g.id));
      const tabs = [...target.session.tabs].sort((x, y) => x.group - y.group || x.index - y.index);
      for (const t of tabs) {
        if (existing.has(t.graphId)) await this.d.openGraphTab(folder, t.graphId, t.group, true);
        else skipped++;
      }
      const focus = tabs.find((t) => t.graphId === target.session.activeGraphId && existing.has(t.graphId));
      if (focus) await this.d.openGraphTab(folder, focus.graphId, focus.group, false);
    } catch (e) {
      failed = true;
      this.d.info(`Could not switch to ${target.session.name}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      this.switching = false;
      this.d.changed();
    }
    if (failed) return false;
    if (skipped) this.d.info(`${skipped} ${plural(skipped, 'graph', 'graphs')} in this session no longer ${plural(skipped, 'exists', 'exist')} and ${plural(skipped, 'was', 'were')} skipped.`);
    this.captureNow();
    return true;
  }

  async create(folder: Folder, name: string): Promise<string | undefined> {
    const session = this.d.app(folder).createSession(name);
    return (await this.switchTo(folder, session.id)) ? session.id : undefined;
  }

  rename(folder: Folder, sessionId: string, name: string) {
    const r = this.d.app(folder).renameSession(sessionId, name);
    this.d.changed();
    return r.ok ? { ok: true as const } : r;
  }

  duplicate(folder: Folder, sessionId: string) {
    const r = this.d.app(folder).duplicateSession(sessionId);
    this.d.changed();
    return r.ok ? { ok: true as const } : r;
  }

  async delete(folder: Folder, sessionId: string): Promise<void> {
    const app = this.d.app(folder);
    const item = app.listSessions().find((s) => s.id === sessionId);
    if (!item) return;
    const moving = app.listGraphs().filter((g) => g.home === sessionId).length;
    const graphs = moving === 0 ? '' : ` ${moving} ${plural(moving, 'graph', 'graphs')} ${plural(moving, 'moves', 'move')} to Default.`;
    if (!(await this.d.confirm(`Delete ${item.name}? Its planner chats are removed; graphs and runs stay.${graphs}`, 'Delete'))) return;
    const isActive = this.active(folder).id === sessionId;
    const other = app.listSessions().find((s) => s.id !== sessionId && !s.problem);
    if (isActive && other && !(await this.switchTo(folder, other.id))) return;
    if (isActive && !other) {
      if (!(await this.confirmDiscard(folder))) return;
      this.switching = true;
      try {
        await this.d.closeGraphTabs(folder.key);
      } finally {
        this.switching = false;
      }
    }
    const r = app.deleteSession(sessionId);
    if (!r.ok) this.d.info(r.error);
    if (!app.listSessions().some((s) => !s.problem)) {
      const fresh = app.sessionStore.ensureDefault();
      await this.d.memory.update(activeSessionKey(folder.key), fresh.id);
    }
    this.d.changed();
  }

  private async confirmDiscard(folder: Folder): Promise<boolean> {
    const dirty = this.d.dirtyTabs(folder.key);
    return dirty === 0 || this.d.confirm(`Discard unsaved step edits in ${dirty} ${plural(dirty, 'tab', 'tabs')}?`, 'Discard');
  }
}
