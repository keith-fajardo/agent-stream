import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '@agent-stream/engine';
import type { HostMessage } from '@agent-stream/shared';
import { ChatViewController } from '../src/chatView';
import type { Folder } from '../src/engines';
import { engineTestDeps, signedIn, testProvider } from './helpers';

function setup() {
  const path = mkdtempSync(join(tmpdir(), 'cs-chat-'));
  const folder: Folder = { key: `file://${path}`, name: 'a', path };
  const app = createApp({ ...engineTestDeps(), projectDir: path, valuesFile: join(mkdtempSync(join(tmpdir(), 'cs-home-')), 'values.json'), provider: testProvider(), status: signedIn, maxParallel: 1 });
  const g1 = app.createGraph('Orders').id;
  const g2 = app.createGraph('Billing').id;
  let session = { id: 'default', name: 'Default' };
  const posted: HostMessage[] = [];
  const confirm = vi.fn(async () => true);
  const switchSession = vi.fn();
  const handle = vi.spyOn(app, 'handle');
  const chat = new ChatViewController({ app: () => app, sessions: { active: () => session }, confirm, switchSession, error: vi.fn() });
  chat.attach((m) => posted.push(m));
  const targets = () => posted.filter((m) => m.type === 'chatTarget');
  return { app, folder, g1, g2, chat, posted, targets, confirm, switchSession, handle, setSession: (s: typeof session) => (session = s) };
}

describe('ChatViewController', () => {
  it('follows the active graph tab and opens its conversation in the folder’s session', async () => {
    const s = setup();
    s.chat.activate({ folder: s.folder, graphId: s.g1 }, [{ folder: s.folder, graphId: s.g1 }]);
    await vi.waitFor(() => expect(s.posted.some((m) => m.type === 'chatOpened')).toBe(true));
    expect(s.targets().at(-1)).toEqual({ type: 'chatTarget', target: { graphId: s.g1, graphName: 'Orders', sessionId: 'default', sessionName: 'Default' } });
    expect(s.posted.find((m) => m.type === 'chatOpened')).toMatchObject({ graphId: s.g1, sessionId: 'default' });
  });

  it('keeps the last graph while a non-graph editor is active', () => {
    const s = setup();
    const open = [{ folder: s.folder, graphId: s.g1 }];
    s.chat.activate({ folder: s.folder, graphId: s.g1 }, open);
    const before = s.targets().length;
    s.chat.activate(undefined, open);
    expect(s.targets()).toHaveLength(before);
  });

  it('moves to the most recent other graph tab when its tab closes, and is empty with none', () => {
    const s = setup();
    const both = [{ folder: s.folder, graphId: s.g1 }, { folder: s.folder, graphId: s.g2 }];
    s.chat.activate({ folder: s.folder, graphId: s.g2 }, both);
    s.chat.activate({ folder: s.folder, graphId: s.g1 }, both);
    s.chat.refresh([{ folder: s.folder, graphId: s.g2 }]);
    expect(s.targets().at(-1)).toMatchObject({ target: { graphId: s.g2 } });
    s.chat.refresh([]);
    expect(s.targets().at(-1)).toEqual({ type: 'chatTarget' });
  });

  it('falls back to empty when its graph goes away', async () => {
    const s = setup();
    s.chat.activate({ folder: s.folder, graphId: s.g1 }, [{ folder: s.folder, graphId: s.g1 }]);
    expect(s.app.deleteGraph(s.g1)).toEqual({ ok: true });
    s.chat.refresh([{ folder: s.folder, graphId: s.g1 }]); // the tab may still be closing
    expect(s.targets().at(-1)).toEqual({ type: 'chatTarget' });
    s.handle.mockClear();
    s.chat.handle({ type: 'chat', graphId: s.g1, sessionId: 'default', text: 'hi' });
    expect(s.handle).not.toHaveBeenCalled();
  });

  it('re-subscribes when the folder’s session changes', async () => {
    const s = setup();
    const b = s.app.createSession('B');
    const open = [{ folder: s.folder, graphId: s.g1 }];
    s.chat.activate({ folder: s.folder, graphId: s.g1 }, open);
    s.setSession({ id: b.id, name: 'B' });
    s.chat.refresh(open);
    await vi.waitFor(() => expect(s.posted.filter((m) => m.type === 'chatOpened').at(-1)).toMatchObject({ sessionId: b.id }));
  });

  it('confirms New chat and runs Switch Session for the header buttons', async () => {
    const s = setup();
    s.chat.activate({ folder: s.folder, graphId: s.g1 }, [{ folder: s.folder, graphId: s.g1 }]);
    s.chat.handle({ type: 'chatCommand', command: 'newChat' });
    await vi.waitFor(() => expect(s.handle).toHaveBeenCalledWith(expect.anything(), { type: 'newChat', graphId: s.g1, sessionId: 'default' }));
    expect(s.confirm).toHaveBeenCalledWith('Start a new conversation? This clears the planner chat for Orders in Default.', 'New chat');
    s.chat.handle({ type: 'chatCommand', command: 'switchSession' });
    expect(s.switchSession).toHaveBeenCalledWith(s.folder);
  });

  it("forwards the conversation's model choice to the engine, and only for the conversation it shows", async () => {
    const s = setup();
    s.chat.activate({ folder: s.folder, graphId: s.g1 }, [{ folder: s.folder, graphId: s.g1 }]);
    s.chat.handle({ type: 'setPlannerModel', graphId: s.g1, sessionId: 'default', model: 'sonnet', effort: 'high' });
    await vi.waitFor(() => expect(s.posted.at(-1)).toEqual({ type: 'plannerModel', graphId: s.g1, sessionId: 'default', model: 'sonnet', effort: 'high' }));
    expect(s.app.sessionStore.plannerState('default', s.g1)).toMatchObject({ model: 'sonnet', effort: 'high' });
    s.handle.mockClear();
    s.chat.handle({ type: 'setPlannerModel', graphId: s.g2, sessionId: 'default', model: 'haiku' });
    expect(s.handle).not.toHaveBeenCalled();
    expect(s.posted.at(-1)).toEqual({ type: 'error', message: 'This chat is no longer open.' });
  });

  it('forwards stopPlanner with its session and graph, and only for the conversation it shows', () => {
    const s = setup();
    s.chat.activate({ folder: s.folder, graphId: s.g1 }, [{ folder: s.folder, graphId: s.g1 }]);
    s.handle.mockClear();
    s.chat.handle({ type: 'stopPlanner', graphId: s.g1, sessionId: 'default' });
    expect(s.handle).toHaveBeenCalledWith(expect.anything(), { type: 'stopPlanner', graphId: s.g1, sessionId: 'default' });
    s.handle.mockClear();
    s.chat.handle({ type: 'stopPlanner', graphId: s.g2, sessionId: 'default' });
    expect(s.handle).not.toHaveBeenCalled();
    expect(s.posted.at(-1)).toEqual({ type: 'error', message: 'This chat is no longer open.' });
  });

  it('refuses chat for a conversation it is not showing', () => {
    const s = setup();
    s.chat.activate({ folder: s.folder, graphId: s.g1 }, [{ folder: s.folder, graphId: s.g1 }]);
    s.handle.mockClear();
    s.chat.handle({ type: 'chat', graphId: s.g2, sessionId: 'default', text: 'hi' });
    expect(s.handle).not.toHaveBeenCalled();
    expect(s.posted.at(-1)).toEqual({ type: 'error', message: 'This chat is no longer open.' });
  });
});
