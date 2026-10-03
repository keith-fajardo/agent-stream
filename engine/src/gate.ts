import type { CanUseTool, HookCallbackMatcher, HookInput, HookJSONOutput } from '@anthropic-ai/claude-agent-sdk';
import type { Decision, NodeEventBody } from '@agent-stream/shared';
import type { ApprovalBroker } from './approvals';
import { privatePathDenial } from './privatePaths';

export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set(['Read', 'Glob', 'Grep']);
/** Approvals wait for the user indefinitely; a day is the practical upper bound. */
export const APPROVAL_HOOK_TIMEOUT_SEC = 24 * 60 * 60;

export type GateOptions = {
  broker: ApprovalBroker;
  runId: string;
  graphId: string;
  nodeId: string;
  nodeTitle: string;
  projectDir: string;
  /** Files Claude may never read, wherever they are (the variable values file). */
  privateFiles: readonly string[];
  signal: AbortSignal;
  emit: (event: NodeEventBody) => void;
};

export type ApprovalGate = { hooks: { PreToolUse: HookCallbackMatcher[] }; canUseTool: CanUseTool };

function denialReason(d: Decision, runStopped: boolean = false): string {
  if (d.decision === 'cancelled' && runStopped) return 'The run was stopped.';
  if (d.decision === 'cancelled') return 'The approval request expired or was withdrawn.';
  if (d.decision === 'deny' && d.note) return `Denied by the user: ${d.note}`;
  return 'Denied by the user.';
}

/**
 * "Ask for everything" (spec §7.4). PreToolUse hooks run before the SDK's permission rules,
 * so allow rules in any settings file cannot skip the user. canUseTool is a backstop for
 * calls that still fall through to it (e.g. a project `ask` rule).
 */
export function makeApprovalGate(o: GateOptions): ApprovalGate {
  const approvedToolUseIds = new Set<string>();

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

  async function preToolUse(input: HookInput, _toolUseID: string | undefined, options: { signal: AbortSignal }): Promise<HookJSONOutput> {
    try {
      if (input.hook_event_name !== 'PreToolUse') return {};
      const private_ = privatePathDenial(o.projectDir, input.tool_name, input.tool_input, o.privateFiles);
      if (private_) return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: private_ } };
      if (READ_ONLY_TOOLS.has(input.tool_name)) return {};
      const d = await ask(input.tool_name, input.tool_input, options.signal);
      if (d.decision === 'approve') {
        approvedToolUseIds.add(input.tool_use_id);
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'allow',
            permissionDecisionReason: 'Approved by the user in Agent Stream.',
          },
        };
      }
      const runStopped = o.signal.aborted;
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: denialReason(d, runStopped) } };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: `Agent Stream could not ask for approval: ${message}`,
        },
      };
    }
  }

  const canUseTool: CanUseTool = async (toolName, input, options) => {
    try {
      if (approvedToolUseIds.has(options.toolUseID)) return { behavior: 'allow', updatedInput: input };
      const d = await ask(toolName, input, options.signal);
      if (d.decision === 'approve') return { behavior: 'allow', updatedInput: input };
      const runStopped = o.signal.aborted;
      const message = denialReason(d, runStopped);
      return { behavior: 'deny', message };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { behavior: 'deny', message: `Agent Stream could not ask for approval: ${message}` };
    }
  };

  return { hooks: { PreToolUse: [{ hooks: [preToolUse as any], timeout: APPROVAL_HOOK_TIMEOUT_SEC }] }, canUseTool };
}
