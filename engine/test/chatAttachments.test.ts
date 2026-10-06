import { existsSync, mkdirSync, rmSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Options, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ServerMessage } from '@agent-stream/shared';
import { createApp } from '../src/app';
import { inlineTextFiles, notIncluded, promptWithNotes, saveChatAttachments, type ChatAttachment } from '../src/chatAttachments';
import { GraphStore } from '../src/graphStore';
import { graphTools } from '../src/plannerTools';
import { privatePathDenial, PRIVATE_FOLDER } from '../src/privatePaths';
import { createClaudeProvider } from '../src/providers/claude';
import type { PlannerTurn, TurnFile } from '../src/providers/types';
import { RunStore } from '../src/runStore';
import { appTestDeps, fixedClock, outsideGit, signedIn, testGitBash, testProvider, tmpProject, tmpValuesFile } from './helpers';

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

const b64 = (text: string) => Buffer.from(text).toString('base64');

describe('saving chat attachments (step model spec §6b.2)', () => {
  it('keeps them in the session’s attachments folder under safe, unique names', () => {
    const paths = tmpProject();
    const r = saveChatAttachments(paths, 'default', [{ name: '/tmp/shot (1).png', data: b64('PNG') }, { name: 'shot _1_.png', data: b64('PNG2') }]);
    if (!r.ok) throw new Error(r.error);
    expect(r.files.map((f) => [f.name, f.kind])).toEqual([['shot _1_.png', 'image'], ['shot _1_-2.png', 'image']]);
    expect(readFileSync(join(paths.sessionsDir, 'default', 'attachments', 'shot _1_-2.png'), 'utf8')).toBe('PNG2');
    // The sessions folder is ignored by Git, so chat attachments are never committed.
    expect(readFileSync(join(paths.dataDir, '.gitignore'), 'utf8')).toContain('sessions/');
  });

  it('refuses a type it doesn’t take, writing nothing', () => {
    const paths = tmpProject();
    expect(saveChatAttachments(paths, 'default', [{ name: 'a.md', data: b64('x') }, { name: 'tool.exe', data: b64('MZ') }])).toEqual({ ok: false, error: expect.stringContaining("tool.exe can't be attached.") });
    expect(existsSync(join(paths.sessionsDir, 'default', 'attachments'))).toBe(false);
  });

  it('refuses a session id that is not one, and too many files, writing nothing', () => {
    const paths = tmpProject();
    expect(saveChatAttachments(paths, '../x', [{ name: 'a.md', data: b64('x') }])).toEqual({ ok: false, error: expect.stringContaining('session') });
    expect(saveChatAttachments(paths, 'default', Array.from({ length: 21 }, (_, i) => ({ name: `a${i}.md`, data: b64('x') })))).toEqual({ ok: false, error: expect.stringContaining('at most 20') });
    expect(existsSync(join(paths.sessionsDir, 'default', 'attachments'))).toBe(false);
  });

  it('refuses a size over the limit: 10 MB for an image, 5 MB for the rest', () => {
    const paths = tmpProject();
    const big = (mb: number) => Buffer.alloc(mb * 1024 * 1024 + 1).toString('base64');
    expect(saveChatAttachments(paths, 'default', [{ name: 'a.png', data: big(10) }])).toEqual({ ok: false, error: 'a.png is larger than 10 MB (the limit for images).' });
    expect(saveChatAttachments(paths, 'default', [{ name: 'a.pdf', data: big(5) }])).toEqual({ ok: false, error: 'a.pdf is larger than 5 MB.' });
  });

  it.skipIf(!canLink)('writes nothing through a link: a linked attachments folder, session folder or sessions folder is refused', () => {
    for (const linked of ['attachments', 'session', 'sessions'] as const) {
      const paths = tmpProject();
      const elsewhere = mkdtempSync(join(tmpdir(), 'chat-elsewhere-'));
      if (linked === 'sessions') {
        rmSync(paths.sessionsDir, { recursive: true });
        symlinkSync(elsewhere, paths.sessionsDir, 'dir');
      } else if (linked === 'session') {
        symlinkSync(elsewhere, join(paths.sessionsDir, 'default'), 'dir');
      } else {
        mkdirSync(join(paths.sessionsDir, 'default'), { recursive: true });
        symlinkSync(elsewhere, join(paths.sessionsDir, 'default', 'attachments'), 'dir');
      }
      expect(saveChatAttachments(paths, 'default', [{ name: 'a.md', data: b64('x') }])).toEqual({ ok: false, error: expect.stringContaining('link') });
      expect(readdirSync(elsewhere)).toEqual([]);
    }
  });

  it.skipIf(!canLink)('never writes over or through a link that is already in the folder', () => {
    const paths = tmpProject();
    const elsewhere = mkdtempSync(join(tmpdir(), 'chat-elsewhere-'));
    writeFileSync(join(elsewhere, 'target.md'), 'secret');
    const dir = join(paths.sessionsDir, 'default', 'attachments');
    mkdirSync(dir, { recursive: true });
    symlinkSync(join(elsewhere, 'target.md'), join(dir, 'notes.md'));
    const r = saveChatAttachments(paths, 'default', [{ name: 'notes.md', data: b64('new') }]);
    if (!r.ok) throw new Error(r.error);
    expect(r.files[0].name).toBe('notes-2.md');
    expect(readFileSync(join(elsewhere, 'target.md'), 'utf8')).toBe('secret');
  });

  it('inlines text files after the message, cutting each at 100 KB with a note', () => {
    const file = (name: string, text: string): ChatAttachment => ({ name, kind: 'text', path: name, bytes: Buffer.from(text) });
    expect(inlineTextFiles('Look at this.', [file('notes.md', 'Has ``` inside\n')])).toBe('Look at this.\n\nAttached to this message:\n\n### notes.md\n\n````\nHas ``` inside\n````\n');
    const big = inlineTextFiles('Big.', [file('big.log', 'x'.repeat(100 * 1024 + 5))]);
    expect(big).toContain('### big.log (cut: only its first 100 KB is included)');
    expect(big).toContain(`${'x'.repeat(100 * 1024)}\n\`\`\``);
    expect(inlineTextFiles('Plain.', [])).toBe('Plain.');
  });

  it('cuts at 100 KB of UTF-8 bytes, never inside a character', () => {
    const file = (name: string, text: string): ChatAttachment => ({ name, kind: 'text', path: name, bytes: Buffer.from(text) });
    // 100 KB = 102400 bytes = 34133 euro signs (3 bytes each) and one byte of the next: the cut must back off.
    const euro = inlineTextFiles('E.', [file('e.txt', '€'.repeat(40000))]);
    expect(euro).toContain('### e.txt (cut: only its first 100 KB is included)');
    expect(euro).toContain(`\n${'€'.repeat(34133)}\n\`\`\`\n`);
    expect(euro).not.toContain('\uFFFD');
    // An emoji is 4 bytes (a surrogate pair): never half of one.
    const emoji = inlineTextFiles('E.', [file('e.txt', 'a' + '😀'.repeat(30000))]);
    expect(emoji).not.toContain('\uFFFD');
    expect(emoji).toContain(`a${'😀'.repeat(25599)}\n\`\`\`\n`);
    // Under the limit in characters but over it in bytes: still cut.
    expect(inlineTextFiles('E.', [file('e.txt', '€'.repeat(34134))])).toContain('(cut:');
    // Exactly at the limit: whole.
    expect(inlineTextFiles('E.', [file('e.txt', 'x'.repeat(102400))])).not.toContain('(cut:');
  });

  it('the read tools can’t open the sessions folder', () => {
    const root = tmpProject().root;
    expect(privatePathDenial(root, 'Read', { file_path: join(root, '.agent-stream', 'sessions', 'default', 'attachments', 'shot.png') })).toBe(PRIVATE_FOLDER);
    expect(privatePathDenial(root, 'Glob', { pattern: '*', path: '.agent-stream/sessions' })).toBe(PRIVATE_FOLDER);
    expect(privatePathDenial(root, 'Read', { file_path: join(root, '.agent-stream', 'attachments', 'g', 'a.png') })).toBeNull();
  });
});

