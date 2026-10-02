# claude-stream Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build claude-stream, a local web app where the user and a Claude planner agent co-edit a workflow graph and then run it node by node — agent nodes through the Claude Agent SDK on the user's Claude subscription, command nodes through the shell — with an approval gate on every agent action and per-node logs.

**Architecture:** npm-workspaces monorepo. `shared/` holds types and pure graph logic. `server/` (run directly with tsx, no build step) owns the single source of truth (`GraphStore`), a planner agent that edits the graph through in-process MCP tools, a `Runner` that schedules nodes in parallel and routes every non-read-only agent tool call through a `PreToolUse` hook into an approval queue, and an HTTP + WebSocket server bound to 127.0.0.1 behind a per-launch token. `web/` is a Vite + React + React Flow UI that renders server state and sends user actions back.

**Tech Stack:** Node ≥ 20.11 (24 installed), TypeScript 7 (`tsc` typecheck only), tsx, Vitest, zod 4, ws, open, `@anthropic-ai/claude-agent-sdk` 0.3.x (+ peers `@anthropic-ai/sdk`, `@modelcontextprotocol/sdk`), React 19, `@xyflow/react` 12, `@dagrejs/dagre` 3, Vite.

**Spec:** `docs/superpowers/specs/2026-10-02-claude-stream-design.md`

## Global Constraints

- Every Agent SDK call passes `pathToClaudeCodeExecutable` = the `claude` resolved from `PATH`, and `env` = `sanitizedEnv(...)` (removes `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN`). Never use bare mode. Never read, store, or forward credentials.
- A session whose init message reports an `apiKeySource` other than `none` or `oauth` fails immediately with an explanation (`authSourceError`).
- Startup auth check: `claude auth status` must report `loggedIn: true`, `authMethod: "claude.ai"`, and (if present) `apiProvider: "firstParty"`; otherwise runs and chat are disabled.
- The server binds `127.0.0.1` only. HTTP and WebSocket require the per-launch token cookie named `cs_<port>`; WebSocket also requires `Origin: http://127.0.0.1:<port>`; every request requires `Host: 127.0.0.1:<port>`.
- Data lives in `<project>/.claude-stream/` with `graphs/`, `runs/`, and a `.gitignore` containing `runs/`.
- Approval gate: `Read`, `Glob`, `Grep` pass without asking; every other agent-node tool call waits for the user. No timeout (hook matcher `timeout: 86400`).
- Agent nodes: `permissionMode: 'default'`, `settingSources: ['project']`, `allowedTools: ['Read','Glob','Grep']`, `disallowedTools: ['Agent','AskUserQuestion']`.
- Planner: `tools: ['Read','Glob','Grep']`, `allowedTools: ['Read','Glob','Grep','mcp__graph__*']`, `permissionMode: 'dontAsk'`, `settingSources: ['project']`, MCP server named `graph`.
- Defaults: port `4317`, `--max-parallel 3`, command timeout `1800` s, upstream excerpt `20_000` chars, kill grace `5000` ms.
- Node ids are `n<number>` and never reused (`Graph.nodeSeq`). Run ids are `yyyymmdd-hhmmss-xxxx` (4 hex).
- TypeScript: `module: Preserve`, `moduleResolution: Bundler`, `noEmit`, extensionless relative imports. tsx runs the server; Vite builds the web UI.
- Names: product and CLI `claude-stream`; package scope `@claude-stream/*`.

## Review Focus

1. **Ids from the browser used in file paths** (`graphId`, `runId`, `nodeId` in `openGraph`, `selectRun`, `getNodeLogs`, plus static file paths) — a crafted `../` value must never read or write outside `.claude-stream/` or `web/dist`. Tests: Task 3 (graph ids), Task 4 (run/node ids), Task 14 (static traversal).
2. **A command that spawns children** (dbt starts Python subprocesses; `cmd & wait`) when stopped or timed out — the whole process group must die, not just the shell. Test: Task 8.
3. **A malformed graph file** from hand edits or a git checkout (bad JSON, duplicate ids, dangling edge, cycle) — it must be listed as unreadable and never overwritten. Tests: Task 2, Task 3.
4. **Two approvals pending at once** from parallel nodes, decided out of order — each call must resume with its own decision, and a node returns to `running` only when all of its approvals are decided. Tests: Task 6, Task 10.
5. **Very large outputs** (MBs of dbt logs) — captured completely on disk, truncated in downstream prompts, and capped in the UI. Tests: Task 7, Task 8 (UI cap in Task 17's `LogView`).

---

## File Structure

```
package.json                 root workspace config, scripts, bin
tsconfig.base.json           shared compiler options
.gitignore
README.md                    install, usage, safety model (Task 18)
shared/
  package.json  tsconfig.json
  src/types.ts               all shared types (graph, ops, runs, events, WS messages)
  src/graph.ts               pure graph logic: applyOp, topoOrder, upstream, descendants, validateRunnable, reusableNodeIds
  src/schemas.ts             zod validation: parseGraph (files), parseClientMessage (WS input)
  src/format.ts              authLabel, fmtDuration (used by CLI and UI)
  src/index.ts               re-exports
  test/graph.test.ts  test/schemas.test.ts
server/
  package.json  tsconfig.json
  bin/claude-stream.mjs      CLI entry: registers tsx, imports src/cli.ts
  src/clock.ts               Clock type + systemClock
  src/fsutil.ts              writeFileAtomic
  src/paths.ts               projectPaths, ensureDataDirs, isGraphId
  src/graphStore.ts          GraphStore: load/list/create/apply ops, op log, planner state
  src/chatLog.ts             ChatLog: per-graph chat transcript
  src/runStore.ts            RunStore: run.json, events.jsonl, output.md; id validation; restart recovery
  src/auth.ts                resolveClaudePath, checkAuth, sanitizedEnv, isSubscriptionAuthSource, authSourceError
  src/approvals.ts           ApprovalBroker: pending approvals, decide, cancel
  src/gate.ts                makeApprovalGate: PreToolUse hook + canUseTool backstop
  src/prompt.ts              buildNodePrompt, truncateHead, truncateTail
  src/executors.ts           NodeContext / NodeOutcome / NodeExecutor types
  src/commandExecutor.ts     createCommandExecutor (process-group aware)
  src/sdk.ts                 QueryFn type, realQuery, loose SDK message helpers
  src/agentExecutor.ts       createAgentExecutor, translateMessage
  src/runner.ts              Runner: scheduling, parallelism, stop, re-run
  src/plannerTools.ts        graphTools, createGraphMcpServer
  src/planner.ts             Planner: chat turns, user-edit preamble, session resume
  src/app.ts                 createApp: wires everything, handles client messages
  src/httpServer.ts          startHttpServer: token cookie, static files, WS
  src/cli.ts                 argument parsing, startup checks, browser open
  test/*.test.ts  test/helpers.ts
web/
  package.json  tsconfig.json  vite.config.ts  index.html
  src/state.ts               pure client state + reducer
  src/layout.ts              dagre auto-layout
  src/runPlan.ts             describeRunPlan for the confirmation dialog
  src/store.ts               React binding (useSyncExternalStore)
  src/socket.ts              WebSocket with reconnect
  src/main.tsx  src/App.tsx  src/styles.css
  src/components/            TopBar, Canvas, StepNode, RightPanel, ChatPanel, NodePanel, LogView, ApprovalsPanel, RunConfirmDialog, Toast
  test/state.test.ts  test/layout.test.ts  test/runPlan.test.ts
```

---

### Task 1: Workspace scaffold and shared graph core

**Files:**
- Create: `package.json`, `tsconfig.base.json`, `.gitignore`
- Create: `shared/package.json`, `shared/tsconfig.json`, `shared/src/types.ts`, `shared/src/graph.ts`, `shared/src/index.ts`
- Test: `shared/test/graph.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces (from `@claude-stream/shared`): all types in `types.ts` (notably `Graph`, `GraphNode`, `Op`, `OpRecord`, `GraphResult`, `NodeRunState`, `RunMeta`, `RunSummary`, `NodeEventBody`, `NodeEvent`, `Decision`, `ApprovalRequest`, `ChatEntry`, `AuthInfo`, `GraphListItem`, `ServerMessage`, `ClientMessage`); functions `emptyGraph(id, name, now): Graph`, `edgeId(from, to): string`, `nextNodeId(graph): string`, `applyOp(graph, op, by, now): GraphResult`, `children(graph, id): string[]`, `upstream(graph, id): string[]`, `descendants(graph, id): Set<string>`, `wouldCreateCycle(graph, from, to): boolean`, `topoOrder(graph): string[]`, `validateRunnable(graph): string[]`, `reusableNodeIds(graph, source: RunSource, fromNodeId?): Set<string>`, type `RunSource = { snapshot: Graph; nodes: Record<string, NodeRunState> }`.

- [ ] **Step 1: Create the root workspace files**

`package.json`:

```json
{
  "name": "claude-stream",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "workspaces": ["shared"],
  "scripts": {
    "test": "npm test --workspaces --if-present",
    "typecheck": "npm run typecheck --workspaces --if-present"
  },
  "engines": { "node": ">=20.11" }
}
```

`tsconfig.base.json`:

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "lib": ["ES2023"],
    "module": "Preserve",
    "moduleResolution": "Bundler",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "isolatedModules": true,
    "resolveJsonModule": true,
    "types": []
  }
}
```

`.gitignore`:

```
node_modules/
web/dist/
.claude-stream/
*.tmp-*
```

- [ ] **Step 2: Create the shared package and install tooling**

`shared/package.json`:

```json
{
  "name": "@claude-stream/shared",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": { "test": "vitest run", "typecheck": "tsc -p ." }
}
```

`shared/tsconfig.json`:

```json
{
  "extends": "../tsconfig.base.json",
  "include": ["src", "test"]
}
```

Run:

```bash
npm install -D typescript vitest @types/node && npm install zod -w shared && npx tsc --version
```

Expected: install succeeds and `tsc --version` prints `Version 7.x` (if `npx tsc` is missing, run `npm install -D typescript@5` and continue).

- [ ] **Step 3: Write `shared/src/types.ts`**

```ts
export type Actor = 'user' | 'agent';
export type NodeKind = 'agent' | 'command';
export type Position = { x: number; y: number };

export type GraphNode = {
  id: string;
  title: string;
  kind: NodeKind;
  prompt?: string;
  command?: string;
  timeoutSec?: number;
  position?: Position;
  createdBy: Actor;
  updatedBy: Actor;
  updatedAt: string;
};

export type Edge = { id: string; from: string; to: string };

export type Graph = {
  id: string;
  name: string;
  goal: string;
  nodes: GraphNode[];
  edges: Edge[];
  /** Highest node number ever issued, so ids are never reused. */
  nodeSeq: number;
  plannerSessionId?: string;
  /** Length of the ops log when the planner's last turn started. */
  plannerOpCursor?: number;
  updatedAt: string;
};

export type NewNodeInput = {
  id?: string;
  title: string;
  kind: NodeKind;
  prompt?: string;
  command?: string;
  timeoutSec?: number;
  position?: Position;
};

export type NodePatch = {
  title?: string;
  kind?: NodeKind;
  prompt?: string;
  command?: string;
  timeoutSec?: number;
};

export type Op =
  | { type: 'addNode'; node: NewNodeInput }
  | { type: 'updateNode'; id: string; patch: NodePatch }
  | { type: 'deleteNode'; id: string }
  | { type: 'connect'; from: string; to: string }
  | { type: 'disconnect'; from: string; to: string }
  | { type: 'setGoal'; goal: string }
  | { type: 'moveNode'; id: string; position: Position };

export type OpRecord = { at: string; by: Actor; op: Op };

export type GraphResult = { ok: true; graph: Graph } | { ok: false; error: string };

export type NodeStatus =
  | 'pending'
  | 'running'
  | 'waiting_approval'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'skipped'
  | 'reused'
  | 'interrupted';

export type RunStatus = 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';

export type NodeUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  turns: number;
};

export type NodeRunState = {
  status: NodeStatus;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  error?: string;
  exitCode?: number | null;
  usage?: NodeUsage;
};

export type RunMeta = {
  id: string;
  graphId: string;
  status: RunStatus;
  startedAt: string;
  endedAt?: string;
  sourceRunId?: string;
  fromNodeId?: string;
  snapshot: Graph;
  nodes: Record<string, NodeRunState>;
};

export type RunSummary = { id: string; graphId: string; status: RunStatus; startedAt: string; endedAt?: string };

export type Decision = { decision: 'approve' } | { decision: 'deny'; note?: string } | { decision: 'cancelled' };

export type NodeEventBody =
  | { type: 'start'; kind: NodeKind; cwd: string; command?: string; prompt?: string }
  | { type: 'text'; text: string }
  | { type: 'tool_call'; toolUseId: string; name: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; content: string; isError: boolean }
  | { type: 'approval_requested'; approvalId: string; toolName: string; input: unknown }
  | { type: 'approval_decided'; approvalId: string; decision: Decision['decision']; note?: string }
  | { type: 'retry'; attempt: number; maxRetries: number; error: string }
  | { type: 'stdout'; chunk: string }
  | { type: 'stderr'; chunk: string }
  | { type: 'result'; ok: boolean; durationMs: number; error?: string; exitCode?: number | null; usage?: NodeUsage }
  | { type: 'error'; message: string };

export type NodeEvent = NodeEventBody & { at: string };

export type ApprovalRequest = {
  id: string;
  runId: string;
  nodeId: string;
  nodeTitle: string;
  toolName: string;
  input: unknown;
  createdAt: string;
};

export type ChatRole = 'user' | 'assistant' | 'tool' | 'error';
export type ChatEntry = { at: string; role: ChatRole; text: string };

export type AuthInfo = { ok: boolean; method?: string; plan?: string; email?: string; error?: string };

export type GraphListItem = { id: string; name: string; error?: string };

export type ServerMessage =
  | { type: 'hello'; auth: AuthInfo; project: string; graphs: GraphListItem[]; approvals: ApprovalRequest[] }
  | { type: 'graphs'; graphs: GraphListItem[] }
  | { type: 'graphOpened'; graph: Graph; chat: ChatEntry[]; chatBusy: boolean; runs: RunSummary[]; run?: RunMeta }
  | { type: 'graph'; graph: Graph }
  | { type: 'opRejected'; graphId: string; error: string }
  | { type: 'runs'; graphId: string; runs: RunSummary[] }
  | { type: 'run'; run: RunMeta; select?: boolean }
  | { type: 'runNode'; runId: string; nodeId: string; state: NodeRunState }
  | { type: 'nodeEvent'; runId: string; nodeId: string; event: NodeEvent }
  | { type: 'nodeLogs'; runId: string; nodeId: string; events: NodeEvent[] }
  | { type: 'approvals'; approvals: ApprovalRequest[] }
  | { type: 'chatEntry'; graphId: string; entry: ChatEntry }
  | { type: 'chatBusy'; graphId: string; busy: boolean }
  | { type: 'confirmRun'; graphId: string; fromNodeId?: string; sourceRunId?: string }
  | { type: 'error'; message: string };

export type ClientMessage =
  | { type: 'openGraph'; graphId: string }
  | { type: 'createGraph'; name: string }
  | { type: 'op'; graphId: string; op: Op }
  | { type: 'chat'; graphId: string; text: string }
  | { type: 'startRun'; graphId: string; fromNodeId?: string; sourceRunId?: string }
  | { type: 'stopRun'; runId: string }
  | { type: 'selectRun'; runId: string }
  | { type: 'getNodeLogs'; runId: string; nodeId: string }
  | { type: 'decide'; approvalId: string; decision: 'approve' | 'deny'; note?: string };
```

- [ ] **Step 4: Write the failing tests `shared/test/graph.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import {
  applyOp,
  descendants,
  emptyGraph,
  nextNodeId,
  reusableNodeIds,
  topoOrder,
  upstream,
  validateRunnable,
  wouldCreateCycle,
} from '../src/graph';
import type { Graph, NodeRunState, Op } from '../src/types';

const T = '2026-10-02T00:00:00.000Z';
const T2 = '2026-10-02T00:00:05.000Z';

function build(ops: Op[], by: 'user' | 'agent' = 'user'): Graph {
  let g = emptyGraph('g', 'G', T);
  for (const op of ops) {
    const r = applyOp(g, op, by, T);
    if (!r.ok) throw new Error(r.error);
    g = r.graph;
  }
  return g;
}
const agent = (title: string, prompt = `do ${title}`): Op => ({ type: 'addNode', node: { title, kind: 'agent', prompt } });
const cmd = (title: string, command: string): Op => ({ type: 'addNode', node: { title, kind: 'command', command } });
const link = (from: string, to: string): Op => ({ type: 'connect', from, to });

function expectError(g: Graph, op: Op, message: string) {
  const r = applyOp(g, op, 'user', T2);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toContain(message);
}

describe('applyOp', () => {
  it('adds nodes with sequential ids and records the author', () => {
    const g = build([agent('a'), cmd('b', 'echo hi')], 'agent');
    expect(g.nodes.map((n) => n.id)).toEqual(['n1', 'n2']);
    expect(g.nodes[0]).toEqual({ id: 'n1', title: 'a', kind: 'agent', prompt: 'do a', createdBy: 'agent', updatedBy: 'agent', updatedAt: T });
    expect(g.nodes[1].command).toBe('echo hi');
    expect(g.nodeSeq).toBe(2);
  });

  it('never reuses an id after the newest node is deleted', () => {
    const g = build([agent('a'), agent('b'), { type: 'deleteNode', id: 'n2' }, agent('c')]);
    expect(g.nodes.map((n) => n.id)).toEqual(['n1', 'n3']);
    expect(nextNodeId(g)).toBe('n4');
  });

  it('rejects duplicate ids, invalid ids and blank titles', () => {
    const g = build([agent('a')]);
    expectError(g, { type: 'addNode', node: { id: 'n1', title: 'x', kind: 'agent' } }, 'already exists');
    expectError(g, { type: 'addNode', node: { id: '../x', title: 'x', kind: 'agent' } }, 'invalid node id');
    expectError(g, { type: 'addNode', node: { title: '   ', kind: 'agent' } }, 'needs a title');
  });

  it('allows empty prompts while drafting', () => {
    const g = build([{ type: 'addNode', node: { title: 'draft', kind: 'agent', prompt: '' } }]);
    expect(g.nodes[0].prompt).toBe('');
  });

  it('updates only the provided fields and records who edited', () => {
    const g = build([agent('a')], 'agent');
    const r = applyOp(g, { type: 'updateNode', id: 'n1', patch: { prompt: 'new', title: undefined } }, 'user', T2);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.graph.nodes[0]).toMatchObject({ title: 'a', prompt: 'new', createdBy: 'agent', updatedBy: 'user', updatedAt: T2 });
    expectError(g, { type: 'updateNode', id: 'n9', patch: { title: 'x' } }, 'does not exist');
    expectError(g, { type: 'updateNode', id: 'n1', patch: { title: ' ' } }, 'needs a title');
  });

  it('deletes a node together with its edges', () => {
    const g = build([agent('a'), agent('b'), agent('c'), link('n1', 'n2'), link('n2', 'n3')]);
    const r = applyOp(g, { type: 'deleteNode', id: 'n2' }, 'user', T2);
    expect(r.ok && r.graph.edges).toEqual([]);
  });

  it('validates connections', () => {
    const g = build([agent('a'), agent('b'), agent('c'), link('n1', 'n2'), link('n2', 'n3')]);
    expect(g.edges.map((e) => e.id)).toEqual(['n1->n2', 'n2->n3']);
    expectError(g, link('n1', 'n1'), 'itself');
    expectError(g, link('n1', 'n2'), 'already exists');
    expectError(g, link('n1', 'n9'), 'does not exist');
    expectError(g, link('n3', 'n1'), 'cycle');
    expectError(g, { type: 'disconnect', from: 'n1', to: 'n3' }, 'does not exist');
    const r = applyOp(g, { type: 'disconnect', from: 'n1', to: 'n2' }, 'user', T2);
    expect(r.ok && r.graph.edges.map((e) => e.id)).toEqual(['n2->n3']);
  });

  it('moves a node without changing who last edited it', () => {
    const g = build([agent('a')], 'agent');
    const r = applyOp(g, { type: 'moveNode', id: 'n1', position: { x: 10, y: 20 } }, 'user', T2);
    expect(r.ok && r.graph.nodes[0]).toMatchObject({ position: { x: 10, y: 20 }, updatedBy: 'agent', updatedAt: T });
  });

  it('sets the goal', () => {
    const r = applyOp(emptyGraph('g', 'G', T), { type: 'setGoal', goal: 'ship it' }, 'agent', T2);
    expect(r.ok && r.graph.goal).toBe('ship it');
  });
});

describe('graph queries', () => {
  const g = build([agent('a'), agent('b'), agent('c'), agent('d'), link('n1', 'n2'), link('n1', 'n3'), link('n2', 'n4'), link('n3', 'n4')]);

  it('orders nodes topologically', () => {
    const order = topoOrder(g);
    expect(order).toHaveLength(4);
    expect(order.indexOf('n1')).toBeLessThan(order.indexOf('n2'));
    expect(order.indexOf('n3')).toBeLessThan(order.indexOf('n4'));
  });

  it('finds upstream nodes, descendants and would-be cycles', () => {
    expect(upstream(g, 'n4').sort()).toEqual(['n2', 'n3']);
    expect([...descendants(g, 'n1')].sort()).toEqual(['n2', 'n3', 'n4']);
    expect(wouldCreateCycle(g, 'n4', 'n1')).toBe(true);
    expect(wouldCreateCycle(g, 'n2', 'n3')).toBe(false);
  });
});

describe('validateRunnable', () => {
  it('reports what blocks a run', () => {
    expect(validateRunnable(emptyGraph('g', 'G', T))).toEqual(['The graph has no nodes.']);
    const g = build([
      { type: 'addNode', node: { title: 'think', kind: 'agent', prompt: ' ' } },
      { type: 'addNode', node: { title: 'build', kind: 'command' } },
    ]);
    expect(validateRunnable(g)).toEqual(['n1 "think": an agent node needs a prompt.', 'n2 "build": a command node needs a command.']);
    expect(validateRunnable(build([agent('a')]))).toEqual([]);
  });
});

describe('reusableNodeIds', () => {
  const chain = build([agent('a'), agent('b'), agent('c'), link('n1', 'n2'), link('n2', 'n3')]);
  const allOk = (g: Graph): Record<string, NodeRunState> =>
    Object.fromEntries(g.nodes.map((n) => [n.id, { status: 'succeeded' as const }]));

  it('re-runs the chosen node and its descendants, reusing the rest', () => {
    expect([...reusableNodeIds(chain, { snapshot: chain, nodes: allOk(chain) }, 'n2')]).toEqual(['n1']);
  });

  it('re-runs nodes that did not succeed last time', () => {
    const nodes = { ...allOk(chain), n1: { status: 'failed' as const } };
    expect([...reusableNodeIds(chain, { snapshot: chain, nodes }, 'n3')]).toEqual([]);
  });

  it('re-runs nodes whose definition changed, plus their descendants', () => {
    const r = applyOp(chain, { type: 'updateNode', id: 'n1', patch: { prompt: 'changed' } }, 'user', T2);
    if (!r.ok) throw new Error(r.error);
    expect([...reusableNodeIds(r.graph, { snapshot: chain, nodes: allOk(chain) }, 'n3')]).toEqual([]);
  });

  it('re-runs nodes whose inputs changed', () => {
    const wide = build([agent('a'), agent('b'), agent('c'), link('n1', 'n2')]);
    const r = applyOp(wide, link('n1', 'n3'), 'user', T2);
    if (!r.ok) throw new Error(r.error);
    expect([...reusableNodeIds(r.graph, { snapshot: wide, nodes: allOk(wide) }, 'n2')]).toEqual(['n1']);
  });
});
```

- [ ] **Step 5: Run the tests to verify they fail**

Run: `npm test -w shared`
Expected: FAIL — `Failed to resolve import "../src/graph"`.

- [ ] **Step 6: Write `shared/src/graph.ts` and `shared/src/index.ts`**

`shared/src/graph.ts`:

```ts
import type { Actor, Graph, GraphNode, GraphResult, NodePatch, NodeRunState, Op } from './types';

const NODE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function emptyGraph(id: string, name: string, now: string): Graph {
  return { id, name, goal: '', nodes: [], edges: [], nodeSeq: 0, updatedAt: now };
}

export function edgeId(from: string, to: string): string {
  return `${from}->${to}`;
}

function seqOf(id: string): number {
  const m = /^n(\d+)$/.exec(id);
  return m ? Number(m[1]) : 0;
}

export function nextNodeId(graph: Graph): string {
  const max = graph.nodes.reduce((acc, n) => Math.max(acc, seqOf(n.id)), graph.nodeSeq);
  return `n${max + 1}`;
}

function definedOnly<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}

export function applyOp(graph: Graph, op: Op, by: Actor, now: string): GraphResult {
  const fail = (error: string): GraphResult => ({ ok: false, error });
  const has = (id: string) => graph.nodes.some((n) => n.id === id);
  const done = (patch: Partial<Graph>): GraphResult => ({ ok: true, graph: { ...graph, ...patch, updatedAt: now } });

  switch (op.type) {
    case 'addNode': {
      const id = op.node.id ?? nextNodeId(graph);
      if (!NODE_ID_RE.test(id)) return fail(`invalid node id "${id}"`);
      if (has(id)) return fail(`node ${id} already exists`);
      const title = op.node.title.trim();
      if (!title) return fail('a node needs a title');
      const node = definedOnly<GraphNode>({
        id,
        title,
        kind: op.node.kind,
        prompt: op.node.prompt,
        command: op.node.command,
        timeoutSec: op.node.timeoutSec,
        position: op.node.position,
        createdBy: by,
        updatedBy: by,
        updatedAt: now,
      }) as GraphNode;
      return done({ nodes: [...graph.nodes, node], nodeSeq: Math.max(graph.nodeSeq, seqOf(id)) });
    }
    case 'updateNode': {
      const node = graph.nodes.find((n) => n.id === op.id);
      if (!node) return fail(`node ${op.id} does not exist`);
      const patch = definedOnly<NodePatch>(op.patch);
      if (patch.title !== undefined) {
        patch.title = patch.title.trim();
        if (!patch.title) return fail('a node needs a title');
      }
      const updated: GraphNode = { ...node, ...patch, updatedBy: by, updatedAt: now };
      return done({ nodes: graph.nodes.map((n) => (n.id === op.id ? updated : n)) });
    }
    case 'deleteNode': {
      if (!has(op.id)) return fail(`node ${op.id} does not exist`);
      return done({
        nodes: graph.nodes.filter((n) => n.id !== op.id),
        edges: graph.edges.filter((e) => e.from !== op.id && e.to !== op.id),
      });
    }
    case 'connect': {
      if (!has(op.from)) return fail(`node ${op.from} does not exist`);
      if (!has(op.to)) return fail(`node ${op.to} does not exist`);
      if (op.from === op.to) return fail('a node cannot depend on itself');
      if (graph.edges.some((e) => e.from === op.from && e.to === op.to)) return fail(`${op.from} -> ${op.to} already exists`);
      if (wouldCreateCycle(graph, op.from, op.to)) return fail(`connecting ${op.from} -> ${op.to} would create a cycle`);
      return done({ edges: [...graph.edges, { id: edgeId(op.from, op.to), from: op.from, to: op.to }] });
    }
    case 'disconnect': {
      if (!graph.edges.some((e) => e.from === op.from && e.to === op.to)) return fail(`${op.from} -> ${op.to} does not exist`);
      return done({ edges: graph.edges.filter((e) => !(e.from === op.from && e.to === op.to)) });
    }
    case 'setGoal':
      return done({ goal: op.goal });
    case 'moveNode': {
      if (!has(op.id)) return fail(`node ${op.id} does not exist`);
      return done({ nodes: graph.nodes.map((n) => (n.id === op.id ? { ...n, position: op.position } : n)) });
    }
  }
}

export function children(graph: Graph, id: string): string[] {
  return graph.edges.filter((e) => e.from === id).map((e) => e.to);
}

export function upstream(graph: Graph, id: string): string[] {
  return graph.edges.filter((e) => e.to === id).map((e) => e.from);
}

/** Every node reachable from `id` by following edges forward. */
export function descendants(graph: Graph, id: string): Set<string> {
  const seen = new Set<string>();
  const stack = [id];
  while (stack.length) {
    const current = stack.pop()!;
    for (const next of children(graph, current)) {
      if (!seen.has(next)) {
        seen.add(next);
        stack.push(next);
      }
    }
  }
  return seen;
}

/** Adding from -> to creates a cycle exactly when `from` is reachable from `to`. */
export function wouldCreateCycle(graph: Graph, from: string, to: string): boolean {
  return from === to || descendants(graph, to).has(from);
}

/** Kahn's algorithm. Returns fewer ids than there are nodes when the graph has a cycle. */
export function topoOrder(graph: Graph): string[] {
  const indegree = new Map(graph.nodes.map((n) => [n.id, 0]));
  for (const e of graph.edges) indegree.set(e.to, (indegree.get(e.to) ?? 0) + 1);
  const ready = graph.nodes.filter((n) => indegree.get(n.id) === 0).map((n) => n.id);
  const order: string[] = [];
  while (ready.length) {
    const id = ready.shift()!;
    order.push(id);
    for (const child of children(graph, id)) {
      const left = (indegree.get(child) ?? 0) - 1;
      indegree.set(child, left);
      if (left === 0) ready.push(child);
    }
  }
  return order;
}

export function validateRunnable(graph: Graph): string[] {
  const problems: string[] = [];
  if (graph.nodes.length === 0) problems.push('The graph has no nodes.');
  for (const n of graph.nodes) {
    if (n.kind === 'agent' && !n.prompt?.trim()) problems.push(`${n.id} "${n.title}": an agent node needs a prompt.`);
    if (n.kind === 'command' && !n.command?.trim()) problems.push(`${n.id} "${n.title}": a command node needs a command.`);
  }
  if (topoOrder(graph).length !== graph.nodes.length) problems.push('The graph has a cycle.');
  return problems;
}

export type RunSource = { snapshot: Graph; nodes: Record<string, NodeRunState> };

function sameSet(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x) => b.includes(x));
}

/**
 * Node ids a re-run may reuse from `source` (spec §7.2). A node executes again when it is
 * `fromNodeId`, did not succeed last time, changed kind/prompt/command, or gained/lost an
 * upstream edge — and so does everything downstream of it. Everything else is reused.
 */
export function reusableNodeIds(graph: Graph, source: RunSource, fromNodeId?: string): Set<string> {
  const seeds = new Set<string>(fromNodeId ? [fromNodeId] : []);
  for (const n of graph.nodes) {
    const prev = source.snapshot.nodes.find((p) => p.id === n.id);
    const state = source.nodes[n.id];
    const succeeded = state?.status === 'succeeded' || state?.status === 'reused';
    const sameDefinition =
      !!prev && prev.kind === n.kind && (prev.prompt ?? '') === (n.prompt ?? '') && (prev.command ?? '') === (n.command ?? '');
    const sameInputs = !!prev && sameSet(upstream(graph, n.id), upstream(source.snapshot, n.id));
    if (!succeeded || !sameDefinition || !sameInputs) seeds.add(n.id);
  }
  const execute = new Set(seeds);
  for (const id of seeds) for (const d of descendants(graph, id)) execute.add(d);
  return new Set(graph.nodes.map((n) => n.id).filter((id) => !execute.has(id)));
}
```

`shared/src/index.ts`:

```ts
export * from './types';
export * from './graph';
```

- [ ] **Step 7: Run the tests and typecheck**

Run: `npm test -w shared && npm run typecheck`
Expected: all `graph.test.ts` tests PASS; typecheck prints no errors.

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json tsconfig.base.json .gitignore shared
git commit -m "feat(shared): graph types and pure graph operations"
```

---

### Task 2: Validation schemas and formatting helpers

**Files:**
- Create: `shared/src/schemas.ts`, `shared/src/format.ts`
- Modify: `shared/src/index.ts`
- Test: `shared/test/schemas.test.ts`

**Interfaces:**
- Consumes: `topoOrder`, types from Task 1.
- Produces: `parseGraph(json: unknown): GraphResult` (validates shape, fills defaults, rejects duplicate ids, dangling or duplicate edges, cycles); `parseClientMessage(raw: string): { ok: true; msg: ClientMessage } | { ok: false; error: string }`; `authLabel(auth: AuthInfo): string`; `fmtDuration(ms: number): string`.

- [ ] **Step 1: Write the failing tests `shared/test/schemas.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { authLabel, fmtDuration } from '../src/format';
import { parseClientMessage, parseGraph } from '../src/schemas';

const node = (id: string) => ({ id, title: id, kind: 'agent' });
const edge = (from: string, to: string) => ({ id: `${from}->${to}`, from, to });

describe('parseGraph', () => {
  it('fills defaults for a minimal file', () => {
    expect(parseGraph({ id: 'g', name: 'G' })).toEqual({
      ok: true,
      graph: { id: 'g', name: 'G', goal: '', nodes: [], edges: [], nodeSeq: 0, updatedAt: '' },
    });
  });

  it('fills node defaults', () => {
    const r = parseGraph({ id: 'g', name: 'G', nodes: [node('n1')] });
    expect(r.ok && r.graph.nodes[0]).toEqual({ id: 'n1', title: 'n1', kind: 'agent', createdBy: 'user', updatedBy: 'user', updatedAt: '' });
  });

  it('rejects wrong shapes with a readable error', () => {
    const r = parseGraph({ id: 'g', name: 'G', nodes: [{ id: 'n1', title: 't', kind: 'robot' }] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('kind');
  });

  it.each([
    [{ nodes: [node('n1'), node('n1')] }, 'duplicate node id'],
    [{ nodes: [node('n1')], edges: [edge('n1', 'n2')] }, 'missing node'],
    [{ nodes: [node('n1'), node('n2')], edges: [edge('n1', 'n2'), edge('n1', 'n2')] }, 'duplicate edge'],
    [{ nodes: [node('n1'), node('n2')], edges: [edge('n1', 'n2'), edge('n2', 'n1')] }, 'cycle'],
  ])('rejects structurally broken graphs (%#)', (extra, message) => {
    const r = parseGraph({ id: 'g', name: 'G', ...extra });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(message);
  });
});

describe('parseClientMessage', () => {
  it('accepts a valid message', () => {
    const msg = { type: 'op', graphId: 'g', op: { type: 'connect', from: 'n1', to: 'n2' } };
    expect(parseClientMessage(JSON.stringify(msg))).toEqual({ ok: true, msg });
  });

  it('rejects invalid JSON, unknown types and bad fields', () => {
    expect(parseClientMessage('{nope').ok).toBe(false);
    expect(parseClientMessage(JSON.stringify({ type: 'format_disk' })).ok).toBe(false);
    expect(parseClientMessage(JSON.stringify({ type: 'decide', approvalId: 'a', decision: 'maybe' })).ok).toBe(false);
    expect(parseClientMessage(JSON.stringify({ type: 'op', graphId: 'g', op: { type: 'moveNode', id: 'n1' } })).ok).toBe(false);
  });
});

describe('format', () => {
  it('labels the signed-in account', () => {
    expect(authLabel({ ok: true, plan: 'max', email: 'me@example.com' })).toBe('Claude Max · me@example.com');
    expect(authLabel({ ok: false, error: 'Not signed in.' })).toBe('⚠ Not signed in.');
  });

  it('formats durations', () => {
    expect(fmtDuration(450)).toBe('450 ms');
    expect(fmtDuration(42_100)).toBe('42.1 s');
    expect(fmtDuration(125_000)).toBe('2m 5s');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w shared`
Expected: FAIL — `Failed to resolve import "../src/format"`.

- [ ] **Step 3: Write `shared/src/schemas.ts`, `shared/src/format.ts`, update `shared/src/index.ts`**

`shared/src/schemas.ts`:

```ts
import { z } from 'zod';
import { topoOrder } from './graph';
import type { ClientMessage, Graph, GraphResult } from './types';

const position = z.object({ x: z.number(), y: z.number() });
const actor = z.enum(['user', 'agent']);
const nodeKind = z.enum(['agent', 'command']);
const timeoutSec = z.number().positive();

const graphNodeSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  title: z.string(),
  kind: nodeKind,
  prompt: z.string().optional(),
  command: z.string().optional(),
  timeoutSec: timeoutSec.optional(),
  position: position.optional(),
  createdBy: actor.default('user'),
  updatedBy: actor.default('user'),
  updatedAt: z.string().default(''),
});

const graphSchema = z.object({
  id: z.string(),
  name: z.string(),
  goal: z.string().default(''),
  nodes: z.array(graphNodeSchema).default([]),
  edges: z.array(z.object({ id: z.string(), from: z.string(), to: z.string() })).default([]),
  nodeSeq: z.number().int().nonnegative().default(0),
  plannerSessionId: z.string().optional(),
  plannerOpCursor: z.number().int().nonnegative().optional(),
  updatedAt: z.string().default(''),
});

export function parseGraph(json: unknown): GraphResult {
  const r = graphSchema.safeParse(json);
  if (!r.success) return { ok: false, error: z.prettifyError(r.error) };
  const graph = r.data as Graph;
  const ids = new Set<string>();
  for (const n of graph.nodes) {
    if (ids.has(n.id)) return { ok: false, error: `duplicate node id ${n.id}` };
    ids.add(n.id);
  }
  const seen = new Set<string>();
  for (const e of graph.edges) {
    if (!ids.has(e.from) || !ids.has(e.to)) return { ok: false, error: `edge ${e.from} -> ${e.to} refers to a missing node` };
    const key = `${e.from}->${e.to}`;
    if (seen.has(key)) return { ok: false, error: `duplicate edge ${e.from} -> ${e.to}` };
    seen.add(key);
  }
  if (topoOrder(graph).length !== graph.nodes.length) return { ok: false, error: 'the graph has a cycle' };
  return { ok: true, graph };
}

const newNode = z.object({
  id: z.string().optional(),
  title: z.string(),
  kind: nodeKind,
  prompt: z.string().optional(),
  command: z.string().optional(),
  timeoutSec: timeoutSec.optional(),
  position: position.optional(),
});

const nodePatch = z.object({
  title: z.string().optional(),
  kind: nodeKind.optional(),
  prompt: z.string().optional(),
  command: z.string().optional(),
  timeoutSec: timeoutSec.optional(),
});

const opSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('addNode'), node: newNode }),
  z.object({ type: z.literal('updateNode'), id: z.string(), patch: nodePatch }),
  z.object({ type: z.literal('deleteNode'), id: z.string() }),
  z.object({ type: z.literal('connect'), from: z.string(), to: z.string() }),
  z.object({ type: z.literal('disconnect'), from: z.string(), to: z.string() }),
  z.object({ type: z.literal('setGoal'), goal: z.string() }),
  z.object({ type: z.literal('moveNode'), id: z.string(), position }),
]);

const clientMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('openGraph'), graphId: z.string() }),
  z.object({ type: z.literal('createGraph'), name: z.string().min(1) }),
  z.object({ type: z.literal('op'), graphId: z.string(), op: opSchema }),
  z.object({ type: z.literal('chat'), graphId: z.string(), text: z.string().min(1) }),
  z.object({ type: z.literal('startRun'), graphId: z.string(), fromNodeId: z.string().optional(), sourceRunId: z.string().optional() }),
  z.object({ type: z.literal('stopRun'), runId: z.string() }),
  z.object({ type: z.literal('selectRun'), runId: z.string() }),
  z.object({ type: z.literal('getNodeLogs'), runId: z.string(), nodeId: z.string() }),
  z.object({ type: z.literal('decide'), approvalId: z.string(), decision: z.enum(['approve', 'deny']), note: z.string().optional() }),
]);

