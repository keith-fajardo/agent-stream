import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { emptyGraph, type GraphNode, type NodeEventBody } from '@agent-stream/shared';
import { createCommandExecutor } from '../src/commandExecutor';
import type { NodeContext } from '../src/executors';
import { findGitBash } from '../src/platform';
import { renderTemplate } from '../src/templates';

function ctx(command: string, cwd: string, signal: AbortSignal = new AbortController().signal): NodeContext {
  const node: GraphNode = { id: 'n1', title: 'cmd', kind: 'command', command, createdBy: 'user', updatedBy: 'user', updatedAt: 't' };
  const events: NodeEventBody[] = [];
  return { runId: 'r', graph: emptyGraph('g', 'G', 't'), node, prompt: '', cwd, signal, emit: (e) => events.push(e) };
}

describe.runIf(process.platform === 'win32')('on real Windows', () => {
  const gitBash = findGitBash({ env: process.env });

  it('finds Git Bash, and not WSL bash', () => {
    expect(gitBash).toMatchObject({ ok: true });
    if (gitBash.ok) expect(gitBash.path.toLowerCase()).not.toContain('system32');
  });

  it('runs a command step in Git Bash, in a folder with spaces, with the Windows defaults', async () => {
    if (!gitBash.ok) throw new Error(gitBash.error);
    const cwd = mkdtempSync(join(tmpdir(), 'my project '));
    const run = createCommandExecutor({ platform: 'win32', gitBashPath: gitBash.path });
    const outcome = await run(ctx('pwd -W && echo "$CHERE_INVOKING $PYTHONIOENCODING"', cwd));
    expect(outcome.ok).toBe(true);
    const [where, defaults] = outcome.output.trim().split(/\r?\n/);
    expect(where.toLowerCase()).toBe(realpathSync(cwd).replace(/\\/g, '/').toLowerCase());
    expect(defaults).toBe('1 utf-8');
  });

  it('passes a quoted value through Git Bash as one argument', async () => {
    if (!gitBash.ok) throw new Error(gitBash.error);
    const command = renderTemplate('printf "%s|" {{ v }}', { mode: 'command', context: { v: `it's a; test` }, env: () => undefined });
    const outcome = await createCommandExecutor({ platform: 'win32', gitBashPath: gitBash.path })(ctx(command, mkdtempSync(join(tmpdir(), 'q-'))));
    expect(outcome).toMatchObject({ ok: true, output: `it's a; test|` });
  });

  it('keeps the rendered command out of the environment of what the command starts', async () => {
    if (!gitBash.ok) throw new Error(gitBash.error);
    const outcome = await createCommandExecutor({ platform: 'win32', gitBashPath: gitBash.path })(ctx('echo "${AGENT_STREAM_COMMAND-unset}"', mkdtempSync(join(tmpdir(), 'e-'))));
    expect(outcome).toMatchObject({ ok: true });
    expect(outcome.output.trim()).toBe('unset');
  });

  it('stops a running command and everything it started with taskkill', async () => {
    if (!gitBash.ok) throw new Error(gitBash.error);
    const controller = new AbortController();
    const started = Date.now();
    const running = createCommandExecutor({ platform: 'win32', gitBashPath: gitBash.path })(ctx('sleep 60 & sleep 60; wait', mkdtempSync(join(tmpdir(), 's-')), controller.signal));
    await new Promise((r) => setTimeout(r, 1500));
    controller.abort();
    expect(await running).toMatchObject({ ok: false, error: 'cancelled' });
    expect(Date.now() - started).toBeLessThan(20_000);
  }, 30_000);
});
