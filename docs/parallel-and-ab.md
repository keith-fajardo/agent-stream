# Parallel tickets and A/B tests

Agents that can change files never work on separate tickets in the same checkout. Agent Stream follows this policy, and gives it to the planner word for word:

> Before starting or planning concurrent write-capable work, determine whether tasks are separate tickets. If they are, require one Git worktree per ticket. Never run write-capable agents for separate tickets in the same repository checkout. If worktrees cannot be verified or created, offer sequential execution only.

Within one graph, the same rule applies to alternatives: parallel write-capable steps need separate workspaces.

The engine enforces this; it doesn't rely on the planner alone:

- **Read-only steps.** Mark an agent step **Read-only** (Node panel › Access). It can only read files (Read, Glob, Grep): every other tool is refused without asking, and it can't change the graph. Command steps can always change files. Read-only steps show a `read-only` badge.
- **One writer per workspace.** Within a run, only one step that can change files runs at a time in each workspace (this checkout, or a variant workspace). Read-only steps, and steps in other workspaces, fill the other `agentStream.maxParallel` slots. The run dialog notes which steps will take turns.
- **One run per checkout.** A run whose steps change files in this checkout holds the checkout's write lease until it ends. This works across VS Code windows, through a lock file in `~/.agent-stream/locks/`. The checkout is the Git top-level folder (the folder itself outside Git), so a repository and its subfolder share one lease. A second such run is refused, and the dialog offers two ways on:
  - **Set Up Parallel Tickets** (Git checkouts only).
  - **Run after it finishes**: starts the run now, runs its read-only steps, and holds its other steps until the first run has ended.
- **Where it works.** The graph tab's top bar shows the branch (`⎇ main`, or `⎇ detached <sha>`), and `· worktree <folder>` in a linked worktree. Its tooltip shows the root, the HEAD commit and the other worktrees. Every run records where it ran (the run picker's tooltip), and the run dialog shows the Checkout line.

## Separate tickets: Set Up Parallel Tickets

Recommended workflow:

1. Commit your changes. Modified or staged tracked files block setup; untracked files stay in this checkout.
2. Run **Agent Stream: Set Up Parallel Tickets** (or the branch button in the Graphs view). Enter:
   - the base (the current branch by default);
   - one ticket per box (leave the last one empty to finish);
   - where the worktrees go (next to the repo by default);
   - the command for the full test suite and typecheck (prefilled from `package.json`).
3. Agent Stream checks everything first, and creates nothing if anything is wrong. Then, for each ticket and all from the same base commit, it creates:
   - a worktree at `<parent>/<repo>-<ticket-slug>`;
   - a new branch `feat/<ticket-slug>`;
   - a starter graph: **Read and research** (read-only) → **Implementation** → **Focused tests** → **Full test + typecheck**, with **Review** (read-only).

   It never overwrites a branch or a folder.
4. Open each worktree in its own VS Code window (the summary's **Open in New VS Code Window…** button) and run its graph there. Each worktree has its own graphs, runs, sessions and variable values; only the check command is seeded.
5. Land one ticket at a time. Even in separate worktrees, changes to `shared/` code, database migrations, package manifests and lockfiles, and contracts between workspaces should normally be serialized: land one ticket, then rebase the others onto it, instead of changing those files in several tickets at once.

The planner follows the same rules. It calls `check_tickets` before planning work for several tickets, and suggests Set Up Parallel Tickets when a ticket has no worktree.

## A/B tests in one graph: variant workspaces

- **Variant workspaces.** A step's **Workspace** (Node panel) puts it in a variant workspace. Steps with the same workspace name share one temporary, detached Git worktree per run. The runner creates it from the run's start commit, in `~/.agent-stream/worktrees/`. Steps in different workspaces run in parallel; a read-only compare step then reads every variant's results. Steps with a workspace show a `⎇ <name>` badge, one colour per workspace.
- **Uncommitted changes aren't copied.** Variant worktrees start from the last commit, and the run dialog says so when this checkout has changes.
- **No reuse.** A step with a workspace always runs again when it executes in a re-run or retry, in that run's own worktree. **Run only** on another step reuses it as it would any other step.
- **New A/B Test Graph.** **Agent Stream: New A/B Test Graph** asks for a name and 2–6 variant names (for example `wh_small`, `wh_large`). It creates:
  - a read-only plan step;
  - for each variant, a **Set up** and a **Run** step in that variant's workspace;
  - a read-only **Compare and recommend** step.
- **Manage Run Workspaces.** Variant worktrees are kept after the run, whether it succeeded, failed or was stopped. **Agent Stream: Manage Run Workspaces** lists them (`· missing`, `· has changes`) and offers:
  - **Open in New VS Code Window**;
  - **Create Branch Here** (`ab/<run id>-<name>`, keeping its changes);
  - **Remove**, which asks first when there are uncommitted changes.

  Nothing is removed any other way.

Recommended workflow:

1. Run **New A/B Test Graph** and name the variants.
2. In **Variables**, set:
   - `setup_command`, for example `dbt deps`;
   - one `run_<variant>` per variant, for example `dbt build --target wh_small`. A `-` in a variant name becomes `_`.
3. Run the graph. The variants run side by side, each in its own worktree.
4. Read the compare step's recommendation.
5. Keep the winner with **Manage Run Workspaces › Create Branch Here**, and remove the rest.

## dbt and other shared resources

- Worktrees separate files only. Give every variant its own external resources: for dbt, a separate target and schema per variant, so variants never build the same tables. Measure fairly:
  - turn off result caches (for Snowflake, `ALTER SESSION SET USE_CACHED_RESULT = FALSE` via a pre-hook or session parameter);
  - start each variant's warehouse suspended, so local caches are cold;
  - tag each variant's queries (`query_tag`), and read cost and runtime from the warehouse's query and metering history;
  - repeat short runs, because minimum billing per resume skews them.

  Compare runtime, cost and failures per variant, and say how confident the result is.
- A new worktree has no untracked files: no `.venv`, `dbt_packages`, `target` or `node_modules`, and no uncommitted `profiles.yml`. Make `setup_command` prepare them (for example `dbt deps`). Profiles in `~/.dbt/` are shared by every worktree.
- The compare step is read-only, so it can't query the warehouse itself. To read the warehouse's history, add a command step, or mark the compare step **Can edit files** so each command asks for your approval.

## Limitations

- Agent Stream doesn't isolate databases, warehouses, schemas, cloud resources or ports. The guidance above covers them; the engine can't check it.
- It doesn't detect tickets from free text. The planner's `check_tickets` and your choice decide what a ticket is.
- Command steps always count as changing files. There is no file-level locking.
- Agent Stream never removes, merges or prunes ticket worktrees or branches. Use `git worktree remove` and `git branch -d` when a ticket is done. Variant workspaces are removed only through Manage Run Workspaces.
- The lease only coordinates Agent Stream runs; it doesn't stop your own edits or other tools.
  - A lock whose process has gone is reclaimed.
  - A lock file that can't be read blocks runs until you delete it, and the message names the file.
  - Process-id reuse isn't detected beyond the liveness check.
- Waiting runs in one window take the lease in the order they started. A run waiting on another window checks again every 3 seconds.
