import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { checkSetup, createWorktrees, inspectCheckout, MAX_TICKETS, planWorktrees, realWorktreeFs, writeStarterGraph, type GitExec, type WorktreeFs } from '@agent-stream/engine';
import type { GraphTarget, Ui } from './commands';
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

  return { setUpParallelTickets };
}
