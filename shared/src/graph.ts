import type { Actor, Graph, GraphNode, GraphResult, NodePatch, NodeRunState, Op } from './types';

const NODE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function emptyGraph(id: string, name: string, now: string): Graph {
  return { id, name, goal: '', nodes: [], edges: [], nodeSeq: 0, updatedAt: now };
}

export function edgeId(from: string, to: string): string {
  return `${from}->${to}`;
}

function seqOf(id: string): number {
  const m = /^n(\d+)$/.exec(id);
  return m ? Number(m[1]) : 0;
}

export function nextNodeId(graph: Graph): string {
  const max = graph.nodes.reduce((acc, n) => Math.max(acc, seqOf(n.id)), graph.nodeSeq);
  return `n${max + 1}`;
}

function definedOnly<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}

export function applyOp(graph: Graph, op: Op, by: Actor, now: string): GraphResult {
  const fail = (error: string): GraphResult => ({ ok: false, error });
  const has = (id: string) => graph.nodes.some((n) => n.id === id);
  const done = (patch: Partial<Graph>): GraphResult => ({ ok: true, graph: { ...graph, ...patch, updatedAt: now } });

  switch (op.type) {
    case 'addNode': {
      const id = op.node.id ?? nextNodeId(graph);
      if (!NODE_ID_RE.test(id)) return fail(`invalid node id "${id}"`);
      if (has(id)) return fail(`node ${id} already exists`);
      const title = op.node.title.trim();
      if (!title) return fail('a node needs a title');
      const node = definedOnly<GraphNode>({
        id,
        title,
        kind: op.node.kind,
        prompt: op.node.prompt,
        command: op.node.command,
        timeoutSec: op.node.timeoutSec,
        position: op.node.position,
        createdBy: by,
        updatedBy: by,
        updatedAt: now,
      }) as GraphNode;
      return done({ nodes: [...graph.nodes, node], nodeSeq: Math.max(graph.nodeSeq, seqOf(id)) });
    }
    case 'updateNode': {
      const node = graph.nodes.find((n) => n.id === op.id);
      if (!node) return fail(`node ${op.id} does not exist`);
      const patch = definedOnly<NodePatch>(op.patch);
      if (patch.title !== undefined) {
        patch.title = patch.title.trim();
        if (!patch.title) return fail('a node needs a title');
      }
      const updated: GraphNode = { ...node, ...patch, updatedBy: by, updatedAt: now };
      return done({ nodes: graph.nodes.map((n) => (n.id === op.id ? updated : n)) });
    }
    case 'deleteNode': {
      if (!has(op.id)) return fail(`node ${op.id} does not exist`);
      return done({
        nodes: graph.nodes.filter((n) => n.id !== op.id),
        edges: graph.edges.filter((e) => e.from !== op.id && e.to !== op.id),
      });
    }
    case 'connect': {
      if (!has(op.from)) return fail(`node ${op.from} does not exist`);
      if (!has(op.to)) return fail(`node ${op.to} does not exist`);
      if (op.from === op.to) return fail('a node cannot depend on itself');
      if (graph.edges.some((e) => e.from === op.from && e.to === op.to)) return fail(`${op.from} -> ${op.to} already exists`);
      if (wouldCreateCycle(graph, op.from, op.to)) return fail(`connecting ${op.from} -> ${op.to} would create a cycle`);
      return done({ edges: [...graph.edges, { id: edgeId(op.from, op.to), from: op.from, to: op.to }] });
    }
    case 'disconnect': {
      if (!graph.edges.some((e) => e.from === op.from && e.to === op.to)) return fail(`${op.from} -> ${op.to} does not exist`);
      return done({ edges: graph.edges.filter((e) => !(e.from === op.from && e.to === op.to)) });
    }
    case 'setGoal':
      return done({ goal: op.goal });
    case 'moveNode': {
      if (!has(op.id)) return fail(`node ${op.id} does not exist`);
      return done({ nodes: graph.nodes.map((n) => (n.id === op.id ? { ...n, position: op.position } : n)) });
    }
  }
}

