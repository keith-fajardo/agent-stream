import type { ZodRawShape } from 'zod';
import type { ChatMessage } from '../agentLoop/chatModel';
import type { EffortLevel, ModelChoice, ProviderId, ProviderStatus } from '@agent-stream/shared';
import type { NodeContext, NodeOutcome } from '../executors';
import type { ToolGate } from './toolGate';

export type ToolReply = { text: string; isError?: boolean };
/** A graph-editing tool the planner may call, defined once for every provider. */
export type GraphTool = { name: string; description: string; schema: ZodRawShape; run(input: unknown): Promise<ToolReply> };
export type PlannerEvent = { type: 'text'; text: string } | { type: 'tool'; name: string; input: unknown };
/** A planner conversation's messages, offered to providers that have no server-side session (spec §6). Claude ignores it. */
export interface TranscriptStore {
  load(id: string): ChatMessage[] | undefined;
  save(id: string, messages: ChatMessage[]): void;
}

export type PlannerTurn = {
  prompt: string;
  systemAppend: string;
  cwd: string;
  tools: GraphTool[];
  /** The provider's own conversation id to continue, when it belongs to this provider. */
  resume?: string;
  /** The model and effort for this turn; absent: the provider's own default. */
  model?: string;
  effort?: EffortLevel;
  gate: ToolGate;
  /** This conversation's stored messages, per session, graph and provider. */
  transcript: TranscriptStore;
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
  /**
   * The models this provider offers, for the Model menus; [] when they can't be listed (the menus then offer only Default).
   * A failure stands for the provider's life, except that one call with `retry` may try again.
   */
  listModels?(o?: { retry?: boolean }): Promise<ModelChoice[]>;
  /** The models already listed, without waiting or starting anything; undefined until a list succeeded. */
  knownModels?(): ModelChoice[] | undefined;
  /** The most model requests one agent step may make, when the provider caps them (Copilot); the run dialog shows it. */
  stepRequestCap?(): number;
  /**
   * The model a step would run on for this choice (undefined: Default), when the provider substitutes its default for a
   * model it no longer lists (Copilot); undefined when it runs the choice as given or can't tell without waiting.
   */
  modelInUse?(model: string | undefined): ModelChoice | undefined;
}
