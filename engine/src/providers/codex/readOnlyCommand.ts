import { isAbsolute, relative, resolve } from 'node:path';
import { privateFolderDenial } from '../../agentLoop/tools';
import type { ToolGate } from '../toolGate';
import type { CommandAction, CommandExecutionRequestApprovalParams } from './protocol';

export type PathKind = 'read' | 'search';
/** Why Codex may not read (or search) this absolute path, or null. */
export type PathPrivacy = (absPath: string, kind: PathKind) => string | null;
export type CommandClass = { kind: 'readOnly' } | { kind: 'private'; reason: string } | { kind: 'ask' };

const ASK: CommandClass = { kind: 'ask' };
const READ_ACTIONS: ReadonlySet<string> = new Set(['read', 'listFiles', 'search']);
const PROGRAMS: ReadonlySet<string> = new Set(['cat', 'head', 'tail', 'nl', 'wc', 'ls', 'pwd', 'stat', 'grep', 'egrep', 'fgrep', 'rg', 'find', 'sed']);
/** Programs that walk folders: their operands are checked as Grep's path is, and so is the folder they search. */
const SEARCHERS: ReadonlySet<string> = new Set(['ls', 'find', 'grep', 'egrep', 'fgrep', 'rg']);
const GREPS: ReadonlySet<string> = new Set(['grep', 'egrep', 'fgrep']);
const SHELLS: ReadonlySet<string> = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);
const FIND_ACTIONS: ReadonlySet<string> = new Set(['-exec', '-execdir', '-ok', '-okdir', '-delete', '-fprint', '-fprint0', '-fprintf', '-fls']);
/** Characters that let a shell run another command, or open other files than the words it was given (R1). */
const SPECIAL = /[;&|<>`$~*?[\]{}%()!^#\r\n]/;
/** Non-ASCII words could name a private folder through the file system's case folding (U+017F matches `s` on APFS and NTFS). */
const NON_ASCII = /[^\x00-\x7f]/;
const SHELL_DIRS: readonly string[] = ['/bin/', '/usr/bin/', '/usr/local/bin/', '/opt/homebrew/bin/'];

/** Long options each program may be given (R1a). `true`: also `--name=<digits>`. Everything else asks, so no abbreviation or `=value` slips through. */
const GREP_LONG: ReadonlyMap<string, boolean> = new Map([
  ['--line-number', false], ['--ignore-case', false], ['--count', false], ['--files-with-matches', false], ['--files-without-match', false],
  ['--word-regexp', false], ['--line-regexp', false], ['--fixed-strings', false], ['--extended-regexp', false], ['--invert-match', false],
  ['--no-filename', false], ['--with-filename', false], ['--max-count', true], ['--context', true], ['--before-context', true], ['--after-context', true],
]);
const LONG: Readonly<Record<string, ReadonlyMap<string, boolean>>> = {
  grep: GREP_LONG, egrep: GREP_LONG, fgrep: GREP_LONG, rg: GREP_LONG,
  head: new Map([['--lines', true], ['--bytes', true]]),
  tail: new Map([['--lines', true], ['--bytes', true]]),
  wc: new Map([['--lines', false], ['--words', false], ['--bytes', false], ['--chars', false]]),
};
/** Short-flag letters each program may be given, with digits (R1b). Programs not listed take no flags (sed and find are limited separately). */
const SHORT: Readonly<Record<string, string>> = {
  grep: 'niclLwxFEvhHmABCe', egrep: 'niclLwxFEvhHmABCe', fgrep: 'niclLwxFEvhHmABCe', rg: 'niclwxFvmABC',
  head: 'nc', tail: 'nc', wc: 'lwcm', ls: 'la1htrSF',
};
const FIND_PREDICATES: ReadonlySet<string> = new Set(['-name', '-iname', '-type', '-maxdepth', '-mindepth', '-path', '-ipath', '-size', '-mtime', '-newer', '-print', '-not', '-o', '-a']);

/** The gate's privacy rule for a path, plus the run-records and sessions folders the agent loop's tools refuse (spec §4.5). */
export function pathPrivacy(gate: Pick<ToolGate, 'privacy'>): PathPrivacy {
  return (path, kind) => (kind === 'read' ? gate.privacy('Read', { file_path: path }) : gate.privacy('Grep', { path })) ?? privateFolderDenial(path);
}

/** A command line's words, with single and double quotes removed; null when it can't be read safely (R1). */
export function shellWords(s: string, platform: NodeJS.Platform): string[] | null {
  const words: string[] = [];
  let word = '';
  let inWord = false;
  let quote: '"' | "'" | null = null;
  for (const ch of s) {
    if (ch === '\\' && platform !== 'win32') return null;
    if (quote) {
      if (ch === quote) quote = null;
      else word += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      inWord = true;
      continue;
    }
    if (ch === ' ' || ch === '\t') {
      if (inWord) words.push(word);
      word = '';
      inWord = false;
      continue;
    }
    word += ch;
    inWord = true;
  }
  if (quote) return null;
  if (inWord) words.push(word);
  return words;
}

/** A shell by bare name, or at one of the standard folders: `./zsh` or `/work/proj/bash` is not trusted to be a shell (R1d). */
const isShell = (word: string) => SHELLS.has(word) || SHELL_DIRS.some((dir) => word.startsWith(dir) && SHELLS.has(word.slice(dir.length)));

/** The words the shell will run: `<shell> -c|-lc '<script>'`, as Codex sends commands, is unwrapped once. */
function commandWords(command: string, platform: NodeJS.Platform): string[] | null {
  const words = shellWords(command, platform);
  if (words?.length === 3 && isShell(words[0]) && (words[1] === '-c' || words[1] === '-lc')) return shellWords(words[2], platform);
  return words;
}

const namesAgentStream = (word: string) => word.split(/[\\/]/).some((part) => part.toLowerCase() === '.agent-stream');

/** The per-program limits of R1: nothing that writes, runs another program, never ends, or ignores ignore rules. */
function programAllows([program, ...args]: string[], platform: NodeJS.Platform): boolean {
  if (program === 'find') return args.every((a) => !a.startsWith('-') || FIND_PREDICATES.has(a));
  if (program === 'sed') return args.length >= 3 && args[0] === '-n' && /^\d+(,\d+)?p$/.test(args[1]) && args.slice(2).every((a) => !a.startsWith('-'));
  // The obsolete `tail +1f` follows forever (R1l).
  if ((program === 'head' || program === 'tail') && args.some((a) => a.startsWith('+'))) return false;
  // PowerShell's `ls` is Get-ChildItem, where `-r` and `-h` mean -Recurse and -Hidden: no flag is safe there (R1n).
  // Other flag-looking words on Windows (`-Path:x`) fail the letter and name lists below, so they ask (R1i).
  if (platform === 'win32' && program === 'ls') return args.every((a) => !a.startsWith('-') || a === '-');
  const longs = LONG[program];
  const letters = SHORT[program] ?? '';
  return args.every((a) => {
    if (a === '-' || !a.startsWith('-')) return true;
    if (a.startsWith('--')) {
      const [name, value, ...more] = a.split('=');
      const numeric = longs?.get(name);
      return numeric !== undefined && more.length === 0 && (value === undefined || (numeric && /^\d+$/.test(value)));
    }
    return [...a.slice(1)].every((ch) => letters.includes(ch) || /\d/.test(ch));
  });
}

/** `<…>/.agent-stream/runs/<run>/nodes/<node>/output.md`: the one file under .agent-stream a step may read (the privacy check has vetted it). */
function isUpstreamOutputPath(path: string): boolean {
  const parts = path.toLowerCase().split(/[\\/]/);
  const i = parts.length - 6;
  return i >= 0 && parts[i] === '.agent-stream' && parts[i + 1] === 'runs' && parts[i + 3] === 'nodes' && parts[i + 5] === 'output.md';
}

/**
 * How Agent Stream answers a command approval request (spec §4.5, R1):
 * - `private`: a path Codex named, or an operand of a read program, is private: declined without asking;
 * - `readOnly`: one plain read (allowed without asking, logged like Read/Grep/Glob, `by: 'readOnly'`);
 * - `ask`: everything else goes to the gate.
 */
export function classifyCommand(p: CommandExecutionRequestApprovalParams, o: { cwd: string; platform: NodeJS.Platform; privacy: PathPrivacy }): CommandClass {
  const cwd = p.cwd || o.cwd;
  const actions: CommandAction[] = p.commandActions ?? [];
  for (const a of actions) {
    const path = a.type === 'unknown' ? null : a.path;
    if (!path) continue;
    const reason = o.privacy(resolve(cwd, path), a.type === 'read' ? 'read' : 'search');
    if (reason) return { kind: 'private', reason };
  }
  const special = (text: string) => SPECIAL.test(text) || NON_ASCII.test(text) || (o.platform === 'win32' ? text.includes(',') : text.includes('\\'));
  const command = p.command ?? '';
  let namesAgentStreamOperand = false;
  const words = special(command) ? null : commandWords(command, o.platform);
  if (words && words.length > 0 && PROGRAMS.has(words[0])) {
    // The actions are a best-effort parse: `cat notes.txt <values file>` reports one read of notes.txt.
    const kind: PathKind = SEARCHERS.has(words[0]) ? 'search' : 'read';
    // A search pattern is not a path (R1f): the first operand, or the word after -e (R1m); -f and long options ask anyway.
    const operands: string[] = [];
    const args = words.slice(1);
    const patterns = words[0] === 'rg' || GREPS.has(words[0]);
    let patternPending = patterns && !args.some((w) => /^-[^-]*e/.test(w));
    for (let i = 0; i < args.length; i++) {
      const w = args[i];
      if (w.startsWith('-')) {
        if (patterns && /^-[^-]*e$/.test(w)) i++;
        continue;
      }
      if (patternPending) patternPending = false;
      else operands.push(w);
    }
    const paths = operands.map((w) => resolve(cwd, w));
    if (kind === 'search') paths.push(resolve(cwd));
    for (const path of paths) {
      const reason = o.privacy(path, kind);
      if (reason) return { kind: 'private', reason };
    }
    // Any other .agent-stream path (another project's values, worktrees, ...) asks, bar an upstream output.md (R1g).
    // Below the step's own folder only: a variant step's cwd is itself under ~/.agent-stream/worktrees (R1j).
    const below = (path: string) => {
      const rel = relative(cwd, path);
      return rel === '..' || rel.startsWith('..') || isAbsolute(rel) ? path : rel;
    };
    namesAgentStreamOperand = paths.some((path) => namesAgentStream(below(path)) && !isUpstreamOutputPath(path));
  }
  if ((p.kind ?? 'command') !== 'command' || p.additionalPermissions || p.networkApprovalContext) return ASK;
  if (actions.length === 0 || !actions.every((a) => READ_ACTIONS.has(a.type)) || actions.some((a) => special(a.command))) return ASK;
  if (!words || words.length === 0 || !PROGRAMS.has(words[0]) || words.some((w) => w.startsWith('='))) return ASK;
  if (namesAgentStreamOperand || !programAllows(words, o.platform)) return ASK;
  if ((words[0] === 'rg' || GREPS.has(words[0])) && words.slice(1).some(namesAgentStream)) return ASK;
  return { kind: 'readOnly' };
}