export function children(graph: Graph, id: string): string[] {
  return graph.edges.filter((e) => e.from === id).map((e) => e.to);
}

export function upstream(graph: Graph, id: string): string[] {
  return graph.edges.filter((e) => e.to === id).map((e) => e.from);
}

/** Every node reachable from `id` by following edges forward. */
export function descendants(graph: Graph, id: string): Set<string> {
  const seen = new Set<string>();
  const stack = [id];
  while (stack.length) {
    const current = stack.pop()!;
    for (const next of children(graph, current)) {
      if (!seen.has(next)) {
        seen.add(next);
        stack.push(next);
      }
    }
  }
  return seen;
}

/** Adding from -> to creates a cycle exactly when `from` is reachable from `to`. */
export function wouldCreateCycle(graph: Graph, from: string, to: string): boolean {
  return from === to || descendants(graph, to).has(from);
}

/** Kahn's algorithm. Returns fewer ids than there are nodes when the graph has a cycle. */
export function topoOrder(graph: Graph): string[] {
  const indegree = new Map(graph.nodes.map((n) => [n.id, 0]));
  for (const e of graph.edges) indegree.set(e.to, (indegree.get(e.to) ?? 0) + 1);
  const ready = graph.nodes.filter((n) => indegree.get(n.id) === 0).map((n) => n.id);
  const order: string[] = [];
  while (ready.length) {
    const id = ready.shift()!;
    order.push(id);
    for (const child of children(graph, id)) {
      const left = (indegree.get(child) ?? 0) - 1;
      indegree.set(child, left);
      if (left === 0) ready.push(child);
    }
  }
  return order;
}

/** What a run depends on; positions are layout, not content. */
export function contentSignature(g: Graph): string {
  return JSON.stringify({
    goal: g.goal,
    nodes: g.nodes.map((n) => [n.id, n.kind, n.title, n.prompt ?? '', n.command ?? '', n.timeoutSec ?? null]),
    edges: g.edges.map((e) => e.id).sort(),
  });
}

export function validateRunnable(graph: Graph): string[] {
  const problems: string[] = [];
  if (graph.nodes.length === 0) problems.push('The graph has no nodes.');
  for (const n of graph.nodes) {
    if (n.kind === 'agent' && !n.prompt?.trim()) problems.push(`${n.id} "${n.title}": an agent node needs a prompt.`);
    if (n.kind === 'command' && !n.command?.trim()) problems.push(`${n.id} "${n.title}": a command node needs a command.`);
  }
  if (topoOrder(graph).length !== graph.nodes.length) problems.push('The graph has a cycle.');
  return problems;
}

export type RunSource = { snapshot: Graph; nodes: Record<string, NodeRunState> };

function sameSet(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x) => b.includes(x));
}

/**
 * Node ids a re-run may reuse from `source` (spec §7.2). A node executes again when it is
 * `fromNodeId`, did not succeed last time, changed kind/prompt/command, or gained/lost an
 * upstream edge — and so does everything downstream of it. Everything else is reused.
 */
export function reusableNodeIds(graph: Graph, source: RunSource, fromNodeId?: string): Set<string> {
  const seeds = new Set<string>(fromNodeId ? [fromNodeId] : []);
  for (const n of graph.nodes) {
    const prev = source.snapshot.nodes.find((p) => p.id === n.id);
    const state = source.nodes[n.id];
    const succeeded = state?.status === 'succeeded' || state?.status === 'reused';
    const sameDefinition =
      !!prev && prev.kind === n.kind && (prev.prompt ?? '') === (n.prompt ?? '') && (prev.command ?? '') === (n.command ?? '');
    const sameInputs = !!prev && sameSet(upstream(graph, n.id), upstream(source.snapshot, n.id));
    if (!succeeded || !sameDefinition || !sameInputs) seeds.add(n.id);
  }
  const execute = new Set(seeds);
  for (const id of seeds) for (const d of descendants(graph, id)) execute.add(d);
  return new Set(graph.nodes.map((n) => n.id).filter((id) => !execute.has(id)));
}
