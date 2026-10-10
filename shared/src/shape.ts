import { parentScopeId } from './subgraphs';
import type { Graph } from './types';

export type ShapeProblem = { nodeId: string; message: string };

/** The rules for condition and stop steps and labeled arrows (spec §2). Empty when the graph is well formed. */
export function shapeProblems(graph: Graph): ShapeProblem[] {
  const problems: ShapeProblem[] = [];
  const kindOf = (id: string) => graph.nodes.find((n) => n.id === id)?.kind;
  /** The sub-graph step in `scope` (undefined: the outer graph) that `id` lies inside, when it is one; the same scope test as a stop's arrow to its collector. */
  const subgraphStepAt = (id: string, scope: string | undefined): string | undefined => {
    for (let at = parentScopeId(id); at !== undefined; at = parentScopeId(at)) {
      if (parentScopeId(at) === scope) return kindOf(at) === 'graph' ? at : undefined;
    }
    return undefined;
  };
  for (const n of graph.nodes) {
    const label = `${n.id} "${n.title}"`;
    const incoming = graph.edges.filter((e) => e.to === n.id);
    const outgoing = graph.edges.filter((e) => e.from === n.id);
    if (n.kind === 'condition') {
      if (incoming.length !== 1) {
        problems.push({ nodeId: n.id, message: `${label}: a condition needs exactly one step before it.` });
      } else {
        const parent = kindOf(incoming[0].from);
        if (parent !== 'agent' && parent !== 'command') {
          problems.push({ nodeId: n.id, message: `${label}: a condition reads the verdict of an agent or command step, not a ${parent} step.` });
        }
      }
      // In a run's expanded graph, an arrow into a sub-graph step becomes one arrow per inner first step: those count as one (R28).
      const arrows = new Set(outgoing.map((e) => `${subgraphStepAt(e.to, parentScopeId(n.id)) ?? e.to}:${e.label ?? ''}`));
      const labels = [...arrows].map((a) => a.slice(a.lastIndexOf(':') + 1)).sort().join(',');
      if (labels !== 'no,yes') {
        problems.push({ nodeId: n.id, message: `${label}: a condition needs exactly two arrows out, one labeled yes and one labeled no.` });
      }
    }
    if (n.kind === 'stop') {
      const [arrowIn] = incoming;
      if (incoming.length !== 1 || kindOf(arrowIn.from) !== 'condition' || !arrowIn.label) {
        problems.push({ nodeId: n.id, message: `${label}: a stop step needs exactly one arrow in, labeled yes or no, from a condition step.` });
      }
      // In a run's expanded graph, a stop inside a sub-graph feeds that sub-graph step like every inner last step (sub-graphs spec §3.1).
      const collector = parentScopeId(n.id);
      const out = outgoing.filter((e) => !(e.to === collector && kindOf(e.to) === 'graph'));
      if (out.length) problems.push({ nodeId: n.id, message: `${label}: a stop step ends the run, so it cannot have arrows out.` });
    }
    if (n.kind !== 'stop' && n.failFast !== undefined) {
      problems.push({ nodeId: n.id, message: `${label}: fail-fast is only for stop steps.` });
    }
    if ((n.kind === 'condition' || n.kind === 'stop') && (n.prompt || n.command)) {
      problems.push({ nodeId: n.id, message: `${label}: a ${n.kind} step has no prompt or command.` });
    }
  }
  for (const e of graph.edges) {
    if (e.label && kindOf(e.from) !== 'condition') {
      problems.push({ nodeId: e.from, message: `${e.from} -> ${e.to}: only an arrow out of a condition step can be labeled yes or no.` });
    }
  }
  return problems;
}
