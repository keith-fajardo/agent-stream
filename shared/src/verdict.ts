import type { EdgeLabel, Graph } from './types';

const VERDICT_LINE = /^\s*VERDICT:\s*(yes|no)\.?\s*$/i;

/** The marker line a step's output ends with; the last one wins. Undefined when there is none. */
export function readVerdict(output: string): EdgeLabel | undefined {
  let found: EdgeLabel | undefined;
  for (const line of output.split(/\r?\n/)) {
    const m = VERDICT_LINE.exec(line);
    if (m) found = m[1].toLowerCase() as EdgeLabel;
  }
  return found;
}

export const VERDICT_INSTRUCTION = 'End your reply with one line on its own: `VERDICT: yes` or `VERDICT: no`.';

/** The instruction an agent step's prompt gets when a condition node reads its verdict; undefined otherwise. */
export function verdictInstructionFor(graph: Graph, nodeId: string): string | undefined {
  const node = graph.nodes.find((n) => n.id === nodeId);
  if (node?.kind !== 'agent') return undefined;
  const feedsCondition = graph.edges.some((e) => e.from === nodeId && graph.nodes.find((n) => n.id === e.to)?.kind === 'condition');
  return feedsCondition ? VERDICT_INSTRUCTION : undefined;
}
