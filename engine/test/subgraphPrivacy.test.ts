import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readOnlyTools } from '../src/agentLoop/tools';
import { classifyCommand, pathPrivacy } from '../src/providers/codex/readOnlyCommand';
import { createPlannerGate } from '../src/providers/toolGate';
import { approvalParams } from './codexFake';

/** A folder whose run has an inner step's output, `nodes/n4~n1/output.md`, next to the run's private record. */
function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'subgraph-privacy-'));
  mkdirSync(join(root, '.agent-stream', 'runs', 'r1', 'nodes', 'n4~n1'), { recursive: true });
  writeFileSync(join(root, '.agent-stream', 'runs', 'r1', 'nodes', 'n4~n1', 'output.md'), 'inner result');
  writeFileSync(join(root, '.agent-stream', 'runs', 'r1', 'run.json'), 'secret');
  return root;
}
const out = '.agent-stream/runs/r1/nodes/n4~n1/output.md';

describe('a step reads an inner step’s output (sub-graphs spec §4.4)', () => {
  it('the agent loop lets Read open nodes/n4~n1/output.md, and still refuses the run record', async () => {
    const cwd = project();
    const read = readOnlyTools(cwd).find((t) => t.spec.name === 'Read')!;
    const signal = new AbortController().signal;
    expect(await read.run({ file_path: out }, signal)).toEqual({ text: '     1\tinner result' });
    expect((await read.run({ file_path: '.agent-stream/runs/r1/run.json' }, signal)).isError).toBe(true);
  });

  it('Codex: the privacy check passes, and the command asks, as any command with a ~ does (ruling R9)', () => {
    const dir = project();
    const script = `cat ${out}`;
    const params = approvalParams({ command: `/bin/zsh -lc '${script}'`, cwd: dir, actions: [{ type: 'read', command: script, name: out, path: resolve(dir, out) }] });
    const privacy = pathPrivacy(createPlannerGate({ projectDir: dir, privateFiles: [], graphToolNames: new Set() }));
    // Not refused as private: `~` is one of the shell characters the read-only rule never allows unasked.
    expect(classifyCommand(params, { cwd: dir, platform: 'linux', privacy })).toEqual({ kind: 'ask' });
    const record = '.agent-stream/runs/r1/run.json';
    const recordParams = approvalParams({ command: `/bin/zsh -lc 'cat ${record}'`, cwd: dir, actions: [{ type: 'read', command: `cat ${record}`, name: record, path: resolve(dir, record) }] });
    expect(classifyCommand(recordParams, { cwd: dir, platform: 'linux', privacy }).kind).toBe('private');
  });
});
