import { createHash } from 'node:crypto';
import {
  contentSignature,
  onlyRunPlan,
  parallelWriteSteps,
  reusableNodeIds,
  runModeProblem,
  topoOrder,
  validateRunnable,
  workspaceOf,
  type CheckoutInfo,
  type Graph,
  type PreviewStep,
  type RenderedRun,
  type RunAttachment,
  type RunMeta,
  type RunMode,
  type RunPreview,
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
};
export type PreviewOutcome = { preview: RunPreview; rendered?: RenderedRun };

type Field = { label: string; src: string; mode: 'text' | 'command'; agentIds: string[] };

function tracking(env: EnvLookup, seen: Set<string>): EnvLookup {
  return (name) => {
    seen.add(name);
    return env(name);
  };
}

export function previewRun(input: PreviewInput): PreviewOutcome {
  const { graph } = input;
  const problems = validateRunnable(graph);
  const modeProblem = runModeProblem(input.mode, input.fromNodeId, input.source?.id);
  if (modeProblem) problems.push(modeProblem);
  const mode: RunMode | undefined = input.source ? (input.mode ?? (input.fromNodeId ? 'from' : 'resume')) : input.mode;
  const warnings: string[] = [];
  const defined = new Set(graph.variables.map((v) => v.name));
  const agentIds = graph.nodes.filter((n) => n.kind === 'agent').map((n) => n.id);

  // Variable values first; each may use env_var() but no other variable.
  const context: Record<string, unknown> = Object.create(null);
  const shown: Record<string, string> = Object.create(null);
  const valueProblems = new Map<string, string>();
  const valueEnv = new Map<string, Set<string>>();
  for (const v of graph.variables) {
    const raw = (Object.hasOwn(input.values, v.name) ? input.values[v.name] : '') ?? '';
    if (raw === '') continue;
    const seen = new Set<string>();
    valueEnv.set(v.name, seen);
    const names = templateNames(raw);
    if (!names.ok) {
      valueProblems.set(v.name, `Variable ${v.name}: Jinja syntax error: ${names.error}`);
      continue;
    }
    if (names.names.length) {
      valueProblems.set(v.name, `Variable ${v.name}: a value can only use env_var(), not ${names.names.map((n) => `\`${n}\``).join(', ')}.`);
      continue;
    }
    try {
      const value = renderTemplate(raw, { mode: 'text', context: {}, env: tracking(input.env, seen) });
      shown[v.name] = value;
      context[v.name] = templateValue(value);
    } catch (e) {
      valueProblems.set(v.name, `Variable ${v.name}: ${templateErrorMessage(e)}`);
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
    let ready = true;
    const seen = new Set<string>();
    for (const name of names.names) {
      if (!defined.has(name)) {
        problems.push(`${f.label}: unknown variable \`${name}\`${DBT_NAMES.has(name) ? `. ${DBT_HINT}` : ''}`);
        ready = false;
        continue;
      }
      usedVariables.add(name);
      if (!Object.hasOwn(context, name)) ready = false; // not set, or its value has a problem: reported once below
      for (const e of valueEnv.get(name) ?? []) seen.add(e);
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

  const goal = render({ label: 'Goal', src: graph.goal, mode: 'text', agentIds });
  const instructions = render({ label: 'Instructions', src: graph.instructions, mode: 'text', agentIds });
  const nodes: Record<string, string> = {};
  for (const n of graph.nodes) {
    const isCommand = n.kind === 'command';
    const text = render({ label: n.id, src: (isCommand ? n.command : n.prompt) ?? '', mode: isCommand ? 'command' : 'text', agentIds: isCommand ? [] : [n.id] });
    if (text !== undefined) nodes[n.id] = text;
  }
  for (const name of [...usedVariables].sort()) {
    const problem = valueProblems.get(name);
    if (problem) problems.push(problem);
    else if (!Object.hasOwn(context, name)) problems.push(`Set a value for ${name} (Variables menu).`);
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

  let rendered: RenderedRun | undefined = problems.length === 0 ? { goal: goal ?? '', instructions: instructions ?? '', nodes } : undefined;
  let reused = new Set<string>();
  let notRun = new Set<string>();
  let stale = new Map<string, unknown>();
  /** Every reused step whose kept result is stale: the marks this run adds and the ones it carries forward. */
  const staleIds = new Set<string>();
  if (input.source && rendered) {
    if (mode === 'only') {
      const plan = onlyRunPlan(graph, input.source, input.fromNodeId!, rendered, input.attachments);
      if (plan.ok) ({ reuse: reused, notRun, stale } = plan);
      else {
        problems.push(plan.error);
        rendered = undefined;
      }
    } else reused = reusableNodeIds(graph, input.source, mode === 'resume' ? undefined : input.fromNodeId, rendered, input.attachments);
    for (const id of reused) if (stale.has(id) || input.source.nodes[id]?.stale) staleIds.add(id);
  }
  // A missing attachment never blocks: the step runs without it (spec §6b.5). Only steps that will run are named.
  const missing = new Set((input.attachments ?? []).filter((a) => !a.sha256).map((a) => a.name));
  const folder = `.agent-stream/attachments/${graph.id}/`;
  const runs = (id: string) => !reused.has(id) && !notRun.has(id);
  for (const name of graph.attachments ?? []) {
    if (missing.has(name) && graph.nodes.some((n) => n.kind === 'agent' && runs(n.id))) warnings.push(`The graph's attachment ${name} is missing from ${folder}, so agent steps run without it.`);
  }
  for (const n of graph.nodes) {
    if (n.kind !== 'agent' || !runs(n.id)) continue;
    for (const name of n.attachments ?? []) if (missing.has(name)) warnings.push(`${n.id}'s attachment ${name} is missing from ${folder}, so the step runs without it.`);
  }
  const order = topoOrder(graph);
  const ids = order.length === graph.nodes.length ? order : graph.nodes.map((n) => n.id);
  const steps: PreviewStep[] = ids.map((id) => {
    const n = graph.nodes.find((x) => x.id === id)!;
    return { id, title: n.title, kind: n.kind, ...(n.description?.trim() && { description: n.description.trim() }), ...(Object.hasOwn(nodes, id) ? { text: nodes[id] } : {}), reused: reused.has(id), ...(staleIds.has(id) && { stale: true }), ...(notRun.has(id) && { notRun: true }) };
  });
  const variables = [...usedVariables]
    .sort()
    .filter((name) => Object.hasOwn(shown, name))
    .map((name) => ({ name, value: shown[name] }));
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
  };
}
