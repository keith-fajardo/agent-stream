import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { emptyGraph, type RunMeta } from '@agent-stream/shared';
import { createApp, valuesFileFor, type GitExec, type NodeOutcome } from '@agent-stream/engine';
import type { Ui } from '../src/commands';
import { EngineManager, type Folder } from '../src/engines';
import { defaultCheckCommand, parallelCommands, realParallelFs } from '../src/parallelTickets';
import { fakeGit, noGit, repoAnswers, signedIn, type GitAnswer } from './helpers';

const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const T1 = 'ABC-1 Fix login';
const T2 = 'ABC-2 Add logout';

function fakeUi() {
  return {
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
    openInNewWindow: vi.fn(async () => {}),
    withProgress: vi.fn(async (_title: string, task: () => Promise<unknown>) => task()),
    infoAction: vi.fn(),
  } satisfies Record<keyof Ui, unknown>;
}

/** A repository folder `<tmp>/app` whose package.json has test and typecheck scripts, and the two worktree paths. */
function repo() {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'cs-tickets-')));
  const root = join(parent, 'app');
  mkdirSync(root);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run', typecheck: 'tsc -p .' } }));
  return { parent, root, p1: join(parent, 'app-abc-1-fix-login'), p2: join(parent, 'app-abc-2-add-logout') };
}
type Repo = ReturnType<typeof repo>;

/** Git for a clean checkout on main where every setup check passes; `worktree add` creates the folder. */
function gitFor(r: Repo, over: Record<string, GitAnswer> = {}) {
  return fakeGit({
    ...repoAnswers({ root: r.root, branch: 'main', head: SHA }),
    'rev-parse --verify --quiet --end-of-options main^{commit}': { stdout: `${SHA}\n` },
    'status --porcelain --untracked-files=normal': { stdout: '?? notes.txt\n' },
    'check-ref-format --branch feat/abc-1-fix-login': {},
    'check-ref-format --branch feat/abc-2-add-logout': {},
    'show-ref --verify --quiet refs/heads/feat/abc-1-fix-login': { code: 1 },
    'show-ref --verify --quiet refs/heads/feat/abc-2-add-logout': { code: 1 },
    'worktree add -b *': (_cwd, args) => {
      mkdirSync(args[4], { recursive: true });
      return {};
    },
    ...over,
  });
}

function setup(r: Repo = repo(), git: GitExec = gitFor(r).exec) {
  const home = mkdtempSync(join(tmpdir(), 'cs-home-'));
  const folder: Folder = { key: `file://${r.root}`, name: 'app', path: r.root };
  // Steps wait until they are stopped, so a test can hold a run open.
  const held = (ctx: { signal: AbortSignal }) => new Promise<NodeOutcome>((resolve) => ctx.signal.addEventListener('abort', () => resolve({ ok: false, output: '', error: 'cancelled' })));
  const manager = new EngineManager({
    settings: () => ({ claudePath: '', codexPath: '', gitBashPath: '', maxParallel: 1, provider: 'claude', model: '', effort: '' as const, copilotMaxRequestsPerStep: 25, copilotMaxRequestsPerTurn: 10 }),
    platform: 'darwin',
    env: {},
    home,
    git: noGit,
    events: { graphs() {}, approvals() {}, confirmRun() {}, graphDeleted() {}, sessions() {}, auth() {}, warning() {} },
    createApp: (deps) => createApp({ ...deps, status: signedIn, executors: { agent: held, command: held } }),
  });
  const ui = fakeUi();
  const opened: { folder: Folder; graphId: string }[] = [];
  const cmds = parallelCommands({ engines: manager, ui: ui as unknown as Ui, git, fs: realParallelFs, home, folderFor: async () => folder, open: async (t) => void opened.push(t) });
  return { r, home, folder, manager, ui, opened, cmds };
}
type Setup = ReturnType<typeof setup>;

