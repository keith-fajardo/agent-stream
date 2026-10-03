import { spawn } from 'node:child_process';
import { childEnv, commandShell, killTree } from './platform';

export const KILL_GRACE_MS = 5000;

/** `error` only when the command didn't exit by itself (timeout, Stop, a signal, or it couldn't start); a non-zero exit is just `exitCode`. */
export type RunShellResult = { exitCode: number | null; output: string; error?: string };
export type RunShell = (o: {
  command: string;
  cwd: string;
  signal: AbortSignal;
  timeoutSec: number;
  onChunk?: (stream: 'stdout' | 'stderr', chunk: string) => void;
}) => Promise<RunShellResult>;

export type RunShellOptions = {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** Windows: Git Bash (see findGitBash). */
  gitBashPath?: string;
  /** macOS/Linux: the shell to use instead of $SHELL. */
  shell?: string;
  /** Replaces the process-tree kill (tests). */
  killTree?: typeof killTree;
  /** How long Stop waits before forcing the command to settle (default KILL_GRACE_MS; tests use less). */
  killGraceMs?: number;
};

/**
 * Runs one shell command (spec §4.3): `$SHELL -lc` on macOS/Linux in its own process group, Git Bash `-lc` on
 * Windows. Stop (the signal) and the timeout end everything it started: SIGTERM, then SIGKILL after the grace
 * period (one taskkill /T /F on Windows), then it settles even if something still holds the pipes.
 */
export function createRunShell(options: RunShellOptions = {}): RunShell {
  const platform = options.platform ?? process.platform;
  const kill = options.killTree ?? killTree;
  const graceMs = options.killGraceMs ?? KILL_GRACE_MS;
  return ({ command, cwd, signal, timeoutSec, onChunk }) =>
    new Promise<RunShellResult>((resolve) => {
      const env = options.env ?? process.env;
      const spec = commandShell({ platform, env, command, shell: options.shell, gitBashPath: options.gitBashPath });
      if ('error' in spec) {
        resolve({ exitCode: null, output: '', error: spec.error });
        return;
      }

      let output = '';
      let timedOut = false;
      let cancelled = false;
      let settled = false;
      let killTimer: NodeJS.Timeout | undefined;

      const child = spawn(spec.file, spec.args, {
        cwd,
        env: { ...childEnv(env, platform), ...spec.env },
        detached: spec.detached,
        windowsHide: spec.windowsHide,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const stopTree = (sig: NodeJS.Signals) => {
        if (child.pid === undefined) return;
        // On Windows a finished launcher's PID may be stale or reused: never taskkill it.
        if (platform === 'win32' && (child.exitCode !== null || child.signalCode !== null)) return;
        kill(child.pid, { platform, signal: sig });
      };
      // 'close' waits for every process holding the pipes, and a command can leave one running
      // (or escape its process group), so after the grace period it settles anyway.
      const forceSettle = () => {
        child.stdout.destroy();
        child.stderr.destroy();
        finish({ exitCode: null, output, error: timedOut ? `timed out after ${timeoutSec} s` : 'cancelled' });
      };
      let stopped = false;
      // A timeout and a Stop can both arrive; the tree is stopped once.
      const terminate = () => {
        if (stopped) return;
        stopped = true;
        stopTree('SIGTERM');
        if (platform === 'win32') {
          // taskkill /F has already ended the tree.
          killTimer = setTimeout(forceSettle, graceMs);
        } else {
          killTimer = setTimeout(() => {
            stopTree('SIGKILL');
            killTimer = setTimeout(forceSettle, Math.min(500, graceMs));
          }, graceMs);
        }
      };

      const timer = setTimeout(() => {
        timedOut = true;
        terminate();
      }, timeoutSec * 1000);
      const onAbort = () => {
        cancelled = true;
        terminate();
      };
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();

      const finish = (result: RunShellResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        signal.removeEventListener('abort', onAbort);
        resolve(result);
      };

      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        output += chunk;
        onChunk?.('stdout', chunk);
      });
      child.stderr.on('data', (chunk: string) => {
        output += chunk;
        onChunk?.('stderr', chunk);
      });
      child.on('error', (err) => finish({ exitCode: null, output, error: err.message }));
      child.on('close', (code, sig) => {
        if (timedOut) return finish({ exitCode: code, output, error: `timed out after ${timeoutSec} s` });
        if (cancelled) return finish({ exitCode: code, output, error: 'cancelled' });
        if (sig) return finish({ exitCode: code, output, error: `killed by ${sig}` });
        finish({ exitCode: code, output });
      });
    });
}
