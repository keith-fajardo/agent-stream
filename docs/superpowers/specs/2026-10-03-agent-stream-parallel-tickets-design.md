# Agent Stream — one writer per workspace: parallel tickets and A/B variants in worktrees

**Date:** 2026-10-03
**Status:** Approved in conversation; written for the record. Amended the same day for variant workspaces (A/B tests inside one graph).
**Builds on:**
- the providers spec (`ToolGate`, step gates);
- the step descriptions spec;
- the agent changes spec (step graph tools, `Runner.amend`).

## 1. Purpose

Agents that can change files must never work on separate tickets in the same checkout. When a user wants several tickets done in parallel, each ticket gets its own Git worktree and branch from one common base commit. Read-only research may still run in parallel in one checkout.

**The policy.** This text is used verbatim in the planner's instructions and the README:

> Before starting or planning concurrent write-capable work, determine whether tasks are separate tickets. If they are, require one Git worktree per ticket. Never run write-capable agents for separate tickets in the same repository checkout. If worktrees cannot be verified or created, offer sequential execution only.

Within one graph, the same rule applies to alternatives: parallel write-capable steps need separate workspaces. This sentence follows the policy in the planner's instructions and the README.

The policy is enforced by runtime checks in the engine, not only by prompting.

**Two ways of working in parallel:**
- **Separate tickets, separate graphs.** Each ticket's graph lives in its own worktree and VS Code window. Tickets never touch each other's files, runs, sessions or values.
- **A/B variants inside one graph.** A graph can try alternatives at the same time. For example, it can build the same dbt project against different warehouses to compare cost and runtime. Each variant's steps run in their own **variant workspace**, a temporary detached worktree the runner creates from the run's start commit. A read-only compare step then reads every variant's results.

Success:
- A second run that can change files can't start in a checkout while another one is changing files there. The user is told why and offered **Set Up Parallel Tickets** or **Run after it finishes**.
- Within one run, two write-capable steps never run at the same time in the same workspace. Read-only steps still run alongside, and steps in different variant workspaces run in parallel.
- **Agent Stream: New A/B Test Graph** creates a graph with one variant workspace per variant and a read-only compare step. The graph's guidance covers isolating external resources and measuring fairly.
- **Agent Stream: Set Up Parallel Tickets** creates one worktree and branch per ticket from one base commit, with a starter graph in each, and never overwrites anything.
- Every graph tab shows the branch and worktree it works in. Every run records where it ran.

## 2. Decisions

| Topic | Decision |
|---|---|
| Write-capable | Command steps always. Agent steps unless marked read-only (`access: 'read'`) |
| Read-only agent steps | Enforced: the step's gate refuses every tool that isn't read-only, and the step gets no graph tools |
| Within a run | At most one write-capable step at a time **per workspace**; read-only steps and other workspaces fill the other `maxParallel` slots. This changes existing behaviour for steps in the checkout |
| Variant workspaces | A step's optional `workspace: '<name>'`. Steps with the same name share one detached worktree per run, created by the runner from the run's start commit |
| Where variant worktrees live | `~/.agent-stream/worktrees/<checkout hash>/<run id>/<name>`, outside the project |
| Variant worktree lifetime | Kept after the run for inspection. **Agent Stream: Manage Run Workspaces** opens, branches or removes them; nothing is removed automatically |
| Variant steps and reuse | A step with a workspace is never reused by a re-run. Its files live in that run's worktree |
| A/B template | **Agent Stream: New A/B Test Graph**: a read-only plan step, a setup and a run step per variant, and a read-only compare step |
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
  - `parallelWriteSteps(graph)`: every pair of write-capable steps **in the same workspace** (a missing `workspace` is the checkout) with no path between them in either direction.
  - `workspaceOf(node)`: `node.workspace ?? null`.

### 3.1a Step workspace

