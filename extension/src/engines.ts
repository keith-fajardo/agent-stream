import { join } from 'node:path';
import {
  createApp as realCreateApp,
  createClaudeProvider,
  createCodexProvider,
  createRunShell,
  createWriteLeases,
  findClaude as realFindClaude,
  findCodex as realFindCodex,
  findGitBash as realFindGitBash,
  legacyValuesFileFor,
  valuesFileFor,
  type AgentProvider,
  type App,
  type Found,
  type GitExec,
  type WriteLeases,
} from '@agent-stream/engine';
import type { ApprovalRequest, GraphListItem, ProviderId, ProviderStatus, ServerMessage, SessionListItem } from '@agent-stream/shared';
import { createCopilotProvider, type LmAccess } from './providers/copilot';
import { parseProviderSetting } from './providers/registry';
import type { Settings } from './settings';

/** A workspace folder: `key` is its URI string, `path` its file-system path. */
export type Folder = { key: string; name: string; path: string };
export type FolderApproval = { folder: Folder; request: ApprovalRequest };

export type EngineEvents = {
  graphs(folder: Folder, graphs: GraphListItem[]): void;
  approvals(): void;
  confirmRun(folder: Folder, graphId: string, fromNodeId?: string, sourceRunId?: string, requestedBy?: 'planner'): void;
  graphDeleted(folder: Folder, graphId: string): void;
  /** A folder's work sessions: sent on connect and after every change. */
  sessions(folder: Folder, sessions: SessionListItem[]): void;
  auth(status: ProviderStatus): void;
  warning(message: string): void;
};

export type EngineManagerDeps = {
  settings: () => Settings;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  home: string;
  /** Runs git: realGit in VS Code, a fake in tests. */
  git: GitExec;
  events: EngineEvents;
  checkAuth?: (claudePath: string) => Promise<ProviderStatus>;
  findClaude?: typeof realFindClaude;
  findCodex?: typeof realFindCodex;
  findGitBash?: typeof realFindGitBash;
  /** context.languageModelAccessInformation: whether Copilot requests need the user's consent first. */
  languageModelAccess?: LmAccess;
  createApp?: typeof realCreateApp;
  /** Test seam: how each provider is built. */
  providers?: Partial<Record<ProviderId, () => AgentProvider>>;
};

export const CHECKING_LABEL = 'checking';
export const checkingStatus = (p: { id: ProviderId; name: string }): ProviderStatus => ({ provider: p.id, ok: false, label: CHECKING_LABEL, error: `Checking ${p.name}…` });
export const isChecking = (s: ProviderStatus): boolean => !s.ok && s.label === CHECKING_LABEL;

type Entry = { folder: Folder; app: App; detach: () => void };

/** One engine per workspace folder (spec §3.2), all sharing the provider named in the settings and its status check. */
export class EngineManager {
  private engines = new Map<string, Entry>();
  status: ProviderStatus;
  private providers = new Map<ProviderId, AgentProvider>();
  private reportedWarning: string | undefined;
  private checkSeq = 0;
  private latest: Promise<ProviderStatus> | undefined;
  /**
   * The extension host's one lease store (spec §4.2), shared by every folder's engine. A second store in this
   * process would take the first one's live locks (same pid) for stale, so only the manager creates it.
   */
  private readonly leases: WriteLeases;

  constructor(private d: EngineManagerDeps) {
    this.leases = createWriteLeases({ locksDir: join(d.home, '.agent-stream', 'locks') });
    this.status = checkingStatus(this.providerFor('claude'));
  }

  /** Windows: Git Bash for Copilot's Bash tool, found as for command steps; none is needed elsewhere. */
  private gitBashPath(): string | undefined {
    if (this.d.platform !== 'win32') return undefined;
    const found = (this.d.findGitBash ?? realFindGitBash)({ env: this.d.env, setting: this.d.settings().gitBashPath });
    return found.ok ? found.path : undefined;
  }

