# Agent Stream — Markdown Graph Files Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each graph is saved as a Markdown file, `.agent-stream/graphs/<id>.md` (a Mermaid Flow plus one section per step), with positions and bookkeeping in `<id>.meta.json`; edits made to the file outside Agent Stream flow into the graph as user operations, and existing JSON graphs are converted on first start.

**Architecture:**
- **Shared (pure, no I/O):**
  - `fence.ts`: code-fence helpers, moved out of the Run Report so both use one copy;
  - `graphFlow.ts`: the Flow block parser (`parseChain`, `parseFlow`);
  - `graphDoc.ts`: `GraphDoc` and friends, `canonicalGraph`, `formatFileErrors`;
  - `freeText.ts`: escaping for Goal and Instructions text;
  - `graphMarkdownParse.ts`: `parseGraphMarkdown`, hand-written and line-based;
  - `graphMarkdownWrite.ts`: `serializeGraphMarkdown`;
  - `graphMeta.ts`: the side file (zod), `graphFromDoc`, `withMeta`;
  - `diffToOps.ts`: `diffToOps`, `opLine`.
- **Engine:**
  - `GraphStore` reads and writes `<id>.md` + `<id>.meta.json`, always in canonical form;
  - `graphFileChanged` / `graphFileDeleted` turn outside edits into user operations (`via: 'file'`), all or nothing;
  - `migrateGraphsToMarkdown` converts `<id>.json` on startup;
  - the App broadcasts `graphFileErrors` and `graphDeleted { reason: 'file' }`.
- **Extension:**
  - graph tabs open `<id>.md` (custom editor `priority: "option"`);
  - **Open Graph as Markdown**;
  - a debounced `FileSystemWatcher` per folder;
  - a `DiagnosticCollection` for file errors;
  - an **Agent Stream** output channel for conversion notes.
- **Web:** the file-error notice and the "This graph was deleted." notice on the graph tab, **File › Open as Markdown**, and reopening a graph whose file came back.

**Tech Stack:** TypeScript 7 (strict, noEmit), npm workspaces (`shared`, `engine`, `web`, `extension`), Vitest 5, zod 4.6.5 (already a dependency of `shared`), React 19, VS Code extension API (`createFileSystemWatcher`, `RelativePattern`, `languages.createDiagnosticCollection`, `createOutputChannel`). No new runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-10-04-agent-stream-markdown-graphs-design.md` (committed at f993b78). It is the binding authority, and every section number below (§n) refers to it.

**Order:**
- Shared groundwork: fences, types, the timeout-clearing patch, the web state for file errors (Task 1).
- The Flow parser (Task 2), the document parser (Task 3), the serializer, canonical form and side file (Task 4), `diffToOps` (Task 5).
- The store on Markdown, with migration, export and import (Task 6); outside edits (Task 7); the App's messages (Task 8).
- The extension: graph tabs on `.md` and Open as Markdown (Task 9); the watcher, diagnostics and output channel (Task 10).
- The web notices, menu item and reopen (Task 11). The integration check, the docs and the full verification (Task 12).

**Code in this plan:** new files are given in full. Changes to existing files are unified diffs against the file as the previous task left it (the `index` lines are left out). Apply a diff by hand, or save the block to a file outside the repo (your scratchpad) and run `git apply <file>` from the repo root; if `git apply` refuses a hunk, stop and report rather than editing around it.

**Planning rulings** (decided while writing this plan; each costs a small rework if wrong):
- **R1. Graph tabs no longer open by default.** The custom editor's selector becomes `**/.agent-stream/graphs/*.md` with `"priority": "option"`. With `default`, a plain open (Explorer, Quick Open) and VS Code's Source Control diff of a graph file would show the canvas, which defeats hand-editing and readable diffs (§1 purposes 1 and 2). Graph tabs still open from the sidebar, commands and sessions, which use `vscode.openWith`. A tab restored from before still points at `<id>.json`; `graphTarget` maps that to the same graph. Both `workspaceContains` activation events are kept (`*.md` and `*.json`, so a folder with only old files activates and is converted).
- **R2. Flow: one line per edge.** §4.1 says "one line per node with an outgoing edge, `a["title"] --> b["title"]`", which can't hold two edges from one node without Mermaid's `&` (refused on read, §2.3). Each edge gets its own line, labels on both ends, in the edges array's order; then one line per step with no edges at all. The spec's example (which writes `n2 --> n3[...]` without n2's label) is only illustrative.
- **R3. Timeouts.** There is no "existing maximum" in the code (the schema only says positive). The maximum is `MAX_TIMEOUT_SEC = 2_147_483`: Node's longest timer in seconds (the shell runner uses `setTimeout(timeoutSec * 1000)`). A stored non-integer timeout (the Node panel accepts `1.5`) is rounded up on save.
- **R4. The store keeps graphs in canonical form** (`canonicalGraph`): what reading the two files gives back. One-line names, titles, variable descriptions and step descriptions; trimmed goal and instructions; LF; only the text of the step's kind (a prompt for an agent step, a command for a command step), absent when empty; `access` only for read-only agent steps; whole-second timeouts; `nodeSeq` at least the highest `n<number>`. `save` returns it, and `apply` returns and emits it, so the cache, the baseline and the webview always hold what a reload would. The visible change: switching a step's kind on the canvas drops the other kind's text instead of keeping it hidden. Baselines are canonicalized when written and read, so an old baseline with a hidden `command` on an agent step doesn't show a phantom agent change.
- **R5. Goal and Instructions are escaped so they read back exactly.** A line that would read as an H1/H2 heading, an already escaped fence line, or the opening of a fence that is never closed gets one leading backslash on write; the reader removes it. Markdown renders those lines as the text they were.
- **R6. While the Markdown file has errors, edits that would rewrite it are refused** (every `apply` but `moveNode`, plus Revert and Rename; Accept and Duplicate still work) with `The file <id>.md has errors (line N: …). Fix it first: until then this graph can't be changed here.` Otherwise a canvas or planner edit would overwrite the user's half-finished hand edit ("nothing the user wrote is ever silently dropped").
- **R7. `load()` handles an outside change like the watcher.** When a cached graph's files changed on disk, `load` calls `graphFileChanged` before returning. Otherwise whichever reader came first (a tab opening, a canvas edit inside the 200 ms debounce) would cache the new text, and the watcher's "same as the cache" check would then skip the edit's history, baseline rules and normalisation.
- **R8. The watcher also watches `<id>.meta.json`** (glob `.agent-stream/graphs/*.{md,meta.json}`), debounced on the same per-graph key: §6.4 needs someone to notice side-file changes. Both kinds of event call `graphFileChanged`, which tells them apart by text.
- **R9. A deleted Markdown file keeps the tab open.** The engine sends `graphDeleted` with `reason: 'file'`; the extension doesn't close the tab (it still does for Delete Graph), the tab shows "This graph was deleted.", and when the list has the graph again (readable) the tab opens it again. `graphFileDeleted` checks that the file is really gone: an editor's save by rename can report delete, then create.
- **R10. A graph that can't be read at all** (broken from the start) opens its Markdown file from the sidebar (its tree item's click and right-click), with its errors in the Problems panel. There is no graph to show in a tab.
- **R11. Headings.** Reserved names (`Goal`, `Instructions`, `Variables`, `Flow`) are matched in any letter case. A step heading has an id when it matches `^<id chars> ·( <title>)?$`; anything else is a title without an id (so `Check · Verify` names step `Check`). An id with an empty title is an error.
- **R12. Text before the first `##` section** (between the name and the first section, or before the name) is an error, as is any content the format has no place for.
- **R13. `updateNode` with `timeoutSec: 0` clears the timeout.** `NodePatch` had no way to remove a timeout, and a hand edit that deletes the `timeout` line needs one. Client messages still require a positive timeout.
- **R14. Import:** content that starts with `{` (after a BOM and whitespace) is read as an `.agent-stream.json` export; anything else as Markdown. Both get a unique id as today.
- **R15. Migration** runs after the legacy planner-state move (which reads `<id>.json`), writes through the store, and reports to a new **Agent Stream** output channel through `App.startupNotes()` and a new optional `EngineEvents.log`. A JSON file that can't be read becomes a startup warning, as the other migrations do.
- **R16. The parser doesn't check description length.** `applyOp` does (2000 characters), so a too-long description in a hand edit fails the edit as a whole, which is also how the all-or-nothing path gets a natural test. A graph read fresh from disk keeps such a description.
- **R17. Order in the file is not applied.** Reordering step sections or variables changes nothing; the file is written back in canvas order. New steps go last.
- **R18. Fences:** ```` ``` ```` and `~~~` fences, up to 3 spaces of indentation, closed by the same character at least as long (CommonMark). Block content is kept exactly as written; info strings are matched in any case. Flow headers may leave out the direction, and a trailing `;` is accepted.
- **R19. New `EngineEvents` members are optional** (`graphFileErrors?`, `log?`), so the many test literals of `EngineEvents` stay as they are.
- **R20. The spec's example in §2 leaves out the `## n3` section its Flow mentions, and gives n1 (a command step) `access: read`;** as written it doesn't parse. `docs/graph-format.md` gets a complete example, and a test keeps that example readable and canonical.

## Global Constraints

- TypeScript strict everywhere. `npm run typecheck` passes after every task.
- `engine/` and `shared/` never import `vscode`. `shared/` has no Node types: tests that read files belong in `engine/test`.
- No new runtime dependencies. No YAML or Markdown parser library: the parser is hand-written and line-based (§1). zod is already a `shared` dependency.
- Node ≥ 20.11 (root `package.json` `engines`).
- Windows: paths are built with `path.join`/`path.resolve`; the parser reads CRLF as LF and drops a BOM; written files use LF. Tests build paths with `join`, and every test that edits a file outside the store changes its size, so the stamp check notices it on any file system.
- Tests use temp folders (`tmpProject()`, `mkdtempSync`) and no network. No test runs real git, Claude, Codex or Copilot.
- The repo is public: no credentials, emails or absolute home paths in code, tests or fixtures.
- Existing tests keep their assertions. The exceptions are named in the task that changes them, each forced by the file format: an expected `.json` file name becoming `.md`, an export's file name and content, the import error for non-JSON content, a test that relied on a hidden `command` on an agent step, the unreadable tree item now having a command, the File menu's new item, and the not-a-graph text. If any other existing test fails, stop and report it instead of changing its assertion.
- Exact user-facing strings:
  - Command: `agentStream.openGraphMarkdown`, title `Open Graph as Markdown`, category `Agent Stream` (palette: `Agent Stream: Open Graph as Markdown`). Graph tab menu item and tree item title: `Open as Markdown`.
  - Notice (§6.3): `` `The file ${id}.md has errors, so the last good version is shown. ${formatFileErrors(errors)} ` `` followed by an `Open as Markdown` link button. `formatFileErrors` writes `line N: message`, plus ` (and K more)` when there are more.
  - Deleted (§6.5): `This graph was deleted.`
  - Refusal (R6): `` `The file ${id}.md has errors (${formatFileErrors(errors)}). Fix it first: until then this graph can't be changed here.` ``
  - Migration note: `` `Converted the graph "${name}" to ${id}.md; the old file is kept as ${id}.json.bak.` ``; warnings: `` `Could not convert the graph file ${id}.json to Markdown (${why}); it was left as it is.` `` and `` `Converted the graph "${name}" to ${id}.md, but could not rename ${id}.json to ${id}.json.bak (${why}). Delete ${id}.json when you no longer need it.` ``
  - Import error prefix: `The file is not a valid Agent Stream graph: ` + up to three problems. Export: `<id>.md`, info `` `Exported ${fileName}. Variable values were left out.` `` (unchanged wording).
  - The spec's own error example, verbatim: `the Flow block mentions n7, but there is no "## n7 · …" step section. Add one or remove n7 from the Flow.` Every parse message says how to fix the file; the exact texts are pinned by the Task 2 and Task 3 tests.
  - Output channel `Agent Stream`; diagnostic collection `agent-stream`, diagnostic source `Agent Stream`.
- Run every command from the repo root, on branch `feat/markdown-graphs`.
  - Never push. Never run `npm run package`. Never set `AGENT_STREAM_LIVE`.
  - Don't touch or stage `logs/`, `.DS_Store`, `.agent-stream/` or `.superpowers/`. Stage files by name only (`git add <paths>`), never `git add -A` or `git add .`.
- Every commit message ends with a `Co-Authored-By:` trailer naming the model that wrote that commit. The commit steps below show `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; a different model writes its own name instead.

## Review Focus

Five failure modes the spec implies but no task's main tests would naturally exercise, most likely first. Each is pinned by a test in the task that owns the code.

1. **A canvas or planner edit while the user is halfway through a hand edit.** The file has errors; the user clicks something on the canvas. Agent Stream must not write the last good version over their unfinished file (moving a step may still save the side file). Pinned in Task 7: `graphFileSync.test.ts` › "keeps the graph and the file as they are when the file has errors, until it is fixed".
2. **Agent Stream's own saves, and saves by rename, read back as outside edits.** A store save must not come back as a second edit or a loop, and an editor that saves by delete-then-create must not make the graph vanish. Pinned in Task 7: › "ignores the store's own saves" and › "treats a delete report for a file that is there as a change"; Task 10: `graphFiles.test.ts` › "debounces per graph and tells the engine once, the last event winning".
3. **Goal, instructions or prompts holding Markdown that looks like structure.** A goal with `## Notes`, an unclosed ```` ``` ````, a prompt with ```` ``` ```` or ```` ```` ```` lines, `{% raw %}`, `\r\n`. Each must come back exactly, and the file must stay stable. Pinned in Task 3: › "free text escapes"; Task 4: `graphMarkdownWrite.test.ts` › "gives generated graphs back exactly (300 seeds)" (the generator mixes those texts in).
4. **An outside edit noticed by something other than the watcher.** A tab opens, or a canvas edit lands, inside the 200 ms debounce. The edit must still be recorded as the user's (history, baseline, ids), not silently absorbed into the cache. Pinned in Task 7: › "notices an outside edit on load, before any watcher reports it".
5. **Old graphs and baselines with hidden fields.** An agent step that kept a `command` from before a kind switch: after the switch to Markdown it must not show as a phantom agent change, and the saved file must equal what a reload gives. Pinned in Task 6: `graphFiles.test.ts` › "saves the canonical form: only the text of the step kind, whole-second timeouts, one-line titles".

## File map

| File | Responsibility | Task |
|---|---|---|
| `shared/src/fence.ts` | `longestRun`, `fenceFor`, `fenceOpening`, `fenceCloses`, `Fence` | 1 |
| `engine/src/runReport.ts` | uses `fenceFor`/`longestRun` from shared | 1 |
| `shared/src/types.ts` | `GraphFileError`, `OpRecord.via`, `graphDeleted.reason`, `graphOpened.fileErrors`, `graphFileErrors`, `HostCommand` `openGraphMarkdown` | 1 |
| `shared/src/schemas.ts` | host command `openGraphMarkdown` | 1 |
| `shared/src/graph.ts` | `seqOf` exported; `timeoutSec: 0` clears (R13) | 1 |
| `web/src/state.ts` | `fileErrors`, `graphGone` | 1 |
| `shared/src/graphFlow.ts` | `parseChain`, `parseFlow`, `FlowLine`, `FlowEdge`, `ONLY_ARROWS` | 2 |
| `shared/src/graphDoc.ts` | `DocStep`, `DocVariable`, `GraphDoc`, `ParseGraphResult`, `MAX_TIMEOUT_SEC`, `STEP_SEPARATOR`, `normText`, `oneLine`, `timeoutValue`, `formatFileErrors` (3); `canonicalGraph` (4) | 3, 4 |
| `shared/src/freeText.ts` | `escapeFreeText`, `unescapeFreeTextLine` | 3 |
| `shared/src/graphMarkdownParse.ts` | `parseGraphMarkdown` | 3 |
| `shared/src/graphMeta.ts` | `GraphMeta`, `GraphMetaNode`, `GraphMetaFile`, `parseGraphMeta`, `metaOf`, `serializeGraphMeta`, `withMeta`, `graphFromDoc` | 4 |
| `shared/src/graphMarkdownWrite.ts` | `serializeGraphMarkdown`, `mermaidLabel` | 4 |
| `shared/test/graphFixtures.ts` | `FIXTURES`, `randomGraph`, `rng`, `build`, `T0` | 4 |
| `shared/src/diffToOps.ts` | `diffToOps`, `opLine` | 5 |
| `shared/src/index.ts` | exports | 1–5 |
| `engine/src/graphStore.ts` | `.md` + `.meta.json`, canonical saves, export/import, `writeConverted`, `fileErrors` (6); `graphFileChanged`, `graphFileDeleted`, `FileSync`, `applyOne`, refusal (7) | 6, 7 |
| `engine/src/migrate.ts` | `migrateGraphsToMarkdown` | 6 |
| `engine/src/app.ts` | migration call, `startupNotes` (6); `graphFileChanged`, `graphFileDeleted`, broadcasts, `graphOpened.fileErrors` (8) | 6, 8 |
| `extension/src/commands.ts` | export as Markdown (6); `openGraphMarkdown`, `CommandDeps.openText`, `pickGraph(withUnreadable)` (9) | 6, 9 |
| `extension/src/ui.ts` | Import accepts `.md` | 6 |
| `extension/src/graphEditor.ts` | `.md` graph files | 9 |
| `extension/src/graphsView.ts` | unreadable item opens its Markdown | 9 |
| `extension/package.json` | selector, priority, activation, command, menu | 9 |
| `extension/src/graphFiles.ts` | `GraphFileWatcher`, `graphIdOfFile`, `publishGraphFileErrors`, `toDiagnostic`, constants | 10 |
| `extension/src/engines.ts` | `graphDeleted` reason, `graphFileErrors?`, `log?` | 10 |
| `extension/src/extension.ts` | `openText` (9); output channel, diagnostics, watcher, deleted-file tabs (10) | 9, 10 |
| `extension/test/vscode.ts` | `Range`, `Diagnostic`, `DiagnosticSeverity`, `RelativePattern` | 10 |
| `web/src/components/GraphFileNotice.tsx`, `web/src/App.tsx`, `web/src/menuModel.ts`, `web/src/bridge.ts` | notices, menu item, reopen | 11 |
| `extension/test/integration/*`, `docs/graph-format.md`, `README.md`, `extension/README.md`, `engine/test/graphFormatDoc.test.ts` | integration check, docs | 12 |

**How the pieces talk (read this before any task):**
- `parseGraphMarkdown(text)` → `GraphDoc` (meaning only, with line numbers) or errors. `graphFromDoc(doc, parseGraphMeta(metaText), id, now)` → `Graph`, giving id-less steps `n<nodeSeq+1>`. `serializeGraphMarkdown(graph)` and `serializeGraphMeta(graph)` write the two files. For any graph `g`: `graphFromDoc(parse(serialize(g)), parseGraphMeta(serializeGraphMeta(g)), g.id, now)` equals `canonicalGraph(g)`, and serializing that gives the same text.
- The store's cache holds, per graph, the canonical graph and the exact text of both files with their mtime and size. Every `save` writes the side file first, then the Markdown (each through `writeFileAtomic`), skipping a file whose text wouldn't change, and remembers the Markdown text it wrote.
- An outside change reaches `graphFileChanged(id)` from the extension's watcher (debounced 200 ms) or from `load()` (R7). Same text as the cache or as the last write: ignored (a side-file-only change re-reads bookkeeping). Otherwise: parse → `diffToOps(current, doc)` → dry run with `applyOp` on a copy → the real run through `applyOne` (baseline rules), recorded `via: 'file'` → rename if the name changed → `save` (normalises the file) → one `changed` event and an `op` event per operation.
- Errors stay in the store (`fileErrors(id)`, `fileErrors` event). The App broadcasts them as `graphFileErrors` and puts them in `graphOpened.fileErrors`. The extension turns them into diagnostics on `<id>.md`; the web shows the notice.

---
### Task 1: Shared groundwork: fences, message types, clearing a timeout, file-error state

**Spec tests owned (§9):** none directly; this task makes room for them (the Run Report's safe-fence helper becomes the one copy the serializer uses, §4.1).

**Files:**
- Create: `shared/src/fence.ts`, `shared/test/fence.test.ts`
- Modify: `shared/src/index.ts`, `shared/src/types.ts`, `shared/src/schemas.ts`, `shared/src/graph.ts`, `engine/src/runReport.ts`, `web/src/state.ts`
- Test: `shared/test/graph.test.ts`, `shared/test/schemas.test.ts`, `web/test/state.test.ts` (append)

**Interfaces:**
- Consumes: nothing new.
- Produces:
  ```ts
  // shared/src/fence.ts
  export type Fence = { char: '`' | '~'; len: number };
  export function longestRun(text: string, ch: string): number;
  export function fenceFor(content: string): string; // shortest backtick fence (≥3) longer than any backtick run in content
  export function fenceOpening(line: string): (Fence & { info: string }) | null;
  export function fenceCloses(line: string, open: Fence): boolean;
  // shared/src/types.ts
  export type GraphFileError = { line: number; message: string };
  export type OpRecord = { at: string; by: Actor; op: Op; source?: ChangeSource; via?: 'file' };
  // ServerMessage: graphDeleted gains reason?: 'file'; graphOpened gains fileErrors?: GraphFileError[];
  //   new { type: 'graphFileErrors'; graphId: string; errors: GraphFileError[] }
  // HostCommand gains 'openGraphMarkdown' (schemas.ts accepts it).
  // shared/src/graph.ts
  export function seqOf(id: string): number; // n12 → 12, other ids → 0 (was private)
  // applyOp updateNode: patch.timeoutSec === 0 removes the timeout (R13).
  // web/src/state.ts: State gains fileErrors: GraphFileError[] (initial []) and graphGone?: boolean.
  ```

- [ ] **Step 1: Write the failing tests**

Create `shared/test/fence.test.ts`:

``````ts
import { describe, expect, it } from 'vitest';
import { fenceCloses, fenceFor, fenceOpening, longestRun } from '../src/fence';

describe('code fences', () => {
  it('picks the shortest backtick fence longer than any backtick run inside', () => {
    expect(fenceFor('plain')).toBe('```');
    expect(fenceFor('')).toBe('```');
    expect(fenceFor('a `` b')).toBe('```');
    expect(fenceFor('a ``` b')).toBe('````');
    expect(fenceFor('````\nx\n````')).toBe('`````');
    expect(longestRun('a``b`', '`')).toBe(2);
    expect(longestRun('', '`')).toBe(0);
  });

  it('recognises an opening fence and its info string as CommonMark does', () => {
    expect(fenceOpening('```prompt')).toEqual({ char: '`', len: 3, info: 'prompt' });
    expect(fenceOpening('  ~~~~ sh extra ')).toEqual({ char: '~', len: 4, info: 'sh extra' });
    expect(fenceOpening('````')).toEqual({ char: '`', len: 4, info: '' });
    expect(fenceOpening('    ```')).toBeNull();
    expect(fenceOpening('``` a`b')).toBeNull();
    expect(fenceOpening('``')).toBeNull();
    expect(fenceOpening('\\```')).toBeNull();
  });

  it('closes a fence only with the same character, at least as many, and nothing after', () => {
    const open = { char: '`' as const, len: 4 };
    expect(fenceCloses('````', open)).toBe(true);
    expect(fenceCloses('   `````  ', open)).toBe(true);
    expect(fenceCloses('```', open)).toBe(false);
    expect(fenceCloses('~~~~', open)).toBe(false);
    expect(fenceCloses('```` x', open)).toBe(false);
  });
});
``````

Append to the end of `shared/test/graph.test.ts`, after one blank line:

```ts
describe('updateNode timeouts', () => {
  it('sets a timeout, keeps it when the patch has none, and clears it with 0', () => {
    const g = build([cmd('a', 'make')]);
    const set = applyOp(g, { type: 'updateNode', id: 'n1', patch: { timeoutSec: 30 } }, 'user', T2);
    if (!set.ok) throw new Error(set.error);
    expect(set.graph.nodes[0].timeoutSec).toBe(30);
    const kept = applyOp(set.graph, { type: 'updateNode', id: 'n1', patch: { title: 'b' } }, 'user', T2);
    expect(kept.ok && kept.graph.nodes[0].timeoutSec).toBe(30);
    const cleared = applyOp(set.graph, { type: 'updateNode', id: 'n1', patch: { timeoutSec: 0 } }, 'user', T2);
    expect(cleared.ok && 'timeoutSec' in cleared.graph.nodes[0]).toBe(false);
  });
});
```

Append to the end of `shared/test/schemas.test.ts`, after one blank line:

```ts
describe('Open as Markdown', () => {
  it('is a host command a graph tab may send', () => {
    expect(parseWebviewMessage({ type: 'host', command: 'openGraphMarkdown' })).toEqual({ ok: true, kind: 'host', msg: { type: 'host', command: 'openGraphMarkdown' } });
  });
});
```

Append to the end of `web/test/state.test.ts`, after one blank line:

```ts
describe('the graph file', () => {
  const errors = [{ line: 4, message: 'kind is "robot"; use agent or command.' }];

  it("keeps the open graph's file errors until they clear or another graph opens", () => {
    const s = apply(opened(graph('a')), server({ type: 'graphFileErrors', graphId: 'a', errors }));
    expect(s.fileErrors).toEqual(errors);
    expect(reduce(s, server({ type: 'graphFileErrors', graphId: 'b', errors: [] })).fileErrors).toEqual(errors);
    expect(reduce(s, server({ type: 'graphFileErrors', graphId: 'a', errors: [] })).fileErrors).toEqual([]);
    expect(reduce(s, opened(graph('a'), { fileErrors: errors })).fileErrors).toEqual(errors);
    expect(reduce(s, opened(graph('b'))).fileErrors).toEqual([]);
  });

  it('marks the graph gone, without a toast, when its file is deleted; opening it again clears that', () => {
    const s = apply(opened(graph('a', ['n1'])), server({ type: 'graphFileErrors', graphId: 'a', errors }));
    const gone = reduce(s, server({ type: 'graphDeleted', graphId: 'a', reason: 'file' }));
    expect([gone.graph, gone.graphGone, gone.fileErrors, gone.toast]).toEqual([undefined, true, [], undefined]);
    expect(reduce(gone, opened(graph('a'))).graphGone).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w shared -- test/fence.test.ts test/graph.test.ts test/schemas.test.ts && npm test -w web -- test/state.test.ts`
Expected: FAIL. `../src/fence` doesn't exist; the timeout stays at 30; `openGraphMarkdown` is refused; `fileErrors` is undefined.

- [ ] **Step 3: Add the fence helpers and reuse them in the Run Report**

Create `shared/src/fence.ts`:

```ts
/** A Markdown code fence: its character and length (CommonMark fenced code blocks). */
export type Fence = { char: '`' | '~'; len: number };

/** The longest run of `ch` in `text`; 0 when there is none. */
export function longestRun(text: string, ch: string): number {
  let best = 0;
  let run = 0;
  for (const c of text) {
    run = c === ch ? run + 1 : 0;
    if (run > best) best = run;
  }
  return best;
}

/** The shortest backtick fence, at least 3, that is longer than any backtick run in `content`, so the content can't close it. */
export function fenceFor(content: string): string {
  return '`'.repeat(Math.max(3, longestRun(content, '`') + 1));
}

const OPEN_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const CLOSE_RE = /^ {0,3}(`+|~+)[ \t]*$/;

/** The fence `line` opens, with its info string, or null. A backtick fence's info string can't hold a backtick. */
export function fenceOpening(line: string): (Fence & { info: string }) | null {
  const m = OPEN_RE.exec(line);
  if (!m) return null;
  const char = m[1][0] as Fence['char'];
  if (char === '`' && m[2].includes('`')) return null;
  return { char, len: m[1].length, info: m[2].trim() };
}

/** Whether `line` closes `open`: the same character, at least as many, and nothing after them. */
export function fenceCloses(line: string, open: Fence): boolean {
  const m = CLOSE_RE.exec(line);
  return !!m && m[1][0] === open.char && m[1].length >= open.len;
}
```

Apply to `shared/src/index.ts` (the `graphFlow` line in later diffs follows this one):

```diff
diff --git a/shared/src/index.ts b/shared/src/index.ts
--- a/shared/src/index.ts
+++ b/shared/src/index.ts
@@ -8,3 +8,4 @@ export * from './changes';
 export * from './access';
 export * from './checkout';
 export * from './models';
+export * from './fence';
```

Apply to `engine/src/runReport.ts` (its local `longestRun` goes; `fenced` keeps its behaviour):

```diff
diff --git a/engine/src/runReport.ts b/engine/src/runReport.ts
--- a/engine/src/runReport.ts
+++ b/engine/src/runReport.ts
@@ -1,4 +1,4 @@
-import { fmtDuration, PROVIDER_NAMES, statusLabel, supportsEffort, topoOrder, type GraphNode, type NodeEvent, type NodeRunState, type NodeUsage, type RunMeta } from '@agent-stream/shared';
+import { fenceFor, fmtDuration, longestRun, PROVIDER_NAMES, statusLabel, supportsEffort, topoOrder, type GraphNode, type NodeEvent, type NodeRunState, type NodeUsage, type RunMeta } from '@agent-stream/shared';
 
 /** One step's records: its events in the order they happened, its output text and where the full output is kept. */
 export type RunReportStep = { events: NodeEvent[]; output?: string; outputPath?: string };
@@ -25,11 +25,9 @@ function cut(text: string, max: number): { text: string; cut: boolean } {
   return { text: `${text.slice(0, end)}…`, cut: true };
 }
 
-const longestRun = (text: string, ch: string): number => Math.max(0, ...[...text.matchAll(new RegExp(`\\${ch}+`, 'g'))].map((m) => m[0].length));
-
 /** A fenced code block whose fence is longer than any backtick run inside, so the content can't close it. */
 export function fenced(content: string, indent = ''): string {
-  const fence = '`'.repeat(Math.max(3, longestRun(content, '`') + 1));
+  const fence = fenceFor(content);
   const body = content.replace(/\r\n?/g, '\n').replace(/\n$/, '');
   return [fence, ...body.split('\n'), fence].map((line) => (line ? indent + line : line)).join('\n');
 }
```

- [ ] **Step 4: Add the message types, the host command and timeout clearing**

Apply to `shared/src/types.ts`:

```diff
diff --git a/shared/src/types.ts b/shared/src/types.ts
--- a/shared/src/types.ts
+++ b/shared/src/types.ts
@@ -62,6 +62,7 @@ export type NodePatch = {
   description?: string;
   prompt?: string;
   command?: string;
+  /** 0 clears the timeout (a hand edit removed it from the graph's Markdown file). */
   timeoutSec?: number;
   /** 'read': an agent step that only reads and reports (spec §3.1). Missing means it can change files. */
   access?: NodeAccess;
@@ -89,7 +90,11 @@ export type Op =
 /** Which agent made an edit: the planner (in a work session) or an agent step during a run. */
 export type ChangeSource = { kind: 'planner'; sessionId?: string } | { kind: 'step'; runId: string; nodeId: string };
 
-export type OpRecord = { at: string; by: Actor; op: Op; source?: ChangeSource };
+/** `via: 'file'`: the edit came from the graph's Markdown file (Markdown graph files spec §6.3). A history label only. */
+export type OpRecord = { at: string; by: Actor; op: Op; source?: ChangeSource; via?: 'file' };
+
+/** One problem in a graph's Markdown file: its 1-based line and a message that says how to fix it. */
+export type GraphFileError = { line: number; message: string };
 
 export type ChangeTarget = { kind: 'node'; id: string } | { kind: 'edge'; id: string } | { kind: 'all' };
 
@@ -301,9 +306,12 @@ export type ServerMessage =
   | { type: 'auth'; status: ProviderStatus }
   | { type: 'hello'; status: ProviderStatus; project: string; graphs: GraphListItem[]; approvals: ApprovalRequest[] }
   | { type: 'graphs'; graphs: GraphListItem[] }
-  | { type: 'graphDeleted'; graphId: string }
+  /** `reason: 'file'`: the graph's Markdown file disappeared (deleted, or a branch switch); the tab stays open and the graph comes back with the file. */
+  | { type: 'graphDeleted'; graphId: string; reason?: 'file' }
   /** `baseline` is the user's graph before pending agent changes (absent when there are none); `changes` lists them. */
-  | { type: 'graphOpened'; graph: Graph; runs: RunSummary[]; run?: RunMeta; variableValues: Record<string, string>; baseline?: Graph; changes: AgentChange[] }
+  | { type: 'graphOpened'; graph: Graph; runs: RunSummary[]; run?: RunMeta; variableValues: Record<string, string>; baseline?: Graph; changes: AgentChange[]; fileErrors?: GraphFileError[] }
+  /** The graph's Markdown file has these problems, so the graph shown is the last good version; [] when they are fixed. */
+  | { type: 'graphFileErrors'; graphId: string; errors: GraphFileError[] }
   | { type: 'graph'; graph: Graph; baseline?: Graph; changes: AgentChange[] }
   | { type: 'opRejected'; graphId: string; error: string }
   | { type: 'runs'; graphId: string; runs: RunSummary[] }
@@ -366,7 +374,7 @@ export type ClientMessage =
 /** Graph actions that need VS Code's own UI (input box, file dialogs, confirmations, quick pick). */
 export type ChatTarget = { graphId: string; graphName: string; sessionId: string; sessionName: string };
 
-export type HostCommand = 'newGraph' | 'openGraph' | 'importGraph' | 'exportGraph' | 'renameGraph' | 'duplicateGraph' | 'deleteGraph' | 'showSidebar' | 'focusChat';
+export type HostCommand = 'newGraph' | 'openGraph' | 'importGraph' | 'exportGraph' | 'renameGraph' | 'duplicateGraph' | 'deleteGraph' | 'showSidebar' | 'focusChat' | 'openGraphMarkdown';
 
 /** Messages a graph tab sends that the extension handles itself (not the engine). */
 export type WebviewHostMessage =
```

Apply to `shared/src/schemas.ts`:

```diff
diff --git a/shared/src/schemas.ts b/shared/src/schemas.ts
--- a/shared/src/schemas.ts
+++ b/shared/src/schemas.ts
@@ -135,7 +135,7 @@ const clientMessageSchema = z.discriminatedUnion('type', [
   z.object({ type: z.literal('decide'), approvalId: z.string(), decision: z.enum(['approve', 'deny']), note: z.string().optional() }),
 ]);
 
-const hostCommand = z.enum(['newGraph', 'openGraph', 'importGraph', 'exportGraph', 'renameGraph', 'duplicateGraph', 'deleteGraph', 'showSidebar', 'focusChat']);
+const hostCommand = z.enum(['newGraph', 'openGraph', 'importGraph', 'exportGraph', 'renameGraph', 'duplicateGraph', 'deleteGraph', 'showSidebar', 'focusChat', 'openGraphMarkdown']);
 const webviewHostSchema = z.discriminatedUnion('type', [
   z.object({ type: z.literal('ready') }),
   z.object({ type: z.literal('opened'), graphId: z.string() }),
```

Apply to `shared/src/graph.ts`:

```diff
diff --git a/shared/src/graph.ts b/shared/src/graph.ts
--- a/shared/src/graph.ts
+++ b/shared/src/graph.ts
@@ -25,7 +25,8 @@ export function edgeId(from: string, to: string): string {
   return `${from}->${to}`;
 }
 
-function seqOf(id: string): number {
+/** The number in an `n<number>` step id; 0 for any other id. */
+export function seqOf(id: string): number {
   const m = /^n(\d+)$/.exec(id);
   return m ? Number(m[1]) : 0;
 }
@@ -85,7 +86,7 @@ export function applyOp(graph: Graph, op: Op, by: Actor, now: string, options: A
     case 'updateNode': {
       const node = graph.nodes.find((n) => n.id === op.id);
       if (!node) return fail(`node ${op.id} does not exist`);
-      const { access, workspace, ...patch } = definedOnly<NodePatch>(op.patch);
+      const { access, workspace, timeoutSec, ...patch } = definedOnly<NodePatch>(op.patch);
       if (patch.title !== undefined) {
         patch.title = patch.title.trim();
         if (!patch.title) return fail('a node needs a title');
@@ -102,10 +103,13 @@ export function applyOp(graph: Graph, op: Op, by: Actor, now: string, options: A
       }
       // A command step can always change files, so becoming one drops `access` (spec §3.1).
       const nextAccess = kind === 'command' ? undefined : (access ?? node.access) === 'read' ? 'read' : undefined;
-      const { access: _access, workspace: _workspace, ...base } = node;
+      // 0 clears the timeout; a missing one keeps it.
+      const nextTimeout = timeoutSec === undefined ? node.timeoutSec : timeoutSec > 0 ? timeoutSec : undefined;
+      const { access: _access, workspace: _workspace, timeoutSec: _timeoutSec, ...base } = node;
       const updated: GraphNode = {
         ...base,
         ...patch,
+        ...(nextTimeout !== undefined && { timeoutSec: nextTimeout }),
         ...(nextAccess && { access: nextAccess }),
         ...(nextWorkspace && { workspace: nextWorkspace }),
         updatedBy: by,
```

- [ ] **Step 5: Keep file errors and a deleted file in the graph tab's state**

`reduceServer` must handle the new `graphFileErrors` message (its `switch` is exhaustive, so the web typecheck fails without it).

Apply to `web/src/state.ts`:

```diff
diff --git a/web/src/state.ts b/web/src/state.ts
--- a/web/src/state.ts
+++ b/web/src/state.ts
@@ -6,6 +6,7 @@ import type {
   EffortLevel,
   CheckoutInfo,
   Graph,
+  GraphFileError,
   GraphListItem,
   HostMessage,
   LeaseHolder,
@@ -34,6 +35,10 @@ export type State = {
   project?: string;
   graphs: GraphListItem[];
   graph?: Graph;
+  /** Problems in the graph's Markdown file: the graph shown is the last good version (Markdown graph files spec §6.3). */
+  fileErrors: GraphFileError[];
+  /** The graph's Markdown file was deleted (spec §6.5): the tab stays open and shows the graph again when the file returns. */
+  graphGone?: boolean;
   /** The user's accepted version of the graph, and what agents changed since (spec §3). */
   baseline?: Graph;
   changes: AgentChange[];
@@ -79,7 +84,7 @@ function confirmRequest(msg: ConfirmRequest): ConfirmRequest {
   return { fromNodeId: msg.fromNodeId, sourceRunId: msg.sourceRunId, ...(msg.requestedBy && { requestedBy: msg.requestedBy }) };
 }
 
-export const initialState: State = { connected: false, graphs: [], changes: [], runs: [], logs: {}, approvals: [], chat: [], chatBusy: false, models: [], defaultEfforts: [], plannerModel: {}, variableValues: {}, tab: 'node', minimap: true, layout: { sideWidth: 440, sideCollapsed: false, logsHeight: null, logsCollapsed: false } };
+export const initialState: State = { connected: false, graphs: [], fileErrors: [], changes: [], runs: [], logs: {}, approvals: [], chat: [], chatBusy: false, models: [], defaultEfforts: [], plannerModel: {}, variableValues: {}, tab: 'node', minimap: true, layout: { sideWidth: 440, sideCollapsed: false, logsHeight: null, logsCollapsed: false } };
 
 export type Action =
   | { kind: 'server'; msg: HostMessage }
@@ -175,10 +180,14 @@ function reduceServer(state: State, msg: HostMessage): State {
       return { ...state, status: msg.status };
     case 'graphs':
       return { ...state, graphs: msg.graphs };
-    case 'graphDeleted':
-      return msg.graphId === current
-        ? { ...state, ...reviewing(state, []), graph: undefined, baseline: undefined, changes: [], run: undefined, runs: [], logs: {}, selectedNodeId: undefined, confirm: undefined, preview: undefined, previewRequestId: undefined, toast: 'This graph was deleted.' }
-        : state;
+    case 'graphDeleted': {
+      if (msg.graphId !== current) return state;
+      // A deleted file shows a notice that stays (the graph may come back); a deleted graph's tab closes.
+      const gone = msg.reason === 'file' ? { graphGone: true } : { toast: 'This graph was deleted.' };
+      return { ...state, ...reviewing(state, []), ...gone, graph: undefined, baseline: undefined, changes: [], fileErrors: [], run: undefined, runs: [], logs: {}, selectedNodeId: undefined, confirm: undefined, preview: undefined, previewRequestId: undefined };
+    }
+    case 'graphFileErrors':
+      return msg.graphId === current ? { ...state, fileErrors: msg.errors } : state;
     case 'graphOpened':
       return {
         ...state,
@@ -186,6 +195,8 @@ function reduceServer(state: State, msg: HostMessage): State {
         // Another graph's review (a picked change, a pending Accept all) doesn't carry over.
         ...(current !== msg.graph.id && { selectedChange: undefined, changeConfirm: undefined, blocked: undefined }),
         graph: msg.graph,
+        graphGone: false,
+        fileErrors: msg.fileErrors ?? [],
         baseline: msg.baseline,
         changes: msg.changes,
         runs: msg.runs,
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm test -w shared && npm test -w web && npm test -w engine -- test/runReport.test.ts`
Expected: PASS.

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add shared/src/fence.ts shared/test/fence.test.ts shared/src/index.ts shared/src/types.ts shared/src/schemas.ts shared/src/graph.ts shared/test/graph.test.ts shared/test/schemas.test.ts engine/src/runReport.ts web/src/state.ts web/test/state.test.ts
git commit -m "$(cat <<'MSG'
feat(shared): fence helpers, graph-file message types, clearing a timeout

The Run Report's safe-fence helper moves to shared so the graph serializer
uses the same rule. Adds GraphFileError, OpRecord.via, graphFileErrors and
graphDeleted.reason, the openGraphMarkdown host command, timeoutSec 0 to
clear a timeout, and the graph tab's file-error state.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
)"
```

---

### Task 2: The Flow block parser

**Spec tests owned (§9):** shared parse — Flow chains, labels, comments and directions; the Flow errors (other Mermaid constructs, an id with no step section, self-edge, duplicate, cycle), with line numbers.

**Files:**
- Create: `shared/src/graphFlow.ts`, `shared/test/graphFlow.test.ts`
- Modify: `shared/src/index.ts`

**Interfaces:**
- Consumes: `edgeId`, `emptyGraph`, `wouldCreateCycle` (`shared/src/graph.ts`); `GraphFileError` (Task 1).
- Produces:
  ```ts
  export type FlowLine = { line: number; text: string };
  export type FlowEdge = { from: string; to: string; line: number };
  export const ONLY_ARROWS: string;
  export function parseChain(text: string): { ok: true; ids: string[] } | { ok: false; error: string };
  /** `openLine`: the mermaid block's opening fence line, for an empty block. */
  export function parseFlow(lines: FlowLine[], stepIds: ReadonlySet<string>, openLine: number): { edges: FlowEdge[]; errors: GraphFileError[] };
  ```

- [ ] **Step 1: Write the failing test**

Create `shared/test/graphFlow.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { ONLY_ARROWS, parseChain, parseFlow } from '../src/graphFlow';