export function parseClientMessage(raw: string): { ok: true; msg: ClientMessage } | { ok: false; error: string } {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'message is not valid JSON' };
  }
  const r = clientMessageSchema.safeParse(json);
  return r.success ? { ok: true, msg: r.data as ClientMessage } : { ok: false, error: z.prettifyError(r.error) };
}
```

`shared/src/format.ts`:

```ts
import type { AuthInfo } from './types';

export function authLabel(auth: AuthInfo): string {
  if (!auth.ok) return `⚠ ${auth.error ?? 'Not signed in.'}`;
  const plan = auth.plan ? auth.plan.charAt(0).toUpperCase() + auth.plan.slice(1) : 'subscription';
  return `Claude ${plan}${auth.email ? ` · ${auth.email}` : ''}`;
}

export function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s - m * 60)}s`;
}
```

`shared/src/index.ts`:

```ts
export * from './types';
export * from './graph';
export * from './schemas';
export * from './format';
```

- [ ] **Step 4: Run the tests and typecheck**

Run: `npm test -w shared && npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add shared
git commit -m "feat(shared): graph file and client message validation, format helpers"
```

---

### Task 3: Server workspace, GraphStore and ChatLog

**Files:**
- Modify: `package.json` (add `server` workspace)
- Create: `server/package.json`, `server/tsconfig.json`, `server/src/clock.ts`, `server/src/fsutil.ts`, `server/src/paths.ts`, `server/src/graphStore.ts`, `server/src/chatLog.ts`, `server/test/helpers.ts`
- Test: `server/test/graphStore.test.ts`

**Interfaces:**
- Consumes: `applyOp`, `emptyGraph`, `nextNodeId`, `parseGraph`, types.
- Produces: `type Clock = () => string`, `systemClock`; `writeFileAtomic(path, data): void`; `type ProjectPaths = { root; dataDir; graphsDir; runsDir }`, `projectPaths(root): ProjectPaths`, `ensureDataDirs(paths): void`, `isGraphId(id): boolean`; `slugify(name): string`; `class GraphStore extends EventEmitter` with `list(): GraphListItem[]`, `load(id): GraphResult`, `get(id): Graph` (throws), `create(name): Graph`, `apply(graphId, op, by): GraphResult` (emits `'changed'` with the new `Graph`), `setPlannerState(graphId, { plannerSessionId?, plannerOpCursor? }): Graph`, `readOps(graphId): OpRecord[]`; `class ChatLog` with `append(graphId, entry)`, `read(graphId): ChatEntry[]`; test helpers `tmpProject(): ProjectPaths`, `fixedClock(): Clock`.

- [ ] **Step 1: Add the server workspace and install its dependencies**

In root `package.json`, change `"workspaces": ["shared"]` to `"workspaces": ["shared", "server"]`.

`server/package.json`:

```json
{
  "name": "@claude-stream/server",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": { "test": "vitest run", "typecheck": "tsc -p ." },
  "dependencies": { "@claude-stream/shared": "*" }
}
```

`server/tsconfig.json`:

```json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": { "types": ["node"] },
  "include": ["src", "test"]
}
```

Run:

```bash
npm install -w server @anthropic-ai/claude-agent-sdk @anthropic-ai/sdk @modelcontextprotocol/sdk zod ws open tsx && npm install -D -w server @types/ws
```

Expected: install succeeds.

- [ ] **Step 2: Write the infrastructure files**

`server/src/clock.ts`:

```ts
export type Clock = () => string;

export const systemClock: Clock = () => new Date().toISOString();
```

`server/src/fsutil.ts`:

```ts
import { randomBytes } from 'node:crypto';
import { renameSync, writeFileSync } from 'node:fs';

/** Write to a temp file, then rename, so readers never see a half-written file. */
export function writeFileAtomic(path: string, data: string): void {
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}
```

`server/src/paths.ts`:

```ts
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type ProjectPaths = { root: string; dataDir: string; graphsDir: string; runsDir: string };

export function projectPaths(root: string): ProjectPaths {
  const dataDir = join(root, '.claude-stream');
  return { root, dataDir, graphsDir: join(dataDir, 'graphs'), runsDir: join(dataDir, 'runs') };
}

export function ensureDataDirs(paths: ProjectPaths): void {
  mkdirSync(paths.graphsDir, { recursive: true });
  mkdirSync(paths.runsDir, { recursive: true });
  const gitignore = join(paths.dataDir, '.gitignore');
  if (!existsSync(gitignore)) writeFileSync(gitignore, 'runs/\n');
}

const GRAPH_ID_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;

/** Graph ids become file names, so they are restricted to a safe slug alphabet. */
export function isGraphId(id: string): boolean {
  return GRAPH_ID_RE.test(id);
}
```

`server/test/helpers.ts`:

```ts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Clock } from '../src/clock';
import { ensureDataDirs, projectPaths, type ProjectPaths } from '../src/paths';

export function tmpProject(): ProjectPaths {
  const paths = projectPaths(mkdtempSync(join(tmpdir(), 'claude-stream-')));
  ensureDataDirs(paths);
  return paths;
}

export function fixedClock(start = Date.parse('2026-10-02T00:00:00.000Z')): Clock {
  let t = start;
  return () => new Date((t += 1000)).toISOString();
}
```

- [ ] **Step 3: Write the failing tests `server/test/graphStore.test.ts`**

```ts
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ChatLog } from '../src/chatLog';
import { GraphStore } from '../src/graphStore';
import { fixedClock, tmpProject } from './helpers';

describe('GraphStore', () => {
  it('creates graphs with slug ids and unique names', () => {
    const store = new GraphStore(tmpProject(), fixedClock());
    expect(store.create('dbt Parity: orders!').id).toBe('dbt-parity-orders');
    expect(store.create('dbt parity orders').id).toBe('dbt-parity-orders-2');
    expect(store.list().map((g) => g.id)).toEqual(['dbt-parity-orders', 'dbt-parity-orders-2']);
  });

  it('applies ops, persists them, logs them and emits changes', () => {
    const paths = tmpProject();
    const store = new GraphStore(paths, fixedClock());
    const { id } = store.create('G');
    const changed = vi.fn();
    store.on('changed', changed);
    expect(store.apply(id, { type: 'addNode', node: { title: 'a', kind: 'agent', prompt: 'p' } }, 'agent').ok).toBe(true);
    store.apply(id, { type: 'moveNode', id: 'n1', position: { x: 1, y: 2 } }, 'user');
    expect(changed).toHaveBeenCalledTimes(2);
    expect(new GraphStore(paths).get(id).nodes[0]).toMatchObject({ id: 'n1', createdBy: 'agent', position: { x: 1, y: 2 } });
    const ops = store.readOps(id);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ by: 'agent', op: { type: 'addNode', node: { id: 'n1', title: 'a' } } });
  });

  it('leaves the file and the log untouched when an op is rejected', () => {
    const paths = tmpProject();
    const store = new GraphStore(paths, fixedClock());
    const { id } = store.create('G');
    const file = join(paths.graphsDir, `${id}.json`);
    const before = readFileSync(file, 'utf8');
    expect(store.apply(id, { type: 'connect', from: 'n1', to: 'n2' }, 'user')).toEqual({ ok: false, error: 'node n1 does not exist' });
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(store.readOps(id)).toEqual([]);
  });

  it('lists unreadable graph files with their error and never overwrites them', () => {
    const paths = tmpProject();
    const broken = join(paths.graphsDir, 'broken.json');
    writeFileSync(broken, '{ "id": "broken", "name": ');
    writeFileSync(
      join(paths.graphsDir, 'cyclic.json'),
      JSON.stringify({
        id: 'cyclic',
        name: 'C',
        nodes: [{ id: 'n1', title: 'a', kind: 'agent' }, { id: 'n2', title: 'b', kind: 'agent' }],
        edges: [{ id: 'n1->n2', from: 'n1', to: 'n2' }, { id: 'n2->n1', from: 'n2', to: 'n1' }],
      }),
    );
    const store = new GraphStore(paths, fixedClock());
    const list = store.list();
    expect(list.find((g) => g.id === 'broken')?.error).toContain('invalid JSON');
    expect(list.find((g) => g.id === 'cyclic')?.error).toContain('cycle');
    expect(store.apply('broken', { type: 'setGoal', goal: 'x' }, 'user').ok).toBe(false);
    expect(readFileSync(broken, 'utf8')).toBe('{ "id": "broken", "name": ');
  });

  it('rejects graph ids that could escape the graphs folder', () => {
    const store = new GraphStore(tmpProject(), fixedClock());
    expect(store.load('../../etc/passwd')).toEqual({ ok: false, error: 'invalid graph id "../../etc/passwd"' });
  });

  it('stores planner state without logging an op or emitting a change', () => {
    const paths = tmpProject();
    const store = new GraphStore(paths, fixedClock());
    const { id } = store.create('G');
    const changed = vi.fn();
    store.on('changed', changed);
    store.setPlannerState(id, { plannerSessionId: 'sess-1', plannerOpCursor: 3 });
    expect(new GraphStore(paths).get(id)).toMatchObject({ plannerSessionId: 'sess-1', plannerOpCursor: 3 });
    expect(changed).not.toHaveBeenCalled();
    expect(store.readOps(id)).toEqual([]);
  });
});

describe('ChatLog', () => {
  it('appends and reads entries per graph', () => {
    const log = new ChatLog(tmpProject());
    log.append('g', { at: 't1', role: 'user', text: 'hi' });
    log.append('g', { at: 't2', role: 'assistant', text: 'hello' });
    expect(log.read('g').map((e) => e.text)).toEqual(['hi', 'hello']);
    expect(log.read('other')).toEqual([]);
    expect(log.read('../x')).toEqual([]);
  });
});
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `npm test -w server`
Expected: FAIL — `Failed to resolve import "../src/chatLog"`.

- [ ] **Step 5: Write `server/src/graphStore.ts` and `server/src/chatLog.ts`**

`server/src/graphStore.ts`:

```ts
import { EventEmitter } from 'node:events';
import { appendFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  applyOp,
  emptyGraph,
  nextNodeId,
  parseGraph,
  type Actor,
  type Graph,
  type GraphListItem,
  type GraphResult,
  type Op,
  type OpRecord,
} from '@claude-stream/shared';
import { systemClock, type Clock } from './clock';
import { writeFileAtomic } from './fsutil';
import { isGraphId, type ProjectPaths } from './paths';

export function slugify(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return slug || 'graph';
}

/** Single source of truth for graphs. Every change goes through `apply`. */
export class GraphStore extends EventEmitter {
  private cache = new Map<string, Graph>();

  constructor(
    private paths: ProjectPaths,
    private clock: Clock = systemClock,
  ) {
    super();
  }

  private file(id: string): string {
    return join(this.paths.graphsDir, `${id}.json`);
  }

  private opsFile(id: string): string {
    return join(this.paths.graphsDir, `${id}.ops.jsonl`);
  }

  list(): GraphListItem[] {
    const ids = readdirSync(this.paths.graphsDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.slice(0, -'.json'.length))
      .sort();
    return ids.map((id) => {
      const r = this.load(id);
      return r.ok ? { id, name: r.graph.name } : { id, name: id, error: r.error };
    });
  }

  load(id: string): GraphResult {
    const cached = this.cache.get(id);
    if (cached) return { ok: true, graph: cached };
    if (!isGraphId(id)) return { ok: false, error: `invalid graph id "${id}"` };
    const path = this.file(id);
    if (!existsSync(path)) return { ok: false, error: `graph "${id}" not found` };
    let json: unknown;
    try {
      json = JSON.parse(readFileSync(path, 'utf8'));
    } catch (e) {
      return { ok: false, error: `invalid JSON: ${(e as Error).message}` };
    }
    const r = parseGraph(json);
    if (!r.ok) return r;
    const graph = { ...r.graph, id };
    this.cache.set(id, graph);
    return { ok: true, graph };
  }

  get(id: string): Graph {
    const r = this.load(id);
    if (!r.ok) throw new Error(r.error);
    return r.graph;
  }

  create(name: string): Graph {
    const base = slugify(name);
    let id = base;
    for (let i = 2; existsSync(this.file(id)); i++) id = `${base}-${i}`;
    const graph = emptyGraph(id, name.trim() || id, this.clock());
    this.save(graph);
    return graph;
  }

  apply(graphId: string, op: Op, by: Actor): GraphResult {
    const current = this.load(graphId);
    if (!current.ok) return current;
    const at = this.clock();
    const resolved: Op =
      op.type === 'addNode' && !op.node.id ? { ...op, node: { ...op.node, id: nextNodeId(current.graph) } } : op;
    const r = applyOp(current.graph, resolved, by, at);
    if (!r.ok) return r;
    this.save(r.graph);
    if (resolved.type !== 'moveNode') {
      const record: OpRecord = { at, by, op: resolved };
      appendFileSync(this.opsFile(graphId), `${JSON.stringify(record)}\n`);
    }
    this.emit('changed', r.graph);
    return r;
  }

  /** Planner bookkeeping: not content, so it is neither logged nor broadcast. */
  setPlannerState(graphId: string, patch: { plannerSessionId?: string; plannerOpCursor?: number }): Graph {
    const graph = { ...this.get(graphId), ...patch };
    this.save(graph);
    return graph;
  }

  readOps(graphId: string): OpRecord[] {
    if (!isGraphId(graphId)) return [];
    const path = this.opsFile(graphId);
    if (!existsSync(path)) return [];
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as OpRecord);
  }

  private save(graph: Graph): void {
    writeFileAtomic(this.file(graph.id), `${JSON.stringify(graph, null, 2)}\n`);
    this.cache.set(graph.id, graph);
  }
}
```

`server/src/chatLog.ts`:

```ts
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ChatEntry } from '@claude-stream/shared';
import { isGraphId, type ProjectPaths } from './paths';

export class ChatLog {
  constructor(private paths: ProjectPaths) {}

  private file(graphId: string): string {
    return join(this.paths.graphsDir, `${graphId}.chat.jsonl`);
  }

  append(graphId: string, entry: ChatEntry): void {
    if (!isGraphId(graphId)) throw new Error(`invalid graph id "${graphId}"`);
    appendFileSync(this.file(graphId), `${JSON.stringify(entry)}\n`);
  }

  read(graphId: string): ChatEntry[] {
    if (!isGraphId(graphId) || !existsSync(this.file(graphId))) return [];
    return readFileSync(this.file(graphId), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as ChatEntry);
  }
}
```

- [ ] **Step 6: Run the tests and typecheck**

Run: `npm test -w server && npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json server
git commit -m "feat(server): graph store with op log and chat log"
```

---

### Task 4: RunStore

**Files:**
- Create: `server/src/runStore.ts`
- Test: `server/test/runStore.test.ts`

**Interfaces:**
- Consumes: `ProjectPaths`, `writeFileAtomic`, types `RunMeta`, `RunSummary`, `NodeEvent`.
- Produces: `isRunId(id): boolean`; `class RunStore` with `create(meta)`, `save(meta)`, `get(runId): RunMeta | undefined`, `list(graphId): RunSummary[]` (newest first), `appendEvent(runId, nodeId, event)`, `readEvents(runId, nodeId): NodeEvent[]`, `writeOutput(runId, nodeId, text)`, `readOutput(runId, nodeId): string`, `copyOutput(fromRunId, toRunId, nodeId)`, `outputRelPath(runId, nodeId): string` (relative to the project root), `recoverInterrupted(now): string[]`. Read methods return empty values for invalid ids; write methods throw.

- [ ] **Step 1: Write the failing tests `server/test/runStore.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { emptyGraph, type RunMeta } from '@claude-stream/shared';
import { RunStore } from '../src/runStore';
import { tmpProject } from './helpers';

const meta = (id: string, graphId = 'g', status: RunMeta['status'] = 'succeeded'): RunMeta => ({
  id,
  graphId,
  status,
  startedAt: `start-${id}`,
  snapshot: emptyGraph(graphId, 'G', 't'),
  nodes: { n1: { status: status === 'running' ? 'running' : 'succeeded' }, n2: { status: 'pending' } },
});

describe('RunStore', () => {
  it('lists a graph’s runs newest first', () => {
    const store = new RunStore(tmpProject());
    store.create(meta('20261002-100000-aaaa'));
    store.create(meta('20261002-110000-bbbb'));
    store.create(meta('20261002-120000-cccc', 'other'));
    expect(store.list('g')).toEqual([
      { id: '20261002-110000-bbbb', graphId: 'g', status: 'succeeded', startedAt: 'start-20261002-110000-bbbb' },
      { id: '20261002-100000-aaaa', graphId: 'g', status: 'succeeded', startedAt: 'start-20261002-100000-aaaa' },
    ]);
    expect(store.get('20261002-120000-cccc')?.graphId).toBe('other');
  });

  it('stores events and outputs per node', () => {
    const store = new RunStore(tmpProject());
    const a = '20261002-100000-aaaa';
    const b = '20261002-110000-bbbb';
    store.create(meta(a));
    store.create(meta(b));
    store.appendEvent(a, 'n1', { at: 't1', type: 'text', text: 'hi' });
    store.appendEvent(a, 'n1', { at: 't2', type: 'stdout', chunk: 'out' });
    expect(store.readEvents(a, 'n1').map((e) => e.type)).toEqual(['text', 'stdout']);
    expect(store.readEvents(a, 'n2')).toEqual([]);
    store.writeOutput(a, 'n1', 'result text');
    expect(store.readOutput(a, 'n1')).toBe('result text');
    expect(store.readOutput(a, 'n2')).toBe('');
    store.copyOutput(a, b, 'n1');
    expect(store.readOutput(b, 'n1')).toBe('result text');
    expect(store.outputRelPath(a, 'n1')).toBe(`.claude-stream/runs/${a}/nodes/n1/output.md`);
  });

  it('refuses ids that could escape the runs folder', () => {
    const store = new RunStore(tmpProject());
    const a = '20261002-100000-aaaa';
    store.create(meta(a));
    expect(store.get('../../x')).toBeUndefined();
    expect(store.readEvents('../../etc', 'passwd')).toEqual([]);
    expect(store.readEvents(a, '../n1')).toEqual([]);
    expect(store.readOutput(a, '../../../secret')).toBe('');
    expect(() => store.writeOutput(a, '../evil', 'x')).toThrow('invalid node id');
    expect(() => store.create(meta('../evil'))).toThrow('invalid run id');
  });

  it('marks runs left running as interrupted', () => {
    const store = new RunStore(tmpProject());
    store.create(meta('20261002-100000-aaaa', 'g', 'running'));
    store.create(meta('20261002-110000-bbbb', 'g', 'succeeded'));
    expect(store.recoverInterrupted('now')).toEqual(['20261002-100000-aaaa']);
    expect(store.get('20261002-100000-aaaa')).toMatchObject({
      status: 'interrupted',
      endedAt: 'now',
      nodes: { n1: { status: 'interrupted', endedAt: 'now' }, n2: { status: 'interrupted', endedAt: 'now' } },
    });
    expect(store.get('20261002-110000-bbbb')?.status).toBe('succeeded');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w server -- runStore`
Expected: FAIL — `Failed to resolve import "../src/runStore"`.

- [ ] **Step 3: Write `server/src/runStore.ts`**

```ts
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { NodeEvent, RunMeta, RunSummary } from '@claude-stream/shared';
import { writeFileAtomic } from './fsutil';
import type { ProjectPaths } from './paths';

const RUN_ID_RE = /^\d{8}-\d{6}-[0-9a-f]{4}$/;
const NODE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const ACTIVE = new Set(['pending', 'running', 'waiting_approval']);

export function isRunId(id: string): boolean {
  return RUN_ID_RE.test(id);
}

/** Run metadata, per-node event logs and outputs under .claude-stream/runs/<runId>/. */
export class RunStore {
  constructor(private paths: ProjectPaths) {}

  private runDir(runId: string): string {
    if (!isRunId(runId)) throw new Error(`invalid run id "${runId}"`);
    return join(this.paths.runsDir, runId);
  }

  private nodeDir(runId: string, nodeId: string): string {
    if (!NODE_ID_RE.test(nodeId)) throw new Error(`invalid node id "${nodeId}"`);
    return join(this.runDir(runId), 'nodes', nodeId);
  }

  private validIds(runId: string, nodeId: string): boolean {
    return isRunId(runId) && NODE_ID_RE.test(nodeId);
  }

  create(meta: RunMeta): void {
    mkdirSync(join(this.runDir(meta.id), 'nodes'), { recursive: true });
    this.save(meta);
  }

  save(meta: RunMeta): void {
    writeFileAtomic(join(this.runDir(meta.id), 'run.json'), `${JSON.stringify(meta, null, 2)}\n`);
  }

  get(runId: string): RunMeta | undefined {
    if (!isRunId(runId)) return undefined;
    const path = join(this.runDir(runId), 'run.json');
    if (!existsSync(path)) return undefined;
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as RunMeta;
    } catch {
      return undefined;
    }
  }

  list(graphId: string): RunSummary[] {
    if (!existsSync(this.paths.runsDir)) return [];
    return readdirSync(this.paths.runsDir)
      .filter(isRunId)
      .sort()
      .reverse()
      .map((id) => this.get(id))
      .filter((m): m is RunMeta => !!m && m.graphId === graphId)
      .map(({ id, graphId: g, status, startedAt, endedAt }) => ({ id, graphId: g, status, startedAt, endedAt }));
  }

  appendEvent(runId: string, nodeId: string, event: NodeEvent): void {
    const dir = this.nodeDir(runId, nodeId);
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, 'events.jsonl'), `${JSON.stringify(event)}\n`);
  }

  readEvents(runId: string, nodeId: string): NodeEvent[] {
    if (!this.validIds(runId, nodeId)) return [];
    const path = join(this.nodeDir(runId, nodeId), 'events.jsonl');
    if (!existsSync(path)) return [];
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as NodeEvent);
  }

  writeOutput(runId: string, nodeId: string, text: string): void {
    const dir = this.nodeDir(runId, nodeId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'output.md'), text);
  }

  readOutput(runId: string, nodeId: string): string {
    if (!this.validIds(runId, nodeId)) return '';
    const path = join(this.nodeDir(runId, nodeId), 'output.md');
    return existsSync(path) ? readFileSync(path, 'utf8') : '';
  }

  copyOutput(fromRunId: string, toRunId: string, nodeId: string): void {
    this.writeOutput(toRunId, nodeId, this.readOutput(fromRunId, nodeId));
  }

  outputRelPath(runId: string, nodeId: string): string {
    return relative(this.paths.root, join(this.nodeDir(runId, nodeId), 'output.md'));
  }

  /** On startup: runs still marked running belonged to a server that stopped mid-run. */
  recoverInterrupted(now: string): string[] {
    if (!existsSync(this.paths.runsDir)) return [];
    const recovered: string[] = [];
    for (const id of readdirSync(this.paths.runsDir).filter(isRunId)) {
      const meta = this.get(id);
      if (!meta || meta.status !== 'running') continue;
      for (const [nodeId, state] of Object.entries(meta.nodes)) {
        if (ACTIVE.has(state.status)) meta.nodes[nodeId] = { ...state, status: 'interrupted', endedAt: now };
      }
      meta.status = 'interrupted';
      meta.endedAt = now;
      this.save(meta);
      recovered.push(id);
    }
    return recovered;
  }
}
```

- [ ] **Step 4: Run the tests and typecheck**

Run: `npm test -w server -- runStore && npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add server/src/runStore.ts server/test/runStore.test.ts
git commit -m "feat(server): run store with id validation and restart recovery"
```

---

### Task 5: Subscription auth checks

**Files:**
- Create: `server/src/auth.ts`
- Test: `server/test/auth.test.ts`

**Interfaces:**
- Consumes: `AuthInfo`.
- Produces: `resolveClaudePath(env?): string | null`; `sanitizedEnv(env?): Record<string, string | undefined>`; `isSubscriptionAuthSource(source: string): boolean`; `authSourceError(source: string): string`; `type ExecFn = (file, args) => Promise<string>`; `checkAuth(claudePath, run?: ExecFn): Promise<AuthInfo>`.

- [ ] **Step 1: Write the failing tests `server/test/auth.test.ts`**

```ts
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { authSourceError, checkAuth, isSubscriptionAuthSource, resolveClaudePath, sanitizedEnv } from '../src/auth';

describe('resolveClaudePath', () => {
  it('finds an executable named claude on PATH', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bin-'));
    const file = join(dir, 'claude');
    writeFileSync(file, '#!/bin/sh\n');
    chmodSync(file, 0o755);
    expect(resolveClaudePath({ PATH: ['/nonexistent', dir].join(delimiter) })).toBe(file);
    expect(resolveClaudePath({ PATH: '/nonexistent' })).toBeNull();
  });
});