describe('a chat message with attachments', () => {
  it('reaches the planner with that message only: text inlined, images and PDFs as files, names on the chat line', async () => {
    const turns: PlannerTurn[] = [];
    const provider = testProvider({ planTurn: async (t) => (turns.push(t), { ok: true, sessionId: 'p1' }) });
    const paths = tmpProject();
    const app = createApp({ ...appTestDeps(), projectDir: paths.root, valuesFile: tmpValuesFile(), provider, status: signedIn, maxParallel: 1, gitBash: testGitBash });
    const graphId = app.graphStore.create('G').id;
    const msgs: ServerMessage[] = [];
    const c = { send: (m: ServerMessage) => void msgs.push(m) };
    app.connect(c);
    await app.handle(c, { type: 'openChat', graphId, sessionId: 'default' });
    await app.handle(c, { type: 'chat', graphId, sessionId: 'default', text: 'Build this.', attachments: [{ name: 'notes.md', data: b64('Use dev.') }, { name: 'shot.png', data: b64('PNG') }, { name: 'spec.pdf', data: b64('%PDF') }] });
    await vi.waitFor(() => expect(turns).toHaveLength(1), { timeout: 5000 });
    expect(turns[0].prompt).toBe('Build this.\n\nAttached to this message:\n\n### notes.md\n\n```\nUse dev.\n```\n');
    expect(turns[0].files?.map((f) => [f.name, f.kind, f.mediaType, f.data])).toEqual([
      ['shot.png', 'image', 'image/png', b64('PNG')],
      ['spec.pdf', 'pdf', 'application/pdf', b64('%PDF')],
    ]);
    const user = msgs.find((m): m is Extract<ServerMessage, { type: 'chatEntry' }> => m.type === 'chatEntry' && m.entry.role === 'user');
    expect(user?.entry).toMatchObject({ text: 'Build this.', attachments: ['notes.md', 'shot.png', 'spec.pdf'] });
    await app.handle(c, { type: 'chat', graphId, sessionId: 'default', text: 'And now?' });
    await vi.waitFor(() => expect(turns).toHaveLength(2), { timeout: 5000 });
    expect(turns[1].prompt).not.toContain('notes.md');
    expect(turns[1]).not.toHaveProperty('files');
  });

  it('refuses a file it doesn’t take, and the planner gets nothing', async () => {
    const planTurn = vi.fn(async () => ({ ok: true as const }));
    const paths = tmpProject();
    const app = createApp({ ...appTestDeps(), projectDir: paths.root, valuesFile: tmpValuesFile(), provider: testProvider({ planTurn }), status: signedIn, maxParallel: 1, gitBash: testGitBash });
    const graphId = app.graphStore.create('G').id;
    const msgs: ServerMessage[] = [];
    await app.handle({ send: (m) => void msgs.push(m) }, { type: 'chat', graphId, sessionId: 'default', text: 'x', attachments: [{ name: 'tool.exe', data: b64('MZ') }] });
    expect(msgs.at(-1)).toEqual({ type: 'error', message: expect.stringContaining("tool.exe can't be attached.") });
    expect(planTurn).not.toHaveBeenCalled();
  });
});