const ids = new Set(['n1', 'n2', 'n3', 'a-b', 'step_4']);
/** The block's lines, numbered from 11 (the opening fence is line 10). */
const flow = (...texts: string[]) => parseFlow(texts.map((text, k) => ({ line: 11 + k, text })), ids, 10);

describe('parseChain', () => {
  it('reads ids joined by arrows, skipping every label form', () => {
    expect(parseChain('n1 --> n2 --> n3')).toEqual({ ok: true, ids: ['n1', 'n2', 'n3'] });
    expect(parseChain('n1["Check · the \\"table\\""] --> n2("Run") --> n3[plain label]')).toEqual({ ok: true, ids: ['n1', 'n2', 'n3'] });
    expect(parseChain('n1(plain) --> n2')).toEqual({ ok: true, ids: ['n1', 'n2'] });
    expect(parseChain('a-b-->step_4;')).toEqual({ ok: true, ids: ['a-b', 'step_4'] });
    expect(parseChain('n1')).toEqual({ ok: true, ids: ['n1'] });
  });

  it('refuses other Mermaid links and shapes', () => {
    for (const text of ['n1 -.-> n2', 'n1 ==> n2', 'n1 -->|yes| n2', 'n1 --- n2', 'n1 & n2 --> n3', 'n1 ---> n2', 'n1{"x"} --> n2', 'n1 -- text --> n2']) {
      expect(parseChain(text)).toMatchObject({ ok: false, error: expect.stringContaining(ONLY_ARROWS) });
    }
    expect(parseChain('n1["open --> n2')).toEqual({ ok: false, error: 'the label after n1 isn\'t closed. Write it as n1["Title"].' });
  });
});

describe('parseFlow', () => {
  it('reads edges in order, with any direction, comments and blank lines', () => {
    const r = flow('flowchart TD', '', '  %% a comment', '  n1["A"] --> n2["B"] --> n3["C"]', '  step_4');
    expect(r).toEqual({
      errors: [],
      edges: [
        { from: 'n1', to: 'n2', line: 14 },
        { from: 'n2', to: 'n3', line: 14 },
      ],
    });
    expect(flow('graph', 'n1 --> n2').edges).toEqual([{ from: 'n1', to: 'n2', line: 12 }]);
    expect(flow('flowchart LR').edges).toEqual([]);
  });

  it('reports each problem with its line', () => {
    const r = flow('flowchart LR', 'subgraph one', 'n1 --> n7', 'n1 --> n1', 'n1 --> n2', 'n1 --> n2', 'n2 --> n1', 'classDef x fill:#f00', 'end', 'n1 ==> n3');
    expect(r.errors).toEqual([
      { line: 12, message: `"subgraph" isn't supported in the Flow. ${ONLY_ARROWS}` },
      { line: 13, message: 'the Flow block mentions n7, but there is no "## n7 · …" step section. Add one or remove n7 from the Flow.' },
      { line: 14, message: "n1 --> n1: a step can't connect to itself. Remove this arrow." },
      { line: 16, message: 'n1 --> n2 is in the Flow twice. Remove one of them.' },
      { line: 17, message: "n2 --> n1 would make a cycle. Steps run in arrow order, so the arrows can't loop back." },
      { line: 18, message: `"classDef" isn't supported in the Flow. ${ONLY_ARROWS}` },
      { line: 19, message: `"end" isn't supported in the Flow. ${ONLY_ARROWS}` },
      { line: 20, message: `"==> n3" isn't supported. ${ONLY_ARROWS}` },
    ]);
    expect(r.edges).toEqual([{ from: 'n1', to: 'n2', line: 15 }]);
  });

  it('asks for the flowchart header, and for content in an empty block', () => {
    expect(flow('n1 --> n2').errors).toEqual([{ line: 11, message: 'the mermaid block must start with "flowchart LR" (or TD, TB, RL, BT).' }]);
    expect(flow('', '%% only a comment').errors).toEqual([{ line: 10, message: 'the mermaid block is empty. Start it with "flowchart LR", then one arrow per line, such as n1 --> n2.' }]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w shared -- test/graphFlow.test.ts`
Expected: FAIL: `../src/graphFlow` doesn't exist.

- [ ] **Step 3: Write the parser**

Create `shared/src/graphFlow.ts`. An id is read up to the first character that can't be in an id, or up to `-->` (so `a-b-->c` is `a-b` then `c`); a label in `[...]` or `(...)`, quoted or not, is skipped. Edges are checked in file order against the ones accepted so far, as the `connect` operation checks them.

```ts
import { edgeId, emptyGraph, wouldCreateCycle } from './graph';
import type { Edge, GraphFileError } from './types';

/** One line inside the Flow's mermaid block, numbered as in the file. */
export type FlowLine = { line: number; text: string };
/** An arrow of the Flow, with the line it is on. */
export type FlowEdge = { from: string; to: string; line: number };

const HEADER_RE = /^(?:flowchart|graph)(?:[ \t]+(?:LR|RL|TD|TB|BT))?[ \t]*;?$/;
const KEYWORD_RE = /^(subgraph|end|classDef|class|style|linkStyle|click|direction)(?=[ \t;]|$)/;
const ID_CHAR_RE = /[A-Za-z0-9_-]/;
export const ONLY_ARROWS = 'The Flow holds only arrows between step ids, such as n1 --> n2, with optional labels such as n1["Title"].';

/** The step ids of one Flow line in order (`a --> b --> c`), or why the line isn't a chain of arrows. Labels are skipped. */
export function parseChain(text: string): { ok: true; ids: string[] } | { ok: false; error: string } {
  let i = 0;
  const skipSpace = () => {
    while (text[i] === ' ' || text[i] === '\t') i++;
  };
  const readRef = (): string | { error: string } => {
    const start = i;
    while (i < text.length && ID_CHAR_RE.test(text[i]) && !text.startsWith('-->', i)) i++;
    if (i === start) return { error: `"${text.slice(i).trim()}" isn't a step id. ${ONLY_ARROWS}` };
    const id = text.slice(start, i);
    const open = text[i];
    if (open !== '[' && open !== '(') return id;
    const close = open === '[' ? ']' : ')';
    const quoted = text[i + 1] === '"';
    const end = quoted ? text.indexOf(`"${close}`, i + 2) : text.indexOf(close, i + 1);
    if (end < 0) return { error: `the label after ${id} isn't closed. Write it as ${id}["Title"].` };
    i = end + (quoted ? 2 : 1);
    return id;
  };
  const ids: string[] = [];
  skipSpace();
  for (;;) {
    const ref = readRef();
    if (typeof ref !== 'string') return { ok: false, error: ref.error };
    ids.push(ref);
    skipSpace();
    if (i >= text.length || (text[i] === ';' && text.slice(i + 1).trim() === '')) return { ok: true, ids };
    const next = text[i + 3];
    if (!text.startsWith('-->', i) || next === '-' || next === '>' || next === '|') return { ok: false, error: `"${text.slice(i).trim()}" isn't supported. ${ONLY_ARROWS}` };
    i += 3;
    skipSpace();
  }
}

/**
 * Reads the Flow's mermaid block (Markdown graph files spec §2.3): the edges in the order they appear, each checked the
 * way the connect operation checks it, and every problem with its line. `openLine` is the block's opening fence.
 */
export function parseFlow(lines: FlowLine[], stepIds: ReadonlySet<string>, openLine: number): { edges: FlowEdge[]; errors: GraphFileError[] } {
  const edges: FlowEdge[] = [];
  const errors: GraphFileError[] = [];
  let accepted: Edge[] = [];
  let header = false;
  for (const { line, text: raw } of lines) {
    const text = raw.trim();
    if (!text || text.startsWith('%%')) continue;
    if (!header) {
      header = true;
      if (HEADER_RE.test(text)) continue;
      errors.push({ line, message: 'the mermaid block must start with "flowchart LR" (or TD, TB, RL, BT).' });
    }
    const keyword = KEYWORD_RE.exec(text);
    if (keyword) {
      errors.push({ line, message: `"${keyword[1]}" isn't supported in the Flow. ${ONLY_ARROWS}` });
      continue;
    }
    const chain = parseChain(text);
    if (!chain.ok) {
      errors.push({ line, message: chain.error });
      continue;
    }
    const missing = [...new Set(chain.ids.filter((id) => !stepIds.has(id)))];
    for (const id of missing) {
      errors.push({ line, message: `the Flow block mentions ${id}, but there is no "## ${id} · …" step section. Add one or remove ${id} from the Flow.` });
    }
    if (missing.length) continue;
    for (let k = 0; k + 1 < chain.ids.length; k++) {
      const from = chain.ids[k];
      const to = chain.ids[k + 1];
      const problem =
        from === to
          ? `${from} --> ${to}: a step can't connect to itself. Remove this arrow.`
          : accepted.some((e) => e.from === from && e.to === to)
            ? `${from} --> ${to} is in the Flow twice. Remove one of them.`
            : wouldCreateCycle({ ...emptyGraph('', '', ''), edges: accepted }, from, to)
              ? `${from} --> ${to} would make a cycle. Steps run in arrow order, so the arrows can't loop back.`
              : null;
      if (problem) {
        errors.push({ line, message: problem });
        continue;
      }
      accepted = [...accepted, { id: edgeId(from, to), from, to }];
      edges.push({ from, to, line });
    }
  }
  if (!header) errors.push({ line: openLine, message: 'the mermaid block is empty. Start it with "flowchart LR", then one arrow per line, such as n1 --> n2.' });
  return { edges, errors };
}
```

Apply to `shared/src/index.ts`:

```diff
diff --git a/shared/src/index.ts b/shared/src/index.ts
--- a/shared/src/index.ts
+++ b/shared/src/index.ts
@@ -9,3 +9,4 @@ export * from './access';
 export * from './checkout';
 export * from './models';
 export * from './fence';
+export * from './graphFlow';
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -w shared -- test/graphFlow.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck`
Expected: no errors.

```bash
git add shared/src/graphFlow.ts shared/test/graphFlow.test.ts shared/src/index.ts
git commit -m "$(cat <<'MSG'
feat(shared): read the Flow block of a graph's Markdown file

Line-based Mermaid flowchart reading: chains of ids joined by -->, labels
skipped, comments and directions ignored. Any other Mermaid construct, an
unknown id, a self-edge, a duplicate or a cycle is an error with its line.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
)"
```

---

### Task 3: The document parser

**Spec tests owned (§9):** shared parse — every rule in §2 (each field, defaults, reserved sections, id-less headings, ids in headings), every listed error with its line, CRLF and BOM, prompts containing ```` ``` ```` and ```` ```` ```` fences, Jinja and `{% raw %}`, Unicode titles, an empty graph (H1 only). Review Focus 3 (free text escapes).

**Files:**
- Create: `shared/src/graphDoc.ts`, `shared/src/freeText.ts`, `shared/src/graphMarkdownParse.ts`, `shared/test/graphMarkdownParse.test.ts`
- Modify: `shared/src/index.ts`

**Interfaces:**
- Consumes: `fenceOpening`, `fenceCloses`, `Fence` (Task 1); `parseFlow`, `FlowEdge` (Task 2); `nodeIdProblem` (`graph.ts`); `variableNameProblem` (`variables.ts`); `COMMAND_ALWAYS_WRITES`, `workspaceNameProblem` (`access.ts`).
- Produces:
  ```ts
  // shared/src/graphDoc.ts
  export const MAX_TIMEOUT_SEC = 2_147_483;
  export const STEP_SEPARATOR = ' · ';
  export type DocStep = { id?: string; title: string; kind: NodeKind; access?: 'read'; workspace?: string; timeoutSec?: number; description?: string; prompt?: string; command?: string; line: number };
  export type DocVariable = { name: string; description: string; line: number };
  export type GraphDoc = { name: string; goal: string; instructions: string; variables: DocVariable[]; steps: DocStep[]; edges: FlowEdge[] };
  export type ParseGraphResult = { ok: true; doc: GraphDoc } | { ok: false; errors: GraphFileError[] };
  export const normText: (text: string) => string;    // CRLF/CR → LF
  export const oneLine: (text: string) => string;     // line breaks → one space, trimmed
  export const timeoutValue: (sec: number) => number; // whole seconds, 1..MAX_TIMEOUT_SEC, rounded up
  export function formatFileErrors(errors: readonly GraphFileError[], max?: number): string; // "line 3: … (and 2 more)"
  // shared/src/freeText.ts
  export function escapeFreeText(text: string): string;
  export function unescapeFreeTextLine(line: string): string;
  // shared/src/graphMarkdownParse.ts
  export function parseGraphMarkdown(text: string): ParseGraphResult;
  ```
  A `DocStep` leaves out what is empty or default: no `description` when there is none, no `prompt`/`command` for an empty block, `access` only when `read`.

- [ ] **Step 1: Write the failing test**

Create `shared/test/graphMarkdownParse.test.ts`:

`````ts
import { describe, expect, it } from 'vitest';
import { COMMAND_ALWAYS_WRITES, WORKSPACE_NAME_PROBLEM } from '../src/access';
import { escapeFreeText, unescapeFreeTextLine } from '../src/freeText';
import { formatFileErrors, type GraphDoc } from '../src/graphDoc';
import { parseGraphMarkdown } from '../src/graphMarkdownParse';
import type { GraphFileError } from '../src/types';

const md = (...lines: string[]) => lines.join('\n');
function doc(text: string): GraphDoc {
  const r = parseGraphMarkdown(text);
  if (!r.ok) throw new Error(formatFileErrors(r.errors, 10));
  return r.doc;
}
function errors(text: string): GraphFileError[] {
  const r = parseGraphMarkdown(text);
  if (r.ok) throw new Error('expected errors');
  return r.errors;
}
const FENCE = '```';

/** The spec's example (§2), with the n3 section it leaves out. */
const EXAMPLE = md(
  '# scd2_tests',
  '',
  '## Goal',
  '',
  'Prove the SCD2 model works.',
  '',
  '## Instructions',
  '',
  'Use the dev target. Never touch prod.',
  '',
  '## Variables',
  '',
  '- `target_schema`: Schema the tests write to',
  '',
  '## Flow',
  '',
  '```mermaid',
  'flowchart LR',
  '  n1["Check table absent"] --> n2["Run model"]',
  '  n2 --> n3["Check table exists"]',
  '```',
  '',
  '## n1 · Check table absent',
  '',
  '- kind: command',
  '- access: read',
  '- timeout: 120',
  '',
  "> Confirms the target table doesn't exist before the first run.",
  '',
  '```sh',
  "dbt run-operation table_exists --args '{table: dim_customer}'",
  '```',
  '',
  '## n2 · Run model',
  '',
  '- kind: agent',
  '- workspace: wh_a',
  '',
  '> Builds the model for the first time.',
  '',
  '```prompt',
  'Run `dbt run -s dim_customer` and report the row count.',
  '```',
  '',
  '## n3 · Check table exists',
  '',
  '```sh',
  'dbt run-operation table_exists',
  '```',
  '',
);

describe('parseGraphMarkdown: the format', () => {
  it("reads the spec's example, except that a command step can't be read-only", () => {
    expect(errors(EXAMPLE)).toEqual([{ line: 26, message: COMMAND_ALWAYS_WRITES }]);
    expect(doc(EXAMPLE.replace('- access: read\n', ''))).toEqual({
      name: 'scd2_tests',
      goal: 'Prove the SCD2 model works.',
      instructions: 'Use the dev target. Never touch prod.',
      variables: [{ name: 'target_schema', description: 'Schema the tests write to', line: 13 }],
      steps: [
        { id: 'n1', title: 'Check table absent', kind: 'command', timeoutSec: 120, description: "Confirms the target table doesn't exist before the first run.", command: "dbt run-operation table_exists --args '{table: dim_customer}'", line: 23 },
        { id: 'n2', title: 'Run model', kind: 'agent', workspace: 'wh_a', description: 'Builds the model for the first time.', prompt: 'Run `dbt run -s dim_customer` and report the row count.', line: 34 },
        { id: 'n3', title: 'Check table exists', kind: 'command', command: 'dbt run-operation table_exists', line: 45 },
      ],
      edges: [
        { from: 'n1', to: 'n2', line: 19 },
        { from: 'n2', to: 'n3', line: 20 },
      ],
    });
  });

  it('reads an empty graph: a name and nothing else', () => {
    expect(doc('# Empty\n')).toEqual({ name: 'Empty', goal: '', instructions: '', variables: [], steps: [], edges: [] });
    expect(doc('\n\n# Empty')).toMatchObject({ name: 'Empty' });
  });

  it('takes reserved sections in any order, between steps, in any letter case', () => {
    const d = doc(md('# G', '## n1 · A', FENCE + 'prompt', 'a', FENCE, '## flow', FENCE + 'mermaid', 'flowchart LR', 'n1', FENCE, '## INSTRUCTIONS', 'Careful.', '## goal', 'Ship.'));
    expect(d).toMatchObject({ goal: 'Ship.', instructions: 'Careful.', edges: [] });
    expect(d.steps.map((s) => s.id)).toEqual(['n1']);
  });

  it('reads ids and titles from headings, the separator being " · "', () => {
    const d = doc(md('# G', '## n1 · Goal', FENCE + 'prompt', FENCE, '## Check the table', FENCE + 'sh', 'make', FENCE, '## step_2 · A · B', FENCE + 'text', 'x', FENCE, '## n9·tight', FENCE + 'md', FENCE));
    expect(d.steps.map((s) => [s.id, s.title, s.kind])).toEqual([
      ['n1', 'Goal', 'agent'],
      [undefined, 'Check the table', 'command'],
      ['step_2', 'A · B', 'agent'],
      [undefined, 'n9·tight', 'agent'],
    ]);
  });

  it('reads fields, the description and the block, with defaults', () => {
    const d = doc(
      md('# G', '## n1 · A', '- kind: agent', '- access: read', '- workspace: wh_b', '- timeout: 2147483', '', '> One', '> two.', '>', '> Three', '', FENCE + 'prompt', 'p', FENCE, '## n2 · B', '- Access: write', FENCE + 'bash', 'echo', FENCE, '## n3 · C', '* kind: command', FENCE + 'shell', FENCE),
    );
    expect(d.steps).toEqual([
      { id: 'n1', title: 'A', kind: 'agent', access: 'read', workspace: 'wh_b', timeoutSec: 2147483, description: 'One two. Three', prompt: 'p', line: 2 },
      { id: 'n2', title: 'B', kind: 'command', command: 'echo', line: 16 },
      { id: 'n3', title: 'C', kind: 'command', line: 21 },
    ]);
  });

  it('keeps a block exactly: Jinja, dbt raw blocks, inner fences, blank lines and Unicode', () => {
    const prompt = md('Run {{ target_schema }} with {% raw %}{{ not_a_var }}{% endraw %}.', '', '```sql', 'select 1', '```', '  indented', '');
    const d = doc(md('# Größe ✓', '## n1 · Prüfen · 日本語', '````prompt', prompt, '````', '## n2 · Tilde', '~~~sh', '```', '~~~'));
    expect(d.name).toBe('Größe ✓');
    expect(d.steps[0]).toMatchObject({ title: 'Prüfen · 日本語', prompt });
    expect(d.steps[1]).toMatchObject({ command: '```' });
  });

  it('reads CRLF as LF and ignores a leading BOM', () => {
    const text = md('# G', '## Goal', 'one', 'two', '## n1 · A', FENCE + 'sh', 'a', 'b', FENCE).replace(/\n/g, '\r\n');
    const d = doc(`﻿${text}`);
    expect(d).toMatchObject({ name: 'G', goal: 'one\ntwo', steps: [{ command: 'a\nb' }] });
  });

  it('never reads a "#" inside a fenced block as a heading', () => {
    const d = doc(md('# G', '## Goal', 'Before.', FENCE, '# not a name', '## not a section', FENCE, 'After.', '## n1 · A', FENCE + 'prompt', '## still the prompt', FENCE));
    expect(d.goal).toBe(md('Before.', FENCE, '# not a name', '## not a section', FENCE, 'After.'));
    expect(d.steps).toHaveLength(1);
    expect(d.steps[0].prompt).toBe('## still the prompt');
  });

  it('reads variables, descriptions optional', () => {
    expect(doc(md('# G', '## Variables', '', '- `a`: First one', '- `b`', '* `c` :  spaced  ', '')).variables).toEqual([
      { name: 'a', description: 'First one', line: 4 },
      { name: 'b', description: '', line: 5 },
      { name: 'c', description: 'spaced', line: 6 },
    ]);
  });
});

describe('parseGraphMarkdown: errors', () => {
  it('asks for the name first', () => {
    expect(errors('')).toEqual([{ line: 1, message: 'the file must start with the graph\'s name, as "# Name".' }]);
    expect(errors(md('Some intro', '# G'))).toEqual([{ line: 1, message: 'the file must start with the graph\'s name, as "# Name".' }]);
    expect(errors(md('', '## Goal', 'x'))).toEqual([{ line: 2, message: 'the file must start with the graph\'s name, as "# Name".' }]);
    expect(errors(md('#', '## Goal'))).toEqual([{ line: 1, message: 'the graph needs a name after "#".' }]);
    expect(errors(md('# G', '# H'))).toEqual([{ line: 2, message: 'a graph file has one "# Name" heading, and this is a second one. Use "##" for sections and steps.' }]);
    expect(errors(md('# G', 'Intro text', '## Goal'))).toEqual([{ line: 2, message: 'text between the name and the first "##" section isn\'t part of the graph. Move it under "## Goal" or "## Instructions", or remove it.' }]);
  });

  it('reports duplicate sections, duplicate ids and unclosed blocks', () => {
    expect(errors(md('# G', '## Goal', 'a', '## Goal', 'b'))).toEqual([{ line: 4, message: 'there is already a "## Goal" section on line 2. Merge the two.' }]);
    expect(errors(md('# G', '## n1 · A', FENCE + 'sh', FENCE, '## n1 · B', FENCE + 'sh', FENCE))).toEqual([
      { line: 5, message: 'the step id n1 is used twice (also on line 2). Give one of them another id, or remove the id to get a new one.' },
    ]);
    expect(errors(md('# G', '## n1 · A', '````prompt', 'never closed', '```', '## n2 · B'))).toEqual([{ line: 3, message: 'this code block is never closed. Add a line with ```` after it.' }]);
  });

  it('reports bad step ids and missing titles', () => {
    expect(errors(md('# G', '## con · A', FENCE + 'sh', FENCE))).toEqual([{ line: 2, message: '"con" can\'t be used as a step id. Step ids use letters, digits, - and _ (at most 64).' }]);
    expect(errors(md('# G', '## n2 ·', FENCE + 'sh', FENCE))).toEqual([{ line: 2, message: 'step n2 needs a title after "·".' }]);
    expect(errors(md('# G', '##', FENCE + 'sh', FENCE))).toEqual([{ line: 2, message: 'this step needs a title after "##".' }]);
  });

  it('reports bad fields and field order', () => {
    const e = errors(
      md('# G', '## n1 · A', '- kind: robot', '- colour: red', '- access: maybe', '- workspace: Bad Name', '- timeout: 1.5', '- timeout: 2', FENCE + 'prompt', FENCE, '## n2 · B', '> why', '- kind: agent', FENCE + 'prompt', FENCE, '> late', FENCE + 'prompt', FENCE),
    );
    expect(e).toEqual([
      { line: 3, message: 'kind is "robot"; use agent or command.' },
      { line: 4, message: 'unknown field "colour". Step fields are kind, access, workspace and timeout.' },
      { line: 5, message: 'access is "maybe"; use read or write.' },
      { line: 6, message: `workspace "Bad Name": ${WORKSPACE_NAME_PROBLEM}` },
      { line: 7, message: 'timeout is "1.5"; use a whole number of seconds from 1 to 2147483.' },
      { line: 8, message: 'the field timeout appears twice in step n1. Keep one.' },
      { line: 13, message: 'fields go at the top of step n2, before the description and the code block.' },
      { line: 16, message: 'the description of step n2 goes before its code block.' },
      { line: 17, message: 'step n2 has a second code block. A step has exactly one: move this text into the first block, or into a step of its own.' },
    ]);
    expect(errors(md('# G', '## n1 · A', '- timeout: 0', FENCE + 'sh', FENCE))[0].message).toContain('from 1 to 2147483');
    expect(errors(md('# G', '## n1 · A', '- timeout: 2147484', FENCE + 'sh', FENCE))[0].message).toContain('from 1 to 2147483');
  });

  it('reports a missing, unlabelled or mismatched block, and other text in a step', () => {
    expect(errors(md('# G', '## n1 · A', '- kind: agent'))).toEqual([{ line: 2, message: 'step n1 has no code block. Add a ```prompt block for an agent step or a ```sh block for a command step.' }]);
    expect(errors(md('# G', '## n1 · A', FENCE + 'python', FENCE))).toEqual([{ line: 3, message: 'the code block of step n1 needs the info string prompt (agent step) or sh (command step), as in ```prompt.' }]);
    expect(errors(md('# G', '## n1 · A', '- kind: agent', FENCE + 'sh', FENCE))).toEqual([{ line: 4, message: 'step n1 is kind agent, but its block is a command (sh). Use a ```prompt block, or change kind to command.' }]);
    expect(errors(md('# G', '## Check', 'A paragraph.', '### Sub', FENCE + 'sh', FENCE))).toEqual([
      { line: 3, message: 'step "Check" has text Agent Stream can\'t keep. A step holds fields (- key: value), a description (> …) and one code block: move this into the description or the code block, or remove it.' },
      { line: 4, message: 'step "Check" has text Agent Stream can\'t keep. A step holds fields (- key: value), a description (> …) and one code block: move this into the description or the code block, or remove it.' },
    ]);
  });

  it('reports bad variables', () => {
    expect(errors(md('# G', '## Variables', '- target', '- `n1`: step ids are reserved', '- `a`', '- `a`', FENCE, FENCE))).toEqual([
      { line: 3, message: 'each line under "## Variables" is one variable, written as - `name`: description.' },
      { line: 4, message: '"n1" looks like a step id; step ids are reserved for step outputs.' },
      { line: 6, message: 'A variable named "a" already exists.' },
      { line: 7, message: 'each line under "## Variables" is one variable, written as - `name`: description.' },
    ]);
  });

  it('reports Flow problems with their lines', () => {
    const steps = md('## n1 · A', FENCE + 'sh', FENCE, '## n2 · B', FENCE + 'sh', FENCE);
    expect(errors(md('# G', '## Flow', 'text', steps))).toEqual([
      { line: 2, message: '"## Flow" needs a ```mermaid block. Add one, or remove the section when no step is connected.' },
      { line: 3, message: 'only a ```mermaid block belongs under "## Flow". Move this text under "## Instructions", or remove it.' },
    ]);
    expect(errors(md('# G', '## Flow', FENCE, 'x', FENCE, steps))).toEqual([{ line: 3, message: 'the block under "## Flow" must be a ```mermaid block.' }]);
    expect(errors(md('# G', '## Flow', FENCE + 'mermaid', 'flowchart LR', 'n1 --> n7', FENCE, FENCE + 'mermaid', 'flowchart LR', FENCE, steps))).toEqual([
      { line: 5, message: 'the Flow block mentions n7, but there is no "## n7 · …" step section. Add one or remove n7 from the Flow.' },
      { line: 7, message: '"## Flow" has a second ```mermaid block. Put every arrow in one block.' },
    ]);
    expect(errors(md('# G', '## Flow', FENCE + 'mermaid', 'flowchart LR', 'n1 --> n2 --> n1', FENCE, steps))).toEqual([
      { line: 5, message: "n2 --> n1 would make a cycle. Steps run in arrow order, so the arrows can't loop back." },
    ]);
  });

  it('knows step ids from headings even when the step itself has an error', () => {
    expect(errors(md('# G', '## Flow', FENCE + 'mermaid', 'flowchart LR', 'n1', FENCE, '## n1 · A', '- kind: robot', FENCE + 'sh', FENCE))).toEqual([{ line: 8, message: 'kind is "robot"; use agent or command.' }]);
  });

  it('reports every problem at once, in line order', () => {
    expect(errors(md('# G', '## n1 · A', '- kind: robot', '## Goal', 'x', '## Goal', '## n2 · B')).map((e) => e.line)).toEqual([2, 3, 6, 7]);
  });
});

describe('free text escapes', () => {
  it('writes heading-like lines, escaped fences and unclosed blocks so they read back unchanged', () => {
    const goal = md('## Looks like a section', '# Looks like a name', '\\## already escaped', '### a real sub-heading', FENCE, '## inside a block', FENCE, '````', 'never closed');
    const written = escapeFreeText(goal);
    expect(written.split('\n')).toEqual(['\\## Looks like a section', '\\# Looks like a name', '\\\\## already escaped', '### a real sub-heading', FENCE, '## inside a block', FENCE, '\\````', 'never closed']);
    expect(doc(md('# G', '## Goal', written)).goal).toBe(goal);
    expect(unescapeFreeTextLine('\\plain')).toBe('\\plain');
  });
});
`````

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w shared -- test/graphMarkdownParse.test.ts`
Expected: FAIL: `../src/graphDoc` doesn't exist.

- [ ] **Step 3: Write the document types and the free-text escapes**

Create `shared/src/graphDoc.ts`:

```ts
import type { FlowEdge } from './graphFlow';
import type { GraphFileError, NodeKind } from './types';

/** The longest timeout a step can have: Node's longest timer, in whole seconds. */
export const MAX_TIMEOUT_SEC = 2_147_483;
/** Between a step's id and its title in its heading: space, U+00B7, space. */
export const STEP_SEPARATOR = ' · ';

/** A step section of a graph's Markdown file. Empty text and a description are left out, as are `access: write` and defaults. */
export type DocStep = {
  /** Missing for a heading without an id: the store gives it the next n<number>. */
  id?: string;
  title: string;
  kind: NodeKind;
  access?: 'read';
  workspace?: string;
  timeoutSec?: number;
  description?: string;
  prompt?: string;
  command?: string;
  /** The heading's line, for messages. */
  line: number;
};
export type DocVariable = { name: string; description: string; line: number };
/** A graph's meaning as its Markdown file states it (Markdown graph files spec §3.1). Positions and bookkeeping are in the side file. */
export type GraphDoc = { name: string; goal: string; instructions: string; variables: DocVariable[]; steps: DocStep[]; edges: FlowEdge[] };
export type ParseGraphResult = { ok: true; doc: GraphDoc } | { ok: false; errors: GraphFileError[] };

/** CRLF and lone CR as LF. */
export const normText = (text: string): string => text.replace(/\r\n?/g, '\n');
/** Line breaks (and the spaces around them) as one space, trimmed: for headings, list items and the description line. */
export const oneLine = (text: string): string => text.replace(/[ \t]*[\r\n]+[ \t]*/g, ' ').trim();
/** A timeout as the file can hold it: whole seconds from 1 to MAX_TIMEOUT_SEC, rounded up. */
export const timeoutValue = (sec: number): number => Math.min(MAX_TIMEOUT_SEC, Math.max(1, Math.ceil(sec)));

/** `line 3: … (and 2 more)`: the first `max` problems, for a list item, a notice or an import error. */
export function formatFileErrors(errors: readonly GraphFileError[], max = 1): string {
  const shown = errors
    .slice(0, max)
    .map((e) => `line ${e.line}: ${e.message}`)
    .join(' ');
  const more = errors.length - max;
  return more > 0 ? `${shown} (and ${more} more)` : shown;
}
```

Create `shared/src/freeText.ts`. `escapeFreeText` scans fences the way the reader does; a fence that is never closed gets its opening line escaped and the scan repeats (each round escapes one more line, so it ends).

```ts
import { fenceCloses, fenceOpening, type Fence } from './fence';

/** After any backslashes: a line the reader would take for an H1 or H2 heading. */
const HEADING_LIKE = /^\\*#{1,2}(?:[ \t]|$)/;
/** A fence line already escaped with at least one backslash. */
const ESCAPED_FENCE = /^\\+ {0,3}(?:`{3,}|~{3,})/;
/** The backslash `escapeFreeText` added. */
const ADDED_ESCAPE = /^\\(?=\\*#{1,2}(?:[ \t]|$)|\\* {0,3}(?:`{3,}|~{3,}))/;

/** Which lines are inside a fenced block (fence lines included), reading `plain` lines as text; and an unclosed opening's index. */
function scanFences(lines: readonly string[], plain: ReadonlySet<number>): { inFence: boolean[]; unclosed: number | null } {
  const inFence = lines.map(() => false);
  let open: (Fence & { at: number }) | null = null;
  for (let i = 0; i < lines.length; i++) {
    if (open) {
      inFence[i] = true;
      if (fenceCloses(lines[i], open)) open = null;
      continue;
    }
    if (plain.has(i)) continue;
    const f = fenceOpening(lines[i]);
    if (f) {
      open = { ...f, at: i };
      inFence[i] = true;
    }
  }
  return { inFence, unclosed: open ? open.at : null };
}

/**
 * Goal or Instructions text as it is written under its heading, so reading it back gives exactly `text` (spec §4.2).
 * Outside fenced blocks, a line that would read as an H1 or H2 heading, an already escaped fence line, and the opening
 * of a block that is never closed each get one leading backslash. Markdown shows them as the plain text they were.
 */
export function escapeFreeText(text: string): string {
  const lines = text.split('\n');
  const plain = new Set<number>();
  for (;;) {
    const { inFence, unclosed } = scanFences(lines, plain);
    if (unclosed === null) {
      return lines.map((line, i) => (!inFence[i] && (plain.has(i) || HEADING_LIKE.test(line) || ESCAPED_FENCE.test(line)) ? `\\${line}` : line)).join('\n');
    }
    plain.add(unclosed);
  }
}

/** Undoes `escapeFreeText` for one line outside a fenced block. */
export function unescapeFreeTextLine(line: string): string {
  return line.replace(ADDED_ESCAPE, '');
}
```

- [ ] **Step 4: Write the parser**

Create `shared/src/graphMarkdownParse.ts`. It splits the text into sections and fenced blocks in one pass, then reads each section. Step ids for the Flow come from the headings, so a step with an error elsewhere doesn't also produce a false "no step section" error.

````ts
import { COMMAND_ALWAYS_WRITES, workspaceNameProblem } from './access';
import { fenceCloses, fenceOpening, type Fence } from './fence';
import { unescapeFreeTextLine } from './freeText';
import { nodeIdProblem } from './graph';
import { MAX_TIMEOUT_SEC, STEP_SEPARATOR, type DocStep, type DocVariable, type ParseGraphResult } from './graphDoc';
import { parseFlow, type FlowEdge } from './graphFlow';
import type { GraphFileError, NodeKind } from './types';
import { variableNameProblem } from './variables';

type TextItem = { kind: 'text'; line: number; text: string };
type CodeItem = { kind: 'code'; line: number; info: string; fence: Fence; content: string[]; raw: string[] };
type Item = TextItem | CodeItem;
type Section = { level: 1 | 2; title: string; line: number; items: Item[] };

const HEADING_RE = /^(#{1,2})(?=[ \t]|$)[ \t]*(.*?)[ \t]*$/;
const RESERVED = { goal: 'Goal', instructions: 'Instructions', variables: 'Variables', flow: 'Flow' } as const;
type Reserved = (typeof RESERVED)[keyof typeof RESERVED];
const STEP_HEADING_RE = new RegExp(`^([A-Za-z0-9_-]+)${STEP_SEPARATOR.trimEnd()}(?: (.*))?$`);
const FIELD_RE = /^[-*][ \t]+([A-Za-z]+)[ \t]*:[ \t]*(.*?)[ \t]*$/;
const VARIABLE_RE = /^[-*][ \t]+`([^`]*)`(?:[ \t]*:[ \t]*(.*?))?[ \t]*$/;
const QUOTE_RE = /^>[ \t]?(.*)$/;
const FIELD_NAMES = ['kind', 'access', 'workspace', 'timeout'];
const AGENT_INFOS = new Set(['prompt', 'text', 'md']);
const COMMAND_INFOS = new Set(['sh', 'bash', 'shell']);
const START = 'the file must start with the graph\'s name, as "# Name".';
const VARIABLE_FORM = 'each line under "## Variables" is one variable, written as - `name`: description.';

/** The id and title of a step heading: `n1 · Title`, or just a title for a new step (spec §2.1). */
function stepHeading(text: string): { id?: string; title: string } {
  const m = STEP_HEADING_RE.exec(text);
  return m ? { id: m[1], title: (m[2] ?? '').trim() } : { title: text.trim() };
}

const infoWord = (item: CodeItem) => item.info.split(/\s+/)[0].toLowerCase();

/** Headings and fenced blocks, line by line. A "#" inside a fenced block is never a heading. */
function sectionsOf(lines: string[], errors: GraphFileError[]): { preamble: Item[]; sections: Section[] } {
  const preamble: Item[] = [];
  const sections: Section[] = [];
  const items = () => (sections.length ? sections[sections.length - 1].items : preamble);
  let code: CodeItem | null = null;
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i];
    const line = i + 1;
    if (code) {
      code.raw.push(text);
      if (fenceCloses(text, code.fence)) code = null;
      else code.content.push(text);
      continue;
    }
    const open = fenceOpening(text);
    if (open) {
      code = { kind: 'code', line, info: open.info, fence: open, content: [], raw: [text] };
      items().push(code);
      continue;
    }
    const heading = HEADING_RE.exec(text);
    if (heading) sections.push({ level: heading[1].length === 1 ? 1 : 2, title: heading[2], line, items: [] });
    else items().push({ kind: 'text', line, text });
  }
  if (code) errors.push({ line: code.line, message: `this code block is never closed. Add a line with ${code.fence.char.repeat(code.fence.len)} after it.` });
  return { preamble, sections };
}

const isBlank = (item: Item) => item.kind === 'text' && item.text.trim() === '';

/** Goal or Instructions: the section's text as written (escapes undone), trimmed. */
function freeText(items: Item[]): string {
  return items
    .flatMap((item) => (item.kind === 'code' ? item.raw : [unescapeFreeTextLine(item.text)]))
    .join('\n')
    .trim();
}

function readVariables(section: Section, errors: GraphFileError[]): DocVariable[] {
  const out: DocVariable[] = [];
  for (const item of section.items) {
    if (isBlank(item)) continue;
    const m = item.kind === 'text' ? VARIABLE_RE.exec(item.text.trim()) : null;
    if (!m) {
      errors.push({ line: item.line, message: VARIABLE_FORM });
      continue;
    }
    const problem = variableNameProblem(m[1], out);
    if (problem) {
      errors.push({ line: item.line, message: problem });
      continue;
    }
    out.push({ name: m[1], description: (m[2] ?? '').trim(), line: item.line });
  }
  return out;
}

function readFlow(section: Section, stepIds: ReadonlySet<string>, errors: GraphFileError[]): FlowEdge[] {
  const blocks: CodeItem[] = [];
  for (const item of section.items) {
    if (item.kind === 'code') blocks.push(item);
    else if (item.text.trim()) errors.push({ line: item.line, message: 'only a ```mermaid block belongs under "## Flow". Move this text under "## Instructions", or remove it.' });
  }
  const mermaid = blocks.filter((b) => infoWord(b) === 'mermaid');
  for (const b of blocks) if (!mermaid.includes(b)) errors.push({ line: b.line, message: 'the block under "## Flow" must be a ```mermaid block.' });
  for (const b of mermaid.slice(1)) errors.push({ line: b.line, message: '"## Flow" has a second ```mermaid block. Put every arrow in one block.' });
  if (!blocks.length) errors.push({ line: section.line, message: '"## Flow" needs a ```mermaid block. Add one, or remove the section when no step is connected.' });
  const block = mermaid[0];
  if (!block) return [];
  const r = parseFlow(
    block.content.map((text, k) => ({ line: block.line + 1 + k, text })),
    stepIds,
    block.line,
  );
  errors.push(...r.errors);
  return r.edges;
}

function readStep(section: Section, errors: GraphFileError[]): DocStep | null {
  const before = errors.length;
  const fail = (line: number, message: string) => void errors.push({ line, message });
  const { id, title } = stepHeading(section.title);
  const label = id ?? `"${title}"`;
  if (id) {
    const problem = nodeIdProblem(id);
    if (problem) fail(section.line, `${problem.replace(/\.$/, '')}. Step ids use letters, digits, - and _ (at most 64).`);
  }
  if (!title) fail(section.line, id ? `step ${id} needs a title after "${STEP_SEPARATOR.trim()}".` : 'this step needs a title after "##".');
  const fields = new Map<string, { value: string; line: number }>();
  const quote: string[] = [];
  let code: CodeItem | undefined;
  let phase: 'fields' | 'description' | 'code' = 'fields';
  for (const item of section.items) {
    if (item.kind === 'code') {
      if (code) fail(item.line, `step ${label} has a second code block. A step has exactly one: move this text into the first block, or into a step of its own.`);
      else code = item;
      phase = 'code';
      continue;
    }
    if (!item.text.trim()) continue;
    const field = FIELD_RE.exec(item.text);
    if (field) {
      const key = field[1].toLowerCase();
      if (phase !== 'fields') fail(item.line, `fields go at the top of step ${label}, before the description and the code block.`);
      else if (!FIELD_NAMES.includes(key)) fail(item.line, `unknown field "${field[1]}". Step fields are kind, access, workspace and timeout.`);
      else if (fields.has(key)) fail(item.line, `the field ${key} appears twice in step ${label}. Keep one.`);
      else fields.set(key, { value: field[2], line: item.line });
      continue;
    }
    const q = QUOTE_RE.exec(item.text);
    if (q) {
      if (phase === 'code') fail(item.line, `the description of step ${label} goes before its code block.`);
      else {
        phase = 'description';
        quote.push(q[1]);
      }
      continue;
    }
    fail(item.line, `step ${label} has text Agent Stream can't keep. A step holds fields (- key: value), a description (> …) and one code block: move this into the description or the code block, or remove it.`);
  }

  let kind: NodeKind | undefined;
  const k = fields.get('kind');
  if (k) {
    if (k.value === 'agent' || k.value === 'command') kind = k.value;
    else fail(k.line, `kind is "${k.value}"; use agent or command.`);
  }
  let blockKind: NodeKind | undefined;
  if (!code) fail(section.line, `step ${label} has no code block. Add a \`\`\`prompt block for an agent step or a \`\`\`sh block for a command step.`);
  else if (AGENT_INFOS.has(infoWord(code))) blockKind = 'agent';
  else if (COMMAND_INFOS.has(infoWord(code))) blockKind = 'command';
  else fail(code.line, `the code block of step ${label} needs the info string prompt (agent step) or sh (command step), as in \`\`\`prompt.`);
  if (code && kind && blockKind && kind !== blockKind) {
    fail(code.line, `step ${label} is kind ${kind}, but its block is ${blockKind === 'agent' ? 'a prompt' : 'a command (sh)'}. Use a \`\`\`${kind === 'agent' ? 'prompt' : 'sh'} block, or change kind to ${blockKind}.`);
  }
  const finalKind = kind ?? blockKind;

  let access: 'read' | undefined;
  const a = fields.get('access');
  if (a) {
    if (a.value === 'read') access = 'read';
    else if (a.value !== 'write') fail(a.line, `access is "${a.value}"; use read or write.`);
    if (access && finalKind === 'command') fail(a.line, COMMAND_ALWAYS_WRITES);
  }
  let workspace: string | undefined;
  const w = fields.get('workspace');
  if (w) {
    const problem = workspaceNameProblem(w.value);
    if (problem) fail(w.line, `workspace "${w.value}": ${problem}`);
    else workspace = w.value;
  }
  let timeoutSec: number | undefined;
  const t = fields.get('timeout');
  if (t) {
    const sec = /^\d+$/.test(t.value) ? Number(t.value) : NaN;
    if (sec >= 1 && sec <= MAX_TIMEOUT_SEC) timeoutSec = sec;
    else fail(t.line, `timeout is "${t.value}"; use a whole number of seconds from 1 to ${MAX_TIMEOUT_SEC}.`);
  }
  if (errors.length > before || !code || !finalKind) return null;
  const description = quote
    .map((q) => q.trim())
    .filter(Boolean)
    .join(' ');
  const text = code.content.join('\n');
  return {
    ...(id && { id }),
    title,
    kind: finalKind,
    ...(access && { access }),
    ...(workspace && { workspace }),
    ...(timeoutSec !== undefined && { timeoutSec }),
    ...(description && { description }),
    ...(text && (finalKind === 'agent' ? { prompt: text } : { command: text })),
    line: section.line,
  };
}

/**
 * Reads a graph's Markdown file (Markdown graph files spec §2, §3.1). Pure: the engine and the tests share it. Every
 * problem found is reported, each with its 1-based line. CRLF reads as LF, and a leading BOM is ignored.
 */
export function parseGraphMarkdown(text: string): ParseGraphResult {
  const errors: GraphFileError[] = [];
  const lines = normalizeLines(text);
  const { preamble, sections } = sectionsOf(lines, errors);

  const stray = preamble.find((item) => !isBlank(item));
  if (stray) errors.push({ line: stray.line, message: START });
  const h1 = sections[0]?.level === 1 ? sections[0] : undefined;
  if (!h1 && !stray) errors.push({ line: sections[0]?.line ?? 1, message: START });
  for (const s of sections) {
    if (s.level === 1 && s !== h1) errors.push({ line: s.line, message: 'a graph file has one "# Name" heading, and this is a second one. Use "##" for sections and steps.' });
  }
  if (h1 && !h1.title) errors.push({ line: h1.line, message: 'the graph needs a name after "#".' });
  const intro = h1?.items.find((item) => !isBlank(item));
  if (intro) errors.push({ line: intro.line, message: 'text between the name and the first "##" section isn\'t part of the graph. Move it under "## Goal" or "## Instructions", or remove it.' });

  let goal = '';
  let instructions = '';
  let variables: DocVariable[] = [];
  let flow: Section | undefined;
  const reservedAt = new Map<Reserved, number>();
  const stepSections: Section[] = [];
  for (const s of sections) {
    if (s.level !== 2) continue;
    const reserved: Reserved | undefined = RESERVED[s.title.toLowerCase() as keyof typeof RESERVED];
    if (!reserved) {
      stepSections.push(s);
      continue;
    }
    const earlier = reservedAt.get(reserved);
    if (earlier !== undefined) {
      errors.push({ line: s.line, message: `there is already a "## ${reserved}" section on line ${earlier}. Merge the two.` });
      continue;
    }
    reservedAt.set(reserved, s.line);
    if (reserved === 'Goal') goal = freeText(s.items);
    else if (reserved === 'Instructions') instructions = freeText(s.items);
    else if (reserved === 'Variables') variables = readVariables(s, errors);
    else flow = s;
  }

  const idLines = new Map<string, number>();
  for (const s of stepSections) {
    const { id } = stepHeading(s.title);
    if (!id) continue;
    const earlier = idLines.get(id);
    if (earlier !== undefined) errors.push({ line: s.line, message: `the step id ${id} is used twice (also on line ${earlier}). Give one of them another id, or remove the id to get a new one.` });
    else idLines.set(id, s.line);
  }
  const steps = stepSections.map((s) => readStep(s, errors)).filter((s): s is DocStep => s !== null);
  const edges = flow ? readFlow(flow, new Set(idLines.keys()), errors) : [];
  if (errors.length) return { ok: false, errors: errors.sort((a, b) => a.line - b.line) };
  return { ok: true, doc: { name: h1!.title, goal, instructions, variables, steps, edges } };
}

/** The file's lines: a leading BOM dropped, CRLF and CR read as LF. */
function normalizeLines(text: string): string[] {
  return text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n');
}
````

Apply to `shared/src/index.ts`:

```diff
diff --git a/shared/src/index.ts b/shared/src/index.ts
--- a/shared/src/index.ts
+++ b/shared/src/index.ts
@@ -10,3 +10,6 @@ export * from './checkout';
 export * from './models';
 export * from './fence';
 export * from './graphFlow';
+export * from './graphDoc';
+export * from './freeText';
+export * from './graphMarkdownParse';
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test -w shared -- test/graphMarkdownParse.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck and commit**

Run: `npm run typecheck`
Expected: no errors.

```bash
git add shared/src/graphDoc.ts shared/src/freeText.ts shared/src/graphMarkdownParse.ts shared/test/graphMarkdownParse.test.ts shared/src/index.ts
git commit -m "$(cat <<'MSG'
feat(shared): parse a graph's Markdown file

parseGraphMarkdown reads the name, Goal, Instructions, Variables, Flow and
step sections line by line, tracking fences, and reports every problem
with its line and how to fix it. CRLF reads as LF; a BOM is ignored.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
)"
```

---

### Task 4: Writing the file, the canonical form and the side file

**Spec tests owned (§9):** shared round trip — `parse(serialize(g))` equals `g`'s meaning and serialize is stable, for fixture graphs plus generated graphs; a single canvas edit changes only the expected lines; the side file's defaults and bad entries (§3.2). Review Focus 3 (generated graphs).

**Files:**
- Create: `shared/src/graphMeta.ts`, `shared/src/graphMarkdownWrite.ts`, `shared/test/graphFixtures.ts`, `shared/test/graphMarkdownWrite.test.ts`
- Modify: `shared/src/graphDoc.ts`, `shared/src/index.ts`

**Interfaces:**
- Consumes: Task 1 (`fenceFor`, `seqOf`), Task 3 (`GraphDoc`, `escapeFreeText`, `normText`, `oneLine`, `timeoutValue`, `STEP_SEPARATOR`, `parseGraphMarkdown`).
- Produces:
  ```ts
  // shared/src/graphDoc.ts
  export function canonicalGraph(graph: Graph): Graph; // R4
  // shared/src/graphMeta.ts
  export type GraphMetaNode = { position?: Position; createdBy?: Actor; updatedBy?: Actor; updatedAt?: string };
  export type GraphMeta = { nodeSeq: number; updatedAt?: string; nodes: Map<string, GraphMetaNode> };
  export type GraphMetaFile = { version: 1; nodeSeq: number; updatedAt: string; nodes: Record<string, { position?: Position; createdBy: Actor; updatedBy: Actor; updatedAt: string }> };
  export function parseGraphMeta(text: string | undefined): GraphMeta | undefined; // undefined: missing or invalid
  export function metaOf(graph: Graph): GraphMetaFile;
  export function serializeGraphMeta(graph: Graph): string;  // JSON, 2-space indent, trailing newline
  export function withMeta(graph: Graph, meta: GraphMeta | undefined, now: string): Graph;
  export function graphFromDoc(doc: GraphDoc, meta: GraphMeta | undefined, id: string, now: string): Graph;
  // shared/src/graphMarkdownWrite.ts
  export function mermaidLabel(title: string): string; // ["…"], " as #quot;
  export function serializeGraphMarkdown(graph: Graph): string;
  // shared/test/graphFixtures.ts (test helper)
  export const T0: string; export function build(name: string, ops: Op[], at?: string): Graph;
  export const FIXTURES: Record<string, Graph>; export function rng(seed: number): () => number; export function randomGraph(seed: number): Graph;
  ```

- [ ] **Step 1: Write the fixtures and the failing test**

Create `shared/test/graphFixtures.ts` (hand-picked graphs, and a seeded generator that mixes in tricky text: fences, headings, unclosed blocks, `\r\n`, Unicode, quotes, ` · `):

`````ts
import { applyOp, emptyGraph } from '../src/graph';
import type { Graph, NewNodeInput, Op } from '../src/types';

export const T0 = '2026-10-04T00:00:00.000Z';

/** Builds a graph through applyOp, so it is valid by construction. */
export function build(name: string, ops: Op[], at = T0): Graph {
  let g = emptyGraph('g', name, at);
  for (const op of ops) {
    const r = applyOp(g, op, 'user', at);
    if (!r.ok) throw new Error(`${op.type}: ${r.error}`);
    g = r.graph;
  }
  return g;
}

const add = (node: NewNodeInput): Op => ({ type: 'addNode', node });
const connect = (from: string, to: string): Op => ({ type: 'connect', from, to });

/** Hand-picked graphs: what each one stresses is in its name. */
export const FIXTURES: Record<string, Graph> = {
  empty: build('Empty', []),
  example: build('scd2_tests', [
    { type: 'setGoal', goal: 'Prove the SCD2 model works.' },
    { type: 'setInstructions', instructions: 'Use the dev target. Never touch prod.' },
    { type: 'addVariable', name: 'target_schema', description: 'Schema the tests write to' },
    add({ title: 'Check table absent', kind: 'command', command: "dbt run-operation table_exists --args '{table: dim_customer}'", timeoutSec: 120, description: "Confirms the target table doesn't exist before the first run." }),
    add({ title: 'Run model', kind: 'agent', workspace: 'wh_a', prompt: 'Run `dbt run -s dim_customer` and report the row count.', description: 'Builds the model for the first time.' }),
    add({ title: 'Check table exists', kind: 'command', command: 'dbt run-operation table_exists' }),
    connect('n1', 'n2'),
    connect('n2', 'n3'),
  ]),
  fencesAndJinja: build('Fences', [
    add({ title: 'Inner fences', kind: 'agent', prompt: 'Write:\n```sql\nselect 1\n```\nand\n````md\nx\n````' }),
    add({ title: 'Jinja', kind: 'command', command: "dbt run --vars '{{ vars }}' {% raw %}{{ keep }}{% endraw %}\n" }),
    add({ title: 'Empty prompt', kind: 'agent' }),
    add({ title: 'Only newlines', kind: 'agent', prompt: '\n\n' }),
    connect('n1', 'n3'),
    connect('n2', 'n3'),
  ]),
  unicodeAndQuotes: build('Größe "quoted" ✓', [
    { type: 'setGoal', goal: '## Looks like a section\n# and a name\n```\nunclosed block' },
    { type: 'setInstructions', instructions: '\\## already escaped\n````\n## inside\n````' },
    add({ title: 'Prüfen · "日本語" #1', kind: 'agent', access: 'read', prompt: 'p', timeoutSec: 30 }),
    add({ id: 'custom-id_1', title: 'Custom', kind: 'command', command: '~~~\n```' }),
    connect('n1', 'custom-id_1'),
  ]),
};

/** A small seeded random generator (mulberry32), so failures can be replayed. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TEXTS = ['', 'plain', '```', '````js\nx\n````', '{% raw %}{{ x }}{% endraw %}', '## not a heading', '# H1', '\n', ' leading space', 'trailing  ', '~~~', '> quote', '- kind: command', '\\## esc', '日本語 ✓', 'a · b', '"q"', '```\nunclosed', '\r\nwindows'];
const TITLES = ['Build', 'Prüfen · 日本語', 'Say "hi"', '# hash', 'Goal', 'a\nb', '  padded  ', 'end'];

/** A random valid graph: steps, fields, edges (always forward, so no cycles), variables and tricky text. */
export function randomGraph(seed: number): Graph {
  const r = rng(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
  const text = () => Array.from({ length: Math.floor(r() * 3) }, () => pick(TEXTS)).join(pick(['\n', ' ', '']));
  const ops: Op[] = [{ type: 'setGoal', goal: text() }, { type: 'setInstructions', instructions: text() }];
  const varCount = Math.floor(r() * 3);
  for (let v = 0; v < varCount; v++) ops.push({ type: 'addVariable', name: `var_${v}`, description: pick(['', 'Some value', 'two\nlines', ' x ']) });
  const count = Math.floor(r() * 6);
  for (let i = 0; i < count; i++) {
    const kind = r() < 0.5 ? 'agent' : 'command';
    ops.push(
      add({
        title: pick(TITLES),
        kind,
        ...(kind === 'agent' ? { prompt: text() } : { command: text() }),
        ...(r() < 0.3 && { description: pick(['Why it runs.', 'multi\nline', ' spaced ']) }),
        ...(r() < 0.3 && { timeoutSec: 1 + Math.floor(r() * 600) }),
        ...(kind === 'agent' && r() < 0.3 && { access: 'read' as const }),
        ...(r() < 0.2 && { workspace: pick(['wh_a', 'wh-b']) }),
        ...(r() < 0.3 && { position: { x: Math.floor(r() * 500), y: Math.floor(r() * 500) } }),
      }),
    );
  }
  for (let a = 1; a <= count; a++) for (let b = a + 1; b <= count; b++) if (r() < 0.3) ops.push(connect(`n${a}`, `n${b}`));
  return build(pick(['G', 'Graph · 1', 'Ünïcode']), ops);
}
`````

Create `shared/test/graphMarkdownWrite.test.ts`:

``````ts
import { describe, expect, it } from 'vitest';
import { applyOp } from '../src/graph';
import { canonicalGraph, formatFileErrors, MAX_TIMEOUT_SEC, type GraphDoc } from '../src/graphDoc';
import { parseGraphMarkdown } from '../src/graphMarkdownParse';
import { serializeGraphMarkdown } from '../src/graphMarkdownWrite';
import { graphFromDoc, metaOf, parseGraphMeta, serializeGraphMeta, withMeta } from '../src/graphMeta';
import type { Graph, Op } from '../src/types';
import { build, FIXTURES, randomGraph, T0 } from './graphFixtures';

const NOW = '2026-10-04T12:00:00.000Z';
function parsed(text: string): GraphDoc {
  const r = parseGraphMarkdown(text);
  if (!r.ok) throw new Error(`${formatFileErrors(r.errors, 5)}\n---\n${text}`);
  return r.doc;
}
/** What loading the graph's two files gives back. */
const reload = (g: Graph) => graphFromDoc(parsed(serializeGraphMarkdown(g)), parseGraphMeta(serializeGraphMeta(g)), g.id, NOW);
function edited(g: Graph, op: Op): Graph {
  const r = applyOp(g, op, 'user', T0);
  if (!r.ok) throw new Error(r.error);
  return r.graph;
}
/** Lines removed and added between two texts (as sets: enough for a few changed lines). */
function lineChanges(before: string, after: string) {
  const a = before.split('\n');
  const b = after.split('\n');
  return { removed: a.filter((l) => !b.includes(l)), added: b.filter((l) => !a.includes(l)) };
}

describe('serializeGraphMarkdown', () => {
  it("writes the spec's example in the fixed order, with labels on every Flow line", () => {
    expect(serializeGraphMarkdown(FIXTURES.example)).toBe(
      [
        '# scd2_tests',
        '',
        '## Goal',
        '',
        'Prove the SCD2 model works.',
        '',
        '## Instructions',
        '',
        'Use the dev target. Never touch prod.',
        '',
        '## Variables',
        '',
        '- `target_schema`: Schema the tests write to',
        '',
        '## Flow',
        '',
        '```mermaid',
        'flowchart LR',
        '  n1["Check table absent"] --> n2["Run model"]',
        '  n2["Run model"] --> n3["Check table exists"]',
        '```',
        '',
        '## n1 · Check table absent',
        '',
        '- kind: command',
        '- timeout: 120',
        '',
        "> Confirms the target table doesn't exist before the first run.",
        '',
        '```sh',
        "dbt run-operation table_exists --args '{table: dim_customer}'",
        '```',
        '',
        '## n2 · Run model',
        '',
        '- kind: agent',
        '- workspace: wh_a',
        '',
        '> Builds the model for the first time.',
        '',
        '```prompt',
        'Run `dbt run -s dim_customer` and report the row count.',
        '```',
        '',
        '## n3 · Check table exists',
        '',
        '- kind: command',
        '',
        '```sh',
        'dbt run-operation table_exists',
        '```',
        '',
      ].join('\n'),
    );
  });

  it('always writes the Flow, leaves out empty sections, and lists steps without edges', () => {
    expect(serializeGraphMarkdown(FIXTURES.empty)).toBe('# Empty\n\n## Flow\n\n```mermaid\nflowchart LR\n```\n');
    const g = build('G', [
      { type: 'addNode', node: { title: 'A "quoted"\ntitle', kind: 'agent', access: 'read', prompt: 'x' } },
      { type: 'addNode', node: { title: 'B', kind: 'command', command: 'y' } },
    ]);
    const text = serializeGraphMarkdown(g);
    expect(text).toContain('```mermaid\nflowchart LR\n  n1["A #quot;quoted#quot; title"]\n  n2["B"]\n```');
    expect(text).toContain('## n1 · A "quoted" title\n\n- kind: agent\n- access: read\n');
    expect(text).not.toMatch(/## (Goal|Instructions|Variables)/);
    expect(text).not.toContain('\r');
    expect(text.endsWith('```\n')).toBe(true);
  });

  it('picks a fence the content cannot close', () => {
    const text = serializeGraphMarkdown(FIXTURES.fencesAndJinja);
    expect(text).toContain('`````prompt\nWrite:\n```sql\nselect 1\n```\nand\n````md\nx\n````\n`````');
    expect(text).toContain('## n3 · Empty prompt\n\n- kind: agent\n\n```prompt\n```');
  });
});

