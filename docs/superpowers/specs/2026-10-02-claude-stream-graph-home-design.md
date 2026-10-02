# claude-stream — Graph home, Graph tab, instructions, export/import

**Date:** 2026-10-02
**Status:** Approved in conversation; written for review
**Builds on:** `2026-10-02-claude-stream-design.md` (v1) and the status/logs/approvals changes on `feat/status-logs-approvals`.

## 1. Purpose

Four requests from using v1:

1. A **main menu** listing all graphs, instead of the top-bar dropdown and "+ New".
2. A **cleaner top bar**: the goal input does not belong there. Add a classic **menu bar**
   (File, Edit, Run, View).
3. **Export/import** a graph as a file, so a teammate can recreate it (without packaging it as a skill).
4. **Instructions & context** for the agents at the graph level, beyond the one-line goal.

Success: you land on a home screen listing your graphs with their last run; open one into
the editor; edit the goal and instructions in a Graph tab; every agent step and the
planner receive the instructions; you can export a graph to a file and a teammate can
import it into their own project and run it.

## 2. Decisions

| Topic | Decision |
|---|---|
| Main menu | A **home screen** (start page) listing graphs; the editor has "← All graphs". |
| Menu bar | **File · Edit · Run · View** in the top bar on every screen, alongside the home screen. |
| Goal + instructions | A **Graph tab** in the right panel (Chat · Node · Approvals · Graph). |
| Fields | Two: **Goal** (one line, as today) and **Instructions & context** (free text). |
| Export contents | **Definition only**: name, goal, instructions, steps, connections, layout. No planner session, chat, op log or runs. |

## 3. Screens and navigation

### 3.1 Home screen

Shown at startup and whenever no graph is open.

```
claude-stream                                Claude Max · you
Your graphs                      [+ New graph] [Import…]
──────────────────────────────────────────────────────────
parallel-testing    Last run: Succeeded · 2h ago       ⋯
dbt-parity-orders   Last run: Failed · yesterday       ⋯
demo                Never run                          ⋯
broken-graph        Can't be read: invalid JSON …      ⋯
```

- Rows are sorted by the graph's `updatedAt`, newest first; unreadable files sort last.
- Clicking a row (or **Open** in ⋯) opens the graph.
- **⋯ menu:** Open, Rename, Duplicate, Export, Delete. Unreadable graphs offer only Delete.
- **+ New graph:** inline name input → creates and opens the graph.
- **Import…:** file picker (see §5).
- **Rename:** inline input; changes the display name only. The graph id and file name stay
  the same, so run history and links keep working.
- **Duplicate:** creates "<name> copy" (deduplicated) with the same goal, instructions,
  steps, connections and layout; no planner session, chat, op log or runs.