describe('a refused chat message leaves no files behind', () => {
  const sessionFiles = (paths: ReturnType<typeof tmpProject>) => {
    const dir = join(paths.sessionsDir, 'default', 'attachments');
    return existsSync(dir) ? readdirSync(dir) : [];
  };

  it('while the planner is still working on that chat, a second message’s files aren’t saved', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const turns: PlannerTurn[] = [];
    const provider = testProvider({ planTurn: async (t) => (turns.push(t), await gate, { ok: true }) });
    const paths = tmpProject();
    const app = createApp({ ...appTestDeps(), projectDir: paths.root, valuesFile: tmpValuesFile(), provider, status: signedIn, maxParallel: 1, gitBash: testGitBash });
    const graphId = app.graphStore.create('G').id;
    const msgs: ServerMessage[] = [];
    const c = { send: (m: ServerMessage) => void msgs.push(m) };
    app.connect(c);
    await app.handle(c, { type: 'openChat', graphId, sessionId: 'default' });
    await app.handle(c, { type: 'chat', graphId, sessionId: 'default', text: 'First.' });
    await vi.waitFor(() => expect(turns).toHaveLength(1), { timeout: 5000 });
    await app.handle(c, { type: 'chat', graphId, sessionId: 'default', text: 'Second.', attachments: [{ name: 'late.md', data: b64('x') }] });
    expect(sessionFiles(paths)).toEqual([]);
    expect(msgs.some((m) => m.type === 'chatEntry' && m.entry.role === 'error')).toBe(true);
    release();
    await vi.waitFor(() => expect(app.planner.isBusy('default', graphId)).toBe(false), { timeout: 5000 });
  });

  it('when the provider refuses the folder, the files aren’t saved', async () => {
    const planTurn = vi.fn(async () => ({ ok: true as const }));
    const paths = tmpProject();
    const provider = testProvider({ planTurn, folderProblem: () => 'This folder is not allowed.' });
    const app = createApp({ ...appTestDeps(), projectDir: paths.root, valuesFile: tmpValuesFile(), provider, status: signedIn, maxParallel: 1, gitBash: testGitBash });
    const graphId = app.graphStore.create('G').id;
    const msgs: ServerMessage[] = [];
    const c = { send: (m: ServerMessage) => void msgs.push(m) };
    app.connect(c);
    await app.handle(c, { type: 'openChat', graphId, sessionId: 'default' });
    await app.handle(c, { type: 'chat', graphId, sessionId: 'default', text: 'x', attachments: [{ name: 'a.md', data: b64('x') }] });
    await vi.waitFor(() => expect(msgs.some((m) => m.type === 'chatEntry' && m.entry.text === 'This folder is not allowed.')).toBe(true), { timeout: 5000 });
    expect(sessionFiles(paths)).toEqual([]);
    expect(planTurn).not.toHaveBeenCalled();
  });
});

