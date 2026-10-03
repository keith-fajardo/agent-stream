import { readdirSync, readFileSync, statSync, type Dirent, type Stats } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { truncateHead } from '../prompt';
import type { ToolSpec } from './chatModel';
import { globToRegExp } from './glob';

/** What a tool returns to the model. */
export type ToolOutput = { text: string; isError?: boolean };
/** A tool the agent loop offers: what the model sees, the name the gate decides on, and what it does. */
export type LoopTool = { spec: ToolSpec; gateName: string; run(input: unknown, signal: AbortSignal): Promise<ToolOutput> };

export const MAX_RESULT_CHARS = 30_000;
const READ_LIMIT = 2000;
const MAX_LINE_CHARS = 2000;
const MAX_GLOB_RESULTS = 1000;
const MAX_GREP_MATCHES = 500;
const MAX_GREP_LINE_CHARS = 500;
const MAX_GREP_FILE_BYTES = 2 * 1024 * 1024;
const BINARY_SNIFF_BYTES = 8192;

/** Head and tail kept, the middle cut with the existing truncateHead's note (spec §4.2). */
export function clipResult(text: string, max: number = MAX_RESULT_CHARS): string {
  if (text.length <= max) return text;
  const half = Math.floor(max / 2);
  return `${truncateHead(text.slice(0, text.length - half), half)}\n${text.slice(text.length - half)}`;
}

/** A leading `~` is the home folder (as privatePathDenial reads it); anything else resolves against the tool's folder. */
export function toolPath(cwd: string, p: string): string {
  return resolve(cwd, /^~(?=$|[\\/])/.test(p) ? join(homedir(), p.slice(1)) : p);
}

/** How results name a file: relative to the working folder when inside it, else absolute. */
function shown(cwd: string, file: string): string {
  const rel = relative(cwd, file);
  return rel !== '' && rel.split(sep)[0] !== '..' && !isAbsolute(rel) ? rel : file;
}

const statOf = (p: string): Stats | undefined => {
  try {
    return statSync(p);
  } catch {
    return undefined;
  }
};
const readOf = (p: string): Buffer | undefined => {
  try {
    return readFileSync(p);
  } catch {
    return undefined;
  }
};
const isBinary = (buf: Buffer) => buf.subarray(0, BINARY_SNIFF_BYTES).includes(0);
const posixRelative = (root: string, file: string) => relative(root, file).split(sep).join('/');

const SKIPPED_FOLDERS = new Set(['.git', 'node_modules']);
/** Agent Stream's own private folders, skipped wherever a `.agent-stream` folder is met. */
const AGENT_STREAM_PRIVATE = new Set(['runs', 'sessions']);

/** Every file under `dir`, in name order, not following links, skipping .git, node_modules and .agent-stream/{runs,sessions}. */
function* walk(dir: string): Generator<string> {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIPPED_FOLDERS.has(e.name) || (AGENT_STREAM_PRIVATE.has(e.name) && basename(dir) === '.agent-stream')) continue;
      yield* walk(full);
    } else if (e.isFile()) yield full;
  }
}

/** A tool whose input is checked with zod first; every result is clipped, and a throw becomes an error result. */
export function defineLoopTool<S extends z.ZodType>(
  name: string,
  description: string,
  schema: S,
  run: (input: z.infer<S>, signal: AbortSignal) => Promise<ToolOutput>,
): LoopTool {
  return {
    spec: { name, description, inputSchema: z.toJSONSchema(schema) },
    gateName: name,
    async run(input, signal) {
      const parsed = schema.safeParse(input ?? {});
      if (!parsed.success) return { text: z.prettifyError(parsed.error), isError: true };
      try {
        const out = await run(parsed.data, signal);
        return { ...out, text: clipResult(out.text) };
      } catch (e) {
        return { text: e instanceof Error ? e.message : String(e), isError: true };
      }
    },
  };
}

const readInput = z.object({
  file_path: z.string().describe('The file to read: absolute, or relative to the working folder.'),
  offset: z.number().int().positive().optional().describe('The line number to start at (1-based).'),
  limit: z.number().int().positive().optional().describe('How many lines to read (default 2000).'),
});
const grepInput = z.object({
  pattern: z.string().describe('A JavaScript regular expression, matched against each line.'),
  path: z.string().optional().describe('The folder or file to search (default: the working folder).'),
  glob: z.string().optional().describe('Only files matching this glob: a name such as *.ts, or a path such as src/**/*.ts.'),
});
const globInput = z.object({
  pattern: z.string().describe('A glob such as **/*.ts or src/*.{js,ts}, matched against paths relative to the searched folder.'),
  path: z.string().optional().describe('The folder to search (default: the working folder).'),
});

