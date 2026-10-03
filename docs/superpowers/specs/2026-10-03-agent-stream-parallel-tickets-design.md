# Agent Stream — one writer per checkout, and parallel tickets in worktrees

**Date:** 2026-10-03
**Status:** Approved in conversation; written for the record
**Builds on:**
- the providers spec (`ToolGate`, step gates);
- the step descriptions spec;
- the agent changes spec (step graph tools, `Runner.amend`).

## 1. Purpose

Agents that can change files must never work on separate tickets in the same checkout. When a user wants several tickets done in parallel, each ticket gets its own Git worktree and branch from one common base commit. Read-only research may still run in parallel in one checkout.

**The policy.** This text is used verbatim in the planner's instructions and the README:

> Before starting or planning concurrent write-capable work, determine whether tasks are separate tickets. If they are, require one Git worktree per ticket. Never run write-capable agents for separate tickets in the same repository checkout. If worktrees cannot be verified or created, offer sequential execution only.

The policy is enforced by runtime checks in the engine, not only by prompting.

Success:
- A second run that can change files can't start in a checkout while another one is changing files there. The user is told why and offered **Set Up Parallel Tickets** or **Run after it finishes**.
- Within one run, two write-capable steps never run at the same time. Read-only steps still run alongside.
- **Agent Stream: Set Up Parallel Tickets** creates one worktree and branch per ticket from one base commit, with a starter graph in each, and never overwrites anything.
- Every graph tab shows the branch and worktree it works in. Every run records where it ran.

## 2. Decisions

| Topic | Decision |
|---|---|
| Write-capable | Command steps always. Agent steps unless marked read-only (`access: 'read'`) |
| Read-only agent steps | Enforced: the step's gate refuses every tool that isn't read-only, and the step gets no graph tools |
| Within a run | At most one write-capable step at a time; read-only steps fill the other `maxParallel` slots. This changes existing behaviour |
| Across runs | A run with write-capable steps holds the checkout's **write lease** until it ends. The checkout is the Git top-level folder, or the folder itself outside Git |
| Other VS Code windows | A lock file under `~/.agent-stream/locks/` carries the lease across windows. It is stale when its process is gone |
| Blocked launch | Refused with a `runBlocked` message offering Set Up Parallel Tickets (Git checkouts only) or Run after it finishes |
| Sequential fallback | The new run starts, but its write-capable steps wait until the lease holder's run has ended. Tickets never interleave edits |
| Worktree folder | `<parent>/<repo-folder-name>-<slug>`, default parent the repo's parent folder |
| Branch | `feat/<slug>` |
| Dirty checkout | Modified or staged tracked files block setup. Untracked files are mentioned only |
| Starter graph's check command | Asked once, prefilled from `package.json` scripts, saved as a variable value in each new worktree |
| Concurrency | The existing `agentStream.maxParallel` (default 3). The starter graph's widest layer is 2 steps |

## 3. Data

### 3.1 Step access

- **`GraphNode` gains `access?: 'read' | 'write'`.** A missing value means `write`.
- **`'read'` is valid on agent steps only.** On a command step, `parseGraph` and the edit operations refuse it with "Command steps can always change files; only agent steps can be read-only."
- **Edit operations:**
  - `addNode` and `updateNode` accept `access`.
  - Changing a step's kind to `command` drops `access`.
- **Export and import** carry `access`, and so does duplicate.
- **`contentSignature`** includes `access`, because it changes what a step may do.
- **Re-run reuse:** an agent step whose `access` changed is re-executed.
- **Helpers** in the new `shared/src/access.ts`:
  - `isWriteCapable(node)`: `node.kind === 'command' || node.access !== 'read'`.
  - `parallelWriteSteps(graph)`: every pair of write-capable steps with no path between them in either direction.

### 3.2 Checkout information

```ts
export type CheckoutInfo =
  | { git: false; root: string; reason: string }             // root = the folder's real path
  | { git: true; root: string; linkedWorktree: boolean;      // root = realpath(git top-level)
      branch?: string; head?: string;                         // branch absent when detached; head absent before the first commit
      worktrees: { path: string; branch?: string; head?: string; current: boolean }[] };
```

- **`RunMeta` gains `checkout?: { root: string; branch?: string; head?: string; linkedWorktree: boolean }`**, recorded when the run starts.
- **`RunMeta` gains `waitingFor?: { runId: string; graphId: string; folder: string }`** while its write-capable steps wait for the lease.

