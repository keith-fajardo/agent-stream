# claude-stream — Design

**Date:** 2026-10-02
**Status:** Draft for review

## 1. Purpose

claude-stream is a local web app where you and a Claude agent co-create and co-edit a
workflow as a graph. The agent's plan is drawn as nodes and edges you can eyeball and
audit; you edit it by hand, the agent edits it through tools, and both sets of edits land
on the same graph. When the plan looks right, you run it: each node executes, shows its
status live, and keeps its own logs.

It runs on your Claude subscription (Claude Max) by driving the locally installed,
signed-in `claude` binary through the Claude Agent SDK.

**Success criteria for v1**

1. `claude-stream ~/some/repo` opens a page in the browser.
2. You can ask the agent for a plan and watch nodes appear on the canvas as it works.
3. You can add, edit, connect, and delete nodes yourself; the agent sees your edits on
   its next turn and revises around them.
4. You can run the graph. Independent nodes run in parallel. Every file edit or shell
   command an agent node attempts waits for your approval in the UI.
5. Every node shows its full log (agent messages, tool calls, approvals, results, or
   command stdout/stderr) during and after the run, and past runs can be reopened.
6. All agent calls use the Claude Max login, never an API key.

**First real use (after v1, not part of it):** dbt model parity testing — build old and
new versions of a model in parallel branches, diff the results, compare runtime and
warehouse cost, and have an agent node write the verdict. Section 14 sketches how that
graph maps onto v1's node types.

## 2. Decisions made during brainstorming

| Topic | Decision |
|---|---|
| Form factor | Standalone local web app launched by a `claude-stream` CLI. No VS Code extension in v1. |
| Node kinds | **Agent** nodes (a Claude Code run) and **command** nodes (a fixed shell command, no LLM). |
| Permissions | **Ask for everything.** Every non-read-only tool call from an agent node waits for your approval. Reads/searches don't. |
| Working directory | **One shared project folder** per graph. No worktrees. |
| Stack | TypeScript end-to-end: Node server + Claude Agent SDK (TS) + React + React Flow. |

## 3. Subscription and credentials

Anthropic's terms allow ordinary individual use of Claude Code and the Agent SDK on a
Pro/Max plan, provided the unmodified `claude` binary signs in through Anthropic's own
flow. Developers may not collect, store, or proxy Claude.ai credentials, or offer
Claude.ai login to other users. claude-stream therefore:

