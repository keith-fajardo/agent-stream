import type { Graph, GraphNode, NodeEventBody, NodeUsage } from '@claude-stream/shared';

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
};

export type NodeExecutor = (ctx: NodeContext) => Promise<NodeOutcome>;

export type Executors = { agent: NodeExecutor; command: NodeExecutor };
