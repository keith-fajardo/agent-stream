import { join, resolve } from 'node:path';

const REASON = "Variable values are private to this machine; claude-stream doesn't let Claude read .claude-stream/variables.local.json.";

/** Why Claude may not touch the path a Read/Grep/Glob call points at (the variable values file), or null. */
export function privatePathDenial(projectDir: string, toolName: string, input: unknown): string | null {
  const key = toolName === 'Read' ? 'file_path' : toolName === 'Grep' || toolName === 'Glob' ? 'path' : undefined;
  if (!key || typeof input !== 'object' || input === null) return null;
  const p = (input as Record<string, unknown>)[key];
  if (typeof p !== 'string' || p === '') return null;
  const norm = (x: string) => (process.platform === 'win32' ? x.toLowerCase() : x);
  return norm(resolve(projectDir, p)) === norm(join(projectDir, '.claude-stream', 'variables.local.json')) ? REASON : null;
}
