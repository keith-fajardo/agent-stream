# Graph homes and a README about what Agent Stream is — design

Date: 2026-10-08. Status: draft for review.

## Goal

A work session shows its own graphs. Each graph has one **home**: a session, or **Shared**. Selecting a session in the sidebar lists that session's graphs, followed by the Shared graphs. The Sessions view moves above the Graphs view.

The same change rewrites the README (see **README rewrite**): it now explains what Agent Stream is and who uses it for what, and the per-feature detail moves into `docs/`.

Today graphs belong to the project folder, and a session is only a set of open tabs plus planner chats (`extension/src/graphsView.ts` lists every graph; `engine/src/sessionStore.ts` holds tabs and chats). That stays true for the files on disk. Only the *listing* and the *grouping* change.

## Decisions (agreed with the user)

1. A graph belongs to **exactly one home**: a session id, or Shared.
2. A graph with no recorded home, or whose home session no longer exists, is in **Default**. No migration step. "Default" means the session `SessionStore.ensureDefault()` returns: the session with id `default`, or, if that one is unreadable, the newest readable session, else a fresh one.
3. **Shared** behaves like a special session that every session can see. Sharing a graph moves it into Shared; moving it back out puts it in a session. It is a group in the Graphs list, not a session you switch into (no tabs or chats of its own).
4. Homes are **personal**: stored in the git-ignored sessions folder, not in the committed graph files. A teammate's pulled graphs land in your Default.
5. The UI lets the user **move a graph to any session or to Shared**.
6. Sub-graph reuse is unchanged: a sub-graph step references a graph by id, whatever its home.

## Non-goals

- No change to graph files (`<id>.md`, `<id>.meta.json`), exports, runs, values or attachments.
- No drag-and-drop in v1. The move action is a context-menu command with a quick-pick.
- The README rewrite moves and trims text. It does not change what any feature does, and the detailed text moves to `docs/` unchanged (apart from the Work sessions paragraph, which gains the graph-homes rules).
- The web client (`web/`) is not changed. It keeps listing every graph and ignores `home`.
- No change to the sub-graph picker, the run dialog, or the Approvals view.

## Data

New file `.agent-stream/sessions/graph-homes.json`:

```json
{ "<graphId>": "<sessionId> | @shared" }
```

Shared is stored as `@shared`, not `shared`: session ids are slugs (`GRAPH_ID_RE`) that cannot contain `@`, so a session someone names "Shared" (id `shared`) can never collide with it. The code calls it `SHARED_HOME` (in `shared/src/graphHome.ts`).

- One map for the whole folder. A graph id appears at most once, so two homes are impossible by construction, and no two files need to agree.
- New engine module `engine/src/graphHomes.ts`, beside `sessionStore.ts`, built on the existing atomic-write helper (`writeFileAtomic`).
  - `resolver(knownSessionIds, defaultId)` reads the file once and returns a function from graph id to home: the recorded home, or `defaultId` (the id `ensureDefault()` gives) when absent or pointing at an unknown session.
  - `move(graphId, home)` sets the home. Moving to the Default session removes the entry.
  - `forget(graphId)` removes the entry (graph deleted).
  - `releaseSession(sessionId)` drops every entry homed in that session (session deleted), so those graphs read as Default.
- The file is read tolerantly. Missing, empty or unparsable means "no homes" (everything in Default), and the problem is logged to the Agent Stream output channel. It is never fatal.
- `GraphListItem` (`shared/src/types.ts`) gains an optional `home` (a session id, or `@shared`; always set by the engine, so it is only missing in tests), filled in by `listGraphs()` in `engine/src/app.ts`.
- The resolver needs the list of existing session ids, taken from `SessionStore.list()`. A session with a problem still counts as existing, so a damaged `session.json` does not silently re-home its graphs.

## Engine API (`engine/src/app.ts`)

- `moveGraph(id, home)`: validates that the graph exists and that `home` is `@shared` or an existing session. Returns the usual `{ ok } | { ok: false, error }`. Broadcasts the graphs list.
- `createGraph`, `duplicateGraph` and the import / template / planner creation paths take an optional `home`. The extension passes the active session. The web client omits it, so those graphs land in Default.
- `deleteGraph` also calls `forget`.
- `deleteSession` also calls `releaseSession(id)` after a successful delete, so no entry is left pointing at a missing session. Deleting the Default session is allowed today (`ensureDefault()` then picks another readable session or makes a fresh one); its graphs follow whichever session that turns out to be, because an entry that points at a missing session already reads as Default.

## Behaviour

- **Graphs list:** `GraphsView` shows the active session's graphs, then a collapsible **Shared** group. Rows need no home label: the group header says Shared. The Shared group is hidden when empty.
- **Switching session** refreshes the list. Tabs, splits and chats switch as today.
- **Moving:** the context menu of a graph row has **Move to Session…**, a quick-pick of the folder's sessions plus **Shared**, with the current home marked. Choosing the current home does nothing.
- **Open tabs:** a move closes nothing. Tabs reference a graph id, so a graph opened in session A and moved elsewhere keeps its tab in A, and restores in A on the next switch.
- **Deleting a session:** its graphs are not deleted. They move to Default, and the confirmation says "N graphs move to Default".
- **Duplicating a session:** copies tabs and chats as today. Graph homes are not copied.
- **Unreadable graphs:** still listed in their home, with the existing warning row.
- **Several folders:** homes and sessions are per folder, as today.
- **Worktrees:** each worktree has its own sessions folder, so its graphs start in Default.

