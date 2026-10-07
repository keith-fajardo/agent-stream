# Agent Stream — sub-graph steps (design)

Date: 2026-10-07. Status: approved in conversation, awaiting review of this written spec.

## 1. Purpose and decisions

The user builds graphs they want to reuse, such as "Company research" or "Tailor a CV". Today the only way to reuse one is to rebuild its steps in every graph that needs it. The user wants to drop a whole graph into another graph as a single step. That step behaves like any other step: it runs, and the steps after it can use its result. Double-clicking it takes the user inside.

**Success:** "Company research" is used as step `n4` in "Job hunting". A run of "Job hunting" runs Company research's steps with the values set on `n4`, and the steps after `n4` receive Company research's final result. Double-clicking `n4` shows Company research's steps with that run's statuses and logs. Editing Company research once changes every graph that uses it.

Decisions made in conversation:

- **Main purpose: reuse across graphs.** A sub-graph step *references* the inner graph by id. It is not a copy, so an edit to the inner graph applies everywhere it is used.
- **Output:** the outputs of the inner graph's final steps (the ones nothing else in it depends on), each under its own heading.
- **Inputs:**
  - Results of the steps feeding the sub-graph step go to the inner graph's first steps (the ones nothing feeds), as "Results from earlier steps".
  - Inner variables get values **set on the step**. A value is a template and may use the outer graph's variables. A value left empty is asked for when the run starts.
- **Going inside:** double-click swaps the canvas to the inner graph **in the same tab**, with a breadcrumb back. It shows the inner steps' statuses and logs for the run being viewed, and editing is allowed. A banner names the other graphs that use it.
- **Approach A: expand at run start.** The run's frozen snapshot replaces each sub-graph step's contents with the inner graph's steps under nested ids (`n4/n1`). One scheduler runs everything, so Stop, approvals, Allow all for this step, the browser, reuse, retry and stale marks keep working per step. Rejected:
  - **B, child runs:** two schedulers would have to share the one-writer-per-workspace lease, which risks deadlock. Stop, approvals and the report would have to cross runs, and retry couldn't resume halfway through an inner graph.
  - **C, paste a copy:** it defeats edit-once reuse.
- **Limits:**
  - Same project folder only.
  - At most 3 levels of nesting below the graph being run.
  - No loops.
  - A missing or broken inner graph blocks the run.

## 2. The step

### 2.1 Data

- `NodeKind` gains `'graph'`.
- `GraphNode` gains two fields:
  - `graph?: string`: the inner graph's id, which is its file name in `.agent-stream/graphs/`. It is required when `kind` is `graph` and absent otherwise.
  - `values?: Record<string, string>`: inner variable name → value template. Absent or `{}` means none set.
- A `graph` step has only `id`, `title`, `description`, `graph`, `values`, `position` and the usual `createdBy` / `updatedBy` / `updatedAt`.
  - The parser drops `prompt`, `command`, `timeoutSec`, `access`, `workspace`, `model`, `effort`, `attachments` and `browser` from it, with a warning, the same way it drops agent-only fields from command steps today.
  - `applyOp` refuses them on a `graph` step.
- **Kind switches:**
  - Switching a step to or from `graph` follows the existing rule for agent ↔ command switches: fields that don't apply to the new kind are dropped.
  - Switching to `graph` needs a graph id, so the panel only offers the switch together with the picker.
- **Values:**
  - A value may be empty. Empty means "ask at run start", the same as no value.
  - Values are capped at `MAX_VARIABLE_VALUE_CHARS` (10,000).
  - Names must pass `VARIABLE_NAME_RE`.
- **Ops:**
  - `NewNodeInput` and `NodePatch` gain `graph` and `values`. A patch's `values` replaces the whole map, like `attachments`.
  - `ChangedField`, `changes.ts` FIELDS, `graphDoc` canonical node, `diffToOps.patchOf`, `undo.graphAsDoc` and `contentSignature` all include both fields, so agent-change review, undo and reuse see them.
- **Old graphs** load unchanged. A graph file with a `graph` step needs this version or later. Older versions report `kind: graph` as a parse problem, which is acceptable.