describe('round trip', () => {
  it('gives every fixture back exactly, and writes the same text again', () => {
    for (const [name, g] of Object.entries(FIXTURES)) {
      const text = serializeGraphMarkdown(g);
      expect(reload(g), name).toEqual(canonicalGraph(g));
      expect(serializeGraphMarkdown(reload(g)), name).toBe(text);
    }
  });

  it('gives generated graphs back exactly (300 seeds)', () => {
    for (let seed = 1; seed <= 300; seed++) {
      const g = randomGraph(seed);
      const text = serializeGraphMarkdown(g);
      expect(reload(g), `seed ${seed}`).toEqual(canonicalGraph(g));
      expect(serializeGraphMarkdown(reload(g)), `seed ${seed}`).toBe(text);
      expect(serializeGraphMarkdown(canonicalGraph(g)), `seed ${seed}`).toBe(text);
    }
  });

  it('changes only the lines that hold what one canvas edit changed', () => {
    const g = FIXTURES.example;
    const before = serializeGraphMarkdown(g);
    expect(serializeGraphMarkdown(edited(g, { type: 'moveNode', id: 'n2', position: { x: 5, y: 6 } }))).toBe(before);
    expect(lineChanges(before, serializeGraphMarkdown(edited(g, { type: 'updateNode', id: 'n2', patch: { prompt: 'Run it.' } })))).toEqual({
      removed: ['Run `dbt run -s dim_customer` and report the row count.'],
      added: ['Run it.'],
    });
    expect(lineChanges(before, serializeGraphMarkdown(edited(g, { type: 'updateNode', id: 'n3', patch: { title: 'Verify' } })))).toEqual({
      removed: ['  n2["Run model"] --> n3["Check table exists"]', '## n3 · Check table exists'],
      added: ['  n2["Run model"] --> n3["Verify"]', '## n3 · Verify'],
    });
    expect(lineChanges(before, serializeGraphMarkdown(edited(g, { type: 'updateNode', id: 'n3', patch: { timeoutSec: 60 } })))).toEqual({ removed: [], added: ['- timeout: 60'] });
  });
});

describe('canonicalGraph', () => {
  it('keeps only what the files can hold', () => {
    const g: Graph = {
      ...FIXTURES.empty,
      name: ' Two\nlines ',
      goal: '\r\n  goal\r\n',
      variables: [{ name: 'v', description: 'a\nb' }],
      nodes: [
        { id: 'n1', title: 'A', kind: 'agent', prompt: 'p\r\nq', command: 'stale', access: 'write', description: ' one\ntwo ', timeoutSec: 0.5, createdBy: 'agent', updatedBy: 'user', updatedAt: T0 },
        { id: 'n7', title: 'B', kind: 'command', prompt: 'stale', command: '', access: 'read', workspace: '', timeoutSec: 1e12, createdBy: 'user', updatedBy: 'user', updatedAt: T0 },
      ],
      nodeSeq: 2,
    };
    expect(canonicalGraph(g)).toEqual({
      ...g,
      name: 'Two lines',
      goal: 'goal',
      variables: [{ name: 'v', description: 'a b' }],
      nodes: [
        { id: 'n1', title: 'A', kind: 'agent', prompt: 'p\nq', description: 'one two', timeoutSec: 1, createdBy: 'agent', updatedBy: 'user', updatedAt: T0 },
        { id: 'n7', title: 'B', kind: 'command', timeoutSec: MAX_TIMEOUT_SEC, createdBy: 'user', updatedBy: 'user', updatedAt: T0 },
      ],
      nodeSeq: 7,
    });
  });
});

describe('the side file', () => {
  it('holds positions, authorship, timestamps and the id counter, and nothing else', () => {
    const g = edited(edited(FIXTURES.example, { type: 'moveNode', id: 'n1', position: { x: 1, y: 2 } }), { type: 'deleteNode', id: 'n3' });
    expect(metaOf(g)).toEqual({
      version: 1,
      nodeSeq: 3,
      updatedAt: T0,
      nodes: { n1: { position: { x: 1, y: 2 }, createdBy: 'user', updatedBy: 'user', updatedAt: T0 }, n2: { createdBy: 'user', updatedBy: 'user', updatedAt: T0 } },
    });
    expect(serializeGraphMeta(g).endsWith('}\n')).toBe(true);
  });

  it('falls back to defaults without a side file, or with an invalid one', () => {
    const doc = parsed(serializeGraphMarkdown(FIXTURES.example));
    for (const text of [undefined, 'not json', '{"version":2}', '[]']) {
      const g = graphFromDoc(doc, parseGraphMeta(text), 'g', NOW);
      expect(g.nodes.every((n) => !n.position && n.createdBy === 'user' && n.updatedBy === 'user' && n.updatedAt === NOW)).toBe(true);
      expect([g.nodeSeq, g.updatedAt]).toEqual([3, NOW]);
    }
  });

  it('ignores bad entries: unknown ids, bad values and a negative nodeSeq', () => {
    const meta = parseGraphMeta('{"version":1,"nodeSeq":-4,"nodes":{"n1":{"position":{"x":"a"},"createdBy":"robot","updatedBy":"agent"},"n9":{"createdBy":"agent"},"__proto__":{"createdBy":"agent"},"bad id":{}}}');
    expect(meta).toEqual({ nodeSeq: 0, nodes: new Map([['n1', { updatedBy: 'agent' }], ['n9', { createdBy: 'agent' }]]) });
    const g = graphFromDoc(parsed(serializeGraphMarkdown(FIXTURES.example)), meta, 'g', NOW);
    expect(g.nodes[0]).toMatchObject({ id: 'n1', createdBy: 'user', updatedBy: 'agent' });
    expect(g.nodes.map((n) => n.id)).toEqual(['n1', 'n2', 'n3']);
  });

  it('gives a step without an id the next number, and never reuses one', () => {
    const doc = parsed(['# G', '## New one', '```sh', 'a', '```', '## n4 · Old', '```sh', '```', '## Another', '```prompt', '```'].join('\n'));
    expect(graphFromDoc(doc, undefined, 'g', NOW).nodes.map((n) => n.id)).toEqual(['n5', 'n4', 'n6']);
    const g = graphFromDoc(doc, parseGraphMeta('{"version":1,"nodeSeq":9}'), 'g', NOW);
    expect([g.nodes.map((n) => n.id), g.nodeSeq]).toEqual([['n10', 'n4', 'n11'], 11]);
  });

  it('re-reads only bookkeeping with withMeta', () => {
    const g = FIXTURES.example;
    const moved = withMeta(g, parseGraphMeta(JSON.stringify({ version: 1, nodeSeq: 8, updatedAt: NOW, nodes: { n2: { position: { x: 3, y: 4 }, createdBy: 'agent', updatedBy: 'agent', updatedAt: NOW } } })), NOW);
    expect(moved.nodes[1]).toMatchObject({ position: { x: 3, y: 4 }, createdBy: 'agent', prompt: g.nodes[1].prompt });
    expect([moved.nodeSeq, moved.updatedAt, moved.nodes[0].updatedAt]).toEqual([8, NOW, NOW]);
  });
});
``````

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w shared -- test/graphMarkdownWrite.test.ts`
Expected: FAIL: `../src/graphMarkdownWrite` doesn't exist.

- [ ] **Step 3: Add the canonical form**

Apply to `shared/src/graphDoc.ts`:

```diff
diff --git a/shared/src/graphDoc.ts b/shared/src/graphDoc.ts
--- a/shared/src/graphDoc.ts
+++ b/shared/src/graphDoc.ts
@@ -1,5 +1,6 @@
+import { edgeId, seqOf } from './graph';
 import type { FlowEdge } from './graphFlow';
-import type { GraphFileError, NodeKind } from './types';
+import type { Graph, GraphFileError, GraphNode, NodeKind } from './types';
 
 /** The longest timeout a step can have: Node's longest timer, in whole seconds. */
 export const MAX_TIMEOUT_SEC = 2_147_483;
@@ -42,3 +43,38 @@ export function formatFileErrors(errors: readonly GraphFileError[], max = 1): st
   const more = errors.length - max;
   return more > 0 ? `${shown} (and ${more} more)` : shown;
 }
+
+/**
+ * The graph as its files hold it (spec §4): what loading its Markdown and side file gives back. Names, titles, variable
+ * descriptions and step descriptions on one line; goal and instructions trimmed; LF line endings; only the text of the
+ * step's kind (a prompt or a command), absent when empty; `access` only for a read-only agent step; whole-second
+ * timeouts; `nodeSeq` at least the highest n<number> id.
+ */
+export function canonicalGraph(graph: Graph): Graph {
+  const nodes = graph.nodes.map(canonicalNode);
+  return {
+    ...graph,
+    name: oneLine(graph.name),
+    goal: normText(graph.goal).trim(),
+    instructions: normText(graph.instructions).trim(),
+    variables: graph.variables.map((v) => ({ name: v.name, description: oneLine(v.description) })),
+    nodes,
+    edges: graph.edges.map((e) => ({ id: edgeId(e.from, e.to), from: e.from, to: e.to })),
+    nodeSeq: Math.max(graph.nodeSeq, ...nodes.map((n) => seqOf(n.id))),
+  };
+}
+
+function canonicalNode(node: GraphNode): GraphNode {
+  const { prompt, command, description, timeoutSec, access, workspace, ...rest } = node;
+  const text = normText((node.kind === 'agent' ? prompt : command) ?? '');
+  const summary = oneLine(description ?? '');
+  return {
+    ...rest,
+    title: oneLine(node.title),
+    ...(summary && { description: summary }),
+    ...(text && (node.kind === 'agent' ? { prompt: text } : { command: text })),
+    ...(timeoutSec !== undefined && { timeoutSec: timeoutValue(timeoutSec) }),
+    ...(node.kind === 'agent' && access === 'read' && { access: 'read' as const }),
+    ...(workspace && { workspace }),
+  };
+}
```

- [ ] **Step 4: Write the side file and the graph builder**

Create `shared/src/graphMeta.ts`. Each field of an entry is validated on its own (`.catch(undefined)`), so one bad value doesn't lose the rest; ids that aren't valid step ids are dropped.

```ts
import { z } from 'zod';
import { edgeId, nodeIdProblem, seqOf } from './graph';
import type { GraphDoc } from './graphDoc';
import type { Actor, Graph, GraphNode, Position } from './types';

/** One step's bookkeeping in the side file. */
export type GraphMetaNode = { position?: Position; createdBy?: Actor; updatedBy?: Actor; updatedAt?: string };
/** `<id>.meta.json` as read: what wasn't valid is left out (Markdown graph files spec §3.2). */
export type GraphMeta = { nodeSeq: number; updatedAt?: string; nodes: Map<string, GraphMetaNode> };
/** `<id>.meta.json` as written. */
export type GraphMetaFile = {
  version: 1;
  nodeSeq: number;
  updatedAt: string;
  nodes: Record<string, { position?: Position; createdBy: Actor; updatedBy: Actor; updatedAt: string }>;
};

const actor = z.enum(['user', 'agent']);
const metaNodeSchema = z.object({
  position: z.object({ x: z.number(), y: z.number() }).optional().catch(undefined),
  createdBy: actor.optional().catch(undefined),
  updatedBy: actor.optional().catch(undefined),
  updatedAt: z.string().optional().catch(undefined),
});
const metaSchema = z.object({
  version: z.literal(1),
  nodeSeq: z.number().int().optional().catch(undefined),
  updatedAt: z.string().optional().catch(undefined),
  nodes: z.record(z.string(), metaNodeSchema.nullable().catch(null)).optional().catch(undefined),
});

/** The side file's text read leniently: undefined when it is missing or not a version 1 side file; a bad entry is left out. */
export function parseGraphMeta(text: string | undefined): GraphMeta | undefined {
  if (text === undefined) return undefined;
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return undefined;
  }
  const r = metaSchema.safeParse(json);
  if (!r.success) return undefined;
  const nodes = new Map<string, GraphMetaNode>();
  for (const [id, entry] of Object.entries(r.data.nodes ?? {})) {
    if (!entry || nodeIdProblem(id)) continue;
    nodes.set(id, {
      ...(entry.position && { position: entry.position }),
      ...(entry.createdBy && { createdBy: entry.createdBy }),
      ...(entry.updatedBy && { updatedBy: entry.updatedBy }),
      ...(entry.updatedAt && { updatedAt: entry.updatedAt }),
    });
  }
  return { nodeSeq: Math.max(0, r.data.nodeSeq ?? 0), ...(r.data.updatedAt && { updatedAt: r.data.updatedAt }), nodes };
}

/** What the side file holds for `graph`: positions, who made and last changed each step and when, and the id counter. */
export function metaOf(graph: Graph): GraphMetaFile {
  return {
    version: 1,
    nodeSeq: graph.nodeSeq,
    updatedAt: graph.updatedAt,
    nodes: Object.fromEntries(
      graph.nodes.map((n) => [n.id, { ...(n.position && { position: n.position }), createdBy: n.createdBy, updatedBy: n.updatedBy, updatedAt: n.updatedAt }]),
    ),
  };
}