/** The wizard's answers, in order: base, tickets (ending with ''), check command; then the parent, the confirmation and the summary button. */
function answer(s: Setup, o: { inputs?: (string | undefined)[]; parent?: 'next' | 'choose'; confirm?: boolean; open?: boolean } = {}) {
  for (const value of o.inputs ?? ['main', T1, T2, '', 'npm test && npm run typecheck']) s.ui.inputBox.mockResolvedValueOnce(value);
  s.ui.quickPick.mockResolvedValueOnce('parent' in o ? o.parent : 'next');
  s.ui.confirm.mockResolvedValueOnce(o.confirm ?? true);
  s.ui.infoAction.mockResolvedValueOnce(o.open ?? true);
}
const added = (git: ReturnType<typeof fakeGit>) => git.calls.filter((c) => c.args[0] === 'worktree' && c.args[1] === 'add');

describe('Set Up Parallel Tickets', () => {
  it('creates one worktree and branch per ticket from one base commit, with a starter graph and the check command in each', async () => {
    const r = repo();
    const git = gitFor(r);
    const s = setup(r, git.exec);
    answer(s);
    s.ui.quickPickMany.mockImplementationOnce(async (items: { value: unknown }[]) => [items[1].value]);
    await s.cmds.setUpParallelTickets();
    expect(s.ui.error).not.toHaveBeenCalled();
    expect(added(git)).toEqual([
      { args: ['worktree', 'add', '-b', 'feat/abc-1-fix-login', r.p1, SHA], cwd: r.root },
      { args: ['worktree', 'add', '-b', 'feat/abc-2-add-logout', r.p2, SHA], cwd: r.root },
    ]);
    for (const [path, id, ticket] of [
      [r.p1, 'abc-1-fix-login', T1],
      [r.p2, 'abc-2-add-logout', T2],
    ]) {
      expect(readFileSync(join(path, '.agent-stream', 'graphs', `${id}.md`), 'utf8')).toContain(`# ${ticket}\n\n## Goal\n\nComplete ticket: ${ticket}\n`);
      expect(JSON.parse(readFileSync(valuesFileFor(path, s.home), 'utf8')).graphs[id]).toEqual({ check_command: 'npm test && npm run typecheck' });
    }
    expect(s.ui.inputBox.mock.calls.map(([o]) => o.prompt)).toEqual([
      'Base branch or commit for the new worktrees',
      'Ticket 1',
      'Ticket 2',
      'Ticket 3 (leave empty to finish)',
      'Command for the full test suite and typecheck (leave empty to set it later)',
    ]);
    expect(s.ui.inputBox.mock.calls[0][0].value).toBe('main');
    expect(s.ui.inputBox.mock.calls[4][0].value).toBe('npm test && npm run typecheck');
    expect(s.ui.quickPick.mock.calls[0][0].map((i: { label: string }) => i.label)).toEqual([`Next to the repo (${r.parent})`, 'Choose folder…']);
    expect(s.ui.confirm).toHaveBeenCalledWith(
      'Create 2 worktrees from main (a1b2c3d)?',
      'Create',
      `${r.p1}  ·  feat/abc-1-fix-login\n${r.p2}  ·  feat/abc-2-add-logout\n1 untracked files stay in this checkout.`,
    );
    expect(s.ui.infoAction).toHaveBeenCalledWith('Set up 2 ticket worktrees from a1b2c3d.', 'Open in New VS Code Window…');
    expect(s.ui.quickPickMany.mock.calls[0][0]).toEqual([
      { label: T1, description: 'feat/abc-1-fix-login', detail: r.p1, value: expect.objectContaining({ path: r.p1 }) },
      { label: T2, description: 'feat/abc-2-add-logout', detail: r.p2, value: expect.objectContaining({ path: r.p2 }) },
    ]);
    expect(s.ui.openInNewWindow.mock.calls).toEqual([[r.p2]]);
  });

  it('puts the worktrees in a chosen folder', async () => {
    const r = repo();
    const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), 'cs-elsewhere-')));
    const git = gitFor(r);
    const s = setup(r, git.exec);
    answer(s, { parent: 'choose', open: false });
    s.ui.pickParentFolder.mockResolvedValueOnce(elsewhere);
    await s.cmds.setUpParallelTickets();
    expect(s.ui.pickParentFolder).toHaveBeenCalledWith(r.parent);
    expect(added(git).map((c) => c.args[4])).toEqual([join(elsewhere, 'app-abc-1-fix-login'), join(elsewhere, 'app-abc-2-add-logout')]);
  });

  it('prefills the check command from the root package.json scripts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cs-pkg-'));
    expect(defaultCheckCommand(dir, realParallelFs)).toBe('');
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' } }));
    expect(defaultCheckCommand(dir, realParallelFs)).toBe('npm test');
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run', typecheck: 'tsc' } }));
    expect(defaultCheckCommand(dir, realParallelFs)).toBe('npm test && npm run typecheck');
    writeFileSync(join(dir, 'package.json'), 'not json');
    expect(defaultCheckCommand(dir, realParallelFs)).toBe('');
  });

  it('refuses outside Git, creating nothing', async () => {
    const s = setup(repo(), noGit);
    await s.cmds.setUpParallelTickets();
    expect(s.ui.error).toHaveBeenCalledWith('Set Up Parallel Tickets needs a Git repository. Not a Git repository');
    expect(s.ui.inputBox).not.toHaveBeenCalled();
  });

  it('shows every failed check in one error, and creates nothing', async () => {
    const r = repo();
    const git = gitFor(r, { 'status --porcelain --untracked-files=no': { stdout: ' M src/a.ts\n' }, 'show-ref --verify --quiet refs/heads/feat/abc-2-add-logout': {} });
    const s = setup(r, git.exec);
    answer(s);
    await s.cmds.setUpParallelTickets();
    expect(s.ui.error).toHaveBeenCalledWith(
      "Can't set up the ticket worktrees: This checkout has uncommitted changes to tracked files (1). Worktrees start from main and won't include them. Commit them yourself, or run this from a clean checkout. The branch feat/abc-2-add-logout already exists.",
    );
    expect(s.ui.confirm).not.toHaveBeenCalled();
    expect(added(git)).toEqual([]);
    expect(existsSync(r.p1)).toBe(false);
  });

  it.each([
    [['main', T1, '', ''], 'Add at least two tickets.'],
    [['main', 'ABC-1', 'abc 1', '', ''], 'Tickets 1 and 2 would both use feat/abc-1.'],
  ])('refuses the tickets %j, creating nothing', async (inputs, message) => {
    const r = repo();
    const git = gitFor(r);
    const s = setup(r, git.exec);
    answer(s, { inputs });
    await s.cmds.setUpParallelTickets();
    expect(s.ui.error).toHaveBeenCalledWith(message);
    expect(added(git)).toEqual([]);
  });

  it.each([
    ['the base', { inputs: [undefined] }],
    ['ticket 1', { inputs: ['main', undefined] }],
    ['ticket 2', { inputs: ['main', T1, undefined] }],
    ['ticket 3', { inputs: ['main', T1, T2, undefined] }],
    ['the parent', { parent: undefined }],
    ['the folder dialog', { parent: 'choose' as const }],
    ['the check command', { inputs: ['main', T1, T2, '', undefined] }],
    ['the confirmation', { confirm: false }],
  ])('creates nothing when cancelled at %s', async (_where, o) => {
    const r = repo();
    const git = gitFor(r);
    const s = setup(r, git.exec);
    answer(s, o);
    await s.cmds.setUpParallelTickets();
    expect(added(git)).toEqual([]);
    expect(s.ui.error).not.toHaveBeenCalled();
    expect(s.ui.infoAction).not.toHaveBeenCalled();
  });

  it('reports a partial failure, keeps what it created, and still offers it', async () => {
    const r = repo();
    const git = gitFor(r, { [`worktree add -b feat/abc-2-add-logout ${r.p2} ${SHA}`]: { code: 128, stderr: `fatal: could not create work tree dir '${r.p2}'\n` } });
    const s = setup(r, git.exec);
    answer(s);
    s.ui.quickPickMany.mockResolvedValueOnce(undefined);
    await s.cmds.setUpParallelTickets();
    expect(s.ui.error).toHaveBeenCalledWith(`Created 1 of 2 worktrees; stopped at ${T2}: fatal: could not create work tree dir '${r.p2}'. Nothing was removed.`);
    expect(s.ui.infoAction).toHaveBeenCalledWith('Set up 1 ticket worktrees from a1b2c3d.', 'Open in New VS Code Window…');
    expect(existsSync(join(r.p1, '.agent-stream', 'graphs', 'abc-1-fix-login.md'))).toBe(true);
    expect(git.ran().some((a) => a.startsWith('worktree remove'))).toBe(false);
    expect(s.ui.openInNewWindow).not.toHaveBeenCalled();
  });
});