### 2.2 Markdown

````markdown
## n4 · Research the target company

- kind: graph
- graph: company-research

> Researches the company we're applying to.

```value company
{{ target_company }}
```

```value depth
quick
```
````

- **Values:** one fenced `value <name>` block per value, in name order, so a value may span lines. The writer writes no block for a value that is absent.
- **Problems** are reported in the same form as other bad step lines:
  - a `graph` step without `- graph:`;
  - a bad graph id (`GRAPH_ID_RE` in `engine/src/paths.ts`, moved to shared);
  - a `value` block with a bad name, or a repeated name;
  - a `prompt` / `sh` block on a `graph` step.
- **Flow diagram:** a `graph` step appears as an ordinary node.
- `docs/graph-format.md` documents the `kind: graph` line, the `graph:` line and the `value` blocks.

### 2.3 Re-runs

- `graph` and `values` are part of the step's definition.
- Changes inside the inner graph show up as changed inner steps after expansion (§3), so reuse needs no extra rule for them.

## 3. Expansion

A pure function in `shared/src/subgraphs.ts`:

```ts
type GraphLookup = (id: string) => { ok: true; graph: Graph } | { ok: false; reason: 'missing' | 'broken'; error: string };

expandGraph(outer: Graph, lookup: GraphLookup): ExpandResult
// ExpandResult = { ok: true; graph: Graph; scopes: Record<string, Scope> } | { ok: false; problems: SubgraphProblem[] }
// Scope = { stepId: string; graphId: string; graphName: string; depth: number; values: Record<string, string> }
// SubgraphProblem = { stepId: string; message: string }   // stepId is the expanded id of the offending sub-graph step
```

The engine and the web both call it, so the run dialog, the stale check, Run only availability and approval reveal agree with the engine.

### 3.1 Rules

For each `graph` step `S` (id `s`) in a graph being expanded:

1. **Look up the inner graph.**
   - `missing` → problem `Step s uses graph "<id>", which isn't in this folder.`
   - `broken` → problem `Step s uses graph "<name>", whose file has errors: <first error>.`
   - **Broken means broken:** the engine's lookup must report a graph whose file currently fails to parse as `broken`. `graphStore.load` returns the last good version in that case, so the lookup checks `brokenFile(id)` first. A run must never use a stale inner graph silently.
   - The lookup must not trigger `graphFileDeleted` side effects. Use a probe that doesn't emit.
2. **Loop check.** If the inner graph's id is the outer graph's id or any graph id on the current expansion path → problem `Step s would put "<name>" inside itself (<path of graph names>).`
3. **Depth check.** Depth 1 is a sub-graph step in the graph being run. More than 3 → problem `Step s nests sub-graphs more than 3 levels deep.`
4. **Empty check.** If the inner graph has no steps → problem `Step s uses graph "<name>", which has no steps.`
5. **Expand the inner graph recursively first.** Nested sub-graph steps inside it are expanded the same way.
6. **Copy the inner steps** with ids `s/<innerId>`, prefixing nested ones further: `s/n2/n1`. Inner edges are copied with prefixed ends.
   - **Workspaces:** an inner step's `workspace: a` becomes the scoped name `s~a`, with `/` in `s` written as `~`. `~` is not allowed in workspace names, so a scoped name can never collide with an outer one or with another use of the same graph.
7. **Rewire:**
   - Every outer edge `X → s` becomes `X → s/<src>` for each inner **first step** `src`: an inner step with no incoming inner edge.
   - Every inner **last step** `snk`, an inner step with no outgoing inner edge, gets an edge `s/<snk> → s`.
   - The edge `X → s` itself is removed.
   - `s`'s outgoing edges are kept.
   - Edge ids are regenerated deterministically from their ends.
8. **Keep `S` in the expanded graph** unchanged (kind `graph`). It is the sub-graph's collector step (§4.1).
9. **Record the scope** `scopes[s] = { stepId: s, graphId, graphName, depth, values: S.values ?? {} }`.

