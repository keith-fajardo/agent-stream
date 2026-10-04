import { resolve } from 'node:path';
import { privateFolderWriteDenial, type LoopTool } from '../../agentLoop/tools';
import type { ToolDecision, ToolGate } from '../toolGate';
import { CodexRpcError, UNSUPPORTED_REQUEST } from './connection';
import type {
  CommandExecutionRequestApprovalParams,
  CommandExecutionRequestApprovalResponse,
  DynamicToolCallParams,
  DynamicToolCallResponse,
  FileChangeRequestApprovalParams,
  FileChangeRequestApprovalResponse,
  FileUpdateChange,
  PermissionsRequestApprovalResponse,
} from './protocol';
import { classifyCommand, pathPrivacy } from './readOnlyCommand';

/** One file in a `Patch` approval: what the card shows (spec §5). */
export type PatchChange = { path: string; kind: 'add' | 'update' | 'delete'; diff: string; movePath?: string };

export function toPatchChanges(changes: FileUpdateChange[]): PatchChange[] {
  return changes.map((c) => ({ path: c.path, kind: c.kind.type, diff: c.diff, ...(c.kind.type === 'update' && c.kind.move_path ? { movePath: c.kind.move_path } : {}) }));
}

/** Why a change may not be made: it touches a private path, or moves a file onto one. The read rule plus the write rule, with no upstream output.md exception, like Edit and Write (R26). */
export function changePrivacyReason(privacy: ReturnType<typeof pathPrivacy>, cwd: string, ch: FileUpdateChange): string | undefined {
  const paths = ch.kind.type === 'update' && ch.kind.move_path ? [ch.path, ch.kind.move_path] : [ch.path];
  for (const path of paths) {
    const full = resolve(cwd, path);
    const reason = privacy(full, 'read') ?? privateFolderWriteDenial(full);
    if (reason) return reason;
  }
  return undefined;
}

export const PERMISSIONS_DECLINED = 'Codex asked for extra permissions; declined.';
export const UNNAMED_CHANGE = "Codex asked to change files it didn't name; declined.";
export const grantRootDeclined = (root: string) => `Codex asked to write anywhere under ${root} for the rest of the session; declined.`;

export type ApprovalContext = {
  gate: ToolGate;
  /** Where relative paths resolve when a request names no cwd: the step's or the planner's folder. Absolute. */
  cwd: string;
  platform: NodeJS.Platform;
  /** The dynamic tools, by the name Codex calls them. */
  tools: ReadonlyMap<string, LoopTool>;
  /** Aborts when the step or turn ends or Codex exits, so no approval card outlives its Codex process (R18). */
  signal: AbortSignal;
  /** File changes by item id, recorded from item/started before the approval request arrives (R14). */
  fileChanges: ReadonlyMap<string, FileUpdateChange[]>;
  /** Why an item was declined, shown in its tool_result (R13). */
  onDeclined(itemId: string, reason: string): void;
  /** A line for the step log. */
  note(text: string): void;
};

/**
 * Codex's server requests as ToolGate decisions (spec §4.5). `acceptForSession` is never sent, so every action that asks
 * is approved on its own. Requests we don't support get a JSON-RPC error and the turn goes on (R16).
 */
export function createServerRequestHandler(c: ApprovalContext): (method: string, params: unknown) => Promise<unknown> {
  const privacy = pathPrivacy(c.gate);
  const settle = (itemId: string, d: ToolDecision): { decision: 'accept' | 'decline' } => {
    if (d.allow) return { decision: 'accept' };
    c.onDeclined(itemId, d.reason);
    return { decision: 'decline' };
  };

  async function command(p: CommandExecutionRequestApprovalParams): Promise<CommandExecutionRequestApprovalResponse> {
    const verdict = classifyCommand(p, { cwd: c.cwd, platform: c.platform, privacy });
    if (verdict.kind === 'private') return settle(p.itemId, { allow: false, reason: verdict.reason });
    // Like Claude's Read/Grep/Glob: allowed without asking, and logged by its tool_call and tool_result.
    if (verdict.kind === 'readOnly') return settle(p.itemId, { allow: true, by: 'readOnly' });
    const input = { command: p.command ?? '', ...(p.reason ? { description: p.reason } : {}) };
    return settle(p.itemId, await c.gate.decide('Bash', input, c.signal));
  }

  async function fileChange(p: FileChangeRequestApprovalParams): Promise<FileChangeRequestApprovalResponse> {
    if (p.grantRoot) return settle(p.itemId, { allow: false, reason: grantRootDeclined(p.grantRoot) });
    const changes = c.fileChanges.get(p.itemId);
    if (!changes || changes.length === 0) return settle(p.itemId, { allow: false, reason: UNNAMED_CHANGE });
    for (const ch of changes) {
      const reason = changePrivacyReason(privacy, c.cwd, ch);
      if (reason) return settle(p.itemId, { allow: false, reason });
    }
    const input = { ...(p.reason ? { description: p.reason } : {}), changes: toPatchChanges(changes) };
    return settle(p.itemId, await c.gate.decide('Patch', input, c.signal));
  }

  async function toolCall(p: DynamicToolCallParams): Promise<DynamicToolCallResponse> {
    const reply = (text: string, success: boolean): DynamicToolCallResponse => ({ contentItems: [{ type: 'inputText', text }], success });
    const tool = c.tools.get(p.tool);
    if (!tool) return reply(`Unknown tool ${p.tool}.`, false);
    // Step graph tools self-approve (they ask the user with the exact change); planner graph tools pass by name.
    const args = p.arguments ?? {};
    const d = await c.gate.decide(tool.gateName, args, c.signal);
    if (!d.allow) return reply(d.reason, false);
    try {
      const out = await tool.run(args, c.signal);
      return reply(out.text, out.isError !== true);
    } catch (e) {
      return reply(e instanceof Error ? e.message : String(e), false);
    }
  }

  return async (method, params) => {
    switch (method) {
      case 'item/commandExecution/requestApproval':
        return command(params as CommandExecutionRequestApprovalParams);
      case 'item/fileChange/requestApproval':
        return fileChange(params as FileChangeRequestApprovalParams);
      case 'item/permissions/requestApproval': {
        c.note(PERMISSIONS_DECLINED);
        const none: PermissionsRequestApprovalResponse = { permissions: {}, scope: 'turn' };
        return none;
      }
      case 'item/tool/call':
        return toolCall(params as DynamicToolCallParams);
      default:
        throw new CodexRpcError(-32601, UNSUPPORTED_REQUEST);
    }
  };
}
