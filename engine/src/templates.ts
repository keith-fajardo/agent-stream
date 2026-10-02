import { randomBytes } from 'node:crypto';
import * as nunjucksModule from 'nunjucks';

type Token = { type: string; value: string; lineno: number; colno: number };
type AstNode = { typename: string; fields: string[]; value?: unknown; [field: string]: unknown };
type Runtime = {
  memberLookup(obj: unknown, val: unknown): unknown;
  contextOrFrameLookup(context: unknown, frame: unknown, name: string): unknown;
  markSafe(value: unknown): unknown;
};
type NunjucksInternals = {
  runtime: Runtime;
  lib: { escape(s: string): string };
  lexer: { lex(src: string): { nextToken(): Token | null } };
  parser: { parse(src: string): AstNode };
};

// Nunjucks is CommonJS; this works whether the bundler hands us the module or its default export.
const nunjucks = ((nunjucksModule as { default?: unknown }).default ?? nunjucksModule) as typeof nunjucksModule & NunjucksInternals;
nunjucks.installJinjaCompat();

// Nunjucks is not a sandbox: block the JavaScript escape hatches (`range.constructor(...)`, `__proto__`, ...).
const BLOCKED_NAMES: ReadonlySet<unknown> = new Set(['constructor', '__proto__', 'prototype', '__defineGetter__', '__defineSetter__', '__lookupGetter__', '__lookupSetter__']);
const runtime = nunjucks.runtime;
const memberLookup = runtime.memberLookup;
const contextOrFrameLookup = runtime.contextOrFrameLookup;
runtime.memberLookup = function (this: unknown, obj: unknown, val: unknown) {
  return BLOCKED_NAMES.has(val) ? undefined : memberLookup.call(this, obj, val);
};
runtime.contextOrFrameLookup = function (this: unknown, context: unknown, frame: unknown, name: string) {
  return BLOCKED_NAMES.has(name) ? undefined : contextOrFrameLookup.call(this, context, frame, name);
};

// Command rendering: with autoescape on, Nunjucks sends every `{{ }}` output through lib.escape (unless it is
// marked safe). During a command render that hook records the value and returns a placeholder; the placeholders
// are then replaced by the value quoted for the shell context they landed in. Quoting protects how the shell
// parses the command line; commands that re-parse their arguments as shell (eval, sh -c, ssh) are the author's
// responsibility.
type ActiveRender = { nonce: string; values: string[]; placeholder: RegExp };
let activeRender: ActiveRender | undefined;
const originalEscape = nunjucks.lib.escape;
nunjucks.lib.escape = (s: string) => {
  const r = activeRender;
  if (!r) return originalEscape(s);
  const raw = s.replace(r.placeholder, (_m, i: string) => r.values[Number(i)]); // set-block captures: quote once
  r.values.push(raw);
  return `\u0000${r.nonce}:${r.values.length - 1}\u0000`;
};

/** Names every template may use without defining them as graph variables. */
export const TEMPLATE_GLOBALS: ReadonlySet<string> = new Set(['env_var', 'range', 'cycler', 'joiner', 'loop', 'True', 'False', 'None']);

/** Looks an environment variable up; undefined when it is not set. */
export type EnvLookup = (name: string) => string | undefined;
export type RenderOptions = { mode: 'text' | 'command'; context: Record<string, unknown>; env: EnvLookup };

