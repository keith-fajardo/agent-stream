import type { Graph, GraphNode } from './types';

export const WORKSPACE_NAME_RE = /^[a-z][a-z0-9_-]{0,39}$/;
export const WORKSPACE_NAME_PROBLEM = 'Workspace names use lowercase letters, digits, - and _, starting with a letter.';
export const COMMAND_ALWAYS_WRITES = 'Command steps can always change files; only agent steps can be read-only.';

/** Why `name` can't name a variant workspace, or null (spec §3.1a). */
export function workspaceNameProblem(name: string): string | null {
  return WORKSPACE_NAME_RE.test(name) ? null : WORKSPACE_NAME_PROBLEM;
}

/** Command steps always; agent steps unless marked read-only (spec §3.1). */
export function isWriteCapable(node: Pick<GraphNode, 'kind' | 'access'>): boolean {
  return node.kind === 'command' || node.access !== 'read';
}

/** The step's variant workspace, or null for the folder's own checkout. */
export function workspaceOf(node: Pick<GraphNode, 'workspace'>): string | null {
  return node.workspace ?? null;
}

function reachable(graph: Graph, from: string): Set<string> {
  const seen = new Set<string>();
  const stack = [from];
  while (stack.length) {
    const id = stack.pop()!;
    for (const e of graph.edges) {
      if (e.from === id && !seen.has(e.to)) {
        seen.add(e.to);
        stack.push(e.to);
      }
    }
  }
  return seen;
}

/** Every pair of write-capable steps in the same workspace with no path between them: they will take turns (spec §3.1, §4.7). */
export function parallelWriteSteps(graph: Graph): [string, string][] {
  const writers = graph.nodes.filter(isWriteCapable);
  const reach = new Map(writers.map((n) => [n.id, reachable(graph, n.id)]));
  const pairs: [string, string][] = [];
  for (let i = 0; i < writers.length; i++) {
    for (let j = i + 1; j < writers.length; j++) {
      const a = writers[i];
      const b = writers[j];
      if (workspaceOf(a) !== workspaceOf(b)) continue;
      if (reach.get(a.id)!.has(b.id) || reach.get(b.id)!.has(a.id)) continue;
      pairs.push([a.id, b.id]);
    }
  }
  return pairs;
}
