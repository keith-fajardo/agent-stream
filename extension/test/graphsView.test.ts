import { describe, expect, it, vi } from 'vitest';
import { SHARED_HOME, type GraphListItem, type ProviderStatus } from '@agent-stream/shared';
import { checkingStatus, type Folder } from '../src/engines';
import { FolderItem, GraphItem, GraphsView, RetryItem, SharedItem } from '../src/graphsView';

const a: Folder = { key: 'file:///a', name: 'a', path: '/a' };
const b: Folder = { key: 'file:///b', name: 'b', path: '/b' };
const now = Date.parse('2026-10-02T12:00:00Z');
const view = (folders: Folder[], graphs: Record<string, GraphListItem[]>, status: ProviderStatus = { provider: 'claude', ok: true, label: 'Claude Max' }, active = 'default') =>
  new GraphsView({ folders: () => folders, graphs: (f) => graphs[f.key] ?? [], status: () => status, now: () => now, active: () => active });

describe('GraphsView', () => {
  it("lists one folder's graphs directly, with their last run", () => {
    const items = view([a], {
      [a.key]: [
        { id: 'p', name: 'Parity', home: 'default', lastRun: { status: 'succeeded', startedAt: '2026-10-02T10:00:00Z' } },
        { id: 'd', name: 'Demo', home: 'default' },
        { id: 'x', name: 'x', home: 'default', error: 'invalid JSON: Unexpected end' },
      ],
    }).getChildren() as GraphItem[];
    expect(items.map((i) => [i.label, i.description, i.contextValue])).toEqual([
      ['Parity', 'Succeeded · 2h ago', 'graph'],
      ['Demo', 'Never run', 'graph'],
      ['x', "Can't be read", 'graphUnreadable'],
    ]);
    expect(items[0].command).toEqual({ command: 'agentStream.openGraph', title: 'Open', arguments: [{ folder: a, graphId: 'p' }] });
    expect([items[0].folder, items[0].graphId]).toEqual([a, 'p']);
    expect(items[2].command).toEqual({ command: 'agentStream.openGraphMarkdown', title: 'Open as Markdown', arguments: [{ folder: a, graphId: 'x' }] });
    expect(items[2].tooltip).toBe('invalid JSON: Unexpected end');
  });

  it('adds the number of agent changes waiting for review', () => {
    const items = view([a], {
      [a.key]: [
        { id: 'p', name: 'Parity', home: 'default', lastRun: { status: 'succeeded', startedAt: '2026-10-02T10:00:00Z' }, agentChanges: 3 },
        { id: 'd', name: 'Demo', home: 'default', agentChanges: 1 },
        { id: 'z', name: 'Zero', home: 'default', agentChanges: 0 },
      ],
    }).getChildren() as GraphItem[];
    expect(items.map((i) => i.description)).toEqual(['Succeeded · 2h ago · 3 agent changes', 'Never run · 1 agent change', 'Never run']);
  });

  it('groups graphs by folder in a multi-folder workspace', () => {
    const v = view([a, b], { [b.key]: [{ id: 'g', name: 'G', home: 'default' }] });
    const top = v.getChildren();
    expect(top.map((i) => [i.label, i instanceof FolderItem])).toEqual([['a', true], ['b', true]]);
    expect(v.getChildren(top[1]).map((i) => i.label)).toEqual(['G']);
  });

  it("shows the active session's graphs, then a Shared group", () => {
    const v = view([a], {
      [a.key]: [
        { id: 'mine', name: 'Mine', home: 'default' },
        { id: 'other', name: 'Other', home: 'work' },
        { id: 'shared', name: 'Common', home: SHARED_HOME },
      ],
    });
    const top = v.getChildren() as (GraphItem | SharedItem)[];
    expect(top.map((i) => i.label)).toEqual(['Mine', 'Shared']);
    expect(top[1]).toBeInstanceOf(SharedItem);
    expect([top[1].contextValue, top[1].id]).toEqual(['shared', `shared:${a.key}`]);
    expect(v.getChildren(top[1]).map((i) => i.label)).toEqual(['Common']);
  });

  it('hides the Shared group when it is empty', () => {
    const v = view([a], { [a.key]: [{ id: 'mine', name: 'Mine', home: 'default' }] });
    expect(v.getChildren().map((i) => i.label)).toEqual(['Mine']);
  });

  it("follows the active session", () => {
    const v = view([a], { [a.key]: [{ id: 'w', name: 'W', home: 'work' }, { id: 'm', name: 'M', home: 'default' }] }, undefined, 'work');
    expect(v.getChildren().map((i) => i.label)).toEqual(['W']);
  });

  it('applies the same grouping under a folder in a multi-folder workspace', () => {
    const v = view([a, b], { [b.key]: [{ id: 'g', name: 'G', home: 'default' }, { id: 's', name: 'S', home: SHARED_HOME }] });
    const top = v.getChildren();
    const inB = v.getChildren(top[1]);
    expect(inB.map((i) => i.label)).toEqual(['G', 'Shared']);
    expect(v.getChildren(inB[1]).map((i) => i.label)).toEqual(['S']);
  });

  it('offers Retry when the sign-in check failed, but not while it runs', () => {
    expect(view([a], {}, { provider: 'claude', ok: false, label: 'not signed in', error: 'Not signed in.' }).getChildren()[0]).toBeInstanceOf(RetryItem);
    expect(new RetryItem().label).toBe('Check again');
    expect(view([a], {}, checkingStatus({ id: 'claude', name: 'Claude' })).getChildren()).toEqual([]);
  });

  it('announces a refresh', () => {
    const v = view([a], {});
    const fired = vi.fn();
    v.onDidChangeTreeData(fired);
    v.refresh();
    expect(fired).toHaveBeenCalled();
  });
});
