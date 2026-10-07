import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '@agent-stream/engine';
import { MAX_IMPORT_CHARS, SHARED_HOME, type ProviderStatus } from '@agent-stream/shared';
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
    settings: () => ({ claudePath: '', codexPath: '', gitBashPath: '', maxParallel: 1, provider: 'claude', model: '', effort: '' as const, copilotMaxRequestsPerStep: 25, copilotMaxRequestsPerTurn: 10 }),
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
  const texts: GraphTarget[] = [];
  let active: GraphTarget | undefined;
  const { commands, pickGraph } = graphCommands({
    engines: manager,
    folders: () => folders,
    ui: ui as unknown as Ui,
    open: async (t) => void opened.push(t),
    openText: async (t) => void texts.push(t),
    activeTarget: () => active,
    sessions: (f) => manager.get(f).listSessions(),
    activeSession: () => 'default',
  });
  return { manager, ui, opened, texts, commands, pickGraph, folders, gate, setActive: (t: GraphTarget) => (active = t) };
}

describe('graph commands', () => {
  it('moves a graph to a session or to Shared, and does nothing for the session it is already in', async () => {
    const s = setup();
    const engine = s.manager.get(s.folders[0]);
    const work = engine.createSession('Work');
    const g = engine.createGraph('G').id;
    s.ui.quickPick.mockResolvedValueOnce(work.id);
    await s.commands.moveGraph({ folder: s.folders[0], graphId: g });
    expect(engine.listGraphs().find((x) => x.id === g)?.home).toBe(work.id);
    s.ui.quickPick.mockResolvedValueOnce(work.id);
    await s.commands.moveGraph({ folder: s.folders[0], graphId: g });
    expect(s.ui.info).not.toHaveBeenCalled();
    s.ui.quickPick.mockResolvedValueOnce(SHARED_HOME);
    await s.commands.moveGraph({ folder: s.folders[0], graphId: g });
    expect(engine.listGraphs().find((x) => x.id === g)?.home).toBe(SHARED_HOME);
    expect(s.ui.error).not.toHaveBeenCalled();
  });

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
    expect(s.ui.error).toHaveBeenLastCalledWith('Couldn\'t import: The file is not a valid Agent Stream graph: line 1: the file must start with the graph\'s name, as "# Name".');
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
    expect(s.ui.saveFile).toHaveBeenCalledWith(join(s.folders[0].path, 'parity.md'), 'markdown');
    expect(written).toContain('## Variables\n\n- `schema`\n');
    expect(written).not.toContain('secret-schema');
    expect(s.ui.info).toHaveBeenCalledWith('Exported parity.md. Variable values were left out.');
  });

  it('says attachment files are left out when the exported graph names any (graph list or a step)', async () => {
    const s = setup();
    const app = s.manager.get(s.folders[0]);
    const g = app.createGraph('Parity');
    const step = app.graphStore.apply(g.id, { type: 'addNode', node: { kind: 'agent', title: 'Step', prompt: 'p' } }, 'user');
    if (!step.ok) throw new Error(step.error);
    const stepId = step.graph.nodes[0].id;
    const toast = 'Exported parity.md. Variable values were left out. Attachment files aren\'t included: send them with it (from .agent-stream/attachments/parity/).';
    const exportOnce = async () => {
      s.ui.saveFile.mockResolvedValueOnce({ write: async () => {} });
      await s.commands.exportGraph({ folder: s.folders[0], graphId: g.id });
      return s.ui.info.mock.lastCall?.[0];
    };
    app.graphStore.apply(g.id, { type: 'updateNode', id: stepId, patch: { attachments: ['spec.md'] } }, 'user');
    expect(await exportOnce()).toBe(toast);
    app.graphStore.apply(g.id, { type: 'updateNode', id: stepId, patch: { attachments: [] } }, 'user');
    app.graphStore.apply(g.id, { type: 'setGraphAttachments', names: ['mockup.png'] }, 'user');
    expect(await exportOnce()).toBe(toast);
    app.graphStore.apply(g.id, { type: 'setGraphAttachments', names: [] }, 'user');
    expect(await exportOnce()).toBe('Exported parity.md. Variable values were left out.');
  });

  describe('Export Run Report', () => {
    /** A finished run of a new graph, recorded straight into the run store. */
    function withRun(s: ReturnType<typeof setup>, id = '20261003-100000-abcd') {
      const app = s.manager.get(s.folders[0]);
      const g = app.createGraph('Parity');
      const graph = app.graphStore.load(g.id);
      if (!graph.ok) throw new Error(graph.error);
      app.runStore.create({ id, graphId: g.id, status: 'succeeded', startedAt: '2026-10-03T10:00:00.000Z', endedAt: '2026-10-03T10:00:05.000Z', snapshot: graph.graph, nodes: {} });
      return { app, graphId: g.id, runId: id, target: { folder: s.folders[0], graphId: g.id } };
    }
    const savedFile = () => {
      const file = { written: undefined as string | undefined, open: vi.fn(async () => {}), write: vi.fn(async (content: string) => void (file.written = content)) };
      return file;
    };

    it("saves the run's report under the suggested name in the project folder, then opens it", async () => {
      const s = setup();
      const r = withRun(s);
      const file = savedFile();
      s.ui.saveFile.mockResolvedValueOnce(file);
      await s.commands.exportRunReport({ ...r.target, runId: r.runId });
      expect(s.ui.saveFile).toHaveBeenCalledWith(join(s.folders[0].path, `${r.graphId}-run-${r.runId}.md`), 'markdown');
      expect(file.written).toContain('# Run report: Parity');
      expect(file.written).toContain(`- Run: ${r.runId}`);
      expect(file.open).toHaveBeenCalledTimes(1);
      expect(file.write.mock.invocationCallOrder[0]).toBeLessThan(file.open.mock.invocationCallOrder[0]);
    });

    it('writes nothing and opens nothing when the save is cancelled', async () => {
      const s = setup();
      const r = withRun(s);
      s.ui.saveFile.mockResolvedValueOnce(undefined);
      await s.commands.exportRunReport({ ...r.target, runId: r.runId });
      expect(s.ui.saveFile).toHaveBeenCalledTimes(1);
      expect(s.ui.error).not.toHaveBeenCalled();
    });

    it('picks a graph, then one of its runs, newest first; cancelling either does nothing', async () => {
      const s = setup();
      const r = withRun(s);
      r.app.runStore.create({ ...r.app.runStore.get(r.runId)!, id: '20261003-110000-bcde', status: 'failed' });
      s.ui.pickGraph.mockResolvedValueOnce(undefined);
      await s.commands.exportRunReport();
      expect(s.ui.quickPick).not.toHaveBeenCalled();
      s.ui.pickGraph.mockResolvedValueOnce(r.target);
      s.ui.quickPick.mockResolvedValueOnce(undefined);
      await s.commands.exportRunReport();
      expect(s.ui.saveFile).not.toHaveBeenCalled();
      const [items, placeHolder] = s.ui.quickPick.mock.calls[0];
      expect(placeHolder).toBe('Which run?');
      expect(items.map((i: { label: string; value: string }) => [i.label, i.value])).toEqual([
        ['Run 20261003-110000-bcde · Failed', '20261003-110000-bcde'],
        ['Run 20261003-100000-abcd · Succeeded', '20261003-100000-abcd'],
      ]);
      s.ui.pickGraph.mockResolvedValueOnce(r.target);
      s.ui.quickPick.mockResolvedValueOnce('20261003-100000-abcd');
      const file = savedFile();
      s.ui.saveFile.mockResolvedValueOnce(file);
      await s.commands.exportRunReport();
      expect(s.ui.saveFile).toHaveBeenCalledWith(join(s.folders[0].path, `${r.graphId}-run-20261003-100000-abcd.md`), 'markdown');
      expect(file.open).toHaveBeenCalled();
    });

    it("uses the active tab's graph, and says when it has no runs", async () => {
      const s = setup();
      const g = s.manager.get(s.folders[0]).createGraph('Empty');
      s.setActive({ folder: s.folders[0], graphId: g.id });
      await s.commands.exportRunReport();
      expect(s.ui.pickGraph).not.toHaveBeenCalled();
      expect(s.ui.info).toHaveBeenCalledWith('Empty has no runs yet.');
      expect(s.ui.quickPick).not.toHaveBeenCalled();
    });

    it('shows the error for an unknown run', async () => {
      const s = setup();
      const r = withRun(s);
      await s.commands.exportRunReport({ ...r.target, runId: '20261003-120000-ffff' });
      expect(s.ui.error).toHaveBeenCalledWith('run 20261003-120000-ffff not found');
      expect(s.ui.saveFile).not.toHaveBeenCalled();
    });
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

describe('Open Graph as Markdown', () => {
  it('opens the Markdown of the given graph, else the active tab’s', async () => {
    const s = setup();
    const f = s.folders[0];
    const g = s.manager.get(f).createGraph('Parity');
    await s.commands.openGraphMarkdown({ folder: f, graphId: g.id });
    s.setActive({ folder: f, graphId: 'other' });
    await s.commands.openGraphMarkdown();
    expect(s.texts).toEqual([
      { folder: f, graphId: g.id },
      { folder: f, graphId: 'other' },
    ]);
  });

  it('offers graphs whose file has errors too, since the file is where to fix them', async () => {
    const s = setup();
    const f = s.folders[0];
    s.manager.get(f).createGraph('Parity');
    writeFileSync(join(f.path, '.agent-stream', 'graphs', 'broken.md'), 'no name\n');
    s.ui.pickGraph.mockResolvedValueOnce({ folder: f, graphId: 'broken' });
    await s.commands.openGraphMarkdown();
    expect(s.ui.pickGraph.mock.calls[0][0].map((i: { label: string }) => i.label)).toEqual(['Parity', 'broken']);
    expect(s.texts).toEqual([{ folder: f, graphId: 'broken' }]);
  });
});

describe('manifest: graph files', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

  it('opens a graph file as a graph tab only when asked, and offers Open Graph as Markdown', () => {
    expect(manifest.contributes.customEditors).toEqual([{ viewType: 'agentStream.graph', displayName: 'Agent Stream Graph', selector: [{ filenamePattern: '**/.agent-stream/graphs/*.md' }], priority: 'option' }]);
    expect(manifest.activationEvents).toEqual(['workspaceContains:.agent-stream/graphs/*.md', 'workspaceContains:.agent-stream/graphs/*.json']);
    expect(manifest.contributes.commands).toContainEqual({ command: 'agentStream.openGraphMarkdown', title: 'Open Graph as Markdown', category: 'Agent Stream' });
    expect(manifest.contributes.menus['view/item/context']).toContainEqual({ command: 'agentStream.openGraphMarkdown', when: 'view == agentStream.graphs && viewItem =~ /^graph/', group: '1_open@2' });
  });
});
