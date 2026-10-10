import { COMMAND_ALWAYS_WRITES, workspaceNameProblem } from './access';
import { attachmentListProblem, MAX_ATTACHMENTS } from './attachments';
import { fenceCloses, fenceOpening, type Fence } from './fence';
import { unescapeFreeTextLine } from './freeText';
import { edgeId, nodeIdProblem } from './graph';
import { MAX_TIMEOUT_SEC, STEP_SEPARATOR, type DocAttachments, type DocStep, type DocVariable, type ParseGraphResult } from './graphDoc';
import { parseFlow, type FlowEdge } from './graphFlow';
import { shapeProblems } from './shape';
import type { EffortLevel, Graph, GraphFileError, GraphNode, NodeKind, StepModel } from './types';
import { isEffortLevel } from './format';
import { parseStepModel } from './stepModels';
import { commandBrowserWarning } from './browser';
import { graphIdProblem, sortedValues, subgraphFieldWarning } from './subgraphStep';
import { MAX_VARIABLE_VALUE_CHARS, variableNameProblem } from './variables';

type TextItem = { kind: 'text'; line: number; text: string };
type CodeItem = { kind: 'code'; line: number; info: string; fence: Fence; content: string[]; raw: string[] };
type Item = TextItem | CodeItem;
type Section = { level: 1 | 2; title: string; line: number; items: Item[] };

const HEADING_RE = /^(#{1,2})(?=[ \t]|$)[ \t]*(.*?)[ \t]*$/;
const RESERVED = { goal: 'Goal', instructions: 'Instructions', variables: 'Variables', attachments: 'Attachments', flow: 'Flow' } as const;
type Reserved = (typeof RESERVED)[keyof typeof RESERVED];
const STEP_HEADING_RE = new RegExp(`^([A-Za-z0-9_-]+)${STEP_SEPARATOR.trimEnd()}(?: (.*))?$`);
const FIELD_RE = /^[-*][ \t]+([A-Za-z][A-Za-z-]*)[ \t]*:[ \t]*(.*?)[ \t]*$/;
const VARIABLE_RE = /^[-*][ \t]+`([^`]*)`(?:[ \t]*:[ \t]*(.*?))?[ \t]*$/;
const QUOTE_RE = /^>[ \t]?(.*)$/;
const FIELD_NAMES = ['kind', 'access', 'workspace', 'timeout', 'model', 'effort', 'browser', 'attach', 'graph', 'fail-fast'];
/** The fields a sub-graph step can't have: dropped from it with a warning (spec §2.1). */
const AGENT_AND_COMMAND_FIELDS = ['access', 'workspace', 'timeout', 'model', 'effort', 'browser', 'attach'];
/** A field a step may repeat: one line per attachment, in order (spec §6b.3). */
const LIST_FIELDS = new Set(['attach']);
const ATTACHMENT_RE = /^[-*][ \t]+`([^`]*)`[ \t]*$/;
const ATTACHMENTS_FORM = 'each line under "## Attachments" is one file, written as - `name`.';
const AGENT_INFOS = new Set(['prompt', 'text', 'md']);
const COMMAND_INFOS = new Set(['sh', 'bash', 'shell']);
const START = 'the file must start with the graph\'s name, as "# Name".';
const VARIABLE_FORM = 'each line under "## Variables" is one variable, written as - `name`: description.';

/** The id and title of a step heading: `n1 · Title`, or just a title for a new step (spec §2.1). */
function stepHeading(text: string): { id?: string; title: string } {
  const m = STEP_HEADING_RE.exec(text);
  return m ? { id: m[1], title: (m[2] ?? '').trim() } : { title: text.trim() };
}

const infoWord = (item: CodeItem) => item.info.split(/\s+/)[0].toLowerCase();
/** An error when a step or Flow block's info string has more than its one word: the rest would be dropped on the next save. */
function extraInfo(item: CodeItem, expected: string, errors: GraphFileError[]): void {
  const info = item.info.trim();
  if (/\s/.test(info)) errors.push({ line: item.line, message: `the code block's first line should be just ${expected}, with nothing after it (found "${info}").` });
}

/** Headings and fenced blocks, line by line. A "#" inside a fenced block is never a heading. */
function sectionsOf(lines: string[], errors: GraphFileError[]): { preamble: Item[]; sections: Section[] } {
  const preamble: Item[] = [];
  const sections: Section[] = [];
  const items = () => (sections.length ? sections[sections.length - 1].items : preamble);
  let code: CodeItem | null = null;
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i];
    const line = i + 1;
    if (code) {
      code.raw.push(text);
      if (fenceCloses(text, code.fence)) code = null;
      else code.content.push(text);
      continue;
    }
    const open = fenceOpening(text);
    if (open) {
      code = { kind: 'code', line, info: open.info, fence: open, content: [], raw: [text] };
      items().push(code);
      continue;
    }
    const heading = HEADING_RE.exec(text);
    if (heading) sections.push({ level: heading[1].length === 1 ? 1 : 2, title: heading[2], line, items: [] });
    else items().push({ kind: 'text', line, text });
  }
  if (code) errors.push({ line: code.line, message: `this code block is never closed. Add a line with ${code.fence.char.repeat(code.fence.len)} after it.` });
  return { preamble, sections };
}

