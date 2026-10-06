import { lstatSync, mkdirSync, readdirSync, readFileSync, statSync, type Dirent, type Stats } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { Worker } from 'node:worker_threads';
import { z } from 'zod';
import { writeFileAtomic } from '../fsutil';
import { PRIVATE_FOLDER } from '../privatePaths';
import { truncateHead } from '../prompt';
import type { RunShell } from '../shell';
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
const MAX_READ_BYTES = 2 * 1024 * 1024;
const BINARY_SNIFF_BYTES = 8192;
const MAX_GLOB_FOUND = 10_000;
/** Glob stops walking after this many entries, and lets the event loop run (so Stop is seen) every GLOB_YIELD_EVERY. */
const MAX_GLOB_ENTRIES = 200_000;
const GLOB_YIELD_EVERY = 2000;
/** How long Grep may search before it is stopped: a model-supplied pattern can backtrack catastrophically. */
export const GREP_TIMEOUT_MS = 20_000;

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
/** Like statOf but does not follow a final symlink. */
const lstatOf = (p: string): Stats | undefined => {
  try {
    return lstatSync(p);
  } catch {
    return undefined;
  }
};
const isBinary = (buf: Buffer) => buf.subarray(0, BINARY_SNIFF_BYTES).includes(0);
const posixRelative = (root: string, file: string) => relative(root, file).split(sep).join('/');

const CASE_INSENSITIVE_FS = process.platform === 'win32' || process.platform === 'darwin';

/** True for `.agent-stream/runs` or `.agent-stream/sessions` under any folder, and anything inside them. */
function isPrivatePath(resolved: string): boolean {
  const parts = (CASE_INSENSITIVE_FS ? resolved.toLowerCase() : resolved).split(sep);
  return parts.some((part, i) => part === '.agent-stream' && AGENT_STREAM_PRIVATE.has(parts[i + 1]));
}

/** `<…>/.agent-stream/runs/<run>/nodes/<node>/output.md`: the file a truncated upstream result points the step at. */
function isUpstreamOutput(resolved: string): boolean {
  const parts = (CASE_INSENSITIVE_FS ? resolved.toLowerCase() : resolved).split(sep);
  const i = parts.length - 6;
  return i >= 0 && parts[i] === '.agent-stream' && parts[i + 1] === 'runs' && parts[i + 3] === 'nodes' && parts[i + 5] === 'output.md';
}

/** Private, and not an upstream output.md that a step is told to read (which must be a regular file, not a folder of that name). */
const refusedFile = (resolved: string) => isPrivatePath(resolved) && !(isUpstreamOutput(resolved) && lstatOf(resolved)?.isFile());

/** Why a resolved path in `.agent-stream/runs` or `.agent-stream/sessions` may not be read (an upstream output.md may), or null. */
export function privateFolderDenial(resolved: string): string | null {
  return refusedFile(resolved) ? PRIVATE_FOLDER : null;
}

/** Why a resolved path in `.agent-stream/runs` or `.agent-stream/sessions` may not be changed: like Edit and Write, with no upstream output.md exception. */
export function privateFolderWriteDenial(resolved: string): string | null {
  return isPrivatePath(resolved) ? PRIVATE_FOLDER : null;
}

const SKIPPED_FOLDERS = new Set(['.git', 'node_modules']);
/** Agent Stream's own private folders, skipped wherever a `.agent-stream` folder is met. */
const AGENT_STREAM_PRIVATE = new Set(['runs', 'sessions']);

/** Every file under `dir`, in name order, not following links, skipping .git, node_modules and .agent-stream/{runs,sessions}. */
function* walk(dir: string, limit?: { signal: AbortSignal; max: number; visited: number; hit: boolean }): Generator<string> {
  if (limit && (limit.signal.aborted || limit.hit)) return;
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const e of entries) {
    if (limit) {
      if (limit.hit) return;
      if (++limit.visited > limit.max) {
        limit.hit = true;
        return;
      }
    }
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIPPED_FOLDERS.has(e.name) || (AGENT_STREAM_PRIVATE.has(e.name) && basename(dir) === '.agent-stream')) continue;
      yield* walk(full, limit);
    } else if (e.isFile()) yield full;
  }
}

