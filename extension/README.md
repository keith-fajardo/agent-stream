# Agent Stream

Agent Stream is an independent project. It is not made, endorsed or supported by Anthropic or GitHub.

A VS Code extension where you and an AI planner co-create a workflow as a graph, then run it step by step on your own AI subscription. Agent Stream is **provider-agnostic**: agent steps and the planner run on the provider you choose. Today that is **Claude** (your Claude subscription through Claude Code), with **GitHub Copilot** available as a preview. Every file edit, shell command or other non-read-only action an agent step attempts waits for your approval, whichever provider runs it, and every step keeps its own logs.

## Requirements

- VS Code **1.106** or newer, on macOS or Windows. Linux works the same way as macOS.
- One provider:
  - **Claude:** Claude Code installed and signed in with your Claude account (run `claude`, then `/login`). Check with `claude auth status`.
  - **GitHub Copilot (preview):** the GitHub Copilot extension installed and signed in. Agent Stream detects your Copilot models. Running steps with Copilot comes in a later version.
- Windows only: Git for Windows, which provides Git Bash for command steps.

## Install

Install Agent Stream from the VS Code Marketplace, or from an `agent-stream-<version>.vsix` file: in VS Code run **Extensions: Install from VSIX…** and pick the file.

## Use

- **Agent Stream sidebar:**
  - **Graphs:** New, Import, and right-click for Open, Rename, Duplicate, Export, Delete.
  - **Sessions:** New Session, click to switch, right-click for Rename, Duplicate, Delete.
  - **Approvals:** Approve, Deny, Approve all.
- **Chat view:** the **Agent Stream Chat** view on the right, next to VS Code's own Chat. It shows the planner conversation for the graph tab you're on, in the current session. Describe a goal; the planner reads your repo (read-only) and draws the plan. **New chat** starts over; the session button switches session.
- **Model and effort:** the chat header's **Model** menu picks the model for this conversation (**Default**, or one the provider lists), and **Effort** its effort level when that model offers levels (for **Default**: the levels of the model in the settings, else of Claude Code's default model). A saved effort always shows, so it can be cleared. The choice is kept with the conversation in the session (New chat keeps it) and applies from the next message. **Default** uses the `agentStream.model` / `agentStream.effort` settings, or Claude Code's own default when they are empty. Runs use those settings, read once when the run starts: the run dialog and the run's tooltip show `Model: … · Effort: …`. Set them with **Agent Stream: Select Model**; the provider's status bar tooltip shows them. A model or effort is never written into a graph or an export. An effort level the chosen model doesn't offer is left out.
- **Graph tab:** the canvas, the logs of the selected step underneath, and Node · Graph on the right (plus a Changes tab while agent changes wait for review). The menu bar has File, Edit, Run, Variables and View, with View › Chat opening the chat view.
- **Work sessions:**
  - A session is a named set of open graph tabs plus its own planner conversations.
  - Switching a session closes the current graph tabs and brings back the other session's tabs, splits and chats.
  - Sessions are personal: they stay in `.agent-stream/sessions/`, which git ignores.