const isBlank = (item: Item) => item.kind === 'text' && item.text.trim() === '';

/** Goal or Instructions: the section's text as written (escapes undone), trimmed. */
function freeText(items: Item[]): string {
  return items
    .flatMap((item) => (item.kind === 'code' ? item.raw : [unescapeFreeTextLine(item.text)]))
    .join('\n')
    .trim();
}

function readVariables(section: Section, errors: GraphFileError[]): DocVariable[] {
  const out: DocVariable[] = [];
  for (const item of section.items) {
    if (isBlank(item)) continue;
    const m = item.kind === 'text' ? VARIABLE_RE.exec(item.text.trim()) : null;
    if (!m) {
      errors.push({ line: item.line, message: VARIABLE_FORM });
      continue;
    }
    const problem = variableNameProblem(m[1], out);
    if (problem) {
      errors.push({ line: item.line, message: problem });
      continue;
    }
    out.push({ name: m[1], description: (m[2] ?? '').trim(), line: item.line });
  }
  return out;
}

/**
 * Names in one list (a step's attach lines, or "## Attachments"): each a safe name in composed (NFC) form, none twice in any
 * letter case, at most 20. `where` names the list in messages.
 */
function attachmentNames(entries: { value: string; line: number }[], where: string, errors: GraphFileError[]): string[] {
  const names: string[] = [];
  const seen = new Map<string, number>();
  for (const e of entries) {
    const problem = attachmentListProblem([e.value]);
    if (problem) {
      errors.push({ line: e.line, message: `${problem} Rename the file in the graph's attachments folder and here.` });
      continue;
    }
    const earlier = seen.get(e.value.toLowerCase());
    if (earlier !== undefined) {
      errors.push({ line: e.line, message: `${e.value} is attached twice in ${where} (also on line ${earlier}). Keep one.` });
      continue;
    }
    seen.set(e.value.toLowerCase(), e.line);
    names.push(e.value);
  }
  if (names.length > MAX_ATTACHMENTS) errors.push({ line: entries[MAX_ATTACHMENTS].line, message: `${where} has ${names.length} attachments; the most is ${MAX_ATTACHMENTS}. Remove ${names.length - MAX_ATTACHMENTS}.` });
  return names;
}

function readAttachments(section: Section, errors: GraphFileError[]): DocAttachments {
  const entries: { value: string; line: number }[] = [];
  for (const item of section.items) {
    if (isBlank(item)) continue;
    const m = item.kind === 'text' ? ATTACHMENT_RE.exec(item.text.trim()) : null;
    if (!m) errors.push({ line: item.line, message: ATTACHMENTS_FORM });
    else entries.push({ value: m[1], line: item.line });
  }
  return { names: attachmentNames(entries, 'the graph', errors), line: section.line };
}

function readFlow(section: Section, stepIds: ReadonlySet<string>, errors: GraphFileError[]): FlowEdge[] {
  const blocks: CodeItem[] = [];
  for (const item of section.items) {
    if (item.kind === 'code') blocks.push(item);
    else if (item.text.trim()) errors.push({ line: item.line, message: 'only a ```mermaid block belongs under "## Flow". Move this text under "## Instructions", or remove it.' });
  }
  const mermaid = blocks.filter((b) => infoWord(b) === 'mermaid');
  for (const b of blocks) if (!mermaid.includes(b)) errors.push({ line: b.line, message: 'the block under "## Flow" must be a ```mermaid block.' });
  for (const b of mermaid.slice(1)) errors.push({ line: b.line, message: '"## Flow" has a second ```mermaid block. Put every arrow in one block.' });
  if (!blocks.length) errors.push({ line: section.line, message: '"## Flow" needs a ```mermaid block. Add one, or remove the section when no step is connected.' });
  const block = mermaid[0];
  if (!block) return [];
  extraInfo(block, '"mermaid"', errors);
  const r = parseFlow(
    block.content.map((text, k) => ({ line: block.line + 1 + k, text })),
    stepIds,
    block.line,
  );
  errors.push(...r.errors);
  return r.edges;
}

