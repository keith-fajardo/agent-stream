import type { Graph, GraphNode, NodeRunState } from '@agent-stream/shared';

export const MAX_UPSTREAM_CHARS = 20_000;

export type UpstreamResult = { node: GraphNode; state: NodeRunState; output: string; outputPath: string };

export function truncateHead(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n…[truncated ${text.length - max} chars]`;
}

export function truncateTail(text: string, max: number): string {
  return text.length <= max ? text : `…[truncated ${text.length - max} chars]\n${text.slice(text.length - max)}`;
}

const brief = (n: GraphNode): string => n.description?.trim() || '';

function heading(u: UpstreamResult): string {
  const about = brief(u.node) ? `: ${brief(u.node)}` : '';
  if (u.node.kind === 'command') {
    const secs = u.state.durationMs !== undefined ? `, ${(u.state.durationMs / 1000).toFixed(1)} s` : '';
    return `## ${u.node.id} · ${u.node.title}${about} (command \`${u.node.command ?? ''}\`, exit ${u.state.exitCode ?? '?'}${secs})`;
  }
  return `## ${u.node.id} · ${u.node.title}${about} (agent, ${u.state.status})`;
}

/** The prompt an agent node receives (spec §7.3). Commands keep their tail, agents their head. */
export function buildNodePrompt(graph: Graph, node: GraphNode, upstream: UpstreamResult[]): string {
  const parts: string[] = [];
  if (graph.goal.trim()) parts.push(`# Workflow goal\n${graph.goal.trim()}`);
  if (graph.instructions?.trim()) parts.push(`# Instructions & context\n${graph.instructions.trim()}`);
  parts.push(`# Your step: ${node.title}\n${brief(node) ? `In short: ${brief(node)}\n` : ''}${(node.prompt ?? '').trim()}`);
  if (upstream.length > 0) {
    const sections = upstream.map((u) => {
      const excerpt =
        u.node.kind === 'command' ? truncateTail(u.output, MAX_UPSTREAM_CHARS) : truncateHead(u.output, MAX_UPSTREAM_CHARS);
      return `${heading(u)}\n${excerpt.trim() || '(no output)'}\nFull output: ${u.outputPath}`;
    });
    parts.push(`# Results from earlier steps\n${sections.join('\n\n')}`);
  }
  return `${parts.join('\n\n')}\n`;
}
