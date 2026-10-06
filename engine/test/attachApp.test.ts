import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ATTACHMENT_NOTICE, type AttachTarget, type ServerMessage } from '@agent-stream/shared';
import { createApp } from '../src/app';
import { appTestDeps, signedIn, testGitBash, testProvider, tmpProject, tmpValuesFile } from './helpers';

const b64 = (text: string) => Buffer.from(text).toString('base64');

function setup() {
  const paths = tmpProject();
  const app = createApp({ ...appTestDeps(), projectDir: paths.root, valuesFile: tmpValuesFile(), provider: testProvider(), status: signedIn, maxParallel: 1, gitBash: testGitBash });
  const graphId = app.graphStore.create('G').id;
  app.graphStore.apply(graphId, { type: 'addNode', node: { id: 'n1', title: 'Design', kind: 'agent', prompt: 'p' } }, 'user');
  app.graphStore.apply(graphId, { type: 'addNode', node: { id: 'n2', title: 'Build', kind: 'command', command: 'make' } }, 'user');
  const msgs: ServerMessage[] = [];
  const c = { send: (m: ServerMessage) => void msgs.push(m) };
  app.connect(c);
  const last = <T extends ServerMessage['type']>(type: T) => msgs.filter((m): m is Extract<ServerMessage, { type: T }> => m.type === type).at(-1);
  const attach = (target: AttachTarget, ...files: [string, string][]) => app.handle(c, { type: 'attach', graphId, target, files: files.map(([name, text]) => ({ name, data: b64(text) })) });
  const detach = (target: AttachTarget, name: string) => app.handle(c, { type: 'detach', graphId, target, name });
  const graph = () => app.graphStore.get(graphId);
  const file = (name: string) => join(paths.dataDir, 'attachments', graphId, name);
  const md = () => readFileSync(join(paths.graphsDir, `${graphId}.md`), 'utf8');
  return { app, graphId, c, last, attach, detach, graph, file, md, paths };
}
const step: AttachTarget = { kind: 'step', nodeId: 'n1' };
const whole: AttachTarget = { kind: 'graph' };

describe('attaching files (step model spec §6b.4)', () => {
  it('copies them in, adds them to the step or the graph as a user edit, and shows the notice once', async () => {
    const s = setup();
    await s.attach(step, ['mockup.png', 'png-bytes']);
    expect(s.last('attached')).toEqual({ type: 'attached', graphId: s.graphId, target: step, names: ['mockup.png'], notice: ATTACHMENT_NOTICE });
    expect(readFileSync(s.file('mockup.png'), 'utf8')).toBe('png-bytes');
    expect(s.graph().nodes[0].attachments).toEqual(['mockup.png']);
    expect(s.md()).toContain('- attach: mockup.png');
    expect(s.app.graphStore.readOps(s.graphId).at(-1)).toMatchObject({ by: 'user', op: { type: 'updateNode', id: 'n1', patch: { attachments: ['mockup.png'] } } });
    await s.attach(whole, ['brief.pdf', '%PDF'], ['mockup.png', 'other']);
    expect(s.last('attached')).toEqual({ type: 'attached', graphId: s.graphId, target: whole, names: ['brief.pdf', 'mockup-2.png'] });
    expect(s.graph().attachments).toEqual(['brief.pdf', 'mockup-2.png']);
    expect(s.md()).toContain('## Attachments\n\n- `brief.pdf`\n- `mockup-2.png`\n');
    expect(s.last('undoState')?.label).toBe('attached brief.pdf, mockup-2.png');
  });

  it('refuses, writing no file: a command step, an unknown step, a type it doesn’t take, more than 20, a file with errors', async () => {
    const s = setup();
    await s.attach({ kind: 'step', nodeId: 'n2' }, ['a.md', 'x']);
    expect(s.last('opRejected')?.error).toBe('Only agent steps have attachments.');
    await s.attach({ kind: 'step', nodeId: 'n9' }, ['a.md', 'x']);
    expect(s.last('opRejected')?.error).toBe('node n9 does not exist');
    await s.attach(step, ['tool.exe', 'MZ']);
    expect(s.last('opRejected')?.error).toContain("tool.exe can't be attached.");
    for (let i = 0; i < 20; i++) await s.attach(whole, [`f${i}.md`, 'x']);
    await s.attach(whole, ['one-more.md', 'x']);
    expect(s.last('opRejected')?.error).toBe('The graph can have at most 20 attachments.');
    expect(s.app.attachments.names(s.graphId)).toHaveLength(20);
    writeFileSync(join(s.paths.graphsDir, `${s.graphId}.md`), `${s.md()}\n## Broken\n`);
    s.app.graphFileChanged(s.graphId);
    await s.attach(step, ['late.md', 'x']);
    expect(s.last('opRejected')?.error).toMatch(/^The file .*\.md has errors/);
    expect(s.app.attachments.exists(s.graphId, 'late.md')).toBe(false);
  });

  it('removes a name, and its file only when nothing else in the graph uses it', async () => {
    const s = setup();
    await s.attach(step, ['mockup.png', 'png']);
    s.app.graphStore.apply(s.graphId, { type: 'setGraphAttachments', names: ['mockup.png'] }, 'user');
    await s.detach(step, 'mockup.png');
    expect(s.graph().nodes[0]).not.toHaveProperty('attachments');
    expect(s.app.attachments.exists(s.graphId, 'mockup.png')).toBe(true);
    await s.detach(whole, 'mockup.png');
    expect(s.app.attachments.exists(s.graphId, 'mockup.png')).toBe(false);
    await s.detach(whole, 'mockup.png');
    expect(s.last('opRejected')?.error).toBe("mockup.png isn't attached there.");
  });

  it('undo covers attaching and removing, files included', async () => {
    const s = setup();
    await s.attach(step, ['mockup.png', 'png']);
    await s.detach(step, 'mockup.png');
    expect(s.app.attachments.exists(s.graphId, 'mockup.png')).toBe(false);
    await s.app.handle(s.c, { type: 'undo', graphId: s.graphId });
    expect(s.last('undone')?.message).toBe('Undid removed mockup.png.');
    expect(readFileSync(s.file('mockup.png'), 'utf8')).toBe('png');
    expect(s.graph().nodes[0].attachments).toEqual(['mockup.png']);
    await s.app.handle(s.c, { type: 'undo', graphId: s.graphId });
    expect(s.last('undone')?.message).toBe('Undid attached mockup.png.');
    expect(s.app.attachments.exists(s.graphId, 'mockup.png')).toBe(false);
    expect(s.graph().nodes[0]).not.toHaveProperty('attachments');
  });

  it('deleting the graph deletes its attachments folder', async () => {
    const s = setup();
    await s.attach(step, ['mockup.png', 'png']);
    expect(s.app.deleteGraph(s.graphId)).toEqual({ ok: true });
    expect(s.app.attachments.names(s.graphId)).toEqual([]);
  });
});
