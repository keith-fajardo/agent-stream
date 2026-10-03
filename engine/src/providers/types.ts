import type { ZodRawShape } from 'zod';
import type { ProviderId, ProviderStatus } from '@agent-stream/shared';
import type { NodeContext, NodeOutcome } from '../executors';
import type { ToolGate } from './toolGate';

export type ToolReply = { text: string; isError?: boolean };
/** A graph-editing tool the planner may call, defined once for every provider. */
export type GraphTool = { name: string; description: string; schema: ZodRawShape; run(input: unknown): Promise<ToolReply> };
export type PlannerEvent = { type: 'text'; text: string } | { type: 'tool'; name: string; input: unknown };
export type PlannerTurn = {
  prompt: string;
  systemAppend: string;
  cwd: string;
  tools: GraphTool[];
  /** The provider's own conversation id to continue, when it belongs to this provider. */
  resume?: string;
  gate: ToolGate;
  signal: AbortSignal;
  onEvent(e: PlannerEvent): void;
};
/** ok: the turn ran (save the session and cursor; `error` is a model-reported failure to show). !ok: nothing ran. */
export type PlannerTurnResult = { ok: true; sessionId?: string; error?: string } | { ok: false; error: string; resumeFailed?: boolean };

export interface AgentProvider {
  readonly id: ProviderId;
  readonly name: string;
  status(): Promise<ProviderStatus>;
  folderProblem?(projectDir: string): string | undefined;
  runStep(ctx: NodeContext, gate: ToolGate): Promise<NodeOutcome>;
  planTurn(turn: PlannerTurn): Promise<PlannerTurnResult>;
}
