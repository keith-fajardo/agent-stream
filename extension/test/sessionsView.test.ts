import { describe, expect, it } from 'vitest';
import type { SessionListItem } from '@agent-stream/shared';
import type { Folder } from '../src/engines';
import { SessionItem, SessionsView } from '../src/sessionsView';
import { FolderItem } from '../src/graphsView';

const a: Folder = { key: 'file:///a', name: 'a', path: '/a' };
const b: Folder = { key: 'file:///b', name: 'b', path: '/b' };
const view = (folders: Folder[], sessions: SessionListItem[], active = 'default') =>
  new SessionsView({ folders: () => folders, sessions: () => sessions, active: () => active });

describe('SessionsView', () => {
  it('lists one folder’s sessions with a check on the active one', () => {
    const items = view([a], [
      { id: 'default', name: 'Default', tabCount: 1 },
      { id: 'b', name: 'B', tabCount: 3 },
    ]).getChildren() as SessionItem[];
    expect(items.map((i) => [i.label, i.description, i.contextValue])).toEqual([
      ['Default', '1 tab', 'session'],
      ['B', '3 tabs', 'session'],
    ]);
    expect(items[0].iconPath).toEqual({ id: 'check' });
    expect(items[1].iconPath).toEqual({ id: 'layers' });
    expect(items[1].command).toEqual({ command: 'agentStream.switchSession', title: 'Switch Session', arguments: [{ folder: a, sessionId: 'b' }] });
  });

  it('marks an unreadable session: no command, the reason in the description', () => {
    const [item] = view([a], [{ id: 'x', name: 'x', tabCount: 0, problem: 'invalid JSON' }]).getChildren() as SessionItem[];
    expect(item.contextValue).toBe('sessionBroken');
    expect(item.command).toBeUndefined();
    expect(item.description).toBe("Can't be read: invalid JSON");
  });

  it('groups by folder when there are several', () => {
    const v = view([a, b], [{ id: 'default', name: 'Default', tabCount: 0 }]);
    const top = v.getChildren();
    expect(top.map((i) => [i.label, i instanceof FolderItem])).toEqual([['a', true], ['b', true]]);
    expect(v.getChildren(top[1]).map((i) => i.label)).toEqual(['Default']);
  });
});
