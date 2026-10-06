import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { applyOp, emptyGraph, type Graph, type NodeEvent, type Op, type RunMeta, type ServerMessage } from '@agent-stream/shared';
import { createApp } from '../src/app';
import { runAttachments, stepAttachments } from '../src/attachedFiles';
import { AttachmentStore } from '../src/attachmentStore';
import { ApprovalBroker } from '../src/approvals';
import type { NodeContext, NodeExecutor } from '../src/executors';
import { buildRunReport } from '../src/runReport';
import { previewRun } from '../src/runPreview';
import { Runner } from '../src/runner';
import { RunStore } from '../src/runStore';
import { appTestDeps, signedIn, testGitBash, testLeases, testProvider, tmpProject, tmpValuesFile } from './helpers';

function graphOf(ops: Op[]): Graph {
  let g = emptyGraph('g', 'G', 't');
  for (const op of ops) {
    const r = applyOp(g, op, 'user', 't');
    if (!r.ok) throw new Error(r.error);
    g = r.graph;
  }
  return g;
}
const graph = graphOf([
  { type: 'setGraphAttachments', names: ['brief.pdf', 'logo.png'] },
  { type: 'addNode', node: { title: 'Design', kind: 'agent', prompt: 'p', attachments: ['mockup.png', 'logo.png'] } },
  { type: 'addNode', node: { title: 'Plain', kind: 'agent', prompt: 'p' } },
  { type: 'addNode', node: { title: 'Build', kind: 'command', command: 'make' } },
]);

describe('the run dialog: missing attachments (spec §6b.5)', () => {
  it('warns for each missing file a running step uses, and never blocks', () => {
    const { preview } = previewRun({ graph, values: {}, env: () => undefined, attachments: [{ name: 'brief.pdf', sha256: 'a' }, { name: 'logo.png' }, { name: 'mockup.png' }] });
    expect(preview.problems).toEqual([]);
    expect(preview.warnings).toEqual([
      "The graph's attachment logo.png is missing from .agent-stream/attachments/g/, so agent steps run without it.",
      "n1's attachment mockup.png is missing from .agent-stream/attachments/g/, so the step runs without it.",
      "n1's attachment logo.png is missing from .agent-stream/attachments/g/, so the step runs without it.",
    ]);
  });
});

describe('Runner: a step’s attachments (spec §6b.5)', () => {
  it('records the files’ hashes, gives each agent step its own then the graph’s, and logs a missing one', async () => {
    const paths = tmpProject();
    const dir = join(paths.dataDir, 'attachments', 'g');
    mkdirSync(dir, { recursive: true });
    for (const name of ['brief.pdf', 'logo.png']) writeFileSync(join(dir, name), name);
    const runStore = new RunStore(paths);
    const seen: Record<string, NodeContext['attachments']> = {};
    const readers: Record<string, NodeContext['readAttachment']> = {};
    const exec: NodeExecutor = async (ctx) => {
      ctx.emit({ type: 'start', kind: ctx.node.kind, cwd: ctx.cwd });
      seen[ctx.node.id] = ctx.attachments;
      readers[ctx.node.id] = ctx.readAttachment;
      return { ok: true, output: '' };
    };
    const runner = new Runner({ runStore, broker: new ApprovalBroker(), executors: { agent: exec, command: exec }, projectDir: paths.root, maxParallel: 1, leases: testLeases() });
    const rendered = { goal: '', instructions: '', nodes: { n1: 'p', n2: 'p', n3: 'make' } };
    const files = [{ name: 'brief.pdf', sha256: 'h1' }, { name: 'logo.png', sha256: 'h2' }, { name: 'mockup.png' }];
    const started = runner.start({ graph, rendered, attachments: files });
    if (!started.ok) throw new Error(started.error);
    const done = await started.done;
    expect(done.attachments).toEqual(files);
    expect(seen.n1?.map((f) => [f.name, f.kind, f.missing, f.shown])).toEqual([
      ['mockup.png', 'image', true, join('.agent-stream', 'attachments', 'g', 'mockup.png')],
      ['logo.png', 'image', false, join('.agent-stream', 'attachments', 'g', 'logo.png')],
      ['brief.pdf', 'pdf', false, join('.agent-stream', 'attachments', 'g', 'brief.pdf')],
    ]);
    expect(seen.n1?.[1].path).toBe(join(dir, 'logo.png'));
    expect(seen.n2?.map((f) => f.name)).toEqual(['brief.pdf', 'logo.png']);
    expect(seen.n3).toBeUndefined();
    // Each step reads its files through the attachment store, and only those it was given.
    expect(readers.n1?.(join(dir, 'logo.png'))?.toString()).toBe('logo.png');
    expect(readers.n1?.(join(paths.root, 'elsewhere.png'))).toBeUndefined();
    expect(readers.n3).toBeUndefined();
    const log: NodeEvent[] = runStore.readEvents(done.id, 'n1');
    expect(log.slice(0, 2)).toMatchObject([{ type: 'start' }, { type: 'text', text: 'Attachment mockup.png is missing from .agent-stream/attachments/g/, so this step runs without it.' }]);
  });
});

