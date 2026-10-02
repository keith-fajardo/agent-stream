import type { CanUseTool, HookCallbackMatcher, HookInput, HookJSONOutput } from '@anthropic-ai/claude-agent-sdk';
import type { Decision, NodeEventBody } from '@claude-stream/shared';
import type { ApprovalBroker } from './approvals';

export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set(['Read', 'Glob', 'Grep']);
/** Approvals wait for the user indefinitely; a day is the practical upper bound. */
export const APPROVAL_HOOK_TIMEOUT_SEC = 24 * 60 * 60;

export type GateOptions = {
  broker: ApprovalBroker;
  runId: string;
  nodeId: string;
  nodeTitle: string;
  signal: AbortSignal;
  emit: (event: NodeEventBody) => void;
};

export type ApprovalGate = { hooks: { PreToolUse: HookCallbackMatcher[] }; canUseTool: CanUseTool };

function denialReason(d: Decision): string {
  if (d.decision === 'cancelled') return 'The run was stopped.';
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

  async function ask(toolName: string, input: unknown): Promise<Decision> {
    const { id, decision } = o.broker.request(
      { runId: o.runId, nodeId: o.nodeId, nodeTitle: o.nodeTitle, toolName, input },
      o.signal,
    );
    o.emit({ type: 'approval_requested', approvalId: id, toolName, input });
    const d = await decision;
    o.emit(
      d.decision === 'deny' && d.note
        ? { type: 'approval_decided', approvalId: id, decision: d.decision, note: d.note }
        : { type: 'approval_decided', approvalId: id, decision: d.decision },
    );
    return d;
  }

  async function preToolUse(input: HookInput): Promise<HookJSONOutput> {
    if (input.hook_event_name !== 'PreToolUse' || READ_ONLY_TOOLS.has(input.tool_name)) return {};
    const d = await ask(input.tool_name, input.tool_input);
    if (d.decision === 'approve') {
      approvedToolUseIds.add(input.tool_use_id);
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          permissionDecisionReason: 'Approved by the user in claude-stream.',
        },
      };
    }
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: denialReason(d) } };
  }

  const canUseTool: CanUseTool = async (toolName, input, options) => {
    if (approvedToolUseIds.has(options.toolUseID)) return { behavior: 'allow', updatedInput: input };
    const d = await ask(toolName, input);
    return d.decision === 'approve' ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: denialReason(d) };
  };

  return { hooks: { PreToolUse: [{ hooks: [preToolUse], timeout: APPROVAL_HOOK_TIMEOUT_SEC }] }, canUseTool };
}