describe('checkAuth', () => {
  const status = (s: object) => async () => JSON.stringify(s);

  it('accepts a claude.ai subscription login', async () => {
    const s = { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', email: 'me@example.com', subscriptionType: 'max' };
    expect(await checkAuth('claude', status(s))).toEqual({ ok: true, method: 'claude.ai', plan: 'max', email: 'me@example.com' });
  });

  it.each([
    [{ loggedIn: false }, 'Not signed in'],
    [{ loggedIn: true, authMethod: 'api_key', apiProvider: 'firstParty' }, 'not a Claude subscription'],
    [{ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'bedrock' }, 'bedrock'],
  ])('rejects %j', async (s, message) => {
    const r = await checkAuth('claude', status(s));
    expect(r.ok).toBe(false);
    expect(r.error).toContain(message);
  });

  it('reports unreadable output and failures to run', async () => {
    expect((await checkAuth('claude', async () => 'not json')).error).toContain('unexpected output');
    const failing = async (): Promise<string> => {
      throw new Error('spawn claude ENOENT');
    };
    expect((await checkAuth('claude', failing)).error).toContain('ENOENT');
  });
});

describe('subscription safety helpers', () => {
  it('removes API-key variables and keeps everything else', () => {
    expect(sanitizedEnv({ PATH: '/bin', HOME: '/h', ANTHROPIC_API_KEY: 'sk', ANTHROPIC_AUTH_TOKEN: 't' })).toEqual({ PATH: '/bin', HOME: '/h' });
  });

  it('accepts only subscription auth sources', () => {
    expect(isSubscriptionAuthSource('none')).toBe(true);
    expect(isSubscriptionAuthSource('oauth')).toBe(true);
    expect(isSubscriptionAuthSource('ANTHROPIC_API_KEY')).toBe(false);
    expect(isSubscriptionAuthSource('apiKeyHelper')).toBe(false);
    expect(authSourceError('apiKeyHelper')).toContain('"apiKeyHelper"');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w server -- auth`
Expected: FAIL — `Failed to resolve import "../src/auth"`.

- [ ] **Step 3: Write `server/src/auth.ts`**

```ts
import { execFile } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';
import type { AuthInfo } from '@claude-stream/shared';

const API_KEY_VARS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'];
/** Init-message auth sources that mean "no API key": the subscription login is in use. */
const SUBSCRIPTION_SOURCES = new Set(['none', 'oauth']);

export function resolveClaudePath(env: NodeJS.ProcessEnv = process.env): string | null {
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, 'claude');
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // not in this folder; keep looking
    }
  }
  return null;
}

/** Copy of `env` without API-key variables, so Claude Code uses the subscription login. */
export function sanitizedEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = { ...env };
  for (const key of API_KEY_VARS) delete out[key];
  return out;
}

export function isSubscriptionAuthSource(source: string): boolean {
  return SUBSCRIPTION_SOURCES.has(source);
}

export function authSourceError(source: string): string {
  return `This Claude session authenticated with "${source}" instead of your Claude subscription. Remove API keys from the environment and sign in with /login in Claude Code.`;
}

export type ExecFn = (file: string, args: string[]) => Promise<string>;

const execStatus: ExecFn = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { env: sanitizedEnv(), timeout: 15_000 }, (err, stdout) => {
      if (stdout.trim()) resolve(stdout);
      else reject(err ?? new Error('no output'));
    });
  });

export async function checkAuth(claudePath: string, run: ExecFn = execStatus): Promise<AuthInfo> {
  let raw: string;
  try {
    raw = await run(claudePath, ['auth', 'status']);
  } catch (e) {
    return { ok: false, error: `Could not run "claude auth status": ${(e as Error).message}` };
  }
  let status: Record<string, unknown>;
  try {
    status = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { ok: false, error: 'Got unexpected output from "claude auth status".' };
  }
  if (status.loggedIn !== true) {
    return { ok: false, error: 'Not signed in to Claude Code. Run `claude`, then /login with your Claude account.' };
  }
  const info = {
    method: typeof status.authMethod === 'string' ? status.authMethod : undefined,
    plan: typeof status.subscriptionType === 'string' ? status.subscriptionType : undefined,
    email: typeof status.email === 'string' ? status.email : undefined,
  };
  if (typeof status.apiProvider === 'string' && status.apiProvider !== 'firstParty') {
    return { ok: false, ...info, error: `Claude Code is configured for "${status.apiProvider}", not your Claude subscription.` };
  }
  if (info.method !== 'claude.ai') {
    return {
      ok: false,
      ...info,
      error: `Signed in with "${info.method ?? 'unknown'}", which is not a Claude subscription. Sign in with /login using your Claude account.`,
    };
  }
  return { ok: true, ...info };
}
```

- [ ] **Step 4: Run the tests and typecheck**

Run: `npm test -w server -- auth && npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add server/src/auth.ts server/test/auth.test.ts
git commit -m "feat(server): subscription auth checks and sanitized environment"
```

---

### Task 6: Approval broker and the PreToolUse approval gate

**Files:**
- Create: `server/src/approvals.ts`, `server/src/gate.ts`
- Test: `server/test/approvals.test.ts`, `server/test/gate.test.ts`

**Interfaces:**
- Consumes: `Clock`, types `ApprovalRequest`, `Decision`, `NodeEventBody`; SDK types `CanUseTool`, `HookCallbackMatcher`, `HookInput`, `HookJSONOutput`.
- Produces: `type ApprovalInput = Omit<ApprovalRequest, 'id' | 'createdAt'>`; `class ApprovalBroker extends EventEmitter` with `request(input, signal?): { id: string; decision: Promise<Decision> }`, `decide(id, decision): boolean`, `cancelRun(runId): void`, `pending(): ApprovalRequest[]`, event `'changed'` (pending list); `READ_ONLY_TOOLS: ReadonlySet<string>` (`Read`, `Glob`, `Grep`); `APPROVAL_HOOK_TIMEOUT_SEC = 86400`; `makeApprovalGate({ broker, runId, nodeId, nodeTitle, signal, emit }): { hooks: { PreToolUse: HookCallbackMatcher[] }; canUseTool: CanUseTool }`.

- [ ] **Step 1: Write the failing tests**

`server/test/approvals.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { ApprovalBroker } from '../src/approvals';
import { fixedClock } from './helpers';

const req = (runId = 'r1', nodeId = 'n1') => ({ runId, nodeId, nodeTitle: 'Step', toolName: 'Bash', input: { command: 'ls' } });

describe('ApprovalBroker', () => {
  it('holds a request until it is decided', async () => {
    const broker = new ApprovalBroker(fixedClock());
    const sizes: number[] = [];
    broker.on('changed', (list: unknown[]) => sizes.push(list.length));
    const { id, decision } = broker.request(req());
    expect(broker.pending()).toMatchObject([{ id, runId: 'r1', toolName: 'Bash', createdAt: '2026-10-02T00:00:01.000Z' }]);
    expect(broker.decide(id, { decision: 'approve' })).toBe(true);
    await expect(decision).resolves.toEqual({ decision: 'approve' });
    expect(broker.pending()).toEqual([]);
    expect(sizes).toEqual([1, 0]);
    expect(broker.decide(id, { decision: 'approve' })).toBe(false);
  });

  it('resolves concurrent requests independently, in any order', async () => {
    const broker = new ApprovalBroker();
    const a = broker.request(req('r1', 'n1'));
    const b = broker.request(req('r1', 'n2'));
    broker.decide(b.id, { decision: 'deny', note: 'no' });
    broker.decide(a.id, { decision: 'approve' });
    await expect(a.decision).resolves.toEqual({ decision: 'approve' });
    await expect(b.decision).resolves.toEqual({ decision: 'deny', note: 'no' });
  });

  it('cancels on abort and per run', async () => {
    const broker = new ApprovalBroker();
    const ac = new AbortController();
    const a = broker.request(req('r1'), ac.signal);
    const b = broker.request(req('r2'));
    broker.request(req('r3'));
    ac.abort();
    broker.cancelRun('r2');
    await expect(a.decision).resolves.toEqual({ decision: 'cancelled' });
    await expect(b.decision).resolves.toEqual({ decision: 'cancelled' });
    expect(broker.pending().map((p) => p.runId)).toEqual(['r3']);
  });

  it('cancels at once when the signal is already aborted', async () => {
    const broker = new ApprovalBroker();
    const ac = new AbortController();
    ac.abort();
    const r = broker.request(req(), ac.signal);
    await expect(r.decision).resolves.toEqual({ decision: 'cancelled' });
    expect(broker.pending()).toEqual([]);
  });
});
```

`server/test/gate.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { CanUseTool, HookInput, HookJSONOutput } from '@anthropic-ai/claude-agent-sdk';
import type { NodeEventBody } from '@claude-stream/shared';
import { ApprovalBroker } from '../src/approvals';
import { makeApprovalGate } from '../src/gate';

const preToolUse = (tool_name: string, tool_input: unknown, tool_use_id = 'tu1') =>
  ({ hook_event_name: 'PreToolUse', tool_name, tool_input, tool_use_id, session_id: 's', transcript_path: '/t', cwd: '/p' }) as HookInput;

function setup() {
  const broker = new ApprovalBroker();
  const events: NodeEventBody[] = [];
  const ac = new AbortController();
  const gate = makeApprovalGate({ broker, runId: 'r1', nodeId: 'n1', nodeTitle: 'Step', signal: ac.signal, emit: (e) => events.push(e) });
  const hook = (input: HookInput) => gate.hooks.PreToolUse[0].hooks[0](input, 'tu', { signal: ac.signal });
  const canUse = (name: string, input: Record<string, unknown>, toolUseID: string) =>
    gate.canUseTool(name, input, { signal: ac.signal, toolUseID, requestId: 'req' } as Parameters<CanUseTool>[2]);
  return { broker, events, ac, gate, hook, canUse };
}

const decisionOf = (out: HookJSONOutput) =>
  (out as { hookSpecificOutput?: { hookEventName?: string; permissionDecision?: string; permissionDecisionReason?: string } }).hookSpecificOutput;

describe('approval gate', () => {
  it('lets read-only tools through without asking', async () => {
    const { broker, hook, events } = setup();
    expect(await hook(preToolUse('Read', { file_path: 'a.sql' }))).toEqual({});
    expect(await hook(preToolUse('Grep', { pattern: 'x' }))).toEqual({});
    expect(broker.pending()).toEqual([]);
    expect(events).toEqual([]);
  });

  it('asks before any other tool and allows it on approve', async () => {
    const { broker, hook, events } = setup();
    const out = hook(preToolUse('Bash', { command: 'dbt build' }));
    const [pending] = broker.pending();
    expect(pending).toMatchObject({ runId: 'r1', nodeId: 'n1', nodeTitle: 'Step', toolName: 'Bash', input: { command: 'dbt build' } });
    broker.decide(pending.id, { decision: 'approve' });
    expect(decisionOf(await out)).toMatchObject({ hookEventName: 'PreToolUse', permissionDecision: 'allow' });
    expect(events).toEqual([
      { type: 'approval_requested', approvalId: pending.id, toolName: 'Bash', input: { command: 'dbt build' } },
      { type: 'approval_decided', approvalId: pending.id, decision: 'approve' },
    ]);
  });

  it('denies with the user’s note', async () => {
    const { broker, hook, events } = setup();
    const out = hook(preToolUse('Write', { file_path: 'x.sql', content: '' }));
    const [pending] = broker.pending();
    broker.decide(pending.id, { decision: 'deny', note: 'use the dev target' });
    expect(decisionOf(await out)).toMatchObject({ permissionDecision: 'deny', permissionDecisionReason: 'Denied by the user: use the dev target' });
    expect(events.at(-1)).toEqual({ type: 'approval_decided', approvalId: pending.id, decision: 'deny', note: 'use the dev target' });
  });

  it('denies when the run is stopped', async () => {
    const { ac, hook } = setup();
    const out = hook(preToolUse('Bash', { command: 'sleep 100' }));
    ac.abort();
    expect(decisionOf(await out)).toMatchObject({ permissionDecision: 'deny', permissionDecisionReason: 'The run was stopped.' });
  });

  it('lets canUseTool allow a call the hook already approved, and asks otherwise', async () => {
    const { broker, hook, canUse } = setup();
    const out = hook(preToolUse('Edit', { file_path: 'x' }, 'tu9'));
    broker.decide(broker.pending()[0].id, { decision: 'approve' });
    await out;
    expect(await canUse('Edit', { file_path: 'x' }, 'tu9')).toEqual({ behavior: 'allow', updatedInput: { file_path: 'x' } });
    expect(broker.pending()).toEqual([]);
    const second = canUse('Bash', { command: 'rm -rf build' }, 'tu10');
    broker.decide(broker.pending()[0].id, { decision: 'deny' });
    expect(await second).toEqual({ behavior: 'deny', message: 'Denied by the user.' });
  });

  it('gates every tool with a day-long hook timeout', () => {
    const { gate } = setup();
    expect(gate.hooks.PreToolUse).toHaveLength(1);
    expect(gate.hooks.PreToolUse[0].matcher).toBeUndefined();
    expect(gate.hooks.PreToolUse[0].timeout).toBe(86400);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w server -- approvals gate`
Expected: FAIL — `Failed to resolve import "../src/approvals"`.

- [ ] **Step 3: Write `server/src/approvals.ts` and `server/src/gate.ts`**

`server/src/approvals.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { ApprovalRequest, Decision } from '@claude-stream/shared';
import { systemClock, type Clock } from './clock';

type Pending = { request: ApprovalRequest; resolve: (decision: Decision) => void };
export type ApprovalInput = Omit<ApprovalRequest, 'id' | 'createdAt'>;

/** Agent tool calls waiting for the user. Emits 'changed' with the full pending list. */
export class ApprovalBroker extends EventEmitter {
  private pendingById = new Map<string, Pending>();

  constructor(private clock: Clock = systemClock) {
    super();
  }

  request(input: ApprovalInput, signal?: AbortSignal): { id: string; decision: Promise<Decision> } {
    const request: ApprovalRequest = { ...input, id: randomUUID(), createdAt: this.clock() };
    const decision = new Promise<Decision>((resolve) => {
      if (signal?.aborted) {
        resolve({ decision: 'cancelled' });
        return;
      }
      this.pendingById.set(request.id, { request, resolve });
      signal?.addEventListener('abort', () => this.settle(request.id, { decision: 'cancelled' }), { once: true });
    });
    if (this.pendingById.has(request.id)) this.emit('changed', this.pending());
    return { id: request.id, decision };
  }

  decide(id: string, decision: Decision): boolean {
    return this.settle(id, decision);
  }

  cancelRun(runId: string): void {
    for (const [id, p] of [...this.pendingById]) {
      if (p.request.runId === runId) this.settle(id, { decision: 'cancelled' });
    }
  }

  pending(): ApprovalRequest[] {
    return [...this.pendingById.values()].map((p) => p.request);
  }

  private settle(id: string, decision: Decision): boolean {
    const p = this.pendingById.get(id);
    if (!p) return false;
    this.pendingById.delete(id);
    p.resolve(decision);
    this.emit('changed', this.pending());
    return true;
  }
}
```

`server/src/gate.ts`:

```ts
import type { CanUseTool, HookCallbackMatcher, HookInput, HookJSONOutput } from '@anthropic-ai/claude-agent-sdk';
import type { Decision, NodeEventBody } from '@claude-stream/shared';
import type { ApprovalBroker } from './approvals';

export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set(['Read', 'Glob', 'Grep']);
/** Approvals wait for the user indefinitely; a day is the practical upper bound. */
export const APPROVAL_HOOK_TIMEOUT_SEC = 24 * 60 * 60;

export type GateOptions = {
  broker: ApprovalBroker;
  runId: string;
  nodeId: string;
  nodeTitle: string;
  signal: AbortSignal;
  emit: (event: NodeEventBody) => void;
};

export type ApprovalGate = { hooks: { PreToolUse: HookCallbackMatcher[] }; canUseTool: CanUseTool };

function denialReason(d: Decision): string {
  if (d.decision === 'cancelled') return 'The run was stopped.';
  if (d.decision === 'deny' && d.note) return `Denied by the user: ${d.note}`;
  return 'Denied by the user.';
}

/**
 * "Ask for everything" (spec §7.4). PreToolUse hooks run before the SDK's permission rules,
 * so allow rules in any settings file cannot skip the user. canUseTool is a backstop for
 * calls that still fall through to it (e.g. a project `ask` rule).
 */
export function makeApprovalGate(o: GateOptions): ApprovalGate {
  const approvedToolUseIds = new Set<string>();

  async function ask(toolName: string, input: unknown): Promise<Decision> {
    const { id, decision } = o.broker.request(
      { runId: o.runId, nodeId: o.nodeId, nodeTitle: o.nodeTitle, toolName, input },
      o.signal,
    );
    o.emit({ type: 'approval_requested', approvalId: id, toolName, input });
    const d = await decision;
    o.emit(
      d.decision === 'deny' && d.note
        ? { type: 'approval_decided', approvalId: id, decision: d.decision, note: d.note }
        : { type: 'approval_decided', approvalId: id, decision: d.decision },
    );
    return d;
  }

  async function preToolUse(input: HookInput): Promise<HookJSONOutput> {
    if (input.hook_event_name !== 'PreToolUse' || READ_ONLY_TOOLS.has(input.tool_name)) return {};
    const d = await ask(input.tool_name, input.tool_input);
    if (d.decision === 'approve') {
      approvedToolUseIds.add(input.tool_use_id);
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          permissionDecisionReason: 'Approved by the user in claude-stream.',
        },
      };
    }
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: denialReason(d) } };
  }

  const canUseTool: CanUseTool = async (toolName, input, options) => {
    if (approvedToolUseIds.has(options.toolUseID)) return { behavior: 'allow', updatedInput: input };
    const d = await ask(toolName, input);
    return d.decision === 'approve' ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: denialReason(d) };
  };

  return { hooks: { PreToolUse: [{ hooks: [preToolUse], timeout: APPROVAL_HOOK_TIMEOUT_SEC }] }, canUseTool };
}
```

- [ ] **Step 4: Run the tests and typecheck**

Run: `npm test -w server -- approvals gate && npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add server/src/approvals.ts server/src/gate.ts server/test/approvals.test.ts server/test/gate.test.ts
git commit -m "feat(server): approval broker and PreToolUse approval gate"
```

---

### Task 7: Node prompt assembly

**Files:**
- Create: `server/src/prompt.ts`
- Test: `server/test/prompt.test.ts`

**Interfaces:**
- Consumes: types `Graph`, `GraphNode`, `NodeRunState`.
- Produces: `MAX_UPSTREAM_CHARS = 20_000`; `type UpstreamResult = { node: GraphNode; state: NodeRunState; output: string; outputPath: string }`; `truncateHead(text, max): string`; `truncateTail(text, max): string`; `buildNodePrompt(graph, node, upstream: UpstreamResult[]): string`.

- [ ] **Step 1: Write the failing tests `server/test/prompt.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { emptyGraph, type Graph, type GraphNode } from '@claude-stream/shared';
import { buildNodePrompt, MAX_UPSTREAM_CHARS } from '../src/prompt';

const node = (id: string, kind: 'agent' | 'command', extra: Partial<GraphNode> = {}): GraphNode => ({
  id,
  title: `Title ${id}`,
  kind,
  createdBy: 'user',
  updatedBy: 'user',
  updatedAt: 't',
  ...extra,
});
const graph = (goal: string): Graph => ({ ...emptyGraph('g', 'G', 't'), goal });