/**
 * The Grep search as plain Node code run in a worker thread, so a runaway regular expression can be terminated (the
 * main thread cannot interrupt a synchronous `re.test`). Self-contained on purpose: no imports from this package.
 */
const GREP_WORKER_SOURCE = String.raw`
const { workerData, parentPort } = require('node:worker_threads');
const { readdirSync, readFileSync, statSync } = require('node:fs');
const { basename, isAbsolute, join, relative, sep } = require('node:path');
const d = workerData;
const re = new RegExp(d.pattern);
const filter = d.globSource === undefined ? undefined : new RegExp(d.globSource);
const skipped = new Set(['.git', 'node_modules']);
const priv = new Set(['runs', 'sessions']);
function* walk(dir) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (skipped.has(e.name) || (priv.has(e.name) && basename(dir) === '.agent-stream')) continue;
      yield* walk(full);
    } else if (e.isFile()) yield full;
  }
}
function shown(file) {
  const rel = relative(d.cwd, file);
  return rel !== '' && rel.split(sep)[0] !== '..' && !isAbsolute(rel) ? rel : file;
}
const out = [];
let stopped = false;
const files = d.isDir ? walk(d.root) : [d.root];
search: for (const file of files) {
  if (filter && d.isDir && !filter.test(d.byPath ? relative(d.root, file).split(sep).join('/') : basename(file))) continue;
  let size;
  try { size = statSync(file).size; } catch { continue; }
  if (size > d.maxFileBytes) continue;
  let buf;
  try { buf = readFileSync(file); } catch { continue; }
  if (buf.subarray(0, d.sniffBytes).includes(0)) continue;
  const lines = buf.toString('utf8').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!re.test(lines[i])) continue;
    if (out.length === d.maxMatches) { stopped = true; break search; }
    const line = lines[i].length > d.maxLineChars ? lines[i].slice(0, d.maxLineChars) + '…' : lines[i];
    out.push(shown(file) + ':' + (i + 1) + ': ' + line);
  }
}
parentPort.postMessage({ out, stopped });
`;

type GrepOutcome = { out: string[]; stopped: boolean } | 'timeout' | 'cancelled';

