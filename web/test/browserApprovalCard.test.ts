// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import type { ApprovalRequest } from '@agent-stream/shared';

vi.mock('../src/bridge', () => ({ send: vi.fn(), sendHost: vi.fn(), post: vi.fn() }));
const { send } = await import('../src/bridge');
const { ApprovalCard } = await import('../src/components/ApprovalCard');
const { approvableApprovals } = await import('../src/actions');
const { dispatch, getState } = await import('../src/store');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const request: ApprovalRequest = {
  id: 'a1',
  runId: 'r1',
  graphId: 'g',
  nodeId: 'n3',
  nodeTitle: 'Research',
  toolName: 'browser_type',
  input: { ref: 'e4', text: 'data engineer' },
  createdAt: 't',
  browserAction: { site: 'www.linkedin.com', url: 'https://www.linkedin.com/jobs/', title: 'Jobs | LinkedIn', element: 'textbox "Search jobs"', text: 'data engineer', screenshot: 'AAAA' },
};

async function render(r: ApprovalRequest) {
  const container = document.createElement('div');
  const root = createRoot(container);
  await act(async () => root.render(createElement(ApprovalCard, { request: r })));
  return { card: container.querySelector('.approval-card') as HTMLElement, done: () => act(async () => root.unmount()) };
}

describe('the browser approval card', () => {
  it('shows what the step wants to do, where, with the exact text and a screenshot', async () => {
    const { card, done } = await render(request);
    expect(card.textContent).toContain('n3 · Research wants to type "data engineer" into textbox "Search jobs" on www.linkedin.com');
    const rows = Object.fromEntries([...card.querySelectorAll('.browser-action dt')].map((dt) => [dt.textContent, dt.nextElementSibling?.textContent]));
    expect(rows).toEqual({ Site: 'www.linkedin.com', Page: 'Jobs | LinkedIn', Element: 'textbox "Search jobs"', Text: 'data engineer' });
    const img = card.querySelector('img.browser-shot') as HTMLImageElement;
    expect(img.getAttribute('src')).toBe('data:image/jpeg;base64,AAAA');
    expect(img.getAttribute('alt')).toBe('The page: Jobs | LinkedIn');
    await done();
  });

  it('offers Deny, Allow on this site for this step, Allow once and, apart and last, Allow all for this step, above the details', async () => {
    const { card, done } = await render(request);
    const buttons = [...card.querySelectorAll('.approval-actions button')] as HTMLButtonElement[];
    expect(buttons.map((b) => b.textContent)).toEqual(['Deny', 'Allow on this site for this step', 'Allow once', 'Allow all for this step']);
    expect(buttons[2].compareDocumentPosition(card.querySelector('.browser-action')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    vi.mocked(send).mockClear();
    await act(async () => buttons[2].click());
    await act(async () => buttons[1].click());
    await act(async () => buttons[3].click());
    const note = card.querySelector('input') as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(note, 'Wrong field');
      note.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => buttons[0].click());
    expect(vi.mocked(send).mock.calls.map((c) => c[0])).toEqual([
      { type: 'decide', approvalId: 'a1', decision: 'approve' },
      { type: 'decide', approvalId: 'a1', decision: 'approve', scope: 'site' },
      { type: 'decide', approvalId: 'a1', decision: 'approve', scope: 'step' },
      { type: 'decide', approvalId: 'a1', decision: 'deny', note: 'Wrong field' },
    ]);
    await done();
  });

  it('a typing card that also presses Enter says so, in the headline and on its own line', async () => {
    const { card, done } = await render({ ...request, input: { ref: 'e4', text: 'data engineer', submit: true }, browserAction: { ...request.browserAction!, submit: true } });
    expect(card.textContent).toContain('n3 · Research wants to type "data engineer" into textbox "Search jobs", then press Enter, on www.linkedin.com');
    const rows = Object.fromEntries([...card.querySelectorAll('.browser-action dt')].map((dt) => [dt.textContent, dt.nextElementSibling?.textContent]));
    expect(rows).toEqual({ Site: 'www.linkedin.com', Page: 'Jobs | LinkedIn', Element: 'textbox "Search jobs"', Text: 'data engineer', Then: 'presses Enter' });
    await done();
  });

  it('a click card names the element; no text row', async () => {
    const { card, done } = await render({ ...request, toolName: 'browser_click', input: { ref: 'e3' }, browserAction: { site: 'jobs.example', url: 'https://jobs.example/', title: 'Jobs', element: 'button "Easy Apply"' } });
    expect(card.textContent).toContain('n3 · Research wants to click button "Easy Apply" on jobs.example');
    expect([...card.querySelectorAll('.browser-action dt')].map((dt) => dt.textContent)).toEqual(['Site', 'Page', 'Element']);
    expect(card.querySelector('img')).toBeNull();
    await done();
  });

  it('Run › Approve all covers browser actions (once), as it covers other tools', () => {
    dispatch({ kind: 'server', msg: { type: 'graphOpened', changes: [], graph: { id: 'g', name: 'G', goal: '', instructions: '', variables: [], nodes: [], edges: [], nodeSeq: 0, updatedAt: 't' }, runs: [], variableValues: {} } });
    dispatch({ kind: 'server', msg: { type: 'approvals', approvals: [request] } });
    expect(approvableApprovals(getState()).map((a) => a.id)).toEqual(['a1']);
  });
});
