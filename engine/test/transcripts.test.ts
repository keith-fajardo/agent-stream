import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../src/agentLoop/chatModel';
import { Transcripts } from '../src/transcripts';
import { textPart, toolCallPart, userText } from './helpers';

const folder = () => join(mkdtempSync(join(tmpdir(), 'transcripts-')), 'transcripts');
const messages: ChatMessage[] = [
  userText('Plan a build.'),
  { role: 'assistant', content: [textPart('Reading.'), toolCallPart('c1', 'Read', { file_path: 'package.json' })] },
  { role: 'user', content: [{ type: 'toolResult', callId: 'c1', text: 'File not found', isError: true }] },
];

describe('Transcripts', () => {
  it('saves and loads a conversation per graph, provider and id, also after a reload', () => {
    const dir = folder();
    const t = new Transcripts(dir);
    t.save('g', 'copilot', 'conv-1', messages);
    expect(existsSync(join(dir, 'g.copilot.conv-1.json'))).toBe(true);
    expect(t.load('g', 'copilot', 'conv-1')).toEqual(messages);
    expect(new Transcripts(dir).load('g', 'copilot', 'conv-1')).toEqual(messages);
    expect(t.load('g', 'claude', 'conv-1')).toBeUndefined();
    expect(t.load('g', 'copilot', 'conv-2')).toBeUndefined();
  });

  it('reads a missing, unreadable or malformed file as missing', () => {
    const dir = folder();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'g.copilot.torn.json'), '[{"role":"user"');
    writeFileSync(join(dir, 'g.copilot.odd.json'), JSON.stringify([{ role: 'system', content: [] }]));
    const t = new Transcripts(dir);
    expect(t.load('g', 'copilot', 'none')).toBeUndefined();
    expect(t.load('g', 'copilot', 'torn')).toBeUndefined();
    expect(t.load('g', 'copilot', 'odd')).toBeUndefined();
  });

  it('refuses ids that could leave the folder', () => {
    const t = new Transcripts(folder());
    expect(t.load('g', 'copilot', '../escape')).toBeUndefined();
    expect(() => t.save('g', 'copilot', '../escape', messages)).toThrow('invalid conversation id "../escape"');
    expect(() => t.save('../g', 'copilot', 'c', messages)).toThrow('invalid graph id "../g"');
  });

  it("clears every provider's transcripts of one graph, and only that graph", () => {
    const dir = folder();
    const t = new Transcripts(dir);
    t.save('g', 'copilot', 'a', messages);
    t.save('g', 'claude', 'b', messages);
    t.save('g-2', 'copilot', 'c', messages);
    t.clear('g');
    expect(readdirSync(dir)).toEqual(['g-2.copilot.c.json']);
    new Transcripts(folder()).clear('g'); // no folder yet: nothing to do
  });
});