describe('Run Report: attachments (spec §6b.5)', () => {
  it('lists each agent step’s files by name and hash, never their contents', () => {
    const run: RunMeta = {
      id: 'r1',
      graphId: 'g',
      status: 'succeeded',
      startedAt: 't0',
      snapshot: graph,
      nodes: { n1: { status: 'succeeded' }, n2: { status: 'succeeded' }, n3: { status: 'succeeded' } },
      attachments: [{ name: 'brief.pdf', sha256: 'a'.repeat(64) }, { name: 'logo.png', sha256: 'b'.repeat(64) }, { name: 'mockup.png' }],
    };
    const md = buildRunReport({ graphName: 'G', run, steps: {}, now: 't1' });
    expect(md).toContain(`**Attachments**\n\n- mockup.png · missing when the run started\n- logo.png · sha256 ${'b'.repeat(64)}\n- brief.pdf · sha256 ${'a'.repeat(64)}\n`);
    expect(md.split('**Attachments**')).toHaveLength(3);
  });
});

describe('App: runs with attachments', () => {
  it('runs a step again when its file changed since the run it re-runs from', async () => {
    const paths = tmpProject();
    const provider = testProvider({ runStep: async (ctx) => (ctx.emit({ type: 'start', kind: 'agent', cwd: ctx.cwd }), { ok: true, output: '' }) });
    const app = createApp({ ...appTestDeps(), projectDir: paths.root, valuesFile: tmpValuesFile(), provider, status: signedIn, maxParallel: 1, gitBash: testGitBash });
    const graphId = app.graphStore.create('G').id;
    app.graphStore.apply(graphId, { type: 'addNode', node: { id: 'n1', title: 'one', kind: 'agent', prompt: 'p' } }, 'user');
    app.graphStore.apply(graphId, { type: 'addNode', node: { id: 'n2', title: 'two', kind: 'agent', prompt: 'p' } }, 'user');
    app.graphStore.apply(graphId, { type: 'connect', from: 'n1', to: 'n2' }, 'user');
    const msgs: ServerMessage[] = [];
    const c = { send: (m: ServerMessage) => void msgs.push(m) };
    app.connect(c);
    const last = <T extends ServerMessage['type']>(type: T) => msgs.filter((m): m is Extract<ServerMessage, { type: T }> => m.type === type).at(-1)!;
    await app.handle(c, { type: 'attach', graphId, target: { kind: 'step', nodeId: 'n1' }, files: [{ name: 'data.csv', data: Buffer.from('a,b').toString('base64') }] });
    const runOnce = async (extra: { fromNodeId?: string; sourceRunId?: string } = {}) => {
      await app.handle(c, { type: 'previewRun', graphId, ...extra });
      const preview = last('runPreview').preview;
      await app.handle(c, { type: 'startRun', graphId, reviewed: preview.signature, ...extra });
      await vi.waitFor(() => expect(last('run').run.status).toBe('succeeded'), { timeout: 5000 });
      return { preview, run: last('run').run };
    };
    const first = await runOnce();
    expect(first.run.attachments).toEqual([{ name: 'data.csv', sha256: expect.stringMatching(/^[0-9a-f]{64}$/) }]);
    const same = await runOnce({ fromNodeId: 'n2', sourceRunId: first.run.id });
    expect(same.preview.steps.find((s) => s.id === 'n1')?.reused).toBe(true);
    writeFileSync(join(paths.dataDir, 'attachments', graphId, 'data.csv'), 'a,b,c');
    const changed = await runOnce({ fromNodeId: 'n2', sourceRunId: same.run.id });
    expect(changed.preview.steps.find((s) => s.id === 'n1')?.reused).toBe(false);
  });
});

describe('files read through the AttachmentStore', () => {
  it('a symlinked attachment is missing: no hash, and the step lists it as missing', () => {
    const paths = tmpProject();
    const dir = join(paths.dataDir, 'attachments', 'g');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'real.md'), 'real');
    writeFileSync(join(paths.root, 'secret.md'), 'secret');
    try {
      symlinkSync(join(paths.root, 'secret.md'), join(dir, 'linked.md'));
    } catch {
      return; // symlinks need extra rights on Windows
    }
    const g = graphOf([{ type: 'setGraphAttachments', names: ['real.md', 'linked.md'] }, { type: 'addNode', node: { title: 'A', kind: 'agent', prompt: 'p' } }]);
    const store = new AttachmentStore(paths);
    expect(runAttachments(g, (name) => store.hash('g', name))).toEqual([{ name: 'real.md', sha256: expect.stringMatching(/^[0-9a-f]{64}$/) }, { name: 'linked.md' }]);
    const files = stepAttachments({ store, graph: g, node: g.nodes[0], cwd: paths.root, worktree: false });
    expect(files.map((f) => [f.name, f.missing])).toEqual([['real.md', false], ['linked.md', true]]);
  });
});
