import { ALLOWED_EVERYTHING_LINE, ALLOWED_FOR_STEP, fenceFor, fmtDuration, loggedUrl, longestRun, modelLine, PAGES_VISITED, PROVIDER_NAMES, statusLabel, stepAttachmentNames, staleNote, supportsEffort, topoOrder, type GraphNode, type NodeEvent, type NodeRunState, type NodeUsage, type RunMeta } from '@agent-stream/shared';

/** One step's records: its events in the order they happened, its output text and where the full output is kept. */
export type RunReportStep = { events: NodeEvent[]; output?: string; outputPath?: string };

/**
 * Everything the report is built from. Deliberately no variable values and no environment: the report shows the
 * prompts and commands as they ran (RunMeta.rendered), and nothing else that could hold a saved value.
 */
export type RunReportInput = { graphName: string; run: RunMeta; steps: Record<string, RunReportStep>; now: string };

const MAX_OUTPUT = 2_000;
const MAX_RESULT = 300;
const MAX_TARGET = 120;

export const RUN_REPORT_NOTE =
  'Prompts, commands and step output appear exactly as they ran, including filled-in variable and environment values and anything an agent printed. The saved variable values file is never included.';

/** At most `max` characters, never splitting a surrogate pair; `…` marks a cut. */
function cut(text: string, max: number): { text: string; cut: boolean } {
  if (text.length <= max) return { text, cut: false };
  let end = max - 1;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return { text: `${text.slice(0, end)}…`, cut: true };
}

/** A fenced code block whose fence is longer than any backtick run inside, so the content can't close it. */
export function fenced(content: string, indent = ''): string {
  const fence = fenceFor(content);
  const body = content.replace(/\r\n?/g, '\n').replace(/\n$/, '');
  return [fence, ...body.split('\n'), fence].map((line) => (line ? indent + line : line)).join('\n');
}

/** An inline code span that holds any text on one line. */
function code(text: string): string {
  const ticks = '`'.repeat(longestRun(text, '`') + 1);
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
  return `${ticks}${pad}${text}${pad}${ticks}`;
}

/** One line of Markdown text: newlines become spaces and characters that start markup or HTML are escaped. */
function inline(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[\\`*[\]<>]/g, (c) => `\\${c}`)
    .replace(/(^|[^A-Za-z0-9])_|_(?=[^A-Za-z0-9]|$)/g, (m) => m.replace('_', '\\_'));
}

/**
 * Text that begins a line, or a list item's content: markers that only count there (headings, list items, quotes,
 * rules, setext underlines, fences, tables) are escaped. Use it on top of `inline`.
 */
function lineStart(text: string): string {
  return text.replace(/^(\d{1,9})([.)])/, '$1\\$2').replace(/^[#>+\-=~|]/, (c) => `\\${c}`);
}

/** `inline` for text that starts a line or a list item. */
const inlineStart = (text: string): string => lineStart(inline(text));

const firstLine = (text: string): string => text.split(/\r\n|\n|\r/).find((l) => l.trim())?.trim() ?? '';
const fieldsOf = (input: unknown): Record<string, unknown> => (typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {});

/** What a tool call acted on: its file, its path, or its command's first line, capped. */
function toolTarget(input: unknown): string {
  const f = fieldsOf(input);
  const raw = [f.file_path, f.path, f.command].find((v): v is string => typeof v === 'string' && v.trim() !== '');
  return raw === undefined ? '' : cut(firstLine(raw), MAX_TARGET).text;
}

function durationOf(state: { startedAt?: string; endedAt?: string; durationMs?: number }): string | undefined {
  if (state.durationMs !== undefined) return fmtDuration(state.durationMs);
  if (!state.startedAt || !state.endedAt) return undefined;
  const ms = Date.parse(state.endedAt) - Date.parse(state.startedAt);
  return Number.isNaN(ms) || ms < 0 ? undefined : fmtDuration(ms);
}

/** The step log's usage wording: tokens, and the cost when one is reported; only the turns when a provider reports no tokens (Copilot). */
function usageLine(u: NodeUsage): string {
  const counted = u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens > 0 || u.costUsd > 0;
  if (!counted) return `${u.turns} turns`;
  const cost = u.costUsd > 0 ? ` · ~$${u.costUsd.toFixed(2)} API-equivalent` : '';
  return `${u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens} in / ${u.outputTokens} out tokens · ${u.turns} turns${cost}`;
}

/** The steps in run order: topological order of the snapshot, then any left over (a cycle) in file order. */
function stepOrder(run: RunMeta): GraphNode[] {
  const byId = new Map(run.snapshot.nodes.map((n) => [n.id, n]));
  const ordered = topoOrder(run.snapshot);
  const rest = run.snapshot.nodes.map((n) => n.id).filter((id) => !ordered.includes(id));
  return [...ordered, ...rest].map((id) => byId.get(id)!);
}

function header(input: RunReportInput): string[] {
  const { run } = input;
  // The run dialog's Model line wording: an unset model or effort is Default, and Copilot has no effort levels.
  const model = run.model ?? 'Default';
  const effort = run.provider && !supportsEffort(run.provider) ? 'not supported' : (run.effort ?? 'Default');
  const lines = [
    `# Run report: ${inline(input.graphName)}`,
    '',
    `- Run: ${run.id}`,
    `- Status: ${statusLabel(run.status)}`,
    `- Started: ${run.startedAt}`,
    `- Duration: ${durationOf(run) ?? (run.status === 'running' ? 'still running' : 'unknown')}`,
    `- Provider: ${run.provider ? PROVIDER_NAMES[run.provider] : 'not recorded'}`,
    `- Model: ${inline(model)}`,
    `- Effort: ${inline(effort)}`,
  ];
  const c = run.checkout;
  if (c) {
    if (c.branch) lines.push(`- Branch: ${inline(c.branch)}`);
    if (c.head) lines.push(`- Commit: ${c.head}`);
    lines.push(`- Folder: ${inline(c.root)}${c.linkedWorktree ? ' (linked worktree)' : ''}`);
  }
  const workspaces = Object.entries(run.workspaces ?? {});
  if (workspaces.length) {
    lines.push('- Variant workspaces:');
    for (const [name, w] of workspaces) lines.push(`  - ${inlineStart(name)} → ${inline(w.path)}${w.removed ? ' (removed)' : ''}`);
  }
  return [...lines, '', RUN_REPORT_NOTE];
}

