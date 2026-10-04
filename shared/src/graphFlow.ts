import { edgeId, emptyGraph, wouldCreateCycle } from './graph';
import type { Edge, GraphFileError } from './types';

/** One line inside the Flow's mermaid block, numbered as in the file. */
export type FlowLine = { line: number; text: string };
/** An arrow of the Flow, with the line it is on. */
export type FlowEdge = { from: string; to: string; line: number };

const HEADER_RE = /^(?:flowchart|graph)(?:[ \t]+(?:LR|RL|TD|TB|BT))?[ \t]*;?$/;
const KEYWORD_RE = /^(subgraph|end|classDef|class|style|linkStyle|click|direction)(?=[ \t;]|$)/;
const ID_CHAR_RE = /[A-Za-z0-9_-]/;
export const ONLY_ARROWS = 'The Flow holds only arrows between step ids, such as n1 --> n2, with optional labels such as n1["Title"].';

/** The step ids of one Flow line in order (`a --> b --> c`), or why the line isn't a chain of arrows. Labels are skipped. */
export function parseChain(text: string): { ok: true; ids: string[] } | { ok: false; error: string } {
  let i = 0;
  const skipSpace = () => {
    while (text[i] === ' ' || text[i] === '\t') i++;
  };
  const readRef = (): string | { error: string } => {
    const start = i;
    while (i < text.length && ID_CHAR_RE.test(text[i]) && !(text[i] === '-' && /[-.=]/.test(text[i + 1] ?? ''))) i++;
    if (i === start) return { error: `"${text.slice(i).trim()}" isn't a step id. ${ONLY_ARROWS}` };
    const id = text.slice(start, i);
    const open = text[i];
    if (open !== '[' && open !== '(') return id;
    const close = open === '[' ? ']' : ')';
    const quoted = text[i + 1] === '"';
    const end = quoted ? text.indexOf(`"${close}`, i + 2) : text.indexOf(close, i + 1);
    if (end < 0) return { error: `the label after ${id} isn't closed. Write it as ${id}["Title"].` };
    i = end + (quoted ? 2 : 1);
    return id;
  };
  const ids: string[] = [];
  skipSpace();
  for (;;) {
    const ref = readRef();
    if (typeof ref !== 'string') return { ok: false, error: ref.error };
    ids.push(ref);
    skipSpace();
    if (i >= text.length || (text[i] === ';' && text.slice(i + 1).trim() === '')) return { ok: true, ids };
    const next = text[i + 3];
    if (!text.startsWith('-->', i) || next === '-' || next === '>' || next === '|') return { ok: false, error: `"${text.slice(i).trim()}" isn't supported. ${ONLY_ARROWS}` };
    i += 3;
    skipSpace();
    if (i >= text.length) return { ok: false, error: 'an arrow at the end of the line has no step after it.' };
  }
}

/**
 * Reads the Flow's mermaid block (Markdown graph files spec §2.3): the edges in the order they appear, each checked the
 * way the connect operation checks it, and every problem with its line. `openLine` is the block's opening fence.
 */
export function parseFlow(lines: FlowLine[], stepIds: ReadonlySet<string>, openLine: number): { edges: FlowEdge[]; errors: GraphFileError[] } {
  const edges: FlowEdge[] = [];
  const errors: GraphFileError[] = [];
  let accepted: Edge[] = [];
  let header = false;
  for (const { line, text: raw } of lines) {
    const text = raw.trim();
    if (!text || text.startsWith('%%')) continue;
    if (!header) {
      header = true;
      if (HEADER_RE.test(text)) continue;
      errors.push({ line, message: 'the mermaid block must start with "flowchart LR" (or TD, TB, RL, BT).' });
    }
    const keyword = KEYWORD_RE.exec(text);
    if (keyword) {
      errors.push({ line, message: `"${keyword[1]}" isn't supported in the Flow. ${ONLY_ARROWS}` });
      continue;
    }
    const chain = parseChain(text);
    if (!chain.ok) {
      errors.push({ line, message: chain.error });
      continue;
    }
    const missing = [...new Set(chain.ids.filter((id) => !stepIds.has(id)))];
    for (const id of missing) {
      errors.push({ line, message: `the Flow block mentions ${id}, but there is no "## ${id} · …" step section. Add one or remove ${id} from the Flow.` });
    }
    if (missing.length) continue;
    for (let k = 0; k + 1 < chain.ids.length; k++) {
      const from = chain.ids[k];
      const to = chain.ids[k + 1];
      const problem =
        from === to
          ? `${from} --> ${to}: a step can't connect to itself. Remove this arrow.`
          : accepted.some((e) => e.from === from && e.to === to)
            ? `${from} --> ${to} is in the Flow twice. Remove one of them.`
            : wouldCreateCycle({ ...emptyGraph('', '', ''), edges: accepted }, from, to)
              ? `${from} --> ${to} would make a cycle. Steps run in arrow order, so the arrows can't loop back.`
              : null;
      if (problem) {
        errors.push({ line, message: problem });
        continue;
      }
      accepted = [...accepted, { id: edgeId(from, to), from, to }];
      edges.push({ from, to, line });
    }
  }
  if (!header) errors.push({ line: openLine, message: 'the mermaid block is empty. Start it with "flowchart LR", then one arrow per line, such as n1 --> n2.' });
  return { edges, errors };
}