  /** Built once per id and kept, so a provider's session state survives switching away and back. */
  providerFor(id: ProviderId): AgentProvider {
    let p = this.providers.get(id);
    if (!p) {
      const d = this.d;
      const build: Record<ProviderId, () => AgentProvider> = {
        claude: () =>
          createClaudeProvider({
            findClaude: () => (d.findClaude ?? realFindClaude)({ platform: d.platform, env: d.env, home: d.home, setting: d.settings().claudePath }),
            checkAuth: d.checkAuth,
          }),
        copilot: () =>
          createCopilotProvider({
            access: d.languageModelAccess,
            // Built per command, so a changed agentStream.gitBashPath reaches the next Bash call (Git Bash as for command steps).
            runShell: (o) => createRunShell({ platform: d.platform, env: d.env, gitBashPath: this.gitBashPath() })(o),
            limits: () => {
              const s = d.settings();
              return { maxRequestsPerStep: s.copilotMaxRequestsPerStep, maxRequestsPerTurn: s.copilotMaxRequestsPerTurn };
            },
          }),
        codex: () =>
          createCodexProvider({
            // Found per status check, so a changed agentStream.codexPath is used from the next check on.
            findCodex: () => (d.findCodex ?? realFindCodex)({ platform: d.platform, env: d.env, home: d.home, setting: d.settings().codexPath }),
            env: d.env,
            platform: d.platform,
          }),
        ...d.providers,
      };
      p = build[id]();
      this.providers.set(id, p);
    }
    return p;
  }

  /** The provider the setting names; an unknown value falls back to Claude and is reported once. */
  currentProvider(): AgentProvider {
    const { id, warning } = parseProviderSetting(this.d.settings().provider);
    if (warning !== undefined && warning !== this.reportedWarning) this.d.events.warning(warning);
    this.reportedWarning = warning;
    return this.providerFor(id);
  }

  /** Asks the provider for its status (Claude: finds Claude Code, runs `claude auth status`); every engine gets the result. */
  async checkProvider(): Promise<ProviderStatus> {
    const seq = ++this.checkSeq;
    const p = this.currentProvider();
    this.status = checkingStatus(p);
    this.d.events.auth(this.status);
    const run = this.runCheck(seq, p);
    this.latest = run;
    return run;
  }

  /** A check that a newer one overtook is dropped: it returns the newer result and changes nothing. */
  private async runCheck(seq: number, provider: AgentProvider): Promise<ProviderStatus> {
    const status = await provider.status();
    if (seq !== this.checkSeq) return this.latest ?? status;
    this.status = status;
    for (const e of this.engines.values()) e.app.setProvider(provider, this.folderStatus(e.folder));
    this.d.events.auth(this.status);
    return this.status;
  }

  /** A folder the provider can't use there (Claude: project settings that reroute it away from the subscription) is disabled on its own. */
  folderStatus(folder: Folder): ProviderStatus {
    if (!this.status.ok) return this.status;
    const problem = this.currentProvider().folderProblem?.(folder.path);
    return problem ? { ...this.status, ok: false, error: problem } : this.status;
  }

  /** Whether this folder already has a running engine (`get` would create one). */
  has(folderKey: string): boolean {
    return this.engines.has(folderKey);
  }

  get(folder: Folder): App {
    const existing = this.engines.get(folder.key);
    if (existing) return existing.app;
    const settings = this.d.settings();
    const gitBash: Found | undefined = this.d.platform === 'win32' ? (this.d.findGitBash ?? realFindGitBash)({ env: this.d.env, setting: settings.gitBashPath }) : undefined;
    const app = (this.d.createApp ?? realCreateApp)({
      projectDir: folder.path,
      provider: this.currentProvider(),
      status: this.folderStatus(folder),
      maxParallel: settings.maxParallel,
      platform: this.d.platform,
      gitBash,
      valuesFile: valuesFileFor(folder.path, this.d.home),
      legacyValuesFile: legacyValuesFileFor(folder.path, this.d.home),
      leases: this.leases,
      git: this.d.git,
      home: this.d.home,
      // Read when a run starts and per planner turn, so a settings change reaches the next one.
      modelDefaults: () => {
        const { model, effort } = this.d.settings();
        return { ...(model && { model }), ...(effort && { effort }) };
      },
    });
    // Registered before connecting: `hello` arrives synchronously and listeners may call get() again.
    const entry: Entry = { folder, app, detach: () => {} };
    this.engines.set(folder.key, entry);
    entry.detach = app.connect({ send: (msg) => this.observe(folder, msg) });
    for (const warning of app.startupWarnings()) this.d.events.warning(warning);
    return app;
  }

  /** The settings' default model or effort changed: every engine's chats update their Default menus. */
  modelDefaultsChanged(): void {
    for (const e of this.engines.values()) e.app.modelDefaultsChanged();
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
        return this.d.events.confirmRun(folder, msg.graphId, msg.fromNodeId, msg.sourceRunId, msg.requestedBy);
      case 'graphDeleted':
        return this.d.events.graphDeleted(folder, msg.graphId);
      case 'sessions':
        return this.d.events.sessions(folder, msg.sessions);
    }
  }
}