describe('Claude planner: chat attachments', () => {
  it('sends images as images and PDFs as documents with the message', async () => {
    const prompts: (string | AsyncIterable<SDKUserMessage>)[] = [];
    const provider = createClaudeProvider({
      findClaude: () => ({ ok: true, path: '/bin/claude' }),
      checkAuth: async () => signedIn,
      queryFn: ({ prompt }: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options }) => {
        prompts.push(prompt);
        return (async function* (): AsyncGenerator<SDKMessage> {
          yield { type: 'system', subtype: 'init', apiKeySource: 'none', session_id: 's1' } as unknown as SDKMessage;
          yield { type: 'result', subtype: 'success', is_error: false, result: 'ok', num_turns: 1, total_cost_usd: 0, usage: {}, session_id: 's1' } as unknown as SDKMessage;
        })();
      },
    });
    await provider.status();
    const r = await provider.planTurn({
      prompt: 'What is this?',
      systemAppend: '',
      cwd: tmpProject().root,
      tools: [],
      files: [
        { name: 'shot.png', kind: 'image', path: 'shot.png', mediaType: 'image/png', data: 'UE5H' },
        { name: 'spec.pdf', kind: 'pdf', path: 'spec.pdf', mediaType: 'application/pdf', data: 'JVBE' },
      ],
      gate: { privacy: () => null, isReadOnly: () => true, isSelfApproving: () => false, approve: async () => ({ allow: true, by: 'user' }), decide: async () => ({ allow: true, by: 'user' }) },
      transcript: { load: () => undefined, save: () => {} },
      signal: new AbortController().signal,
      onEvent: () => {},
    });
    expect(r.ok).toBe(true);
    const prompt = prompts[0];
    if (typeof prompt === 'string') throw new Error('expected a message with files');
    const sent: SDKUserMessage[] = [];
    for await (const m of prompt) sent.push(m);
    expect(sent[0].message.content).toEqual([
      { type: 'text', text: 'What is this?' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'UE5H' } },
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'JVBE' } },
    ]);
  });
});

