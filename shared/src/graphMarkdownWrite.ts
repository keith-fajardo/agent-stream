import { fenceFor } from './fence';
import { escapeFreeText } from './freeText';
import { normText, oneLine, STEP_SEPARATOR, timeoutValue } from './graphDoc';
import { stepModelText } from './stepModels';
import { sortedValues } from './subgraphStep';
import type { Graph, GraphNode } from './types';

/** A Mermaid node label: quoted, `"` as #quot;, on one line (spec §4.1). */
export function mermaidLabel(title: string): string {
  return `["${oneLine(title).replace(/"/g, '#quot;')}"]`;
}

/** One line per edge, in the edges' order, then one per step with no edges at all, so the diagram shows every step. */
function flowLines(graph: Graph): string[] {
  const label = new Map(graph.nodes.map((n) => [n.id, mermaidLabel(n.title)]));
  const ref = (id: string) => `${id}${label.get(id) ?? ''}`;
  const connected = new Set(graph.edges.flatMap((e) => [e.from, e.to]));
  return ['flowchart LR', ...graph.edges.map((e) => `  ${ref(e.from)} -->${e.label ? `|${e.label}|` : ''} ${ref(e.to)}`), ...graph.nodes.filter((n) => !connected.has(n.id)).map((n) => `  ${ref(n.id)}`)];
}

/** A fenced block whose fence the content can't close. Empty content has no lines between the fences. */
function block(info: string, content: string): string[] {
  const fence = fenceFor(content);
  return [`${fence}${info}`, ...(content === '' ? [] : content.split('\n')), fence];
}

/** A sub-graph step (sub-graphs spec §2.2): its graph line, its description, then a ```value <name>``` block per value. */
function subgraphStepLines(node: GraphNode): string[] {
  const description = oneLine(node.description ?? '');
  return [
    `## ${node.id}${STEP_SEPARATOR}${oneLine(node.title)}`,
    '',
    '- kind: graph',
    ...(node.graph ? [`- graph: ${node.graph}`] : []),
    ...(description ? ['', `> ${description}`] : []),
    ...Object.entries(sortedValues(node.values)).flatMap(([name, value]) => ['', ...block(`value ${name}`, normText(value))]),
  ];
}

function stepLines(node: GraphNode): string[] {
  if (node.kind === 'graph') return subgraphStepLines(node);
  const fields = [`- kind: ${node.kind}`];
  if (node.kind === 'agent' && node.access === 'read') fields.push('- access: read');
  if (node.workspace) fields.push(`- workspace: ${node.workspace}`);
  if (node.timeoutSec !== undefined) fields.push(`- timeout: ${timeoutValue(node.timeoutSec)}`);
  if (node.kind === 'agent' && node.model) fields.push(`- model: ${stepModelText(node.model)}`);
  if (node.kind === 'agent' && node.effort) fields.push(`- effort: ${node.effort}`);
  // Written only when on (browser spec §2.1).
  if (node.kind === 'agent' && node.browser) fields.push('- browser: on');
  if (node.kind === 'agent') for (const name of node.attachments ?? []) fields.push(`- attach: ${name}`);
  const description = oneLine(node.description ?? '');
  const text = normText((node.kind === 'agent' ? node.prompt : node.command) ?? '');
  return [
    `## ${node.id}${STEP_SEPARATOR}${oneLine(node.title)}`,
    '',
    ...fields,
    '',
    ...(description ? [`> ${description}`, ''] : []),
    ...block(node.kind === 'agent' ? 'prompt' : 'sh', text),
  ];
}

/**
 * The graph's Markdown file (Markdown graph files spec §2, §4.1). Pure and deterministic: name, Goal, Instructions,
 * Variables, Attachments, Flow, then the steps in canvas order; empty Goal, Instructions, Variables and Attachments left out; LF line endings and
 * one trailing newline. Positions and bookkeeping go to the side file instead.
 */
export function serializeGraphMarkdown(graph: Graph): string {
  const out = [`# ${oneLine(graph.name)}`];
  const section = (title: string, body: string[]) => out.push('', `## ${title}`, '', ...body);
  const goal = normText(graph.goal).trim();
  if (goal) section('Goal', escapeFreeText(goal).split('\n'));
  const instructions = normText(graph.instructions).trim();
  if (instructions) section('Instructions', escapeFreeText(instructions).split('\n'));
  if (graph.variables.length) {
    section(
      'Variables',
      graph.variables.map((v) => {
        const description = oneLine(v.description);
        return description ? `- \`${v.name}\`: ${description}` : `- \`${v.name}\``;
      }),
    );
  }
  if (graph.attachments?.length) section('Attachments', graph.attachments.map((name) => `- \`${name}\``));
  section('Flow', block('mermaid', flowLines(graph).join('\n')));
  for (const node of graph.nodes) out.push('', ...stepLines(node));
  return `${out.join('\n')}\n`;
}
