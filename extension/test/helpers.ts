import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWriteLeases, type AgentProvider } from '@agent-stream/engine';
import type { ProviderStatus } from '@agent-stream/shared';
import { vi } from 'vitest';
import * as vscode from 'vscode';

export const signedIn: ProviderStatus = { provider: 'claude', ok: true, label: 'Claude Max' };
export function testProvider(over: Partial<AgentProvider> = {}): AgentProvider {
  return { id: 'claude', name: 'Claude', status: async () => signedIn, runStep: async () => ({ ok: true, output: '' }), planTurn: async () => ({ ok: true }), ...over };
}

// Shared with the engine's tests so the fake git and its checkout answers stay in one place.
export { fakeGit, noGit, repoAnswers, type GitAnswer } from '../../engine/test/helpers';
import { noGit } from '../../engine/test/helpers';

/** What createApp needs besides the folder: no real Git, leases and a home folder in temp folders. */
export function engineTestDeps() {
  return { git: noGit, leases: createWriteLeases({ locksDir: mkdtempSync(join(tmpdir(), 'cs-locks-')), isAlive: () => true }), home: mkdtempSync(join(tmpdir(), 'cs-home-')) };
}

type LmRequest = { messages: vscode.LanguageModelChatMessage[]; options?: vscode.LanguageModelChatRequestOptions; token?: vscode.CancellationToken };

/**
 * A Copilot model as vscode.lm returns it (the vscode mock's classes), answering each request from `replies`:
 * parts to stream (an Error item is thrown at that point), or an Error that rejects the request. No real Copilot.
 */
export function fakeLmModel(o: { id: string; name?: string; maxInputTokens?: number; toolCalling?: boolean; replies?: (unknown[] | Error)[] }) {
  const requests: LmRequest[] = [];
  const replies = [...(o.replies ?? [])];
  const sendRequest = vi.fn(async (messages: vscode.LanguageModelChatMessage[], options?: vscode.LanguageModelChatRequestOptions, token?: vscode.CancellationToken) => {
    requests.push({ messages, options, token });
    const reply = replies.shift() ?? [new vscode.LanguageModelTextPart('ok')];
    if (reply instanceof Error) throw reply;
    async function* stream() {
      for (const part of reply as unknown[]) {
        if (part instanceof Error) throw part;
        yield part;
      }
    }
    return { stream: stream(), text: (async function* () {})() };
  });
  const model = {
    id: o.id,
    name: o.name ?? o.id,
    vendor: 'copilot',
    family: o.id,
    version: '1',
    maxInputTokens: o.maxInputTokens ?? 100_000,
    capabilities: { supportsToolCalling: o.toolCalling ?? true },
    countTokens: async () => 0,
    sendRequest,
  };
  return { model: model as unknown as vscode.LanguageModelChat, requests, sendRequest };
}
