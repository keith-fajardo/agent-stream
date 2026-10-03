import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  abTestGraph,
  checkSetup,
  createWorktrees,
  inspectCheckout,
  MAX_TICKETS,
  MAX_VARIANTS,
  MIN_VARIANTS,
  planWorktrees,
  pruneWorkspaces,
  realWorktreeFs,
  removeWorkspace,
  variantProblem,
  writeStarterGraph,
  type GitExec,
  type RunWorkspaceItem,
  type WorktreeFs,
} from '@agent-stream/engine';
import type { GraphTarget, PickItem, Ui } from './commands';
import type { EngineManager, Folder } from './engines';

/** What the wizards read from disk; tests use the real one on temp folders. */
export type ParallelFs = WorktreeFs & { readFile(p: string): string | undefined };
export const realParallelFs: ParallelFs = {
  ...realWorktreeFs,
  readFile: (p) => {
    try {
      return readFileSync(p, 'utf8');
    } catch {
      return undefined;
    }
  },
};

/** The parallel-work commands (spec §5.3–§5.5). VS Code-free: everything goes through `ui`, `git` and `fs`. */
export type ParallelDeps = {
  engines: EngineManager;
  ui: Ui;
  git: GitExec;
  fs: ParallelFs;
  /** The home folder: each new worktree's check command is seeded in its values file there. */
  home: string;
  folderFor(target?: { folder?: Folder }): Promise<Folder | undefined>;
  open(target: GraphTarget): Promise<void>;
};

/** `npm test && npm run typecheck` when the root package.json has both scripts, `npm test` with only `test`, else empty (spec §5.3). */
export function defaultCheckCommand(root: string, fs: ParallelFs): string {
  const text = fs.readFile(join(root, 'package.json'));
  if (!text) return '';
  try {
    const scripts = (JSON.parse(text) as { scripts?: Record<string, unknown> }).scripts ?? {};
    if (typeof scripts.test !== 'string') return '';
    return typeof scripts.typecheck === 'string' ? 'npm test && npm run typecheck' : 'npm test';
  } catch {
    return '';
  }
}

const sha7 = (sha: string) => sha.slice(0, 7);

