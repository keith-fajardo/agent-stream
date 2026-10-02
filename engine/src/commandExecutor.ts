import { spawn } from 'node:child_process';
import type { NodeExecutor, NodeOutcome } from './executors';
import { childEnv, commandShell, killTree } from './platform';

export const DEFAULT_TIMEOUT_SEC = 1800;
export const KILL_GRACE_MS = 5000;

export type CommandExecutorOptions = {
  platform?: NodeJS.Platform;
  /** macOS/Linux: the shell to use instead of $SHELL. */
  shell?: string;
  /** Windows: Git Bash (see findGitBash). */
  gitBashPath?: string;
  env?: NodeJS.ProcessEnv;
  /** Replaces the process-tree kill (tests). */
  killTree?: typeof killTree;
};

/**
 * Runs a command node in a login shell (spec §8.1): `$SHELL -lc` on macOS/Linux in its own
 * process group, Git Bash `-lc` on Windows. Stop and timeout end everything it started.
 */
export function createCommandExecutor(options: CommandExecutorOptions = {}): NodeExecutor {
  const platform = options.platform ?? process.platform;
  const kill = options.killTree ?? killTree;
  return (ctx) =>
    new Promise<NodeOutcome>((resolve) => {
      const command = ctx.node.command ?? '';
      const env = options.env ?? process.env;
      const timeoutSec = ctx.node.timeoutSec ?? DEFAULT_TIMEOUT_SEC;
      ctx.emit({ type: 'start', kind: 'command', cwd: ctx.cwd, command });
      const spec = commandShell({ platform, env, command, shell: options.shell, gitBashPath: options.gitBashPath });
      if ('error' in spec) {
        resolve({ ok: false, output: '', exitCode: null, error: spec.error });
        return;
      }

      let output = '';
      let timedOut = false;
      let cancelled = false;
      let settled = false;
      let killTimer: NodeJS.Timeout | undefined;

      const child = spawn(spec.file, spec.args, {
        cwd: ctx.cwd,
        env: childEnv(env, platform),
        detached: spec.detached,
        windowsHide: spec.windowsHide,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const stopTree = (signal: NodeJS.Signals) => {
        if (child.pid !== undefined) kill(child.pid, { platform, signal });
      };
      let stopped = false;
      // A timeout and a Stop can both arrive; the tree is stopped once.
      const terminate = () => {
        if (stopped) return;
        stopped = true;
        stopTree('SIGTERM');
        // On Windows taskkill /F has already ended the tree; elsewhere force it after a grace period.
        if (platform !== 'win32') killTimer = setTimeout(() => stopTree('SIGKILL'), KILL_GRACE_MS);
      };

      const timer = setTimeout(() => {
        timedOut = true;
        terminate();
      }, timeoutSec * 1000);
      const onAbort = () => {
        cancelled = true;
        terminate();
      };
      ctx.signal.addEventListener('abort', onAbort, { once: true });
      if (ctx.signal.aborted) onAbort();

      const finish = (outcome: NodeOutcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        ctx.signal.removeEventListener('abort', onAbort);
        resolve(outcome);
      };

      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        output += chunk;
        ctx.emit({ type: 'stdout', chunk });
      });
      child.stderr.on('data', (chunk: string) => {
        output += chunk;
        ctx.emit({ type: 'stderr', chunk });
      });
      child.on('error', (err) => finish({ ok: false, output, exitCode: null, error: err.message }));
      child.on('close', (code, signal) => {
        if (timedOut) return finish({ ok: false, output, exitCode: code, error: `timed out after ${timeoutSec} s` });
        if (cancelled) return finish({ ok: false, output, exitCode: code, error: 'cancelled' });
        if (code === 0) return finish({ ok: true, output, exitCode: 0 });
        finish({ ok: false, output, exitCode: code, error: signal ? `killed by ${signal}` : `exited with code ${code}` });
      });
    });
}
