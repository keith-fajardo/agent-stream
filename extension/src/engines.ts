import {
  checkAuth as realCheckAuth,
  createApp as realCreateApp,
  findClaude as realFindClaude,
  findGitBash as realFindGitBash,
  projectSettingsProblem,
  legacyValuesFileFor,
  valuesFileFor,
  type App,
  type Found,
} from '@agent-stream/engine';
import type { ApprovalRequest, AuthInfo, GraphListItem, ServerMessage } from '@agent-stream/shared';
import type { Settings } from './settings';

/** A workspace folder: `key` is its URI string, `path` its file-system path. */
export type Folder = { key: string; name: string; path: string };
export type FolderApproval = { folder: Folder; request: ApprovalRequest };

export type EngineEvents = {
  graphs(folder: Folder, graphs: GraphListItem[]): void;
  approvals(): void;
  confirmRun(folder: Folder, graphId: string, fromNodeId?: string, sourceRunId?: string): void;
  graphDeleted(folder: Folder, graphId: string): void;
  auth(auth: AuthInfo): void;
  warning(message: string): void;
};

export type EngineManagerDeps = {
  settings: () => Settings;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  home: string;
  events: EngineEvents;
  checkAuth?: (claudePath: string) => Promise<AuthInfo>;
  findClaude?: typeof realFindClaude;
  findGitBash?: typeof realFindGitBash;
  createApp?: typeof realCreateApp;
};

export const CHECKING: AuthInfo = { ok: false, error: 'Checking your Claude sign-in…' };

type Entry = { folder: Folder; app: App; detach: () => void };

/** One engine per workspace folder (spec §3.2), all sharing one sign-in check. */
export class EngineManager {
  private engines = new Map<string, Entry>();
  auth: AuthInfo = CHECKING;
  private claudePath: string | undefined;
  private checkSeq = 0;
  private latest: Promise<AuthInfo> | undefined;

  constructor(private d: EngineManagerDeps) {}

  /** Finds Claude Code and runs `claude auth status`; every engine gets the result (and the path, ruling R6). */
  async checkSignIn(): Promise<AuthInfo> {
    const seq = ++this.checkSeq;
    const run = this.runCheck(seq);
    this.latest = run;
    return run;
  }

  /** A check that a newer one overtook is dropped: it returns the newer result and changes nothing. */
  private async runCheck(seq: number): Promise<AuthInfo> {
    const settings = this.d.settings();
    const found = (this.d.findClaude ?? realFindClaude)({ platform: this.d.platform, env: this.d.env, home: this.d.home, setting: settings.claudePath });
    let auth: AuthInfo;
    let claudePath: string | undefined;
    if (found.ok) {
      claudePath = found.path;
      auth = await (this.d.checkAuth ?? realCheckAuth)(found.path);
    } else {
      auth = { ok: false, error: found.error };
    }
    if (seq !== this.checkSeq) return this.latest ?? auth;
    this.claudePath = claudePath;
    this.auth = auth;
    for (const e of this.engines.values()) e.app.setAuth(this.folderAuth(e.folder), this.claudePath);
    this.d.events.auth(this.auth);
    return this.auth;
  }

  /** A project setting that reroutes Claude away from the subscription disables that folder only. */
  folderAuth(folder: Folder): AuthInfo {
    if (!this.auth.ok) return this.auth;
    const problem = projectSettingsProblem(folder.path);
    return problem ? { ...this.auth, ok: false, error: problem } : this.auth;
  }

  get(folder: Folder): App {
    const existing = this.engines.get(folder.key);
    if (existing) return existing.app;
    const settings = this.d.settings();
    const gitBash: Found | undefined = this.d.platform === 'win32' ? (this.d.findGitBash ?? realFindGitBash)({ env: this.d.env, setting: settings.gitBashPath }) : undefined;
    const app = (this.d.createApp ?? realCreateApp)({
      projectDir: folder.path,
      claudePath: this.claudePath ?? 'claude',
      auth: this.folderAuth(folder),
      maxParallel: settings.maxParallel,
      platform: this.d.platform,
      gitBash,
      valuesFile: valuesFileFor(folder.path, this.d.home),
      legacyValuesFile: legacyValuesFileFor(folder.path, this.d.home),
    });
    // Registered before connecting: `hello` arrives synchronously and listeners may call get() again.
    const entry: Entry = { folder, app, detach: () => {} };
    this.engines.set(folder.key, entry);
    entry.detach = app.connect({ send: (msg) => this.observe(folder, msg) });
    for (const warning of app.startupWarnings()) this.d.events.warning(warning);
    return app;
  }

  approvals(): FolderApproval[] {
    return [...this.engines.values()].flatMap((e) => e.app.broker.pending().map((request) => ({ folder: e.folder, request })));
  }

  remove(key: string): void {
    const e = this.engines.get(key);
    if (!e) return;
    e.detach();
    e.app.dispose();
    this.engines.delete(key);
  }

  dispose(): void {
    for (const key of [...this.engines.keys()]) this.remove(key);
  }

  private observe(folder: Folder, msg: ServerMessage): void {
    switch (msg.type) {
      case 'hello':
      case 'graphs':
        return this.d.events.graphs(folder, msg.graphs);
      case 'approvals':
        return this.d.events.approvals();
      case 'confirmRun':
        return this.d.events.confirmRun(folder, msg.graphId, msg.fromNodeId, msg.sourceRunId);
      case 'graphDeleted':
        return this.d.events.graphDeleted(folder, msg.graphId);
    }
  }
}