describe('manifest', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

  it('contributes Set Up Parallel Tickets, with a branch button in the Graphs view', () => {
    expect(manifest.contributes.commands).toContainEqual({ command: 'agentStream.setUpParallelTickets', title: 'Set Up Parallel Tickets', category: 'Agent Stream', icon: '$(git-branch)' });
    expect(manifest.contributes.menus['view/title']).toContainEqual({ command: 'agentStream.setUpParallelTickets', when: 'view == agentStream.graphs', group: 'navigation@3' });
  });
  it('contributes New A/B Test Graph and Manage Run Workspaces', () => {
    expect(manifest.contributes.commands).toContainEqual({ command: 'agentStream.newAbTestGraph', title: 'New A/B Test Graph', category: 'Agent Stream' });
    expect(manifest.contributes.commands).toContainEqual({ command: 'agentStream.manageRunWorkspaces', title: 'Manage Run Workspaces', category: 'Agent Stream' });
  });
});

describe('New A/B Test Graph', () => {
  const names = (s: Setup, ...values: (string | undefined)[]) => {
    for (const v of values) s.ui.inputBox.mockResolvedValueOnce(v);
  };

  it('validates variant names as workspace names, refusing repeats and clashing variables', async () => {
    const s = setup();
    names(s, 'Warehouse cost test', 'wh_small', 'wh_large', '');
    await s.cmds.newAbTestGraph();
    const [name, v1, v2, v3] = s.ui.inputBox.mock.calls.map(([o]) => o);
    expect([name.prompt, name.placeHolder]).toEqual(['Name of the A/B test graph', 'Warehouse cost test']);
    expect(name.validate(' ')).toBe('A graph needs a name.');
    expect([v1.prompt, v2.prompt, v3.prompt]).toEqual(['Variant 1', 'Variant 2', 'Variant 3 (leave empty to finish)']);
    expect(v1.validate('')).toBe('Enter a variant name, for example wh_small.');
    expect(v1.validate('Small WH')).toBe('Workspace names use lowercase letters, digits, - and _, starting with a letter.');
    expect(v2.validate('wh_small')).toBe('Variant 2 repeats wh_small.');
    expect(v3.validate('')).toBeUndefined();
    expect(v3.validate('wh-small')).toBe('Variants wh_small and wh-small would both use the variable run_wh_small.');
  });

  it('writes the graph into the folder and opens it', async () => {
    const s = setup();
    names(s, 'Warehouse cost test', 'wh_small', 'wh_large', '');
    await s.cmds.newAbTestGraph();
    const app = s.manager.get(s.folder);
    const [listed] = app.listGraphs();
    expect(listed.name).toBe('Warehouse cost test');
    expect(app.graphStore.get(listed.id).nodes.map((n) => n.title)).toEqual(['Plan the comparison', 'Set up wh_small', 'Run wh_small', 'Set up wh_large', 'Run wh_large', 'Compare and recommend']);
    expect(s.opened).toEqual([{ folder: s.folder, graphId: listed.id }]);
  });

  it('trims variant names before validating and building the graph', async () => {
    const s = setup();
    names(s, 'Warehouse cost test', '  wh_small  ', ' wh_large ', '');
    await s.cmds.newAbTestGraph();
    const [, , v2] = s.ui.inputBox.mock.calls.map(([o]) => o);
    expect(v2.validate(' wh_small ')).toBe('Variant 2 repeats wh_small.');
    expect(v2.validate(' Small WH ')).toBe('Workspace names use lowercase letters, digits, - and _, starting with a letter.');
    expect(s.ui.error).not.toHaveBeenCalled();
    const app = s.manager.get(s.folder);
    expect(app.graphStore.get(app.listGraphs()[0].id).nodes.map((n) => n.title)).toEqual(['Plan the comparison', 'Set up wh_small', 'Run wh_small', 'Set up wh_large', 'Run wh_large', 'Compare and recommend']);
  });

  it('stops asking after six variants', async () => {
    const s = setup();
    names(s, 'Six', 'a', 'b', 'c', 'd', 'e', 'f');
    await s.cmds.newAbTestGraph();
    expect(s.ui.inputBox).toHaveBeenCalledTimes(7);
    const app = s.manager.get(s.folder);
    expect(app.graphStore.get(app.listGraphs()[0].id).nodes).toHaveLength(14);
  });

  it('creates nothing when cancelled', async () => {
    const s = setup();
    names(s, 'Warehouse cost test', 'wh_small', undefined);
    await s.cmds.newAbTestGraph();
    expect(s.manager.get(s.folder).listGraphs()).toEqual([]);
    expect(s.opened).toEqual([]);
  });
});

