import type { EffortLevel, Graph, GraphNode, NodeEventBody, NodeUsage } from '@agent-stream/shared';
import type { StepAttachment } from './attachedFiles';
import type { GraphTool } from './providers/types';

export type NodeOutcome = { ok: boolean; output: string; error?: string; exitCode?: number | null; usage?: NodeUsage };

export type NodeContext = {
  runId: string;
  graph: Graph;
  node: GraphNode;
  /** Assembled prompt for agent nodes; empty for command nodes. */
  prompt: string;
  cwd: string;
  signal: AbortSignal;
  emit: (event: NodeEventBody) => void;
  /** Agent steps: tools to change the graph of the running run, each asking the user first (add_step, change_step). */
  graphTools?: GraphTool[];
  /** Agent steps: the model and effort the run resolved for this step when it started; absent: the provider's own default. */
  model?: string;
  effort?: EffortLevel;
  /** Agent steps: the files the step gets, its own then the graph's (step model spec §6b.5); a missing one is marked. */
  attachments?: StepAttachment[];
  /** Reads one of `attachments` by its path, through the attachment store, when the step sends it (a link swapped in since the start is not followed). */
  readAttachment?: (path: string) => Buffer | undefined;
};

export type NodeExecutor = (ctx: NodeContext) => Promise<NodeOutcome>;

export type Executors = { agent: NodeExecutor; command: NodeExecutor };
