import { existsSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { emptyGraph, type GraphNode, type NodeEventBody } from '@claude-stream/shared';
import { createCommandExecutor } from '../src/commandExecutor';
import type { NodeContext } from '../src/executors';

const run = createCommandExecutor({ shell: '/bin/sh' });
const tmp = () => mkdtempSync(join(tmpdir(), 'cmd-'));

function ctx(command: string, opts: { timeoutSec?: number; signal?: AbortSignal; cwd?: string } = {}) {
  const events: NodeEventBody[] = [];
  const node: GraphNode = { id: 'n1', title: 'cmd', kind: 'command', command, timeoutSec: opts.timeoutSec, createdBy: 'user', updatedBy: 'user', updatedAt: 't' };
  const c: NodeContext = {
    runId: 'r',
    graph: emptyGraph('g', 'G', 't'),
    node,
    prompt: '',
    cwd: opts.cwd ?? tmp(),
    signal: opts.signal ?? new AbortController().signal,
    emit: (e) => events.push(e),
  };
  return { c, events };
}

async function waitFor(condition: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('command executor', () => {
  it('runs in the project folder and captures stdout', async () => {
    const cwd = tmp();
    const { c, events } = ctx('echo hello && pwd', { cwd });
    const expected = `hello\n${realpathSync(cwd)}\n`;
    expect(await run(c)).toEqual({ ok: true, output: expected, exitCode: 0 });
    expect(events[0]).toEqual({ type: 'start', kind: 'command', cwd, command: 'echo hello && pwd' });
    const stdout = events.flatMap((e) => (e.type === 'stdout' ? [e.chunk] : [])).join('');
    expect(stdout).toBe(expected);
  });

  it('fails with the exit code and keeps stderr', async () => {
    const { c, events } = ctx('echo oops >&2; exit 3');
    expect(await run(c)).toEqual({ ok: false, output: 'oops\n', exitCode: 3, error: 'exited with code 3' });
    expect(events).toContainEqual({ type: 'stderr', chunk: 'oops\n' });
  });

  it('kills the command when it times out', async () => {
    const started = Date.now();
    const out = await run(ctx('sleep 5', { timeoutSec: 0.3 }).c);
    expect(out).toMatchObject({ ok: false, error: 'timed out after 0.3 s' });
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('stops the whole process group on abort, including background children', async () => {
    const cwd = tmp();
    const ac = new AbortController();
    const pending = run(ctx('sleep 30 & echo $! > child.pid; wait', { cwd, signal: ac.signal }).c);
    const pidFile = join(cwd, 'child.pid');
    await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim() !== '');
    const childPid = Number(readFileSync(pidFile, 'utf8'));
    ac.abort();
    expect(await pending).toMatchObject({ ok: false, error: 'cancelled' });
    await waitFor(() => {
      try {
        process.kill(childPid, 0);
        return false;
      } catch {
        return true;
      }
    });
  });

  it('captures large output completely', async () => {
    const out = await run(ctx("head -c 1000000 /dev/zero | tr '\\0' x").c);
    expect(out.ok).toBe(true);
    expect(out.output).toHaveLength(1_000_000);
  });
});