export function serializeGraphMeta(graph: Graph): string {
  return `${JSON.stringify(metaOf(graph), null, 2)}\n`;
}

/** `graph` with the side file's bookkeeping, and the defaults where it has none: no position, `user`, `now` (spec §3.2, §6.4). */
export function withMeta(graph: Graph, meta: GraphMeta | undefined, now: string): Graph {
  const nodes = graph.nodes.map((n): GraphNode => {
    const m = meta?.nodes.get(n.id);
    const { position: _position, ...rest } = n;
    return { ...rest, ...(m?.position && { position: m.position }), createdBy: m?.createdBy ?? 'user', updatedBy: m?.updatedBy ?? 'user', updatedAt: m?.updatedAt ?? now };
  });
  return { ...graph, nodes, nodeSeq: Math.max(graph.nodeSeq, meta?.nodeSeq ?? 0), updatedAt: meta?.updatedAt ?? now };
}

/**
 * The in-memory graph from a parsed Markdown file and its side file (spec §3.3). A step without an id gets
 * n<nodeSeq + 1>, and `nodeSeq` advances, so ids are never reused. `nodeSeq` is at least the highest n<number> in use.
 */
export function graphFromDoc(doc: GraphDoc, meta: GraphMeta | undefined, id: string, now: string): Graph {
  let seq = Math.max(meta?.nodeSeq ?? 0, ...doc.steps.map((s) => (s.id ? seqOf(s.id) : 0)));
  const nodes = doc.steps.map((s): GraphNode => {
    const { line: _line, id: stepId, ...content } = s;
    return { id: stepId ?? `n${++seq}`, ...content, createdBy: 'user', updatedBy: 'user', updatedAt: now };
  });
  const graph: Graph = {
    id,
    name: doc.name,
    goal: doc.goal,
    instructions: doc.instructions,
    variables: doc.variables.map(({ name, description }) => ({ name, description })),
    nodes,
    edges: doc.edges.map(({ from, to }) => ({ id: edgeId(from, to), from, to })),
    nodeSeq: seq,
    updatedAt: now,
  };
  return withMeta(graph, meta, now);
}
```

- [ ] **Step 5: Write the serializer**

Create `shared/src/graphMarkdownWrite.ts`:

```ts
import { fenceFor } from './fence';
import { escapeFreeText } from './freeText';
import { normText, oneLine, STEP_SEPARATOR, timeoutValue } from './graphDoc';
import type { Graph, GraphNode } from './types';

/** A Mermaid node label: quoted, `"` as #quot;, on one line (spec §4.1). */
export function mermaidLabel(title: string): string {
  return `["${oneLine(title).replace(/"/g, '#quot;')}"]`;
}

/** One line per edge, in the edges' order, then one per step with no edges at all, so the diagram shows every step. */
function flowLines(graph: Graph): string[] {
  const label = new Map(graph.nodes.map((n) => [n.id, mermaidLabel(n.title)]));
  const ref = (id: string) => `${id}${label.get(id) ?? ''}`;
  const connected = new Set(graph.edges.flatMap((e) => [e.from, e.to]));
  return ['flowchart LR', ...graph.edges.map((e) => `  ${ref(e.from)} --> ${ref(e.to)}`), ...graph.nodes.filter((n) => !connected.has(n.id)).map((n) => `  ${ref(n.id)}`)];
}

/** A fenced block whose fence the content can't close. Empty content has no lines between the fences. */
function block(info: string, content: string): string[] {
  const fence = fenceFor(content);
  return [`${fence}${info}`, ...(content === '' ? [] : content.split('\n')), fence];
}

function stepLines(node: GraphNode): string[] {
  const fields = [`- kind: ${node.kind}`];
  if (node.kind === 'agent' && node.access === 'read') fields.push('- access: read');
  if (node.workspace) fields.push(`- workspace: ${node.workspace}`);
  if (node.timeoutSec !== undefined) fields.push(`- timeout: ${timeoutValue(node.timeoutSec)}`);
  const description = oneLine(node.description ?? '');
  const text = normText((node.kind === 'agent' ? node.prompt : node.command) ?? '');
  return [
    `## ${node.id}${STEP_SEPARATOR}${oneLine(node.title)}`,
    '',
    ...fields,
    '',
    ...(description ? [`> ${description}`, ''] : []),
    ...block(node.kind === 'agent' ? 'prompt' : 'sh', text),
  ];
}

/**
 * The graph's Markdown file (Markdown graph files spec §2, §4.1). Pure and deterministic: name, Goal, Instructions,
 * Variables, Flow, then the steps in canvas order; empty Goal, Instructions and Variables left out; LF line endings and
 * one trailing newline. Positions and bookkeeping go to the side file instead.
 */
export function serializeGraphMarkdown(graph: Graph): string {
  const out = [`# ${oneLine(graph.name)}`];
  const section = (title: string, body: string[]) => out.push('', `## ${title}`, '', ...body);
  const goal = normText(graph.goal).trim();
  if (goal) section('Goal', escapeFreeText(goal).split('\n'));
  const instructions = normText(graph.instructions).trim();
  if (instructions) section('Instructions', escapeFreeText(instructions).split('\n'));
  if (graph.variables.length) {
    section(
      'Variables',
      graph.variables.map((v) => {
        const description = oneLine(v.description);
        return description ? `- \`${v.name}\`: ${description}` : `- \`${v.name}\``;
      }),
    );
  }
  section('Flow', block('mermaid', flowLines(graph).join('\n')));
  for (const node of graph.nodes) out.push('', ...stepLines(node));
  return `${out.join('\n')}\n`;
}
```

Apply to `shared/src/index.ts`:

```diff
diff --git a/shared/src/index.ts b/shared/src/index.ts
--- a/shared/src/index.ts
+++ b/shared/src/index.ts
@@ -13,3 +13,5 @@ export * from './graphFlow';
 export * from './graphDoc';
 export * from './freeText';
 export * from './graphMarkdownParse';
+export * from './graphMeta';
+export * from './graphMarkdownWrite';
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm test -w shared`
Expected: PASS (all shared tests, including the 300 generated graphs).

- [ ] **Step 7: Typecheck and commit**

Run: `npm run typecheck`
Expected: no errors.

```bash
git add shared/src/graphMeta.ts shared/src/graphMarkdownWrite.ts shared/src/graphDoc.ts shared/src/index.ts shared/test/graphFixtures.ts shared/test/graphMarkdownWrite.test.ts
git commit -m "$(cat <<'MSG'
feat(shared): write a graph's Markdown and side file

serializeGraphMarkdown writes the canonical file (fixed section order,
labelled Flow lines, safe fences, LF); the side file holds positions and
bookkeeping. graphFromDoc builds the Graph from both, and canonicalGraph
is what a reload gives back. Round trips are tested on fixtures and 300
generated graphs.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
)"
```

---

### Task 5: `diffToOps`

**Spec tests owned (§9):** shared `diffToOps` — one test per operation kind, the order of operations, the variable delete-then-add case, no operations for identical input.

**Files:**
- Create: `shared/src/diffToOps.ts`, `shared/test/diffToOps.test.ts`
- Modify: `shared/src/index.ts`

**Interfaces:**
- Consumes: `GraphDoc`, `DocStep` (Task 3); `canonicalGraph` (Task 4, in tests); `timeoutSec: 0` clears (Task 1).
- Produces:
  ```ts
  /** `current` must be canonical. Order: disconnect, deleteNode, addNode, updateNode, connect, setGoal/setInstructions, variables. */
  export function diffToOps(current: Graph, doc: GraphDoc): Op[];
  /** The file line an op came from (its step, arrow or variable), else 1. */
  export function opLine(doc: GraphDoc, op: Op): number;
  ```
  A patch holds only the changed fields among title, kind, description, prompt, command, access, workspace, timeoutSec; `''` clears a description, prompt, command or workspace, `access: 'write'` drops read-only, `timeoutSec: 0` clears a timeout. A step without an id becomes `addNode` without an id (the store numbers it). The name is not an operation.

- [ ] **Step 1: Write the failing test**

Create `shared/test/diffToOps.test.ts`:

````ts
import { describe, expect, it } from 'vitest';
import { diffToOps, opLine } from '../src/diffToOps';
import { applyOp } from '../src/graph';
import { canonicalGraph, formatFileErrors, type GraphDoc } from '../src/graphDoc';
import { parseGraphMarkdown } from '../src/graphMarkdownParse';
import { serializeGraphMarkdown } from '../src/graphMarkdownWrite';
import type { Graph } from '../src/types';
import { FIXTURES, randomGraph, T0 } from './graphFixtures';

function parsed(text: string): GraphDoc {
  const r = parseGraphMarkdown(text);
  if (!r.ok) throw new Error(formatFileErrors(r.errors, 5));
  return r.doc;
}
const g = canonicalGraph(FIXTURES.example);
const text = serializeGraphMarkdown(g);
/** The example's file with `from` replaced by `to`, read back. */
function editedDoc(from: string, to: string): GraphDoc {
  if (!text.includes(from)) throw new Error(`not in the file: ${from}`);
  return parsed(text.replace(from, to));
}
function applied(graph: Graph, doc: GraphDoc): Graph {
  let out = graph;
  for (const op of diffToOps(graph, doc)) {
    const r = applyOp(out, op, 'user', T0);
    if (!r.ok) throw new Error(`${op.type}: ${r.error}`);
    out = r.graph;
  }
  return out;
}

describe('diffToOps', () => {
  it('has nothing to do for the same graph', () => {
    expect(diffToOps(g, parsed(text))).toEqual([]);
    for (let seed = 1; seed <= 100; seed++) {
      const r = canonicalGraph(randomGraph(seed));
      expect(diffToOps(r, parsed(serializeGraphMarkdown(r))), `seed ${seed}`).toEqual([]);
    }
  });

  it('disconnects a removed arrow and connects a new one', () => {
    expect(diffToOps(g, editedDoc('  n2["Run model"] --> n3["Check table exists"]', '  n1 --> n3'))).toEqual([
      { type: 'disconnect', from: 'n2', to: 'n3' },
      { type: 'connect', from: 'n1', to: 'n3' },
    ]);
  });

  it('deletes a step whose section is gone', () => {
    const without = parsed(text.replace('  n2["Run model"] --> n3["Check table exists"]\n', '').replace(/\n## n3 · [\s\S]*$/, '\n'));
    expect(diffToOps(g, without)).toEqual([
      { type: 'disconnect', from: 'n2', to: 'n3' },
      { type: 'deleteNode', id: 'n3' },
    ]);
  });

  it('adds new steps, with or without an id', () => {
    const doc = parsed(`${text}\n## n8 · Report\n\n> Says how it went.\n\n\`\`\`prompt\nSum up.\n\`\`\`\n\n## Clean up\n\n- timeout: 5\n\n\`\`\`sh\nrm -rf tmp\n\`\`\`\n`);
    expect(diffToOps(g, doc)).toEqual([
      { type: 'addNode', node: { id: 'n8', title: 'Report', kind: 'agent', description: 'Says how it went.', prompt: 'Sum up.' } },
      { type: 'addNode', node: { title: 'Clean up', kind: 'command', timeoutSec: 5, command: 'rm -rf tmp' } },
    ]);
  });

  it('updates only the fields that changed, clearing what was removed', () => {
    expect(diffToOps(g, editedDoc('- kind: command\n- timeout: 120\n\n> Confirms the target table doesn\'t exist before the first run.\n', '- kind: command\n'))).toEqual([
      { type: 'updateNode', id: 'n1', patch: { description: '', timeoutSec: 0 } },
    ]);
    expect(diffToOps(g, editedDoc('## n2 · Run model\n\n- kind: agent\n- workspace: wh_a\n', '## n2 · Run the model\n\n- kind: agent\n- access: read\n'))).toEqual([
      { type: 'updateNode', id: 'n2', patch: { title: 'Run the model', access: 'read', workspace: '' } },
    ]);
    expect(diffToOps(g, editedDoc('- kind: command\n\n```sh\ndbt run-operation table_exists\n```', '- kind: agent\n\n```prompt\nCheck it.\n```'))).toEqual([
      { type: 'updateNode', id: 'n3', patch: { kind: 'agent', prompt: 'Check it.' } },
    ]);
  });

  it('sets the goal and instructions, and changes variables by name', () => {
    const changed = parsed(
      text
        .replace('Prove the SCD2 model works.', 'Prove it.')
        .replace('Use the dev target. Never touch prod.', 'Use dev.')
        .replace('- `target_schema`: Schema the tests write to', '- `schema`: Renamed\n- `warehouse`'),
    );
    expect(diffToOps(g, changed)).toEqual([
      { type: 'setGoal', goal: 'Prove it.' },
      { type: 'setInstructions', instructions: 'Use dev.' },
      { type: 'deleteVariable', name: 'target_schema' },
      { type: 'addVariable', name: 'schema', description: 'Renamed' },
      { type: 'addVariable', name: 'warehouse' },
    ]);
    expect(diffToOps(g, editedDoc('Schema the tests write to', 'Where tests write'))).toEqual([{ type: 'setVariableDescription', name: 'target_schema', description: 'Where tests write' }]);
  });

  it('orders every kind of operation as the spec lists them, and the result matches the file', () => {
    const doc = parsed(
      text
        .replace('Prove the SCD2 model works.', 'Prove it.')
        .replace('- `target_schema`: Schema the tests write to', '- `schema`')
        .replace('  n1["Check table absent"] --> n2["Run model"]\n  n2["Run model"] --> n3["Check table exists"]', '  n1 --> n3\n  n9 --> n1')
        .replace('## n2 · Run model', '## n9 · Prepare')
        .replace('dbt run-operation table_exists\n', 'dbt run-operation table_exists --strict\n'),
    );
    expect(diffToOps(g, doc).map((op) => op.type)).toEqual(['disconnect', 'disconnect', 'deleteNode', 'addNode', 'updateNode', 'connect', 'connect', 'setGoal', 'deleteVariable', 'addVariable']);
    const result = applied(g, doc);
    expect(diffToOps(canonicalGraph(result), doc)).toEqual([]);
    expect(result.nodes.map((n) => n.id)).toEqual(['n1', 'n3', 'n9']);
    expect(result.edges.map((e) => e.id).sort()).toEqual(['n1->n3', 'n9->n1']);
  });

  it('names the line an operation came from', () => {
    const doc = parsed(`${text}\n## Clean up\n\n\`\`\`sh\nx\n\`\`\`\n`);
    expect(opLine(doc, { type: 'updateNode', id: 'n2', patch: {} })).toBe(34);
    expect(opLine(doc, { type: 'addNode', node: { title: 'Clean up', kind: 'command' } })).toBe(53);
    expect(opLine(doc, { type: 'connect', from: 'n2', to: 'n3' })).toBe(20);
    expect(opLine(doc, { type: 'addVariable', name: 'target_schema' })).toBe(13);
    expect(opLine(doc, { type: 'setGoal', goal: '' })).toBe(1);
  });
});
````

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w shared -- test/diffToOps.test.ts`
Expected: FAIL: `../src/diffToOps` doesn't exist.

- [ ] **Step 3: Write `diffToOps`**

Create `shared/src/diffToOps.ts`:

```ts
import type { DocStep, GraphDoc } from './graphDoc';
import type { Graph, GraphNode, NewNodeInput, NodePatch, Op } from './types';

const edgeKey = (e: { from: string; to: string }) => `${e.from}->${e.to}`;

function newNode(step: DocStep): NewNodeInput {
  const { line: _line, ...node } = step;
  return node;
}

/** Only the fields that differ; '' clears a description, prompt, command or workspace, and 0 clears a timeout. */
function patchOf(node: GraphNode, step: DocStep): NodePatch {
  const patch: NodePatch = {};
  if (node.title !== step.title) patch.title = step.title;
  if (node.kind !== step.kind) patch.kind = step.kind;
  if ((node.description ?? '') !== (step.description ?? '')) patch.description = step.description ?? '';
  if (step.kind === 'agent' && (node.kind !== 'agent' || (node.prompt ?? '') !== (step.prompt ?? ''))) patch.prompt = step.prompt ?? '';
  if (step.kind === 'command' && (node.kind !== 'command' || (node.command ?? '') !== (step.command ?? ''))) patch.command = step.command ?? '';
  if ((node.access === 'read') !== (step.access === 'read')) patch.access = step.access ?? 'write';
  if ((node.workspace ?? '') !== (step.workspace ?? '')) patch.workspace = step.workspace ?? '';
  if ((node.timeoutSec ?? 0) !== (step.timeoutSec ?? 0)) patch.timeoutSec = step.timeoutSec ?? 0;
  return patch;
}

/**
 * The operations that turn `current` into what the Markdown file says (Markdown graph files spec §6.3), matching steps
 * by id, in this order: disconnect, deleteNode, addNode, updateNode, connect, setGoal and setInstructions, then
 * variables. `current` is in canonical form (the store keeps it so). The name is not an operation: the store renames.
 */
export function diffToOps(current: Graph, doc: GraphDoc): Op[] {
  const ops: Op[] = [];
  const docIds = new Set(doc.steps.flatMap((s) => (s.id ? [s.id] : [])));
  const nodes = new Map(current.nodes.map((n) => [n.id, n]));
  const docEdges = new Set(doc.edges.map(edgeKey));
  const currentEdges = new Set(current.edges.map(edgeKey));
  for (const e of current.edges) if (!docEdges.has(edgeKey(e))) ops.push({ type: 'disconnect', from: e.from, to: e.to });
  for (const n of current.nodes) if (!docIds.has(n.id)) ops.push({ type: 'deleteNode', id: n.id });
  for (const s of doc.steps) if (!s.id || !nodes.has(s.id)) ops.push({ type: 'addNode', node: newNode(s) });
  for (const s of doc.steps) {
    const node = s.id ? nodes.get(s.id) : undefined;
    if (!node) continue;
    const patch = patchOf(node, s);
    if (Object.keys(patch).length) ops.push({ type: 'updateNode', id: node.id, patch });
  }
  for (const e of doc.edges) if (!currentEdges.has(edgeKey(e))) ops.push({ type: 'connect', from: e.from, to: e.to });
  if (doc.goal !== current.goal) ops.push({ type: 'setGoal', goal: doc.goal });
  if (doc.instructions !== current.instructions) ops.push({ type: 'setInstructions', instructions: doc.instructions });
  const docVariables = new Map(doc.variables.map((v) => [v.name, v]));
  const variables = new Map(current.variables.map((v) => [v.name, v]));
  for (const v of current.variables) if (!docVariables.has(v.name)) ops.push({ type: 'deleteVariable', name: v.name });
  for (const v of doc.variables) {
    const before = variables.get(v.name);
    if (!before) ops.push({ type: 'addVariable', name: v.name, ...(v.description && { description: v.description }) });
    else if (before.description !== v.description) ops.push({ type: 'setVariableDescription', name: v.name, description: v.description });
  }
  return ops;
}

/** The file line an operation came from, for an error message: its step, arrow or variable; 1 when there is none. */
export function opLine(doc: GraphDoc, op: Op): number {
  switch (op.type) {
    case 'addNode':
      return (op.node.id ? doc.steps.find((s) => s.id === op.node.id) : doc.steps.find((s) => !s.id && s.title === op.node.title))?.line ?? 1;
    case 'updateNode':
      return doc.steps.find((s) => s.id === op.id)?.line ?? 1;
    case 'connect':
      return doc.edges.find((e) => e.from === op.from && e.to === op.to)?.line ?? 1;
    case 'addVariable':
    case 'setVariableDescription':
      return doc.variables.find((v) => v.name === op.name)?.line ?? 1;
    default:
      return 1;
  }
}
```

Apply to `shared/src/index.ts`:

```diff
diff --git a/shared/src/index.ts b/shared/src/index.ts
--- a/shared/src/index.ts
+++ b/shared/src/index.ts
@@ -15,3 +15,4 @@ export * from './freeText';
 export * from './graphMarkdownParse';
 export * from './graphMeta';
 export * from './graphMarkdownWrite';
+export * from './diffToOps';
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -w shared -- test/diffToOps.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck`
Expected: no errors.

```bash
git add shared/src/diffToOps.ts shared/test/diffToOps.test.ts shared/src/index.ts
git commit -m "$(cat <<'MSG'
feat(shared): turn a Markdown edit into graph operations

diffToOps matches steps by id and emits disconnect, deleteNode, addNode,
updateNode (changed fields only), connect, goal and instructions, then
variables by name; opLine finds the file line an operation came from.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
)"
```

---
### Task 6: The store on Markdown files, with migration, export and import

**Spec tests owned (§9):** engine — store load and save of `.md` + `.meta.json` (atomic, side file defaults), list with a broken file, migration (`.json` → `.md` + `.meta.json` + `.json.bak`, idempotent, a bad JSON left alone), export/import of `.md` and legacy JSON. Review Focus 5.

**Files:**
- Modify: `engine/src/graphStore.ts`, `engine/src/migrate.ts`, `engine/src/app.ts`, `extension/src/commands.ts`, `extension/src/ui.ts`
- Create: `engine/test/graphFiles.test.ts`, `engine/test/graphStoreWrites.test.ts`
- Test (modify): `engine/test/graphStore.test.ts`, `engine/test/migrate.test.ts`, `engine/test/app.test.ts`, `engine/test/ticketGraph.test.ts`, `extension/test/commands.test.ts`, `extension/test/parallelTickets.test.ts`

**Interfaces:**
- Consumes: Tasks 1–4 (`canonicalGraph`, `formatFileErrors`, `graphFromDoc`, `parseGraphMarkdown`, `parseGraphMeta`, `serializeGraphMarkdown`, `serializeGraphMeta`, `MAX_IMPORT_CHARS`, `GraphFileError`).
- Produces:
  ```ts
  // engine/src/graphStore.ts (GraphStore)
  fileErrors(id: string): GraphFileError[];   // [] when the file reads; emits 'fileErrors' (id, errors) when they change
  writeConverted(graph: Graph): Graph;        // for the migration: saves in canonical form
  exportGraph(id): { ok: true; fileName: `${id}.md`; content: string } | { ok: false; error: string };
  importGraph(content: string): GraphResult;  // Markdown, or an export when it starts with `{` (R14)
  // apply/rename/duplicate/create return (and emit) the canonical graph; private save(graph): Graph
  // engine/src/migrate.ts
  export function migrateGraphsToMarkdown(paths: ProjectPaths, store: GraphStore, rename?: typeof renameSync): { notes: string[]; warnings: string[] };
  // engine/src/app.ts (App)
  startupNotes(): string[];
  ```

**Existing tests changed by the file format (named exceptions):**
- `graphStore.test.ts`: the file paths in "leaves the file and the log untouched…", "lists unreadable graph files…" (now Markdown files, plus a file name that isn't a graph id), "sees external edits…" and "refuses to accept or revert…" become `.md`. "reports a graph file broken after it was loaded…" checks `fileErrors` instead of the list item. "duplicates the definition without planner state" no longer injects planner fields into a JSON file (a Markdown file has nowhere to keep them). "exports and imports…" expects `parity.md` and the Markdown import error, and keeps the JSON error for `{ nope`. "accepts one step into the baseline…" changes the agent's patch from `command` to `prompt`: it is an agent step, and a hidden command no longer exists (R4).
- `app.test.ts`: "never writes a model or effort into the graph file…" reads `<id>.md` and `<id>.meta.json`.
- `ticketGraph.test.ts`: the worktree's graphs folder holds `<id>.md` and `<id>.meta.json`.
- `extension/test/commands.test.ts`: the import error for `nope`; the export's file name, save kind, content and info message.
- `extension/test/parallelTickets.test.ts`: the starter graph is `<id>.md`.

- [ ] **Step 1: Write the failing tests**

Create `engine/test/graphFiles.test.ts`:

````ts
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { canonicalGraph, serializeGraphMarkdown } from '@agent-stream/shared';
import { abTestGraph } from '../src/abTestGraph';
import { GraphStore } from '../src/graphStore';
import { starterGraph } from '../src/ticketGraph';
import { fixedClock, tmpProject } from './helpers';

function setup() {
  const paths = tmpProject();
  const store = new GraphStore(paths, fixedClock());
  const { id } = store.create('Parity');
  const md = join(paths.graphsDir, `${id}.md`);
  const meta = join(paths.graphsDir, `${id}.meta.json`);
  return { paths, store, id, md, meta, read: (f: string) => readFileSync(f, 'utf8') };
}

describe('graph files', () => {
  it('keeps the meaning in <id>.md and positions and bookkeeping in <id>.meta.json', () => {
    const { paths, store, id, md, meta, read } = setup();
    store.apply(id, { type: 'addNode', node: { title: 'Build', kind: 'command', command: 'make' } }, 'agent');
    store.apply(id, { type: 'addNode', node: { title: 'Check', kind: 'agent', prompt: 'Look.' } }, 'user');
    store.apply(id, { type: 'connect', from: 'n1', to: 'n2' }, 'user');
    const text = read(md);
    expect(text).toBe(serializeGraphMarkdown(store.get(id)));
    expect(text).not.toMatch(/position|createdBy|updatedAt|2026-/);
    expect(JSON.parse(read(meta))).toMatchObject({ version: 1, nodeSeq: 2, nodes: { n1: { createdBy: 'agent' }, n2: { createdBy: 'user' } } });
    store.apply(id, { type: 'moveNode', id: 'n1', position: { x: 40, y: 80 } }, 'user');
    expect(read(md)).toBe(text);
    expect(JSON.parse(read(meta)).nodes.n1.position).toEqual({ x: 40, y: 80 });
    expect(new GraphStore(paths, fixedClock()).get(id)).toEqual(store.get(id));
    expect(readdirSync(paths.graphsDir).filter((f) => f.includes('.tmp-'))).toEqual([]);
  });

  it('falls back to defaults without a side file, or with a broken one', () => {
    const { paths, store, id, meta } = setup();
    store.apply(id, { type: 'addNode', node: { title: 'A', kind: 'agent', prompt: 'p', position: { x: 1, y: 1 } } }, 'agent');
    rmSync(meta);
    const g = new GraphStore(paths, fixedClock()).get(id);
    expect(g.nodes[0]).toMatchObject({ id: 'n1', createdBy: 'user', updatedBy: 'user' });
    expect(g.nodes[0].position).toBeUndefined();
    expect(g.nodeSeq).toBe(1);
    writeFileSync(meta, '{ not json');
    expect(new GraphStore(paths, fixedClock()).load(id).ok).toBe(true);
  });

  it('gives a step written without an id the next number when the graph is read', () => {
    const { paths, store, id, md, read } = setup();
    store.apply(id, { type: 'addNode', node: { title: 'A', kind: 'agent', prompt: 'p' } }, 'user');
    writeFileSync(md, `${read(md)}\n## Clean up\n\n\`\`\`sh\nrm -rf tmp\n\`\`\`\n`);
    const g = new GraphStore(paths, fixedClock()).get(id);
    expect(g.nodes.map((n) => [n.id, n.title])).toEqual([
      ['n1', 'A'],
      ['n2', 'Clean up'],
    ]);
    expect(g.nodeSeq).toBe(2);
  });

  it('saves the canonical form: only the text of the step kind, whole-second timeouts, one-line titles', () => {
    const { store, id, md, read } = setup();
    store.apply(id, { type: 'addNode', node: { title: 'A', kind: 'agent', prompt: 'p', timeoutSec: 1.5 } }, 'user');
    const r = store.apply(id, { type: 'updateNode', id: 'n1', patch: { command: 'stale', title: 'Two\nlines' } }, 'agent');
    expect(r.ok && r.graph.nodes[0]).toMatchObject({ title: 'Two lines', prompt: 'p', timeoutSec: 2 });
    expect(r.ok && 'command' in r.graph.nodes[0]).toBe(false);
    expect(read(md)).toContain('## n1 · Two lines\n\n- kind: agent\n- timeout: 2\n');
    const base = store.baseline(id);
    expect(base.ok && base.graph && 'command' in base.graph.nodes[0]).toBe(false);
  });

  it('exports the stored Markdown and imports Markdown or a legacy export as a new graph', () => {
    const { store, id, md, read } = setup();
    store.apply(id, { type: 'addNode', node: { id: 'n4', title: 'A', kind: 'agent', prompt: 'p' } }, 'user');
    const exported = store.exportGraph(id);
    expect(exported).toEqual({ ok: true, fileName: 'parity.md', content: read(md) });
    const imported = store.importGraph(`﻿${read(md).replace(/\n/g, '\r\n')}\n## Next\n\n\`\`\`prompt\n\`\`\`\n`);
    if (!imported.ok) throw new Error(imported.error);
    expect(imported.graph.id).toBe('parity-2');
    expect(imported.graph.nodes.map((n) => n.id)).toEqual(['n4', 'n5']);
    expect(imported.graph.nodeSeq).toBe(5);
    const legacy = store.importGraph(JSON.stringify(abTestGraph('A/B', ['wh_small', 'wh_large'])));
    expect(legacy.ok && legacy.graph.id).toBe('a-b');
    expect(store.importGraph('# Bad\n## n1 · A\n')).toEqual({ ok: false, error: 'The file is not a valid Agent Stream graph: line 2: step n1 has no code block. Add a ```prompt block for an agent step or a ```sh block for a command step.' });
  });

  it('gives the built-in templates back unchanged after a reload', () => {
    const { paths, store } = setup();
    for (const content of [JSON.stringify(abTestGraph('A/B', ['wh_small', 'wh_large', 'wh-x'])), JSON.stringify(starterGraph('ABC-1 Fix login', '2026-10-04T00:00:00.000Z'))]) {
      const r = store.importGraph(content);
      if (!r.ok) throw new Error(r.error);
      expect(new GraphStore(paths, fixedClock()).get(r.graph.id)).toEqual(canonicalGraph(r.graph));
      expect(canonicalGraph(r.graph)).toEqual(r.graph);
    }
  });
});
````

Create `engine/test/graphStoreWrites.test.ts` (it wraps `writeFileAtomic` to see the order of writes):

```ts
import { describe, expect, it, vi } from 'vitest';

const writes: string[] = [];
vi.mock('../src/fsutil', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/fsutil')>();
  return { ...real, writeFileAtomic: (path: string, data: string, mode?: number) => (writes.push(path), real.writeFileAtomic(path, data, mode)) };
});
const { GraphStore } = await import('../src/graphStore');
const { fixedClock, tmpProject } = await import('./helpers');

describe('graph file writes', () => {
  it('write the side file first, then the Markdown, each through a temp file', () => {
    const store = new GraphStore(tmpProject(), fixedClock());
    const { id } = store.create('G');
    writes.length = 0;
    store.apply(id, { type: 'addNode', node: { title: 'A', kind: 'agent', prompt: 'p' } }, 'user');
    expect(writes.map((p) => p.slice(p.lastIndexOf(id)))).toEqual([`${id}.meta.json`, `${id}.md`]);
    writes.length = 0;
    store.apply(id, { type: 'moveNode', id: 'n1', position: { x: 1, y: 2 } }, 'user');
    expect(writes.map((p) => p.slice(p.lastIndexOf(id)))).toEqual([`${id}.meta.json`]);
  });
});
```

Apply to `engine/test/graphStore.test.ts`:

````diff
diff --git a/engine/test/graphStore.test.ts b/engine/test/graphStore.test.ts
--- a/engine/test/graphStore.test.ts
+++ b/engine/test/graphStore.test.ts
@@ -33,7 +33,7 @@ describe('GraphStore', () => {
     const paths = tmpProject();
     const store = new GraphStore(paths, fixedClock());
     const { id } = store.create('G');
-    const file = join(paths.graphsDir, `${id}.json`);
+    const file = join(paths.graphsDir, `${id}.md`);
     const before = readFileSync(file, 'utf8');
     expect(store.apply(id, { type: 'connect', from: 'n1', to: 'n2' }, 'user')).toEqual({ ok: false, error: 'node n1 does not exist' });
     expect(readFileSync(file, 'utf8')).toBe(before);
@@ -42,23 +42,18 @@ describe('GraphStore', () => {
 
   it('lists unreadable graph files with their error and never overwrites them', () => {
     const paths = tmpProject();
-    const broken = join(paths.graphsDir, 'broken.json');
-    writeFileSync(broken, '{ "id": "broken", "name": ');
-    writeFileSync(
-      join(paths.graphsDir, 'cyclic.json'),
-      JSON.stringify({
-        id: 'cyclic',
-        name: 'C',
-        nodes: [{ id: 'n1', title: 'a', kind: 'agent' }, { id: 'n2', title: 'b', kind: 'agent' }],
-        edges: [{ id: 'n1->n2', from: 'n1', to: 'n2' }, { id: 'n2->n1', from: 'n2', to: 'n1' }],
-      }),
-    );
+    const broken = join(paths.graphsDir, 'broken.md');
+    writeFileSync(broken, 'no name here\n');
+    writeFileSync(join(paths.graphsDir, 'cyclic.md'), ['# C', '## Flow', '```mermaid', 'flowchart LR', 'n1 --> n2 --> n1', '```', '## n1 · a', '```prompt', '```', '## n2 · b', '```prompt', '```', ''].join('\n'));
+    writeFileSync(join(paths.graphsDir, 'Bad Name.md'), '# Fine\n');
     const store = new GraphStore(paths, fixedClock());
     const list = store.list();
-    expect(list.find((g) => g.id === 'broken')?.error).toContain('invalid JSON');
-    expect(list.find((g) => g.id === 'cyclic')?.error).toContain('cycle');
+    expect(list.find((g) => g.id === 'broken')?.error).toBe('line 1: the file must start with the graph\'s name, as "# Name".');
+    expect(list.find((g) => g.id === 'cyclic')?.error).toContain('line 5: n2 --> n1 would make a cycle');
+    expect(list.find((g) => g.id === 'Bad Name')?.error).toBe('invalid graph id "Bad Name"');
+    expect(store.fileErrors('broken')).toEqual([{ line: 1, message: 'the file must start with the graph\'s name, as "# Name".' }]);
     expect(store.apply('broken', { type: 'setGoal', goal: 'x' }, 'user').ok).toBe(false);
-    expect(readFileSync(broken, 'utf8')).toBe('{ "id": "broken", "name": ');
+    expect(readFileSync(broken, 'utf8')).toBe('no name here\n');
   });
 
   it('sees external edits to a graph file after it was loaded', () => {
@@ -66,9 +61,8 @@ describe('GraphStore', () => {
     const store = new GraphStore(paths, fixedClock());
     const { id } = store.create('G');
     expect(store.get(id).goal).toBe('');
-    const file = join(paths.graphsDir, `${id}.json`);
-    const edited = { ...JSON.parse(readFileSync(file, 'utf8')), goal: 'edited by hand outside agent-stream' };
-    writeFileSync(file, `${JSON.stringify(edited, null, 2)}\n`);
+    const file = join(paths.graphsDir, `${id}.md`);
+    writeFileSync(file, readFileSync(file, 'utf8').replace('# G\n', '# G\n\n## Goal\n\nedited by hand outside agent-stream\n'));
     expect(store.get(id).goal).toBe('edited by hand outside agent-stream');
   });
 
@@ -77,10 +71,11 @@ describe('GraphStore', () => {
     const store = new GraphStore(paths, fixedClock());
     const { id } = store.create('G');
     expect(store.load(id).ok).toBe(true);
-    const file = join(paths.graphsDir, `${id}.json`);
-    const conflicted = '<<<<<<< HEAD\n{ "id": "g" }\n=======\n';
+    const file = join(paths.graphsDir, `${id}.md`);
+    const conflicted = '<<<<<<< HEAD\n# G\n=======\n';
     writeFileSync(file, conflicted);
-    expect(store.list().find((g) => g.id === id)?.error).toContain('invalid JSON');
+    store.list();
+    expect(store.fileErrors(id)[0]).toMatchObject({ line: 1 });
     expect(store.apply(id, { type: 'setGoal', goal: 'x' }, 'user').ok).toBe(false);
     expect(readFileSync(file, 'utf8')).toBe(conflicted);
   });
@@ -155,9 +150,6 @@ describe('ChatLog', () => {
       const store = new GraphStore(paths, fixedClock());
       const { id } = store.create('G');
       store.apply(id, { type: 'addNode', node: { title: 'a', kind: 'agent', prompt: 'p' } }, 'user');
-      // A graph file from before work sessions still carries planner state.
-      const file = join(paths.graphsDir, `${id}.json`);
-      writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), plannerSessionId: 's', plannerOpCursor: 1 }));
       const first = store.duplicate(id);
       const second = store.duplicate(id);
       if (!first.ok || !second.ok) throw new Error('duplicate failed');
@@ -185,10 +177,11 @@ describe('ChatLog', () => {
       const { id } = store.create('Parity');
       const exported = store.exportGraph(id);
       if (!exported.ok) throw new Error(exported.error);
-      expect(exported.fileName).toBe('parity.agent-stream.json');
+      expect(exported.fileName).toBe('parity.md');
       const imported = store.importGraph(exported.content);
       expect(imported.ok && imported.graph.id).toBe('parity-2');
-      expect(store.importGraph('nope')).toEqual({ ok: false, error: 'The file is not valid JSON.' });
+      expect(store.importGraph('nope')).toEqual({ ok: false, error: 'The file is not a valid Agent Stream graph: line 1: the file must start with the graph\'s name, as "# Name".' });
+      expect(store.importGraph('{ nope')).toEqual({ ok: false, error: 'The file is not valid JSON.' });
     });
   });
 });