function readStep(section: Section, errors: GraphFileError[], warnings: GraphFileError[]): DocStep | null {
  const before = errors.length;
  const fail = (line: number, message: string) => void errors.push({ line, message });
  const { id, title } = stepHeading(section.title);
  const label = id ?? `"${title}"`;
  if (id) {
    const problem = nodeIdProblem(id);
    if (problem) fail(section.line, problem.startsWith('invalid') ? problem : `${problem} Step ids use letters, digits, - and _ (at most 64).`);
  }
  if (!title) fail(section.line, id ? `step ${id} needs a title after "${STEP_SEPARATOR.trim()}".` : 'this step needs a title after "##".');
  const fields = new Map<string, { value: string; line: number }>();
  const lists = new Map<string, { value: string; line: number }[]>();
  const quote: string[] = [];
  let code: CodeItem | undefined;
  /** A sub-graph step's ```value <name>``` blocks (spec §2.2); any number, after the description. */
  const valueBlocks: CodeItem[] = [];
  let phase: 'fields' | 'description' | 'code' = 'fields';
  for (const item of section.items) {
    if (item.kind === 'code') {
      if (infoWord(item) === 'value') valueBlocks.push(item);
      else if (code) fail(item.line, `step ${label} has a second code block. A step has exactly one: move this text into the first block, or into a step of its own.`);
      else code = item;
      phase = 'code';
      continue;
    }
    if (!item.text.trim()) continue;
    const field = FIELD_RE.exec(item.text);
    if (field) {
      const key = field[1].toLowerCase();
      if (phase !== 'fields') fail(item.line, `fields go at the top of step ${label}, before the description and the code block.`);
      else if (!FIELD_NAMES.includes(key)) fail(item.line, `unknown field "${field[1]}". Step fields are kind, access, workspace, timeout, model, effort, browser, attach, graph and fail-fast.`);
      else if (LIST_FIELDS.has(key)) lists.set(key, [...(lists.get(key) ?? []), { value: field[2], line: item.line }]);
      else if (fields.has(key)) fail(item.line, `the field ${key} appears twice in step ${label}. Keep one.`);
      else fields.set(key, { value: field[2], line: item.line });
      continue;
    }
    const q = QUOTE_RE.exec(item.text);
    if (q) {
      if (phase === 'code') fail(item.line, `the description of step ${label} goes before its code block.`);
      else {
        phase = 'description';
        quote.push(q[1]);
      }
      continue;
    }
    fail(item.line, `step ${label} has text Agent Stream can't keep. A step holds fields (- key: value), a description (> …) and one code block: move this into the description or the code block, or remove it.`);
  }

  let kind: NodeKind | undefined;
  const k = fields.get('kind');
  if (k) {
    if (k.value === 'agent' || k.value === 'command' || k.value === 'graph' || k.value === 'condition' || k.value === 'stop') kind = k.value;
    else fail(k.line, `kind is "${k.value}"; use agent, command, graph, condition or stop.`);
  }
  const graphLine = fields.get('graph');
  // A sub-graph step: `- kind: graph`, or a graph line on a step with no prompt or sh block (spec §2.2).
  const isGraph = kind === 'graph' || (!k && !code && !!graphLine);
  let blockKind: NodeKind | undefined;
  if (isGraph) {
    if (code) fail(code.line, `step ${label} is a sub-graph step, so it can't have a \`\`\`${infoWord(code) || 'code'} block. Remove the block, or make it an agent or command step.`);
  } else if (kind === 'condition' || kind === 'stop') {
    if (code) fail(code.line, `a ${kind} step has no prompt or command. Remove the code block from step ${label}.`);
  } else if (!code) fail(section.line, `step ${label} has no code block. Add a \`\`\`prompt block for an agent step or a \`\`\`sh block for a command step.`);
  else if (AGENT_INFOS.has(infoWord(code))) blockKind = 'agent';
  else if (COMMAND_INFOS.has(infoWord(code))) blockKind = 'command';
  else fail(code.line, `the code block of step ${label} needs the info string prompt (agent step) or sh (command step), as in \`\`\`prompt.`);
  if (code && blockKind) extraInfo(code, '"prompt" or "sh"', errors);
  if (code && kind && blockKind && kind !== blockKind) {
    fail(code.line, `step ${label} is kind ${kind}, but its block is ${blockKind === 'agent' ? 'a prompt' : 'a command (sh)'}. Use a \`\`\`${kind === 'agent' ? 'prompt' : 'sh'} block, or change kind to ${blockKind}.`);
  }
  const finalKind: NodeKind | undefined = isGraph ? 'graph' : (kind ?? blockKind);

  // A sub-graph step has only its graph and values: its agent and command fields are dropped with a warning, in line order.
  if (finalKind === 'graph') {
    const dropped = [
      ...AGENT_AND_COMMAND_FIELDS.flatMap((key) => {
        const f = fields.get(key);
        fields.delete(key);
        return f ? [{ key, line: f.line }] : [];
      }),
      ...(lists.get('attach') ?? []).map((a) => ({ key: 'attach', line: a.line })),
    ];
    lists.delete('attach');
    for (const d of dropped.sort((a, b) => a.line - b.line)) warnings.push({ line: d.line, message: subgraphFieldWarning(label, d.key) });
  }
  let graph: string | undefined;
  const values: Record<string, string> = {};
  if (finalKind === 'graph') {
    if (!graphLine) fail(section.line, `step ${label} is a sub-graph step, so it needs a "- graph: <graph id>" line.`);
    else {
      const problem = graphIdProblem(graphLine.value);
      if (problem) fail(graphLine.line, problem);
      else graph = graphLine.value;
    }
    const seenAt = new Map<string, number>();
    for (const v of valueBlocks) {
      const words = v.info.trim().split(/\s+/);
      const name = words[1] ?? '';
      if (words.length !== 2) {
        fail(v.line, 'a value block\'s first line is "value" and the variable\'s name, as in ```value company.');
        continue;
      }
      const problem = variableNameProblem(name);
      if (problem) {
        fail(v.line, `value "${name}": ${problem}`);
        continue;
      }
      const earlier = seenAt.get(name);
      if (earlier !== undefined) {
        fail(v.line, `step ${label} sets the value ${name} twice (also on line ${earlier}). Keep one.`);
        continue;
      }
      seenAt.set(name, v.line);
      const value = v.content.join('\n');
      if (value.length > MAX_VARIABLE_VALUE_CHARS) fail(v.line, `The value of ${name} can be at most ${MAX_VARIABLE_VALUE_CHARS} characters.`);
      else values[name] = value;
    }
  } else if (finalKind) {
    const which = finalKind === 'agent' ? 'an agent' : finalKind === 'command' ? 'a command' : `a ${finalKind}`;
    if (graphLine) fail(graphLine.line, `step ${label} is ${which} step, so it can't have a graph. Remove this line, or make it a sub-graph step (kind: graph).`);
    for (const v of valueBlocks) fail(v.line, `step ${label} is ${which} step, so it can't have a value block. Remove the block, or make it a sub-graph step (kind: graph).`);
  }

  // A condition or stop step has none of the agent and command fields (spec §2): each line is an error, so the writer never drops one.
  if (finalKind === 'condition' || finalKind === 'stop') {
    const lines = [
      ...AGENT_AND_COMMAND_FIELDS.flatMap((key) => {
        const f = fields.get(key);
        fields.delete(key);
        return f ? [{ key, line: f.line }] : [];
      }),
      ...(lists.get('attach') ?? []).map((x) => ({ key: 'attach', line: x.line })),
    ];
    lists.delete('attach');
    for (const d of lines.sort((x, y) => x.line - y.line)) fail(d.line, `step ${label} is a ${finalKind} step, so it can't have the field ${d.key}. Remove this line.`);
  }

  let access: 'read' | undefined;
  const a = fields.get('access');
  if (a) {
    if (a.value === 'read') access = 'read';
    else if (a.value !== 'write') fail(a.line, `access is "${a.value}"; use read or write.`);
    if (access && finalKind === 'command') fail(a.line, COMMAND_ALWAYS_WRITES);
  }
  let workspace: string | undefined;
  const w = fields.get('workspace');
  if (w) {
    const problem = workspaceNameProblem(w.value);
    if (problem) fail(w.line, `workspace "${w.value}": ${problem}`);
    else workspace = w.value;
  }
  let timeoutSec: number | undefined;
  const t = fields.get('timeout');
  if (t) {
    const sec = /^\d+$/.test(t.value) ? Number(t.value) : NaN;
    if (sec >= 1 && sec <= MAX_TIMEOUT_SEC) timeoutSec = sec;
    else fail(t.line, `timeout is "${t.value}"; use a whole number of seconds from 1 to ${MAX_TIMEOUT_SEC}.`);
  }
  // A step's own model and effort (step model spec §2.2). Whether the model exists is checked when a run starts, not here.
  let model: StepModel | undefined;
  let effort: EffortLevel | undefined;
  for (const key of ['model', 'effort'] as const) {
    const f = fields.get(key);
    if (!f) continue;
    if (finalKind === 'command') {
      fail(f.line, `step ${label} is a command step, so it can't have a model or effort. Remove this line, or make it an agent step.`);
      continue;
    }
    if (key === 'model') {
      const r = parseStepModel(f.value);
      if (r.ok) model = r.model;
      else fail(f.line, r.error);
    } else if (isEffortLevel(f.value)) effort = f.value;
    else fail(f.line, `effort is "${f.value}"; use low, medium, high, xhigh, max or ultra.`);
  }
  // Its attachments (spec §6b.3). Whether the files are there is checked when a run starts, not here.
  const attachLines = lists.get('attach') ?? [];
  let attachments: string[] = [];
  if (attachLines.length && finalKind === 'command') {
    for (const a of attachLines) fail(a.line, `step ${label} is a command step, so it can't have attachments. Remove this line, or make it an agent step.`);
  } else attachments = attachmentNames(attachLines, `step ${label}`, errors);
  // Whether the step may use the browser (browser spec §2.1): on, or off (the same as no line). A command step never
  // has it: the line is dropped with a warning and the file still reads (ruling R1).
  let browser: true | undefined;
  const b = fields.get('browser');
  if (b) {
    if (b.value !== 'on' && b.value !== 'off') fail(b.line, `browser is "${b.value}"; use on or off.`);
    else if (finalKind === 'command') warnings.push({ line: b.line, message: commandBrowserWarning(label) });
    else if (b.value === 'on') browser = true;
  }
  // Whether a stop step ends the run at once (spec §2.1): on, or off (the same as no line, but kept as written).
  let failFast: boolean | undefined;
  const ff = fields.get('fail-fast');
  if (ff) {
    if (ff.value === 'on') failFast = true;
    else if (ff.value === 'off') failFast = false;
    else fail(ff.line, 'fail-fast is on or off.');
  }
  if (errors.length > before || !finalKind || (finalKind !== 'graph' && finalKind !== 'condition' && finalKind !== 'stop' && !code)) return null;
  const description = quote
    .map((q) => q.trim())
    .filter(Boolean)
    .join(' ');
  const text = code?.content.join('\n') ?? '';
  return {
    ...(id && { id }),
    title,
    kind: finalKind,
    ...(access && { access }),
    ...(workspace && { workspace }),
    ...(timeoutSec !== undefined && { timeoutSec }),
    ...(model && { model }),
    ...(effort && { effort }),
    ...(browser && { browser }),
    ...(attachments.length > 0 && { attachments }),
    ...(failFast !== undefined && { failFast }),
    ...(graph && { graph }),
    ...(Object.keys(values).length > 0 && { values: sortedValues(values) }),
    ...(description && { description }),
    ...(text && (finalKind === 'agent' ? { prompt: text } : { command: text })),
    line: section.line,
  };
}