function runGrepWorker(data: object, timeoutMs: number, signal: AbortSignal): Promise<GrepOutcome> {
  return new Promise((resolveOutcome, reject) => {
    if (signal.aborted) return resolveOutcome('cancelled');
    const worker = new Worker(GREP_WORKER_SOURCE, { eval: true, workerData: data });
    let done = false;
    const finish = (outcome: GrepOutcome | Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      void worker.terminate();
      if (outcome instanceof Error) reject(outcome);
      else resolveOutcome(outcome);
    };
    const onAbort = () => finish('cancelled');
    const timer = setTimeout(() => finish('timeout'), timeoutMs);
    signal.addEventListener('abort', onAbort, { once: true });
    worker.once('message', (m: { out: string[]; stopped: boolean }) => finish(m));
    worker.once('error', (e: Error) => finish(e));
    worker.once('exit', (code) => finish(new Error(`Grep worker exited with code ${code}.`)));
  });
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
export function readOnlyTools(cwd: string, options: { grepTimeoutMs?: number; globMaxEntries?: number; globYieldEvery?: number } = {}): LoopTool[] {
  const grepTimeoutMs = options.grepTimeoutMs ?? GREP_TIMEOUT_MS;
  const globMaxEntries = options.globMaxEntries ?? MAX_GLOB_ENTRIES;
  const globYieldEvery = options.globYieldEvery ?? GLOB_YIELD_EVERY;
  return [
    defineLoopTool('Read', 'Read a text file. Lines come numbered from 1; use offset and limit for long files.', readInput, async ({ file_path, offset, limit }) => {
      const file = toolPath(cwd, file_path);
      if (refusedFile(file)) return { text: PRIVATE_FOLDER, isError: true };
      const st = statOf(file);
      if (!st) return { text: `File not found: ${file}`, isError: true };
      if (st.isDirectory()) return { text: `${file} is a folder, not a file. Use Glob to list it.`, isError: true };
      if (st.size > MAX_READ_BYTES) return { text: `${file} is larger than 2 MB; too big to read.`, isError: true };
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
    defineLoopTool('Grep', 'Search file contents with a JavaScript regular expression, line by line. Results are file:line: text.', grepInput, async ({ pattern, path, glob }, signal) => {
      try {
        new RegExp(pattern);
      } catch (e) {
        return { text: `Invalid regular expression: ${(e as Error).message}`, isError: true };
      }
      const root = toolPath(cwd, path || '.');
      if (refusedFile(root)) return { text: PRIVATE_FOLDER, isError: true };
      const st = statOf(root);
      if (!st) return { text: `Not found: ${root}`, isError: true };
      const outcome = await runGrepWorker(
        {
          pattern,
          root,
          cwd,
          isDir: st.isDirectory(),
          globSource: glob ? globToRegExp(glob).source : undefined,
          byPath: !!glob && /[\\/]/.test(glob),
          maxFileBytes: MAX_GREP_FILE_BYTES,
          sniffBytes: BINARY_SNIFF_BYTES,
          maxMatches: MAX_GREP_MATCHES,
          maxLineChars: MAX_GREP_LINE_CHARS,
        },
        grepTimeoutMs,
        signal,
      );
      if (outcome === 'cancelled') return { text: 'Cancelled.', isError: true };
      if (outcome === 'timeout') {
        return { text: `Grep stopped after ${Math.round(grepTimeoutMs / 1000)} s; the pattern may be too slow (for example nested quantifiers like (a+)+). Simplify it.`, isError: true };
      }
      const { out, stopped } = outcome;
      if (out.length === 0) return { text: 'No matches found.' };
      if (stopped) out.push(`(Stopped after ${MAX_GREP_MATCHES} matches.)`);
      return { text: out.join('\n') };
    }),
    defineLoopTool('Glob', 'Find files by a glob pattern such as **/*.ts. Results are newest first.', globInput, async ({ pattern, path }, signal) => {
      const root = toolPath(cwd, path || '.');
      if (isPrivatePath(root)) return { text: PRIVATE_FOLDER, isError: true };
      if (!statOf(root)?.isDirectory()) return { text: `Folder not found: ${root}`, isError: true };
      const re = globToRegExp(pattern);
      const found: { file: string; mtime: number }[] = [];
      let capped = false;
      const limit = { signal, max: globMaxEntries, visited: 0, hit: false };
      let sinceYield = 0;
      for (const file of walk(root, limit)) {
        if (++sinceYield >= globYieldEvery) {
          sinceYield = 0;
          await new Promise<void>((done) => setImmediate(done));
        }
        if (signal.aborted) return { text: 'Cancelled.', isError: true };
        if (re.test(posixRelative(root, file))) found.push({ file, mtime: statOf(file)?.mtimeMs ?? 0 });
        if (found.length >= MAX_GLOB_FOUND) {
          capped = true;
          break;
        }
      }
      if (signal.aborted) return { text: 'Cancelled.', isError: true };
      const footer = `Stopped after visiting ${globMaxEntries} entries.`;
      if (found.length === 0) return { text: limit.hit ? footer : 'No files found.' };
      found.sort((a, b) => b.mtime - a.mtime);
      const lines = found.slice(0, MAX_GLOB_RESULTS).map((f) => shown(cwd, f.file));
      if (capped) lines.push(`(Showing the newest ${MAX_GLOB_RESULTS} of more than ${MAX_GLOB_FOUND} files.)`);
      else if (found.length > MAX_GLOB_RESULTS) lines.push(`(Showing the newest ${MAX_GLOB_RESULTS} of ${found.length} files.)`);
      if (limit.hit) lines.push(footer);
      return { text: lines.join('\n') };
    }),
  ];
}

export const BASH_TIMEOUT_SEC = 600;

const editInput = z.object({
  file_path: z.string().describe('The file to change.'),
  old_string: z.string().describe('The exact text to replace.'),
  new_string: z.string().describe('The text to put in its place.'),
  replace_all: z.boolean().optional().describe('Replace every occurrence. Without it, old_string must occur exactly once.'),
});
const writeInput = z.object({
  file_path: z.string().describe('The file to create or overwrite.'),
  content: z.string().describe('The full content of the file.'),
});
const bashInput = z.object({
  command: z.string().describe('The shell command to run.'),
  description: z.string().optional().describe('What the command does, in a few words.'),
});

const occurrences = (text: string, s: string) => text.split(s).length - 1;

/** Edit, Write and Bash: each runs only after the gate allowed it (the loop asks first). */
function writeTools(cwd: string, runShell: RunShell): LoopTool[] {
  return [
    defineLoopTool('Edit', 'Replace text in a file. old_string must occur exactly once unless replace_all is true.', editInput, async ({ file_path, old_string, new_string, replace_all }) => {
      const file = toolPath(cwd, file_path);
      if (isPrivatePath(file)) return { text: PRIVATE_FOLDER, isError: true };
      if (old_string === '') return { text: 'old_string is empty; use Write to create or replace a whole file.', isError: true };
      const st = statOf(file);
      if (!st?.isFile()) return { text: `File not found: ${file}`, isError: true };
      const buf = readFileSync(file);
      if (isBinary(buf)) return { text: `${file} is a binary file.`, isError: true };
      const text = buf.toString('utf8');
      let from = old_string;
      let to = new_string;
      let count = occurrences(text, from);
      if (count === 0 && text.includes('\r\n') && from.includes('\n') && !from.includes('\r')) {
        // Read shows lines without their \r, so on a CRLF file the model writes \n: match with the file's line ends.
        from = from.replace(/\n/g, '\r\n');
        to = to.replace(/\r?\n/g, '\r\n');
        count = occurrences(text, from);
      }
      if (count > 0 && !from.includes('\n') && to.includes('\n') && text.includes('\r\n')) to = to.replace(/\r?\n/g, '\r\n');
      if (count === 0) return { text: `old_string was not found in ${file}.`, isError: true };
      if (count > 1 && !replace_all) return { text: `old_string was found ${count} times in ${file}. Add more surrounding text to make it unique, or set replace_all.`, isError: true };
      writeFileAtomic(file, text.split(from).join(to), st.mode & 0o777);
      return { text: `Edited ${file} (${count} replacement${count === 1 ? '' : 's'}).` };
    }),
    defineLoopTool('Write', 'Create or overwrite a file with the given content. Missing folders are created.', writeInput, async ({ file_path, content }) => {
      const file = toolPath(cwd, file_path);
      if (isPrivatePath(file)) return { text: PRIVATE_FOLDER, isError: true };
      mkdirSync(dirname(file), { recursive: true });
      const existing = statOf(file);
      writeFileAtomic(file, content, existing?.isFile() ? existing.mode & 0o777 : undefined);
      return { text: `Wrote ${file} (${Buffer.byteLength(content)} bytes).` };
    }),
    defineLoopTool('Bash', 'Run a shell command in the working folder (a login shell; Git Bash on Windows). Returns its output and exit code.', bashInput, async ({ command }, signal) => {
      const r = await runShell({ command, cwd, signal, timeoutSec: BASH_TIMEOUT_SEC });
      const output = r.output && !r.output.endsWith('\n') ? `${r.output}\n` : r.output;
      if (r.error !== undefined) return { text: `${output}${r.error}`, isError: true };
      // A non-zero exit is information for the model, not a tool error.
      return { text: `${output}exit code ${r.exitCode}` };
    }),
  ];
}

/** The built-in tools (spec §4.2). A read-only step gets only Read, Grep and Glob. */
export function builtinTools(o: { cwd: string; runShell: RunShell; readOnly: boolean }): LoopTool[] {
  const tools = readOnlyTools(o.cwd);
  return o.readOnly ? tools : [...tools, ...writeTools(o.cwd, o.runShell)];
}
