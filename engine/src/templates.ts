import * as nunjucksModule from 'nunjucks';

type Token = { type: string; value: string; lineno: number; colno: number };
type AstNode = { typename: string; fields: string[]; value?: unknown; [field: string]: unknown };
type NunjucksInternals = {
  lexer: { lex(src: string): { nextToken(): Token | null } };
  parser: { parse(src: string): AstNode };
};

// Nunjucks is CommonJS; this works whether the bundler hands us the module or its default export.
const nunjucks = ((nunjucksModule as { default?: unknown }).default ?? nunjucksModule) as typeof nunjucksModule & NunjucksInternals;
nunjucks.installJinjaCompat();

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

/** Rewrites each `{{ expr }}` to `{{ (expr) | _shq }}` unless its last filter is `unquoted`. */
export function quoteCommandTemplate(src: string): string {
  let out = '';
  let pos = 0;
  for (const tag of tagsOf(src)) {
    if (tag.kind !== 'variable') continue;
    const significant = tag.inner.filter((x) => x.type !== 'whitespace');
    const n = significant.length;
    if (n >= 2 && significant[n - 2].type === 'pipe' && significant[n - 1].type === 'symbol' && significant[n - 1].value === 'unquoted') continue;
    const exprStart = tag.open.offset + tag.open.value.length;
    out += `${src.slice(pos, exprStart)} (${src.slice(exprStart, tag.close.offset).trim()}) | _shq `;
    pos = tag.close.offset;
  }
  return out + src.slice(pos);
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

export function renderTemplate(src: string, o: RenderOptions): string {
  // No loaders: {% include %}, {% import %} and {% extends %} can't read files.
  const env = new nunjucks.Environment([], { autoescape: false, throwOnUndefined: true });
  env.addFilter('unquoted', (value: unknown) => value);
  env.addFilter('_shq', (value: unknown) => {
    if (value === undefined || value === null) throw new Error('attempted to output null or undefined value');
    return shellQuote(String(value));
  });
  env.addGlobal('env_var', (name: unknown, fallback?: unknown) => {
    const value = o.env(String(name));
    if (value !== undefined) return value;
    if (fallback !== undefined) return String(fallback);
    throw new Error(`environment variable ${String(name)} is not set on this machine`);
  });
  return env.renderString(o.mode === 'command' ? quoteCommandTemplate(src) : src, o.context);
}