describe('buildNodePrompt', () => {
  it('includes the goal, the step and the upstream results', () => {
    const prompt = buildNodePrompt(graph('Prove the new model is equivalent'), node('n3', 'agent', { title: 'Compare', prompt: 'Compare the results.' }), [
      { node: node('n1', 'agent', { title: 'Plan' }), state: { status: 'succeeded' }, output: 'wrote parity.sql', outputPath: '.claude-stream/runs/r/nodes/n1/output.md' },
      {
        node: node('n2', 'command', { title: 'Build', command: 'dbt build -s x' }),
        state: { status: 'succeeded', exitCode: 0, durationMs: 42_100 },
        output: 'OK\n',
        outputPath: '.claude-stream/runs/r/nodes/n2/output.md',
      },
    ]);
    expect(prompt).toBe(`# Workflow goal
Prove the new model is equivalent

# Your step: Compare
Compare the results.

# Results from earlier steps
## n1 · Plan (agent, succeeded)
wrote parity.sql
Full output: .claude-stream/runs/r/nodes/n1/output.md

## n2 · Build (command \`dbt build -s x\`, exit 0, 42.1 s)
OK
Full output: .claude-stream/runs/r/nodes/n2/output.md
`);
  });

  it('omits empty sections and marks missing output', () => {
    expect(buildNodePrompt(graph('  '), node('n1', 'agent', { prompt: 'Do it.' }), [])).toBe('# Your step: Title n1\nDo it.\n');
    const prompt = buildNodePrompt(graph(''), node('n2', 'agent', { prompt: 'x' }), [
      { node: node('n1', 'agent'), state: { status: 'succeeded' }, output: '', outputPath: 'o' },
    ]);
    expect(prompt).toContain('(no output)');
  });

  it('keeps the start of agent output and the end of command output', () => {
    const big = `START${'a'.repeat(60_000)}END`;
    const prompt = buildNodePrompt(graph(''), node('n3', 'agent', { prompt: 'x' }), [
      { node: node('n1', 'agent'), state: { status: 'succeeded' }, output: big, outputPath: 'o1' },
      { node: node('n2', 'command', { command: 'dbt run' }), state: { status: 'failed', exitCode: 1 }, output: big, outputPath: 'o2' },
    ]);
    const [agentPart, commandPart] = prompt.split('## n2');
    expect(agentPart).toContain('START');
    expect(agentPart).not.toContain('END');
    expect(agentPart).toContain('[truncated');
    expect(commandPart).toContain('END');
    expect(commandPart).not.toContain('START');
    expect(commandPart).toContain('(command `dbt run`, exit 1)');
    expect(prompt.length).toBeLessThan(2 * MAX_UPSTREAM_CHARS + 2_000);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w server -- prompt`
Expected: FAIL — `Failed to resolve import "../src/prompt"`.

- [ ] **Step 3: Write `server/src/prompt.ts`**

```ts
import type { Graph, GraphNode, NodeRunState } from '@claude-stream/shared';

export const MAX_UPSTREAM_CHARS = 20_000;

export type UpstreamResult = { node: GraphNode; state: NodeRunState; output: string; outputPath: string };

export function truncateHead(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n…[truncated ${text.length - max} chars]`;
}

export function truncateTail(text: string, max: number): string {
  return text.length <= max ? text : `…[truncated ${text.length - max} chars]\n${text.slice(text.length - max)}`;
}

function heading(u: UpstreamResult): string {
  if (u.node.kind === 'command') {
    const secs = u.state.durationMs !== undefined ? `, ${(u.state.durationMs / 1000).toFixed(1)} s` : '';
    return `## ${u.node.id} · ${u.node.title} (command \`${u.node.command ?? ''}\`, exit ${u.state.exitCode ?? '?'}${secs})`;
  }
  return `## ${u.node.id} · ${u.node.title} (agent, ${u.state.status})`;
}

/** The prompt an agent node receives (spec §7.3). Commands keep their tail, agents their head. */
export function buildNodePrompt(graph: Graph, node: GraphNode, upstream: UpstreamResult[]): string {
  const parts: string[] = [];
  if (graph.goal.trim()) parts.push(`# Workflow goal\n${graph.goal.trim()}`);
  parts.push(`# Your step: ${node.title}\n${(node.prompt ?? '').trim()}`);
  if (upstream.length > 0) {
    const sections = upstream.map((u) => {
      const excerpt =
        u.node.kind === 'command' ? truncateTail(u.output, MAX_UPSTREAM_CHARS) : truncateHead(u.output, MAX_UPSTREAM_CHARS);
      return `${heading(u)}\n${excerpt.trim() || '(no output)'}\nFull output: ${u.outputPath}`;
    });
    parts.push(`# Results from earlier steps\n${sections.join('\n\n')}`);
  }
  return `${parts.join('\n\n')}\n`;
}
```

- [ ] **Step 4: Run the tests and typecheck**

Run: `npm test -w server -- prompt && npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add server/src/prompt.ts server/test/prompt.test.ts
git commit -m "feat(server): node prompt assembly with upstream truncation"
```

---

### Task 8: Command executor

**Files:**
- Create: `server/src/executors.ts`, `server/src/commandExecutor.ts`
- Test: `server/test/commandExecutor.test.ts`

**Interfaces:**
- Consumes: types `Graph`, `GraphNode`, `NodeEventBody`, `NodeUsage`.
- Produces: `type NodeOutcome = { ok: boolean; output: string; error?: string; exitCode?: number | null; usage?: NodeUsage }`; `type NodeContext = { runId; graph; node; prompt; cwd; signal: AbortSignal; emit(event: NodeEventBody): void }`; `type NodeExecutor = (ctx: NodeContext) => Promise<NodeOutcome>`; `type Executors = { agent: NodeExecutor; command: NodeExecutor }`; `DEFAULT_TIMEOUT_SEC = 1800`; `KILL_GRACE_MS = 5000`; `createCommandExecutor({ shell?, env? }?): NodeExecutor`. Error strings: `exited with code <n>`, `timed out after <s> s`, `cancelled`, `killed by <signal>`.

- [ ] **Step 1: Write `server/src/executors.ts`**

```ts
import type { Graph, GraphNode, NodeEventBody, NodeUsage } from '@claude-stream/shared';

export type NodeOutcome = { ok: boolean; output: string; error?: string; exitCode?: number | null; usage?: NodeUsage };

export type NodeContext = {
  runId: string;
  graph: Graph;
  node: GraphNode;
  /** Assembled prompt for agent nodes; empty for command nodes. */
  prompt: string;
  cwd: string;
  signal: AbortSignal;
  emit: (event: NodeEventBody) => void;
};

export type NodeExecutor = (ctx: NodeContext) => Promise<NodeOutcome>;

export type Executors = { agent: NodeExecutor; command: NodeExecutor };
```

- [ ] **Step 2: Write the failing tests `server/test/commandExecutor.test.ts`**

```ts
import { existsSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { emptyGraph, type GraphNode, type NodeEventBody } from '@claude-stream/shared';
import { createCommandExecutor } from '../src/commandExecutor';
import type { NodeContext } from '../src/executors';

const run = createCommandExecutor({ shell: '/bin/sh' });
const tmp = () => mkdtempSync(join(tmpdir(), 'cmd-'));

function ctx(command: string, opts: { timeoutSec?: number; signal?: AbortSignal; cwd?: string } = {}) {
  const events: NodeEventBody[] = [];
  const node: GraphNode = { id: 'n1', title: 'cmd', kind: 'command', command, timeoutSec: opts.timeoutSec, createdBy: 'user', updatedBy: 'user', updatedAt: 't' };
  const c: NodeContext = {
    runId: 'r',
    graph: emptyGraph('g', 'G', 't'),
    node,
    prompt: '',
    cwd: opts.cwd ?? tmp(),
    signal: opts.signal ?? new AbortController().signal,
    emit: (e) => events.push(e),
  };
  return { c, events };
}

async function waitFor(condition: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('command executor', () => {
  it('runs in the project folder and captures stdout', async () => {
    const cwd = tmp();
    const { c, events } = ctx('echo hello && pwd', { cwd });
    const expected = `hello\n${realpathSync(cwd)}\n`;
    expect(await run(c)).toEqual({ ok: true, output: expected, exitCode: 0 });
    expect(events[0]).toEqual({ type: 'start', kind: 'command', cwd, command: 'echo hello && pwd' });
    const stdout = events.flatMap((e) => (e.type === 'stdout' ? [e.chunk] : [])).join('');
    expect(stdout).toBe(expected);
  });

  it('fails with the exit code and keeps stderr', async () => {
    const { c, events } = ctx('echo oops >&2; exit 3');
    expect(await run(c)).toEqual({ ok: false, output: 'oops\n', exitCode: 3, error: 'exited with code 3' });
    expect(events).toContainEqual({ type: 'stderr', chunk: 'oops\n' });
  });

  it('kills the command when it times out', async () => {
    const started = Date.now();
    const out = await run(ctx('sleep 5', { timeoutSec: 0.3 }).c);
    expect(out).toMatchObject({ ok: false, error: 'timed out after 0.3 s' });
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('stops the whole process group on abort, including background children', async () => {
    const cwd = tmp();
    const ac = new AbortController();
    const pending = run(ctx('sleep 30 & echo $! > child.pid; wait', { cwd, signal: ac.signal }).c);
    const pidFile = join(cwd, 'child.pid');
    await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim() !== '');
    const childPid = Number(readFileSync(pidFile, 'utf8'));
    ac.abort();
    expect(await pending).toMatchObject({ ok: false, error: 'cancelled' });
    await waitFor(() => {
      try {
        process.kill(childPid, 0);
        return false;
      } catch {
        return true;
      }
    });
  });

  it('captures large output completely', async () => {
    const out = await run(ctx("head -c 1000000 /dev/zero | tr '\\0' x").c);
    expect(out.ok).toBe(true);
    expect(out.output).toHaveLength(1_000_000);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm test -w server -- commandExecutor`
Expected: FAIL — `Failed to resolve import "../src/commandExecutor"`.

- [ ] **Step 4: Write `server/src/commandExecutor.ts`**

```ts
import { spawn } from 'node:child_process';
import type { NodeExecutor, NodeOutcome } from './executors';

export const DEFAULT_TIMEOUT_SEC = 1800;
export const KILL_GRACE_MS = 5000;

export type CommandExecutorOptions = { shell?: string; env?: NodeJS.ProcessEnv };

/**
 * Runs a command node as `$SHELL -lc "<command>"` in its own process group, so stop and
 * timeout terminate everything it started (dbt, python, …), not just the shell. Uses the
 * user's normal environment so dbt profiles and credentials work as in their terminal.
 */
export function createCommandExecutor(options: CommandExecutorOptions = {}): NodeExecutor {
  return (ctx) =>
    new Promise<NodeOutcome>((resolve) => {
      const command = ctx.node.command ?? '';
      const shell = options.shell ?? process.env.SHELL ?? '/bin/sh';
      const timeoutSec = ctx.node.timeoutSec ?? DEFAULT_TIMEOUT_SEC;
      ctx.emit({ type: 'start', kind: 'command', cwd: ctx.cwd, command });

      let output = '';
      let timedOut = false;
      let cancelled = false;
      let settled = false;
      let killTimer: NodeJS.Timeout | undefined;

      const child = spawn(shell, ['-lc', command], {
        cwd: ctx.cwd,
        env: options.env ?? process.env,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const signalGroup = (signal: NodeJS.Signals) => {
        if (child.pid === undefined) return;
        try {
          process.kill(-child.pid, signal);
        } catch {
          // the process group already exited
        }
      };
      const terminate = () => {
        signalGroup('SIGTERM');
        killTimer ??= setTimeout(() => signalGroup('SIGKILL'), KILL_GRACE_MS);
      };
      const timer = setTimeout(() => {
        timedOut = true;
        terminate();
      }, timeoutSec * 1000);
      const onAbort = () => {
        cancelled = true;
        terminate();
      };
      ctx.signal.addEventListener('abort', onAbort, { once: true });
      if (ctx.signal.aborted) onAbort();

      const finish = (outcome: NodeOutcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        ctx.signal.removeEventListener('abort', onAbort);
        resolve(outcome);
      };

      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        output += chunk;
        ctx.emit({ type: 'stdout', chunk });
      });
      child.stderr.on('data', (chunk: string) => {
        output += chunk;
        ctx.emit({ type: 'stderr', chunk });
      });
      child.on('error', (err) => finish({ ok: false, output, exitCode: null, error: err.message }));
      child.on('close', (code, signal) => {
        if (timedOut) return finish({ ok: false, output, exitCode: code, error: `timed out after ${timeoutSec} s` });
        if (cancelled) return finish({ ok: false, output, exitCode: code, error: 'cancelled' });
        if (code === 0) return finish({ ok: true, output, exitCode: 0 });
        finish({ ok: false, output, exitCode: code, error: signal ? `killed by ${signal}` : `exited with code ${code}` });
      });
    });
}
```

- [ ] **Step 5: Run the tests and typecheck**

Run: `npm test -w server -- commandExecutor && npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
git add server/src/executors.ts server/src/commandExecutor.ts server/test/commandExecutor.test.ts
git commit -m "feat(server): command executor with process-group stop and timeout"
```

---

### Task 9: Agent executor (Claude Agent SDK)

**Files:**
- Create: `server/src/sdk.ts`, `server/src/agentExecutor.ts`
- Test: `server/test/agentExecutor.test.ts`

**Interfaces:**
- Consumes: `ApprovalBroker`, `makeApprovalGate`, `READ_ONLY_TOOLS`, `sanitizedEnv`, `isSubscriptionAuthSource`, `authSourceError`, executor types; SDK `query`, `Options`, `SDKMessage`, `SDKResultMessage`.
- Produces: `type QueryFn = (params: { prompt: string; options?: Options }) => AsyncIterable<SDKMessage>`; `realQuery: QueryFn`; `type LooseBlock`; `blocksOf(message: unknown): LooseBlock[]`; `toolResultText(content: unknown): string`; `translateMessage(msg, emit): { stop?: NodeOutcome }`; `type AgentExecutorDeps = { claudePath: string; broker: ApprovalBroker; queryFn?: QueryFn; env?: NodeJS.ProcessEnv }`; `createAgentExecutor(deps): NodeExecutor`.

- [ ] **Step 1: Write `server/src/sdk.ts`**

```ts
import { query, type Options, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';

/** The slice of the SDK's `query` we use; tests substitute a fake. */
export type QueryFn = (params: { prompt: string; options?: Options }) => AsyncIterable<SDKMessage>;

export const realQuery: QueryFn = query;

/** A loose view of message content blocks, so we don't depend on every SDK block type. */
export type LooseBlock = {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
};

export function blocksOf(message: unknown): LooseBlock[] {
  const content = (message as { content?: unknown } | undefined)?.content;
  return Array.isArray(content) ? (content as LooseBlock[]) : [];
}

export function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return (content as LooseBlock[]).map((c) => (c.type === 'text' ? (c.text ?? '') : `[${c.type}]`)).join('\n');
  }
  return '';
}
```

- [ ] **Step 2: Write the failing tests `server/test/agentExecutor.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import type { HookInput, Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { emptyGraph, type ApprovalRequest, type GraphNode, type NodeEventBody } from '@claude-stream/shared';
import { createAgentExecutor } from '../src/agentExecutor';
import { ApprovalBroker } from '../src/approvals';
import type { NodeContext } from '../src/executors';
import type { QueryFn } from '../src/sdk';

const msg = (m: object) => m as unknown as SDKMessage;
const init = (apiKeySource = 'none') => msg({ type: 'system', subtype: 'init', apiKeySource, session_id: 's1' });
const assistant = (...content: object[]) => msg({ type: 'assistant', parent_tool_use_id: null, message: { content }, session_id: 's1' });
const toolResult = (tool_use_id: string, content: unknown, is_error = false) =>
  msg({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id, content, is_error }] }, session_id: 's1' });
const usage = { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 40 };
const success = (result: string) =>
  msg({ type: 'result', subtype: 'success', is_error: false, result, num_turns: 2, total_cost_usd: 0.12, usage, session_id: 's1' });
const failure = (errors: string[]) =>
  msg({ type: 'result', subtype: 'error_during_execution', is_error: true, errors, num_turns: 1, total_cost_usd: 0, usage, session_id: 's1' });

function fake(script: (options: Options) => AsyncGenerator<SDKMessage>) {
  const calls: { prompt: string; options?: Options }[] = [];
  const fn: QueryFn = (params) => {
    calls.push(params);
    return script(params.options ?? {});
  };
  return { fn, calls };
}

function ctx(signal: AbortSignal = new AbortController().signal) {
  const events: NodeEventBody[] = [];
  const node: GraphNode = { id: 'n2', title: 'Write SQL', kind: 'agent', prompt: 'p', createdBy: 'user', updatedBy: 'user', updatedAt: 't' };
  const c: NodeContext = { runId: 'r1', graph: emptyGraph('g', 'G', 't'), node, prompt: 'FULL PROMPT', cwd: '/proj', signal, emit: (e) => events.push(e) };
  return { c, events };
}

describe('agent executor', () => {
  it('runs the node through the SDK with subscription-safe options', async () => {
    const { fn, calls } = fake(async function* () {
      yield init();
      yield assistant({ type: 'text', text: 'Working.' }, { type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: 'a.sql' } });
      yield toolResult('tu1', [{ type: 'text', text: 'select 1' }]);
      yield success('Done: wrote b.sql');
    });
    const exec = createAgentExecutor({
      claudePath: '/opt/homebrew/bin/claude',
      broker: new ApprovalBroker(),
      queryFn: fn,
      env: { PATH: '/bin', ANTHROPIC_API_KEY: 'sk-ant-xxx', ANTHROPIC_AUTH_TOKEN: 't' },
    });
    const { c, events } = ctx();
    expect(await exec(c)).toEqual({
      ok: true,
      output: 'Done: wrote b.sql',
      usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 40, costUsd: 0.12, turns: 2 },
    });
    expect(calls[0].prompt).toBe('FULL PROMPT');
    const options = calls[0].options!;
    expect(options).toMatchObject({
      cwd: '/proj',
      pathToClaudeCodeExecutable: '/opt/homebrew/bin/claude',
      permissionMode: 'default',
      settingSources: ['project'],
      allowedTools: ['Read', 'Glob', 'Grep'],
      disallowedTools: ['Agent', 'AskUserQuestion'],
    });
    expect(options.env).toEqual({ PATH: '/bin' });
    expect(options.hooks?.PreToolUse).toHaveLength(1);
    expect(typeof options.canUseTool).toBe('function');
    expect(events).toEqual([
      { type: 'start', kind: 'agent', cwd: '/proj', prompt: 'FULL PROMPT' },
      { type: 'text', text: 'Working.' },
      { type: 'tool_call', toolUseId: 'tu1', name: 'Read', input: { file_path: 'a.sql' } },
      { type: 'tool_result', toolUseId: 'tu1', content: 'select 1', isError: false },
    ]);
  });

  it('refuses to continue when the session is not on the subscription', async () => {
    let continued = false;
    const { fn } = fake(async function* () {
      yield init('ANTHROPIC_API_KEY');
      continued = true;
      yield success('should not get here');
    });
    const out = await createAgentExecutor({ claudePath: 'claude', broker: new ApprovalBroker(), queryFn: fn })(ctx().c);
    expect(out.ok).toBe(false);
    expect(out.error).toContain('"ANTHROPIC_API_KEY"');
    expect(continued).toBe(false);
  });

  it('fails with the SDK’s errors', async () => {
    const { fn } = fake(async function* () {
      yield init();
      yield failure(['boom', 'worse']);
    });
    const out = await createAgentExecutor({ claudePath: 'claude', broker: new ApprovalBroker(), queryFn: fn })(ctx().c);
    expect(out).toMatchObject({ ok: false, error: 'boom\nworse' });
  });

  it('fails when the session ends without a result', async () => {
    const { fn } = fake(async function* () {
      yield init();
    });
    const out = await createAgentExecutor({ claudePath: 'claude', broker: new ApprovalBroker(), queryFn: fn })(ctx().c);
    expect(out).toMatchObject({ ok: false, error: 'The agent session ended without a result.' });
  });

  it('routes non-read-only tool calls through the approval queue', async () => {
    const broker = new ApprovalBroker();
    broker.on('changed', (pending: ApprovalRequest[]) => {
      for (const p of pending) queueMicrotask(() => broker.decide(p.id, { decision: 'approve' }));
    });
    let hookResult: unknown;
    const { fn } = fake(async function* (options) {
      yield init();
      const hook = options.hooks!.PreToolUse![0].hooks[0];
      const input = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'dbt build' }, tool_use_id: 'tu7', session_id: 's1', transcript_path: '/t', cwd: '/proj' } as HookInput;
      hookResult = await hook(input, 'tu7', { signal: new AbortController().signal });
      yield success('ok');
    });
    const { c, events } = ctx();
    const out = await createAgentExecutor({ claudePath: 'claude', broker, queryFn: fn })(c);
    expect(out.ok).toBe(true);
    expect(hookResult).toMatchObject({ hookSpecificOutput: { permissionDecision: 'allow' } });
    expect(events.map((e) => e.type)).toEqual(['start', 'approval_requested', 'approval_decided']);
  });

  it('reports cancellation when the run is stopped', async () => {
    const ac = new AbortController();
    const { fn } = fake(async function* (options) {
      yield init();
      await new Promise((_, reject) => options.abortController!.signal.addEventListener('abort', () => reject(new Error('aborted'))));
    });
    const pending = createAgentExecutor({ claudePath: 'claude', broker: new ApprovalBroker(), queryFn: fn })(ctx(ac.signal).c);
    await new Promise((r) => setTimeout(r, 10));
    ac.abort();
    expect(await pending).toMatchObject({ ok: false, error: 'cancelled' });
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm test -w server -- agentExecutor`
Expected: FAIL — `Failed to resolve import "../src/agentExecutor"`.

- [ ] **Step 4: Write `server/src/agentExecutor.ts`**

```ts
import type { Options, SDKMessage, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import type { NodeEventBody, NodeUsage } from '@claude-stream/shared';
import type { ApprovalBroker } from './approvals';
import { authSourceError, isSubscriptionAuthSource, sanitizedEnv } from './auth';
import type { NodeExecutor, NodeOutcome } from './executors';
import { makeApprovalGate, READ_ONLY_TOOLS } from './gate';
import { blocksOf, realQuery, toolResultText, type QueryFn } from './sdk';

export type AgentExecutorDeps = { claudePath: string; broker: ApprovalBroker; queryFn?: QueryFn; env?: NodeJS.ProcessEnv };

function usageOf(msg: SDKResultMessage): NodeUsage {
  return {
    inputTokens: msg.usage.input_tokens ?? 0,
    outputTokens: msg.usage.output_tokens ?? 0,
    cacheReadTokens: msg.usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: msg.usage.cache_creation_input_tokens ?? 0,
    costUsd: msg.total_cost_usd ?? 0,
    turns: msg.num_turns ?? 0,
  };
}

/** Turns one SDK message into node log events; `stop` ends the node with that outcome. */
export function translateMessage(msg: SDKMessage, emit: (event: NodeEventBody) => void): { stop?: NodeOutcome } {
  switch (msg.type) {
    case 'system': {
      const sys = msg as unknown as { subtype?: string; apiKeySource?: string; attempt?: number; max_retries?: number; error?: unknown };
      if (sys.subtype === 'init' && sys.apiKeySource !== undefined && !isSubscriptionAuthSource(sys.apiKeySource)) {
        return { stop: { ok: false, output: '', error: authSourceError(sys.apiKeySource) } };
      }
      if (sys.subtype === 'api_retry') {
        emit({ type: 'retry', attempt: sys.attempt ?? 0, maxRetries: sys.max_retries ?? 0, error: String(sys.error ?? 'unknown') });
      }
      return {};
    }
    case 'assistant': {
      const m = msg as unknown as { parent_tool_use_id?: string | null; message?: unknown };
      if (m.parent_tool_use_id) return {};
      for (const b of blocksOf(m.message)) {
        if (b.type === 'text' && b.text?.trim()) emit({ type: 'text', text: b.text });
        else if (b.type === 'tool_use') emit({ type: 'tool_call', toolUseId: b.id ?? '', name: b.name ?? '', input: b.input });
      }
      return {};
    }
    case 'user': {
      const m = msg as unknown as { parent_tool_use_id?: string | null; message?: unknown };
      if (m.parent_tool_use_id) return {};
      for (const b of blocksOf(m.message)) {
        if (b.type === 'tool_result') {
          emit({ type: 'tool_result', toolUseId: b.tool_use_id ?? '', content: toolResultText(b.content), isError: b.is_error === true });
        }
      }
      return {};
    }
    case 'result': {
      const usage = usageOf(msg);
      if (msg.subtype === 'success') {
        return {
          stop: msg.is_error
            ? { ok: false, output: msg.result, error: msg.result || 'The agent reported an error.', usage }
            : { ok: true, output: msg.result, usage },
        };
      }
      return { stop: { ok: false, output: '', error: msg.errors.join('\n') || msg.subtype, usage } };
    }
    default:
      return {};
  }
}

/** One agent node = one SDK query on the user's Claude subscription (spec §3, §7.3). */
export function createAgentExecutor(deps: AgentExecutorDeps): NodeExecutor {
  const queryFn = deps.queryFn ?? realQuery;
  return async (ctx) => {
    ctx.emit({ type: 'start', kind: 'agent', cwd: ctx.cwd, prompt: ctx.prompt });
    const abortController = new AbortController();
    const onAbort = () => abortController.abort();
    ctx.signal.addEventListener('abort', onAbort, { once: true });
    if (ctx.signal.aborted) onAbort();
    const gate = makeApprovalGate({
      broker: deps.broker,
      runId: ctx.runId,
      nodeId: ctx.node.id,
      nodeTitle: ctx.node.title,
      signal: abortController.signal,
      emit: ctx.emit,
    });
    const options: Options = {
      cwd: ctx.cwd,
      pathToClaudeCodeExecutable: deps.claudePath,
      env: sanitizedEnv(deps.env ?? process.env),
      permissionMode: 'default',
      settingSources: ['project'],
      allowedTools: [...READ_ONLY_TOOLS],
      disallowedTools: ['Agent', 'AskUserQuestion'],
      hooks: gate.hooks,
      canUseTool: gate.canUseTool,
      abortController,
    };
    try {
      for await (const message of queryFn({ prompt: ctx.prompt, options })) {
        const step = translateMessage(message, ctx.emit);
        if (step.stop) return step.stop;
      }
      return { ok: false, output: '', error: ctx.signal.aborted ? 'cancelled' : 'The agent session ended without a result.' };
    } catch (e) {
      if (ctx.signal.aborted) return { ok: false, output: '', error: 'cancelled' };
      return { ok: false, output: '', error: e instanceof Error ? e.message : String(e) };
    } finally {
      ctx.signal.removeEventListener('abort', onAbort);
    }
  };
}
```

- [ ] **Step 5: Run the tests and typecheck**

Run: `npm test -w server -- agentExecutor && npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
git add server/src/sdk.ts server/src/agentExecutor.ts server/test/agentExecutor.test.ts
git commit -m "feat(server): agent executor on the Claude Agent SDK with approval gate"
```

---

### Task 10: Runner — scheduling, parallelism, stop and re-run

**Files:**
- Create: `server/src/runner.ts`
- Test: `server/test/runner.test.ts`

**Interfaces:**
- Consumes: `RunStore`, `ApprovalBroker`, `Executors`/`NodeOutcome`, `buildNodePrompt`, shared `reusableNodeIds`, `topoOrder`, `upstream`, `validateRunnable`.
- Produces: `newRunId(date?): string`; `type RunnerDeps = { runStore; broker; executors; projectDir; maxParallel; clock?; newRunId?: () => string }`; `type StartRunInput = { graph: Graph; sourceRunId?: string; fromNodeId?: string }`; `type StartRunResult = { ok: true; run: RunMeta; done: Promise<RunMeta> } | { ok: false; error: string }`; `class Runner extends EventEmitter` with `start(input): StartRunResult`, `stop(runId): boolean`, `stopAll(): void`, `get(runId): RunMeta | undefined` (active runs only), `activeFor(graphId): RunMeta | undefined`; events `'run'` (meta), `'node'` (runId, nodeId, state), `'event'` (runId, nodeId, NodeEvent). Error strings: `A run is already in progress for this graph.`, `node <id> does not exist`, `run <id> not found`.

- [ ] **Step 1: Write the failing tests `server/test/runner.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { applyOp, emptyGraph, type Graph, type Op } from '@claude-stream/shared';
import { ApprovalBroker } from '../src/approvals';
import type { NodeContext, NodeExecutor, NodeOutcome } from '../src/executors';
import { newRunId, Runner } from '../src/runner';
import { RunStore } from '../src/runStore';
import { tmpProject } from './helpers';

const tick = () => new Promise((r) => setImmediate(r));

function graphOf(ops: Op[]): Graph {
  let g = emptyGraph('g', 'G', 't');
  for (const op of ops) {
    const r = applyOp(g, op, 'user', 't');
    if (!r.ok) throw new Error(r.error);
    g = r.graph;
  }
  return g;
}
const agent = (title: string): Op => ({ type: 'addNode', node: { title, kind: 'agent', prompt: `do ${title}` } });
const link = (from: string, to: string): Op => ({ type: 'connect', from, to });

/** An executor whose nodes finish only when the test says so. */
function controllable() {
  const started: string[] = [];
  const contexts = new Map<string, NodeContext>();
  const finishers = new Map<string, (o: NodeOutcome) => void>();
  let active = 0;
  let maxActive = 0;
  const exec: NodeExecutor = (ctx) =>
    new Promise<NodeOutcome>((resolve) => {
      started.push(ctx.node.id);
      contexts.set(ctx.node.id, ctx);
      active++;
      maxActive = Math.max(maxActive, active);
      const finish = (o: NodeOutcome) => {
        if (finishers.get(ctx.node.id) !== finish) return;
        finishers.delete(ctx.node.id);
        active--;
        resolve(o);
      };
      finishers.set(ctx.node.id, finish);
      ctx.signal.addEventListener('abort', () => finish({ ok: false, output: '', error: 'cancelled' }), { once: true });
    });
  return {
    exec,
    started,
    contexts,
    finish: (id: string, o: NodeOutcome = { ok: true, output: `out-${id}` }) => finishers.get(id)?.(o),
    get maxActive() {
      return maxActive;
    },
  };
}

let seq = 0;
function setup(maxParallel = 3) {
  const paths = tmpProject();
  const runStore = new RunStore(paths);
  const broker = new ApprovalBroker();
  const fake = controllable();
  const runner = new Runner({
    runStore,
    broker,
    executors: { agent: fake.exec, command: fake.exec },
    projectDir: paths.root,
    maxParallel,
    newRunId: () => `20261002-000000-${(seq++).toString(16).padStart(4, '0')}`,
  });
  return { runStore, broker, fake, runner };
}

function started(r: ReturnType<Runner['start']>) {
  if (!r.ok) throw new Error(r.error);
  return r;
}

describe('Runner', () => {
  it('creates sortable run ids', () => {
    expect(newRunId(new Date(2026, 9, 2, 13, 4, 5))).toMatch(/^20261002-130405-[0-9a-f]{4}$/);
  });

  it('runs a chain in order and feeds outputs downstream', async () => {
    const { runner, fake, runStore } = setup();
    const statuses: string[] = [];
    runner.on('node', (_runId: string, nodeId: string, state: { status: string }) => statuses.push(`${nodeId}:${state.status}`));
    const r = started(runner.start({ graph: graphOf([agent('a'), agent('b'), link('n1', 'n2')]) }));
    await tick();
    expect(fake.started).toEqual(['n1']);
    fake.finish('n1');
    await tick();
    expect(fake.started).toEqual(['n1', 'n2']);
    const prompt = fake.contexts.get('n2')!.prompt;
    expect(prompt).toContain('out-n1');
    expect(prompt).toContain(`.claude-stream/runs/${r.run.id}/nodes/n1/output.md`);
    fake.finish('n2');
    const done = await r.done;
    expect(done.status).toBe('succeeded');
    expect(statuses).toEqual(['n1:running', 'n1:succeeded', 'n2:running', 'n2:succeeded']);
    expect(runStore.readOutput(done.id, 'n2')).toBe('out-n2');
    expect(runStore.readEvents(done.id, 'n1').map((e) => e.type)).toEqual(['result']);
    expect(runStore.get(done.id)?.status).toBe('succeeded');
  });

  it('runs independent nodes in parallel up to maxParallel', async () => {
    const { runner, fake } = setup(2);
    const r = started(runner.start({ graph: graphOf([agent('a'), agent('b'), agent('c'), agent('d')]) }));
    await tick();
    expect(fake.started).toEqual(['n1', 'n2']);
    fake.finish('n1');
    await tick();
    expect(fake.started).toEqual(['n1', 'n2', 'n3']);
    fake.finish('n2');
    fake.finish('n3');
    await tick();
    fake.finish('n4');
    expect((await r.done).status).toBe('succeeded');
    expect(fake.maxActive).toBe(2);
  });

  it('skips descendants of a failed node but finishes independent branches', async () => {
    const { runner, fake, runStore } = setup();
    const r = started(runner.start({ graph: graphOf([agent('a'), agent('b'), agent('c'), link('n1', 'n2')]) }));
    await tick();
    fake.finish('n1', { ok: false, output: 'partial', error: 'boom' });
    fake.finish('n3');
    const done = await r.done;
    expect(done.status).toBe('failed');
    expect(done.nodes.n1).toMatchObject({ status: 'failed', error: 'boom' });
    expect(done.nodes.n2.status).toBe('skipped');
    expect(done.nodes.n3.status).toBe('succeeded');
    expect(fake.started).not.toContain('n2');
    expect(runStore.readEvents(done.id, 'n1').at(-1)).toMatchObject({ type: 'result', ok: false, error: 'boom' });
  });

  it('stops running and pending nodes and cancels their approvals', async () => {
    const { runner, broker } = setup();
    const r = started(runner.start({ graph: graphOf([agent('a'), agent('b'), agent('c'), link('n1', 'n3')]) }));
    await tick();
    const approval = broker.request({ runId: r.run.id, nodeId: 'n2', nodeTitle: 'b', toolName: 'Bash', input: {} });
    expect(runner.stop(r.run.id)).toBe(true);
    const done = await r.done;
    expect(done.status).toBe('cancelled');
    expect(done.nodes).toMatchObject({ n1: { status: 'cancelled' }, n2: { status: 'cancelled' }, n3: { status: 'cancelled' } });
    await expect(approval.decision).resolves.toEqual({ decision: 'cancelled' });
    expect(runner.stop(r.run.id)).toBe(false);
  });

  it('stopAll stops every active run', async () => {
    const { runner } = setup();
    const r = started(runner.start({ graph: graphOf([agent('a')]) }));
    await tick();
    runner.stopAll();
    expect((await r.done).status).toBe('cancelled');
  });

  it('re-runs from a node, reusing unchanged upstream results', async () => {
    const { runner, fake, runStore } = setup();
    const g = graphOf([agent('a'), agent('b'), agent('c'), link('n1', 'n2'), link('n2', 'n3')]);
    const first = started(runner.start({ graph: g }));
    await tick();
    fake.finish('n1');
    await tick();
    fake.finish('n2');
    await tick();
    fake.finish('n3');
    await first.done;
    fake.started.length = 0;
    const second = started(runner.start({ graph: g, sourceRunId: first.run.id, fromNodeId: 'n2' }));
    expect(second.run.nodes.n1.status).toBe('reused');
    expect(second.run.sourceRunId).toBe(first.run.id);
    expect(runStore.readOutput(second.run.id, 'n1')).toBe('out-n1');
    await tick();
    expect(fake.started).toEqual(['n2']);
    expect(fake.contexts.get('n2')!.prompt).toContain('out-n1');
    fake.finish('n2');
    await tick();
    fake.finish('n3');
    expect((await second.done).status).toBe('succeeded');
  });

  it('refuses runs that cannot start', () => {
    const { runner } = setup();
    const draft = graphOf([{ type: 'addNode', node: { title: 'x', kind: 'agent', prompt: '' } }]);
    expect(runner.start({ graph: draft })).toEqual({ ok: false, error: 'n1 "x": an agent node needs a prompt.' });
    const g = graphOf([agent('a')]);
    expect(runner.start({ graph: g, fromNodeId: 'n9' })).toEqual({ ok: false, error: 'node n9 does not exist' });
    expect(runner.start({ graph: g, sourceRunId: '20990101-000000-ffff' })).toEqual({ ok: false, error: 'run 20990101-000000-ffff not found' });
    expect(runner.start({ graph: g }).ok).toBe(true);
    expect(runner.start({ graph: g })).toEqual({ ok: false, error: 'A run is already in progress for this graph.' });
  });

  it('marks a node waiting while any of its approvals is pending', async () => {
    const { runner, fake } = setup();
    const r = started(runner.start({ graph: graphOf([agent('a')]) }));
    await tick();
    const { emit } = fake.contexts.get('n1')!;
    const status = () => runner.get(r.run.id)!.nodes.n1.status;
    emit({ type: 'approval_requested', approvalId: 'a1', toolName: 'Bash', input: {} });
    emit({ type: 'approval_requested', approvalId: 'a2', toolName: 'Edit', input: {} });
    expect(status()).toBe('waiting_approval');
    emit({ type: 'approval_decided', approvalId: 'a2', decision: 'approve' });
    expect(status()).toBe('waiting_approval');
    emit({ type: 'approval_decided', approvalId: 'a1', decision: 'deny' });
    expect(status()).toBe('running');
    fake.finish('n1');
    await r.done;
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w server -- runner`
Expected: FAIL — `Failed to resolve import "../src/runner"`.

- [ ] **Step 3: Write `server/src/runner.ts`**

```ts
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  reusableNodeIds,
  topoOrder,
  upstream,
  validateRunnable,
  type Graph,
  type NodeEvent,
  type NodeEventBody,
  type NodeRunState,
  type NodeStatus,
  type RunMeta,
} from '@claude-stream/shared';
import type { ApprovalBroker } from './approvals';
import { systemClock, type Clock } from './clock';
import type { Executors, NodeOutcome } from './executors';
import { buildNodePrompt } from './prompt';
import type { RunStore } from './runStore';

export function newRunId(date: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp = `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
  return `${stamp}-${randomBytes(2).toString('hex')}`;
}

export type RunnerDeps = {
  runStore: RunStore;
  broker: ApprovalBroker;
  executors: Executors;
  projectDir: string;
  maxParallel: number;
  clock?: Clock;
  newRunId?: () => string;
};

export type StartRunInput = { graph: Graph; sourceRunId?: string; fromNodeId?: string };
export type StartRunResult = { ok: true; run: RunMeta; done: Promise<RunMeta> } | { ok: false; error: string };

type ActiveRun = {
  meta: RunMeta;
  order: string[];
  running: Map<string, AbortController>;
  waiting: Map<string, number>;
  stopping: boolean;
  finished: boolean;
  resolveDone: (meta: RunMeta) => void;
};

const DONE_OK: ReadonlySet<NodeStatus> = new Set(['succeeded', 'reused']);
const BLOCKED: ReadonlySet<NodeStatus> = new Set(['failed', 'skipped', 'cancelled', 'interrupted']);

/**
 * Executes a frozen snapshot of a graph (spec §7.2): a node starts once every upstream node
 * succeeded or was reused, up to `maxParallel` at a time; failures skip descendants.
 * Events: 'run' (RunMeta), 'node' (runId, nodeId, NodeRunState), 'event' (runId, nodeId, NodeEvent).
 */
export class Runner extends EventEmitter {
  private runs = new Map<string, ActiveRun>();
  private clock: Clock;
  private makeRunId: () => string;

  constructor(private deps: RunnerDeps) {
    super();
    this.clock = deps.clock ?? systemClock;
    this.makeRunId = deps.newRunId ?? (() => newRunId());
  }

  get(runId: string): RunMeta | undefined {
    return this.runs.get(runId)?.meta;
  }

  activeFor(graphId: string): RunMeta | undefined {
    for (const run of this.runs.values()) if (run.meta.graphId === graphId) return run.meta;
    return undefined;
  }

  start(input: StartRunInput): StartRunResult {
    const graph = structuredClone(input.graph);
    const problems = validateRunnable(graph);
    if (problems.length) return { ok: false, error: problems.join('\n') };
    if (this.activeFor(graph.id)) return { ok: false, error: 'A run is already in progress for this graph.' };
    if (input.fromNodeId && !graph.nodes.some((n) => n.id === input.fromNodeId)) {
      return { ok: false, error: `node ${input.fromNodeId} does not exist` };
    }
    let source: RunMeta | undefined;
    if (input.sourceRunId) {
      source = this.deps.runStore.get(input.sourceRunId);
      if (!source) return { ok: false, error: `run ${input.sourceRunId} not found` };
    }
    const reuse = source ? reusableNodeIds(graph, source, input.fromNodeId) : new Set<string>();

    const meta: RunMeta = { id: this.makeRunId(), graphId: graph.id, status: 'running', startedAt: this.clock(), snapshot: graph, nodes: {} };
    if (source) meta.sourceRunId = source.id;
    if (input.fromNodeId) meta.fromNodeId = input.fromNodeId;
    for (const n of graph.nodes) {
      meta.nodes[n.id] = source && reuse.has(n.id) ? { ...source.nodes[n.id], status: 'reused' } : { status: 'pending' };
    }
    this.deps.runStore.create(meta);
    if (source) for (const id of reuse) this.deps.runStore.copyOutput(source.id, meta.id, id);

    let resolveDone!: (m: RunMeta) => void;
    const done = new Promise<RunMeta>((resolve) => (resolveDone = resolve));
    const run: ActiveRun = { meta, order: topoOrder(graph), running: new Map(), waiting: new Map(), stopping: false, finished: false, resolveDone };
    this.runs.set(meta.id, run);
    this.emit('run', meta);
    this.schedule(run);
    return { ok: true, run: meta, done };
  }

  stop(runId: string): boolean {
    const run = this.runs.get(runId);
    if (!run || run.finished) return false;
    run.stopping = true;
    for (const id of run.order) if (run.meta.nodes[id].status === 'pending') this.setNode(run, id, { status: 'cancelled' });
    this.deps.broker.cancelRun(runId);
    for (const controller of run.running.values()) controller.abort();
    this.schedule(run);
    return true;
  }

  stopAll(): void {
    for (const id of [...this.runs.keys()]) this.stop(id);
  }

  private schedule(run: ActiveRun): void {
    if (run.finished) return;
    if (!run.stopping) {
      for (const id of run.order) {
        if (run.meta.nodes[id].status !== 'pending') continue;
        const parents = upstream(run.meta.snapshot, id).map((p) => run.meta.nodes[p].status);
        if (parents.some((s) => BLOCKED.has(s))) {
          this.setNode(run, id, { status: 'skipped' });
          continue;
        }
        if (parents.every((s) => DONE_OK.has(s)) && run.running.size < this.deps.maxParallel) this.launch(run, id);
      }
    }
    if (run.running.size === 0) this.finish(run);
  }

  private launch(run: ActiveRun, nodeId: string): void {
    const { meta } = run;
    const node = meta.snapshot.nodes.find((n) => n.id === nodeId)!;
    const controller = new AbortController();
    run.running.set(nodeId, controller);
    this.setNode(run, nodeId, { status: 'running', startedAt: this.clock() });
    const startedAt = Date.now();
    const upstreamResults = upstream(meta.snapshot, nodeId).map((parentId) => ({
      node: meta.snapshot.nodes.find((n) => n.id === parentId)!,
      state: meta.nodes[parentId],
      output: this.deps.runStore.readOutput(meta.id, parentId),
      outputPath: this.deps.runStore.outputRelPath(meta.id, parentId),
    }));
    const prompt = node.kind === 'agent' ? buildNodePrompt(meta.snapshot, node, upstreamResults) : '';
    const executor = this.deps.executors[node.kind];
    Promise.resolve()
      .then(() =>
        executor({
          runId: meta.id,
          graph: meta.snapshot,
          node,
          prompt,
          cwd: this.deps.projectDir,
          signal: controller.signal,
          emit: (event) => this.emitEvent(run, nodeId, event),
        }),
      )
      .catch((e: unknown): NodeOutcome => ({ ok: false, output: '', error: e instanceof Error ? e.message : String(e) }))
      .then((outcome) => this.complete(run, nodeId, outcome, Date.now() - startedAt));
  }

  private complete(run: ActiveRun, nodeId: string, outcome: NodeOutcome, durationMs: number): void {
    run.running.delete(nodeId);
    run.waiting.delete(nodeId);
    this.deps.runStore.writeOutput(run.meta.id, nodeId, outcome.output);
    this.emitEvent(run, nodeId, { type: 'result', ok: outcome.ok, durationMs, error: outcome.error, exitCode: outcome.exitCode, usage: outcome.usage });
    const status: NodeStatus = outcome.ok ? 'succeeded' : run.stopping ? 'cancelled' : 'failed';
    this.setNode(run, nodeId, {
      status,
      endedAt: this.clock(),
      durationMs,
      error: outcome.ok ? undefined : outcome.error,
      exitCode: outcome.exitCode,
      usage: outcome.usage,
    });
    this.schedule(run);
  }

  private emitEvent(run: ActiveRun, nodeId: string, body: NodeEventBody): void {
    const event = { ...body, at: this.clock() } as NodeEvent;
    this.deps.runStore.appendEvent(run.meta.id, nodeId, event);
    this.emit('event', run.meta.id, nodeId, event);
    if (!run.running.has(nodeId)) return;
    if (body.type === 'approval_requested') {
      run.waiting.set(nodeId, (run.waiting.get(nodeId) ?? 0) + 1);
      this.setNode(run, nodeId, { status: 'waiting_approval' });
    } else if (body.type === 'approval_decided') {
      const left = Math.max(0, (run.waiting.get(nodeId) ?? 1) - 1);
      run.waiting.set(nodeId, left);
      if (left === 0 && run.meta.nodes[nodeId].status === 'waiting_approval') this.setNode(run, nodeId, { status: 'running' });
    }
  }

  private setNode(run: ActiveRun, nodeId: string, patch: Partial<NodeRunState>): void {
    const state = { ...run.meta.nodes[nodeId], ...patch } as NodeRunState;
    run.meta.nodes[nodeId] = state;
    this.deps.runStore.save(run.meta);
    this.emit('node', run.meta.id, nodeId, state);
  }

  private finish(run: ActiveRun): void {
    if (run.finished) return;
    run.finished = true;
    const statuses = Object.values(run.meta.nodes).map((s) => s.status);
    run.meta.status = run.stopping ? 'cancelled' : statuses.every((s) => DONE_OK.has(s)) ? 'succeeded' : 'failed';
    run.meta.endedAt = this.clock();
    this.deps.runStore.save(run.meta);
    this.runs.delete(run.meta.id);
    this.emit('run', run.meta);
    run.resolveDone(run.meta);
  }
}
```

- [ ] **Step 4: Run the tests and typecheck**

Run: `npm test -w server -- runner && npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add server/src/runner.ts server/test/runner.test.ts
git commit -m "feat(server): runner with parallel scheduling, stop and re-run"
```

---

### Task 11: Planner graph tools (in-process MCP server)

**Files:**
- Create: `server/src/plannerTools.ts`
- Test: `server/test/plannerTools.test.ts`

**Interfaces:**
- Consumes: `GraphStore.apply/get`, `RunStore.list/get/readOutput`, `truncateHead`, `truncateTail`; SDK `tool`, `createSdkMcpServer`, `SdkMcpToolDefinition`; `zod`.
- Produces: `type PlannerToolDeps = { graphStore; runStore; graphId: string; requestRun: (fromNodeId?: string) => string | null }` (returns an error message or null); `summarizeGraph(graph)`; `graphTools(deps): SdkMcpToolDefinition<any>[]` with tools named `get_graph`, `add_node`, `update_node`, `delete_node`, `connect`, `disconnect`, `set_goal`, `request_run`, `get_run`; `createGraphMcpServer(deps)` (server name `graph`).

- [ ] **Step 1: Write the failing tests `server/test/plannerTools.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { GraphStore } from '../src/graphStore';
import { graphTools } from '../src/plannerTools';
import { RunStore } from '../src/runStore';
import { fixedClock, tmpProject } from './helpers';

function setup() {
  const paths = tmpProject();
  const graphStore = new GraphStore(paths, fixedClock());
  const runStore = new RunStore(paths);
  const graphId = graphStore.create('G').id;
  const runRequests: (string | undefined)[] = [];
  let runError: string | null = null;
  const tools = graphTools({
    graphStore,
    runStore,
    graphId,
    requestRun: (fromNodeId) => {
      runRequests.push(fromNodeId);
      return runError;
    },
  });
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const t = tools.find((x) => x.name === name);
    if (!t) throw new Error(`no tool ${name}`);
    const r = await t.handler(args, {});
    return { text: (r.content[0] as { text: string }).text, isError: r.isError === true };
  };
  return { tools, graphStore, runStore, graphId, call, runRequests, failRuns: (e: string | null) => (runError = e) };
}

describe('planner graph tools', () => {
  it('exposes the documented tools', () => {
    expect(setup().tools.map((t) => t.name)).toEqual([
      'get_graph', 'add_node', 'update_node', 'delete_node', 'connect', 'disconnect', 'set_goal', 'request_run', 'get_run',
    ]);
  });

  it('adds agent-authored nodes and wires them after existing ones', async () => {
    const s = setup();
    expect(await s.call('add_node', { kind: 'command', title: 'Build', command: 'dbt build -s orders' })).toEqual({ text: 'Added n1.', isError: false });
    expect(await s.call('add_node', { kind: 'agent', title: 'Check', prompt: 'Check the build.', after: ['n1'] })).toEqual({ text: 'Added n2.', isError: false });
    const g = s.graphStore.get(s.graphId);
    expect(g.nodes.map((n) => [n.id, n.createdBy])).toEqual([['n1', 'agent'], ['n2', 'agent']]);
    expect(g.edges.map((e) => e.id)).toEqual(['n1->n2']);
    expect(s.graphStore.readOps(s.graphId).every((r) => r.by === 'agent')).toBe(true);
  });

  it('keeps the node but reports edges that could not be created', async () => {
    const s = setup();
    expect(await s.call('add_node', { kind: 'agent', title: 'Orphan', prompt: 'x', after: ['n9'] })).toEqual({
      text: 'Added n1, but some edges failed:\nnode n9 does not exist',
      isError: true,
    });
    expect(s.graphStore.get(s.graphId).nodes).toHaveLength(1);
  });

  it('updates, connects, disconnects, deletes and sets the goal', async () => {
    const s = setup();
    await s.call('add_node', { kind: 'agent', title: 'A', prompt: 'a' });
    await s.call('add_node', { kind: 'agent', title: 'B', prompt: 'b' });
    expect(await s.call('update_node', { id: 'n1', prompt: 'better' })).toEqual({ text: 'Updated n1.', isError: false });
    expect(await s.call('connect', { from: 'n1', to: 'n2' })).toEqual({ text: 'Connected n1 -> n2.', isError: false });
    expect(await s.call('connect', { from: 'n2', to: 'n1' })).toEqual({ text: 'connecting n2 -> n1 would create a cycle', isError: true });
    expect(await s.call('disconnect', { from: 'n1', to: 'n2' })).toEqual({ text: 'Disconnected n1 -> n2.', isError: false });
    expect(await s.call('set_goal', { goal: 'Prove parity' })).toEqual({ text: 'Goal updated.', isError: false });
    expect(await s.call('delete_node', { id: 'n2' })).toEqual({ text: 'Deleted n2.', isError: false });
    const g = s.graphStore.get(s.graphId);
    expect(g).toMatchObject({ goal: 'Prove parity', edges: [] });
    expect(g.nodes).toEqual([expect.objectContaining({ id: 'n1', prompt: 'better', updatedBy: 'agent' })]);
  });

  it('returns a compact view of the graph', async () => {
    const s = setup();
    await s.call('add_node', { kind: 'command', title: 'Build', command: 'dbt build' });
    await s.call('add_node', { kind: 'agent', title: 'Check', prompt: 'check', after: ['n1'] });
    expect(JSON.parse((await s.call('get_graph')).text)).toEqual({
      goal: '',
      nodes: [
        { id: 'n1', title: 'Build', kind: 'command', command: 'dbt build', createdBy: 'agent', updatedBy: 'agent' },
        { id: 'n2', title: 'Check', kind: 'agent', prompt: 'check', createdBy: 'agent', updatedBy: 'agent' },
      ],
      edges: ['n1 -> n2'],
    });
  });

  it('asks the user to start runs instead of starting them', async () => {
    const s = setup();
    expect((await s.call('request_run', { fromNodeId: 'n1' })).isError).toBe(false);
    expect(s.runRequests).toEqual(['n1']);
    s.failRuns("The graph can't run yet");
    expect(await s.call('request_run')).toEqual({ text: "The graph can't run yet", isError: true });
  });

  it('summarises the latest run for debugging', async () => {
    const s = setup();
    expect(await s.call('get_run')).toEqual({ text: 'No runs yet.', isError: false });
    await s.call('add_node', { kind: 'command', title: 'Build', command: 'dbt build' });
    const id = '20261002-100000-aaaa';
    s.runStore.create({
      id,
      graphId: s.graphId,
      status: 'failed',
      startedAt: 't',
      snapshot: s.graphStore.get(s.graphId),
      nodes: { n1: { status: 'failed', error: 'exited with code 2' } },
    });
    s.runStore.writeOutput(id, 'n1', 'Compilation Error in model orders');
    const { text } = await s.call('get_run');
    expect(text).toContain(`Run ${id}: failed`);
    expect(text).toContain('## n1 · Build — failed');
    expect(text).toContain('error: exited with code 2');
    expect(text).toContain('Compilation Error in model orders');
    expect(await s.call('get_run', { runId: '20990101-000000-ffff' })).toEqual({ text: 'Run 20990101-000000-ffff not found.', isError: true });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w server -- plannerTools`
Expected: FAIL — `Failed to resolve import "../src/plannerTools"`.

- [ ] **Step 3: Write `server/src/plannerTools.ts`**

```ts
import { createSdkMcpServer, tool, type SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { Graph, Op } from '@claude-stream/shared';
import type { GraphStore } from './graphStore';
import { truncateHead, truncateTail } from './prompt';
import type { RunStore } from './runStore';

export type PlannerToolDeps = {
  graphStore: GraphStore;
  runStore: RunStore;
  graphId: string;
  /** Opens the run confirmation dialog in the browser; returns an error message or null. */
  requestRun: (fromNodeId?: string) => string | null;
};

type ToolReply = { content: { type: 'text'; text: string }[]; isError?: boolean };

const reply = (text: string, isError = false): ToolReply =>
  isError ? { content: [{ type: 'text', text }], isError: true } : { content: [{ type: 'text', text }] };

const kind = z.enum(['agent', 'command']);
const RUN_EXCERPT_CHARS = 2000;

export function summarizeGraph(graph: Graph) {
  return {
    goal: graph.goal,
    nodes: graph.nodes.map(({ id, title, kind: k, prompt, command, timeoutSec, createdBy, updatedBy }) => ({
      id, title, kind: k, prompt, command, timeoutSec, createdBy, updatedBy,
    })),
    edges: graph.edges.map((e) => `${e.from} -> ${e.to}`),
  };
}

/** The planner edits the graph only through these tools; every change is tagged `agent`. */
export function graphTools(d: PlannerToolDeps): SdkMcpToolDefinition<any>[] {
  const apply = (op: Op) => d.graphStore.apply(d.graphId, op, 'agent');
  const outcome = (r: { ok: true } | { ok: false; error: string }, success: string) => (r.ok ? reply(success) : reply(r.error, true));

  return [
    tool('get_graph', 'Return the current workflow graph: goal, nodes (id, title, kind, prompt or command) and edges.', {}, async () =>
      reply(JSON.stringify(summarizeGraph(d.graphStore.get(d.graphId)), null, 2)),
    ),
    tool(
      'add_node',
      'Add a step. kind "agent" runs a separate Claude agent with `prompt`; kind "command" runs the exact shell `command` in the project root. `after` lists ids of steps this one depends on; an edge is created from each.',
      {
        kind,
        title: z.string(),
        prompt: z.string().optional(),
        command: z.string().optional(),
        timeoutSec: z.number().positive().optional(),
        after: z.array(z.string()).optional(),
      },
      async (a) => {
        const r = apply({ type: 'addNode', node: { title: a.title, kind: a.kind, prompt: a.prompt, command: a.command, timeoutSec: a.timeoutSec } });
        if (!r.ok) return reply(r.error, true);
        const id = r.graph.nodes[r.graph.nodes.length - 1].id;
        const errors: string[] = [];
        for (const from of a.after ?? []) {
          const c = apply({ type: 'connect', from, to: id });
          if (!c.ok) errors.push(c.error);
        }
        return errors.length ? reply(`Added ${id}, but some edges failed:\n${errors.join('\n')}`, true) : reply(`Added ${id}.`);
      },
    ),
    tool(
      'update_node',
      'Change fields of a step. Only the fields you pass change.',
      {
        id: z.string(),
        title: z.string().optional(),
        kind: kind.optional(),
        prompt: z.string().optional(),
        command: z.string().optional(),
        timeoutSec: z.number().positive().optional(),
      },
      async ({ id, ...patch }) => outcome(apply({ type: 'updateNode', id, patch }), `Updated ${id}.`),
    ),
    tool('delete_node', 'Delete a step and its edges.', { id: z.string() }, async ({ id }) =>
      outcome(apply({ type: 'deleteNode', id }), `Deleted ${id}.`),
    ),
    tool('connect', 'Make `to` run after `from` and receive its output.', { from: z.string(), to: z.string() }, async ({ from, to }) =>
      outcome(apply({ type: 'connect', from, to }), `Connected ${from} -> ${to}.`),
    ),
    tool('disconnect', 'Remove the edge from `from` to `to`.', { from: z.string(), to: z.string() }, async ({ from, to }) =>
      outcome(apply({ type: 'disconnect', from, to }), `Disconnected ${from} -> ${to}.`),
    ),
    tool('set_goal', 'Set the workflow goal: shared context every agent step receives.', { goal: z.string() }, async ({ goal }) =>
      outcome(apply({ type: 'setGoal', goal }), 'Goal updated.'),
    ),
    tool(
      'request_run',
      "Ask the user to start a run. This opens a confirmation dialog in the user's browser; the user decides whether to start it. Pass fromNodeId to re-run from that step, reusing the latest run's results for unchanged steps.",
      { fromNodeId: z.string().optional() },
      async ({ fromNodeId }) => {
        const error = d.requestRun(fromNodeId);
        return error ? reply(error, true) : reply('Asked the user to confirm the run in the UI. Call get_run later to see results.');
      },
    ),
    tool('get_run', 'Show the latest run (or runId): status of each step, errors, and output excerpts.', { runId: z.string().optional() }, async ({ runId }) => {
      const id = runId ?? d.runStore.list(d.graphId)[0]?.id;
      const meta = id ? d.runStore.get(id) : undefined;
      if (!meta || meta.graphId !== d.graphId) return runId ? reply(`Run ${runId} not found.`, true) : reply('No runs yet.');
      const lines = [`Run ${meta.id}: ${meta.status}`];
      for (const n of meta.snapshot.nodes) {
        const state = meta.nodes[n.id];
        const output = d.runStore.readOutput(meta.id, n.id);
        const excerpt = n.kind === 'command' ? truncateTail(output, RUN_EXCERPT_CHARS) : truncateHead(output, RUN_EXCERPT_CHARS);
        lines.push(`\n## ${n.id} · ${n.title} — ${state?.status ?? 'unknown'}`);
        if (state?.error) lines.push(`error: ${state.error}`);
        if (excerpt.trim()) lines.push(`output:\n${excerpt}`);
      }
      return reply(lines.join('\n'));
    }),
  ];
}

export function createGraphMcpServer(d: PlannerToolDeps) {
  return createSdkMcpServer({ name: 'graph', version: '1.0.0', tools: graphTools(d) });
}
```

- [ ] **Step 4: Run the tests and typecheck**

Run: `npm test -w server -- plannerTools && npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add server/src/plannerTools.ts server/test/plannerTools.test.ts
git commit -m "feat(server): planner graph tools as an in-process MCP server"
```

---

### Task 12: Planner (chat agent)

**Files:**
- Create: `server/src/planner.ts`
- Test: `server/test/planner.test.ts`

**Interfaces:**
- Consumes: `GraphStore`, `RunStore`, `ChatLog`, `createGraphMcpServer`, `sanitizedEnv`, `isSubscriptionAuthSource`, `authSourceError`, `blocksOf`, `realQuery`, `QueryFn`, `Clock`.
- Produces: `PLANNER_APPEND: string`; `describeOp(op): string`; `userEditsPreamble(records: OpRecord[]): string`; `describeToolCall(name, input): string`; `type PlannerDeps = { graphStore; runStore; chatLog; projectDir; claudePath; requestRun: (graphId: string, fromNodeId?: string) => string | null; queryFn?; env?; clock? }`; `class Planner extends EventEmitter` with `send(graphId, text): Promise<void>` (caller must ensure the graph exists), `isBusy(graphId): boolean`; events `'entry'` (graphId, ChatEntry), `'busy'` (graphId, boolean).

- [ ] **Step 1: Write the failing tests `server/test/planner.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { ChatLog } from '../src/chatLog';
import { GraphStore } from '../src/graphStore';
import { Planner, PLANNER_APPEND } from '../src/planner';
import { RunStore } from '../src/runStore';
import type { QueryFn } from '../src/sdk';
import { fixedClock, tmpProject } from './helpers';

const msg = (m: object) => m as unknown as SDKMessage;
const init = (apiKeySource = 'none') => msg({ type: 'system', subtype: 'init', apiKeySource, session_id: 'sess-1' });
const say = (...content: object[]) => msg({ type: 'assistant', parent_tool_use_id: null, message: { content }, session_id: 'sess-1' });
const done = () =>
  msg({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'ok',
    num_turns: 1,
    total_cost_usd: 0,
    usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    session_id: 'sess-1',
  });

function setup(script: (options: Options) => AsyncGenerator<SDKMessage>) {
  const paths = tmpProject();
  const graphStore = new GraphStore(paths, fixedClock());
  const runStore = new RunStore(paths);
  const chatLog = new ChatLog(paths);
  const graphId = graphStore.create('G').id;
  const calls: { prompt: string; options: Options }[] = [];
  const queryFn: QueryFn = ({ prompt, options }) => {
    calls.push({ prompt, options: options! });
    return script(options!);
  };
  const planner = new Planner({
    graphStore,
    runStore,
    chatLog,
    projectDir: paths.root,
    claudePath: '/usr/local/bin/claude',
    requestRun: () => null,
    queryFn,
    clock: fixedClock(),
    env: { PATH: '/bin', ANTHROPIC_API_KEY: 'sk' },
  });
  const busy: boolean[] = [];
  planner.on('busy', (_graphId: string, b: boolean) => busy.push(b));
  const chat = () => chatLog.read(graphId);
  return { paths, graphStore, graphId, planner, calls, busy, chat };
}

describe('Planner', () => {
  it('runs a turn with read-only tools plus graph tools and records the chat', async () => {
    const s = setup(async function* () {
      yield init();
      yield say({ type: 'text', text: 'Here is a plan.' }, { type: 'tool_use', id: 't1', name: 'mcp__graph__add_node', input: { kind: 'agent', title: 'Plan' } });
      yield done();
    });
    await s.planner.send(s.graphId, 'Plan a parity test');
    const o = s.calls[0].options;
    expect(o).toMatchObject({
      cwd: s.paths.root,
      pathToClaudeCodeExecutable: '/usr/local/bin/claude',
      tools: ['Read', 'Glob', 'Grep'],
      allowedTools: ['Read', 'Glob', 'Grep', 'mcp__graph__*'],
      permissionMode: 'dontAsk',
      settingSources: ['project'],
      systemPrompt: { type: 'preset', preset: 'claude_code', append: PLANNER_APPEND },
    });
    expect(o.env).toEqual({ PATH: '/bin' });
    expect(o.resume).toBeUndefined();
    expect(o.mcpServers?.graph).toBeDefined();
    expect(s.calls[0].prompt).toBe('Plan a parity test');
    expect(s.chat().map((e) => [e.role, e.text])).toEqual([
      ['user', 'Plan a parity test'],
      ['assistant', 'Here is a plan.'],
      ['tool', 'add_node {"kind":"agent","title":"Plan"}'],
    ]);
    expect(s.graphStore.get(s.graphId)).toMatchObject({ plannerSessionId: 'sess-1', plannerOpCursor: 0 });
    expect(s.busy).toEqual([true, false]);
  });

  it('resumes the session and tells the planner about user edits since its last turn', async () => {
    const s = setup(async function* () {
      yield init();
      yield done();
    });
    await s.planner.send(s.graphId, 'first');
    s.graphStore.apply(s.graphId, { type: 'addNode', node: { title: 'Mine', kind: 'command', command: 'ls' } }, 'user');
    s.graphStore.apply(s.graphId, { type: 'updateNode', id: 'n1', patch: { title: 'Agent touch' } }, 'agent');
    s.graphStore.apply(s.graphId, { type: 'setGoal', goal: 'ship' }, 'user');
    await s.planner.send(s.graphId, 'second');
    expect(s.calls[1].options.resume).toBe('sess-1');
    expect(s.calls[1].prompt).toBe(
      '[Since your last turn, the user edited the graph:\n- added n1 "Mine" (command)\n- set the goal to "ship"\nCall get_graph for the full current state.]\n\nsecond',
    );
    expect(s.graphStore.get(s.graphId).plannerOpCursor).toBe(3);
  });

  it('rejects a second message while the planner is busy', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const s = setup(async function* () {
      yield init();
      await gate;
      yield done();
    });
    const first = s.planner.send(s.graphId, 'one');
    expect(s.planner.isBusy(s.graphId)).toBe(true);
    await s.planner.send(s.graphId, 'two');
    release();
    await first;
    expect(s.calls).toHaveLength(1);
    expect(s.chat().map((e) => e.role)).toEqual(['user', 'error']);
    expect(s.planner.isBusy(s.graphId)).toBe(false);
  });

  it('stops when the session is not on the subscription', async () => {
    const s = setup(async function* () {
      yield init('apiKeyHelper');
      yield say({ type: 'text', text: 'should not appear' });
      yield done();
    });
    await s.planner.send(s.graphId, 'hi');
    expect(s.chat().map((e) => e.role)).toEqual(['user', 'error']);
    expect(s.chat()[1].text).toContain('"apiKeyHelper"');
    expect(s.graphStore.get(s.graphId).plannerSessionId).toBeUndefined();
  });

  it('resets a broken session so the next message starts fresh', async () => {
    let fail = false;
    const s = setup(async function* () {
      if (fail) throw new Error('No conversation found');
      yield init();
      yield done();
    });
    await s.planner.send(s.graphId, 'one');
    fail = true;
    await s.planner.send(s.graphId, 'two');
    expect(s.graphStore.get(s.graphId).plannerSessionId).toBeUndefined();
    const last = s.chat().at(-1)!;
    expect(last.role).toBe('error');
    expect(last.text).toContain('No conversation found');
    expect(last.text).toContain('reset');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w server -- planner.test`
Expected: FAIL — `Failed to resolve import "../src/planner"`.

- [ ] **Step 3: Write `server/src/planner.ts`**

```ts
import { EventEmitter } from 'node:events';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import type { ChatEntry, ChatRole, Op, OpRecord } from '@claude-stream/shared';
import { authSourceError, isSubscriptionAuthSource, sanitizedEnv } from './auth';
import type { ChatLog } from './chatLog';
import { systemClock, type Clock } from './clock';
import type { GraphStore } from './graphStore';
import { createGraphMcpServer } from './plannerTools';
import type { RunStore } from './runStore';
import { blocksOf, realQuery, type QueryFn } from './sdk';

export const PLANNER_APPEND = `You are the planner inside claude-stream, a local tool where the user and you co-create a workflow graph that is then executed step by step.

How the graph works:
- Each node is a step. kind "agent" is a separate Claude agent run that receives the workflow goal, its own prompt, and the outputs of the nodes it depends on. kind "command" is an exact shell command run in the project root, with no LLM involved.
- An edge from A to B means B runs after A and receives A's output. Nodes with no path between them run in parallel.
- Agent nodes ask the user before every file edit or shell command. Command nodes run exactly as written once the user starts the run.

How to work:
- Build and change plans only through the graph tools (add_node, update_node, delete_node, connect, disconnect, set_goal). Do not just describe a plan in chat.
- Use the read-only tools (Read, Glob, Grep) to ground the plan in the actual project.
- Prefer command nodes for anything that must be reproducible: builds, test runs, timings, queries, diffs. Use agent nodes for judgment: writing code or SQL, analysing results, summarising.
- Make every agent node prompt self-contained: what to do, where, and what to output. Downstream nodes see upstream outputs, not this chat.
- Command nodes never receive upstream output as input. If a command needs something an agent produced, have the agent write it to a file and have the command read that file.
- The user edits the same graph. Respect their edits; you will be told what they changed since your last turn.
- You cannot start runs. Use request_run to ask the user, and get_run to read results when debugging.
- Keep chat replies short; the graph is the plan.`;

export function describeOp(op: Op): string {
  switch (op.type) {
    case 'addNode':
      return `added ${op.node.id ?? 'a node'} "${op.node.title}" (${op.node.kind})`;
    case 'updateNode':
      return `changed ${op.id}: ${Object.entries(op.patch).filter(([, v]) => v !== undefined).map(([k]) => k).join(', ')}`;
    case 'deleteNode':
      return `deleted ${op.id}`;
    case 'connect':
      return `connected ${op.from} -> ${op.to}`;
    case 'disconnect':
      return `disconnected ${op.from} -> ${op.to}`;
    case 'setGoal':
      return `set the goal to "${op.goal}"`;
    case 'moveNode':
      return `moved ${op.id}`;
  }
}

/** Tells the planner what the user changed since its last turn (spec §6). */
export function userEditsPreamble(records: OpRecord[]): string {
  const lines = records.filter((r) => r.by === 'user').map((r) => `- ${describeOp(r.op)}`);
  if (lines.length === 0) return '';
  return `[Since your last turn, the user edited the graph:\n${lines.join('\n')}\nCall get_graph for the full current state.]\n\n`;
}

export function describeToolCall(name: string, input: unknown): string {
  const text = `${name.replace(/^mcp__graph__/, '')} ${JSON.stringify(input)}`;
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

export type PlannerDeps = {
  graphStore: GraphStore;
  runStore: RunStore;
  chatLog: ChatLog;
  projectDir: string;
  claudePath: string;
  requestRun: (graphId: string, fromNodeId?: string) => string | null;
  queryFn?: QueryFn;
  env?: NodeJS.ProcessEnv;
  clock?: Clock;
};

/** The chat agent: one resumable SDK session per graph. Events: 'entry', 'busy'. */
export class Planner extends EventEmitter {
  private busy = new Set<string>();
  private clock: Clock;
  private queryFn: QueryFn;

  constructor(private d: PlannerDeps) {
    super();
    this.clock = d.clock ?? systemClock;
    this.queryFn = d.queryFn ?? realQuery;
  }

  isBusy(graphId: string): boolean {
    return this.busy.has(graphId);
  }

  private add(graphId: string, role: ChatRole, text: string): void {
    const entry: ChatEntry = { at: this.clock(), role, text };
    this.d.chatLog.append(graphId, entry);
    this.emit('entry', graphId, entry);
  }

  async send(graphId: string, text: string): Promise<void> {
    if (this.busy.has(graphId)) {
      this.add(graphId, 'error', 'The planner is still working on your previous message.');
      return;
    }
    this.busy.add(graphId);
    this.emit('busy', graphId, true);
    const abortController = new AbortController();
    try {
      this.add(graphId, 'user', text);
      const graph = this.d.graphStore.get(graphId);
      const ops = this.d.graphStore.readOps(graphId);
      const cursor = ops.length;
      const prompt = userEditsPreamble(ops.slice(graph.plannerOpCursor ?? 0)) + text;
      const options: Options = {
        cwd: this.d.projectDir,
        pathToClaudeCodeExecutable: this.d.claudePath,
        env: sanitizedEnv(this.d.env ?? process.env),
        tools: ['Read', 'Glob', 'Grep'],
        allowedTools: ['Read', 'Glob', 'Grep', 'mcp__graph__*'],
        permissionMode: 'dontAsk',
        settingSources: ['project'],
        mcpServers: {
          graph: createGraphMcpServer({
            graphStore: this.d.graphStore,
            runStore: this.d.runStore,
            graphId,
            requestRun: (fromNodeId) => this.d.requestRun(graphId, fromNodeId),
          }),
        },
        systemPrompt: { type: 'preset', preset: 'claude_code', append: PLANNER_APPEND },
        abortController,
      };
      if (graph.plannerSessionId) options.resume = graph.plannerSessionId;

      let sessionId: string | undefined;
      for await (const message of this.queryFn({ prompt, options })) {
        const m = message as unknown as { type: string; subtype?: string; apiKeySource?: string; session_id?: string; parent_tool_use_id?: string | null; message?: unknown };
        if (m.session_id) sessionId = m.session_id;
        if (m.type === 'system' && m.subtype === 'init' && m.apiKeySource !== undefined && !isSubscriptionAuthSource(m.apiKeySource)) {
          this.add(graphId, 'error', authSourceError(m.apiKeySource));
          abortController.abort();
          return;
        }
        if (message.type === 'assistant' && !m.parent_tool_use_id) {
          for (const b of blocksOf(m.message)) {
            if (b.type === 'text' && b.text?.trim()) this.add(graphId, 'assistant', b.text);
            else if (b.type === 'tool_use' && b.name?.startsWith('mcp__graph__')) this.add(graphId, 'tool', describeToolCall(b.name, b.input));
          }
        }
        if (message.type === 'result') {
          if (message.subtype !== 'success') this.add(graphId, 'error', message.errors.join('\n') || message.subtype);
          else if (message.is_error) this.add(graphId, 'error', message.result || 'The planner reported an error.');
        }
      }
      this.d.graphStore.setPlannerState(graphId, { plannerSessionId: sessionId ?? graph.plannerSessionId, plannerOpCursor: cursor });
    } catch (e) {
      const hadSession = !!this.d.graphStore.load(graphId).ok && !!this.d.graphStore.get(graphId).plannerSessionId;
      if (hadSession) this.d.graphStore.setPlannerState(graphId, { plannerSessionId: undefined });
      const message = e instanceof Error ? e.message : String(e);
      this.add(graphId, 'error', hadSession ? `${message} (The previous planner session was reset; send your message again.)` : message);
    } finally {
      this.busy.delete(graphId);
      this.emit('busy', graphId, false);
    }
  }
}
```

- [ ] **Step 4: Run the tests and typecheck**

Run: `npm test -w server -- planner.test && npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add server/src/planner.ts server/test/planner.test.ts
git commit -m "feat(server): planner chat agent with user-edit awareness and session resume"
```

---

### Task 13: App wiring and client message handling

**Files:**
- Create: `server/src/app.ts`
- Test: `server/test/app.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 3–12.
- Produces: `type Client = { send(msg: ServerMessage): void }`; `type AppDeps = { projectDir; claudePath; auth: AuthInfo; maxParallel; executors?: Executors; queryFn?: QueryFn; clock?: Clock }`; `createApp(deps)` returning `{ connect(client): () => void; handle(client, msg: ClientMessage): Promise<void>; requestRun(graphId, fromNodeId?): string | null; graphStore; runStore; runner; broker; planner }`; `type App = ReturnType<typeof createApp>`. `connect` sends `hello`; `openGraph`/`createGraph` reply with `graphOpened`; graph changes, run updates, node events, approvals and chat are broadcast to every client.

- [ ] **Step 1: Write the failing tests `server/test/app.test.ts`**

```ts
import { describe, expect, it, vi } from 'vitest';
import { emptyGraph, type AuthInfo, type ServerMessage } from '@claude-stream/shared';
import { createApp } from '../src/app';
import type { NodeExecutor } from '../src/executors';
import { RunStore } from '../src/runStore';
import { tmpProject } from './helpers';

const instant: NodeExecutor = async (ctx) => {
  ctx.emit({ type: 'start', kind: ctx.node.kind, cwd: ctx.cwd });
  return { ok: true, output: `out-${ctx.node.id}` };
};
const signedIn: AuthInfo = { ok: true, method: 'claude.ai', plan: 'max', email: 'me@example.com' };

function setup(auth: AuthInfo = signedIn) {
  const paths = tmpProject();
  const app = createApp({
    projectDir: paths.root,
    claudePath: 'claude',
    auth,
    maxParallel: 2,
    executors: { agent: instant, command: instant },
    queryFn: async function* () {},
  });
  const client = () => {
    const msgs: ServerMessage[] = [];
    // Copy like a real WebSocket would serialize: the runner keeps mutating RunMeta after sending.
    const c = { send: (m: ServerMessage) => void msgs.push(structuredClone(m)) };
    app.connect(c);
    const of = <T extends ServerMessage['type']>(type: T) => msgs.filter((m): m is Extract<ServerMessage, { type: T }> => m.type === type);
    return { c, msgs, of };
  };
  return { paths, app, client };
}

describe('app', () => {
  it('greets a client with auth, graphs and pending approvals', () => {
    const { app, client } = setup();
    app.graphStore.create('First');
    expect(client().msgs[0]).toEqual({
      type: 'hello',
      auth: signedIn,
      project: expect.any(String),
      graphs: [{ id: 'first', name: 'First' }],
      approvals: [],
    });
  });

  it('creates graphs, applies user ops and broadcasts the new graph', async () => {
    const { app, client } = setup();
    const a = client();
    const b = client();
    await app.handle(a.c, { type: 'createGraph', name: 'Parity' });
    expect(a.of('graphOpened')[0].graph.id).toBe('parity');
    expect(b.of('graphs').at(-1)?.graphs).toEqual([{ id: 'parity', name: 'Parity' }]);
    await app.handle(a.c, { type: 'op', graphId: 'parity', op: { type: 'addNode', node: { title: 'Plan', kind: 'agent', prompt: 'p' } } });
    expect(b.of('graph').at(-1)?.graph.nodes[0]).toMatchObject({ id: 'n1', createdBy: 'user' });
    await app.handle(a.c, { type: 'op', graphId: 'parity', op: { type: 'connect', from: 'n1', to: 'n1' } });
    expect(a.of('opRejected')).toEqual([{ type: 'opRejected', graphId: 'parity', error: 'a node cannot depend on itself' }]);
    expect(b.of('opRejected')).toEqual([]);
  });

  it('reports unknown graphs', async () => {
    const { app, client } = setup();
    const a = client();
    await app.handle(a.c, { type: 'openGraph', graphId: 'nope' });
    expect(a.of('error')).toEqual([{ type: 'error', message: 'graph "nope" not found' }]);
  });

  it('runs a graph and streams run, node and log updates', async () => {
    const { app, client } = setup();
    const a = client();
    const g = app.graphStore.create('G');
    app.graphStore.apply(g.id, { type: 'addNode', node: { title: 'a', kind: 'agent', prompt: 'p' } }, 'user');
    await app.handle(a.c, { type: 'startRun', graphId: g.id });
    await vi.waitFor(() => expect(a.of('run').at(-1)?.run.status).toBe('succeeded'));
    const runId = a.of('run')[0].run.id;
    expect(a.of('run')[0].run.status).toBe('running');
    expect(a.of('runNode').map((m) => m.state.status)).toEqual(['running', 'succeeded']);
    expect(a.of('nodeEvent').map((m) => m.event.type)).toEqual(['start', 'result']);
    expect(a.of('runs').at(-1)?.runs[0]).toMatchObject({ id: runId, status: 'succeeded' });
    await app.handle(a.c, { type: 'getNodeLogs', runId, nodeId: 'n1' });
    expect(a.of('nodeLogs')[0].events.map((e) => e.type)).toEqual(['start', 'result']);
    await app.handle(a.c, { type: 'selectRun', runId });
    expect(a.of('run').at(-1)).toMatchObject({ select: true, run: { id: runId } });
    await app.handle(a.c, { type: 'openGraph', graphId: g.id });
    expect(a.of('graphOpened')[0]).toMatchObject({ graph: { id: g.id }, chat: [], chatBusy: false, runs: [{ id: runId }], run: { id: runId } });
  });

  it('disables runs and chat when not signed in to a subscription', async () => {
    const { app, client } = setup({ ok: false, error: 'Not signed in.' });
    const a = client();
    const g = app.graphStore.create('G');
    app.graphStore.apply(g.id, { type: 'addNode', node: { title: 'a', kind: 'agent', prompt: 'p' } }, 'user');
    await app.handle(a.c, { type: 'startRun', graphId: g.id });
    await app.handle(a.c, { type: 'chat', graphId: g.id, text: 'hi' });
    expect(a.of('error').map((m) => m.message)).toEqual(['Runs are disabled: Not signed in.', 'Chat is disabled: Not signed in.']);
    expect(a.of('run')).toEqual([]);
  });

  it('passes approval decisions to the broker and broadcasts the queue', async () => {
    const { app, client } = setup();
    const a = client();
    const req = app.broker.request({ runId: 'r', nodeId: 'n1', nodeTitle: 't', toolName: 'Bash', input: {} });
    expect(a.of('approvals').at(-1)?.approvals).toHaveLength(1);
    await app.handle(a.c, { type: 'decide', approvalId: req.id, decision: 'deny', note: 'not now' });
    await expect(req.decision).resolves.toEqual({ decision: 'deny', note: 'not now' });
    expect(a.of('approvals').at(-1)?.approvals).toEqual([]);
  });

  it('asks the browser to confirm planner-requested runs', () => {
    const { app, client } = setup();
    const a = client();
    const g = app.graphStore.create('G');
    app.graphStore.apply(g.id, { type: 'addNode', node: { title: 'a', kind: 'agent', prompt: '' } }, 'agent');
    expect(app.requestRun(g.id)).toContain('needs a prompt');
    app.graphStore.apply(g.id, { type: 'updateNode', id: 'n1', patch: { prompt: 'p' } }, 'agent');
    expect(app.requestRun(g.id, 'n1')).toBe('There is no previous run to re-run from.');
    expect(app.requestRun(g.id)).toBeNull();
    expect(a.of('confirmRun')).toEqual([{ type: 'confirmRun', graphId: g.id }]);
  });

  it('marks runs left running by a previous server as interrupted', () => {
    const paths = tmpProject();
    new RunStore(paths).create({
      id: '20261001-120000-abcd',
      graphId: 'g',
      status: 'running',
      startedAt: 't',
      snapshot: emptyGraph('g', 'G', 't'),
      nodes: { n1: { status: 'running' } },
    });
    const app = createApp({ projectDir: paths.root, claudePath: 'claude', auth: signedIn, maxParallel: 1, executors: { agent: instant, command: instant } });
    expect(app.runStore.get('20261001-120000-abcd')).toMatchObject({ status: 'interrupted', nodes: { n1: { status: 'interrupted' } } });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w server -- app.test`
Expected: FAIL — `Failed to resolve import "../src/app"`.

- [ ] **Step 3: Write `server/src/app.ts`**

```ts
import {
  validateRunnable,
  type ApprovalRequest,
  type AuthInfo,
  type ChatEntry,
  type ClientMessage,
  type Graph,
  type NodeEvent,
  type NodeRunState,
  type RunMeta,
  type ServerMessage,
} from '@claude-stream/shared';
import { createAgentExecutor } from './agentExecutor';
import { ApprovalBroker } from './approvals';
import { ChatLog } from './chatLog';
import { systemClock, type Clock } from './clock';
import { createCommandExecutor } from './commandExecutor';
import type { Executors } from './executors';
import { GraphStore } from './graphStore';
import { ensureDataDirs, projectPaths } from './paths';
import { Planner } from './planner';
import { Runner } from './runner';
import { RunStore } from './runStore';
import type { QueryFn } from './sdk';

export type Client = { send(msg: ServerMessage): void };

export type AppDeps = {
  projectDir: string;
  claudePath: string;
  auth: AuthInfo;
  maxParallel: number;
  executors?: Executors;
  queryFn?: QueryFn;
  clock?: Clock;
};

export type App = ReturnType<typeof createApp>;

export function createApp(d: AppDeps) {
  const clock = d.clock ?? systemClock;
  const paths = projectPaths(d.projectDir);
  ensureDataDirs(paths);
  const graphStore = new GraphStore(paths, clock);
  const chatLog = new ChatLog(paths);
  const runStore = new RunStore(paths);
  runStore.recoverInterrupted(clock());
  const broker = new ApprovalBroker(clock);
  const executors = d.executors ?? {
    agent: createAgentExecutor({ claudePath: d.claudePath, broker, queryFn: d.queryFn }),
    command: createCommandExecutor(),
  };
  const runner = new Runner({ runStore, broker, executors, projectDir: d.projectDir, maxParallel: d.maxParallel, clock });
  const clients = new Set<Client>();
  const broadcast = (msg: ServerMessage) => {
    for (const c of clients) c.send(msg);
  };

  /** Planner's request_run: validate, then let the user confirm in the browser. */
  function requestRun(graphId: string, fromNodeId?: string): string | null {
    const r = graphStore.load(graphId);
    if (!r.ok) return r.error;
    const problems = validateRunnable(r.graph);
    if (problems.length) return `The graph can't run yet:\n${problems.join('\n')}`;
    if (runner.activeFor(graphId)) return 'A run is already in progress.';
    let sourceRunId: string | undefined;
    if (fromNodeId) {
      if (!r.graph.nodes.some((n) => n.id === fromNodeId)) return `node ${fromNodeId} does not exist`;
      sourceRunId = runStore.list(graphId)[0]?.id;
      if (!sourceRunId) return 'There is no previous run to re-run from.';
    }
    broadcast({ type: 'confirmRun', graphId, fromNodeId, sourceRunId });
    return null;
  }

  const planner = new Planner({ graphStore, runStore, chatLog, projectDir: d.projectDir, claudePath: d.claudePath, requestRun, queryFn: d.queryFn, clock });

  graphStore.on('changed', (graph: Graph) => broadcast({ type: 'graph', graph }));
  runner.on('run', (run: RunMeta) => {
    broadcast({ type: 'run', run });
    broadcast({ type: 'runs', graphId: run.graphId, runs: runStore.list(run.graphId) });
  });
  runner.on('node', (runId: string, nodeId: string, state: NodeRunState) => broadcast({ type: 'runNode', runId, nodeId, state }));
  runner.on('event', (runId: string, nodeId: string, event: NodeEvent) => broadcast({ type: 'nodeEvent', runId, nodeId, event }));
  broker.on('changed', (approvals: ApprovalRequest[]) => broadcast({ type: 'approvals', approvals }));
  planner.on('entry', (graphId: string, entry: ChatEntry) => broadcast({ type: 'chatEntry', graphId, entry }));
  planner.on('busy', (graphId: string, busy: boolean) => broadcast({ type: 'chatBusy', graphId, busy }));

  function opened(graph: Graph): ServerMessage {
    const runs = runStore.list(graph.id);
    const run = runner.activeFor(graph.id) ?? (runs[0] ? runStore.get(runs[0].id) : undefined);
    return { type: 'graphOpened', graph, chat: chatLog.read(graph.id), chatBusy: planner.isBusy(graph.id), runs, run };
  }

  function connect(client: Client): () => void {
    clients.add(client);
    client.send({ type: 'hello', auth: d.auth, project: d.projectDir, graphs: graphStore.list(), approvals: broker.pending() });
    return () => {
      clients.delete(client);
    };
  }

  async function handle(client: Client, msg: ClientMessage): Promise<void> {
    const error = (message: string) => client.send({ type: 'error', message });
    switch (msg.type) {
      case 'openGraph': {
        const r = graphStore.load(msg.graphId);
        if (!r.ok) return error(r.error);
        client.send(opened(r.graph));
        return;
      }
      case 'createGraph': {
        const graph = graphStore.create(msg.name);
        broadcast({ type: 'graphs', graphs: graphStore.list() });
        client.send(opened(graph));
        return;
      }
      case 'op': {
        const r = graphStore.apply(msg.graphId, msg.op, 'user');
        if (!r.ok) client.send({ type: 'opRejected', graphId: msg.graphId, error: r.error });
        return;
      }
      case 'chat': {
        if (!d.auth.ok) return error(`Chat is disabled: ${d.auth.error}`);
        const r = graphStore.load(msg.graphId);
        if (!r.ok) return error(r.error);
        void planner.send(msg.graphId, msg.text);
        return;
      }
      case 'startRun': {
        if (!d.auth.ok) return error(`Runs are disabled: ${d.auth.error}`);
        const r = graphStore.load(msg.graphId);
        if (!r.ok) return error(r.error);
        const started = runner.start({ graph: r.graph, sourceRunId: msg.sourceRunId, fromNodeId: msg.fromNodeId });
        if (!started.ok) return error(started.error);
        return;
      }
      case 'stopRun':
        runner.stop(msg.runId);
        return;
      case 'selectRun': {
        const run = runner.get(msg.runId) ?? runStore.get(msg.runId);
        if (!run) return error(`run ${msg.runId} not found`);
        client.send({ type: 'run', run, select: true });
        return;
      }
      case 'getNodeLogs':
        client.send({ type: 'nodeLogs', runId: msg.runId, nodeId: msg.nodeId, events: runStore.readEvents(msg.runId, msg.nodeId) });
        return;
      case 'decide':
        broker.decide(msg.approvalId, msg.decision === 'approve' ? { decision: 'approve' } : { decision: 'deny', note: msg.note });
        return;
    }
  }

  return { connect, handle, requestRun, graphStore, runStore, runner, broker, planner };
}
```

- [ ] **Step 4: Run all server tests and typecheck**

Run: `npm test -w server && npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add server/src/app.ts server/test/app.test.ts
git commit -m "feat(server): app wiring and client message handling"
```

---

### Task 14: HTTP + WebSocket server, CLI and launcher

**Files:**
- Create: `server/src/httpServer.ts`, `server/src/cli.ts`, `server/bin/claude-stream.mjs`
- Modify: `package.json` (root: `bin`, `start` script)
- Test: `server/test/httpServer.test.ts`

**Interfaces:**
- Consumes: `App` (`connect`, `handle`), `Client`, `createApp`, `checkAuth`, `resolveClaudePath`, `parseClientMessage`, `authLabel`.
- Produces: `parseCookies(header): Record<string, string>`; `type HttpServerOptions = { app: Pick<App, 'connect' | 'handle'>; port: number; staticDir: string; token?: string }`; `startHttpServer(options): Promise<{ url: string; port: number; token: string; close(): Promise<void> }>`; CLI `claude-stream [projectDir] [--port 4317] [--max-parallel 3] [--no-open]`.

- [ ] **Step 1: Write the failing tests `server/test/httpServer.test.ts`**

```ts
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import type { ClientMessage } from '@claude-stream/shared';
import type { Client } from '../src/app';
import { parseCookies, startHttpServer } from '../src/httpServer';

const TOKEN = 'test-token-0123456789abcdef';
let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

async function start() {
  const staticDir = mkdtempSync(join(tmpdir(), 'web-'));
  writeFileSync(join(staticDir, 'index.html'), '<html>claude-stream</html>');
  mkdirSync(join(staticDir, 'assets'));
  writeFileSync(join(staticDir, 'assets', 'app.js'), 'console.log(1)');
  const received: ClientMessage[] = [];
  const app = {
    connect: (c: Client) => {
      c.send({ type: 'error', message: 'hello-from-fake' });
      return () => {};
    },
    handle: async (_c: Client, m: ClientMessage) => {
      received.push(m);
    },
  };
  const server = await startHttpServer({ app, port: 0, staticDir, token: TOKEN });
  close = server.close;
  const origin = `http://127.0.0.1:${server.port}`;
  return { server, origin, cookie: `cs_${server.port}=${TOKEN}`, received };
}

describe('http server', () => {
  it('parses cookies', () => {
    expect(parseCookies('a=1; cs_4317=abc; b=%20x')).toEqual({ a: '1', cs_4317: 'abc', b: ' x' });
    expect(parseCookies(undefined)).toEqual({});
  });

  it('requires the launch token', async () => {
    const { server, origin, cookie } = await start();
    expect(server.url).toBe(`${origin}/?token=${TOKEN}`);
    expect((await fetch(`${origin}/`)).status).toBe(401);
    expect((await fetch(`${origin}/?token=wrong`, { redirect: 'manual' })).status).toBe(403);
    const login = await fetch(`${origin}/?token=${TOKEN}`, { redirect: 'manual' });
    expect(login.status).toBe(302);
    expect(login.headers.get('set-cookie')).toBe(`${cookie}; HttpOnly; SameSite=Strict; Path=/`);
    const page = await fetch(`${origin}/`, { headers: { cookie } });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('claude-stream');
    const js = await fetch(`${origin}/assets/app.js`, { headers: { cookie } });
    expect(js.headers.get('content-type')).toContain('text/javascript');
  });

  it('does not serve files outside the web folder', async () => {
    const { origin, cookie } = await start();
    expect((await fetch(`${origin}/..%2f..%2f..%2fetc%2fpasswd`, { headers: { cookie } })).status).toBe(404);
  });

  it('rejects requests with a foreign Host header', async () => {
    const { server, cookie } = await start();
    const status = await new Promise<number>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: server.port, path: '/', headers: { host: 'evil.example', cookie } }, (res) => resolve(res.statusCode ?? 0));
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(403);
  });

  it('accepts WebSocket connections only with the cookie and our origin', async () => {
    const { server, origin, cookie, received } = await start();
    const messages: unknown[] = [];
    const good = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, { origin, headers: { cookie } });
    good.on('message', (data) => messages.push(JSON.parse(data.toString())));
    await new Promise((resolve, reject) => {
      good.once('open', resolve);
      good.once('error', reject);
    });
    await vi.waitFor(() => expect(messages).toEqual([{ type: 'error', message: 'hello-from-fake' }]));
    good.send(JSON.stringify({ type: 'openGraph', graphId: 'g' }));
    good.send('not json');
    await vi.waitFor(() => expect(received).toEqual([{ type: 'openGraph', graphId: 'g' }]));
    await vi.waitFor(() => expect(messages.at(-1)).toEqual({ type: 'error', message: 'message is not valid JSON' }));
    good.close();

    for (const options of [{ origin: 'http://evil.example', headers: { cookie } }, { origin }]) {
      const bad = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, options);
      const status = await new Promise<number>((resolve) => {
        bad.once('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
        bad.once('error', () => resolve(-1));
      });
      expect(status).toBe(403);
    }
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w server -- httpServer`
Expected: FAIL — `Failed to resolve import "../src/httpServer"`.

- [ ] **Step 3: Write `server/src/httpServer.ts`**

```ts
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, resolve, sep } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { parseClientMessage, type ServerMessage } from '@claude-stream/shared';
import type { App, Client } from './app';

const HOST = '127.0.0.1';
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

export type HttpServerOptions = { app: Pick<App, 'connect' | 'handle'>; port: number; staticDir: string; token?: string };
export type RunningServer = { url: string; port: number; token: string; close(): Promise<void> };

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const raw = part.slice(i + 1).trim();
    let value = raw;
    try {
      value = decodeURIComponent(raw);
    } catch {
      // keep the raw value
    }
    out[part.slice(0, i).trim()] = value;
  }
  return out;
}

async function serveStatic(root: string, pathname: string, res: ServerResponse): Promise<void> {
  let path: string;
  try {
    path = decodeURIComponent(pathname);
  } catch {
    res.writeHead(400).end('Bad request');
    return;
  }
  const base = resolve(root);
  const file = resolve(base, `.${path === '/' ? '/index.html' : path}`);
  if (!file.startsWith(base + sep)) {
    res.writeHead(404).end('Not found');
    return;
  }
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' }).end(data);
  } catch {
    if (extname(file)) {
      res.writeHead(404).end('Not found');
      return;
    }
    try {
      const html = await readFile(join(base, 'index.html'));
      res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' }).end(html);
    } catch {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }).end('The web UI is not built. Run `npm run build` in the claude-stream folder.');
    }
  }
}

/**
 * Serves the UI and the WebSocket on 127.0.0.1 only (spec §10). The per-launch token in the
 * printed URL is swapped for an HttpOnly cookie; every request must carry it and our Host,
 * and WebSocket upgrades must also come from our Origin.
 */
export async function startHttpServer(o: HttpServerOptions): Promise<RunningServer> {
  const token = o.token ?? randomBytes(24).toString('hex');
  let port = o.port;
  const hostHeader = () => `${HOST}:${port}`;
  const cookieName = () => `cs_${port}`;
  const tokenMatches = (value: string | null | undefined) => {
    if (!value) return false;
    const a = Buffer.from(value);
    const b = Buffer.from(token);
    return a.length === b.length && timingSafeEqual(a, b);
  };
  const plain = { 'Content-Type': 'text/plain; charset=utf-8' };

  const server = createServer((req, res) => {
    void (async () => {
      if (req.headers.host !== hostHeader()) {
        res.writeHead(403, plain).end('Forbidden');
        return;
      }
      const url = new URL(req.url ?? '/', `http://${hostHeader()}`);
      if (url.searchParams.has('token')) {
        if (!tokenMatches(url.searchParams.get('token'))) {
          res.writeHead(403, plain).end('Invalid token');
          return;
        }
        res.writeHead(302, { 'Set-Cookie': `${cookieName()}=${token}; HttpOnly; SameSite=Strict; Path=/`, Location: '/' }).end();
        return;
      }
      if (!tokenMatches(parseCookies(req.headers.cookie)[cookieName()])) {
        res.writeHead(401, plain).end('Open the URL printed in the terminal where you started claude-stream.');
        return;
      }
      await serveStatic(o.staticDir, url.pathname, res);
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500, plain).end('Internal error');
    });
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const allowed =
      req.url === '/ws' &&
      req.headers.host === hostHeader() &&
      req.headers.origin === `http://${hostHeader()}` &&
      tokenMatches(parseCookies(req.headers.cookie)[cookieName()]);
    if (!allowed) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => attach(ws));
  });

  function attach(ws: WebSocket): void {
    const client: Client = {
      send: (msg: ServerMessage) => {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
      },
    };
    const disconnect = o.app.connect(client);
    ws.on('message', (data) => {
      const parsed = parseClientMessage(data.toString());
      if (!parsed.ok) {
        client.send({ type: 'error', message: parsed.error });
        return;
      }
      o.app.handle(client, parsed.msg).catch((e: unknown) => client.send({ type: 'error', message: e instanceof Error ? e.message : String(e) }));
    });
    ws.on('close', disconnect);
  }

  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(o.port, HOST, () => {
      server.off('error', reject);
      resolveListen();
    });
  });
  port = (server.address() as AddressInfo).port;

  return {
    url: `http://${HOST}:${port}/?token=${token}`,
    port,
    token,
    close: () =>
      new Promise<void>((resolveClose) => {
        for (const ws of wss.clients) ws.terminate();
        wss.close();
        server.closeAllConnections();
        server.close(() => resolveClose());
      }),
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -w server -- httpServer && npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 5: Write the CLI and launcher**

`server/src/cli.ts`:

```ts
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import open from 'open';
import { authLabel } from '@claude-stream/shared';
import { createApp } from './app';
import { checkAuth, resolveClaudePath } from './auth';
import { startHttpServer, type RunningServer } from './httpServer';

const USAGE = `Usage: claude-stream [projectDir] [--port 4317] [--max-parallel 3] [--no-open]

Opens a local page where you and a Claude planner co-edit a workflow graph for projectDir
(default: the current folder) and run it on your Claude subscription.`;

const WEB_DIST = resolve(import.meta.dirname, '../../web/dist');

function fail(message: string): never {
  console.error(`claude-stream: ${message}`);
  process.exit(1);
}

function intOption(value: string, name: string, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) fail(`--${name} must be a whole number from ${min} to ${max}`);
  return n;
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      port: { type: 'string', default: '4317' },
      'max-parallel': { type: 'string', default: '3' },
      'no-open': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return;
  }
  if (positionals.length > 1) fail(`expected at most one project folder\n\n${USAGE}`);
  const projectDir = resolve(positionals[0] ?? '.');
  if (!existsSync(projectDir) || !statSync(projectDir).isDirectory()) fail(`not a folder: ${projectDir}`);
  const port = intOption(values.port, 'port', 0, 65535);
  const maxParallel = intOption(values['max-parallel'], 'max-parallel', 1, 16);

  const claudePath = resolveClaudePath();
  if (!claudePath) fail('could not find `claude` on your PATH. Install Claude Code (https://code.claude.com), sign in with your Claude account, then try again.');
  const auth = await checkAuth(claudePath);
  const app = createApp({ projectDir, claudePath, auth, maxParallel });

  let server: RunningServer;
  try {
    server = await startHttpServer({ app, port, staticDir: WEB_DIST });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EADDRINUSE') fail(`port ${port} is in use; pass --port <another port>`);
    throw e;
  }

  console.log(`claude-stream · ${projectDir}`);
  console.log(auth.ok ? `Signed in: ${authLabel(auth)}` : `${authLabel(auth)}\nRuns and chat are disabled until you sign in; restart claude-stream afterwards.`);
  console.log(`Open: ${server.url}`);
  if (!values['no-open']) await open(server.url);

  const shutdown = async () => {
    app.runner.stopAll();
    await server.close();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
}

main().catch((e: unknown) => fail(e instanceof Error ? e.message : String(e)));
```

`server/bin/claude-stream.mjs`:

```js
#!/usr/bin/env node
import { register } from 'tsx/esm/api';

register();
await import('../src/cli.ts');
```

Run: `chmod +x server/bin/claude-stream.mjs`

In root `package.json`, add a `bin` field and a `start` script (keep everything else, including the devDependencies npm added):

```json
  "bin": { "claude-stream": "server/bin/claude-stream.mjs" },
```

```json
    "start": "node server/bin/claude-stream.mjs"
```

- [ ] **Step 6: Smoke-test the CLI**

Run:

```bash
node server/bin/claude-stream.mjs --help
```

Expected: the usage text.

Run:

```bash
tmp=$(mktemp -d) && (node server/bin/claude-stream.mjs "$tmp" --no-open --port 4399 > "$tmp/cli.log" 2>&1 &) && curl -s -o /dev/null -w '%{http_code}\n' --retry 20 --retry-connrefused --retry-delay 1 http://127.0.0.1:4399/ ; cat "$tmp/cli.log"; pkill -f "claude-stream.mjs $tmp"; ls -a "$tmp/.claude-stream"
```

Expected: `401`, then a log with `Signed in: Claude Max · …` and `Open: http://127.0.0.1:4399/?token=…`, and the data folder listing `.gitignore graphs runs`.

- [ ] **Step 7: Run all tests and commit**

Run: `npm test && npm run typecheck`
Expected: PASS.

```bash
git add package.json server/src/httpServer.ts server/src/cli.ts server/bin/claude-stream.mjs server/test/httpServer.test.ts
git commit -m "feat(server): localhost HTTP/WebSocket server with token cookie, CLI launcher"
```

---

### Task 15: Web client state, layout and run planning

**Files:**
- Modify: `package.json` (add `web` workspace)
- Create: `web/package.json`, `web/tsconfig.json`, `web/src/state.ts`, `web/src/layout.ts`, `web/src/runPlan.ts`
- Test: `web/test/state.test.ts`, `web/test/layout.test.ts`, `web/test/runPlan.test.ts`

**Interfaces:**
- Consumes: shared types, `validateRunnable`, `reusableNodeIds`.
- Produces: `type Tab = 'chat' | 'node' | 'approvals'`; `type ConfirmRequest = { fromNodeId?: string; sourceRunId?: string }`; `type State`; `initialState`; `type Action` (`server`, `disconnected`, `selectNode`, `setTab`, `openConfirm`, `closeConfirm`, `dismissToast`); `reduce(state, action): State`; `logKey(runId, nodeId): string`; `contentSignature(graph): string`; `NODE_WIDTH = 220`, `NODE_HEIGHT = 70`, `layoutPositions(graph, onlyMissing): Map<string, Position>`; `type RunPlan = { problems: string[]; commands: GraphNode[]; agentCount: number; reused: string[]; exact: boolean }`; `describeRunPlan(graph, request: ConfirmRequest, loadedRun?: RunMeta): RunPlan`.

- [ ] **Step 1: Add the web workspace**

In root `package.json`, change `"workspaces": ["shared", "server"]` to `"workspaces": ["shared", "server", "web"]`.

`web/package.json`:

```json
{
  "name": "@claude-stream/web",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": { "test": "vitest run", "typecheck": "tsc -p ." },
  "dependencies": { "@claude-stream/shared": "*" }
}
```

`web/tsconfig.json`:

```json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": { "lib": ["ES2023", "DOM", "DOM.Iterable"], "jsx": "react-jsx" },
  "include": ["src", "test"]
}
```

Run: `npm install -w web @dagrejs/dagre`
Expected: install succeeds.

- [ ] **Step 2: Write the failing tests**

`web/test/state.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { emptyGraph, type Graph, type RunMeta, type ServerMessage } from '@claude-stream/shared';
import { contentSignature, initialState, logKey, reduce, type Action, type State } from '../src/state';

const T = 't';
const graph = (id: string, nodes: string[] = []): Graph => ({
  ...emptyGraph(id, id.toUpperCase(), T),
  nodes: nodes.map((n) => ({ id: n, title: n, kind: 'agent' as const, prompt: 'p', createdBy: 'user' as const, updatedBy: 'user' as const, updatedAt: T })),
});
const run = (id: string, graphId: string, status: RunMeta['status'] = 'running'): RunMeta => ({
  id,
  graphId,
  status,
  startedAt: T,
  snapshot: graph(graphId, ['n1']),
  nodes: { n1: { status: 'pending' } },
});
const server = (msg: ServerMessage): Action => ({ kind: 'server', msg });
const opened = (g: Graph, extra: Partial<Extract<ServerMessage, { type: 'graphOpened' }>> = {}): Action =>
  server({ type: 'graphOpened', graph: g, chat: [], chatBusy: false, runs: [], ...extra });
const apply = (...actions: Action[]): State => actions.reduce(reduce, initialState);

describe('client state', () => {
  it('tracks the connection and account', () => {
    const s = apply(server({ type: 'hello', auth: { ok: true, plan: 'max' }, project: '/p', graphs: [{ id: 'a', name: 'A' }], approvals: [] }));
    expect(s).toMatchObject({ connected: true, auth: { ok: true }, project: '/p', graphs: [{ id: 'a', name: 'A' }] });
    expect(reduce(s, { kind: 'disconnected' }).connected).toBe(false);
  });

  it('switches graphs and resets graph-scoped state', () => {
    const s1 = apply(opened(graph('a', ['n1'])), { kind: 'selectNode', id: 'n1' }, server({ type: 'nodeLogs', runId: 'r', nodeId: 'n1', events: [] }));
    expect(s1).toMatchObject({ selectedNodeId: 'n1', tab: 'node' });
    const same = reduce(s1, opened(graph('a', ['n1'])));
    expect(same.selectedNodeId).toBe('n1');
    expect(same.logs).toEqual({});
    const other = reduce(s1, opened(graph('b')));
    expect(other.graph?.id).toBe('b');
    expect(other.selectedNodeId).toBeUndefined();
  });

  it('applies graph updates only to the open graph', () => {
    const s = apply(opened(graph('a', ['n1', 'n2'])), { kind: 'selectNode', id: 'n2' });
    expect(reduce(s, server({ type: 'graph', graph: graph('b', ['x']) })).graph?.id).toBe('a');
    const updated = reduce(s, server({ type: 'graph', graph: graph('a', ['n1']) }));
    expect(updated.graph?.nodes).toHaveLength(1);
    expect(updated.selectedNodeId).toBeUndefined();
  });

  it('follows new runs, keeps the selected run current and ignores unrelated runs', () => {
    const s = apply(opened(graph('a', ['n1']), { run: run('r1', 'a', 'succeeded') }));
    expect(reduce(s, server({ type: 'run', run: run('r0', 'a', 'failed') })).run?.id).toBe('r1');
    expect(reduce(s, server({ type: 'run', run: run('r0', 'a', 'failed'), select: true })).run?.id).toBe('r0');
    expect(reduce(s, server({ type: 'run', run: run('r9', 'b') })).run?.id).toBe('r1');
    const s2 = reduce(s, server({ type: 'run', run: run('r2', 'a') }));
    expect(s2.run?.id).toBe('r2');
    const s3 = reduce(s2, server({ type: 'runNode', runId: 'r2', nodeId: 'n1', state: { status: 'running' } }));
    expect(s3.run?.nodes.n1.status).toBe('running');
    expect(reduce(s3, server({ type: 'runNode', runId: 'r1', nodeId: 'n1', state: { status: 'failed' } })).run?.nodes.n1.status).toBe('running');
  });

  it('appends live log events only once the log is loaded', () => {
    const event = { at: T, type: 'text' as const, text: 'hi' };
    const s = apply(opened(graph('a')));
    expect(reduce(s, server({ type: 'nodeEvent', runId: 'r', nodeId: 'n1', event })).logs).toEqual({});
    const loaded = reduce(s, server({ type: 'nodeLogs', runId: 'r', nodeId: 'n1', events: [event] }));
    const appended = reduce(loaded, server({ type: 'nodeEvent', runId: 'r', nodeId: 'n1', event: { ...event, text: 'more' } }));
    expect(appended.logs[logKey('r', 'n1')].map((e) => (e.type === 'text' ? e.text : ''))).toEqual(['hi', 'more']);
  });

  it('scopes chat and run confirmations to the open graph', () => {
    const entry = { at: T, role: 'assistant' as const, text: 'plan' };
    const s = apply(opened(graph('a')));
    expect(reduce(s, server({ type: 'chatEntry', graphId: 'b', entry })).chat).toEqual([]);
    expect(reduce(s, server({ type: 'chatEntry', graphId: 'a', entry })).chat).toEqual([entry]);
    expect(reduce(s, server({ type: 'chatBusy', graphId: 'a', busy: true })).chatBusy).toBe(true);
    expect(reduce(s, server({ type: 'confirmRun', graphId: 'a', fromNodeId: 'n2', sourceRunId: 'r1' })).confirm).toEqual({ fromNodeId: 'n2', sourceRunId: 'r1' });
    expect(reduce(s, server({ type: 'confirmRun', graphId: 'b' })).confirm).toBeUndefined();
  });

  it('shows errors and rejected edits as a toast', () => {
    const s = apply(opened(graph('a')));
    expect(reduce(s, server({ type: 'opRejected', graphId: 'a', error: 'cycle' })).toast).toBe('cycle');
    const errored = reduce(s, server({ type: 'error', message: 'boom' }));
    expect(errored.toast).toBe('boom');
    expect(reduce(errored, { kind: 'dismissToast' }).toast).toBeUndefined();
  });

  it('changes the content signature for edits but not for layout', () => {
    const g = graph('a', ['n1']);
    const moved = { ...g, nodes: [{ ...g.nodes[0], position: { x: 5, y: 5 } }] };
    const edited = { ...g, nodes: [{ ...g.nodes[0], prompt: 'other' }] };
    expect(contentSignature(moved)).toBe(contentSignature(g));
    expect(contentSignature(edited)).not.toBe(contentSignature(g));
  });
});
```

`web/test/layout.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { applyOp, emptyGraph, type Graph, type Op } from '@claude-stream/shared';
import { layoutPositions } from '../src/layout';

function graphOf(ops: Op[]): Graph {
  let g = emptyGraph('g', 'G', 't');
  for (const op of ops) {
    const r = applyOp(g, op, 'user', 't');
    if (!r.ok) throw new Error(r.error);
    g = r.graph;
  }
  return g;
}
const agent = (title: string): Op => ({ type: 'addNode', node: { title, kind: 'agent', prompt: 'p' } });

describe('layoutPositions', () => {
  it('lays out a chain from left to right', () => {
    const p = layoutPositions(graphOf([agent('a'), agent('b'), agent('c'), { type: 'connect', from: 'n1', to: 'n2' }, { type: 'connect', from: 'n2', to: 'n3' }]), false);
    expect(p.get('n1')!.x).toBeLessThan(p.get('n2')!.x);
    expect(p.get('n2')!.x).toBeLessThan(p.get('n3')!.x);
  });

  it('only places nodes without a position when asked', () => {
    const g = graphOf([agent('a'), { type: 'addNode', node: { title: 'b', kind: 'agent', prompt: 'p', position: { x: 500, y: 500 } } }]);
    expect([...layoutPositions(g, true).keys()]).toEqual(['n1']);
  });
});
```

`web/test/runPlan.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { applyOp, emptyGraph, type Graph, type Op, type RunMeta } from '@claude-stream/shared';
import { describeRunPlan } from '../src/runPlan';

function graphOf(ops: Op[]): Graph {
  let g = emptyGraph('g', 'G', 't');
  for (const op of ops) {
    const r = applyOp(g, op, 'user', 't');
    if (!r.ok) throw new Error(r.error);
    g = r.graph;
  }
  return g;
}
const cmd = (title: string, command: string): Op => ({ type: 'addNode', node: { title, kind: 'command', command } });
const link = (from: string, to: string): Op => ({ type: 'connect', from, to });
const g = graphOf([
  cmd('Build old', 'dbt build -s orders --target old'),
  cmd('Build new', 'dbt build -s orders_v2'),
  { type: 'addNode', node: { title: 'Compare', kind: 'agent', prompt: 'compare' } },
  link('n1', 'n3'),
  link('n2', 'n3'),
]);

describe('describeRunPlan', () => {
  it('lists every command and counts agent steps for a full run', () => {
    expect(describeRunPlan(g, {})).toEqual({ problems: [], commands: [g.nodes[0], g.nodes[1]], agentCount: 1, reused: [], exact: true });
  });

  it('shows only what a re-run will execute when the source run is loaded', () => {
    const source: RunMeta = {
      id: 'r1',
      graphId: 'g',
      status: 'failed',
      startedAt: 't',
      snapshot: g,
      nodes: { n1: { status: 'succeeded' }, n2: { status: 'succeeded' }, n3: { status: 'failed' } },
    };
    expect(describeRunPlan(g, { fromNodeId: 'n3', sourceRunId: 'r1' }, source)).toMatchObject({ commands: [], agentCount: 1, reused: ['n1', 'n2'], exact: true });
  });

  it('falls back to listing every command when the source run is not loaded', () => {
    expect(describeRunPlan(g, { fromNodeId: 'n3', sourceRunId: 'r9' })).toMatchObject({ commands: [g.nodes[0], g.nodes[1]], exact: false });
  });

  it('reports why a graph cannot run', () => {
    const draft = graphOf([{ type: 'addNode', node: { title: 'x', kind: 'command' } }]);
    expect(describeRunPlan(draft, {}).problems).toEqual(['n1 "x": a command node needs a command.']);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm test -w web`
Expected: FAIL — `Failed to resolve import "../src/state"`.

- [ ] **Step 4: Write `web/src/state.ts`, `web/src/layout.ts`, `web/src/runPlan.ts`**

`web/src/state.ts`:

```ts
import type {
  ApprovalRequest,
  AuthInfo,
  ChatEntry,
  Graph,
  GraphListItem,
  NodeEvent,
  RunMeta,
  RunSummary,
  ServerMessage,
} from '@claude-stream/shared';

export type Tab = 'chat' | 'node' | 'approvals';
export type ConfirmRequest = { fromNodeId?: string; sourceRunId?: string };

export type State = {
  connected: boolean;
  auth?: AuthInfo;
  project?: string;
  graphs: GraphListItem[];
  graph?: Graph;
  runs: RunSummary[];
  /** The run shown on the canvas and in the logs: the latest by default, or one the user picked. */
  run?: RunMeta;
  /** Node logs loaded on demand, keyed by logKey(runId, nodeId). */
  logs: Record<string, NodeEvent[]>;
  approvals: ApprovalRequest[];
  chat: ChatEntry[];
  chatBusy: boolean;
  confirm?: ConfirmRequest;
  selectedNodeId?: string;
  tab: Tab;
  toast?: string;
};

export const initialState: State = { connected: false, graphs: [], runs: [], logs: {}, approvals: [], chat: [], chatBusy: false, tab: 'chat' };

export type Action =
  | { kind: 'server'; msg: ServerMessage }
  | { kind: 'disconnected' }
  | { kind: 'selectNode'; id?: string }
  | { kind: 'setTab'; tab: Tab }
  | { kind: 'openConfirm'; request: ConfirmRequest }
  | { kind: 'closeConfirm' }
  | { kind: 'dismissToast' };

export const logKey = (runId: string, nodeId: string) => `${runId}:${nodeId}`;

/** What a run depends on; positions are layout, not content. */
export function contentSignature(g: Graph): string {
  return JSON.stringify({
    goal: g.goal,
    nodes: g.nodes.map((n) => [n.id, n.kind, n.title, n.prompt ?? '', n.command ?? '', n.timeoutSec ?? null]),
    edges: g.edges.map((e) => e.id).sort(),
  });
}

export function reduce(state: State, action: Action): State {
  switch (action.kind) {
    case 'disconnected':
      return { ...state, connected: false };
    case 'selectNode':
      return { ...state, selectedNodeId: action.id, tab: action.id ? 'node' : state.tab };
    case 'setTab':
      return { ...state, tab: action.tab };
    case 'openConfirm':
      return { ...state, confirm: action.request };
    case 'closeConfirm':
      return { ...state, confirm: undefined };
    case 'dismissToast':
      return { ...state, toast: undefined };
    case 'server':
      return reduceServer(state, action.msg);
  }
}

function reduceServer(state: State, msg: ServerMessage): State {
  const current = state.graph?.id;
  switch (msg.type) {
    case 'hello':
      return { ...state, connected: true, auth: msg.auth, project: msg.project, graphs: msg.graphs, approvals: msg.approvals };
    case 'graphs':
      return { ...state, graphs: msg.graphs };
    case 'graphOpened':
      return {
        ...state,
        graph: msg.graph,
        chat: msg.chat,
        chatBusy: msg.chatBusy,
        runs: msg.runs,
        run: msg.run,
        logs: {},
        confirm: undefined,
        selectedNodeId: current === msg.graph.id ? state.selectedNodeId : undefined,
      };
    case 'graph': {
      if (msg.graph.id !== current) return state;
      const stillThere = msg.graph.nodes.some((n) => n.id === state.selectedNodeId);
      return { ...state, graph: msg.graph, selectedNodeId: stillThere ? state.selectedNodeId : undefined };
    }
    case 'opRejected':
      return msg.graphId === current ? { ...state, toast: msg.error } : state;
    case 'runs':
      return msg.graphId === current ? { ...state, runs: msg.runs } : state;
    case 'run': {
      if (msg.run.graphId !== current) return state;
      const isCurrent = msg.run.id === state.run?.id;
      if (isCurrent || msg.select || msg.run.status === 'running') return { ...state, run: msg.run, logs: isCurrent ? state.logs : {} };
      return state;
    }
    case 'runNode': {
      const run = state.run;
      if (!run || run.id !== msg.runId) return state;
      return { ...state, run: { ...run, nodes: { ...run.nodes, [msg.nodeId]: msg.state } } };
    }
    case 'nodeEvent': {
      const key = logKey(msg.runId, msg.nodeId);
      const existing = state.logs[key];
      return existing ? { ...state, logs: { ...state.logs, [key]: [...existing, msg.event] } } : state;
    }
    case 'nodeLogs':
      return { ...state, logs: { ...state.logs, [logKey(msg.runId, msg.nodeId)]: msg.events } };
    case 'approvals':
      return { ...state, approvals: msg.approvals };
    case 'chatEntry':
      return msg.graphId === current ? { ...state, chat: [...state.chat, msg.entry] } : state;
    case 'chatBusy':
      return msg.graphId === current ? { ...state, chatBusy: msg.busy } : state;
    case 'confirmRun':
      return msg.graphId === current ? { ...state, confirm: { fromNodeId: msg.fromNodeId, sourceRunId: msg.sourceRunId } } : state;
    case 'error':
      return { ...state, toast: msg.message };
  }
}
```

`web/src/layout.ts`:

```ts
import { graphlib, layout } from '@dagrejs/dagre';
import type { Graph, Position } from '@claude-stream/shared';

export const NODE_WIDTH = 220;
export const NODE_HEIGHT = 70;

/** Left-to-right layout. With onlyMissing, returns positions just for nodes that have none. */
export function layoutPositions(graph: Graph, onlyMissing: boolean): Map<string, Position> {
  const g = new graphlib.Graph();
  g.setGraph({ rankdir: 'LR', nodesep: 40, ranksep: 80 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of graph.nodes) g.setNode(n.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  for (const e of graph.edges) g.setEdge(e.from, e.to);
  layout(g);
  const out = new Map<string, Position>();
  for (const n of graph.nodes) {
    if (onlyMissing && n.position) continue;
    const p = g.node(n.id);
    out.set(n.id, { x: Math.round(p.x - NODE_WIDTH / 2), y: Math.round(p.y - NODE_HEIGHT / 2) });
  }
  return out;
}
```

`web/src/runPlan.ts`:

```ts
import { reusableNodeIds, validateRunnable, type Graph, type GraphNode, type RunMeta } from '@claude-stream/shared';
import type { ConfirmRequest } from './state';

export type RunPlan = { problems: string[]; commands: GraphNode[]; agentCount: number; reused: string[]; exact: boolean };

/**
 * What the confirmation dialog shows (spec §7.1). For a re-run it is exact only when the
 * source run is the one loaded in the browser; otherwise it lists every command node.
 */
export function describeRunPlan(graph: Graph, request: ConfirmRequest, loadedRun?: RunMeta): RunPlan {
  const problems = validateRunnable(graph);
  let reused = new Set<string>();
  let exact = true;
  if (request.sourceRunId) {
    if (loadedRun?.id === request.sourceRunId) reused = reusableNodeIds(graph, loadedRun, request.fromNodeId);
    else exact = false;
  }
  const executing = graph.nodes.filter((n) => !reused.has(n.id));
  return {
    problems,
    commands: executing.filter((n) => n.kind === 'command'),
    agentCount: executing.filter((n) => n.kind === 'agent').length,
    reused: [...reused],
    exact,
  };
}
```

- [ ] **Step 5: Run the tests and typecheck**

Run: `npm test -w web && npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json web
git commit -m "feat(web): client state reducer, auto-layout and run planning"
```

---

### Task 16: Web shell — store, socket, top bar and canvas

**Files:**
- Modify: `web/package.json` (build scripts), `web/tsconfig.json` (vite types)
- Create: `web/index.html`, `web/vite.config.ts`, `web/src/main.tsx`, `web/src/store.ts`, `web/src/socket.ts`, `web/src/App.tsx`, `web/src/styles.css`, `web/src/components/TopBar.tsx`, `web/src/components/Canvas.tsx`, `web/src/components/StepNode.tsx`

**Interfaces:**
- Consumes: `reduce`, `initialState`, `contentSignature`, `layoutPositions`, shared `nextNodeId`, `authLabel`, `fmtDuration`.
- Produces: `getState(): State`; `dispatch(action): void`; `useStore(selector)`; `connect(): void`; `send(msg: ClientMessage): void`; components `App`, `TopBar`, `Canvas`, `StepNode`, type `StepFlowNode`.

- [ ] **Step 1: Install UI dependencies and configure the build**

Run:

```bash
npm install -w web react react-dom @xyflow/react && npm install -D -w web vite @vitejs/plugin-react @types/react @types/react-dom
```

In `web/package.json`, replace `"scripts"` with:

```json
  "scripts": { "build": "vite build", "dev": "vite build --watch", "test": "vitest run", "typecheck": "tsc -p ." },
```

In root `package.json` `"scripts"`, add:

```json
    "build": "npm run build -w web",
```

Replace `web/tsconfig.json` with:

```json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": { "lib": ["ES2023", "DOM", "DOM.Iterable"], "jsx": "react-jsx", "types": ["vite/client"] },
  "include": ["src", "test", "vite.config.ts"]
}
```

`web/vite.config.ts`:

```ts
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true },
});
```

`web/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>claude-stream</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 2: Write the store binding and the socket**

`web/src/store.ts`:

```ts
import { useSyncExternalStore } from 'react';
import { initialState, reduce, type Action, type State } from './state';

let state: State = initialState;
const listeners = new Set<() => void>();

export function getState(): State {
  return state;
}

export function dispatch(action: Action): void {
  state = reduce(state, action);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Selectors must return a slice of state (not a new object) so React can compare by reference. */
export function useStore<T>(selector: (s: State) => T): T {
  return useSyncExternalStore(subscribe, () => selector(state));
}
```

`web/src/socket.ts`:

```ts
import type { ClientMessage, ServerMessage } from '@claude-stream/shared';
import { dispatch, getState } from './store';

let ws: WebSocket | undefined;
let attempt = 0;
const queue: string[] = [];

export function connect(): void {
  const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws = socket;
  socket.onopen = () => {
    attempt = 0;
    const graphId = getState().graph?.id;
    if (graphId) socket.send(JSON.stringify({ type: 'openGraph', graphId } satisfies ClientMessage));
    while (queue.length) socket.send(queue.shift()!);
  };
  socket.onmessage = (event) => {
    const msg = JSON.parse(String(event.data)) as ServerMessage;
    dispatch({ kind: 'server', msg });
    if (msg.type === 'hello' && !getState().graph) {
      const first = msg.graphs.find((g) => !g.error);
      if (first) send({ type: 'openGraph', graphId: first.id });
    }
  };
  socket.onclose = () => {
    dispatch({ kind: 'disconnected' });
    setTimeout(connect, Math.min(10_000, 500 * 2 ** attempt++));
  };
}

export function send(msg: ClientMessage): void {
  const data = JSON.stringify(msg);
  if (ws?.readyState === WebSocket.OPEN) ws.send(data);
  else queue.push(data);
}
```

- [ ] **Step 3: Write the canvas components**

`web/src/components/StepNode.tsx`:

```tsx
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { fmtDuration, type GraphNode, type NodeRunState } from '@claude-stream/shared';

export type StepData = { node: GraphNode; state?: NodeRunState; waiting: boolean };
export type StepFlowNode = Node<StepData, 'step'>;

export function StepNode({ data, selected }: NodeProps<StepFlowNode>) {
  const { node, state, waiting } = data;
  const status = state?.status;
  const classes = ['step', `kind-${node.kind}`, status ? `status-${status}` : '', waiting ? 'waiting' : '', selected ? 'selected' : ''];
  return (
    <div className={classes.filter(Boolean).join(' ')}>
      <Handle type="target" position={Position.Left} />
      <div className="step-title">
        <span className="kind-icon">{node.kind === 'agent' ? '✦' : '$'}</span>
        {node.title}
      </div>
      <div className="step-meta">
        <span>{node.id}</span>
        {node.updatedBy === 'agent' && <span className="by-agent">by agent</span>}
        {status && <span className="status">{status.replace('_', ' ')}</span>}
        {state?.durationMs !== undefined && <span>{fmtDuration(state.durationMs)}</span>}
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
```

`web/src/components/Canvas.tsx`:

```tsx
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Background,
  Controls,
  MarkerType,
  MiniMap,
  ReactFlow,
  applyNodeChanges,
  useReactFlow,
  type Connection,
  type Edge as FlowEdge,
  type NodeChange,
  type OnDelete,
  type XYPosition,
} from '@xyflow/react';
import { nextNodeId, type Op } from '@claude-stream/shared';
import { layoutPositions } from '../layout';
import { send } from '../socket';
import { contentSignature } from '../state';
import { dispatch, useStore } from '../store';
import { StepNode, type StepFlowNode } from './StepNode';

const nodeTypes = { step: StepNode };

export function Canvas() {
  const graph = useStore((s) => s.graph);
  const run = useStore((s) => s.run);
  const approvals = useStore((s) => s.approvals);
  const selectedId = useStore((s) => s.selectedNodeId);
  const { screenToFlowPosition } = useReactFlow();
  const wrapper = useRef<HTMLDivElement>(null);
  const [nodes, setNodes] = useState<StepFlowNode[]>([]);
  const runForGraph = run && graph && run.graphId === graph.id ? run : undefined;

  useEffect(() => {
    if (!graph) {
      setNodes([]);
      return;
    }
    const auto = layoutPositions(graph, true);
    setNodes(
      graph.nodes.map((n) => ({
        id: n.id,
        type: 'step',
        position: n.position ?? auto.get(n.id) ?? { x: 0, y: 0 },
        selected: n.id === selectedId,
        data: {
          node: n,
          state: runForGraph?.nodes[n.id],
          waiting: approvals.some((a) => a.nodeId === n.id && a.runId === runForGraph?.id),
        },
      })),
    );
  }, [graph, runForGraph, approvals, selectedId]);

  const edges = useMemo<FlowEdge[]>(
    () =>
      (graph?.edges ?? []).map((e) => ({
        id: e.id,
        source: e.from,
        target: e.to,
        markerEnd: { type: MarkerType.ArrowClosed },
        animated: runForGraph?.nodes[e.to]?.status === 'running',
      })),
    [graph, runForGraph],
  );

  const onNodesChange = useCallback(
    (changes: NodeChange<StepFlowNode>[]) => setNodes((current) => applyNodeChanges(changes.filter((c) => c.type !== 'remove'), current)),
    [],
  );

  if (!graph) return <div className="empty">Create a graph with “+ New” to start.</div>;

  const graphId = graph.id;
  const op = (o: Op) => send({ type: 'op', graphId, op: o });
  const addAt = (position: XYPosition) => {
    const id = nextNodeId(graph);
    op({ type: 'addNode', node: { id, title: 'New step', kind: 'agent', prompt: '', position: { x: Math.round(position.x), y: Math.round(position.y) } } });
    dispatch({ kind: 'selectNode', id });
  };
  const addInCenter = () => {
    const r = wrapper.current?.getBoundingClientRect();
    if (r) addAt(screenToFlowPosition({ x: r.left + r.width / 2, y: r.top + r.height / 2 }));
  };
  const tidy = () => {
    for (const [id, position] of layoutPositions(graph, false)) op({ type: 'moveNode', id, position });
  };
  const onDelete: OnDelete<StepFlowNode, FlowEdge> = ({ nodes: deleted, edges: removed }) => {
    const ids = new Set(deleted.map((n) => n.id));
    for (const e of removed) if (!ids.has(e.source) && !ids.has(e.target)) op({ type: 'disconnect', from: e.source, to: e.target });
    for (const id of ids) op({ type: 'deleteNode', id });
  };
  const stale = runForGraph !== undefined && contentSignature(runForGraph.snapshot) !== contentSignature(graph);

  return (
    <div
      className="canvas"
      ref={wrapper}
      onDoubleClick={(e) => {
        if ((e.target as HTMLElement).classList.contains('react-flow__pane')) addAt(screenToFlowPosition({ x: e.clientX, y: e.clientY }));
      }}
    >
      <div className="canvas-toolbar">
        <button onClick={addInCenter}>+ Step</button>
        <button onClick={tidy}>Tidy</button>
        {stale && <span className="stale">Graph changed since this run started</span>}
      </div>
      <ReactFlow
        key={graphId}
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onConnect={(c: Connection) => op({ type: 'connect', from: c.source, to: c.target })}
        onDelete={onDelete}
        onNodeDragStop={(_e, n) => op({ type: 'moveNode', id: n.id, position: { x: Math.round(n.position.x), y: Math.round(n.position.y) } })}
        onNodeClick={(_e, n) => dispatch({ kind: 'selectNode', id: n.id })}
        onPaneClick={() => dispatch({ kind: 'selectNode' })}
        zoomOnDoubleClick={false}
        deleteKeyCode={['Backspace', 'Delete']}
        fitView
      >
        <Background />
        <Controls />
        <MiniMap pannable zoomable />
      </ReactFlow>
    </div>
  );
}
```

`web/src/components/TopBar.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { authLabel } from '@claude-stream/shared';
import { send } from '../socket';
import { dispatch, useStore } from '../store';

export function TopBar() {
  const connected = useStore((s) => s.connected);
  const auth = useStore((s) => s.auth);
  const graphs = useStore((s) => s.graphs);
  const graph = useStore((s) => s.graph);
  const runs = useStore((s) => s.runs);
  const run = useStore((s) => s.run);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [goal, setGoal] = useState(graph?.goal ?? '');
  useEffect(() => setGoal(graph?.goal ?? ''), [graph?.id, graph?.goal]);
  const running = run?.status === 'running';

  const create = () => {
    if (name.trim()) send({ type: 'createGraph', name: name.trim() });
    setCreating(false);
    setName('');
  };
  const commitGoal = () => {
    if (graph && goal !== graph.goal) send({ type: 'op', graphId: graph.id, op: { type: 'setGoal', goal } });
  };

  return (
    <header className="topbar">
      <span className="brand">claude-stream</span>
      {creating ? (
        <span className="new-graph">
          <input
            autoFocus
            placeholder="Graph name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') create();
              if (e.key === 'Escape') setCreating(false);
            }}
          />
          <button onClick={create}>Create</button>
        </span>
      ) : (
        <>
          <select value={graph?.id ?? ''} onChange={(e) => send({ type: 'openGraph', graphId: e.target.value })}>
            {!graph && <option value="">No graph</option>}
            {graphs.map((g) => (
              <option key={g.id} value={g.id} disabled={!!g.error} title={g.error}>
                {g.name}
                {g.error ? ' (unreadable)' : ''}
              </option>
            ))}
          </select>
          <button onClick={() => setCreating(true)}>+ New</button>
        </>
      )}
      {graph && (
        <input
          className="goal"
          placeholder="Workflow goal: shared context for every agent step"
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          onBlur={commitGoal}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
          }}
        />
      )}
      {graph &&
        (running ? (
          <button className="danger" onClick={() => run && send({ type: 'stopRun', runId: run.id })}>
            Stop
          </button>
        ) : (
          <button className="primary" disabled={!auth?.ok} onClick={() => dispatch({ kind: 'openConfirm', request: {} })}>
            Run
          </button>
        ))}
      {runs.length > 0 && (
        <select value={run?.id ?? ''} onChange={(e) => send({ type: 'selectRun', runId: e.target.value })}>
          {runs.map((r) => (
            <option key={r.id} value={r.id}>
              {r.id} · {r.status}
            </option>
          ))}
        </select>
      )}
      <span className={`auth ${auth?.ok ? 'ok' : 'bad'}`} title={auth?.error}>
        {connected ? (auth ? authLabel(auth) : '…') : 'Disconnected, reconnecting…'}
      </span>
    </header>
  );
}
```

- [ ] **Step 4: Write the app shell, entry point and styles**

`web/src/App.tsx`:

```tsx
import { ReactFlowProvider } from '@xyflow/react';
import { Canvas } from './components/Canvas';
import { TopBar } from './components/TopBar';
import { useStore } from './store';