- **Delete:** an in-app confirmation dialog ("Delete <name>? This removes the graph, its
  chat and its edit history. Past run logs stay on disk."). Deletes
  `graphs/<id>.json`, `<id>.ops.jsonl`, `<id>.chat.jsonl`. Refused while the graph has an
  active run.
- Relative times ("2h ago", "yesterday") are formatted in the browser.

### 3.2 Editor

- Opening a graph sets the URL hash to `#/graph/<id>`; reload and browser back/forward
  respect it. `#/` (or no hash) shows the home screen. An unknown or unreadable id in the
  hash shows the home screen with a toast.
- **Top bar:** `claude-stream  File Edit Run View · ← All graphs · <graph name> ·
  Run/Stop · run picker · account`. The goal input is removed from the top bar.
- If the open graph is deleted (e.g. from another tab), the editor returns to the home
  screen with a toast.

### 3.3 Menu bar

Shown in the top bar on every screen. Menus open on click; while one is open, hovering
another menu title switches to it; Esc or a click outside closes it. Items that don't
apply right now are shown disabled (not hidden). No keyboard shortcuts in this version.

| Menu | Items | Enabled when |
|---|---|---|
| **File** | New graph… · Open… (goes to the home screen) · Import… · Export… · Rename… · Duplicate · Delete… | New/Open/Import: always. Others: a graph is open |
| **Edit** | Add step · Delete selected step · Tidy layout | A graph is open (Delete: a step is selected) |
| **Run** | Run… · Stop · Re-run from selected step… · Approve all (N) | Run: a graph is open, signed in, no active run. Stop: a run is active. Re-run: a step is selected and the graph has a previous run. Approve all: N > 0 |
| **View** | Logs panel (for the selected step) · Minimap ✓ · Chat · Node · Approvals · Graph | Logs panel: a step is selected. Minimap: toggle, remembered in the browser |

- Every item reuses the same action as its existing button or ⋯ entry (one code path):
  e.g. File › Delete… opens the same confirmation dialog as the home screen, Run › Run…
  opens the same run confirmation dialog, Run › Approve all is the Approvals tab button.
- **New graph…** and **Rename…** use a small in-app dialog with a name field (no browser
  `prompt()`), shared with the home screen's inline actions where possible.
- On the home screen only File's always-enabled items are active; the rest are disabled.

### 3.4 Graph tab

Right panel tabs become **Chat · Node · Approvals · Graph**.

```
Goal
[Prove orders_v2 matches orders and is cheaper……………]
Instructions & context
┌──────────────────────────────────────────────┐
│ Use target dev. Never run against prod.      │
│ Compare row counts and key columns first.    │
└──────────────────────────────────────────────┘
[Save]                               [Export graph]
```

- Local draft like the Node editor: Save sends only changed fields (`setGoal` and/or
  `setInstructions` ops); if someone else (the planner) changes a field while you have
  unsaved edits, a notice offers "Discard my edits".
- **Export graph** downloads the export file (§5).

## 4. Instructions & context

- `Graph.instructions: string` (default `''`). Older graph files without it load with `''`
  (zod default).
- New op `{ type: 'setInstructions'; instructions: string }`, applied, validated, logged and
  broadcast like `setGoal`.
- **Agent prompt** (`buildNodePrompt`): after `# Workflow goal`, add
  `# Instructions & context\n<text>` when non-empty, before `# Your step`.
- **Planner:**
  - `get_graph` includes `instructions`.
  - New graph tool `set_instructions({ instructions })`.
  - `describeOp` reports `changed the instructions` in the user-edits preamble.
  - `PLANNER_APPEND` mentions that the graph's goal and instructions are given to every
    agent step, and that it can propose instructions with `set_instructions`.
- **Run confirmation binding:** `contentSignature` includes `instructions`, so a change
  after the user reviewed a run makes Start ask to review again.
- **Re-run reuse** is unchanged: like the goal, instructions do not invalidate reused steps.

## 5. Export / import

### 5.1 File format

`<id>.claude-stream.json`:

```json
{
  "format": "claude-stream/graph",
  "version": 1,
  "exportedAt": "2026-10-02T12:00:00.000Z",
  "graph": {
    "name": "dbt parity orders",
    "goal": "…",
    "instructions": "…",
    "nodes": [{ "id": "n1", "title": "…", "kind": "agent", "prompt": "…", "position": { "x": 0, "y": 0 } }],
    "edges": [{ "from": "n1", "to": "n2" }]
  }
}
```

- Nodes keep `id`, `title`, `kind`, `prompt` / `command`, `timeoutSec`, `position`.
  Authorship (`createdBy`/`updatedBy`/`updatedAt`) is dropped; on import every node is
  `createdBy: 'user'` with the import time.
- Not included: planner session/cursor, chat, op log, runs, the graph id.

### 5.2 Export

- The server builds the file (one code path for the Graph tab and the home ⋯ menu):
  client sends `exportGraph { graphId }`, server replies `exportData { fileName, content }`,
  the browser downloads it.

### 5.3 Import

- Home screen **Import…** reads the chosen file in the browser (refused above 1 MB) and
  sends `importGraph { content }`.
- The server validates: JSON, `format` and `version`, then the graph with the same rules
  as graph files (unique node ids, valid edges, no cycles; `parseGraph`). On success it
  creates a new graph with id from the name (deduplicated), `nodeSeq` from the highest
  node number, empty planner state, and replies with `graphOpened` (and broadcasts the new
  list). On failure it replies `error` with the reason and creates nothing.
- Imported command steps still go through the run confirmation dialog before running.

## 6. Protocol and data changes

- `GraphListItem` gains `updatedAt?: string` and `lastRun?: { status: RunStatus; startedAt: string }`
  (from the newest run of that graph).
- `ClientMessage` gains:
  - `renameGraph { graphId, name }`
  - `duplicateGraph { graphId }`
  - `deleteGraph { graphId }`
  - `exportGraph { graphId }`
  - `importGraph { content }` (string, max 1 MB)
- `ServerMessage` gains:
  - `exportData { graphId, fileName, content }`
  - `graphDeleted { graphId }`
- `GraphStore` gains `rename(id, name)`, `duplicate(id)`, `delete(id)`,
  `importGraph(exported)`; `list()` returns the new fields; `exportGraph(id)` builds the
  export object.
- Rename/duplicate/delete/import broadcast the updated `graphs` list. Rename also
  broadcasts the renamed `graph`.
- The client keeps the open graph id in the URL hash; `hello` no longer auto-opens the
  first graph.

## 7. Error handling

| Situation | Behavior |
|---|---|
| Import: not JSON, wrong format/version, invalid graph, over 1 MB | `error` toast with the reason; nothing created |
| Delete while the graph has an active run | refused: "Stop the run first." |
| Delete/rename/duplicate/export an unknown or invalid id | `error` toast |
| Hash points to an unknown/unreadable graph | home screen + toast |
| Open graph deleted elsewhere | `graphDeleted` → home screen + toast |
| Rename to a blank name | refused |

## 8. Testing

- **shared:** `setInstructions` op; `contentSignature` includes instructions; export-file
  schema validation (accepts a valid file, rejects wrong format/version/broken graph).
- **server:**
  - `buildNodePrompt` instructions section (present/omitted).
  - Planner: `set_instructions` tool and `describeOp`.
  - `GraphStore`: rename, duplicate, delete, export, import (incl. dedupe, nodeSeq,
    authorship reset), and list fields.
  - App: message handling incl. delete-while-running refusal and `graphDeleted`.
- **web:**
  - Reducer: home/editor view from hash, `graphDeleted`.
  - Component tests: home screen (rows, last run, ⋯ actions, delete confirmation, import
    size limit); Graph tab (save only changed fields, export request).
- Component tests for the menu bar: open/close/hover-switch, disabled states for a
  representative item per menu, and that items dispatch the same actions as their buttons.
- **Visual check** in headless Chrome with screenshots: home screen, editor top bar with an
  open menu, Graph tab.

## 9. Out of scope

- Sharing through a hosted service or link; importing by URL.
- Merging an imported graph into an existing one.
- Exporting run results or chat (option C/B in the conversation).
- Undo for delete (the files are removed; git history covers committed graphs).