## 4. Engine

### 4.1 Git behind an abstraction (`engine/src/git.ts`)

```ts
export type GitResult = { code: number; stdout: string; stderr: string };
export type GitExec = (args: string[], cwd: string) => Promise<GitResult>;
export const realGit: GitExec; // execFile('git', args, { cwd, timeout: 15_000, windowsHide: true }); never throws; a missing git returns code -1 with stderr "git not found"
export function inspectCheckout(folder: string, git: GitExec): Promise<CheckoutInfo>;
```

**`inspectCheckout`** runs these git commands:
- `git rev-parse --show-toplevel`. When this fails, the result is `git: false`, with the reason "Not a Git repository" or "Git isn't available".
- `git rev-parse --absolute-git-dir` and `git rev-parse --git-common-dir`. The common dir is resolved against `cwd`. `linkedWorktree` is true when the two differ.
- `git symbolic-ref --quiet --short HEAD` for the branch.
- `git rev-parse --verify --quiet HEAD` for the head commit.
- `git worktree list --porcelain`, which `parseWorktreeList` parses.

Unit tests never run real git. They pass a fake `GitExec` that returns fixed output.

### 4.2 Write lease (`engine/src/writeLease.ts`)

```ts
export type LeaseHolder = { runId: string; graphId: string; folder: string; pid: number; startedAt: string };
export type LeaseResult = { ok: true } | { ok: false; holder: LeaseHolder; otherWindow: boolean };
export interface WriteLeases {
  acquire(checkoutRoot: string, holder: Omit<LeaseHolder, 'pid'>): LeaseResult;
  release(checkoutRoot: string, runId: string): void;
  holder(checkoutRoot: string): LeaseHolder | undefined;
  onRelease(listener: (checkoutRoot: string) => void): () => void;
}
export function createWriteLeases(o: { locksDir: string; pid?: number; isAlive?: (pid: number) => boolean; clock?: () => string }): WriteLeases;
```

- **One instance per extension host.** It is shared by every folder's engine and passed into `createApp`. That lets two workspace folders on the same checkout, such as a repo and its subfolder, share one lease.
- **The lock file** is `~/.agent-stream/locks/<sha256(checkoutRoot).hex.slice(0,16)>.json` with the content `{ version: 1, ...LeaseHolder, checkout }`. It is created exclusively (`wx`).
- **A stale lock is reclaimed.** A lock is stale when its `pid` isn't alive, or when it is this process's own pid but no active run of this process holds it. "Alive" means `process.kill(pid, 0)` didn't throw `ESRCH`.
- **An unreadable lock file** counts as held by an unknown process. Its run shows as `unknown`, and the message names the file so the user can delete it.
- **Release** deletes the file only when its `runId` matches. Engine disposal releases every lease the engine holds.

### 4.3 Runner

- **`StartRunInput` gains `sequential?: boolean`.** `RunnerDeps` gains `leases: WriteLeases` and `checkout: () => Promise<CheckoutInfo>`, or the checkout already inspected by `app`.
- **Does the run need the lease?** Only if a write-capable step will actually execute. Reused or skipped steps don't count.
- **Starting a run that needs the lease:**
  - **Acquired:** the run starts as today.
  - **Held, not sequential:** `start` returns `{ ok: false, blocked: { holder, otherWindow, checkout } }`, and nothing is created.
  - **Held, sequential:** the run starts with `waitingFor` set. Its read-only steps launch as usual, and its write-capable steps stay `queued`.
    - The runner retries `acquire` on `onRelease`, and every 3 s while the holder is in another window.
    - Once acquired, it clears `waitingFor` and pumps.
    - Waiting runs in one process acquire in the order they were started.
- **Within a run:** `pump` launches a write-capable step only when no other write-capable step of the run is running and the run holds the lease.
- **Lease release:** the lease is released when the run reaches any final status.
- **Amendments:** the step graph tools are only given to write-capable steps, so a run that is amended already holds the lease.

### 4.4 Read-only agent steps

- The step gate for a step with `access: 'read'` refuses every tool that isn't read-only, with this reason: `This step is read-only, so <tool> isn't allowed. Mark the step "Can edit files" if it needs to change something.` It never asks the user.
- The step gets no graph tools.
- `buildNodePrompt` adds `This step is read-only: investigate and report; don't change files or run commands.` under the step heading.

### 4.5 App

