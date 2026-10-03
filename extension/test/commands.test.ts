import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '@agent-stream/engine';
import { MAX_IMPORT_CHARS, type ProviderStatus } from '@agent-stream/shared';
import { graphCommands, type GraphTarget, type Ui } from '../src/commands';
import { EngineManager, type Folder } from '../src/engines';
import { noGit } from './helpers';

type NodeOutcome = { ok: true; output: string };
const signedIn: ProviderStatus = { provider: 'claude', ok: true, label: 'Claude Max' };
const folder = (name: string): Folder => {
  const path = mkdtempSync(join(tmpdir(), `cs-${name}-`));
  return { key: `file://${path}`, name, path };
};

function setup(folders: Folder[] = [folder('a')]) {
  // Command steps wait for `release` so a test can hold a run open.
  const gate = { release: () => {} };
  const held = () => new Promise<NodeOutcome>((resolve) => (gate.release = () => resolve({ ok: true, output: '' })));
  const manager = new EngineManager({
    settings: () => ({ claudePath: '', gitBashPath: '', maxParallel: 1, provider: 'claude' }),
    platform: 'darwin',
    env: {},
    home: mkdtempSync(join(tmpdir(), 'cs-home-')),
    git: noGit,
    events: { graphs() {}, approvals() {}, confirmRun() {}, graphDeleted() {}, sessions() {}, auth() {}, warning() {} },
    checkAuth: async () => signedIn,
    findClaude: () => ({ ok: true, path: '/bin/claude' }),
    // Signed in from the start (no checkSignIn in these tests), with steps that wait for the test.
    createApp: (deps) => createApp({ ...deps, status: signedIn, executors: { agent: held, command: held } }),
  });
  const ui = {
    inputBox: vi.fn(),
    pickGraph: vi.fn(),
    pickFolder: vi.fn(),
    confirm: vi.fn(),
    openFile: vi.fn(),
    saveFile: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    quickPick: vi.fn(),
    quickPickMany: vi.fn(),
    pickParentFolder: vi.fn(),
    openInNewWindow: vi.fn(),
    withProgress: vi.fn(),
    infoAction: vi.fn(),
  } satisfies Record<keyof Ui, unknown>;
  const opened: GraphTarget[] = [];
  let active: GraphTarget | undefined;
  const { commands, pickGraph } = graphCommands({
    engines: manager,
    folders: () => folders,
    ui: ui as unknown as Ui,
    open: async (t) => void opened.push(t),
    activeTarget: () => active,
  });
  return { manager, ui, opened, commands, pickGraph, folders, gate, setActive: (t: GraphTarget) => (active = t) };
}