/**
 * Reads a graph's Markdown file (Markdown graph files spec §2, §3.1). Pure: the engine and the tests share it. Every
 * problem found is reported, each with its 1-based line. CRLF reads as LF, and a leading BOM is ignored.
 */
export function parseGraphMarkdown(text: string): ParseGraphResult {
  const errors: GraphFileError[] = [];
  const lines = normalizeLines(text);
  const { preamble, sections } = sectionsOf(lines, errors);

  const stray = preamble.find((item) => !isBlank(item));
  if (stray) errors.push({ line: stray.line, message: START });
  const h1 = sections[0]?.level === 1 ? sections[0] : undefined;
  if (!h1 && !stray) errors.push({ line: sections[0]?.line ?? 1, message: START });
  for (const s of sections) {
    if (h1 && s.level === 1 && s !== h1) errors.push({ line: s.line, message: 'a graph file has one "# Name" heading, and this is a second one. Use "##" for sections and steps.' });
  }
  if (h1 && !h1.title) errors.push({ line: h1.line, message: 'the graph needs a name after "#".' });
  const intro = h1?.items.find((item) => !isBlank(item));
  if (intro) errors.push({ line: intro.line, message: 'text between the name and the first "##" section isn\'t part of the graph. Move it under "## Goal" or "## Instructions", or remove it.' });

  let goal = '';
  let instructions = '';
  let variables: DocVariable[] = [];
  let attachments: DocAttachments | undefined;
  let flow: Section | undefined;
  const reservedAt = new Map<Reserved, number>();
  const stepSections: Section[] = [];
  for (const s of sections) {
    if (s.level !== 2) continue;
    const reserved: Reserved | undefined = RESERVED[s.title.toLowerCase() as keyof typeof RESERVED];
    if (!reserved) {
      stepSections.push(s);
      continue;
    }
    const earlier = reservedAt.get(reserved);
    if (earlier !== undefined) {
      errors.push({ line: s.line, message: `there is already a "## ${reserved}" section on line ${earlier}. Merge the two.` });
      continue;
    }
    reservedAt.set(reserved, s.line);
    if (reserved === 'Goal') goal = freeText(s.items);
    else if (reserved === 'Instructions') instructions = freeText(s.items);
    else if (reserved === 'Variables') variables = readVariables(s, errors);
    else if (reserved === 'Attachments') attachments = readAttachments(s, errors);
    else flow = s;
  }

  const idLines = new Map<string, number>();
  for (const s of stepSections) {
    const { id } = stepHeading(s.title);
    if (!id) continue;
    const earlier = idLines.get(id);
    if (earlier !== undefined) errors.push({ line: s.line, message: `the step id ${id} is used twice (also on line ${earlier}). Give one of them another id, or remove the id to get a new one.` });
    else idLines.set(id, s.line);
  }
  const warnings: GraphFileError[] = [];
  const steps = stepSections.map((s) => readStep(s, errors, warnings)).filter((s): s is DocStep => s !== null);
  const edges = flow ? readFlow(flow, new Set(idLines.keys()), errors) : [];
  // Shape problems warn and do not block the read (ruling R26): the canvas can save a condition whose arrows are not yet
  // labeled, and the graph must still open to be fixed. validateRunnable refuses to run it with the same messages.
  if (!errors.length) warnings.push(...shapeErrors(steps, edges));
  if (errors.length) return { ok: false, errors: errors.sort((a, b) => a.line - b.line) };
  warnings.sort((a, b) => a.line - b.line);
  return { ok: true, doc: { name: h1!.title, goal, instructions, variables, ...(attachments?.names.length && { attachments }), steps, edges }, ...(warnings.length > 0 && { warnings }) };
}