## Sidebar order

`extension/package.json` `contributes.views.agentStream` becomes: `agentStream.sessions`, `agentStream.graphs`, `agentStream.approvals`. VS Code remembers the view order a user has already set, so existing installs may keep the old order until they reset it (View: Reset View Locations). New installs get the new order.

## README rewrite

### Why

Agent Stream has grown from "a planner that draws a graph" into a tool with sessions, parallel tickets, A/B variants, sub-graphs and a browser. The README (about 45 KB) is a reference manual: the first screen does not say what the tool is for. It should explain what Agent Stream is and which jobs a developer can use it for, and leave the detail to linked pages.

### Structure

Both `README.md` (GitHub) and `extension/README.md` (the Marketplace page) get the same new body. They differ only in the **Install** text and in the root README's **Development** link, as today.

1. **Title and disclaimer.** Keep the independent-project line.
2. **What Agent Stream is.** Two short paragraphs, then four steps of how it works: describe a goal; the planner draws a graph with one step per action; you review and edit; steps run on your own AI subscription, each edit or command waits for your approval, and every run is recorded. State plainly that it is provider-agnostic (Claude, GitHub Copilot, OpenAI Codex).
3. **Use cases** (below).
4. **Key ideas.** A short glossary: graph, step, planner, approval, run report, session, Shared, provider. Sessions and Shared use the graph-homes rules above.
5. **Requirements, Install, Quick start.** The existing Requirements and Install text, plus a short first-run walkthrough taken from today's **Use** section.
6. **Learn more.** Links to the `docs/` pages.
7. **Third-party software, License.** Unchanged. The root README keeps a one-line link to `docs/development.md`.

### Use cases

Written for a developer deciding whether the tool fits. Each is a short paragraph plus one concrete example.

1. **Break a big task into auditable steps** (the main use case). Example: test a **dbt snapshot (SCD2) model**. Steps check the snapshot table doesn't exist, run `dbt snapshot`, check it now exists, add a new source row, run again, check the row arrived, change the row, and check the old version was closed. Every run and edit waits for approval, and **Export Run Report** gives one Markdown record to hand to a reviewer. Also fits migrations and refactors.
2. **Work on several tickets at once.** Each ticket runs in its **own Git worktree**, so changes never collide. Each worktree has its own graphs, runs and sessions.
3. **Compare scenarios in one graph.** Variants run the same steps in separate **Git worktrees** (variant workspaces) and the results sit side by side. Example: run a dbt model on two warehouses and compare cost and runtime.
4. **Research along several dimensions, then synthesize.** The planner splits a question into dimensions (for example market, competitors, pricing, risks). Each dimension is its own research step, read-only steps run side by side, and a final synthesis step combines their outputs into one report. Browser steps reach sources behind a login. Each step keeps its own log, so a claim in the synthesis traces back to the step that found it.
5. **Build reusable workflows.** A graph can be one step of another (sub-graphs), for example "Company research" used by several graphs. Reusable graphs can live in **Shared**.
6. **Use sites that need a login.** Browser steps use your own logged-in Chrome, Edge or Chromium; every click and keystroke asks first.

### Where the detail goes

Moved without rewording, except where noted. In the Marketplace README, links to `docs/` use the absolute GitHub URLs, as the existing `graph-format.md` link does.

| README section today | New home |
| --- | --- |
| Use (sidebar, chat, model and effort, attachments, work sessions, status bar), Sub-graphs, Graph files | `docs/using.md` (Work sessions gains the graph-homes rules, Shared and Move to Session) |
| The Agent Stream browser | `docs/browser.md` |
| Parallel tickets and A/B tests | `docs/parallel-and-ab.md` |
| Settings | `docs/settings.md` |
| Providers (Claude, Copilot, Codex) | `docs/providers.md` |
| Files it writes (adds `graph-homes.json`) | `docs/files.md` |
| Development | `docs/development.md` |

`docs/graph-format.md` and `docs/windows-checklist.md` stay as they are.

## Testing

- Engine (`graphHomes`): Default fallback for absent and unknown sessions; `move` to a session and to Shared; moving back to Default removes the entry; `forget`; `releaseSession`; unreadable file reads as "no homes"; a session with a problem still counts as existing.
- Engine (`app`): `moveGraph` validation errors; `createGraph` / `duplicateGraph` with and without `home`; `deleteGraph` forgets; `deleteSession` releases its graphs to Default; `listGraphs` fills `home`.
- Extension: `GraphsView` shows the active session's graphs plus the Shared group, hides an empty Shared group, and refreshes on a session switch; Move to Session quick-pick lists sessions plus Shared and marks the current home; the delete-session confirmation names the graph count.
- `package.json`: a test that the view order is Sessions, Graphs, Approvals.
- README: a test that every `docs/...` link in `README.md` and `extension/README.md` points at a file that exists, and that both READMEs have the same headings apart from the Install and Development differences.

## Open items for the plan

- Whether `GraphsView` should say which home a graph moved to in a status-bar message or a notification (default: none; the list updates).
- Screenshots: if the README gets any, take them with `extension/scripts/screenshots.mjs` after the sidebar reorder.
