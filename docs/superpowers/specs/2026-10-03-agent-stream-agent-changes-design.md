# Agent Stream — agent changes to the graph, and telling them apart from the original

**Date:** 2026-10-03
**Status:** Approved in conversation (sections 1–4); written for review
**Builds on:**
- the providers spec (neutral graph tools, `ToolGate`);
- the sessions spec (planner attribution per session);
- the step descriptions spec.

This work joins the same implementation plan, after the descriptions tasks and before its integration and docs tasks.

## 1. Purpose

Agents should be able to change the graph when work calls for it. A step that hits a problem mid-run can add a workaround step or fix a later step, and the planner already edits graphs. The user must be able to see exactly what the agents did, and tell agent changes apart from their own original graph.

Success:
- **During a run.** A step agent can propose "add step *Install deps* before n3" or "change n4's command". It asks the user first, showing the exact text that would run. When approved, the change lands in the graph and the running run uses it.
- **On the canvas.** Every agent change (added, changed, removed step; added or removed connection) stays visibly marked until the user accepts it into the original or reverts it. Each mark names who made it: the planner, or step n2 in run 12.
- **Before/after.** The user can review every changed field.

## 2. Decisions

| Topic | Decision |
|---|---|
| Which agents may change the graph | The planner (as today) and step agents during a run |
| Step-agent changes and the running run | They apply to the current run, after the user approves each one |
| What "original" means | A per-graph **baseline**: the graph as the user accepted it. Agent changes are highlighted until accepted or reverted |
| Tracking | Approach A: a baseline copy. User edits go to graph and baseline; agent edits go to the graph only; the difference is what to review |

## 3. Data and attribution

### 3.1 The baseline

- **The file.** `graphs/<id>.baseline.json` has the same schema as the graph file. It is written atomically and committed with the graph. Absent means "no pending agent changes": the graph is its own baseline.
- **`GraphStore.apply(graphId, op, by, source?)`:**
  - **User edits** (`by: 'user'`): when a baseline exists, the same op is also applied to the baseline. If it can't apply there (for example, the user renames a step the agent added, which the baseline doesn't have), the baseline is left as it is, so the step stays marked as agent-added.
  - **Agent edits** (`by: 'agent'`): if no baseline exists, it is first created as a copy of the current graph, then the op is applied to the graph only.
- **Deleting a graph** deletes its baseline. **Duplicate** copies the current graph with no baseline. **Import** never creates one.
- **Export** writes the current graph and never the baseline.

### 3.2 Who made a change

- `OpRecord` gains `source?: ChangeSource`:
  ```ts
  export type ChangeSource = { kind: 'planner'; sessionId?: string } | { kind: 'step'; runId: string; nodeId: string };
  ```
- Planner ops are recorded with `{ kind: 'planner', sessionId }`. Step-agent ops are recorded with `{ kind: 'step', runId, nodeId }`.
- `Actor` stays `'user' | 'agent'`. `source` says which agent.

### 3.3 The difference

- `diffGraphs(baseline, graph): AgentChange[]` lives in `shared/src/changes.ts`:
  ```ts
  export type AgentChange =
    | { kind: 'node'; change: 'added' | 'changed' | 'removed'; id: string; title: string; fields?: ChangedField[]; by?: ChangeSource; at?: string }
    | { kind: 'edge'; change: 'added' | 'removed'; id: string; from: string; to: string; by?: ChangeSource; at?: string };
  export type ChangedField = 'title' | 'description' | 'kind' | 'prompt' | 'command' | 'timeoutSec';
  ```
- Position is never a change. Moving a step is layout, not content.
- The engine fills `by`/`at` from the latest agent op in the ops log that touched that node or edge.
- `GraphListItem` gains `agentChanges?: number`.

### 3.4 Accept and Revert

New user ops:

```ts
| { type: 'acceptChange'; target: ChangeTarget }
| { type: 'revertChange'; target: ChangeTarget }
// ChangeTarget = { kind: 'node'; id: string } | { kind: 'edge'; id: string } | { kind: 'all' }
```

They are logged like other user edits.

**Accept** copies the graph's version of the target into the baseline:
- the node, or its removal, or the edge;
- `all` copies the whole graph.

When nothing differs any more, the baseline file is deleted.

**Revert** copies the baseline's version of the target back into the graph:
- it restores a changed step's fields;
- it re-adds a removed step or edge;
- it removes an added step, together with the agent-added edges attached to it, or an added edge;
- `all` restores the whole baseline.

Reverting an added step that other added steps depend on removes only that step and its edges.

## 4. Step agents changing the graph during a run

### 4.1 Tools

Agent steps receive two neutral graph tools through `NodeContext.graphTools`. Claude wraps them in an in-process tool server named `run_graph`:

- `add_step({ title, kind, prompt?, command?, description?, after: string[], before: string[] })` adds a step that runs after `after` and before `before`.
- `change_step({ id, title?, description?, prompt?, command? })` changes a step that hasn't started.

Step agents can't delete steps, change a step that is running, finished, reused or skipped, or change their own step.

### 4.2 Validation and approval

Each call first validates against the current graph and the running run:
- the IDs exist;
- the `before` targets and changed steps haven't started;
- no cycle results;
- the step kind matches its fields.

It then fills `{{ }}` with the run's values, exactly as the run would. Any problem returns a tool error to the agent, with no approval prompt.

If the call is valid, it requests approval from the `ApprovalBroker`:
- `toolName` is `"Change graph"`;
- `ApprovalRequest` gains `graphChange?: { summary: string; detail: string }`;
- examples of the summary:
  - `n2 wants to add step "Install deps" after n2, before n3`;
  - `n2 wants to change n4's command`;
- `detail` is the exact rendered prompt or command (with values filled in) and the new description.