export function App() {
  const auth = useStore((s) => s.auth);
  return (
    <div className="app">
      <TopBar />
      {auth && !auth.ok && <div className="banner">{auth.error} Restart claude-stream after signing in.</div>}
      <main className="main">
        <ReactFlowProvider>
          <Canvas />
        </ReactFlowProvider>
      </main>
    </div>
  );
}
```

`web/src/main.tsx`:

```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@xyflow/react/dist/style.css';
import './styles.css';
import { App } from './App';
import { connect } from './socket';

connect();
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
```

`web/src/styles.css` (complete stylesheet, including classes used by Task 17's panels):

```css
:root {
  --bg: #f7f7f5;
  --panel: #ffffff;
  --border: #e3e2de;
  --text: #1f1f1d;
  --muted: #6b6a66;
  --accent: #c96442;
  --accent-text: #ffffff;
  --danger: #b42318;
  --ok: #2e7d32;
  --warn: #b26a00;
  --info: #1d5fa8;
  --skip: #8a8a86;
  --code-bg: #f1f0ec;
  font-family: ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif;
  font-size: 14px;
  color: var(--text);
  background: var(--bg);
}

@media (prefers-color-scheme: dark) {
  :root {
    --bg: #1c1b19;
    --panel: #262523;
    --border: #3a3936;
    --text: #ecebe8;
    --muted: #a3a29e;
    --code-bg: #2f2e2b;
  }
}

