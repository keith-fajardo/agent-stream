import { resolve } from 'node:path';
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
const SPECIAL = /[;&|<>`$~*?[\]{}%()!\r\n]/;

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

/** The words the shell will run: `<shell> -c|-lc '<script>'`, as Codex sends commands, is unwrapped once. */
function commandWords(command: string, platform: NodeJS.Platform): string[] | null {
  const words = shellWords(command, platform);
  if (words?.length === 3 && SHELLS.has(words[0].split('/').pop() ?? '') && (words[1] === '-c' || words[1] === '-lc')) return shellWords(words[2], platform);
  return words;
}

const namesAgentStream = (word: string) => word.split(/[\\/]/).some((part) => part.toLowerCase() === '.agent-stream');

/** The per-program limits of R1: nothing that writes, runs another program, never ends, or ignores ignore rules. */
function programAllows([program, ...args]: string[]): boolean {
  const flags = args.filter((a) => a.startsWith('-') && a !== '-');
  const short = (letters: string) => flags.some((f) => !f.startsWith('--') && [...f.slice(1)].some((ch) => letters.includes(ch)));
  const long = (re: RegExp) => flags.some((f) => re.test(f));
  switch (program) {
    case 'find':
      return !args.some((a) => FIND_ACTIONS.has(a));
    case 'sed':
      return args.length >= 3 && args[0] === '-n' && /^\d+(,\d+)?p$/.test(args[1]) && args.slice(2).every((a) => !a.startsWith('-'));
    case 'rg':
      return !short('u.z') && !long(/^--(pre|pre-glob|hidden|no-ignore[\w-]*|unrestricted|search-zip)(=|$)/);
    case 'grep':
    case 'egrep':
    case 'fgrep':
      return !short('rRd') && !long(/^--(recursive|dereference-recursive|directories)(=|$)/);
    case 'tail':
      return !short('fF') && !long(/^--(follow|retry)(=|$)/);
    default:
      return true;
  }
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
  const special = (text: string) => SPECIAL.test(text) || (o.platform === 'win32' ? text.includes(',') : text.includes('\\'));
  const command = p.command ?? '';
  const words = special(command) ? null : commandWords(command, o.platform);
  if (words && words.length > 0 && PROGRAMS.has(words[0])) {
    // The actions are a best-effort parse: `cat notes.txt <values file>` reports one read of notes.txt.
    const kind: PathKind = SEARCHERS.has(words[0]) ? 'search' : 'read';
    const paths = words.slice(1).filter((w) => !w.startsWith('-')).map((w) => resolve(cwd, w));
    if (kind === 'search') paths.push(resolve(cwd));
    for (const path of paths) {
      const reason = o.privacy(path, kind);
      if (reason) return { kind: 'private', reason };
    }
  }
  if ((p.kind ?? 'command') !== 'command' || p.additionalPermissions || p.networkApprovalContext) return ASK;
  if (actions.length === 0 || !actions.every((a) => READ_ACTIONS.has(a.type)) || actions.some((a) => special(a.command))) return ASK;
  if (!words || words.length === 0 || !PROGRAMS.has(words[0]) || words.some((w) => w.startsWith('='))) return ASK;
  if (!programAllows(words)) return ASK;
  if ((words[0] === 'rg' || GREPS.has(words[0])) && words.slice(1).some(namesAgentStream)) return ASK;
  return { kind: 'readOnly' };
}