describe('graph commands', () => {
  it('creates a graph from a name and opens it; a blank name is refused; cancelling does nothing', async () => {
    const s = setup();
    s.ui.inputBox.mockResolvedValueOnce(undefined);
    await s.commands.newGraph();
    expect(s.manager.get(s.folders[0]).listGraphs()).toEqual([]);
    s.ui.inputBox.mockResolvedValueOnce('Parity');
    await s.commands.newGraph();
    expect(s.ui.inputBox.mock.calls[0][0].validate('  ')).toBe('A graph needs a name.');
    expect(s.opened).toEqual([{ folder: s.folders[0], graphId: 'parity' }]);
  });

  it('asks which folder when there are several and no tab is active', async () => {
    const s = setup([folder('a'), folder('b')]);
    s.ui.pickFolder.mockResolvedValueOnce(s.folders[1]);
    s.ui.inputBox.mockResolvedValueOnce('G');
    await s.commands.newGraph();
    expect(s.manager.get(s.folders[1]).listGraphs().map((g) => g.id)).toEqual(['g']);
  });

  it('asks for a folder first when no folder is open, for New Graph and Import Graph', async () => {
    const s = setup([]);
    await s.commands.newGraph();
    await s.commands.importGraph();
    const message = "Open a folder first. Agent Stream keeps graphs in the folder's .agent-stream folder.";
    expect(s.ui.error.mock.calls).toEqual([[message], [message]]);
    expect(s.ui.inputBox).not.toHaveBeenCalled();
    expect(s.ui.openFile).not.toHaveBeenCalled();
  });

  it('says nothing when the folder choice is cancelled', async () => {
    const s = setup([folder('a'), folder('b')]);
    s.ui.pickFolder.mockResolvedValue(undefined);
    await s.commands.newGraph();
    await s.commands.importGraph();
    expect(s.ui.error).not.toHaveBeenCalled();
  });

  it('opens a graph picked from every folder', async () => {
    const s = setup([folder('a'), folder('b')]);
    s.manager.get(s.folders[0]).createGraph('One');
    s.manager.get(s.folders[1]).createGraph('Two');
    s.ui.pickGraph.mockImplementationOnce(async (items: { target: GraphTarget }[]) => items[1].target);
    await s.commands.openGraph();
    expect(s.ui.pickGraph.mock.calls[0][0].map((i: { label: string; description?: string }) => [i.label, i.description])).toEqual([
      ['One', 'a'],
      ['Two', 'b'],
    ]);
    expect(s.opened).toEqual([{ folder: s.folders[1], graphId: 'two' }]);
  });

  it('imports a file into a new graph, refusing big or broken files', async () => {
    const s = setup();
    const source = s.manager.get(folder('x'));
    const exported = source.exportGraph(source.createGraph('Parity').id);
    if (!exported.ok) throw new Error(exported.error);
    s.ui.openFile.mockResolvedValueOnce({ size: MAX_IMPORT_CHARS + 1, read: async () => '' });
    await s.commands.importGraph();
    expect(s.ui.error).toHaveBeenLastCalledWith("Couldn't import: The file is larger than 1 MB.");
    s.ui.openFile.mockResolvedValueOnce({ size: 4, read: async () => 'nope' });
    await s.commands.importGraph();
    expect(s.ui.error).toHaveBeenLastCalledWith("Couldn't import: The file is not valid JSON.");
    s.ui.openFile.mockResolvedValueOnce({ size: exported.content.length, read: async () => exported.content });
    await s.commands.importGraph();
    expect(s.opened).toEqual([{ folder: s.folders[0], graphId: 'parity' }]);
  });

  it('exports without variable values', async () => {
    const s = setup();
    const app = s.manager.get(s.folders[0]);
    const g = app.createGraph('Parity');
    app.graphStore.apply(g.id, { type: 'addVariable', name: 'schema' }, 'user');
    app.values.set(g.id, 'schema', 'secret-schema');
    let written = '';
    s.ui.saveFile.mockResolvedValueOnce({ write: async (content: string) => void (written = content) });
    await s.commands.exportGraph({ folder: s.folders[0], graphId: g.id });
    expect(s.ui.saveFile).toHaveBeenCalledWith(join(s.folders[0].path, 'parity.agent-stream.json'));
    expect(JSON.parse(written).graph.variables).toEqual([{ name: 'schema', description: '' }]);
    expect(written).not.toContain('secret-schema');
    expect(s.ui.info).toHaveBeenCalledWith('Exported parity.agent-stream.json. Variable values were left out.');
  });

  it('renames starting from the current name', async () => {
    const s = setup();
    const g = s.manager.get(s.folders[0]).createGraph('Parity');
    s.ui.inputBox.mockResolvedValueOnce('Orders parity');
    await s.commands.renameGraph({ folder: s.folders[0], graphId: g.id });
    expect(s.ui.inputBox.mock.calls[0][0].value).toBe('Parity');
    expect(s.manager.get(s.folders[0]).listGraphs()[0].name).toBe('Orders parity');
  });

  it('deletes after confirmation, and refuses while the graph runs', async () => {
    const s = setup();
    const app = s.manager.get(s.folders[0]);
    const g = app.createGraph('Parity');
    const target = { folder: s.folders[0], graphId: g.id };
    s.ui.confirm.mockResolvedValueOnce(false);
    await s.commands.deleteGraph(target);
    expect(s.ui.confirm).toHaveBeenCalledWith(
      'Delete Parity? This removes the graph, its chat, its edit history and its variable values on this machine. Past run logs stay.',
      'Delete',
    );
    expect(app.listGraphs()).toHaveLength(1);

    app.graphStore.apply(g.id, { type: 'addNode', node: { title: 'b', kind: 'command', command: 'x' } }, 'user');
    const msgs: { type: string; preview?: { signature: string } }[] = [];
    const client = { send: (m: never) => void msgs.push(m) };
    await app.handle(client, { type: 'previewRun', graphId: g.id });
    await app.handle(client, { type: 'startRun', graphId: g.id, reviewed: msgs.find((m) => m.type === 'runPreview')!.preview!.signature });
    s.ui.confirm.mockResolvedValueOnce(true);
    await s.commands.deleteGraph(target);
    expect(s.ui.error).toHaveBeenLastCalledWith('Stop the run first.');
    s.gate.release();
    await vi.waitFor(() => expect(app.runner.activeFor(g.id)).toBeUndefined());
    s.ui.confirm.mockResolvedValueOnce(true);
    await s.commands.deleteGraph(target);
    expect(app.listGraphs()).toEqual([]);
  });

  it('acts on the active tab when no graph is given', async () => {
    const s = setup();
    const g = s.manager.get(s.folders[0]).createGraph('Parity');
    s.setActive({ folder: s.folders[0], graphId: g.id });
    await s.commands.duplicateGraph();
    expect(s.manager.get(s.folders[0]).listGraphs().map((x) => x.name).sort()).toEqual(['Parity', 'Parity copy']);
  });
});