**Other rules:**
- Ids in the expanded graph that contain `/` are never written to Markdown, never validated by `NODE_ID_RE`, and never added to `nodeSeq`.
- The expanded graph keeps the outer graph's `id`, `name`, `goal`, `instructions`, `variables` and `attachments`.
- Problems are collected for every sub-graph step, not just the first.
- The expanded graph is capped at 500 steps → problem `This graph expands to more than 500 steps.`

### 3.2 Which graph a step belongs to

`scopeOf(expandedId)` gives the longest scope whose `stepId` is a `/`-prefix of the id. A step with no scope belongs to the outer graph. Everything that used to read "the run's graph" for a step reads its scope's graph instead:

- goal and instructions;
- graph-level attachments and the attachment folder `.agent-stream/attachments/<graphId>/`;
- the variable context used to render its prompt and command.

### 3.3 Variables

Rendering happens in `previewRun` (engine) on the expanded graph, from the outermost scope inward:

- **Outer graph:** rendered as today, with the run form's values.
- **A scope `s` with inner graph `G`.** For each variable `v` of `G`:
  - If `values[v]` is set and non-empty, render it as a template in the **parent scope's** context. That context is the outer graph's variables, or for a nested scope its parent sub-graph's variables. The result is `v`'s value in `s`.
  - Otherwise the run form asks for it. Its row key is `s/v` and its label is `s · v`, with the inner graph's description for `v`.
  - Values typed in the run form are remembered under the **outer** graph id with the key `s/v`, alongside the outer variables (`variableValues`).
  - A template error in a value (for example an unknown outer variable) is reported in the run dialog the same way an unknown variable in a prompt is today, naming `s` and `v`.
- **Unused values:** a value whose name `G` doesn't have is ignored at run time and shown as unused in the step panel (§6.2).
- **`RenderedRun`** gains `scopes?: Record<string, { goal: string; instructions: string }>`. `nodes` is keyed by expanded id. The collector step gets an empty rendered entry.

## 4. Running

### 4.1 The collector step

The sub-graph step `s` stays in the run as a normal step with kind `graph`. Its parents in the expanded graph are its inner last steps, so the scheduler starts it once they all succeed. Its executor:

- **Calls no model and runs no command.** It finishes in well under a second.
- **Writes `output.md`:** for each inner last step `snk`, in topological order:

  ```
  ### <snk innerId> · <title>
  <its output, trimmed; "(no output)" when empty>
  Full output: <outputRelPath of s/snk>
  ```

- **Emits** a `start` event (`Started sub-graph step`) and a `result`.
- **Is never write-capable:** `isWriteCapable` returns false for kind `graph`, and it never takes the lease or calls `broker.beginStep`.

Downstream steps receive it through `buildNodePrompt` with the heading `## s · <title>: <description> (sub-graph "<inner name>", succeeded)`. The upstream excerpt limit for agent outputs (`MAX_UPSTREAM_CHARS`, head kept) still applies.

### 4.2 Status shown for a sub-graph step

The stored `NodeRunState` of `s` follows the normal rules: queued, then not_run when an inner step fails, and so on. The canvas, the logs panel and the Run Report show a **derived** status computed from `s` and every `s/*` step. The first match wins:

1. Any inner step `waiting_approval` → **needs approval**.
2. Any `running` → **running**.
3. Any `failed` → **failed**.
4. Any `interrupted` → **interrupted**.
5. Any `cancelled` → **stopped**.
6. `s` itself succeeded → **succeeded**. If any `s/*` step is stale, it is **succeeded, stale**, the same as an ordinary step's stale mark.
7. Every inner step `reused` and `s` `reused` → **reused**.
8. Otherwise → `s`'s own status.

A shared function `derivedStatus(run, stepId)` implements this, and the web and the Run Report both use it.

### 4.3 What inner steps get

- **Prompt:** `buildNodePrompt` receives the scope's rendered goal and instructions. Inner steps don't see the outer graph's goal or instructions.
- **Upstream results:** the inner first steps' parents in the expanded graph are the outer steps that fed `s`, so they receive those results with no special case.
- **Attachments:**
  - from the scope graph's own attachment folder and lists (`stepAttachments` and `runAttachments` take the scope's graph);
  - `missingAttachmentLine` names the scope's graph.
