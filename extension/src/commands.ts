import { join } from 'node:path';
import type { App } from '@agent-stream/engine';
import { MAX_IMPORT_CHARS, statusLabel } from '@agent-stream/shared';
import type { EngineManager, Folder } from './engines';

export type GraphTarget = { folder: Folder; graphId: string };

/** One quick pick item carrying its value. */
export type PickItem<T> = { label: string; description?: string; detail?: string; value: T };

/** The VS Code UI the commands use; tests pass a fake. */
export type Ui = {
  inputBox(o: { prompt: string; value?: string; placeHolder?: string; validate(value: string): string | undefined }): Promise<string | undefined>;
  pickGraph(items: { label: string; description?: string; target: GraphTarget }[]): Promise<GraphTarget | undefined>;
  pickFolder(folders: Folder[]): Promise<Folder | undefined>;
  /** A modal confirmation; `detail` is shown under the message. */
  confirm(message: string, action: string, detail?: string): Promise<boolean>;
  openFile(): Promise<{ size: number; read(): Promise<string> } | undefined>;
  /** A save dialog starting at `defaultPath`, filtered to graph files (the default) or Markdown; `open` shows the saved file in an editor. */
  saveFile(defaultPath: string, kind?: 'graph' | 'markdown'): Promise<{ write(content: string): Promise<void>; open(): Promise<void> } | undefined>;
  info(message: string): void;
  error(message: string): void;
  quickPick<T>(items: PickItem<T>[], placeHolder: string): Promise<T | undefined>;
  quickPickMany<T>(items: PickItem<T>[], placeHolder: string): Promise<T[] | undefined>;
  /** A folder picked in the open dialog, starting at `defaultPath`. */
  pickParentFolder(defaultPath: string): Promise<string | undefined>;
  openInNewWindow(path: string): Promise<void>;
  withProgress<T>(title: string, task: () => Promise<T>): Promise<T>;
  /** An information message with one button: true when it was pressed. */
  infoAction(message: string, action: string): Promise<boolean>;
};

export type CommandDeps = {
  engines: EngineManager;
  folders(): Folder[];
  ui: Ui;
  open(target: GraphTarget): Promise<void>;
  /** Opens the graph's `<id>.md` in a text editor beside the graph tab (Markdown graph files spec §7). */
  openText(target: GraphTarget): Promise<void>;
  activeTarget(): GraphTarget | undefined;
};

/** How many recent runs Export Run Report offers. */
const MAX_RUN_PICKS = 50;
const blankName = (value: string) => (value.trim() ? undefined : 'A graph needs a name.');
const NO_FOLDER = "Open a folder first. Agent Stream keeps graphs in the folder's .agent-stream folder.";