/**
 * The condition, stop and label rules (spec §2), checked when the file has no other error. They are returned as warnings
 * (ruling R26). A problem with a step is on its heading; a problem with an arrow is on the arrow's line in the Flow.
 */
function shapeErrors(steps: DocStep[], edges: FlowEdge[]): GraphFileError[] {
  const lineOf = new Map<string, number>();
  const nodes = steps.map((s, k): GraphNode => {
    const { line, id, ...content } = s;
    const nodeId = id ?? `step-without-id-${k}`;
    lineOf.set(nodeId, line);
    return { id: nodeId, ...content, createdBy: 'user', updatedBy: 'user', updatedAt: '' };
  });
  const graph: Graph = {
    id: '',
    name: '',
    goal: '',
    instructions: '',
    variables: [],
    nodes,
    edges: edges.map(({ from, to, label }) => ({ id: edgeId(from, to), from, to, ...(label && { label }) })),
    nodeSeq: 0,
    updatedAt: '',
  };
  return shapeProblems(graph).map((p) => {
    const arrow = edges.find((e) => p.message.startsWith(`${e.from} -> ${e.to}:`));
    return { line: arrow?.line ?? lineOf.get(p.nodeId) ?? 1, message: p.message };
  });
}

/** The file's lines: a leading BOM dropped, CRLF and CR read as LF. */
function normalizeLines(text: string): string[] {
  return text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n');
}
