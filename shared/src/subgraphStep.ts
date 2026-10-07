import { MAX_VARIABLE_VALUE_CHARS, variableNameProblem } from './variables';

/** Graph ids are file names in .agent-stream/graphs/, so they use a safe slug alphabet (moved here from engine/src/paths.ts). */
export const GRAPH_ID_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;
export const isGraphId = (id: string): boolean => GRAPH_ID_RE.test(id);

export const SUBGRAPH_NEEDS_GRAPH = 'A sub-graph step needs a graph.';
export const ONLY_SUBGRAPH_STEPS_GRAPH = 'Only sub-graph steps have a graph and values.';
export const SUBGRAPH_FIELDS_ONLY = 'A sub-graph step has only a title, a description, a graph and values.';

/** Why `id` can't name an inner graph, or null. */
export const graphIdProblem = (id: string): string | null =>
  isGraphId(id) ? null : `"${id}" isn't a graph id: graph ids use lowercase letters, digits and -, starting with a letter or digit (at most 80).`;

/** Why `values` can't be a sub-graph step's values, or null (spec §2.1): variable names, each value at most MAX_VARIABLE_VALUE_CHARS. */
export function subgraphValuesProblem(values: Record<string, string>): string | null {
  for (const [name, value] of Object.entries(values)) {
    const problem = variableNameProblem(name);
    if (problem) return problem;
    if (value.length > MAX_VARIABLE_VALUE_CHARS) return `The value of ${name} can be at most ${MAX_VARIABLE_VALUE_CHARS} characters.`;
  }
  return null;
}

/** The values in name order: the order the Markdown file writes them, so comparisons and signatures don't depend on how they were set. */
export function sortedValues(values: Record<string, string> | undefined): Record<string, string> {
  return Object.fromEntries(Object.entries(values ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** A step's values as one line per value (`name: value`), for comparing and for the Changes tab. */
export const valuesText = (values: Record<string, string> | undefined): string =>
  Object.entries(sortedValues(values))
    .map(([name, value]) => `${name}: ${value}`)
    .join('\n');

/** The warning for an agent or command field on a sub-graph step in a graph file: the line is dropped and the file still reads (spec §2.1). */
export const subgraphFieldWarning = (label: string, field: string): string => `step ${label} is a sub-graph step, so it can't have ${field}. Agent Stream removed this line.`;

/** Whether a new step or a patch sets a field a sub-graph step can't have. Clearing one (null, '', [], 0, false, write) doesn't. */
export function setsStepField(f: { prompt?: string; command?: string; timeoutSec?: number; access?: string; workspace?: string; model?: unknown; effort?: unknown; attachments?: string[]; browser?: boolean }): boolean {
  return !!f.prompt || !!f.command || (f.timeoutSec ?? 0) > 0 || f.access === 'read' || !!f.workspace?.trim() || !!f.model || !!f.effort || !!f.attachments?.length || f.browser === true;
}
