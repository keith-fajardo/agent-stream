import { join } from 'node:path';
import type { App } from '@claude-stream/engine';
import { MAX_IMPORT_CHARS } from '@claude-stream/shared';
import type { EngineManager, Folder } from './engines';

export type GraphTarget = { folder: Folder; graphId: string };

/** The VS Code UI the commands use; tests pass a fake. */
export type Ui = {
  inputBox(o: { prompt: string; value?: string; validate(value: string): string | undefined }): Promise<string | undefined>;
  pickGraph(items: { label: string; description?: string; target: GraphTarget }[]): Promise<GraphTarget | undefined>;
  pickFolder(folders: Folder[]): Promise<Folder | undefined>;
  confirm(message: string, action: string): Promise<boolean>;
  openFile(): Promise<{ size: number; read(): Promise<string> } | undefined>;
  saveFile(defaultPath: string): Promise<{ write(content: string): Promise<void> } | undefined>;
  info(message: string): void;
  error(message: string): void;
};

export type CommandDeps = {
  engines: EngineManager;
  folders(): Folder[];
  ui: Ui;
  open(target: GraphTarget): Promise<void>;
  activeTarget(): GraphTarget | undefined;
};

const blankName = (value: string) => (value.trim() ? undefined : 'A graph needs a name.');

/** Graph management (spec §5). Each runs from the sidebar, the tab's File menu (with its graph) or the Command Palette. */
export function graphCommands(d: CommandDeps) {
  const app = (folder: Folder): App => d.engines.get(folder);
  const nameOf = (t: GraphTarget) => {
    const r = app(t.folder).graphStore.load(t.graphId);
    return r.ok ? r.graph.name : t.graphId;
  };

  async function pickGraph(): Promise<GraphTarget | undefined> {
    const folders = d.folders();
    const items = folders.flatMap((folder) =>
      app(folder)
        .listGraphs()
        .filter((g) => !g.error)
        .map((g) => ({ label: g.name, description: folders.length > 1 ? folder.name : undefined, target: { folder, graphId: g.id } })),
    );
    return d.ui.pickGraph(items);
  }

  async function folderFor(target?: { folder?: Folder }): Promise<Folder | undefined> {
    if (target?.folder) return target.folder;
    const active = d.activeTarget();
    if (active) return active.folder;
    const folders = d.folders();
    return folders.length <= 1 ? folders[0] : d.ui.pickFolder(folders);
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
      const r = app(t.folder).exportGraph(t.graphId);
      if (!r.ok) return d.ui.error(r.error);
      const file = await d.ui.saveFile(join(t.folder.path, r.fileName));
      if (!file) return;
      await file.write(r.content);
      d.ui.info(`Exported ${r.fileName}. Variable values were left out.`);
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

  return { commands, pickGraph };
}
