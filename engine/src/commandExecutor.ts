import type { NodeExecutor } from './executors';
import { createRunShell, KILL_GRACE_MS, type RunShellOptions } from './shell';

export const DEFAULT_TIMEOUT_SEC = 1800;
export { KILL_GRACE_MS };

export type CommandExecutorOptions = RunShellOptions;

/**
 * Runs a command node (spec §8.1) through the shared shell runner: `$SHELL -lc` on macOS/Linux in its own
 * process group, Git Bash `-lc` on Windows. Stop and timeout end everything it started.
 */
export function createCommandExecutor(options: CommandExecutorOptions = {}): NodeExecutor {
  const runShell = createRunShell(options);
  return async (ctx) => {
    const command = ctx.node.command ?? '';
    ctx.emit({ type: 'start', kind: 'command', cwd: ctx.cwd, command });
    const r = await runShell({
      command,
      cwd: ctx.cwd,
      signal: ctx.signal,
      timeoutSec: ctx.node.timeoutSec ?? DEFAULT_TIMEOUT_SEC,
      onChunk: (stream, chunk) => ctx.emit(stream === 'stdout' ? { type: 'stdout', chunk } : { type: 'stderr', chunk }),
    });
    if (r.error !== undefined) return { ok: false, output: r.output, exitCode: r.exitCode, error: r.error };
    if (r.exitCode === 0) return { ok: true, output: r.output, exitCode: 0 };
    return { ok: false, output: r.output, exitCode: r.exitCode, error: `exited with code ${r.exitCode}` };
  };
}
