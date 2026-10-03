import {
  createApp as realCreateApp,
  createClaudeProvider,
  findClaude as realFindClaude,
  findGitBash as realFindGitBash,
  legacyValuesFileFor,
  valuesFileFor,
  type AgentProvider,
  type App,
  type Found,
} from '@agent-stream/engine';
import type { ApprovalRequest, GraphListItem, ProviderStatus, ServerMessage } from '@agent-stream/shared';
import type { Settings } from './settings';

/** A workspace folder: `key` is its URI string, `path` its file-system path. */
export type Folder = { key: string; name: string; path: string };
export type FolderApproval = { folder: Folder; request: ApprovalRequest };

export type EngineEvents = {
  graphs(folder: Folder, graphs: GraphListItem[]): void;
  approvals(): void;
  confirmRun(folder: Folder, graphId: string, fromNodeId?: string, sourceRunId?: string): void;
  graphDeleted(folder: Folder, graphId: string): void;
  auth(status: ProviderStatus): void;
  warning(message: string): void;
};

export type EngineManagerDeps = {
  settings: () => Settings;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  home: string;
  events: EngineEvents;
  checkAuth?: (claudePath: string) => Promise<ProviderStatus>;
  findClaude?: typeof realFindClaude;
  findGitBash?: typeof realFindGitBash;
  createApp?: typeof realCreateApp;
};

export const CHECKING: ProviderStatus = { provider: 'claude', ok: false, label: 'checking', error: 'Checking your Claude sign-in…' };

type Entry = { folder: Folder; app: App; detach: () => void };

/** One engine per workspace folder (spec §3.2), all sharing one provider and its sign-in check. */
export class EngineManager {
  private engines = new Map<string, Entry>();
  status: ProviderStatus = CHECKING;
  private provider: AgentProvider;
  private checkSeq = 0;
  private latest: Promise<ProviderStatus> | undefined;

  constructor(private d: EngineManagerDeps) {
    this.provider = createClaudeProvider({
      findClaude: () => (d.findClaude ?? realFindClaude)({ platform: d.platform, env: d.env, home: d.home, setting: d.settings().claudePath }),
      checkAuth: d.checkAuth,
    });
  }

  /** Asks the provider for its status (Claude: finds Claude Code, runs `claude auth status`); every engine gets the result. */
  async checkSignIn(): Promise<ProviderStatus> {
    const seq = ++this.checkSeq;
    const run = this.runCheck(seq);
    this.latest = run;
    return run;
  }

  /** A check that a newer one overtook is dropped: it returns the newer result and changes nothing. */
  private async runCheck(seq: number): Promise<ProviderStatus> {
    const status = await this.provider.status();
    if (seq !== this.checkSeq) return this.latest ?? status;
    this.status = status;
    for (const e of this.engines.values()) e.app.setProvider(this.provider, this.folderStatus(e.folder));
    this.d.events.auth(this.status);
    return this.status;
  }

  /** A folder the provider can't use there (Claude: project settings that reroute it away from the subscription) is disabled on its own. */
  folderStatus(folder: Folder): ProviderStatus {
    if (!this.status.ok) return this.status;
    const problem = this.provider.folderProblem?.(folder.path);
    return problem ? { ...this.status, ok: false, error: problem } : this.status;
  }

  get(folder: Folder): App {
    const existing = this.engines.get(folder.key);
    if (existing) return existing.app;
    const settings = this.d.settings();
    const gitBash: Found | undefined = this.d.platform === 'win32' ? (this.d.findGitBash ?? realFindGitBash)({ env: this.d.env, setting: settings.gitBashPath }) : undefined;
    const app = (this.d.createApp ?? realCreateApp)({
      projectDir: folder.path,
      provider: this.provider,
      status: this.folderStatus(folder),
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
