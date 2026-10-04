# Agent Stream — Markdown graph files (design)

Date: 2026-10-04. Status: approved in conversation, awaiting review of this written spec.

## 1. Purpose and decisions

Today a graph is one JSON file, `.agent-stream/graphs/<id>.json`. The user wants a text form of the graph that serves four purposes at once:

1. **Hand-editing** in an editor, with the canvas following.
2. **Readable git diffs** in PRs and history.
3. **Sharing and documenting:** a diagram that renders on GitHub.
4. **Writing graphs with other AIs or scripts.**

Decisions made with the user:

- **Format A:** a Markdown file holding a Mermaid diagram for the connections and one section per step for its content. Mermaid alone was rejected, because prompts, commands and flags don't fit in node labels. YAML was rejected, because it doesn't render as a diagram.
- **The Markdown file replaces the JSON** as the saved graph. There is no second copy to keep in sync.
- **Positions and bookkeeping go in a side file** (`<id>.meta.json`), so the Markdown changes only when the graph's meaning changes.

Two refinements of the draft shown in chat, both made to avoid a YAML parser (no new dependencies) and to render better on GitHub:

- The graph's name is the `# Title`, not YAML front matter.
- The goal and variables are `##` sections.

## 2. The file format

`.agent-stream/graphs/<id>.md`. Example:

````markdown
# scd2_tests

## Goal

Prove the SCD2 model works.

## Instructions

Use the dev target. Never touch prod.

## Variables

- `target_schema`: Schema the tests write to

## Flow

```mermaid
flowchart LR
  n1["Check table absent"] --> n2["Run model"]
  n2 --> n3["Check table exists"]
```

## n1 · Check table absent

- kind: command
- access: read
- timeout: 120

> Confirms the target table doesn't exist before the first run.

```sh
dbt run-operation table_exists --args '{table: dim_customer}'
```

## n2 · Run model

- kind: agent
- workspace: wh_a

> Builds the model for the first time.

```prompt
Run `dbt run -s dim_customer` and report the row count.
```
````

### 2.1 Structure

The file is read line by line. Fenced code blocks are tracked, so a `#` inside a fence is never read as a heading.

- **`# <name>`:** the first line that is not blank. It holds the graph's display name. Exactly one H1 is allowed.
- **Reserved `##` sections**, each optional and at most once, in any order before or between steps:
  - `## Goal`: free Markdown, trimmed. Missing means empty.
  - `## Instructions`: free Markdown, trimmed. Missing means empty.
  - `## Variables`: a bullet list with one variable per bullet, `` - `name`: description ``. The description may be empty: `` - `name` ``. Variable names follow the existing variable-name rule. Values never appear in the file, because the format has no place for them.
  - `## Flow`: exactly one ```` ```mermaid ```` block (described below). Missing means no connections.
- **Step sections:** every other `##` heading.
  - `## <id> · <title>` names an existing or new step with that id. The separator is ` · ` (space, U+00B7, space).
  - Ids use the existing node-id rule.
  - A heading without the separator (`## <title>`) is a new step without an id (§3.3). A title equal to a reserved name is still a step when it carries an id.

### 2.2 A step section, in order

1. **A field list** (optional, but `kind` is written by Agent Stream): bullets `- key: value`.
   - Keys: `kind` (`agent` | `command`), `access` (`read` | `write`), `workspace` (a workspace name as today), `timeout` (a whole number of seconds, from 1 up to the existing maximum).
   - An unknown key or a bad value is an error.
   - Missing `kind`: `agent` when the step has a `prompt` block, `command` when it has an `sh` block.
   - Missing `access` means write-capable, and missing `workspace` means this checkout, both as today.
2. **A description** (optional): consecutive `>` quote lines, joined with a space and trimmed. It is one plain-language sentence, as today.
3. **Exactly one code block:**
   - Info string `prompt` for an agent step's prompt. `text` and `md` are also accepted on read.
   - Info string `sh` for a command step's command. `bash` and `shell` are also accepted on read.
   - The content is kept exactly, including Jinja, dbt `{% raw %}` blocks and inner fences.
   - The block must match `kind`. An agent step with an `sh` block is an error.
   - An empty block is allowed: an empty prompt or command, as the canvas allows today.