describe('Claude planner: an image over 5 MB', () => {
  it('gets a note instead of an image block; the message and the other files still go', async () => {
    const prompts: (string | AsyncIterable<SDKUserMessage>)[] = [];
    const provider = createClaudeProvider({
      findClaude: () => ({ ok: true, path: '/bin/claude' }),
      checkAuth: async () => signedIn,
      queryFn: ({ prompt }: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options }) => {
        prompts.push(prompt);
        return (async function* (): AsyncGenerator<SDKMessage> {
          yield { type: 'result', subtype: 'success', is_error: false, result: 'ok', num_turns: 1, total_cost_usd: 0, usage: {}, session_id: 's1' } as unknown as SDKMessage;
        })();
      },
    });
    await provider.status();
    const events: { type: string; text?: string }[] = [];
    // 4 MB is under 5 MB itself but over it as base64, which is what the API counts; 3.75 MB is exactly 5 MB of base64.
    const big = Buffer.alloc(4 * 1024 * 1024).toString('base64');
    const exact = Buffer.alloc(3.75 * 1024 * 1024).toString('base64');
    const gate = { privacy: () => null, isReadOnly: () => true, isSelfApproving: () => false, approve: async () => ({ allow: true as const, by: 'user' as const }), decide: async () => ({ allow: true as const, by: 'user' as const }) };
    await provider.planTurn({
      prompt: 'Look.',
      systemAppend: '',
      cwd: tmpProject().root,
      tools: [],
      files: [
        { name: 'big.png', kind: 'image', path: 'big.png', mediaType: 'image/png', data: big },
        { name: 'exact.png', kind: 'image', path: 'exact.png', mediaType: 'image/png', data: exact },
      ],
      gate,
      transcript: { load: () => undefined, save: () => {} },
      signal: new AbortController().signal,
      onEvent: (e) => events.push(e),
    });
    const prompt = prompts[0];
    if (typeof prompt === 'string') throw new Error('expected a message with files');
    const sent: SDKUserMessage[] = [];
    for await (const m of prompt) sent.push(m);
    // The model is told too: one line naming the file and why, never a path.
    expect(sent[0].message.content).toEqual([
      { type: 'text', text: "Look.\n\nNote: big.png couldn't be included: it is too large to send (Claude takes images up to 3.75 MB).\n" },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: exact } },
    ]);
    expect((sent[0].message.content as { type: string; text?: string }[])[0].text).not.toMatch(/[\\/]/);
    expect(events).toContainEqual({ type: 'note', text: "big.png couldn't be included: it is too large to send (Claude takes images up to 3.75 MB)." });
  });

  it('with only an oversize image, the plain text prompt still carries the line (and no path)', async () => {
    const prompts: unknown[] = [];
    const provider = createClaudeProvider({
      findClaude: () => ({ ok: true, path: '/bin/claude' }),
      checkAuth: async () => signedIn,
      queryFn: ({ prompt }: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options }) => {
        prompts.push(prompt);
        return (async function* (): AsyncGenerator<SDKMessage> {
          yield { type: 'result', subtype: 'success', is_error: false, result: 'ok', num_turns: 1, total_cost_usd: 0, usage: {}, session_id: 's1' } as unknown as SDKMessage;
        })();
      },
    });
    await provider.status();
    await provider.planTurn({
      prompt: 'Look.',
      systemAppend: '',
      cwd: tmpProject().root,
      tools: [],
      files: [{ name: 'big.png', kind: 'image', path: 'big.png', mediaType: 'image/png', data: Buffer.alloc(5 * 1024 * 1024 + 1).toString('base64') }],
      gate: { privacy: () => null, isReadOnly: () => true, isSelfApproving: () => false, approve: async () => ({ allow: true, by: 'user' }), decide: async () => ({ allow: true, by: 'user' }) },
      transcript: { load: () => undefined, save: () => {} },
      signal: new AbortController().signal,
      onEvent: () => {},
    });
    expect(prompts[0]).toBe("Look.\n\nNote: big.png couldn't be included: it is too large to send (Claude takes images up to 3.75 MB).\n");
  });
});