export function parallelCommands(d: ParallelDeps) {
  /** One worktree and branch per ticket from one base commit, each with a starter graph (spec §5.3). Never overwrites anything. */
  async function setUpParallelTickets(target?: { folder?: Folder }): Promise<void> {
    const folder = await d.folderFor(target);
    if (!folder) return;
    const info = await inspectCheckout(folder.path, d.git);
    if (!info.git) return d.ui.error(`Set Up Parallel Tickets needs a Git repository. ${info.reason}`);
    const base = await d.ui.inputBox({ prompt: 'Base branch or commit for the new worktrees', value: info.branch ?? info.head ?? '', validate: (v) => (v.trim() ? undefined : 'Enter a branch or commit.') });
    if (base === undefined) return;
    const tickets: string[] = [];
    for (let n = 1; n <= MAX_TICKETS; n++) {
      const optional = n > 2;
      const value = await d.ui.inputBox({
        prompt: optional ? `Ticket ${n} (leave empty to finish)` : `Ticket ${n}`,
        validate: (v) => (optional || v.trim() ? undefined : 'Enter a ticket, for example ABC-123 Fix the login redirect.'),
      });
      if (value === undefined) return;
      if (!value.trim()) break;
      tickets.push(value.trim());
    }
    const nextToRepo = dirname(info.root);
    const where = await d.ui.quickPick<'next' | 'choose'>(
      [
        { label: `Next to the repo (${nextToRepo})`, value: 'next' },
        { label: 'Choose folder…', value: 'choose' },
      ],
      'Where should the worktrees go?',
    );
    if (!where) return;
    const parent = where === 'next' ? nextToRepo : await d.ui.pickParentFolder(nextToRepo);
    if (!parent) return;
    const checkCommand = await d.ui.inputBox({
      prompt: 'Command for the full test suite and typecheck (leave empty to set it later)',
      value: defaultCheckCommand(info.root, d.fs),
      validate: () => undefined,
    });
    if (checkCommand === undefined) return;
    const planned = planWorktrees({ root: info.root, parent, tickets });
    if (!planned.ok) return d.ui.error(planned.error);
    const check = await checkSetup(planned.plan, base.trim(), d.git, d.fs);
    if (check.problems.length || !check.sha) return d.ui.error(`Can't set up the ticket worktrees: ${check.problems.join(' ')}`);
    const sha = check.sha;
    const n = planned.plan.items.length;
    const lines = planned.plan.items.map((i) => `${i.path}  ·  ${i.branch}`);
    if (check.untracked > 0) lines.push(`${check.untracked} untracked files stay in this checkout.`);
    if (!(await d.ui.confirm(`Create ${n} worktrees from ${base.trim()} (${sha7(sha)})?`, 'Create', lines.join('\n')))) return;
    const result = await d.ui.withProgress('Creating ticket worktrees', () =>
      createWorktrees(planned.plan, sha, d.git, (item) => {
        writeStarterGraph({ worktreePath: item.path, ticket: item.ticket, checkCommand, home: d.home });
      }),
    );
    if (result.failed) d.ui.error(`Created ${result.created.length} of ${n} worktrees; stopped at ${result.failed.item.ticket}: ${result.failed.error}. Nothing was removed.`);
    if (result.created.length === 0) return;
    if (!(await d.ui.infoAction(`Set up ${result.created.length} ticket worktrees from ${sha7(sha)}.`, 'Open in New VS Code Window…'))) return;
    const picked = await d.ui.quickPickMany(
      result.created.map((i) => ({ label: i.ticket, description: i.branch, detail: i.path, value: i })),
      'Open which worktrees?',
    );
    for (const item of picked ?? []) await d.ui.openInNewWindow(item.path);
  }

  /** A graph with one variant workspace per variant and a read-only compare step (spec §5.4). */
  async function newAbTestGraph(target?: { folder?: Folder }): Promise<void> {
    const folder = await d.folderFor(target);
    if (!folder) return;
    const name = await d.ui.inputBox({ prompt: 'Name of the A/B test graph', placeHolder: 'Warehouse cost test', validate: (v) => (v.trim() ? undefined : 'A graph needs a name.') });
    if (name === undefined) return;
    const variants: string[] = [];
    for (let n = 1; n <= MAX_VARIANTS; n++) {
      const optional = n > MIN_VARIANTS;
      const earlier = [...variants];
      const value = await d.ui.inputBox({
        prompt: optional ? `Variant ${n} (leave empty to finish)` : `Variant ${n}`,
        placeHolder: n === 1 ? 'wh_small' : n === 2 ? 'wh_large' : undefined,
        validate: (v) => (v.trim() ? (variantProblem(v.trim(), earlier) ?? undefined) : optional ? undefined : 'Enter a variant name, for example wh_small.'),
      });
      if (value === undefined) return;
      if (!value.trim()) break;
      variants.push(value.trim());
    }
    let content: string;
    try {
      content = JSON.stringify(abTestGraph(name.trim(), variants));
    } catch (e) {
      return d.ui.error(e instanceof Error ? e.message : String(e));
    }
    const r = d.engines.get(folder).importGraph(content);
    if (!r.ok) return d.ui.error(`Couldn't create the A/B test graph: ${r.error}`);
    await d.open({ folder, graphId: r.graph.id });
  }

  /** Opens, branches or removes the variant workspaces this folder's runs created; nothing is removed any other way (spec §5.5). */
  async function manageRunWorkspaces(target?: { folder?: Folder }): Promise<void> {
    const folder = await d.folderFor(target);
    if (!folder) return;
    const app = d.engines.get(folder);
    const entries = app.runWorkspaces();
    if (entries.length === 0) return d.ui.info('No run workspaces in this folder.');
    type Entry = RunWorkspaceItem & { missing: boolean; changes: boolean };
    const items = await Promise.all(
      entries.map(async (w): Promise<PickItem<Entry>> => {
        const missing = !d.fs.exists(w.path);
        const changes = !missing && (await d.git(['status', '--porcelain'], w.path)).stdout.trim() !== '';
        return { label: `${w.runId} · ${w.name}${missing ? ' · missing' : ''}${changes ? ' · has changes' : ''}`, description: w.graphName, detail: w.path, value: { ...w, missing, changes } };
      }),
    );
    const chosen = await d.ui.quickPick(items, 'Choose a run workspace');
    if (!chosen) return;
    const actions: PickItem<'open' | 'branch' | 'remove'>[] = chosen.missing
      ? [{ label: 'Remove', value: 'remove' }]
      : [
          { label: 'Open in New VS Code Window', value: 'open' },
          { label: 'Create Branch Here', value: 'branch' },
          { label: 'Remove', value: 'remove' },
        ];
    const action = await d.ui.quickPick(actions, `${chosen.runId} · ${chosen.name}`);
    if (!action) return;
    if (action === 'open') return d.ui.openInNewWindow(chosen.path);
    if (action === 'branch') {
      const branch = await d.ui.inputBox({
        prompt: 'Name of the new branch',
        value: `ab/${chosen.runId}-${chosen.name}`,
        validate: (v) => (v.trim() && !/\s/.test(v.trim()) ? undefined : 'Enter a branch name without spaces.'),
      });
      if (branch === undefined) return;
      const name = branch.trim();
      const r = await d.git(['switch', '-c', name], chosen.path);
      if (r.code !== 0) return d.ui.error(`Couldn't create the branch ${name}: ${r.stderr.trim() || r.stdout.trim()}`);
      return d.ui.info(`Created the branch ${name} in ${chosen.path}. Its uncommitted changes stay there.`);
    }
    if (chosen.running) return d.ui.error(`Run ${chosen.runId} is still running. Stop it first.`);
    if (chosen.changes && !(await d.ui.confirm(`Remove ${chosen.path}? Its uncommitted changes will be lost.`, 'Remove'))) return;
    // A workspace deleted by hand is forgotten with prune (spec §8).
    const removed = chosen.missing
      ? await pruneWorkspaces({ checkoutRoot: chosen.checkoutRoot, git: d.git })
      : await removeWorkspace({ checkoutRoot: chosen.checkoutRoot, path: chosen.path, force: chosen.changes, git: d.git });
    if (!removed.ok) return d.ui.error(`Couldn't remove ${chosen.path}: ${removed.error}`);
    const marked = app.markWorkspaceRemoved(chosen.runId, chosen.name);
    if (!marked.ok) return d.ui.error(marked.error);
    d.ui.info(`Removed ${chosen.path}.`);
  }

  return { setUpParallelTickets, newAbTestGraph, manageRunWorkspaces };
}