These tools approve themselves. The Claude adapter's PreToolUse hook passes `mcp__run_graph__*` through without a second generic prompt (a `selfApproving` set on the gate), so the user sees exactly one approval per change.

### 4.3 Applying an approved change

1. Validate again. If a target step started meanwhile, return `"<id> already started; the change was not applied."` and apply nothing.
2. Apply the op to the graph as `by: 'agent', source: { kind: 'step', runId, nodeId }`. The baseline keeps the original.
3. Amend the running run with `runner.amend(runId, …)`:
   - **Add.** The node joins the run snapshot as `queued`, with its rendered text and its edges, and starts when its `after` steps succeed.
   - **Change.** The not-yet-started node's snapshot and rendered text are replaced.
   - **Record.** `RunMeta` gains `amendments?: { at: string; byNodeId: string; nodeId: string; summary: string }[]` (`nodeId` is the step added or changed). They are shown in the run's logs header and in the run picker tooltip.
4. Return `"Applied: <summary>"` to the agent.

A **denial** returns `Denied by the user[: note]`. A cancellation because the run stopped returns `The run was stopped.`

### 4.4 The planner

Unchanged: it edits the graph with its tools and without approval, and every edit is now attributed `{ kind: 'planner', sessionId }` and highlighted. Planner edits never amend a run in progress; runs use their snapshot.

## 5. UI

- **The canvas.** Agent changes use one theme accent (`--vscode-charts-purple`, falling back to the focus border colour).
  - An added step has a dashed accent border and a badge: `＋ planner` or `＋ n2 · run <id>`.
  - A changed step has a solid accent border and a badge `✎ planner` (or `✎ n2 · run <id>`); its tooltip lists the changed fields.
  - A removed step shows as a ghost card at its baseline position. It is faded, with its title struck through and the badge `removed by planner`. Its edges are faded and dashed.
  - An added connection is a dashed accent edge; a removed connection is a faded dashed ghost edge.
  - Ghosts can't be selected for editing. Clicking one opens its change in the Changes tab.
- **The Changes tab.** The right panel tabs become **Node · Graph · Changes (N)**. The tab shows only while N > 0, but Edit › Review agent changes always opens it.
  - The list runs newest first. Each row shows an icon (＋ / ✎ / ✕), the step or connection, the changed fields, who made it and when, with **Accept** and **Revert**.
  - The footer has **Accept all · Revert all**.
  - Selecting a row selects the step and shows a field-by-field **before/after**. Text fields get a line diff: removed lines struck through, added lines highlighted.
- **The Node panel.** For a changed step it shows a banner: `Changed by <who>: <fields> · Show before/after · Accept · Revert`.
- **Approvals.** Graph-change requests use the existing approval surfaces: the step's card, the logs panel, the sidebar Approvals view and notifications. They show `graphChange.summary`, and the card expands to `detail`.
- **Graphs sidebar.** A row's description gains `· N agent changes`.
- **The Edit menu.** It gains *Review agent changes…*, *Accept all agent changes* and *Revert all agent changes*. The last two are disabled when N = 0 and ask for confirmation.
- **Protocol.**
  - `graphOpened` and `graph` gain `baseline?: Graph` and `changes: AgentChange[]`.
  - `ClientMessage` gains `{ type: 'op'; … }` with the accept and revert ops; these reuse the `op` message.

## 6. Error handling

| Situation | Behaviour |
|---|---|
| Baseline file unreadable | No highlights; one warning naming the file; **Accept all** rewrites it from the current graph |
| A step started between request and approval | Re-validated; not applied; the agent is told `"<id> already started; the change was not applied."` |
| Revert touches a step in an active run (queued or running) | Refused: `Stop the run first.` Accept is always allowed |
| The run stops while a graph-change approval is pending | The approval is cancelled; the agent is told `The run was stopped.` |
| Fill-in problem, cycle, unknown ID or started step at request time | A tool error to the agent; no approval prompt |
| Git merge conflict in a baseline file | Out of scope; git shows it like any other file |

## 7. Testing

- **Shared:** `diffGraphs`: added, changed (with the field list) and removed nodes; added and removed edges; position-only moves ignored; accept and revert ops in `applyOp`.
- **Engine:**
  - Baseline upkeep:
    - created on the first agent op;
    - user ops are mirrored, and an op that can't apply to the baseline leaves it alone;
    - agent ops go to the graph only;
    - the baseline is deleted when it matches the graph;
    - the baseline is deleted along with its graph;
    - export without a baseline.
  - Attribution from `OpRecord.source`, for both the planner and a step agent.
  - Accept and Revert per node, per edge and all; Revert refused for active-run steps.
  - Step-agent tools:
    - each validation error;
    - the approval wording and rendered `detail`;
    - an approved add runs after its `after` steps and before its `before` steps;
    - an approved change runs the new text;
    - denial;
    - "already started" on re-validation;
    - `amendments` recorded;
    - exactly one approval per change through the Claude adapter (`selfApproving`).
- **Web:**
  - canvas classes for added, changed, removed and ghost nodes and edges;
  - the Changes tab rows, before/after, Accept/Revert messages and the footer;
  - the Node panel banner;
  - the graph-change approval card;
  - the Edit menu items and their states.
- **Extension:** `· N agent changes` in the Graphs view; the graph-change notification text.
- **Integration and screenshots:**
  - a sample workspace with a pre-written `baseline.json` shows marked changes and the Changes tab;
  - a real step agent making a change is checked only in the opt-in `AGENT_STREAM_LIVE` test.

## 8. Out of scope

- Step agents deleting steps, or changing steps that already started.
- Changes to the running run by the planner.
- An undo UI beyond Revert.
- Resolving git conflicts in baseline files.
- Per-field partial accept within one step: a step's change is accepted or reverted as a whole.
