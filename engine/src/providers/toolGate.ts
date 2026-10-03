import type { Decision, NodeEventBody } from '@agent-stream/shared';
import type { ApprovalBroker } from '../approvals';
import { privatePathDenial } from '../privatePaths';

export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set(['Read', 'Glob', 'Grep']);
/** Approvals wait for the user indefinitely; a day is the practical upper bound. */
export const APPROVAL_HOOK_TIMEOUT_SEC = 24 * 60 * 60;

export type ToolDecision = { allow: true; by: 'readOnly' | 'user' | 'graphTool' } | { allow: false; reason: string };

export interface ToolGate {
  /** Sync privacy check: why this call may never touch its path, or null. */
  privacy(toolName: string, input: unknown): string | null;
  isReadOnly(toolName: string): boolean;
  /** Steps: ask the user. Planner: allow graph tools, refuse anything else. Never throws. */
  approve(toolName: string, input: unknown, signal?: AbortSignal): Promise<ToolDecision>;
  /** privacy → read-only → approve. What a provider without its own permission system calls. */
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
};

function denialReason(d: Decision, runStopped: boolean = false): string {
  if (d.decision === 'cancelled' && runStopped) return 'The run was stopped.';
  if (d.decision === 'cancelled') return 'The approval request expired or was withdrawn.';
  if (d.decision === 'deny' && d.note) return `Denied by the user: ${d.note}`;
  return 'Denied by the user.';
}

function withDecide(base: Omit<ToolGate, 'decide'>): ToolGate {
  return {
    ...base,
    async decide(toolName, input, signal) {
      const reason = base.privacy(toolName, input);
      if (reason) return { allow: false, reason };
      if (base.isReadOnly(toolName)) return { allow: true, by: 'readOnly' };
      return base.approve(toolName, input, signal);
    },
  };
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

      const { id, decision } = o.broker.request(
        { runId: o.runId, graphId: o.graphId, nodeId: o.nodeId, nodeTitle: o.nodeTitle, toolName, input },
        combinedSignal,
      );
      try {
        o.emit({ type: 'approval_requested', approvalId: id, toolName, input });
      } catch (error) {
        o.broker.decide(id, { decision: 'cancelled' });
        throw error;
      }
      const d = await decision;
      try {
        o.emit(
          d.decision === 'deny' && d.note
            ? { type: 'approval_decided', approvalId: id, decision: d.decision, note: d.note }
            : { type: 'approval_decided', approvalId: id, decision: d.decision },
        );
      } catch (error) {
        throw error;
      }
      return d;
    } finally {
      clearTimeout(timer);
    }
  }
  return withDecide({
    privacy: (toolName, input) => privatePathDenial(o.projectDir, toolName, input, o.privateFiles),
    isReadOnly: (toolName) => READ_ONLY_TOOLS.has(toolName),
    async approve(toolName, input, signal) {
      try {
        const d = await ask(toolName, input, signal);
        return d.decision === 'approve' ? { allow: true, by: 'user' } : { allow: false, reason: denialReason(d, o.signal.aborted) };
      } catch (error) {
        return { allow: false, reason: `Agent Stream could not ask for approval: ${error instanceof Error ? error.message : String(error)}` };
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