- **`startRun`:**
  - The message gains `sequential?: boolean`.
  - Before `runner.start`, the app inspects the checkout and records it in `RunMeta.checkout`.
  - A blocked start sends `{ type: 'runBlocked'; graphId; message; holder; otherWindow; checkout; canSetUpTickets }` to the client and is not an error.
  - `canSetUpTickets` is `checkout.git`.
  - `message` reads: `"<graph name>" can't start: run <runId> of "<holder graph name or id>" is already changing files in this checkout (<root>). Separate tickets need separate worktrees.` When the holder is in another window, `in another VS Code window` is added after the run id.
- **New client message `{ type: 'inspectCheckout' }`.** The app answers `{ type: 'checkout'; info: CheckoutInfo; lease?: LeaseHolder }`. It also sends `checkout` after `hello`, and again whenever a run starts or ends in this folder.

### 4.6 Planner

- **`PLANNER_APPEND` gains:**
  - the policy (§1);
  - "Mark agent steps that only read and report as read-only (access: read). Never plan write-capable steps for separate tickets in parallel in one checkout. Before planning work for several tickets, call check_tickets. When tickets lack their own worktrees, suggest the command Agent Stream: Set Up Parallel Tickets, or plan the tickets one after another."
  - the serialization guidance (§6).
- **Graph tools:** `add_node` and `update_node` accept `access`. `get_graph` shows `access: read` for read-only steps.
- **New read-only planner tools:**
  - `checkout_info()` returns the `CheckoutInfo` and the current lease holder as JSON.
  - `check_tickets({ tickets: string[] })` takes 1–20 tickets. For each ticket it returns `{ ticket, slug, branch: 'feat/<slug>', worktree?: string }`, where `worktree` is the registered worktree whose branch is `feat/<slug>`. It also returns `allHaveWorktrees` and an `advice` string. Outside Git it returns the advice "Worktrees can't be verified here; plan the tickets one after another."

### 4.7 Run preview

When `parallelWriteSteps` is non-empty, the preview adds one note per pair: `n2 and n3 can both change files; they will run one at a time.` A note is not a problem and doesn't block the run.

## 5. Set Up Parallel Tickets

### 5.1 Engine part (`engine/src/worktrees.ts`)

The engine part is pure functions, plus one executor that uses `GitExec` and an injected filesystem probe.

- **`ticketSlug(ticket)`:**
  - lowercase;
  - every run of `[^a-z0-9]` becomes `-`;
  - leading and trailing `-` trimmed;
  - at most 40 characters, and no trailing `-` after cutting.
  - An empty result is refused with "Ticket <n> needs letters or numbers."
- **`planWorktrees({ root, parent, tickets })`** gives each ticket its `{ ticket, slug, branch: 'feat/<slug>', path: join(parent, basename(root) + '-' + slug) }`.
  - It refuses fewer than 2 tickets: "Add at least two tickets."
  - It refuses more than 20.
  - It refuses duplicate slugs: "Tickets 1 and 3 would both use feat/abc-1."
- **`checkSetup(plan, base, git, fs)`** returns every problem at once and creates nothing. It checks:
  - Git is available.
  - The root is a Git checkout.
  - `base` doesn't start with `-`, and it resolves with `git rev-parse --verify --quiet --end-of-options <base>^{commit}`.
  - `git status --porcelain --untracked-files=no` is empty. Otherwise the problem reads: "This checkout has uncommitted changes to tracked files (<n>). Worktrees start from <base> and won't include them. Commit them yourself, or run this from a clean checkout."
  - The parent exists and is not inside the root (compared by real path).
  - For each ticket:
    - `git check-ref-format --branch feat/<slug>` passes;
    - `git show-ref --verify --quiet refs/heads/feat/<slug>` fails, meaning the branch doesn't exist yet;
    - the path doesn't exist;
    - the path isn't in `git worktree list`.
  - It also reports untracked files: `untracked: number`.
- **`worktreeAddArgs(item, sha)`** returns `['worktree', 'add', '-b', item.branch, item.path, sha]`.
- **`createWorktrees(plan, sha, git, after)`:**
  - It runs `git worktree add` one ticket at a time, from the root.
  - It calls `after(item)` for each ticket, which writes the starter graph and seeds the value.
  - It stops at the first failure and returns `{ created: Item[], failed?: { item, error } }`. It never deletes anything.

### 5.2 Starter graph (`engine/src/ticketGraph.ts`)