- **Model and effort:** the inner step's own setting, else the run's (`runStepModels` runs on the expanded graph).
- **Workspaces:**
  - Scoped names (§3.1.6) are created like any other workspace name. `names` in `startRun` is derived from the expanded graph.
  - The step prompt names the inner graph's original workspace name; the folder path uses the scoped one.
- **Browser, approvals, Allow all for this step, Stop:** unchanged and keyed by expanded id.
  - An approval request's `nodeId` is the expanded id.
  - Cards, notifications and the sidebar show `n4/n2 · Read news (in Company research)`.
- **Lease:** `needsCheckoutLease`, `writerRunning` and `parallelWriteSteps` run on the expanded graph's real steps. A sub-graph whose inner steps are all read-only needs no lease.

### 4.4 Run files

- **Folders:** a step's folder is `nodes/<folder id>/`, where the folder id is the expanded id with `/` written as `~` (`nodes/n4~n2/`).
  - `RunStore` accepts expanded ids: segments match `NODE_ID_RE`, separated by `/`, at most 4 segments.
  - It maps them to folder ids in one place.
- **Privacy checks:** `isUpstreamOutput` (`engine/src/agentLoop/tools.ts`) and `isUpstreamOutputPath` (`engine/src/providers/codex/readOnlyCommand.ts`) keep assuming one folder level, which stays true. Tests cover an inner step reading `nodes/n4~n1/output.md`.
- **`run.json`** stores the expanded snapshot, `scopes` (§3), and `rendered.scopes`. Old `run.json` files have neither and load unchanged.

### 4.5 Reuse and retry

These run on expanded graphs: the source run's snapshot was expanded when it ran, and the new run expands the live graphs now.

- **Reuse by step:**
  - `changedSinceSource` and `reusableNodeIds` compare step by step by expanded id. An edit inside the inner graph re-runs only the changed inner steps and what depends on them, including `s` and the steps after it.
  - A source run from before this feature has no `s/*` steps, so they count as changed.
  - Each step's attachments are compared against its scope graph's attachment lists, not the outer graph's.
- **Retry from where it stopped:** works unchanged.
- **Re-run from `s` / Run only `s`** (`s` is a sub-graph step) are rewritten to cover the whole sub-graph:
  - *from `s`*: the seeds are `s`'s inner first steps.
  - *only `s`*: run `s` and every `s/*` step. The ancestor rule applies to the steps that fed `s`. Steps after `s` are kept and marked stale, as today.
- **Re-run from / Run only an inner step** (sent from inside, §6.1) use the expanded id directly.
- `startRun`'s `fromNodeId` accepts expanded ids. `onlyRunPlan` and the preview signature work on the expanded graph.

### 4.6 Graph changes during a run

Agent steps can change the graph during a run (`stepGraphTools`). Inside sub-graphs that is refused:

- **Inner steps get no graph-change tools.** If a tool is reached anyway, it answers `Steps inside a sub-graph can't change graphs.`
- **Outer steps' changes are refused when they:**
  - connect into or out of a `graph` step;
  - add a step before or after one;
  - add or change a `graph` step.

  The answer is `Changes that touch sub-graph step s can't be made during a run; change the graph after it finishes.`
- **`known()`** treats expanded ids as not existing, so agents can't wire to inner steps.

### 4.7 Deleting a graph that's in use

- **During a run:** `deleteGraph` refuses while any active run's `scopes` include that graph id: `"<name>" is being used by a run of "<outer name>". Stop it first.`
- **When other graphs use it:** the delete confirmation names them: `Used as a sub-graph in: Job hunting, Weekly report. Those steps will show "missing graph" until you change them.`
- `GraphListItem` gains `usedBy?: string[]` (ids of graphs with a `graph` step pointing at it), computed in `graphStore.list()`.
- **Renaming** a graph changes only its display name; the id is unchanged, so references survive with no extra work.

## 5. Run dialog and Run Report