- **Never touches credentials.** It runs the installed `claude` binary (resolved from
  `PATH`, passed as the SDK's `pathToClaudeCodeExecutable`), which uses its own stored
  login.
- **Checks the login at startup** with `claude auth status` (JSON). Runs and chat are
  disabled unless `authMethod` is `claude.ai`; the header shows the plan and email
  (e.g. "Claude Max · contact@keithfajardo.com").
- **Strips `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN`** from the environment passed
  to every SDK session (the SDK's `env` option replaces, not merges, so the server builds
  the env explicitly). Otherwise a stray key in your shell would silently bill the API.
- **Never uses `--bare` / bare mode**, which ignores the subscription login.
- **Verifies per session.** The SDK's init message reports the auth source; if it
  indicates an API key, the node or chat turn fails with a clear error.

If anyone else ever runs claude-stream, they run it on their own machine with their own
`claude` login. claude-stream is not a hosted product.

## 4. Architecture

```
 browser (127.0.0.1)                      claude-stream server (Node)
┌──────────────────────────┬─────────┐   ┌────────────────────────────────────┐
│ Canvas (React Flow)      │ Right   │◄─►│ GraphStore — single source of      │
│  nodes, edges, status    │ panel:  │ WS│   truth; every change is an op     │
│                          │ Chat    │   │ Planner — chat agent, edits graph  │
│                          │ Node    │   │   via in-process MCP tools         │
│                          │Approvals│   │ Runner — schedules + executes      │
└──────────────────────────┴─────────┘   │ ApprovalBroker — PreToolUse → UI   │
                                         │ RunStore — logs/outputs on disk    │
                                         └──────────┬─────────────────────────┘
                                                    │ Agent SDK / child_process
                                           installed `claude` · shell · dbt
```

Repository layout (npm workspaces):

```
claude-stream/
  shared/   graph, op, run-event, and WS message types + zod schemas; pure graph logic
  server/   CLI entry, HTTP + WS server, GraphStore, Planner, Runner, ApprovalBroker, RunStore
  web/      Vite + React + @xyflow/react UI
```

`shared/` holds everything both sides must agree on, plus pure functions (applying ops,
cycle detection, topological order, run planning). The server uses them to change the
graph; the browser reuses run planning so the run confirmation dialog shows exactly which
nodes will execute.

### 4.1 Units and their interfaces

| Unit | Responsibility | Depends on |
|---|---|---|
| `shared/graph` | Types, `applyOp(graph, op) → graph \| error`, `wouldCreateCycle`, `topoOrder`, `descendants` | nothing |
| `server/GraphStore` | Load/save graphs, apply ops sequentially, append op log, emit `graph.changed` | shared/graph, fs |
| `server/Planner` | One Agent SDK session per graph; exposes graph tools; streams chat to UI | GraphStore, RunStore, SDK |
| `server/Runner` | Execute a run: snapshot, schedule, call executors, propagate status | executors, RunStore, ApprovalBroker |
| `server/AgentExecutor` | Run one agent node via SDK `query()`, emit events, return output | SDK, ApprovalBroker |
| `server/CommandExecutor` | Run one command node via `child_process`, emit events, return output | node:child_process |
| `server/ApprovalBroker` | Hold pending approvals, resolve on user decision, cancel on abort | — |
| `server/RunStore` | Write/read run metadata, per-node events, outputs | fs |
| `server/Hub` | WS fan-out of events; inbound user ops/approvals/chat | all of the above |
| `server/auth` | `claude auth status` check; build sanitized env | node:child_process |

`Runner` takes executors through an interface, so tests substitute a fake
`AgentExecutor` and never call Claude.

## 5. Graph model

A graph is one JSON file: `<project>/.claude-stream/graphs/<name>.json`.

```ts
type Graph = {
  id: string;            // slug, also the file name
  name: string;
  goal: string;          // shared context given to every agent node and to the planner
  nodes: Node[];
  edges: Edge[];         // { id, from, to } — "to runs after from and receives its output"
  nodeSeq: number;       // highest node number ever issued; node ids are never reused
  plannerSessionId?: string;
  plannerOpCursor?: number; // ops-log length when the planner's last turn started
  updatedAt: string;
};

type Node = {
  id: string;            // short and readable: n1, n2, … (easy for the agent to reference)
  title: string;
  kind: "agent" | "command";
  prompt?: string;       // agent: the instructions for this step
  command?: string;      // command: exact shell command, run with cwd = project root
  timeoutSec?: number;   // command only; default 1800
  position?: { x: number; y: number }; // absent → auto-layout places it
  createdBy: "user" | "agent";
  updatedBy: "user" | "agent";
  updatedAt: string;
};
```

**Ops** are the only way the graph changes: `addNode`, `updateNode`, `deleteNode`
(also removes its edges), `connect`, `disconnect`, `setGoal`, `moveNode`. Each applied op
is appended to `graphs/<name>.ops.jsonl` as `{ at, by: "user" | "agent", op }` (except
`moveNode`: layout is not content, so drags are saved but not logged). That file
is the audit trail of who changed what.

Validation in `applyOp`: unique node ids, non-empty titles, edge endpoints exist, no
self-edges or duplicate edges, no cycles (`connect` that would create one is rejected).
Empty prompts and commands are allowed while drafting; a run refuses to start until every
agent node has a prompt and every command node has a command. A rejected op returns an
error message. The planner's tool returns it as tool output so the agent can correct itself;
the UI shows it as a toast.

## 6. Co-editing

- The server applies ops **sequentially**, one at a time; there is no merge logic. Last
  write wins per node field. With one user and one agent this is sufficient.
- After every applied op the server broadcasts the updated graph to the browser. Graphs
  are small, so the browser doesn't replay ops. On (re)connect the browser reopens the
  graph and receives it in full.
- **Your edits** go browser → server as ops tagged `by: "user"`.
- **The planner's edits** come from its graph tools, tagged `by: "agent"`. Nodes it
  creates are marked "by agent" on the canvas until you edit them.
- **The planner sees your edits.** At the start of each planner turn the server prepends
  a short summary of user ops since the planner's previous turn ("You (user) changed n3's
  prompt to …; deleted n5"). The planner can also call `get_graph` at any time.
- **Edits during a run** are allowed. They apply to the graph, not to the running run,
  which executes a frozen snapshot. The run bar shows "graph changed since this run
  started" when they differ.

### 6.1 Planner (the chat agent)

One Agent SDK session per graph, resumed across turns via `resume: plannerSessionId`.

- **cwd:** project root. **Tools:** `Read`, `Glob`, `Grep` (so it can plan against the
  real repo) plus the in-process MCP server `graph` (via `createSdkMcpServer` + `tool()`).
  `permissionMode: "dontAsk"`, `allowedTools: ["mcp__graph__*"]`; edit, write, shell, and
  web tools are in `disallowedTools`. The planner never changes files and never prompts.
- **System prompt addition:** explains claude-stream's node kinds, that it must build
  plans through the graph tools, prefer command nodes for anything that must be
  reproducible (builds, timings, diffs), keep node prompts self-contained, and wire
  edges for data flow.
- **Graph tools:**

| Tool | Purpose |
|---|---|
| `get_graph` | Current graph as JSON |
| `add_node` | `{ kind, title, prompt \| command, after?: string[] }` — creates edges from `after` |
| `update_node` | `{ id, title?, prompt?, command?, timeoutSec? }` |
| `delete_node` | `{ id }` |
| `connect` / `disconnect` | `{ from, to }` |
| `set_goal` | `{ goal }` |
| `request_run` | `{ fromNodeId? }` — opens the run confirmation dialog in the UI; you start the run |
| `get_run` | `{ runId? }` — latest (or given) run's per-node status, outputs, and errors, for debugging |

- Chat messages stream to the right panel. Graph tool calls appear inline in the chat
  ("added n4 · Build new model") as well as on the canvas.
- The chat transcript is saved to `graphs/<name>.chat.jsonl` so it survives reloads.

## 7. Execution

### 7.1 Starting a run

The Run button (or the planner's `request_run`) opens a **confirmation dialog** that
lists every command node's exact command and the count of agent nodes. You confirm to
start. This dialog is the approval for command nodes. Agent node actions are approved
one by one at run time (7.4).

A run takes a frozen snapshot of the graph and gets an id
`<yyyymmdd-hhmmss>-<4 hex>`.

### 7.2 Scheduling

- A node is **ready** when every upstream node has `succeeded` (or `reused`).
- Ready nodes start immediately, up to `maxParallel` (default 3, CLI flag
  `--max-parallel`) to avoid burning through plan usage limits.
- If a node fails, every descendant is marked `not_run` ("Not run": it never ran because a
  step before it failed). Independent branches keep going.
- Node statuses: `queued → running → (waiting_approval ⇄ running) → succeeded | failed
  | cancelled`, or `not_run` / `reused`. The UI shows them as Queued, Running, Waiting
  approval, Succeeded, Failed, Cancelled, Not run, Reused, Interrupted. Runs saved before
  the rename (`pending`, `skipped`) are read back with the new names.
- The run ends `succeeded` (all nodes succeeded/reused), `failed` (any failed or not run),
  `cancelled`, or `interrupted` (server stopped mid-run; see section 10).

**Stop** aborts the run: agent sessions are interrupted via their `AbortController`;
command processes get SIGTERM, then SIGKILL after 5 s; pending approvals are cancelled.

**Re-run from node X** starts a new run from the current graph. The new run executes X,
any node that lacks a `succeeded`/`reused` result in the source run, any node whose kind,
prompt, command, or upstream edges changed since the source run, and every descendant
of those. Every other node is `reused`: its output is copied from the source run. This is the
loop for "edit the failed node's prompt, try again" without re-running the expensive
upstream work.

### 7.3 Agent nodes

Each agent node is one SDK `query()`:

- `cwd`: project root; `pathToClaudeCodeExecutable`: resolved `claude`; `env`: sanitized
  (section 3); `permissionMode: "default"`; `settingSources: ["project"]` (loads the
  repo's `CLAUDE.md` and `.claude/settings.json`, but not your user-level hooks, so
  SessionStart hooks don't fire for every node).
- `disallowedTools: ["Agent", "AskUserQuestion"]`. The graph is the unit of
  decomposition, so nodes don't spawn hidden subagents, and nodes can't block waiting on
  a question. A node that can't proceed should say so in its result and fail.
- **Prompt** assembled by `buildNodePrompt`:

```
# Workflow goal
<graph.goal>

# Your step: <node.title>
<node.prompt>

# Results from earlier steps
## n1 · <title> (agent, succeeded)
<output, truncated to 20,000 chars>
Full output: .claude-stream/runs/<runId>/nodes/n1/output.md

## n2 · <title> (command `dbt build -s x`, exit 0, 42.1 s)
<stdout tail, truncated to 20,000 chars>
Full output: .claude-stream/runs/<runId>/nodes/n2/output.md
```

- **Output** is the result message's `result` text, saved to `output.md`.
- **Node fails** when the result is an error, the session throws, or the auth source
  check fails.

### 7.4 Approval gate ("ask for everything")

Implemented as an SDK **`PreToolUse` hook** on every agent node session. Hooks run before
the SDK's rule evaluation, so allow rules in any settings file cannot bypass them.

- **Pass through without asking:** `Read`, `Glob`, `Grep`.
- **Everything else** (Edit, Write, NotebookEdit, Bash, WebFetch, WebSearch, MCP tools, …)
  creates an approval request `{ id, runId, nodeId, toolName, input, createdAt }`. The node
  goes `waiting_approval`, the request appears in the Approvals tab and the node pulses on
  the canvas. The hook awaits your decision:
  - **Approve** → the hook allows the call.
  - **Deny** (with an optional note) → the hook denies the call and the note is returned
    to the agent as the reason, so it can adjust.
- A `canUseTool` callback is also set as a backstop. If a call already approved by the
  hook still falls through to `canUseTool` (for example, a project `ask` rule), it is
  allowed automatically by matching `toolUseID`. Anything else that reaches it goes
  through the same approval queue.
- Requests from parallel nodes queue together; you decide them in any order.
- No timeout. A request waits until you decide or stop the run.
- The approval UI shows the full input: the diff for Edit/Write, the exact command for
  Bash.

### 7.5 Command nodes

- Run with `spawn` using the user's shell (`$SHELL -lc "<command>"`) in the project root,
  with the user's normal environment (so `dbt` profiles and credentials work as they do
  in your terminal).
- stdout and stderr are streamed as events. **Output** = stdout and stderr interleaved in arrival order, saved to
  `output.md`. Exit code 0 → `succeeded`; non-zero → `failed`; timeout → killed, `failed`.
- Command nodes don't receive upstream outputs as shell input. If a later command needs
  something an agent produced, the agent writes it to a file in the project and the
  command reads the file. This avoids splicing LLM output into shell commands.

## 8. Logs and run history

On disk, per run:

```
.claude-stream/runs/<runId>/
  run.json                 snapshot, status, start/end, source run (for re-runs)
  nodes/<nodeId>/
    events.jsonl           every event for this node, in order
    output.md              the node's output
```

`.claude-stream/.gitignore` is created with `runs/`, so graphs can be committed and run
logs stay local.

**Agent node events:** start (including the full assembled prompt, so you can audit
exactly what context the node received), assistant text, tool call (name + input), tool result
(truncated in the UI with expand), approval requested/decided (who, when, decision,
note), API retry notices, result (tokens in/out, cache tokens, duration, turns,
API-equivalent cost estimate).

**Command node events:** start (exact command, cwd), stdout chunk, stderr chunk, exit
(code, signal, duration).

**UI:** selecting a node opens its **logs panel** below the canvas: the step's status,
duration and error, then the event timeline for the selected run, streaming live (and
following new lines) while it runs. The right panel switches to the **Node** tab, which
edits title, kind, prompt/command, and timeout. ✕ or clicking empty canvas closes the
logs panel. The run selector in the top bar switches the canvas
overlay (statuses, durations) and the logs to any past run.

## 9. UI

- **Top bar:** graph picker (plus "New graph"), goal (click to edit), Run / Stop, run
  selector, login badge.
- **Canvas (center):** React Flow. Drag to move, drag between handles to connect, Delete
  key to remove, double-click empty space to add a node. Node card: title, kind icon,
  status color, duration once finished, "by agent" marker, pulse while waiting for
  approval. Nodes without a position are placed by `@dagrejs/dagre` auto-layout
  (left-to-right); a "Tidy" button re-lays out everything.
- **Logs panel:** under the canvas (about 35% of its height), shown while a step is selected.
- **Right panel tabs:** **Chat** (planner conversation + input box), **Node** (editor for the
  selected node), **Approvals** (pending queue with a count badge; the tab
  turns attention-colored when non-empty).
- Live updates arrive over one WebSocket. The client keeps a single store fed by server
  events.

## 10. Server, startup, and safety

- **CLI:** `claude-stream [projectDir=.] [--port 4317] [--max-parallel 3] [--no-open]`.
  It resolves `claude` on PATH (exits with an install hint if missing), runs the auth
  check, creates `.claude-stream/` if needed, starts the server, and opens the browser.
- **Network:** binds `127.0.0.1` only. A random token is generated per launch. The
  opened URL carries it once; the server swaps it for an `HttpOnly; SameSite=Strict`
  cookie. HTTP and WS require the cookie, and WS also checks `Origin` and `Host`
  (guarding against other sites and DNS rebinding). This matters because the server can
  run shell commands.
- **Restart recovery:** runs found in state `running` at startup are marked
  `interrupted`, along with their in-flight nodes.

## 11. Error handling

| Situation | Behavior |
|---|---|
| `claude` not on PATH | CLI exits with install instructions |
| Not signed in, or signed in with an API key | Page loads; banner explains; Run and Chat disabled |
| Session auth source is an API key | That node/turn fails with an explicit message |
| Usage limit / rate limit | SDK retry events appear in the node log; if the session ultimately fails, the node fails with the error text |
| Agent session error / max turns | Node `failed`; error shown at the top of its log |
| Command non-zero exit / timeout | Node `failed`; exit code / "timed out after N s" shown |
| Invalid op (cycle, missing node) | Rejected; planner gets the error as tool output, UI gets a toast |
| Browser disconnects | Client reconnects with backoff; server resends full graph, active run state, pending approvals |
| Server restarts mid-run | Run marked `interrupted` on next start |
| Graph file is invalid JSON / fails schema | Graph picker shows it as unreadable with the parse error; it is not overwritten |

## 12. Testing

Vitest across all workspaces.

- **shared:** `applyOp` for every op, including the validation failures; cycle
  detection; `topoOrder`; `descendants`.
- **server, no Claude calls:**
  - Runner with a fake `AgentExecutor`: parallelism cap, ready-node ordering, failure →
    descendants not run, stop/cancel, re-run-from node selection and `reused` copying.
  - `CommandExecutor` with real shell commands (`echo`, `sleep`, `exit 3`, timeout).
  - `buildNodePrompt`: goal, upstream ordering, truncation, full-output paths.
  - Approval gate: read-only passthrough, approve → allow, deny → deny with note, abort →
    cancelled, `canUseTool` backstop matching by `toolUseID`.
  - Planner graph tools: each handler applies the right op tagged `agent` and returns
    errors as text.
  - `auth`: parses `claude auth status` JSON; sanitized env drops API key vars.
  - RunStore: layout on disk, interrupted-run recovery.
  - Hub: WS integration test with a fake executor (connect, receive snapshot, send op,
    receive broadcast, approve a request).
- **web:** unit tests for the client store reducer (applying server events). The UI is
  checked by launching the app and driving it in a browser.
- **Opt-in live smoke test** (`CLAUDE_STREAM_LIVE=1`): a two-node graph against real
  Claude, verifying the auth source is the subscription and an approval round-trip
  works. Not part of the default test run.

## 13. Out of scope for v1

- dbt-specific node types (compare/assert), parity templates
- Git worktrees / per-branch isolation
- Undo/redo (the op log makes it possible later)
- Conditional branches, loops, retries-with-backoff per node
- Per-node model selection
- VS Code launcher command
- Multi-user, remote access, packaging/publishing to npm (installed locally with `npm link`)

## 14. Sketch: the dbt parity graph on v1

Shows the node model is sufficient. This is not a v1 deliverable.

```
n1 agent   "Inspect model X and its new version; write parity SQL
            (row counts, key diff, aggregate diff) to parity/x.sql"
   ├─► n2 command  dbt build -s x       --target parity_old   (timed)
   └─► n3 command  dbt build -s x_v2    --target parity_new   (timed)
n2, n3 ─► n4 command  dbt show --inline "$(cat parity/x.sql)" (diff results)
n2, n3, n4 ─► n5 agent "Compare outputs, runtimes, and bytes scanned;
                        state pass/fail on parity and the speed/cost delta"
```

Numbers come from command nodes, so they're reproducible. The judgment lives in n5,
whose inputs are all visible in the logs.
