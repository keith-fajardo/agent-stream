import { describe, expect, it, vi } from 'vitest';
import type { ApprovalRequest } from '@agent-stream/shared';
import type { Folder, FolderApproval } from '../src/engines';
import { ApprovalNotifier } from '../src/notifications';

const a: Folder = { key: 'file:///a', name: 'a', path: '/a' };
const request = (id: string, graphId = 'g'): ApprovalRequest => ({ id, runId: 'r', graphId, nodeId: 'n2', nodeTitle: 'Build new', toolName: 'Bash', input: { command: 'dbt build' }, createdAt: 't' });

function setup(visible = false) {
  let pending: FolderApproval[] = [];
  const answers: ((choice?: string) => void)[] = [];
  const d = {
    pending: () => pending,
    isVisible: vi.fn(() => visible),
    ask: vi.fn((_message: string, ..._actions: string[]) => new Promise<string | undefined>((resolve) => answers.push(resolve))),
    decide: vi.fn(),
    reveal: vi.fn(),
  };
  return { d, notifier: new ApprovalNotifier(d), setPending: (p: FolderApproval[]) => (pending = p), answers };
}

describe('ApprovalNotifier', () => {
  it('asks once per new request whose tab is not visible', () => {
    const s = setup();
    s.setPending([{ folder: a, request: request('a1') }]);
    s.notifier.update();
    s.notifier.update();
    expect(s.d.ask).toHaveBeenCalledTimes(1);
    expect(s.d.ask).toHaveBeenCalledWith('n2 Build new wants to run: dbt build', 'Approve', 'Deny', 'Show');
  });

  it('stays quiet when the graph tab is visible', () => {
    const s = setup(true);
    s.setPending([{ folder: a, request: request('a1') }]);
    s.notifier.update();
    expect(s.d.ask).not.toHaveBeenCalled();
  });

  it('approves, denies or shows as chosen, unless it was decided elsewhere meanwhile', async () => {
    const s = setup();
    s.setPending([{ folder: a, request: request('a1') }, { folder: a, request: request('a2') }, { folder: a, request: request('a3') }]);
    s.notifier.update();
    s.answers[0]('Approve');
    s.answers[1]('Show');
    await vi.waitFor(() => expect(s.d.decide).toHaveBeenCalledWith(a, 'a1', 'approve'));
    await vi.waitFor(() => expect(s.d.reveal).toHaveBeenCalledWith(a, request('a2')));
    s.setPending([]);
    s.answers[2]('Deny');
    await new Promise((r) => setTimeout(r, 0));
    expect(s.d.decide).toHaveBeenCalledTimes(1);
  });
});