- **Steps list:**
  - Expanded steps are listed in topological order, inner steps indented under their sub-graph step with their expanded id and their own kind (`n4/n1 · Find site`).
  - The sub-graph step itself is listed as `n4 · Research the target company (sub-graph "Company research", 3 steps)`.
  - Reused, not-run and stale lists use expanded ids.
- **Variables table:** includes the `s · v` rows (§3.3).
- **Warnings:** browser-off hints, attachment warnings, workspace refusals and parallel-write notes all run on the expanded graph's real steps.
- **Blocking problems:** any expansion problem blocks the run, and the dialog lists them. `startRun` re-expands and refuses if the signature differs, as today.
- **Run Report:**
  - Inner steps appear indented under their sub-graph step, headed `n4/n2 · Read news (Company research)`, with their own prompt and their scope's attachments.
  - The sub-graph step shows its derived status and its collected output.
  - The report's goal and instructions are the outer graph's. Each sub-graph section starts with the inner graph's rendered goal.

## 6. In the editor

### 6.1 Going inside

- **Double-click** on a `graph` step's card goes inside. Double-click on empty canvas still adds a step.
- **Inside:**
  - The canvas shows the inner graph's live steps.
  - A **breadcrumb** heads it: `Job hunting › n4 Research the target company (Company research)`. Each part can be clicked to climb to that level, and **↑ Back** climbs one.
  - Double-clicking a nested `graph` step goes one level deeper.
- **State:** the web state gains `scope: string[]`, the sub-graph step ids from the tab's graph down. The canvas, node panel and logs panel read the graph at that scope and map an inner step id `x` to the expanded id `scope.join('/') + '/' + x` for run state, logs (`getNodeLogs`) and retries.
- **Editing inside** works like editing anywhere:
  - Ops are sent with the inner graph's id.
  - Undo and redo are already kept per (tab, graph id), so ⌘Z inside undoes the inner graph's edits.
  - Agent-change review (baseline, Accept / Revert) shows the inner graph's own changes.
- **Banner inside:** `Used in 3 graphs: changes apply to all of them.`, naming them from `usedBy`.
- **The planner chat** stays the outer graph's.
- **If the inner graph becomes missing or broken while you're inside,** the canvas shows the problem with ↑ Back.
- **Revealing an approval:** an approval for `n4/n2` (from a notification, the sidebar or the Approve command) goes inside `n4` and selects `n2`.

### 6.2 The step panel and card

- **Panel for a `graph` step:**
  - the inner graph's name, with a picker to change it;
  - its goal;
  - a value box per inner variable, labelled with the variable's description, with the placeholder `Asked when the run starts`;
  - values the inner graph no longer has, listed as **Unused**, each with a remove button;
  - **Go inside**;
  - `Used in: …`, listing the other graphs that use the inner graph.
- **Kind select:** gains **Sub-graph**.
- **Picker:**
  - It lists the folder's graphs with name and step count.
  - It leaves out the current graph and every graph that would create a loop (`wouldCreateGraphLoop(outerId, candidateId, lookup)` in `shared/src/subgraphs.ts`).
  - Graphs with file errors are listed but disabled, with the error as a tooltip.
- **Canvas toolbar:** **+ Sub-graph** opens the picker and adds a `graph` step titled with the chosen graph's name.
- **Card:**
  - a sub-graph icon `⧉` (`kind-graph` class), the inner graph's name, `3 steps`, the derived status, and the **Needs approval** mark when an inner step is waiting;
  - an expansion problem shows on the card in the error style, with the message as its tooltip.

### 6.3 How the web gets inner graphs

- **New message:** the engine sends `{ type: 'subgraphs'; graphId; graphs: Record<string, Graph | { error: string }> }` for a tab's graph. It holds every graph reachable through `graph` steps, transitively.
  - It is sent on `openGraph`.
  - It is sent again whenever one of those graphs changes, or a `graph` step's `graph` field changes.
  - The web stores it in `state.subgraphs` and passes a lookup over it to `expandGraph`.
- **Stale check and Run only:** the "Graph changed since this run started" check compares `contentSignature(run.snapshot)` with the signature of the **expanded** live graph. `onlyAvailability` (web/src/retry.ts) runs `onlyRunPlan` on the expanded live graph.