describe('Claude planner: the inline budget per request (ruling on I-2)', () => {
  async function send(files: TurnFile[]) {
    const prompts: (string | AsyncIterable<SDKUserMessage>)[] = [];
    const provider = createClaudeProvider({
      findClaude: () => ({ ok: true, path: '/bin/claude' }),
      checkAuth: async () => signedIn,
      queryFn: ({ prompt }: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options }) => {
        prompts.push(prompt);
        return (async function* (): AsyncGenerator<SDKMessage> {
          yield { type: 'result', subtype: 'success', is_error: false, result: 'ok', num_turns: 1, total_cost_usd: 0, usage: {}, session_id: 's1' } as unknown as SDKMessage;
        })();
      },
    });
    await provider.status();
    const events: { type: string; text?: string }[] = [];
    await provider.planTurn({
      prompt: 'Look.',
      systemAppend: '',
      cwd: tmpProject().root,
      tools: [],
      files,
      gate: { privacy: () => null, isReadOnly: () => true, isSelfApproving: () => false, approve: async () => ({ allow: true, by: 'user' }), decide: async () => ({ allow: true, by: 'user' }) },
      transcript: { load: () => undefined, save: () => {} },
      signal: new AbortController().signal,
      onEvent: (e) => events.push(e),
    });
    const prompt = prompts[0];
    if (typeof prompt === 'string') throw new Error('expected a message with files');
    const sent: SDKUserMessage[] = [];
    for await (const m of prompt) sent.push(m);
    return { content: sent[0].message.content as { type: string; text?: string }[], events };
  }
  const MB = 1024 * 1024;
  const png = (name: string, size: number): TurnFile => ({ name, kind: 'image', path: name, mediaType: 'image/png', data: Buffer.alloc(size).toString('base64') });
  const pdf = (name: string, size: number): TurnFile => ({ name, kind: 'pdf', path: name, mediaType: 'application/pdf', data: Buffer.alloc(size).toString('base64') });
  const together = (name: string) => `${name} couldn't be included: the message's files were too large to send together.`;

  it('fills 20 MB in message order, PDFs counting too; a file past it gets a line naming it (no path)', async () => {
    const { content, events } = await send([pdf('spec.pdf', 18 * MB), png('big.png', 3 * MB), png('small.png', MB)]);
    expect(content.map((c) => c.type)).toEqual(['text', 'document', 'image']);
    expect(content[0].text).toBe(`Look.\n\nNote: ${together('big.png')}\n`);
    expect(events).toContainEqual({ type: 'note', text: together('big.png') });
  });

  it('sends at most 20 images', async () => {
    const { content } = await send(Array.from({ length: 21 }, (_, i) => png(`i${i}.png`, 10)));
    expect(content.filter((c) => c.type === 'image')).toHaveLength(20);
    expect(content[0].text).toBe(`Look.\n\nNote: ${together('i20.png')}\n`);
  });
});

describe('Codex and Copilot planner messages say what was dropped (spec §6b.5)', () => {
  it('Codex: a PDF is named in the message text, with no path', async () => {
    // Pinned in codexPlanTurn.test.ts too; here the wording helper itself.
    expect(promptWithNotes('Hi.', [notIncluded('spec.pdf', "OpenAI Codex can't read PDFs in the chat")])).toBe("Hi.\n\nNote: spec.pdf couldn't be included: OpenAI Codex can't read PDFs in the chat.\n");
    expect(promptWithNotes('Hi.', [])).toBe('Hi.');
  });
});

describe('the planner is told attachment names, never contents (spec §6b.1)', () => {
  it('get_graph lists the graph’s and each step’s attachments', async () => {
    const paths = tmpProject();
    const graphStore = new GraphStore(paths, fixedClock());
    const graphId = graphStore.create('G').id;
    graphStore.apply(graphId, { type: 'setGraphAttachments', names: ['brief.pdf'] }, 'user');
    graphStore.apply(graphId, { type: 'addNode', node: { title: 'Design', kind: 'agent', prompt: 'p', attachments: ['mockup.png'] } }, 'user');
    const tools = graphTools({ graphStore, runStore: new RunStore(paths), graphId, source: { kind: 'planner' }, requestRun: () => null, checkout: outsideGit(paths.root) });
    const summary = JSON.parse((await tools.find((t) => t.name === 'get_graph')!.run({})).text);
    expect(summary.attachments).toEqual(['brief.pdf']);
    expect(summary.nodes[0].attachments).toEqual(['mockup.png']);
    expect(tools.map((t) => t.name).filter((n) => /attach/.test(n))).toEqual([]);
  });
});
