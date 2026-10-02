# claude-stream for VS Code — extension, Windows support, graph management, variables

**Date:** 2026-10-02
**Status:** Approved in conversation; written for review
**Builds on:** `2026-10-02-claude-stream-design.md` (v1) and the status/logs/approvals changes on
`feat/status-logs-approvals`.
**Replaces:** `2026-10-02-claude-stream-graph-home-design.md`. Its home screen, in-page menu bar
and URL routing are redesigned here for VS Code; its Graph tab, instructions and export/import
carry over (§5, §6).

## 1. Purpose

claude-stream becomes a **VS Code extension** (the original ask), installed from a `.vsix` file,
that runs on **macOS and Windows**. The browser version and its `claude-stream` command go away.

In the same release:

- **Graph management:** new, open, rename, duplicate, delete, export and import graphs.
- **Instructions & context** for the agents at the graph level, beyond the one-line goal.
- **Variables** referenced from steps with Jinja (`{{ target_schema }}`), with values that stay on
  your machine, and dbt-style `env_var()` for machine environment variables.

Success: a teammate on Windows or a Mac installs the `.vsix`, opens a graph you exported, fills in
its variable values, runs it on their own Claude subscription, approves its steps, and reads each
step's logs, all inside VS Code.

## 2. Decisions

| Topic | Decision |
|---|---|
| Product shape | VS Code extension only; the browser app and CLI are removed. |
| Architecture | Engine runs inside VS Code's extension host; each graph tab is a webview client using today's message protocol over `postMessage`. No local server. |
| Layout | Graph tabs (canvas, logs, Chat · Node · Graph panel) plus a **Claude Stream sidebar** with Graphs and Approvals. |
| Menus | An in-tab menu bar **File · Edit · Run · Variables · View** (VS Code doesn't let extensions add top-level menus to its own menu bar). |
| Windows command shell | **Bash everywhere**: Git Bash on Windows, the login shell on macOS/Linux. |
| Distribution | A `.vsix` file shared with teammates; Marketplace later needs no code changes. |
| Templates | Full Jinja (Nunjucks), in agent prompts, commands, goal and instructions. |
| Variable values | Never in the graph file or an export; stored locally in a gitignored file. |
| Secrets | No Secret flag. Credentials stay in the machine environment; `env_var` on a credential-looking name warns. |

## 3. Architecture

### 3.1 Packages

| Package | Today | After |
|---|---|---|
| `shared/` | types, schemas, graph logic | unchanged role; new types/ops (§9) |
| `server/` | engine + HTTP/WebSocket server + CLI | renamed **`engine/`**: a library (graph store, runner, planner, approvals, executors, auth, variables). `cli.ts`, `httpServer.ts`, `bin/` and the `ws`/`open` dependencies are deleted. |
| `web/` | React app served over HTTP | the **webview UI**; `socket.ts` is replaced by a `postMessage` bridge |
| `extension/` | — | **new**: VS Code glue (activation, sidebar views, custom editor, commands, notifications, status bar, settings) and packaging |

Build: esbuild bundles `extension` + `engine` + `shared` into `extension/dist/extension.cjs`
(`vscode` external); Vite builds `web` into `extension/dist/webview/`. `npm run package` runs
`vsce package` and produces `claude-stream-<version>.vsix`. Manifest: `engines.vscode ^1.100.0`,
`extensionKind: ["workspace"]`, publisher id `claude-stream-local` (only used for the `.vsix`).

### 3.2 Engine lifecycle

- One engine (`createApp`) per **workspace folder**, created lazily the first time that folder's
  graphs are listed or a graph from it is opened. With no folder open, the sidebar shows "Open a
  folder to use Claude Stream".
- Data stays in `<folder>/.claude-stream/` exactly as today (graphs, ops/chat logs, `runs/`), so
  graphs made with the browser version open unchanged.
- **Auth** is checked once at activation with `claude auth status` (same rules as v1: claude.ai
  login, first-party provider, sanitized environment, `projectSettingsProblem` per folder). The
  result feeds every engine, the status bar and the sidebar. **Retry** (sidebar button and
  command) re-runs the check.
- On deactivation (VS Code closing or the window reloading), active runs are stopped and recorded
  as Interrupted, as the server's shutdown does today.
- Settings: `claudeStream.claudePath`, `claudeStream.gitBashPath` (Windows), and
  `claudeStream.maxParallel` (default 3, replaces the CLI flag).

### 3.3 Webview bridge

- A graph tab is a **custom editor** (`claudeStream.graph`) for
  `**/.claude-stream/graphs/*.json` (a `CustomReadonlyEditorProvider`; the engine writes files
  itself). Opening a graph from the sidebar, the menu bar, the Command Palette or the Explorer all
  open this editor. "Reopen Editor With… → Text Editor" shows the raw JSON.
- Each webview registers as an engine `Client` whose `send` is `webview.postMessage`; incoming
  messages are validated with `parseClientMessage` and passed to `app.handle`. On dispose it
  disconnects.
- The webview sends `openGraph` for its own graph id after `hello` (the old "open the first
  graph" behaviour is removed). Tabs restore after a VS Code restart.
- `retainContextWhenHidden` is on, so a hidden tab keeps its canvas viewport and state.
- Content Security Policy: no remote content; scripts only from the extension with a nonce;
  styles from the extension plus inline styles (React Flow needs them); `localResourceRoots`
  limited to `dist/webview`.

### 3.4 Host commands

Actions that need VS Code's own UI (input box, file dialogs, confirmation dialog, quick pick)
live in the extension, not the engine. The webview asks for them with a new message
`{ type: 'host'; command: HostCommand; graphId }`, where `HostCommand` is one of `newGraph`,
`openGraph`, `importGraph`, `exportGraph`, `renameGraph`, `duplicateGraph`, `deleteGraph`,
`showSidebar`. The sidebar context menus and Command Palette call the same VS Code commands, so
every action has one code path. The extension calls engine methods directly (in-process) for
rename, duplicate, delete, export and import.

## 4. VS Code UI

### 4.1 Claude Stream sidebar

Own activity-bar icon; its badge is the number of pending approvals.

**Graphs**
- Rows: graph name; description shows the last run (`Succeeded · 2h ago`, `Failed · yesterday`,
  `Never run`). Unreadable graph files show the reason and offer only Delete.
- Sorted by the graph's `updatedAt`, newest first; unreadable files last. In a multi-root
  workspace, grouped by folder.
- Click opens the graph tab (or focuses it if already open).
- Title buttons: **New graph**, **Import**.
- Context menu: Open, Rename, Duplicate, Export, Delete.

**Approvals**
- Pending requests from every graph, oldest first: label `n2 · Build new`, description
  `Bash: dbt build …` (same summary as approval cards), tooltip with the full input (truncated at
  2,000 characters).
- Inline actions ✓ Approve and ✕ Deny. Click reveals the step: opens its graph tab, selects the
  step and shows its logs panel with the full approval card (note field included).
- Title button **Approve all** approves every request listed.
- Signed out / Claude Code not found: the sidebar shows a welcome message with the reason and a
  **Retry** button (§10).

### 4.2 Graph tab

```
File  Edit  Run  Variables  View   ·  dbt-parity-orders  ·  Run #3 ✓ 2h ago ▾  ·  ▶ Run
┌───────────────────────────────────────────────┬─────────────────────┐
│ canvas (+ Step, minimap)                      │ Chat · Node · Graph │
├─ Logs · n2 Build new · Waiting approval ──────┤                     │
│ [approval card]  log timeline …               │                     │
└───────────────────────────────────────────────┴─────────────────────┘
```

- **Top bar:** menu bar, graph name, run history picker, **▶ Run** (or **■ Stop** during a run).
  The goal input and account badge are no longer here (goal → Graph panel, account → status bar).
- **Right panel:** **Chat · Node · Graph**. The Approvals tab is removed (it lives in the
  sidebar); approval cards stay on the step and pinned above its logs.
- The logs panel, step cards (statuses, "⏸ Needs approval"), run confirmation dialog, canvas
  editing and chat behave as on `feat/status-logs-approvals`, except as changed below.
- Colours come from the VS Code theme (`--vscode-*` CSS variables), so light, dark and high
  contrast themes all work.

### 4.3 Menu bar

Menus open on click; while one is open, hovering another title switches to it; Esc or a click
outside closes it. Items that don't apply right now are greyed out, not hidden. No built-in
keyboard shortcuts; every item is also a Command Palette command the user can bind.

| Menu | Items | Enabled when |
|---|---|---|
| **File** | New graph… · Open… · Import… · Export… · Rename… · Duplicate · Delete… | Always; Delete… only with no active run |
| **Edit** | Add step · Delete selected step · Tidy layout | Delete: a step is selected |
| **Run** | Run… · Stop · Re-run from selected step… · Approve all (N) | Run: signed in, no active run. Stop: a run is active. Re-run: signed in, no active run, a step is selected, a previous run exists. Approve all: N > 0 pending requests **for this graph** |
| **Variables** | one row per variable (`name = value`, or `⚠ name — not set`) · Add variable… · Edit variables… | Always |
| **View** | Logs panel · Minimap ✓ · Chat · Node · Graph · Show sidebar | Logs panel: a step is selected. Minimap: toggle, remembered across tabs and restarts (extension `globalState`) |

- File items run the host commands (§3.4): New graph… and Rename… use VS Code's input box;
  Open… shows a quick pick of the folder's graphs; Import… and Export… use VS Code's file dialogs;
  Delete… uses a VS Code modal confirmation.
- Run… and Re-run… open the run confirmation dialog (§7.6).
- Clicking a variable row, Add variable… and Edit variables… open the **Variables dialog**
  (§7.3), focused on that variable's value, on a new empty row, or on the table.

### 4.4 Elsewhere in VS Code

- **Status bar:** `✓ Claude Max` (plan from auth) when signed in with the subscription;
  `⚠ Claude Stream: not signed in` (or the auth error) otherwise. Clicking shows the details and a
  Retry action.
- **Approval notifications:** when a request arrives and its graph tab is not visible, an
  information notification shows `n2 Build new wants to run: dbt build …` with **Approve**,
  **Deny** and **Show** (Show = reveal, as in §4.1). Deny from a notification sends no note.
- **Planner run requests** (`confirmRun`) open the graph's tab if needed, then its run dialog.
- **Command Palette:** `Claude Stream: New Graph`, `Open Graph`, `Import Graph`, `Export Graph`,
  `Rename Graph`, `Duplicate Graph`, `Delete Graph`, `Run Graph`, `Stop Run`, `Approve All`,
  `Edit Variables`, `Show Sidebar`, `Retry Sign-in Check`. Commands that act on a graph use the
  active graph tab, or ask with a quick pick when none is active.

## 5. Graph management

- **New graph:** name from VS Code's input box (blank refused) → creates the graph (id from the
  name, deduplicated as today) and opens its tab.
- **Rename:** changes the display name only; the id and file name stay, so runs keep working.
  Broadcasts the updated graph and list.
- **Duplicate:** creates "<name> copy" (deduplicated) with the same goal, instructions, steps,
  connections, layout, variable definitions **and local variable values**; no planner session,
  chat, op log or runs.
- **Delete:** VS Code modal: "Delete <name>? This removes the graph, its chat, its edit history
  and its variable values on this machine. Past run logs stay." Removes `graphs/<id>.json`,
  `<id>.ops.jsonl`, `<id>.chat.jsonl` and the graph's entry in `variables.local.json`; closes its
  tab. Refused while the graph has an active run ("Stop the run first.").
- **Export:** VS Code save dialog, default file name `<id>.claude-stream.json`:

  ```json
  {
    "format": "claude-stream/graph",
    "version": 1,
    "exportedAt": "2026-10-02T12:00:00.000Z",
    "graph": {
      "name": "dbt parity orders",
      "goal": "…",
      "instructions": "…",
      "variables": [{ "name": "target_schema", "description": "Schema for the new build" }],
      "nodes": [{ "id": "n1", "title": "…", "kind": "agent", "prompt": "…", "position": { "x": 0, "y": 0 } }],
      "edges": [{ "from": "n1", "to": "n2" }]
    }
  }
  ```

  Nodes keep `id`, `title`, `kind`, `prompt`/`command`, `timeoutSec`, `position`; authorship is
  dropped. **Variable values are never exported.** Not included: planner session/cursor, chat, op
  log, runs, graph id.
- **Import:** VS Code open dialog; files over 1 MB are refused. Validation: JSON, `format`,
  `version`, then the graph with the same rules as graph files (unique node ids, valid edges, no
  cycles, valid variable names). On success: a new graph (id from the name, deduplicated;
  `nodeSeq` from the highest node number; every node `createdBy: 'user'` at import time; empty
  planner state; no local values) opens in a tab, and its Variables menu shows each variable as
  not set. On failure: an error notification with the reason; nothing is created. Imported command
  steps still go through the run dialog.

## 6. Instructions & context

- `Graph.instructions: string` (default `''`; older files load with `''`).
- Op `{ type: 'setInstructions'; instructions: string }`, applied, validated, logged and
  broadcast like `setGoal`.
- **Graph panel** (right panel, "Graph" tab): **Goal** (one line) and **Instructions & context**
  (free text), with **Save**. Local draft like the Node editor: Save sends only changed fields; if
  the planner changes a field while you have unsaved edits, a notice offers "Discard my edits".
- **Agent prompt** (`buildNodePrompt`): after `# Workflow goal`, add
  `# Instructions & context\n<text>` when non-empty, before `# Your step`. Goal and instructions
  are rendered with variables first (§7.4).
- **Planner:** `get_graph` includes `instructions`; new tool `set_instructions({ instructions })`;
  `describeOp` reports "changed the instructions"; `PLANNER_APPEND` says the goal and instructions
  are given to every agent step.
- `contentSignature` includes `instructions`. Re-run reuse ignores goal and instructions, as
  today.

## 7. Variables

### 7.1 Storage

- **Definitions** live in the graph: `Graph.variables: { name: string; description: string }[]`
  (default `[]`). They are committed with the graph file and included in exports.
- **Values** live only on this machine, in `<folder>/.claude-stream/variables.local.json`:

  ```json
  { "version": 1, "graphs": { "dbt-parity-orders": { "target_schema": "{{ env_var('DBT_SCHEMA', 'dev') }}", "model": "orders_v2" } } }
  ```

  Written atomically, with file mode `0600` on macOS/Linux. `ensureDataDirs` makes sure
  `.claude-stream/.gitignore` contains both `runs/` and `variables.local.json` (appending the
  missing line in existing projects). A torn or invalid file is reported once and treated as
  empty; it is not overwritten until the user saves a value.
- A value is a string (max 10,000 characters). An empty string means **not set**.

### 7.2 Names

- Pattern `^[A-Za-z_][A-Za-z0-9_]{0,63}$`, unique within the graph.
- Reserved: `env_var`; step ids (`n` followed by digits, kept for output values); Jinja words
  (`true`, `false`, `none`, `True`, `False`, `None`, `and`, `or`, `not`, `in`, `is`, `if`, `else`,
  `elif`, `endif`, `for`, `endfor`, `set`, `raw`, `endraw`, `loop`, `super`, `self`).

### 7.3 Editing

- Ops: `addVariable { name, description? }`, `renameVariable { name, newName }`,
  `setVariableDescription { name, description }`, `deleteVariable { name }`, validated, logged
  and broadcast like other ops (the planner sees them in its user-edits preamble).
- **Rename** also rewrites references to the old name in every step's prompt and command and in
  the goal and instructions: a Nunjucks lexer pass replaces symbol tokens equal to the old name
  inside `{{ }}` and `{% %}` tags (not attribute names after a `.`). The run dialog catches any
  reference the rewrite misses. Local values move to the new name.
- **Delete** removes the definition and its local value; steps still referring to it fail in the
  run dialog.
- Values are not ops: the webview sends `setVariableValue { graphId, name, value }`; the engine
  writes `variables.local.json` and broadcasts `variableValues { graphId, values }` (a
  `Record<name, string>`) to that graph's tabs. Values are never sent to the planner.
- **Variables dialog** (from the Variables menu): a table of Name · Value · Description with a
  delete button per row and **Add variable**. Save applies only the changes (ops for
  names/descriptions, `setVariableValue` for values). Name errors show inline and block Save.
- **Planner:** `get_graph` includes `variables` (names and descriptions, never values). New tools
  `set_variable({ name, description })` (adds, or updates the description) and
  `delete_variable({ name })`. `PLANNER_APPEND` explains `{{ name }}` references, that the user
  sets values, that command values are quoted (`| unquoted` to opt out), `env_var()`, and wrapping
  dbt Jinja in `{% raw %}…{% endraw %}`.

### 7.4 Rendering

- Engine module `variables.ts` uses **Nunjucks** with Jinja compatibility
  (`installJinjaCompat`), `autoescape: false`, `throwOnUndefined: true`, no file loader (no
  `include`/`extends`/`import`).
- Context: the graph's variables (their values rendered first, see below) plus the global
  `env_var(name, default?)`.
- Rendered fields: each step's `prompt` (agent) or `command` (command), the goal and the
  instructions. Titles are not rendered.
- A variable's **value** may itself use `env_var()` (e.g. `{{ env_var('DBT_SCHEMA', 'dev') }}`);
  it may not reference other variables. Each value is rendered once per run.
- **Agent prompts, goal, instructions:** output inserted as-is.
- **Commands:** every `{{ … }}` output is shell-quoted for POSIX shells (`'…'`, with `'` written
  as `'\''`; empty → `''`), applied by rewriting each `{{ expr }}` to `{{ (expr) | _shq }}` via the
  lexer before rendering. `{{ expr | unquoted }}` skips quoting. Literal text, including text
  inside `{% if %}` blocks, is not quoted. Quoting happens inside claude-stream, so the result is
  the same on every OS (all command steps run in Bash, §8.1). A `{{ }}` placed inside a
  double-quoted shell string gets literal quote marks; the run dialog shows the final command so
  this is visible.

### 7.5 `env_var`

- `env_var('NAME')` returns the variable from VS Code's extension-host environment;
  `env_var('NAME', 'default')` returns the default when it is unset. Unset with no default →
  error.
- Names are matched as the OS does: exact case on macOS/Linux, case-insensitive on Windows.
- The environment is the one VS Code started with: after changing a system or shell-profile
  variable, quit and reopen VS Code.
- **Credential warning:** when an `env_var` name contains `PASSWORD`, `PASSWD`, `TOKEN` or
  `SECRET`, or has `KEY` as an `_`-separated part (`API_KEY`, `PRIVATE_KEY_PATH`), the run dialog
  warns: "`SNOWFLAKE_PASSWORD` looks like a credential. Its value will appear in this dialog and in
  the step's logs (and is sent to Claude in agent step n1). Steps already inherit your environment,
  so tools like dbt can read it directly." This is a warning, not a block.

### 7.6 Run dialog and starting a run

The run plan moves from the browser (`describeRunPlan`) to the engine:

- Webview sends `previewRun { graphId, fromNodeId?, sourceRunId? }`; the engine replies
  `runPreview { graphId, fromNodeId?, sourceRunId?, problems, warnings, steps, signature }`, where
  `steps` lists every step that will execute with its rendered command (commands) or rendered step
  prompt (agents), plus the reused step ids. The re-run plan is now exact for any source run.
- **Problems (block Start):** v1's `validateRunnable` problems; a variable with no value ("Set a
  value for target_schema (Variables menu)"); an unknown name ("n2: unknown variable `ref`" — when
  the name is one of `ref`, `source`, `config`, `this`, `target`, `var`, `is_incremental`,
  `adapter`, `run_query`, `log`, `statement`, `execute`, `model`, `dbt_utils`, add "This looks like
  dbt Jinja. Wrap it in {% raw %}…{% endraw %}."); an unset `env_var` with no default; a Nunjucks
  syntax error (step, field and line).
- **Warnings (shown, don't block):** credential-looking `env_var` names; uses of `| unquoted`.
- Dialog layout: commands in full; agent step prompts collapsed with an expand toggle; a list of
  the variables used with their rendered values; problems and warnings at the top.
- `signature` = SHA-256 of `contentSignature(graph)` + every rendered field + the reused set.
  **Start** sends `startRun { graphId, reviewed: signature, … }`; the engine re-renders and
  refuses with "Something changed since you reviewed this run (a step, a variable or an
  environment variable). Review it again." when the signature differs.
- `RunMeta` gains `rendered: { goal: string; instructions: string; nodes: Record<string, string> }`
  (rendered prompt or command per executed step). Executors receive rendered text; the `start`
  log event shows the rendered command/prompt.
- **Re-run reuse:** `reusableNodeIds` compares a step's rendered text with the source run's
  `rendered` entry (falls back to the template for runs recorded before this change), so a step
  whose `{{ model }}` value changed runs again.

## 8. Windows and platform support

### 8.1 Command steps

- **macOS/Linux:** unchanged: `$SHELL -lc "<command>"` (fallback `/bin/sh`), own process group.
- **Windows:** Git Bash: `bash.exe -lc "<command>"` with `windowsHide: true`, and
  `CHERE_INVOKING=1` so Git Bash's login profile stays in the project folder instead of changing
  to the home directory. `PYTHONIOENCODING=utf-8` is set unless already set, so Python tools like
  dbt don't fail printing non-ASCII output to a pipe.
- **Finding Git Bash**, in order: `claudeStream.gitBashPath`; `CLAUDE_CODE_GIT_BASH_PATH`; next to
  `git.exe` found on PATH (`<Git>\cmd\git.exe` → `<Git>\bin\bash.exe`); `%ProgramFiles%\Git\bin\bash.exe`.
  Never the first `bash` on PATH (often `C:\Windows\System32\bash.exe`, which is WSL).
- **Git Bash missing:** the run dialog lists a problem for graphs with command steps: "Command
  steps need Git Bash on Windows. Install Git for Windows, or set claudeStream.gitBashPath."
  Agent-only graphs still run.

### 8.2 Stop and timeouts

- **macOS/Linux:** unchanged: SIGTERM to the process group, SIGKILL after 5 s.
- **Windows:** `taskkill /PID <pid> /T /F` ends the command and everything it started at once
  (there is no reliable graceful stop for console programs).

### 8.3 Finding Claude Code

In order: `claudeStream.claudePath`; PATH (on Windows, `claude.exe`, then other `PATHEXT`
extensions); then `~/.local/bin/claude`, `/opt/homebrew/bin/claude`, `/usr/local/bin/claude`
(macOS/Linux) or `%USERPROFILE%\.local\bin\claude.exe` (Windows). The fallbacks matter because
VS Code started from the Dock or Start menu may have a different PATH than a terminal. A `.cmd`
launcher can't be passed to the Agent SDK directly; if that is all that is found, the sidebar asks
for `claudeStream.claudePath` to point at `claude.exe`.

### 8.4 Agent steps

No change. On Windows, Claude Code runs shell commands through Git Bash or its PowerShell tool;
both pass through the approval gate, which lets only `Read`, `Glob` and `Grep` through. Approval
cards and the sidebar summarise `PowerShell` requests like `Bash` (by their command).

### 8.5 Files and environment

- Graph, ops, chat and variables files are read correctly with CRLF line endings (Git's
  `autocrlf` on Windows); files are written with LF.
- All paths are built with `node:path`; graph ids stay slugs, so file names are valid on Windows.
- `variables.local.json` gets mode `0600` on macOS/Linux; on Windows it relies on the user
  profile's permissions.

### 8.6 Remote workspaces

`extensionKind: ["workspace"]`: with Remote SSH, WSL or Dev Containers the extension runs where
the files are, so Claude Code must be installed and signed in there. A WSL folder on Windows runs
as Linux (no Git Bash needed). VS Code for the Web (vscode.dev) is not supported.

## 9. Protocol and data changes

- **Graph:** `instructions: string`, `variables: { name; description }[]` (zod defaults for old
  files).
- **Op:** `setInstructions`, `addVariable`, `renameVariable`, `setVariableDescription`,
  `deleteVariable`.
- **RunMeta:** `rendered` (§7.6).
- **GraphListItem:** `updatedAt?: string`, `lastRun?: { status: RunStatus; startedAt: string }`.
- **ClientMessage:** `previewRun`, `setVariableValue`; `host` (webview → extension, §3.4, not
  seen by the engine). `startRun.reviewed` becomes the preview signature.
- **ServerMessage:** `runPreview`, `variableValues`, `graphDeleted { graphId }`; host → webview
  `revealNode { nodeId }` (select a step and show its logs) and `openRunDialog { fromNodeId? }`.
  `graphOpened` also carries the graph's `variableValues`.
- **GraphStore:** `rename`, `duplicate`, `delete`, `exportGraph`, `importGraph`; `list()` returns
  the new fields.
- **New engine modules:** `variables.ts` (rendering, validation, local values file),
  `platform.ts` (shell and Claude Code discovery, process-tree kill).
- `hello` no longer causes the webview to open the first graph.

## 10. Error handling

| Situation | Behavior |
|---|---|
| Not signed in with the Claude subscription | Sidebar welcome message + Retry; status bar warning; Run and chat disabled in graph tabs |
| Claude Code not found (or only a `.cmd` launcher) | Sidebar message naming `claudeStream.claudePath`; Run and chat disabled |
| Project `.claude/settings.json` reroutes Claude | That folder's graphs show the v1 message; Run and chat disabled for them |
| Git Bash missing on Windows | Run dialog problem for graphs with command steps |
| Variable not set, unknown name, unset `env_var`, template syntax error | Run dialog problems (§7.6) |
| Something changed between review and Start | Start refused; review again |
| Import: not JSON, wrong format/version, invalid graph, over 1 MB | Error notification with the reason; nothing created |
| Delete while the graph has an active run | Refused: "Stop the run first." |
| Rename to a blank name; invalid or duplicate variable name | Refused with the reason (inline in dialogs) |
| `variables.local.json` unreadable | One warning notification; values treated as empty; file left untouched until a value is saved |
| Graph deleted while its tab is open | `graphDeleted` → tab closes with a notification |
| No workspace folder open | Sidebar: "Open a folder to use Claude Stream" |

## 11. Testing

- **Existing suites** keep running against `engine` (renamed), `shared` and `web`.
- **shared:** new ops and their validation; `contentSignature` with instructions; export-file
  schema (valid, wrong format/version, broken graph, bad variable names); reuse with `rendered`.
- **engine:**
  - `variables.ts`: rendering in each field; command quoting incl. `'` in values, empty values,
    `| unquoted`, `{% if %}` literals; `env_var` set/unset/default; values using `env_var`;
    unknown-name, dbt-hint, unset-value and syntax-error problems; credential warnings; rename
    reference rewrite; local file read/write, torn file, gitignore line, `0600` mode.
  - Run preview and signature; Start refused after a value or environment change; `rendered`
    recorded and passed to executors.
  - `buildNodePrompt` instructions section; planner `set_instructions`, `set_variable`,
    `delete_variable`, `describeOp` for the new ops; `get_graph` never includes values.
  - `GraphStore` rename/duplicate (incl. values)/delete (incl. values)/export (no values)/import.
  - `platform.ts` with an injected platform and file system: Git Bash discovery order (never WSL
    bash), Claude Code discovery order incl. `.cmd`, process-tree kill command per OS, Windows
    environment additions.
- **extension:** unit tests with a stand-in `vscode` module: tree items (Graphs, Approvals),
  command routing (menu bar host commands, context menus and palette reach the same handler),
  notification on approval when the tab is hidden, status bar states.
- **web:** menu bar (open/close/hover-switch, disabled states per menu, Approve all scoped to the
  graph), Variables menu and dialog, Graph panel (saves only changed fields), run dialog rendering
  of a `runPreview` (problems, warnings, collapsed prompts).
- **VS Code integration** (`@vscode/test-electron`, on this Mac): activate the extension on a
  fixture folder, list graphs, open a graph tab and receive `graphOpened` from its webview, run a
  command-only graph to success.
- **Visual check:** launch VS Code with the extension and capture screenshots through Electron's
  remote debugging port (as the headless Chrome checks did): sidebar, graph tab with an open
  menu, Variables dialog, run dialog, light and dark themes.
- **Windows checklist** (run by the user or a teammate from the `.vsix` on Windows):
  1. Install the `.vsix`; the sidebar and status bar show the signed-in subscription.
  2. Open an exported graph via Import; its variables show as not set; set them.
  3. Run an agent step that edits a file: the approval appears on the step, in the sidebar and as
     a notification; approving works.
  4. Run a command step using `{{ }}` values with a space and a `'` in them; the run dialog shows
     the quoted command and it runs in the project folder.
  5. `env_var` with a user environment variable, and with a missing one (problem shown).
  6. Stop a long command (`sleep 600`): the step stops and no `bash.exe`/child stays running.
  7. Rename Git for Windows' folder or set a wrong `claudeStream.gitBashPath`: the run dialog
     explains.

## 12. Removed

- The `claude-stream` CLI (`server/bin`, `cli.ts`), the HTTP/WebSocket server (`httpServer.ts`,
  per-launch token, cookie, Host/Origin checks) and the `ws` and `open` dependencies.
- The home screen idea, URL hash routing, the top bar's goal input and account badge, and the
  right panel's Approvals tab.
- `web/src/socket.ts` (replaced by the `postMessage` bridge) and the browser-side run plan
  (`runPlan.ts`, replaced by `runPreview`).
- The README is rewritten for installing from the `.vsix`, prerequisites (Claude Code signed in
  with a Claude subscription; Git for Windows on Windows) and the settings.

## 13. Risks to check first

These are verified at the start of implementation, before the work that depends on them:

1. **Agent SDK in the extension host:** `@anthropic-ai/claude-agent-sdk` bundles with esbuild and
   runs with `pathToClaudeCodeExecutable`. If it can't be bundled, it ships as a dependency inside
   the `.vsix`.
2. **React Flow under the webview CSP** (inline styles, no `eval`).
3. **Windows-only behaviour** that can't be tested on this Mac (`CHERE_INVOKING`, `taskkill`,
   `PYTHONIOENCODING`, `claude.exe` discovery) is isolated in `platform.ts` behind injected
   dependencies, and confirmed by the Windows checklist.

## 14. Out of scope

- The browser version; Marketplace publishing; VS Code for the Web.
- Output values, skills in the planner chat, and the planner as a full agent (follow-up spec).
  Variable names already reserve step ids for output values (`{{ n1.model }}`).
- Per-step shell choice or PowerShell command steps.
- A Secret flag, masking values in logs, or encrypting `variables.local.json`.
- Default keyboard shortcuts.
- Merging an imported graph into an existing one; exporting runs or chat; undo for delete.