## 7. Planner

- **New tool `list_graphs`:** returns, for each graph in the folder except the current one, its `id`, `name`, `goal`, variables (name and description), step count, and whether using it here would create a loop. It is registered in `graphToolNames` and needs no approval, since it only reads.
- **`add_node` / `update_node`** accept `kind: 'graph'` with `graph` and `values`.
- **`get_graph`** shows a sub-graph step's `graph`, `values` and the inner graph's name.
- **`get_run`** lists expanded steps, with inner ones indented.
- **Rules added to `PLANNER_APPEND`:**
  - Before building steps that an existing graph already does, call `list_graphs` and use a sub-graph step.
  - Set its values from this graph's variables where they fit.
  - The planner can't edit inner graphs from this chat. When one needs changing, tell the user to go inside it or open it.

## 8. Extension

- **Delete confirmation:** names the graphs that use this one (§4.7). The engine refuses deletion while a run uses it.
- **Export:** notes `Sub-graphs aren't included: <names>. Export them too.` when the graph has `graph` steps.
- **Import:** a graph that refers to graph ids this folder doesn't have imports fine. Its steps show "missing graph".
- **Duplicate:** copies references unchanged.

## 9. Testing

- **Shared:**
  - `expandGraph`: id prefixing; rewiring with several first and last steps; an outer step feeding several inner first steps; two uses of the same inner graph in one graph; nesting to depth 3, and a problem at 4; direct and indirect loops; missing, broken and empty inner graphs; the 500-step cap; scoped workspace names; deterministic edge ids.
  - `scopeOf`, `derivedStatus` (each rule in order), `wouldCreateGraphLoop`.
  - Markdown round-trip of a `graph` step with multi-line values. Parse problems for each bad case in §2.2.
  - `applyOp` refusals; undo / diffToOps / changes for `graph` and `values`; `contentSignature` includes them.
  - Reuse on expanded graphs: editing one inner step re-runs it, its inner descendants, `s` and the steps after `s`. Attachment changes compare against the scope graph.
  - from / only on a sub-graph step (§4.5).
- **Engine:**
  - A full run: the collector output and the downstream prompt heading; inner steps get the inner goal, instructions and attachments.
  - Values rendered from outer variables; empty values asked as `s/v` and remembered.
  - Run outcomes: an inner failure gives `s` the derived status failed and not-run downstream; Stop mid-sub-graph.
  - Approvals and permissions: an inner approval and Allow all for this step on an inner step; the lease not taken for an all-read-only sub-graph.
  - Retry from where it stopped inside a sub-graph.
  - Privacy checks pass for `nodes/n4~n1/output.md` from an inner step (agent loop and Codex).
  - Refusals:
    - graph-change tools refused inside and around sub-graph steps;
    - expansion problems block preview and `startRun`;
    - a broken inner file is refused (not its last good version);
    - delete refused during a run.
  - `list_graphs`; `usedBy`.
- **Web:**
  - Navigation: double-click goes in; the breadcrumb and ↑ Back; going deeper.
  - Editing inside: an edit inside sends an op with the inner graph id; ⌘Z inside.
  - Run state: inner statuses come from expanded ids; the card shows the derived status and the approval mark; revealing an `n4/n2` approval goes inside.
  - Panel: values and the Unused list; the picker leaves out loops and disables broken graphs.
  - Run dialog: the indented list, `s · v` rows, and expansion problems blocking Start.
  - Retry checks: the stale check uses the expanded graph; Run only is available after a sub-graph step.
- **Docs:** `README.md` and `extension/README.md` (identical) get a short **Sub-graphs** section; `docs/graph-format.md` gets the format.

## 10. Not included in this version

- Choosing which inner step is the output (it is always the final steps).
- Overriding an inner step's settings (model, browser, access) per use.
- Pinning a sub-graph to a version of the inner graph.
- Sub-graphs from another folder or project.
- Agent steps changing graphs inside sub-graphs during a run (§4.6).
- The planner editing inner graphs from the outer graph's chat.
- Bundling sub-graphs into an export.