- **Status bar:** the provider your steps run on (for example `Claude Max` or `Copilot (preview)`) and the current session (`Default`). Click either one to change it.
- **Agent steps** run a separate AI agent with the step's prompt, the goal, the instructions and the outputs of earlier steps. **Command steps** run an exact shell command in the project folder: your login shell on macOS, Git Bash on Windows.
- **Step descriptions:** each step has a plain-language description for people. It shows on the canvas card, and agents get it as context: a step sees its own description as "In short", and later steps see earlier steps' descriptions next to their results. The planner writes one for every step it adds or changes, and you can write or edit it in the Node panel.
- **Refine with planner:** write a step in plain words, then press **Refine with planner** (Node panel, or **Edit › Refine selected step** / **Refine steps you changed**). The planner reads your repository and writes the precise prompt or command, plus a one-line description, for you to review.
- **Agent changes:** the planner, and agent steps during a run, can change the graph. A step agent asks your approval first, showing the exact text that would run, and can only change steps that haven't started. That approval can't be given from a notification or with **Approve all**: you approve each request on its own, after you see its text on the step or in the Approvals view. Approved changes apply to the running run and stay marked on the canvas (`＋` added, `✎` changed, faded ghosts for removed steps) until you **Accept** them into your original graph or **Revert** them in the **Changes** tab. The tab shows each change's before and after and who made it.
- **Variables:** use `{{ name }}` (Jinja) in steps, the goal and the instructions. Values stay on this machine, outside the project, in `~/.agent-stream/values/` (`%USERPROFILE%\.agent-stream\values\` on Windows): they are never committed or exported, and Claude's Read, Grep and Glob tools are refused access to them (a shell command an agent attempts still needs your approval first). A value can read an environment variable: `{{ env_var('DBT_SCHEMA', 'dev') }}`. In commands every value is shell-quoted; `{{ flags | unquoted }}` opts out. A value inside `'…'` or `"…"` is escaped for those quotes. Places where a value can't be quoted safely (after a backtick, `$((`, `${`, `$'`, `$"` or a heredoc, inside a `#` comment or nested quotes, or right after a `\`) are refused with a message that says how to fix the step. Wrap dbt's own Jinja in `{% raw %}…{% endraw %}`.
- **Run:** the dialog shows every command and prompt with values filled in, plus any problem that blocks the run. Start runs exactly what you reviewed.
- **Export / Import:** share a graph's definition (steps, goal, instructions, variable names) as `<name>.agent-stream.json`.

## Parallel tickets and A/B tests

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

### Separate tickets: Set Up Parallel Tickets

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

### A/B tests in one graph: variant workspaces

- **Variant workspaces.** A step's **Workspace** (Node panel) puts it in a variant workspace. Steps with the same workspace name share one temporary, detached Git worktree per run. The runner creates it from the run's start commit, in `~/.agent-stream/worktrees/`. Steps in different workspaces run in parallel; a read-only compare step then reads every variant's results. Steps with a workspace show a `⎇ <name>` badge, one colour per workspace.
- **Uncommitted changes aren't copied.** Variant worktrees start from the last commit, and the run dialog says so when this checkout has changes.
- **No reuse.** A step with a workspace always runs again on a re-run, in that run's own worktree.
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

### dbt and other shared resources

- Worktrees separate files only. Give every variant its own external resources: for dbt, a separate target and schema per variant, so variants never build the same tables. Measure fairly:
  - turn off result caches (for Snowflake, `ALTER SESSION SET USE_CACHED_RESULT = FALSE` via a pre-hook or session parameter);
  - start each variant's warehouse suspended, so local caches are cold;
  - tag each variant's queries (`query_tag`), and read cost and runtime from the warehouse's query and metering history;
  - repeat short runs, because minimum billing per resume skews them.

  Compare runtime, cost and failures per variant, and say how confident the result is.
- A new worktree has no untracked files: no `.venv`, `dbt_packages`, `target` or `node_modules`, and no uncommitted `profiles.yml`. Make `setup_command` prepare them (for example `dbt deps`). Profiles in `~/.dbt/` are shared by every worktree.
- The compare step is read-only, so it can't query the warehouse itself. To read the warehouse's history, add a command step, or mark the compare step **Can edit files** so each command asks for your approval.

### Limitations

- Agent Stream doesn't isolate databases, warehouses, schemas, cloud resources or ports. The guidance above covers them; the engine can't check it.
- It doesn't detect tickets from free text. The planner's `check_tickets` and your choice decide what a ticket is.
- Command steps always count as changing files. There is no file-level locking.
- Agent Stream never removes, merges or prunes ticket worktrees or branches. Use `git worktree remove` and `git branch -d` when a ticket is done. Variant workspaces are removed only through Manage Run Workspaces.
- The lease only coordinates Agent Stream runs; it doesn't stop your own edits or other tools.
  - A lock whose process has gone is reclaimed.
  - A lock file that can't be read blocks runs until you delete it, and the message names the file.
  - Process-id reuse isn't detected beyond the liveness check.
- Waiting runs in one window take the lease in the order they started. A run waiting on another window checks again every 3 seconds.

## Settings

- `agentStream.provider` — `claude` (default) or `copilot` (preview).
- `agentStream.claudePath` — Claude provider only. Claude Code's full path if it isn't found automatically.
- `agentStream.gitBashPath` — Windows: Git Bash's full path if it isn't found automatically.
- `agentStream.model` — the model agent steps in runs use, and planner conversations without their own choice (an alias such as `sonnet`, or a full model id). Empty (default): Claude Code's default.
- `agentStream.effort` — the effort level for the same: `low`, `medium`, `high`, `xhigh` or `max`. Empty (default): the model's own level.
- `agentStream.maxParallel` — how many steps of a run may run at once (default 3). Steps that can change files still take turns within each workspace.

## Providers

Choose the provider with **Agent Stream: Select Provider** (or click the provider in the status bar), or set `agentStream.provider`. Graph files never name a provider, so a graph built on one provider runs on another. A run keeps the provider it started with; the planner starts a fresh conversation when you switch providers.

### Claude

Agent Stream runs your installed, signed-in Claude Code through the Claude Agent SDK. It never reads or stores your credentials. It removes `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL` and `CLAUDE_CODE_USE_*` from every agent's environment, checks `claude auth status`, and stops any session that reports an API key instead of your subscription. It refuses to run in a project whose `.claude/settings.json` would route Claude elsewhere.

### GitHub Copilot (preview)

Agent Stream finds your Copilot models through VS Code's Language Model API and shows them in the status bar tooltip. In this version Copilot can't run steps or the planner yet: runs and chat explain that and point you back to Claude. Agent Stream sends no requests to Copilot, so VS Code doesn't ask you to allow it yet.

## Files it writes

```
<folder>/.agent-stream/
  graphs/<id>.json            the graph (safe to commit)
  graphs/<id>.ops.jsonl       who changed what, and when
  graphs/<id>.baseline.json   your version of the graph while agent changes wait for review
  runs/<run-id>/              run snapshot, per-step events and outputs (git-ignored)
  sessions/<id>/              your work sessions: open tabs and planner chats (git-ignored)
```

Older `.claude-stream` folders and values are moved to the new names automatically the first time a folder is opened. Older planner chats move into a session called Default the first time a folder is opened.

Variable values are kept outside the project, in `~/.agent-stream/values/<hash>.json`, one file per project folder (named after a hash of the folder's path).

Two more folders in your home folder: `~/.agent-stream/locks/` holds one lock file per checkout while a run is changing files there, and `~/.agent-stream/worktrees/<checkout hash>/<run id>/<name>/` holds the variant workspaces runs create (kept until you remove them with Manage Run Workspaces).

## License

MIT. See [LICENSE](LICENSE). The extension package also bundles Anthropic's Claude Agent SDK, which is not covered by this license: it is © Anthropic PBC and subject to Anthropic's own terms (https://code.claude.com/docs/en/legal-and-compliance).