/** Graph management (spec §5). Each runs from the sidebar, the tab's File menu (with its graph) or the Command Palette. */
export function graphCommands(d: CommandDeps) {
  const app = (folder: Folder): App => d.engines.get(folder);
  const nameOf = (t: GraphTarget) => {
    const r = app(t.folder).graphStore.load(t.graphId);
    return r.ok ? r.graph.name : t.graphId;
  };

  /** `withUnreadable`: graphs whose file can't be read are offered too (Open as Markdown is how to fix them). */
  async function pickGraph(withUnreadable = false): Promise<GraphTarget | undefined> {
    const folders = d.folders();
    const items = folders.flatMap((folder) =>
      app(folder)
        .listGraphs()
        .filter((g) => withUnreadable || !g.error)
        .map((g) => ({ label: g.name, description: folders.length > 1 ? folder.name : undefined, target: { folder, graphId: g.id } })),
    );
    return d.ui.pickGraph(items);
  }

  async function folderFor(target?: { folder?: Folder }): Promise<Folder | undefined> {
    if (target?.folder) return target.folder;
    const active = d.activeTarget();
    if (active) return active.folder;
    const folders = d.folders();
    if (folders.length === 0) {
      d.ui.error(NO_FOLDER);
      return undefined;
    }
    return folders.length === 1 ? folders[0] : d.ui.pickFolder(folders);
  }

  async function targetFor(target?: GraphTarget): Promise<GraphTarget | undefined> {
    return target?.graphId ? target : (d.activeTarget() ?? (await pickGraph()));
  }

  const commands = {
    async newGraph(target?: { folder?: Folder }): Promise<void> {
      const folder = await folderFor(target);
      if (!folder) return;
      const name = await d.ui.inputBox({ prompt: 'Name of the new graph', validate: blankName });
      if (name === undefined) return;
      const graph = app(folder).createGraph(name);
      await d.open({ folder, graphId: graph.id });
    },

    async openGraph(target?: GraphTarget): Promise<void> {
      const t = target?.graphId ? target : await pickGraph();
      if (t) await d.open(t);
    },

    async importGraph(target?: { folder?: Folder }): Promise<void> {
      const folder = await folderFor(target);
      if (!folder) return;
      const file = await d.ui.openFile();
      if (!file) return;
      if (file.size > MAX_IMPORT_CHARS) return d.ui.error("Couldn't import: The file is larger than 1 MB.");
      const r = app(folder).importGraph(await file.read());
      if (!r.ok) return d.ui.error(`Couldn't import: ${r.error}`);
      await d.open({ folder, graphId: r.graph.id });
    },

    async exportGraph(target?: GraphTarget): Promise<void> {
      const t = await targetFor(target);
      if (!t) return;
      const engine = app(t.folder);
      const r = engine.exportGraph(t.graphId);
      if (!r.ok) return d.ui.error(r.error);
      const file = await d.ui.saveFile(join(t.folder.path, r.fileName), 'markdown');
      if (!file) return;
      await file.write(r.content);
      // Spec §9: the export names attachments (the graph's or a step's) but doesn't include the files.
      const g = engine.graphStore.load(t.graphId);
      const named = g.ok && (!!g.graph.attachments?.length || g.graph.nodes.some((n) => !!n.attachments?.length));
      const files = named ? ` Attachment files aren't included: send them with it (from .agent-stream/attachments/${t.graphId}/).` : '';
      d.ui.info(`Exported ${r.fileName}. Variable values were left out.${files}`);
    },

    /**
     * Saves a run's Markdown report (default folder: the project folder) and opens it. Without a run, picks the graph
     * (the active tab's, else from a list) and then one of its runs, newest first.
     */
    async exportRunReport(target?: GraphTarget & { runId?: string }): Promise<void> {
      const t = await targetFor(target);
      if (!t) return;
      const engine = app(t.folder);
      let runId = target?.runId;
      if (!runId) {
        const runs = engine.runStore.list(t.graphId);
        if (!runs.length) return d.ui.info(`${nameOf(t)} has no runs yet.`);
        runId = await d.ui.quickPick(
          runs.slice(0, MAX_RUN_PICKS).map((r) => ({ label: `Run ${r.id} · ${statusLabel(r.status)}`, description: r.startedAt, value: r.id })),
          'Which run?',
        );
        if (!runId) return;
      }
      const r = engine.runReport(t.graphId, runId);
      if (!r.ok) return d.ui.error(r.error);
      const file = await d.ui.saveFile(join(t.folder.path, r.suggestedName), 'markdown');
      if (!file) return;
      await file.write(r.markdown);
      await file.open();
    },

    async openGraphMarkdown(target?: GraphTarget): Promise<void> {
      const t = target?.graphId ? target : (d.activeTarget() ?? (await pickGraph(true)));
      if (t) await d.openText(t);
    },

    async renameGraph(target?: GraphTarget): Promise<void> {
      const t = await targetFor(target);
      if (!t) return;
      const name = await d.ui.inputBox({ prompt: 'New name for the graph', value: nameOf(t), validate: blankName });
      if (name === undefined) return;
      const r = app(t.folder).renameGraph(t.graphId, name);
      if (!r.ok) d.ui.error(r.error);
    },

    async duplicateGraph(target?: GraphTarget): Promise<void> {
      const t = await targetFor(target);
      if (!t) return;
      const r = app(t.folder).duplicateGraph(t.graphId);
      if (!r.ok) d.ui.error(r.error);
    },

    async deleteGraph(target?: GraphTarget): Promise<void> {
      const t = await targetFor(target);
      if (!t) return;
      const message = `Delete ${nameOf(t)}? This removes the graph, its chat, its edit history and its variable values on this machine. Past run logs stay.`;
      if (!(await d.ui.confirm(message, 'Delete'))) return;
      const r = app(t.folder).deleteGraph(t.graphId);
      if (!r.ok) d.ui.error(r.error);
    },
  };

  return { commands, pickGraph, folderFor };
}