/** Read, Grep and Glob (spec §4.2): everything a read-only step or the planner gets. */
export function readOnlyTools(cwd: string): LoopTool[] {
  return [
    defineLoopTool('Read', 'Read a text file. Lines come numbered from 1; use offset and limit for long files.', readInput, async ({ file_path, offset, limit }) => {
      const file = toolPath(cwd, file_path);
      const st = statOf(file);
      if (!st) return { text: `File not found: ${file}`, isError: true };
      if (st.isDirectory()) return { text: `${file} is a folder, not a file. Use Glob to list it.`, isError: true };
      const buf = readFileSync(file);
      if (isBinary(buf)) return { text: `${file} is a binary file.`, isError: true };
      const lines = buf.toString('utf8').split(/\r?\n/);
      if (lines.at(-1) === '') lines.pop(); // a final newline doesn't start another line
      if (lines.length === 0) return { text: '(The file is empty.)' };
      const start = (offset ?? 1) - 1;
      if (start >= lines.length) return { text: `The file has ${lines.length} lines; offset ${offset} is past the end.`, isError: true };
      return {
        text: lines
          .slice(start, start + (limit ?? READ_LIMIT))
          .map((line, i) => `${String(start + i + 1).padStart(6)}\t${line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line}`)
          .join('\n'),
      };
    }),
    defineLoopTool('Grep', 'Search file contents with a JavaScript regular expression, line by line. Results are file:line: text.', grepInput, async ({ pattern, path, glob }) => {
      let re: RegExp;
      try {
        re = new RegExp(pattern);
      } catch (e) {
        return { text: `Invalid regular expression: ${(e as Error).message}`, isError: true };
      }
      const root = toolPath(cwd, path || '.');
      const st = statOf(root);
      if (!st) return { text: `Not found: ${root}`, isError: true };
      const filter = glob ? globToRegExp(glob) : undefined;
      const byPath = !!glob && /[\\/]/.test(glob);
      const files = st.isDirectory() ? walk(root) : [root];
      const out: string[] = [];
      let stopped = false;
      search: for (const file of files) {
        if (filter && st.isDirectory() && !filter.test(byPath ? posixRelative(root, file) : basename(file))) continue;
        const size = statOf(file)?.size;
        if (size === undefined || size > MAX_GREP_FILE_BYTES) continue;
        const buf = readOf(file);
        if (!buf || isBinary(buf)) continue;
        const lines = buf.toString('utf8').split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          if (!re.test(lines[i])) continue;
          if (out.length === MAX_GREP_MATCHES) {
            stopped = true;
            break search;
          }
          const line = lines[i].length > MAX_GREP_LINE_CHARS ? `${lines[i].slice(0, MAX_GREP_LINE_CHARS)}…` : lines[i];
          out.push(`${shown(cwd, file)}:${i + 1}: ${line}`);
        }
      }
      if (out.length === 0) return { text: 'No matches found.' };
      if (stopped) out.push(`(Stopped after ${MAX_GREP_MATCHES} matches.)`);
      return { text: out.join('\n') };
    }),
    defineLoopTool('Glob', 'Find files by a glob pattern such as **/*.ts. Results are newest first.', globInput, async ({ pattern, path }) => {
      const root = toolPath(cwd, path || '.');
      if (!statOf(root)?.isDirectory()) return { text: `Folder not found: ${root}`, isError: true };
      const re = globToRegExp(pattern);
      const found: { file: string; mtime: number }[] = [];
      for (const file of walk(root)) if (re.test(posixRelative(root, file))) found.push({ file, mtime: statOf(file)?.mtimeMs ?? 0 });
      if (found.length === 0) return { text: 'No files found.' };
      found.sort((a, b) => b.mtime - a.mtime);
      const lines = found.slice(0, MAX_GLOB_RESULTS).map((f) => shown(cwd, f.file));
      if (found.length > MAX_GLOB_RESULTS) lines.push(`(Showing the newest ${MAX_GLOB_RESULTS} of ${found.length} files.)`);
      return { text: lines.join('\n') };
    }),
  ];
}
