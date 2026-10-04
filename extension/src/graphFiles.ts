import * as vscode from 'vscode';
import { isGraphId, type App } from '@agent-stream/engine';
import type { GraphFileError } from '@agent-stream/shared';
import type { Folder } from './engines';
import { graphUri } from './graphEditor';

/** How long a graph file must be quiet before its engine reads it (Markdown graph files spec §6.2). */
export const GRAPH_FILE_DEBOUNCE_MS = 200;
/** What the watchers look at, relative to each workspace folder. */
export const GRAPH_FILES_GLOB = '.agent-stream/graphs/*.{md,meta.json}';

/** `<id>.md` or `<id>.meta.json` → the graph id; undefined for any other file. */
export function graphIdOfFile(path: string): string | undefined {
  const name = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1);
  const m = /^(.+?)(?:\.md|\.meta\.json)$/.exec(name);
  return m && isGraphId(m[1]) ? m[1] : undefined;
}

/** The parts of a vscode.FileSystemWatcher the watcher uses; tests pass a fake. */
export type FileWatcher = {
  onDidCreate(listener: (uri: vscode.Uri) => unknown): unknown;
  onDidChange(listener: (uri: vscode.Uri) => unknown): unknown;
  onDidDelete(listener: (uri: vscode.Uri) => unknown): unknown;
  dispose(): unknown;
};

export type GraphFileWatcherDeps = {
  /** The folder's engine, only when it is already running: a folder without one has nothing cached to update. */
  engine(folder: Folder): Pick<App, 'graphFileChanged' | 'graphFileDeleted'> | undefined;
  /** A watcher for GRAPH_FILES_GLOB in the folder (vscode.workspace.createFileSystemWatcher with a RelativePattern). */
  watch(folder: Folder): FileWatcher;
  delayMs?: number;
};

/**
 * Tells each folder's engine when one of its graph files changes outside Agent Stream (spec §6.2). Events are debounced
 * per graph; the last kind wins, so a save by rename (delete, then create) reads as a change.
 */
export class GraphFileWatcher {
  private watchers = new Map<string, { folder: Folder; watcher: FileWatcher }>();
  private pending = new Map<string, { timer: ReturnType<typeof setTimeout>; deleted: boolean }>();

  constructor(private d: GraphFileWatcherDeps) {}

  /** Watches exactly these folders: new ones get a watcher, removed ones lose theirs. */
  sync(folders: Folder[]): void {
    const keys = new Set(folders.map((f) => f.key));
    for (const [key, w] of this.watchers) {
      if (keys.has(key)) continue;
      w.watcher.dispose();
      this.watchers.delete(key);
    }
    for (const folder of folders) {
      if (this.watchers.has(folder.key)) continue;
      const watcher = this.d.watch(folder);
      watcher.onDidCreate((uri) => this.event(folder, uri.path, false));
      watcher.onDidChange((uri) => this.event(folder, uri.path, false));
      watcher.onDidDelete((uri) => this.event(folder, uri.path, true));
      this.watchers.set(folder.key, { folder, watcher });
    }
  }

  private event(folder: Folder, path: string, deleted: boolean): void {
    const id = graphIdOfFile(path);
    if (!id) return;
    const key = `${folder.key}|${id}`;
    const before = this.pending.get(key);
    if (before) clearTimeout(before.timer);
    const timer = setTimeout(() => {
      this.pending.delete(key);
      this.fire(folder, id, deleted);
    }, this.d.delayMs ?? GRAPH_FILE_DEBOUNCE_MS);
    this.pending.set(key, { timer, deleted });
  }

  private fire(folder: Folder, id: string, deleted: boolean): void {
    const engine = this.d.engine(folder);
    if (!engine) return;
    try {
      if (deleted) engine.graphFileDeleted(id);
      else engine.graphFileChanged(id);
    } catch (e) {
      console.error(`[agent-stream] could not read the graph file ${id}`, e);
    }
  }

  dispose(): void {
    for (const { timer } of this.pending.values()) clearTimeout(timer);
    this.pending.clear();
    for (const { watcher } of this.watchers.values()) watcher.dispose();
    this.watchers.clear();
  }
}

/** Where a line's problem shows in the Problems panel: the whole line. */
const LINE_END = 10_000;

/** A Markdown file problem as a VS Code diagnostic on its line. */
export function toDiagnostic(error: GraphFileError): vscode.Diagnostic {
  const line = Math.max(0, error.line - 1);
  const d = new vscode.Diagnostic(new vscode.Range(line, 0, line, LINE_END), error.message, vscode.DiagnosticSeverity.Error);
  d.source = 'Agent Stream';
  return d;
}

/** The parts of a vscode.DiagnosticCollection used here. */
export type Diagnostics = { set(uri: vscode.Uri, diagnostics: vscode.Diagnostic[]): void; delete(uri: vscode.Uri): void };

/** Shows a graph's Markdown problems in the Problems panel, and clears them when there are none (spec §6.3). */
export function publishGraphFileErrors(diagnostics: Diagnostics, folder: Folder, graphId: string, errors: GraphFileError[]): void {
  const uri = graphUri(folder, graphId);
  if (errors.length) diagnostics.set(uri, errors.map(toDiagnostic));
  else diagnostics.delete(uri);
}
