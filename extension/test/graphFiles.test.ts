import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import type { Folder } from '../src/engines';
import { GRAPH_FILE_DEBOUNCE_MS, GraphFileWatcher, graphIdOfFile, publishGraphFileErrors, type FileWatcher } from '../src/graphFiles';

const a: Folder = { key: 'file:///a', name: 'a', path: '/a' };
const b: Folder = { key: 'file:///b', name: 'b', path: '/b' };
const uri = (path: string) => vscode.Uri.file(path);

/** A watcher per folder whose events the test fires, and a fake engine per folder. */
function setup(running: Folder[] = [a, b]) {
  const watchers = new Map<string, { create: (u: vscode.Uri) => void; change: (u: vscode.Uri) => void; remove: (u: vscode.Uri) => void; dispose: ReturnType<typeof vi.fn> }>();
  const engines = new Map(running.map((f) => [f.key, { graphFileChanged: vi.fn(), graphFileDeleted: vi.fn() }]));
  const watcher = new GraphFileWatcher({
    engine: (f) => engines.get(f.key),
    watch: (f): FileWatcher => {
      const w = { create: (_: vscode.Uri) => {}, change: (_: vscode.Uri) => {}, remove: (_: vscode.Uri) => {}, dispose: vi.fn() };
      watchers.set(f.key, w);
      return { onDidCreate: (l) => (w.create = l), onDidChange: (l) => (w.change = l), onDidDelete: (l) => (w.remove = l), dispose: w.dispose };
    },
  });
  return { watcher, watchers, engines };
}

afterEach(() => vi.useRealTimers());

describe('graphIdOfFile', () => {
  it('reads the id of a Markdown or side file, and nothing else', () => {
    expect(graphIdOfFile('/a/.agent-stream/graphs/parity.md')).toBe('parity');
    expect(graphIdOfFile('C:\\a\\.agent-stream\\graphs\\parity.meta.json')).toBe('parity');
    expect(graphIdOfFile('/a/.agent-stream/graphs/parity.json')).toBeUndefined();
    expect(graphIdOfFile('/a/.agent-stream/graphs/Bad Name.md')).toBeUndefined();
  });
});

describe('GraphFileWatcher', () => {
  it('debounces per graph and tells the engine once, the last event winning', () => {
    vi.useFakeTimers();
    const { watcher, watchers, engines } = setup();
    watcher.sync([a, b]);
    const w = watchers.get(a.key)!;
    w.change(uri('/a/.agent-stream/graphs/g.md'));
    w.change(uri('/a/.agent-stream/graphs/g.meta.json'));
    w.remove(uri('/a/.agent-stream/graphs/g.md'));
    w.create(uri('/a/.agent-stream/graphs/g.md'));
    w.change(uri('/a/.agent-stream/graphs/other.md'));
    vi.advanceTimersByTime(GRAPH_FILE_DEBOUNCE_MS - 1);
    expect(engines.get(a.key)!.graphFileChanged).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(engines.get(a.key)!.graphFileChanged.mock.calls).toEqual([['g'], ['other']]);
    expect(engines.get(a.key)!.graphFileDeleted).not.toHaveBeenCalled();
    w.remove(uri('/a/.agent-stream/graphs/g.md'));
    vi.advanceTimersByTime(GRAPH_FILE_DEBOUNCE_MS);
    expect(engines.get(a.key)!.graphFileDeleted.mock.calls).toEqual([['g']]);
    expect(engines.get(b.key)!.graphFileChanged).not.toHaveBeenCalled();
  });

  it('skips folders without a running engine, and follows the folders', () => {
    vi.useFakeTimers();
    const { watcher, watchers, engines } = setup([a]);
    watcher.sync([a, b]);
    watchers.get(b.key)!.change(uri('/b/.agent-stream/graphs/g.md'));
    vi.advanceTimersByTime(GRAPH_FILE_DEBOUNCE_MS);
    expect(engines.get(a.key)!.graphFileChanged).not.toHaveBeenCalled();
    const bWatcher = watchers.get(b.key)!;
    watcher.sync([a]);
    expect(bWatcher.dispose).toHaveBeenCalled();
    watcher.dispose();
    expect(watchers.get(a.key)!.dispose).toHaveBeenCalled();
  });
});

describe('publishGraphFileErrors', () => {
  it('puts each problem on its line in the Problems panel, and clears them', () => {
    const set = vi.fn();
    const del = vi.fn();
    publishGraphFileErrors({ set, delete: del }, a, 'g', [{ line: 3, message: 'kind is "robot"; use agent or command.' }]);
    const [target, diagnostics] = set.mock.calls[0];
    expect(String(target)).toBe('file:///a/.agent-stream/graphs/g.md');
    expect(diagnostics).toEqual([expect.objectContaining({ message: 'kind is "robot"; use agent or command.', severity: vscode.DiagnosticSeverity.Error, source: 'Agent Stream', range: expect.objectContaining({ startLine: 2, startCharacter: 0, endLine: 2 }) })]);
    publishGraphFileErrors({ set, delete: del }, a, 'g', []);
    expect(String(del.mock.calls[0][0])).toBe('file:///a/.agent-stream/graphs/g.md');
  });
});
