import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ApprovalRequest } from '@agent-stream/shared';
import { ApprovalItem, approvalsBadge, ApprovalsView } from '../src/approvalsView';
import type { Folder } from '../src/engines';

const a: Folder = { key: 'file:///a', name: 'a', path: '/a' };
const request = (id: string, createdAt: string, input: unknown = { command: 'dbt build' }): ApprovalRequest => ({
  id,
  runId: 'r',
  graphId: 'g',
  nodeId: 'n2',
  nodeTitle: 'Build new',
  toolName: 'Bash',
  input,
  createdAt,
});

describe('ApprovalsView', () => {
  it('lists pending requests oldest first, each revealing its step', () => {
    const items = new ApprovalsView(() => [
      { folder: a, request: request('later', '2026-10-02T10:00:02Z') },
      { folder: a, request: request('first', '2026-10-02T10:00:01Z') },
    ]).getChildren();
    expect(items.map((i) => i.request.id)).toEqual(['first', 'later']);
    expect([items[0].label, items[0].description, items[0].contextValue]).toEqual(['n2 · Build new', 'Bash: dbt build', 'approval']);
    expect(items[0].command).toEqual({ command: 'agentStream.revealApproval', title: 'Show step', arguments: [items[0]] });
  });

  it('caps the tooltip at 2,000 characters', () => {
    const item = new ApprovalItem(a, request('x', 't', { command: 'y'.repeat(3000) }));
    expect(String(item.tooltip).length).toBe(2001);
    expect(String(item.tooltip).endsWith('…')).toBe(true);
  });

  it('shows the exact text of a graph change as its tooltip', () => {
    const detail = `Title: Install\n\nCommand:\n${'z'.repeat(3000)}`;
    const item = new ApprovalItem(a, { ...request('c', 't', { id: 'n4', command: 'npm {{ x }}' }), toolName: 'Change graph', graphChange: { summary: "n2 wants to change n4's command", detail } });
    expect(item.tooltip).toBe(detail);
    expect(item.description).toBe("n2 wants to change n4's command");
  });

  it('gives a graph change its own context value, so the sidebar never offers Approve for it', () => {
    const item = new ApprovalItem(a, { ...request('c', 't'), toolName: 'Change graph', graphChange: { summary: 's', detail: 'Title: x' } });
    expect(item.contextValue).toBe('graphChange');
    expect(item.command).toEqual({ command: 'agentStream.revealApproval', title: 'Show step', arguments: [item] });
    expect(new ApprovalItem(a, request('p', 't')).contextValue).toBe('approval');
  });

  it('offers Show and Deny for a graph change in the sidebar, never Approve', () => {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    const entries: { command: string; when: string }[] = manifest.contributes.menus['view/item/context'];
    const forGraphChange = entries.filter((e) => e.when.includes('viewItem == graphChange')).map((e) => e.command);
    expect(forGraphChange.sort()).toEqual(['agentStream.deny', 'agentStream.revealApproval']);
    expect(entries.filter((e) => e.command === 'agentStream.approve').map((e) => e.when)).toEqual(['view == agentStream.approvals && viewItem == approval']);
  });

  it('badges the count', () => {
    expect(approvalsBadge(0)).toBeUndefined();
    expect(approvalsBadge(1)).toEqual({ value: 1, tooltip: '1 approval waiting' });
    expect(approvalsBadge(3)).toEqual({ value: 3, tooltip: '3 approvals waiting' });
  });
});
