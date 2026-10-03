import { existsSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GIT_BASH_MISSING } from '../src/platform';
import { createRunShell } from '../src/shell';

const tmp = () => mkdtempSync(join(tmpdir(), 'shell-'));
const live = () => new AbortController().signal;
const runShell = createRunShell({ shell: '/bin/sh' });

async function waitFor(condition: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 20));
  }
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('createRunShell', () => {
  it('fails clearly on Windows without Git Bash, starting nothing', async () => {
    expect(await createRunShell({ platform: 'win32' })({ command: 'echo hi', cwd: tmp(), signal: live(), timeoutSec: 5 })).toEqual({
      exitCode: null,
      output: '',
      error: GIT_BASH_MISSING,
    });
  });
});

describe.skipIf(process.platform === 'win32')('createRunShell on macOS and Linux', () => {
  it('returns the combined output and the exit code, streaming each chunk; a non-zero exit is not an error', async () => {
    const cwd = tmp();
    const chunks: [string, string][] = [];
    const r = await runShell({ command: 'pwd; echo oops >&2; exit 3', cwd, signal: live(), timeoutSec: 5, onChunk: (stream, chunk) => chunks.push([stream, chunk]) });
    expect(r.exitCode).toBe(3);
    expect(r.error).toBeUndefined();
    expect(r.output).toContain(`${realpathSync(cwd)}\n`);
    expect(r.output).toContain('oops\n');
    expect(chunks).toContainEqual(['stderr', 'oops\n']);
  });

  it('reports a clean exit without an error', async () => {
    expect(await runShell({ command: 'echo hi', cwd: tmp(), signal: live(), timeoutSec: 5 })).toEqual({ exitCode: 0, output: 'hi\n' });
  });

  it('stops a command that runs past its timeout', async () => {
    const started = Date.now();
    const r = await runShell({ command: 'sleep 5', cwd: tmp(), signal: live(), timeoutSec: 0.3 });
    expect(r.error).toBe('timed out after 0.3 s');
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('kills the whole process group on abort, background children included', async () => {
    const cwd = tmp();
    const ac = new AbortController();
    const pending = runShell({ command: 'sleep 30 & echo $! > child.pid; wait', cwd, signal: ac.signal, timeoutSec: 60 });
    const pidFile = join(cwd, 'child.pid');
    await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim() !== '');
    const childPid = Number(readFileSync(pidFile, 'utf8'));
    ac.abort();
    expect(await pending).toMatchObject({ error: 'cancelled' });
    await waitFor(() => !alive(childPid));
  });
});
