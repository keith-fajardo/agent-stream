import type { CanUseTool, HookCallbackMatcher, HookInput, HookJSONOutput } from '@anthropic-ai/claude-agent-sdk';
import { APPROVAL_HOOK_TIMEOUT_SEC, couldNotAsk, type ToolGate } from '../toolGate';

export type ApprovalGate = { hooks: { PreToolUse: HookCallbackMatcher[] }; canUseTool: CanUseTool };

/** PreToolUse hooks run before the SDK's permission rules, so settings allow rules can't skip the user; canUseTool is the backstop. */
export function toSdkGate(gate: ToolGate): ApprovalGate {
  const approvedToolUseIds = new Set<string>();
  const deny = (reason: string): HookJSONOutput => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });

  async function preToolUse(input: HookInput, _id: string | undefined, options: { signal: AbortSignal }): Promise<HookJSONOutput> {
    if (input.hook_event_name !== 'PreToolUse') return {};
    try {
      const reason = gate.privacy(input.tool_name, input.tool_input);
      if (reason) return deny(reason);
      if (gate.isReadOnly(input.tool_name)) return {};
      const d = await gate.approve(input.tool_name, input.tool_input, options.signal);
      if (!d.allow) return deny(d.reason);
      approvedToolUseIds.add(input.tool_use_id);
    } catch (error) {
      return deny(couldNotAsk(error));
    }
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: 'Approved by the user in Agent Stream.' } };
  }

  const canUseTool: CanUseTool = async (toolName, input, options) => {
    try {
      if (approvedToolUseIds.has(options.toolUseID)) return { behavior: 'allow', updatedInput: input };
      const d = await gate.approve(toolName, input, options.signal);
      return d.allow ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: d.reason };
    } catch (error) {
      return { behavior: 'deny', message: couldNotAsk(error) };
    }
  };

  return { hooks: { PreToolUse: [{ hooks: [preToolUse as any], timeout: APPROVAL_HOOK_TIMEOUT_SEC }] }, canUseTool };
}
