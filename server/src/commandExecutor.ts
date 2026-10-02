import { spawn } from 'node:child_process';
import type { NodeExecutor, NodeOutcome } from './executors';

export const DEFAULT_TIMEOUT_SEC = 1800;
export const KILL_GRACE_MS = 5000;

export type CommandExecutorOptions = { shell?: string; env?: NodeJS.ProcessEnv };

/**
 * Runs a command node as `$SHELL -lc "<command>"` in its own process group, so stop and
 * timeout terminate everything it started (dbt, python, …), not just the shell. Uses the
 * user's normal environment so dbt profiles and credentials work as in their terminal.
 */
export function createCommandExecutor(options: CommandExecutorOptions = {}): NodeExecutor {
  return (ctx) =>
    new Promise<NodeOutcome>((resolve) => {
      const command = ctx.node.command ?? '';
      const shell = options.shell ?? process.env.SHELL ?? '/bin/sh';
      const timeoutSec = ctx.node.timeoutSec ?? DEFAULT_TIMEOUT_SEC;
      ctx.emit({ type: 'start', kind: 'command', cwd: ctx.cwd, command });

      let output = '';
      let timedOut = false;
      let cancelled = false;
      let settled = false;
      let killTimer: NodeJS.Timeout | undefined;

      const child = spawn(shell, ['-lc', command], {
        cwd: ctx.cwd,
        env: options.env ?? process.env,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const signalGroup = (signal: NodeJS.Signals) => {
        if (child.pid === undefined) return;
        try {
          process.kill(-child.pid, signal);
        } catch {
          // the process group already exited
        }
      };
      const terminate = () => {
        signalGroup('SIGTERM');
        killTimer ??= setTimeout(() => signalGroup('SIGKILL'), KILL_GRACE_MS);
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