Any other content in a step section (a paragraph, a second code block, a sub-heading) is an error. Nothing the user wrote is ever silently dropped.

### 2.3 The Flow block

- Line-oriented Mermaid `flowchart` syntax. The first line is `flowchart LR` (or `TD`, `TB`, `RL`, `BT`, or `graph …`). The direction is ignored on read.
- Each line holds a chain of node references joined by `-->`.
- A node reference is an id, optionally followed by a label: `id`, `id["label"]`, `id("label")` or `id[label]`. Labels are ignored on read: titles come from the step headings.
- `a --> b --> c` means the edges a→b and b→c.
- Blank lines and `%%` comments are ignored.
- **Errors:**
  - any other Mermaid construct (subgraphs, `-.->`, `==>`, link text, `classDef`, `style`), so the file never holds connections Agent Stream can't represent;
  - an id with no step section;
  - an edge the graph rules refuse (a self-edge, a duplicate, or a cycle, checked the same way as the `connect` operation).
- **A step that appears in no arrow** simply has no connections. A node mentioned alone on a line is allowed and adds no edge.

## 3. Reading (parse)

### 3.1 `parseGraphMarkdown`

```ts
parseGraphMarkdown(text: string): { ok: true; doc: GraphDoc } | { ok: false; errors: { line: number; message: string }[] }
```

It lives in `shared/` (pure, no I/O), so the engine and tests use the same code.

- **`GraphDoc`** holds the meaning only: name, goal, instructions, variables, steps (id or none, title, kind, access, workspace, timeoutSec, description, prompt or command), and edges.
- **Line endings:** CRLF input is read as LF. A leading BOM is ignored.
- **Errors:** all errors found are reported, each with a 1-based line number and a message that says how to fix it. For example: `line 31: the Flow block mentions n7, but there is no "## n7 · …" step section. Add one or remove n7 from the Flow.`

### 3.2 The side file, `<id>.meta.json`

```ts
{ version: 1, nodeSeq: number, updatedAt: string,
  nodes: { [id]: { position?: Position, createdBy: Actor, updatedBy: Actor, updatedAt: string } } }
```

- **Validated with zod.** A missing or invalid side file is not an error. Positions are then placed by the existing auto-layout, actors default to `user`, timestamps default to now, and `nodeSeq` defaults to the highest `n<number>` id in use.
- **Bad entries are ignored:** an entry for an id the Markdown doesn't have, and a negative `nodeSeq`.

### 3.3 Building the `Graph`

The in-memory `Graph` type stays unchanged, so the canvas, runner, planner tools and runs keep working.

- The Markdown supplies the meaning and the side file supplies the bookkeeping.
- **A step without an id** gets `n<nodeSeq+1>`, and `nodeSeq` advances. The id is then written into the heading on the next save (§4), so ids are never reused.
- **Duplicate ids** in one file are an error.
- The graph id is the file name without `.md`, under the existing graph-id rule. A file whose name breaks that rule is listed with an error, not loaded.

## 4. Writing (serialize)

### 4.1 `serializeGraphMarkdown`

```ts
serializeGraphMarkdown(graph: Graph): string
```

It is in `shared/`, pure and deterministic.

- **Section order:** H1, Goal, Instructions, Variables, Flow, then steps in canvas order. Canvas order is the current `nodes` array order, which the canvas already keeps stable.
- **Leaving out empty sections:** an empty Goal, Instructions or Variables section is left out. Flow is always written, even with no edges, so a hand-editor sees where connections go.
- **Flow:**
  - `flowchart LR`;
  - one line per node with an outgoing edge, `a["title"] --> b["title"]`;
  - plus one line per node that has no edges at all, `a["title"]`, so the diagram shows every step;
  - edges in the order they appear in the edges array;
  - labels escaped for Mermaid: `"` becomes `#quot;`, and newlines become spaces.
- **Steps:**
  - fields in a fixed order: `kind` always; `access` only when `read`; `workspace` only when set; `timeout` only when set;
  - the description as one `>` line, only when non-empty;
  - the code block fence is the shortest run of backticks, at least 3, that is longer than any backtick run inside the content, the same rule as the Run Report's safe fences.
- **Endings:** LF line endings, and one trailing newline.