/** The goal or instructions as they ran, fenced so nothing in them (headings, images, links, definitions, HTML) is markup. */
function textSection(title: string, text: string): string[] {
  return text.trim() ? [`## ${title}`, '', fenced(text.trim())] : [];
}

function plan(run: RunMeta, order: GraphNode[]): string[] {
  const lines = order.map((n, i) => {
    const traits = [n.kind, ...(n.access === 'read' ? ['read-only'] : []), ...(n.workspace ? [`workspace ${inline(n.workspace)}`] : [])];
    const after = run.snapshot.edges.filter((e) => e.to === n.id).map((e) => e.from);
    return `${i + 1}. ${n.id} · ${inline(n.title)} (${traits.join(', ')})${after.length ? ` — after ${after.join(', ')}` : ''}`;
  });
  return ['## Plan', '', ...lines];
}

/** Web addresses in text: up to whitespace, quotes or brackets, without the punctuation that ends a sentence. */
const URL_IN_TEXT = /[a-z][a-z0-9+.-]*:\/\/[^\s"'<>`]*[^\s"'<>`.,;:!?)\]]/gi;

/**
 * A tool's result as the report shows it: every address as the step log and Pages visited show it (loggedUrl), without a
 * username, password or `#…` part (OAuth tokens live there). The report is a document people share.
 */
const excerpt = (content: string): string => cut(content.replace(URL_IN_TEXT, (url) => loggedUrl(url)), MAX_RESULT).text;

function toolCalls(events: NodeEvent[]): string[] {
  const results = new Map<string, Extract<NodeEvent, { type: 'tool_result' }>>();
  for (const e of events) if (e.type === 'tool_result') results.set(e.toolUseId, e);
  const lines: string[] = [];
  for (const e of events) {
    if (e.type !== 'tool_call') continue;
    const target = toolTarget(e.input);
    const result = results.get(e.toolUseId);
    lines.push(`- ${inlineStart(e.name)}${target ? ` ${code(target)}` : ''}${result?.isError ? ' (error)' : ''}${result ? '' : ' (no result)'}`);
    if (result && result.content.trim()) lines.push('', fenced(excerpt(result.content), '  '), '');
  }
  while (lines.at(-1) === '') lines.pop();
  return lines.length ? ['**Tool calls**', '', ...lines] : [];
}

/** Approvals in request order, each paired with its own decision by id. Undecided reads pending only while the step can still decide. */
function approvals(events: NodeEvent[], status: NodeRunState['status']): string[] {
  const undecided = status === 'running' || status === 'waiting_approval' ? 'pending' : 'never decided';
  const decisions = new Map<string, Extract<NodeEvent, { type: 'approval_decided' }>>();
  for (const e of events) if (e.type === 'approval_decided') decisions.set(e.approvalId, e);
  const words = { approve: 'approved', deny: 'denied', cancelled: 'cancelled' } as const;
  const lines = events.flatMap((e) => {
    // The press of Allow all for this step, in order among the requests it covers.
    if (e.type === 'approval_allowed_all') return [`- ${e.at} ${ALLOWED_EVERYTHING_LINE}`];
    // Approved by the allowance with no request before it.
    if (e.type === 'approval_decided' && e.auto) return [`- ${e.at} ${inline(e.toolName ?? 'a tool')}: approved ${ALLOWED_FOR_STEP}`];
    if (e.type !== 'approval_requested') return [];
    const d = decisions.get(e.approvalId);
    const note = d?.note?.trim() ? ` — ${inline(d.note)}` : '';
    const scope = d?.decision === 'approve' && d.scope === 'step' ? ` ${ALLOWED_FOR_STEP}` : '';
    return [`- ${e.at} ${inline(e.toolName)}: ${d ? words[d.decision] : undecided}${scope}${note}`];
  });
  return lines.length ? ['**Approvals**', '', ...lines] : [];
}

function stepSection(run: RunMeta, n: GraphNode, step: RunReportStep | undefined): string[] {
  const state: NodeRunState = run.nodes[n.id] ?? { status: 'not_run' };
  const duration = durationOf(state);
  const out: string[] = [`### ${n.id} · ${inline(n.title)} — ${statusLabel(state.status)}${duration ? `, ${duration}` : ''}`];
  const block = (lines: string[]) => lines.length && out.push('', ...lines);
  // A kept result the run knows may no longer fit (retry options): said before the step's own details.
  if (state.stale) block([`**Stale:** ${inline(staleNote(state.stale, n.id))}`]);
  // The model and effort the step ran with, resolved when the run started (step model spec §3.3); runs from before have none.
  const use = n.kind === 'agent' ? run.stepModels?.[n.id] : undefined;
  if (use) block([inline(modelLine({ model: use.model, effort: use.effort, provider: run.provider })), ...(use.note?.trim() ? ['', `_Note:_ ${inline(use.note)}`] : [])]);
  // Its attachments, its own then the graph's, by name and SHA-256 as the run started; never their contents (spec §6b.5).
  const files = n.kind === 'agent' ? stepAttachmentNames(n.attachments, run.snapshot.attachments) : [];
  if (files.length) {
    const hash = (name: string) => run.attachments?.find((a) => a.name === name)?.sha256;
    block(['**Attachments**', '', ...files.map((name) => `- ${inlineStart(name)} · ${hash(name) ? `sha256 ${hash(name)}` : 'missing when the run started'}`)]);
  }
  // After a label on the same line, so line-start markup in it (an agent can write descriptions) stays text.
  if (n.description?.trim()) block([`_Description:_ ${inline(n.description)}`]);
  // As it ran: the rendered text, which has the variable values filled in.
  const text = run.rendered?.nodes[n.id] ?? (n.kind === 'command' ? n.command : n.prompt) ?? '';
  if (text.trim()) {
    if (n.kind === 'command') block(['**Command**', '', fenced(text)]);
    else block(['<details><summary>Prompt</summary>', '', fenced(text), '', '</details>']);
  }
  const events = step?.events ?? [];
  block(toolCalls(events));
  block(approvals(events, state.status));
  // A browser step's pages, from run.json (spec §4.4). A URL is page-controlled text: any whitespace or line break in it
  // becomes a space so it stays on its own list item, and it goes in a code span so nothing in it is markup.
  const pages = state.browserPages ?? [];
  if (pages.length) block([`**${PAGES_VISITED}**`, '', ...pages.map((url) => `- ${code(url.replace(/[\s\u0000-\u001f\u007f-\u009f]+/g, ' ').trim())}`)]);
  const output = step?.output ?? '';
  if (output.trim()) {
    const shown = cut(output, MAX_OUTPUT);
    block(['**Output**', '', fenced(shown.text), ...(shown.cut && step?.outputPath ? ['', `[full output: ${inline(step.outputPath.replace(/\\/g, '/'))}]`] : [])]);
  }
  if (state.exitCode !== undefined && state.exitCode !== null) block([`**Exit code:** ${state.exitCode}`]);
  if (state.error?.trim()) block(['**Error**', '', fenced(cut(state.error, MAX_OUTPUT).text)]);
  if (state.usage) block([`**Usage:** ${usageLine(state.usage)}`]);
  return out;
}

function amendments(run: RunMeta): string[] {
  const list = run.amendments ?? [];
  if (!list.length) return [];
  return ['## Agent changes during the run', '', ...list.map((a) => `- ${a.at} · by ${a.byNodeId} · ${inline(a.summary)}`)];
}

/** One Markdown audit trail for a run: what was asked, what each step did, what was approved, and what it produced. */
export function buildRunReport(input: RunReportInput): string {
  const { run } = input;
  const order = stepOrder(run);
  const sections: string[][] = [
    header(input),
    textSection('Goal', run.rendered?.goal ?? run.snapshot.goal),
    textSection('Instructions', run.rendered?.instructions ?? run.snapshot.instructions),
    plan(run, order),
    ['## Steps', ...order.flatMap((n) => ['', ...stepSection(run, n, input.steps[n.id])])],
    amendments(run),
    [`_Generated by Agent Stream on ${input.now}._`],
  ];
  return `${sections
    .filter((s) => s.length)
    .map((s) => s.join('\n'))
    .join('\n\n')}\n`;
}