/** POSIX single-quoting: one argument for any value, including quotes, spaces and newlines. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

type Located = Token & { offset: number };
type Tag = { kind: 'variable' | 'block'; open: Located; close: Located; inner: Located[] };

function lex(src: string): Located[] {
  const lineStarts = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === '\n') lineStarts.push(i + 1);
  const out: Located[] = [];
  const lexer = nunjucks.lexer.lex(src);
  for (let t = lexer.nextToken(); t; t = lexer.nextToken()) out.push({ ...t, offset: lineStarts[t.lineno] + t.colno });
  return out;
}

/** `{{ }}` and `{% %}` tags outside {% raw %}/{% verbatim %} blocks, with their tokens. */
function tagsOf(src: string): Tag[] {
  const all = lex(src);
  const out: Tag[] = [];
  let rawEnd: string | undefined;
  for (let i = 0; i < all.length; i++) {
    const t = all[i];
    if (t.type !== 'variable-start' && t.type !== 'block-start') continue;
    const closeType = t.type === 'variable-start' ? 'variable-end' : 'block-end';
    let j = i + 1;
    while (j < all.length && all[j].type !== closeType) j++;
    if (j >= all.length) break; // unterminated: the parser reports it
    const inner = all.slice(i + 1, j);
    const first = inner.find((x) => x.type !== 'whitespace');
    i = j;
    if (rawEnd) {
      if (t.type === 'block-start' && first?.value === rawEnd) rawEnd = undefined;
      continue;
    }
    if (t.type === 'block-start' && (first?.value === 'raw' || first?.value === 'verbatim')) {
      rawEnd = `end${first.value}`;
      continue;
    }
    out.push({ kind: t.type === 'variable-start' ? 'variable' : 'block', open: t, close: all[j], inner });
  }
  return out;
}

/** Renames symbol references to a variable inside tags (not attributes after `.` or filter names after `|`). */
export function renameReferences(src: string, from: string, to: string): string {
  let tags: Tag[];
  try {
    tags = tagsOf(src);
  } catch {
    return src;
  }
  const offsets: number[] = [];
  for (const tag of tags) {
    let prev: Located | undefined;
    for (const t of tag.inner) {
      if (t.type === 'whitespace') continue;
      const afterDotOrPipe = prev !== undefined && ((prev.type === 'operator' && prev.value === '.') || prev.type === 'pipe');
      if (t.type === 'symbol' && t.value === from && !afterDotOrPipe) offsets.push(t.offset);
      prev = t;
    }
  }
  let out = src;
  for (const offset of offsets.reverse()) out = out.slice(0, offset) + to + out.slice(offset + from.length);
  return out;
}

function isNode(x: unknown): x is AstNode {
  return typeof x === 'object' && x !== null && typeof (x as AstNode).typename === 'string';
}

function symbolsIn(node: unknown, out: Set<string>): void {
  if (Array.isArray(node)) return node.forEach((c) => symbolsIn(c, out));
  if (!isNode(node)) return;
  if (node.typename === 'Symbol') out.add(String(node.value));
  for (const f of node.fields) symbolsIn(node[f], out);
}

function walk(node: unknown, used: Set<string>, bound: Set<string>): void {
  if (Array.isArray(node)) return node.forEach((c) => walk(c, used, bound));
  if (!isNode(node)) return;
  switch (node.typename) {
    case 'Symbol':
      used.add(String(node.value));
      return;
    case 'Filter':
    case 'FilterAsync':
      return walk(node.args, used, bound); // node.name is the filter, not a variable
    case 'Is':
      return walk(node.left, used, bound); // node.right is a test name such as `defined`
    case 'For':
    case 'AsyncEach':
    case 'AsyncAll':
      symbolsIn(node.name, bound);
      bound.add('loop');
      walk(node.arr, used, bound);
      walk(node.body, used, bound);
      return walk(node.else_, used, bound);
    case 'Set':
      symbolsIn(node.targets, bound);
      walk(node.value, used, bound);
      return walk(node.body, used, bound);
    case 'Macro':
    case 'Caller':
      symbolsIn(node.name, bound);
      symbolsIn(node.args, bound);
      return walk(node.body, used, bound);
    case 'Pair':
      if (!isNode(node.key) || node.key.typename !== 'Symbol') walk(node.key, used, bound);
      return walk(node.value, used, bound);
  }
  for (const f of node.fields) walk(node[f], used, bound);
}

/** Names the template uses but does not define itself (loop variables, {% set %}, macros) and that aren't globals. */
export function templateNames(src: string): { ok: true; names: string[] } | { ok: false; error: string } {
  let root: AstNode;
  try {
    root = nunjucks.parser.parse(src);
  } catch (e) {
    return { ok: false, error: templateErrorMessage(e) };
  }
  const used = new Set<string>();
  const bound = new Set<string>();
  walk(root, used, bound);
  return { ok: true, names: [...used].filter((n) => !bound.has(n) && !TEMPLATE_GLOBALS.has(n)).sort() };
}

