import { fenceCloses, fenceOpening, type Fence } from './fence';

/** After any backslashes: a line the reader would take for an H1 or H2 heading. */
const HEADING_LIKE = /^\\*#{1,2}(?:[ \t]|$)/;
/** A fence line already escaped with at least one backslash. */
const ESCAPED_FENCE = /^\\+ {0,3}(?:`{3,}|~{3,})/;
/** The backslash `escapeFreeText` added. */
const ADDED_ESCAPE = /^\\(?=\\*#{1,2}(?:[ \t]|$)|\\* {0,3}(?:`{3,}|~{3,}))/;

/** Which lines are inside a fenced block (fence lines included), reading `plain` lines as text; and an unclosed opening's index. */
function scanFences(lines: readonly string[], plain: ReadonlySet<number>): { inFence: boolean[]; unclosed: number | null } {
  const inFence = lines.map(() => false);
  let open: (Fence & { at: number }) | null = null;
  for (let i = 0; i < lines.length; i++) {
    if (open) {
      inFence[i] = true;
      if (fenceCloses(lines[i], open)) open = null;
      continue;
    }
    if (plain.has(i)) continue;
    const f = fenceOpening(lines[i]);
    if (f) {
      open = { ...f, at: i };
      inFence[i] = true;
    }
  }
  return { inFence, unclosed: open ? open.at : null };
}

/**
 * Goal or Instructions text as it is written under its heading, so reading it back gives exactly `text` (spec §4.2).
 * Outside fenced blocks, a line that would read as an H1 or H2 heading, an already escaped fence line, and the opening
 * of a block that is never closed each get one leading backslash. Markdown shows them as the plain text they were.
 */
export function escapeFreeText(text: string): string {
  const lines = text.split('\n');
  const plain = new Set<number>();
  for (;;) {
    const { inFence, unclosed } = scanFences(lines, plain);
    if (unclosed === null) {
      return lines.map((line, i) => (!inFence[i] && (plain.has(i) || HEADING_LIKE.test(line) || ESCAPED_FENCE.test(line)) ? `\\${line}` : line)).join('\n');
    }
    plain.add(unclosed);
  }
}

/** Undoes `escapeFreeText` for one line outside a fenced block. */
export function unescapeFreeTextLine(line: string): string {
  return line.replace(ADDED_ESCAPE, '');
}