**`starterGraph(ticket)`** returns an export file. It is written with `GraphStore.importGraph` after `ensureDataDirs(projectPaths(worktreePath))`. The graph has:
- `name`: the ticket;
- `goal`: `Complete ticket: <ticket>`;
- `instructions`: the policy, a "this worktree is the only checkout this ticket's agents change" line, and the serialization guidance (§6);
- `variables`: `[{ name: 'check_command', description: 'Full test suite and typecheck, e.g. npm test && npm run typecheck' }]`.

| id | Title | Kind | Access | After |
|---|---|---|---|---|
| n1 | Read and research | agent | read | — |
| n2 | Implementation | agent | write | n1 |
| n3 | Focused tests | agent | write | n2 |
| n4 | Full test + typecheck | command `{{ check_command }}` | (write) | n3 |
| n5 | Review | agent | read | n3 |

- Every step has a one-sentence description and a prompt.
- n3 runs the tests closest to the change and fixes failures in the ticket's own code.
- n5 reviews the diff against the base and reports. It doesn't edit.
- The widest layer is {n4, n5}. It holds one write-capable step and one read-only step.
- Positions are laid out left to right.

**Seeding the value.** When the wizard got a check command, it is written with `VariableValues(valuesFileFor(worktreePath)).set(graphId, 'check_command', value)`. Nothing else is copied: no runs, sessions or other values.

### 5.3 Extension command

- **Manifest:** the command is `agentStream.setUpParallelTickets`, titled "Set Up Parallel Tickets" in the category "Agent Stream". It also has a Graphs view title button, `$(git-branch)`, as `navigation@3`.
- **The wizard** lives in `extension/src/parallelTickets.ts`. It is VS Code-free and works through `Ui` and `GitExec`.
  1. **Folder:** the existing `folderFor`.
  2. **Inspect:** inspect the checkout. Outside Git it shows the error "Set Up Parallel Tickets needs a Git repository. <reason>" and stops.
  3. **Base:** an input box, filled in with the current branch, or with the HEAD SHA when detached.
  4. **Tickets:** input boxes "Ticket 1", "Ticket 2", "Ticket 3 (leave empty to finish)", and so on. Escape cancels.
  5. **Parent:** a quick pick with "Next to the repo (<parent>)" or "Choose folder…".
  6. **Check command:** an input box, prefilled with `npm test && npm run typecheck` when the root `package.json` has both scripts, with `npm test` when it has only `test`, and empty otherwise. Empty means not seeded.
  7. **Checks:** `checkSetup`. Any problem shows one error listing all of them, and the wizard stops.
  8. **Confirm:** a modal dialog: "Create N worktrees from <base> (<sha7>)?" with one line per ticket (`<path>  ·  feat/<slug>`), plus "<n> untracked files stay in this checkout." when there are any.
  9. **Create:** `createWorktrees`, with progress.
     - On a partial failure: "Created k of N worktrees; stopped at <ticket>: <error>. Nothing was removed." The created ones are still offered.
  10. **Summary:** an information message, "Set up N ticket worktrees from <sha7>.", with an **Open in New VS Code Window…** button.
      - The button opens a multi-select quick pick, with the ticket as label, the branch as description and the path as detail.
      - Each selected worktree opens with `vscode.openFolder(uri, { forceNewWindow: true })`.
- **New `Ui` methods:** `quickPick` (single and multi), `pickParentFolder` and `openInNewWindow`. They are added to `vscodeUi` and to the test fake.
- **From the graph tab:** the host message `{ type: 'setUpParallelTickets' }` runs the command for that tab's folder.

## 6. Serialization guidance

This text is shared by the planner instructions, the starter graph and the README:

> Even in separate worktrees, changes to `shared/` code, database migrations, package manifests and lockfiles, and contracts between workspaces should normally be serialized: land one ticket, then rebase the others onto it, instead of changing those files in several tickets at once.

## 7. UI

- **Where the graph works** (graph tab top bar): a chip shows `⎇ <branch>` (`⎇ detached <sha7>` when detached).
  - In a linked worktree it adds `· worktree <folder name>`.
  - Outside Git it shows `Not a Git repository`.
  - Its tooltip shows the root, the HEAD commit and the other worktrees.
  - It refreshes on the `checkout` message, which arrives after hello, on run start and end, and whenever the tab becomes visible (the tab sends `inspectCheckout`).
