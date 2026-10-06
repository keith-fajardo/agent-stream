import { mkdirSync, mkdtempSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createApp, createClaudeProvider } from '@agent-stream/engine';
import type { HostMessage, ServerMessage } from '@agent-stream/shared';
import type { Folder } from '../src/engines';
import { createMessageHandler, GraphPanel, type PickedFile } from '../src/graphEditor';
import { engineTestDeps } from './helpers';

/** Whether this machine lets a test make a symlink (a Windows runner may not have the privilege). */
const canLink = (() => {
  const d = mkdtempSync(join(tmpdir(), 'linkprobe-'));
  try {
    symlinkSync(d, join(d, 'l'));
    return true;
  } catch {
    return false;
  }
})();

function setup(picked: PickedFile[] | undefined) {
  const path = mkdtempSync(join(tmpdir(), 'cs-attach-'));
  const folder: Folder = { key: `file://${path}`, name: 'a', path };
  const done = async () => ({ ok: true, output: '' });
  const app = createApp({
    ...engineTestDeps(),
    projectDir: path,
    provider: createClaudeProvider({ findClaude: () => ({ ok: true, path: '/bin/claude' }) }),
    status: { provider: 'claude', ok: true, label: 'Claude Max' },
    maxParallel: 1,
    executors: { agent: done, command: done },
    valuesFile: join(mkdtempSync(join(tmpdir(), 'cs-home-')), 'values.json'),
  });
  const graph = app.createGraph('G');
  const posted: HostMessage[] = [];
  const panel = new GraphPanel(folder, graph.id, { post: (m) => void posted.push(m), reveal: vi.fn(), close: vi.fn(), visible: () => false, active: () => false });
  const received: ServerMessage[] = [];
  const openPath = vi.fn();
  const handler = createMessageHandler({
    app,
    panel,
    client: { send: (m) => void received.push(m) },
    runHostCommand: vi.fn(),
    setMinimap: vi.fn(),
    setUpParallelTickets: vi.fn(),
    exportRunReport: vi.fn(),
    activeSession: () => 'default',
    pickFiles: async () => picked,
    openPath,
  });
  return { app, graph, path, received, handler, openPath };
}
const file = (name: string, text: string, size = text.length): PickedFile & { read: ReturnType<typeof vi.fn> } => ({ name, size, read: vi.fn(async () => new TextEncoder().encode(text)) });

describe('Add… and Open in a graph tab (step model spec §6b.4)', () => {
  it('attaches the picked files to the graph through the engine', async () => {
    const s = setup([file('/Users/me/brief.pdf', '%PDF-1.7')]);
    s.handler.handle({ type: 'pickAttachments', target: { kind: 'graph' } });
    await vi.waitFor(() => expect(s.received.some((m) => m.type === 'attached')).toBe(true), { timeout: 5000 });
    expect(s.app.graphStore.get(s.graph.id).attachments).toEqual(['brief.pdf']);
    expect(readFileSync(join(s.path, '.agent-stream', 'attachments', s.graph.id, 'brief.pdf'), 'utf8')).toBe('%PDF-1.7');
  });

  it('refuses a file over the limit before reading it, and does nothing when cancelled', async () => {
    const huge = file('photo.png', '', 11 * 1024 * 1024);
    const s = setup([huge]);
    s.handler.handle({ type: 'pickAttachments', target: { kind: 'graph' } });
    await vi.waitFor(() => expect(s.received).toContainEqual({ type: 'opRejected', graphId: s.graph.id, error: 'photo.png is larger than 10 MB (the limit for images).' }), { timeout: 5000 });
    expect(huge.read).not.toHaveBeenCalled();
    const cancelled = setup(undefined);
    cancelled.handler.handle({ type: 'pickAttachments', target: { kind: 'graph' } });
    await new Promise((r) => setTimeout(r, 10));
    expect(cancelled.received.filter((m) => m.type === 'attached' || m.type === 'opRejected')).toEqual([]);
  });

  it('opens an attachment from the graph’s folder, and never a path outside it', () => {
    const s = setup([]);
    s.handler.handle({ type: 'openAttachment', name: 'mockup.png' });
    expect(s.openPath).toHaveBeenCalledWith(join(s.path, '.agent-stream', 'attachments', s.graph.id, 'mockup.png'));
    s.handler.handle({ type: 'openAttachment', name: '../../.ssh/id_rsa' });
    expect(s.openPath).toHaveBeenCalledTimes(1);
    expect(s.received.at(-1)).toEqual({ type: 'error', message: "Agent Stream can't open ../../.ssh/id_rsa." });
  });

  it('F7: checks the count against the room before reading any file', async () => {
    const s = setup(undefined);
    const files = Array.from({ length: 21 }, (_, i) => file(`f${i}.md`, 'x'));
    const t = setup(files);
    t.handler.handle({ type: 'pickAttachments', target: { kind: 'graph' } });
    await vi.waitFor(() => expect(t.received).toContainEqual({ type: 'opRejected', graphId: t.graph.id, error: 'The graph can have at most 20 attachments.' }), { timeout: 5000 });
    for (const f of files) expect(f.read).not.toHaveBeenCalled();
    expect(s.received).toEqual([]);
  });

  it.skipIf(!canLink)('F3: Open refuses a symlinked attachments folder', () => {
    const s = setup([]);
    const out = mkdtempSync(join(tmpdir(), 'cs-out-'));
    mkdirSync(join(s.path, '.agent-stream', 'attachments'), { recursive: true });
    symlinkSync(out, join(s.path, '.agent-stream', 'attachments', s.graph.id));
    s.handler.handle({ type: 'openAttachment', name: 'a.png' });
    expect(s.openPath).not.toHaveBeenCalled();
    expect(s.received.at(-1)).toMatchObject({ type: 'error' });
  });
});