- **`GraphNode` gains `workspace?: string`.**
  - The name matches `/^[a-z][a-z0-9_-]{0,39}$/`. Otherwise it is refused with "Workspace names use lowercase letters, digits, - and _, starting with a letter."
  - A missing value means the folder's own checkout.
  - It is allowed on agent and command steps, and on read-only steps (which then read that variant's files).
- **Edit operations:** `addNode` and `updateNode` accept `workspace`. An empty string clears it.
- **Export, import, duplicate and `contentSignature`** carry and include `workspace`.

### 3.2 Checkout information

```ts
export type CheckoutInfo =
  | { git: false; root: string; reason: string }             // root = the folder's real path
  | { git: true; root: string; linkedWorktree: boolean;      // root = realpath(git top-level)
      branch?: string; head?: string;                         // branch absent when detached; head absent before the first commit
      dirty: boolean;                                         // tracked files modified or staged
      worktrees: { path: string; branch?: string; head?: string; current: boolean }[] };
```

- **`RunMeta` gains `workspaces?: Record<string, { path: string; head: string; removed?: boolean }>`**, one entry per variant workspace the run created.

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
- `git status --porcelain --untracked-files=no` for `dirty`.
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
- **Does the run need the lease?** Only if a write-capable step **in the checkout** (no `workspace`) will actually execute. Reused or skipped steps don't count. Variant workspaces belong to one run, so they need no lease.
- **Starting a run that needs the lease:**
  - **Acquired:** the run starts as today.
  - **Held, not sequential:** `start` returns `{ ok: false, blocked: { holder, otherWindow, checkout } }`, and nothing is created.
  - **Held, sequential:** the run starts with `waitingFor` set. Its read-only steps launch as usual, and its write-capable steps stay `queued`.
    - The runner retries `acquire` on `onRelease`, and every 3 s while the holder is in another window.
    - Once acquired, it clears `waitingFor` and pumps.
    - Waiting runs in one process acquire in the order they were started.
- **Within a run:** `pump` launches a write-capable step only when no other write-capable step of the run is running **in the same workspace**. For the checkout, the run must also hold the lease.
- **Lease release:** the lease is released when the run reaches any final status.
- **Amendments:** the step graph tools are only given to write-capable steps, so a run that is amended already holds the lease.

### 4.3a Variant workspaces (`engine/src/variantWorkspaces.ts`)

```ts
export function variantPath(home: string, checkoutRoot: string, runId: string, name: string): string;
  // join(home, '.agent-stream', 'worktrees', sha256(checkoutRoot).hex.slice(0,16), runId, name)
export function createVariantWorkspaces(o: { checkoutRoot: string; runId: string; names: string[]; head: string; git: GitExec; home: string }):
  Promise<{ ok: true; workspaces: Record<string, { path: string; head: string }> } | { ok: false; error: string }>;
export function removeWorkspace(o: { checkoutRoot: string; path: string; force: boolean; git: GitExec }): Promise<{ ok: true } | { ok: false; error: string }>;
```

- **When a run starts** with steps that use workspaces and will execute:
  - **The checkout must be in Git, with a HEAD commit.** Otherwise the start is refused: `Step <id> uses workspace "<name>", which needs a Git repository with at least one commit.`
  - **The app creates the worktrees before `runner.start`,** one per distinct name. Each is created with `git worktree add --detach <path> <head>`, run from the checkout root, and its path recorded in `RunMeta.workspaces`.
  - **If a creation fails,** the worktrees this attempt already created are removed with `git worktree remove --force <path>`. They hold nothing yet. The start is then refused with `Couldn't create workspace "<name>": <git error>`.
  - **Uncommitted changes aren't copied.** When the checkout is dirty, the run preview notes: `Workspaces start from <sha7>; uncommitted changes in this checkout aren't included.`
- **Steps with a workspace run there.** Agents get the variant path as their working directory, and commands run with it as their current directory.
  - `buildNodePrompt` adds: `You are working in workspace "<name>" at <path>: a separate Git worktree of this repository at <sha7>. Change files only there.`
  - Later steps' headings for earlier results add `, workspace <name>`. For example: `## n3 · Run wh_small (command \`dbt build\`, exit 0, 312.4 s, workspace wh_small)`.
- **Reuse:** a re-run never reuses a step that has a workspace. It executes again in the new run's own workspaces.
- **After the run:** the worktrees are kept. Stopping, failing and succeeding all leave them in place.
- **Isolation of external resources.** Worktrees separate files only. Databases, warehouses, schemas, cloud resources and ports are shared, so a variant that writes to them must use its own. The A/B template's guidance (§5.4) and the planner's instructions say so.

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
  - "To compare alternatives at the same time within one graph (A/B tests), put each variant's steps in their own workspace (workspace: <name>) and end with a read-only compare step. Worktrees separate files only: every variant that writes to a database, warehouse, schema or other shared resource must use its own (for dbt, a separate target and schema per variant)."
- **Graph tools:** `add_node` and `update_node` accept `access` and `workspace`. `get_graph` shows `access: read` for read-only steps and `workspace: <name>` when one is set.
- **New read-only planner tools:**
  - `checkout_info()` returns the `CheckoutInfo` and the current lease holder as JSON.
  - `check_tickets({ tickets: string[] })` takes 1–20 tickets. For each ticket it returns `{ ticket, slug, branch: 'feat/<slug>', worktree?: string }`, where `worktree` is the registered worktree whose branch is `feat/<slug>`. It also returns `allHaveWorktrees` and an `advice` string. Outside Git it returns the advice "Worktrees can't be verified here; plan the tickets one after another."

### 4.7 Run preview

- **Parallel writers.** When `parallelWriteSteps` is non-empty, the preview adds one note per pair: `n2 and n3 can both change files in the same workspace; they will run one at a time.`
- **Dirty checkout.** When steps use workspaces and the checkout is dirty, it adds the uncommitted-changes note from §4.3a.

A note is not a problem and doesn't block the run.

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

### 5.4 A/B test template (`engine/src/abTestGraph.ts`)

- **The command** is `agentStream.newAbTestGraph`, titled "New A/B Test Graph".
- **The wizard** (in `extension/src/parallelTickets.ts`, through `Ui`) asks for:
  - a name, such as "Warehouse cost test";
  - 2–6 variant names, one input box each, validated as workspace names, for example `wh_small`, `wh_large`.
- **`abTestGraph(name, variants)`** returns an export file, written with the folder's engine `importGraph`. It contains:

| id | Title | Kind | Access | Workspace | After |
|---|---|---|---|---|---|
| n1 | Plan the comparison | agent | read | — | — |
| per variant `v`: setup | Set up `<v>` | command `{{ setup_command }}` | (write) | `v` | n1 |
| per variant `v`: run | Run `<v>` | command `{{ run_<v> }}` | (write) | `v` | setup `<v>` |
| last | Compare and recommend | agent | read | — | every run step |

- **Variables:**
  - `setup_command`, described as "Prepares a fresh worktree, e.g. dbt deps (new worktrees have no untracked files such as .venv, dbt_packages or node_modules)";
  - one `run_<v>` per variant, described as "The command for variant <v>, e.g. dbt build --target <v>".
  - Values aren't seeded.
- **`instructions`** carries the measurement guidance, which the compare step's prompt repeats. It reads:

> Worktrees separate files only. Give every variant its own external resources: for dbt, a separate target and schema per variant, so variants never build the same tables. Measure fairly: turn off result caches (for Snowflake, `ALTER SESSION SET USE_CACHED_RESULT = FALSE` via a pre-hook or session parameter); start each variant's warehouse suspended so local caches are cold; tag each variant's queries (`query_tag`) and read cost and runtime from the warehouse's query and metering history; repeat short runs, because minimum billing per resume skews them. Compare runtime, cost and failures per variant, and say how confident the result is.

- **The compare step** reads every run step's output and duration from its context. It may query the warehouse's history read-only through commands only if the user approves. Its prompt says to recommend one variant and explain why.
- **Positions** fan out: the plan step on the left, one row per variant, and compare on the right.

### 5.5 Manage Run Workspaces

- **The command** is `agentStream.manageRunWorkspaces`, titled "Manage Run Workspaces". It works on the folder from `folderFor`.
- **It lists** every variant workspace recorded in that folder's runs, newest run first. Each quick pick item shows `<run id> · <name>`, the graph name, and the path.
  - It also adds `· missing` when the path no longer exists, and `· has changes` when `git status --porcelain` in it isn't empty.
- **Actions on the chosen item:**
  - **Open in New VS Code Window.**
  - **Create Branch Here:** asks for a name, default `ab/<run id>-<name>`, then runs `git switch -c <branch>` in the workspace. Uncommitted changes stay in it.
  - **Remove:** runs `git worktree remove <path>`. When the workspace has changes, a modal dialog asks first ("Remove <path>? Its uncommitted changes will be lost."), and the removal then uses `--force`.
  - The engine marks the entry `removed` in `RunMeta.workspaces`.
- Nothing is ever removed without this command.

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
- **Node panel:**
  - Agent steps get an **Access** select, "Can edit files" or "Read-only", placed after Kind. It is part of the draft.
  - Command steps show "Command steps can change files" as static text.
  - Every step gets a **Workspace** field after Access. It is a text input with the placeholder "This checkout", and the existing workspace names in the graph are offered as suggestions. It is part of the draft.
- **Canvas card:**
  - read-only steps show a `read-only` badge;
  - steps with a workspace show a `⎇ <name>` badge;
  - steps that share a workspace share one badge colour, picked from the theme's chart colours by a hash of the name.
- **Logs header:** for a step that ran in a variant workspace, it shows `workspace <name> · <path>` from `RunMeta.workspaces`.

## 8. Error handling

| Situation | Behaviour |
|---|---|
| Git missing | The checkout chip says "Git isn't available"; leases are keyed by the folder's real path; runBlocked offers sequential only; Set Up refuses |
| Lock file unreadable | Treated as held; the message names the file |
| Lock holder's process gone | The lock is stale and reclaimed |
| Run cancelled while waiting for the lease | It stops waiting; nothing is acquired |
| Engine disposed with leases held | They are released |
| Partial worktree creation | It stops, reports, and keeps what was created |
| A step uses a workspace outside Git, or before the first commit | The run is refused, naming the step and workspace |
| A variant worktree can't be created | This attempt's new worktrees are removed (they're empty); the run is refused with git's error |
| A recorded variant workspace was deleted by hand | Manage Run Workspaces shows it as missing; Remove runs `git worktree prune` instead |
| Setup checks fail | One error lists every problem; nothing is created |

## 9. Testing

No unit test runs real git or creates real worktrees. Tests use a fake `GitExec`, temp folders, and a fake `isAlive`.

- **Shared:**
  - `access` in `parseGraph` (command steps refused), in the edit operations and in export/import;
  - `isWriteCapable`;
  - `parallelWriteSteps`, per workspace;
  - `workspace` in `parseGraph` (name rule), in the edit operations and in export/import;
  - `contentSignature` changes with `access` and with `workspace`.
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
    - within a run, write-capable steps in the same workspace never overlap, while read-only ones and steps in different variant workspaces do;
    - steps with a workspace run with the variant path as their working directory;
    - a run whose only write-capable steps are in variant workspaces needs no lease;
    - a re-run never reuses a step that has a workspace;
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
  - Variant workspaces:
    - `variantPath`;
    - the exact `git worktree add --detach` arguments;
    - the refusals outside Git and before the first commit;
    - a creation failure removes only this attempt's worktrees;
    - `removeWorkspace` with and without `--force`;
    - the prompt line and the heading suffix.
  - A/B template:
    - it is valid for 2 and 6 variants;
    - each variant's steps share its workspace;
    - compare depends on every run step;
    - plan and compare are read-only;
    - the instructions contain the measurement guidance.
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
  - the waiting text;
  - the Workspace field in the draft;
  - the workspace badge and its shared colour;
  - the logs header's workspace line.
- **Extension:**
  - the wizard with a fake `Ui` and fake `GitExec`:
    - the success path builds the exact git commands and writes graphs into temp folders;
    - every refusal creates nothing;
    - cancelling at each prompt;
    - the partial-failure message;
    - Open in New Window;
  - the manifest has the commands;
  - the graph-tab host message runs it;
  - the New A/B Test Graph wizard: variant-name validation, 2–6 variants, the graph written;
  - Manage Run Workspaces:
    - the listing, with its missing and has-changes markers;
    - the exact git commands for Create Branch and Remove;
    - Remove asks first when there are changes, and runs `git worktree prune` when the workspace is missing.
- **Integration (CI):** the sample workspace's graph tab gets a `checkout` message. No worktrees are created.

## 10. Out of scope

- Removing ticket worktrees, merging tickets or variants, and pruning branches. Removal is covered only for variant workspaces, through Manage Run Workspaces.
- Automatic cleanup of variant workspaces.
- Enforcing isolation of external resources such as databases or warehouses. The guidance covers it; the engine can't verify it.
- Collecting warehouse cost automatically. The compare step reads it with the user's approval.
- A per-graph concurrency setting.
- Protecting against process-id reuse, beyond the liveness check.
- File-level locking for command steps. A command step is always treated as write-capable.
- Detecting tickets from free text at run time. The planner's `check_tickets` and the user's choice decide what a ticket is.
