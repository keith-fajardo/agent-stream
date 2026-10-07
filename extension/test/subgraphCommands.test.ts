import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '@agent-stream/engine';
import type { ProviderStatus } from '@agent-stream/shared';
import { graphCommands, type Ui } from '../src/commands';
import { EngineManager, type Folder } from '../src/engines';
import { noGit } from './helpers';

const signedIn: ProviderStatus = { provider: 'claude', ok: true, label: 'Claude Max' };

function setup() {
  const path = mkdtempSync(join(tmpdir(), 'cs-sub-'));
  const folder: Folder = { key: `file://${path}`, name: 'a', path };
  const manager = new EngineManager({
    settings: () => ({ claudePath: '', codexPath: '', gitBashPath: '', maxParallel: 1, provider: 'claude', model: '', effort: '' as const, copilotMaxRequestsPerStep: 25, copilotMaxRequestsPerTurn: 10 }),
    platform: 'darwin',
    env: {},
    home: mkdtempSync(join(tmpdir(), 'cs-home-')),
    git: noGit,
    events: { graphs() {}, approvals() {}, confirmRun() {}, graphDeleted() {}, sessions() {}, auth() {}, warning() {} },
    checkAuth: async () => signedIn,
    findClaude: () => ({ ok: true, path: '/bin/claude' }),
    createApp: (deps) => createApp({ ...deps, status: signedIn }),
  });
  const ui = { inputBox: vi.fn(), pickGraph: vi.fn(), pickFolder: vi.fn(), confirm: vi.fn(), openFile: vi.fn(), saveFile: vi.fn(), info: vi.fn(), error: vi.fn(), quickPick: vi.fn(), quickPickMany: vi.fn(), pickParentFolder: vi.fn(), openInNewWindow: vi.fn(), withProgress: vi.fn(), infoAction: vi.fn() } satisfies Record<keyof Ui, unknown>;
  const { commands } = graphCommands({ engines: manager, folders: () => [folder], ui: ui as unknown as Ui, open: async () => {}, openText: async () => {}, activeTarget: () => undefined, sessions: (f) => manager.get(f).listSessions(), activeSession: () => 'default' });
  const app = manager.get(folder);
  const research = app.createGraph('Company research').id;
  for (const name of ['Job hunting', 'Weekly report']) {
    const id = app.createGraph(name).id;
    app.graphStore.apply(id, { type: 'addNode', node: { title: 'Research', kind: 'graph', graph: research } }, 'user');
  }
  return { app, ui, commands, folder, research };
}

describe('sub-graphs in the graph commands (spec §8)', () => {
  it('the delete confirmation names the graphs that use this one', async () => {
    const s = setup();
    s.ui.confirm.mockResolvedValueOnce(false);
    await s.commands.deleteGraph({ folder: s.folder, graphId: s.research });
    expect(s.ui.confirm).toHaveBeenCalledWith(
      'Delete Company research? This removes the graph, its chat, its edit history and its variable values on this machine. Past run logs stay.',
      'Delete',
      'Used as a sub-graph in: Job hunting, Weekly report. Those steps will show "missing graph" until you change them.',
    );
  });

  it('export says which sub-graphs are left out, and import of a graph whose sub-graph is missing works', async () => {
    const s = setup();
    let written = '';
    s.ui.saveFile.mockResolvedValueOnce({ write: async (content: string) => void (written = content) });
    await s.commands.exportGraph({ folder: s.folder, graphId: 'job-hunting' });
    expect(s.ui.info).toHaveBeenCalledWith("Exported job-hunting.md. Variable values were left out. Sub-graphs aren't included: Company research. Export them too.");
    const imported = s.app.importGraph(written.replace('- graph: company-research', '- graph: not-here'));
    expect(imported.ok).toBe(true);
    expect(readFileSync(join(s.folder.path, '.agent-stream', 'graphs', `${imported.ok ? imported.graph.id : ''}.md`), 'utf8')).toContain('- graph: not-here');
  });
});

describe('the export notice and values set on sub-graph steps', () => {
  it('says nothing about them when no sub-graph step has values, and that they were included when one has', async () => {
    const s = setup();
    s.ui.saveFile.mockResolvedValue({ write: async () => {} });
    await s.commands.exportGraph({ folder: s.folder, graphId: 'job-hunting' });
    expect(s.ui.info.mock.calls.at(-1)?.[0]).not.toContain('sub-graph steps are part of');
    const node = s.app.graphStore.load('weekly-report');
    if (!node.ok) throw new Error('expected the graph');
    s.app.graphStore.apply('weekly-report', { type: 'updateNode', id: node.graph.nodes[0].id, patch: { values: { company: 'Acme' } } }, 'user');
    await s.commands.exportGraph({ folder: s.folder, graphId: 'weekly-report' });
    expect(s.ui.info.mock.calls.at(-1)?.[0]).toBe("Exported weekly-report.md. Variable values were left out. Values set on sub-graph steps are part of the graph and were included. Sub-graphs aren't included: Company research. Export them too.");
  });
});

describe('the docs', () => {
  it('describe sub-graph step values in docs/using.md, and the READMEs leave that detail there', () => {
    const read = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8');
    const section = /## Sub-graphs\n[\s\S]*?(?=\n## |$)/.exec(read('../../docs/using.md'))?.[0];
    expect(section).toContain('saved in the graph file');
    expect(read('../../README.md')).not.toContain('## Sub-graphs');
    expect(read('../README.md')).not.toContain('## Sub-graphs');
  });
});
