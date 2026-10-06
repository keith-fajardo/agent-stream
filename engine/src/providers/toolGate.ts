import { resolve } from 'node:path';
import type { Decision, NodeEventBody } from '@agent-stream/shared';
import { requestApproval, type ApprovalBroker } from '../approvals';
import { privatePathDenial } from '../privatePaths';

export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set(['Read', 'Glob', 'Grep']);
/**
 * How the gate names a step's graph tools: Claude serves them from its `run_graph` MCP server (so the SDK calls them
 * `mcp__run_graph__<name>`), and the agent loop names them to match, so one self-approving set fits every provider.
 */
export const STEP_GRAPH_TOOL_PREFIX = 'mcp__run_graph__';
/** Approvals wait for the user indefinitely; a day is the practical upper bound. */
export const APPROVAL_HOOK_TIMEOUT_SEC = 24 * 60 * 60;

/** Why a read-only step can't use a tool (spec §4.4). Never asks the user. */
export const readOnlyRefusal = (toolName: string): string =>
  `This step is read-only, so ${toolName} isn't allowed. Mark the step "Can edit files" if it needs to change something.`;

export type ToolDecision = { allow: true; by: 'readOnly' | 'user' | 'graphTool' } | { allow: false; reason: string };

export interface ToolGate {
  /** Sync privacy check: why this call may never touch its path, or null. */
  privacy(toolName: string, input: unknown): string | null;
  isReadOnly(toolName: string): boolean;
  /** Tools that ask the user themselves (the step graph tools): passed through without a second approval. */
  isSelfApproving(toolName: string): boolean;
  /** Steps: ask the user. Planner: allow graph tools, refuse anything else. Never throws. */
  approve(toolName: string, input: unknown, signal?: AbortSignal): Promise<ToolDecision>;
  /** privacy → read-only → self-approving → approve. What a provider without its own permission system calls. */
  decide(toolName: string, input: unknown, signal?: AbortSignal): Promise<ToolDecision>;
}

export type StepGateOptions = {
  broker: ApprovalBroker;
  runId: string;
  graphId: string;
  nodeId: string;
  nodeTitle: string;
  projectDir: string;
  /** Files no agent may read, wherever they are (the variable values files). */
  privateFiles: readonly string[];
  signal: AbortSignal;
  emit: (event: NodeEventBody) => void;
  /** Tool names that ask the user themselves (the step's graph tools, as the provider names them). */
  selfApproving?: ReadonlySet<string>;
  /** The folder whose .agent-stream/runs hold this run's records, when the step works elsewhere (a variant worktree, ruling R18). */
  runsRoot?: string;
  /** A read-only step (access: 'read'): every tool that isn't read-only is refused without asking (spec §4.4). */
  readOnly?: boolean;
};

/** Why a step's request was not approved, as the agent is told. */
export function denialReason(d: Decision, runStopped: boolean = false): string {
  if (d.decision === 'cancelled' && runStopped) return 'The run was stopped.';
  if (d.decision === 'cancelled') return 'The approval request expired or was withdrawn.';
  if (d.decision === 'deny' && d.note) return `Denied by the user: ${d.note}`;
  return 'Denied by the user.';
}

/** The refusal every gate falls back to when it cannot decide: fail closed. */
export function couldNotAsk(error: unknown): string {
  return `Agent Stream could not ask for approval: ${error instanceof Error ? error.message : String(error)}`;
}

export function withDecide(base: Omit<ToolGate, 'decide' | 'isSelfApproving'> & { isSelfApproving?: ToolGate['isSelfApproving'] }): ToolGate {
  const isSelfApproving = base.isSelfApproving ?? (() => false);
  return {
    ...base,
    isSelfApproving,
    async decide(toolName, input, signal) {
      try {
        const reason = base.privacy(toolName, input);
        if (reason) return { allow: false, reason };
        if (base.isReadOnly(toolName)) return { allow: true, by: 'readOnly' };
        if (isSelfApproving(toolName)) return { allow: true, by: 'graphTool' };
        return await base.approve(toolName, input, signal);
      } catch (error) {
        return { allow: false, reason: couldNotAsk(error) };
      }
    },
  };
}

/**
 * The tool input with its path made absolute against the step's working directory, where the agent's relative paths
 * resolve (a search without a path searches that folder). A leading ~ is left for privatePathDenial to expand.
 */
function resolvedAgainst(cwd: string, toolName: string, input: unknown): unknown {
  const key = toolName === 'Read' ? 'file_path' : toolName === 'Grep' || toolName === 'Glob' ? 'path' : undefined;
  if (!key || typeof input !== 'object' || input === null) return input;
  const given = (input as Record<string, unknown>)[key];
  const p = key === 'path' && (given === undefined || given === null || given === '') ? cwd : given;
  if (typeof p !== 'string' || p === '' || /^~(?=$|[\\/])/.test(p)) return input;
  return { ...input, [key]: resolve(cwd, p) };
}

/** "Ask for everything" for one agent step (spec §7.4): privacy first, read-only tools pass, the rest waits for the user. */
export function createStepGate(o: StepGateOptions): ToolGate {
  async function ask(toolName: string, input: unknown, sdkSignal?: AbortSignal): Promise<Decision> {
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), (APPROVAL_HOOK_TIMEOUT_SEC - 60) * 1000);
    timer.unref();

    try {
      const signals = [o.signal, deadline.signal];
      if (sdkSignal) signals.push(sdkSignal);
      const combinedSignal = AbortSignal.any(signals);

      // The one approval path of every step (requestApproval): Allow all for this step, the log lines and Stop work the same here as for the graph tools and the browser.
      return await requestApproval({
        broker: o.broker,
        ctx: { runId: o.runId, graph: { id: o.graphId }, node: { id: o.nodeId, title: o.nodeTitle }, emit: o.emit },
        toolName,
        input,
        card: {},
        signal: combinedSignal,
      });
    } finally {
      clearTimeout(timer);
    }
  }
  return withDecide({
    privacy: (toolName, input) =>
      privatePathDenial(o.projectDir, toolName, input, o.privateFiles) ??
      (o.runsRoot && o.runsRoot !== o.projectDir ? privatePathDenial(o.runsRoot, toolName, resolvedAgainst(o.projectDir, toolName, input)) : null),
    isReadOnly: (toolName) => READ_ONLY_TOOLS.has(toolName),
    isSelfApproving: (toolName) => o.selfApproving?.has(toolName) ?? false,
    async approve(toolName, input, signal) {
      if (o.readOnly) return { allow: false, reason: readOnlyRefusal(toolName) };
      try {
        const d = await ask(toolName, input, signal);
        return d.decision === 'approve' ? { allow: true, by: 'user' } : { allow: false, reason: denialReason(d, o.signal.aborted) };
      } catch (error) {
        return { allow: false, reason: couldNotAsk(error) };
      }
    },
  });
}

/** The planner reads files and edits the graph through its tools; it never asks the user for anything. */
export function createPlannerGate(o: { projectDir: string; privateFiles: readonly string[]; graphToolNames: ReadonlySet<string> }): ToolGate {
  return withDecide({
    privacy: (toolName, input) => privatePathDenial(o.projectDir, toolName, input, o.privateFiles),
    isReadOnly: (toolName) => READ_ONLY_TOOLS.has(toolName),
    async approve(toolName) {
      return o.graphToolNames.has(toolName) ? { allow: true, by: 'graphTool' } : { allow: false, reason: 'The planner can only read files and edit the graph.' };
    },
  });
}
