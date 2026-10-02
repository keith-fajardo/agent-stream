import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyOp, emptyGraph, type ApprovalRequest, type Graph, type Op } from '@claude-stream/shared';
import { createAgentExecutor } from '../src/agentExecutor';
import { ApprovalBroker } from '../src/approvals';
import { checkAuth, resolveClaudePath } from '../src/auth';
import { createCommandExecutor } from '../src/commandExecutor';
import { Runner } from '../src/runner';
import { RunStore } from '../src/runStore';
import { tmpProject } from './helpers';

const live = process.env.CLAUDE_STREAM_LIVE === '1';

describe.skipIf(!live)('live: real Claude on the subscription', () => {
  it('runs agent and command steps with an approval round-trip', async () => {
    const claudePath = resolveClaudePath();
    if (!claudePath) throw new Error('claude is not on PATH');
    const auth = await checkAuth(claudePath);
    expect(auth.ok, auth.error).toBe(true);

    const paths = tmpProject();
    const broker = new ApprovalBroker();
    const approved: string[] = [];
    broker.on('changed', (pending: ApprovalRequest[]) => {
      for (const p of pending) {
        queueMicrotask(() => {
          if (broker.decide(p.id, { decision: 'approve' })) approved.push(p.toolName);
        });
      }
    });
    const runStore = new RunStore(paths);
    const runner = new Runner({
      runStore,
      broker,
      executors: { agent: createAgentExecutor({ claudePath, broker }), command: createCommandExecutor() },
      projectDir: paths.root,
      maxParallel: 2,
    });

    let graph: Graph = emptyGraph('live', 'Live', new Date().toISOString());
    const ops: Op[] = [
      { type: 'addNode', node: { title: 'Say pong', kind: 'agent', prompt: 'Reply with exactly the word PONG and nothing else. Do not use any tools.' } },
      {
        type: 'addNode',
        node: { title: 'Write file', kind: 'agent', prompt: 'Use the Write tool to create hello.txt in the current folder containing exactly: hi from claude-stream. Then reply DONE.' },
      },
      { type: 'addNode', node: { title: 'Check file', kind: 'command', command: 'cat hello.txt' } },
      { type: 'connect', from: 'n1', to: 'n2' },
      { type: 'connect', from: 'n2', to: 'n3' },
    ];
    for (const op of ops) {
      const r = applyOp(graph, op, 'user', new Date().toISOString());
      if (!r.ok) throw new Error(r.error);
      graph = r.graph;
    }

    const started = runner.start({ graph });
    if (!started.ok) throw new Error(started.error);
    const run = await started.done;
    expect(run.status, JSON.stringify(run.nodes, null, 2)).toBe('succeeded');
    expect(runStore.readOutput(run.id, 'n1')).toContain('PONG');
    expect(approved).toContain('Write');
    expect(readFileSync(join(paths.root, 'hello.txt'), 'utf8')).toContain('hi from claude-stream');
    expect(runStore.readOutput(run.id, 'n3')).toContain('hi from claude-stream');
  }, 300_000);
});