- **Run picker:** each run's tooltip gains `Ran in <root> on <branch> at <sha7>` from `RunMeta.checkout`.
- **Run dialog:**
  - It shows the Checkout line.
  - On `runBlocked` it shows the message and the buttons **Set Up Parallel Tickets** (only when `canSetUpTickets`), **Run after it finishes** and **Cancel**.
  - **Run after it finishes** re-sends `startRun` with `sequential: true` and the same reviewed signature.
- **Waiting runs:** while `waitingFor` is set, the logs header and the run picker show `Waiting for run <id> ("<graph>") to finish changing files`.
- **Node panel:** agent steps get an **Access** select, "Can edit files" or "Read-only", placed after Kind. It is part of the draft. Command steps show "Command steps can change files" as static text.
- **Canvas card:** read-only steps show a `read-only` badge.

## 8. Error handling

| Situation | Behaviour |
|---|---|
| Git missing | The checkout chip says "Git isn't available"; leases are keyed by the folder's real path; runBlocked offers sequential only; Set Up refuses |
| Lock file unreadable | Treated as held; the message names the file |
| Lock holder's process gone | The lock is stale and reclaimed |
| Run cancelled while waiting for the lease | It stops waiting; nothing is acquired |
| Engine disposed with leases held | They are released |
| Partial worktree creation | It stops, reports, and keeps what was created |
| Setup checks fail | One error lists every problem; nothing is created |

## 9. Testing

No unit test runs real git or creates real worktrees. Tests use a fake `GitExec`, temp folders, and a fake `isAlive`.

- **Shared:**
  - `access` in `parseGraph` (command steps refused), in the edit operations and in export/import;
  - `isWriteCapable`;
  - `parallelWriteSteps`;
  - `contentSignature` changes with `access`.
- **Engine:**
  - `inspectCheckout`: a main checkout, a linked worktree, detached HEAD, no commits, not a repo, git missing; `parseWorktreeList`.
  - Leases:
    - acquire and release;
    - held by another run of this process;
    - held by a live other pid;
    - stale pid reclaimed;
    - unreadable file;
    - release only by the owner;
    - `onRelease`.
  - Runner:
    - a second write-capable run is blocked and nothing is created;
    - a read-only-only run starts alongside a write-capable run;
    - in a sequential run, read-only steps run and write-capable steps wait until the first run ends;
    - within a run, write-capable steps never overlap while read-only ones do;
    - the lease is released on success, failure and cancel;
    - a cancelled waiting run never acquires.
  - Read-only gate:
    - a tool that isn't read-only is refused without asking;
    - no graph tools;
    - the prompt line.
  - Worktrees:
    - `ticketSlug`, `planWorktrees` (names, duplicates, counts);
    - every `checkSetup` refusal;
    - `worktreeAddArgs`;
    - `createWorktrees` stops on failure and never deletes.
  - Starter graph:
    - it is valid;
    - its edges are exactly as in §5.2;
    - no layer has two write-capable steps;
    - its instructions contain the policy and §6.
  - Planner:
    - the `PLANNER_APPEND` policy;
    - `access` in the tools;
    - `checkout_info`;
    - `check_tickets`, with and without worktrees, and outside Git.
  - App:
    - `runBlocked` message and `canSetUpTickets`;
    - `sequential` start;
    - the `checkout` message;
    - `RunMeta.checkout` recorded.
  - Isolation: two worktree paths get different values files and different lease keys, and no file is copied.
- **Web:**
  - the checkout chip, including linked worktree, detached and not Git;
  - the run dialog's Checkout line and `runBlocked` buttons;
  - Run after it finishes sends `sequential`;
  - the Access select in the draft;
  - the read-only badge;
  - the waiting text.
- **Extension:**
  - the wizard with a fake `Ui` and fake `GitExec`:
    - the success path builds the exact git commands and writes graphs into temp folders;
    - every refusal creates nothing;
    - cancelling at each prompt;
    - the partial-failure message;
    - Open in New Window;
  - the manifest has the command;
  - the graph-tab host message runs it.
- **Integration (CI):** the sample workspace's graph tab gets a `checkout` message. No worktrees are created.

## 10. Out of scope

- Removing or merging worktrees, and pruning branches.
- A per-graph concurrency setting.
- Protecting against process-id reuse, beyond the liveness check.
- File-level locking for command steps. A command step is always treated as write-capable.
- Detecting tickets from free text at run time. The planner's `check_tickets` and the user's choice decide what a ticket is.
