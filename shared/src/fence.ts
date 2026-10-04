/** A Markdown code fence: its character and length (CommonMark fenced code blocks). */
export type Fence = { char: '`' | '~'; len: number };

/** The longest run of `ch` in `text`; 0 when there is none. */
export function longestRun(text: string, ch: string): number {
  let best = 0;
  let run = 0;
  for (const c of text) {
    run = c === ch ? run + 1 : 0;
    if (run > best) best = run;
  }
  return best;
}

/** The shortest backtick fence, at least 3, that is longer than any backtick run in `content`, so the content can't close it. */
export function fenceFor(content: string): string {
  return '`'.repeat(Math.max(3, longestRun(content, '`') + 1));
}

const OPEN_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const CLOSE_RE = /^ {0,3}(`+|~+)[ \t]*$/;

/** The fence `line` opens, with its info string, or null. A backtick fence's info string can't hold a backtick. */
export function fenceOpening(line: string): (Fence & { info: string }) | null {
  const m = OPEN_RE.exec(line);
  if (!m) return null;
  const char = m[1][0] as Fence['char'];
  if (char === '`' && m[2].includes('`')) return null;
  return { char, len: m[1].length, info: m[2].trim() };
}

/** Whether `line` closes `open`: the same character, at least as many, and nothing after them. */
export function fenceCloses(line: string, open: Fence): boolean {
  const m = CLOSE_RE.exec(line);
  return !!m && m[1][0] === open.char && m[1].length >= open.len;
}
