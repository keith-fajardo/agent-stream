import { createHash } from 'node:crypto';
import {
  browserMention,
  browserOffWarning,
  contentSignature,
  expandGraph,
  groupedOrder,
  onlyRunPlan,
  parallelWriteSteps,
  reusableNodeIds,
  runModeProblem,
  scopeOf,
  subgraphValueKey,
  subgraphValueLabel,
  topoOrder,
  validateRunnable,
  workspaceOf,
  type CheckoutInfo,
  type ExpandResult,
  type Graph,
  type PreviewStep,
  type RenderedRun,
  type RunAttachment,
  type RunMeta,
  type RunMode,
  type RunPreview,
  type Scope,
} from '@agent-stream/shared';
import { renderTemplate, templateErrorMessage, templateNames, type EnvLookup } from './templates';

/** dbt's own Jinja names: an unknown one of these gets a hint to wrap it in {% raw %}. */
export const DBT_NAMES: ReadonlySet<string> = new Set([
  'ref', 'source', 'config', 'this', 'target', 'var', 'is_incremental', 'adapter', 'run_query', 'log', 'statement', 'execute', 'model', 'dbt_utils',
]);
const DBT_HINT = 'This looks like dbt Jinja. Wrap it in {% raw %}…{% endraw %}.';

/** Environment variable names whose values are probably secrets (spec §7.5). */
export function looksLikeCredential(name: string): boolean {
  const upper = name.toUpperCase();
  return /PASSWORD|PASSWD|TOKEN|SECRET/.test(upper) || upper.split('_').includes('KEY');
}

/** How env_var() finds a variable: exact case on macOS/Linux, any case on Windows (as the OS does). */
export function envLookup(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): EnvLookup {
  if (platform !== 'win32') return (name) => env[name];
  return (name) => {
    const key = Object.keys(env).find((k) => k.toUpperCase() === name.toUpperCase());
    return key === undefined ? undefined : env[key];
  };
}

/** Values are text; "true" and "false" become booleans so {% if flag %} reads naturally (ruling R1). */
export function templateValue(value: string): string | boolean {
  const t = value.trim().toLowerCase();
  return t === 'true' ? true : t === 'false' ? false : value;
}

export type PreviewInput = {
  graph: Graph;
  values: Record<string, string>;
  env: EnvLookup;
  source?: RunMeta;
  /** The step `from` re-runs from, or `only` runs alone. */
  fromNodeId?: string;
  /** How the run uses `source`; absent: `from` with a step, else a retry from where it stopped. */
  mode?: RunMode;
  /** Why command steps can't run on this machine (Git Bash missing on Windows), if so. */
  commandShellProblem?: string | null;
  /** The checkout the run will use (ruling R8): refuses workspaces outside Git or before the first commit, notes uncommitted changes. */
  checkout?: CheckoutInfo;
  /** The attachments the steps use, with their SHA-256 now (no hash: missing): warnings for missing files, and reuse by content (step model spec §6b.5). */
  attachments?: RunAttachment[];
  /**
   * `graph` expanded with the folder's graphs (sub-graphs spec §3). Absent: a graph with sub-graph steps is expanded with
   * no other graph, so each is reported missing.
   */
  expansion?: ExpandResult;
};
/** `expanded` and `scopes`: the graph the run executes and its sub-graph steps, when `graph` has any. */
export type PreviewOutcome = { preview: RunPreview; rendered?: RenderedRun; expanded?: Graph; scopes?: Record<string, Scope> };

/** `scope`: the sub-graph step whose variables the template reads ('' for the graph being run). */
type Field = { label: string; src: string; mode: 'text' | 'command'; agentIds: string[]; scope: string };
/** One graph's variables as a template sees them: the names it has, and the values that are set. */
type VarContext = { defined: Set<string>; context: Record<string, unknown> };

function tracking(env: EnvLookup, seen: Set<string>): EnvLookup {
  return (name) => {
    seen.add(name);
    return env(name);
  };
}

