import type { EffortLevel, Graph, GraphNode, NodeEventBody, NodeUsage } from '@agent-stream/shared';
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
};

export type NodeExecutor = (ctx: NodeContext) => Promise<NodeOutcome>;

export type Executors = { agent: NodeExecutor; command: NodeExecutor };