### 4.2 Stability

- `parse(serialize(g))` gives `g`'s meaning back exactly.
- `serialize(parse(serialize(g)))` gives exactly the same text as `serialize(g)`.
- A canvas edit changes only the lines that hold what was edited (plus the Flow line of a retitled step).

### 4.3 Atomic writes

The store writes the Markdown and the side file each as a temp file in the same folder followed by `rename`, so editors and watchers never read a half-written file. The side file is written first, then the Markdown.

## 5. Storage, migration, import and export

### 5.1 Files in `.agent-stream/graphs/`

| File | What | Commit? |
|---|---|---|
| `<id>.md` | the graph | yes |
| `<id>.meta.json` | positions and bookkeeping | yes (optional; without it, layout and "last edited by" fall back to defaults) |
| `<id>.ops.jsonl` | change history (unchanged) | as today |
| `<id>.baseline.json` | the user's version while agent changes wait for review (internal, stays JSON) | as today |

- `GraphStore.list()` lists `*.md` files.
- `load` parses the Markdown and the side file, and caches the result as today.
- A graph whose Markdown doesn't parse appears in the list with an error mark, and opening it shows the errors and the file (§6.3).

### 5.2 Migration

- **When:** each `<id>.json` (not `*.baseline.json`) without a matching `<id>.md` is converted the first time the folder's engine starts, next to the existing `.claude-stream` migration.
- **What it writes:** `<id>.md` and `<id>.meta.json`, then the JSON is renamed to `<id>.json.bak`, so nothing is lost and it's never converted twice.
- **What it reports:** one line in the Agent Stream output channel per converted graph.
- **Errors:** a JSON file that fails `parseGraph` is left as it is and reported. Migration never deletes data.

### 5.3 Run records

Run snapshots (`runs/<run-id>/run.json`) keep their internal JSON `Graph` snapshot. Old runs, re-runs and Run Reports are unaffected.

### 5.4 Export and import

- **Export** saves the graph's Markdown as `<id>.md`. It is the same text as the stored file, so it never contains variable values.
- **Import** accepts a `.md` file in this format and, as before, an `.agent-stream.json` export. An imported graph gets a unique id as today, and `nodeSeq` starts from its highest id.

## 6. Sync with edits made outside Agent Stream

### 6.1 Agent Stream's own edits

Canvas, planner and agent-step edits are unchanged: operations go through `GraphStore.apply`, its history and its agent-change rules, and the store writes the files (§4.3).

### 6.2 Watching the files

- **Who watches:** the extension, for each open folder, with `vscode.workspace.createFileSystemWatcher` on `.agent-stream/graphs/*.md`. That works for remote folders too.
- **What it calls:** on a create or change it calls `engine.graphFileChanged(id)`; on a delete it calls `engine.graphFileDeleted(id)`. Events are debounced per file (200 ms).
- **Ignoring its own saves:** the store remembers the exact text it last wrote for each graph. `graphFileChanged` reads the file and returns at once when the text equals that, or equals the text the cache already holds. That is how Agent Stream's own saves are ignored, with no feedback loop.

### 6.3 An outside change to the Markdown

1. **Parse.** On errors: keep the current graph, don't change any file, and publish the errors. They appear in VS Code's Problems panel for that file, with line numbers, through a `DiagnosticCollection`, and in a notice on the graph's tab saying the file has errors and the last good version is shown. The errors clear when the file parses again.
2. **Turn the edit into operations** with `diffToOps(current: Graph, doc: GraphDoc): Op[]` (in `shared/`). Nodes are matched by id.
   - **Order:**
     1. `disconnect` removed edges;
     2. `deleteNode` removed nodes;
     3. `addNode` new nodes (with their ids);
     4. `updateNode` changed nodes, with a patch of only the changed fields among title, kind, description, prompt, command, access, workspace and timeoutSec;
     5. `connect` new edges;
     6. `setGoal` and `setInstructions` when changed;
     7. variables: `deleteVariable`, `addVariable` and `setVariableDescription` by name. A renamed variable shows as a delete and an add, which is acceptable.
   - **A changed name** is applied through the store's existing rename.
