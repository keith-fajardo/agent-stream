import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { CLAUDE_IMAGE_MAX_BYTES, createStepGate, type NodeContext } from '@agent-stream/engine';
import { EARLIER_SCREENSHOT_REMOVED, emptyGraph, SCREENSHOT_TOO_LARGE, type GraphNode, type NodeEventBody } from '@agent-stream/shared';
import { ApprovalBroker } from '../../engine/src/approvals';
import { createBrowserAsk } from '../../engine/src/browser/approval';
import { toolSetup } from '../../engine/test/browserFakes';
import { createCopilotProvider } from '../src/providers/copilot';
import { fakeLmModel } from './helpers';

const JOBS = 'https://jobs.example/';
const call = (callId: string, name: string, input: object) => new vscode.LanguageModelToolCallPart(callId, name, input);
const text = (value: string) => new vscode.LanguageModelTextPart(value);

async function browserStep(broker: ApprovalBroker, browser = true, shotBytes?: number) {
  const node: GraphNode = { id: 'n1', title: 'Research', kind: 'agent', prompt: 'p', browser, createdBy: 'user', updatedBy: 'user', updatedAt: 't' };
  const events: NodeEventBody[] = [];
  const signal = new AbortController().signal;
  const base = { runId: 'r1', graph: emptyGraph('g', 'G', 't'), node, emit: (e: NodeEventBody) => void events.push(e), signal };
  const s = toolSetup({ ask: createBrowserAsk({ broker, ctx: base }) });
  s.ctx.sites[JOBS] = { title: 'Jobs', snapshot: '- button "Easy Apply" [ref=e3]', elements: { e3: { text: 'Easy Apply', attributes: {}, html: '<button/>' } }, ...(shotBytes !== undefined && { screenshotBytes: shotBytes }) };
  await s.call('browser_open', { url: JOBS });
  await s.call('browser_snapshot');
  const ctx: NodeContext = { ...base, prompt: 'Do it.', cwd: mkdtempSync(join(tmpdir(), 'copilot-browser-')), ...(browser && { browserTools: s.tools }) };
  const gate = createStepGate({ broker, runId: 'r1', graphId: 'g', nodeId: 'n1', nodeTitle: 'Research', projectDir: ctx.cwd, privateFiles: [], signal, emit: ctx.emit, selfApproving: new Set(s.tools.map((t) => `mcp__agent_stream_browser__${t.name}`)) });
  return { ctx, gate };
}
const provider = (model: vscode.LanguageModelChat) =>
  createCopilotProvider({ lm: { selectChatModels: vi.fn(async () => [model]) }, runShell: async () => ({ exitCode: 0, output: '' }), limits: () => ({ maxRequestsPerStep: 10, maxRequestsPerTurn: 10 }) });
const takingImages = (m: ReturnType<typeof fakeLmModel>) => {
  (m.model as unknown as { capabilities: Record<string, boolean> }).capabilities.supportsImageToText = true;
  return m;
};