@@ -344,12 +337,12 @@ describe('agent changes against the baseline', () => {
 
   it('accepts one step into the baseline and leaves the rest marked', () => {
     const { store, id } = withGraph([step('n1'), step('n2')]);
-    store.apply(id, { type: 'updateNode', id: 'n1', patch: { command: 'x' } }, 'agent', { kind: 'planner' });
+    store.apply(id, { type: 'updateNode', id: 'n1', patch: { prompt: 'x' } }, 'agent', { kind: 'planner' });
     store.apply(id, { type: 'deleteNode', id: 'n2' }, 'agent', { kind: 'planner' });
     store.apply(id, { type: 'addNode', node: step('n3') }, 'agent', { kind: 'planner' });
     expect(store.apply(id, { type: 'acceptChange', target: { kind: 'node', id: 'n2' } }, 'user').ok).toBe(true);
     expect(store.apply(id, { type: 'acceptChange', target: { kind: 'node', id: 'n3' } }, 'user').ok).toBe(true);
-    expect(store.agentChanges(id)).toMatchObject([{ id: 'n1', change: 'changed', fields: ['command'] }]);
+    expect(store.agentChanges(id)).toMatchObject([{ id: 'n1', change: 'changed', fields: ['prompt'] }]);
     expect(store.apply(id, { type: 'acceptChange', target: { kind: 'node', id: 'n9' } }, 'user')).toEqual({ ok: false, error: 'node n9 does not exist' });
   });
 
@@ -420,7 +413,7 @@ describe('agent changes against the baseline', () => {
     const changed = vi.fn();
     store.on('changed', changed);
     const ops = () => store.readOps(id).length;
-    const graphFile = join(paths.graphsDir, `${id}.json`);
+    const graphFile = join(paths.graphsDir, `${id}.md`);
     const noChanges = { ok: false, error: 'There are no agent changes to review.' };
     // Nothing differs: no baseline at all.
     let logged = ops();
````

Apply to `engine/test/migrate.test.ts`:

```diff
diff --git a/engine/test/migrate.test.ts b/engine/test/migrate.test.ts
--- a/engine/test/migrate.test.ts
+++ b/engine/test/migrate.test.ts
@@ -1,8 +1,10 @@
-import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
+import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
 import { tmpdir } from 'node:os';
 import { dirname, join } from 'node:path';
 import { describe, expect, it } from 'vitest';
-import { migrateProjectFolder, migrateValuesFile } from '../src/migrate';
+import { GraphStore } from '../src/graphStore';
+import { migrateGraphsToMarkdown, migrateProjectFolder, migrateValuesFile } from '../src/migrate';
+import { fixedClock, tmpProject } from './helpers';
 
 const tmp = (prefix: string) => mkdtempSync(join(tmpdir(), prefix));
 const posix = process.platform !== 'win32';
@@ -101,3 +103,52 @@ describe('migrateValuesFile', () => {
     expect(existsSync(file)).toBe(false);
   });
 });
+
+describe('migrateGraphsToMarkdown', () => {
+  const legacy = (id: string, name: string) =>
+    JSON.stringify({
+      id,
+      name,
+      goal: 'Ship it.',
+      instructions: '',
+      variables: [{ name: 'schema', description: 'Where' }],
+      nodes: [{ id: 'n1', title: 'Build', kind: 'command', command: 'make', position: { x: 5, y: 6 }, createdBy: 'agent', updatedBy: 'user', updatedAt: '2026-10-01T00:00:00.000Z' }],
+      edges: [],
+      nodeSeq: 3,
+      updatedAt: '2026-10-01T00:00:00.000Z',
+    });
+
+  it('writes <id>.md and <id>.meta.json, keeps the JSON as <id>.json.bak, and runs once', () => {
+    const paths = tmpProject();
+    writeFileSync(join(paths.graphsDir, 'g1.json'), legacy('g1', 'First'));
+    writeFileSync(join(paths.graphsDir, 'g1.baseline.json'), legacy('g1', 'First'));
+    const store = new GraphStore(paths, fixedClock());
+    expect(migrateGraphsToMarkdown(paths, store)).toEqual({ notes: ['Converted the graph "First" to g1.md; the old file is kept as g1.json.bak.'], warnings: [] });
+    expect(readdirSync(paths.graphsDir).sort()).toEqual(['g1.baseline.json', 'g1.json.bak', 'g1.md', 'g1.meta.json']);
+    expect(readFileSync(join(paths.graphsDir, 'g1.md'), 'utf8')).toContain('# First\n\n## Goal\n\nShip it.\n');
+    expect(new GraphStore(paths, fixedClock()).get('g1')).toMatchObject({ nodeSeq: 3, nodes: [{ id: 'n1', position: { x: 5, y: 6 }, createdBy: 'agent' }] });
+    expect(migrateGraphsToMarkdown(paths, store)).toEqual({ notes: [], warnings: [] });
+  });
+
+  it('leaves a file it cannot read as it is, and skips a graph that already has its Markdown', () => {
+    const paths = tmpProject();
+    writeFileSync(join(paths.graphsDir, 'bad.json'), '{ nope');
+    writeFileSync(join(paths.graphsDir, 'cyclic.json'), JSON.stringify({ id: 'cyclic', name: 'C', nodes: [{ id: 'n1', title: 'a', kind: 'agent' }], edges: [{ id: 'n1->n1', from: 'n1', to: 'n1' }] }));
+    writeFileSync(join(paths.graphsDir, 'done.json'), legacy('done', 'Done'));
+    writeFileSync(join(paths.graphsDir, 'done.md'), '# Done by hand\n');
+    const r = migrateGraphsToMarkdown(paths, new GraphStore(paths, fixedClock()));
+    expect(r.notes).toEqual([]);
+    expect(r.warnings).toEqual([expect.stringMatching(/^Could not convert the graph file bad\.json to Markdown \(invalid JSON: .*\); it was left as it is\.$/), expect.stringMatching(/^Could not convert the graph file cyclic\.json to Markdown \(.*\); it was left as it is\.$/)]);
+    expect(readdirSync(paths.graphsDir).sort()).toEqual(['bad.json', 'cyclic.json', 'done.json', 'done.md']);
+  });
+
+  it('keeps the converted graph when the old file cannot be renamed, and says so', () => {
+    const paths = tmpProject();
+    writeFileSync(join(paths.graphsDir, 'g1.json'), legacy('g1', 'First'));
+    const r = migrateGraphsToMarkdown(paths, new GraphStore(paths, fixedClock()), () => {
+      throw new Error('EBUSY');
+    });
+    expect(r).toEqual({ notes: [], warnings: ['Converted the graph "First" to g1.md, but could not rename g1.json to g1.json.bak (EBUSY). Delete g1.json when you no longer need it.'] });
+    expect(existsSync(join(paths.graphsDir, 'g1.md'))).toBe(true);
+  });
+});
```

Apply to `engine/test/app.test.ts`:

```diff
diff --git a/engine/test/app.test.ts b/engine/test/app.test.ts
--- a/engine/test/app.test.ts
+++ b/engine/test/app.test.ts
@@ -1671,8 +1671,21 @@ describe('app: model and effort', () => {
     await flush();
     const exported = app.exportGraph(graphId);
     if (!exported.ok) throw new Error(exported.error);
-    for (const text of [exported.content, readFileSync(join(paths.graphsDir, `${graphId}.json`), 'utf8')]) {
+    for (const text of [exported.content, readFileSync(join(paths.graphsDir, `${graphId}.md`), 'utf8'), readFileSync(join(paths.graphsDir, `${graphId}.meta.json`), 'utf8')]) {
       expect(text).not.toMatch(/"model"|"effort"|sonnet|haiku/);
     }
   });
 });
+
+describe('graphs from before Markdown', () => {
+  it('converts them on start, after the planner-state move, with one note per graph', () => {
+    const paths = tmpProject();
+    writeFileSync(join(paths.graphsDir, 'g1.json'), JSON.stringify({ ...emptyGraph('g1', 'Old graph', 't'), plannerSessionId: 's' }));
+    const app = createApp({ ...appTestDeps(), projectDir: paths.root, valuesFile: tmpValuesFile(), provider: testProvider(), status: signedIn, maxParallel: 1 });
+    expect(app.startupNotes()).toEqual(['Converted the graph "Old graph" to g1.md; the old file is kept as g1.json.bak.']);
+    expect(app.startupWarnings()).toEqual([]);
+    expect(app.sessionStore.plannerState('default', 'g1')).toMatchObject({ sessionId: 's' });
+    expect(app.listGraphs().map((g) => g.id)).toEqual(['g1']);
+    expect(existsSync(join(paths.graphsDir, 'g1.json.bak'))).toBe(true);
+  });
+});
```

Apply to `engine/test/ticketGraph.test.ts`:

```diff
diff --git a/engine/test/ticketGraph.test.ts b/engine/test/ticketGraph.test.ts
--- a/engine/test/ticketGraph.test.ts
+++ b/engine/test/ticketGraph.test.ts
@@ -77,7 +77,7 @@ describe('starter ticket graph', () => {
     expect(new VariableValues(valuesFileFor(a, home)).get(ga.graphId)).toEqual({ check_command: 'npm test' });
     expect(existsSync(valuesFileFor(b, home))).toBe(false);
     expect(readdirSync(join(a, '.agent-stream')).sort()).toEqual(['.gitignore', 'graphs', 'runs', 'sessions']);
-    expect(readdirSync(join(a, '.agent-stream', 'graphs'))).toEqual([`${ga.graphId}.json`]);
+    expect(readdirSync(join(a, '.agent-stream', 'graphs')).sort()).toEqual([`${ga.graphId}.md`, `${ga.graphId}.meta.json`]);
     expect(readdirSync(join(a, '.agent-stream', 'runs'))).toEqual([]);
     expect(readdirSync(join(a, '.agent-stream', 'sessions'))).toEqual([]);
     expect(new GraphStore(projectPaths(b)).get(gb.graphId).name).toBe('ABC-2');
```

Apply to `extension/test/commands.test.ts`:

```diff
diff --git a/extension/test/commands.test.ts b/extension/test/commands.test.ts
--- a/extension/test/commands.test.ts
+++ b/extension/test/commands.test.ts
@@ -120,7 +120,7 @@ describe('graph commands', () => {
     expect(s.ui.error).toHaveBeenLastCalledWith("Couldn't import: The file is larger than 1 MB.");
     s.ui.openFile.mockResolvedValueOnce({ size: 4, read: async () => 'nope' });
     await s.commands.importGraph();
-    expect(s.ui.error).toHaveBeenLastCalledWith("Couldn't import: The file is not valid JSON.");
+    expect(s.ui.error).toHaveBeenLastCalledWith('Couldn\'t import: The file is not a valid Agent Stream graph: line 1: the file must start with the graph\'s name, as "# Name".');
     s.ui.openFile.mockResolvedValueOnce({ size: exported.content.length, read: async () => exported.content });
     await s.commands.importGraph();
     expect(s.opened).toEqual([{ folder: s.folders[0], graphId: 'parity' }]);
@@ -135,10 +135,10 @@ describe('graph commands', () => {
     let written = '';
     s.ui.saveFile.mockResolvedValueOnce({ write: async (content: string) => void (written = content) });
     await s.commands.exportGraph({ folder: s.folders[0], graphId: g.id });
-    expect(s.ui.saveFile).toHaveBeenCalledWith(join(s.folders[0].path, 'parity.agent-stream.json'));
-    expect(JSON.parse(written).graph.variables).toEqual([{ name: 'schema', description: '' }]);
+    expect(s.ui.saveFile).toHaveBeenCalledWith(join(s.folders[0].path, 'parity.md'), 'markdown');
+    expect(written).toContain('## Variables\n\n- `schema`\n');
     expect(written).not.toContain('secret-schema');
-    expect(s.ui.info).toHaveBeenCalledWith('Exported parity.agent-stream.json. Variable values were left out.');
+    expect(s.ui.info).toHaveBeenCalledWith('Exported parity.md. Variable values were left out.');
   });
 
   describe('Export Run Report', () => {
```

Apply to `extension/test/parallelTickets.test.ts`:

```diff
diff --git a/extension/test/parallelTickets.test.ts b/extension/test/parallelTickets.test.ts
--- a/extension/test/parallelTickets.test.ts
+++ b/extension/test/parallelTickets.test.ts
@@ -107,7 +107,7 @@ describe('Set Up Parallel Tickets', () => {
       [r.p1, 'abc-1-fix-login', T1],
       [r.p2, 'abc-2-add-logout', T2],
     ]) {
-      expect(JSON.parse(readFileSync(join(path, '.agent-stream', 'graphs', `${id}.json`), 'utf8'))).toMatchObject({ name: ticket, goal: `Complete ticket: ${ticket}` });
+      expect(readFileSync(join(path, '.agent-stream', 'graphs', `${id}.md`), 'utf8')).toContain(`# ${ticket}\n\n## Goal\n\nComplete ticket: ${ticket}\n`);
       expect(JSON.parse(readFileSync(valuesFileFor(path, s.home), 'utf8')).graphs[id]).toEqual({ check_command: 'npm test && npm run typecheck' });
     }
     expect(s.ui.inputBox.mock.calls.map(([o]) => o.prompt)).toEqual([
@@ -219,7 +219,7 @@ describe('Set Up Parallel Tickets', () => {
     await s.cmds.setUpParallelTickets();
     expect(s.ui.error).toHaveBeenCalledWith(`Created 1 of 2 worktrees; stopped at ${T2}: fatal: could not create work tree dir '${r.p2}'. Nothing was removed.`);
     expect(s.ui.infoAction).toHaveBeenCalledWith('Set up 1 ticket worktrees from a1b2c3d.', 'Open in New VS Code Window…');
-    expect(existsSync(join(r.p1, '.agent-stream', 'graphs', 'abc-1-fix-login.json'))).toBe(true);
+    expect(existsSync(join(r.p1, '.agent-stream', 'graphs', 'abc-1-fix-login.md'))).toBe(true);
     expect(git.ran().some((a) => a.startsWith('worktree remove'))).toBe(false);
     expect(s.ui.openInNewWindow).not.toHaveBeenCalled();
   });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w engine -- test/graphFiles.test.ts test/graphStoreWrites.test.ts test/graphStore.test.ts test/migrate.test.ts`
Expected: FAIL. No `.md` file is written, `migrateGraphsToMarkdown` doesn't exist, the export is still `parity.agent-stream.json`.

- [ ] **Step 3: Move the store to Markdown files**

Apply to `engine/src/graphStore.ts`. What changes: the file is `<id>.md` beside `<id>.meta.json`; the cache keeps both texts and stamps; a broken Markdown file is remembered (so an unchanged one isn't re-read on every list) and its problems kept in `errors`; `save` writes canonical text, side file first, skipping files whose text is unchanged, and returns the saved graph; baselines are canonicalized; export and import use Markdown.

```diff
diff --git a/engine/src/graphStore.ts b/engine/src/graphStore.ts
--- a/engine/src/graphStore.ts
+++ b/engine/src/graphStore.ts
@@ -3,18 +3,26 @@ import { appendFileSync, existsSync, readdirSync, readFileSync, rmSync, statSync
 import { join } from 'node:path';
 import {
   applyOp,
+  canonicalGraph,
   diffGraphs,
   edgeId,
   emptyGraph,
+  formatFileErrors,
+  graphFromDoc,
+  MAX_IMPORT_CHARS,
   nextNodeId,
   parseExportFile,
   parseGraph,
-  toExportFile,
+  parseGraphMarkdown,
+  parseGraphMeta,
+  serializeGraphMarkdown,
+  serializeGraphMeta,
   type Actor,
   type AgentChange,
   type ChangeSource,
   type ChangeTarget,
   type Graph,
+  type GraphFileError,
   type GraphNode,
   type GraphListItem,
   type GraphResult,
@@ -38,6 +46,18 @@ const NO_CHANGES = 'There are no agent changes to review.';
 const ONLY_USER_REVIEWS = 'Only you can accept or revert agent changes.';
 const BASELINE_SUFFIX = '.baseline.json';
 
+/** A file's modification time and size: a cached graph is valid while both of its files keep theirs. */
+type Stamp = { mtimeMs: number; size: number };
+/** A graph as last read or written, with the exact text of its two files. */
+type Cached = { graph: Graph; text: string; metaText?: string; md: Stamp; meta?: Stamp };
+
+function stampOf(path: string): Stamp | undefined {
+  const s = statSync(path, { throwIfNoEntry: false });
+  return s && { mtimeMs: s.mtimeMs, size: s.size };
+}
+const sameStamp = (a: Stamp | undefined, b: Stamp | undefined) => a?.mtimeMs === b?.mtimeMs && a?.size === b?.size;
+const readIfExists = (path: string): string | undefined => (existsSync(path) ? readFileSync(path, 'utf8') : undefined);
+
 /** Whether an agent op made or touched this change (for attribution). */
 function touches(op: Op, change: AgentChange): boolean {
   if (change.kind === 'node') {
@@ -54,10 +74,16 @@ function withContentOf(node: GraphNode, source: GraphNode): GraphNode {
   return { ...rest, title: source.title, kind: source.kind, ...Object.fromEntries(Object.entries(optional).filter(([, v]) => v !== undefined)) };
 }
 
-/** Single source of truth for graphs. Every change goes through `apply`. */
+/**
+ * Single source of truth for graphs. Every change goes through `apply`. A graph is two files (Markdown graph files spec
+ * §5.1): `<id>.md`, its meaning, and `<id>.meta.json`, positions and bookkeeping.
+ */
 export class GraphStore extends EventEmitter {
-  /** Parsed graphs keyed by id, valid only while the file's mtime and size are unchanged. */
-  private cache = new Map<string, { graph: Graph; mtimeMs: number; size: number }>();
+  private cache = new Map<string, Cached>();
+  /** Markdown files that didn't parse, so an unchanged broken file isn't read again on every list. */
+  private failed = new Map<string, { md: Stamp; meta?: Stamp; error: string }>();
+  /** The problems in each graph's Markdown file. */
+  private errors = new Map<string, GraphFileError[]>();
 
   constructor(
     private paths: ProjectPaths,
@@ -67,6 +93,15 @@ export class GraphStore extends EventEmitter {
   }
 
   private file(id: string): string {
+    return join(this.paths.graphsDir, `${id}.md`);
+  }
+
+  private metaFile(id: string): string {
+    return join(this.paths.graphsDir, `${id}.meta.json`);
+  }
+
+  /** A graph file from before Markdown, not converted yet: its id stays taken. */
+  private legacyFile(id: string): string {
     return join(this.paths.graphsDir, `${id}.json`);
   }
 
@@ -85,14 +120,14 @@ export class GraphStore extends EventEmitter {
   private uniqueId(name: string): string {
     const base = slugify(name);
     let id = base;
-    for (let i = 2; existsSync(this.file(id)); i++) id = `${base}-${i}`;
+    for (let i = 2; existsSync(this.file(id)) || existsSync(this.legacyFile(id)); i++) id = `${base}-${i}`;
     return id;
   }
 
   list(): GraphListItem[] {
     const ids = readdirSync(this.paths.graphsDir)
-      .filter((f) => f.endsWith('.json') && !f.endsWith(BASELINE_SUFFIX))
-      .map((f) => f.slice(0, -'.json'.length))
+      .filter((f) => f.endsWith('.md'))
+      .map((f) => f.slice(0, -'.md'.length))
       .sort();
     const items = ids.map((id): GraphListItem => {
       const r = this.load(id);
@@ -107,29 +142,63 @@ export class GraphStore extends EventEmitter {
 
   load(id: string): GraphResult {
     if (!isGraphId(id)) return { ok: false, error: `invalid graph id "${id}"` };
-    const path = this.file(id);
-    const stat = statSync(path, { throwIfNoEntry: false });
-    if (!stat) {
-      this.cache.delete(id);
+    const md = stampOf(this.file(id));
+    if (!md) {
+      this.forget(id);
       return { ok: false, error: `graph "${id}" not found` };
     }
+    const meta = stampOf(this.metaFile(id));
     const cached = this.cache.get(id);
-    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return { ok: true, graph: cached.graph };
-    // The file changed on disk (hand edit, git checkout, ...) or was never loaded: re-read it.
-    this.cache.delete(id);
-    let json: unknown;
-    try {
-      json = JSON.parse(readFileSync(path, 'utf8'));
-    } catch (e) {
-      return { ok: false, error: `invalid JSON: ${(e as Error).message}` };
+    if (cached && sameStamp(cached.md, md) && sameStamp(cached.meta, meta)) return { ok: true, graph: cached.graph };
+    const failed = this.failed.get(id);
+    if (!cached && failed && sameStamp(failed.md, md) && sameStamp(failed.meta, meta)) return { ok: false, error: failed.error };
+    // The files changed on disk (hand edit, git checkout, ...) or were never read: read them.
+    return this.read(id, md, meta);
+  }
+
+  /** Reads the graph's two files. A Markdown file that doesn't parse is reported and never overwritten. */
+  private read(id: string, md: Stamp, meta: Stamp | undefined): GraphResult {
+    const text = readFileSync(this.file(id), 'utf8');
+    const metaText = readIfExists(this.metaFile(id));
+    const parsed = parseGraphMarkdown(text);
+    if (!parsed.ok) {
+      const error = formatFileErrors(parsed.errors);
+      this.cache.delete(id);
+      this.failed.set(id, { md, meta, error });
+      this.setErrors(id, parsed.errors);
+      return { ok: false, error };
     }
-    const r = parseGraph(json);
-    if (!r.ok) return r;
-    const graph = { ...r.graph, id };
-    this.cache.set(id, { graph, mtimeMs: stat.mtimeMs, size: stat.size });
+    const graph = canonicalGraph(graphFromDoc(parsed.doc, parseGraphMeta(metaText), id, this.clock()));
+    this.cache.set(id, { graph, text, metaText, md, meta });
+    this.failed.delete(id);
+    this.setErrors(id, []);
     return { ok: true, graph };
   }
 
+  /** Writes a graph converted from a file in the old JSON format (spec §5.2), in canonical form. */
+  writeConverted(graph: Graph): Graph {
+    return this.save(graph);
+  }
+
+  /** The problems in the graph's Markdown file: [] when it reads. */
+  fileErrors(id: string): GraphFileError[] {
+    return this.errors.get(id) ?? [];
+  }
+
+  private setErrors(id: string, errors: GraphFileError[]): void {
+    if (JSON.stringify(this.errors.get(id) ?? []) === JSON.stringify(errors)) return;
+    if (errors.length) this.errors.set(id, errors);
+    else this.errors.delete(id);
+    this.emit('fileErrors', id, errors);
+  }
+
+  /** Drops what the store remembers about a graph whose Markdown file is gone. */
+  private forget(id: string): void {
+    this.cache.delete(id);
+    this.failed.delete(id);
+    this.setErrors(id, []);
+  }
+
   get(id: string): Graph {
     const r = this.load(id);
     if (!r.ok) throw new Error(r.error);
@@ -138,9 +207,7 @@ export class GraphStore extends EventEmitter {
 
   create(name: string): Graph {
     const id = this.uniqueId(name);
-    const graph = emptyGraph(id, name.trim() || id, this.clock());
-    this.save(graph);
-    return graph;
+    return this.save(emptyGraph(id, name.trim() || id, this.clock()));
   }
 
   /** Changes the display name only; the id (file name) stays, so runs keep pointing at it. */
@@ -149,8 +216,7 @@ export class GraphStore extends EventEmitter {
     if (!trimmed) return { ok: false, error: 'A graph needs a name.' };
     const r = this.load(id);
     if (!r.ok) return r;
-    const graph = { ...r.graph, name: trimmed, updatedAt: this.clock() };
-    this.save(graph);
+    const graph = this.save({ ...r.graph, name: trimmed, updatedAt: this.clock() });
     this.emit('changed', graph);
     return { ok: true, graph };
   }
@@ -162,32 +228,38 @@ export class GraphStore extends EventEmitter {
     const names = new Set(this.list().map((g) => g.name));
     let name = `${r.graph.name} copy`;
     for (let i = 2; names.has(name); i++) name = `${r.graph.name} copy ${i}`;
-    const graph: Graph = { ...r.graph, id: this.uniqueId(name), name, updatedAt: this.clock() };
-    this.save(graph);
+    const graph = this.save({ ...r.graph, id: this.uniqueId(name), name, updatedAt: this.clock() });
     return { ok: true, graph };
   }
 
-  /** Removes the graph, its agent-change baseline, its edit history and its chat. Run logs stay on disk. */
+  /** Removes the graph, its side file, its agent-change baseline, its edit history and its chat. Run logs stay on disk. */
   delete(id: string): { ok: true } | { ok: false; error: string } {
     if (!isGraphId(id)) return { ok: false, error: `invalid graph id "${id}"` };
     if (!existsSync(this.file(id))) return { ok: false, error: `graph "${id}" not found` };
-    for (const f of [this.file(id), this.baselineFile(id), this.opsFile(id), this.chatFile(id)]) rmSync(f, { force: true });
-    this.cache.delete(id);
+    for (const f of [this.file(id), this.metaFile(id), this.baselineFile(id), this.opsFile(id), this.chatFile(id)]) rmSync(f, { force: true });
+    this.forget(id);
     return { ok: true };
   }
 
+  /** The graph's Markdown, as `<id>.md` (spec §5.4): the stored file's text, so never a variable value. */
   exportGraph(id: string): { ok: true; fileName: string; content: string } | { ok: false; error: string } {
     const r = this.load(id);
     if (!r.ok) return r;
-    return { ok: true, fileName: `${id}.agent-stream.json`, content: `${JSON.stringify(toExportFile(r.graph, this.clock()), null, 2)}\n` };
+    return { ok: true, fileName: `${id}.md`, content: serializeGraphMarkdown(r.graph) };
   }
 
+  /** A graph file in the Markdown format, or an `.agent-stream.json` export (content starting with `{`), as a new graph. */
   importGraph(content: string): GraphResult {
-    const parsed = parseExportFile(content, 'import', this.clock());
-    if (!parsed.ok) return parsed;
-    const graph = { ...parsed.graph, id: this.uniqueId(parsed.graph.name) };
-    this.save(graph);
-    return { ok: true, graph };
+    if (content.length > MAX_IMPORT_CHARS) return { ok: false, error: 'The file is larger than 1 MB.' };
+    const text = content.replace(/^\uFEFF/, '');
+    if (text.trimStart().startsWith('{')) {
+      const legacy = parseExportFile(text, 'import', this.clock());
+      if (!legacy.ok) return legacy;
+      return { ok: true, graph: this.save({ ...legacy.graph, id: this.uniqueId(legacy.graph.name) }) };
+    }
+    const parsed = parseGraphMarkdown(text);
+    if (!parsed.ok) return { ok: false, error: `The file is not a valid Agent Stream graph: ${formatFileErrors(parsed.errors, 3)}` };
+    return { ok: true, graph: this.save(graphFromDoc(parsed.doc, undefined, this.uniqueId(parsed.doc.name), this.clock())) };
   }
 
   /**
@@ -217,14 +289,14 @@ export class GraphStore extends EventEmitter {
         if (mirrored.ok) this.writeBaseline(mirrored.graph);
       }
     }
-    this.save(r.graph);
+    const saved = this.save(r.graph);
     if (resolved.type !== 'moveNode') {
-      this.dropBaselineIfSame(r.graph);
+      this.dropBaselineIfSame(saved);
       this.record(graphId, { at, by, op: resolved, ...(source && { source }) });
     }
-    this.emit('changed', r.graph);
+    this.emit('changed', saved);
     this.emit('op', graphId, resolved);
-    return r;
+    return { ok: true, graph: saved };
   }
 
   /** The user's graph before pending agent changes: none when the file is absent. */
@@ -239,7 +311,7 @@ export class GraphStore extends EventEmitter {
       r = { ok: false, error: (e as Error).message };
     }
     if (!r.ok) return { ok: false, error: `The agent-change baseline ${file} could not be read (${r.error}).` };
-    return { ok: true, graph: { ...r.graph, id } };
+    return { ok: true, graph: canonicalGraph({ ...r.graph, id }) };
   }
 
   /** What agents changed since the baseline, each attributed to the latest agent op that touched it. */
@@ -276,9 +348,11 @@ export class GraphStore extends EventEmitter {
     if (pending) return { ok: false, error: pending };
     const r = op.type === 'acceptChange' ? accept(base.graph, graph, op.target) : revert(base.graph, graph, op.target, at);
     if (!r.ok) return r;
-    if (op.type === 'acceptChange') this.writeBaseline(r.graph);
-    else this.save(r.graph);
-    return this.finishReview(graphId, op, op.type === 'acceptChange' ? graph : r.graph, at);
+    if (op.type === 'acceptChange') {
+      this.writeBaseline(r.graph);
+      return this.finishReview(graphId, op, graph, at);
+    }
+    return this.finishReview(graphId, op, this.save(r.graph), at);
   }
 
   private finishReview(graphId: string, op: ReviewOp, graph: Graph, at: string): GraphResult {
@@ -290,7 +364,7 @@ export class GraphStore extends EventEmitter {
   }
 
   private writeBaseline(graph: Graph): void {
-    writeFileAtomic(this.baselineFile(graph.id), `${JSON.stringify(graph, null, 2)}\n`);
+    writeFileAtomic(this.baselineFile(graph.id), `${JSON.stringify(canonicalGraph(graph), null, 2)}\n`);
   }
 
   /** No differences left means no pending agent changes: the graph is its own baseline again. */
@@ -308,11 +382,22 @@ export class GraphStore extends EventEmitter {
     return readJsonLines<OpRecord>(this.opsFile(graphId));
   }
 
-  private save(graph: Graph): void {
-    const path = this.file(graph.id);
-    writeFileAtomic(path, `${JSON.stringify(graph, null, 2)}\n`);
-    const { mtimeMs, size } = statSync(path);
-    this.cache.set(graph.id, { graph, mtimeMs, size });
+  /**
+   * Writes the graph in canonical form (spec §4.3), each file as a temp file renamed into place: the side file first,
+   * then the Markdown. A file whose text wouldn't change isn't rewritten, so a move leaves the Markdown alone.
+   */
+  private save(graph: Graph): Graph {
+    const g = canonicalGraph(graph);
+    const text = serializeGraphMarkdown(g);
+    const metaText = serializeGraphMeta(g);
+    const mdPath = this.file(g.id);
+    const metaPath = this.metaFile(g.id);
+    const cached = this.cache.get(g.id);
+    if (cached?.metaText !== metaText || !existsSync(metaPath)) writeFileAtomic(metaPath, metaText);
+    if (cached?.text !== text || !existsSync(mdPath)) writeFileAtomic(mdPath, text);
+    this.cache.set(g.id, { graph: g, text, metaText, md: stampOf(mdPath)!, meta: stampOf(metaPath) });
+    this.failed.delete(g.id);
+    return g;
   }
 }
 
```

- [ ] **Step 4: Convert graphs from before Markdown on startup**

Apply to `engine/src/migrate.ts`:

```diff
diff --git a/engine/src/migrate.ts b/engine/src/migrate.ts
--- a/engine/src/migrate.ts
+++ b/engine/src/migrate.ts
@@ -1,5 +1,8 @@
-import { chmodSync, copyFileSync, existsSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
+import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync } from 'node:fs';
 import { dirname, join } from 'node:path';
+import { parseGraph } from '@agent-stream/shared';
+import type { GraphStore } from './graphStore';
+import { isGraphId, type ProjectPaths } from './paths';
 
 const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
 
@@ -38,3 +41,48 @@ export function migrateValuesFile(file: string, legacyFile: string, rename: type
     return [`Could not move the variable values file from ${legacyFile} to ${file} (${errorText(e)}); variable values are treated as empty.`];
   }
 }
+
+/**
+ * Converts each graph file from before Markdown, `<id>.json` without a `<id>.md`, to `<id>.md` and `<id>.meta.json`,
+ * then renames the JSON to `<id>.json.bak` (Markdown graph files spec §5.2). Baselines stay JSON. Returns one note per
+ * converted graph and a warning per file left as it was; never throws, never deletes.
+ */
+export function migrateGraphsToMarkdown(paths: ProjectPaths, store: GraphStore, rename: typeof renameSync = renameSync): { notes: string[]; warnings: string[] } {
+  const notes: string[] = [];
+  const warnings: string[] = [];
+  if (!existsSync(paths.graphsDir)) return { notes, warnings };
+  const ids = readdirSync(paths.graphsDir)
+    .filter((f) => f.endsWith('.json') && !f.endsWith('.baseline.json') && !f.endsWith('.meta.json'))
+    .map((f) => f.slice(0, -'.json'.length))
+    .filter((id) => isGraphId(id) && !existsSync(join(paths.graphsDir, `${id}.md`)))
+    .sort();
+  for (const id of ids) {
+    const file = join(paths.graphsDir, `${id}.json`);
+    const leftAlone = (why: string) => warnings.push(`Could not convert the graph file ${id}.json to Markdown (${why}); it was left as it is.`);
+    let json: unknown;
+    try {
+      json = JSON.parse(readFileSync(file, 'utf8'));
+    } catch (e) {
+      leftAlone(`invalid JSON: ${errorText(e)}`);
+      continue;
+    }
+    const r = parseGraph(json);
+    if (!r.ok) {
+      leftAlone(r.error);
+      continue;
+    }
+    try {
+      store.writeConverted({ ...r.graph, id });
+    } catch (e) {
+      leftAlone(errorText(e));
+      continue;
+    }
+    try {
+      rename(file, `${file}.bak`);
+      notes.push(`Converted the graph "${r.graph.name}" to ${id}.md; the old file is kept as ${id}.json.bak.`);
+    } catch (e) {
+      warnings.push(`Converted the graph "${r.graph.name}" to ${id}.md, but could not rename ${id}.json to ${id}.json.bak (${errorText(e)}). Delete ${id}.json when you no longer need it.`);
+    }
+  }
+  return { notes, warnings };
+}
```

Apply to `engine/src/app.ts` (the conversion runs right after `migrateLegacy`, which reads the old JSON files):

```diff
diff --git a/engine/src/app.ts b/engine/src/app.ts
--- a/engine/src/app.ts
+++ b/engine/src/app.ts
@@ -36,7 +36,7 @@ import { createCommandExecutor } from './commandExecutor';
 import type { Executors, NodeExecutor } from './executors';
 import { inspectCheckout, type GitExec } from './git';
 import { GraphStore } from './graphStore';
-import { migrateProjectFolder, migrateValuesFile } from './migrate';
+import { migrateGraphsToMarkdown, migrateProjectFolder, migrateValuesFile } from './migrate';
 import { ensureDataDirs, projectPaths } from './paths';
 import { Planner } from './planner';
 import { refineRequest, splitRequest } from './refine';
@@ -144,6 +144,9 @@ export function createApp(d: AppDeps) {
   const sessions = new SessionStore(paths, clock);
   // Planner state and chats from before work sessions move into the Default session.
   migrationWarnings.push(...migrateLegacy(paths, sessions));
+  // After the planner-state move above, which reads the old JSON graph files.
+  const converted = migrateGraphsToMarkdown(paths, graphStore, d.rename);
+  migrationWarnings.push(...converted.warnings);
   sessions.ensureDefault();
   const runStore = new RunStore(paths);
   const platform = d.platform ?? process.platform;
@@ -760,5 +763,7 @@ export function createApp(d: AppDeps) {
     status: () => status,
     dispose,
     startupWarnings,
+    /** One line per graph converted to Markdown on startup, for the Agent Stream output channel. */
+    startupNotes: () => [...converted.notes],
   };
 }
```

- [ ] **Step 5: Export as Markdown and import `.md` files in the extension**

Apply to `extension/src/commands.ts`:

```diff
diff --git a/extension/src/commands.ts b/extension/src/commands.ts
--- a/extension/src/commands.ts
+++ b/extension/src/commands.ts
@@ -109,7 +109,7 @@ export function graphCommands(d: CommandDeps) {
       if (!t) return;
       const r = app(t.folder).exportGraph(t.graphId);
       if (!r.ok) return d.ui.error(r.error);
-      const file = await d.ui.saveFile(join(t.folder.path, r.fileName));
+      const file = await d.ui.saveFile(join(t.folder.path, r.fileName), 'markdown');
       if (!file) return;
       await file.write(r.content);
       d.ui.info(`Exported ${r.fileName}. Variable values were left out.`);
```

Apply to `extension/src/ui.ts`:

```diff
diff --git a/extension/src/ui.ts b/extension/src/ui.ts
--- a/extension/src/ui.ts
+++ b/extension/src/ui.ts
@@ -1,7 +1,7 @@
 import * as vscode from 'vscode';
 import type { Ui } from './commands';
 
-const filters = { 'Agent Stream graph': ['json'] };
+const filters = { 'Agent Stream graph': ['md', 'json'] };
 const saveFilters = { graph: filters, markdown: { Markdown: ['md'] } };
 
 export const vscodeUi: Ui = {
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm test -w engine && npm test -w extension`
Expected: PASS (all engine and extension tests).

- [ ] **Step 7: Typecheck and commit**

Run: `npm run typecheck`
Expected: no errors.

```bash
git add engine/src/graphStore.ts engine/src/migrate.ts engine/src/app.ts engine/test/graphFiles.test.ts engine/test/graphStoreWrites.test.ts engine/test/graphStore.test.ts engine/test/migrate.test.ts engine/test/app.test.ts engine/test/ticketGraph.test.ts extension/src/commands.ts extension/src/ui.ts extension/test/commands.test.ts extension/test/parallelTickets.test.ts
git commit -m "$(cat <<'MSG'
feat(engine): save graphs as Markdown with a side file

GraphStore reads and writes <id>.md and <id>.meta.json, always in
canonical form, side file first, each through a temp file and rename.
Graphs saved as <id>.json are converted on startup (the JSON kept as
.json.bak, one note per graph). Export writes <id>.md; import takes
Markdown or an older JSON export.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
)"
```

---

### Task 7: Edits made outside Agent Stream

**Spec tests owned (§9):** engine — `graphFileChanged` ignores its own writes, applies outside edits as `via: 'file'`, all or nothing on failure, normalises ids, keeps the baseline rules; `graphFileDeleted`. Review Focus 1, 2 and 4.

**Files:**
- Modify: `engine/src/graphStore.ts`
- Create: `engine/test/graphFileSync.test.ts`

**Interfaces:**
- Consumes: `diffToOps`, `opLine` (Task 5); `withMeta`, `parseGraphMeta` (Task 4); the Task 6 store.
- Produces:
  ```ts
  export type FileSync = 'unchanged' | 'applied' | 'meta' | 'added' | 'errors' | 'deleted';
  // GraphStore
  graphFileChanged(id: string): FileSync; // §6.2–6.4; emits 'changed', 'op', 'fileErrors'
  graphFileDeleted(id: string): FileSync; // §6.5; emits 'fileDeleted' (id) when a known graph's file is gone
  // apply / rename / revertChange refuse while fileErrors(id) is non-empty (R6); moveNode is allowed.
  // load() hands an outside change on a cached graph to graphFileChanged (R7), and a vanished file to graphFileDeleted.
  ```

- [ ] **Step 1: Write the failing test**

Create `engine/test/graphFileSync.test.ts`:

````ts
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { GraphStore } from '../src/graphStore';
import { fixedClock, tmpProject } from './helpers';

/** A store with one graph: n1 (agent) --> n2 (command), a goal and a variable, all made by the user. */
function setup() {
  const paths = tmpProject();
  const store = new GraphStore(paths, fixedClock());
  const { id } = store.create('Parity');
  store.apply(id, { type: 'setGoal', goal: 'Prove it.' }, 'user');
  store.apply(id, { type: 'addVariable', name: 'schema', description: 'Where' }, 'user');
  store.apply(id, { type: 'addNode', node: { title: 'Plan', kind: 'agent', prompt: 'Plan it.' } }, 'user');
  store.apply(id, { type: 'addNode', node: { title: 'Build', kind: 'command', command: 'make' } }, 'user');
  store.apply(id, { type: 'connect', from: 'n1', to: 'n2' }, 'user');
  const md = join(paths.graphsDir, `${id}.md`);
  const meta = join(paths.graphsDir, `${id}.meta.json`);
  const text = () => readFileSync(md, 'utf8');
  /** Edits the Markdown file as another editor would. */
  const edit = (from: string, to: string) => {
    const before = text();
    if (!before.includes(from)) throw new Error(`not in the file: ${from}`);
    writeFileSync(md, before.replace(from, to));
  };
  const changed = vi.fn();
  const ops = vi.fn();
  const fileErrors = vi.fn();
  store.on('changed', changed);
  store.on('op', ops);
  store.on('fileErrors', fileErrors);
  return { paths, store, id, md, meta, text, edit, changed, ops, fileErrors };
}

describe('graphFileChanged', () => {
  it("ignores the store's own saves", () => {
    const { store, id, changed } = setup();
    const before = store.readOps(id).length;
    expect(store.graphFileChanged(id)).toBe('unchanged');
    store.apply(id, { type: 'setGoal', goal: 'Again.' }, 'user');
    changed.mockClear();
    expect(store.graphFileChanged(id)).toBe('unchanged');
    expect(changed).not.toHaveBeenCalled();
    expect(store.readOps(id)).toHaveLength(before + 1);
  });

  it('applies an outside edit as user operations recorded via the file', () => {
    const { store, id, md, text, edit, changed, ops } = setup();
    edit('Plan it.', 'Plan it well.');
    edit('  n1["Plan"] --> n2["Build"]', '  n1["Plan"] --> n2["Build"]\n  n2 --> n3');
    edit('# Parity', '# Parity check');
    writeFileSync(md, `${text()}\n## n3 · Report\n\n\`\`\`prompt\nSum up.\n\`\`\`\n`);
    expect(store.graphFileChanged(id)).toBe('applied');
    const g = store.get(id);
    expect(g.name).toBe('Parity check');
    expect(g.nodes.map((n) => [n.id, n.prompt ?? n.command])).toEqual([
      ['n1', 'Plan it well.'],
      ['n2', 'make'],
      ['n3', 'Sum up.'],
    ]);
    expect(g.edges.map((e) => e.id)).toEqual(['n1->n2', 'n2->n3']);
    expect(store.readOps(id).slice(-3)).toEqual([
      { at: expect.any(String), by: 'user', op: { type: 'addNode', node: { id: 'n3', title: 'Report', kind: 'agent', prompt: 'Sum up.' } }, via: 'file' },
      { at: expect.any(String), by: 'user', op: { type: 'updateNode', id: 'n1', patch: { prompt: 'Plan it well.' } }, via: 'file' },
      { at: expect.any(String), by: 'user', op: { type: 'connect', from: 'n2', to: 'n3' }, via: 'file' },
    ]);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(ops.mock.calls.map(([, op]) => op.type)).toEqual(['addNode', 'updateNode', 'connect']);
  });

  it('gives a new step its id and writes the file back in canonical form, which it then ignores', () => {
    const { store, id, text, md } = setup();
    writeFileSync(md, `${text()}\n## Clean up\n- timeout: 5\n\`\`\`bash\nrm -rf tmp\n\`\`\`\n`);
    expect(store.graphFileChanged(id)).toBe('applied');
    expect(text()).toContain('## n3 · Clean up\n\n- kind: command\n- timeout: 5\n\n```sh\nrm -rf tmp\n```\n');
    expect(text()).toContain('  n3["Clean up"]\n```');
    expect(store.graphFileChanged(id)).toBe('unchanged');
  });

  it('keeps the graph and the file as they are when the file has errors, until it is fixed', () => {
    const { store, id, edit, text, fileErrors, changed } = setup();
    const good = store.get(id);
    edit('- kind: command', '- kind: robot');
    const broken = text();
    expect(store.graphFileChanged(id)).toBe('errors');
    expect(store.get(id)).toEqual(good);
    expect(text()).toBe(broken);
    expect(store.fileErrors(id)).toEqual([{ line: expect.any(Number), message: 'kind is "robot"; use agent or command.' }]);
    expect(fileErrors).toHaveBeenLastCalledWith(id, store.fileErrors(id));
    expect(changed).not.toHaveBeenCalled();
    // The canvas can't rewrite a file the user is still fixing; moving a step only touches the side file.
    expect(store.apply(id, { type: 'setGoal', goal: 'x' }, 'user')).toEqual({ ok: false, error: `The file ${id}.md has errors (line ${store.fileErrors(id)[0].line}: kind is "robot"; use agent or command.). Fix it first: until then this graph can't be changed here.` });
    expect(store.rename(id, 'Other').ok).toBe(false);
    expect(store.apply(id, { type: 'moveNode', id: 'n1', position: { x: 1, y: 1 } }, 'user').ok).toBe(true);
    expect(text()).toBe(broken);
    edit('- kind: robot', '- kind: command\n- timeout: 9');
    expect(store.graphFileChanged(id)).toBe('applied');
    expect(store.fileErrors(id)).toEqual([]);
    expect(fileErrors).toHaveBeenLastCalledWith(id, []);
    expect(store.get(id).nodes[1]).toMatchObject({ id: 'n2', timeoutSec: 9 });
    expect(store.get(id).nodes[0].position).toEqual({ x: 1, y: 1 });
  });

  it('applies all of an edit or none of it', () => {
    const { store, id, edit, text } = setup();
    const before = store.readOps(id).length;
    edit('Prove it.', 'Prove it now.');
    edit('## n2 · Build\n\n- kind: command\n', `## n2 · Build\n\n- kind: command\n\n> ${'x'.repeat(2001)}\n`);
    const written = text();
    expect(store.graphFileChanged(id)).toBe('errors');
    expect(store.fileErrors(id)).toEqual([{ line: written.split('\n').indexOf('## n2 · Build') + 1, message: 'a description can be at most 2000 characters. Nothing from this edit was applied.' }]);
    expect(store.get(id).goal).toBe('Prove it.');
    expect(store.readOps(id)).toHaveLength(before);
    expect(text()).toBe(written);
  });

  it('follows the baseline rules of a canvas edit', () => {
    const { store, id, edit } = setup();
    store.apply(id, { type: 'updateNode', id: 'n2', patch: { command: 'make all' } }, 'agent', { kind: 'planner' });
    edit('Plan it.', 'Plan it by hand.');
    expect(store.graphFileChanged(id)).toBe('applied');
    const base = store.baseline(id);
    expect(base.ok && base.graph?.nodes[0].prompt).toBe('Plan it by hand.');
    expect(store.agentChanges(id)).toMatchObject([{ kind: 'node', change: 'changed', id: 'n2', fields: ['command'] }]);
    edit('make all', 'make');
    expect(store.graphFileChanged(id)).toBe('applied');
    expect(store.agentChanges(id)).toEqual([]);
    expect(store.baseline(id)).toEqual({ ok: true });
  });

  it('turns a renamed variable into a delete and an add', () => {
    const { store, id, edit } = setup();
    edit('- `schema`: Where', '- `target_schema`: Where');
    expect(store.graphFileChanged(id)).toBe('applied');
    expect(store.readOps(id).slice(-2).map((r) => r.op)).toEqual([
      { type: 'deleteVariable', name: 'schema' },
      { type: 'addVariable', name: 'target_schema', description: 'Where' },
    ]);
  });

  it('re-reads positions from a changed side file without recording operations', () => {
    const { store, id, meta, changed } = setup();
    const before = store.readOps(id).length;
    const file = JSON.parse(readFileSync(meta, 'utf8'));
    file.nodes.n2.position = { x: 70, y: 90 };
    writeFileSync(meta, JSON.stringify(file));
    expect(store.graphFileChanged(id)).toBe('meta');
    expect(store.get(id).nodes[1].position).toEqual({ x: 70, y: 90 });
    expect(store.readOps(id)).toHaveLength(before);
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it('notices an outside edit on load, before any watcher reports it', () => {
    const { store, id, edit } = setup();
    edit('Prove it.', 'Proved by hand.');
    expect(store.get(id).goal).toBe('Proved by hand.');
    expect(store.readOps(id).at(-1)).toMatchObject({ op: { type: 'setGoal', goal: 'Proved by hand.' }, via: 'file' });
    expect(store.graphFileChanged(id)).toBe('unchanged');
  });

  it('adds a graph whose file appears, giving its new steps ids', () => {
    const { paths, store } = setup();
    writeFileSync(join(paths.graphsDir, 'notes.md'), '# Notes\n\n## Say hi\n\n```sh\necho hi\n```\n');
    expect(store.graphFileChanged('notes')).toBe('added');
    expect(readFileSync(join(paths.graphsDir, 'notes.md'), 'utf8')).toContain('## n1 · Say hi');
    expect(store.list().map((g) => g.id)).toContain('notes');
  });
});

describe('graphFileDeleted', () => {
  it('drops the graph and keeps its side file, history and baseline; it comes back with its file', () => {
    const { paths, store, id, md, meta, text } = setup();
    store.apply(id, { type: 'moveNode', id: 'n1', position: { x: 3, y: 4 } }, 'user');
    store.apply(id, { type: 'updateNode', id: 'n2', patch: { command: 'make all' } }, 'agent', { kind: 'planner' });
    const saved = text();
    const deleted = vi.fn();
    store.on('fileDeleted', deleted);
    rmSync(md);
    expect(store.graphFileDeleted(id)).toBe('deleted');
    expect(deleted).toHaveBeenCalledWith(id);
    expect(store.list().map((g) => g.id)).toEqual([]);
    expect([existsSync(meta), existsSync(join(paths.graphsDir, `${id}.ops.jsonl`)), existsSync(join(paths.graphsDir, `${id}.baseline.json`))]).toEqual([true, true, true]);
    expect(store.graphFileDeleted(id)).toBe('unchanged');
    writeFileSync(md, saved);
    expect(store.graphFileChanged(id)).toBe('added');
    expect(store.get(id).nodes[0].position).toEqual({ x: 3, y: 4 });
    expect(store.agentChanges(id)).toMatchObject([{ kind: 'node', change: 'changed', id: 'n2', fields: ['command'] }]);
  });

  it('treats a delete report for a file that is there as a change', () => {
    const { store, id, edit } = setup();
    edit('Prove it.', 'Still here.');
    expect(store.graphFileDeleted(id)).toBe('applied');
    expect(store.get(id).goal).toBe('Still here.');
  });

  it('is noticed on load too', () => {
    const { store, id, md } = setup();
    const deleted = vi.fn();
    store.on('fileDeleted', deleted);
    rmSync(md);
    expect(store.load(id)).toEqual({ ok: false, error: `graph "${id}" not found` });
    expect(deleted).toHaveBeenCalledWith(id);
  });
});
````

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w engine -- test/graphFileSync.test.ts`
Expected: FAIL: `store.graphFileChanged is not a function`.

- [ ] **Step 3: Implement the sync**

Apply to `engine/src/graphStore.ts`. What changes: `written` remembers the last text saved; `load` hands outside changes to `graphFileChanged`; `graphFileChanged` parses, diffs, dry-runs the operations on a copy, then applies them through `applyOne` (the old body of `apply`, saving nothing) and records them `via: 'file'`; `refuseFile` keeps the last good graph and marks the broken stamp; `brokenFile` is the refusal message; `graphFileDeleted` forgets the graph.

```diff
diff --git a/engine/src/graphStore.ts b/engine/src/graphStore.ts
--- a/engine/src/graphStore.ts
+++ b/engine/src/graphStore.ts
@@ -5,18 +5,21 @@ import {
   applyOp,
   canonicalGraph,
   diffGraphs,
+  diffToOps,
   edgeId,
   emptyGraph,
   formatFileErrors,
   graphFromDoc,
   MAX_IMPORT_CHARS,
   nextNodeId,
+  opLine,
   parseExportFile,
   parseGraph,
   parseGraphMarkdown,
   parseGraphMeta,
   serializeGraphMarkdown,
   serializeGraphMeta,
+  withMeta,
   type Actor,
   type AgentChange,
   type ChangeSource,
@@ -48,8 +51,10 @@ const BASELINE_SUFFIX = '.baseline.json';
 
 /** A file's modification time and size: a cached graph is valid while both of its files keep theirs. */
 type Stamp = { mtimeMs: number; size: number };
-/** A graph as last read or written, with the exact text of its two files. */
-type Cached = { graph: Graph; text: string; metaText?: string; md: Stamp; meta?: Stamp };
+/** A graph as last read or written, with the exact text of its two files. `broken`: the Markdown file now on disk, which doesn't parse. */
+type Cached = { graph: Graph; text: string; metaText?: string; md: Stamp; meta?: Stamp; broken?: Stamp };
+/** What graphFileChanged and graphFileDeleted did. */
+export type FileSync = 'unchanged' | 'applied' | 'meta' | 'added' | 'errors' | 'deleted';
 
 function stampOf(path: string): Stamp | undefined {
   const s = statSync(path, { throwIfNoEntry: false });
@@ -84,6 +89,8 @@ export class GraphStore extends EventEmitter {
   private failed = new Map<string, { md: Stamp; meta?: Stamp; error: string }>();
   /** The problems in each graph's Markdown file. */
   private errors = new Map<string, GraphFileError[]>();
+  /** The exact text this store last wrote to each graph's Markdown file: its own saves, which the file watcher reports too. */
+  private written = new Map<string, string>();
 
   constructor(
     private paths: ProjectPaths,
@@ -144,15 +151,20 @@ export class GraphStore extends EventEmitter {
     if (!isGraphId(id)) return { ok: false, error: `invalid graph id "${id}"` };
     const md = stampOf(this.file(id));
     if (!md) {
-      this.forget(id);
+      this.graphFileDeleted(id);
       return { ok: false, error: `graph "${id}" not found` };
     }
     const meta = stampOf(this.metaFile(id));
     const cached = this.cache.get(id);
-    if (cached && sameStamp(cached.md, md) && sameStamp(cached.meta, meta)) return { ok: true, graph: cached.graph };
+    if (cached) {
+      if ((sameStamp(cached.md, md) || sameStamp(cached.broken, md)) && sameStamp(cached.meta, meta)) return { ok: true, graph: cached.graph };
+      // Changed outside Agent Stream, and noticed here before the file watcher: the same handling as the watcher's.
+      this.graphFileChanged(id);
+      const after = this.cache.get(id);
+      return after ? { ok: true, graph: after.graph } : { ok: false, error: `graph "${id}" not found` };
+    }
     const failed = this.failed.get(id);
-    if (!cached && failed && sameStamp(failed.md, md) && sameStamp(failed.meta, meta)) return { ok: false, error: failed.error };
-    // The files changed on disk (hand edit, git checkout, ...) or were never read: read them.
+    if (failed && sameStamp(failed.md, md) && sameStamp(failed.meta, meta)) return { ok: false, error: failed.error };
     return this.read(id, md, meta);
   }
 
@@ -171,10 +183,101 @@ export class GraphStore extends EventEmitter {
     const graph = canonicalGraph(graphFromDoc(parsed.doc, parseGraphMeta(metaText), id, this.clock()));
     this.cache.set(id, { graph, text, metaText, md, meta });
     this.failed.delete(id);
+    this.written.delete(id);
     this.setErrors(id, []);
     return { ok: true, graph };
   }
 
+  /**
+   * The graph's Markdown or side file changed outside Agent Stream (Markdown graph files spec §6.2-§6.4). The store's
+   * own saves are recognised by their exact text and ignored. A Markdown edit becomes user operations, applied all or
+   * nothing and recorded `via: 'file'`, and the file is written back in canonical form. A Markdown file that doesn't
+   * parse changes nothing: the last good graph stays and its problems wait in fileErrors(). A side file change only
+   * re-reads positions and bookkeeping.
+   */
+  graphFileChanged(id: string): FileSync {
+    if (!isGraphId(id)) return 'unchanged';
+    const md = stampOf(this.file(id));
+    if (!md) return this.graphFileDeleted(id);
+    const meta = stampOf(this.metaFile(id));
+    const cached = this.cache.get(id);
+    if (!cached) {
+      // A new file, a deleted one that came back, or one that didn't parse until now.
+      const r = this.read(id, md, meta);
+      if (!r.ok) return 'errors';
+      if (this.cache.get(id)?.text !== serializeGraphMarkdown(r.graph)) this.save(r.graph);
+      return 'added';
+    }
+    const text = readFileSync(this.file(id), 'utf8');
+    const metaText = readIfExists(this.metaFile(id));
+    if (text === cached.text || text === this.written.get(id)) {
+      this.setErrors(id, []);
+      if (metaText === cached.metaText) {
+        this.cache.set(id, { ...cached, md, meta, broken: undefined });
+        return 'unchanged';
+      }
+      const graph = withMeta(cached.graph, parseGraphMeta(metaText), this.clock());
+      this.cache.set(id, { graph, text: cached.text, metaText, md, meta });
+      this.emit('changed', graph);
+      return 'meta';
+    }
+    const parsed = parseGraphMarkdown(text);
+    if (!parsed.ok) return this.refuseFile(id, cached, md, meta, parsed.errors);
+    const at = this.clock();
+    // A branch switch changes both files: the side file's bookkeeping first, then the edit on top of it.
+    const current = metaText === cached.metaText ? cached.graph : withMeta(cached.graph, parseGraphMeta(metaText), at);
+    const ops = diffToOps(current, parsed.doc);
+    let draft = current;
+    for (const op of ops) {
+      const r = applyOp(draft, op, 'user', at, { rewriteReferences: renameReferences });
+      if (!r.ok) return this.refuseFile(id, cached, md, meta, [{ line: opLine(parsed.doc, op), message: `${r.error}. Nothing from this edit was applied.` }]);
+      draft = r.graph;
+    }
+    let graph = current;
+    const applied: Op[] = [];
+    for (const op of ops) {
+      const r = this.applyOne(graph, op, 'user', at);
+      if (!r.ok) throw new Error(r.error); // the same operations just succeeded on a copy
+      graph = r.graph;
+      applied.push(r.op);
+    }
+    if (parsed.doc.name !== graph.name) graph = { ...graph, name: parsed.doc.name, updatedAt: at };
+    this.setErrors(id, []);
+    // What is on disk now, so save() writes the canonical text back (new steps get their ids) when it differs.
+    this.cache.set(id, { graph: current, text, metaText, md, meta });
+    const saved = this.save(graph);
+    this.dropBaselineIfSame(saved);
+    for (const op of applied) this.record(id, { at, by: 'user', op, via: 'file' });
+    this.emit('changed', saved);
+    for (const op of applied) this.emit('op', id, op);
+    return 'applied';
+  }
+
+  /** The graph's Markdown file is gone (spec §6.5): the graph leaves the list. Its side file, history and baseline stay. */
+  graphFileDeleted(id: string): FileSync {
+    if (!isGraphId(id)) return 'unchanged';
+    // An editor's save by rename can read as a delete and a create: a file that is there is a change.
+    if (existsSync(this.file(id))) return this.graphFileChanged(id);
+    const known = this.cache.has(id) || this.failed.has(id);
+    this.forget(id);
+    if (!known) return 'unchanged';
+    this.emit('fileDeleted', id);
+    return 'deleted';
+  }
+
+  /** Keeps the last good graph and changes no file; the problems wait in fileErrors() until the file reads again. */
+  private refuseFile(id: string, cached: Cached, md: Stamp, meta: Stamp | undefined, errors: GraphFileError[]): FileSync {
+    this.cache.set(id, { ...cached, meta, broken: md });
+    this.setErrors(id, errors);
+    return 'errors';
+  }
+
+  /** While the Markdown file has errors, edits that would rewrite it are refused, so a half-finished hand edit is never lost. */
+  private brokenFile(id: string): string | null {
+    const errors = this.fileErrors(id);
+    return errors.length ? `The file ${id}.md has errors (${formatFileErrors(errors)}). Fix it first: until then this graph can't be changed here.` : null;
+  }
+
   /** Writes a graph converted from a file in the old JSON format (spec §5.2), in canonical form. */
   writeConverted(graph: Graph): Graph {
     return this.save(graph);
@@ -196,6 +299,7 @@ export class GraphStore extends EventEmitter {
   private forget(id: string): void {
     this.cache.delete(id);
     this.failed.delete(id);
+    this.written.delete(id);
     this.setErrors(id, []);
   }
 
@@ -216,6 +320,8 @@ export class GraphStore extends EventEmitter {
     if (!trimmed) return { ok: false, error: 'A graph needs a name.' };
     const r = this.load(id);
     if (!r.ok) return r;
+    const broken = this.brokenFile(id);
+    if (broken) return { ok: false, error: broken };
     const graph = this.save({ ...r.graph, name: trimmed, updatedAt: this.clock() });
     this.emit('changed', graph);
     return { ok: true, graph };
@@ -274,29 +380,38 @@ export class GraphStore extends EventEmitter {
     }
     const current = this.load(graphId);
     if (!current.ok) return current;
+    // A move only rewrites the side file, so it is allowed while the Markdown file has errors.
+    const broken = op.type === 'moveNode' ? null : this.brokenFile(graphId);
+    if (broken) return { ok: false, error: broken };
     const at = this.clock();
-    const resolved: Op =
-      op.type === 'addNode' && !op.node.id ? { ...op, node: { ...op.node, id: nextNodeId(current.graph) } } : op;
-    const r = applyOp(current.graph, resolved, by, at, { rewriteReferences: renameReferences });
+    const r = this.applyOne(current.graph, op, by, at);
+    if (!r.ok) return r;
+    const saved = this.save(r.graph);
+    if (r.op.type !== 'moveNode') {
+      this.dropBaselineIfSame(saved);
+      this.record(graphId, { at, by, op: r.op, ...(source && { source }) });
+    }
+    this.emit('changed', saved);
+    this.emit('op', graphId, r.op);
+    return { ok: true, graph: saved };
+  }
+
+  /** One edit on `current`, keeping the baseline rules; saves nothing. Returns the op as recorded: an added step gets its id. */
+  private applyOne(current: Graph, op: Op, by: Actor, at: string): { ok: true; graph: Graph; op: Op } | { ok: false; error: string } {
+    const resolved: Op = op.type === 'addNode' && !op.node.id ? { ...op, node: { ...op.node, id: nextNodeId(current) } } : op;
+    const r = applyOp(current, resolved, by, at, { rewriteReferences: renameReferences });
     if (!r.ok) return r;
     // Positions are layout, not content: moves never touch the baseline.
     if (resolved.type !== 'moveNode') {
-      const base = this.baseline(graphId);
-      if (by === 'agent' && base.ok && !base.graph) this.writeBaseline(current.graph);
+      const base = this.baseline(current.id);
+      if (by === 'agent' && base.ok && !base.graph) this.writeBaseline(current);
       if (by === 'user' && base.ok && base.graph) {
         // An edit that doesn't fit the baseline (renaming a step an agent added) leaves it as it is.
         const mirrored = applyOp(base.graph, resolved, 'user', at, { rewriteReferences: renameReferences });
         if (mirrored.ok) this.writeBaseline(mirrored.graph);
       }
     }
-    const saved = this.save(r.graph);
-    if (resolved.type !== 'moveNode') {
-      this.dropBaselineIfSame(saved);
-      this.record(graphId, { at, by, op: resolved, ...(source && { source }) });
-    }
-    this.emit('changed', saved);
-    this.emit('op', graphId, resolved);
-    return { ok: true, graph: saved };
+    return { ok: true, graph: r.graph, op: resolved };
   }
 
   /** The user's graph before pending agent changes: none when the file is absent. */
@@ -333,6 +448,8 @@ export class GraphStore extends EventEmitter {
   private reviewOp(graphId: string, op: ReviewOp): GraphResult {
     const current = this.load(graphId);
     if (!current.ok) return current;
+    const broken = op.type === 'revertChange' ? this.brokenFile(graphId) : null;
+    if (broken) return { ok: false, error: broken };
     const graph = current.graph;
     const at = this.clock();
     const base = this.baseline(graphId);
@@ -395,6 +512,7 @@ export class GraphStore extends EventEmitter {
     const cached = this.cache.get(g.id);
     if (cached?.metaText !== metaText || !existsSync(metaPath)) writeFileAtomic(metaPath, metaText);
     if (cached?.text !== text || !existsSync(mdPath)) writeFileAtomic(mdPath, text);
+    this.written.set(g.id, text);
     this.cache.set(g.id, { graph: g, text, metaText, md: stampOf(mdPath)!, meta: stampOf(metaPath) });
     this.failed.delete(g.id);
     return g;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -w engine`
Expected: PASS (all engine tests; the Task 6 tests "sees external edits…" and "reports a graph file broken after it was loaded…" now go through `graphFileChanged`).

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck`
Expected: no errors.

```bash
git add engine/src/graphStore.ts engine/test/graphFileSync.test.ts
git commit -m "$(cat <<'MSG'
feat(engine): apply edits made to a graph's Markdown file

graphFileChanged ignores the store's own saves, turns an outside edit
into user operations recorded via 'file' (all or nothing, baseline rules
kept), writes the file back in canonical form, and keeps the last good
graph while the file has errors, refusing edits that would overwrite it.
graphFileDeleted drops a graph whose file is gone until it comes back.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
)"
```

---

### Task 8: The App tells the clients about graph files

**Spec tests owned (§9):** engine — every existing graphStore, app and planner test kept passing; the file errors and deletions reach the clients (§6.3 step 5, §6.5).

**Files:**
- Modify: `engine/src/app.ts`
- Test: `engine/test/app.test.ts`

**Interfaces:**
- Consumes: `FileSync`, `graphFileChanged`, `graphFileDeleted`, `fileErrors`, the `fileErrors` and `fileDeleted` events (Task 7).
- Produces:
  ```ts
  // App
  graphFileChanged(id: string): FileSync; // broadcasts 'graphs' after 'added' | 'applied' | 'errors'
  graphFileDeleted(id: string): FileSync;
  // broadcasts: { type: 'graphFileErrors', graphId, errors } on every change of a graph's file errors;
  //   { type: 'graphDeleted', graphId, reason: 'file' } then 'graphs' when a file disappears;
  //   graphOpened carries fileErrors when there are any.
  ```

- [ ] **Step 1: Write the failing test**

Apply to `engine/test/app.test.ts`:

```diff
diff --git a/engine/test/app.test.ts b/engine/test/app.test.ts
--- a/engine/test/app.test.ts
+++ b/engine/test/app.test.ts
@@ -1,4 +1,4 @@
-import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
+import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
 import { tmpdir } from 'node:os';
 import { dirname, join } from 'node:path';
 import { describe, expect, it, vi } from 'vitest';
@@ -1689,3 +1689,60 @@ describe('graphs from before Markdown', () => {
     expect(existsSync(join(paths.graphsDir, 'g1.json.bak'))).toBe(true);
   });
 });
+
+describe('graph files changed outside Agent Stream', () => {
+  function withFile() {
+    const { app, graphId, paths } = setupWithGraph();
+    app.graphStore.apply(graphId, { type: 'addVariable', name: 'schema' }, 'user');
+    app.graphStore.apply(graphId, { type: 'addNode', node: { title: 'Build', kind: 'command', command: 'make {{ schema }}' } }, 'user');
+    const md = join(paths.graphsDir, `${graphId}.md`);
+    const edit = (from: string, to: string) => writeFileSync(md, readFileSync(md, 'utf8').replace(from, to));
+    return { app, graphId, md, edit, c: client(app) };
+  }
+
+  it('sends the edited graph and the list, and records the edit as the user’s, via the file', () => {
+    const { app, graphId, edit, c } = withFile();
+    edit('# G', '# G edited\n\n## Goal\n\nFrom a text editor.');
+    expect(app.graphFileChanged(graphId)).toBe('applied');
+    expect(c.last('graph').graph).toMatchObject({ name: 'G edited', goal: 'From a text editor.' });
+    expect(c.last('graphs').graphs.find((g) => g.id === graphId)?.name).toBe('G edited');
+    expect(app.graphStore.readOps(graphId).at(-1)).toMatchObject({ by: 'user', op: { type: 'setGoal' }, via: 'file' });
+    expect(app.graphFileChanged(graphId)).toBe('unchanged');
+  });
+
+  it('forgets the value of a variable the file removed', () => {
+    const { app, graphId, edit } = withFile();
+    app.values.set(graphId, 'schema', 'dev');
+    edit('## Variables\n\n- `schema`\n\n', '');
+    edit('make {{ schema }}', 'make');
+    expect(app.graphFileChanged(graphId)).toBe('applied');
+    expect(app.values.get(graphId)).toEqual({});
+  });
+
+  it('publishes file errors, includes them when the graph opens, and clears them when fixed', async () => {
+    const { app, graphId, edit, c } = withFile();
+    edit('- kind: command', '- kind: robot');
+    expect(app.graphFileChanged(graphId)).toBe('errors');
+    expect(c.last('graphFileErrors')).toEqual({ type: 'graphFileErrors', graphId, errors: [{ line: expect.any(Number), message: 'kind is "robot"; use agent or command.' }] });
+    await app.handle(c.client, { type: 'openGraph', graphId });
+    expect(c.last('graphOpened').fileErrors).toEqual(c.last('graphFileErrors').errors);
+    // Back to the text the store holds: nothing to apply, and the problems are gone.
+    edit('- kind: robot', '- kind: command');
+    expect(app.graphFileChanged(graphId)).toBe('unchanged');
+    expect(c.last('graphFileErrors')).toEqual({ type: 'graphFileErrors', graphId, errors: [] });
+    await app.handle(c.client, { type: 'openGraph', graphId });
+    expect('fileErrors' in c.last('graphOpened')).toBe(false);
+  });
+
+  it('tells the tabs a deleted file’s graph is gone, and lists it again when the file comes back', () => {
+    const { app, graphId, md, c } = withFile();
+    const saved = readFileSync(md, 'utf8');
+    rmSync(md);
+    expect(app.graphFileDeleted(graphId)).toBe('deleted');
+    expect(c.last('graphDeleted')).toEqual({ type: 'graphDeleted', graphId, reason: 'file' });
+    expect(c.last('graphs').graphs.map((g) => g.id)).toEqual([]);
+    writeFileSync(md, saved);
+    expect(app.graphFileChanged(graphId)).toBe('added');
+    expect(c.last('graphs').graphs.map((g) => g.id)).toEqual([graphId]);
+  });
+});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w engine -- test/app.test.ts`
Expected: FAIL: `app.graphFileChanged is not a function`.

- [ ] **Step 3: Wire the store's file events to the clients**

Apply to `engine/src/app.ts`:

```diff
diff --git a/engine/src/app.ts b/engine/src/app.ts
--- a/engine/src/app.ts
+++ b/engine/src/app.ts
@@ -13,6 +13,7 @@ import {
   type ChatEntry,
   type ClientMessage,
   type Graph,
+  type GraphFileError,
   type GraphListItem,
   type GraphNode,
   type GraphResult,
@@ -35,7 +36,7 @@ import { systemClock, type Clock } from './clock';
 import { createCommandExecutor } from './commandExecutor';
 import type { Executors, NodeExecutor } from './executors';
 import { inspectCheckout, type GitExec } from './git';
-import { GraphStore } from './graphStore';
+import { GraphStore, type FileSync } from './graphStore';
 import { migrateGraphsToMarkdown, migrateProjectFolder, migrateValuesFile } from './migrate';
 import { ensureDataDirs, projectPaths } from './paths';
 import { Planner } from './planner';
@@ -340,6 +341,22 @@ export function createApp(d: AppDeps) {
       broadcastGraphs();
     }
   });
+  graphStore.on('fileErrors', (graphId: string, errors: GraphFileError[]) => broadcast({ type: 'graphFileErrors', graphId, errors }));
+  graphStore.on('fileDeleted', (graphId: string) => {
+    agentChangeCounts.delete(graphId);
+    broadcast({ type: 'graphDeleted', graphId, reason: 'file' });
+    broadcastGraphs();
+  });
+  /** The extension's file watcher saw `<id>.md` or `<id>.meta.json` change (Markdown graph files spec §6.2). */
+  function graphFileChanged(id: string): FileSync {
+    const r = graphStore.graphFileChanged(id);
+    if (r === 'added' || r === 'applied' || r === 'errors') broadcastGraphs();
+    return r;
+  }
+  /** The extension's file watcher saw `<id>.md` deleted: the store's fileDeleted event tells the clients. */
+  function graphFileDeleted(id: string): FileSync {
+    return graphStore.graphFileDeleted(id);
+  }
   /** Each active run's last announced state: the checkout chip follows a run that starts, ends or stops waiting (spec §4.5). */
   const announced = new Map<string, string>();
   runner.on('run', (run: RunMeta) => {
@@ -402,7 +419,8 @@ export function createApp(d: AppDeps) {
   function opened(graph: Graph): ServerMessage {
     const runs = runStore.list(graph.id);
     const run = runner.activeFor(graph.id) ?? (runs[0] ? runStore.get(runs[0].id) : undefined);
-    return { type: 'graphOpened', graph, runs, run, variableValues: values.get(graph.id), ...review(graph.id) };
+    const fileErrors = graphStore.fileErrors(graph.id);
+    return { type: 'graphOpened', graph, runs, run, variableValues: values.get(graph.id), ...review(graph.id), ...(fileErrors.length > 0 && { fileErrors }) };
   }
 
   /** A revert would change a step that a run in progress is about to run or is running. */
@@ -748,6 +766,8 @@ export function createApp(d: AppDeps) {
     deleteGraph,
     exportGraph: (id: string) => graphStore.exportGraph(id),
     importGraph,
+    graphFileChanged,
+    graphFileDeleted,
     runWorkspaces,
     markWorkspaceRemoved,
     runReport,
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -w engine`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck`
Expected: no errors.

```bash
git add engine/src/app.ts engine/test/app.test.ts
git commit -m "$(cat <<'MSG'
feat(engine): tell graph tabs about Markdown file errors and deletions

The App exposes graphFileChanged and graphFileDeleted for the file
watcher, broadcasts graphFileErrors and graphDeleted with reason 'file',
and includes file errors when a graph opens.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
)"
```

---
### Task 9: Graph tabs on `.md` files, and Open Graph as Markdown

**Spec tests owned (§9):** extension — the Open as Markdown command and menu items (§7). R1, R10.

**Files:**
- Modify: `extension/src/graphEditor.ts`, `extension/src/commands.ts`, `extension/src/graphsView.ts`, `extension/src/extension.ts`, `extension/package.json`
- Test: `extension/test/graphEditor.test.ts`, `extension/test/graphsView.test.ts`, `extension/test/commands.test.ts`

**Interfaces:**
- Consumes: the Task 6 store (`listGraphs` error items).
- Produces:
  ```ts
  // extension/src/graphEditor.ts
  export function graphUri(folder: Folder, graphId: string): vscode.Uri; // now <folder>/.agent-stream/graphs/<id>.md
  // graphTarget / graphIdFromPath accept <id>.md and a restored tab's <id>.json
  // extension/src/commands.ts
  export type CommandDeps = { …; openText(target: GraphTarget): Promise<void> };
  commands.openGraphMarkdown(target?: GraphTarget): Promise<void>; // target, else the active tab, else a pick (unreadable graphs included)
  pickGraph(withUnreadable?: boolean): Promise<GraphTarget | undefined>;
  ```
  Manifest: command `agentStream.openGraphMarkdown`; context menu item `group: "1_open@2"` for `viewItem =~ /^graph/`; custom editor selector `**/.agent-stream/graphs/*.md`, `priority: "option"`; activation on `*.md` and `*.json`.

**Existing tests changed by the file format (named exceptions):** `graphEditor.test.ts` "keeps the general explanation…" (the text now says "see it as text", since the file is Markdown); `graphsView.test.ts` "lists one folder's graphs directly…" (an unreadable item now opens its Markdown).

- [ ] **Step 1: Write the failing tests**

Apply to `extension/test/graphEditor.test.ts`:

```diff
diff --git a/extension/test/graphEditor.test.ts b/extension/test/graphEditor.test.ts
--- a/extension/test/graphEditor.test.ts
+++ b/extension/test/graphEditor.test.ts
@@ -228,6 +228,7 @@ describe('hostCommandArgs', () => {
     expect(hostCommandArgs('newGraph', panel)).toEqual([{ folder: f }]);
     expect(hostCommandArgs('importGraph', panel)).toEqual([{ folder: f }]);
     expect(hostCommandArgs('deleteGraph', panel)).toEqual([{ folder: f, graphId: 'g' }]);
+    expect(hostCommandArgs('openGraphMarkdown', panel)).toEqual([{ folder: f, graphId: 'g' }]);
   });
 });
 
@@ -237,6 +238,9 @@ describe('graphIdFromPath', () => {
     expect(graphIdFromPath('C:\\w\\.agent-stream\\graphs\\x.json')).toBe('x');
     expect(graphIdFromPath('/w/other/x.json')).toBeUndefined();
     expect(graphIdFromPath('/w/.agent-stream/graphs/Bad Name.json')).toBeUndefined();
+    expect(graphIdFromPath('/w/.agent-stream/graphs/dbt-parity.md')).toBe('dbt-parity');
+    expect(graphIdFromPath('C:\\w\\.agent-stream\\graphs\\x.md')).toBe('x');
+    expect(graphIdFromPath('/w/.agent-stream/graphs/x.meta.json')).toBeUndefined();
   });
 });
 
@@ -248,11 +252,15 @@ describe('graphTarget', () => {
     expect(graphTarget('/ws', '/ws/node_modules/p/.agent-stream/graphs/x.json')).toBeUndefined();
     expect(graphTarget('/ws', '/ws/.agent-stream/graphs/Bad Name.json')).toBeUndefined();
     expect(graphTarget('/ws', '/other/.agent-stream/graphs/g.json')).toBeUndefined();
+    expect(graphTarget('/ws', '/ws/.agent-stream/graphs/g.md')).toBe('g');
+    expect(graphTarget('C:\\ws', 'C:\\ws\\.agent-stream\\graphs\\g.md')).toBe('g');
+    expect(graphTarget('/ws', '/ws/.agent-stream/graphs/g.meta.json')).toBeUndefined();
+    expect(graphTarget('/ws', '/ws/sub/.agent-stream/graphs/x.md')).toBeUndefined();
   });
 });
 
 describe('notGraphText', () => {
-  const generic = "This file isn't a graph in this workspace folder. Graphs live in .agent-stream/graphs at the folder's root. Use \"Reopen Editor With… → Text Editor\" to see it as JSON.";
+  const generic = "This file isn't a graph in this workspace folder. Graphs live in .agent-stream/graphs at the folder's root. Use \"Reopen Editor With… → Text Editor\" to see it as text.";
   const baseline = 'This is the agent-change baseline for a graph (your accepted version). Use "Reopen Editor With… → Text Editor" to see it as JSON.';
 
   it('explains a baseline file, which the graph editor selector also matches', () => {
```

Apply to `extension/test/graphsView.test.ts`:

```diff
diff --git a/extension/test/graphsView.test.ts b/extension/test/graphsView.test.ts
--- a/extension/test/graphsView.test.ts
+++ b/extension/test/graphsView.test.ts
@@ -25,7 +25,7 @@ describe('GraphsView', () => {
     ]);
     expect(items[0].command).toEqual({ command: 'agentStream.openGraph', title: 'Open', arguments: [{ folder: a, graphId: 'p' }] });
     expect([items[0].folder, items[0].graphId]).toEqual([a, 'p']);
-    expect(items[2].command).toBeUndefined();
+    expect(items[2].command).toEqual({ command: 'agentStream.openGraphMarkdown', title: 'Open as Markdown', arguments: [{ folder: a, graphId: 'x' }] });
     expect(items[2].tooltip).toBe('invalid JSON: Unexpected end');
   });
 
```

Apply to `extension/test/commands.test.ts`:

```diff
diff --git a/extension/test/commands.test.ts b/extension/test/commands.test.ts
--- a/extension/test/commands.test.ts
+++ b/extension/test/commands.test.ts
@@ -1,4 +1,4 @@
-import { mkdtempSync } from 'node:fs';
+import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
 import { tmpdir } from 'node:os';
 import { join } from 'node:path';
 import { describe, expect, it, vi } from 'vitest';
@@ -48,15 +48,17 @@ function setup(folders: Folder[] = [folder('a')]) {
     infoAction: vi.fn(),
   } satisfies Record<keyof Ui, unknown>;
   const opened: GraphTarget[] = [];
+  const texts: GraphTarget[] = [];
   let active: GraphTarget | undefined;
   const { commands, pickGraph } = graphCommands({
     engines: manager,
     folders: () => folders,
     ui: ui as unknown as Ui,
     open: async (t) => void opened.push(t),
+    openText: async (t) => void texts.push(t),
     activeTarget: () => active,
   });
-  return { manager, ui, opened, commands, pickGraph, folders, gate, setActive: (t: GraphTarget) => (active = t) };
+  return { manager, ui, opened, texts, commands, pickGraph, folders, gate, setActive: (t: GraphTarget) => (active = t) };
 }
 
 describe('graph commands', () => {
@@ -268,3 +270,40 @@ describe('graph commands', () => {
     expect(s.manager.get(s.folders[0]).listGraphs().map((x) => x.name).sort()).toEqual(['Parity', 'Parity copy']);
   });
 });
+
+describe('Open Graph as Markdown', () => {
+  it('opens the Markdown of the given graph, else the active tab’s', async () => {
+    const s = setup();
+    const f = s.folders[0];
+    const g = s.manager.get(f).createGraph('Parity');
+    await s.commands.openGraphMarkdown({ folder: f, graphId: g.id });
+    s.setActive({ folder: f, graphId: 'other' });
+    await s.commands.openGraphMarkdown();
+    expect(s.texts).toEqual([
+      { folder: f, graphId: g.id },
+      { folder: f, graphId: 'other' },
+    ]);
+  });
+
+  it('offers graphs whose file has errors too, since the file is where to fix them', async () => {
+    const s = setup();
+    const f = s.folders[0];
+    s.manager.get(f).createGraph('Parity');
+    writeFileSync(join(f.path, '.agent-stream', 'graphs', 'broken.md'), 'no name\n');
+    s.ui.pickGraph.mockResolvedValueOnce({ folder: f, graphId: 'broken' });
+    await s.commands.openGraphMarkdown();
+    expect(s.ui.pickGraph.mock.calls[0][0].map((i: { label: string }) => i.label)).toEqual(['Parity', 'broken']);
+    expect(s.texts).toEqual([{ folder: f, graphId: 'broken' }]);
+  });
+});
+
+describe('manifest: graph files', () => {
+  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
+
+  it('opens a graph file as a graph tab only when asked, and offers Open Graph as Markdown', () => {
+    expect(manifest.contributes.customEditors).toEqual([{ viewType: 'agentStream.graph', displayName: 'Agent Stream Graph', selector: [{ filenamePattern: '**/.agent-stream/graphs/*.md' }], priority: 'option' }]);
+    expect(manifest.activationEvents).toEqual(['workspaceContains:.agent-stream/graphs/*.md', 'workspaceContains:.agent-stream/graphs/*.json']);
+    expect(manifest.contributes.commands).toContainEqual({ command: 'agentStream.openGraphMarkdown', title: 'Open Graph as Markdown', category: 'Agent Stream' });
+    expect(manifest.contributes.menus['view/item/context']).toContainEqual({ command: 'agentStream.openGraphMarkdown', when: 'view == agentStream.graphs && viewItem =~ /^graph/', group: '1_open@2' });
+  });
+});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w extension -- test/graphEditor.test.ts test/graphsView.test.ts test/commands.test.ts`
Expected: FAIL. `.md` paths aren't graphs yet, `openGraphMarkdown` doesn't exist, the manifest has no such command.

- [ ] **Step 3: Point graph tabs at `<id>.md`**

Apply to `extension/src/graphEditor.ts`:

```diff
diff --git a/extension/src/graphEditor.ts b/extension/src/graphEditor.ts
--- a/extension/src/graphEditor.ts
+++ b/extension/src/graphEditor.ts
@@ -9,24 +9,27 @@ import { escapeHtml, webviewHtml } from './webviewHtml';
 
 export const GRAPH_VIEW_TYPE = 'agentStream.graph';
 
-/** `<folder>/.agent-stream/graphs/<id>.json` → id; undefined for any other file. */
+/** `<folder>/.agent-stream/graphs/<id>.md` (or a tab's older `<id>.json`) → id; undefined for any other file. */
 export function graphIdFromPath(p: string): string | undefined {
-  const m = /[\\/]\.agent-stream[\\/]graphs[\\/]([^\\/]+)\.json$/.exec(p);
+  const m = /[\\/]\.agent-stream[\\/]graphs[\\/]([^\\/]+)\.(?:md|json)$/.exec(p);
   return m && isGraphId(m[1]) ? m[1] : undefined;
 }
 
-/** The graph id when `filePath` is exactly `<folderPath>/.agent-stream/graphs/<id>.json`; nested copies belong to no engine. */
+/**
+ * The graph id when `filePath` is exactly `<folderPath>/.agent-stream/graphs/<id>.md`; nested copies belong to no
+ * engine. A tab restored from before Markdown graph files still points at `<id>.json`, which names the same graph.
+ */
 export function graphTarget(folderPath: string, filePath: string): string | undefined {
   const segments = (p: string) => p.replace(/\\/g, '/').split('/').filter(Boolean);
   const base = segments(folderPath);
   const file = segments(filePath);
   if (file.length !== base.length + 3 || !base.every((seg, i) => seg === file[i])) return undefined;
   const [dir, graphs, name] = file.slice(base.length);
-  const m = /^(.+)\.json$/.exec(name);
+  const m = /^(.+)\.(?:md|json)$/.exec(name);
   return dir === '.agent-stream' && graphs === 'graphs' && m && isGraphId(m[1]) ? m[1] : undefined;
 }
 
-const GENERIC_NOT_GRAPH = `This file isn't a graph in this workspace folder. Graphs live in .agent-stream/graphs at the folder's root. Use "Reopen Editor With… → Text Editor" to see it as JSON.`;
+const GENERIC_NOT_GRAPH = `This file isn't a graph in this workspace folder. Graphs live in .agent-stream/graphs at the folder's root. Use "Reopen Editor With… → Text Editor" to see it as text.`;
 const BASELINE_NOT_GRAPH = 'This is the agent-change baseline for a graph (your accepted version). Use "Reopen Editor With… → Text Editor" to see it as JSON.';
 
 /** Why a file the graph editor was asked to open isn't shown as a graph. The editor selector also matches `<id>.baseline.json`. */
@@ -256,7 +259,7 @@ export function hostCommandArgs(command: HostCommand, panel: { folder: Folder; g
 }
 
 export function graphUri(folder: Folder, graphId: string): vscode.Uri {
-  return vscode.Uri.joinPath(folderUri(folder), '.agent-stream', 'graphs', `${graphId}.json`);
+  return vscode.Uri.joinPath(folderUri(folder), '.agent-stream', 'graphs', `${graphId}.md`);
 }
 
 export async function openGraphTab(folder: Folder, graphId: string): Promise<void> {
```

Apply to `extension/package.json`:

```diff
diff --git a/extension/package.json b/extension/package.json
--- a/extension/package.json
+++ b/extension/package.json
@@ -23,6 +23,7 @@
   ],
   "main": "./dist/extension.cjs",
   "activationEvents": [
+    "workspaceContains:.agent-stream/graphs/*.md",
     "workspaceContains:.agent-stream/graphs/*.json"
   ],
   "contributes": {
@@ -99,10 +100,10 @@
         "displayName": "Agent Stream Graph",
         "selector": [
           {
-            "filenamePattern": "**/.agent-stream/graphs/*.json"
+            "filenamePattern": "**/.agent-stream/graphs/*.md"
           }
         ],
-        "priority": "default"
+        "priority": "option"
       }
     ],
     "viewsContainers": {
@@ -209,6 +210,11 @@
         "title": "Export Run Report",
         "category": "Agent Stream"
       },
+      {
+        "command": "agentStream.openGraphMarkdown",
+        "title": "Open Graph as Markdown",
+        "category": "Agent Stream"
+      },
       {
         "command": "agentStream.renameGraph",
         "title": "Rename Graph",
@@ -350,6 +356,11 @@
           "when": "view == agentStream.graphs && viewItem == graph",
           "group": "1_open@1"
         },
+        {
+          "command": "agentStream.openGraphMarkdown",
+          "when": "view == agentStream.graphs && viewItem =~ /^graph/",
+          "group": "1_open@2"
+        },
         {
           "command": "agentStream.renameGraph",
           "when": "view == agentStream.graphs && viewItem == graph",
```

- [ ] **Step 4: Add the command and the sidebar items**

Apply to `extension/src/commands.ts`:

```diff
diff --git a/extension/src/commands.ts b/extension/src/commands.ts
--- a/extension/src/commands.ts
+++ b/extension/src/commands.ts
@@ -35,6 +35,8 @@ export type CommandDeps = {
   folders(): Folder[];
   ui: Ui;
   open(target: GraphTarget): Promise<void>;
+  /** Opens the graph's `<id>.md` in a text editor beside the graph tab (Markdown graph files spec §7). */
+  openText(target: GraphTarget): Promise<void>;
   activeTarget(): GraphTarget | undefined;
 };
 
@@ -51,12 +53,13 @@ export function graphCommands(d: CommandDeps) {
     return r.ok ? r.graph.name : t.graphId;
   };
 
-  async function pickGraph(): Promise<GraphTarget | undefined> {
+  /** `withUnreadable`: graphs whose file can't be read are offered too (Open as Markdown is how to fix them). */
+  async function pickGraph(withUnreadable = false): Promise<GraphTarget | undefined> {
     const folders = d.folders();
     const items = folders.flatMap((folder) =>
       app(folder)
         .listGraphs()
-        .filter((g) => !g.error)
+        .filter((g) => withUnreadable || !g.error)
         .map((g) => ({ label: g.name, description: folders.length > 1 ? folder.name : undefined, target: { folder, graphId: g.id } })),
     );
     return d.ui.pickGraph(items);
@@ -141,6 +144,11 @@ export function graphCommands(d: CommandDeps) {
       await file.open();
     },
 
+    async openGraphMarkdown(target?: GraphTarget): Promise<void> {
+      const t = target?.graphId ? target : (d.activeTarget() ?? (await pickGraph(true)));
+      if (t) await d.openText(t);
+    },
+
     async renameGraph(target?: GraphTarget): Promise<void> {
       const t = await targetFor(target);
       if (!t) return;
```

Apply to `extension/src/graphsView.ts`:

```diff
diff --git a/extension/src/graphsView.ts b/extension/src/graphsView.ts
--- a/extension/src/graphsView.ts
+++ b/extension/src/graphsView.ts
@@ -25,6 +25,8 @@ export class GraphItem extends vscode.TreeItem {
       this.tooltip = graph.error;
       this.contextValue = 'graphUnreadable';
       this.iconPath = new vscode.ThemeIcon('warning');
+      // Its errors are in the Problems panel; the file is where to fix them.
+      this.command = { command: 'agentStream.openGraphMarkdown', title: 'Open as Markdown', arguments: [{ folder, graphId: graph.id }] };
       return;
     }
     const lastRun = graph.lastRun ? `${statusLabel(graph.lastRun.status)} · ${relativeTime(graph.lastRun.startedAt, now)}` : 'Never run';
```

Apply to `extension/src/extension.ts` (the text editor opens beside the graph tab):

```diff
diff --git a/extension/src/extension.ts b/extension/src/extension.ts
--- a/extension/src/extension.ts
+++ b/extension/src/extension.ts
@@ -89,6 +89,7 @@ export async function activate(context: vscode.ExtensionContext) {
     folders: workspaceFolders,
     ui: vscodeUi,
     open: (t) => openGraphTab(t.folder, t.graphId),
+    openText: async (t) => void (await vscode.window.showTextDocument(graphUri(t.folder, t.graphId), { viewColumn: vscode.ViewColumn.Beside, preview: false })),
     activeTarget: () => {
       const p = panels.active();
       return p && { folder: p.folder, graphId: p.graphId };
```

The graph tab's **File › Open as Markdown** reaches this command through `runHostCommand` (`agentStream.${command}` with `{ folder, graphId }`, the default branch of `hostCommandArgs`); the menu item itself comes in Task 11.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -w extension`
Expected: PASS.

- [ ] **Step 6: Typecheck and commit**

Run: `npm run typecheck`
Expected: no errors.

```bash
git add extension/src/graphEditor.ts extension/src/commands.ts extension/src/graphsView.ts extension/src/extension.ts extension/package.json extension/test/graphEditor.test.ts extension/test/graphsView.test.ts extension/test/commands.test.ts
git commit -m "$(cat <<'MSG'
feat(extension): graph tabs on Markdown files, and Open Graph as Markdown

Graph tabs open <id>.md (a plain open now shows the text, so diffs and
hand edits use the text editor). Open Graph as Markdown opens the file
beside the graph tab, from the palette, the sidebar's right-click menu,
or a click on a graph whose file can't be read.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
)"
```

---

### Task 10: The file watcher, diagnostics and the output channel

**Spec tests owned (§9):** extension — the watcher wiring (debounce, the calls to the engine); diagnostics published and cleared (§6.2, §6.3). Review Focus 2 (debounce, last event wins).

**Files:**
- Create: `extension/src/graphFiles.ts`, `extension/test/graphFiles.test.ts`
- Modify: `extension/src/engines.ts`, `extension/src/extension.ts`, `extension/test/vscode.ts`
- Test: `extension/test/engines.test.ts`

**Interfaces:**
- Consumes: `App.graphFileChanged`, `App.graphFileDeleted`, `App.startupNotes` (Tasks 6, 8); `graphUri` (Task 9); `isGraphId` (engine).
- Produces:
  ```ts
  // extension/src/graphFiles.ts
  export const GRAPH_FILE_DEBOUNCE_MS = 200;
  export const GRAPH_FILES_GLOB = '.agent-stream/graphs/*.{md,meta.json}';
  export function graphIdOfFile(path: string): string | undefined;
  export type FileWatcher = { onDidCreate(l): unknown; onDidChange(l): unknown; onDidDelete(l): unknown; dispose(): unknown };
  export type GraphFileWatcherDeps = { engine(folder: Folder): Pick<App, 'graphFileChanged' | 'graphFileDeleted'> | undefined; watch(folder: Folder): FileWatcher; delayMs?: number };
  export class GraphFileWatcher { constructor(d: GraphFileWatcherDeps); sync(folders: Folder[]): void; dispose(): void }
  export function toDiagnostic(error: GraphFileError): vscode.Diagnostic;
  export type Diagnostics = { set(uri: vscode.Uri, diagnostics: vscode.Diagnostic[]): void; delete(uri: vscode.Uri): void };
  export function publishGraphFileErrors(diagnostics: Diagnostics, folder: Folder, graphId: string, errors: GraphFileError[]): void;
  // extension/src/engines.ts (EngineEvents)
  graphDeleted(folder: Folder, graphId: string, reason?: 'file'): void;
  graphFileErrors?(folder: Folder, graphId: string, errors: GraphFileError[]): void;
  log?(message: string): void;
  ```

- [ ] **Step 1: Write the failing tests**

Apply to `extension/test/vscode.ts` (the test double gains the classes the diagnostics use):

```diff
diff --git a/extension/test/vscode.ts b/extension/test/vscode.ts
--- a/extension/test/vscode.ts
+++ b/extension/test/vscode.ts
@@ -132,3 +132,32 @@ export class CancellationTokenSource {
     this.listeners = [];
   }
 }
+
+export enum DiagnosticSeverity {
+  Error = 0,
+  Warning = 1,
+  Information = 2,
+  Hint = 3,
+}
+export class Range {
+  constructor(
+    public startLine: number,
+    public startCharacter: number,
+    public endLine: number,
+    public endCharacter: number,
+  ) {}
+}
+export class Diagnostic {
+  source?: string;
+  constructor(
+    public range: Range,
+    public message: string,
+    public severity: DiagnosticSeverity = DiagnosticSeverity.Error,
+  ) {}
+}
+export class RelativePattern {
+  constructor(
+    public base: unknown,
+    public pattern: string,
+  ) {}
+}
```

Create `extension/test/graphFiles.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import type { Folder } from '../src/engines';
import { GRAPH_FILE_DEBOUNCE_MS, GraphFileWatcher, graphIdOfFile, publishGraphFileErrors, type FileWatcher } from '../src/graphFiles';

const a: Folder = { key: 'file:///a', name: 'a', path: '/a' };
const b: Folder = { key: 'file:///b', name: 'b', path: '/b' };
const uri = (path: string) => vscode.Uri.file(path);

/** A watcher per folder whose events the test fires, and a fake engine per folder. */
function setup(running: Folder[] = [a, b]) {
  const watchers = new Map<string, { create: (u: vscode.Uri) => void; change: (u: vscode.Uri) => void; remove: (u: vscode.Uri) => void; dispose: ReturnType<typeof vi.fn> }>();
  const engines = new Map(running.map((f) => [f.key, { graphFileChanged: vi.fn(), graphFileDeleted: vi.fn() }]));
  const watcher = new GraphFileWatcher({
    engine: (f) => engines.get(f.key),
    watch: (f): FileWatcher => {
      const w = { create: (_: vscode.Uri) => {}, change: (_: vscode.Uri) => {}, remove: (_: vscode.Uri) => {}, dispose: vi.fn() };
      watchers.set(f.key, w);
      return { onDidCreate: (l) => (w.create = l), onDidChange: (l) => (w.change = l), onDidDelete: (l) => (w.remove = l), dispose: w.dispose };
    },
  });
  return { watcher, watchers, engines };
}

afterEach(() => vi.useRealTimers());

describe('graphIdOfFile', () => {
  it('reads the id of a Markdown or side file, and nothing else', () => {
    expect(graphIdOfFile('/a/.agent-stream/graphs/parity.md')).toBe('parity');
    expect(graphIdOfFile('C:\\a\\.agent-stream\\graphs\\parity.meta.json')).toBe('parity');
    expect(graphIdOfFile('/a/.agent-stream/graphs/parity.json')).toBeUndefined();
    expect(graphIdOfFile('/a/.agent-stream/graphs/Bad Name.md')).toBeUndefined();
  });
});

describe('GraphFileWatcher', () => {
  it('debounces per graph and tells the engine once, the last event winning', () => {
    vi.useFakeTimers();
    const { watcher, watchers, engines } = setup();
    watcher.sync([a, b]);
    const w = watchers.get(a.key)!;
    w.change(uri('/a/.agent-stream/graphs/g.md'));
    w.change(uri('/a/.agent-stream/graphs/g.meta.json'));
    w.remove(uri('/a/.agent-stream/graphs/g.md'));
    w.create(uri('/a/.agent-stream/graphs/g.md'));
    w.change(uri('/a/.agent-stream/graphs/other.md'));
    vi.advanceTimersByTime(GRAPH_FILE_DEBOUNCE_MS - 1);
    expect(engines.get(a.key)!.graphFileChanged).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(engines.get(a.key)!.graphFileChanged.mock.calls).toEqual([['g'], ['other']]);
    expect(engines.get(a.key)!.graphFileDeleted).not.toHaveBeenCalled();
    w.remove(uri('/a/.agent-stream/graphs/g.md'));
    vi.advanceTimersByTime(GRAPH_FILE_DEBOUNCE_MS);
    expect(engines.get(a.key)!.graphFileDeleted.mock.calls).toEqual([['g']]);
    expect(engines.get(b.key)!.graphFileChanged).not.toHaveBeenCalled();
  });

  it('skips folders without a running engine, and follows the folders', () => {
    vi.useFakeTimers();
    const { watcher, watchers, engines } = setup([a]);
    watcher.sync([a, b]);
    watchers.get(b.key)!.change(uri('/b/.agent-stream/graphs/g.md'));
    vi.advanceTimersByTime(GRAPH_FILE_DEBOUNCE_MS);
    expect(engines.get(a.key)!.graphFileChanged).not.toHaveBeenCalled();
    const bWatcher = watchers.get(b.key)!;
    watcher.sync([a]);
    expect(bWatcher.dispose).toHaveBeenCalled();
    watcher.dispose();
    expect(watchers.get(a.key)!.dispose).toHaveBeenCalled();
  });
});

describe('publishGraphFileErrors', () => {
  it('puts each problem on its line in the Problems panel, and clears them', () => {
    const set = vi.fn();
    const del = vi.fn();
    publishGraphFileErrors({ set, delete: del }, a, 'g', [{ line: 3, message: 'kind is "robot"; use agent or command.' }]);
    const [target, diagnostics] = set.mock.calls[0];
    expect(String(target)).toBe('file:///a/.agent-stream/graphs/g.md');
    expect(diagnostics).toEqual([expect.objectContaining({ message: 'kind is "robot"; use agent or command.', severity: vscode.DiagnosticSeverity.Error, source: 'Agent Stream', range: expect.objectContaining({ startLine: 2, startCharacter: 0, endLine: 2 }) })]);
    publishGraphFileErrors({ set, delete: del }, a, 'g', []);
    expect(String(del.mock.calls[0][0])).toBe('file:///a/.agent-stream/graphs/g.md');
  });
});
```

Apply to `extension/test/engines.test.ts`:

```diff
diff --git a/extension/test/engines.test.ts b/extension/test/engines.test.ts
--- a/extension/test/engines.test.ts
+++ b/extension/test/engines.test.ts
@@ -1,4 +1,4 @@
-import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
+import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
 import { tmpdir } from 'node:os';
 import { join } from 'node:path';
 import { describe, expect, it, vi } from 'vitest';
@@ -313,3 +313,24 @@ describe('the Codex provider', () => {
     expect(findCodex).toHaveBeenCalledWith(expect.objectContaining({ platform: 'darwin', env: {}, setting: '/tools/codex' }));
   });
 });
+
+describe('EngineManager and graph files', () => {
+  it('logs graphs converted on startup, and passes file errors and deleted files on', () => {
+    const { manager, events } = setup();
+    events.log = vi.fn();
+    events.graphFileErrors = vi.fn();
+    const f = folder('md');
+    const graphs = join(f.path, '.agent-stream', 'graphs');
+    mkdirSync(graphs, { recursive: true });
+    writeFileSync(join(graphs, 'old.json'), JSON.stringify({ id: 'old', name: 'Old', nodes: [], edges: [] }));
+    const app = manager.get(f);
+    expect(events.log).toHaveBeenCalledWith('Converted the graph "Old" to old.md; the old file is kept as old.json.bak.');
+    writeFileSync(join(graphs, 'old.md'), 'no name\n');
+    app.graphFileChanged('old');
+    expect(events.graphFileErrors).toHaveBeenLastCalledWith(f, 'old', [{ line: 1, message: 'the file must start with the graph\'s name, as "# Name".' }]);
+    rmSync(join(graphs, 'old.md'));
+    app.graphFileDeleted('old');
+    expect(events.graphFileErrors).toHaveBeenLastCalledWith(f, 'old', []);
+    expect(events.graphDeleted).toHaveBeenLastCalledWith(f, 'old', 'file');
+  });
+});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w extension -- test/graphFiles.test.ts test/engines.test.ts`
Expected: FAIL: `../src/graphFiles` doesn't exist; `events.log` is never called.

- [ ] **Step 3: Write the watcher and the diagnostics**

Create `extension/src/graphFiles.ts`:

```ts
import * as vscode from 'vscode';
import { isGraphId, type App } from '@agent-stream/engine';
import type { GraphFileError } from '@agent-stream/shared';
import type { Folder } from './engines';
import { graphUri } from './graphEditor';

/** How long a graph file must be quiet before its engine reads it (Markdown graph files spec §6.2). */
export const GRAPH_FILE_DEBOUNCE_MS = 200;
/** What the watchers look at, relative to each workspace folder. */
export const GRAPH_FILES_GLOB = '.agent-stream/graphs/*.{md,meta.json}';

/** `<id>.md` or `<id>.meta.json` → the graph id; undefined for any other file. */
export function graphIdOfFile(path: string): string | undefined {
  const name = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1);
  const m = /^(.+?)(?:\.md|\.meta\.json)$/.exec(name);
  return m && isGraphId(m[1]) ? m[1] : undefined;
}

/** The parts of a vscode.FileSystemWatcher the watcher uses; tests pass a fake. */
export type FileWatcher = {
  onDidCreate(listener: (uri: vscode.Uri) => unknown): unknown;
  onDidChange(listener: (uri: vscode.Uri) => unknown): unknown;
  onDidDelete(listener: (uri: vscode.Uri) => unknown): unknown;
  dispose(): unknown;
};

export type GraphFileWatcherDeps = {
  /** The folder's engine, only when it is already running: a folder without one has nothing cached to update. */
  engine(folder: Folder): Pick<App, 'graphFileChanged' | 'graphFileDeleted'> | undefined;
  /** A watcher for GRAPH_FILES_GLOB in the folder (vscode.workspace.createFileSystemWatcher with a RelativePattern). */
  watch(folder: Folder): FileWatcher;
  delayMs?: number;
};

/**
 * Tells each folder's engine when one of its graph files changes outside Agent Stream (spec §6.2). Events are debounced
 * per graph; the last kind wins, so a save by rename (delete, then create) reads as a change.
 */
export class GraphFileWatcher {
  private watchers = new Map<string, { folder: Folder; watcher: FileWatcher }>();
  private pending = new Map<string, { timer: ReturnType<typeof setTimeout>; deleted: boolean }>();

  constructor(private d: GraphFileWatcherDeps) {}

  /** Watches exactly these folders: new ones get a watcher, removed ones lose theirs. */
  sync(folders: Folder[]): void {
    const keys = new Set(folders.map((f) => f.key));
    for (const [key, w] of this.watchers) {
      if (keys.has(key)) continue;
      w.watcher.dispose();
      this.watchers.delete(key);
    }
    for (const folder of folders) {
      if (this.watchers.has(folder.key)) continue;
      const watcher = this.d.watch(folder);
      watcher.onDidCreate((uri) => this.event(folder, uri.path, false));
      watcher.onDidChange((uri) => this.event(folder, uri.path, false));
      watcher.onDidDelete((uri) => this.event(folder, uri.path, true));
      this.watchers.set(folder.key, { folder, watcher });
    }
  }

  private event(folder: Folder, path: string, deleted: boolean): void {
    const id = graphIdOfFile(path);
    if (!id) return;
    const key = `${folder.key}|${id}`;
    const before = this.pending.get(key);
    if (before) clearTimeout(before.timer);
    const timer = setTimeout(() => {
      this.pending.delete(key);
      this.fire(folder, id, deleted);
    }, this.d.delayMs ?? GRAPH_FILE_DEBOUNCE_MS);
    this.pending.set(key, { timer, deleted });
  }

  private fire(folder: Folder, id: string, deleted: boolean): void {
    const engine = this.d.engine(folder);
    if (!engine) return;
    try {
      if (deleted) engine.graphFileDeleted(id);
      else engine.graphFileChanged(id);
    } catch (e) {
      console.error(`[agent-stream] could not read the graph file ${id}`, e);
    }
  }

  dispose(): void {
    for (const { timer } of this.pending.values()) clearTimeout(timer);
    this.pending.clear();
    for (const { watcher } of this.watchers.values()) watcher.dispose();
    this.watchers.clear();
  }
}

/** Where a line's problem shows in the Problems panel: the whole line. */
const LINE_END = 10_000;

/** A Markdown file problem as a VS Code diagnostic on its line. */
export function toDiagnostic(error: GraphFileError): vscode.Diagnostic {
  const line = Math.max(0, error.line - 1);
  const d = new vscode.Diagnostic(new vscode.Range(line, 0, line, LINE_END), error.message, vscode.DiagnosticSeverity.Error);
  d.source = 'Agent Stream';
  return d;
}

/** The parts of a vscode.DiagnosticCollection used here. */
export type Diagnostics = { set(uri: vscode.Uri, diagnostics: vscode.Diagnostic[]): void; delete(uri: vscode.Uri): void };

/** Shows a graph's Markdown problems in the Problems panel, and clears them when there are none (spec §6.3). */
export function publishGraphFileErrors(diagnostics: Diagnostics, folder: Folder, graphId: string, errors: GraphFileError[]): void {
  const uri = graphUri(folder, graphId);
  if (errors.length) diagnostics.set(uri, errors.map(toDiagnostic));
  else diagnostics.delete(uri);
}
```

- [ ] **Step 4: Pass the engine's new messages on**

Apply to `extension/src/engines.ts`:

```diff
diff --git a/extension/src/engines.ts b/extension/src/engines.ts
--- a/extension/src/engines.ts
+++ b/extension/src/engines.ts
@@ -16,7 +16,7 @@ import {
   type GitExec,
   type WriteLeases,
 } from '@agent-stream/engine';
-import type { ApprovalRequest, GraphListItem, ProviderId, ProviderStatus, ServerMessage, SessionListItem } from '@agent-stream/shared';
+import type { ApprovalRequest, GraphFileError, GraphListItem, ProviderId, ProviderStatus, ServerMessage, SessionListItem } from '@agent-stream/shared';
 import { createCopilotProvider, type LmAccess } from './providers/copilot';
 import { parseProviderSetting } from './providers/registry';
 import type { Settings } from './settings';
@@ -29,7 +29,12 @@ export type EngineEvents = {
   graphs(folder: Folder, graphs: GraphListItem[]): void;
   approvals(): void;
   confirmRun(folder: Folder, graphId: string, fromNodeId?: string, sourceRunId?: string, requestedBy?: 'planner'): void;
-  graphDeleted(folder: Folder, graphId: string): void;
+  /** `reason: 'file'`: the graph's Markdown file disappeared; the graph comes back with it (Markdown graph files spec §6.5). */
+  graphDeleted(folder: Folder, graphId: string, reason?: 'file'): void;
+  /** The graph's Markdown file has these problems; [] once they are fixed (spec §6.3). */
+  graphFileErrors?(folder: Folder, graphId: string, errors: GraphFileError[]): void;
+  /** A line for the Agent Stream output channel: each graph converted to Markdown on startup (spec §5.2). */
+  log?(message: string): void;
   /** A folder's work sessions: sent on connect and after every change. */
   sessions(folder: Folder, sessions: SessionListItem[]): void;
   auth(status: ProviderStatus): void;
@@ -192,6 +197,7 @@ export class EngineManager {
     this.engines.set(folder.key, entry);
     entry.detach = app.connect({ send: (msg) => this.observe(folder, msg) });
     for (const warning of app.startupWarnings()) this.d.events.warning(warning);
+    for (const note of app.startupNotes()) this.d.events.log?.(note);
     return app;
   }
 
@@ -226,7 +232,9 @@ export class EngineManager {
       case 'confirmRun':
         return this.d.events.confirmRun(folder, msg.graphId, msg.fromNodeId, msg.sourceRunId, msg.requestedBy);
       case 'graphDeleted':
-        return this.d.events.graphDeleted(folder, msg.graphId);
+        return this.d.events.graphDeleted(folder, msg.graphId, msg.reason);
+      case 'graphFileErrors':
+        return this.d.events.graphFileErrors?.(folder, msg.graphId, msg.errors);
       case 'sessions':
         return this.d.events.sessions(folder, msg.sessions);
     }
```

- [ ] **Step 5: Wire them up in the extension**

Apply to `extension/src/extension.ts`. The output channel and the diagnostic collection are created before the events object; Delete Graph still closes its tab, while a deleted file leaves the tab open (R9); every deletion clears the file's diagnostics.

```diff
diff --git a/extension/src/extension.ts b/extension/src/extension.ts
--- a/extension/src/extension.ts
+++ b/extension/src/extension.ts
@@ -6,7 +6,8 @@ import { ApprovalsView, approvalsBadge } from './approvalsView';
 import { ChatViewController, ChatViewProvider, type ChatSource } from './chatView';
 import { graphCommands } from './commands';
 import { EngineManager, isChecking, type EngineEvents, type Folder } from './engines';
-import { folderFor, workspaceFolders } from './folders';
+import { folderFor, folderUri, workspaceFolders } from './folders';
+import { GRAPH_FILES_GLOB, GraphFileWatcher, publishGraphFileErrors } from './graphFiles';
 import { GRAPH_VIEW_TYPE, GraphEditorProvider, GraphPanels, graphTarget, graphUri, hostCommandArgs, openAndSend, openGraphTab, type GraphPanel } from './graphEditor';
 import { FolderItem, GraphsView } from './graphsView';
 import { ApprovalNotifier } from './notifications';
@@ -33,6 +34,9 @@ export async function activate(context: vscode.ExtensionContext) {
     status.show();
   };
 
+  const output = vscode.window.createOutputChannel('Agent Stream');
+  const diagnostics = vscode.languages.createDiagnosticCollection('agent-stream');
+  context.subscriptions.push(output, diagnostics);
   // Views and tabs replace these no-ops as they are wired up below.
   const events: EngineEvents = {
     graphs: () => {},
@@ -42,6 +46,8 @@ export async function activate(context: vscode.ExtensionContext) {
     sessions: () => {},
     auth: showAuth,
     warning: (message) => void vscode.window.showWarningMessage(message),
+    log: (message) => output.appendLine(message),
+    graphFileErrors: (folder, graphId, errors) => publishGraphFileErrors(diagnostics, folder, graphId, errors),
   };
   const manager = new EngineManager({
     settings: readSettings,
@@ -137,12 +143,22 @@ export async function activate(context: vscode.ExtensionContext) {
     // An open tab already got confirmRun from the engine; a closed one is opened first.
     if (!panels.get(folder.key, graphId)) void openAndSend(panels, folder, graphId, { type: 'openRunDialog', fromNodeId, sourceRunId, ...(requestedBy && { requestedBy }) });
   };
-  events.graphDeleted = (folder, graphId) => {
+  events.graphDeleted = (folder, graphId, reason) => {
+    publishGraphFileErrors(diagnostics, folder, graphId, []);
+    // A deleted file (or a branch switch) leaves the tab open: it shows the graph again when the file comes back.
+    if (reason === 'file') return;
     const panel = panels.get(folder.key, graphId);
     if (!panel) return;
     panel.view.close();
     void vscode.window.showInformationMessage(`The graph ${graphId} was deleted, so its tab was closed.`);
   };
+  // Edits to graph files made outside Agent Stream reach the folder's engine (Markdown graph files spec §6.2).
+  const fileWatcher = new GraphFileWatcher({
+    engine: (folder) => (manager.has(folder.key) ? manager.get(folder) : undefined),
+    watch: (folder) => vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folderUri(folder), GRAPH_FILES_GLOB)),
+  });
+  fileWatcher.sync(workspaceFolders());
+  context.subscriptions.push(fileWatcher, vscode.workspace.onDidChangeWorkspaceFolders(() => fileWatcher.sync(workspaceFolders())));
 
   // Work sessions: each folder's set of graph tabs (sessions spec §5).
   const sessionStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
@@ -245,8 +261,8 @@ export async function activate(context: vscode.ExtensionContext) {
     chat.refresh(graphSources());
   };
   const baseDeleted = events.graphDeleted;
-  events.graphDeleted = (folder, graphId) => {
-    baseDeleted(folder, graphId);
+  events.graphDeleted = (folder, graphId, reason) => {
+    baseDeleted(folder, graphId, reason);
     chat.refresh(graphSources());
   };
   chat.activate(activeGraphSource(), graphSources());
```

- [ ] **Step 6: Run the tests to verify they pass, and build**

Run: `npm test -w extension && npm run build`
Expected: PASS, and the build succeeds.

- [ ] **Step 7: Typecheck and commit**

Run: `npm run typecheck`
Expected: no errors.

```bash
git add extension/src/graphFiles.ts extension/test/graphFiles.test.ts extension/src/engines.ts extension/src/extension.ts extension/test/vscode.ts extension/test/engines.test.ts
git commit -m "$(cat <<'MSG'
feat(extension): watch graph files and show their problems

A file system watcher per folder tells the engine when <id>.md or
<id>.meta.json changes (debounced 200 ms per graph, last event wins).
File errors appear in the Problems panel on their lines, a deleted file
leaves its tab open, and graphs converted on startup are listed in the
Agent Stream output channel.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
)"
```

---

### Task 11: The graph tab: notices, File › Open as Markdown, and reopening

**Spec tests owned (§9):** web — the error notice on a graph tab, and the menu item (§6.3, §6.5, §7). R9.

**Files:**
- Create: `web/src/components/GraphFileNotice.tsx`, `web/test/GraphFileNotice.test.ts`
- Modify: `web/src/App.tsx`, `web/src/menuModel.ts`, `web/src/bridge.ts`
- Test: `web/test/menuModel.test.ts`, `web/test/bridge.test.ts`

**Interfaces:**
- Consumes: `State.fileErrors`, `State.graphGone` (Task 1); `formatFileErrors` (Task 3); host command `openGraphMarkdown` (Tasks 1, 9).
- Produces: `GraphFileNotice` (rendered under the provider banner); File menu item `Open as Markdown` after `Export…`, disabled when the graph's file is gone; the bridge re-sends `openGraph` when a `graphs` list newly holds the tab's graph, readable, while the tab has no graph.

**Existing tests changed (named exception):** `menuModel.test.ts` "enables File items from the spec…" lists the new item.

- [ ] **Step 1: Write the failing tests**

Create `web/test/GraphFileNotice.test.ts`:

```ts
// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyGraph, type HostMessage } from '@agent-stream/shared';

vi.mock('../src/bridge', () => ({ send: vi.fn(), sendHost: vi.fn(), post: vi.fn(), bootGraphId: () => 'parity' }));
const { sendHost } = await import('../src/bridge');
const { dispatch, resetStoreForTests } = await import('../src/store');
const { GraphFileNotice } = await import('../src/components/GraphFileNotice');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
const server = (msg: HostMessage) => act(async () => dispatch({ kind: 'server', msg }));

beforeEach(async () => {
  resetStoreForTests();
  dispatch({ kind: 'server', msg: { type: 'graphOpened', changes: [], graph: emptyGraph('parity', 'Parity', 't'), runs: [], variableValues: {} } });
  container = document.createElement('div');
  root = createRoot(container);
  await act(async () => root.render(createElement(GraphFileNotice)));
});
afterEach(async () => act(async () => root.unmount()));

describe('GraphFileNotice', () => {
  it('says the file has errors and the last good version is shown, with a way to open the file', async () => {
    expect(container.textContent).toBe('');
    await server({ type: 'graphFileErrors', graphId: 'parity', errors: [{ line: 4, message: 'kind is "robot"; use agent or command.' }, { line: 9, message: 'x' }] });
    expect(container.textContent).toBe('The file parity.md has errors, so the last good version is shown. line 4: kind is "robot"; use agent or command. (and 1 more) Open as Markdown');
    act(() => (container.querySelector('button') as HTMLButtonElement).click());
    expect(sendHost).toHaveBeenCalledWith('openGraphMarkdown');
    await server({ type: 'graphFileErrors', graphId: 'parity', errors: [] });
    expect(container.textContent).toBe('');
  });

  it('says the graph was deleted when its file is gone', async () => {
    await server({ type: 'graphDeleted', graphId: 'parity', reason: 'file' });
    expect(container.textContent).toBe('This graph was deleted.');
  });
});
```

Apply to `web/test/menuModel.test.ts`:

```diff
diff --git a/web/test/menuModel.test.ts b/web/test/menuModel.test.ts
--- a/web/test/menuModel.test.ts
+++ b/web/test/menuModel.test.ts
@@ -37,6 +37,7 @@ describe('menus', () => {
       ['Open…', true],
       ['Import…', true],
       ['Export…', true],
+      ['Open as Markdown', true],
       ['Rename…', true],
       ['Duplicate', true],
       ['Delete…', true],
@@ -161,3 +162,11 @@ describe('menus', () => {
     ]);
   });
 });
+
+describe('File › Open as Markdown', () => {
+  it('asks the extension to open the graph file, unless the file is gone', () => {
+    items(base(), 'file')['Open as Markdown'].run();
+    expect(sendHost).toHaveBeenCalledWith('openGraphMarkdown');
+    expect(items(base({ graph: undefined, graphGone: true }), 'file')['Open as Markdown'].enabled).toBe(false);
+  });
+});
```

Apply to `web/test/bridge.test.ts`:

```diff
diff --git a/web/test/bridge.test.ts b/web/test/bridge.test.ts
--- a/web/test/bridge.test.ts
+++ b/web/test/bridge.test.ts
@@ -55,3 +55,18 @@ describe('bridge', () => {
     expect(loadViewState()).toEqual({ layout: { sideWidth: 300 } });
   });
 });
+
+describe('bridge: the graph file comes back', () => {
+  it('opens its graph again when the list has it readable again, and only then', () => {
+    const graphs = (error?: string) => ({ type: 'graphs', graphs: [{ id: 'parity', name: 'Parity', ...(error && { error }) }] });
+    deliver({ type: 'graphDeleted', graphId: 'parity', reason: 'file' });
+    deliver({ type: 'graphs', graphs: [] });
+    posted.length = 0;
+    deliver(graphs('line 1: the file must start with the graph\'s name, as "# Name".'));
+    expect(posted).toEqual([]);
+    deliver(graphs());
+    expect(posted).toEqual([{ type: 'openGraph', graphId: 'parity' }]);
+    deliver(graphs());
+    expect(posted).toHaveLength(1);
+  });
+});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w web -- test/GraphFileNotice.test.ts test/menuModel.test.ts test/bridge.test.ts`
Expected: FAIL: `../src/components/GraphFileNotice` doesn't exist; there is no `Open as Markdown` item; no `openGraph` is sent when the graph comes back.

- [ ] **Step 3: Write the notice and the menu item**

Create `web/src/components/GraphFileNotice.tsx`:

```tsx
import { formatFileErrors } from '@agent-stream/shared';
import { bootGraphId, sendHost } from '../bridge';
import { useStore } from '../store';

/** The graph's Markdown file has problems, or is gone (Markdown graph files spec §6.3, §6.5). */
export function GraphFileNotice() {
  const errors = useStore((s) => s.fileErrors);
  const gone = useStore((s) => s.graphGone);
  if (gone) return <div className="banner">This graph was deleted.</div>;
  if (!errors.length) return null;
  return (
    <div className="banner file-errors">
      {`The file ${bootGraphId()}.md has errors, so the last good version is shown. ${formatFileErrors(errors)} `}
      <button className="link" onClick={() => sendHost('openGraphMarkdown')}>
        Open as Markdown
      </button>
    </div>
  );
}
```

Apply to `web/src/App.tsx`:

```diff
diff --git a/web/src/App.tsx b/web/src/App.tsx
--- a/web/src/App.tsx
+++ b/web/src/App.tsx
@@ -1,6 +1,7 @@
 import { ReactFlowProvider } from '@xyflow/react';
 import { Canvas } from './components/Canvas';
 import { ChangeConfirmDialog } from './components/ChangeConfirmDialog';
+import { GraphFileNotice } from './components/GraphFileNotice';
 import { LogsPanel } from './components/LogsPanel';
 import { RightPanel } from './components/RightPanel';
 import { RunConfirmDialog } from './components/RunConfirmDialog';
@@ -15,6 +16,7 @@ export function App() {
     <div className="app">
       <TopBar />
       {status && !status.ok && <div className="banner">{`${status.error} Fix this, then use Check again in the Agent Stream sidebar.`}</div>}
+      <GraphFileNotice />
       <main className="main">
         <div className="workspace">
           <ReactFlowProvider>
```

Apply to `web/src/menuModel.ts`:

```diff
diff --git a/web/src/menuModel.ts b/web/src/menuModel.ts
--- a/web/src/menuModel.ts
+++ b/web/src/menuModel.ts
@@ -43,6 +43,7 @@ export function buildMenus(s: State): Menu[] {
         host('Import…', 'importGraph'),
         SEPARATOR,
         host('Export…', 'exportGraph', hasGraph),
+        host('Open as Markdown', 'openGraphMarkdown', !s.graphGone),
         host('Rename…', 'renameGraph', hasGraph),
         host('Duplicate', 'duplicateGraph', hasGraph),
         SEPARATOR,
```

- [ ] **Step 4: Open the graph again when its file comes back**

Apply to `web/src/bridge.ts`:

```diff
diff --git a/web/src/bridge.ts b/web/src/bridge.ts
--- a/web/src/bridge.ts
+++ b/web/src/bridge.ts
@@ -1,5 +1,5 @@
-import type { ClientMessage, HostCommand, HostMessage, WebviewMessage } from '@agent-stream/shared';
-import { dispatch } from './store';
+import type { ClientMessage, GraphListItem, HostCommand, HostMessage, WebviewMessage } from '@agent-stream/shared';
+import { dispatch, getState } from './store';
 
 type VsCodeApi = { postMessage(message: unknown): void; getState?(): unknown; setState?(state: unknown): void };
 declare const acquireVsCodeApi: (() => VsCodeApi) | undefined;
@@ -40,13 +40,19 @@ function isHostMessage(x: unknown): x is HostMessage {
   return typeof x === 'object' && x !== null && typeof (x as { type?: unknown }).type === 'string';
 }
 
+/** Whether the graphs list has this tab's graph, readable. */
+const listsOwnGraph = (graphs: readonly GraphListItem[]) => graphs.some((g) => g.id === bootGraphId() && !g.error);
+
 /** Listens to the extension and tells it this tab is ready; reports once its graph has loaded (ruling R5). */
 export function connect(): void {
   window.addEventListener('message', (event: MessageEvent) => {
     const msg: unknown = event.data;
     if (!isHostMessage(msg)) return;
+    const wasListed = listsOwnGraph(getState().graphs);
     dispatch({ kind: 'server', msg });
     if (msg.type === 'hello') send({ type: 'openGraph', graphId: bootGraphId() });
+    // The graph's file came back, or reads again (Markdown graph files spec §6.5): open it again.
+    if (msg.type === 'graphs' && !getState().graph && !wasListed && listsOwnGraph(msg.graphs)) send({ type: 'openGraph', graphId: bootGraphId() });
     if (msg.type === 'graphOpened') post({ type: 'opened', graphId: msg.graph.id });
   });
   // The checkout can change while the tab is hidden (a branch switch in a terminal): ask again when it shows (spec §7).
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -w web`
Expected: PASS.

- [ ] **Step 6: Typecheck and commit**

Run: `npm run typecheck`
Expected: no errors.

```bash
git add web/src/components/GraphFileNotice.tsx web/test/GraphFileNotice.test.ts web/src/App.tsx web/src/menuModel.ts web/src/bridge.ts web/test/menuModel.test.ts web/test/bridge.test.ts
git commit -m "$(cat <<'MSG'
feat(web): graph file notices and File › Open as Markdown

The graph tab says when its Markdown file has errors (the last good
version is shown) or was deleted, offers Open as Markdown in the File
menu and the notice, and opens the graph again when its file returns.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
)"
```

---

### Task 12: The integration check, the docs and the full verification

**Spec tests owned (§9):** extension integration suite (open a folder with a JSON graph, see it migrated, edit the `.md`, see the change); §8 docs (`docs/graph-format.md` with a full example and every rule in §2, a "Graph files" section in both READMEs, the "Files it writes" table). R20.

**Files:**
- Create: `docs/graph-format.md`, `engine/test/graphFormatDoc.test.ts`
- Modify: `extension/test/integration/runTest.mjs`, `extension/test/integration/suite.cjs`, `README.md`, `extension/README.md`

**Interfaces:**
- Consumes: everything above.
- Produces: docs only, and the integration checks.

- [ ] **Step 1: Write the format document and its test**

Create `docs/graph-format.md`:

``````markdown
# Agent Stream graph files

Agent Stream saves each graph as a Markdown file, `.agent-stream/graphs/<id>.md`. The same file:

- renders on GitHub, with the steps drawn as a diagram;
- shows readable diffs in pull requests;
- can be edited by hand, or written by another AI or a script. When you save it, the open graph tab follows.

Open it from a graph tab with **File › Open as Markdown**, from a graph's right-click menu in the Graphs sidebar, or with **Agent Stream: Open Graph as Markdown**.

## A full example

`````markdown
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
  n2["Run model"] --> n3["Check table exists"]
```

## n1 · Check table absent

- kind: command
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
Run `dbt run -s dim_customer` in {{ target_schema }} and report the row count.
```

## n3 · Check table exists

- kind: command

```sh
dbt run-operation table_exists --args '{table: dim_customer}'
```
`````

## The parts of the file

The file is read line by line. A `#` inside a fenced code block is never read as a heading.

- **`# <name>`:** the first line that isn't blank. It is the graph's name. A file has exactly one `#` heading, and nothing goes between it and the first `##` section.
- **`## Goal`** and **`## Instructions`:** free Markdown, trimmed. Both are optional; a missing one is empty.
- **`## Variables`:** one variable per bullet, `` - `name`: description ``, or `` - `name` `` without a description. Names use letters, digits and `_` and start with a letter or `_`. Values never appear in the file: they stay on your machine.
- **`## Flow`:** exactly one ```` ```mermaid ```` block with the connections (below). Without a Flow section no step is connected.
- **Every other `##` heading is a step.**

Goal, Instructions, Variables and Flow may come in any order, before or between steps, each at most once. Their names are read in any letter case.

## Steps

A step heading is `## <id> · <title>`: the separator is a space, a middle dot (`·`, U+00B7) and a space. Ids use letters, digits, `-` and `_`. A heading without an id, `## <title>`, is a new step: Agent Stream gives it the next free id (`n7`, say) and writes the id into the heading. Ids are never reused. A step with an id and the title `Goal` is still a step.

A step section holds, in this order:

1. **Fields**, one bullet each, `- key: value`:
   - `kind`: `agent` or `command`. Agent Stream always writes it. When it's missing, a ```` ```prompt ```` block means an agent step and a ```` ```sh ```` block a command step.
   - `access`: `read` for an agent step that only reads and reports. Missing (or `write`) means it can change files. Command steps can always change files.
   - `workspace`: a variant workspace name (lowercase letters, digits, `-` and `_`, starting with a letter). Steps with the same workspace share one worktree per run. Missing means this checkout.
   - `timeout`: a whole number of seconds, from 1 to 2147483.
2. **A description** (optional): one or more `>` lines, joined with spaces. One plain-language sentence for people: what the step does and why.
3. **Exactly one code block:**
   - ```` ```prompt ```` (or `text`, `md`) for an agent step's prompt;
   - ```` ```sh ```` (or `bash`, `shell`) for a command step's command.

   The content is kept exactly, including `{{ variables }}`, dbt's `{% raw %}` blocks and inner code fences: use a longer fence outside (```` ```` ````) when the content has ```` ``` ```` lines. An empty block is an empty prompt or command. The block must match `kind`.

Anything else in a step section (a paragraph, a second code block, a sub-heading) is an error: nothing you write is ever dropped silently.

## The Flow

```mermaid
flowchart LR
  n1["Check table absent"] --> n2["Run model"]
  n2["Run model"] --> n3["Check table exists"]
```

- The first line is `flowchart LR` (or `TD`, `TB`, `RL`, `BT`, or `graph …`). The direction is only for the diagram.
- Each line is a chain of step ids joined by `-->`: `a --> b --> c` connects a to b and b to c.
- A step id may carry a label: `n1["Title"]`, `n1("Title")` or `n1[Title]`. Labels are only for the diagram: titles come from the step headings.
- Blank lines and `%%` comments are ignored. A step id alone on a line adds no connection.
- Anything else Mermaid offers (subgraphs, `-.->`, `==>`, link text, `classDef`, `style`) is an error, so the file never holds connections Agent Stream can't show.
- Every id needs a step section, and the arrows can't loop back to an earlier step.
- Mermaid can't draw a node whose id is `end`: give such a step another id.

## When the file has errors

Agent Stream keeps showing the last good version of the graph and changes no file. Each problem appears in VS Code's Problems panel on its line, with how to fix it, and the graph tab says the file has errors. Until the file is fixed, the graph can't be changed from the canvas (moving a step still works). Every message says what to change, so another AI can fix the file from the messages alone.

## When you save the file

Agent Stream turns your edit into graph changes, recorded in the graph's history as yours, then writes the file back in its own layout: it adds ids to new steps, puts the sections in order (name, Goal, Instructions, Variables, Flow, then the steps in canvas order) and leaves out empty sections. New steps go after the others. A renamed variable is a deleted variable plus a new one. A run that is already going keeps the graph it started with.

## The side file

`.agent-stream/graphs/<id>.meta.json` holds where each step sits on the canvas, who made and last changed each step and when, and the last id issued, so the Markdown only changes when the graph's meaning does. It is safe to commit. Without it, the canvas lays the steps out by itself and every step counts as yours.
``````

Create `engine/test/graphFormatDoc.test.ts` (in `engine/`, because `shared/` has no Node types):

``````ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { graphFromDoc, parseGraphMarkdown, serializeGraphMarkdown } from '@agent-stream/shared';

describe('docs/graph-format.md', () => {
  it('has a full example that reads without errors and is already in Agent Stream’s own layout', () => {
    const doc = readFileSync(new URL('../../docs/graph-format.md', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    const example = /`````markdown\n([\s\S]*?)\n`````/.exec(doc)?.[1];
    if (!example) throw new Error('no example in docs/graph-format.md');
    const r = parseGraphMarkdown(example);
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    expect(serializeGraphMarkdown(graphFromDoc(r.doc, undefined, 'scd2-tests', '2026-10-04T00:00:00.000Z'))).toBe(`${example}\n`);
  });
});
``````

Run: `npm test -w engine -- test/graphFormatDoc.test.ts`
Expected: PASS. (If it fails, fix the example in the document, not the parser.)

- [ ] **Step 2: Update both READMEs**

`README.md` and `extension/README.md` get the same changes.

Apply to `README.md`:

````diff
diff --git a/README.md b/README.md
--- a/README.md
+++ b/README.md
@@ -35,7 +35,7 @@ Get `agent-stream-<version>.vsix` (or build it: `npm install && npm run package`
 ## Use
 
 - **Agent Stream sidebar:**
-  - **Graphs:** New, Import, and right-click for Open, Rename, Duplicate, Export, Delete.
+  - **Graphs:** New, Import, and right-click for Open, Open Graph as Markdown, Rename, Duplicate, Export, Delete. A graph whose file has errors shows **Can't be read**: click it to open the file, with its problems in the Problems panel.
   - **Sessions:** New Session, click to switch, right-click for Rename, Duplicate, Delete.
   - **Approvals:** Approve, Deny, Approve all.
 - **Chat view:** the **Agent Stream Chat** view on the right, next to VS Code's own Chat. It shows the planner conversation for the graph tab you're on, in the current session. Describe a goal; the planner reads your repo (read-only) and draws the plan. **New chat** starts over; the session button switches session.
@@ -57,7 +57,11 @@ Get `agent-stream-<version>.vsix` (or build it: `npm install && npm run package`
 - **Variables:** use `{{ name }}` (Jinja) in steps, the goal and the instructions. Values stay on this machine, outside the project, in `~/.agent-stream/values/` (`%USERPROFILE%\.agent-stream\values\` on Windows): they are never committed or exported, and Claude's Read, Grep and Glob tools are refused access to them (a shell command an agent attempts still needs your approval first). A value can read an environment variable: `{{ env_var('DBT_SCHEMA', 'dev') }}`. In commands every value is shell-quoted; `{{ flags | unquoted }}` opts out. A value inside `'…'` or `"…"` is escaped for those quotes. Places where a value can't be quoted safely (after a backtick, `$((`, `${`, `$'`, `$"` or a heredoc, inside a `#` comment or nested quotes, or right after a `\`) are refused with a message that says how to fix the step. Wrap dbt's own Jinja in `{% raw %}…{% endraw %}`.
 - **Run:** the dialog shows every command and prompt with values filled in, plus any problem that blocks the run. Start runs exactly what you reviewed.
 - **Run report:** **Run › Export Run Report…**, the **Report** button next to the run picker, or **Agent Stream: Export Run Report** saves one Markdown audit trail of a run (`<graph-id>-run-<run-id>.md`, in the project folder by default) and opens it: where and how it ran (branch, commit, provider, model, effort), the goal, instructions and plan, then each step's prompt or command as it ran, its tool calls, every approval with its decision and note, its output (long output is cut, with the path to the full file), exit code and usage, and the changes agents made during the run. Prompts, commands and step output appear exactly as they ran, including filled-in variable and environment values and anything an agent printed. The saved variable values file is never included.
-- **Export / Import:** share a graph's definition (steps, goal, instructions, variable names) as `<name>.agent-stream.json`.
+- **Export / Import:** share a graph as its Markdown file, `<id>.md` (the same text as the stored file, so never a variable value). Import takes a graph Markdown file, or an older `<name>.agent-stream.json` export.
+
+## Graph files
+
+Each graph is a Markdown file, `.agent-stream/graphs/<id>.md`: a Mermaid diagram of the connections and one section per step with its fields, description and prompt or command. It renders on GitHub, diffs cleanly in pull requests, and can be edited by hand or by another AI or script. Save it and the open graph tab follows; a file with errors shows them in the Problems panel and the last good version stays. Open it with **File › Open as Markdown** in the graph tab, the same item on a graph's right-click menu, or **Agent Stream: Open Graph as Markdown**. Positions and bookkeeping live next to it in `<id>.meta.json`. The format, every rule and a full example: [docs/graph-format.md](https://github.com/keith-fajardo/agent-stream/blob/main/docs/graph-format.md).
 
 ## Parallel tickets and A/B tests
 
@@ -209,14 +213,15 @@ Agent Stream runs agent steps and the planner on your ChatGPT subscription throu
 
 ```
 <folder>/.agent-stream/
-  graphs/<id>.json            the graph (safe to commit)
+  graphs/<id>.md              the graph, as Markdown (safe to commit)
+  graphs/<id>.meta.json       where each step sits on the canvas, who made and changed it (safe to commit; optional)
   graphs/<id>.ops.jsonl       who changed what, and when
   graphs/<id>.baseline.json   your version of the graph while agent changes wait for review
   runs/<run-id>/              run snapshot, per-step events and outputs (git-ignored)
   sessions/<id>/              your work sessions: open tabs, planner chats and Copilot planner transcripts (git-ignored)
 ```
 
-Older `.claude-stream` folders and values are moved to the new names automatically the first time a folder is opened. Older planner chats move into a session called Default the first time a folder is opened.
+Older `.claude-stream` folders and values are moved to the new names automatically the first time a folder is opened. Graphs saved as `<id>.json` by earlier versions are converted to `<id>.md` and `<id>.meta.json` the first time a folder is opened; the old file is kept as `<id>.json.bak`, and the Agent Stream output channel lists each conversion. Older planner chats move into a session called Default the first time a folder is opened.
 
 Variable values are kept outside the project, in `~/.agent-stream/values/<hash>.json`, one file per project folder (named after a hash of the folder's path).
 
````

Apply to `extension/README.md`:

````diff
diff --git a/extension/README.md b/extension/README.md
--- a/extension/README.md
+++ b/extension/README.md
@@ -35,7 +35,7 @@ Install Agent Stream from the VS Code Marketplace, or from an `agent-stream-<ver
 ## Use
 
 - **Agent Stream sidebar:**
-  - **Graphs:** New, Import, and right-click for Open, Rename, Duplicate, Export, Delete.
+  - **Graphs:** New, Import, and right-click for Open, Open Graph as Markdown, Rename, Duplicate, Export, Delete. A graph whose file has errors shows **Can't be read**: click it to open the file, with its problems in the Problems panel.
   - **Sessions:** New Session, click to switch, right-click for Rename, Duplicate, Delete.
   - **Approvals:** Approve, Deny, Approve all.
 - **Chat view:** the **Agent Stream Chat** view on the right, next to VS Code's own Chat. It shows the planner conversation for the graph tab you're on, in the current session. Describe a goal; the planner reads your repo (read-only) and draws the plan. **New chat** starts over; the session button switches session.
@@ -57,7 +57,11 @@ Install Agent Stream from the VS Code Marketplace, or from an `agent-stream-<ver
 - **Variables:** use `{{ name }}` (Jinja) in steps, the goal and the instructions. Values stay on this machine, outside the project, in `~/.agent-stream/values/` (`%USERPROFILE%\.agent-stream\values\` on Windows): they are never committed or exported, and Claude's Read, Grep and Glob tools are refused access to them (a shell command an agent attempts still needs your approval first). A value can read an environment variable: `{{ env_var('DBT_SCHEMA', 'dev') }}`. In commands every value is shell-quoted; `{{ flags | unquoted }}` opts out. A value inside `'…'` or `"…"` is escaped for those quotes. Places where a value can't be quoted safely (after a backtick, `$((`, `${`, `$'`, `$"` or a heredoc, inside a `#` comment or nested quotes, or right after a `\`) are refused with a message that says how to fix the step. Wrap dbt's own Jinja in `{% raw %}…{% endraw %}`.
 - **Run:** the dialog shows every command and prompt with values filled in, plus any problem that blocks the run. Start runs exactly what you reviewed.
 - **Run report:** **Run › Export Run Report…**, the **Report** button next to the run picker, or **Agent Stream: Export Run Report** saves one Markdown audit trail of a run (`<graph-id>-run-<run-id>.md`, in the project folder by default) and opens it: where and how it ran (branch, commit, provider, model, effort), the goal, instructions and plan, then each step's prompt or command as it ran, its tool calls, every approval with its decision and note, its output (long output is cut, with the path to the full file), exit code and usage, and the changes agents made during the run. Prompts, commands and step output appear exactly as they ran, including filled-in variable and environment values and anything an agent printed. The saved variable values file is never included.
-- **Export / Import:** share a graph's definition (steps, goal, instructions, variable names) as `<name>.agent-stream.json`.
+- **Export / Import:** share a graph as its Markdown file, `<id>.md` (the same text as the stored file, so never a variable value). Import takes a graph Markdown file, or an older `<name>.agent-stream.json` export.
+
+## Graph files
+
+Each graph is a Markdown file, `.agent-stream/graphs/<id>.md`: a Mermaid diagram of the connections and one section per step with its fields, description and prompt or command. It renders on GitHub, diffs cleanly in pull requests, and can be edited by hand or by another AI or script. Save it and the open graph tab follows; a file with errors shows them in the Problems panel and the last good version stays. Open it with **File › Open as Markdown** in the graph tab, the same item on a graph's right-click menu, or **Agent Stream: Open Graph as Markdown**. Positions and bookkeeping live next to it in `<id>.meta.json`. The format, every rule and a full example: [docs/graph-format.md](https://github.com/keith-fajardo/agent-stream/blob/main/docs/graph-format.md).
 
 ## Parallel tickets and A/B tests
 
@@ -209,14 +213,15 @@ Agent Stream runs agent steps and the planner on your ChatGPT subscription throu
 
 ```
 <folder>/.agent-stream/
-  graphs/<id>.json            the graph (safe to commit)
+  graphs/<id>.md              the graph, as Markdown (safe to commit)
+  graphs/<id>.meta.json       where each step sits on the canvas, who made and changed it (safe to commit; optional)
   graphs/<id>.ops.jsonl       who changed what, and when
   graphs/<id>.baseline.json   your version of the graph while agent changes wait for review
   runs/<run-id>/              run snapshot, per-step events and outputs (git-ignored)
   sessions/<id>/              your work sessions: open tabs, planner chats and Copilot planner transcripts (git-ignored)
 ```
 
-Older `.claude-stream` folders and values are moved to the new names automatically the first time a folder is opened. Older planner chats move into a session called Default the first time a folder is opened.
+Older `.claude-stream` folders and values are moved to the new names automatically the first time a folder is opened. Graphs saved as `<id>.json` by earlier versions are converted to `<id>.md` and `<id>.meta.json` the first time a folder is opened; the old file is kept as `<id>.json.bak`, and the Agent Stream output channel lists each conversion. Older planner chats move into a session called Default the first time a folder is opened.
 
 Variable values are kept outside the project, in `~/.agent-stream/values/<hash>.json`, one file per project folder (named after a hash of the folder's path).
 
````

- [ ] **Step 3: Extend the integration suite**

The sample workspace keeps writing JSON graphs, so the suite sees them converted.

Apply to `extension/test/integration/runTest.mjs`:

```diff
diff --git a/extension/test/integration/runTest.mjs b/extension/test/integration/runTest.mjs
--- a/extension/test/integration/runTest.mjs
+++ b/extension/test/integration/runTest.mjs
@@ -21,6 +21,7 @@ const graph = (id, name, node) => ({
   nodeSeq: 1,
   updatedAt: at,
 });
+// Written in the format from before Markdown graph files: the engine converts them to <id>.md when it starts.
 const write = (file, value) => writeFileSync(join(dataDir, 'graphs', file), JSON.stringify(value, null, 2));
 write('demo.json', {
   ...graph('demo', 'Demo', { id: 'n1', title: 'Say hello', kind: 'command', command: 'echo {{ greeting }}', description: 'Says hello with the greeting value.' }),
```

Apply to `extension/test/integration/suite.cjs` (graph tabs open `<id>.md`; a plain open shows text (R1); Open as Markdown; an edit saved outside reaches the graph through the watcher alone, because the check waits for a `graph` message without calling the store; a broken file shows in the Problems panel and clears when fixed):

```diff
diff --git a/extension/test/integration/suite.cjs b/extension/test/integration/suite.cjs
--- a/extension/test/integration/suite.cjs
+++ b/extension/test/integration/suite.cjs
@@ -48,17 +48,26 @@ exports.run = async function run() {
   const folder = { key: wf.uri.toString(), name: wf.name, path: wf.uri.fsPath };
   const app = api.engines.get(folder);
   assert.deepEqual(app.listGraphs().map((g) => g.id).sort(), ['demo', 'second']);
+  // The JSON graphs were converted to Markdown on start, keeping the old files as .json.bak (Markdown graph files spec §5.2).
+  const mdUri = (id) => vscode.Uri.joinPath(wf.uri, '.agent-stream', 'graphs', `${id}.md`);
+  const graphsDir = path.join(wf.uri.fsPath, '.agent-stream', 'graphs');
+  for (const f of ['demo.md', 'demo.meta.json', 'demo.json.bak', 'second.md', 'second.baseline.json']) assert.ok(fs.existsSync(path.join(graphsDir, f)), `${f} exists`);
+  assert.ok(!fs.existsSync(path.join(graphsDir, 'demo.json')), 'demo.json was renamed');
 
   // The graph tab's page runs under the CSP, connects, and loads its graph.
-  await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.joinPath(wf.uri, '.agent-stream', 'graphs', 'demo.json'), 'agentStream.graph');
+  await vscode.commands.executeCommand('vscode.openWith', mdUri('demo'), 'agentStream.graph');
   const panel = await waitFor(() => api.panels.get(folder.key, 'demo'), 'the graph tab');
   await waitFor(() => panel.isLoaded, 'the tab to load its graph');
 
-  // A plain open (Explorer click, Quick Open) uses the graph tab too: the custom editor is the default.
+  // A plain open (Explorer click, Quick Open) shows the graph's Markdown as text: the graph tab opens only when asked.
   await vscode.commands.executeCommand('workbench.action.closeAllEditors');
   await waitFor(() => !api.panels.get(folder.key, 'demo'), 'the graph tab to close');
-  await vscode.commands.executeCommand('vscode.open', vscode.Uri.joinPath(wf.uri, '.agent-stream', 'graphs', 'demo.json'));
-  const reopened = await waitFor(() => api.panels.get(folder.key, 'demo'), 'a plain open to show the graph tab');
+  await vscode.commands.executeCommand('vscode.open', mdUri('demo'));
+  await waitFor(() => vscode.window.activeTextEditor?.document.uri.fsPath === mdUri('demo').fsPath, 'a plain open to show the Markdown');
+  assert.equal(api.panels.get(folder.key, 'demo'), undefined);
+  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
+  await vscode.commands.executeCommand('vscode.openWith', mdUri('demo'), 'agentStream.graph');
+  const reopened = await waitFor(() => api.panels.get(folder.key, 'demo'), 'the graph tab again');
   await waitFor(() => reopened.isLoaded, 'the reopened tab to load its graph');
 
   // Where the graph works (spec §7): the tab's engine sends the checkout after hello and on request. The sample
@@ -118,8 +127,7 @@ exports.run = async function run() {
   await waitFor(() => api.engines.status.provider === 'claude' && api.engines.status.label !== 'checking', 'the Claude status after Codex');
 
   // Work sessions: the tab set comes back per session, and conversations stay apart.
-  const uriOf = (id) => vscode.Uri.joinPath(wf.uri, '.agent-stream', 'graphs', `${id}.json`);
-  await vscode.commands.executeCommand('vscode.openWith', uriOf('second'), 'agentStream.graph', { viewColumn: vscode.ViewColumn.Two, preview: false });
+  await vscode.commands.executeCommand('vscode.openWith', mdUri('second'), 'agentStream.graph', { viewColumn: vscode.ViewColumn.Two, preview: false });
   await waitFor(() => api.panels.get(folder.key, 'second')?.isLoaded, 'the second graph tab');
   api.sessions.captureNow();
   const sessionB = app.createSession('Integration B');
@@ -154,6 +162,25 @@ exports.run = async function run() {
   assert.deepEqual(app.graphStore.agentChanges('second').map((c) => [c.kind, c.change, c.id]), [['node', 'changed', 'n1']]);
   assert.equal(app.listGraphs().find((g) => g.id === 'second').agentChanges, 1);
 
+  // Markdown graph files (spec §6, §7): Open as Markdown shows the file; the file watcher brings a saved edit into the
+  // graph (no store call here, so only the watcher can deliver it); a broken file shows in the Problems panel.
+  await vscode.commands.executeCommand('agentStream.openGraphMarkdown', { folder, graphId: 'demo' });
+  await waitFor(() => vscode.window.activeTextEditor?.document.uri.fsPath === mdUri('demo').fsPath, 'Open as Markdown');
+  const seen = [];
+  const detachSeen = app.connect({ send: (m) => seen.push(m) });
+  const demoFile = mdUri('demo').fsPath;
+  const original = fs.readFileSync(demoFile, 'utf8');
+  fs.writeFileSync(demoFile, original.replace('# Demo\n', '# Demo\n\n## Goal\n\nEdited outside Agent Stream.\n'));
+  await waitFor(() => seen.some((m) => m.type === 'graph' && m.graph.id === 'demo' && m.graph.goal === 'Edited outside Agent Stream.'), 'the outside edit to reach the graph');
+  assert.equal(app.graphStore.readOps('demo').at(-1).via, 'file');
+  fs.writeFileSync(demoFile, '# Demo\n\nstray text\n');
+  await waitFor(() => vscode.languages.getDiagnostics(mdUri('demo')).length > 0, 'the file problem in the Problems panel');
+  assert.equal(app.graphStore.get('demo').goal, 'Edited outside Agent Stream.');
+  fs.writeFileSync(demoFile, original);
+  await waitFor(() => vscode.languages.getDiagnostics(mdUri('demo')).length === 0, 'the problem to clear');
+  await waitFor(() => seen.some((m) => m.type === 'graph' && m.graph.id === 'demo' && m.graph.goal === ''), 'the restored file to reach the graph');
+  detachSeen();
+
   if (!api.engines.status.ok) {
     console.warn(`Skipping the run check: ${api.engines.status.error}`);
     return;
```

- [ ] **Step 4: Run everything**

Run:

```bash
npm run typecheck
npm test
npm run build
npm run test:integration -w extension
```

Expected:
- typecheck: no errors;
- `npm test`: every workspace passes (the engine's `live` and Windows-only tests are skipped as before);
- the build succeeds;
- the integration suite passes. It downloads VS Code once; if this machine can't (no network), say so in the report and leave this step to CI rather than skipping it silently.

- [ ] **Step 5: Check what's left, and commit**

```bash
git status --short
rg -n "agent-stream\.json" engine/src extension/src web/src
```

Expected:
- `git status --short` shows only the files of this task and the untracked files you must not stage (`logs/`, `.DS_Store`, `.agent-stream/`, `.superpowers/`).
- The search finds one line: the doc comment of `GraphStore.importGraph`, which still reads older `.agent-stream.json` exports. Nothing writes that format any more.

```bash
git add docs/graph-format.md engine/test/graphFormatDoc.test.ts README.md extension/README.md extension/test/integration/runTest.mjs extension/test/integration/suite.cjs
git commit -m "$(cat <<'MSG'
docs: Markdown graph files; integration check for conversion and edits

docs/graph-format.md describes the format with a full example (kept
readable by a test). The READMEs gain a Graph files section and the new
files. The integration suite sees JSON graphs converted, opens a graph
as Markdown, and checks that an outside edit and a broken file reach the
graph and the Problems panel.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
MSG
)"
```

Don't push, and don't run `npm run package`.

---

## Self-review (done while writing this plan)

**1. Spec coverage.**

| Spec | Task |
|---|---|
| §1 decisions: Markdown with Mermaid replaces the JSON; side file; `# Title`; `##` Goal and Variables | 3, 4, 6 |
| §2.1 structure: H1, reserved sections, step headings, separator, id rule, id-less headings | 3 (R11, R12) |
| §2.2 step section: fields, defaults, description, one block, info strings, exact content, kind match, empty block, nothing dropped | 3 |
| §2.3 Flow: syntax, chains, labels, comments, errors, steps without arrows | 2, 3 |
| §3.1 `parseGraphMarkdown`, `GraphDoc`, CRLF/BOM, all errors with lines | 3 |
| §3.2 side file: zod, defaults, bad entries | 4 |
| §3.3 building the Graph: id-less steps, duplicate ids, graph id from the file name | 3, 4, 6 |
| §4.1 `serializeGraphMarkdown`: order, empty sections, Flow, steps, fences, LF | 4 (R2, R5) |
| §4.2 stability: round trip, stable text, edits change only their lines | 4 |
| §4.3 atomic writes, side file first | 6 |
| §5.1 files, list `*.md`, broken file listed | 6 |
| §5.2 migration | 6 (R15) |
| §5.3 run records unchanged | nothing to do: run snapshots stay JSON |
| §5.4 export and import | 6 (R14) |
| §6.1 Agent Stream's own edits | 6, 7 |
| §6.2 watching, debounce, ignoring own saves | 7, 10 (R8) |
| §6.3 parse, errors (Problems panel, notice), `diffToOps` order, all or nothing, `via: 'file'`, baseline rules, normalise, refresh | 5, 7, 8, 10, 11 (R6, R7) |
| §6.4 side file changes | 7 |
| §6.5 deleted file | 7, 8, 10, 11 (R9) |
| §6.6 renamed or copied file | 7 ("adds a graph whose file appears"; its side file is used when copied along) |
| §7 Open as Markdown (menu bar, sidebar, palette, beside) | 9, 11 |
| §8 planner unchanged; other AIs; docs; fixable errors | 12 (docs), 3 (messages) |
| §9 tests | named under "Spec tests owned" in every task |
| §10 out of scope | nothing implemented: no YAML, no visual Mermaid editing, no run history in the file, no variable-rename detection |

**2. Placeholder scan.** Every code step contains its code (new files in full, changes as diffs), and every test step its test code.

**3. Type consistency.** Names used in more than one task are spelled the same everywhere: `Fence`, `fenceFor`, `fenceOpening`, `fenceCloses`, `longestRun` (1, 3, 4); `GraphFileError`, `OpRecord.via` (1, 3, 6–11); `FlowLine`, `FlowEdge`, `parseFlow`, `parseChain`, `ONLY_ARROWS` (2, 3); `GraphDoc`, `DocStep`, `DocVariable`, `ParseGraphResult`, `MAX_TIMEOUT_SEC`, `STEP_SEPARATOR`, `normText`, `oneLine`, `timeoutValue`, `formatFileErrors` (3–7, 11); `escapeFreeText`, `unescapeFreeTextLine` (3, 4); `canonicalGraph`, `GraphMeta`, `parseGraphMeta`, `metaOf`, `serializeGraphMeta`, `withMeta`, `graphFromDoc`, `serializeGraphMarkdown`, `mermaidLabel` (4, 6, 7, 12); `diffToOps`, `opLine` (5, 7); `FileSync`, `graphFileChanged`, `graphFileDeleted`, `fileErrors`, `writeConverted`, `migrateGraphsToMarkdown`, `startupNotes` (6–10); `openGraphMarkdown`, `openText`, `graphUri` (9–11); `GraphFileWatcher`, `publishGraphFileErrors`, `GRAPH_FILES_GLOB` (10); `fileErrors`, `graphGone` in the web state (1, 11).

**4. Review Focus.** Each of the five has a test in its owning task: 1, 2 and 4 in Task 7 (`graphFileSync.test.ts`, plus Task 10's debounce test for 2), 3 in Tasks 3 and 4, and 5 in Task 6 (`graphFiles.test.ts`).

**5. Dry run.** This plan's own text was replayed task by task on a fresh copy of the repo at f993b78, outside this checkout: every new file written and every diff applied with `git apply`, exactly as given. After every task, `npm run typecheck` and the tests of all four workspaces passed; after Task 12 the counts were shared 186, engine 883, web 249, extension 216, and `npm run build` passed. The integration suite (it downloads VS Code) and a Windows run were not part of the dry run.