/** A preview that can't run: the graph's sub-graph steps can't be expanded (sub-graphs spec §5), so nothing is rendered. */
function blockedPreview(input: PreviewInput, problems: string[]): PreviewOutcome {
  const { graph } = input;
  const order = topoOrder(graph);
  const ids = order.length === graph.nodes.length ? order : graph.nodes.map((n) => n.id);
  const steps: PreviewStep[] = ids.map((id) => {
    const n = graph.nodes.find((x) => x.id === id)!;
    return { id, title: n.title, kind: n.kind, ...(n.description?.trim() && { description: n.description.trim() }), reused: false };
  });
  const signature = createHash('sha256').update(JSON.stringify({ content: contentSignature(graph), problems })).digest('hex');
  return { preview: { graphId: graph.id, fromNodeId: input.fromNodeId, sourceRunId: input.source?.id, ...(input.mode && { mode: input.mode }), problems, warnings: [], notes: [], steps, variables: [], signature, ...(input.checkout && { checkout: input.checkout }) } };
}

export function previewRun(input: PreviewInput): PreviewOutcome {
  const outer = input.graph;
  // The graph a run executes: its sub-graph steps expanded (sub-graphs spec §3); any problem blocks the run.
  const expansion = input.expansion ?? (outer.nodes.some((n) => n.kind === 'graph') ? expandGraph(outer, (id) => ({ ok: false, reason: 'missing', error: `graph "${id}" not found` })) : undefined);
  if (expansion && !expansion.ok) return blockedPreview(input, [...validateRunnable(outer), ...expansion.problems.map((p) => p.message)]);
  const graph = expansion?.graph ?? outer;
  const scopes = expansion?.scopes ?? {};
  const scopeList = Object.values(scopes).sort((a, b) => a.depth - b.depth);
  /** The sub-graph step a step's templates read their variables from: '' for the graph being run. */
  const scopeKeyOf = (id: string) => scopeOf(scopes, id)?.stepId ?? '';
  const problems = validateRunnable(graph);
  const modeProblem = runModeProblem(input.mode, input.fromNodeId, input.source?.id);
  if (modeProblem) problems.push(modeProblem);
  const mode: RunMode | undefined = input.source ? (input.mode ?? (input.fromNodeId ? 'from' : 'resume')) : input.mode;
  const warnings: string[] = [];
  const agentIdsIn = (scope: string) => graph.nodes.filter((n) => n.kind === 'agent' && scopeKeyOf(n.id) === scope).map((n) => n.id);

  /**
   * Variable values by key: a variable of the graph by its name, an inner one as `<step>/<name>` (sub-graphs spec §3.3).
   * `shown`: the value as the dialog shows it; `needs`: the keys a value set on a sub-graph step waits for.
   */
  const contexts = new Map<string, VarContext>();
  const shown: Record<string, string> = Object.create(null);
  const labels = new Map<string, string>();
  const valueProblems = new Map<string, string>();
  const valueEnv = new Map<string, Set<string>>();
  const needs = new Map<string, string[]>();
  const keyIn = (scope: string, name: string) => (scope ? subgraphValueKey(scope, name) : name);
  /** A value typed on this machine: it may use env_var() but no other variable. */
  const readTyped = (ctx: VarContext, name: string, key: string, raw: string) => {
    const label = labels.get(key) ?? key;
    const seen = new Set<string>();
    valueEnv.set(key, seen);
    const names = templateNames(raw);
    if (!names.ok) return void valueProblems.set(key, `Variable ${label}: Jinja syntax error: ${names.error}`);
    if (names.names.length) return void valueProblems.set(key, `Variable ${label}: a value can only use env_var(), not ${names.names.map((n) => `\`${n}\``).join(', ')}.`);
    try {
      const value = renderTemplate(raw, { mode: 'text', context: {}, env: tracking(input.env, seen) });
      shown[key] = value;
      ctx.context[name] = templateValue(value);
    } catch (e) {
      valueProblems.set(key, `Variable ${label}: ${templateErrorMessage(e)}`);
    }
  };
  const outerContext: VarContext = { defined: new Set(outer.variables.map((v) => v.name)), context: Object.create(null) };
  contexts.set('', outerContext);
  for (const v of outer.variables) {
    const raw = (Object.hasOwn(input.values, v.name) ? input.values[v.name] : '') ?? '';
    if (raw !== '') readTyped(outerContext, v.name, v.name, raw);
  }
  // Each sub-graph's variables, outermost first: a value set on the step is a template over the graph around it; an
  // empty one is asked for in the run form under `<step>/<name>`.
  for (const scope of scopeList) {
    const inner = expansion!.ok ? expansion!.graphs[scope.graphId] : undefined;
    const parentKey = scopeKeyOf(scope.stepId);
    const parent = contexts.get(parentKey)!;
    const ctx: VarContext = { defined: new Set(inner?.variables.map((v) => v.name) ?? []), context: Object.create(null) };
    contexts.set(scope.stepId, ctx);
    for (const v of inner?.variables ?? []) {
      const key = subgraphValueKey(scope.stepId, v.name);
      const label = subgraphValueLabel(scope.stepId, v.name);
      labels.set(key, label);
      const set = Object.hasOwn(scope.values, v.name) ? scope.values[v.name] : '';
      if (set === '') {
        const raw = (Object.hasOwn(input.values, key) ? input.values[key] : '') ?? '';
        if (raw !== '') readTyped(ctx, v.name, key, raw);
        continue;
      }
      const names = templateNames(set);
      if (!names.ok) {
        valueProblems.set(key, `${label}: Jinja syntax error: ${names.error}`);
        continue;
      }
      const unknown = names.names.filter((n) => !parent.defined.has(n));
      if (unknown.length) {
        valueProblems.set(key, unknown.map((n) => `${label}: unknown variable \`${n}\`${DBT_NAMES.has(n) ? `. ${DBT_HINT}` : ''}`).join('\n'));
        continue;
      }
      const missing = names.names.filter((n) => !Object.hasOwn(parent.context, n));
      if (missing.length) {
        needs.set(key, missing.map((n) => keyIn(parentKey, n)));
        continue;
      }
      const seen = new Set<string>();
      for (const n of names.names) for (const e of valueEnv.get(keyIn(parentKey, n)) ?? []) seen.add(e);
      valueEnv.set(key, seen);
      try {
        const value = renderTemplate(set, { mode: 'text', context: parent.context, env: tracking(input.env, seen) });
        shown[key] = value;
        ctx.context[v.name] = templateValue(value);
      } catch (e) {
        valueProblems.set(key, `${label}: ${templateErrorMessage(e)}`);
      }
    }
  }

  const usedVariables = new Set<string>();
  /** Credential-looking env names → agent steps whose prompt includes them. */
  const credentials = new Map<string, Set<string>>();

  const render = (f: Field): string | undefined => {
    const names = templateNames(f.src);
    if (!names.ok) {
      problems.push(`${f.label}: Jinja syntax error: ${names.error}`);
      return undefined;
    }
    const { defined, context } = contexts.get(f.scope)!;
    let ready = true;
    const seen = new Set<string>();
    for (const name of names.names) {
      if (!defined.has(name)) {
        problems.push(`${f.label}: unknown variable \`${name}\`${DBT_NAMES.has(name) ? `. ${DBT_HINT}` : ''}`);
        ready = false;
        continue;
      }
      usedVariables.add(keyIn(f.scope, name));
      if (!Object.hasOwn(context, name)) ready = false; // not set, or its value has a problem: reported once below
      for (const e of valueEnv.get(keyIn(f.scope, name)) ?? []) seen.add(e);
    }
    let out: string | undefined;
    if (ready) {
      try {
        out = renderTemplate(f.src, { mode: f.mode, context, env: tracking(input.env, seen) });
      } catch (e) {
        problems.push(`${f.label}: ${templateErrorMessage(e)}`);
      }
    }
    for (const e of seen) {
      if (!looksLikeCredential(e)) continue;
      const ids = credentials.get(e) ?? new Set<string>();
      for (const id of f.agentIds) ids.add(id);
      credentials.set(e, ids);
    }
    return out;
  };

  const goal = render({ label: 'Goal', src: graph.goal, mode: 'text', agentIds: agentIdsIn(''), scope: '' });
  const instructions = render({ label: 'Instructions', src: graph.instructions, mode: 'text', agentIds: agentIdsIn(''), scope: '' });
  // Each sub-graph's own goal and instructions, rendered with its values: what its steps get (spec §4.3).
  const scopeTexts: Record<string, { goal?: string; instructions?: string }> = {};
  for (const scope of scopeList) {
    const inner = expansion!.ok ? expansion!.graphs[scope.graphId] : undefined;
    const ids = agentIdsIn(scope.stepId);
    scopeTexts[scope.stepId] = {
      goal: render({ label: `${scope.stepId} · Goal`, src: inner?.goal ?? '', mode: 'text', agentIds: ids, scope: scope.stepId }),
      instructions: render({ label: `${scope.stepId} · Instructions`, src: inner?.instructions ?? '', mode: 'text', agentIds: ids, scope: scope.stepId }),
    };
  }
  const nodes: Record<string, string> = {};
  for (const n of graph.nodes) {
    // A sub-graph step runs nothing of its own: it collects its inner steps' results (spec §4.1).
    if (n.kind === 'graph') {
      nodes[n.id] = '';
      continue;
    }
    const isCommand = n.kind === 'command';
    const text = render({ label: n.id, src: (isCommand ? n.command : n.prompt) ?? '', mode: isCommand ? 'command' : 'text', agentIds: isCommand ? [] : [n.id], scope: scopeKeyOf(n.id) });
    if (text !== undefined) nodes[n.id] = text;
  }
  // A value set on a sub-graph step that waits for a variable around it needs that variable too.
  for (const key of [...usedVariables]) for (const k of needs.get(key) ?? []) usedVariables.add(k);
  const hasValue = (key: string) => {
    const at = key.lastIndexOf('/');
    return Object.hasOwn(contexts.get(at < 0 ? '' : key.slice(0, at))?.context ?? {}, at < 0 ? key : key.slice(at + 1));
  };
  for (const key of [...usedVariables].sort()) {
    const problem = valueProblems.get(key);
    if (problem) problems.push(...problem.split('\n'));
    else if (!hasValue(key) && !needs.has(key)) problems.push(`Set a value for ${labels.get(key) ?? key} (Variables menu).`);
  }
  if (input.commandShellProblem && graph.nodes.some((n) => n.kind === 'command')) problems.push(input.commandShellProblem);
  const workspaceSteps = graph.nodes.filter((n) => workspaceOf(n) !== null);
  if (input.checkout && (!input.checkout.git || !input.checkout.head)) {
    for (const n of workspaceSteps) problems.push(`Step ${n.id} uses workspace "${n.workspace}", which needs a Git repository with at least one commit.`);
  }

  for (const [name, ids] of [...credentials].sort(([a], [b]) => a.localeCompare(b))) {
    const sent = ids.size ? ` (and is sent to Claude in agent step${ids.size === 1 ? '' : 's'} ${[...ids].sort().join(', ')})` : '';
    warnings.push(
      `\`${name}\` looks like a credential. Its value will appear in this dialog and in the step's logs${sent}. Steps already inherit your environment, so tools like dbt can read it directly.`,
    );
  }
  for (const n of graph.nodes) {
    if (n.kind === 'command' && /\|\s*unquoted\b/.test(n.command ?? '')) warnings.push(`${n.id} inserts a value without quotes (| unquoted). Check its command below.`);
  }
  // Notes are shown, never block (spec §4.7).
  const notes = parallelWriteSteps(graph).map(([a, b]) => `${a} and ${b} can both change files in the same workspace; they will run one at a time.`);
  if (input.checkout?.git && input.checkout.dirty && input.checkout.head && workspaceSteps.length > 0) {
    notes.push(`Workspaces start from ${input.checkout.head.slice(0, 7)}; uncommitted changes in this checkout aren't included.`);
  }

  const renderedScopes = Object.fromEntries(Object.entries(scopeTexts).map(([id, t]) => [id, { goal: t.goal ?? '', instructions: t.instructions ?? '' }]));
  let rendered: RenderedRun | undefined =
    problems.length === 0 ? { goal: goal ?? '', instructions: instructions ?? '', nodes, ...(scopeList.length > 0 && { scopes: renderedScopes }) } : undefined;
  let reused = new Set<string>();
  let notRun = new Set<string>();
  let stale = new Map<string, unknown>();
  /** Every reused step whose kept result is stale: the marks this run adds and the ones it carries forward. */
  const staleIds = new Set<string>();
  if (input.source && rendered) {
    if (mode === 'only') {
      const plan = onlyRunPlan(graph, input.source, input.fromNodeId!, rendered, input.attachments, scopes);
      if (plan.ok) ({ reuse: reused, notRun, stale } = plan);
      else {
        problems.push(plan.error);
        rendered = undefined;
      }
    } else reused = reusableNodeIds(graph, input.source, mode === 'resume' ? undefined : input.fromNodeId, rendered, input.attachments, scopes);
    for (const id of reused) if (stale.has(id) || input.source.nodes[id]?.stale) staleIds.add(id);
  }
  // A missing attachment never blocks: the step runs without it (spec §6b.5). Only steps that will run are named.
  // A step inside a sub-graph gets its sub-graph's files, from that graph's folder (spec §4.3).
  const missing = new Set((input.attachments ?? []).filter((a) => !a.sha256).map((a) => `${a.graphId ?? ''}\u0000${a.name}`));
  const isMissing = (graphId: string | undefined, name: string) => missing.has(`${graphId ?? ''}\u0000${name}`);
  const folderOf = (graphId: string | undefined) => `.agent-stream/attachments/${graphId ?? graph.id}/`;
  const runs = (id: string) => !reused.has(id) && !notRun.has(id);
  const agentsRun = (scope: string) => graph.nodes.some((n) => n.kind === 'agent' && runs(n.id) && scopeKeyOf(n.id) === scope);
  for (const name of graph.attachments ?? []) {
    if (isMissing(undefined, name) && agentsRun('')) warnings.push(`The graph's attachment ${name} is missing from ${folderOf(undefined)}, so agent steps run without it.`);
  }
  for (const scope of scopeList) {
    for (const name of scope.attachments ?? []) {
      if (isMissing(scope.graphId, name) && agentsRun(scope.stepId)) warnings.push(`${scope.graphName}'s attachment ${name} is missing from ${folderOf(scope.graphId)}, so the agent steps in ${scope.stepId} run without it.`);
    }
  }
  for (const n of graph.nodes) {
    if (n.kind !== 'agent' || !runs(n.id)) continue;
    const graphId = scopeOf(scopes, n.id)?.graphId;
    for (const name of n.attachments ?? []) if (isMissing(graphId, name)) warnings.push(`${n.id}'s attachment ${name} is missing from ${folderOf(graphId)}, so the step runs without it.`);
  }
  // The agent gets no browser tools unless the switch is on, whatever its text says: tell the user before it runs without one.
  for (const n of graph.nodes) {
    const phrase = runs(n.id) ? browserMention(n) : undefined;
    if (phrase) warnings.push(browserOffWarning(n.id, phrase));
  }
  // Run order, each sub-graph step heading its inner steps (spec §5).
  const steps: PreviewStep[] = groupedOrder(graph).map((id) => {
    const n = graph.nodes.find((x) => x.id === id)!;
    const depth = scopeOf(scopes, id)?.depth;
    const inner = scopes[id] && expansion?.ok ? expansion.graphs[scopes[id].graphId] : undefined;
    return {
      id,
      title: n.title,
      kind: n.kind,
      ...(n.description?.trim() && { description: n.description.trim() }),
      ...(Object.hasOwn(nodes, id) ? { text: nodes[id] } : {}),
      reused: reused.has(id),
      ...(staleIds.has(id) && { stale: true }),
      ...(notRun.has(id) && { notRun: true }),
      ...(depth !== undefined && { depth }),
      ...(inner && { subgraph: { graphName: inner.name, steps: inner.nodes.length } }),
    };
  });
  const variables = [...usedVariables]
    .sort()
    .filter((key) => Object.hasOwn(shown, key))
    .map((key) => ({ name: key, value: shown[key], ...(labels.has(key) && { label: labels.get(key)! }) }));
  const signature = createHash('sha256')
    .update(
      JSON.stringify({
        content: contentSignature(graph),
        rendered: rendered ?? null,
        reused: [...reused].sort(),
        // Only `Run only` leaves steps unrun or marks any stale; absent otherwise, so other runs keep their signature.
        ...(notRun.size > 0 && { notRun: [...notRun].sort() }),
        ...(staleIds.size > 0 && { stale: [...staleIds].sort() }),
        ...(mode && { mode }),
        fromNodeId: input.fromNodeId ?? null,
        sourceRunId: input.source?.id ?? null,
        // Workspaces start from HEAD: a commit since review would run other code. Graphs without them keep their signature.
        ...(workspaceSteps.length > 0 && { head: (input.checkout?.git && input.checkout.head) || null }),
      }),
    )
    .digest('hex');
  return {
    preview: {
      graphId: graph.id,
      fromNodeId: input.fromNodeId,
      sourceRunId: input.source?.id,
      ...(mode && { mode }),
      problems,
      warnings,
      notes,
      steps,
      variables,
      signature,
      ...(input.checkout && { checkout: input.checkout }),
    },
    rendered,
    ...(expansion?.ok && scopeList.length > 0 && { expanded: graph, scopes }),
  };
}