* { box-sizing: border-box; }
html, body, #root { height: 100%; margin: 0; }
button { font: inherit; padding: 4px 10px; border: 1px solid var(--border); border-radius: 6px; background: var(--panel); color: var(--text); cursor: pointer; }
button:disabled { opacity: 0.5; cursor: default; }
button.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-text); }
button.danger { color: var(--danger); border-color: var(--danger); }
button.link { border: none; background: none; padding: 0; color: var(--info); text-decoration: underline; }
input, select, textarea { font: inherit; color: var(--text); background: var(--panel); border: 1px solid var(--border); border-radius: 6px; padding: 4px 8px; }
textarea { width: 100%; resize: vertical; }
pre, code, .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
pre { background: var(--code-bg); padding: 8px; border-radius: 6px; white-space: pre-wrap; word-break: break-word; margin: 4px 0; max-height: 400px; overflow: auto; }
.muted { color: var(--muted); }
.pad { padding: 16px; }

.app { display: flex; flex-direction: column; height: 100%; }
.topbar { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-bottom: 1px solid var(--border); background: var(--panel); }
.brand { font-weight: 600; margin-right: 8px; }
.new-graph { display: flex; gap: 6px; }
.goal { flex: 1; min-width: 120px; }
.auth { margin-left: auto; font-size: 12px; white-space: nowrap; }
.auth.ok { color: var(--ok); }
.auth.bad { color: var(--danger); }
.banner { padding: 8px 12px; background: rgba(180, 35, 24, 0.1); color: var(--danger); border-bottom: 1px solid var(--border); }
.main { flex: 1; display: flex; min-height: 0; }

