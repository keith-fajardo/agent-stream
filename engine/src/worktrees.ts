import { existsSync } from 'node:fs';
import { basename, isAbsolute, join, relative } from 'node:path';
import { parseWorktreeList, realOrResolved, type GitExec, type GitResult } from './git';

export const MAX_TICKETS = 20;
export type WorktreeItem = { ticket: string; slug: string; branch: string; path: string };
export type WorktreePlan = { root: string; parent: string; items: WorktreeItem[] };
/** The filesystem probe checkSetup uses; tests pass a fake. */
export type WorktreeFs = { exists(p: string): boolean; realpath(p: string): string };
export const realWorktreeFs: WorktreeFs = { exists: (p) => existsSync(p), realpath: (p) => realOrResolved(p) };
export type SetupCheck = { problems: string[]; sha?: string; untracked: number };

/** Lowercase; runs of anything but a-z and 0-9 become `-`; trimmed; at most 40 characters with no trailing `-` (spec §5.1). */
export function ticketSlug(ticket: string): string {
  return ticket
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
}

export function ticketSlugs(tickets: string[]): { ok: true; slugs: string[] } | { ok: false; error: string } {
  const slugs = tickets.map(ticketSlug);
  const empty = slugs.indexOf('');
  return empty >= 0 ? { ok: false, error: `Ticket ${empty + 1} needs letters or numbers.` } : { ok: true, slugs };
}

/** One worktree per ticket: `<parent>/<repo folder>-<slug>` on `feat/<slug>` (spec §5.1). */
export function planWorktrees(o: { root: string; parent: string; tickets: string[] }): { ok: true; plan: WorktreePlan } | { ok: false; error: string } {
  const tickets = o.tickets.map((t) => t.trim());
  if (tickets.length < 2) return { ok: false, error: 'Add at least two tickets.' };
  if (tickets.length > MAX_TICKETS) return { ok: false, error: `Add at most ${MAX_TICKETS} tickets.` };
  const s = ticketSlugs(tickets);
  if (!s.ok) return s;
  for (let i = 0; i < s.slugs.length; i++) {
    const first = s.slugs.indexOf(s.slugs[i]);
    if (first < i) return { ok: false, error: `Tickets ${first + 1} and ${i + 1} would both use feat/${s.slugs[i]}.` };
  }
  const items = tickets.map((ticket, i) => ({ ticket, slug: s.slugs[i], branch: `feat/${s.slugs[i]}`, path: join(o.parent, `${basename(o.root)}-${s.slugs[i]}`) }));
  return { ok: true, plan: { root: o.root, parent: o.parent, items } };
}

const lines = (r: GitResult) => r.stdout.split(/\r?\n/).filter((l) => l.trim());
/** `child` is `parent` or inside it (both real paths). */
const inside = (child: string, parent: string) => {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

/** Every problem at once; creates nothing (spec §5.1). */
export async function checkSetup(plan: WorktreePlan, base: string, git: GitExec, fs: WorktreeFs = realWorktreeFs): Promise<SetupCheck> {
  const top = await git(['rev-parse', '--show-toplevel'], plan.root);
  if (top.code === -1) return { problems: ["Git isn't available."], untracked: 0 };
  if (top.code !== 0) return { problems: [`${plan.root} isn't a Git repository.`], untracked: 0 };
  const problems: string[] = [];
  let sha: string | undefined;
  if (!base.trim() || base.startsWith('-')) problems.push(`"${base}" isn't a valid base.`);
  else {
    const r = await git(['rev-parse', '--verify', '--quiet', '--end-of-options', `${base}^{commit}`], plan.root);
    if (r.code === 0 && r.stdout.trim()) sha = r.stdout.trim();
    else problems.push(`Can't find the base "${base}".`);
  }
  const changed = lines(await git(['status', '--porcelain', '--untracked-files=no'], plan.root)).length;
  if (changed > 0) {
    problems.push(`This checkout has uncommitted changes to tracked files (${changed}). Worktrees start from ${base} and won't include them. Commit them yourself, or run this from a clean checkout.`);
  }
  const untracked = lines(await git(['status', '--porcelain', '--untracked-files=normal'], plan.root)).filter((l) => l.startsWith('?? ')).length;
  if (!fs.exists(plan.parent)) problems.push(`The folder ${plan.parent} doesn't exist.`);
  else if (inside(fs.realpath(plan.parent), fs.realpath(plan.root))) problems.push(`${plan.parent} is inside this checkout. Choose a folder outside it.`);
  const registered = new Set(parseWorktreeList((await git(['worktree', 'list', '--porcelain'], plan.root)).stdout).map((w) => fs.realpath(w.path)));
  for (const item of plan.items) {
    if ((await git(['check-ref-format', '--branch', item.branch], plan.root)).code !== 0) problems.push(`${item.branch} isn't a valid branch name.`);
    else if ((await git(['show-ref', '--verify', '--quiet', `refs/heads/${item.branch}`], plan.root)).code === 0) problems.push(`The branch ${item.branch} already exists.`);
    if (fs.exists(item.path)) problems.push(`${item.path} already exists.`);
    else if (registered.has(fs.realpath(item.path))) problems.push(`${item.path} is already a registered worktree.`);
  }
  return { problems, ...(sha && { sha }), untracked };
}

export function worktreeAddArgs(item: WorktreeItem, sha: string): string[] {
  return ['worktree', 'add', '-b', item.branch, item.path, sha];
}

/** One `git worktree add` at a time, from the root, then `after(item)`; stops at the first failure and never deletes (spec §5.1). */
export async function createWorktrees(
  plan: WorktreePlan,
  sha: string,
  git: GitExec,
  after: (item: WorktreeItem) => void | Promise<void>,
): Promise<{ created: WorktreeItem[]; failed?: { item: WorktreeItem; error: string } }> {
  const created: WorktreeItem[] = [];
  for (const item of plan.items) {
    const r = await git(worktreeAddArgs(item, sha), plan.root);
    if (r.code !== 0) return { created, failed: { item, error: r.stderr.trim() || r.stdout.trim() || `git exited with code ${r.code}` } };
    created.push(item);
    try {
      await after(item);
    } catch (e) {
      return { created, failed: { item, error: e instanceof Error ? e.message : String(e) } };
    }
  }
  return { created };
}
