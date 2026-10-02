import { describe, expect, it } from 'vitest';
import { approvalSentence, approvalSummary, relativeTime } from '../src/format';
import type { ApprovalRequest } from '../src/types';

describe('relativeTime', () => {
  const now = Date.parse('2026-10-02T12:00:00Z');
  it('says how long ago, briefly', () => {
    expect(relativeTime('2026-10-02T11:59:30Z', now)).toBe('just now');
    expect(relativeTime('2026-10-02T11:15:00Z', now)).toBe('45m ago');
    expect(relativeTime('2026-10-02T10:00:00Z', now)).toBe('2h ago');
    expect(relativeTime('2026-10-01T09:00:00Z', now)).toBe('yesterday');
    expect(relativeTime('2026-09-28T12:00:00Z', now)).toBe('4d ago');
    expect(relativeTime('2026-07-01T12:00:00Z', now)).toBe('2026-07-01');
    expect(relativeTime('nope', now)).toBe('');
  });
});

describe('approval text', () => {
  const request = (toolName: string, input: unknown): ApprovalRequest => ({ id: 'a', runId: 'r', graphId: 'g', nodeId: 'n2', nodeTitle: 'Build new', toolName, input, createdAt: 't' });

  it('summarises a request in one line', () => {
    expect(approvalSummary('Bash', { command: 'dbt build -s orders_v2\n--target dev' })).toBe('Bash: dbt build -s orders_v2');
    expect(approvalSummary('PowerShell', { command: 'Get-ChildItem' })).toBe('PowerShell: Get-ChildItem');
    expect(approvalSummary('Edit', { file_path: 'models/orders_v2.sql' })).toBe('Edit: models/orders_v2.sql');
    expect(approvalSummary('WebFetch', { url: 'x' })).toBe('WebFetch');
    expect(approvalSummary('Bash', { command: 'x'.repeat(100) })).toBe(`Bash: ${'x'.repeat(79)}…`);
  });

  it('says what a step wants to do', () => {
    expect(approvalSentence(request('Bash', { command: 'dbt build' }))).toBe('n2 Build new wants to run: dbt build');
    expect(approvalSentence(request('Edit', { file_path: 'a.sql' }))).toBe('n2 Build new wants to edit a.sql');
    expect(approvalSentence(request('Write', { file_path: 'a.sql' }))).toBe('n2 Build new wants to write a.sql');
    expect(approvalSentence(request('WebFetch', {}))).toBe('n2 Build new wants to use WebFetch');
  });
});
