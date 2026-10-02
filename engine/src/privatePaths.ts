import { basename, join, resolve, sep } from 'node:path';

const REASON = "Variable values are private to this machine; claude-stream doesn't let Claude read .claude-stream/variables.local.json.";
const RUN_REASON = "Run records contain variable values; claude-stream doesn't let Claude read .claude-stream/runs/*/run.json or events.jsonl.";

/** Why Claude may not touch the path a Read/Grep/Glob call points at (the variable values file), or null. */
export function privatePathDenial(projectDir: string, toolName: string, input: unknown): string | null {
  const key = toolName === 'Read' ? 'file_path' : toolName === 'Grep' || toolName === 'Glob' ? 'path' : undefined;
  if (!key || typeof input !== 'object' || input === null) return null;
  const p = (input as Record<string, unknown>)[key];
  if (typeof p !== 'string' || p === '') return null;
  const norm = (x: string) => (process.platform === 'win32' ? x.toLowerCase() : x);
  const full = norm(resolve(projectDir, p));
  if (full === norm(join(projectDir, '.claude-stream', 'variables.local.json'))) return REASON;
  const runsDir = norm(join(projectDir, '.claude-stream', 'runs'));
  // A searched directory can override ripgrep's ignore rules, so Grep may not aim at the runs tree (output.md files are fine).
  if (toolName === 'Grep' && (full === runsDir || full.startsWith(runsDir + sep)) && basename(full) !== 'output.md') return RUN_REASON;
  const runs = runsDir + sep;
  if (full.startsWith(runs) && ['run.json', 'events.jsonl'].includes(basename(full))) return RUN_REASON;
  return null;
}
