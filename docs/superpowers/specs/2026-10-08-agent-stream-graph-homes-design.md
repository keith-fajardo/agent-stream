# Graph homes: graphs belong to sessions — design

Date: 2026-10-08. Status: draft for review.

## Goal

A work session shows its own graphs. Each graph has one **home**: a session, or **Shared**. Selecting a session in the sidebar lists that session's graphs, followed by the Shared graphs. The Sessions view moves above the Graphs view.

Today graphs belong to the project folder, and a session is only a set of open tabs plus planner chats (`extension/src/graphsView.ts` lists every graph; `engine/src/sessionStore.ts` holds tabs and chats). That stays true for the files on disk. Only the *listing* and the *grouping* change.

## Decisions (agreed with the user)

1. A graph belongs to **exactly one home**: a session id, or `shared`.
2. A graph with no recorded home, or whose home session no longer exists, is in **Default**. No migration step. "Default" means the session `SessionStore.ensureDefault()` returns: the session with id `default`, or, if that one is unreadable, the newest readable session, else a fresh one.
3. **Shared** behaves like a special session that every session can see. Sharing a graph moves it into Shared; moving it back out puts it in a session. It is a group in the Graphs list, not a session you switch into (no tabs or chats of its own).
4. Homes are **personal**: stored in the git-ignored sessions folder, not in the committed graph files. A teammate's pulled graphs land in your Default.
5. The UI lets the user **move a graph to any session or to Shared**.
6. Sub-graph reuse is unchanged: a sub-graph step references a graph by id, whatever its home.

## Non-goals

- No change to graph files (`<id>.md`, `<id>.meta.json`), exports, runs, values or attachments.
- No drag-and-drop in v1. The move action is a context-menu command with a quick-pick.
- The web client (`web/`) is not changed. It keeps listing every graph and ignores `home`.
- No change to the sub-graph picker, the run dialog, or the Approvals view.

## Data

New file `.agent-stream/sessions/graph-homes.json`:

```json
{ "<graphId>": "<sessionId> | shared" }
```

- One map for the whole folder. A graph id appears at most once, so two homes are impossible by construction, and no two files need to agree.
- New engine module `engine/src/graphHomes.ts`, beside `sessionStore.ts`, built on the existing atomic-write helper (`writeFileAtomic`).
  - `homeOf(graphId, knownSessionIds, defaultId): string` returns the recorded home, or `defaultId` (the id `ensureDefault()` gives) when absent or pointing at an unknown session.
  - `move(graphId, home)` sets the home. Moving to the Default session removes the entry.
  - `forget(graphId)` removes the entry (graph deleted).
  - `reassign(fromSessionId, toSessionId)` moves every graph homed in one session to another (session deleted).
- The file is read tolerantly. Missing, empty or unparsable means "no homes" (everything in Default), and the problem is logged to the Agent Stream output channel. It is never fatal.
- `GraphListItem` (`shared/src/types.ts`) gains `home: string` (a session id, or `shared`), filled in by `listGraphs()` in `engine/src/app.ts`.
- `homeOf` needs the list of existing session ids, taken from `SessionStore.list()`. A session with a problem still counts as existing, so a damaged `session.json` does not silently re-home its graphs.

## Engine API (`engine/src/app.ts`)

- `moveGraph(id, home)`: validates that the graph exists and that `home` is `shared` or an existing session. Returns the usual `{ ok } | { ok: false, error }`. Broadcasts the graphs list.
- `createGraph`, `duplicateGraph` and the import / template / planner creation paths take an optional `home`. The extension passes the active session. The web client omits it, so those graphs land in Default.
- `deleteGraph` also calls `forget`.
- `deleteSession` also calls `reassign(id, <default id>)` after a successful delete, so graphs are never left pointing at a missing session. Deleting the Default session is allowed today (`ensureDefault()` then picks another readable session or makes a fresh one); its graphs follow whichever session that turns out to be, because an entry that points at a missing session already reads as Default.

## Behaviour

- **Graphs list:** `GraphsView` shows the active session's graphs, then a collapsible **Shared** group. A graph row shows its home only where it is not obvious: rows in the Shared group say "Shared". The Shared group is hidden when empty.
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

## Testing

- Engine (`graphHomes`): Default fallback for absent and unknown sessions; `move` to a session and to `shared`; moving back to Default removes the entry; `forget`; `reassign`; unreadable file reads as "no homes"; a session with a problem still counts as existing.
- Engine (`app`): `moveGraph` validation errors; `createGraph` / `duplicateGraph` with and without `home`; `deleteGraph` forgets; `deleteSession` reassigns to Default; `listGraphs` fills `home`.
- Extension: `GraphsView` shows the active session's graphs plus the Shared group, hides an empty Shared group, and refreshes on a session switch; Move to Session quick-pick lists sessions plus Shared and marks the current home; the delete-session confirmation names the graph count.
- `package.json`: a test that the view order is Sessions, Graphs, Approvals.

## Open items for the plan

- Whether `GraphsView` should say which home a graph moved to in a status-bar message or a notification (default: none; the list updates).
- READMEs (root and `extension/`): the "Work sessions" section needs a paragraph on homes, Shared and Move to Session.
