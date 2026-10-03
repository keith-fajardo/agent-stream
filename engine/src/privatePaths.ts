import { homedir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';

const VALUES_REASON = "Variable values are private to this machine; claude-stream doesn't let Claude read the variable values file.";
const RUN_REASON = "Run records contain variable values; claude-stream doesn't let Claude read .claude-stream/runs/*/run.json or events.jsonl.";

/** True when `path` is `folder` or inside it (`folder` may be a root such as / or C:\). */
function within(path: string, folder: string): boolean {
  return path === folder || path.startsWith(folder.endsWith(sep) ? folder : folder + sep);
}

/**
 * Why Claude may not touch the path a Read/Grep/Glob call points at, or null: one of
 * `privateFiles` (the variable values file, kept outside the project), a search that would reach
 * one (its folder, or any folder above it), or a run record.
 */
export function privatePathDenial(projectDir: string, toolName: string, input: unknown, privateFiles: readonly string[] = []): string | null {
  const key = toolName === 'Read' ? 'file_path' : toolName === 'Grep' || toolName === 'Glob' ? 'path' : undefined;
  if (!key || typeof input !== 'object' || input === null) return null;
  const given = (input as Record<string, unknown>)[key];
  // A search without a path searches the project folder, which may hold the values file (a home folder opened as the workspace).
  const p = key === 'path' && (given === undefined || given === null || given === '') ? projectDir : given;
  if (typeof p !== 'string' || p === '') return null;
  const norm = (x: string) => (process.platform === 'win32' ? x.toLowerCase() : x);
  // Claude Code expands a leading ~ to the home folder, where the values file lives.
  const expanded = /^~(?=$|[\\/])/.test(p) ? join(homedir(), p.slice(1)) : p;
  // One root for both the checked path and the runs folder, so a drive-less projectDir can't make them disagree on Windows.
  const root = resolve(projectDir);
  const full = norm(resolve(root, expanded));
  const files = privateFiles.map((f) => norm(resolve(f)));
  if (files.includes(full)) return VALUES_REASON;
  // A searched folder with a glob can override ripgrep's ignore rules, so searches may not aim at the file's folder or above it.
  if ((toolName === 'Grep' || toolName === 'Glob') && files.some((f) => within(full, dirname(f)) || within(f, full))) return VALUES_REASON;
  const runsDir = norm(join(root, '.claude-stream', 'runs'));
  // A searched directory can override ripgrep's ignore rules, so Grep may not aim at the runs tree (output.md files are fine).
  if (toolName === 'Grep' && (full === runsDir || full.startsWith(runsDir + sep)) && basename(full) !== 'output.md') return RUN_REASON;
  const runs = runsDir + sep;
  if (full.startsWith(runs) && ['run.json', 'events.jsonl'].includes(basename(full))) return RUN_REASON;
  return null;
}