describe('Copilot: browser tools', () => {
  it('offers them to the model only when the step has Browser on', async () => {
    const on = fakeLmModel({ id: 'auto', replies: [[text('done')]] });
    const b = await browserStep(new ApprovalBroker());
    await provider(on.model).runStep(b.ctx, b.gate);
    expect(on.requests[0].options!.tools!.map((t) => t.name)).toEqual(expect.arrayContaining(['browser_open', 'browser_click', 'browser_wait_for_you']));
    const off = fakeLmModel({ id: 'auto', replies: [[text('done')]] });
    const plain = await browserStep(new ApprovalBroker(), false);
    await provider(off.model).runStep(plain.ctx, plain.gate);
    expect(off.requests[0].options!.tools!.map((t) => t.name)).not.toContain('browser_open');
  });

  it('sends a screenshot as an image to a model that takes images, and says it couldn\'t be shown to one that doesn\'t', async () => {
    const seeing = takingImages(fakeLmModel({ id: 'auto', replies: [[call('c1', 'browser_screenshot', {})], [text('done')]] }));
    const b = await browserStep(new ApprovalBroker());
    expect((await provider(seeing.model).runStep(b.ctx, b.gate)).ok).toBe(true);
    const parts = seeing.requests[1].messages.at(-1)!.content as unknown[];
    expect(parts.some((p) => p instanceof vscode.LanguageModelDataPart && p.mimeType === 'image/png')).toBe(true);
    // Once converted, the image still follows the tool result it belongs to.
    const dataAt = parts.findIndex((p) => p instanceof vscode.LanguageModelDataPart);
    expect(dataAt).toBeGreaterThan(parts.findIndex((p) => p instanceof vscode.LanguageModelToolResultPart));
    const blind = fakeLmModel({ id: 'auto', replies: [[call('c1', 'browser_screenshot', {})], [text('done')]] });
    const c = await browserStep(new ApprovalBroker());
    await provider(blind.model).runStep(c.ctx, c.gate);
    const blindParts = blind.requests[1].messages.at(-1)!.content as unknown[];
    expect(blindParts.some((p) => p instanceof vscode.LanguageModelDataPart)).toBe(false);
    const result = blindParts.find((p) => p instanceof vscode.LanguageModelToolResultPart) as vscode.LanguageModelToolResultPart;
    expect((result.content[0] as vscode.LanguageModelTextPart).value).toContain("The screenshot couldn't be shown to this model.");
  });

  it('a screenshot over 5 MB is sent as text only, saying it was too large', async () => {
    const m = takingImages(fakeLmModel({ id: 'auto', replies: [[call('c1', 'browser_screenshot', { fullPage: true })], [text('done')]] }));
    const b = await browserStep(new ApprovalBroker(), true, CLAUDE_IMAGE_MAX_BYTES + 1);
    expect((await provider(m.model).runStep(b.ctx, b.gate)).ok).toBe(true);
    const parts = m.requests[1].messages.at(-1)!.content as unknown[];
    expect(parts.some((p) => p instanceof vscode.LanguageModelDataPart)).toBe(false);
    const result = parts.find((p) => p instanceof vscode.LanguageModelToolResultPart) as vscode.LanguageModelToolResultPart;
    expect((result.content[0] as vscode.LanguageModelTextPart).value).toContain(SCREENSHOT_TOO_LARGE);
  });

  it('keeps the 3 newest screenshots as images in the conversation; older ones say they were removed', async () => {
    const shot = (n: number) => [call(`c${n}`, 'browser_screenshot', {})];
    const m = takingImages(fakeLmModel({ id: 'auto', replies: [shot(1), shot(2), shot(3), shot(4), [text('done')]] }));
    const b = await browserStep(new ApprovalBroker());
    expect((await provider(m.model).runStep(b.ctx, b.gate)).ok).toBe(true);
    const parts = m.requests[4].messages.flatMap((msg) => msg.content as unknown[]);
    expect(parts.filter((p) => p instanceof vscode.LanguageModelDataPart)).toHaveLength(3);
    expect(parts.filter((p) => p instanceof vscode.LanguageModelTextPart && p.value === EARLIER_SCREENSHOT_REMOVED)).toHaveLength(1);
  });

  it('runs an action only after the user approves its card', async () => {
    const broker = new ApprovalBroker();
    const m = fakeLmModel({ id: 'auto', replies: [[call('c1', 'browser_click', { ref: 'e3' })], [text('done')]] });
    const b = await browserStep(broker);
    const outcome = provider(m.model).runStep(b.ctx, b.gate);
    await vi.waitFor(() => expect(broker.pending()).toHaveLength(1));
    expect(broker.pending()[0].toolName).toBe('browser_click');
    broker.decide(broker.pending()[0].id, { decision: 'approve' });
    expect((await outcome).ok).toBe(true);
    const result = (m.requests[1].messages.at(-1)!.content as unknown[]).find((p) => p instanceof vscode.LanguageModelToolResultPart) as vscode.LanguageModelToolResultPart;
    expect((result.content[0] as vscode.LanguageModelTextPart).value).toContain('Clicked button "Easy Apply".');
  });
});