describe('Manage Run Workspaces', () => {
  /** A folder with two finished runs: one whose workspace was deleted by hand, one with a changed and a clean workspace. */
  function world() {
    const r = repo();
    const changed = realpathSync(mkdtempSync(join(tmpdir(), 'cs-ws-changed-')));
    const clean = realpathSync(mkdtempSync(join(tmpdir(), 'cs-ws-clean-')));
    const missing = join(tmpdir(), 'cs-ws-missing-never-created');
    const git = fakeGit({
      'status --porcelain': (cwd) => ({ stdout: cwd === changed ? ' M models/orders.sql\n' : '' }),
      'switch -c *': {},
      'worktree remove *': {},
      'worktree prune': {},
    });
    const s = setup(r, git.exec);
    const app = s.manager.get(s.folder);
    const graph = app.createGraph('Warehouse test');
    const run = (id: string, workspaces: RunMeta['workspaces']): RunMeta => ({
      id,
      graphId: graph.id,
      status: 'succeeded',
      startedAt: 't',
      snapshot: emptyGraph(graph.id, 'Warehouse test', 't'),
      nodes: {},
      workspaces,
      checkout: { root: r.root, linkedWorktree: false },
    });
    app.runStore.create(run('20261003-100000-aaaa', { wh_gone: { path: missing, head: SHA } }));
    app.runStore.create(run('20261003-110000-bbbb', { wh_small: { path: changed, head: SHA }, wh_large: { path: clean, head: SHA } }));
    return { ...s, git, app, changed, clean, missing };
  }
  type World = ReturnType<typeof world>;
  /** Picks the item whose label contains `label`, then the action. */
  const choose = (w: World, label: string, action?: 'open' | 'branch' | 'remove') => {
    w.ui.quickPick.mockImplementationOnce(async (items: { label: string; value: unknown }[]) => items.find((i) => i.label.includes(label))?.value);
    if (action) w.ui.quickPick.mockResolvedValueOnce(action);
  };
  const worktreeCalls = (w: World) => w.git.calls.filter((c) => c.args[0] === 'worktree');

  it('lists every run workspace, newest run first, marking missing ones and ones with changes', async () => {
    const w = world();
    w.ui.quickPick.mockResolvedValueOnce(undefined);
    await w.cmds.manageRunWorkspaces();
    expect(w.ui.quickPick.mock.calls[0][0].map((i: { label: string; description: string; detail: string }) => [i.label, i.description, i.detail])).toEqual([
      ['20261003-110000-bbbb · wh_small · has changes', 'Warehouse test', w.changed],
      ['20261003-110000-bbbb · wh_large', 'Warehouse test', w.clean],
      ['20261003-100000-aaaa · wh_gone · missing', 'Warehouse test', w.missing],
    ]);
    expect(w.git.calls).toEqual([
      { args: ['status', '--porcelain'], cwd: w.changed },
      { args: ['status', '--porcelain'], cwd: w.clean },
    ]);
  });

  it('says so when there are none', async () => {
    const s = setup();
    await s.cmds.manageRunWorkspaces();
    expect(s.ui.info).toHaveBeenCalledWith('No run workspaces in this folder.');
    expect(s.ui.quickPick).not.toHaveBeenCalled();
  });

  it('opens a workspace in a new window', async () => {
    const w = world();
    choose(w, 'wh_large', 'open');
    await w.cmds.manageRunWorkspaces();
    expect(w.ui.quickPick.mock.calls[1][0].map((i: { label: string }) => i.label)).toEqual(['Open in New VS Code Window', 'Create Branch Here', 'Remove']);
    expect(w.ui.openInNewWindow).toHaveBeenCalledWith(w.clean);
  });

  it('creates a branch in the workspace, ab/<run id>-<name> by default', async () => {
    const w = world();
    choose(w, 'wh_large', 'branch');
    w.ui.inputBox.mockImplementationOnce(async (o: { value: string }) => o.value);
    await w.cmds.manageRunWorkspaces();
    expect(w.ui.inputBox.mock.calls[0][0].value).toBe('ab/20261003-110000-bbbb-wh_large');
    expect(w.git.calls.at(-1)).toEqual({ args: ['switch', '-c', 'ab/20261003-110000-bbbb-wh_large'], cwd: w.clean });
    expect(w.ui.info).toHaveBeenCalledWith(`Created the branch ab/20261003-110000-bbbb-wh_large in ${w.clean}. Its uncommitted changes stay there.`);
  });

  it('asks before removing a workspace with changes, then removes it with --force and marks it removed', async () => {
    const w = world();
    choose(w, 'wh_small', 'remove');
    w.ui.confirm.mockResolvedValueOnce(true);
    await w.cmds.manageRunWorkspaces();
    expect(w.ui.confirm).toHaveBeenCalledWith(`Remove ${w.changed}? Its uncommitted changes will be lost.`, 'Remove');
    expect(worktreeCalls(w)).toEqual([{ args: ['worktree', 'remove', '--force', w.changed], cwd: w.r.root }]);
    expect(w.app.runStore.get('20261003-110000-bbbb')?.workspaces?.wh_small.removed).toBe(true);
    expect(w.ui.info).toHaveBeenCalledWith(`Removed ${w.changed}.`);
  });

  it('removes nothing when the user declines', async () => {
    const w = world();
    choose(w, 'wh_small', 'remove');
    w.ui.confirm.mockResolvedValueOnce(false);
    await w.cmds.manageRunWorkspaces();
    expect(worktreeCalls(w)).toEqual([]);
    expect(w.app.runStore.get('20261003-110000-bbbb')?.workspaces?.wh_small.removed).toBeUndefined();
  });

  it('removes a clean workspace without asking and without --force', async () => {
    const w = world();
    choose(w, 'wh_large', 'remove');
    await w.cmds.manageRunWorkspaces();
    expect(w.ui.confirm).not.toHaveBeenCalled();
    expect(worktreeCalls(w)).toEqual([{ args: ['worktree', 'remove', w.clean], cwd: w.r.root }]);
  });

  it('offers only Remove for a missing workspace, and runs git worktree prune', async () => {
    const w = world();
    choose(w, 'wh_gone', 'remove');
    await w.cmds.manageRunWorkspaces();
    expect(w.ui.quickPick.mock.calls[1][0].map((i: { label: string }) => i.label)).toEqual(['Remove']);
    expect(worktreeCalls(w)).toEqual([{ args: ['worktree', 'prune'], cwd: w.r.root }]);
    expect(w.app.runStore.get('20261003-100000-aaaa')?.workspaces?.wh_gone.removed).toBe(true);
  });

  it('refuses to remove a workspace of a run that is still running', async () => {
    const w = world();
    const live = realpathSync(mkdtempSync(join(tmpdir(), 'cs-ws-live-')));
    const g = w.app.createGraph('Live');
    w.app.graphStore.apply(g.id, { type: 'addNode', node: { title: 'run', kind: 'command', command: 'make', workspace: 'wh_live' } }, 'user');
    const started = w.app.runner.start({ graph: w.app.graphStore.get(g.id), rendered: { goal: '', instructions: '', nodes: { n1: 'make' } }, workspaces: { wh_live: { path: live, head: SHA } } });
    if (!started.ok) throw new Error(started.error);
    choose(w, 'wh_live', 'remove');
    await w.cmds.manageRunWorkspaces();
    expect(w.ui.error).toHaveBeenCalledWith(`Run ${started.run.id} is still running. Stop it first.`);
    expect(worktreeCalls(w)).toEqual([]);
    w.app.runner.stop(started.run.id);
  });
});