.canvas { flex: 1; position: relative; min-width: 0; }
.canvas-toolbar { position: absolute; z-index: 5; top: 8px; left: 8px; display: flex; gap: 6px; align-items: center; }
.stale { font-size: 12px; color: var(--warn); background: var(--panel); border: 1px solid var(--border); border-radius: 6px; padding: 2px 8px; }
.empty { flex: 1; display: grid; place-items: center; color: var(--muted); }

.step { width: 220px; min-height: 70px; padding: 8px 10px; border-radius: 8px; border: 2px solid var(--border); background: var(--panel); color: var(--text); box-shadow: 0 1px 2px rgba(0, 0, 0, 0.06); }
.step.selected { outline: 2px solid var(--accent); outline-offset: 2px; }
.step-title { font-weight: 600; display: flex; gap: 6px; align-items: baseline; overflow-wrap: anywhere; }
.kind-icon { color: var(--muted); font-family: ui-monospace, monospace; }
.step-meta { margin-top: 6px; display: flex; flex-wrap: wrap; gap: 6px; font-size: 11px; color: var(--muted); }
.by-agent { color: var(--info); }
.status-running { border-color: var(--info); }
.status-waiting_approval, .step.waiting { border-color: var(--warn); animation: pulse 1.2s ease-in-out infinite; }
.status-succeeded, .status-reused { border-color: var(--ok); }
.status-failed, .status-interrupted { border-color: var(--danger); }
.status-skipped, .status-cancelled { border-color: var(--skip); border-style: dashed; }
@keyframes pulse { 50% { box-shadow: 0 0 0 4px rgba(178, 106, 0, 0.25); } }

.right { width: 440px; display: flex; flex-direction: column; border-left: 1px solid var(--border); background: var(--panel); min-height: 0; }
.tabs { display: flex; border-bottom: 1px solid var(--border); }
.tabs button { flex: 1; border: none; border-radius: 0; background: none; padding: 8px; }
.tabs button.active { border-bottom: 2px solid var(--accent); font-weight: 600; }
.tabs button.attention { color: var(--warn); font-weight: 600; }
.tab-body { flex: 1; min-height: 0; overflow: auto; display: flex; flex-direction: column; }

.chat { display: flex; flex-direction: column; height: 100%; }
.chat-log { flex: 1; overflow: auto; padding: 12px; display: flex; flex-direction: column; gap: 8px; }
.msg { white-space: pre-wrap; padding: 8px 10px; border-radius: 8px; max-width: 95%; overflow-wrap: anywhere; }
.msg.user { align-self: flex-end; background: var(--accent); color: var(--accent-text); }
.msg.assistant { background: var(--code-bg); }
.msg.tool { font-size: 12px; color: var(--muted); padding: 2px 10px; }
.msg.error { color: var(--danger); border: 1px solid var(--danger); }
.msg.busy { color: var(--muted); font-style: italic; }
.chat-input { display: flex; gap: 8px; padding: 8px; border-top: 1px solid var(--border); align-items: flex-end; }
.chat-input textarea { min-height: 60px; }

.node-panel { padding: 12px; display: flex; flex-direction: column; gap: 10px; }
.subtabs { display: flex; gap: 6px; }
.subtabs button.active { border-color: var(--accent); color: var(--accent); }
.field { display: flex; flex-direction: column; gap: 4px; }
.field label { font-size: 12px; color: var(--muted); }
.notice { font-size: 12px; color: var(--warn); }
.actions { display: flex; gap: 8px; flex-wrap: wrap; }

