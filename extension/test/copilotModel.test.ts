import { describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { ChatModelError, type ChatMessage, type ChatPart } from '@agent-stream/engine';
import { COPILOT_PERMISSION, JUSTIFICATION, vscodeChatModel } from '../src/providers/copilotModel';
import { fakeLmModel } from './helpers';

const live = () => new AbortController().signal;
async function collect(parts: AsyncIterable<ChatPart>, into: ChatPart[] = []): Promise<ChatPart[]> {
  for await (const p of parts) into.push(p);
  return into;
}

describe('vscodeChatModel', () => {
  it('sends our messages as Language Model messages, with the tools and the justification', async () => {
    const fake = fakeLmModel({ id: 'auto', maxInputTokens: 900_000 });
    const model = vscodeChatModel(fake.model);
    expect(model).toMatchObject({ id: 'auto', maxInputTokens: 900_000 });
    const messages: ChatMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'Do it.' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Reading.' }, { type: 'toolCall', callId: 'c1', name: 'Read', input: { file_path: 'a.txt' } }] },
      { role: 'user', content: [{ type: 'toolResult', callId: 'c1', text: '     1\thello' }] },
    ];
    const tools = [{ name: 'Read', description: 'Read a file.', inputSchema: { type: 'object' } }];
    await collect(model.send(messages, tools, live()));
    const [request] = fake.requests;
    expect(request.messages).toEqual([
      vscode.LanguageModelChatMessage.User([new vscode.LanguageModelTextPart('Do it.')]),
      vscode.LanguageModelChatMessage.Assistant([new vscode.LanguageModelTextPart('Reading.'), new vscode.LanguageModelToolCallPart('c1', 'Read', { file_path: 'a.txt' })]),
      vscode.LanguageModelChatMessage.User([new vscode.LanguageModelToolResultPart('c1', [new vscode.LanguageModelTextPart('     1\thello')])]),
    ]);
    expect(request.options).toEqual({ tools, justification: JUSTIFICATION });
    expect(JUSTIFICATION).toBe('Agent Stream runs your workflow steps on Copilot.');
  });

  it('yields text and tool-call parts and ignores every other part', async () => {
    const fake = fakeLmModel({
      id: 'auto',
      replies: [
        [
          new vscode.LanguageModelTextPart('Hel'),
          new vscode.LanguageModelTextPart('lo'),
          { kind: 'thinking', value: '…' },
          new vscode.LanguageModelDataPart(new Uint8Array([1]), 'application/json'),
          new vscode.LanguageModelToolCallPart('c1', 'Grep', { pattern: 'x' }),
        ],
      ],
    });
    expect(await collect(vscodeChatModel(fake.model).send([], [], live()))).toEqual([
      { type: 'text', text: 'Hel' },
      { type: 'text', text: 'lo' },
      { type: 'toolCall', callId: 'c1', name: 'Grep', input: { pattern: 'x' } },
    ]);
  });

  it.each([
    [vscode.LanguageModelError.NoPermissions('no consent'), 'permission', COPILOT_PERMISSION],
    [vscode.LanguageModelError.Blocked('monthly quota reached'), 'blocked', 'Copilot refused the request (quota or policy): monthly quota reached'],
    [vscode.LanguageModelError.NotFound('gone'), 'notFound', 'The Copilot model gpt-5.6-luna is no longer available. Pick another model.'],
    [new Error('socket hang up'), 'other', 'Copilot failed: socket hang up'],
  ])('maps a refused request to a ChatModelError with the user-facing message (%#)', async (error, code, message) => {
    const fake = fakeLmModel({ id: 'gpt-5.6-luna', replies: [error] });
    const sent = collect(vscodeChatModel(fake.model).send([], [], live()));
    await expect(sent).rejects.toBeInstanceOf(ChatModelError);
    await expect(sent).rejects.toMatchObject({ code, message });
  });

  it('spells the permission message as the spec does', () => {
    expect(COPILOT_PERMISSION).toBe("Agent Stream isn't allowed to use Copilot. Run the step again and choose Allow, or enable it under Accounts › Manage Language Model Access.");
  });

  it('maps an error that ends the stream midway, after the parts before it', async () => {
    const fake = fakeLmModel({ id: 'auto', replies: [[new vscode.LanguageModelTextPart('par'), vscode.LanguageModelError.Blocked('rate limited')]] });
    const parts: ChatPart[] = [];
    await expect(collect(vscodeChatModel(fake.model).send([], [], live()), parts)).rejects.toMatchObject({
      code: 'blocked',
      message: 'Copilot refused the request (quota or policy): rate limited',
    });
    expect(parts).toEqual([{ type: 'text', text: 'par' }]);
  });

  it('cancels the request when the signal aborts, and ends as an abort', async () => {
    const ac = new AbortController();
    const fake = fakeLmModel({ id: 'auto', replies: [[new vscode.LanguageModelTextPart('a'), new vscode.LanguageModelTextPart('b')]] });
    const parts: ChatPart[] = [];
    const run = (async () => {
      for await (const p of vscodeChatModel(fake.model).send([], [], ac.signal)) {
        parts.push(p);
        ac.abort();
      }
    })();
    await expect(run).rejects.toMatchObject({ name: 'AbortError' });
    expect(parts).toEqual([{ type: 'text', text: 'a' }]);
    expect(fake.requests[0].token?.isCancellationRequested).toBe(true);
  });

  it('drops the $schema key z.toJSONSchema adds, without touching the caller\'s schema', async () => {
    const fake = fakeLmModel({ id: 'auto' });
    const inputSchema = { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', properties: { a: { type: 'string' } } };
    await collect(vscodeChatModel(fake.model).send([], [{ name: 'T', description: 'd', inputSchema }], live()));
    expect(fake.requests[0].options?.tools).toEqual([{ name: 'T', description: 'd', inputSchema: { type: 'object', properties: { a: { type: 'string' } } } }]);
    expect(inputSchema.$schema).toBeDefined();
  });
});