/** Nunjucks messages without their "(unknown path)" noise; "line N: " when Nunjucks knows the line. */
export function templateErrorMessage(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  const where = /\[Line (\d+), Column \d+\]/.exec(raw);
  const message = raw
    .replace(/Template render error:/g, '')
    .replace(/\(unknown path\)/g, '')
    .replace(/\[Line \d+, Column \d+\]/g, '')
    .replace(/\bError: /g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return where ? `line ${where[1]}: ${message}` : message;
}

const REFUSE_BACKSLASH = 'A \\ right before {{ }} would cancel its quoting. Remove the backslash.';
const REFUSE_SUBSTITUTION = "{{ }} inside a command substitution within double quotes can't be quoted safely. Move it outside the quotes.";
const REFUSE_HEREDOC = "{{ }} after a heredoc (<<) can't be quoted safely. Pass the value as an argument instead.";

/** Replaces each placeholder with its value quoted for the POSIX quoting context it landed in. */
function quotePlaceholders(rendered: string, r: ActiveRender): string {
  let out = '';
  let state: 'out' | 'single' | 'double' = 'out';
  let doubleStart = 0;
  let heredoc = false;
  const marker = `\u0000${r.nonce}:`;
  for (let i = 0; i < rendered.length; ) {
    if (rendered.startsWith(marker, i)) {
      const end = rendered.indexOf('\u0000', i + marker.length);
      const value = r.values[Number(rendered.slice(i + marker.length, end))];
      if (state === 'out') {
        if (heredoc) throw new Error(REFUSE_HEREDOC);
        out += shellQuote(value);
      } else if (state === 'single') {
        out += value.replace(/'/g, `'\\''`);
      } else {
        const since = rendered.slice(doubleStart, i);
        if (since.includes('$(') || since.includes('`')) throw new Error(REFUSE_SUBSTITUTION);
        out += value.replace(/[\\"$`]/g, '\\$&');
      }
      i = end + 1;
      continue;
    }
    const c = rendered[i];
    if (state === 'single') {
      if (c === "'") state = 'out';
    } else if (c === '\\') {
      if (rendered.startsWith(marker, i + 1)) throw new Error(REFUSE_BACKSLASH);
      out += rendered.slice(i, i + 2);
      i += 2;
      continue;
    } else if (state === 'double') {
      if (c === '"') state = 'out';
    } else if (c === "'") {
      state = 'single';
    } else if (c === '"') {
      state = 'double';
      doubleStart = i + 1;
    } else if (c === '<' && rendered[i + 1] === '<') {
      if (rendered[i + 2] === '<') {
        out += '<<<';
        i += 3;
        continue;
      }
      heredoc = true;
      out += '<<';
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

export function renderTemplate(src: string, o: RenderOptions): string {
  const command = o.mode === 'command';
  // No loaders: {% include %}, {% import %} and {% extends %} can't read files.
  const env = new nunjucks.Environment([], { autoescape: command, throwOnUndefined: true });
  env.addFilter('unquoted', (value: unknown) => (command && value !== undefined && value !== null ? nunjucks.runtime.markSafe(String(value)) : value));
  if (command) {
    env.addFilter('safe', () => {
      throw new Error('Use | unquoted to insert a value without quotes.');
    });
  }
  env.addGlobal('env_var', (name: unknown, fallback?: unknown) => {
    const value = o.env(String(name));
    if (value !== undefined) return value;
    if (fallback !== undefined) return String(fallback);
    throw new Error(`environment variable ${String(name)} is not set on this machine`);
  });
  if (!command) return env.renderString(src, o.context);
  const nonce = randomBytes(8).toString('hex');
  const render: ActiveRender = { nonce, values: [], placeholder: new RegExp(`\u0000${nonce}:(\\d+)\u0000`, 'g') };
  let rendered: string;
  activeRender = render;
  try {
    rendered = env.renderString(src, o.context);
  } finally {
    activeRender = undefined;
  }
  return quotePlaceholders(rendered, render);
}