.logs { display: flex; flex-direction: column; gap: 8px; }
.log-status .error, .ev.error, .ev.final.error, .ev.result.error { color: var(--danger); }
.logview { display: flex; flex-direction: column; gap: 6px; }
.ev { font-size: 13px; }
.ev .t { color: var(--muted); font-size: 11px; margin-right: 6px; }
.ev.text .body { white-space: pre-wrap; margin-top: 2px; }
.ev.approval { color: var(--warn); }
.ev.approval.approve, .ev.final.ok { color: var(--ok); }
.stream.stderr { color: var(--danger); }

.approvals { padding: 12px; display: flex; flex-direction: column; gap: 12px; }
.approval-card { border: 1px solid var(--warn); border-radius: 8px; padding: 10px; display: flex; flex-direction: column; gap: 8px; }
.diff.del { background: rgba(180, 35, 24, 0.08); }
.diff.add { background: rgba(46, 125, 50, 0.08); }
.approval-actions { display: flex; justify-content: flex-end; gap: 8px; }

.modal-backdrop { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.35); display: grid; place-items: center; z-index: 50; }
.modal { background: var(--panel); border-radius: 10px; padding: 20px; width: min(640px, 92vw); max-height: 85vh; overflow: auto; display: flex; flex-direction: column; gap: 10px; }
.modal h2 { margin: 0; font-size: 18px; }
.modal-actions { display: flex; justify-content: flex-end; gap: 8px; }
.toast { position: fixed; bottom: 16px; left: 50%; transform: translateX(-50%); background: var(--text); color: var(--bg); padding: 8px 14px; border-radius: 8px; z-index: 60; cursor: pointer; max-width: 80vw; white-space: pre-wrap; }
```

- [ ] **Step 5: Build, typecheck and smoke-test**

Run: `npm run build && npm run typecheck && npm test`
Expected: Vite writes `web/dist/index.html` and assets; typecheck and tests PASS.

Run:

```bash
tmp=$(mktemp -d) && (node server/bin/claude-stream.mjs "$tmp" --no-open --port 4399 > "$tmp/cli.log" 2>&1 &) && url=$(curl -s --retry 20 --retry-connrefused --retry-delay 1 -o /dev/null -w '' http://127.0.0.1:4399/; grep -o 'http://127.0.0.1:4399/?token=[0-9a-f]*' "$tmp/cli.log") && curl -s -c "$tmp/jar" -b "$tmp/jar" -L "$url" | grep -o '<title>claude-stream</title>'; pkill -f "claude-stream.mjs $tmp"
```

Expected: `<title>claude-stream</title>` (the token login sets the cookie and the built page is served).

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json web
git commit -m "feat(web): app shell with top bar and editable React Flow canvas"
```

---

### Task 17: Right panel — chat, node editor and logs, approvals, run dialog

**Files:**
- Create: `web/src/components/RightPanel.tsx`, `web/src/components/ChatPanel.tsx`, `web/src/components/NodePanel.tsx`, `web/src/components/LogView.tsx`, `web/src/components/ApprovalsPanel.tsx`, `web/src/components/RunConfirmDialog.tsx`, `web/src/components/Toast.tsx`
- Modify: `web/src/App.tsx`

**Interfaces:**
- Consumes: `useStore`, `dispatch`, `send`, `logKey`, `describeRunPlan`, shared `fmtDuration`, types.
- Produces: components `RightPanel`, `ChatPanel`, `NodePanel`, `LogView`, `ApprovalsPanel`, `RunConfirmDialog`, `Toast`; `LOG_STREAM_CAP = 200_000` (characters of stdout/stderr shown per block).

- [ ] **Step 1: Write the panels**

`web/src/components/LogView.tsx`:

```tsx
import { useState, type ReactNode } from 'react';
import { fmtDuration, type NodeEvent } from '@claude-stream/shared';

export const LOG_STREAM_CAP = 200_000;

const pretty = (value: unknown) => {
  try {
    return JSON.stringify(value, null, 2) ?? '';
  } catch {
    return String(value);
  }
};

function Collapsible({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > 600;
  return (
    <div className="collapsible">
      <pre>{open || !long ? text : `${text.slice(0, 600)}…`}</pre>
      {long && (
        <button className="link" onClick={() => setOpen(!open)}>
          {open ? 'Show less' : `Show all (${text.length} chars)`}
        </button>
      )}
    </div>
  );
}

function LogEvent({ event: e }: { event: NodeEvent }) {
  const time = <span className="t">{new Date(e.at).toLocaleTimeString()}</span>;
  switch (e.type) {
    case 'start':
      return (
        <div className="ev start">
          {time}Started {e.kind} step in <code>{e.cwd}</code>
          {e.command && <pre>{e.command}</pre>}
          {e.prompt && (
            <details>
              <summary>Prompt sent to the agent</summary>
              <pre>{e.prompt}</pre>
            </details>
          )}
        </div>
      );
    case 'text':
      return (
        <div className="ev text">
          {time}
          <div className="body">{e.text}</div>
        </div>
      );
    case 'tool_call':
      return (
        <div className="ev tool">
          {time}→ <b>{e.name}</b>
          <Collapsible text={pretty(e.input)} />
        </div>
      );
    case 'tool_result':
      return (
        <div className={`ev result ${e.isError ? 'error' : ''}`}>
          {time}← result
          <Collapsible text={e.content} />
        </div>
      );
    case 'approval_requested':
      return (
        <div className="ev approval">
          {time}⏸ Waiting for your approval: <b>{e.toolName}</b>
        </div>
      );
    case 'approval_decided':
      return (
        <div className={`ev approval ${e.decision}`}>
          {time}
          {e.decision === 'approve' ? '✔ Approved' : e.decision === 'deny' ? `✖ Denied${e.note ? `: ${e.note}` : ''}` : '■ Cancelled (run stopped)'}
        </div>
      );
    case 'retry':
      return (
        <div className="ev retry">
          {time}↻ API retry {e.attempt}/{e.maxRetries}: {e.error}
        </div>
      );
    case 'result': {
      const usage = e.usage
        ? ` · ${e.usage.inputTokens + e.usage.cacheReadTokens + e.usage.cacheWriteTokens} in / ${e.usage.outputTokens} out tokens · ${e.usage.turns} turns · ~$${e.usage.costUsd.toFixed(2)} API-equivalent`
        : '';
      const exit = e.exitCode !== undefined && e.exitCode !== null ? ` · exit ${e.exitCode}` : '';
      return (
        <div className={`ev final ${e.ok ? 'ok' : 'error'}`}>
          {time}
          {e.ok ? '✔ Succeeded' : `✖ Failed${e.error ? `: ${e.error}` : ''}`} · {fmtDuration(e.durationMs)}
          {exit}
          {usage}
        </div>
      );
    }
    case 'error':
      return (
        <div className="ev error">
          {time}
          {e.message}
        </div>
      );
    default:
      return null;
  }
}

/** Renders a node's events; consecutive stdout/stderr chunks merge into one block. */
export function LogView({ events }: { events: NodeEvent[] }) {
  const items: ReactNode[] = [];
  let stream: { kind: 'stdout' | 'stderr'; text: string } | undefined;
  const flush = (key: number) => {
    if (!stream) return;
    const text =
      stream.text.length > LOG_STREAM_CAP
        ? `…[earlier output hidden; the full output is in output.md]\n${stream.text.slice(-LOG_STREAM_CAP)}`
        : stream.text;
    items.push(
      <pre key={`s${key}`} className={`stream ${stream.kind}`}>
        {text}
      </pre>,
    );
    stream = undefined;
  };
  events.forEach((e, i) => {
    if (e.type === 'stdout' || e.type === 'stderr') {
      if (stream && stream.kind === e.type) stream.text += e.chunk;
      else {
        flush(i);
        stream = { kind: e.type, text: e.chunk };
      }
      return;
    }
    flush(i);
    items.push(<LogEvent key={i} event={e} />);
  });
  flush(events.length);
  return <div className="logview">{items}</div>;
}
```

`web/src/components/ChatPanel.tsx`:

```tsx
import { useEffect, useRef, useState } from 'react';
import { send } from '../socket';
import { useStore } from '../store';

export function ChatPanel() {
  const chat = useStore((s) => s.chat);
  const busy = useStore((s) => s.chatBusy);
  const graph = useStore((s) => s.graph);
  const auth = useStore((s) => s.auth);
  const [text, setText] = useState('');
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => end.current?.scrollIntoView({ block: 'end' }), [chat.length, busy]);
  const canType = !!graph && !!auth?.ok;
  const submit = () => {
    const t = text.trim();
    if (!t || !graph || !canType || busy) return;
    send({ type: 'chat', graphId: graph.id, text: t });
    setText('');
  };
  return (
    <div className="chat">
      <div className="chat-log">
        {chat.length === 0 && (
          <p className="muted">Describe what you want done. The planner draws the plan on the canvas; edit it freely, then press Run.</p>
        )}
        {chat.map((e, i) => (
          <div key={i} className={`msg ${e.role}`}>
            {e.role === 'tool' ? <code>{e.text}</code> : e.text}
          </div>
        ))}
        {busy && <div className="msg busy">Planner is working…</div>}
        <div ref={end} />
      </div>
      <div className="chat-input">
        <textarea
          value={text}
          disabled={!canType}
          placeholder={canType ? 'Ask the planner… (Enter to send, Shift+Enter for a new line)' : 'Chat is unavailable until you sign in to Claude.'}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <button className="primary" disabled={!canType || busy || !text.trim()} onClick={submit}>
          Send
        </button>
      </div>
    </div>
  );
}
```

`web/src/components/NodePanel.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { fmtDuration, type GraphNode, type NodeKind, type NodePatch } from '@claude-stream/shared';
import { send } from '../socket';
import { logKey } from '../state';
import { dispatch, useStore } from '../store';
import { LogView } from './LogView';

type Draft = { title: string; kind: NodeKind; prompt: string; command: string; timeoutSec: string };

const toDraft = (n: GraphNode): Draft => ({
  title: n.title,
  kind: n.kind,
  prompt: n.prompt ?? '',
  command: n.command ?? '',
  timeoutSec: n.timeoutSec ? String(n.timeoutSec) : '',
});
const sameDraft = (a: Draft, b: Draft) => JSON.stringify(a) === JSON.stringify(b);

export function NodePanel() {
  const graph = useStore((s) => s.graph);
  const selectedId = useStore((s) => s.selectedNodeId);
  const [view, setView] = useState<'edit' | 'logs'>('edit');
  const node = graph?.nodes.find((n) => n.id === selectedId);
  if (!graph || !node) return <p className="muted pad">Select a step on the canvas, or double-click empty canvas to add one.</p>;
  return (
    <div className="node-panel">
      <div className="subtabs">
        <button className={view === 'edit' ? 'active' : ''} onClick={() => setView('edit')}>
          Edit
        </button>
        <button className={view === 'logs' ? 'active' : ''} onClick={() => setView('logs')}>
          Logs
        </button>
      </div>
      {view === 'edit' ? <NodeEditor key={node.id} graphId={graph.id} node={node} /> : <NodeLogs node={node} />}
    </div>
  );
}

/** Edits a local draft; if someone else changes the node meanwhile, the user decides. */
function NodeEditor({ graphId, node }: { graphId: string; node: GraphNode }) {
  const run = useStore((s) => s.run);
  const runs = useStore((s) => s.runs);
  const [base, setBase] = useState(() => ({ draft: toDraft(node), at: node.updatedAt }));
  const [draft, setDraft] = useState<Draft>(base.draft);
  const dirty = !sameDraft(draft, base.draft);
  const changedUnderneath = node.updatedAt !== base.at;

  useEffect(() => {
    if (changedUnderneath && !dirty) {
      const fresh = toDraft(node);
      setBase({ draft: fresh, at: node.updatedAt });
      setDraft(fresh);
    }
  }, [changedUnderneath, dirty, node]);

  const discard = () => {
    const fresh = toDraft(node);
    setBase({ draft: fresh, at: node.updatedAt });
    setDraft(fresh);
  };
  const save = () => {
    const patch: NodePatch = {};
    if (draft.title !== base.draft.title) patch.title = draft.title;
    if (draft.kind !== base.draft.kind) patch.kind = draft.kind;
    if (draft.prompt !== base.draft.prompt) patch.prompt = draft.prompt;
    if (draft.command !== base.draft.command) patch.command = draft.command;
    const timeout = Number(draft.timeoutSec);
    if (draft.timeoutSec !== base.draft.timeoutSec && timeout > 0) patch.timeoutSec = timeout;
    send({ type: 'op', graphId, op: { type: 'updateNode', id: node.id, patch } });
    setBase({ draft, at: node.updatedAt });
  };
  const latest = runs[0];
  const running = run?.status === 'running';

  return (
    <>
      {changedUnderneath && dirty && (
        <p className="notice">
          This step changed since you started editing; saving overwrites those changes.{' '}
          <button className="link" onClick={discard}>
            Discard my edits
          </button>
        </p>
      )}
      <div className="field">
        <label>Title</label>
        <input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
      </div>
      <div className="field">
        <label>Kind</label>
        <select value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value as NodeKind })}>
          <option value="agent">Agent: a Claude agent run</option>
          <option value="command">Command: an exact shell command</option>
        </select>
      </div>
      {draft.kind === 'agent' ? (
        <div className="field">
          <label>Prompt</label>
          <textarea
            rows={12}
            value={draft.prompt}
            placeholder="What this step should do, where, and what it should output."
            onChange={(e) => setDraft({ ...draft, prompt: e.target.value })}
          />
        </div>
      ) : (
        <>
          <div className="field">
            <label>Command (runs in the project folder)</label>
            <textarea rows={4} className="mono" value={draft.command} onChange={(e) => setDraft({ ...draft, command: e.target.value })} />
          </div>
          <div className="field">
            <label>Timeout in seconds (default 1800)</label>
            <input value={draft.timeoutSec} inputMode="numeric" onChange={(e) => setDraft({ ...draft, timeoutSec: e.target.value })} />
          </div>
        </>
      )}
      <p className="muted">
        {node.id} · created by {node.createdBy} · last edited by {node.updatedBy}
      </p>
      <div className="actions">
        <button className="primary" disabled={!dirty} onClick={save}>
          Save
        </button>
        <button
          disabled={!latest || running}
          title={latest ? `Run this step and everything after it again, reusing run ${latest.id} for the rest` : 'Run the graph once first'}
          onClick={() => latest && dispatch({ kind: 'openConfirm', request: { fromNodeId: node.id, sourceRunId: latest.id } })}
        >
          Re-run from here
        </button>
        <button className="danger" onClick={() => send({ type: 'op', graphId, op: { type: 'deleteNode', id: node.id } })}>
          Delete
        </button>
      </div>
    </>
  );
}

function NodeLogs({ node }: { node: GraphNode }) {
  const run = useStore((s) => s.run);
  const state = run?.nodes[node.id];
  const key = run ? logKey(run.id, node.id) : '';
  const events = useStore((s) => (key ? s.logs[key] : undefined));
  const runId = run?.id;
  const hasState = state !== undefined;
  const loaded = events !== undefined;
  useEffect(() => {
    if (runId && hasState && !loaded) send({ type: 'getNodeLogs', runId, nodeId: node.id });
  }, [runId, node.id, hasState, loaded]);

  if (!run || !state) return <p className="muted">This step has no logs in the selected run.</p>;
  const sourceRunId = run.sourceRunId;
  return (
    <div className="logs">
      <div className="log-status">
        Run {run.id} · <b>{state.status.replace('_', ' ')}</b>
        {state.durationMs !== undefined && ` · ${fmtDuration(state.durationMs)}`}
        {state.error && <div className="error">{state.error}</div>}
        {state.status === 'reused' && sourceRunId && (
          <div>
            Reused from run {sourceRunId}.{' '}
            <button className="link" onClick={() => send({ type: 'selectRun', runId: sourceRunId })}>
              Open that run
            </button>
          </div>
        )}
      </div>
      {events ? <LogView events={events} /> : <p className="muted">Loading…</p>}
    </div>
  );
}
```

`web/src/components/ApprovalsPanel.tsx`:

```tsx
import { useState, type ReactNode } from 'react';
import type { ApprovalRequest } from '@claude-stream/shared';
import { send } from '../socket';
import { dispatch, useStore } from '../store';

function ApprovalCard({ request: a }: { request: ApprovalRequest }) {
  const [note, setNote] = useState('');
  const input = (a.input ?? {}) as Record<string, unknown>;
  const str = (key: string) => (typeof input[key] === 'string' ? (input[key] as string) : undefined);
  let body: ReactNode;
  if (a.toolName === 'Bash') {
    body = (
      <>
        {str('description') && <p>{str('description')}</p>}
        <pre className="mono">{str('command')}</pre>
      </>
    );
  } else if (a.toolName === 'Edit') {
    body = (
      <>
        <p>
          <code>{str('file_path')}</code>
        </p>
        <pre className="diff del">{str('old_string')}</pre>
        <pre className="diff add">{str('new_string')}</pre>
      </>
    );
  } else if (a.toolName === 'Write') {
    body = (
      <>
        <p>
          <code>{str('file_path')}</code>
        </p>
        <pre className="diff add">{str('content')}</pre>
      </>
    );
  } else {
    body = <pre>{JSON.stringify(a.input, null, 2)}</pre>;
  }
  return (
    <div className="approval-card">
      <div>
        <button className="link" onClick={() => dispatch({ kind: 'selectNode', id: a.nodeId })}>
          {a.nodeId} · {a.nodeTitle}
        </button>{' '}
        wants to use <b>{a.toolName}</b>
      </div>
      {body}
      <input placeholder="Note for the agent (optional, sent when you deny)" value={note} onChange={(e) => setNote(e.target.value)} />
      <div className="approval-actions">
        <button className="danger" onClick={() => send({ type: 'decide', approvalId: a.id, decision: 'deny', note: note.trim() || undefined })}>
          Deny
        </button>
        <button className="primary" onClick={() => send({ type: 'decide', approvalId: a.id, decision: 'approve' })}>
          Approve
        </button>
      </div>
    </div>
  );
}

export function ApprovalsPanel() {
  const approvals = useStore((s) => s.approvals);
  if (approvals.length === 0) return <p className="muted pad">Nothing is waiting for approval.</p>;
  return (
    <div className="approvals">
      {approvals.map((a) => (
        <ApprovalCard key={a.id} request={a} />
      ))}
    </div>
  );
}
```

`web/src/components/RunConfirmDialog.tsx`:

```tsx
import { describeRunPlan } from '../runPlan';
import { send } from '../socket';
import { dispatch, useStore } from '../store';

export function RunConfirmDialog() {
  const confirm = useStore((s) => s.confirm);
  const graph = useStore((s) => s.graph);
  const run = useStore((s) => s.run);
  if (!confirm || !graph) return null;
  const plan = describeRunPlan(graph, confirm, run);
  const close = () => dispatch({ kind: 'closeConfirm' });
  const start = () => {
    send({ type: 'startRun', graphId: graph.id, fromNodeId: confirm.fromNodeId, sourceRunId: confirm.sourceRunId });
    close();
  };
  return (
    <div className="modal-backdrop" onClick={close}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>{confirm.fromNodeId ? `Re-run from ${confirm.fromNodeId}` : 'Run workflow'}</h2>
        {plan.problems.length > 0 ? (
          <>
            <p>This graph can't run yet:</p>
            <ul>
              {plan.problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </>
        ) : (
          <>
            <p>
              {plan.agentCount} agent step{plan.agentCount === 1 ? '' : 's'} will run. Every file edit or shell command they attempt waits for your
              approval.
            </p>
            {plan.commands.length > 0 ? (
              <>
                <p>These commands will run exactly as written:</p>
                {plan.commands.map((n) => (
                  <div key={n.id}>
                    <div>
                      {n.id} · {n.title}
                    </div>
                    <pre className="mono">{n.command}</pre>
                  </div>
                ))}
              </>
            ) : (
              <p>No command steps will run.</p>
            )}
            {plan.reused.length > 0 && (
              <p className="muted">
                Reused from run {confirm.sourceRunId}: {plan.reused.join(', ')}
              </p>
            )}
            {!plan.exact && (
              <p className="muted">Showing every command step; steps unchanged since run {confirm.sourceRunId} will be reused instead of run again.</p>
            )}
          </>
        )}
        <div className="modal-actions">
          <button onClick={close}>Cancel</button>
          <button className="primary" disabled={plan.problems.length > 0} onClick={start}>
            Start run
          </button>
        </div>
      </div>
    </div>
  );
}
```

`web/src/components/Toast.tsx`:

```tsx
import { useEffect } from 'react';
import { dispatch, useStore } from '../store';

export function Toast() {
  const toast = useStore((s) => s.toast);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => dispatch({ kind: 'dismissToast' }), 6000);
    return () => clearTimeout(timer);
  }, [toast]);
  if (!toast) return null;
  return (
    <div className="toast" onClick={() => dispatch({ kind: 'dismissToast' })}>
      {toast}
    </div>
  );
}
```

`web/src/components/RightPanel.tsx`:

```tsx
import type { Tab } from '../state';
import { dispatch, useStore } from '../store';
import { ApprovalsPanel } from './ApprovalsPanel';
import { ChatPanel } from './ChatPanel';
import { NodePanel } from './NodePanel';

const LABELS: Record<Tab, string> = { chat: 'Chat', node: 'Node', approvals: 'Approvals' };

export function RightPanel() {
  const tab = useStore((s) => s.tab);
  const approvals = useStore((s) => s.approvals);
  return (
    <aside className="right">
      <nav className="tabs">
        {(Object.keys(LABELS) as Tab[]).map((t) => (
          <button
            key={t}
            className={[tab === t ? 'active' : '', t === 'approvals' && approvals.length > 0 ? 'attention' : ''].filter(Boolean).join(' ')}
            onClick={() => dispatch({ kind: 'setTab', tab: t })}
          >
            {LABELS[t]}
            {t === 'approvals' && approvals.length > 0 ? ` (${approvals.length})` : ''}
          </button>
        ))}
      </nav>
      <div className="tab-body">{tab === 'chat' ? <ChatPanel /> : tab === 'node' ? <NodePanel /> : <ApprovalsPanel />}</div>
    </aside>
  );
}
```

- [ ] **Step 2: Wire the panels into `web/src/App.tsx`**

Replace `web/src/App.tsx` with:

```tsx
import { ReactFlowProvider } from '@xyflow/react';
import { Canvas } from './components/Canvas';
import { RightPanel } from './components/RightPanel';
import { RunConfirmDialog } from './components/RunConfirmDialog';
import { Toast } from './components/Toast';
import { TopBar } from './components/TopBar';
import { useStore } from './store';

export function App() {
  const auth = useStore((s) => s.auth);
  return (
    <div className="app">
      <TopBar />
      {auth && !auth.ok && <div className="banner">{auth.error} Restart claude-stream after signing in.</div>}
      <main className="main">
        <ReactFlowProvider>
          <Canvas />
        </ReactFlowProvider>
        <RightPanel />
      </main>
      <RunConfirmDialog />
      <Toast />
    </div>
  );
}
```

- [ ] **Step 3: Build, typecheck and test**

Run: `npm run build && npm run typecheck && npm test`
Expected: build succeeds; typecheck and all tests PASS.

- [ ] **Step 4: Commit**

```bash
git add web
git commit -m "feat(web): chat, node editor and logs, approvals queue, run confirmation"
```

---

### Task 18: Live subscription test, README and end-to-end check

**Files:**
- Create: `server/test/live.test.ts`, `README.md`

**Interfaces:**
- Consumes: everything.
- Produces: an opt-in live test (`CLAUDE_STREAM_LIVE=1`) and user documentation.

- [ ] **Step 1: Write the opt-in live test `server/test/live.test.ts`**

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyOp, emptyGraph, type ApprovalRequest, type Graph, type Op } from '@claude-stream/shared';
import { createAgentExecutor } from '../src/agentExecutor';
import { ApprovalBroker } from '../src/approvals';
import { checkAuth, resolveClaudePath } from '../src/auth';
import { createCommandExecutor } from '../src/commandExecutor';
import { Runner } from '../src/runner';
import { RunStore } from '../src/runStore';
import { tmpProject } from './helpers';

const live = process.env.CLAUDE_STREAM_LIVE === '1';

describe.skipIf(!live)('live: real Claude on the subscription', () => {
  it('runs agent and command steps with an approval round-trip', async () => {
    const claudePath = resolveClaudePath();
    if (!claudePath) throw new Error('claude is not on PATH');
    const auth = await checkAuth(claudePath);
    expect(auth.ok, auth.error).toBe(true);

    const paths = tmpProject();
    const broker = new ApprovalBroker();
    const approved: string[] = [];
    broker.on('changed', (pending: ApprovalRequest[]) => {
      for (const p of pending) {
        queueMicrotask(() => {
          if (broker.decide(p.id, { decision: 'approve' })) approved.push(p.toolName);
        });
      }
    });
    const runStore = new RunStore(paths);
    const runner = new Runner({
      runStore,
      broker,
      executors: { agent: createAgentExecutor({ claudePath, broker }), command: createCommandExecutor() },
      projectDir: paths.root,
      maxParallel: 2,
    });

    let graph: Graph = emptyGraph('live', 'Live', new Date().toISOString());
    const ops: Op[] = [
      { type: 'addNode', node: { title: 'Say pong', kind: 'agent', prompt: 'Reply with exactly the word PONG and nothing else. Do not use any tools.' } },
      {
        type: 'addNode',
        node: { title: 'Write file', kind: 'agent', prompt: 'Use the Write tool to create hello.txt in the current folder containing exactly: hi from claude-stream. Then reply DONE.' },
      },
      { type: 'addNode', node: { title: 'Check file', kind: 'command', command: 'cat hello.txt' } },
      { type: 'connect', from: 'n1', to: 'n2' },
      { type: 'connect', from: 'n2', to: 'n3' },
    ];
    for (const op of ops) {
      const r = applyOp(graph, op, 'user', new Date().toISOString());
      if (!r.ok) throw new Error(r.error);
      graph = r.graph;
    }

    const started = runner.start({ graph });
    if (!started.ok) throw new Error(started.error);
    const run = await started.done;
    expect(run.status, JSON.stringify(run.nodes, null, 2)).toBe('succeeded');
    expect(runStore.readOutput(run.id, 'n1')).toContain('PONG');
    expect(approved).toContain('Write');
    expect(readFileSync(join(paths.root, 'hello.txt'), 'utf8')).toContain('hi from claude-stream');
    expect(runStore.readOutput(run.id, 'n3')).toContain('hi from claude-stream');
  }, 300_000);
});
```

- [ ] **Step 2: Run the default suite (live test skipped), then the live test**

Run: `npm test`
Expected: PASS, with the live test reported as skipped.

Run (uses a small amount of the Claude Max plan): `CLAUDE_STREAM_LIVE=1 npm test -w server -- live`
Expected: PASS. If it fails with an `authenticated with "<source>"` error, the init message's `apiKeySource` for a subscription login is not `none`/`oauth` on this Claude Code version: print the init message in a scratch script, add the observed value to `SUBSCRIPTION_SOURCES` in `server/src/auth.ts` (only if `claude auth status` reports `authMethod: "claude.ai"`), add it to the `isSubscriptionAuthSource` test, and rerun.

- [ ] **Step 3: Write `README.md`**

````markdown
# claude-stream

A local web app where you and a Claude planner co-create a workflow as a graph, then run it step by step on your Claude subscription. Every agent action waits for your approval, and every step keeps its own logs.

## Requirements

- Node.js 20.11 or newer
- Claude Code, installed and signed in with your Claude account (run `claude`, then `/login`). Check with `claude auth status`.

## Install

```bash
npm install
npm run build
npm link          # puts the `claude-stream` command on your PATH
```

## Use

```bash
claude-stream ~/path/to/your/repo            # opens the page in your browser
claude-stream . --port 4400 --max-parallel 2 --no-open
```

- **Chat (right panel):** describe a goal. The planner reads your repo (read-only) and draws the plan on the canvas.
- **Canvas:** double-click to add a step, drag between handles to connect, Delete to remove. Steps the planner wrote are marked "by agent" until you edit them.
- **Agent steps** run a separate Claude agent with the step's prompt plus the outputs of the steps before it. **Command steps** run an exact shell command in the project folder.
- **Run:** the confirmation dialog lists every command that will run. Agent steps ask before every file edit or shell command (Approvals tab).
- **Logs:** select a step, then Node → Logs. Each agent log starts with the exact prompt it received.
- **Re-run from here:** reruns a step and everything after it, reusing earlier results that are still valid.

## Your Claude subscription

claude-stream runs your installed, signed-in `claude` program through the Claude Agent SDK. It never reads or stores your credentials. It removes `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` from every agent's environment, checks `claude auth status` at startup, and stops any session that reports an API key instead of your subscription. Parallel steps use your plan's usage limits faster; `--max-parallel` (default 3) caps them.

This is a personal tool: anyone else who runs it uses their own Claude Code login on their own machine.

## Files it writes

```
<repo>/.claude-stream/
  graphs/<name>.json        the graph (safe to commit)
  graphs/<name>.ops.jsonl   who changed what, and when
  graphs/<name>.chat.jsonl  planner conversation
  runs/<run-id>/            run snapshot, per-step events and outputs (git-ignored)
```

## Safety

- The server listens on 127.0.0.1 only and requires the token in the URL it prints (exchanged for a cookie).
- Command steps run exactly as written with your shell environment, after you confirm the run.
- Agent steps can't start sub-agents and wait for you before any edit, write, or shell command.

## Development

```bash
npm test                      # all unit tests
npm run typecheck
npm run dev -w web            # rebuild the UI on change
CLAUDE_STREAM_LIVE=1 npm test -w server -- live   # real Claude, small plan usage
```
````

- [ ] **Step 4: End-to-end check in the browser**

Run:

```bash
npm run build && npm link && mkdir -p /tmp/cs-demo && cd /tmp/cs-demo && git init -q 2>/dev/null; printf '# Demo\nA tiny project for trying claude-stream.\n' > README.md
```

Start `claude-stream /tmp/cs-demo --no-open --port 4317` in the background, open the printed URL in Chrome (claude-in-chrome), and verify each item:

1. The header shows `Claude Max · <email>`.
2. "+ New" → create graph `demo`; the canvas is empty.
3. Double-click the canvas → a `New step` node appears and the Node tab opens. Set the prompt to "Summarize README.md in one sentence." and Save; the node's title and prompt persist after a page reload.
4. Add a second step with kind Command and command `wc -l README.md`; connect step 1 → step 2.
5. Run → the dialog lists `wc -l README.md`; Start. Node borders turn blue, then green. Node → Logs for step 1 shows "Prompt sent to the agent" and the summary; step 2 shows the line count.
6. Chat: "Add a step after the summary that writes SUMMARY.md containing the summary." → a node marked "by agent" appears, connected after step 1.
7. Run again → the Approvals tab shows a `Write` request for `SUMMARY.md` with its content; Approve → the step succeeds and `/tmp/cs-demo/SUMMARY.md` exists.
8. On the new step, "Re-run from here" → the dialog says step 1 is reused; Start → step 1 shows "reused".
9. Stop the server (Ctrl+C) and start it again → the run selector lists the earlier runs and their logs still open.

Expected: all nine items behave as described. Fix anything that doesn't before committing.

- [ ] **Step 5: Final verification and commit**

Run: `npm test && npm run typecheck && npm run build`
Expected: all PASS.

```bash
git add README.md server/test/live.test.ts
git commit -m "test: opt-in live subscription test; docs: README"
```

---

## Self-review notes

- **Spec coverage:** §3 subscription → Tasks 5, 9, 12, 18; §4 architecture/units → Tasks 1–14; §5 graph model and op log → Tasks 1–3; §6 co-editing and planner → Tasks 3, 11, 12, 13, 16, 17; §7.1 confirmation dialog → Tasks 15, 17; §7.2 scheduling, stop, re-run → Task 10; §7.3 agent nodes and prompt → Tasks 7, 9; §7.4 approval gate → Task 6; §7.5 command nodes → Task 8; §8 logs and history → Tasks 4, 10, 17; §9 UI → Tasks 16, 17; §10 CLI, network safety, restart recovery → Tasks 4, 13, 14; §11 error handling → covered by the owning tasks' tests; §12 testing → every task, plus Task 18's live test.
- **Review Focus** lines each have a test in the named task.
