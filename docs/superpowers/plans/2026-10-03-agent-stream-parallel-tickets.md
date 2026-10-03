# Agent Stream — One Writer per Workspace: Parallel Tickets and A/B Variants Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make sure agents that can change files never work on separate tickets in the same checkout. Write-capable steps are serialized per workspace within a run, and a run that changes files holds its checkout's write lease across runs and windows. Separate tickets get their own worktrees (Set Up Parallel Tickets), and A/B variants inside one graph get their own temporary worktrees (variant workspaces).

**Architecture:**
- **Shared.** Steps gain `access` (`'read' | 'write'`) and `workspace` (a variant workspace name). The protocol gains `CheckoutInfo`, `LeaseHolder`, the `checkout` and `runBlocked` server messages, `inspectCheckout`, and `startRun.sequential`.
- **Engine.** It stays VS Code-free and adds these modules:
  - `git.ts`: `GitExec` and `inspectCheckout`;
  - `writeLease.ts`: lock files under `~/.agent-stream/locks/`;
  - `variantWorkspaces.ts`: detached worktrees under `~/.agent-stream/worktrees/`;
  - `worktrees.ts`: ticket worktree planning, checks and creation;
  - `ticketGraph.ts` and `abTestGraph.ts`: the two templates;
  - `policy.ts`: the policy texts, used verbatim.
- **Runner.** It decides whether a run needs the lease, serializes writers per workspace, and waits in sequential mode.
- **App.** It inspects the checkout, creates variant worktrees before `runner.start`, sends `runBlocked`, and broadcasts `checkout`.
- **Extension.** `parallelTickets.ts` is VS Code-free (through `Ui`, `GitExec` and a filesystem probe). It holds the three new commands. The web UI shows where a graph works, the blocked-run choices, and the Access and Workspace fields and badges.

**Tech Stack:** TypeScript 7 (strict, noEmit), npm workspaces (`shared`, `engine`, `web`, `extension`), Vitest 5, zod 4, React 19 + @xyflow/react 12, Vite 8, esbuild, Node `child_process.execFile` (git), VS Code extension API (`showQuickPick`, `showOpenDialog`, `withProgress`, `vscode.openFolder`).

**Spec:** `docs/superpowers/specs/2026-10-03-agent-stream-parallel-tickets-design.md` (committed at 668eb04). It is the binding authority, and every section number below (§n) refers to it.

**Order:**
- Shared data and protocol first (Tasks 1–2).
- Then the engine building blocks: git, leases, the runner, variant workspaces and read-only steps (Tasks 3–7).
- Then the app, which wires them together (Task 8).
- Then ticket worktrees, the planner and the two templates (Tasks 9–11).
- Then the extension commands (Tasks 12–13), the web UI (Tasks 14–15), and finally the integration test and the docs (Task 16).

Task 5 also does the dependency plumbing (`AppDeps.leases/git/home`, `EngineManagerDeps.git`) once, so later tasks never touch every `createApp` call again.

**Planning rulings** (decided while writing this plan; each costs a small rework if wrong):
- **R1. `access: 'write'` is stored as no `access` field.** `applyOp` drops it, so `contentSignature`, reuse and export compare `access ?? 'write'`. `parseGraph` still accepts an explicit `'write'` in a file.
- **R2. Changed-field reporting covers the new fields.** `ChangedField` gains `'access'` and `'workspace'`, so agent changes list them, and Revert restores them (`graphStore.withContentOf`). The step graph tools' field names gain them too. The spec only lists them as content (`contentSignature`), so this is the consistent reading.
- **R3. A step whose `workspace` changed is also re-executed**, not only one whose `access` changed. Its earlier output came from another place.
- **R4. The run's checkout is passed to `runner.start` as `StartRunInput.checkout`.** This is the spec's "or the checkout already inspected by app" option, and it keeps `start` synchronous. Without it, the lease key is `projectDir` (runner unit tests). `StartRunInput` also gains `runId`, because variant worktree paths contain the run id and are created before `start`. A blocked start returns `{ ok: false, error, blocked }`, so existing `if (!r.ok) … r.error` code still compiles.
- **R5. Lease ordering.** Each waiting run subscribes its own `onRelease` listener when it starts waiting. Listeners run in subscription order, so waiting runs of one process acquire in the order they started (spec §4.3). The 3-second retry for another window's holder runs only while the holder is in another window. In the rare case of two waiting runs in two folders of one checkout, both retrying against another window, the first timer to fire wins.
- **R6. An unreadable lock file** makes `acquire` return the holder `{ runId: 'unknown', graphId: 'unknown', folder: '', pid: 0, startedAt: '' }`, with `otherWindow: true` and an extra optional `lockFile` (the file's path). The `runBlocked` message then ends with `` ` Its lock file ${lockFile} can't be read; delete it if no run is changing files.` `` so it names the file (§4.2).
- **R7. A step added mid-run** by a step agent (the step graph tools can't set `access` or `workspace`) is a write-capable checkout step. If the run doesn't hold the lease yet, because its other writers are all in variant workspaces, `pump` acquires the lease on demand. If another run holds it, the step waits as in a sequential run.
- **R8. The workspace refusal is a run-preview problem.** `previewRun` gains the inspected `checkout` and reports `Step <id> uses workspace "<name>", which needs a Git repository with at least one commit.` once per such step. That blocks Start in the dialog and makes `startRun` refuse with the same text (§4.3a, §8). The preview also carries `checkout` (the dialog's Checkout line) and `notes?: string[]` (shown, never blocking).
- **R9. The initial `checkout` message is sent on `setImmediate` after `hello`/`sessions`.** `hello` and `sessions` then always come first, and existing tests that read the last messages synchronously after `connect` are unaffected. Later `checkout` messages go out when a run first appears, reaches a final status, or stops waiting.
- **R10. Command templates use `| unquoted`.** Agent Stream shell-quotes every value in a command step, so a whole command in a variable has to expand to several words. The starter graph's n4 is `{{ check_command | unquoted }}`, and the A/B template's steps are `{{ setup_command | unquoted }}` and `{{ run_<v> | unquoted }}` (the spec table writes them without the filter). The preview's existing `| unquoted` warning shows for them, as intended.
- **R11. A/B variable names replace `-` with `_`.** Workspace names allow `-` but variable names don't: variant `wh-small` uses `run_wh_small`. The wizard refuses two variants that would map to one variable.
- **R12. The A/B compare step is read-only, as in §5.4's table.** A read-only step can never run commands, so its prompt says that querying warehouse history needs either a command step or "Can edit files" (each command then asks for approval). §5.4's "through commands only if the user approves" is met this way, without contradicting §4.4.
- **R13. The starter graph's Review step (n5) is read-only.** It can't run `git diff`, so its prompt tells it to read the changed files and compare them with the research and implementation reports.
- **R14. Wording the spec leaves open** (used verbatim in the tasks below):
  - `` `Add at most 20 tickets.` ``
  - the other setup-check problems listed in Task 9;
  - the check_tickets advice when worktrees exist or are missing;
  - the wizard prompts;
  - `No run workspaces in this folder.`
  - `` `Run ${runId} is still running. Stop it first.` ``
  - the A/B wizard's validation messages;
  - the blocked dialog's heading `Can't start yet`.
- **R15. `Ui` gains a few small methods.** Besides `quickPick`/`quickPickMany`, `pickParentFolder` and `openInNewWindow`, it gains:
  - `withProgress` (the "with progress" in §5.3 step 9);
  - `infoAction(message, action)` (the summary's button);
  - an optional `detail` on `confirm` (the per-ticket lines).
- **R16. Manage Run Workspaces lists only entries not yet removed.** It offers only Remove (which runs `git worktree prune`) for a missing workspace, and refuses Remove while that run is still running.
- **R17. The integration check connects a probe client to the folder's engine**, the same engine the tab uses, and asserts the `checkout` message. The webview's own messages can't be observed from the test host.
- **R18. Privacy for variant steps.** A step running in a variant worktree gets its gate's `projectDir` set to the worktree, plus `runsRoot` set to the folder. The folder's run records (`run.json`, `events.jsonl`) then stay private (Review Focus 4).

## Global Constraints

- TypeScript strict everywhere. `npm run typecheck` passes after every task.
- The engine (`engine/`) and `shared/` never import `vscode`. Only `extension/` does. `extension/src/parallelTickets.ts` doesn't import `vscode` either; it works through `Ui`, `GitExec` and a filesystem probe.
- No new runtime dependencies. Git runs through `node:child_process` `execFile('git', args, { cwd, timeout: 15_000, windowsHide: true })`.
- **No test runs real git or creates real worktrees.** Tests use a fake `GitExec`, temp folders (`mkdtemp`), an injected `isAlive` and an injected pid. No test touches the real home folder: every `home`, `locksDir` and values file is a temp folder. The integration test runs real VS Code, but creates no worktree.
- Existing tests keep their assertions, except where the spec changes behaviour. Write-capable steps in the same workspace within a run are now serialized (§2, "This changes existing behaviour"). Task 5 names each test this changes and updates it, by marking the parallel steps read-only or by releasing them in turn. A test that only gains setup (new required deps) keeps its assertions.
- Windows paths:
  - Paths are built with `path.join`/`path.resolve`/`fs.realpathSync`, never with a hard-coded `/`.
  - Tests build expected paths with the same functions, and compare real paths for temp folders (`realpathSync`, because macOS temp folders are symlinks).
  - Fake git answers are keyed by `args.join(' ')`, built from the same `join` calls.
- Exact user-facing strings, used verbatim from the spec:
  - Policy (§1): `Before starting or planning concurrent write-capable work, determine whether tasks are separate tickets. If they are, require one Git worktree per ticket. Never run write-capable agents for separate tickets in the same repository checkout. If worktrees cannot be verified or created, offer sequential execution only.`
  - Alternatives (§1): `Within one graph, the same rule applies to alternatives: parallel write-capable steps need separate workspaces.`
  - Serialization guidance (§6): ``Even in separate worktrees, changes to `shared/` code, database migrations, package manifests and lockfiles, and contracts between workspaces should normally be serialized: land one ticket, then rebase the others onto it, instead of changing those files in several tickets at once.``
  - Planner rules (§4.6): `Mark agent steps that only read and report as read-only (access: read). Never plan write-capable steps for separate tickets in parallel in one checkout. Before planning work for several tickets, call check_tickets. When tickets lack their own worktrees, suggest the command Agent Stream: Set Up Parallel Tickets, or plan the tickets one after another.` and `To compare alternatives at the same time within one graph (A/B tests), put each variant's steps in their own workspace (workspace: <name>) and end with a read-only compare step. Worktrees separate files only: every variant that writes to a database, warehouse, schema or other shared resource must use its own (for dbt, a separate target and schema per variant).`
  - A/B measurement guidance (§5.4): ``Worktrees separate files only. Give every variant its own external resources: for dbt, a separate target and schema per variant, so variants never build the same tables. Measure fairly: turn off result caches (for Snowflake, `ALTER SESSION SET USE_CACHED_RESULT = FALSE` via a pre-hook or session parameter); start each variant's warehouse suspended so local caches are cold; tag each variant's queries (`query_tag`) and read cost and runtime from the warehouse's query and metering history; repeat short runs, because minimum billing per resume skews them. Compare runtime, cost and failures per variant, and say how confident the result is.``
  - Command steps and read-only (§3.1): `Command steps can always change files; only agent steps can be read-only.`
  - Workspace names (§3.1a): `Workspace names use lowercase letters, digits, - and _, starting with a letter.`
  - Workspace refusals (§4.3a): `` `Step ${id} uses workspace "${name}", which needs a Git repository with at least one commit.` `` and `` `Couldn't create workspace "${name}": ${gitError}` ``
  - Uncommitted-changes note (§4.3a): `` `Workspaces start from ${sha7}; uncommitted changes in this checkout aren't included.` ``
  - Workspace prompt line (§4.3a): `` `You are working in workspace "${name}" at ${path}: a separate Git worktree of this repository at ${sha7}. Change files only there.` ``
  - Heading suffix (§4.3a): `` `, workspace ${name}` ``
  - Read-only refusal (§4.4): `` `This step is read-only, so ${tool} isn't allowed. Mark the step "Can edit files" if it needs to change something.` ``
  - Read-only prompt line (§4.4): `This step is read-only: investigate and report; don't change files or run commands.`
  - Blocked message (§4.5): `` `"${graphName}" can't start: run ${runId} of "${holderName}" is already changing files in this checkout (${root}). Separate tickets need separate worktrees.` ``, with ` in another VS Code window` after the run id when the holder is in another window.
  - check_tickets outside Git (§4.6): `Worktrees can't be verified here; plan the tickets one after another.`
  - Parallel writers note (§4.7): `` `${a} and ${b} can both change files in the same workspace; they will run one at a time.` ``
  - Slugs and plans (§5.1):
    - `` `Ticket ${n} needs letters or numbers.` ``
    - `Add at least two tickets.`
    - `` `Tickets ${i} and ${j} would both use feat/${slug}.` ``
    - `` `This checkout has uncommitted changes to tracked files (${n}). Worktrees start from ${base} and won't include them. Commit them yourself, or run this from a clean checkout.` ``
  - Starter graph (§5.2):
    - goal `` `Complete ticket: ${ticket}` ``
    - variable `check_command`, described as `Full test suite and typecheck, e.g. npm test && npm run typecheck`
    - titles `Read and research`, `Implementation`, `Focused tests`, `Full test + typecheck`, `Review`
  - Wizard (§5.3):
    - `` `Set Up Parallel Tickets needs a Git repository. ${reason}` ``
    - `Ticket 1`, `Ticket 2`, `` `Ticket ${n} (leave empty to finish)` ``
    - `` `Next to the repo (${parent})` ``, `Choose folder…`
    - `` `Create ${n} worktrees from ${base} (${sha7})?` ``
    - per-ticket line `` `${path}  ·  ${branch}` `` (two spaces each side of the dot)
    - `` `${n} untracked files stay in this checkout.` ``
    - `` `Created ${k} of ${n} worktrees; stopped at ${ticket}: ${error}. Nothing was removed.` ``
    - `` `Set up ${n} ticket worktrees from ${sha7}.` ``
    - `Open in New VS Code Window…`
  - A/B (§5.4):
    - `New A/B Test Graph`
    - setup variable description `Prepares a fresh worktree, e.g. dbt deps (new worktrees have no untracked files such as .venv, dbt_packages or node_modules)`
    - run variable description `` `The command for variant ${v}, e.g. dbt build --target ${v}` ``
    - titles `Plan the comparison`, `` `Set up ${v}` ``, `` `Run ${v}` ``, `Compare and recommend`
  - Manage (§5.5):
    - `Manage Run Workspaces`
    - `· missing`, `· has changes`
    - `Open in New VS Code Window`, `Create Branch Here`, `Remove`
    - default branch `` `ab/${runId}-${name}` ``
    - `` `Remove ${path}? Its uncommitted changes will be lost.` ``
  - UI (§7):
    - `` `⎇ ${branch}` ``, `` `⎇ detached ${sha7}` ``, `` ` · worktree ${folderName}` ``, `Not a Git repository`, `Git isn't available`
    - `` `Ran in ${root} on ${branch} at ${sha7}` ``
    - `Set Up Parallel Tickets`, `Run after it finishes`, `Cancel`
    - `` `Waiting for run ${id} ("${graph}") to finish changing files` ``
    - `Access`, `Can edit files`, `Read-only`, `Command steps can change files`
    - `Workspace`, placeholder `This checkout`
    - badges `read-only` and `` `⎇ ${name}` ``
    - logs line `` `workspace ${name} · ${path}` ``
- Manifest:
  - `agentStream.setUpParallelTickets`, titled `Set Up Parallel Tickets`, category `Agent Stream`, icon `$(git-branch)`, with a Graphs view title button at `navigation@3`;
  - `agentStream.newAbTestGraph`, titled `New A/B Test Graph`;
  - `agentStream.manageRunWorkspaces`, titled `Manage Run Workspaces`.
- `agentStream.maxParallel` stays the only concurrency setting (default 3).
- The repo is public, so commit no personal paths, emails or machine details.
- Run every command from the repo root, on branch `feat/parallel-tickets`. Never push. Do NOT run `npm run package`, because no VSIX is built for this work.
- Every commit message ends with the line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

These are five failure modes the spec implies but that no task's main tests would naturally exercise, most likely first. Each is pinned by a test in the task that owns the code.

1. **Two workspace folders of one checkout** (a repo and its subfolder) open in one window, or the same repo in two windows. They must share one lease, keyed by the Git top-level and not by the folder, so the second folder's write-capable run is blocked. Pinned in Task 3 (`git.test.ts` › "reports the top-level folder as the root of a subfolder") and Task 5 (`runner.test.ts` › "blocks a second write-capable run in the same checkout, from another engine, creating nothing").
2. **A step agent adds a checkout step mid-run to a run whose writers were all in variant workspaces.** That run holds no lease. The added step must wait for the lease (or take it if free) before it changes files in the checkout. Pinned in Task 6: `runner.test.ts` › "takes the lease on demand for a checkout step added mid-run".
3. **A step in a variant workspace reads an earlier step's output.** Its working directory is the worktree, so the `Full output:` path must be absolute, or the agent reads a file that doesn't exist. Pinned in Task 6: `runner.test.ts` › "runs a step that has a workspace there, with absolute paths to earlier outputs".
4. **An agent in a variant workspace reads the folder's run records** (`.agent-stream/runs/*/run.json`, which contain variable values) by absolute path. Privacy must still refuse it, even though the step's `projectDir` is now the worktree. Pinned in Task 6: `toolGate.test.ts` › "keeps the folder's run records private from a step in a workspace".
5. **"Run after it finishes" when the holder finished meanwhile.** The re-sent `startRun` with `sequential: true` must simply start and take the lease, with no `waitingFor` and no stuck queued steps. Pinned in Task 5: `runner.test.ts` › "a sequential start takes the lease at once when it is free".

## File map

| File | Responsibility | Task |
|---|---|---|
| `shared/src/access.ts` | `isWriteCapable`, `workspaceOf`, `parallelWriteSteps`, name rule, messages | 1 |
| `shared/src/types.ts` | `GraphNode.access/workspace`, patches, `ChangedField`; `CheckoutInfo`, `LeaseHolder`, `RunMeta.checkout/workspaces/waitingFor`, messages | 1, 2 |
| `shared/src/graph.ts` | `applyOp` (access, workspace), `contentSignature`, `reusableNodeIds` | 1 |
| `shared/src/schemas.ts` | zod: node fields, `parseGraph` checks, `inspectCheckout`, `startRun.sequential`, `setUpParallelTickets` | 1, 2 |
| `shared/src/exportFile.ts`, `shared/src/changes.ts` | export/import and changed fields carry the new fields | 1 |
| `shared/src/checkout.ts` | `toRunCheckout`, `checkoutChip`, `checkoutTooltip`, `ranIn`, `waitingText`, `folderName` | 2 |
| `engine/src/git.ts` | `GitExec`, `realGit`, `inspectCheckout`, `parseWorktreeList`, `realOrResolved` | 3 |
| `engine/src/writeLease.ts` | `createWriteLeases`, `leaseKey`, `leaseFile`, `processAlive` | 4 |
| `engine/src/runner.ts` | lease, sequential wait, per-workspace writer serialization, workspace cwd, `dispose` | 5, 6 |
| `engine/src/variantWorkspaces.ts` | `variantPath`, `createVariantWorkspaces`, `removeWorkspace`, `pruneWorkspaces` | 6 |
| `engine/src/prompt.ts` | workspace line, heading suffix, read-only line | 6, 7 |
| `engine/src/providers/toolGate.ts` | `runsRoot` privacy (6); `readOnly` refusal (7) | 6, 7 |
| `engine/src/runPreview.ts` | notes, workspace refusals, `checkout` | 8 |
| `engine/src/app.ts` | deps plumbing (5); read-only executors (7); checkout, runBlocked, sequential, variant creation (8); planner checkout (10); run workspaces (13) | 5, 7, 8, 10, 13 |
| `engine/src/runStore.ts` | summaries carry `checkout`/`waitingFor`; `all()` | 2, 13 |
| `engine/src/worktrees.ts` | `ticketSlug(s)`, `planWorktrees`, `checkSetup`, `worktreeAddArgs`, `createWorktrees` | 9 |
| `engine/src/policy.ts` | the policy texts | 10 |
| `engine/src/planner.ts`, `engine/src/plannerTools.ts` | policy in `PLANNER_APPEND`; `access`/`workspace` in tools; `checkout_info`, `check_tickets` | 10 |
| `engine/src/ticketGraph.ts`, `engine/src/abTestGraph.ts` | the starter ticket graph and the A/B template | 11 |
| `engine/src/index.ts` | exports for the extension | 3, 4, 6, 9, 11 |
| `extension/src/engines.ts`, `extension/src/extension.ts` | shared leases, `realGit`, `home`; command registration | 5, 12, 13 |
| `extension/src/commands.ts`, `extension/src/ui.ts` | new `Ui` methods; `graphCommands` returns `folderFor` | 12 |
| `extension/src/parallelTickets.ts` | Set Up Parallel Tickets, New A/B Test Graph, Manage Run Workspaces | 12, 13 |
| `extension/src/graphEditor.ts` | `setUpParallelTickets` host message | 12 |
| `extension/package.json` | the three commands and the view title button | 12, 13 |
| `web/src/state.ts` | `checkout`, `blocked`, `lastStart` | 2 |
| `web/src/components/TopBar.tsx`, `RunConfirmDialog.tsx`, `web/src/bridge.ts` | chip, run tooltips, waiting text, Checkout line, notes, blocked buttons, visibility | 14 |
| `web/src/components/NodePanel.tsx`, `StepNode.tsx`, `LogsPanel.tsx`, `web/src/workspaceColor.ts`, `web/src/styles.css` | Access and Workspace fields, badges, logs workspace line | 15 |
| `extension/test/integration/suite.cjs`, `README.md`, `extension/README.md` | integration check, docs | 16 |

---

### Task 1: Shared — step access and workspace

**Files:**
- Create: `shared/src/access.ts`, `shared/test/access.test.ts`
- Modify: `shared/src/types.ts:5-18` (`GraphNode`), `:38-56` (`NewNodeInput`, `NodePatch`), `:82` (`ChangedField`)
- Modify: `shared/src/graph.ts:55-89` (`applyOp` `addNode`/`updateNode`), `:204-211` (`contentSignature`), `:236-256` (`reusableNodeIds`)
- Modify: `shared/src/schemas.ts:12-24`, `:38-62`, `:64-82`
- Modify: `shared/src/exportFile.ts:11`, `:31`
- Modify: `shared/src/changes.ts:3`
- Modify: `shared/src/index.ts`
- Modify: `engine/src/graphStore.ts:51-55` (`withContentOf`), `engine/src/stepGraphTools.ts:31-32` (`FIELD_ORDER`, `FIELD_NAMES`)
- Test: `shared/test/access.test.ts`, `shared/test/graph.test.ts`, `shared/test/schemas.test.ts`, `shared/test/exportFile.test.ts`, `shared/test/changes.test.ts`, `engine/test/graphStore.test.ts`

**Interfaces:**
- Produces (in `@agent-stream/shared`):
  ```ts
  export type NodeAccess = 'read' | 'write';
  // GraphNode, NewNodeInput and NodePatch gain:
  access?: NodeAccess;      // missing means 'write'; applyOp stores 'read' only (ruling R1)
  workspace?: string;       // a variant workspace name; NodePatch.workspace '' clears it
  export type ChangedField = 'title' | 'description' | 'kind' | 'prompt' | 'command' | 'timeoutSec' | 'access' | 'workspace';
  export const WORKSPACE_NAME_RE: RegExp;            // /^[a-z][a-z0-9_-]{0,39}$/
  export const WORKSPACE_NAME_PROBLEM: string;       // 'Workspace names use lowercase letters, digits, - and _, starting with a letter.'
  export const COMMAND_ALWAYS_WRITES: string;        // 'Command steps can always change files; only agent steps can be read-only.'
  export function workspaceNameProblem(name: string): string | null;
  export function isWriteCapable(node: Pick<GraphNode, 'kind' | 'access'>): boolean;
  export function workspaceOf(node: Pick<GraphNode, 'workspace'>): string | null;
  export function parallelWriteSteps(graph: Graph): [string, string][];   // ids in graph order
  ```

- [ ] **Step 1: Write the failing tests**

Create `shared/test/access.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { isWriteCapable, parallelWriteSteps, workspaceNameProblem, workspaceOf } from '../src/access';
import { applyOp, emptyGraph } from '../src/graph';
import type { Graph, Op } from '../src/types';

function build(ops: Op[]): Graph {
  let g = emptyGraph('g', 'G', 't');
  for (const op of ops) {
    const r = applyOp(g, op, 'user', 't');
    if (!r.ok) throw new Error(r.error);
    g = r.graph;
  }
  return g;
}
const writer = (title: string, workspace?: string): Op => ({ type: 'addNode', node: { title, kind: 'agent', prompt: 'p', ...(workspace && { workspace }) } });
const reader = (title: string): Op => ({ type: 'addNode', node: { title, kind: 'agent', prompt: 'p', access: 'read' } });
const command = (title: string, workspace?: string): Op => ({ type: 'addNode', node: { title, kind: 'command', command: 'make', ...(workspace && { workspace }) } });
const link = (from: string, to: string): Op => ({ type: 'connect', from, to });

describe('isWriteCapable', () => {
  it('is true for command steps, and for agent steps unless they are read-only', () => {
    expect(isWriteCapable({ kind: 'command' })).toBe(true);
    expect(isWriteCapable({ kind: 'agent' })).toBe(true);
    expect(isWriteCapable({ kind: 'agent', access: 'write' })).toBe(true);
    expect(isWriteCapable({ kind: 'agent', access: 'read' })).toBe(false);
  });
});

describe('workspaceOf', () => {
  it('is the workspace name, or null for the checkout', () => {
    expect(workspaceOf({ workspace: 'wh_small' })).toBe('wh_small');
    expect(workspaceOf({})).toBeNull();
  });
});

describe('workspaceNameProblem', () => {
  it.each(['a', 'wh_small', 'wh-large', 'v2', 'a'.repeat(40)])('accepts %s', (name) => expect(workspaceNameProblem(name)).toBeNull());
  it.each(['', 'Wh', '2v', '_a', '-a', 'a b', 'a/b', '..', 'a'.repeat(41)])('refuses %j', (name) =>
    expect(workspaceNameProblem(name)).toBe('Workspace names use lowercase letters, digits, - and _, starting with a letter.'),
  );
});

describe('parallelWriteSteps', () => {
  it('pairs write-capable steps of one workspace that have no path between them', () => {
    const g = build([writer('a'), writer('b'), reader('c'), command('d'), link('n1', 'n4')]);
    expect(parallelWriteSteps(g)).toEqual([
      ['n1', 'n2'],
      ['n2', 'n4'],
    ]);
  });

  it('treats each variant workspace on its own, and the checkout as one more', () => {
    const g = build([writer('a', 'wh_a'), command('b', 'wh_a'), writer('c', 'wh_b'), writer('d')]);
    expect(parallelWriteSteps(g)).toEqual([['n1', 'n2']]);
  });

  it('finds nothing in a chain', () => {
    expect(parallelWriteSteps(build([writer('a'), writer('b'), writer('c'), link('n1', 'n2'), link('n2', 'n3')]))).toEqual([]);
  });
});
```

Append to `shared/test/graph.test.ts` (it already has `build`, `agent`, `cmd`, `link`, `expectError`, `T`, `T2`, and imports `applyOp`, `contentSignature`, `emptyGraph`, `reusableNodeIds`, `Graph`, `NodeRunState`, `Op`):

```ts
describe('step access and workspace', () => {
  const apply = (g: Graph, op: Op): Graph => {
    const r = applyOp(g, op, 'user', T2);
    if (!r.ok) throw new Error(r.error);
    return r.graph;
  };

  it('stores read-only access and a workspace on add, and stores write as no field', () => {
    const g = build([
      { type: 'addNode', node: { title: 'Read', kind: 'agent', prompt: 'p', access: 'read', workspace: 'wh_small' } },
      { type: 'addNode', node: { title: 'Write', kind: 'agent', prompt: 'p', access: 'write' } },
    ]);
    expect(g.nodes[0]).toMatchObject({ access: 'read', workspace: 'wh_small' });
    expect(g.nodes[1]).not.toHaveProperty('access');
    expect(g.nodes[1]).not.toHaveProperty('workspace');
  });

  it('refuses read-only command steps on add and update', () => {
    const msg = 'Command steps can always change files; only agent steps can be read-only.';
    expectError(emptyGraph('g', 'G', T), { type: 'addNode', node: { title: 'x', kind: 'command', command: 'ls', access: 'read' } }, msg);
    expectError(build([cmd('b', 'ls')]), { type: 'updateNode', id: 'n1', patch: { access: 'read' } }, msg);
    expectError(build([agent('a')]), { type: 'updateNode', id: 'n1', patch: { kind: 'command', command: 'ls', access: 'read' } }, msg);
  });

  it('drops access when a step becomes a command step', () => {
    const g = build([{ type: 'addNode', node: { title: 'a', kind: 'agent', prompt: 'p', access: 'read' } }]);
    const next = apply(g, { type: 'updateNode', id: 'n1', patch: { kind: 'command', command: 'ls' } });
    expect(next.nodes[0].kind).toBe('command');
    expect(next.nodes[0]).not.toHaveProperty('access');
  });

  it('sets, keeps and clears access and workspace on update', () => {
    let g = build([agent('a')]);
    g = apply(g, { type: 'updateNode', id: 'n1', patch: { access: 'read', workspace: 'wh_a' } });
    expect(g.nodes[0]).toMatchObject({ access: 'read', workspace: 'wh_a' });
    g = apply(g, { type: 'updateNode', id: 'n1', patch: { title: 'renamed' } });
    expect(g.nodes[0]).toMatchObject({ title: 'renamed', access: 'read', workspace: 'wh_a' });
    g = apply(g, { type: 'updateNode', id: 'n1', patch: { access: 'write', workspace: '' } });
    expect(g.nodes[0]).not.toHaveProperty('access');
    expect(g.nodes[0]).not.toHaveProperty('workspace');
  });

  it('refuses bad workspace names on add and update', () => {
    const msg = 'Workspace names use lowercase letters, digits, - and _, starting with a letter.';
    expectError(emptyGraph('g', 'G', T), { type: 'addNode', node: { title: 'x', kind: 'agent', workspace: 'Bad Name' } }, msg);
    expectError(build([agent('a')]), { type: 'updateNode', id: 'n1', patch: { workspace: '../x' } }, msg);
  });

  it('changes the content signature with access and with workspace, and not for an explicit write', () => {
    const g = build([agent('a')]);
    expect(contentSignature(apply(g, { type: 'updateNode', id: 'n1', patch: { access: 'read' } }))).not.toBe(contentSignature(g));
    expect(contentSignature(apply(g, { type: 'updateNode', id: 'n1', patch: { workspace: 'wh_a' } }))).not.toBe(contentSignature(g));
    expect(contentSignature({ ...g, nodes: [{ ...g.nodes[0], access: 'write' }] })).toBe(contentSignature(g));
  });

  it('re-executes an agent step whose access or workspace changed, and everything after it', () => {
    const g = build([agent('a'), agent('b'), link('n1', 'n2')]);
    const allOk = Object.fromEntries(g.nodes.map((n) => [n.id, { status: 'succeeded' as const }])) as Record<string, NodeRunState>;
    expect(reusableNodeIds(g, { snapshot: g, nodes: allOk })).toEqual(new Set(['n1', 'n2']));
    expect(reusableNodeIds(apply(g, { type: 'updateNode', id: 'n1', patch: { access: 'read' } }), { snapshot: g, nodes: allOk })).toEqual(new Set());
    expect(reusableNodeIds(apply(g, { type: 'updateNode', id: 'n2', patch: { workspace: 'wh_a' } }), { snapshot: g, nodes: allOk })).toEqual(new Set(['n1']));
  });

  it('never reuses a step that has a workspace', () => {
    const g = build([agent('a'), { type: 'addNode', node: { title: 'b', kind: 'command', command: 'make', workspace: 'wh_a' } }, agent('c'), link('n2', 'n3')]);
    const allOk = Object.fromEntries(g.nodes.map((n) => [n.id, { status: 'succeeded' as const }])) as Record<string, NodeRunState>;
    expect(reusableNodeIds(g, { snapshot: g, nodes: allOk })).toEqual(new Set(['n1']));
  });
});
```

Append to `shared/test/schemas.test.ts`:

```ts
describe('parseGraph step access and workspace', () => {
  it('reads access and workspace', () => {
    const r = parseGraph({ id: 'g', name: 'G', nodes: [{ ...node('n1'), access: 'read', workspace: 'wh_a' }] });
    expect(r.ok && r.graph.nodes[0]).toMatchObject({ access: 'read', workspace: 'wh_a' });
  });

  it('refuses a read-only command step', () => {
    expect(parseGraph({ id: 'g', name: 'G', nodes: [{ id: 'n1', title: 'b', kind: 'command', access: 'read' }] })).toEqual({
      ok: false,
      error: 'n1: Command steps can always change files; only agent steps can be read-only.',
    });
  });

  it('refuses a bad workspace name', () => {
    expect(parseGraph({ id: 'g', name: 'G', nodes: [{ ...node('n1'), workspace: 'WH' }] })).toEqual({
      ok: false,
      error: 'n1: Workspace names use lowercase letters, digits, - and _, starting with a letter.',
    });
  });

  it('accepts access and workspace in step edits, and refuses an unknown access', () => {
    expect(parseWebviewMessage({ type: 'op', graphId: 'g', op: { type: 'updateNode', id: 'n1', patch: { access: 'read', workspace: '' } } })).toMatchObject({ ok: true, kind: 'engine' });
    expect(parseWebviewMessage({ type: 'op', graphId: 'g', op: { type: 'addNode', node: { title: 't', kind: 'agent', access: 'maybe' } } }).ok).toBe(false);
  });
});
```

Append to `shared/test/exportFile.test.ts`:

```ts
describe('step access and workspace in export files', () => {
  it('carries access and workspace through export and import', () => {
    const r = applyOp(sample(), { type: 'updateNode', id: 'n2', patch: { access: 'read', workspace: 'wh_a' } }, 'user', T);
    if (!r.ok) throw new Error(r.error);
    const file = toExportFile(r.graph, T);
    expect(file.graph.nodes[1]).toMatchObject({ id: 'n2', access: 'read', workspace: 'wh_a' });
    expect(file.graph.nodes[0]).not.toHaveProperty('access');
    expect(file.graph.nodes[0]).not.toHaveProperty('workspace');
    const back = parseExportFile(JSON.stringify(file), 'copy', T);
    expect(back.ok && back.graph.nodes[1]).toMatchObject({ access: 'read', workspace: 'wh_a' });
  });
});
```

Append to `shared/test/changes.test.ts` (it already imports `diffGraphs` and has `node`/`graph` helpers):

```ts
describe('changed fields for access and workspace', () => {
  it('lists access and workspace changes', () => {
    expect(diffGraphs(graph([node('n1')]), graph([node('n1', { access: 'read', workspace: 'wh_a' })]))).toEqual([
      { kind: 'node', change: 'changed', id: 'n1', title: 'n1', fields: ['access', 'workspace'] },
    ]);
  });
});
```

Append to `engine/test/graphStore.test.ts`, inside `describe('GraphStore', …)`:

```ts
  it('keeps access and workspace through duplicate, and Revert restores them', () => {
    const store = new GraphStore(tmpProject(), fixedClock());
    const { id } = store.create('G');
    store.apply(id, { type: 'addNode', node: { title: 'a', kind: 'agent', prompt: 'p', access: 'read', workspace: 'wh_a' } }, 'user');
    const copy = store.duplicate(id);
    if (!copy.ok) throw new Error(copy.error);
    expect(copy.graph.nodes[0]).toMatchObject({ access: 'read', workspace: 'wh_a' });
    store.apply(id, { type: 'updateNode', id: 'n1', patch: { access: 'write', workspace: '' } }, 'agent', { kind: 'planner', sessionId: 's' });
    expect(store.agentChanges(id)).toEqual([expect.objectContaining({ id: 'n1', fields: ['access', 'workspace'] })]);
    expect(store.apply(id, { type: 'revertChange', target: { kind: 'node', id: 'n1' } }, 'user').ok).toBe(true);
    expect(store.get(id).nodes[0]).toMatchObject({ access: 'read', workspace: 'wh_a' });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w shared && npm test -w engine -- graphStore`
Expected: FAIL. `access.ts` doesn't exist, and `access`/`workspace` aren't stored or validated.

- [ ] **Step 3: Implement**

Create `shared/src/access.ts`:

```ts
import type { Graph, GraphNode } from './types';

export const WORKSPACE_NAME_RE = /^[a-z][a-z0-9_-]{0,39}$/;
export const WORKSPACE_NAME_PROBLEM = 'Workspace names use lowercase letters, digits, - and _, starting with a letter.';
export const COMMAND_ALWAYS_WRITES = 'Command steps can always change files; only agent steps can be read-only.';

/** Why `name` can't name a variant workspace, or null (spec §3.1a). */
export function workspaceNameProblem(name: string): string | null {
  return WORKSPACE_NAME_RE.test(name) ? null : WORKSPACE_NAME_PROBLEM;
}

/** Command steps always; agent steps unless marked read-only (spec §3.1). */
export function isWriteCapable(node: Pick<GraphNode, 'kind' | 'access'>): boolean {
  return node.kind === 'command' || node.access !== 'read';
}

/** The step's variant workspace, or null for the folder's own checkout. */
export function workspaceOf(node: Pick<GraphNode, 'workspace'>): string | null {
  return node.workspace ?? null;
}

function reachable(graph: Graph, from: string): Set<string> {
  const seen = new Set<string>();
  const stack = [from];
  while (stack.length) {
    const id = stack.pop()!;
    for (const e of graph.edges) {
      if (e.from === id && !seen.has(e.to)) {
        seen.add(e.to);
        stack.push(e.to);
      }
    }
  }
  return seen;
}

/** Every pair of write-capable steps in the same workspace with no path between them: they will take turns (spec §3.1, §4.7). */
export function parallelWriteSteps(graph: Graph): [string, string][] {
  const writers = graph.nodes.filter(isWriteCapable);
  const reach = new Map(writers.map((n) => [n.id, reachable(graph, n.id)]));
  const pairs: [string, string][] = [];
  for (let i = 0; i < writers.length; i++) {
    for (let j = i + 1; j < writers.length; j++) {
      const a = writers[i];
      const b = writers[j];
      if (workspaceOf(a) !== workspaceOf(b)) continue;
      if (reach.get(a.id)!.has(b.id) || reach.get(b.id)!.has(a.id)) continue;
      pairs.push([a.id, b.id]);
    }
  }
  return pairs;
}
```

In `shared/src/types.ts`, add `export type NodeAccess = 'read' | 'write';` above `GraphNode`. Then add these two fields to `GraphNode` (after `timeoutSec`), to `NewNodeInput` (after `timeoutSec`) and to `NodePatch` (after `timeoutSec`):

```ts
  /** 'read': an agent step that only reads and reports (spec §3.1). Missing means it can change files. */
  access?: NodeAccess;
  /** A variant workspace: steps with the same name share one worktree per run (spec §3.1a). Missing means this checkout; '' in a patch clears it. */
  workspace?: string;
```

Change `ChangedField` to:

```ts
export type ChangedField = 'title' | 'description' | 'kind' | 'prompt' | 'command' | 'timeoutSec' | 'access' | 'workspace';
```

In `shared/src/graph.ts`:
- Add `import { COMMAND_ALWAYS_WRITES, workspaceNameProblem } from './access';`.
- Replace the `addNode` and `updateNode` cases with:

```ts
    case 'addNode': {
      const id = op.node.id ?? nextNodeId(graph);
      const idProblem = nodeIdProblem(id);
      if (idProblem) return fail(idProblem);
      if (has(id)) return fail(`node ${id} already exists`);
      const title = op.node.title.trim();
      if (!title) return fail('a node needs a title');
      if ((op.node.description?.length ?? 0) > MAX_DESCRIPTION_CHARS) return fail(DESCRIPTION_TOO_LONG);
      if (op.node.access === 'read' && op.node.kind === 'command') return fail(COMMAND_ALWAYS_WRITES);
      const workspace = op.node.workspace?.trim() || undefined;
      const workspaceProblem = workspace === undefined ? null : workspaceNameProblem(workspace);
      if (workspaceProblem) return fail(workspaceProblem);
      const node = definedOnly<GraphNode>({
        id,
        title,
        kind: op.node.kind,
        description: op.node.description,
        prompt: op.node.prompt,
        command: op.node.command,
        timeoutSec: op.node.timeoutSec,
        access: op.node.access === 'read' ? 'read' : undefined,
        workspace,
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
      const { access, workspace, ...patch } = definedOnly<NodePatch>(op.patch);
      if (patch.title !== undefined) {
        patch.title = patch.title.trim();
        if (!patch.title) return fail('a node needs a title');
      }
      if ((patch.description?.length ?? 0) > MAX_DESCRIPTION_CHARS) return fail(DESCRIPTION_TOO_LONG);
      const kind = patch.kind ?? node.kind;
      if (access === 'read' && kind === 'command') return fail(COMMAND_ALWAYS_WRITES);
      let nextWorkspace = node.workspace;
      if (workspace !== undefined) {
        const trimmed = workspace.trim();
        const problem = trimmed === '' ? null : workspaceNameProblem(trimmed);
        if (problem) return fail(problem);
        nextWorkspace = trimmed || undefined;
      }
      // A command step can always change files, so becoming one drops `access` (spec §3.1).
      const nextAccess = kind === 'command' ? undefined : (access ?? node.access) === 'read' ? 'read' : undefined;
      const { access: _access, workspace: _workspace, ...base } = node;
      const updated: GraphNode = {
        ...base,
        ...patch,
        ...(nextAccess && { access: nextAccess }),
        ...(nextWorkspace && { workspace: nextWorkspace }),
        updatedBy: by,
        updatedAt: now,
      };
      return done({ nodes: graph.nodes.map((n) => (n.id === op.id ? updated : n)) });
    }
```

- In `contentSignature`, change the node tuple to:

```ts
    nodes: g.nodes.map((n) => [n.id, n.kind, n.title, n.description ?? '', n.prompt ?? '', n.command ?? '', n.timeoutSec ?? null, n.access ?? 'write', n.workspace ?? '']),
```

- In `reusableNodeIds`, replace the line `const sameDefinition = …` and the line `if (!succeeded || …) seeds.add(n.id);` with:

```ts
    // What a step may do and where it runs are part of its definition (spec §3.1, §3.1a).
    const sameAccess = n.kind !== 'agent' || (prev?.access ?? 'write') === (n.access ?? 'write');
    const samePlace = (prev?.workspace ?? '') === (n.workspace ?? '');
    const sameDefinition = !!prev && prev.kind === n.kind && sameText && sameDescription && sameAccess && samePlace;
    const sameInputs = !!prev && sameSet(upstream(graph, n.id), upstream(source.snapshot, n.id));
    // A step with a workspace is never reused: its files lived in that run's own worktree (spec §4.3a).
    if (!succeeded || !sameDefinition || !sameInputs || n.workspace) seeds.add(n.id);
```

(Delete the old `const sameInputs` line, because the block above redefines it.) Also add to the function's doc comment: "…changed access or workspace, has a workspace…".

In `shared/src/schemas.ts`:
- Add `import { COMMAND_ALWAYS_WRITES, workspaceNameProblem } from './access';`.
- Add `const access = z.enum(['read', 'write']);`.
- Add `access: access.optional(), workspace: z.string().optional(),` to `graphNodeSchema`, to `newNode` and to `nodePatch` (after `timeoutSec`).
- In `parseGraph`'s node loop, after the duplicate-id check, add:

```ts
    if (n.access === 'read' && n.kind === 'command') return { ok: false, error: `${n.id}: ${COMMAND_ALWAYS_WRITES}` };
    const workspaceProblem = n.workspace === undefined ? null : workspaceNameProblem(n.workspace);
    if (workspaceProblem) return { ok: false, error: `${n.id}: ${workspaceProblem}` };
```

In `shared/src/exportFile.ts`, make `ExportedNode` `Pick<GraphNode, 'id' | 'title' | 'kind' | 'description' | 'prompt' | 'command' | 'timeoutSec' | 'access' | 'workspace' | 'position'>`, and change the node mapping to:

```ts
      nodes: graph.nodes.map(({ id, title, kind, description, prompt, command, timeoutSec, access, workspace, position }) =>
        JSON.parse(JSON.stringify({ id, title, kind, description, prompt, command, timeoutSec, access, workspace, position })) as ExportedNode,
      ),
```

In `shared/src/changes.ts`, change `FIELDS` to `['title', 'description', 'kind', 'prompt', 'command', 'timeoutSec', 'access', 'workspace']`.

In `shared/src/index.ts`, add `export * from './access';`.

In `engine/src/graphStore.ts`, replace `withContentOf` with:

```ts
function withContentOf(node: GraphNode, source: GraphNode): GraphNode {
  const { description: _d, prompt: _p, command: _c, timeoutSec: _t, access: _a, workspace: _w, ...rest } = node;
  const optional = { description: source.description, prompt: source.prompt, command: source.command, timeoutSec: source.timeoutSec, access: source.access, workspace: source.workspace };
  return { ...rest, title: source.title, kind: source.kind, ...Object.fromEntries(Object.entries(optional).filter(([, v]) => v !== undefined)) };
}
```

In `engine/src/stepGraphTools.ts`, change the two constants to:

```ts
const FIELD_ORDER: ChangedField[] = ['prompt', 'command', 'title', 'description', 'kind', 'timeoutSec', 'access', 'workspace'];
const FIELD_NAMES: Record<ChangedField, string> = { prompt: 'prompt', command: 'command', title: 'title', description: 'description', kind: 'kind', timeoutSec: 'timeout', access: 'access', workspace: 'workspace' };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -w shared && npm test -w engine && npm run typecheck`
Expected: PASS. The web and extension typecheck too, since nothing there narrows on `ChangedField`.

- [ ] **Step 5: Commit**

```bash
git add shared/src shared/test engine/src/graphStore.ts engine/src/stepGraphTools.ts engine/test/graphStore.test.ts
git commit -m "feat(shared): read-only access and variant workspace on steps

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Shared — checkout and lease protocol

**Files:**
- Create: `shared/src/checkout.ts`, `shared/test/checkout.test.ts`
- Modify: `shared/src/types.ts` (`RunMeta`, `RunSummary`, `RunPreview`, `ServerMessage`, `ClientMessage`, `WebviewHostMessage`; new types), `shared/src/schemas.ts:105-131`, `shared/src/index.ts`
- Modify: `engine/src/runStore.ts:73-90` (`list`), `:124-139` (`recoverInterrupted`)
- Modify: `web/src/state.ts`
- Test: `shared/test/schemas.test.ts`, `engine/test/runStore.test.ts`, `web/test/state.test.ts`

**Interfaces:**
- Produces (in `@agent-stream/shared`):
  ```ts
  export type CheckoutInfo =
    | { git: false; root: string; reason: string }
    | { git: true; root: string; linkedWorktree: boolean; branch?: string; head?: string; dirty: boolean;
        worktrees: { path: string; branch?: string; head?: string; current: boolean }[] };
  export type LeaseHolder = { runId: string; graphId: string; folder: string; pid: number; startedAt: string };
  export type RunCheckout = { root: string; branch?: string; head?: string; linkedWorktree: boolean };
  export type RunWorkspace = { path: string; head: string; removed?: boolean };
  export type WaitingFor = { runId: string; graphId: string; folder: string };
  // RunMeta gains: checkout?: RunCheckout; workspaces?: Record<string, RunWorkspace>; waitingFor?: WaitingFor;
  // RunSummary gains: checkout?: RunCheckout; waitingFor?: WaitingFor;
  // RunPreview gains: notes?: string[]; checkout?: CheckoutInfo;
  // ServerMessage gains:
  //   | { type: 'checkout'; info: CheckoutInfo; lease?: LeaseHolder }
  //   | { type: 'runBlocked'; graphId: string; message: string; holder: LeaseHolder; otherWindow: boolean; checkout: CheckoutInfo; canSetUpTickets: boolean }
  // ClientMessage: startRun gains `sequential?: boolean`; new | { type: 'inspectCheckout' }
  // WebviewHostMessage gains | { type: 'setUpParallelTickets' }
  export function folderName(path: string): string;
  export function toRunCheckout(info: CheckoutInfo): RunCheckout;
  export function checkoutChip(info: CheckoutInfo): string;
  export function checkoutTooltip(info: CheckoutInfo): string;
  export function ranIn(c: RunCheckout): string;
  export function waitingText(w: WaitingFor, graphName: string): string;
  ```
- Produces (in `web/src/state.ts`):
  ```ts
  export type StartRequest = { graphId: string; reviewed: string; fromNodeId?: string; sourceRunId?: string };
  export type Blocked = { message: string; canSetUpTickets: boolean; start?: StartRequest };
  // State gains: checkout?: { info: CheckoutInfo; lease?: LeaseHolder }; lastStart?: StartRequest; blocked?: Blocked;
  // Action gains: | { kind: 'startRequested'; start: StartRequest } | { kind: 'closeBlocked' }
  ```

- [ ] **Step 1: Write the failing tests**

Create `shared/test/checkout.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { checkoutChip, checkoutTooltip, folderName, ranIn, toRunCheckout, waitingText } from '../src/checkout';
import type { CheckoutInfo } from '../src/types';

const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const main: CheckoutInfo = {
  git: true,
  root: '/work/app',
  linkedWorktree: false,
  branch: 'main',
  head: SHA,
  dirty: false,
  worktrees: [
    { path: '/work/app', branch: 'main', head: SHA, current: true },
    { path: '/work/app-abc-1', branch: 'feat/abc-1', head: SHA, current: false },
  ],
};

describe('checkout texts', () => {
  it('names the branch, a detached head, a linked worktree, or why there is no Git', () => {
    expect(checkoutChip(main)).toBe('⎇ main');
    expect(checkoutChip({ ...main, branch: undefined })).toBe('⎇ detached a1b2c3d');
    expect(checkoutChip({ ...main, root: '/work/app-abc-1', linkedWorktree: true, branch: 'feat/abc-1' })).toBe('⎇ feat/abc-1 · worktree app-abc-1');
    expect(checkoutChip({ git: false, root: '/work/notes', reason: 'Not a Git repository' })).toBe('Not a Git repository');
    expect(checkoutChip({ git: false, root: '/work/notes', reason: "Git isn't available" })).toBe("Git isn't available");
  });

  it('shows the root, the HEAD commit and the other worktrees as the tooltip', () => {
    expect(checkoutTooltip(main)).toBe(`Root: /work/app\nHEAD: ${SHA}\nOther worktrees:\n  /work/app-abc-1 · feat/abc-1`);
    expect(checkoutTooltip({ ...main, head: undefined, worktrees: [] })).toBe('Root: /work/app\nHEAD: no commits yet');
  });

  it('records where a run ran, and says so', () => {
    expect(toRunCheckout(main)).toEqual({ root: '/work/app', branch: 'main', head: SHA, linkedWorktree: false });
    expect(toRunCheckout({ git: false, root: '/work/notes', reason: 'Not a Git repository' })).toEqual({ root: '/work/notes', linkedWorktree: false });
    expect(ranIn(toRunCheckout(main))).toBe('Ran in /work/app on main at a1b2c3d');
    expect(ranIn({ root: '/work/app', head: SHA, linkedWorktree: false })).toBe('Ran in /work/app at a1b2c3d');
    expect(ranIn({ root: '/work/notes', linkedWorktree: false })).toBe('Ran in /work/notes');
  });

  it('says what a waiting run waits for', () => {
    expect(waitingText({ runId: '20261003-101500-abcd', graphId: 'billing', folder: '/work/app' }, 'Billing')).toBe(
      'Waiting for run 20261003-101500-abcd ("Billing") to finish changing files',
    );
  });

  it('takes the last folder of either kind of path', () => {
    expect(folderName('/work/app-abc-1')).toBe('app-abc-1');
    expect(folderName('C:\\work\\app-abc-1\\')).toBe('app-abc-1');
  });
});
```

Append to `shared/test/schemas.test.ts`, inside `describe('parseWebviewMessage', …)`:

```ts
  it('accepts inspectCheckout, a sequential startRun and the setUpParallelTickets host message', () => {
    expect(parseWebviewMessage({ type: 'inspectCheckout' })).toEqual({ ok: true, kind: 'engine', msg: { type: 'inspectCheckout' } });
    expect(parseWebviewMessage({ type: 'startRun', graphId: 'g', reviewed: 's', sequential: true })).toMatchObject({ ok: true, kind: 'engine', msg: { sequential: true } });
    expect(parseWebviewMessage({ type: 'setUpParallelTickets' })).toEqual({ ok: true, kind: 'host', msg: { type: 'setUpParallelTickets' } });
  });
```

Append to `engine/test/runStore.test.ts`, inside `describe('RunStore', …)`. It uses the file's `meta(id, graphId, status)` helper:

```ts
  it('lists where a run ran and what it waits for, and forgets the wait when it recovers an interrupted run', () => {
    const store = new RunStore(tmpProject());
    const checkout = { root: '/work/app', branch: 'main', head: 'a1b2c3d4', linkedWorktree: false };
    const waitingFor = { runId: '20261003-090000-aaaa', graphId: 'other', folder: '/work/app' };
    const run: RunMeta = { ...meta('20261003-100000-bbbb', 'g', 'running'), checkout, waitingFor };
    store.create(run);
    expect(store.list(run.graphId)[0]).toMatchObject({ id: run.id, checkout, waitingFor });
    store.recoverInterrupted('2026-10-03T11:00:00.000Z');
    expect(store.get(run.id)).not.toHaveProperty('waitingFor');
    expect(store.get(run.id)?.checkout).toEqual(checkout);
  });
```

Append to `web/test/state.test.ts`:

```ts
describe('checkout and blocked runs', () => {
  const info = { git: false as const, root: '/p', reason: 'Not a Git repository' };
  const holder = { runId: '20261003-090000-aaaa', graphId: 'other', folder: '/p', pid: 1, startedAt: 't' };

  it('keeps the latest checkout and lease', () => {
    const s = apply(server({ type: 'checkout', info, lease: holder }));
    expect(s.checkout).toEqual({ info, lease: holder });
    expect(reduce(s, server({ type: 'checkout', info })).checkout).toEqual({ info });
  });

  it("shows a blocked run for this graph with the start it refused, and forgets it on close", () => {
    const start = { graphId: 'a', reviewed: 'sig', fromNodeId: undefined, sourceRunId: undefined };
    const blocked = { type: 'runBlocked' as const, graphId: 'a', message: 'no', holder, otherWindow: false, checkout: info, canSetUpTickets: false };
    const s = apply(opened(graph('a')), { kind: 'startRequested', start }, server(blocked));
    expect(s.blocked).toEqual({ message: 'no', canSetUpTickets: false, start });
    expect(reduce(s, { kind: 'closeBlocked' }).blocked).toBeUndefined();
    expect(apply(opened(graph('b')), server(blocked)).blocked).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w shared && npm test -w engine -- runStore && npm test -w web -- state`
Expected: FAIL. `checkout.ts`, the message types and the state cases don't exist.

- [ ] **Step 3: Implement**

In `shared/src/types.ts`, add after `RunPreview`:

```ts
/** Where a folder's graphs work (spec §3.2). `root` is a real path: the Git top-level, or the folder itself outside Git. */
export type CheckoutInfo =
  | { git: false; root: string; reason: string }
  | {
      git: true;
      root: string;
      linkedWorktree: boolean;
      /** Absent when HEAD is detached. */
      branch?: string;
      /** Absent before the first commit. */
      head?: string;
      /** Tracked files modified or staged. */
      dirty: boolean;
      worktrees: { path: string; branch?: string; head?: string; current: boolean }[];
    };

/** The run changing files in a checkout (spec §4.2). */
export type LeaseHolder = { runId: string; graphId: string; folder: string; pid: number; startedAt: string };
/** Where a run ran, recorded when it starts. */
export type RunCheckout = { root: string; branch?: string; head?: string; linkedWorktree: boolean };
/** A variant workspace a run created (spec §4.3a); `removed` once Manage Run Workspaces removed it. */
export type RunWorkspace = { path: string; head: string; removed?: boolean };
/** The run whose lease a sequential run's write-capable steps wait for. */
export type WaitingFor = { runId: string; graphId: string; folder: string };
```

Add these to `RunPreview` (after `signature`):

```ts
  /** Shown, never block (spec §4.7): writers that take turns, uncommitted changes left out of workspaces. */
  notes?: string[];
  /** The checkout the run will use: the dialog's Checkout line. */
  checkout?: CheckoutInfo;
```

Add these to `RunMeta` (after `amendments`):

```ts
  /** Where the run ran, recorded when it started. */
  checkout?: RunCheckout;
  /** One entry per variant workspace the run created. */
  workspaces?: Record<string, RunWorkspace>;
  /** Set while the run's write-capable steps wait for another run's write lease. */
  waitingFor?: WaitingFor;
```

Change `RunSummary` to:

```ts
export type RunSummary = { id: string; graphId: string; status: RunStatus; startedAt: string; endedAt?: string; provider?: ProviderId; amendments?: number; checkout?: RunCheckout; waitingFor?: WaitingFor };
```

Add to `ServerMessage`, before the `error` member:

```ts
  /** Where this folder's graphs work and who holds its write lease: after hello, on request, and when a run starts, ends or stops waiting. */
  | { type: 'checkout'; info: CheckoutInfo; lease?: LeaseHolder }
  /** A run was refused because another run is changing files in this checkout (spec §4.5). Not an error. */
  | { type: 'runBlocked'; graphId: string; message: string; holder: LeaseHolder; otherWindow: boolean; checkout: CheckoutInfo; canSetUpTickets: boolean }
```

Change the `startRun` member of `ClientMessage` to `| { type: 'startRun'; graphId: string; reviewed: string; fromNodeId?: string; sourceRunId?: string; sequential?: boolean }`, and add `| { type: 'inspectCheckout' }`. Add `| { type: 'setUpParallelTickets' }` to `WebviewHostMessage`.

Create `shared/src/checkout.ts`:

```ts
import type { CheckoutInfo, RunCheckout, WaitingFor } from './types';

const sha7 = (sha?: string): string => (sha ? sha.slice(0, 7) : '');

/** The last folder of a path, whichever separator it uses. */
export function folderName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

export function toRunCheckout(info: CheckoutInfo): RunCheckout {
  if (!info.git) return { root: info.root, linkedWorktree: false };
  return { root: info.root, ...(info.branch && { branch: info.branch }), ...(info.head && { head: info.head }), linkedWorktree: info.linkedWorktree };
}

/** The graph tab's chip (spec §7): `⎇ main`, `⎇ detached abc1234`, `… · worktree <folder>`, or why there is no Git. */
export function checkoutChip(info: CheckoutInfo): string {
  if (!info.git) return info.reason;
  const where = info.branch ? `⎇ ${info.branch}` : `⎇ detached ${sha7(info.head)}`.trimEnd();
  return info.linkedWorktree ? `${where} · worktree ${folderName(info.root)}` : where;
}

/** The chip's tooltip: the root, the HEAD commit and the other worktrees. */
export function checkoutTooltip(info: CheckoutInfo): string {
  if (!info.git) return `${info.root}\n${info.reason}`;
  const others = info.worktrees.filter((w) => !w.current);
  return [
    `Root: ${info.root}`,
    `HEAD: ${info.head ?? 'no commits yet'}`,
    ...(others.length ? ['Other worktrees:', ...others.map((w) => `  ${w.path} · ${w.branch ?? `detached ${sha7(w.head)}`}`)] : []),
  ].join('\n');
}

/** A run's tooltip line (spec §7): `Ran in <root> on <branch> at <sha7>`. */
export function ranIn(c: RunCheckout): string {
  return `Ran in ${c.root}${c.branch ? ` on ${c.branch}` : ''}${c.head ? ` at ${sha7(c.head)}` : ''}`;
}

export function waitingText(w: WaitingFor, graphName: string): string {
  return `Waiting for run ${w.runId} ("${graphName}") to finish changing files`;
}
```

Add `export * from './checkout';` to `shared/src/index.ts`.

In `shared/src/schemas.ts`:
- Change the `startRun` schema to `z.object({ type: z.literal('startRun'), graphId: z.string(), reviewed: z.string(), fromNodeId: z.string().optional(), sourceRunId: z.string().optional(), sequential: z.boolean().optional() })`.
- Add `z.object({ type: z.literal('inspectCheckout') }),` to `clientMessageSchema`.
- Add `z.object({ type: z.literal('setUpParallelTickets') }),` to `webviewHostSchema`.

In `engine/src/runStore.ts`, change the mapping in `list` to:

```ts
      .map(({ id, graphId: g, status, startedAt, endedAt, provider, amendments, checkout, waitingFor }) => ({
        id,
        graphId: g,
        status,
        startedAt,
        endedAt,
        ...(provider && { provider }),
        ...(amendments?.length && { amendments: amendments.length }),
        ...(checkout && { checkout }),
        ...(waitingFor && { waitingFor }),
      }));
```

In `recoverInterrupted`, after `meta.endedAt = now;`, add `delete meta.waitingFor;`.

In `web/src/state.ts`:
- Import `CheckoutInfo` and `LeaseHolder` types from `@agent-stream/shared`.
- Add the exported types:

```ts
export type StartRequest = { graphId: string; reviewed: string; fromNodeId?: string; sourceRunId?: string };
/** A start the engine refused because another run is changing files in this checkout (spec §7). */
export type Blocked = { message: string; canSetUpTickets: boolean; start?: StartRequest };
```

- Add these fields to `State`:

```ts
  /** Where this folder's graphs work and who holds its write lease. */
  checkout?: { info: CheckoutInfo; lease?: LeaseHolder };
  /** The last Start the run dialog sent: Run after it finishes re-sends it. */
  lastStart?: StartRequest;
  blocked?: Blocked;
```

- Add `| { kind: 'startRequested'; start: StartRequest } | { kind: 'closeBlocked' }` to `Action`.
- In `reduce`, add these cases:

```ts
    case 'startRequested':
      return { ...state, lastStart: action.start };
    case 'closeBlocked':
      return { ...state, blocked: undefined };
```

- In `reduceServer`, add these cases:

```ts
    case 'checkout':
      return { ...state, checkout: { info: msg.info, ...(msg.lease && { lease: msg.lease }) } };
    case 'runBlocked':
      return msg.graphId === current
        ? { ...state, blocked: { message: msg.message, canSetUpTickets: msg.canSetUpTickets, ...(state.lastStart?.graphId === msg.graphId && { start: state.lastStart }) } }
        : state;
```

- In the `graphOpened` case, extend the line `...(current !== msg.graph.id && { selectedChange: undefined, changeConfirm: undefined }),` to also clear `blocked: undefined`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -w shared && npm test -w engine -- runStore && npm test -w web -- state && npm run typecheck`
Expected: PASS. The engine's `handle` and the extension's host switch don't need the new cases yet: they return `void`, so a missing case still compiles.

- [ ] **Step 5: Commit**

```bash
git add shared/src shared/test engine/src/runStore.ts engine/test/runStore.test.ts web/src/state.ts web/test/state.test.ts
git commit -m "feat(shared): checkout, lease and blocked-run protocol

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 3: Engine — Git behind an abstraction

**Files:**
- Create: `engine/src/git.ts`, `engine/test/git.test.ts`
- Modify: `engine/test/helpers.ts` (fake Git), `engine/src/index.ts`

**Interfaces:**
- Consumes: `CheckoutInfo` (Task 2).
- Produces (in `engine/src/git.ts`, re-exported from `@agent-stream/engine`):
  ```ts
  export type GitResult = { code: number; stdout: string; stderr: string };
  export type GitExec = (args: string[], cwd: string) => Promise<GitResult>;
  export const GIT_MISSING = "Git isn't available";
  export const NOT_A_REPO = 'Not a Git repository';
  export const realGit: GitExec;                       // never throws; a missing git gives { code: -1, stderr: 'git not found' }
  export function realOrResolved(p: string): string;   // realpathSync, or path.resolve when p doesn't exist
  export type WorktreeEntry = { path: string; branch?: string; head?: string };
  export function parseWorktreeList(porcelain: string): WorktreeEntry[];
  export function inspectCheckout(folder: string, git: GitExec): Promise<CheckoutInfo>;
  ```
- Produces (in `engine/test/helpers.ts`, for later tasks):
  ```ts
  export type GitAnswer = Partial<GitResult> | ((cwd: string, args: string[]) => Partial<GitResult>);
  export function fakeGit(answers?: Record<string, GitAnswer>): { exec: GitExec; calls: { args: string[]; cwd: string }[]; ran(): string[] };
  //   keys are args.join(' '); a key ending in ' *' matches by prefix; anything else exits 1
  export const noGit: GitExec;       // exit 128, "not a git repository"
  export const missingGit: GitExec;  // exit -1, "git not found"
  export type RepoOptions = { root: string; branch?: string; head?: string; dirty?: boolean; mainRoot?: string; worktrees?: WorktreeEntry[]; answers?: Record<string, GitAnswer> };
  export function repoAnswers(o: RepoOptions): Record<string, GitAnswer>;
  export function repoGit(o: RepoOptions): ReturnType<typeof fakeGit>;
  ```

- [ ] **Step 1: Write the fake Git helpers and the failing tests**

Add to `engine/test/helpers.ts`. Add `basename` and `relative` to its `node:path` import. Add the import `import type { GitExec, GitResult, WorktreeEntry } from '../src/git';`. Then add:

```ts
export type GitAnswer = Partial<GitResult> | ((cwd: string, args: string[]) => Partial<GitResult>);

/** A fake GitExec: answers by the joined arguments (a key ending in ' *' matches by prefix); anything else exits 1. No test runs real git. */
export function fakeGit(answers: Record<string, GitAnswer> = {}) {
  const calls: { args: string[]; cwd: string }[] = [];
  const exec: GitExec = async (args, cwd) => {
    calls.push({ args, cwd });
    const key = args.join(' ');
    const prefix = Object.keys(answers).find((k) => k.endsWith(' *') && key.startsWith(k.slice(0, -1)));
    const answer = answers[key] ?? (prefix === undefined ? undefined : answers[prefix]);
    const r = typeof answer === 'function' ? answer(cwd, args) : answer;
    return r ? { code: r.code ?? 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '' } : { code: 1, stdout: '', stderr: `unexpected: git ${key}` };
  };
  return { exec, calls, ran: () => calls.map((c) => c.args.join(' ')) };
}

export const noGit: GitExec = async () => ({ code: 128, stdout: '', stderr: 'fatal: not a git repository (or any of the parent directories): .git' });
export const missingGit: GitExec = async () => ({ code: -1, stdout: '', stderr: 'git not found' });

export type RepoOptions = { root: string; branch?: string; head?: string; dirty?: boolean; mainRoot?: string; worktrees?: WorktreeEntry[]; answers?: Record<string, GitAnswer> };

/** What inspectCheckout asks, answered for a checkout at `root` (an existing temp folder). `mainRoot` makes it a linked worktree of that checkout. */
export function repoAnswers(o: RepoOptions): Record<string, GitAnswer> {
  const main = o.mainRoot ?? o.root;
  const entries: WorktreeEntry[] = [
    { path: main, branch: o.mainRoot ? 'main' : o.branch, head: o.head },
    ...(o.mainRoot ? [{ path: o.root, branch: o.branch, head: o.head }] : []),
    ...(o.worktrees ?? []),
  ];
  const list = entries
    .map((w) => [`worktree ${w.path}`, `HEAD ${w.head ?? '0'.repeat(40)}`, w.branch ? `branch refs/heads/${w.branch}` : 'detached'].join('\n'))
    .join('\n\n');
  return {
    'rev-parse --show-toplevel': { stdout: `${o.root}\n` },
    'rev-parse --absolute-git-dir': { stdout: `${o.mainRoot ? join(main, '.git', 'worktrees', basename(o.root)) : join(o.root, '.git')}\n` },
    // Real git prints the common dir relative to the folder it runs in (`.git`, `../../.git`); a linked worktree's is absolute.
    'rev-parse --git-common-dir': (cwd) => ({ stdout: `${o.mainRoot ? join(main, '.git') : relative(cwd, join(o.root, '.git'))}\n` }),
    'symbolic-ref --quiet --short HEAD': o.branch ? { stdout: `${o.branch}\n` } : { code: 1 },
    'rev-parse --verify --quiet HEAD': o.head ? { stdout: `${o.head}\n` } : { code: 1 },
    'status --porcelain --untracked-files=no': { stdout: o.dirty ? ' M src/app.ts\n' : '' },
    'worktree list --porcelain': { stdout: `${list}\n` },
    ...o.answers,
  };
}

export const repoGit = (o: RepoOptions) => fakeGit(repoAnswers(o));
```

Create `engine/test/git.test.ts`:

```ts
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { inspectCheckout, parseWorktreeList } from '../src/git';
import { missingGit, noGit, repoGit } from './helpers';

const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const tmp = (name: string) => realpathSync(mkdtempSync(join(tmpdir(), `agent-stream-${name}-`)));

describe('inspectCheckout', () => {
  it('describes a main checkout and its other worktrees', async () => {
    const root = tmp('repo');
    const other = join(tmp('wt'), 'app-abc-1');
    const info = await inspectCheckout(root, repoGit({ root, branch: 'main', head: SHA, worktrees: [{ path: other, branch: 'feat/abc-1', head: SHA }] }).exec);
    expect(info).toEqual({
      git: true,
      root,
      linkedWorktree: false,
      branch: 'main',
      head: SHA,
      dirty: false,
      worktrees: [
        { path: root, branch: 'main', head: SHA, current: true },
        { path: other, branch: 'feat/abc-1', head: SHA, current: false },
      ],
    });
  });

  it('describes a linked worktree', async () => {
    const main = tmp('repo');
    const root = tmp('app-abc-1');
    const info = await inspectCheckout(root, repoGit({ root, mainRoot: main, branch: 'feat/abc-1', head: SHA }).exec);
    expect(info).toMatchObject({ git: true, root, linkedWorktree: true, branch: 'feat/abc-1' });
    expect(info.git && info.worktrees.map((w) => [w.path, w.current])).toEqual([
      [main, false],
      [root, true],
    ]);
  });

  it('reports a detached HEAD and modified tracked files', async () => {
    const root = tmp('repo');
    const info = await inspectCheckout(root, repoGit({ root, head: SHA, dirty: true }).exec);
    expect(info).toMatchObject({ git: true, head: SHA, dirty: true });
    expect(info).not.toHaveProperty('branch');
  });

  it('has a branch but no head before the first commit', async () => {
    const root = tmp('repo');
    const info = await inspectCheckout(root, repoGit({ root, branch: 'main' }).exec);
    expect(info).toMatchObject({ git: true, branch: 'main' });
    expect(info).not.toHaveProperty('head');
    expect(info.git && info.worktrees[0]).toEqual({ path: root, branch: 'main', current: true });
  });

  it('reports a folder outside Git by its real path', async () => {
    const folder = tmp('plain');
    expect(await inspectCheckout(folder, noGit)).toEqual({ git: false, root: folder, reason: 'Not a Git repository' });
  });

  it("says when Git isn't available", async () => {
    const folder = tmp('plain');
    expect(await inspectCheckout(folder, missingGit)).toEqual({ git: false, root: folder, reason: "Git isn't available" });
  });

  it('reports the top-level folder as the root of a subfolder (Review Focus 1)', async () => {
    const root = tmp('repo');
    const sub = join(root, 'packages', 'web');
    mkdirSync(sub, { recursive: true });
    const git = repoGit({ root, branch: 'main', head: SHA });
    expect(await inspectCheckout(sub, git.exec)).toMatchObject({ git: true, root, linkedWorktree: false });
    expect(git.calls.every((c) => c.cwd === sub)).toBe(true);
  });

  it('runs exactly the documented git commands', async () => {
    const root = tmp('repo');
    const git = repoGit({ root, branch: 'main', head: SHA });
    await inspectCheckout(root, git.exec);
    expect(git.ran().sort()).toEqual(
      [
        'rev-parse --show-toplevel',
        'rev-parse --absolute-git-dir',
        'rev-parse --git-common-dir',
        'symbolic-ref --quiet --short HEAD',
        'rev-parse --verify --quiet HEAD',
        'status --porcelain --untracked-files=no',
        'worktree list --porcelain',
      ].sort(),
    );
  });
});

describe('parseWorktreeList', () => {
  it('reads paths, heads and branches, and leaves out a detached branch and an unborn head', () => {
    const text = [
      `worktree ${join('/', 'work', 'app')}`,
      `HEAD ${SHA}`,
      'branch refs/heads/main',
      '',
      `worktree ${join('/', 'work', 'app-abc-1')}`,
      `HEAD ${SHA}`,
      'detached',
      '',
      `worktree ${join('/', 'work', 'app-new')}`,
      `HEAD ${'0'.repeat(40)}`,
      'branch refs/heads/feat/new',
      '',
    ].join('\r\n');
    expect(parseWorktreeList(text)).toEqual([
      { path: join('/', 'work', 'app'), head: SHA, branch: 'main' },
      { path: join('/', 'work', 'app-abc-1'), head: SHA },
      { path: join('/', 'work', 'app-new'), branch: 'feat/new' },
    ]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w engine -- git`
Expected: FAIL with "Failed to load url ../src/git" (the module doesn't exist).

- [ ] **Step 3: Implement `engine/src/git.ts`**

```ts
import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import type { CheckoutInfo } from '@agent-stream/shared';

export type GitResult = { code: number; stdout: string; stderr: string };
/** Runs `git <args>` in `cwd`. Unit tests pass a fake; nothing in a test runs real git (spec §4.1). */
export type GitExec = (args: string[], cwd: string) => Promise<GitResult>;

export const GIT_MISSING = "Git isn't available";
export const NOT_A_REPO = 'Not a Git repository';

/** The real git. Never throws: a missing git is `{ code: -1, stderr: 'git not found' }`. */
export const realGit: GitExec = (args, cwd) =>
  new Promise((done) => {
    execFile('git', args, { cwd, timeout: 15_000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = (error as { code?: unknown } | null)?.code;
      if (code === 'ENOENT') return done({ code: -1, stdout: '', stderr: 'git not found' });
      done({ code: !error ? 0 : typeof code === 'number' ? code : 1, stdout: String(stdout), stderr: String(stderr) });
    });
  });

/** The real path of `p`, or `p` resolved when it doesn't exist (a worktree deleted by hand). */
export function realOrResolved(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

export type WorktreeEntry = { path: string; branch?: string; head?: string };

/** `git worktree list --porcelain`: one block per worktree. A detached one has no branch; an unborn one (all-zero HEAD) has no head. */
export function parseWorktreeList(porcelain: string): WorktreeEntry[] {
  const out: WorktreeEntry[] = [];
  let current: WorktreeEntry | undefined;
  for (const raw of porcelain.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (line.startsWith('worktree ')) {
      current = { path: line.slice('worktree '.length) };
      out.push(current);
    } else if (current && line.startsWith('HEAD ')) {
      const sha = line.slice('HEAD '.length);
      if (!/^0+$/.test(sha)) current.head = sha;
    } else if (current && line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
    }
  }
  return out;
}

const text = (r: GitResult): string | undefined => (r.code === 0 && r.stdout.trim() ? r.stdout.trim() : undefined);

/** Where `folder` works (spec §4.1): its Git top-level, branch, HEAD and worktrees; outside Git, its own real path and why. */
export async function inspectCheckout(folder: string, git: GitExec): Promise<CheckoutInfo> {
  const top = await git(['rev-parse', '--show-toplevel'], folder);
  if (top.code !== 0 || !top.stdout.trim()) return { git: false, root: realOrResolved(folder), reason: top.code === -1 ? GIT_MISSING : NOT_A_REPO };
  const root = realOrResolved(top.stdout.trim());
  const [absolute, common, symbolic, head, status, list] = await Promise.all([
    git(['rev-parse', '--absolute-git-dir'], folder),
    git(['rev-parse', '--git-common-dir'], folder),
    git(['symbolic-ref', '--quiet', '--short', 'HEAD'], folder),
    git(['rev-parse', '--verify', '--quiet', 'HEAD'], folder),
    git(['status', '--porcelain', '--untracked-files=no'], folder),
    git(['worktree', 'list', '--porcelain'], folder),
  ]);
  const gitDir = text(absolute);
  const commonDir = text(common);
  // The common dir is printed relative to the folder git ran in.
  const linkedWorktree = !!gitDir && !!commonDir && realOrResolved(gitDir) !== realOrResolved(resolve(folder, commonDir));
  const branch = text(symbolic);
  const sha = text(head);
  const worktrees = parseWorktreeList(list.code === 0 ? list.stdout : '').map((w) => ({ ...w, current: realOrResolved(w.path) === root }));
  return { git: true, root, linkedWorktree, ...(branch && { branch }), ...(sha && { head: sha }), dirty: status.code === 0 && status.stdout.trim() !== '', worktrees };
}
```

In `engine/src/index.ts`, add `export { GIT_MISSING, inspectCheckout, NOT_A_REPO, realGit, realOrResolved, type GitExec, type GitResult } from './git';`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -w engine -- git && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add engine/src/git.ts engine/src/index.ts engine/test/git.test.ts engine/test/helpers.ts
git commit -m "feat(engine): inspect the checkout through a GitExec abstraction

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Engine — write leases

**Files:**
- Create: `engine/src/writeLease.ts`, `engine/test/writeLease.test.ts`
- Modify: `engine/test/helpers.ts` (`testLeases`), `engine/src/index.ts`

**Interfaces:**
- Consumes: `LeaseHolder` (Task 2).
- Produces (re-exported from `@agent-stream/engine`):
  ```ts
  export type LeaseResult = { ok: true } | { ok: false; holder: LeaseHolder; otherWindow: boolean; lockFile?: string };   // lockFile: ruling R6
  export interface WriteLeases {
    acquire(checkoutRoot: string, holder: Omit<LeaseHolder, 'pid'>): LeaseResult;
    release(checkoutRoot: string, runId: string): void;
    holder(checkoutRoot: string): LeaseHolder | undefined;
    onRelease(listener: (checkoutRoot: string) => void): () => void;
  }
  export const UNKNOWN_HOLDER: LeaseHolder;   // { runId: 'unknown', graphId: 'unknown', folder: '', pid: 0, startedAt: '' }
  export function leaseKey(checkoutRoot: string): string;                 // sha256 hex, first 16 chars
  export function leaseFile(locksDir: string, checkoutRoot: string): string;
  export function processAlive(pid: number): boolean;
  export function createWriteLeases(o: { locksDir: string; pid?: number; isAlive?: (pid: number) => boolean; clock?: () => string }): WriteLeases;
  ```
- Produces (in `engine/test/helpers.ts`): `export function testLeases(o?: { pid?: number }): WriteLeases;`, which uses a temp `locksDir` and `isAlive: () => true`.

- [ ] **Step 1: Write the failing tests**

Add to `engine/test/helpers.ts`:

```ts
import { createWriteLeases, type WriteLeases } from '../src/writeLease';

/** Leases with their lock files in a fresh temp folder: no test writes to ~/.agent-stream/locks. */
export function testLeases(o: { pid?: number } = {}): WriteLeases {
  return createWriteLeases({ locksDir: mkdtempSync(join(tmpdir(), 'agent-stream-locks-')), isAlive: () => true, ...o });
}
```

Create `engine/test/writeLease.test.ts`:

```ts
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createWriteLeases, leaseFile, leaseKey, UNKNOWN_HOLDER } from '../src/writeLease';

const ROOT = join(tmpdir(), 'agent-stream-some-checkout');
const locks = () => mkdtempSync(join(tmpdir(), 'agent-stream-locks-'));
const holder = (runId: string) => ({ runId, graphId: 'g', folder: join(tmpdir(), 'proj'), startedAt: '2026-10-03T00:00:00.000Z' });

describe('write leases', () => {
  it('acquires by writing the lock file, and releases by deleting it', () => {
    const dir = locks();
    const leases = createWriteLeases({ locksDir: dir, pid: 100, isAlive: () => true });
    expect(leases.acquire(ROOT, holder('r1'))).toEqual({ ok: true });
    expect(leaseKey(ROOT)).toMatch(/^[0-9a-f]{16}$/);
    const file = leaseFile(dir, ROOT);
    expect(file).toBe(join(dir, `${leaseKey(ROOT)}.json`));
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ version: 1, ...holder('r1'), pid: 100, checkout: ROOT });
    expect(leases.holder(ROOT)).toEqual({ ...holder('r1'), pid: 100 });
    leases.release(ROOT, 'r1');
    expect(existsSync(file)).toBe(false);
    expect(leases.holder(ROOT)).toBeUndefined();
  });

  it('refuses another run of this process, and lets the holder acquire again', () => {
    const leases = createWriteLeases({ locksDir: locks(), pid: 100, isAlive: () => true });
    leases.acquire(ROOT, holder('r1'));
    expect(leases.acquire(ROOT, holder('r2'))).toEqual({ ok: false, holder: { ...holder('r1'), pid: 100 }, otherWindow: false });
    expect(leases.acquire(ROOT, holder('r1'))).toEqual({ ok: true });
  });

  it('refuses while a live process in another window holds the lock', () => {
    const dir = locks();
    createWriteLeases({ locksDir: dir, pid: 100, isAlive: () => true }).acquire(ROOT, holder('r1'));
    const other = createWriteLeases({ locksDir: dir, pid: 200, isAlive: () => true });
    expect(other.acquire(ROOT, holder('r2'))).toEqual({ ok: false, holder: { ...holder('r1'), pid: 100 }, otherWindow: true });
    expect(other.holder(ROOT)).toEqual({ ...holder('r1'), pid: 100 });
  });

  it('reclaims a lock whose process is gone', () => {
    const dir = locks();
    createWriteLeases({ locksDir: dir, pid: 100, isAlive: () => true }).acquire(ROOT, holder('r1'));
    const next = createWriteLeases({ locksDir: dir, pid: 200, isAlive: (pid) => pid !== 100 });
    expect(next.holder(ROOT)).toBeUndefined();
    expect(next.acquire(ROOT, holder('r2'))).toEqual({ ok: true });
    expect(JSON.parse(readFileSync(leaseFile(dir, ROOT), 'utf8'))).toMatchObject({ runId: 'r2', pid: 200 });
  });

  it('reclaims a lock this process left behind without an active run', () => {
    const dir = locks();
    writeFileSync(leaseFile(dir, ROOT), JSON.stringify({ version: 1, ...holder('old'), pid: 100, checkout: ROOT }));
    const leases = createWriteLeases({ locksDir: dir, pid: 100, isAlive: () => true });
    expect(leases.holder(ROOT)).toBeUndefined();
    expect(leases.acquire(ROOT, holder('r1'))).toEqual({ ok: true });
  });

  it('treats an unreadable lock file as held by an unknown run, and names the file', () => {
    const dir = locks();
    writeFileSync(leaseFile(dir, ROOT), 'not json');
    const leases = createWriteLeases({ locksDir: dir, pid: 100, isAlive: () => true });
    expect(UNKNOWN_HOLDER).toEqual({ runId: 'unknown', graphId: 'unknown', folder: '', pid: 0, startedAt: '' });
    expect(leases.acquire(ROOT, holder('r1'))).toEqual({ ok: false, holder: UNKNOWN_HOLDER, otherWindow: true, lockFile: leaseFile(dir, ROOT) });
    expect(leases.holder(ROOT)).toEqual(UNKNOWN_HOLDER);
    expect(readFileSync(leaseFile(dir, ROOT), 'utf8')).toBe('not json');
  });

  it('releases only for the run that holds the lease', () => {
    const dir = locks();
    const leases = createWriteLeases({ locksDir: dir, pid: 100, isAlive: () => true });
    leases.acquire(ROOT, holder('r1'));
    leases.release(ROOT, 'r2');
    expect(existsSync(leaseFile(dir, ROOT))).toBe(true);
    expect(leases.holder(ROOT)?.runId).toBe('r1');
  });

  it('tells listeners when a lease is released, in the order they subscribed, until they unsubscribe', () => {
    const leases = createWriteLeases({ locksDir: locks(), pid: 100, isAlive: () => true });
    const seen: string[] = [];
    const offA = leases.onRelease((root) => seen.push(`a:${root}`));
    leases.onRelease((root) => seen.push(`b:${root}`));
    leases.acquire(ROOT, holder('r1'));
    leases.release(ROOT, 'r1');
    expect(seen).toEqual([`a:${ROOT}`, `b:${ROOT}`]);
    offA();
    leases.acquire(ROOT, holder('r2'));
    leases.release(ROOT, 'r2');
    expect(seen).toEqual([`a:${ROOT}`, `b:${ROOT}`, `b:${ROOT}`]);
  });

  it('keeps separate checkouts apart', () => {
    const leases = createWriteLeases({ locksDir: locks(), pid: 100, isAlive: () => true });
    const other = join(tmpdir(), 'agent-stream-other-checkout');
    expect(leaseKey(other)).not.toBe(leaseKey(ROOT));
    expect(leases.acquire(ROOT, holder('r1'))).toEqual({ ok: true });
    expect(leases.acquire(other, holder('r2'))).toEqual({ ok: true });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w engine -- writeLease`
Expected: FAIL (the module doesn't exist).

- [ ] **Step 3: Implement `engine/src/writeLease.ts`**

```ts
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LeaseHolder } from '@agent-stream/shared';

export type { LeaseHolder } from '@agent-stream/shared';
/** `lockFile` is set when the lock file can't be read, so the message can name it (ruling R6). */
export type LeaseResult = { ok: true } | { ok: false; holder: LeaseHolder; otherWindow: boolean; lockFile?: string };

/** The checkout's write lease (spec §4.2): one instance per extension host, shared by every folder's engine. */
export interface WriteLeases {
  acquire(checkoutRoot: string, holder: Omit<LeaseHolder, 'pid'>): LeaseResult;
  release(checkoutRoot: string, runId: string): void;
  holder(checkoutRoot: string): LeaseHolder | undefined;
  onRelease(listener: (checkoutRoot: string) => void): () => void;
}

/** Who holds a lock file that can't be read. */
export const UNKNOWN_HOLDER: LeaseHolder = { runId: 'unknown', graphId: 'unknown', folder: '', pid: 0, startedAt: '' };

export function leaseKey(checkoutRoot: string): string {
  return createHash('sha256').update(checkoutRoot).digest('hex').slice(0, 16);
}

export function leaseFile(locksDir: string, checkoutRoot: string): string {
  return join(locksDir, `${leaseKey(checkoutRoot)}.json`);
}

/** Alive means `process.kill(pid, 0)` didn't throw ESRCH (EPERM: alive, owned by someone else). */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

type LockRead = { kind: 'none' } | { kind: 'unreadable' } | { kind: 'held'; holder: LeaseHolder };

function readLock(file: string): LockRead {
  let content: string;
  try {
    content = readFileSync(file, 'utf8');
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? { kind: 'none' } : { kind: 'unreadable' };
  }
  try {
    const j = JSON.parse(content) as Record<string, unknown>;
    if (j.version !== 1 || typeof j.runId !== 'string' || typeof j.graphId !== 'string' || typeof j.folder !== 'string' || typeof j.pid !== 'number') return { kind: 'unreadable' };
    return { kind: 'held', holder: { runId: j.runId, graphId: j.graphId, folder: j.folder, pid: j.pid, startedAt: typeof j.startedAt === 'string' ? j.startedAt : '' } };
  } catch {
    return { kind: 'unreadable' };
  }
}

export function createWriteLeases(o: { locksDir: string; pid?: number; isAlive?: (pid: number) => boolean; clock?: () => string }): WriteLeases {
  const pid = o.pid ?? process.pid;
  const isAlive = o.isAlive ?? processAlive;
  /** The leases this process holds, by checkout root. */
  const held = new Map<string, LeaseHolder>();
  /** A Set keeps subscription order: waiting runs acquire in the order they started (ruling R5). */
  const listeners = new Set<(checkoutRoot: string) => void>();
  /** Stale: its process is gone, or it is this process's pid but no active run of this process holds it. */
  const stale = (h: LeaseHolder, root: string) => !isAlive(h.pid) || (h.pid === pid && held.get(root)?.runId !== h.runId);

  return {
    acquire(root, h) {
      const mine = held.get(root);
      if (mine) return mine.runId === h.runId ? { ok: true } : { ok: false, holder: mine, otherWindow: false };
      const file = leaseFile(o.locksDir, root);
      const holder: LeaseHolder = { ...h, pid };
      // Two attempts: a stale lock is removed once, then the exclusive create is tried again.
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          mkdirSync(o.locksDir, { recursive: true });
          writeFileSync(file, `${JSON.stringify({ version: 1, ...holder, checkout: root }, null, 2)}\n`, { flag: 'wx' });
          held.set(root, holder);
          return { ok: true };
        } catch (e) {
          // Fail closed: a lock we can neither create nor read blocks like an unreadable one.
          if ((e as NodeJS.ErrnoException).code !== 'EEXIST') return { ok: false, holder: UNKNOWN_HOLDER, otherWindow: true, lockFile: file };
        }
        const lock = readLock(file);
        if (lock.kind === 'none') continue;
        if (lock.kind === 'unreadable') return { ok: false, holder: UNKNOWN_HOLDER, otherWindow: true, lockFile: file };
        if (!stale(lock.holder, root)) return { ok: false, holder: lock.holder, otherWindow: lock.holder.pid !== pid };
        rmSync(file, { force: true });
      }
      return { ok: false, holder: UNKNOWN_HOLDER, otherWindow: true, lockFile: file };
    },

    release(root, runId) {
      const mine = held.get(root);
      if (!mine || mine.runId !== runId) return;
      held.delete(root);
      const file = leaseFile(o.locksDir, root);
      const lock = readLock(file);
      if (lock.kind === 'held' && lock.holder.runId === runId && lock.holder.pid === pid) rmSync(file, { force: true });
      for (const listener of [...listeners]) {
        try {
          listener(root);
        } catch (e) {
          console.error('[agent-stream] a lease listener failed', e);
        }
      }
    },

    holder(root) {
      const mine = held.get(root);
      if (mine) return mine;
      const lock = readLock(leaseFile(o.locksDir, root));
      if (lock.kind === 'unreadable') return UNKNOWN_HOLDER;
      return lock.kind === 'held' && !stale(lock.holder, root) ? lock.holder : undefined;
    },

    onRelease(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}
```

(`clock` is accepted for symmetry with the spec's signature, but nothing uses it: `startedAt` comes from the run.)

In `engine/src/index.ts`, add `export { createWriteLeases, leaseKey, type LeaseResult, type WriteLeases } from './writeLease';`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -w engine -- writeLease && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add engine/src/writeLease.ts engine/src/index.ts engine/test/writeLease.test.ts engine/test/helpers.ts
git commit -m "feat(engine): checkout write leases with lock files across windows

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Runner — the lease, per-workspace serialization and the sequential fallback

This task changes existing behaviour, as the spec says (§2: "This changes existing behaviour for steps in the checkout"). Write-capable steps in one workspace now take turns within a run. Three existing tests assumed two write-capable checkout steps run at once, and Step 1 updates each of them:
- `engine/test/runner.test.ts` › "runs independent nodes in parallel up to maxParallel": its steps become read-only.
- `engine/test/runner.test.ts` › "skips descendants of a failed node but finishes independent branches": `c` becomes read-only.
- `engine/test/app.test.ts` › "refuses to revert a step of a run in progress": `lint` (n3) now runs after `build` (n1), so the test releases them in turn.

If any other test fails only because two write-capable checkout steps no longer overlap, update it the same way, and name it in the commit message.

**Files:**
- Modify: `engine/src/runner.ts` (deps, `StartRunInput`, `StartRunResult`, `ActiveRun`, `start`, `schedule`, `finish`; new `ensureLease`, `waitForLease`, `endWait`, `holderOf`, `writerRunning`, `dispose`, `newRunId`)
- Modify: `engine/src/app.ts:51-73` (`AppDeps`), `:135` (`new Runner`), `:307-309` (`dispose`)
- Modify: `engine/test/helpers.ts` (`appTestDeps`), `engine/test/runner.test.ts`, `engine/test/app.test.ts` (every `createApp({` gets `...appTestDeps(),`; the revert test), `engine/test/stepGraphTools.test.ts:52`, `engine/test/live.test.ts:37`
- Modify: `extension/src/engines.ts` (`EngineManagerDeps.git`, shared leases, `home`), `extension/src/extension.ts:43`
- Modify: `extension/test/helpers.ts`, `extension/test/engines.test.ts`, `extension/test/commands.test.ts:21`, `extension/test/runCommands.test.ts:20`, `extension/test/chatView.test.ts:14`, `extension/test/graphEditor.test.ts:21`, `extension/test/sessions.test.ts:15`

**Interfaces:**
- Consumes: `WriteLeases`, `LeaseHolder`, `testLeases` (Task 4); `GitExec`, `noGit`, `realGit` (Task 3); `CheckoutInfo`, `WaitingFor`, `toRunCheckout` (Task 2); `isWriteCapable`, `workspaceOf` (Task 1).
- Produces (in `engine/src/runner.ts`):
  ```ts
  export const LEASE_RETRY_MS = 3000;
  // RunnerDeps gains: leases: WriteLeases; leaseRetryMs?: number;
  // StartRunInput gains: runId?: string; sequential?: boolean; checkout?: CheckoutInfo;
  export type RunBlocked = { holder: LeaseHolder; otherWindow: boolean; checkout: CheckoutInfo; lockFile?: string };
  export type StartRunResult = { ok: true; run: RunMeta; done: Promise<RunMeta> } | { ok: false; error: string; blocked?: RunBlocked };
  class Runner { newRunId(): string; dispose(): void; /* …existing… */ }
  ```
- Produces (in `engine/src/app.ts`): `AppDeps` gains `leases: WriteLeases; git: GitExec; home: string` (all required, so no test writes to the real home or runs real git by default).
- Produces (in `extension/src/engines.ts`): `EngineManagerDeps` gains `git: GitExec`. The manager builds one `WriteLeases` with `locksDir: join(home, '.agent-stream', 'locks')` and passes it, `git` and `home` to every `createApp`.
- Produces (test helpers):
  - `engine/test/helpers.ts`: `appTestDeps(): { git: GitExec; leases: WriteLeases; home: string }`.
  - `extension/test/helpers.ts`: `noGit` and `engineTestDeps()`.

- [ ] **Step 1: Update the test setup, change the three tests, and write the failing tests**

Add to `engine/test/helpers.ts`:

```ts
/** What createApp needs besides the folder: no real Git, temp leases and a temp home folder. */
export function appTestDeps() {
  return { git: noGit, leases: testLeases(), home: mkdtempSync(join(tmpdir(), 'agent-stream-home-')) };
}
```

In `engine/test/app.test.ts`, add `appTestDeps` to the `./helpers` import. Then put `...appTestDeps(),` first in every `createApp({` object literal: lines 24, 57, 214, 249, 421, 447, 471, 753, 936, and the `base` object at line 700. In "refuses to revert a step of a run in progress", replace these four lines:

```ts
      releaseAll();
      await vi.waitFor(() => expect(app.runner.activeFor(g.id)?.nodes.n2.status).toBe('running'));
      releaseAll();
      await vi.waitFor(() => expect(app.runner.activeFor(g.id)).toBeUndefined());
```

with:

```ts
      // build (n1) and lint (n3) can both change files, so they take turns (spec §4.3); test (n2) follows build.
      releaseAll();
      await vi.waitFor(() => expect(app.runner.activeFor(g.id)?.nodes.n3.status).toBe('running'));
      releaseAll();
      await vi.waitFor(() => expect(app.runner.activeFor(g.id)?.nodes.n2.status).toBe('running'));
      releaseAll();
      await vi.waitFor(() => expect(app.runner.activeFor(g.id)).toBeUndefined());
```

In `engine/test/stepGraphTools.test.ts:52` and `engine/test/live.test.ts:37`, add `leases: testLeases(),` to the `new Runner({ … })` options, and add `testLeases` to each file's `./helpers` import.

In `engine/test/runner.test.ts`:
- Imports: add `mkdtempSync` from `node:fs`, `tmpdir` from `node:os`, `type CheckoutInfo` to the shared import, `import { createWriteLeases, type WriteLeases } from '../src/writeLease';`, and `testLeases` to the `./helpers` import.
- Add the helper `const reader = (title: string): Op => ({ type: 'addNode', node: { title, kind: 'agent', prompt: `do ${title}`, access: 'read' } });` next to `agent`.
- Replace `setup` with:

```ts
function setup(maxParallel = 3, leases: WriteLeases = testLeases(), leaseRetryMs?: number) {
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
    leases,
    leaseRetryMs,
    newRunId: () => `20261002-000000-${(seq++).toString(16).padStart(4, '0')}`,
  });
  return { runStore, broker, fake, runner, leases, projectDir: paths.root };
}
```

- In the second `new Runner({` (in "fails the node and finishes the run when completing a node throws unexpectedly"), add `leases: testLeases(),`.
- In "runs independent nodes in parallel up to maxParallel", change `graphOf([agent('a'), agent('b'), agent('c'), agent('d')])` to `graphOf([reader('a'), reader('b'), reader('c'), reader('d')])`, and add the comment `// Read-only: write-capable steps in one workspace take turns (spec §4.3).`.
- In "skips descendants of a failed node but finishes independent branches", change `agent('c')` to `reader('c')`.

Append to `engine/test/runner.test.ts`:

```ts
describe('Runner write leases', () => {
  const checkout: CheckoutInfo = { git: false, root: join(tmpdir(), 'agent-stream-checkout'), reason: 'Not a Git repository' };
  const g = (...ops: Op[]) => graphOf(ops);

  it('blocks a second write-capable run in the same checkout, from another engine, creating nothing (Review Focus 1)', async () => {
    const leases = testLeases();
    const a = setup(3, leases);
    const b = setup(3, leases);
    const first = started(a.runner.start({ ...withRendered(g(agent('a'))), checkout }));
    expect(first.run.checkout).toEqual({ root: checkout.root, linkedWorktree: false });
    const second = b.runner.start({ ...withRendered(g(agent('b'))), checkout });
    expect(second).toEqual({
      ok: false,
      error: `Run ${first.run.id} is already changing files in ${checkout.root}.`,
      blocked: { holder: { runId: first.run.id, graphId: 'g', folder: a.projectDir, pid: process.pid, startedAt: first.run.startedAt }, otherWindow: false, checkout },
    });
    expect(b.runStore.list('g')).toEqual([]);
    expect(b.runner.activeFor('g')).toBeUndefined();
    await tick();
    a.fake.finish('n1');
    await first.done;
  });

  it('starts a read-only run alongside a write-capable run', async () => {
    const leases = testLeases();
    const a = setup(3, leases);
    const b = setup(3, leases);
    const first = started(a.runner.start({ ...withRendered(g(agent('a'))), checkout }));
    const second = started(b.runner.start({ ...withRendered(g(reader('look'))), checkout }));
    expect(second.run.waitingFor).toBeUndefined();
    await tick();
    expect(b.fake.started).toEqual(['n1']);
    b.fake.finish('n1');
    expect((await second.done).status).toBe('succeeded');
    a.fake.finish('n1');
    await first.done;
  });

  it('in a sequential run, read-only steps run and write-capable steps wait until the first run ends', async () => {
    const leases = testLeases();
    const a = setup(3, leases);
    const b = setup(3, leases);
    const first = started(a.runner.start({ ...withRendered(g(agent('a'))), checkout }));
    const second = started(b.runner.start({ ...withRendered(g(reader('look'), agent('edit'))), checkout, sequential: true }));
    expect(second.run.waitingFor).toEqual({ runId: first.run.id, graphId: 'g', folder: a.projectDir });
    await tick();
    expect(b.fake.started).toEqual(['n1']);
    b.fake.finish('n1');
    await tick();
    expect(b.runner.get(second.run.id)).toMatchObject({ status: 'running', nodes: { n2: { status: 'queued' } } });
    a.fake.finish('n1');
    await first.done;
    await tick();
    expect(b.fake.started).toEqual(['n1', 'n2']);
    expect(b.runner.get(second.run.id)?.waitingFor).toBeUndefined();
    expect(leases.holder(checkout.root)?.runId).toBe(second.run.id);
    b.fake.finish('n2');
    expect((await second.done).status).toBe('succeeded');
    expect(leases.holder(checkout.root)).toBeUndefined();
  });

  it('never overlaps write-capable checkout steps of one run, while read-only ones run alongside', async () => {
    const { runner, fake } = setup(4);
    const r = started(runner.start({ ...withRendered(g(agent('a'), agent('b'), reader('c'), reader('d'))), checkout }));
    await tick();
    expect(fake.started).toEqual(['n1', 'n3', 'n4']);
    fake.finish('n3');
    fake.finish('n4');
    await tick();
    expect(fake.started).toEqual(['n1', 'n3', 'n4']);
    fake.finish('n1');
    await tick();
    expect(fake.started).toEqual(['n1', 'n3', 'n4', 'n2']);
    fake.finish('n2');
    expect((await r.done).status).toBe('succeeded');
    expect(fake.maxActive).toBe(3);
  });

  it('releases the lease on success, failure and cancel', async () => {
    const { runner, fake, leases } = setup();
    const graph = g(agent('a'));
    const ok = started(runner.start({ ...withRendered(graph), checkout }));
    expect(leases.holder(checkout.root)?.runId).toBe(ok.run.id);
    await tick();
    fake.finish('n1');
    await ok.done;
    expect(leases.holder(checkout.root)).toBeUndefined();
    const failed = started(runner.start({ ...withRendered(graph), checkout }));
    await tick();
    fake.finish('n1', { ok: false, output: '', error: 'boom' });
    expect((await failed.done).status).toBe('failed');
    expect(leases.holder(checkout.root)).toBeUndefined();
    const cancelled = started(runner.start({ ...withRendered(graph), checkout }));
    await tick();
    runner.stop(cancelled.run.id);
    expect((await cancelled.done).status).toBe('cancelled');
    expect(leases.holder(checkout.root)).toBeUndefined();
  });

  it('a cancelled waiting run never takes the lease', async () => {
    const leases = testLeases();
    const a = setup(3, leases);
    const b = setup(3, leases);
    const first = started(a.runner.start({ ...withRendered(g(agent('a'))), checkout }));
    const second = started(b.runner.start({ ...withRendered(g(agent('b'))), checkout, sequential: true }));
    b.runner.stop(second.run.id);
    const stopped = await second.done;
    expect(stopped.status).toBe('cancelled');
    expect(stopped.waitingFor).toBeUndefined();
    await tick();
    a.fake.finish('n1');
    await first.done;
    expect(leases.holder(checkout.root)).toBeUndefined();
    expect(b.fake.started).toEqual([]);
  });

  it('waiting runs take the lease in the order they started', async () => {
    const leases = testLeases();
    const a = setup(3, leases);
    const b = setup(3, leases);
    const c = setup(3, leases);
    const first = started(a.runner.start({ ...withRendered(g(agent('a'))), checkout }));
    const second = started(c.runner.start({ ...withRendered(g(agent('c'))), checkout, sequential: true }));
    const third = started(b.runner.start({ ...withRendered(g(agent('b'))), checkout, sequential: true }));
    await tick();
    a.fake.finish('n1');
    await first.done;
    expect(leases.holder(checkout.root)?.runId).toBe(second.run.id);
    expect(b.runner.get(third.run.id)?.waitingFor?.runId).toBe(second.run.id);
    await tick();
    c.fake.finish('n1');
    await second.done;
    expect(leases.holder(checkout.root)?.runId).toBe(third.run.id);
    await tick();
    b.fake.finish('n1');
    await third.done;
  });

  it('retries every few seconds while the holder is in another window', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-stream-locks-'));
    const elsewhere = join(tmpdir(), 'elsewhere');
    const otherWindow = createWriteLeases({ locksDir: dir, pid: 4242, isAlive: () => true });
    otherWindow.acquire(checkout.root, { runId: '20261003-090000-beef', graphId: 'billing', folder: elsewhere, startedAt: 't' });
    const { runner, fake } = setup(3, createWriteLeases({ locksDir: dir, isAlive: () => true }), 20);
    const r = started(runner.start({ ...withRendered(g(agent('a'))), checkout, sequential: true }));
    expect(r.run.waitingFor).toEqual({ runId: '20261003-090000-beef', graphId: 'billing', folder: elsewhere });
    otherWindow.release(checkout.root, '20261003-090000-beef');
    await vi.waitFor(() => expect(fake.started).toEqual(['n1']));
    fake.finish('n1');
    expect((await r.done).status).toBe('succeeded');
  });

  it('a sequential start takes the lease at once when it is free (Review Focus 5)', async () => {
    const { runner, fake, leases } = setup();
    const r = started(runner.start({ ...withRendered(g(agent('a'))), checkout, sequential: true }));
    expect(r.run.waitingFor).toBeUndefined();
    expect(leases.holder(checkout.root)?.runId).toBe(r.run.id);
    await tick();
    expect(fake.started).toEqual(['n1']);
    fake.finish('n1');
    expect((await r.done).status).toBe('succeeded');
  });

  it('needs no lease when its write-capable steps are all reused', async () => {
    const { runner, fake, leases } = setup();
    const graph = g(agent('a'), reader('b'), link('n1', 'n2'));
    const first = started(runner.start({ ...withRendered(graph), checkout }));
    await tick();
    fake.finish('n1');
    await tick();
    fake.finish('n2');
    await first.done;
    expect(leases.acquire(checkout.root, { runId: '20261003-090000-beef', graphId: 'x', folder: 'f', startedAt: 't' })).toEqual({ ok: true });
    const rerun = started(runner.start({ ...withRendered(graph, { sourceRunId: first.run.id, fromNodeId: 'n2' }), checkout }));
    expect(rerun.run.nodes.n1.status).toBe('reused');
    expect(rerun.run.waitingFor).toBeUndefined();
    await tick();
    fake.finish('n2');
    expect((await rerun.done).status).toBe('succeeded');
    leases.release(checkout.root, '20261003-090000-beef');
  });

  it('dispose releases every lease and stops the runs', async () => {
    const { runner, leases } = setup();
    const r = started(runner.start({ ...withRendered(g(agent('a'))), checkout }));
    await tick();
    runner.dispose();
    expect(leases.holder(checkout.root)).toBeUndefined();
    expect((await r.done).status).toBe('cancelled');
  });

  it('uses the run id it is given', () => {
    const { runner } = setup();
    const r = started(runner.start({ ...withRendered(g(reader('a'))), runId: '20261003-120000-abcd' }));
    expect(r.run.id).toBe('20261003-120000-abcd');
    runner.stop(r.run.id);
  });
});
```

Add to `extension/test/helpers.ts`:

```ts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWriteLeases, type GitExec } from '@agent-stream/engine';

export const noGit: GitExec = async () => ({ code: 128, stdout: '', stderr: 'fatal: not a git repository (or any of the parent directories): .git' });

/** What createApp needs besides the folder: no real Git, leases and a home folder in temp folders. */
export function engineTestDeps() {
  return { git: noGit, leases: createWriteLeases({ locksDir: mkdtempSync(join(tmpdir(), 'cs-locks-')), isAlive: () => true }), home: mkdtempSync(join(tmpdir(), 'cs-home-')) };
}
```

(Merge the `@agent-stream/engine` import with the file's existing `import type { AgentProvider }`.) Then:
- add `...engineTestDeps(),` first in the `createApp({` literals in `extension/test/chatView.test.ts:14`, `extension/test/graphEditor.test.ts:21` and `extension/test/sessions.test.ts:15`;
- add `git: noGit,` to the `new EngineManager({` options in `extension/test/commands.test.ts:21`, `extension/test/runCommands.test.ts:20`, and in `extension/test/engines.test.ts`: `baseDeps` (line 17), `setup` (line 34) and the one in "passes Git Bash to the engine on Windows only" (line 159).

Import `noGit`/`engineTestDeps` from `./helpers` where needed. Then append to `extension/test/engines.test.ts`:

```ts
describe('engines and the checkout', () => {
  it('gives every folder engine the same write leases, Git and home folder', () => {
    const seen: AppDeps[] = [];
    const home = mkdtempSync(join(tmpdir(), 'cs-home-'));
    const manager = new EngineManager({
      ...baseDeps(),
      home,
      git: noGit,
      settings: () => defaults,
      createApp: (deps) => {
        seen.push(deps);
        return createApp(deps);
      },
    });
    manager.get(folder('a'));
    manager.get(folder('b'));
    expect(seen).toHaveLength(2);
    expect(seen[0].leases).toBe(seen[1].leases);
    expect(seen[0].git).toBe(noGit);
    expect(seen[0].home).toBe(home);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w engine -- runner && npm test -w extension -- engines`
Expected: FAIL. `leases`, `checkout`, `sequential` and `runId` are unknown, and the second write-capable run starts.

- [ ] **Step 3: Implement the runner**

In `engine/src/runner.ts`:
- Add `isWriteCapable`, `toRunCheckout`, `workspaceOf`, `type CheckoutInfo`, `type LeaseHolder`, `type WaitingFor` to the shared import.
- Add `import type { WriteLeases } from './writeLease';`.
- Then make these changes:

```ts
/** How often a waiting run retries while the lease holder is in another VS Code window (spec §4.3). */
export const LEASE_RETRY_MS = 3000;

export type RunnerDeps = {
  runStore: RunStore;
  broker: ApprovalBroker;
  executors: Executors;
  projectDir: string;
  maxParallel: number;
  /** The extension host's write leases, shared by every folder's engine (spec §4.2). */
  leases: WriteLeases;
  /** For tests: how often to retry while the holder is in another window. */
  leaseRetryMs?: number;
  clock?: Clock;
  newRunId?: () => string;
};
```

Add these to `StartRunInput`:

```ts
  /** The run's id, when the caller needs it before the run starts (variant worktree paths contain it). */
  runId?: string;
  /** Start even though another run holds the checkout's lease: write-capable checkout steps wait for it (spec §4.3). */
  sequential?: boolean;
  /** The checkout the app inspected (ruling R4): recorded in RunMeta.checkout, and its root keys the lease. Default: projectDir. */
  checkout?: CheckoutInfo;
```

Replace `StartRunResult` with:

```ts
/** Another run holds the checkout's write lease (spec §4.3); nothing was created. */
export type RunBlocked = { holder: LeaseHolder; otherWindow: boolean; checkout: CheckoutInfo; lockFile?: string };
export type StartRunResult = { ok: true; run: RunMeta; done: Promise<RunMeta> } | { ok: false; error: string; blocked?: RunBlocked };
```

Add these to `ActiveRun`:

```ts
  /** The checkout root that keys this run's lease. */
  leaseRoot: string;
  holdsLease: boolean;
  /** Set while the run waits for the lease: unsubscribes and stops retrying. */
  stopWaiting?: () => void;
```

Add the module helper below `BLOCKED`:

```ts
const waitingOn = (h: LeaseHolder): WaitingFor => ({ runId: h.runId, graphId: h.graphId, folder: h.folder });
```

In `start`, replace everything from `const meta: RunMeta = {` down to `return { ok: true, run: meta, done };` with:

```ts
    const runId = input.runId ?? this.makeRunId();
    const leaseRoot = input.checkout?.root ?? this.deps.projectDir;
    const startedAt = this.clock();
    // Only write-capable steps in this checkout that will actually run need the lease (spec §4.3).
    const needsLease = graph.nodes.some((n) => isWriteCapable(n) && workspaceOf(n) === null && !reuse.has(n.id));
    let holdsLease = false;
    let waitFor: { holder: LeaseHolder; otherWindow: boolean } | undefined;
    if (needsLease) {
      const got = this.deps.leases.acquire(leaseRoot, { runId, graphId: graph.id, folder: this.deps.projectDir, startedAt });
      if (got.ok) holdsLease = true;
      else if (!input.sequential) {
        return {
          ok: false,
          error: `Run ${got.holder.runId} is already changing files in ${leaseRoot}.`,
          blocked: {
            holder: got.holder,
            otherWindow: got.otherWindow,
            checkout: input.checkout ?? { git: false, root: leaseRoot, reason: 'Not inspected' },
            ...(got.lockFile && { lockFile: got.lockFile }),
          },
        };
      } else waitFor = { holder: got.holder, otherWindow: got.otherWindow };
    }

    const meta: RunMeta = {
      id: runId,
      graphId: graph.id,
      status: 'running',
      startedAt,
      snapshot: graph,
      nodes: {},
      ...(input.provider && { provider: input.provider }),
      ...(input.checkout && { checkout: toRunCheckout(input.checkout) }),
      ...(waitFor && { waitingFor: waitingOn(waitFor.holder) }),
    };
    meta.rendered = structuredClone(input.rendered);
    if (source) meta.sourceRunId = source.id;
    if (input.fromNodeId) meta.fromNodeId = input.fromNodeId;
    for (const n of graph.nodes) {
      meta.nodes[n.id] = source && reuse.has(n.id) ? { ...source.nodes[n.id], status: 'reused' } : { status: 'queued' };
    }
    try {
      this.deps.runStore.create(meta);
      if (source) for (const id of reuse) this.deps.runStore.copyOutput(source.id, meta.id, id);
    } catch (e) {
      if (holdsLease) this.deps.leases.release(leaseRoot, runId);
      throw e;
    }

    let resolveDone!: (m: RunMeta) => void;
    const done = new Promise<RunMeta>((resolve) => (resolveDone = resolve));
    const run: ActiveRun = {
      meta,
      agent: input.agent,
      order: topoOrder(graph),
      running: new Map(),
      waiting: new Map(),
      stopping: false,
      finished: false,
      resolveDone,
      leaseRoot,
      holdsLease,
    };
    this.runs.set(meta.id, run);
    if (waitFor) this.waitForLease(run, waitFor.otherWindow);
    this.safeEmit('run', meta);
    this.schedule(run);
    return { ok: true, run: meta, done };
```

Add these public methods after `stopAll()`:

```ts
  /** A fresh run id, for callers that need it before start (variant worktree paths). */
  newRunId(): string {
    return this.makeRunId();
  }

  /** VS Code is closing (spec §8): release every lease this engine holds, then stop every run. */
  dispose(): void {
    for (const run of this.runs.values()) {
      this.endWait(run);
      if (run.holdsLease) {
        run.holdsLease = false;
        this.deps.leases.release(run.leaseRoot, run.meta.id);
      }
    }
    this.stopAll();
  }
```

Replace `schedule` with:

```ts
  private schedule(run: ActiveRun): void {
    if (run.finished) return;
    if (!run.stopping) {
      for (const id of run.order) {
        if (run.meta.nodes[id].status !== 'queued') continue;
        const parents = upstream(run.meta.snapshot, id).map((p) => run.meta.nodes[p].status);
        if (parents.some((s) => BLOCKED.has(s))) {
          this.setNode(run, id, { status: 'not_run' });
          continue;
        }
        if (!parents.every((s) => DONE_OK.has(s)) || run.running.size >= this.deps.maxParallel) continue;
        const node = run.meta.snapshot.nodes.find((n) => n.id === id)!;
        if (isWriteCapable(node)) {
          // At most one write-capable step per workspace at a time; in the checkout only while the run holds the lease (spec §4.3).
          const workspace = workspaceOf(node);
          if (this.writerRunning(run, workspace)) continue;
          if (workspace === null && !this.ensureLease(run)) continue;
        }
        this.launch(run, id);
      }
    }
    // Queued steps with nothing running can only be waiting for the lease: the run isn't over yet.
    const waitingForLease = !run.stopping && !!run.stopWaiting && run.order.some((id) => run.meta.nodes[id].status === 'queued');
    if (run.running.size === 0 && !waitingForLease) this.finish(run);
  }

  /** Another write-capable step of this run is running in the same workspace. */
  private writerRunning(run: ActiveRun, workspace: string | null): boolean {
    for (const id of run.running.keys()) {
      const n = run.meta.snapshot.nodes.find((x) => x.id === id);
      if (n && isWriteCapable(n) && workspaceOf(n) === workspace) return true;
    }
    return false;
  }

  private holderOf(run: ActiveRun): Omit<LeaseHolder, 'pid'> {
    return { runId: run.meta.id, graphId: run.meta.graphId, folder: this.deps.projectDir, startedAt: run.meta.startedAt };
  }

  /** A write-capable checkout step may start only while its run holds the lease. A run without it takes it now, or waits (ruling R7). */
  private ensureLease(run: ActiveRun): boolean {
    if (run.holdsLease) return true;
    if (run.stopWaiting) return false;
    const got = this.deps.leases.acquire(run.leaseRoot, this.holderOf(run));
    if (got.ok) {
      run.holdsLease = true;
      return true;
    }
    run.meta.waitingFor = waitingOn(got.holder);
    this.persist(run.meta);
    this.safeEmit('run', run.meta);
    this.waitForLease(run, got.otherWindow);
    return false;
  }

  /**
   * Retries the lease whenever one is released in this process and, while the holder is in another window, every
   * LEASE_RETRY_MS (spec §4.3). One listener per waiting run, subscribed when it starts waiting, so runs acquire in that order.
   */
  private waitForLease(run: ActiveRun, otherWindow: boolean): void {
    if (run.stopWaiting) return;
    let timer: NodeJS.Timeout | undefined;
    const poll = (on: boolean) => {
      if (on && !timer) {
        timer = setInterval(retry, this.deps.leaseRetryMs ?? LEASE_RETRY_MS);
        timer.unref?.();
      } else if (!on && timer) {
        clearInterval(timer);
        timer = undefined;
      }
    };
    const retry = () => {
      if (run.finished || run.stopping || run.holdsLease) return;
      const got = this.deps.leases.acquire(run.leaseRoot, this.holderOf(run));
      if (!got.ok) {
        poll(got.otherWindow);
        if (run.meta.waitingFor?.runId !== got.holder.runId) {
          run.meta.waitingFor = waitingOn(got.holder);
          this.persist(run.meta);
          this.safeEmit('run', run.meta);
        }
        return;
      }
      run.holdsLease = true;
      this.endWait(run);
      delete run.meta.waitingFor;
      this.persist(run.meta);
      this.safeEmit('run', run.meta);
      this.schedule(run);
    };
    const off = this.deps.leases.onRelease((root) => {
      if (root === run.leaseRoot) retry();
    });
    poll(otherWindow);
    run.stopWaiting = () => {
      off();
      poll(false);
    };
  }

  private endWait(run: ActiveRun): void {
    run.stopWaiting?.();
    run.stopWaiting = undefined;
  }
```

In `finish`, after `run.finished = true;`, add:

```ts
    this.endWait(run);
    delete run.meta.waitingFor;
```

Then, between `this.runs.delete(run.meta.id);` and `this.safeEmit('run', run.meta);`, add:

```ts
    // Released at any final status (spec §4.3): waiting runs hear it through onRelease.
    if (run.holdsLease) {
      run.holdsLease = false;
      this.deps.leases.release(run.leaseRoot, run.meta.id);
    }
```

- [ ] **Step 4: Plumb the leases, Git and home through the app and the extension**

In `engine/src/app.ts`:
- Add `import type { GitExec } from './git';` and `import type { WriteLeases } from './writeLease';`.
- Add these to `AppDeps`:

```ts
  /** The extension host's write leases, shared by every folder's engine (spec §4.2). */
  leases: WriteLeases;
  /** Runs git: realGit in VS Code; tests pass a fake, so none runs real git. */
  git: GitExec;
  /** The home folder: variant worktrees live in ~/.agent-stream/worktrees (spec §4.3a). Required, so no test writes to the real one. */
  home: string;
```

- Change the runner to `new Runner({ runStore, broker, executors, projectDir: d.projectDir, maxParallel: d.maxParallel, clock, leases: d.leases })`.
- Change `dispose` to:

```ts
  /** VS Code is closing: release this engine's leases and stop every run (ruling R4, spec §8). */
  function dispose(): void {
    runner.dispose();
  }
```

In `extension/src/engines.ts`:
- Add `import { join } from 'node:path';` and add `createWriteLeases`, `type GitExec`, `type WriteLeases` to the `@agent-stream/engine` import.
- Add to `EngineManagerDeps`: `/** Runs git: realGit in VS Code, a fake in tests. */ git: GitExec;`.
- In the class, add `private readonly leases: WriteLeases;`, and as the first line of the constructor body: `this.leases = createWriteLeases({ locksDir: join(d.home, '.agent-stream', 'locks') });` (one instance per extension host, spec §4.2).
- In `get`, add `leases: this.leases, git: this.d.git, home: this.d.home,` to the `createApp({ … })` deps.

In `extension/src/extension.ts`, import `realGit` from `@agent-stream/engine` and change line 43 to `new EngineManager({ settings: readSettings, platform: process.platform, env: process.env, home: homedir(), git: realGit, events })`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -w engine && npm test -w extension && npm run typecheck`
Expected: PASS. If an engine or extension test other than the three named above fails because two write-capable checkout steps no longer overlap, update it as described at the top of this task.

- [ ] **Step 6: Commit**

```bash
git add engine/src/runner.ts engine/src/app.ts engine/test extension/src/engines.ts extension/src/extension.ts extension/test
git commit -m "feat(engine): one writer per workspace and the checkout write lease

Write-capable steps in one workspace now take turns within a run (spec §2).
Updated tests: runner 'runs independent nodes in parallel up to maxParallel'
and 'skips descendants of a failed node' (read-only steps), app 'refuses to
revert a step of a run in progress' (steps released in turn).

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 6: Variant workspaces — worktrees, the step's working directory, prompt lines and no reuse

**Files:**
- Create: `engine/src/variantWorkspaces.ts`, `engine/test/variantWorkspaces.test.ts`
- Modify: `engine/src/runner.ts` (`StartRunInput.workspaces`, `ActiveRun.workspaces`, `start` guard and `meta.workspaces`, `launch` cwd, output paths, prompt)
- Modify: `engine/src/prompt.ts:17-41`
- Modify: `engine/src/providers/toolGate.ts:23-36`, `:108` (`runsRoot`)
- Modify: `engine/src/app.ts:111-130` (`agentFor` passes `runsRoot`)
- Modify: `engine/src/index.ts`
- Test: `engine/test/variantWorkspaces.test.ts`, `engine/test/runner.test.ts`, `engine/test/prompt.test.ts`, `engine/test/toolGate.test.ts`

**Interfaces:**
- Consumes: `GitExec`, `fakeGit` (Task 3); the runner from Task 5.
- Produces (in `engine/src/variantWorkspaces.ts`, re-exported):
  ```ts
  export function variantPath(home: string, checkoutRoot: string, runId: string, name: string): string;
  export function createVariantWorkspaces(o: { checkoutRoot: string; runId: string; names: string[]; head: string; git: GitExec; home: string }):
    Promise<{ ok: true; workspaces: Record<string, { path: string; head: string }> } | { ok: false; error: string }>;
  export function removeWorkspace(o: { checkoutRoot: string; path: string; force: boolean; git: GitExec }): Promise<{ ok: true } | { ok: false; error: string }>;
  export function pruneWorkspaces(o: { checkoutRoot: string; git: GitExec }): Promise<{ ok: true } | { ok: false; error: string }>;
  ```
- Produces:
  - In `engine/src/runner.ts`: `StartRunInput.workspaces?: Record<string, { path: string; head: string }>`.
  - In `engine/src/prompt.ts`: `export type StepWorkspace = { path: string; head: string }` and `buildNodePrompt(graph, node, upstream, workspace?: StepWorkspace)`.
  - In `toolGate.ts`: `StepGateOptions.runsRoot?: string`.

- [ ] **Step 1: Write the failing tests**

Create `engine/test/variantWorkspaces.test.ts`:

```ts
import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createVariantWorkspaces, pruneWorkspaces, removeWorkspace, variantPath } from '../src/variantWorkspaces';
import { fakeGit } from './helpers';

const SHA = '0123456789abcdef0123456789abcdef01234567';
const RUN = '20261003-101500-abcd';
const tmp = (name: string) => realpathSync(mkdtempSync(join(tmpdir(), `agent-stream-${name}-`)));

describe('variant workspaces', () => {
  it('puts each worktree under the home folder, keyed by the checkout, the run and the name', () => {
    const home = join(tmpdir(), 'home');
    const root = join(tmpdir(), 'repo');
    const key = createHash('sha256').update(root).digest('hex').slice(0, 16);
    expect(variantPath(home, root, RUN, 'wh_small')).toBe(join(home, '.agent-stream', 'worktrees', key, RUN, 'wh_small'));
  });

  it('adds one detached worktree per name from the checkout root, at the given head', async () => {
    const home = tmp('home');
    const root = tmp('repo');
    const small = variantPath(home, root, RUN, 'wh_small');
    const large = variantPath(home, root, RUN, 'wh_large');
    const git = fakeGit({ [`worktree add --detach ${small} ${SHA}`]: {}, [`worktree add --detach ${large} ${SHA}`]: {} });
    expect(await createVariantWorkspaces({ checkoutRoot: root, runId: RUN, names: ['wh_small', 'wh_large'], head: SHA, git: git.exec, home })).toEqual({
      ok: true,
      workspaces: { wh_small: { path: small, head: SHA }, wh_large: { path: large, head: SHA } },
    });
    expect(git.calls).toEqual([
      { args: ['worktree', 'add', '--detach', small, SHA], cwd: root },
      { args: ['worktree', 'add', '--detach', large, SHA], cwd: root },
    ]);
  });

  it('removes only the worktrees this attempt created when one fails, and says why', async () => {
    const home = tmp('home');
    const root = tmp('repo');
    const a = variantPath(home, root, RUN, 'wh_a');
    const b = variantPath(home, root, RUN, 'wh_b');
    const git = fakeGit({
      [`worktree add --detach ${a} ${SHA}`]: {},
      [`worktree add --detach ${b} ${SHA}`]: { code: 128, stderr: `fatal: '${b}' already exists\n` },
      [`worktree remove --force ${a}`]: {},
    });
    expect(await createVariantWorkspaces({ checkoutRoot: root, runId: RUN, names: ['wh_a', 'wh_b', 'wh_c'], head: SHA, git: git.exec, home })).toEqual({
      ok: false,
      error: `Couldn't create workspace "wh_b": fatal: '${b}' already exists`,
    });
    expect(git.ran()).toEqual([`worktree add --detach ${a} ${SHA}`, `worktree add --detach ${b} ${SHA}`, `worktree remove --force ${a}`]);
  });

  it('removes a workspace, with --force only when asked, and prunes', async () => {
    const root = tmp('repo');
    const path = join(tmp('home'), 'wt');
    const git = fakeGit({ [`worktree remove ${path}`]: {}, [`worktree remove --force ${path}`]: {}, 'worktree prune': {} });
    expect(await removeWorkspace({ checkoutRoot: root, path, force: false, git: git.exec })).toEqual({ ok: true });
    expect(await removeWorkspace({ checkoutRoot: root, path, force: true, git: git.exec })).toEqual({ ok: true });
    expect(await pruneWorkspaces({ checkoutRoot: root, git: git.exec })).toEqual({ ok: true });
    expect(git.calls).toEqual([
      { args: ['worktree', 'remove', path], cwd: root },
      { args: ['worktree', 'remove', '--force', path], cwd: root },
      { args: ['worktree', 'prune'], cwd: root },
    ]);
    const failing = fakeGit({ [`worktree remove ${path}`]: { code: 128, stderr: "fatal: contains modified or untracked files, use --force to delete it\n" } });
    expect(await removeWorkspace({ checkoutRoot: root, path, force: false, git: failing.exec })).toEqual({
      ok: false,
      error: 'fatal: contains modified or untracked files, use --force to delete it',
    });
  });
});
```

Append to `engine/test/prompt.test.ts`:

```ts
describe('buildNodePrompt and workspaces', () => {
  it("names the workspace a step works in, and earlier results' workspaces in their headings", () => {
    const n1 = node('n1', 'command', { title: 'Run wh_small', command: 'dbt build', workspace: 'wh_small' });
    const n2 = node('n2', 'agent', { title: 'Check', prompt: 'Check it.', workspace: 'wh_small' });
    const text = buildNodePrompt(graph(''), n2, [{ node: n1, state: { status: 'succeeded', exitCode: 0, durationMs: 312_400 }, output: 'ok', outputPath: 'out.md' }], {
      path: '/wt/wh_small',
      head: 'abcdef0123456789',
    });
    expect(text).toContain('# Your step: Check\nYou are working in workspace "wh_small" at /wt/wh_small: a separate Git worktree of this repository at abcdef0. Change files only there.\nCheck it.');
    expect(text).toContain('## n1 · Run wh_small (command `dbt build`, exit 0, 312.4 s, workspace wh_small)');
    const later = buildNodePrompt(graph(''), node('n3', 'agent', { prompt: 'x' }), [{ node: n2, state: { status: 'succeeded' }, output: 'o', outputPath: 'p' }]);
    expect(later).toContain('## n2 · Check (agent, succeeded, workspace wh_small)');
    expect(later).not.toContain('You are working in workspace');
  });
});
```

Append to `engine/test/toolGate.test.ts`, inside `describe('step gate', …)`:

```ts
  it("keeps the folder's run records private from a step in a workspace (Review Focus 4)", () => {
    const workspace = resolve('/', 'home', 'me', '.agent-stream', 'worktrees', '0123456789abcdef', '20261003-000000-0001', 'wh_a');
    const gate = createStepGate({ broker: new ApprovalBroker(() => 't'), runId: 'r', graphId: 'g', nodeId: 'n1', nodeTitle: 'Step', projectDir: workspace, runsRoot: PROJECT, privateFiles: [VALUES], signal: new AbortController().signal, emit: vi.fn() });
    const runDir = join(PROJECT, '.agent-stream', 'runs', '20261003-000000-0001');
    expect(gate.privacy('Read', { file_path: join(runDir, 'run.json') })).toMatch(/Run records contain variable values/);
    expect(gate.privacy('Read', { file_path: join(runDir, 'nodes', 'n1', 'events.jsonl') })).toMatch(/Run records contain variable values/);
    expect(gate.privacy('Read', { file_path: join(runDir, 'nodes', 'n1', 'output.md') })).toBeNull();
    expect(gate.privacy('Read', { file_path: join(workspace, 'models', 'orders.sql') })).toBeNull();
  });
```

Append to `engine/test/runner.test.ts`:

```ts
describe('Runner variant workspaces', () => {
  const SHA = '0123456789abcdef0123456789abcdef01234567';
  const checkout: CheckoutInfo = { git: false, root: join(tmpdir(), 'agent-stream-checkout'), reason: 'Not a Git repository' };
  const inWs = (title: string, workspace: string, kind: 'agent' | 'command' = 'agent'): Op => ({
    type: 'addNode',
    node: kind === 'agent' ? { title, kind, prompt: `do ${title}`, workspace } : { title, kind, command: `run ${title}`, workspace },
  });
  const places = (...names: string[]) => Object.fromEntries(names.map((n) => [n, { path: mkdtempSync(join(tmpdir(), `agent-stream-ws-${n}-`)), head: SHA }]));

  it('runs a step that has a workspace there, with absolute paths to earlier outputs (Review Focus 3)', async () => {
    const { runner, fake, projectDir } = setup();
    const workspaces = places('wh_a');
    const r = started(runner.start({ ...withRendered(graphOf([agent('a'), inWs('b', 'wh_a'), link('n1', 'n2')])), workspaces }));
    expect(r.run.workspaces).toEqual(workspaces);
    await tick();
    expect(fake.contexts.get('n1')!.cwd).toBe(projectDir);
    fake.finish('n1');
    await tick();
    const ctx = fake.contexts.get('n2')!;
    expect(ctx.cwd).toBe(workspaces.wh_a.path);
    expect(ctx.prompt).toContain(`Full output: ${join(projectDir, '.agent-stream', 'runs', r.run.id, 'nodes', 'n1', 'output.md')}`);
    expect(ctx.prompt).toContain(`You are working in workspace "wh_a" at ${workspaces.wh_a.path}: a separate Git worktree of this repository at 0123456. Change files only there.`);
    fake.finish('n2');
    expect((await r.done).status).toBe('succeeded');
  });

  it('runs write-capable steps of different workspaces in parallel, one at a time within each', async () => {
    const { runner, fake } = setup(6);
    const workspaces = places('wh_a', 'wh_b');
    const readerInA: Op = { type: 'addNode', node: { title: 'd', kind: 'agent', prompt: 'do d', access: 'read', workspace: 'wh_a' } };
    const r = started(runner.start({ ...withRendered(graphOf([inWs('a1', 'wh_a'), inWs('a2', 'wh_a', 'command'), inWs('b1', 'wh_b'), agent('c'), readerInA])), workspaces }));
    await tick();
    expect(fake.started).toEqual(['n1', 'n3', 'n4', 'n5']);
    expect(fake.contexts.get('n5')!.cwd).toBe(workspaces.wh_a.path);
    fake.finish('n1');
    await tick();
    expect(fake.started).toEqual(['n1', 'n3', 'n4', 'n5', 'n2']);
    for (const id of ['n2', 'n3', 'n4', 'n5']) fake.finish(id);
    expect((await r.done).status).toBe('succeeded');
  });

  it('needs no lease when its write-capable steps are all in variant workspaces', async () => {
    const leases = testLeases();
    const holder = setup(3, leases);
    const other = setup(3, leases);
    const first = started(holder.runner.start({ ...withRendered(graphOf([agent('a')])), checkout }));
    const r = started(other.runner.start({ ...withRendered(graphOf([inWs('a', 'wh_a'), reader('b')])), checkout, workspaces: places('wh_a') }));
    expect(r.run.waitingFor).toBeUndefined();
    await tick();
    expect(other.fake.started).toEqual(['n1', 'n2']);
    other.fake.finish('n1');
    other.fake.finish('n2');
    expect((await r.done).status).toBe('succeeded');
    expect(leases.holder(checkout.root)?.runId).toBe(first.run.id);
    await tick();
    holder.fake.finish('n1');
    await first.done;
  });

  it('takes the lease on demand for a checkout step added mid-run (Review Focus 2)', async () => {
    const leases = testLeases();
    const holder = setup(3, leases);
    const other = setup(3, leases);
    const first = started(holder.runner.start({ ...withRendered(graphOf([agent('a')])), checkout }));
    const r = started(other.runner.start({ ...withRendered(graphOf([inWs('a', 'wh_a')])), checkout, workspaces: places('wh_a') }));
    await tick();
    const added: GraphNode = { id: 'n2', title: 'fix', kind: 'agent', prompt: 'fix it', createdBy: 'agent', updatedBy: 'agent', updatedAt: 't' };
    expect(other.runner.amend(r.run.id, { kind: 'add', node: added, text: 'fix it', after: ['n1'], before: [] }, 'n1', 'n1 wants to add step "fix"')).toEqual({ ok: true });
    other.fake.finish('n1');
    await tick();
    expect(other.runner.get(r.run.id)).toMatchObject({ status: 'running', waitingFor: { runId: first.run.id }, nodes: { n2: { status: 'queued' } } });
    expect(other.fake.started).toEqual(['n1']);
    holder.fake.finish('n1');
    await first.done;
    await tick();
    expect(other.fake.started).toEqual(['n1', 'n2']);
    expect(leases.holder(checkout.root)?.runId).toBe(r.run.id);
    other.fake.finish('n2');
    expect((await r.done).status).toBe('succeeded');
    expect(leases.holder(checkout.root)).toBeUndefined();
  });

  it('never reuses a step that has a workspace on a re-run', async () => {
    const { runner, fake } = setup();
    const graph = graphOf([agent('a'), inWs('b', 'wh_a', 'command'), link('n1', 'n2')]);
    const first = started(runner.start({ ...withRendered(graph), workspaces: places('wh_a') }));
    await tick();
    fake.finish('n1');
    await tick();
    fake.finish('n2');
    await first.done;
    fake.started.length = 0;
    const second = started(runner.start({ ...withRendered(graph, { sourceRunId: first.run.id }), workspaces: places('wh_a') }));
    expect(second.run.nodes).toMatchObject({ n1: { status: 'reused' }, n2: { status: 'queued' } });
    await tick();
    expect(fake.started).toEqual(['n2']);
    fake.finish('n2');
    expect((await second.done).status).toBe('succeeded');
  });

  it('refuses a run whose workspace has no worktree, creating nothing', () => {
    const { runner, runStore } = setup();
    expect(runner.start(withRendered(graphOf([inWs('a', 'wh_a')])))).toEqual({ ok: false, error: 'Step n1 uses workspace "wh_a", but this run has no worktree for it.' });
    expect(runStore.list('g')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w engine -- variantWorkspaces runner prompt toolGate`
Expected: FAIL. `variantWorkspaces.ts` doesn't exist, steps run in `projectDir`, the prompt has no workspace line, and the gate has no `runsRoot`.

- [ ] **Step 3: Implement `engine/src/variantWorkspaces.ts`**

```ts
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { GitExec, GitResult } from './git';

/** `~/.agent-stream/worktrees/<checkout hash>/<run id>/<name>`: outside the project (spec §2). */
export function variantPath(home: string, checkoutRoot: string, runId: string, name: string): string {
  return join(home, '.agent-stream', 'worktrees', createHash('sha256').update(checkoutRoot).digest('hex').slice(0, 16), runId, name);
}

const gitError = (r: GitResult): string => r.stderr.trim() || r.stdout.trim() || `git exited with code ${r.code}`;

/**
 * One detached worktree per name, from the run's start commit, run from the checkout root (spec §4.3a). If one can't be
 * created, the ones this attempt made are removed (they hold nothing yet) and the error names the workspace.
 */
export async function createVariantWorkspaces(o: {
  checkoutRoot: string;
  runId: string;
  names: string[];
  head: string;
  git: GitExec;
  home: string;
}): Promise<{ ok: true; workspaces: Record<string, { path: string; head: string }> } | { ok: false; error: string }> {
  const workspaces: Record<string, { path: string; head: string }> = {};
  for (const name of o.names) {
    const path = variantPath(o.home, o.checkoutRoot, o.runId, name);
    let r: GitResult;
    try {
      mkdirSync(dirname(path), { recursive: true });
      r = await o.git(['worktree', 'add', '--detach', path, o.head], o.checkoutRoot);
    } catch (e) {
      r = { code: 1, stdout: '', stderr: e instanceof Error ? e.message : String(e) };
    }
    if (r.code !== 0) {
      for (const made of Object.values(workspaces)) await o.git(['worktree', 'remove', '--force', made.path], o.checkoutRoot);
      return { ok: false, error: `Couldn't create workspace "${name}": ${gitError(r)}` };
    }
    workspaces[name] = { path, head: o.head };
  }
  return { ok: true, workspaces };
}

/** `git worktree remove [--force] <path>`, run from the checkout root (spec §5.5). */
export async function removeWorkspace(o: { checkoutRoot: string; path: string; force: boolean; git: GitExec }): Promise<{ ok: true } | { ok: false; error: string }> {
  const r = await o.git(['worktree', 'remove', ...(o.force ? ['--force'] : []), o.path], o.checkoutRoot);
  return r.code === 0 ? { ok: true } : { ok: false, error: gitError(r) };
}

/** `git worktree prune`: forgets worktrees whose folder was deleted by hand (spec §8). */
export async function pruneWorkspaces(o: { checkoutRoot: string; git: GitExec }): Promise<{ ok: true } | { ok: false; error: string }> {
  const r = await o.git(['worktree', 'prune'], o.checkoutRoot);
  return r.code === 0 ? { ok: true } : { ok: false, error: gitError(r) };
}
```

In `engine/src/index.ts`, add `export { createVariantWorkspaces, pruneWorkspaces, removeWorkspace, variantPath } from './variantWorkspaces';`.

- [ ] **Step 4: Implement the prompt lines**

In `engine/src/prompt.ts`, replace `heading` and `buildNodePrompt`:

```ts
/** Where a step in a variant workspace works (spec §4.3a). */
export type StepWorkspace = { path: string; head: string };

function heading(u: UpstreamResult): string {
  const about = brief(u.node) ? `: ${brief(u.node)}` : '';
  const where = u.node.workspace ? `, workspace ${u.node.workspace}` : '';
  if (u.node.kind === 'command') {
    const secs = u.state.durationMs !== undefined ? `, ${(u.state.durationMs / 1000).toFixed(1)} s` : '';
    return `## ${u.node.id} · ${u.node.title}${about} (command \`${u.node.command ?? ''}\`, exit ${u.state.exitCode ?? '?'}${secs}${where})`;
  }
  return `## ${u.node.id} · ${u.node.title}${about} (agent, ${u.state.status}${where})`;
}

/** The prompt an agent node receives (spec §7.3). Commands keep their tail, agents their head. */
export function buildNodePrompt(graph: Graph, node: GraphNode, upstream: UpstreamResult[], workspace?: StepWorkspace): string {
  const parts: string[] = [];
  if (graph.goal.trim()) parts.push(`# Workflow goal\n${graph.goal.trim()}`);
  if (graph.instructions?.trim()) parts.push(`# Instructions & context\n${graph.instructions.trim()}`);
  const step = [`# Your step: ${node.title}`];
  if (node.workspace && workspace) {
    step.push(`You are working in workspace "${node.workspace}" at ${workspace.path}: a separate Git worktree of this repository at ${workspace.head.slice(0, 7)}. Change files only there.`);
  }
  if (brief(node)) step.push(`In short: ${brief(node)}`);
  step.push((node.prompt ?? '').trim());
  parts.push(step.join('\n'));
  if (upstream.length > 0) {
    const sections = upstream.map((u) => {
      const excerpt = u.node.kind === 'command' ? truncateTail(u.output, MAX_UPSTREAM_CHARS) : truncateHead(u.output, MAX_UPSTREAM_CHARS);
      return `${heading(u)}\n${excerpt.trim() || '(no output)'}\nFull output: ${u.outputPath}`;
    });
    parts.push(`# Results from earlier steps\n${sections.join('\n\n')}`);
  }
  return `${parts.join('\n\n')}\n`;
}
```

(The joined `step` lines produce exactly the text the old template produced when there is no workspace line, so the existing prompt tests are unchanged.)

- [ ] **Step 5: Run steps in their workspace**

In `engine/src/runner.ts`, add `import { join } from 'node:path';`. Add this to `StartRunInput`:

```ts
  /** The variant workspaces the app created for this run, by name (spec §4.3a). */
  workspaces?: Record<string, { path: string; head: string }>;
```

Add to `ActiveRun`: `/** This run's variant worktrees, by name. */ workspaces: Record<string, { path: string; head: string }>;`.

In `start`, right after the loop that checks `The run has no reviewed text for step …`, add:

```ts
    for (const n of graph.nodes) {
      const ws = workspaceOf(n);
      if (ws !== null && !input.workspaces?.[ws]) return { ok: false, error: `Step ${n.id} uses workspace "${ws}", but this run has no worktree for it.` };
    }
```

Add `...(input.workspaces && Object.keys(input.workspaces).length > 0 && { workspaces: structuredClone(input.workspaces) }),` to the `meta` literal, and `workspaces: input.workspaces ?? {},` to the `run` literal.

In `launch`, replace the body of the first `.then(() => { … })` with:

```ts
        const workspace = workspaceOf(node);
        const place = workspace === null ? undefined : run.workspaces[workspace];
        if (workspace !== null && !place) throw new Error(`Step ${nodeId} uses workspace "${workspace}", but this run has no worktree for it.`);
        // Inside the chain so a failure reading upstream outputs fails this node instead of escaping.
        const upstreamResults = upstream(meta.snapshot, nodeId).map((parentId) => {
          const rel = this.deps.runStore.outputRelPath(meta.id, parentId);
          return {
            node: executionNode(meta, parentId),
            state: meta.nodes[parentId],
            output: this.deps.runStore.readOutput(meta.id, parentId),
            // Relative to the folder; a step working in a worktree needs the full path (Review Focus 3).
            outputPath: place ? join(this.deps.projectDir, rel) : rel,
          };
        });
        const graph = meta.rendered ? { ...meta.snapshot, goal: meta.rendered.goal, instructions: meta.rendered.instructions } : meta.snapshot;
        const execNode = executionNode(meta, nodeId);
        const prompt = node.kind === 'agent' ? buildNodePrompt(graph, execNode, upstreamResults, place) : '';
        return executor({
          runId: meta.id,
          graph,
          node: execNode,
          prompt,
          // Agents get the variant path as their working directory; commands run there (spec §4.3a).
          cwd: place?.path ?? this.deps.projectDir,
          signal: controller.signal,
          emit: (event) => this.emitEvent(run, nodeId, event),
        });
```

- [ ] **Step 6: Keep the folder's run records private from steps in a worktree**

In `engine/src/providers/toolGate.ts`, add to `StepGateOptions`:

```ts
  /** The folder whose .agent-stream/runs hold this run's records, when the step works elsewhere (a variant worktree, ruling R18). */
  runsRoot?: string;
```

In `createStepGate`, change `privacy` to:

```ts
    privacy: (toolName, input) =>
      privatePathDenial(o.projectDir, toolName, input, o.privateFiles) ??
      (o.runsRoot && o.runsRoot !== o.projectDir ? privatePathDenial(o.runsRoot, toolName, input) : null),
```

In `engine/src/app.ts` `agentFor`, add `runsRoot: d.projectDir,` to the `createStepGate({ … })` options. The existing `projectDir: ctx.cwd` stays: it is now the worktree for a step with a workspace.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npm test -w engine && npm run typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add engine/src/variantWorkspaces.ts engine/src/runner.ts engine/src/prompt.ts engine/src/providers/toolGate.ts engine/src/app.ts engine/src/index.ts engine/test
git commit -m "feat(engine): variant workspaces run their steps in their own worktree

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Read-only agent steps — the gate and the prompt

**Files:**
- Modify: `engine/src/providers/toolGate.ts` (`readOnly`, `readOnlyRefusal`)
- Modify: `engine/src/prompt.ts` (`READ_ONLY_LINE`)
- Modify: `engine/src/app.ts:111-130` (`agentFor`)
- Test: `engine/test/toolGate.test.ts`, `engine/test/prompt.test.ts`, `engine/test/app.test.ts`

**Interfaces:**
- Consumes: `isWriteCapable` (Task 1); `buildNodePrompt`'s workspace line (Task 6).
- Produces:
  ```ts
  // engine/src/providers/toolGate.ts
  export function readOnlyRefusal(toolName: string): string;   // the §4.4 reason
  // StepGateOptions gains: readOnly?: boolean;
  // engine/src/prompt.ts
  export const READ_ONLY_LINE: string;   // "This step is read-only: investigate and report; don't change files or run commands."
  ```

- [ ] **Step 1: Write the failing tests**

Append to `engine/test/toolGate.test.ts`, inside `describe('step gate', …)`:

```ts
  it('refuses every tool that is not read-only in a read-only step, without asking', async () => {
    const broker = new ApprovalBroker(() => 't');
    const emit = vi.fn();
    const gate = createStepGate({ broker, runId: 'r', graphId: 'g', nodeId: 'n1', nodeTitle: 'Step', projectDir: PROJECT, privateFiles: [VALUES], signal: new AbortController().signal, emit, readOnly: true });
    expect(await gate.decide('Grep', { pattern: 'x', path: join(PROJECT, 'src') })).toEqual({ allow: true, by: 'readOnly' });
    expect(await gate.decide('Edit', { file_path: join(PROJECT, 'a.ts') })).toEqual({
      allow: false,
      reason: 'This step is read-only, so Edit isn\'t allowed. Mark the step "Can edit files" if it needs to change something.',
    });
    expect(await gate.approve('Bash', { command: 'ls' })).toEqual({
      allow: false,
      reason: 'This step is read-only, so Bash isn\'t allowed. Mark the step "Can edit files" if it needs to change something.',
    });
    expect(broker.pending()).toEqual([]);
    expect(emit).not.toHaveBeenCalled();
  });
```

Append to `engine/test/prompt.test.ts`:

```ts
describe('buildNodePrompt and read-only steps', () => {
  it('tells a read-only step to investigate and report, under its heading', () => {
    expect(buildNodePrompt(graph(''), node('n1', 'agent', { title: 'Look', prompt: 'Look around.', access: 'read', description: 'Reads the code.' }), [])).toBe(
      "# Your step: Look\nThis step is read-only: investigate and report; don't change files or run commands.\nIn short: Reads the code.\nLook around.\n",
    );
    expect(buildNodePrompt(graph(''), node('n1', 'agent', { prompt: 'x' }), [])).not.toContain('read-only');
  });
});
```

Append to `engine/test/app.test.ts`, inside `describe('agent changes', …)` (next to "gives agent steps the add_step and change_step tools"):

```ts
    it('gives a read-only step no graph tools and a gate that refuses edits without asking', async () => {
      const seen: { tools: string[]; decision: unknown }[] = [];
      const provider = testProvider({
        runStep: async (ctx, gate) => {
          seen.push({ tools: (ctx.graphTools ?? []).map((t) => t.name), decision: await gate.decide('Edit', { file_path: join(ctx.cwd, 'a.ts') }) });
          return { ok: true, output: '' };
        },
      });
      const { app, client } = setup(signedIn, instant, undefined, { provider, executors: undefined });
      const c = client();
      const g = app.graphStore.create('G');
      app.graphStore.apply(g.id, { type: 'addNode', node: { title: 'look', kind: 'agent', prompt: 'p', access: 'read' } }, 'user');
      await app.handle(c.c, { type: 'startRun', graphId: g.id, reviewed: (await reviewed(app, c, g.id)).signature });
      await vi.waitFor(() => expect(c.of('run').at(-1)?.run.status).toBe('succeeded'));
      expect(seen).toEqual([
        { tools: [], decision: { allow: false, reason: 'This step is read-only, so Edit isn\'t allowed. Mark the step "Can edit files" if it needs to change something.' } },
      ]);
      expect(app.broker.pending()).toEqual([]);
    });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w engine -- toolGate prompt app`
Expected: FAIL. `readOnly` is unknown, the read-only line is missing, and the read-only step still gets `add_step`/`change_step` and asks the user.

- [ ] **Step 3: Implement**

In `engine/src/providers/toolGate.ts`, add:

```ts
/** Why a read-only step can't use a tool (spec §4.4). Never asks the user. */
export const readOnlyRefusal = (toolName: string): string =>
  `This step is read-only, so ${toolName} isn't allowed. Mark the step "Can edit files" if it needs to change something.`;
```

Add to `StepGateOptions`: `/** A read-only step (access: 'read'): every tool that isn't read-only is refused without asking (spec §4.4). */ readOnly?: boolean;`. In `createStepGate`'s `approve`, add this as its first line:

```ts
      if (o.readOnly) return { allow: false, reason: readOnlyRefusal(toolName) };
```

In `engine/src/prompt.ts`, add `export const READ_ONLY_LINE = "This step is read-only: investigate and report; don't change files or run commands.";`. In `buildNodePrompt`, right after `const step = [`# Your step: ${node.title}`];`, add:

```ts
  if (node.access === 'read') step.push(READ_ONLY_LINE);
```

In `engine/src/app.ts`, add `isWriteCapable` to the shared import and replace `agentFor` with:

```ts
  /**
   * Agent steps on `p`, each asking the user through its own step gate. A step that can change files also gets the graph
   * tools (add_step, change_step), which ask the user themselves, so the gate lets them through. A read-only step gets no
   * graph tools, and its gate refuses everything that isn't read-only without asking (spec §4.4).
   */
  const agentFor =
    (p: AgentProvider): NodeExecutor =>
    (ctx) => {
      const readOnly = !isWriteCapable(ctx.node);
      const graphTools = readOnly ? [] : createStepGraphTools({ ctx, graphStore, runner, broker, render: renderNode, signal: ctx.signal });
      return p.runStep(
        { ...ctx, graphTools },
        createStepGate({
          broker,
          runId: ctx.runId,
          graphId: ctx.graph.id,
          nodeId: ctx.node.id,
          nodeTitle: ctx.node.title,
          projectDir: ctx.cwd,
          runsRoot: d.projectDir,
          privateFiles: privateFiles(),
          signal: ctx.signal,
          emit: ctx.emit,
          readOnly,
          selfApproving: new Set(graphTools.map((t) => `mcp__run_graph__${t.name}`)),
        }),
      );
    };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -w engine && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add engine/src/providers/toolGate.ts engine/src/prompt.ts engine/src/app.ts engine/test
git commit -m "feat(engine): read-only agent steps refuse every non-read-only tool

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 8: App — the checkout, runBlocked, sequential starts, variant creation and preview notes

**Files:**
- Modify: `engine/src/runPreview.ts:42-50` (`PreviewInput.checkout`), `:149` and `:157-187` (problems, notes, `checkout`)
- Modify: `engine/src/app.ts` (imports; `blockedMessage`; `inspect`, `checkoutMessage`, `sendCheckout`, `holderGraphName`; the runner `'run'` listener at `:252-256`; `preview` at `:265-272`; `connect` at `:321-329`; the `previewRun` and `startRun` cases; a new `inspectCheckout` case)
- Test: `engine/test/runPreview.test.ts`, `engine/test/app.test.ts`

**Interfaces:**
- Consumes:
  - `inspectCheckout`, `GitExec`, `repoGit`, `fakeGit`, `noGit` (Task 3);
  - `createWriteLeases`, `leaseFile`, `testLeases` (Task 4);
  - `Runner.newRunId`, `StartRunInput.{runId, sequential, checkout}`, `StartRunResult.blocked`, `appTestDeps` (Task 5);
  - `createVariantWorkspaces`, `removeWorkspace`, `variantPath`, `StartRunInput.workspaces` (Task 6);
  - `parallelWriteSteps`, `workspaceOf` (Task 1);
  - the protocol types (Task 2).
- Produces:
  ```ts
  // engine/src/runPreview.ts
  // PreviewInput gains: checkout?: CheckoutInfo;  RunPreview gets notes (always) and checkout (when given)
  // engine/src/app.ts
  export function blockedMessage(o: { graphName: string; holder: LeaseHolder; holderName: string; otherWindow: boolean; root: string; lockFile?: string }): string;
  // handle('startRun') honours `sequential`; handle('inspectCheckout') answers { type: 'checkout', info, lease? }
  ```

- [ ] **Step 1: Write the failing tests**

Append to `engine/test/runPreview.test.ts` (add `type CheckoutInfo` to its shared import):

```ts
describe('previewRun notes and workspaces', () => {
  const SHA = '0123456789abcdef0123456789abcdef01234567';
  const repo = (over: Partial<Extract<CheckoutInfo, { git: true }>> = {}): CheckoutInfo => ({ git: true, root: 'repo', linkedWorktree: false, branch: 'main', head: SHA, dirty: false, worktrees: [], ...over });
  const inWs = (title: string, workspace: string): Op => ({ type: 'addNode', node: { title, kind: 'command', command: 'make', workspace } });

  it('notes write-capable steps of one workspace that will take turns, without blocking', () => {
    const g = graphOf([agent('A', 'a'), agent('B', 'b'), { type: 'addNode', node: { title: 'C', kind: 'agent', prompt: 'c', access: 'read' } }]);
    const { preview, rendered } = previewRun({ graph: g, values: {}, env: env() });
    expect(preview.notes).toEqual(['n1 and n2 can both change files in the same workspace; they will run one at a time.']);
    expect(preview.problems).toEqual([]);
    expect(rendered).toBeDefined();
  });

  it('notes that workspaces start from HEAD when the checkout has uncommitted changes', () => {
    const g = graphOf([inWs('A', 'wh_a')]);
    expect(previewRun({ graph: g, values: {}, env: env(), checkout: repo({ dirty: true }) }).preview.notes).toEqual([
      "Workspaces start from 0123456; uncommitted changes in this checkout aren't included.",
    ]);
    expect(previewRun({ graph: g, values: {}, env: env(), checkout: repo() }).preview.notes).toEqual([]);
    expect(previewRun({ graph: graphOf([agent('A', 'a')]), values: {}, env: env(), checkout: repo({ dirty: true }) }).preview.notes).toEqual([]);
  });

  it('refuses steps with a workspace outside Git and before the first commit, naming each step', () => {
    const g = graphOf([inWs('A', 'wh_a'), inWs('B', 'wh_b'), agent('C', 'c')]);
    const problems = ['Step n1 uses workspace "wh_a", which needs a Git repository with at least one commit.', 'Step n2 uses workspace "wh_b", which needs a Git repository with at least one commit.'];
    for (const checkout of [{ git: false as const, root: 'plain', reason: 'Not a Git repository' }, repo({ head: undefined })]) {
      const out = previewRun({ graph: g, values: {}, env: env(), checkout });
      expect(out.preview.problems).toEqual(problems);
      expect(out.rendered).toBeUndefined();
    }
    expect(previewRun({ graph: g, values: {}, env: env(), checkout: repo() }).preview.problems).toEqual([]);
  });

  it('carries the checkout for the Checkout line', () => {
    expect(previewRun({ graph: graphOf([agent('A', 'a')]), values: {}, env: env(), checkout: repo() }).preview.checkout).toEqual(repo());
    expect(previewRun({ graph: graphOf([agent('A', 'a')]), values: {}, env: env() }).preview).not.toHaveProperty('checkout');
  });
});
```

Append to `engine/test/app.test.ts`:
- Add these imports: `realpathSync` (to the `node:fs` import); `type Op` (to the `@agent-stream/shared` import; `type App` and `type AppDeps` are already imported); `import type { GitExec } from '../src/git';`; `import { createWriteLeases, leaseFile, type WriteLeases } from '../src/writeLease';`; `import { variantPath } from '../src/variantWorkspaces';`.
- Add `appTestDeps`, `noGit`, `repoGit` and `testLeases` to the `./helpers` import.

Then add:

```ts
describe('the checkout and the write lease', () => {
  const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
  const held = (gate: { promise: Promise<void> }): NodeExecutor => async () => {
    await gate.promise;
    return { ok: true, output: '' };
  };
  /** An App on `projectDir` (a fresh folder by default) whose fake git is built for its real path. */
  function gitApp(o: { git?: (root: string) => GitExec; leases?: WriteLeases; projectDir?: string; over?: Partial<AppDeps> } = {}) {
    const projectDir = o.projectDir ?? tmpProject().root;
    const root = realpathSync(projectDir);
    const deps = appTestDeps();
    const leases = o.leases ?? deps.leases;
    const app = createApp({
      ...deps,
      leases,
      projectDir,
      valuesFile: tmpValuesFile(),
      provider: testProvider(),
      status: signedIn,
      maxParallel: 2,
      gitBash: testGitBash,
      executors: { agent: instant, command: instant },
      git: o.git ? o.git(root) : noGit,
      ...o.over,
    });
    return { app, root, projectDir, home: deps.home, leases };
  }
  const main = (root: string) => repoGit({ root, branch: 'main', head: SHA }).exec;
  async function reviewedBy(app: App, c: ReturnType<typeof client>, graphId: string) {
    await app.handle(c.client, { type: 'previewRun', graphId });
    return c.last('runPreview').preview;
  }
  function graphWith(app: App, name: string, ...nodes: Op[]) {
    const g = app.graphStore.create(name);
    for (const op of nodes) app.graphStore.apply(g.id, op, 'user');
    return g;
  }
  const writer: Op = { type: 'addNode', node: { title: 'edit', kind: 'agent', prompt: 'p' } };

  it('sends the checkout after hello and when asked', async () => {
    const { app, root } = gitApp({ git: main });
    const c = client(app);
    expect(c.msgs.slice(0, 2).map((m) => m.type)).toEqual(['hello', 'sessions']);
    await vi.waitFor(() => expect(c.all('checkout')).toHaveLength(1));
    expect(c.last('checkout')).toEqual({
      type: 'checkout',
      info: { git: true, root, linkedWorktree: false, branch: 'main', head: SHA, dirty: false, worktrees: [{ path: root, branch: 'main', head: SHA, current: true }] },
    });
    await app.handle(c.client, { type: 'inspectCheckout' });
    expect(c.all('checkout')).toHaveLength(2);
  });

  it('records where a run ran, and announces the checkout when the run starts and ends', async () => {
    const gate = deferred<void>();
    const { app, root } = gitApp({ git: main, over: { executors: { agent: held(gate), command: held(gate) } } });
    const c = client(app);
    await vi.waitFor(() => expect(c.all('checkout')).toHaveLength(1));
    const g = graphWith(app, 'G', writer);
    const preview = await reviewedBy(app, c, g.id);
    expect(preview.checkout).toMatchObject({ git: true, root, branch: 'main' });
    await app.handle(c.client, { type: 'startRun', graphId: g.id, reviewed: preview.signature });
    const runId = c.all('run')[0].run.id;
    await vi.waitFor(() => expect(c.all('checkout').at(-1)?.lease?.runId).toBe(runId));
    gate.resolve();
    await vi.waitFor(() => expect(c.all('run').at(-1)?.run.status).toBe('succeeded'));
    await vi.waitFor(() => expect(c.all('checkout').at(-1)).not.toHaveProperty('lease'));
    expect(app.runStore.get(runId)?.checkout).toEqual({ root, branch: 'main', head: SHA, linkedWorktree: false });
  });

  it('refuses a second run that would change files in the same checkout with runBlocked, not an error', async () => {
    const leases = testLeases();
    const gate = deferred<void>();
    const a = gitApp({ leases, git: main, over: { executors: { agent: held(gate), command: held(gate) } } });
    const b = gitApp({ leases, git: () => main(a.root) });
    const ga = graphWith(a.app, 'Orders', writer);
    const gb = graphWith(b.app, 'Billing', writer);
    const ca = client(a.app);
    const cb = client(b.app);
    await a.app.handle(ca.client, { type: 'startRun', graphId: ga.id, reviewed: (await reviewedBy(a.app, ca, ga.id)).signature });
    const runA = ca.all('run')[0].run.id;
    await b.app.handle(cb.client, { type: 'startRun', graphId: gb.id, reviewed: (await reviewedBy(b.app, cb, gb.id)).signature });
    expect(cb.last('runBlocked')).toEqual({
      type: 'runBlocked',
      graphId: gb.id,
      message: `"Billing" can't start: run ${runA} of "Orders" is already changing files in this checkout (${a.root}). Separate tickets need separate worktrees.`,
      holder: expect.objectContaining({ runId: runA, graphId: ga.id, folder: a.projectDir }),
      otherWindow: false,
      checkout: expect.objectContaining({ git: true, root: a.root }),
      canSetUpTickets: true,
    });
    expect(cb.all('error')).toEqual([]);
    expect(b.app.runStore.list(gb.id)).toEqual([]);
    gate.resolve();
    await vi.waitFor(() => expect(ca.all('run').at(-1)?.run.status).toBe('succeeded'));
  });

  it('offers only sequential execution outside Git', async () => {
    const leases = testLeases();
    const gate = deferred<void>();
    const folder = tmpProject().root;
    const a = gitApp({ leases, projectDir: folder, over: { executors: { agent: held(gate), command: held(gate) } } });
    const b = gitApp({ leases, projectDir: folder });
    const ga = graphWith(a.app, 'Orders', writer);
    const gb = graphWith(b.app, 'Billing', writer);
    const ca = client(a.app);
    const cb = client(b.app);
    await a.app.handle(ca.client, { type: 'startRun', graphId: ga.id, reviewed: (await reviewedBy(a.app, ca, ga.id)).signature });
    await b.app.handle(cb.client, { type: 'startRun', graphId: gb.id, reviewed: (await reviewedBy(b.app, cb, gb.id)).signature });
    expect(cb.last('runBlocked')).toMatchObject({ canSetUpTickets: false, checkout: { git: false, root: a.root, reason: 'Not a Git repository' } });
    expect(cb.last('runBlocked').message).toContain(`is already changing files in this checkout (${a.root}).`);
    gate.resolve();
    await vi.waitFor(() => expect(ca.all('run').at(-1)?.run.status).toBe('succeeded'));
  });

  it('starts a sequential run that waits for the lease, and runs it once the first run ends', async () => {
    const leases = testLeases();
    const gate = deferred<void>();
    const a = gitApp({ leases, git: main, over: { executors: { agent: held(gate), command: held(gate) } } });
    const b = gitApp({ leases, git: () => main(a.root) });
    const ga = graphWith(a.app, 'Orders', writer);
    const gb = graphWith(b.app, 'Billing', writer);
    const ca = client(a.app);
    const cb = client(b.app);
    await a.app.handle(ca.client, { type: 'startRun', graphId: ga.id, reviewed: (await reviewedBy(a.app, ca, ga.id)).signature });
    const runA = ca.all('run')[0].run.id;
    await b.app.handle(cb.client, { type: 'startRun', graphId: gb.id, reviewed: (await reviewedBy(b.app, cb, gb.id)).signature, sequential: true });
    expect(cb.all('runBlocked')).toEqual([]);
    expect(cb.all('run')[0].run.waitingFor).toEqual({ runId: runA, graphId: ga.id, folder: a.projectDir });
    gate.resolve();
    await vi.waitFor(() => expect(cb.all('run').at(-1)?.run.status).toBe('succeeded'));
  });

  it('names another VS Code window, and an unreadable lock file, in the message', async () => {
    const locksDir = mkdtempSync(join(tmpdir(), 'agent-stream-locks-'));
    const { app, root } = gitApp({ leases: createWriteLeases({ locksDir, isAlive: () => true }), git: main });
    createWriteLeases({ locksDir, pid: 4242, isAlive: () => true }).acquire(root, { runId: '20261003-090000-beef', graphId: 'billing', folder: join(tmpdir(), 'elsewhere'), startedAt: 't' });
    const c = client(app);
    const g = graphWith(app, 'Orders', writer);
    await app.handle(c.client, { type: 'startRun', graphId: g.id, reviewed: (await reviewedBy(app, c, g.id)).signature });
    expect(c.last('runBlocked')).toMatchObject({
      otherWindow: true,
      message: `"Orders" can't start: run 20261003-090000-beef in another VS Code window of "billing" is already changing files in this checkout (${root}). Separate tickets need separate worktrees.`,
    });
    writeFileSync(leaseFile(locksDir, root), 'not json');
    await app.handle(c.client, { type: 'startRun', graphId: g.id, reviewed: (await reviewedBy(app, c, g.id)).signature });
    expect(c.last('runBlocked').message).toBe(
      `"Orders" can't start: run unknown in another VS Code window of "unknown" is already changing files in this checkout (${root}). Separate tickets need separate worktrees. Its lock file ${leaseFile(locksDir, root)} can't be read; delete it if no run is changing files.`,
    );
  });

  it('creates the variant worktrees before the run starts, records them, and runs each step in its own', async () => {
    const ran: { id: string; cwd: string }[] = [];
    const record: NodeExecutor = async (ctx) => {
      ran.push({ id: ctx.node.id, cwd: ctx.cwd });
      return { ok: true, output: '' };
    };
    const added: string[] = [];
    const removed: string[] = [];
    const { app, root, home, projectDir } = gitApp({
      git: (root) =>
        repoGit({
          root,
          branch: 'main',
          head: SHA,
          answers: {
            'worktree add --detach *': (cwd, args) => {
              added.push(`${cwd}|${args[3]}|${args[4]}`);
              return {};
            },
            'worktree remove *': (_cwd, args) => {
              removed.push(args.join(' '));
              return {};
            },
          },
        }).exec,
      over: { executors: { agent: record, command: record } },
    });
    const c = client(app);
    const g = graphWith(
      app,
      'AB',
      { type: 'addNode', node: { title: 'a', kind: 'command', command: 'make', workspace: 'wh_a' } },
      { type: 'addNode', node: { title: 'b', kind: 'command', command: 'make', workspace: 'wh_b' } },
      { type: 'addNode', node: { title: 'compare', kind: 'agent', prompt: 'p', access: 'read' } },
    );
    await app.handle(c.client, { type: 'startRun', graphId: g.id, reviewed: (await reviewedBy(app, c, g.id)).signature });
    await vi.waitFor(() => expect(c.all('run').at(-1)?.run.status).toBe('succeeded'));
    const run = c.all('run').at(-1)!.run;
    const pathA = variantPath(home, root, run.id, 'wh_a');
    const pathB = variantPath(home, root, run.id, 'wh_b');
    expect(run.workspaces).toEqual({ wh_a: { path: pathA, head: SHA }, wh_b: { path: pathB, head: SHA } });
    expect(added).toEqual([`${root}|${pathA}|${SHA}`, `${root}|${pathB}|${SHA}`]);
    expect(ran).toEqual(expect.arrayContaining([{ id: 'n1', cwd: pathA }, { id: 'n2', cwd: pathB }, { id: 'n3', cwd: projectDir }]));
    // Kept after the run for inspection (spec §4.3a): nothing removes them.
    expect(removed).toEqual([]);
  });

  it("refuses the run when a workspace can't be created, removing this attempt's worktrees", async () => {
    const ran: string[] = [];
    const { app } = gitApp({
      git: (root) =>
        repoGit({
          root,
          branch: 'main',
          head: SHA,
          answers: {
            'worktree add --detach *': (_cwd, args) => {
              ran.push(`add ${args[3]}`);
              return args[3].endsWith('wh_b') ? { code: 128, stderr: 'fatal: boom\n' } : {};
            },
            'worktree remove --force *': (_cwd, args) => {
              ran.push(`remove ${args[3]}`);
              return {};
            },
          },
        }).exec,
    });
    const c = client(app);
    const g = graphWith(
      app,
      'AB',
      { type: 'addNode', node: { title: 'a', kind: 'command', command: 'make', workspace: 'wh_a' } },
      { type: 'addNode', node: { title: 'b', kind: 'command', command: 'make', workspace: 'wh_b' } },
    );
    await app.handle(c.client, { type: 'startRun', graphId: g.id, reviewed: (await reviewedBy(app, c, g.id)).signature });
    expect(c.last('error').message).toBe('Couldn\'t create workspace "wh_b": fatal: boom');
    expect(app.runStore.list(g.id)).toEqual([]);
    expect(ran).toHaveLength(3);
    expect(ran[2]).toBe(ran[0].replace('add', 'remove'));
  });

  it('removes the worktrees it made when the run is blocked', async () => {
    const ran: string[] = [];
    const locksDir = mkdtempSync(join(tmpdir(), 'agent-stream-locks-'));
    const { app, root } = gitApp({
      leases: createWriteLeases({ locksDir, isAlive: () => true }),
      git: (root) =>
        repoGit({
          root,
          branch: 'main',
          head: SHA,
          answers: { 'worktree add --detach *': (_cwd, args) => (ran.push(`add ${args[3]}`), {}), 'worktree remove --force *': (_cwd, args) => (ran.push(`remove ${args[3]}`), {}) },
        }).exec,
    });
    createWriteLeases({ locksDir, pid: 4242, isAlive: () => true }).acquire(root, { runId: '20261003-090000-beef', graphId: 'x', folder: 'f', startedAt: 't' });
    const c = client(app);
    const g = graphWith(app, 'AB', { type: 'addNode', node: { title: 'a', kind: 'command', command: 'make', workspace: 'wh_a' } }, writer);
    await app.handle(c.client, { type: 'startRun', graphId: g.id, reviewed: (await reviewedBy(app, c, g.id)).signature });
    expect(c.all('runBlocked')).toHaveLength(1);
    expect(ran).toHaveLength(2);
    expect(ran[0]).toMatch(/^add .*wh_a$/);
    expect(ran[1]).toBe(ran[0].replace('add', 'remove'));
  });

  it('refuses a step with a workspace outside Git or before the first commit', async () => {
    for (const { app } of [gitApp(), gitApp({ git: (root) => repoGit({ root, branch: 'main' }).exec })]) {
      const c = client(app);
      const g = graphWith(app, 'AB', { type: 'addNode', node: { title: 'a', kind: 'command', command: 'make', workspace: 'wh_a' } });
      const preview = await reviewedBy(app, c, g.id);
      const problem = 'Step n1 uses workspace "wh_a", which needs a Git repository with at least one commit.';
      expect(preview.problems).toContain(problem);
      await app.handle(c.client, { type: 'startRun', graphId: g.id, reviewed: preview.signature });
      expect(c.last('error').message).toContain(problem);
      expect(app.runStore.list(g.id)).toEqual([]);
    }
  });

  it('releases its leases on dispose', async () => {
    const gate = deferred<void>();
    const { app, root, leases } = gitApp({ over: { executors: { agent: held(gate), command: held(gate) } } });
    const c = client(app);
    const g = graphWith(app, 'G', writer);
    await app.handle(c.client, { type: 'startRun', graphId: g.id, reviewed: (await reviewedBy(app, c, g.id)).signature });
    expect(leases.holder(root)?.runId).toBe(c.all('run')[0].run.id);
    app.dispose();
    expect(leases.holder(root)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w engine -- runPreview app`
Expected: FAIL. There are no notes, no `checkout`, no `runBlocked`, and no worktrees are created.

- [ ] **Step 3: Implement the preview**

In `engine/src/runPreview.ts`, add `parallelWriteSteps`, `workspaceOf` and `type CheckoutInfo` to the shared import. Add to `PreviewInput`:

```ts
  /** The checkout the run will use (ruling R8): refuses workspaces outside Git or before the first commit, notes uncommitted changes. */
  checkout?: CheckoutInfo;
```

After the line `if (input.commandShellProblem && …) problems.push(input.commandShellProblem);`, add:

```ts
  const workspaceSteps = graph.nodes.filter((n) => workspaceOf(n) !== null);
  if (input.checkout && (!input.checkout.git || !input.checkout.head)) {
    for (const n of workspaceSteps) problems.push(`Step ${n.id} uses workspace "${n.workspace}", which needs a Git repository with at least one commit.`);
  }
```

After the loop that pushes the `| unquoted` warnings, add:

```ts
  // Notes are shown, never block (spec §4.7).
  const notes = parallelWriteSteps(graph).map(([a, b]) => `${a} and ${b} can both change files in the same workspace; they will run one at a time.`);
  if (input.checkout?.git && input.checkout.dirty && input.checkout.head && workspaceSteps.length > 0) {
    notes.push(`Workspaces start from ${input.checkout.head.slice(0, 7)}; uncommitted changes in this checkout aren't included.`);
  }
```

Change the returned `preview` to:

```ts
    preview: {
      graphId: graph.id,
      fromNodeId: input.fromNodeId,
      sourceRunId: input.source?.id,
      problems,
      warnings,
      notes,
      steps,
      variables,
      signature,
      ...(input.checkout && { checkout: input.checkout }),
    },
```

- [ ] **Step 4: Implement the app**

In `engine/src/app.ts`:
- Add `workspaceOf`, `type CheckoutInfo` and `type LeaseHolder` to the shared import.
- Add `import { inspectCheckout } from './git';` (`GitExec` is already imported as a type).
- Add `import { createVariantWorkspaces, removeWorkspace } from './variantWorkspaces';`.

Add above `createApp`:

```ts
/** The runBlocked message (spec §4.5), naming an unreadable lock file when there is one (ruling R6). */
export function blockedMessage(o: { graphName: string; holder: LeaseHolder; holderName: string; otherWindow: boolean; root: string; lockFile?: string }): string {
  const text = `"${o.graphName}" can't start: run ${o.holder.runId}${o.otherWindow ? ' in another VS Code window' : ''} of "${o.holderName}" is already changing files in this checkout (${o.root}). Separate tickets need separate worktrees.`;
  return o.lockFile ? `${text} Its lock file ${o.lockFile} can't be read; delete it if no run is changing files.` : text;
}
```

Inside `createApp`, right after `const runner = new Runner(…)`, add:

```ts
  const inspect = (): Promise<CheckoutInfo> => inspectCheckout(d.projectDir, d.git);
  async function checkoutMessage(): Promise<ServerMessage> {
    const info = await inspect();
    const lease = d.leases.holder(info.root);
    return { type: 'checkout', info, ...(lease && { lease }) };
  }
  /** Inspects the checkout and sends it; a failure is logged, never thrown into a run or a client. */
  function sendCheckout(send: (msg: ServerMessage) => void): void {
    checkoutMessage().then(send, (e: unknown) => console.error('[agent-stream] could not inspect the checkout', e));
  }
  /** The holder's graph name, read from its own folder: another workspace folder or window may hold the lease. */
  function holderGraphName(holder: LeaseHolder): string {
    if (!holder.folder) return holder.graphId;
    const store = holder.folder === d.projectDir ? graphStore : new GraphStore(projectPaths(holder.folder));
    const r = store.load(holder.graphId);
    return r.ok ? r.graph.name : holder.graphId;
  }
```

Replace the runner `'run'` listener with:

```ts
  /** Each active run's last announced state: the checkout chip follows a run that starts, ends or stops waiting (spec §4.5). */
  const announced = new Map<string, string>();
  runner.on('run', (run: RunMeta) => {
    broadcast({ type: 'run', run });
    broadcast({ type: 'runs', graphId: run.graphId, runs: runStore.list(run.graphId) });
    broadcastGraphs();
    const state = `${run.status}|${run.waitingFor?.runId ?? ''}`;
    if (announced.get(run.id) === state) return;
    if (run.status === 'running') announced.set(run.id, state);
    else announced.delete(run.id);
    sendCheckout(broadcast);
  });
```

Replace `preview` with:

```ts
  async function preview(
    graph: Graph,
    fromNodeId?: string,
    sourceRunId?: string,
  ): Promise<{ ok: true; outcome: PreviewOutcome; checkout: CheckoutInfo } | { ok: false; error: string }> {
    let source: RunMeta | undefined;
    if (sourceRunId) {
      source = runStore.get(sourceRunId);
      if (!source || source.graphId !== graph.id) return { ok: false, error: `run ${sourceRunId} not found` };
    }
    const checkout = await inspect();
    return { ok: true, checkout, outcome: previewRun({ graph, values: values.get(graph.id), env, source, fromNodeId, commandShellProblem, checkout }) };
  }
```

In `connect`, after `client.send({ type: 'sessions', … });`, add:

```ts
    // After this turn, so hello and sessions always come first (ruling R9); never to a client that left meanwhile.
    setImmediate(() => sendCheckout((msg) => clients.has(client) && client.send(msg)));
```

In `handle`:
- In the `previewRun` case, change `const p = preview(…)` to `const p = await preview(r.graph, msg.fromNodeId, msg.sourceRunId);`.
- Replace the `startRun` case with:

```ts
      case 'startRun': {
        if (!status.ok) return error(`Runs are disabled: ${status.error}`);
        const r = graphStore.load(msg.graphId);
        if (!r.ok) return error(r.error);
        const p = await preview(r.graph, msg.fromNodeId, msg.sourceRunId);
        if (!p.ok) return error(p.error);
        // Run only what the user reviewed: a step, a value or an environment variable may have changed since.
        if (p.outcome.preview.signature !== msg.reviewed) return error(CHANGED_SINCE_REVIEW);
        if (!p.outcome.rendered) return error(p.outcome.preview.problems.join('\n'));
        if (runner.activeFor(r.graph.id)) return error('A run is already in progress for this graph.');
        const { checkout } = p;
        const runId = runner.newRunId();
        // Steps with a workspace never reuse (spec §4.3a): every workspace the graph names gets a fresh worktree, before start.
        const names = [...new Set(r.graph.nodes.map(workspaceOf).filter((w): w is string => w !== null))];
        let workspaces: Record<string, { path: string; head: string }> | undefined;
        if (names.length) {
          // The preview already refused this; kept so `head` is known here.
          if (!checkout.git || !checkout.head) return error(p.outcome.preview.problems.join('\n'));
          const made = await createVariantWorkspaces({ checkoutRoot: checkout.root, runId, names, head: checkout.head, git: d.git, home: d.home });
          if (!made.ok) return error(made.error);
          workspaces = made.workspaces;
        }
        const started = runner.start({
          graph: r.graph,
          rendered: p.outcome.rendered,
          sourceRunId: msg.sourceRunId,
          fromNodeId: msg.fromNodeId,
          provider: provider.id,
          runId,
          checkout,
          sequential: msg.sequential,
          ...(workspaces && { workspaces }),
          // Fixed for the whole run: a provider switch mid-run doesn't reach its later steps.
          ...(d.executors ? {} : { agent: agentFor(provider) }),
        });
        if (started.ok) return;
        // Nothing ran in them yet: the worktrees this attempt made go again.
        for (const w of Object.values(workspaces ?? {})) await removeWorkspace({ checkoutRoot: checkout.root, path: w.path, force: true, git: d.git });
        if (!started.blocked) return error(started.error);
        const { holder, otherWindow, lockFile } = started.blocked;
        client.send({
          type: 'runBlocked',
          graphId: r.graph.id,
          message: blockedMessage({ graphName: r.graph.name, holder, holderName: holderGraphName(holder), otherWindow, root: checkout.root, lockFile }),
          holder,
          otherWindow,
          checkout,
          canSetUpTickets: checkout.git,
        });
        return;
      }
      case 'inspectCheckout':
        client.send(await checkoutMessage());
        return;
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -w engine && npm test -w extension && npm run typecheck`
Expected: PASS. The extension tests use `noGit`, so every engine they create reports "Not a Git repository".

- [ ] **Step 6: Commit**

```bash
git add engine/src/runPreview.ts engine/src/app.ts engine/test/runPreview.test.ts engine/test/app.test.ts
git commit -m "feat(engine): checkout messages, runBlocked, sequential starts and variant worktrees

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 9: Engine — ticket worktrees (plan, check, create)

**Files:**
- Create: `engine/src/worktrees.ts`, `engine/test/worktrees.test.ts`
- Modify: `engine/src/index.ts`

**Interfaces:**
- Consumes: `GitExec`, `parseWorktreeList`, `realOrResolved` (Task 3); `fakeGit`, `missingGit`, `noGit`, `GitAnswer` (Task 3 helpers).
- Produces (re-exported from `@agent-stream/engine`):
  ```ts
  export const MAX_TICKETS = 20;
  export type WorktreeItem = { ticket: string; slug: string; branch: string; path: string };
  export type WorktreePlan = { root: string; parent: string; items: WorktreeItem[] };
  export type WorktreeFs = { exists(p: string): boolean; realpath(p: string): string };
  export const realWorktreeFs: WorktreeFs;
  export type SetupCheck = { problems: string[]; sha?: string; untracked: number };
  export function ticketSlug(ticket: string): string;   // '' when it has no letters or numbers
  export function ticketSlugs(tickets: string[]): { ok: true; slugs: string[] } | { ok: false; error: string };
  export function planWorktrees(o: { root: string; parent: string; tickets: string[] }): { ok: true; plan: WorktreePlan } | { ok: false; error: string };
  export function checkSetup(plan: WorktreePlan, base: string, git: GitExec, fs?: WorktreeFs): Promise<SetupCheck>;
  export function worktreeAddArgs(item: WorktreeItem, sha: string): string[];
  export function createWorktrees(plan: WorktreePlan, sha: string, git: GitExec, after: (item: WorktreeItem) => void | Promise<void>):
    Promise<{ created: WorktreeItem[]; failed?: { item: WorktreeItem; error: string } }>;
  ```
- Setup-check problem texts (ruling R14, plus the spec's dirty-checkout text):
  - `Git isn't available.`
  - `` `${root} isn't a Git repository.` ``
  - `` `"${base}" isn't a valid base.` ``
  - `` `Can't find the base "${base}".` ``
  - the dirty text (§5.1)
  - `` `The folder ${parent} doesn't exist.` ``
  - `` `${parent} is inside this checkout. Choose a folder outside it.` ``
  - `` `${branch} isn't a valid branch name.` ``
  - `` `The branch ${branch} already exists.` ``
  - `` `${path} already exists.` ``
  - `` `${path} is already a registered worktree.` ``

- [ ] **Step 1: Write the failing tests**

Create `engine/test/worktrees.test.ts`:

```ts
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkSetup, createWorktrees, planWorktrees, ticketSlug, ticketSlugs, worktreeAddArgs, type WorktreeFs, type WorktreePlan } from '../src/worktrees';
import { fakeGit, missingGit, noGit, type GitAnswer } from './helpers';

const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const PARENT = join(tmpdir(), 'work');
const ROOT = join(PARENT, 'app');
const P1 = join(PARENT, 'app-abc-1-fix-login');
const P2 = join(PARENT, 'app-abc-2-add-logout');
function plan(tickets = ['ABC-1 Fix login', 'ABC-2 Add logout'], parent = PARENT): WorktreePlan {
  const r = planWorktrees({ root: ROOT, parent, tickets });
  if (!r.ok) throw new Error(r.error);
  return r.plan;
}
/** A filesystem where only `existing` exist; a path's real path is itself. */
const fsWith = (...existing: string[]): WorktreeFs => ({ exists: (p) => existing.includes(p), realpath: (p) => p });
/** A clean checkout where every check passes, with two untracked files. */
const clean = (over: Record<string, GitAnswer> = {}): Record<string, GitAnswer> => ({
  'rev-parse --show-toplevel': { stdout: `${ROOT}\n` },
  'rev-parse --verify --quiet --end-of-options main^{commit}': { stdout: `${SHA}\n` },
  'status --porcelain --untracked-files=no': { stdout: '' },
  'status --porcelain --untracked-files=normal': { stdout: '?? notes.txt\n?? scratch/\n' },
  'worktree list --porcelain': { stdout: `worktree ${ROOT}\nHEAD ${SHA}\nbranch refs/heads/main\n` },
  'check-ref-format --branch feat/abc-1-fix-login': {},
  'check-ref-format --branch feat/abc-2-add-logout': {},
  'show-ref --verify --quiet refs/heads/feat/abc-1-fix-login': { code: 1 },
  'show-ref --verify --quiet refs/heads/feat/abc-2-add-logout': { code: 1 },
  ...over,
});

describe('ticketSlug', () => {
  it.each([
    ['ABC-123 Fix the login redirect', 'abc-123-fix-the-login-redirect'],
    ['  --Hello,   World!--  ', 'hello-world'],
    ['Ünïcode', 'n-code'],
    [`${'a'.repeat(39)} b`, 'a'.repeat(39)],
    ['x'.repeat(50), 'x'.repeat(40)],
    ['!!!', ''],
  ])('slugs %j as %j', (ticket, slug) => expect(ticketSlug(ticket)).toBe(slug));

  it('refuses a ticket without letters or numbers, by its position', () => {
    expect(ticketSlugs(['ABC-1', '!!!'])).toEqual({ ok: false, error: 'Ticket 2 needs letters or numbers.' });
    expect(ticketSlugs(['ABC-1', 'b'])).toEqual({ ok: true, slugs: ['abc-1', 'b'] });
  });
});

describe('planWorktrees', () => {
  it('names each worktree <repo>-<slug> in the parent folder, on branch feat/<slug>', () => {
    expect(plan()).toEqual({
      root: ROOT,
      parent: PARENT,
      items: [
        { ticket: 'ABC-1 Fix login', slug: 'abc-1-fix-login', branch: 'feat/abc-1-fix-login', path: P1 },
        { ticket: 'ABC-2 Add logout', slug: 'abc-2-add-logout', branch: 'feat/abc-2-add-logout', path: P2 },
      ],
    });
  });

  it('refuses fewer than two and more than twenty tickets', () => {
    expect(planWorktrees({ root: ROOT, parent: PARENT, tickets: ['ABC-1'] })).toEqual({ ok: false, error: 'Add at least two tickets.' });
    const many = Array.from({ length: 21 }, (_, i) => `T-${i + 1}`);
    expect(planWorktrees({ root: ROOT, parent: PARENT, tickets: many })).toEqual({ ok: false, error: 'Add at most 20 tickets.' });
    expect(planWorktrees({ root: ROOT, parent: PARENT, tickets: many.slice(0, 20) }).ok).toBe(true);
  });

  it('refuses tickets that would share a branch, naming both, and tickets without letters or numbers', () => {
    expect(planWorktrees({ root: ROOT, parent: PARENT, tickets: ['ABC-1', 'Other', 'abc 1'] })).toEqual({ ok: false, error: 'Tickets 1 and 3 would both use feat/abc-1.' });
    expect(planWorktrees({ root: ROOT, parent: PARENT, tickets: ['ABC-1', '...'] })).toEqual({ ok: false, error: 'Ticket 2 needs letters or numbers.' });
  });
});

describe('checkSetup', () => {
  it('passes a clean checkout, resolving the base and counting untracked files, and creates nothing', async () => {
    const git = fakeGit(clean());
    expect(await checkSetup(plan(), 'main', git.exec, fsWith(PARENT))).toEqual({ problems: [], sha: SHA, untracked: 2 });
    expect(git.calls.every((c) => c.cwd === ROOT)).toBe(true);
    expect(git.ran().some((a) => a.startsWith('worktree add'))).toBe(false);
  });

  it("refuses when Git isn't available, or the folder isn't a repository", async () => {
    expect(await checkSetup(plan(), 'main', missingGit, fsWith(PARENT))).toEqual({ problems: ["Git isn't available."], untracked: 0 });
    expect(await checkSetup(plan(), 'main', noGit, fsWith(PARENT))).toEqual({ problems: [`${ROOT} isn't a Git repository.`], untracked: 0 });
  });

  it('refuses a base that starts with - without passing it to git, and a base that does not resolve', async () => {
    const git = fakeGit(clean());
    expect((await checkSetup(plan(), '--upload-pack=x', git.exec, fsWith(PARENT))).problems).toEqual(['"--upload-pack=x" isn\'t a valid base.']);
    expect(git.ran().some((a) => a.includes('--upload-pack'))).toBe(false);
    expect((await checkSetup(plan(), 'nope', git.exec, fsWith(PARENT))).problems).toEqual(['Can\'t find the base "nope".']);
  });

  it('refuses uncommitted changes to tracked files, counting them', async () => {
    const git = fakeGit(clean({ 'status --porcelain --untracked-files=no': { stdout: ' M a.ts\nM  b.ts\n' } }));
    expect((await checkSetup(plan(), 'main', git.exec, fsWith(PARENT))).problems).toEqual([
      "This checkout has uncommitted changes to tracked files (2). Worktrees start from main and won't include them. Commit them yourself, or run this from a clean checkout.",
    ]);
  });

  it('refuses a parent folder that is missing, or inside the checkout', async () => {
    expect((await checkSetup(plan(), 'main', fakeGit(clean()).exec, fsWith())).problems).toEqual([`The folder ${PARENT} doesn't exist.`]);
    const trees = join(ROOT, 'trees');
    const inside = plan(['ABC-1', 'ABC-2'], trees);
    const git = fakeGit(
      clean({
        'check-ref-format --branch feat/abc-1': {},
        'check-ref-format --branch feat/abc-2': {},
        'show-ref --verify --quiet refs/heads/feat/abc-1': { code: 1 },
        'show-ref --verify --quiet refs/heads/feat/abc-2': { code: 1 },
      }),
    );
    expect((await checkSetup(inside, 'main', git.exec, fsWith(trees))).problems).toEqual([`${trees} is inside this checkout. Choose a folder outside it.`]);
  });

  it('refuses an invalid branch name, an existing branch, an existing folder and a registered worktree', async () => {
    const branches = fakeGit(clean({ 'check-ref-format --branch feat/abc-1-fix-login': { code: 1 }, 'show-ref --verify --quiet refs/heads/feat/abc-2-add-logout': {} }));
    expect((await checkSetup(plan(), 'main', branches.exec, fsWith(PARENT))).problems).toEqual(["feat/abc-1-fix-login isn't a valid branch name.", 'The branch feat/abc-2-add-logout already exists.']);
    const folders = fakeGit(clean({ 'worktree list --porcelain': { stdout: `worktree ${ROOT}\nHEAD ${SHA}\nbranch refs/heads/main\n\nworktree ${P2}\nHEAD ${SHA}\ndetached\n` } }));
    expect((await checkSetup(plan(), 'main', folders.exec, fsWith(PARENT, P1))).problems).toEqual([`${P1} already exists.`, `${P2} is already a registered worktree.`]);
  });

  it('reports every problem at once', async () => {
    const git = fakeGit(clean({ 'status --porcelain --untracked-files=no': { stdout: ' M a.ts\n' }, 'show-ref --verify --quiet refs/heads/feat/abc-2-add-logout': {} }));
    expect((await checkSetup(plan(), 'nope', git.exec, fsWith())).problems).toEqual([
      'Can\'t find the base "nope".',
      "This checkout has uncommitted changes to tracked files (1). Worktrees start from nope and won't include them. Commit them yourself, or run this from a clean checkout.",
      `The folder ${PARENT} doesn't exist.`,
      'The branch feat/abc-2-add-logout already exists.',
    ]);
  });
});

describe('creating ticket worktrees', () => {
  it('adds a worktree on a new branch at the base commit', () => {
    expect(worktreeAddArgs(plan().items[0], SHA)).toEqual(['worktree', 'add', '-b', 'feat/abc-1-fix-login', P1, SHA]);
  });

  it('creates them one at a time from the root, writing each starter graph after its worktree', async () => {
    const order: string[] = [];
    const git = fakeGit({
      [`worktree add -b feat/abc-1-fix-login ${P1} ${SHA}`]: () => (order.push('add 1'), {}),
      [`worktree add -b feat/abc-2-add-logout ${P2} ${SHA}`]: () => (order.push('add 2'), {}),
    });
    expect(await createWorktrees(plan(), SHA, git.exec, (item) => void order.push(`after ${item.slug}`))).toEqual({ created: plan().items });
    expect(order).toEqual(['add 1', 'after abc-1-fix-login', 'add 2', 'after abc-2-add-logout']);
    expect(git.calls.every((c) => c.cwd === ROOT)).toBe(true);
  });

  it('stops at the first failure and never deletes anything', async () => {
    const three = plan(['ABC-1 Fix login', 'ABC-2 Add logout', 'ABC-3']);
    const git = fakeGit({
      [`worktree add -b feat/abc-1-fix-login ${P1} ${SHA}`]: {},
      [`worktree add -b feat/abc-2-add-logout ${P2} ${SHA}`]: { code: 128, stderr: `fatal: could not create work tree dir '${P2}'\n` },
    });
    const after: string[] = [];
    expect(await createWorktrees(three, SHA, git.exec, (item) => void after.push(item.slug))).toEqual({
      created: [three.items[0]],
      failed: { item: three.items[1], error: `fatal: could not create work tree dir '${P2}'` },
    });
    expect(after).toEqual(['abc-1-fix-login']);
    expect(git.ran().filter((a) => !a.startsWith('worktree add'))).toEqual([]);
  });

  it('stops when a starter graph cannot be written, keeping the worktree', async () => {
    const git = fakeGit({ [`worktree add -b feat/abc-1-fix-login ${P1} ${SHA}`]: {} });
    const r = await createWorktrees(plan(), SHA, git.exec, () => {
      throw new Error('ENOSPC: no space left on device');
    });
    expect(r).toEqual({ created: [plan().items[0]], failed: { item: plan().items[0], error: 'ENOSPC: no space left on device' } });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w engine -- worktrees`
Expected: FAIL (the module doesn't exist).

- [ ] **Step 3: Implement `engine/src/worktrees.ts`**

```ts
import { existsSync } from 'node:fs';
import { basename, isAbsolute, join, relative } from 'node:path';
import { parseWorktreeList, realOrResolved, type GitExec, type GitResult } from './git';

export const MAX_TICKETS = 20;
export type WorktreeItem = { ticket: string; slug: string; branch: string; path: string };
export type WorktreePlan = { root: string; parent: string; items: WorktreeItem[] };
/** The filesystem probe checkSetup uses; tests pass a fake. */
export type WorktreeFs = { exists(p: string): boolean; realpath(p: string): string };
export const realWorktreeFs: WorktreeFs = { exists: (p) => existsSync(p), realpath: (p) => realOrResolved(p) };
export type SetupCheck = { problems: string[]; sha?: string; untracked: number };

/** Lowercase; runs of anything but a-z and 0-9 become `-`; trimmed; at most 40 characters with no trailing `-` (spec §5.1). */
export function ticketSlug(ticket: string): string {
  return ticket
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
}

export function ticketSlugs(tickets: string[]): { ok: true; slugs: string[] } | { ok: false; error: string } {
  const slugs = tickets.map(ticketSlug);
  const empty = slugs.indexOf('');
  return empty >= 0 ? { ok: false, error: `Ticket ${empty + 1} needs letters or numbers.` } : { ok: true, slugs };
}

/** One worktree per ticket: `<parent>/<repo folder>-<slug>` on `feat/<slug>` (spec §5.1). */
export function planWorktrees(o: { root: string; parent: string; tickets: string[] }): { ok: true; plan: WorktreePlan } | { ok: false; error: string } {
  const tickets = o.tickets.map((t) => t.trim());
  if (tickets.length < 2) return { ok: false, error: 'Add at least two tickets.' };
  if (tickets.length > MAX_TICKETS) return { ok: false, error: `Add at most ${MAX_TICKETS} tickets.` };
  const s = ticketSlugs(tickets);
  if (!s.ok) return s;
  for (let i = 0; i < s.slugs.length; i++) {
    const first = s.slugs.indexOf(s.slugs[i]);
    if (first < i) return { ok: false, error: `Tickets ${first + 1} and ${i + 1} would both use feat/${s.slugs[i]}.` };
  }
  const items = tickets.map((ticket, i) => ({ ticket, slug: s.slugs[i], branch: `feat/${s.slugs[i]}`, path: join(o.parent, `${basename(o.root)}-${s.slugs[i]}`) }));
  return { ok: true, plan: { root: o.root, parent: o.parent, items } };
}

const lines = (r: GitResult) => r.stdout.split(/\r?\n/).filter((l) => l.trim());
/** `child` is `parent` or inside it (both real paths). */
const inside = (child: string, parent: string) => {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

/** Every problem at once; creates nothing (spec §5.1). */
export async function checkSetup(plan: WorktreePlan, base: string, git: GitExec, fs: WorktreeFs = realWorktreeFs): Promise<SetupCheck> {
  const top = await git(['rev-parse', '--show-toplevel'], plan.root);
  if (top.code === -1) return { problems: ["Git isn't available."], untracked: 0 };
  if (top.code !== 0) return { problems: [`${plan.root} isn't a Git repository.`], untracked: 0 };
  const problems: string[] = [];
  let sha: string | undefined;
  if (!base.trim() || base.startsWith('-')) problems.push(`"${base}" isn't a valid base.`);
  else {
    const r = await git(['rev-parse', '--verify', '--quiet', '--end-of-options', `${base}^{commit}`], plan.root);
    if (r.code === 0 && r.stdout.trim()) sha = r.stdout.trim();
    else problems.push(`Can't find the base "${base}".`);
  }
  const changed = lines(await git(['status', '--porcelain', '--untracked-files=no'], plan.root)).length;
  if (changed > 0) {
    problems.push(`This checkout has uncommitted changes to tracked files (${changed}). Worktrees start from ${base} and won't include them. Commit them yourself, or run this from a clean checkout.`);
  }
  const untracked = lines(await git(['status', '--porcelain', '--untracked-files=normal'], plan.root)).filter((l) => l.startsWith('?? ')).length;
  if (!fs.exists(plan.parent)) problems.push(`The folder ${plan.parent} doesn't exist.`);
  else if (inside(fs.realpath(plan.parent), fs.realpath(plan.root))) problems.push(`${plan.parent} is inside this checkout. Choose a folder outside it.`);
  const registered = new Set(parseWorktreeList((await git(['worktree', 'list', '--porcelain'], plan.root)).stdout).map((w) => fs.realpath(w.path)));
  for (const item of plan.items) {
    if ((await git(['check-ref-format', '--branch', item.branch], plan.root)).code !== 0) problems.push(`${item.branch} isn't a valid branch name.`);
    else if ((await git(['show-ref', '--verify', '--quiet', `refs/heads/${item.branch}`], plan.root)).code === 0) problems.push(`The branch ${item.branch} already exists.`);
    if (fs.exists(item.path)) problems.push(`${item.path} already exists.`);
    else if (registered.has(fs.realpath(item.path))) problems.push(`${item.path} is already a registered worktree.`);
  }
  return { problems, ...(sha && { sha }), untracked };
}

export function worktreeAddArgs(item: WorktreeItem, sha: string): string[] {
  return ['worktree', 'add', '-b', item.branch, item.path, sha];
}

/** One `git worktree add` at a time, from the root, then `after(item)`; stops at the first failure and never deletes (spec §5.1). */
export async function createWorktrees(
  plan: WorktreePlan,
  sha: string,
  git: GitExec,
  after: (item: WorktreeItem) => void | Promise<void>,
): Promise<{ created: WorktreeItem[]; failed?: { item: WorktreeItem; error: string } }> {
  const created: WorktreeItem[] = [];
  for (const item of plan.items) {
    const r = await git(worktreeAddArgs(item, sha), plan.root);
    if (r.code !== 0) return { created, failed: { item, error: r.stderr.trim() || r.stdout.trim() || `git exited with code ${r.code}` } };
    created.push(item);
    try {
      await after(item);
    } catch (e) {
      return { created, failed: { item, error: e instanceof Error ? e.message : String(e) } };
    }
  }
  return { created };
}
```

In `engine/src/index.ts`, add:

```ts
export {
  checkSetup,
  createWorktrees,
  MAX_TICKETS,
  planWorktrees,
  realWorktreeFs,
  ticketSlug,
  ticketSlugs,
  worktreeAddArgs,
  type SetupCheck,
  type WorktreeFs,
  type WorktreeItem,
  type WorktreePlan,
} from './worktrees';
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -w engine -- worktrees && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add engine/src/worktrees.ts engine/src/index.ts engine/test/worktrees.test.ts
git commit -m "feat(engine): plan, check and create one worktree per ticket

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Planner — the policy, access and workspace in the tools, checkout_info and check_tickets

**Files:**
- Create: `engine/src/policy.ts`, `engine/test/policy.test.ts`
- Modify: `engine/src/planner.ts:13-37` (`PLANNER_APPEND`), `:84-96` (`PlannerDeps.checkout`), `:174-180` (passes it to the tools)
- Modify: `engine/src/plannerTools.ts` (`PlannerToolDeps.checkout`, `summarizeGraph`, `add_node`, `update_node`, two new tools)
- Modify: `engine/src/app.ts:213` (the planner's `checkout`)
- Modify: `engine/src/index.ts`
- Modify: `engine/test/helpers.ts` (`outsideGit`)
- Test: `engine/test/plannerTools.test.ts` (its "exposes the documented tools" list gains the two tools), `engine/test/planner.test.ts` (setup gains `checkout`), `engine/test/claudePlanTurn.test.ts:61` and `:293` (setup gains `checkout`)

**Interfaces:**
- Consumes: `ticketSlugs` (Task 9); `CheckoutInfo`, `LeaseHolder` (Task 2); the app's `inspect` (Task 8).
- Produces:
  ```ts
  // engine/src/policy.ts (re-exported)
  export const PARALLEL_POLICY: string;          // §1, verbatim
  export const ALTERNATIVES_RULE: string;        // §1, verbatim
  export const SERIALIZATION_GUIDANCE: string;   // §6, verbatim
  export const PLANNER_TICKET_RULES: string;     // §4.6, verbatim
  export const PLANNER_AB_RULES: string;         // §4.6, verbatim
  export const OUTSIDE_GIT_ADVICE: string;       // §4.6, verbatim
  export const ALL_HAVE_WORKTREES_ADVICE: string;
  export const MISSING_WORKTREES_ADVICE: string;
  // engine/src/plannerTools.ts
  export type CheckoutSource = () => Promise<{ info: CheckoutInfo; lease?: LeaseHolder }>;
  // PlannerToolDeps and PlannerDeps gain: checkout: CheckoutSource;
  // engine/test/helpers.ts
  export function outsideGit(root: string): CheckoutSource;
  ```

- [ ] **Step 1: Write the failing tests**

Create `engine/test/policy.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { ALTERNATIVES_RULE, OUTSIDE_GIT_ADVICE, PARALLEL_POLICY, PLANNER_AB_RULES, PLANNER_TICKET_RULES, SERIALIZATION_GUIDANCE } from '../src/policy';

describe('policy texts', () => {
  it('are the spec texts, verbatim', () => {
    expect(PARALLEL_POLICY).toBe(
      'Before starting or planning concurrent write-capable work, determine whether tasks are separate tickets. If they are, require one Git worktree per ticket. Never run write-capable agents for separate tickets in the same repository checkout. If worktrees cannot be verified or created, offer sequential execution only.',
    );
    expect(ALTERNATIVES_RULE).toBe('Within one graph, the same rule applies to alternatives: parallel write-capable steps need separate workspaces.');
    expect(SERIALIZATION_GUIDANCE).toBe(
      'Even in separate worktrees, changes to `shared/` code, database migrations, package manifests and lockfiles, and contracts between workspaces should normally be serialized: land one ticket, then rebase the others onto it, instead of changing those files in several tickets at once.',
    );
    expect(PLANNER_TICKET_RULES).toBe(
      'Mark agent steps that only read and report as read-only (access: read). Never plan write-capable steps for separate tickets in parallel in one checkout. Before planning work for several tickets, call check_tickets. When tickets lack their own worktrees, suggest the command Agent Stream: Set Up Parallel Tickets, or plan the tickets one after another.',
    );
    expect(PLANNER_AB_RULES).toBe(
      "To compare alternatives at the same time within one graph (A/B tests), put each variant's steps in their own workspace (workspace: <name>) and end with a read-only compare step. Worktrees separate files only: every variant that writes to a database, warehouse, schema or other shared resource must use its own (for dbt, a separate target and schema per variant).",
    );
    expect(OUTSIDE_GIT_ADVICE).toBe("Worktrees can't be verified here; plan the tickets one after another.");
  });
});
```

Add to `engine/test/helpers.ts`:

```ts
import type { CheckoutSource } from '../src/plannerTools';

/** A planner checkout source for a folder outside Git. */
export const outsideGit = (root: string): CheckoutSource => async () => ({ info: { git: false, root, reason: 'Not a Git repository' } });
```

In `engine/test/planner.test.ts` (the `new Planner({ … })` in `setup`) and `engine/test/claudePlanTurn.test.ts:293`, add `checkout: outsideGit(paths.root),`. In `engine/test/claudePlanTurn.test.ts:61`, add `checkout: outsideGit(paths.root)` to the `graphTools({ … })` call. Add `outsideGit` to both files' `./helpers` imports.

Append to `engine/test/planner.test.ts`, inside its main `describe`:

```ts
  it('carries the parallel tickets policy, the alternatives rule and the serialization guidance verbatim', () => {
    for (const text of [PARALLEL_POLICY, ALTERNATIVES_RULE, PLANNER_TICKET_RULES, SERIALIZATION_GUIDANCE, PLANNER_AB_RULES]) expect(PLANNER_APPEND).toContain(text);
    expect(PLANNER_APPEND.indexOf(ALTERNATIVES_RULE)).toBe(PLANNER_APPEND.indexOf(PARALLEL_POLICY) + PARALLEL_POLICY.length + '\n- '.length);
  });
```

(Import the five constants from `../src/policy`.)

In `engine/test/plannerTools.test.ts`:
- Import `type CheckoutInfo` from `@agent-stream/shared`, `ALL_HAVE_WORKTREES_ADVICE` from `../src/policy`, `type CheckoutSource` from `../src/plannerTools`, and `outsideGit` from `./helpers`.
- Change `function setup()` to `function setup(checkout?: CheckoutSource)`, and pass `checkout: checkout ?? outsideGit(paths.root),` to `graphTools({ … })`.
- Change the expected list in "exposes the documented tools" to end with `'request_run', 'get_run', 'checkout_info', 'check_tickets'`.

Then append:

```ts
describe('planner tools for access, workspaces and tickets', () => {
  const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
  const repo = (worktrees: { path: string; branch?: string }[] = []): CheckoutInfo => ({
    git: true,
    root: '/work/app',
    linkedWorktree: false,
    branch: 'main',
    head: SHA,
    dirty: false,
    worktrees: [{ path: '/work/app', branch: 'main', head: SHA, current: true }, ...worktrees.map((w) => ({ ...w, head: SHA, current: false }))],
  });

  it('sets access and workspace with add_node and update_node, and get_graph shows them', async () => {
    const s = setup();
    expect(await s.call('add_node', { kind: 'agent', title: 'Look', prompt: 'p', access: 'read' })).toEqual({ text: 'Added n1.', isError: false });
    expect(await s.call('add_node', { kind: 'command', title: 'Run', command: 'make', workspace: 'wh_a' })).toEqual({ text: 'Added n2.', isError: false });
    const shown = JSON.parse((await s.call('get_graph')).text) as { nodes: Record<string, unknown>[] };
    expect(shown.nodes[0]).toMatchObject({ id: 'n1', access: 'read' });
    expect(shown.nodes[0]).not.toHaveProperty('workspace');
    expect(shown.nodes[1]).toMatchObject({ id: 'n2', workspace: 'wh_a' });
    expect(shown.nodes[1]).not.toHaveProperty('access');
    expect(await s.call('update_node', { id: 'n2', workspace: '' })).toEqual({ text: 'Updated n2.', isError: false });
    expect(s.graphStore.get(s.graphId).nodes[1]).not.toHaveProperty('workspace');
    expect(await s.call('update_node', { id: 'n2', access: 'read' })).toEqual({ text: 'Command steps can always change files; only agent steps can be read-only.', isError: true });
    expect(await s.call('add_node', { kind: 'agent', title: 'Bad', prompt: 'p', workspace: 'Bad Name' })).toEqual({
      text: 'Workspace names use lowercase letters, digits, - and _, starting with a letter.',
      isError: true,
    });
  });

  it('checkout_info returns the checkout and the lease holder as JSON', async () => {
    const holder = { runId: '20261003-090000-aaaa', graphId: 'other', folder: '/work/app', pid: 1, startedAt: 't' };
    expect(JSON.parse((await setup(async () => ({ info: repo(), lease: holder })).call('checkout_info')).text)).toEqual({ checkout: repo(), lease: holder });
    expect(JSON.parse((await setup(async () => ({ info: repo() })).call('checkout_info')).text)).toEqual({ checkout: repo(), lease: null });
  });

  it('check_tickets finds each ticket worktree by its feat/<slug> branch', async () => {
    const s = setup(async () => ({ info: repo([{ path: '/work/app-abc-1', branch: 'feat/abc-1' }, { path: '/work/app-abc-2', branch: 'feat/abc-2' }]) }));
    expect(JSON.parse((await s.call('check_tickets', { tickets: ['ABC-1', 'ABC 2'] })).text)).toEqual({
      tickets: [
        { ticket: 'ABC-1', slug: 'abc-1', branch: 'feat/abc-1', worktree: '/work/app-abc-1' },
        { ticket: 'ABC 2', slug: 'abc-2', branch: 'feat/abc-2', worktree: '/work/app-abc-2' },
      ],
      allHaveWorktrees: true,
      advice: ALL_HAVE_WORKTREES_ADVICE,
    });
  });

  it('check_tickets suggests Set Up Parallel Tickets when a ticket has no worktree', async () => {
    const s = setup(async () => ({ info: repo([{ path: '/work/app-abc-1', branch: 'feat/abc-1' }]) }));
    const r = JSON.parse((await s.call('check_tickets', { tickets: ['ABC-1', 'ABC-3'] })).text);
    expect(r.tickets[1]).toEqual({ ticket: 'ABC-3', slug: 'abc-3', branch: 'feat/abc-3' });
    expect(r).toMatchObject({ allHaveWorktrees: false, advice: 'Not every ticket has its own worktree. Suggest the command Agent Stream: Set Up Parallel Tickets, or plan the tickets one after another.' });
  });

  it('check_tickets says worktrees cannot be verified outside Git', async () => {
    expect(JSON.parse((await setup().call('check_tickets', { tickets: ['ABC-1'] })).text)).toEqual({
      tickets: [{ ticket: 'ABC-1', slug: 'abc-1', branch: 'feat/abc-1' }],
      allHaveWorktrees: false,
      advice: "Worktrees can't be verified here; plan the tickets one after another.",
    });
  });

  it('check_tickets takes 1 to 20 tickets that have letters or numbers', async () => {
    const s = setup();
    expect((await s.call('check_tickets', { tickets: [] })).isError).toBe(true);
    expect((await s.call('check_tickets', { tickets: Array.from({ length: 21 }, (_, i) => `T-${i}`) })).isError).toBe(true);
    expect(await s.call('check_tickets', { tickets: ['ABC-1', '???'] })).toEqual({ text: 'Ticket 2 needs letters or numbers.', isError: true });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w engine -- policy planner plannerTools claudePlanTurn`
Expected: FAIL (`policy.ts` doesn't exist, and the tools don't know `access`, `workspace`, `checkout_info` or `check_tickets`).

- [ ] **Step 3: Implement**

Create `engine/src/policy.ts`:

```ts
/** The policy (spec §1): verbatim in the planner's instructions, the starter graph and the README. */
export const PARALLEL_POLICY =
  'Before starting or planning concurrent write-capable work, determine whether tasks are separate tickets. If they are, require one Git worktree per ticket. Never run write-capable agents for separate tickets in the same repository checkout. If worktrees cannot be verified or created, offer sequential execution only.';
/** Follows the policy in the planner's instructions and the README (spec §1). */
export const ALTERNATIVES_RULE = 'Within one graph, the same rule applies to alternatives: parallel write-capable steps need separate workspaces.';
/** Spec §6: shared by the planner instructions, the starter graph and the README. */
export const SERIALIZATION_GUIDANCE =
  'Even in separate worktrees, changes to `shared/` code, database migrations, package manifests and lockfiles, and contracts between workspaces should normally be serialized: land one ticket, then rebase the others onto it, instead of changing those files in several tickets at once.';
/** Spec §4.6. */
export const PLANNER_TICKET_RULES =
  'Mark agent steps that only read and report as read-only (access: read). Never plan write-capable steps for separate tickets in parallel in one checkout. Before planning work for several tickets, call check_tickets. When tickets lack their own worktrees, suggest the command Agent Stream: Set Up Parallel Tickets, or plan the tickets one after another.';
/** Spec §4.6. */
export const PLANNER_AB_RULES =
  "To compare alternatives at the same time within one graph (A/B tests), put each variant's steps in their own workspace (workspace: <name>) and end with a read-only compare step. Worktrees separate files only: every variant that writes to a database, warehouse, schema or other shared resource must use its own (for dbt, a separate target and schema per variant).";
/** check_tickets outside Git (spec §4.6). */
export const OUTSIDE_GIT_ADVICE = "Worktrees can't be verified here; plan the tickets one after another.";
export const ALL_HAVE_WORKTREES_ADVICE =
  'Every ticket has its own worktree. Plan each ticket in the graph of its own worktree, opened in its own VS Code window; never plan their write-capable work in parallel in this checkout.';
export const MISSING_WORKTREES_ADVICE = 'Not every ticket has its own worktree. Suggest the command Agent Stream: Set Up Parallel Tickets, or plan the tickets one after another.';
```

In `engine/src/planner.ts`, add `import { ALTERNATIVES_RULE, PARALLEL_POLICY, PLANNER_AB_RULES, PLANNER_TICKET_RULES, SERIALIZATION_GUIDANCE } from './policy';` and `import type { CheckoutSource } from './plannerTools';` (merge with the existing `graphTools` import). Then make these changes:
- In `PLANNER_APPEND`, add this bullet after "- An edge from A to B means B runs after A and receives A's output. Nodes with no path between them run in parallel.":

```
- Steps that can change files take turns within one workspace; read-only steps (access: read) and steps in other workspaces run alongside them.
```

- Add this section at the end of `PLANNER_APPEND`, right before its closing backtick (after the dbt line):

```

Parallel work and workspaces:
- ${PARALLEL_POLICY}
- ${ALTERNATIVES_RULE}
- ${PLANNER_TICKET_RULES}
- ${SERIALIZATION_GUIDANCE}
- ${PLANNER_AB_RULES}
- Use checkout_info to see the branch, other worktrees and which run is changing files in this checkout.
```

- Add to `PlannerDeps`: `/** Where the folder's graphs work and who holds its write lease (checkout_info, check_tickets). */ checkout: CheckoutSource;`.
- Add `checkout: this.d.checkout,` to the `graphTools({ … })` call in `send`.

In `engine/src/plannerTools.ts`:
- Add `import type { CheckoutInfo, LeaseHolder } from '@agent-stream/shared';` (merged with the existing shared import), `import { ALL_HAVE_WORKTREES_ADVICE, MISSING_WORKTREES_ADVICE, OUTSIDE_GIT_ADVICE } from './policy';` and `import { ticketSlugs } from './worktrees';`.
- Make these changes:

```ts
/** Where the folder's graphs work and who holds its write lease. */
export type CheckoutSource = () => Promise<{ info: CheckoutInfo; lease?: LeaseHolder }>;
```

Add `/** checkout_info and check_tickets read it. */ checkout: CheckoutSource;` to `PlannerToolDeps`. Add `const access = z.enum(['read', 'write']);` next to `kind`. Change the `summarizeGraph` node mapping to:

```ts
    nodes: graph.nodes.map(({ id, title, kind: k, description, prompt, command, timeoutSec, access: a, workspace, createdBy, updatedBy }) => ({
      id, title, kind: k, description, prompt, command, timeoutSec,
      ...(a === 'read' && { access: 'read' as const }),
      ...(workspace && { workspace }),
      createdBy, updatedBy,
    })),
```

In `add_node`:
- Append to its description: `` ` \`access\` "read" marks an agent step that only reads and reports: it can't edit files or run commands. Command steps can always change files. \`workspace\` names a variant workspace (lowercase letters, digits, - and _): steps with the same workspace run in their own Git worktree for each run, for A/B tests; leave it out for this checkout.` ``
- Add `access: access.optional(), workspace: z.string().optional(),` to its schema.
- Change its op to `{ type: 'addNode', node: { title: a.title, kind: a.kind, description: a.description, prompt: a.prompt, command: a.command, timeoutSec: a.timeoutSec, access: a.access, workspace: a.workspace } }`.

In `update_node`:
- Append to its description: `` ` \`access\` "read" or "write"; \`workspace\` "" puts the step back in this checkout.` ``
- Add `access: access.optional(), workspace: z.string().optional(),` to its schema.

After `get_run`, add the two tools:

```ts
    defineTool(
      'checkout_info',
      'Read-only. Return where this graph works, as JSON: the Git checkout (root, branch, HEAD, uncommitted changes, other worktrees) and the run that is changing files there, if any.',
      {},
      async () => {
        const { info, lease } = await d.checkout();
        return reply(JSON.stringify({ checkout: info, lease: lease ?? null }, null, 2));
      },
    ),
    defineTool(
      'check_tickets',
      'Read-only. Check whether each ticket already has its own Git worktree on branch feat/<slug>. Call it before planning work for several tickets.',
      { tickets: z.array(z.string()).min(1).max(20) },
      async ({ tickets }) => {
        const s = ticketSlugs(tickets);
        if (!s.ok) return reply(s.error, true);
        const { info } = await d.checkout();
        const rows = tickets.map((ticket, i) => {
          const branch = `feat/${s.slugs[i]}`;
          const worktree = info.git ? info.worktrees.find((w) => w.branch === branch)?.path : undefined;
          return { ticket, slug: s.slugs[i], branch, ...(worktree && { worktree }) };
        });
        const allHaveWorktrees = info.git && rows.every((r) => r.worktree);
        const advice = !info.git ? OUTSIDE_GIT_ADVICE : allHaveWorktrees ? ALL_HAVE_WORKTREES_ADVICE : MISSING_WORKTREES_ADVICE;
        return reply(JSON.stringify({ tickets: rows, allHaveWorktrees, advice }, null, 2));
      },
    ),
```

In `engine/src/app.ts`, add this to the `new Planner({ … })` options (it comes after the Task 8 helpers, so `inspect` exists):

```ts
    checkout: async () => {
      const info = await inspect();
      const lease = d.leases.holder(info.root);
      return { info, ...(lease && { lease }) };
    },
```

In `engine/src/index.ts`, add `export { ALTERNATIVES_RULE, PARALLEL_POLICY, SERIALIZATION_GUIDANCE } from './policy';`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -w engine && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add engine/src/policy.ts engine/src/planner.ts engine/src/plannerTools.ts engine/src/app.ts engine/src/index.ts engine/test
git commit -m "feat(engine): planner policy for tickets and workspaces, checkout_info and check_tickets

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: The starter ticket graph and the A/B test template

**Files:**
- Create: `engine/src/ticketGraph.ts`, `engine/src/abTestGraph.ts`, `engine/test/ticketGraph.test.ts`, `engine/test/abTestGraph.test.ts`
- Modify: `engine/src/index.ts`

**Interfaces:**
- Consumes:
  - `PARALLEL_POLICY`, `SERIALIZATION_GUIDANCE` (Task 10);
  - `leaseKey` (Task 4);
  - `GraphStore`, `projectPaths`, `ensureDataDirs`, `VariableValues`, `valuesFileFor` (existing);
  - `applyOp`, `emptyGraph`, `toExportFile`, `workspaceNameProblem` (shared).
- Produces (re-exported from `@agent-stream/engine`):
  ```ts
  // engine/src/ticketGraph.ts
  export const CHECK_COMMAND = 'check_command';
  export const WORKTREE_ONLY_LINE: string;   // "This worktree is the only checkout this ticket's agents change."
  export function starterGraph(ticket: string, now: string): ExportFile;
  export function writeStarterGraph(o: { worktreePath: string; ticket: string; checkCommand: string; home: string; now?: string }): { graphId: string };
  // engine/src/abTestGraph.ts
  export const MIN_VARIANTS = 2;
  export const MAX_VARIANTS = 6;
  export const AB_MEASUREMENT_GUIDANCE: string;   // §5.4, verbatim
  export function abVariableName(variant: string): string;   // run_<variant>, '-' → '_' (ruling R11)
  export function variantProblem(variant: string, earlier: string[]): string | null;
  export function abTestGraph(name: string, variants: string[], now?: string): ExportFile;   // throws on a bad variant list
  ```

- [ ] **Step 1: Write the failing tests**

Create `engine/test/ticketGraph.test.ts`:

```ts
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isWriteCapable, parallelWriteSteps, parseExportFile, topoOrder, upstream, validateRunnable } from '@agent-stream/shared';
import { GraphStore } from '../src/graphStore';
import { projectPaths } from '../src/paths';
import { PARALLEL_POLICY, SERIALIZATION_GUIDANCE } from '../src/policy';
import { starterGraph, writeStarterGraph } from '../src/ticketGraph';
import { valuesFileFor, VariableValues } from '../src/variableValues';
import { leaseKey } from '../src/writeLease';

const T = '2026-10-03T00:00:00.000Z';
function parsed() {
  const r = parseExportFile(JSON.stringify(starterGraph('ABC-1 Fix login', T)), 'abc', T);
  if (!r.ok) throw new Error(r.error);
  return r.graph;
}

describe('starter ticket graph', () => {
  it('is a valid graph for the ticket, with a check_command variable', () => {
    const g = parsed();
    expect(g).toMatchObject({
      name: 'ABC-1 Fix login',
      goal: 'Complete ticket: ABC-1 Fix login',
      variables: [{ name: 'check_command', description: 'Full test suite and typecheck, e.g. npm test && npm run typecheck' }],
    });
    expect(validateRunnable(g)).toEqual([]);
    expect(g.nodes.map((n) => [n.id, n.title, n.kind, n.access ?? 'write'])).toEqual([
      ['n1', 'Read and research', 'agent', 'read'],
      ['n2', 'Implementation', 'agent', 'write'],
      ['n3', 'Focused tests', 'agent', 'write'],
      ['n4', 'Full test + typecheck', 'command', 'write'],
      ['n5', 'Review', 'agent', 'read'],
    ]);
    expect(g.nodes[3].command).toBe('{{ check_command | unquoted }}');
    for (const n of g.nodes) {
      expect(n.description?.trim()).toBeTruthy();
      expect((n.prompt ?? n.command ?? '').trim()).toBeTruthy();
    }
    expect(g.nodes.map((n) => n.position!.x)).toEqual([0, 280, 560, 840, 840]);
  });

  it('has exactly the edges of §5.2', () => {
    expect(parsed().edges.map((e) => `${e.from}->${e.to}`).sort()).toEqual(['n1->n2', 'n2->n3', 'n3->n4', 'n3->n5']);
  });

  it('never has two write-capable steps in one layer, and its widest layer is 2 steps', () => {
    const g = parsed();
    expect(parallelWriteSteps(g)).toEqual([]);
    const depth = new Map<string, number>();
    for (const id of topoOrder(g)) depth.set(id, Math.max(0, ...upstream(g, id).map((p) => depth.get(p)! + 1)));
    const layers = new Map<number, string[]>();
    for (const n of g.nodes) layers.set(depth.get(n.id)!, [...(layers.get(depth.get(n.id)!) ?? []), n.id]);
    for (const ids of layers.values()) expect(ids.filter((id) => isWriteCapable(g.nodes.find((n) => n.id === id)!)).length).toBeLessThanOrEqual(1);
    expect(Math.max(...[...layers.values()].map((ids) => ids.length))).toBe(2);
  });

  it('carries the policy, the worktree line and the serialization guidance in its instructions', () => {
    const { instructions } = parsed();
    expect(instructions).toContain(PARALLEL_POLICY);
    expect(instructions).toContain("This worktree is the only checkout this ticket's agents change.");
    expect(instructions).toContain(SERIALIZATION_GUIDANCE);
  });

  it('keeps two ticket worktrees apart: their own values file and lease key, and nothing copied', () => {
    const parent = realpathSync(mkdtempSync(join(tmpdir(), 'agent-stream-tickets-')));
    const home = mkdtempSync(join(tmpdir(), 'agent-stream-home-'));
    const a = join(parent, 'app-abc-1');
    const b = join(parent, 'app-abc-2');
    mkdirSync(a);
    mkdirSync(b);
    const ga = writeStarterGraph({ worktreePath: a, ticket: 'ABC-1', checkCommand: 'npm test', home });
    const gb = writeStarterGraph({ worktreePath: b, ticket: 'ABC-2', checkCommand: '  ', home });
    expect(valuesFileFor(a, home)).not.toBe(valuesFileFor(b, home));
    expect(leaseKey(a)).not.toBe(leaseKey(b));
    expect(new VariableValues(valuesFileFor(a, home)).get(ga.graphId)).toEqual({ check_command: 'npm test' });
    expect(existsSync(valuesFileFor(b, home))).toBe(false);
    expect(readdirSync(join(a, '.agent-stream')).sort()).toEqual(['.gitignore', 'graphs', 'runs', 'sessions']);
    expect(readdirSync(join(a, '.agent-stream', 'graphs'))).toEqual([`${ga.graphId}.json`]);
    expect(readdirSync(join(a, '.agent-stream', 'runs'))).toEqual([]);
    expect(readdirSync(join(a, '.agent-stream', 'sessions'))).toEqual([]);
    expect(new GraphStore(projectPaths(b)).get(gb.graphId).name).toBe('ABC-2');
  });
});
```

Create `engine/test/abTestGraph.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { parallelWriteSteps, parseExportFile, upstream, validateRunnable, WORKSPACE_NAME_PROBLEM } from '@agent-stream/shared';
import { AB_MEASUREMENT_GUIDANCE, abTestGraph, variantProblem } from '../src/abTestGraph';

const T = '2026-10-03T00:00:00.000Z';
function parsed(variants: string[]) {
  const r = parseExportFile(JSON.stringify(abTestGraph('Warehouse cost test', variants, T)), 'ab', T);
  if (!r.ok) throw new Error(r.error);
  return r.graph;
}

describe('A/B test template', () => {
  it.each([[['wh_small', 'wh_large']], [['a', 'b', 'c', 'd', 'e', 'f']]])('is a valid graph for %j', (variants) => {
    const g = parsed(variants);
    expect(g.name).toBe('Warehouse cost test');
    expect(validateRunnable(g)).toEqual([]);
    expect(g.nodes).toHaveLength(2 + 2 * variants.length);
    expect(g.variables.map((v) => v.name)).toEqual(['setup_command', ...variants.map((v) => `run_${v}`)]);
  });

  it("puts each variant's setup and run steps in its own workspace", () => {
    const g = parsed(['wh_small', 'wh_large']);
    expect(g.nodes.map((n) => [n.id, n.title, n.workspace ?? null, n.command ?? null])).toEqual([
      ['n1', 'Plan the comparison', null, null],
      ['n2', 'Set up wh_small', 'wh_small', '{{ setup_command | unquoted }}'],
      ['n3', 'Run wh_small', 'wh_small', '{{ run_wh_small | unquoted }}'],
      ['n4', 'Set up wh_large', 'wh_large', '{{ setup_command | unquoted }}'],
      ['n5', 'Run wh_large', 'wh_large', '{{ run_wh_large | unquoted }}'],
      ['n6', 'Compare and recommend', null, null],
    ]);
    expect(g.edges.map((e) => e.id).sort()).toEqual(['n1->n2', 'n1->n4', 'n2->n3', 'n3->n6', 'n4->n5', 'n5->n6']);
    expect(parallelWriteSteps(g)).toEqual([]);
  });

  it('makes compare depend on every run step, with plan and compare read-only', () => {
    const g = parsed(['a', 'b', 'c']);
    expect(upstream(g, 'n8').sort()).toEqual(['n3', 'n5', 'n7']);
    expect(g.nodes.filter((n) => n.access === 'read').map((n) => n.id)).toEqual(['n1', 'n8']);
  });

  it('carries the measurement guidance in its instructions and in the compare prompt', () => {
    expect(AB_MEASUREMENT_GUIDANCE).toBe(
      'Worktrees separate files only. Give every variant its own external resources: for dbt, a separate target and schema per variant, so variants never build the same tables. Measure fairly: turn off result caches (for Snowflake, `ALTER SESSION SET USE_CACHED_RESULT = FALSE` via a pre-hook or session parameter); start each variant\'s warehouse suspended so local caches are cold; tag each variant\'s queries (`query_tag`) and read cost and runtime from the warehouse\'s query and metering history; repeat short runs, because minimum billing per resume skews them. Compare runtime, cost and failures per variant, and say how confident the result is.',
    );
    const g = parsed(['wh_small', 'wh_large']);
    expect(g.instructions).toBe(AB_MEASUREMENT_GUIDANCE);
    const compare = g.nodes.find((n) => n.id === 'n6')!;
    expect(compare.prompt).toContain(AB_MEASUREMENT_GUIDANCE);
    expect(compare.prompt).toContain('Recommend one variant and explain why.');
    expect(g.variables[0].description).toBe('Prepares a fresh worktree, e.g. dbt deps (new worktrees have no untracked files such as .venv, dbt_packages or node_modules)');
    expect(g.variables[1].description).toBe('The command for variant wh_small, e.g. dbt build --target wh_small');
  });

  it('fans out: plan on the left, one row per variant, compare on the right', () => {
    const g = parsed(['wh_small', 'wh_large']);
    expect(Object.fromEntries(g.nodes.map((n) => [n.id, n.position]))).toEqual({
      n1: { x: 0, y: 80 },
      n2: { x: 280, y: 0 },
      n3: { x: 560, y: 0 },
      n4: { x: 280, y: 160 },
      n5: { x: 560, y: 160 },
      n6: { x: 840, y: 80 },
    });
  });

  it('turns - into _ in variable names (ruling R11)', () => {
    expect(parsed(['wh-small', 'wh-large']).nodes.find((n) => n.id === 'n3')!.command).toBe('{{ run_wh_small | unquoted }}');
  });

  it('refuses fewer than 2 or more than 6 variants, bad names, repeats and clashing variables', () => {
    expect(() => abTestGraph('x', ['a'])).toThrow('An A/B test needs 2 to 6 variants.');
    expect(() => abTestGraph('x', ['a', 'b', 'c', 'd', 'e', 'f', 'g'])).toThrow('An A/B test needs 2 to 6 variants.');
    expect(variantProblem('Bad', [])).toBe(WORKSPACE_NAME_PROBLEM);
    expect(variantProblem('a', ['a'])).toBe('Variant 2 repeats a.');
    expect(variantProblem('wh_small', ['wh-small'])).toBe('Variants wh-small and wh_small would both use the variable run_wh_small.');
    expect(variantProblem('wh_large', ['wh_small'])).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w engine -- ticketGraph abTestGraph`
Expected: FAIL (the modules don't exist).

- [ ] **Step 3: Implement `engine/src/ticketGraph.ts`**

```ts
import { applyOp, emptyGraph, toExportFile, type ExportFile, type Graph, type NewNodeInput, type Op } from '@agent-stream/shared';
import { GraphStore } from './graphStore';
import { ensureDataDirs, projectPaths } from './paths';
import { PARALLEL_POLICY, SERIALIZATION_GUIDANCE } from './policy';
import { valuesFileFor, VariableValues } from './variableValues';

export const CHECK_COMMAND = 'check_command';
export const WORKTREE_ONLY_LINE = "This worktree is the only checkout this ticket's agents change.";
const X = 280;

/** The five steps of §5.2. n4's value is a whole command, so it expands unquoted (ruling R10). n5 is read-only, so it reads instead of running git (ruling R13). */
const STEPS: NewNodeInput[] = [
  {
    id: 'n1',
    title: 'Read and research',
    kind: 'agent',
    access: 'read',
    description: 'Reads the code the ticket touches and reports what has to change.',
    prompt: "Read the parts of this repository the ticket touches. Report which files and functions have to change, which tests cover them, and any risks or open questions. Don't change anything.",
    position: { x: 0, y: 0 },
  },
  {
    id: 'n2',
    title: 'Implementation',
    kind: 'agent',
    description: 'Makes the change the ticket asks for.',
    prompt: "Implement the ticket in this worktree, following the research above and the repository's conventions. Keep the change to this ticket. Report every file you changed and why.",
    position: { x: X, y: 0 },
  },
  {
    id: 'n3',
    title: 'Focused tests',
    kind: 'agent',
    description: "Runs the tests closest to the change and fixes failures in this ticket's code.",
    prompt:
      "Run the tests closest to the files changed above (the tests for those modules first). Fix failures caused by this ticket's code; don't change unrelated code or tests. Add a test for new behaviour that no test covers. Report the tests you ran, their results, and every file you changed.",
    position: { x: 2 * X, y: 0 },
  },
  {
    id: 'n4',
    title: 'Full test + typecheck',
    kind: 'command',
    description: 'Runs the full test suite and the typecheck.',
    command: `{{ ${CHECK_COMMAND} | unquoted }}`,
    position: { x: 3 * X, y: -80 },
  },
  {
    id: 'n5',
    title: 'Review',
    kind: 'agent',
    access: 'read',
    description: 'Reviews the change against the base and reports problems, without editing.',
    prompt:
      "Review this ticket's change against the base: read every file the earlier steps report changing, and compare it with what the research found before the change. Report bugs, missing tests and anything outside the ticket. This step can't run git or other commands, and it doesn't edit anything.",
    position: { x: 3 * X, y: 80 },
  },
];
const EDGES: [string, string][] = [
  ['n1', 'n2'],
  ['n2', 'n3'],
  ['n3', 'n4'],
  ['n3', 'n5'],
];

/** The graph each ticket worktree starts with (spec §5.2), as an export file. */
export function starterGraph(ticket: string, now: string): ExportFile {
  const name = ticket.trim();
  let g: Graph = {
    ...emptyGraph('ticket', name, now),
    goal: `Complete ticket: ${name}`,
    instructions: [PARALLEL_POLICY, WORKTREE_ONLY_LINE, SERIALIZATION_GUIDANCE].join('\n\n'),
    variables: [{ name: CHECK_COMMAND, description: 'Full test suite and typecheck, e.g. npm test && npm run typecheck' }],
  };
  const ops: Op[] = [...STEPS.map((node): Op => ({ type: 'addNode', node })), ...EDGES.map(([from, to]): Op => ({ type: 'connect', from, to }))];
  for (const op of ops) {
    const r = applyOp(g, op, 'user', now);
    if (!r.ok) throw new Error(r.error);
    g = r.graph;
  }
  return toExportFile(g, now);
}

/** Writes the starter graph into a new worktree and seeds its check command; nothing else is copied (spec §5.2). */
export function writeStarterGraph(o: { worktreePath: string; ticket: string; checkCommand: string; home: string; now?: string }): { graphId: string } {
  const now = o.now ?? new Date().toISOString();
  const paths = projectPaths(o.worktreePath);
  ensureDataDirs(paths);
  const r = new GraphStore(paths).importGraph(JSON.stringify(starterGraph(o.ticket, now)));
  if (!r.ok) throw new Error(r.error);
  const value = o.checkCommand.trim();
  if (value) new VariableValues(valuesFileFor(o.worktreePath, o.home)).set(r.graph.id, CHECK_COMMAND, value);
  return { graphId: r.graph.id };
}
```

- [ ] **Step 4: Implement `engine/src/abTestGraph.ts`**

```ts
import { applyOp, emptyGraph, toExportFile, workspaceNameProblem, type ExportFile, type Graph, type NewNodeInput, type Op } from '@agent-stream/shared';

export const MIN_VARIANTS = 2;
export const MAX_VARIANTS = 6;
/** Spec §5.4: the template's instructions, repeated in the compare step's prompt. */
export const AB_MEASUREMENT_GUIDANCE =
  "Worktrees separate files only. Give every variant its own external resources: for dbt, a separate target and schema per variant, so variants never build the same tables. Measure fairly: turn off result caches (for Snowflake, `ALTER SESSION SET USE_CACHED_RESULT = FALSE` via a pre-hook or session parameter); start each variant's warehouse suspended so local caches are cold; tag each variant's queries (`query_tag`) and read cost and runtime from the warehouse's query and metering history; repeat short runs, because minimum billing per resume skews them. Compare runtime, cost and failures per variant, and say how confident the result is.";
const SETUP_COMMAND = 'setup_command';
const X = 280;
const ROW = 160;

/** `run_<variant>`: workspace names allow `-`, variable names don't (ruling R11). */
export const abVariableName = (variant: string): string => `run_${variant.replace(/-/g, '_')}`;

/** Why `variant` can't follow `earlier` in an A/B test, or null (used by the wizard, one name at a time). */
export function variantProblem(variant: string, earlier: string[]): string | null {
  const name = variant.trim();
  const problem = workspaceNameProblem(name);
  if (problem) return problem;
  if (earlier.includes(name)) return `Variant ${earlier.length + 1} repeats ${name}.`;
  const clash = earlier.find((v) => abVariableName(v) === abVariableName(name));
  return clash ? `Variants ${clash} and ${name} would both use the variable ${abVariableName(name)}.` : null;
}

/** The A/B test template (spec §5.4): a read-only plan step, a setup and a run step per variant in its own workspace, and a read-only compare step. */
export function abTestGraph(name: string, variants: string[], now: string = new Date().toISOString()): ExportFile {
  if (variants.length < MIN_VARIANTS || variants.length > MAX_VARIANTS) throw new Error(`An A/B test needs ${MIN_VARIANTS} to ${MAX_VARIANTS} variants.`);
  variants.forEach((v, i) => {
    const problem = variantProblem(v, variants.slice(0, i));
    if (problem) throw new Error(problem);
  });
  const list = variants.join(', ');
  const mid = ((variants.length - 1) * ROW) / 2;
  const compareId = `n${2 + 2 * variants.length}`;
  const steps: NewNodeInput[] = [
    {
      id: 'n1',
      title: 'Plan the comparison',
      kind: 'agent',
      access: 'read',
      description: 'Plans a fair comparison of the variants.',
      prompt: `Plan how to compare these variants fairly: ${list}. Check how the project is configured (for dbt: profiles, targets and schemas) and confirm that every variant uses its own external resources, so variants never write to the same tables. Say what setup_command and each variant's run command should be, and what the compare step should measure. Don't change anything.`,
      position: { x: 0, y: mid },
    },
    ...variants.flatMap((v, i): NewNodeInput[] => [
      { id: `n${2 + 2 * i}`, title: `Set up ${v}`, kind: 'command', workspace: v, description: `Prepares the ${v} worktree.`, command: `{{ ${SETUP_COMMAND} | unquoted }}`, position: { x: X, y: i * ROW } },
      { id: `n${3 + 2 * i}`, title: `Run ${v}`, kind: 'command', workspace: v, description: `Runs the ${v} variant.`, command: `{{ ${abVariableName(v)} | unquoted }}`, position: { x: 2 * X, y: i * ROW } },
    ]),
    {
      id: compareId,
      title: 'Compare and recommend',
      kind: 'agent',
      access: 'read',
      description: 'Compares the runtime, cost and failures of every variant and recommends one.',
      // Read-only (spec §5.4 table), so it can't run commands itself (ruling R12).
      prompt: `Compare the variants ${list} from each run step's output and duration above. ${AB_MEASUREMENT_GUIDANCE} If you need the warehouse's query or metering history, say which read-only query to run: this step can't run commands, so the user can add a command step, or mark this step "Can edit files" so each command asks for approval. Recommend one variant and explain why.`,
      position: { x: 3 * X, y: mid },
    },
  ];
  const edges: [string, string][] = variants.flatMap((_, i): [string, string][] => [
    ['n1', `n${2 + 2 * i}`],
    [`n${2 + 2 * i}`, `n${3 + 2 * i}`],
    [`n${3 + 2 * i}`, compareId],
  ]);
  let g: Graph = {
    ...emptyGraph('ab-test', name.trim(), now),
    goal: `Compare ${list} and recommend one.`,
    instructions: AB_MEASUREMENT_GUIDANCE,
    variables: [
      { name: SETUP_COMMAND, description: 'Prepares a fresh worktree, e.g. dbt deps (new worktrees have no untracked files such as .venv, dbt_packages or node_modules)' },
      ...variants.map((v) => ({ name: abVariableName(v), description: `The command for variant ${v}, e.g. dbt build --target ${v}` })),
    ],
  };
  for (const op of [...steps.map((node): Op => ({ type: 'addNode', node })), ...edges.map(([from, to]): Op => ({ type: 'connect', from, to }))]) {
    const r = applyOp(g, op, 'user', now);
    if (!r.ok) throw new Error(r.error);
    g = r.graph;
  }
  return toExportFile(g, now);
}
```

In `engine/src/index.ts`, add:

```ts
export { CHECK_COMMAND, starterGraph, writeStarterGraph } from './ticketGraph';
export { AB_MEASUREMENT_GUIDANCE, abTestGraph, abVariableName, MAX_VARIANTS, MIN_VARIANTS, variantProblem } from './abTestGraph';
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -w engine && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add engine/src/ticketGraph.ts engine/src/abTestGraph.ts engine/src/index.ts engine/test/ticketGraph.test.ts engine/test/abTestGraph.test.ts
git commit -m "feat(engine): starter ticket graph and A/B test template

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 12: Extension — Set Up Parallel Tickets

**Files:**
- Create: `extension/src/parallelTickets.ts`, `extension/test/parallelTickets.test.ts`
- Modify: `extension/src/commands.ts:8-18` (`Ui`, `PickItem`), `:129` (`graphCommands` returns `folderFor`)
- Modify: `extension/src/ui.ts` (the new `vscodeUi` methods)
- Modify: `extension/src/graphEditor.ts:104-155` (`MessageHandlerDeps.setUpParallelTickets`, the host case), `:157-166` and `:209-219` (`EditorDeps`, passing it)
- Modify: `extension/src/extension.ts` (register the command; the editor's `setUpParallelTickets`)
- Modify: `extension/package.json` (the command and the view title button)
- Modify: `extension/test/helpers.ts` (`fakeGit`, `repoAnswers`), `extension/test/commands.test.ts:32-41` (the fake `Ui` gains the new methods), `extension/test/graphEditor.test.ts` (setup and a host-message test)

**Interfaces:**
- Consumes:
  - `inspectCheckout`, `planWorktrees`, `checkSetup`, `createWorktrees`, `MAX_TICKETS`, `realWorktreeFs`, `WorktreeFs` (Tasks 3, 9);
  - `writeStarterGraph` (Task 11);
  - `realGit`, `GitExec` (Task 3);
  - `noGit` (Task 5).
- Produces:
  ```ts
  // extension/src/commands.ts
  export type PickItem<T> = { label: string; description?: string; detail?: string; value: T };
  // Ui gains:
  //   inputBox(o: { prompt: string; value?: string; placeHolder?: string; validate(value: string): string | undefined })
  //   confirm(message: string, action: string, detail?: string): Promise<boolean>;
  //   quickPick<T>(items: PickItem<T>[], placeHolder: string): Promise<T | undefined>;
  //   quickPickMany<T>(items: PickItem<T>[], placeHolder: string): Promise<T[] | undefined>;
  //   pickParentFolder(defaultPath: string): Promise<string | undefined>;
  //   openInNewWindow(path: string): Promise<void>;
  //   withProgress<T>(title: string, task: () => Promise<T>): Promise<T>;
  //   infoAction(message: string, action: string): Promise<boolean>;
  // graphCommands(d) returns { commands, pickGraph, folderFor }
  // extension/src/parallelTickets.ts
  export type ParallelFs = WorktreeFs & { readFile(p: string): string | undefined };
  export const realParallelFs: ParallelFs;
  export type ParallelDeps = { engines: EngineManager; ui: Ui; git: GitExec; fs: ParallelFs; home: string;
    folderFor(target?: { folder?: Folder }): Promise<Folder | undefined>; open(target: GraphTarget): Promise<void> };
  export function defaultCheckCommand(root: string, fs: ParallelFs): string;
  export function parallelCommands(d: ParallelDeps): { setUpParallelTickets(target?: { folder?: Folder }): Promise<void> };   // Task 13 adds two more
  // extension/src/graphEditor.ts: MessageHandlerDeps and EditorDeps gain setUpParallelTickets(folder: Folder): void
  ```
- Wizard prompts (ruling R14):
  - base: `Base branch or commit for the new worktrees`, with validation `Enter a branch or commit.`;
  - required ticket: `Enter a ticket, for example ABC-123 Fix the login redirect.`;
  - parent: `Where should the worktrees go?`;
  - check command: `Command for the full test suite and typecheck (leave empty to set it later)`;
  - confirm action: `Create`;
  - progress: `Creating ticket worktrees`;
  - open pick: `Open which worktrees?`;
  - failed checks: `` `Can't set up the ticket worktrees: ${problems.join(' ')}` ``.

- [ ] **Step 1: Write the test helpers and the failing tests**

Add to `extension/test/helpers.ts` (merge the engine import into one line: `import { createWriteLeases, type GitExec, type GitResult } from '@agent-stream/engine';`):

```ts
export type GitAnswer = Partial<GitResult> | ((cwd: string, args: string[]) => Partial<GitResult>);

/** A fake GitExec: answers by the joined arguments (a key ending in ' *' matches by prefix); anything else exits 1. No test runs real git. */
export function fakeGit(answers: Record<string, GitAnswer> = {}) {
  const calls: { args: string[]; cwd: string }[] = [];
  const exec: GitExec = async (args, cwd) => {
    calls.push({ args, cwd });
    const key = args.join(' ');
    const prefix = Object.keys(answers).find((k) => k.endsWith(' *') && key.startsWith(k.slice(0, -1)));
    const answer = answers[key] ?? (prefix === undefined ? undefined : answers[prefix]);
    const r = typeof answer === 'function' ? answer(cwd, args) : answer;
    return r ? { code: r.code ?? 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '' } : { code: 1, stdout: '', stderr: `unexpected: git ${key}` };
  };
  return { exec, calls, ran: () => calls.map((c) => c.args.join(' ')) };
}

/** What inspectCheckout asks, answered for a main checkout at `root` (an existing temp folder, given by its real path). */
export function repoAnswers(o: { root: string; branch: string; head: string }): Record<string, GitAnswer> {
  return {
    'rev-parse --show-toplevel': { stdout: `${o.root}\n` },
    'rev-parse --absolute-git-dir': { stdout: `${join(o.root, '.git')}\n` },
    'rev-parse --git-common-dir': { stdout: `${join(o.root, '.git')}\n` },
    'symbolic-ref --quiet --short HEAD': { stdout: `${o.branch}\n` },
    'rev-parse --verify --quiet HEAD': { stdout: `${o.head}\n` },
    'status --porcelain --untracked-files=no': { stdout: '' },
    'worktree list --porcelain': { stdout: `worktree ${o.root}\nHEAD ${o.head}\nbranch refs/heads/${o.branch}\n` },
  };
}
```

In `extension/test/commands.test.ts`, add these to the fake `ui` object (lines 32–41) so it still `satisfies Record<keyof Ui, unknown>`:

```ts
    quickPick: vi.fn(),
    quickPickMany: vi.fn(),
    pickParentFolder: vi.fn(),
    openInNewWindow: vi.fn(),
    withProgress: vi.fn(),
    infoAction: vi.fn(),
```

In `extension/test/graphEditor.test.ts` `setup()`, add `const setUpParallelTickets = vi.fn();`, pass `setUpParallelTickets` to `createMessageHandler({ … })`, and return it. Then add, inside `describe('graph tab messages', …)`:

```ts
  it("runs Set Up Parallel Tickets for the tab's folder", () => {
    const s = setup();
    s.handler.handle({ type: 'setUpParallelTickets' });
    expect(s.setUpParallelTickets).toHaveBeenCalledWith(s.panel.folder);
  });
```

Create `extension/test/parallelTickets.test.ts`:

```ts
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createApp, valuesFileFor, type GitExec, type NodeOutcome } from '@agent-stream/engine';
import type { Ui } from '../src/commands';
import { EngineManager, type Folder } from '../src/engines';
import { defaultCheckCommand, parallelCommands, realParallelFs } from '../src/parallelTickets';
import { fakeGit, noGit, repoAnswers, signedIn, type GitAnswer } from './helpers';

const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const T1 = 'ABC-1 Fix login';
const T2 = 'ABC-2 Add logout';

function fakeUi() {
  return {
    inputBox: vi.fn(),
    pickGraph: vi.fn(),
    pickFolder: vi.fn(),
    confirm: vi.fn(),
    openFile: vi.fn(),
    saveFile: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    quickPick: vi.fn(),
    quickPickMany: vi.fn(),
    pickParentFolder: vi.fn(),
    openInNewWindow: vi.fn(async () => {}),
    withProgress: vi.fn(async (_title: string, task: () => Promise<unknown>) => task()),
    infoAction: vi.fn(),
  } satisfies Record<keyof Ui, unknown>;
}

/** A repository folder `<tmp>/app` whose package.json has test and typecheck scripts, and the two worktree paths. */
function repo() {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'cs-tickets-')));
  const root = join(parent, 'app');
  mkdirSync(root);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run', typecheck: 'tsc -p .' } }));
  return { parent, root, p1: join(parent, 'app-abc-1-fix-login'), p2: join(parent, 'app-abc-2-add-logout') };
}
type Repo = ReturnType<typeof repo>;

/** Git for a clean checkout on main where every setup check passes; `worktree add` creates the folder. */
function gitFor(r: Repo, over: Record<string, GitAnswer> = {}) {
  return fakeGit({
    ...repoAnswers({ root: r.root, branch: 'main', head: SHA }),
    'rev-parse --verify --quiet --end-of-options main^{commit}': { stdout: `${SHA}\n` },
    'status --porcelain --untracked-files=normal': { stdout: '?? notes.txt\n' },
    'check-ref-format --branch feat/abc-1-fix-login': {},
    'check-ref-format --branch feat/abc-2-add-logout': {},
    'show-ref --verify --quiet refs/heads/feat/abc-1-fix-login': { code: 1 },
    'show-ref --verify --quiet refs/heads/feat/abc-2-add-logout': { code: 1 },
    'worktree add -b *': (_cwd, args) => {
      mkdirSync(args[4], { recursive: true });
      return {};
    },
    ...over,
  });
}

function setup(r: Repo = repo(), git: GitExec = gitFor(r).exec) {
  const home = mkdtempSync(join(tmpdir(), 'cs-home-'));
  const folder: Folder = { key: `file://${r.root}`, name: 'app', path: r.root };
  // Steps wait until they are stopped, so a test can hold a run open.
  const held = (ctx: { signal: AbortSignal }) => new Promise<NodeOutcome>((resolve) => ctx.signal.addEventListener('abort', () => resolve({ ok: false, output: '', error: 'cancelled' })));
  const manager = new EngineManager({
    settings: () => ({ claudePath: '', gitBashPath: '', maxParallel: 1, provider: 'claude' }),
    platform: 'darwin',
    env: {},
    home,
    git: noGit,
    events: { graphs() {}, approvals() {}, confirmRun() {}, graphDeleted() {}, sessions() {}, auth() {}, warning() {} },
    createApp: (deps) => createApp({ ...deps, status: signedIn, executors: { agent: held, command: held } }),
  });
  const ui = fakeUi();
  const opened: { folder: Folder; graphId: string }[] = [];
  const cmds = parallelCommands({ engines: manager, ui: ui as unknown as Ui, git, fs: realParallelFs, home, folderFor: async () => folder, open: async (t) => void opened.push(t) });
  return { r, home, folder, manager, ui, opened, cmds };
}
type Setup = ReturnType<typeof setup>;

/** The wizard's answers, in order: base, tickets (ending with ''), check command; then the parent, the confirmation and the summary button. */
function answer(s: Setup, o: { inputs?: (string | undefined)[]; parent?: 'next' | 'choose'; confirm?: boolean; open?: boolean } = {}) {
  for (const value of o.inputs ?? ['main', T1, T2, '', 'npm test && npm run typecheck']) s.ui.inputBox.mockResolvedValueOnce(value);
  s.ui.quickPick.mockResolvedValueOnce('parent' in o ? o.parent : 'next');
  s.ui.confirm.mockResolvedValueOnce(o.confirm ?? true);
  s.ui.infoAction.mockResolvedValueOnce(o.open ?? true);
}
const added = (git: ReturnType<typeof fakeGit>) => git.calls.filter((c) => c.args[0] === 'worktree' && c.args[1] === 'add');

describe('Set Up Parallel Tickets', () => {
  it('creates one worktree and branch per ticket from one base commit, with a starter graph and the check command in each', async () => {
    const r = repo();
    const git = gitFor(r);
    const s = setup(r, git.exec);
    answer(s);
    s.ui.quickPickMany.mockImplementationOnce(async (items: { value: unknown }[]) => [items[1].value]);
    await s.cmds.setUpParallelTickets();
    expect(s.ui.error).not.toHaveBeenCalled();
    expect(added(git)).toEqual([
      { args: ['worktree', 'add', '-b', 'feat/abc-1-fix-login', r.p1, SHA], cwd: r.root },
      { args: ['worktree', 'add', '-b', 'feat/abc-2-add-logout', r.p2, SHA], cwd: r.root },
    ]);
    for (const [path, id, ticket] of [
      [r.p1, 'abc-1-fix-login', T1],
      [r.p2, 'abc-2-add-logout', T2],
    ]) {
      expect(JSON.parse(readFileSync(join(path, '.agent-stream', 'graphs', `${id}.json`), 'utf8'))).toMatchObject({ name: ticket, goal: `Complete ticket: ${ticket}` });
      expect(JSON.parse(readFileSync(valuesFileFor(path, s.home), 'utf8')).graphs[id]).toEqual({ check_command: 'npm test && npm run typecheck' });
    }
    expect(s.ui.inputBox.mock.calls.map(([o]) => o.prompt)).toEqual([
      'Base branch or commit for the new worktrees',
      'Ticket 1',
      'Ticket 2',
      'Ticket 3 (leave empty to finish)',
      'Command for the full test suite and typecheck (leave empty to set it later)',
    ]);
    expect(s.ui.inputBox.mock.calls[0][0].value).toBe('main');
    expect(s.ui.inputBox.mock.calls[4][0].value).toBe('npm test && npm run typecheck');
    expect(s.ui.quickPick.mock.calls[0][0].map((i: { label: string }) => i.label)).toEqual([`Next to the repo (${r.parent})`, 'Choose folder…']);
    expect(s.ui.confirm).toHaveBeenCalledWith(
      'Create 2 worktrees from main (a1b2c3d)?',
      'Create',
      `${r.p1}  ·  feat/abc-1-fix-login\n${r.p2}  ·  feat/abc-2-add-logout\n1 untracked files stay in this checkout.`,
    );
    expect(s.ui.infoAction).toHaveBeenCalledWith('Set up 2 ticket worktrees from a1b2c3d.', 'Open in New VS Code Window…');
    expect(s.ui.quickPickMany.mock.calls[0][0]).toEqual([
      { label: T1, description: 'feat/abc-1-fix-login', detail: r.p1, value: expect.objectContaining({ path: r.p1 }) },
      { label: T2, description: 'feat/abc-2-add-logout', detail: r.p2, value: expect.objectContaining({ path: r.p2 }) },
    ]);
    expect(s.ui.openInNewWindow.mock.calls).toEqual([[r.p2]]);
  });

  it('puts the worktrees in a chosen folder', async () => {
    const r = repo();
    const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), 'cs-elsewhere-')));
    const git = gitFor(r);
    const s = setup(r, git.exec);
    answer(s, { parent: 'choose', open: false });
    s.ui.pickParentFolder.mockResolvedValueOnce(elsewhere);
    await s.cmds.setUpParallelTickets();
    expect(s.ui.pickParentFolder).toHaveBeenCalledWith(r.parent);
    expect(added(git).map((c) => c.args[4])).toEqual([join(elsewhere, 'app-abc-1-fix-login'), join(elsewhere, 'app-abc-2-add-logout')]);
  });

  it('prefills the check command from the root package.json scripts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cs-pkg-'));
    expect(defaultCheckCommand(dir, realParallelFs)).toBe('');
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' } }));
    expect(defaultCheckCommand(dir, realParallelFs)).toBe('npm test');
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run', typecheck: 'tsc' } }));
    expect(defaultCheckCommand(dir, realParallelFs)).toBe('npm test && npm run typecheck');
    writeFileSync(join(dir, 'package.json'), 'not json');
    expect(defaultCheckCommand(dir, realParallelFs)).toBe('');
  });

  it('refuses outside Git, creating nothing', async () => {
    const s = setup(repo(), noGit);
    await s.cmds.setUpParallelTickets();
    expect(s.ui.error).toHaveBeenCalledWith('Set Up Parallel Tickets needs a Git repository. Not a Git repository');
    expect(s.ui.inputBox).not.toHaveBeenCalled();
  });

  it('shows every failed check in one error, and creates nothing', async () => {
    const r = repo();
    const git = gitFor(r, { 'status --porcelain --untracked-files=no': { stdout: ' M src/a.ts\n' }, 'show-ref --verify --quiet refs/heads/feat/abc-2-add-logout': {} });
    const s = setup(r, git.exec);
    answer(s);
    await s.cmds.setUpParallelTickets();
    expect(s.ui.error).toHaveBeenCalledWith(
      "Can't set up the ticket worktrees: This checkout has uncommitted changes to tracked files (1). Worktrees start from main and won't include them. Commit them yourself, or run this from a clean checkout. The branch feat/abc-2-add-logout already exists.",
    );
    expect(s.ui.confirm).not.toHaveBeenCalled();
    expect(added(git)).toEqual([]);
    expect(existsSync(r.p1)).toBe(false);
  });

  it.each([
    [['main', T1, '', ''], 'Add at least two tickets.'],
    [['main', 'ABC-1', 'abc 1', '', ''], 'Tickets 1 and 2 would both use feat/abc-1.'],
  ])('refuses the tickets %j, creating nothing', async (inputs, message) => {
    const r = repo();
    const git = gitFor(r);
    const s = setup(r, git.exec);
    answer(s, { inputs });
    await s.cmds.setUpParallelTickets();
    expect(s.ui.error).toHaveBeenCalledWith(message);
    expect(added(git)).toEqual([]);
  });

  it.each([
    ['the base', { inputs: [undefined] }],
    ['ticket 1', { inputs: ['main', undefined] }],
    ['ticket 2', { inputs: ['main', T1, undefined] }],
    ['ticket 3', { inputs: ['main', T1, T2, undefined] }],
    ['the parent', { parent: undefined }],
    ['the folder dialog', { parent: 'choose' as const }],
    ['the check command', { inputs: ['main', T1, T2, '', undefined] }],
    ['the confirmation', { confirm: false }],
  ])('creates nothing when cancelled at %s', async (_where, o) => {
    const r = repo();
    const git = gitFor(r);
    const s = setup(r, git.exec);
    answer(s, o);
    await s.cmds.setUpParallelTickets();
    expect(added(git)).toEqual([]);
    expect(s.ui.error).not.toHaveBeenCalled();
    expect(s.ui.infoAction).not.toHaveBeenCalled();
  });

  it('reports a partial failure, keeps what it created, and still offers it', async () => {
    const r = repo();
    const git = gitFor(r, { [`worktree add -b feat/abc-2-add-logout ${r.p2} ${SHA}`]: { code: 128, stderr: `fatal: could not create work tree dir '${r.p2}'\n` } });
    const s = setup(r, git.exec);
    answer(s);
    s.ui.quickPickMany.mockResolvedValueOnce(undefined);
    await s.cmds.setUpParallelTickets();
    expect(s.ui.error).toHaveBeenCalledWith(`Created 1 of 2 worktrees; stopped at ${T2}: fatal: could not create work tree dir '${r.p2}'. Nothing was removed.`);
    expect(s.ui.infoAction).toHaveBeenCalledWith('Set up 1 ticket worktrees from a1b2c3d.', 'Open in New VS Code Window…');
    expect(existsSync(join(r.p1, '.agent-stream', 'graphs', 'abc-1-fix-login.json'))).toBe(true);
    expect(git.ran().some((a) => a.startsWith('worktree remove'))).toBe(false);
    expect(s.ui.openInNewWindow).not.toHaveBeenCalled();
  });
});

describe('manifest', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

  it('contributes Set Up Parallel Tickets, with a branch button in the Graphs view', () => {
    expect(manifest.contributes.commands).toContainEqual({ command: 'agentStream.setUpParallelTickets', title: 'Set Up Parallel Tickets', category: 'Agent Stream', icon: '$(git-branch)' });
    expect(manifest.contributes.menus['view/title']).toContainEqual({ command: 'agentStream.setUpParallelTickets', when: 'view == agentStream.graphs', group: 'navigation@3' });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w extension -- parallelTickets graphEditor commands`
Expected: FAIL. `parallelTickets.ts` doesn't exist, the `Ui` fake has unknown keys, and the host message is ignored.

- [ ] **Step 3: Extend `Ui` and `vscodeUi`**

In `extension/src/commands.ts`, replace the `Ui` type with:

```ts
/** One quick pick item carrying its value. */
export type PickItem<T> = { label: string; description?: string; detail?: string; value: T };

/** The VS Code UI the commands use; tests pass a fake. */
export type Ui = {
  inputBox(o: { prompt: string; value?: string; placeHolder?: string; validate(value: string): string | undefined }): Promise<string | undefined>;
  pickGraph(items: { label: string; description?: string; target: GraphTarget }[]): Promise<GraphTarget | undefined>;
  pickFolder(folders: Folder[]): Promise<Folder | undefined>;
  /** A modal confirmation; `detail` is shown under the message. */
  confirm(message: string, action: string, detail?: string): Promise<boolean>;
  openFile(): Promise<{ size: number; read(): Promise<string> } | undefined>;
  saveFile(defaultPath: string): Promise<{ write(content: string): Promise<void> } | undefined>;
  info(message: string): void;
  error(message: string): void;
  quickPick<T>(items: PickItem<T>[], placeHolder: string): Promise<T | undefined>;
  quickPickMany<T>(items: PickItem<T>[], placeHolder: string): Promise<T[] | undefined>;
  /** A folder picked in the open dialog, starting at `defaultPath`. */
  pickParentFolder(defaultPath: string): Promise<string | undefined>;
  openInNewWindow(path: string): Promise<void>;
  withProgress<T>(title: string, task: () => Promise<T>): Promise<T>;
  /** An information message with one button: true when it was pressed. */
  infoAction(message: string, action: string): Promise<boolean>;
};
```

Change `return { commands, pickGraph };` at the end of `graphCommands` to `return { commands, pickGraph, folderFor };`.

In `extension/src/ui.ts`, change `inputBox` and `confirm`, and add the new methods:

```ts
  inputBox: async (o) => vscode.window.showInputBox({ prompt: o.prompt, value: o.value, placeHolder: o.placeHolder, validateInput: o.validate }),
  confirm: async (message, action, detail) => (await vscode.window.showWarningMessage(message, { modal: true, detail }, action)) === action,
  quickPick: async (items, placeHolder) => (await vscode.window.showQuickPick(items, { placeHolder }))?.value,
  quickPickMany: async (items, placeHolder) => (await vscode.window.showQuickPick(items, { placeHolder, canPickMany: true }))?.map((i) => i.value),
  pickParentFolder: async (defaultPath) =>
    (await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false, defaultUri: vscode.Uri.file(defaultPath), openLabel: 'Put the worktrees here' }))?.[0]?.fsPath,
  openInNewWindow: async (path) => {
    await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(path), { forceNewWindow: true });
  },
  withProgress: (title, task) => Promise.resolve(vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, () => task())),
  infoAction: async (message, action) => (await vscode.window.showInformationMessage(message, action)) === action,
```

- [ ] **Step 4: Implement the wizard**

Create `extension/src/parallelTickets.ts`:

```ts
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { checkSetup, createWorktrees, inspectCheckout, MAX_TICKETS, planWorktrees, realWorktreeFs, writeStarterGraph, type GitExec, type WorktreeFs } from '@agent-stream/engine';
import type { GraphTarget, Ui } from './commands';
import type { EngineManager, Folder } from './engines';

/** What the wizards read from disk; tests use the real one on temp folders. */
export type ParallelFs = WorktreeFs & { readFile(p: string): string | undefined };
export const realParallelFs: ParallelFs = {
  ...realWorktreeFs,
  readFile: (p) => {
    try {
      return readFileSync(p, 'utf8');
    } catch {
      return undefined;
    }
  },
};

/** The parallel-work commands (spec §5.3–§5.5). VS Code-free: everything goes through `ui`, `git` and `fs`. */
export type ParallelDeps = {
  engines: EngineManager;
  ui: Ui;
  git: GitExec;
  fs: ParallelFs;
  /** The home folder: each new worktree's check command is seeded in its values file there. */
  home: string;
  folderFor(target?: { folder?: Folder }): Promise<Folder | undefined>;
  open(target: GraphTarget): Promise<void>;
};

/** `npm test && npm run typecheck` when the root package.json has both scripts, `npm test` with only `test`, else empty (spec §5.3). */
export function defaultCheckCommand(root: string, fs: ParallelFs): string {
  const text = fs.readFile(join(root, 'package.json'));
  if (!text) return '';
  try {
    const scripts = (JSON.parse(text) as { scripts?: Record<string, unknown> }).scripts ?? {};
    if (typeof scripts.test !== 'string') return '';
    return typeof scripts.typecheck === 'string' ? 'npm test && npm run typecheck' : 'npm test';
  } catch {
    return '';
  }
}

const sha7 = (sha: string) => sha.slice(0, 7);

export function parallelCommands(d: ParallelDeps) {
  /** One worktree and branch per ticket from one base commit, each with a starter graph (spec §5.3). Never overwrites anything. */
  async function setUpParallelTickets(target?: { folder?: Folder }): Promise<void> {
    const folder = await d.folderFor(target);
    if (!folder) return;
    const info = await inspectCheckout(folder.path, d.git);
    if (!info.git) return d.ui.error(`Set Up Parallel Tickets needs a Git repository. ${info.reason}`);
    const base = await d.ui.inputBox({ prompt: 'Base branch or commit for the new worktrees', value: info.branch ?? info.head ?? '', validate: (v) => (v.trim() ? undefined : 'Enter a branch or commit.') });
    if (base === undefined) return;
    const tickets: string[] = [];
    for (let n = 1; n <= MAX_TICKETS; n++) {
      const optional = n > 2;
      const value = await d.ui.inputBox({
        prompt: optional ? `Ticket ${n} (leave empty to finish)` : `Ticket ${n}`,
        validate: (v) => (optional || v.trim() ? undefined : 'Enter a ticket, for example ABC-123 Fix the login redirect.'),
      });
      if (value === undefined) return;
      if (!value.trim()) break;
      tickets.push(value.trim());
    }
    const nextToRepo = dirname(info.root);
    const where = await d.ui.quickPick<'next' | 'choose'>(
      [
        { label: `Next to the repo (${nextToRepo})`, value: 'next' },
        { label: 'Choose folder…', value: 'choose' },
      ],
      'Where should the worktrees go?',
    );
    if (!where) return;
    const parent = where === 'next' ? nextToRepo : await d.ui.pickParentFolder(nextToRepo);
    if (!parent) return;
    const checkCommand = await d.ui.inputBox({
      prompt: 'Command for the full test suite and typecheck (leave empty to set it later)',
      value: defaultCheckCommand(info.root, d.fs),
      validate: () => undefined,
    });
    if (checkCommand === undefined) return;
    const planned = planWorktrees({ root: info.root, parent, tickets });
    if (!planned.ok) return d.ui.error(planned.error);
    const check = await checkSetup(planned.plan, base.trim(), d.git, d.fs);
    if (check.problems.length || !check.sha) return d.ui.error(`Can't set up the ticket worktrees: ${check.problems.join(' ')}`);
    const sha = check.sha;
    const n = planned.plan.items.length;
    const lines = planned.plan.items.map((i) => `${i.path}  ·  ${i.branch}`);
    if (check.untracked > 0) lines.push(`${check.untracked} untracked files stay in this checkout.`);
    if (!(await d.ui.confirm(`Create ${n} worktrees from ${base.trim()} (${sha7(sha)})?`, 'Create', lines.join('\n')))) return;
    const result = await d.ui.withProgress('Creating ticket worktrees', () =>
      createWorktrees(planned.plan, sha, d.git, (item) => {
        writeStarterGraph({ worktreePath: item.path, ticket: item.ticket, checkCommand, home: d.home });
      }),
    );
    if (result.failed) d.ui.error(`Created ${result.created.length} of ${n} worktrees; stopped at ${result.failed.item.ticket}: ${result.failed.error}. Nothing was removed.`);
    if (result.created.length === 0) return;
    if (!(await d.ui.infoAction(`Set up ${result.created.length} ticket worktrees from ${sha7(sha)}.`, 'Open in New VS Code Window…'))) return;
    const picked = await d.ui.quickPickMany(
      result.created.map((i) => ({ label: i.ticket, description: i.branch, detail: i.path, value: i })),
      'Open which worktrees?',
    );
    for (const item of picked ?? []) await d.ui.openInNewWindow(item.path);
  }

  return { setUpParallelTickets };
}
```

- [ ] **Step 5: Wire the graph tab's message, the command and the manifest**

In `extension/src/graphEditor.ts`:
- Add `/** The tab's run dialog asked for Set Up Parallel Tickets (spec §5.3). */ setUpParallelTickets(folder: Folder): void;` to `MessageHandlerDeps` and to `EditorDeps`.
- In `createMessageHandler`'s switch, add:

```ts
        case 'setUpParallelTickets':
          d.setUpParallelTickets(d.panel.folder);
          return;
```

- In `GraphEditorProvider.resolveCustomEditor`, add `setUpParallelTickets: (f) => this.d.setUpParallelTickets(f),` to the `createMessageHandler({ … })` call.

In `extension/src/extension.ts`:
- Add `import { parallelCommands, realParallelFs } from './parallelTickets';`.
- Add `setUpParallelTickets: (folder) => void vscode.commands.executeCommand('agentStream.setUpParallelTickets', { folder }),` to the `new GraphEditorProvider({ … })` deps.
- After the loop that registers `graph.commands`, add:

```ts
  const parallel = parallelCommands({
    engines: manager,
    ui: vscodeUi,
    git: realGit,
    fs: realParallelFs,
    home: homedir(),
    folderFor: graph.folderFor,
    open: (t) => openGraphTab(t.folder, t.graphId),
  });
  for (const [name, run] of Object.entries(parallel)) context.subscriptions.push(vscode.commands.registerCommand(`agentStream.${name}`, run));
```

In `extension/package.json`:
- Add this to `contributes.commands`, after `agentStream.deleteGraph`:

```json
      {
        "command": "agentStream.setUpParallelTickets",
        "title": "Set Up Parallel Tickets",
        "category": "Agent Stream",
        "icon": "$(git-branch)"
      },
```

- Add this to `contributes.menus["view/title"]`, after the `importGraph` entry:

```json
        {
          "command": "agentStream.setUpParallelTickets",
          "when": "view == agentStream.graphs",
          "group": "navigation@3"
        },
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm test -w extension && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add extension/src extension/test extension/package.json
git commit -m "feat(extension): Set Up Parallel Tickets creates one worktree per ticket

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: Extension — New A/B Test Graph and Manage Run Workspaces

**Files:**
- Modify: `engine/src/runStore.ts` (`all`), `engine/src/app.ts` (`RunWorkspaceItem`, `runWorkspaces`, `markWorkspaceRemoved`, the returned object), `engine/src/index.ts`
- Modify: `extension/src/parallelTickets.ts` (`newAbTestGraph`, `manageRunWorkspaces`), `extension/package.json`
- Test: `engine/test/runStore.test.ts`, `engine/test/app.test.ts`, `extension/test/parallelTickets.test.ts`

**Interfaces:**
- Consumes:
  - `abTestGraph`, `variantProblem`, `MIN_VARIANTS`, `MAX_VARIANTS` (Task 11);
  - `removeWorkspace`, `pruneWorkspaces` (Task 6);
  - `RunMeta.workspaces`, `RunMeta.checkout` (Task 2);
  - the Task 12 test setup.
- Produces:
  ```ts
  // engine/src/runStore.ts
  all(): RunMeta[];   // every run, newest first
  // engine/src/app.ts (re-exported type)
  export type RunWorkspaceItem = { runId: string; graphId: string; graphName: string; name: string; path: string; head: string; checkoutRoot: string; running: boolean };
  // App gains: runWorkspaces(): RunWorkspaceItem[]; markWorkspaceRemoved(runId: string, name: string): { ok: true } | { ok: false; error: string };
  // extension/src/parallelTickets.ts: parallelCommands(d) also returns newAbTestGraph(target?) and manageRunWorkspaces(target?)
  ```
- Messages (ruling R14):
  - `No run workspaces in this folder.`
  - `Choose a run workspace`
  - `` `Run ${runId} is still running. Stop it first.` ``
  - `` `Run ${runId} has no workspace "${name}".` ``
  - `Name of the new branch`, with validation `Enter a branch name without spaces.`
  - `` `Created the branch ${branch} in ${path}. Its uncommitted changes stay there.` ``
  - `` `Couldn't create the branch ${branch}: ${gitError}` ``
  - `` `Removed ${path}.` `` and `` `Couldn't remove ${path}: ${error}` ``
  - `Name of the A/B test graph` (placeholder `Warehouse cost test`), `Variant 1`, `Variant 2`, `` `Variant ${n} (leave empty to finish)` ``, `Enter a variant name, for example wh_small.`

- [ ] **Step 1: Write the failing tests**

Append to `engine/test/runStore.test.ts`, inside `describe('RunStore', …)`:

```ts
  it('lists every run of every graph, newest first', () => {
    const store = new RunStore(tmpProject());
    store.create(meta('20261002-100000-aaaa'));
    store.create(meta('20261002-120000-cccc', 'other'));
    store.create(meta('20261002-110000-bbbb'));
    expect(store.all().map((m) => m.id)).toEqual(['20261002-120000-cccc', '20261002-110000-bbbb', '20261002-100000-aaaa']);
  });
```

Append to `engine/test/app.test.ts`, inside `describe('for the extension', …)`:

```ts
    it('lists the variant workspaces of its runs, newest first, and marks one removed', () => {
      const { app, graphId, paths } = setupWithGraph();
      const run = (id: string, workspaces: RunMeta['workspaces'], checkout?: RunMeta['checkout']): RunMeta => ({
        id,
        graphId,
        status: 'succeeded',
        startedAt: 't',
        snapshot: emptyGraph(graphId, 'G', 't'),
        nodes: {},
        workspaces,
        ...(checkout && { checkout }),
      });
      app.runStore.create(run('20261003-100000-aaaa', { wh_a: { path: 'wt-a', head: 'h' } }));
      app.runStore.create(run('20261003-110000-bbbb', { wh_b: { path: 'wt-b', head: 'h' }, wh_c: { path: 'wt-c', head: 'h', removed: true } }, { root: 'repo', linkedWorktree: false }));
      expect(app.runWorkspaces()).toEqual([
        { runId: '20261003-110000-bbbb', graphId, graphName: 'G', name: 'wh_b', path: 'wt-b', head: 'h', checkoutRoot: 'repo', running: false },
        { runId: '20261003-100000-aaaa', graphId, graphName: 'G', name: 'wh_a', path: 'wt-a', head: 'h', checkoutRoot: paths.root, running: false },
      ]);
      expect(app.markWorkspaceRemoved('20261003-100000-aaaa', 'wh_a')).toEqual({ ok: true });
      expect(app.runStore.get('20261003-100000-aaaa')?.workspaces?.wh_a).toEqual({ path: 'wt-a', head: 'h', removed: true });
      expect(app.runWorkspaces().map((w) => w.name)).toEqual(['wh_b']);
      expect(app.markWorkspaceRemoved('20261003-100000-aaaa', 'nope')).toEqual({ ok: false, error: 'Run 20261003-100000-aaaa has no workspace "nope".' });
    });
```

Append to `extension/test/parallelTickets.test.ts`:
- Add `emptyGraph` and `type RunMeta` from `@agent-stream/shared` to its imports.
- Add the two new commands to the manifest test as a new `it` inside `describe('manifest', …)`:

```ts
  it('contributes New A/B Test Graph and Manage Run Workspaces', () => {
    expect(manifest.contributes.commands).toContainEqual({ command: 'agentStream.newAbTestGraph', title: 'New A/B Test Graph', category: 'Agent Stream' });
    expect(manifest.contributes.commands).toContainEqual({ command: 'agentStream.manageRunWorkspaces', title: 'Manage Run Workspaces', category: 'Agent Stream' });
  });
```

Then add:

```ts
describe('New A/B Test Graph', () => {
  const names = (s: Setup, ...values: (string | undefined)[]) => {
    for (const v of values) s.ui.inputBox.mockResolvedValueOnce(v);
  };

  it('validates variant names as workspace names, refusing repeats and clashing variables', async () => {
    const s = setup();
    names(s, 'Warehouse cost test', 'wh_small', 'wh_large', '');
    await s.cmds.newAbTestGraph();
    const [name, v1, v2, v3] = s.ui.inputBox.mock.calls.map(([o]) => o);
    expect([name.prompt, name.placeHolder]).toEqual(['Name of the A/B test graph', 'Warehouse cost test']);
    expect(name.validate(' ')).toBe('A graph needs a name.');
    expect([v1.prompt, v2.prompt, v3.prompt]).toEqual(['Variant 1', 'Variant 2', 'Variant 3 (leave empty to finish)']);
    expect(v1.validate('')).toBe('Enter a variant name, for example wh_small.');
    expect(v1.validate('Small WH')).toBe('Workspace names use lowercase letters, digits, - and _, starting with a letter.');
    expect(v2.validate('wh_small')).toBe('Variant 2 repeats wh_small.');
    expect(v3.validate('')).toBeUndefined();
    expect(v3.validate('wh-small')).toBe('Variants wh_small and wh-small would both use the variable run_wh_small.');
  });

  it('writes the graph into the folder and opens it', async () => {
    const s = setup();
    names(s, 'Warehouse cost test', 'wh_small', 'wh_large', '');
    await s.cmds.newAbTestGraph();
    const app = s.manager.get(s.folder);
    const [listed] = app.listGraphs();
    expect(listed.name).toBe('Warehouse cost test');
    expect(app.graphStore.get(listed.id).nodes.map((n) => n.title)).toEqual(['Plan the comparison', 'Set up wh_small', 'Run wh_small', 'Set up wh_large', 'Run wh_large', 'Compare and recommend']);
    expect(s.opened).toEqual([{ folder: s.folder, graphId: listed.id }]);
  });

  it('stops asking after six variants', async () => {
    const s = setup();
    names(s, 'Six', 'a', 'b', 'c', 'd', 'e', 'f');
    await s.cmds.newAbTestGraph();
    expect(s.ui.inputBox).toHaveBeenCalledTimes(7);
    const app = s.manager.get(s.folder);
    expect(app.graphStore.get(app.listGraphs()[0].id).nodes).toHaveLength(14);
  });

  it('creates nothing when cancelled', async () => {
    const s = setup();
    names(s, 'Warehouse cost test', 'wh_small', undefined);
    await s.cmds.newAbTestGraph();
    expect(s.manager.get(s.folder).listGraphs()).toEqual([]);
    expect(s.opened).toEqual([]);
  });
});

describe('Manage Run Workspaces', () => {
  /** A folder with two finished runs: one whose workspace was deleted by hand, one with a changed and a clean workspace. */
  function world() {
    const r = repo();
    const changed = realpathSync(mkdtempSync(join(tmpdir(), 'cs-ws-changed-')));
    const clean = realpathSync(mkdtempSync(join(tmpdir(), 'cs-ws-clean-')));
    const missing = join(tmpdir(), 'cs-ws-missing-never-created');
    const git = fakeGit({
      'status --porcelain': (cwd) => ({ stdout: cwd === changed ? ' M models/orders.sql\n' : '' }),
      'switch -c *': {},
      'worktree remove *': {},
      'worktree prune': {},
    });
    const s = setup(r, git.exec);
    const app = s.manager.get(s.folder);
    const graph = app.createGraph('Warehouse test');
    const run = (id: string, workspaces: RunMeta['workspaces']): RunMeta => ({
      id,
      graphId: graph.id,
      status: 'succeeded',
      startedAt: 't',
      snapshot: emptyGraph(graph.id, 'Warehouse test', 't'),
      nodes: {},
      workspaces,
      checkout: { root: r.root, linkedWorktree: false },
    });
    app.runStore.create(run('20261003-100000-aaaa', { wh_gone: { path: missing, head: SHA } }));
    app.runStore.create(run('20261003-110000-bbbb', { wh_small: { path: changed, head: SHA }, wh_large: { path: clean, head: SHA } }));
    return { ...s, git, app, changed, clean, missing };
  }
  type World = ReturnType<typeof world>;
  /** Picks the item whose label contains `label`, then the action. */
  const choose = (w: World, label: string, action?: 'open' | 'branch' | 'remove') => {
    w.ui.quickPick.mockImplementationOnce(async (items: { label: string; value: unknown }[]) => items.find((i) => i.label.includes(label))?.value);
    if (action) w.ui.quickPick.mockResolvedValueOnce(action);
  };
  const worktreeCalls = (w: World) => w.git.calls.filter((c) => c.args[0] === 'worktree');

  it('lists every run workspace, newest run first, marking missing ones and ones with changes', async () => {
    const w = world();
    w.ui.quickPick.mockResolvedValueOnce(undefined);
    await w.cmds.manageRunWorkspaces();
    expect(w.ui.quickPick.mock.calls[0][0].map((i: { label: string; description: string; detail: string }) => [i.label, i.description, i.detail])).toEqual([
      ['20261003-110000-bbbb · wh_small · has changes', 'Warehouse test', w.changed],
      ['20261003-110000-bbbb · wh_large', 'Warehouse test', w.clean],
      ['20261003-100000-aaaa · wh_gone · missing', 'Warehouse test', w.missing],
    ]);
    expect(w.git.calls).toEqual([
      { args: ['status', '--porcelain'], cwd: w.changed },
      { args: ['status', '--porcelain'], cwd: w.clean },
    ]);
  });

  it('says so when there are none', async () => {
    const s = setup();
    await s.cmds.manageRunWorkspaces();
    expect(s.ui.info).toHaveBeenCalledWith('No run workspaces in this folder.');
    expect(s.ui.quickPick).not.toHaveBeenCalled();
  });

  it('opens a workspace in a new window', async () => {
    const w = world();
    choose(w, 'wh_large', 'open');
    await w.cmds.manageRunWorkspaces();
    expect(w.ui.quickPick.mock.calls[1][0].map((i: { label: string }) => i.label)).toEqual(['Open in New VS Code Window', 'Create Branch Here', 'Remove']);
    expect(w.ui.openInNewWindow).toHaveBeenCalledWith(w.clean);
  });

  it('creates a branch in the workspace, ab/<run id>-<name> by default', async () => {
    const w = world();
    choose(w, 'wh_large', 'branch');
    w.ui.inputBox.mockImplementationOnce(async (o: { value: string }) => o.value);
    await w.cmds.manageRunWorkspaces();
    expect(w.ui.inputBox.mock.calls[0][0].value).toBe('ab/20261003-110000-bbbb-wh_large');
    expect(w.git.calls.at(-1)).toEqual({ args: ['switch', '-c', 'ab/20261003-110000-bbbb-wh_large'], cwd: w.clean });
    expect(w.ui.info).toHaveBeenCalledWith(`Created the branch ab/20261003-110000-bbbb-wh_large in ${w.clean}. Its uncommitted changes stay there.`);
  });

  it('asks before removing a workspace with changes, then removes it with --force and marks it removed', async () => {
    const w = world();
    choose(w, 'wh_small', 'remove');
    w.ui.confirm.mockResolvedValueOnce(true);
    await w.cmds.manageRunWorkspaces();
    expect(w.ui.confirm).toHaveBeenCalledWith(`Remove ${w.changed}? Its uncommitted changes will be lost.`, 'Remove');
    expect(worktreeCalls(w)).toEqual([{ args: ['worktree', 'remove', '--force', w.changed], cwd: w.r.root }]);
    expect(w.app.runStore.get('20261003-110000-bbbb')?.workspaces?.wh_small.removed).toBe(true);
    expect(w.ui.info).toHaveBeenCalledWith(`Removed ${w.changed}.`);
  });

  it('removes nothing when the user declines', async () => {
    const w = world();
    choose(w, 'wh_small', 'remove');
    w.ui.confirm.mockResolvedValueOnce(false);
    await w.cmds.manageRunWorkspaces();
    expect(worktreeCalls(w)).toEqual([]);
    expect(w.app.runStore.get('20261003-110000-bbbb')?.workspaces?.wh_small.removed).toBeUndefined();
  });

  it('removes a clean workspace without asking and without --force', async () => {
    const w = world();
    choose(w, 'wh_large', 'remove');
    await w.cmds.manageRunWorkspaces();
    expect(w.ui.confirm).not.toHaveBeenCalled();
    expect(worktreeCalls(w)).toEqual([{ args: ['worktree', 'remove', w.clean], cwd: w.r.root }]);
  });

  it('offers only Remove for a missing workspace, and runs git worktree prune', async () => {
    const w = world();
    choose(w, 'wh_gone', 'remove');
    await w.cmds.manageRunWorkspaces();
    expect(w.ui.quickPick.mock.calls[1][0].map((i: { label: string }) => i.label)).toEqual(['Remove']);
    expect(worktreeCalls(w)).toEqual([{ args: ['worktree', 'prune'], cwd: w.r.root }]);
    expect(w.app.runStore.get('20261003-100000-aaaa')?.workspaces?.wh_gone.removed).toBe(true);
  });

  it('refuses to remove a workspace of a run that is still running', async () => {
    const w = world();
    const live = realpathSync(mkdtempSync(join(tmpdir(), 'cs-ws-live-')));
    const g = w.app.createGraph('Live');
    w.app.graphStore.apply(g.id, { type: 'addNode', node: { title: 'run', kind: 'command', command: 'make', workspace: 'wh_live' } }, 'user');
    const started = w.app.runner.start({ graph: w.app.graphStore.get(g.id), rendered: { goal: '', instructions: '', nodes: { n1: 'make' } }, workspaces: { wh_live: { path: live, head: SHA } } });
    if (!started.ok) throw new Error(started.error);
    choose(w, 'wh_live', 'remove');
    await w.cmds.manageRunWorkspaces();
    expect(w.ui.error).toHaveBeenCalledWith(`Run ${started.run.id} is still running. Stop it first.`);
    expect(worktreeCalls(w)).toEqual([]);
    w.app.runner.stop(started.run.id);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w engine -- runStore app && npm test -w extension -- parallelTickets`
Expected: FAIL. `all`, `runWorkspaces`, `newAbTestGraph` and `manageRunWorkspaces` don't exist.

- [ ] **Step 3: Implement the engine part**

In `engine/src/runStore.ts`, add:

```ts
  /** Every run of every graph, newest first. */
  all(): RunMeta[] {
    if (!existsSync(this.paths.runsDir)) return [];
    return readdirSync(this.paths.runsDir)
      .filter(isRunId)
      .sort()
      .reverse()
      .map((id) => this.get(id))
      .filter((m): m is RunMeta => !!m);
  }
```

In `engine/src/app.ts`, add above `createApp`:

```ts
/** A variant workspace a run recorded and Manage Run Workspaces hasn't removed (spec §5.5). */
export type RunWorkspaceItem = { runId: string; graphId: string; graphName: string; name: string; path: string; head: string; checkoutRoot: string; running: boolean };
```

Inside `createApp`, add:

```ts
  /** Every variant workspace this folder's runs recorded and haven't removed, newest run first (spec §5.5, ruling R16). */
  function runWorkspaces(): RunWorkspaceItem[] {
    const names = new Map(graphStore.list().map((g) => [g.id, g.name]));
    return runStore.all().flatMap((run) =>
      Object.entries(run.workspaces ?? {})
        .filter(([, w]) => !w.removed)
        .map(([name, w]) => ({
          runId: run.id,
          graphId: run.graphId,
          graphName: names.get(run.graphId) ?? run.graphId,
          name,
          path: w.path,
          head: w.head,
          checkoutRoot: run.checkout?.root ?? d.projectDir,
          running: !!runner.get(run.id),
        })),
    );
  }
  /** Manage Run Workspaces removed it: the run keeps the entry, marked removed (spec §5.5). */
  function markWorkspaceRemoved(runId: string, name: string): { ok: true } | { ok: false; error: string } {
    if (runner.get(runId)) return { ok: false, error: `Run ${runId} is still running. Stop it first.` };
    const run = runStore.get(runId);
    const w = run?.workspaces?.[name];
    if (!run || !w) return { ok: false, error: `Run ${runId} has no workspace "${name}".` };
    run.workspaces = { ...run.workspaces, [name]: { ...w, removed: true } };
    runStore.save(run);
    return { ok: true };
  }
```

Add `runWorkspaces,` and `markWorkspaceRemoved,` to the returned object. In `engine/src/index.ts`, change the first export line to `export { createApp, type App, type AppDeps, type Client, type RunWorkspaceItem } from './app';`.

- [ ] **Step 4: Implement the two commands**

In `extension/src/parallelTickets.ts`:
- Add `abTestGraph`, `MAX_VARIANTS`, `MIN_VARIANTS`, `pruneWorkspaces`, `removeWorkspace`, `variantProblem` and `type RunWorkspaceItem` to the `@agent-stream/engine` import.
- Add `type PickItem` to the `./commands` import.
- Add these inside `parallelCommands`, before the `return`:

```ts
  /** A graph with one variant workspace per variant and a read-only compare step (spec §5.4). */
  async function newAbTestGraph(target?: { folder?: Folder }): Promise<void> {
    const folder = await d.folderFor(target);
    if (!folder) return;
    const name = await d.ui.inputBox({ prompt: 'Name of the A/B test graph', placeHolder: 'Warehouse cost test', validate: (v) => (v.trim() ? undefined : 'A graph needs a name.') });
    if (name === undefined) return;
    const variants: string[] = [];
    for (let n = 1; n <= MAX_VARIANTS; n++) {
      const optional = n > MIN_VARIANTS;
      const earlier = [...variants];
      const value = await d.ui.inputBox({
        prompt: optional ? `Variant ${n} (leave empty to finish)` : `Variant ${n}`,
        placeHolder: n === 1 ? 'wh_small' : n === 2 ? 'wh_large' : undefined,
        validate: (v) => (v.trim() ? (variantProblem(v, earlier) ?? undefined) : optional ? undefined : 'Enter a variant name, for example wh_small.'),
      });
      if (value === undefined) return;
      if (!value.trim()) break;
      variants.push(value.trim());
    }
    let content: string;
    try {
      content = JSON.stringify(abTestGraph(name.trim(), variants));
    } catch (e) {
      return d.ui.error(e instanceof Error ? e.message : String(e));
    }
    const r = d.engines.get(folder).importGraph(content);
    if (!r.ok) return d.ui.error(`Couldn't create the A/B test graph: ${r.error}`);
    await d.open({ folder, graphId: r.graph.id });
  }

  /** Opens, branches or removes the variant workspaces this folder's runs created; nothing is removed any other way (spec §5.5). */
  async function manageRunWorkspaces(target?: { folder?: Folder }): Promise<void> {
    const folder = await d.folderFor(target);
    if (!folder) return;
    const app = d.engines.get(folder);
    const entries = app.runWorkspaces();
    if (entries.length === 0) return d.ui.info('No run workspaces in this folder.');
    type Entry = RunWorkspaceItem & { missing: boolean; changes: boolean };
    const items = await Promise.all(
      entries.map(async (w): Promise<PickItem<Entry>> => {
        const missing = !d.fs.exists(w.path);
        const changes = !missing && (await d.git(['status', '--porcelain'], w.path)).stdout.trim() !== '';
        return { label: `${w.runId} · ${w.name}${missing ? ' · missing' : ''}${changes ? ' · has changes' : ''}`, description: w.graphName, detail: w.path, value: { ...w, missing, changes } };
      }),
    );
    const chosen = await d.ui.quickPick(items, 'Choose a run workspace');
    if (!chosen) return;
    const actions: PickItem<'open' | 'branch' | 'remove'>[] = chosen.missing
      ? [{ label: 'Remove', value: 'remove' }]
      : [
          { label: 'Open in New VS Code Window', value: 'open' },
          { label: 'Create Branch Here', value: 'branch' },
          { label: 'Remove', value: 'remove' },
        ];
    const action = await d.ui.quickPick(actions, `${chosen.runId} · ${chosen.name}`);
    if (!action) return;
    if (action === 'open') return d.ui.openInNewWindow(chosen.path);
    if (action === 'branch') {
      const branch = await d.ui.inputBox({
        prompt: 'Name of the new branch',
        value: `ab/${chosen.runId}-${chosen.name}`,
        validate: (v) => (v.trim() && !/\s/.test(v.trim()) ? undefined : 'Enter a branch name without spaces.'),
      });
      if (branch === undefined) return;
      const name = branch.trim();
      const r = await d.git(['switch', '-c', name], chosen.path);
      if (r.code !== 0) return d.ui.error(`Couldn't create the branch ${name}: ${r.stderr.trim() || r.stdout.trim()}`);
      return d.ui.info(`Created the branch ${name} in ${chosen.path}. Its uncommitted changes stay there.`);
    }
    if (chosen.running) return d.ui.error(`Run ${chosen.runId} is still running. Stop it first.`);
    if (chosen.changes && !(await d.ui.confirm(`Remove ${chosen.path}? Its uncommitted changes will be lost.`, 'Remove'))) return;
    // A workspace deleted by hand is forgotten with prune (spec §8).
    const removed = chosen.missing
      ? await pruneWorkspaces({ checkoutRoot: chosen.checkoutRoot, git: d.git })
      : await removeWorkspace({ checkoutRoot: chosen.checkoutRoot, path: chosen.path, force: chosen.changes, git: d.git });
    if (!removed.ok) return d.ui.error(`Couldn't remove ${chosen.path}: ${removed.error}`);
    const marked = app.markWorkspaceRemoved(chosen.runId, chosen.name);
    if (!marked.ok) return d.ui.error(marked.error);
    d.ui.info(`Removed ${chosen.path}.`);
  }
```

- Change the `return` to `return { setUpParallelTickets, newAbTestGraph, manageRunWorkspaces };`.

In `extension/package.json`, add these after the `setUpParallelTickets` command (`extension.ts` already registers every command `parallelCommands` returns):

```json
      {
        "command": "agentStream.newAbTestGraph",
        "title": "New A/B Test Graph",
        "category": "Agent Stream"
      },
      {
        "command": "agentStream.manageRunWorkspaces",
        "title": "Manage Run Workspaces",
        "category": "Agent Stream"
      },
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -w engine && npm test -w extension && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add engine/src/runStore.ts engine/src/app.ts engine/src/index.ts engine/test extension/src/parallelTickets.ts extension/test/parallelTickets.test.ts extension/package.json
git commit -m "feat(extension): New A/B Test Graph and Manage Run Workspaces

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 14: Web — where the graph works, run tooltips, the run dialog's Checkout line, notes and blocked choices

**Files:**
- Modify: `web/src/components/TopBar.tsx`, `web/src/components/RunConfirmDialog.tsx`, `web/src/bridge.ts:35-44`, `web/src/styles.css`
- Create: `web/test/TopBar.test.ts`
- Test: `web/test/RunConfirmDialog.test.ts`, `web/test/bridge.test.ts`

**Interfaces:**
- Consumes:
  - `checkoutChip`, `checkoutTooltip`, `ranIn`, `waitingText` (Task 2);
  - `State.checkout`, `State.blocked`, `State.lastStart`, and the actions `startRequested`/`closeBlocked` (Task 2);
  - `RunPreview.notes`/`checkout` (Task 8);
  - the host message `{ type: 'setUpParallelTickets' }` (Tasks 2, 12).
- Produces: the visible UI only (class names `checkout-chip`, `checkout-line`, `run-note`; the dialog `aria-label="Run blocked"`).

- [ ] **Step 1: Write the failing tests**

Create `web/test/TopBar.test.ts`:

```ts
// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyGraph, type CheckoutInfo, type RunSummary } from '@agent-stream/shared';

vi.mock('../src/bridge', () => ({ send: vi.fn(), sendHost: vi.fn(), post: vi.fn() }));
const { dispatch } = await import('../src/store');
const { TopBar } = await import('../src/components/TopBar');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const main: CheckoutInfo = {
  git: true,
  root: '/work/app',
  linkedWorktree: false,
  branch: 'main',
  head: SHA,
  dirty: false,
  worktrees: [
    { path: '/work/app', branch: 'main', head: SHA, current: true },
    { path: '/work/app-abc-1', branch: 'feat/abc-1', head: SHA, current: false },
  ],
};
let container: HTMLDivElement;
let root: Root;
const chip = () => container.querySelector('.checkout-chip') as HTMLElement | null;
const checkout = (info: CheckoutInfo) => act(async () => dispatch({ kind: 'server', msg: { type: 'checkout', info } }));

beforeEach(async () => {
  dispatch({ kind: 'server', msg: { type: 'hello', status: { provider: 'claude', ok: true, label: 'Claude Max' }, project: '/work/app', graphs: [{ id: 'g', name: 'G' }, { id: 'billing', name: 'Billing' }], approvals: [] } });
  dispatch({ kind: 'server', msg: { type: 'graphOpened', changes: [], graph: emptyGraph('g', 'G', 't'), runs: [], variableValues: {} } });
  container = document.createElement('div');
  root = createRoot(container);
  await act(async () => root.render(createElement(TopBar)));
});
afterEach(async () => act(async () => root.unmount()));

describe('TopBar checkout chip', () => {
  it('shows the branch, with the root, HEAD and the other worktrees as its tooltip', async () => {
    await checkout(main);
    expect(chip()?.textContent).toBe('⎇ main');
    expect(chip()?.title).toBe(`Root: /work/app\nHEAD: ${SHA}\nOther worktrees:\n  /work/app-abc-1 · feat/abc-1`);
  });

  it('names a linked worktree and a detached HEAD', async () => {
    await checkout({ ...main, root: '/work/app-abc-1', linkedWorktree: true, branch: 'feat/abc-1' });
    expect(chip()?.textContent).toBe('⎇ feat/abc-1 · worktree app-abc-1');
    await checkout({ ...main, branch: undefined });
    expect(chip()?.textContent).toBe('⎇ detached a1b2c3d');
  });

  it('says when the folder is not a Git repository, or Git is missing', async () => {
    await checkout({ git: false, root: '/work/notes', reason: 'Not a Git repository' });
    expect(chip()?.textContent).toBe('Not a Git repository');
    await checkout({ git: false, root: '/work/notes', reason: "Git isn't available" });
    expect(chip()?.textContent).toBe("Git isn't available");
  });
});

describe('TopBar run picker', () => {
  it('says where each run ran, and what a waiting run waits for', async () => {
    const runs: RunSummary[] = [
      { id: '20261003-110000-bbbb', graphId: 'g', status: 'running', startedAt: 't', waitingFor: { runId: '20261003-100000-aaaa', graphId: 'billing', folder: '/work/app' } },
      { id: '20261003-100000-aaaa', graphId: 'g', status: 'succeeded', startedAt: 't', checkout: { root: '/work/app', branch: 'main', head: SHA, linkedWorktree: false } },
    ];
    await act(async () => dispatch({ kind: 'server', msg: { type: 'runs', graphId: 'g', runs } }));
    const options = [...container.querySelectorAll('option')];
    expect(options[0].textContent).toBe('Run 20261003-110000-bbbb · Running · Waiting for run 20261003-100000-aaaa ("Billing") to finish changing files');
    expect(options[1].title).toBe('Ran in /work/app on main at a1b2c3d');
  });
});
```

In `web/test/RunConfirmDialog.test.ts`:
- Change the bridge import to `const { post, send } = await import('../src/bridge');`.
- Add `type ServerMessage` to the shared import.
- Add `vi.mocked(post).mockClear();` and `dispatch({ kind: 'closeBlocked' });` to `beforeEach`. The store outlives each test, and `graphOpened` for the same graph id keeps `blocked`.
- Append:

```ts
describe('RunConfirmDialog and the checkout', () => {
  const MESSAGE = '"G" can\'t start: run 20261003-090000-aaaa of "Billing" is already changing files in this checkout (/work/app). Separate tickets need separate worktrees.';
  const blocked = (canSetUpTickets: boolean): ServerMessage => ({
    type: 'runBlocked',
    graphId: 'g',
    message: MESSAGE,
    holder: { runId: '20261003-090000-aaaa', graphId: 'billing', folder: '/work/app', pid: 1, startedAt: 't' },
    otherWindow: false,
    checkout: canSetUpTickets ? { git: true, root: '/work/app', linkedWorktree: false, dirty: false, worktrees: [] } : { git: false, root: '/work/app', reason: 'Not a Git repository' },
    canSetUpTickets,
  });
  const actionLabels = () => [...container.querySelectorAll('.modal-actions button')].map((b) => b.textContent);
  async function startThenBlock(canSetUpTickets: boolean) {
    await act(async () => dispatch({ kind: 'openConfirm', request: { fromNodeId: 'n2', sourceRunId: 'r1' } }));
    await act(async () => dispatch({ kind: 'server', msg: { type: 'runPreview', preview: preview({ fromNodeId: 'n2', sourceRunId: 'r1' }), requestId: lastRequestId() } }));
    await act(async () => button('Start run').click());
    await act(async () => dispatch({ kind: 'server', msg: blocked(canSetUpTickets) }));
  }

  it('shows the Checkout line and the notes, which never block Start', async () => {
    const checkout = { git: true as const, root: '/work/app', linkedWorktree: false, branch: 'main', head: 'a1b2c3d4e5', dirty: false, worktrees: [] };
    await act(async () => dispatch({ kind: 'openConfirm', request: {} }));
    await act(async () =>
      dispatch({ kind: 'server', msg: { type: 'runPreview', preview: preview({ checkout, notes: ['n1 and n2 can both change files in the same workspace; they will run one at a time.'] }), requestId: lastRequestId() } }),
    );
    expect(container.querySelector('.checkout-line')?.textContent).toBe('Checkout: ⎇ main · /work/app');
    expect(container.querySelector('.run-note')?.textContent).toBe('ℹ n1 and n2 can both change files in the same workspace; they will run one at a time.');
    expect(button('Start run').disabled).toBe(false);
  });

  it('offers Set Up Parallel Tickets, Run after it finishes and Cancel when the run is blocked', async () => {
    await startThenBlock(true);
    expect(container.querySelector('[aria-label="Run blocked"]')?.textContent).toContain(MESSAGE);
    expect(actionLabels()).toEqual(['Cancel', 'Set Up Parallel Tickets', 'Run after it finishes']);
  });

  it('re-sends the reviewed start with sequential when Run after it finishes is chosen', async () => {
    await startThenBlock(true);
    await act(async () => button('Run after it finishes').click());
    expect(send).toHaveBeenLastCalledWith({ type: 'startRun', graphId: 'g', reviewed: 'sig-1', fromNodeId: 'n2', sourceRunId: 'r1', sequential: true });
    expect(getState().blocked).toBeUndefined();
    expect(container.querySelector('[aria-label="Run blocked"]')).toBeNull();
  });

  it('asks the extension to set up parallel tickets, and offers it only in Git checkouts', async () => {
    await startThenBlock(true);
    await act(async () => button('Set Up Parallel Tickets').click());
    expect(post).toHaveBeenCalledWith({ type: 'setUpParallelTickets' });
    expect(getState().blocked).toBeUndefined();
    await startThenBlock(false);
    expect(actionLabels()).toEqual(['Cancel', 'Run after it finishes']);
    vi.mocked(send).mockClear();
    await act(async () => button('Cancel').click());
    expect(getState().blocked).toBeUndefined();
    expect(send).not.toHaveBeenCalled();
  });
});
```

Append to `web/test/bridge.test.ts`, inside `describe('bridge', …)` (after the first test, which calls `connect()`):

```ts
  it('asks for the checkout again whenever the tab becomes visible', () => {
    posted.length = 0;
    const visibility = (state: string) => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
      document.dispatchEvent(new Event('visibilitychange'));
    };
    visibility('visible');
    expect(posted).toEqual([{ type: 'inspectCheckout' }]);
    visibility('hidden');
    expect(posted).toEqual([{ type: 'inspectCheckout' }]);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w web -- TopBar RunConfirmDialog bridge`
Expected: FAIL. There is no chip, no run tooltip, no Checkout line, no notes, no blocked dialog, and no visibility listener.

- [ ] **Step 3: Implement the top bar**

Replace `web/src/components/TopBar.tsx` with:

```tsx
import { PROVIDER_NAMES, checkoutChip, checkoutTooltip, ranIn, statusLabel, waitingText } from '@agent-stream/shared';
import { actions } from '../actions';
import { send } from '../bridge';
import { useStore } from '../store';
import { MenuBar } from './MenuBar';

export function TopBar() {
  const status = useStore((s) => s.status);
  const graph = useStore((s) => s.graph);
  const graphs = useStore((s) => s.graphs);
  const runs = useStore((s) => s.runs);
  const run = useStore((s) => s.run);
  const checkout = useStore((s) => s.checkout);
  const running = run?.status === 'running';
  const graphName = (id: string) => graphs.find((g) => g.id === id)?.name ?? id;
  return (
    <header className="topbar">
      <MenuBar />
      {graph && (
        <span className="graph-name" title={graph.id}>
          {graph.name}
        </span>
      )}
      {checkout && (
        // Where this graph works (spec §7): its branch and worktree, refreshed on every checkout message.
        <span className="checkout-chip" title={checkoutTooltip(checkout.info)}>
          {checkoutChip(checkout.info)}
        </span>
      )}
      <span className="spacer" />
      {runs.length > 0 && (
        <select aria-label="Run" value={run?.id ?? ''} onChange={(e) => send({ type: 'selectRun', runId: e.target.value })}>
          {runs.map((r) => {
            // The selected run's own record is live and lists each change; other runs give the count alone.
            const selected = run?.id === r.id ? run : undefined;
            const n = (selected ? selected.amendments?.length : r.amendments) ?? 0;
            const waiting = selected ? selected.waitingFor : r.waitingFor;
            const ran = selected?.checkout ?? r.checkout;
            const title = [selected?.amendments?.map((a) => a.summary).join('\n'), ran && ranIn(ran)].filter(Boolean).join('\n') || undefined;
            return (
              <option key={r.id} value={r.id} title={title}>
                {`Run ${r.id} · ${statusLabel(r.status)}${r.provider ? ` · ${PROVIDER_NAMES[r.provider]}` : ''}${n > 0 ? ` · ${n} change${n === 1 ? '' : 's'} by agents` : ''}${waiting ? ` · ${waitingText(waiting, graphName(waiting.graphId))}` : ''}`}
              </option>
            );
          })}
        </select>
      )}
      {graph &&
        (running ? (
          <button className="danger" onClick={actions.stop}>
            ■ Stop
          </button>
        ) : (
          <button className="primary" disabled={!status?.ok} onClick={actions.run}>
            ▶ Run
          </button>
        ))}
    </header>
  );
}
```

- [ ] **Step 4: Implement the run dialog**

In `web/src/components/RunConfirmDialog.tsx`:
- Change the imports to `import { checkoutChip } from '@agent-stream/shared';` and `import { post, send } from '../bridge';`.
- In `RunConfirmDialog`, add `const blocked = useStore((s) => s.blocked);` after the existing `useStore` calls (before the `useEffect`).
- Right before `if (!confirm || !graph) return null;`, add:

```tsx
  if (blocked && graph) {
    // Another run is changing files in this checkout (spec §7): separate tickets, or wait for it.
    const dismiss = () => dispatch({ kind: 'closeBlocked' });
    const runAfter = () => {
      if (blocked.start) send({ type: 'startRun', ...blocked.start, sequential: true });
      dismiss();
    };
    return (
      <div className="modal-backdrop" onClick={dismiss}>
        <div className="modal" role="dialog" aria-label="Run blocked" onClick={(e) => e.stopPropagation()}>
          <h2>Can't start yet</h2>
          <p>{blocked.message}</p>
          <div className="modal-actions">
            <button onClick={dismiss}>Cancel</button>
            {blocked.canSetUpTickets && (
              <button
                onClick={() => {
                  post({ type: 'setUpParallelTickets' });
                  dismiss();
                }}
              >
                Set Up Parallel Tickets
              </button>
            )}
            <button className="primary" disabled={!blocked.start} onClick={runAfter}>
              Run after it finishes
            </button>
          </div>
        </div>
      </div>
    );
  }
```

- Change `start` to record what it sent:

```tsx
  const start = () => {
    if (!preview) return;
    const request = { graphId: graph.id, reviewed: preview.signature, fromNodeId: confirm.fromNodeId, sourceRunId: confirm.sourceRunId };
    send({ type: 'startRun', ...request });
    dispatch({ kind: 'startRequested', start: request });
    close();
  };
```

- Inside the `<>…</>` block (after the problems block, before the warnings), add:

```tsx
            {preview.checkout && (
              <p className="checkout-line">
                Checkout: {checkoutChip(preview.checkout)} · {preview.checkout.root}
              </p>
            )}
            {preview.notes?.map((n) => (
              <p key={n} className="run-note">
                ℹ {n}
              </p>
            ))}
```

(`send({ type: 'startRun', ...request })` still sends exactly `{ type, graphId, reviewed, fromNodeId, sourceRunId }`, so the existing "starts with the signature" test passes unchanged.)

- [ ] **Step 5: Refresh the checkout when the tab becomes visible**

In `web/src/bridge.ts`, inside `connect()`, before `post({ type: 'ready' });`, add:

```ts
  // The checkout can change while the tab is hidden (a branch switch in a terminal): ask again when it shows (spec §7).
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') send({ type: 'inspectCheckout' });
  });
```

- [ ] **Step 6: Style it**

Append to `web/src/styles.css`:

```css
.checkout-chip { margin-left: 8px; padding: 1px 6px; border: 1px solid var(--border); border-radius: 10px; color: var(--muted); font-size: 12px; white-space: nowrap; }
.checkout-line { color: var(--muted); }
.run-note { color: var(--info); }
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npm test -w web && npm run typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add web/src web/test
git commit -m "feat(web): checkout chip, run tooltips, blocked-run choices and preview notes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 15: Web — Access and Workspace fields, badges, and the logs header

**Files:**
- Create: `web/src/workspaceColor.ts`
- Modify: `web/src/components/NodePanel.tsx` (draft, fields, save), `web/src/components/StepNode.tsx:38-49`, `web/src/components/LogsPanel.tsx:10-58`, `web/src/styles.css`
- Test: `web/test/NodePanel.test.ts`, `web/test/StepNode.test.ts`, `web/test/LogsPanel.test.ts`

**Interfaces:**
- Consumes: `GraphNode.access/workspace`, `NodePatch.access/workspace` (Task 1); `RunMeta.workspaces/waitingFor`, `waitingText` (Task 2).
- Produces:
  ```ts
  // web/src/workspaceColor.ts
  export const WORKSPACE_COLORS = 6;
  export function workspaceColor(name: string): number;   // 0..5, from a hash of the name; class ws-color-<n>
  ```

- [ ] **Step 1: Write the failing tests**

Append to `web/test/NodePanel.test.ts`:

```ts
describe('NodePanel access and workspace', () => {
  const change = (el: HTMLInputElement | HTMLSelectElement, value: string) => {
    const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
  };
  async function render(g: Graph, id = 'n1') {
    dispatch({ kind: 'server', msg: { type: 'graphOpened', changes: [], graph: g, runs: [], variableValues: {} } });
    dispatch({ kind: 'selectNode', id });
    vi.mocked(send).mockClear();
    const el = document.createElement('div');
    const root = createRoot(el);
    await act(async () => root.render(createElement(NodePanel)));
    const save = () => [...el.querySelectorAll('button')].find((b) => b.textContent === 'Save') as HTMLButtonElement;
    return { el, root, save };
  }

  it('puts the Access select after Kind and the Workspace field after it, and saves Read-only in the draft', async () => {
    const { el, root, save } = await render(graph);
    expect([...el.querySelectorAll('.field label')].map((l) => l.textContent).slice(0, 5)).toEqual(['Title', 'Description', 'Kind', 'Access', 'Workspace']);
    const access = el.querySelector('select#node-access') as HTMLSelectElement;
    expect([...access.options].map((o) => o.textContent)).toEqual(['Can edit files', 'Read-only']);
    expect(access.value).toBe('write');
    await act(async () => change(access, 'read'));
    expect(save().disabled).toBe(false);
    await act(async () => save().click());
    expect(send).toHaveBeenCalledWith({ type: 'op', graphId: 'g', op: { type: 'updateNode', id: 'n1', patch: { access: 'read' } } });
    await act(async () => root.unmount());
  });

  it('says command steps can change files instead of offering the select', async () => {
    const commandGraph: Graph = { ...graph, nodes: [{ id: 'n1', title: 'Build', kind: 'command', command: 'make', createdBy: 'user', updatedBy: 'user', updatedAt: 't' }] };
    const { el, root } = await render(commandGraph);
    expect(el.querySelector('select#node-access')).toBeNull();
    expect(el.querySelector('.static-note')?.textContent).toBe('Command steps can change files');
    await act(async () => root.unmount());
  });

  it("edits the workspace in the draft, suggests the graph's workspace names, and clears it with an empty value", async () => {
    const g: Graph = { ...graph, nodes: [{ ...step, workspace: 'wh_small' }, { ...step, id: 'n2', workspace: 'wh_large' }, { ...step, id: 'n3' }] };
    const { el, root, save } = await render(g);
    const field = el.querySelector('input#node-workspace') as HTMLInputElement;
    expect(field.value).toBe('wh_small');
    expect(field.placeholder).toBe('This checkout');
    expect(field.getAttribute('list')).toBe('workspace-names');
    expect([...el.querySelectorAll('datalist#workspace-names option')].map((o) => (o as HTMLOptionElement).value)).toEqual(['wh_large', 'wh_small']);
    await act(async () => change(field, ''));
    await act(async () => save().click());
    expect(send).toHaveBeenCalledWith({ type: 'op', graphId: 'g', op: { type: 'updateNode', id: 'n1', patch: { workspace: '' } } });
    await act(async () => root.unmount());
  });
});
```

Append to `web/test/StepNode.test.ts` (add `import { WORKSPACE_COLORS, workspaceColor } from '../src/workspaceColor';`):

```ts
describe('StepNode access and workspace badges', () => {
  it('shows a read-only badge on read-only steps only', async () => {
    const reader = await renderCardEl({ ...node, kind: 'agent', command: undefined, prompt: 'p', access: 'read' });
    expect(reader.container.querySelector('.read-badge')?.textContent).toBe('read-only');
    await reader.done();
    const plain = await renderCardEl(node);
    expect(plain.container.querySelector('.read-badge')).toBeNull();
    await plain.done();
  });

  it('shows the workspace as a ⎇ badge, in one colour for every step that shares it', async () => {
    const a = await renderCardEl({ ...node, workspace: 'wh_small' });
    const b = await renderCardEl({ ...node, id: 'n3', workspace: 'wh_small' });
    const badge = a.container.querySelector('.ws-badge')!;
    expect(badge.textContent).toBe('⎇ wh_small');
    expect(badge.className).toBe(`ws-badge ws-color-${workspaceColor('wh_small')}`);
    expect(b.container.querySelector('.ws-badge')!.className).toBe(badge.className);
    await a.done();
    await b.done();
    const none = await renderCardEl(node);
    expect(none.container.querySelector('.ws-badge')).toBeNull();
    await none.done();
  });
});

describe('workspaceColor', () => {
  it('picks one of the chart colours by a hash of the name, the same every time', () => {
    for (const name of ['a', 'wh_small', 'wh_large', 'variant-6']) {
      expect(workspaceColor(name)).toBe(workspaceColor(name));
      expect(workspaceColor(name)).toBeGreaterThanOrEqual(0);
      expect(workspaceColor(name)).toBeLessThan(WORKSPACE_COLORS);
    }
    expect(new Set(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map(workspaceColor)).size).toBeGreaterThan(1);
  });
});
```

Append to `web/test/LogsPanel.test.ts`, inside `describe('LogsPanel', …)`:

```ts
  it('shows the workspace a step ran in, from the run record', async () => {
    const inWorkspace = { ...graph.nodes[1], workspace: 'wh_small' };
    await act(async () => server({ type: 'run', run: { ...run, snapshot: { ...run.snapshot, nodes: [inWorkspace] }, workspaces: { wh_small: { path: '/wt/wh_small', head: 'a1b2c3d4' } } } }));
    await act(async () => dispatch({ kind: 'selectNode', id: 'n2' }));
    expect(container.querySelector('.logs-head .logs-workspace')?.textContent).toBe('workspace wh_small · /wt/wh_small');
    await act(async () => server({ type: 'run', run }));
    expect(container.querySelector('.logs-workspace')).toBeNull();
  });

  it('says what a waiting run waits for', async () => {
    await act(async () => server({ type: 'run', run: { ...run, status: 'running', waitingFor: { runId: '20261003-090000-aaaa', graphId: 'billing', folder: '/p' } } }));
    await act(async () => dispatch({ kind: 'selectNode', id: 'n2' }));
    expect(container.querySelector('.logs-head .logs-waiting')?.textContent).toBe('Waiting for run 20261003-090000-aaaa ("billing") to finish changing files');
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w web -- NodePanel StepNode LogsPanel`
Expected: FAIL. There are no Access or Workspace fields, no badges, no `workspaceColor` module, and no workspace or waiting line in the logs.

- [ ] **Step 3: Implement `web/src/workspaceColor.ts`**

```ts
/** How many theme chart colours workspace badges cycle through (styles.css: .ws-color-0 … .ws-color-5). */
export const WORKSPACE_COLORS = 6;

/** Steps that share a workspace share a badge colour: a hash of the name picks it (spec §7). */
export function workspaceColor(name: string): number {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  return h % WORKSPACE_COLORS;
}
```

- [ ] **Step 4: Implement the Node panel fields**

In `web/src/components/NodePanel.tsx`:
- Change `Draft` and `toDraft`:

```tsx
type Draft = { title: string; description: string; kind: NodeKind; access: 'read' | 'write'; workspace: string; prompt: string; command: string; timeoutSec: string };

const toDraft = (n: GraphNode): Draft => ({
  title: n.title,
  description: n.description ?? '',
  kind: n.kind,
  access: n.access === 'read' ? 'read' : 'write',
  workspace: n.workspace ?? '',
  prompt: n.prompt ?? '',
  command: n.command ?? '',
  timeoutSec: n.timeoutSec ? String(n.timeoutSec) : '',
});
```

- In `NodePanel`, compute `const workspaces = [...new Set(graph.nodes.flatMap((n) => (n.workspace ? [n.workspace] : [])))].sort();` after the `if (!graph || !node) return …` line, and render `<NodeEditor key={node.id} graphId={graph.id} node={node} workspaces={workspaces} />`.
- Change the `NodeEditor` signature to `function NodeEditor({ graphId, node, workspaces }: { graphId: string; node: GraphNode; workspaces: string[] })`.
- In `save`, after the `kind` line, add:

```tsx
    if (draft.access !== base.draft.access && draft.kind === 'agent') patch.access = draft.access;
    if (draft.workspace !== base.draft.workspace) patch.workspace = draft.workspace.trim();
```

- Right after the Kind `<div className="field">…</div>`, add:

```tsx
      {draft.kind === 'agent' ? (
        <div className="field">
          <label htmlFor="node-access">Access</label>
          <select id="node-access" value={draft.access} onChange={(e) => setDraft({ ...draft, access: e.target.value as Draft['access'] })}>
            <option value="write">Can edit files</option>
            <option value="read">Read-only</option>
          </select>
        </div>
      ) : (
        <div className="field">
          <label>Access</label>
          <p className="static-note">Command steps can change files</p>
        </div>
      )}
      <div className="field">
        <label htmlFor="node-workspace">Workspace</label>
        <input id="node-workspace" list="workspace-names" value={draft.workspace} placeholder="This checkout" onChange={(e) => setDraft({ ...draft, workspace: e.target.value })} />
        <datalist id="workspace-names">
          {workspaces.map((w) => (
            <option key={w} value={w} />
          ))}
        </datalist>
      </div>
```

- [ ] **Step 5: Implement the badges and the logs header**

In `web/src/components/StepNode.tsx`, add `import { workspaceColor } from '../workspaceColor';`. In the `step-meta` div, right after `<span>{node.id}</span>`, add:

```tsx
        {node.access === 'read' && <span className="read-badge">read-only</span>}
        {node.workspace && (
          <span className={`ws-badge ws-color-${workspaceColor(node.workspace)}`} title={`Runs in workspace ${node.workspace}`}>
            ⎇ {node.workspace}
          </span>
        )}
```

In `web/src/components/LogsPanel.tsx`:
- Change the shared import to `import { PROVIDER_NAMES, fmtDuration, statusLabel, waitingText } from '@agent-stream/shared';`.
- Add `const graphs = useStore((s) => s.graphs);` after the existing `useStore` calls at the top.
- After the line `const changedBy = …`, add:

```tsx
  // The step as it ran: its workspace and that run's worktree (spec §7).
  const ranAs = run?.snapshot.nodes.find((n) => n.id === node.id);
  const place = ranAs?.workspace ? run?.workspaces?.[ranAs.workspace] : undefined;
  const waitingFor = run?.waitingFor;
```

- Inside `<header className="logs-head">`, after the closing `</span>` of the title span, add:

```tsx
        {ranAs?.workspace && place && (
          <span className="logs-workspace">
            workspace {ranAs.workspace} · {place.path}
          </span>
        )}
        {waitingFor && <span className="logs-waiting">{waitingText(waitingFor, graphs.find((g) => g.id === waitingFor.graphId)?.name ?? waitingFor.graphId)}</span>}
```

- [ ] **Step 6: Style it**

Append to `web/src/styles.css`:

```css
.static-note { margin: 0; color: var(--muted); }
.read-badge { padding: 0 4px; border: 1px solid var(--border); border-radius: 8px; color: var(--muted); }
.ws-badge { padding: 0 4px; border: 1px solid var(--ws); border-radius: 8px; color: var(--ws); }
.ws-color-0 { --ws: var(--vscode-charts-blue, #1d5fa8); }
.ws-color-1 { --ws: var(--vscode-charts-green, #2e7d32); }
.ws-color-2 { --ws: var(--vscode-charts-orange, #b26a00); }
.ws-color-3 { --ws: var(--vscode-charts-purple, #8957e5); }
.ws-color-4 { --ws: var(--vscode-charts-red, #b42318); }
.ws-color-5 { --ws: var(--vscode-charts-yellow, #8a6d00); }
.logs-workspace, .logs-waiting { margin-left: 8px; color: var(--muted); }
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npm test -w web && npm run typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add web/src web/test
git commit -m "feat(web): Access and Workspace fields, read-only and workspace badges, logs workspace line

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 16: Integration, READMEs and the full verification

**Files:**
- Modify: `extension/test/integration/suite.cjs:52-63` (the checkout check and the command registrations)
- Modify: `README.md`, `extension/README.md` (a new section after "## Use", the `agentStream.maxParallel` line, "## Files it writes")

**Interfaces:**
- Consumes: everything above. Produces documentation and the integration check (ruling R17).

- [ ] **Step 1: Add the integration check**

In `extension/test/integration/suite.cjs`, right after `await waitFor(() => reopened.isLoaded, 'the reopened tab to load its graph');`, add:

```js
  // Where the graph works (spec §7): the tab's engine sends the checkout after hello and on request. The sample
  // workspace is a temp folder outside Git, and nothing here creates a worktree.
  const where = [];
  const whereClient = { send: (m) => where.push(m) };
  const detachWhere = app.connect(whereClient);
  const firstCheckout = await waitFor(() => where.find((m) => m.type === 'checkout'), 'the checkout message');
  assert.equal(firstCheckout.info.git, false);
  assert.equal(firstCheckout.info.root, fs.realpathSync(wf.uri.fsPath));
  await app.handle(whereClient, { type: 'inspectCheckout' });
  assert.equal(where.filter((m) => m.type === 'checkout').length, 2);
  detachWhere();
  const registered = await vscode.commands.getCommands(true);
  for (const id of ['agentStream.setUpParallelTickets', 'agentStream.newAbTestGraph', 'agentStream.manageRunWorkspaces']) assert.ok(registered.includes(id), `${id} is registered`);
```

- [ ] **Step 2: Document it in both READMEs**

Make the same edits to `README.md` and `extension/README.md`.

(a) In "## Settings", change the `agentStream.maxParallel` line to:

```markdown
- `agentStream.maxParallel` — how many steps of a run may run at once (default 3). Steps that can change files still take turns within each workspace.
```

(b) Insert this section right before "## Settings":

````markdown
## Parallel tickets and A/B tests

Agents that can change files never work on separate tickets in the same checkout. Agent Stream follows this policy, and gives it to the planner word for word:

> Before starting or planning concurrent write-capable work, determine whether tasks are separate tickets. If they are, require one Git worktree per ticket. Never run write-capable agents for separate tickets in the same repository checkout. If worktrees cannot be verified or created, offer sequential execution only.

Within one graph, the same rule applies to alternatives: parallel write-capable steps need separate workspaces.

The engine enforces this; it doesn't rely on the planner alone:

- **Read-only steps.** Mark an agent step **Read-only** (Node panel › Access). It can only read files (Read, Glob, Grep): every other tool is refused without asking, and it can't change the graph. Command steps can always change files. Read-only steps show a `read-only` badge.
- **One writer per workspace.** Within a run, only one step that can change files runs at a time in each workspace (this checkout, or a variant workspace). Read-only steps, and steps in other workspaces, fill the other `agentStream.maxParallel` slots. The run dialog notes which steps will take turns.
- **One run per checkout.** A run whose steps change files in this checkout holds the checkout's write lease until it ends. This works across VS Code windows, through a lock file in `~/.agent-stream/locks/`. The checkout is the Git top-level folder (the folder itself outside Git), so a repository and its subfolder share one lease. A second such run is refused, and the dialog offers two ways on:
  - **Set Up Parallel Tickets** (Git checkouts only).
  - **Run after it finishes**: starts the run now, runs its read-only steps, and holds its other steps until the first run has ended.
- **Where it works.** The graph tab's top bar shows the branch (`⎇ main`, or `⎇ detached <sha>`), and `· worktree <folder>` in a linked worktree. Its tooltip shows the root, the HEAD commit and the other worktrees. Every run records where it ran (the run picker's tooltip), and the run dialog shows the Checkout line.

### Separate tickets: Set Up Parallel Tickets

Recommended workflow:

1. Commit your changes. Modified or staged tracked files block setup; untracked files stay in this checkout.
2. Run **Agent Stream: Set Up Parallel Tickets** (or the branch button in the Graphs view). Enter:
   - the base (the current branch by default);
   - one ticket per box (leave the last one empty to finish);
   - where the worktrees go (next to the repo by default);
   - the command for the full test suite and typecheck (prefilled from `package.json`).
3. Agent Stream checks everything first, and creates nothing if anything is wrong. Then, for each ticket and all from the same base commit, it creates:
   - a worktree at `<parent>/<repo>-<ticket-slug>`;
   - a new branch `feat/<ticket-slug>`;
   - a starter graph: **Read and research** (read-only) → **Implementation** → **Focused tests** → **Full test + typecheck**, with **Review** (read-only).

   It never overwrites a branch or a folder.
4. Open each worktree in its own VS Code window (the summary's **Open in New VS Code Window…** button) and run its graph there. Each worktree has its own graphs, runs, sessions and variable values; only the check command is seeded.
5. Land one ticket at a time. Even in separate worktrees, changes to `shared/` code, database migrations, package manifests and lockfiles, and contracts between workspaces should normally be serialized: land one ticket, then rebase the others onto it, instead of changing those files in several tickets at once.

The planner follows the same rules. It calls `check_tickets` before planning work for several tickets, and suggests Set Up Parallel Tickets when a ticket has no worktree.

### A/B tests in one graph: variant workspaces

- **Variant workspaces.** A step's **Workspace** (Node panel) puts it in a variant workspace. Steps with the same workspace name share one temporary, detached Git worktree per run. The runner creates it from the run's start commit, in `~/.agent-stream/worktrees/`. Steps in different workspaces run in parallel; a read-only compare step then reads every variant's results. Steps with a workspace show a `⎇ <name>` badge, one colour per workspace.
- **Uncommitted changes aren't copied.** Variant worktrees start from the last commit, and the run dialog says so when this checkout has changes.
- **No reuse.** A step with a workspace always runs again on a re-run, in that run's own worktree.
- **New A/B Test Graph.** **Agent Stream: New A/B Test Graph** asks for a name and 2–6 variant names (for example `wh_small`, `wh_large`). It creates:
  - a read-only plan step;
  - for each variant, a **Set up** and a **Run** step in that variant's workspace;
  - a read-only **Compare and recommend** step.
- **Manage Run Workspaces.** Variant worktrees are kept after the run, whether it succeeded, failed or was stopped. **Agent Stream: Manage Run Workspaces** lists them (`· missing`, `· has changes`) and offers:
  - **Open in New VS Code Window**;
  - **Create Branch Here** (`ab/<run id>-<name>`, keeping its changes);
  - **Remove**, which asks first when there are uncommitted changes.

  Nothing is removed any other way.

Recommended workflow:

1. Run **New A/B Test Graph** and name the variants.
2. In **Variables**, set:
   - `setup_command`, for example `dbt deps`;
   - one `run_<variant>` per variant, for example `dbt build --target wh_small`. A `-` in a variant name becomes `_`.
3. Run the graph. The variants run side by side, each in its own worktree.
4. Read the compare step's recommendation.
5. Keep the winner with **Manage Run Workspaces › Create Branch Here**, and remove the rest.

### dbt and other shared resources

- Worktrees separate files only. Give every variant its own external resources: for dbt, a separate target and schema per variant, so variants never build the same tables. Measure fairly:
  - turn off result caches (for Snowflake, `ALTER SESSION SET USE_CACHED_RESULT = FALSE` via a pre-hook or session parameter);
  - start each variant's warehouse suspended, so local caches are cold;
  - tag each variant's queries (`query_tag`), and read cost and runtime from the warehouse's query and metering history;
  - repeat short runs, because minimum billing per resume skews them.

  Compare runtime, cost and failures per variant, and say how confident the result is.
- A new worktree has no untracked files: no `.venv`, `dbt_packages`, `target` or `node_modules`, and no uncommitted `profiles.yml`. Make `setup_command` prepare them (for example `dbt deps`). Profiles in `~/.dbt/` are shared by every worktree.
- The compare step is read-only, so it can't query the warehouse itself. To read the warehouse's history, add a command step, or mark the compare step **Can edit files** so each command asks for your approval.

### Limitations

- Agent Stream doesn't isolate databases, warehouses, schemas, cloud resources or ports. The guidance above covers them; the engine can't check it.
- It doesn't detect tickets from free text. The planner's `check_tickets` and your choice decide what a ticket is.
- Command steps always count as changing files. There is no file-level locking.
- Agent Stream never removes, merges or prunes ticket worktrees or branches. Use `git worktree remove` and `git branch -d` when a ticket is done. Variant workspaces are removed only through Manage Run Workspaces.
- The lease only coordinates Agent Stream runs; it doesn't stop your own edits or other tools.
  - A lock whose process has gone is reclaimed.
  - A lock file that can't be read blocks runs until you delete it, and the message names the file.
  - Process-id reuse isn't detected beyond the liveness check.
- Waiting runs in one window take the lease in the order they started. A run waiting on another window checks again every 3 seconds.
````

(c) In "## Files it writes", after the line about variable values, add:

```markdown
Two more folders in your home folder: `~/.agent-stream/locks/` holds one lock file per checkout while a run is changing files there, and `~/.agent-stream/worktrees/<checkout hash>/<run id>/<name>/` holds the variant workspaces runs create (kept until you remove them with Manage Run Workspaces).
```

- [ ] **Step 3: Run the full verification from the repo root**

Run each command and read its output before going on:

```bash
npm test
npm run typecheck
npm run build
npm run test:integration -w extension
```

Expected: every workspace's unit tests pass, the typecheck is clean, and the web UI and extension bundle build. The integration suite passes, prints `Skipping the agent-step check (set AGENT_STREAM_LIVE=1)`, and passes the new checkout assertions. Run it without `AGENT_STREAM_LIVE`, and do NOT run `npm run package`.

If the integration run fails only because VS Code can't be downloaded (no network), say so plainly; don't claim it passed.

- [ ] **Step 4: Commit**

```bash
git add extension/test/integration/suite.cjs README.md extension/README.md
git commit -m "docs: parallel tickets, variant workspaces and their limits; integration check for the checkout

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Self-review (done while writing this plan)

**1. Spec coverage.** Each spec section maps to a task:

| Spec | Task |
|---|---|
| §1 policy and alternatives sentence | 10 (planner), 11 (starter graph), 16 (README) |
| §1 success: blocked second run with both offers | 5, 8, 14 |
| §1 success: one writer per workspace within a run | 5, 6 |
| §1 success: New A/B Test Graph | 11, 13 |
| §1 success: Set Up Parallel Tickets | 9, 11, 12 |
| §1 success: branch and worktree shown; runs record where they ran | 2, 8, 14 |
| §2 decisions | the tasks named in each row below |
| §3.1 access: type, parse, edit ops, export/import, duplicate, signature, reuse, helpers | 1 |
| §3.1a workspace: name rule, edit ops, export, signature | 1 |
| §3.2 `CheckoutInfo`, `RunMeta.checkout/workspaces/waitingFor` | 2 |
| §4.1 git abstraction | 3 |
| §4.2 leases (one per host, lock file, stale, unreadable, owner release, dispose) | 4, 5 |
| §4.3 runner (needs-lease rule, blocked, sequential, retries, order, per-workspace pump, release, amendments) | 5, 6 (R7) |
| §4.3a variant workspaces (path, creation before start, failure cleanup, dirty note, cwd, prompt line, heading, no reuse, kept, isolation guidance) | 6, 8, 11, 16 |
| §4.4 read-only gate, no graph tools, prompt line | 7 |
| §4.5 app (`startRun.sequential`, `RunMeta.checkout`, `runBlocked`, `inspectCheckout`, checkout messages) | 8 |
| §4.6 planner (append, tools, `checkout_info`, `check_tickets`) | 10 |
| §4.7 preview notes | 8 |
| §5.1 worktrees | 9 |
| §5.2 starter graph and seeding | 11 |
| §5.3 wizard, `Ui`, manifest, host message | 12 |
| §5.4 A/B template and wizard | 11, 13 |
| §5.5 Manage Run Workspaces | 13 |
| §6 serialization guidance | 10, 11, 16 |
| §7 UI | 14, 15 |
| §8 error table | 3 (Git missing), 4 (unreadable or stale lock), 5 (cancelled while waiting, dispose), 6/8 (workspace creation failure, outside Git), 9/12 (partial creation, failed checks), 13 (deleted by hand → prune) |
| §9 tests | named in each task's Step 1 |
| §10 out of scope | nothing implemented, stated in the README's Limitations |

**2. Placeholder scan.** Every code step contains its code. No step says "add tests", "handle errors" or "similar to Task N" without the code itself.

**3. Type consistency.** Names used in more than one task are spelled the same everywhere:
- Tasks 2/4/5/8: `LeaseHolder`, `LeaseResult.lockFile`, `RunBlocked`.
- Tasks 2/5/8/14/15: `WaitingFor`.
- Tasks 3/6/8/9/12/13: `GitExec`.
- Tasks 6/8/13: `createVariantWorkspaces`, `removeWorkspace`, `pruneWorkspaces`.
- Tasks 8/10: `CheckoutSource`.
- Tasks 9/12: `WorktreeFs`, `ParallelFs`.
- Tasks 13/16: `RunWorkspaceItem`.
- Tasks 2/12/13: `PickItem`.
- Task 5: `Runner.newRunId`, `Runner.dispose`.
- Tasks 3/5/12: `fakeGit` (engine and extension copies), `appTestDeps`, `engineTestDeps`, `testLeases`, `noGit`.

**4. Review Focus.** Each of the five has a test in its owning task: 1 in Tasks 3 and 5, 2–4 in Task 6, and 5 in Task 5.