3. **Apply all or nothing.** The operations are applied, as `by: 'user'`, to a copy first. If any operation fails, nothing is applied, and the failure is reported like a parse error (with the line of the step or edge when known). Otherwise they are applied for real through `GraphStore.apply`.
   - **History:** each `OpRecord` gets a new optional field `via: 'file'`. It is a history label only. `ChangeSource` is unchanged, because it names agents, and file edits are the user's.
   - **Agent changes waiting for review:** file edits are user edits, with exactly the rules a canvas edit follows today, including updating the baseline when they fit there.
4. **Normalise the file.** The store writes the result back in canonical form (§4), for example adding ids to new steps. That write is recognised as Agent Stream's own and ignored.
5. **Refresh.** The webview gets the updated graph as for any edit, and an open run dialog refreshes.
   - **Runs:** a running run keeps the snapshot it started with, as today, and the "Graph changed since this run started" note appears.

### 6.4 An outside change to the side file

The side file is re-read, and positions or bookkeeping update. No operations are recorded.

### 6.5 A deleted Markdown file

When the `.md` disappears (deleted, or a branch switch), the graph leaves the list and its open tab shows "This graph was deleted.", as for a deleted graph today. The side file, history and baseline stay. When the file comes back, the graph comes back.

### 6.6 A renamed or copied file

A renamed or copied file is a new graph whose id is the new file name. Its side file is used when it was renamed or copied too; otherwise defaults apply.

## 7. Opening the file as text

- **File › Open as Markdown** in the graph tab's menu bar, the same item on a graph's right-click menu in the Graphs sidebar, and a command palette entry `Agent Stream: Open Graph as Markdown`.
- It opens `<id>.md` in a text editor in the column beside the graph tab.
- Saving in that editor goes through §6.3.

## 8. Planner and other AIs

- **The planner** keeps its graph tools (operations). No prompt change is needed: its edits are written to the Markdown like any other.
- **Other AIs and scripts** write or edit `<id>.md` directly, and the file watcher applies their edits.
- **Docs:**
  - a new `docs/graph-format.md` with a full example and every rule in §2;
  - a short "Graph files" section in both READMEs that links to it;
  - the "Files it writes" table updated.
- **Errors** are written so an AI can fix the file from the message alone.

## 9. Testing

All tests use temp folders and no network. They pass on Windows, macOS and Linux CI.

- **`shared`, parse:**
  - every rule in §2: each field, defaults, reserved sections, id-less headings, ids in headings;
  - Flow chains, labels, comments and directions;
  - every listed error, with its line number;
  - CRLF and BOM input;
  - prompts containing ``` and ```` fences, Jinja and `{% raw %}`;
  - Unicode titles;
  - an empty graph (H1 only).
- **`shared`, round trip:**
  - `parse(serialize(g))` equals `g`'s meaning, and serialize is stable, for every graph fixture in the existing tests plus generated graphs (random steps, edges, fields and prompt contents);
  - a single canvas edit changes only the expected lines.
- **`shared`, `diffToOps`:** one test per operation kind, the order of operations, the variable delete-then-add case, and no operations for identical input.
- **`engine`:**
  - store load and save of `.md` + `.meta.json` (atomic, side file defaults);
  - list with a broken file;
  - `graphFileChanged`: ignores its own writes, applies outside edits as `via: 'file'`, all or nothing on failure, normalises ids, keeps the baseline rules;
  - `graphFileDeleted`;
  - migration (`.json` → `.md` + `.meta.json` + `.json.bak`, idempotent, a bad JSON left alone);
  - export/import of `.md` and legacy JSON;
  - every existing graphStore, app and planner test kept passing.
- **`extension`:**
  - the watcher wiring (debounce, the calls to the engine);
  - diagnostics published and cleared;
  - the Open as Markdown command and menu items;
  - the integration suite (open a folder with a JSON graph, see it migrated, edit the `.md`, see the change).
- **`web`:** the error notice on a graph tab, and the menu item.

## 10. Out of scope

- Other formats (YAML, plain Mermaid files).
- Visual editing of the Mermaid diagram inside Markdown preview.
- Run history in the Markdown.
- Detecting variable renames in hand edits.
- Concurrent multi-user editing beyond "last write wins, then the watcher applies it". A file edit and a canvas edit in the same 200 ms window resolve as two consecutive edits.
