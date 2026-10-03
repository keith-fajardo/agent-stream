import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { NodeEvent, NodeStatus, RunMeta, RunSummary } from '@agent-stream/shared';
import { readJsonLines, writeFileAtomic } from './fsutil';
import type { ProjectPaths } from './paths';

const RUN_ID_RE = /^\d{8}-\d{6}-[0-9a-f]{4}$/;
const NODE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const ACTIVE = new Set(['queued', 'running', 'waiting_approval']);
/** Status names used before the queued / not_run rename, translated when old runs are read. */
const RENAMED_STATUSES: Record<string, NodeStatus> = { pending: 'queued', skipped: 'not_run' };

export function isRunId(id: string): boolean {
  return RUN_ID_RE.test(id);
}

/** Run metadata, per-node event logs and outputs under .agent-stream/runs/<runId>/. */
export class RunStore {
  constructor(private paths: ProjectPaths) {}

  private runDir(runId: string): string {
    if (!isRunId(runId)) throw new Error(`invalid run id "${runId}"`);
    return join(this.paths.runsDir, runId);
  }

  private nodeDir(runId: string, nodeId: string): string {
    if (!NODE_ID_RE.test(nodeId)) throw new Error(`invalid node id "${nodeId}"`);
    return join(this.runDir(runId), 'nodes', nodeId);
  }

  private validIds(runId: string, nodeId: string): boolean {
    return isRunId(runId) && NODE_ID_RE.test(nodeId);
  }

  create(meta: RunMeta): void {
    mkdirSync(join(this.runDir(meta.id), 'nodes'), { recursive: true });
    this.save(meta);
  }

  save(meta: RunMeta): void {
    writeFileAtomic(join(this.runDir(meta.id), 'run.json'), `${JSON.stringify(meta, null, 2)}\n`);
  }

  get(runId: string): RunMeta | undefined {
    if (!isRunId(runId)) return undefined;
    const path = join(this.runDir(runId), 'run.json');
    if (!existsSync(path)) return undefined;
    let meta: RunMeta;
    try {
      meta = JSON.parse(readFileSync(path, 'utf8')) as RunMeta;
    } catch {
      return undefined;
    }
    for (const state of Object.values(meta.nodes ?? {})) {
      const renamed = RENAMED_STATUSES[state.status];
      if (renamed) state.status = renamed;
    }
    return meta;
  }

  /** The newest run of every graph, keyed by graph id. */
  latestByGraph(): Map<string, RunSummary> {
    const out = new Map<string, RunSummary>();
    if (!existsSync(this.paths.runsDir)) return out;
    for (const id of readdirSync(this.paths.runsDir).filter(isRunId).sort().reverse()) {
      const m = this.get(id);
      if (!m || out.has(m.graphId)) continue;
      out.set(m.graphId, { id: m.id, graphId: m.graphId, status: m.status, startedAt: m.startedAt, endedAt: m.endedAt });
    }
    return out;
  }

  list(graphId: string): RunSummary[] {
    if (!existsSync(this.paths.runsDir)) return [];
    return readdirSync(this.paths.runsDir)
      .filter(isRunId)
      .sort()
      .reverse()
      .map((id) => this.get(id))
      .filter((m): m is RunMeta => !!m && m.graphId === graphId)
      .map(({ id, graphId: g, status, startedAt, endedAt, provider, amendments, checkout, waitingFor }) => ({
        id,
        graphId: g,
        status,
        startedAt,
        endedAt,
        ...(provider && { provider }),
        ...(amendments?.length && { amendments: amendments.length }),
        ...(checkout && { checkout }),
        ...(waitingFor && { waitingFor }),
      }));
  }

  appendEvent(runId: string, nodeId: string, event: NodeEvent): void {
    const dir = this.nodeDir(runId, nodeId);
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, 'events.jsonl'), `${JSON.stringify(event)}\n`);
  }

  readEvents(runId: string, nodeId: string): NodeEvent[] {
    if (!this.validIds(runId, nodeId)) return [];
    return readJsonLines<NodeEvent>(join(this.nodeDir(runId, nodeId), 'events.jsonl'));
  }

  writeOutput(runId: string, nodeId: string, text: string): void {
    const dir = this.nodeDir(runId, nodeId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'output.md'), text);
  }

  readOutput(runId: string, nodeId: string): string {
    if (!this.validIds(runId, nodeId)) return '';
    const path = join(this.nodeDir(runId, nodeId), 'output.md');
    return existsSync(path) ? readFileSync(path, 'utf8') : '';
  }

  copyOutput(fromRunId: string, toRunId: string, nodeId: string): void {
    this.writeOutput(toRunId, nodeId, this.readOutput(fromRunId, nodeId));
  }

  outputRelPath(runId: string, nodeId: string): string {
    return relative(this.paths.root, join(this.nodeDir(runId, nodeId), 'output.md'));
  }

  /** On startup: runs still marked running belonged to a server that stopped mid-run. */
  recoverInterrupted(now: string): string[] {
    if (!existsSync(this.paths.runsDir)) return [];
    const recovered: string[] = [];
    for (const id of readdirSync(this.paths.runsDir).filter(isRunId)) {
      const meta = this.get(id);
      if (!meta || meta.status !== 'running') continue;
      for (const [nodeId, state] of Object.entries(meta.nodes)) {
        if (ACTIVE.has(state.status)) meta.nodes[nodeId] = { ...state, status: 'interrupted', endedAt: now };
      }
      meta.status = 'interrupted';
      meta.endedAt = now;
      delete meta.waitingFor;
      this.save(meta);
      recovered.push(id);
    }
    return recovered;
  }
}
