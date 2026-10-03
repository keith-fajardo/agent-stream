# Agent Stream — Providers, Work Sessions and Chat View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Agent Stream provider-agnostic: Claude moves behind a provider interface, and GitHub Copilot becomes a selectable scaffold. Then add personal work sessions (graph tabs + their own planner chats) and move the planner chat into its own Copilot-style view.

**Architecture:**
- **Providers and gate.** Each provider owns its agent loop behind `AgentProvider` (status, step, planner turn). Approvals and privacy run through a provider-neutral `ToolGate`.
- **Engine.** The engine stays VS Code-free. Claude lives in `engine/src/providers/claude/`, and the Copilot scaffold lives in the extension (it needs `vscode.lm`).
- **Sessions.** They are per-folder files in `.agent-stream/sessions/<id>/`, git-ignored, holding the tab set, the per-graph planner state and the chats.
- **Chat view.** A webview view in the secondary side bar follows the active graph tab and that folder's active session.

**Tech Stack:** TypeScript 7 (noEmit), npm workspaces (`shared`, `engine`, `web`, `extension`), Vitest 5, zod 4, React 19 + @xyflow/react 12, Vite 8, esbuild, `@anthropic-ai/claude-agent-sdk`, VS Code extension API (`vscode.lm`, `window.tabGroups`, `WebviewViewProvider`).

**Specs:** `docs/superpowers/specs/2026-10-03-agent-stream-providers-design.md` and `docs/superpowers/specs/2026-10-03-agent-stream-sessions-chat-design.md`. The sessions spec §8 amends the provider spec's planner-state section.

**Order:** Providers first (Tasks 1–4), then sessions and the chat view (Tasks 5–9), then the integration test (Task 10) and the docs (Task 11). Tasks 5 and 6 are split so that the planner never runs half-migrated: Task 5 builds the session store and migration without wiring them in, and Task 6 wires them in.

**Planning rulings** (decided while writing this plan; each costs a small rework if wrong):
- **P1. The VS Code floor rises from `^1.100.0` to `^1.106.0`.** Extensions can contribute a view container to the secondary side bar (`viewsContainers.secondarySidebar`) only from 1.106 (October 2025); it was a proposed API in 1.104. The spec allowed this ("where supported"). VS Code is at 1.140 today. Cost if wrong: users on VS Code older than about a year can't install.
- **P2. `ProviderStatus` gains `preview?: boolean`.** It means "available but can't run yet", so the status bar can show `$(beaker)` without string-matching labels. It isn't named in the spec.
- **P3. Claude's failures all keep the status-bar label `not signed in`.** This matches today's `$(warning) Agent Stream: not signed in`. The reason stays in `error`.
- **P4. The per-run provider is captured through `StartRunInput.agent`/`provider`.** It is not looked up later by run ID, so a run's steps can never race a provider swap.
- **P5. Between Tasks 6 and 7, the graph tab's in-tab chat subscribes with session `default`.** Task 7 removes it. This keeps every task's suite green.
- **P6. The chat view's session picker is a header button that runs `agentStream.switchSession`.** That command is a VS Code quick pick that includes "New Session…". This is the spec's "session picker" without a second picker UI.

## Global Constraints

- The engine (`engine/`) and `shared/` never import `vscode`. Only `extension/` does.
- No new runtime dependencies. The `.vsix` stays universal: `npm run package` and `check-vsix.mjs` pass, with no `node_modules`, native or per-platform files.
- **Claude behaviour is unchanged.** It has to match today's code in five things:
  - env stripping (`sanitizedEnv`);
  - the `apiKeySource` refusal (`authSourceError`), `UNVERIFIED_AUTH` and `projectSettingsProblem` messages, verbatim;
  - the gate order: privacy first, then read-only tools pass, then the user's approval;
  - `APPROVAL_HOOK_TIMEOUT_SEC`;
  - `'Approved by the user in Agent Stream.'`.
- Every existing test keeps its assertions. A test that moves only gets its imports and setup updated.
- Exact user-facing strings, used verbatim:
  - `COPILOT_NOT_IMPLEMENTED` = `Copilot support isn't implemented yet. Switch to Claude with Agent Stream: Select Provider.`
  - `COPILOT_UNAVAILABLE` = `GitHub Copilot isn't available. Install the GitHub Copilot extension and sign in, or switch to Claude with Agent Stream: Select Provider.`
  - Copilot preview detail: `` `Models: ${names}. Running steps with Copilot isn't implemented yet.` `` (`names` comma-separated)
  - Unknown provider: `` `Unknown agentStream.provider '${value}'; using Claude.` ``
  - Planner provider switch note: `` `Started a new planner conversation with ${providerName}; it doesn't see earlier messages.` ``
  - Session delete confirmation: `` `Delete ${name}? Its planner chats are removed; graphs and runs stay.` ``
  - Unsaved-edits prompt: `` `Discard unsaved step edits in ${n} ${n === 1 ? 'tab' : 'tabs'}?` ``
  - Skipped graphs: `` `${n} ${n === 1 ? 'graph' : 'graphs'} in this session no longer ${n === 1 ? 'exists' : 'exist'} and ${n === 1 ? 'was' : 'were'} skipped.` ``
  - New chat confirmation: `` `Start a new conversation? This clears the planner chat for ${graphName} in ${sessionName}.` ``
  - Empty chat view: `Open a graph to chat with the planner.`
  - Session status bar: `` `$(layers) ${sessionName}` ``
- `.agent-stream/.gitignore` lists `runs/` and `sessions/`. Graph files carry no planner state after Task 6. The export format is unchanged.
- Tests never touch the real home folder. They use `mkdtemp` folders, as `tmpValuesFile()`/`tmpProject()` already do.
- The repo is PUBLIC, so commit no personal paths, emails or machine details.
- Run every command from the repo root (`/Users/keithfajardo/Desktop/local/personal/agent-stream`). Work on branch `feat/providers-sessions`.
- Commits end with the implementer's own `Co-Authored-By` line, taken from its system reminder.

## Review Focus

These are five failure modes the specs imply but that no task's main tests would naturally exercise, most likely first. Each is pinned by a test in the task that owns the code.

1. **The provider switches mid-run.** The run's remaining agent steps must still use the provider it started with, and the next run uses the new one. Pinned in Task 3: `app.test.ts` › "a run keeps the provider it started with".
2. **Switching sessions while a graph tab has a half-typed step edit.** Answering "no" must leave every tab and the active session untouched. Pinned in Task 8: `sessions.test.ts` › "a declined unsaved-edits prompt changes nothing".
3. **Two folders both have a session called `default`.** Switching in folder A must not close folder B's graph tabs. Pinned in Task 8: `sessions.test.ts` › "switching only touches its folder's graph tabs".
4. **A migration interrupted halfway, then run again.** The chat was moved but the graph rewrite didn't happen. A second run must finish the job without duplicating or losing chat lines. Pinned in Task 5: `sessionStore.test.ts` › "migration resumes after a partial run".
5. **The chat view's graph is deleted or its tab closes.** The view falls back to the empty state and never sends a chat for a deleted graph. Pinned in Task 9: `chatView.test.ts` › "falls back to empty when its graph goes away".

## File map

| File | Responsibility | Task |
|---|---|---|
| `shared/src/types.ts` | `ProviderId`, `ProviderStatus`, run `provider`, session and chat protocol types | 1, 6, 7 |
| `shared/src/format.ts` | `providerLabel` (replaces `authLabel`) | 1 |
| `shared/src/schemas.ts` | webview message schemas (chat, sessions, draftState, chat view) | 6, 7 |
| `engine/src/providers/types.ts` | `AgentProvider`, `GraphTool`, `PlannerTurn`, `PlannerTurnResult` | 3 |
| `engine/src/providers/toolGate.ts` | provider-neutral `ToolGate`, `createStepGate`, `createPlannerGate` | 2 |
| `engine/src/providers/claude/sdkGate.ts` | `ToolGate` → SDK hooks and `canUseTool` | 2 |
| `engine/src/providers/claude/{auth,sdk,runStep,planTurn,index}.ts` | the Claude provider (moved from `auth.ts`, `sdk.ts`, `agentExecutor.ts`, the planner query) | 3 |
| `engine/src/plannerTools.ts` | graph tools as neutral `GraphTool[]` | 3 |
| `engine/src/planner.ts` | neutral planner (Task 3); keyed by session and graph (Task 6) | 3, 6 |
| `engine/src/runner.ts` | per-run `agent` executor and `provider` | 3 |
| `engine/src/app.ts` | provider wiring (Task 3); sessions and chat subscriptions (Task 6) | 1, 3, 6 |
| `engine/src/sessionStore.ts` | sessions on disk, legacy migration | 5 |
| `engine/src/chatLog.ts` | a chat log for a folder of chat files | 5 |
| `engine/src/paths.ts` | `sessionsDir`, `isSessionId`, `.gitignore` `sessions/` | 5 |
| `extension/src/providers/copilot.ts` | Copilot scaffold (`vscode.lm`) | 4 |
| `extension/src/providers/registry.ts` | provider factory and setting parsing | 4 |
| `extension/src/engines.ts` | provider selection, status checks, swaps | 1, 3, 4 |
| `extension/src/statusBar.ts` | provider status text; session text | 1, 8 |
| `extension/src/selectProvider.ts` | "Agent Stream: Select Provider" | 4 |
| `extension/src/sessions.ts` | active session, tab tracking, switching | 8 |
| `extension/src/sessionsView.ts` | Sessions tree | 8 |
| `extension/src/chatView.ts` | chat `WebviewViewProvider` following the active graph | 9 |
| `web/src/main.tsx`, `web/src/ChatApp.tsx`, `web/src/chatBridge.ts` | chat view mode | 7 |
| `web/src/components/RightPanel.tsx`, `NodePanel.tsx`, `menuModel.ts` | Node · Graph only, `draftState`, View › Chat | 7 |
| `extension/test/integration/suite.cjs`, `extension/scripts/screenshots.mjs` | real VS Code checks, screenshots | 10 |
| `README.md`, `extension/README.md`, `docs/windows-checklist.md`, `extension/package.json` `description` | provider-agnostic docs | 11 |

---

### Task 1: Provider status replaces Claude-only `AuthInfo`

**Files:**
- Modify: `shared/src/types.ts`, `shared/src/format.ts`, `shared/test/format.test.ts`
- Modify: `engine/src/auth.ts`, `engine/src/app.ts`, `engine/test/auth.test.ts`, `engine/test/app.test.ts`
- Modify: `extension/src/engines.ts`, `extension/src/statusBar.ts`, `extension/src/extension.ts`, `extension/src/graphsView.ts`, and the extension tests that build an App or a status (`statusBar.test.ts`, `engines.test.ts`, `graphsView.test.ts`, `graphEditor.test.ts`, `commands.test.ts`, `runCommands.test.ts`)
- Modify: `web/src/state.ts`, `web/src/App.tsx`, `web/src/components/ChatPanel.tsx`, `web/test/state.test.ts`

**Interfaces:**
- Produces (in `@agent-stream/shared`):
  ```ts
  export type ProviderId = 'claude' | 'copilot';
  export const PROVIDER_IDS: readonly ProviderId[] = ['claude', 'copilot'];
  /** Display names, for places that only have a ProviderId (run records). */
  export const PROVIDER_NAMES: Record<ProviderId, string> = { claude: 'Claude', copilot: 'GitHub Copilot' };
  export type ProviderStatus = {
    provider: ProviderId;
    /** Runs and planner chat are allowed. */
    ok: boolean;
    /** Status-bar text: "Claude Max", "not signed in", "Copilot (preview)", "Copilot not available". */
    label: string;
    /** Tooltip detail: the account, or the models VS Code reports. */
    detail?: string;
    /** Why runs and chat are refused, shown verbatim. */
    error?: string;
    /** Available but not runnable yet (the Copilot scaffold). */
    preview?: boolean;
  };
  export function providerLabel(status: ProviderStatus): string; // format.ts
  ```
  - `ServerMessage`: `{ type: 'auth'; status: ProviderStatus }` and `hello` carries `status: ProviderStatus` (it was `auth`).
  - `RunMeta` gains `provider?: ProviderId`. It is written in Task 3.
  - `AuthInfo` and `authLabel` are deleted.
- Produces (engine): `checkAuth(claudePath, run?) : Promise<ProviderStatus>`. `AppDeps.status: ProviderStatus` replaces `auth`. `app.setAuth(status: ProviderStatus, claudePath?: string)` keeps its name until Task 3.
- Produces (extension): `CHECKING: ProviderStatus`, `EngineManager.status`, which replaces `.auth`, and `EngineManager.folderStatus(folder)`, which replaces `folderAuth`. `EngineEvents.auth(status: ProviderStatus)` keeps its name.

- [ ] **Step 1: Write the failing shared test** (replace the `authLabel` tests in `shared/test/format.test.ts`)

```ts
import { providerLabel } from '../src/format';

describe('providerLabel', () => {
  it('names the provider and plan when it can run', () => {
    expect(providerLabel({ provider: 'claude', ok: true, label: 'Claude Max', detail: 'me@example.com' })).toBe('Claude Max · me@example.com');
    expect(providerLabel({ provider: 'claude', ok: true, label: 'Claude Pro' })).toBe('Claude Pro');
  });
  it('gives the reason when it cannot', () => {
    expect(providerLabel({ provider: 'claude', ok: false, label: 'not signed in', error: 'Not signed in to Claude Code.' })).toBe('⚠ Not signed in to Claude Code.');
    expect(providerLabel({ provider: 'copilot', ok: false, label: 'Copilot not available' })).toBe('⚠ Copilot not available');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -w shared -- format`
Expected: FAIL. `providerLabel` is not exported.

- [ ] **Step 3: Implement the shared types and label**

In `shared/src/types.ts`, delete `AuthInfo` and add `ProviderId`, `PROVIDER_IDS` and `ProviderStatus` exactly as in **Interfaces**. Change the two message variants:

```ts
  | { type: 'auth'; status: ProviderStatus }
  | { type: 'hello'; status: ProviderStatus; project: string; graphs: GraphListItem[]; approvals: ApprovalRequest[] }
```

Then add the run's provider to `RunMeta`, after `rendered?`:

```ts
  /** Which provider ran this run's agent steps (absent for runs made before providers). */
  provider?: ProviderId;
```

In `shared/src/format.ts`, replace `authLabel` with:

```ts
export function providerLabel(status: ProviderStatus): string {
  if (!status.ok) return `⚠ ${status.error ?? status.label}`;
  return status.detail ? `${status.label} · ${status.detail}` : status.label;
}
```

Update its import to `ProviderStatus` instead of `AuthInfo`. `PROVIDER_IDS` is a value export: make sure `shared/src/index.ts` re-exports it (it re-exports `types.ts` with `export *`; check that it does).

- [ ] **Step 4: Run the shared tests**

Run: `npm test -w shared`
Expected: PASS.

- [ ] **Step 5: Write the failing engine test** (update `engine/test/auth.test.ts`)

`checkAuth` now returns a `ProviderStatus`. Rewrite each expected object in `auth.test.ts` by this mapping, keeping every case:
- `{ ok: true, method: 'claude.ai', plan: 'max', email: 'a@b.c' }` becomes `{ provider: 'claude', ok: true, label: 'Claude Max', detail: 'a@b.c' }`.
- A missing plan gives the label `'Claude subscription'`.
- Every failure becomes `{ provider: 'claude', ok: false, label: 'not signed in', error: <the same error text as today> }`.
  - The failures with `info` today (wrong `apiProvider`, wrong `authMethod`) also keep `detail: email` when there is one.

Add this case:

```ts
it('labels a missing plan as a subscription', async () => {
  const run = async () => JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'a@b.c' });
  expect(await checkAuth('claude', run)).toEqual({ provider: 'claude', ok: true, label: 'Claude subscription', detail: 'a@b.c' });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `npm test -w engine -- auth`
Expected: FAIL, because the old shape is still returned.

- [ ] **Step 7: Implement `checkAuth`**

In `engine/src/auth.ts`, change the return type to `Promise<ProviderStatus>` and build the result like this:

```ts
const fail = (error: string, detail?: string): ProviderStatus =>
  detail ? { provider: 'claude', ok: false, label: 'not signed in', detail, error } : { provider: 'claude', ok: false, label: 'not signed in', error };
```

- Use `fail(...)` with today's exact messages in every failure branch.
- The success branch:

```ts
const plan = info.plan ? info.plan.charAt(0).toUpperCase() + info.plan.slice(1) : 'subscription';
return info.email ? { provider: 'claude', ok: true, label: `Claude ${plan}`, detail: info.email } : { provider: 'claude', ok: true, label: `Claude ${plan}` };
```

- [ ] **Step 8: Rename the App's dependency**

In `engine/src/app.ts`:
- `AppDeps.auth: AuthInfo` becomes `status: ProviderStatus`. Rename `let auth = d.auth` to `let status = d.status`.
- `setAuth(next: ProviderStatus, nextClaudePath?: string)` assigns `status` and broadcasts `{ type: 'auth', status }`.
- `connect` sends `{ type: 'hello', status, … }`.
- The refusals use `status.ok`/`status.error` with today's wording: `Chat is disabled: …`, `Runs are disabled: …`.

In `engine/test/app.test.ts`:
- `const signedIn: ProviderStatus = { provider: 'claude', ok: true, label: 'Claude Max' }`.
- Every `auth: …` in a `createApp` call becomes `status: …`.
- Every "not signed in" fixture becomes `{ provider: 'claude', ok: false, label: 'not signed in', error: <same text> }`.
- Assertions on `hello.auth` read `hello.status`.

- [ ] **Step 9: Update the extension**

`extension/src/engines.ts`:

```ts
export const CHECKING: ProviderStatus = { provider: 'claude', ok: false, label: 'checking', error: 'Checking your Claude sign-in…' };
```

- `auth: AuthInfo` becomes `status: ProviderStatus`.
- `folderAuth` becomes `folderStatus(folder): ProviderStatus`, returning `problem ? { ...this.status, ok: false, error: problem } : this.status`.
- A missing Claude CLI produces `{ provider: 'claude', ok: false, label: 'not signed in', error: found.error }`.
- `createApp` is called with `status: this.folderStatus(folder)`.
- `checkSignIn`/`runCheck` keep their logic and the stale-check guard, with the types renamed.

`extension/src/statusBar.ts` (whole file):

```ts
import type { ProviderStatus } from '@agent-stream/shared';
import { CHECKING } from './engines';

export function statusBarText(status: ProviderStatus): { text: string; tooltip: string } {
  if (status === CHECKING) return { text: '$(sync~spin) Agent Stream', tooltip: status.error ?? '' };
  if (status.ok) return { text: `$(check) ${status.label}`, tooltip: `Agent Stream runs on ${status.label}${status.detail ? ` (${status.detail})` : ''}.` };
  if (status.preview) return { text: `$(beaker) ${status.label}`, tooltip: status.detail ?? status.error ?? status.label };
  return { text: `$(warning) Agent Stream: ${status.label}`, tooltip: status.error ?? status.label };
}
```

In `extension/test/statusBar.test.ts`, set the expectations to:

```ts
it('shows the provider and plan when it can run', () => {
  expect(statusBarText({ provider: 'claude', ok: true, label: 'Claude Max', detail: 'me@example.com' })).toEqual({
    text: '$(check) Claude Max',
    tooltip: 'Agent Stream runs on Claude Max (me@example.com).',
  });
});
it('warns otherwise, with the reason in the tooltip', () => {
  expect(statusBarText({ provider: 'claude', ok: false, label: 'not signed in', error: 'Not signed in to Claude Code.' })).toEqual({
    text: '$(warning) Agent Stream: not signed in',
    tooltip: 'Not signed in to Claude Code.',
  });
});
it('marks a preview provider', () => {
  expect(statusBarText({ provider: 'copilot', ok: false, preview: true, label: 'Copilot (preview)', detail: 'Models: GPT-5.', error: 'x' })).toEqual({
    text: '$(beaker) Copilot (preview)',
    tooltip: 'Models: GPT-5.',
  });
});
it('shows the check in progress', () => {
  expect(statusBarText(CHECKING).text).toBe('$(sync~spin) Agent Stream');
});
```

- `extension/src/extension.ts`: use `ProviderStatus` and `providerLabel`, and read `manager.status` (it was `manager.auth`). The `signInDetails` message becomes `` `Agent Stream runs on ${providerLabel(status)}.` ``.
- `extension/src/graphsView.ts`: `GraphsSource.auth(): AuthInfo` becomes `status(): ProviderStatus`, with the same `ok || === CHECKING` logic.
- Every other extension test that builds an App: `auth:` becomes `status:` with a `ProviderStatus` value. Every `manager.auth` becomes `manager.status`.

- [ ] **Step 10: Update the web**

`web/src/state.ts`:
- `auth?: AuthInfo` becomes `status?: ProviderStatus`.
- `hello` sets `status: msg.status`.
- `auth` sets `status: msg.status`.

`web/src/App.tsx`: the banner reads `status && !status.ok && status.error`.

`web/src/components/ChatPanel.tsx`:
- `const status = useStore((s) => s.status)`;
- `canType = !!graph && !!status?.ok`;
- the disabled placeholder is `status?.error ?? 'Chat is unavailable.'`.

Rename every other read of `s.auth` in `web/src` to `s.status`. That includes `menuModel.ts` (`const signedIn = !!s.status?.ok`) and any component using `useStore((s) => s.auth)`; find them with `git grep -n "s\.auth\|auth?" -- web/src`. In `web/test/state.test.ts` and any other web test that builds a `hello`/`auth` message, update the fixtures and assertions to `status`.

- [ ] **Step 11: Verify everything**

Run: `npm test && npm run typecheck`
Expected: every suite PASSES, and typecheck is clean. `git grep -n "AuthInfo\|authLabel"` (excluding `docs/`) finds nothing.

- [ ] **Step 12: Commit**

```bash
git add shared engine extension web
git commit -m "refactor: provider status replaces the Claude-only AuthInfo"
```

---

### Task 2: Provider-neutral tool gate, with Claude's SDK adapter

**Files:**
- Create: `engine/src/providers/toolGate.ts`, `engine/src/providers/claude/sdkGate.ts`, `engine/test/toolGate.test.ts`
- Move: `engine/test/gate.test.ts` → `engine/test/sdkGate.test.ts`
- Delete: `engine/src/gate.ts`
- Modify: `engine/src/agentExecutor.ts`, `engine/src/planner.ts`, the imports in `engine/test/agentExecutor.test.ts`

**Interfaces:**
- Produces (`engine/src/providers/toolGate.ts`):
  ```ts
  export const READ_ONLY_TOOLS: ReadonlySet<string>;          // moved from gate.ts: Read, Glob, Grep
  export const APPROVAL_HOOK_TIMEOUT_SEC: number;             // moved: 24 * 60 * 60
  export type ToolDecision = { allow: true; by: 'readOnly' | 'user' | 'graphTool' } | { allow: false; reason: string };
  export interface ToolGate {
    /** Sync privacy check: why this call may never touch its path, or null. */
    privacy(toolName: string, input: unknown): string | null;
    isReadOnly(toolName: string): boolean;
    /** Steps: ask the user. Planner: allow graph tools, refuse anything else. Never throws. */
    approve(toolName: string, input: unknown, signal?: AbortSignal): Promise<ToolDecision>;
    /** privacy → read-only → approve. What a provider without its own permission system calls. */
    decide(toolName: string, input: unknown, signal?: AbortSignal): Promise<ToolDecision>;
  }
  export type StepGateOptions = { broker: ApprovalBroker; runId: string; graphId: string; nodeId: string; nodeTitle: string; projectDir: string; privateFiles: readonly string[]; signal: AbortSignal; emit: (event: NodeEventBody) => void };
  export function createStepGate(o: StepGateOptions): ToolGate;
  export function createPlannerGate(o: { projectDir: string; privateFiles: readonly string[]; graphToolNames: ReadonlySet<string> }): ToolGate;
  ```
- Produces (`engine/src/providers/claude/sdkGate.ts`): `export type ApprovalGate = { hooks: { PreToolUse: HookCallbackMatcher[] }; canUseTool: CanUseTool }` and `export function toSdkGate(gate: ToolGate): ApprovalGate`.

- [ ] **Step 1: Write the failing test** — `engine/test/toolGate.test.ts`

```ts
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ApprovalBroker } from '../src/approvals';
import { createPlannerGate, createStepGate } from '../src/providers/toolGate';

const VALUES = resolve('/', 'home', 'me', '.agent-stream', 'values', '0123456789abcdef.json');
const PROJECT = resolve('/', 'work', 'proj');

function stepGate(signal = new AbortController().signal) {
  const broker = new ApprovalBroker(() => 't');
  const emit = vi.fn();
  const gate = createStepGate({ broker, runId: 'r', graphId: 'g', nodeId: 'n1', nodeTitle: 'Step', projectDir: PROJECT, privateFiles: [VALUES], signal, emit });
  return { broker, emit, gate };
}

describe('step gate', () => {
  it('refuses private files before anything else', async () => {
    const { gate, broker } = stepGate();
    expect(gate.privacy('Read', { file_path: VALUES })).toMatch(/private to this machine/);
    expect(await gate.decide('Read', { file_path: VALUES })).toEqual({ allow: false, reason: expect.stringMatching(/private to this machine/) });
    expect(broker.pending()).toEqual([]);
  });

  it('lets read-only tools through without asking', async () => {
    const { gate, broker } = stepGate();
    expect(gate.isReadOnly('Grep')).toBe(true);
    expect(await gate.decide('Grep', { pattern: 'x', path: join(PROJECT, 'src') })).toEqual({ allow: true, by: 'readOnly' });
    expect(broker.pending()).toEqual([]);
  });

  it('asks the user for everything else and reports both events', async () => {
    const { gate, broker, emit } = stepGate();
    const decision = gate.decide('Bash', { command: 'ls' });
    const [request] = broker.pending();
    expect(request).toMatchObject({ runId: 'r', graphId: 'g', nodeId: 'n1', nodeTitle: 'Step', toolName: 'Bash' });
    broker.decide(request.id, { decision: 'approve' });
    expect(await decision).toEqual({ allow: true, by: 'user' });
    expect(emit.mock.calls.map((c) => c[0].type)).toEqual(['approval_requested', 'approval_decided']);
  });

  it('turns a denial note into the reason', async () => {
    const { gate, broker } = stepGate();
    const decision = gate.decide('Edit', { file_path: 'a' });
    broker.decide(broker.pending()[0].id, { decision: 'deny', note: 'not now' });
    expect(await decision).toEqual({ allow: false, reason: 'Denied by the user: not now' });
  });

  it('says the run was stopped when its signal aborts', async () => {
    const run = new AbortController();
    const { gate } = stepGate(run.signal);
    const decision = gate.decide('Bash', { command: 'ls' });
    run.abort();
    expect(await decision).toEqual({ allow: false, reason: 'The run was stopped.' });
  });
});

describe('planner gate', () => {
  const gate = createPlannerGate({ projectDir: PROJECT, privateFiles: [VALUES], graphToolNames: new Set(['add_node']) });
  it('allows read-only and graph tools, refuses the rest, and keeps privacy first', async () => {
    expect(await gate.decide('Glob', { pattern: '*' })).toEqual({ allow: true, by: 'readOnly' });
    expect(await gate.decide('add_node', { kind: 'agent', title: 't' })).toEqual({ allow: true, by: 'graphTool' });
    expect(await gate.decide('Bash', { command: 'ls' })).toEqual({ allow: false, reason: 'The planner can only read files and edit the graph.' });
    expect(await gate.decide('Grep', { pattern: 'x', path: '/' })).toMatchObject({ allow: false });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -w engine -- toolGate`
Expected: FAIL. The module `../src/providers/toolGate` is not found.

- [ ] **Step 3: Implement `engine/src/providers/toolGate.ts`**

Move `READ_ONLY_TOOLS`, `APPROVAL_HOOK_TIMEOUT_SEC`, `denialReason` and the `ask` helper from `gate.ts` unchanged. Then:

```ts
import type { Decision, NodeEventBody } from '@agent-stream/shared';
import type { ApprovalBroker } from '../approvals';
import { privatePathDenial } from '../privatePaths';

export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set(['Read', 'Glob', 'Grep']);
/** Approvals wait for the user indefinitely; a day is the practical upper bound. */
export const APPROVAL_HOOK_TIMEOUT_SEC = 24 * 60 * 60;

export type ToolDecision = { allow: true; by: 'readOnly' | 'user' | 'graphTool' } | { allow: false; reason: string };

export interface ToolGate {
  privacy(toolName: string, input: unknown): string | null;
  isReadOnly(toolName: string): boolean;
  approve(toolName: string, input: unknown, signal?: AbortSignal): Promise<ToolDecision>;
  decide(toolName: string, input: unknown, signal?: AbortSignal): Promise<ToolDecision>;
}

export type StepGateOptions = {
  broker: ApprovalBroker;
  runId: string;
  graphId: string;
  nodeId: string;
  nodeTitle: string;
  projectDir: string;
  /** Files no agent may read, wherever they are (the variable values files). */
  privateFiles: readonly string[];
  signal: AbortSignal;
  emit: (event: NodeEventBody) => void;
};

function denialReason(d: Decision, runStopped = false): string {
  if (d.decision === 'cancelled' && runStopped) return 'The run was stopped.';
  if (d.decision === 'cancelled') return 'The approval request expired or was withdrawn.';
  if (d.decision === 'deny' && d.note) return `Denied by the user: ${d.note}`;
  return 'Denied by the user.';
}

function withDecide(base: Omit<ToolGate, 'decide'>): ToolGate {
  return {
    ...base,
    async decide(toolName, input, signal) {
      const reason = base.privacy(toolName, input);
      if (reason) return { allow: false, reason };
      if (base.isReadOnly(toolName)) return { allow: true, by: 'readOnly' };
      return base.approve(toolName, input, signal);
    },
  };
}

/** "Ask for everything" for one agent step (spec §7.4): privacy first, read-only tools pass, the rest waits for the user. */
export function createStepGate(o: StepGateOptions): ToolGate {
  async function ask(toolName: string, input: unknown, extra?: AbortSignal): Promise<Decision> {
    // Body moved verbatim from gate.ts `ask` (deadline timer, combined signal, broker.request,
    // approval_requested / approval_decided events, cancel-on-emit-failure).
  }
  return withDecide({
    privacy: (toolName, input) => privatePathDenial(o.projectDir, toolName, input, o.privateFiles),
    isReadOnly: (toolName) => READ_ONLY_TOOLS.has(toolName),
    async approve(toolName, input, signal) {
      try {
        const d = await ask(toolName, input, signal);
        return d.decision === 'approve' ? { allow: true, by: 'user' } : { allow: false, reason: denialReason(d, o.signal.aborted) };
      } catch (error) {
        return { allow: false, reason: `Agent Stream could not ask for approval: ${error instanceof Error ? error.message : String(error)}` };
      }
    },
  });
}

/** The planner reads files and edits the graph through its tools; it never asks the user for anything. */
export function createPlannerGate(o: { projectDir: string; privateFiles: readonly string[]; graphToolNames: ReadonlySet<string> }): ToolGate {
  return withDecide({
    privacy: (toolName, input) => privatePathDenial(o.projectDir, toolName, input, o.privateFiles),
    isReadOnly: (toolName) => READ_ONLY_TOOLS.has(toolName),
    async approve(toolName) {
      return o.graphToolNames.has(toolName) ? { allow: true, by: 'graphTool' } : { allow: false, reason: 'The planner can only read files and edit the graph.' };
    },
  });
}
```

Fill in `ask` by copying the body of `gate.ts`'s `ask` exactly, with `o` as `StepGateOptions` and `extra` as its third parameter (`sdkSignal`).

- [ ] **Step 4: Implement `engine/src/providers/claude/sdkGate.ts`**

`toSdkGate` reproduces today's `makeApprovalGate` SDK behaviour on top of a `ToolGate`:

```ts
import type { CanUseTool, HookCallbackMatcher, HookInput, HookJSONOutput } from '@anthropic-ai/claude-agent-sdk';
import { APPROVAL_HOOK_TIMEOUT_SEC, type ToolGate } from '../toolGate';

export type ApprovalGate = { hooks: { PreToolUse: HookCallbackMatcher[] }; canUseTool: CanUseTool };

/** PreToolUse hooks run before the SDK's permission rules, so settings allow rules can't skip the user; canUseTool is the backstop. */
export function toSdkGate(gate: ToolGate): ApprovalGate {
  const approvedToolUseIds = new Set<string>();
  const deny = (reason: string): HookJSONOutput => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });

  async function preToolUse(input: HookInput, _id: string | undefined, options: { signal: AbortSignal }): Promise<HookJSONOutput> {
    if (input.hook_event_name !== 'PreToolUse') return {};
    const reason = gate.privacy(input.tool_name, input.tool_input);
    if (reason) return deny(reason);
    if (gate.isReadOnly(input.tool_name)) return {};
    const d = await gate.approve(input.tool_name, input.tool_input, options.signal);
    if (!d.allow) return deny(d.reason);
    approvedToolUseIds.add(input.tool_use_id);
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: 'Approved by the user in Agent Stream.' } };
  }

  const canUseTool: CanUseTool = async (toolName, input, options) => {
    if (approvedToolUseIds.has(options.toolUseID)) return { behavior: 'allow', updatedInput: input };
    const d = await gate.approve(toolName, input, options.signal);
    return d.allow ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: d.reason };
  };

  return { hooks: { PreToolUse: [{ hooks: [preToolUse as any], timeout: APPROVAL_HOOK_TIMEOUT_SEC }] }, canUseTool };
}
```

`approve` never throws, so the old try/catch around each callback moves into `createStepGate.approve`. A hook that throws is no longer possible. The text `Agent Stream could not ask for approval: …` is unchanged.

- [ ] **Step 5: Switch the callers and move the test**

- `engine/src/agentExecutor.ts`: replace `makeApprovalGate({...})` with `toSdkGate(createStepGate({...same fields...}))`. Import `READ_ONLY_TOOLS` from `./providers/toolGate`.
- `engine/src/planner.ts`: the PreToolUse hook body becomes:
  ```ts
  const reason = plannerGate.privacy(input.tool_name, input.tool_input);
  return reason ? { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } } : {};
  ```
  Here `plannerGate = createPlannerGate({ projectDir, privateFiles, graphToolNames: new Set() })`.
- `git mv engine/test/gate.test.ts engine/test/sdkGate.test.ts`. Rewrite its setup to `toSdkGate(createStepGate(options))` wherever it called `makeApprovalGate(options)`. Every assertion stays.
- Delete `engine/src/gate.ts`. `git grep -n "from './gate'\|from '../src/gate'"` must find nothing.

- [ ] **Step 6: Verify**

Run: `npm test -w engine && npm run typecheck`
Expected: PASS. `toolGate` and `sdkGate` are both green, and so are `agentExecutor` and `planner` with no assertion changed.

- [ ] **Step 7: Commit**

```bash
git add engine
git commit -m "refactor(engine): provider-neutral tool gate with a Claude SDK adapter"
```

---

### Task 3: The Claude provider, a neutral planner, and the App wired to a provider

**Files:**
- Create: `engine/src/providers/types.ts`, `engine/src/providers/claude/index.ts`, `engine/src/providers/claude/runStep.ts`, `engine/src/providers/claude/planTurn.ts`
- Move: `engine/src/auth.ts` → `engine/src/providers/claude/auth.ts`; `engine/src/sdk.ts` → `engine/src/providers/claude/sdk.ts`; `engine/src/agentExecutor.ts` → `engine/src/providers/claude/runStep.ts`
- Move the tests: `engine/test/auth.test.ts` → `engine/test/claudeAuth.test.ts`; `engine/test/agentExecutor.test.ts` → `engine/test/claudeRunStep.test.ts`
- Create: `engine/test/claudePlanTurn.test.ts`, which takes today's SDK-level planner tests
- Modify: `engine/src/plannerTools.ts`, `engine/src/planner.ts`, `engine/src/runner.ts`, `engine/src/runStore.ts`, `engine/src/app.ts`, `engine/src/index.ts`, `shared/src/types.ts` (`RunSummary.provider`), `engine/test/planner.test.ts`, `engine/test/plannerTools.test.ts`, `engine/test/app.test.ts`, `engine/test/runner.test.ts`, `engine/test/runStore.test.ts`, `engine/test/live.test.ts`, `engine/test/helpers.ts`
- Modify: `extension/src/engines.ts`, plus the extension tests that build an App

**Interfaces:**
- Consumes: `ToolGate`, `createStepGate`, `createPlannerGate` (Task 2); `ProviderStatus`, `ProviderId` (Task 1).
- Produces (`engine/src/providers/types.ts`):
  ```ts
  import type { ZodRawShape } from 'zod';
  import type { ProviderId, ProviderStatus } from '@agent-stream/shared';
  import type { NodeContext, NodeOutcome } from '../executors';
  import type { ToolGate } from './toolGate';

  export type ToolReply = { text: string; isError?: boolean };
  /** A graph-editing tool the planner may call, defined once for every provider. */
  export type GraphTool = { name: string; description: string; schema: ZodRawShape; run(input: unknown): Promise<ToolReply> };
  export type PlannerEvent = { type: 'text'; text: string } | { type: 'tool'; name: string; input: unknown };
  export type PlannerTurn = {
    prompt: string;
    systemAppend: string;
    cwd: string;
    tools: GraphTool[];
    /** The provider's own conversation id to continue, when it belongs to this provider. */
    resume?: string;
    gate: ToolGate;
    signal: AbortSignal;
    onEvent(e: PlannerEvent): void;
  };
  /** ok: the turn ran (save the session and cursor; `error` is a model-reported failure to show). !ok: nothing ran. */
  export type PlannerTurnResult = { ok: true; sessionId?: string; error?: string } | { ok: false; error: string; resumeFailed?: boolean };

  export interface AgentProvider {
    readonly id: ProviderId;
    readonly name: string;
    status(): Promise<ProviderStatus>;
    folderProblem?(projectDir: string): string | undefined;
    runStep(ctx: NodeContext, gate: ToolGate): Promise<NodeOutcome>;
    planTurn(turn: PlannerTurn): Promise<PlannerTurnResult>;
  }
  ```
- Produces (`engine/src/providers/claude/index.ts`): `createClaudeProvider(d: { findClaude: () => Found; checkAuth?: (path: string) => Promise<ProviderStatus>; queryFn?: QueryFn; env?: NodeJS.ProcessEnv }): AgentProvider`, which is exported from the engine index.
- Produces (App):
  - `AppDeps.provider: AgentProvider` and `AppDeps.status: ProviderStatus`. `claudePath`, `queryFn` and `auth` are gone.
  - `app.setProvider(provider: AgentProvider, status: ProviderStatus): void` replaces `setAuth`.
  - `app.provider(): AgentProvider` and `app.status(): ProviderStatus` are readable.
- Produces (Runner): `StartRunInput` gains `agent?: NodeExecutor; provider?: ProviderId`. `RunMeta.provider` is set from it.
- Produces (planner):
  - `graphTools(d: PlannerToolDeps): GraphTool[]` has no SDK import.
  - `PlannerDeps` drops `claudePath`/`queryFn`/`env`/`valuesFile`/`legacyValuesFile` and adds `provider: () => AgentProvider` and `privateFiles: () => string[]`.
  - `PLANNER_APPEND` uses provider-neutral wording.

- [ ] **Step 1: Move the Claude files**

```bash
mkdir -p engine/src/providers/claude
git mv engine/src/auth.ts engine/src/providers/claude/auth.ts
git mv engine/src/sdk.ts engine/src/providers/claude/sdk.ts
git mv engine/src/agentExecutor.ts engine/src/providers/claude/runStep.ts
git mv engine/test/auth.test.ts engine/test/claudeAuth.test.ts
git mv engine/test/agentExecutor.test.ts engine/test/claudeRunStep.test.ts
```

Fix the relative imports in the moved files (`../../approvals`, `../../executors`, `../toolGate`, `./sdk`, `./auth`) and in their tests (`../src/providers/claude/...`). `projectSettingsProblem` stays in `auth.ts`. Run `npm run typecheck`: it should fail only in `app.ts`, `planner.ts`, `index.ts` and the extension, which the next steps fix.

- [ ] **Step 2: Write the failing provider tests**

**`claudeRunStep.test.ts`.** Its tests call `createAgentExecutor(deps)(ctx)` today. Change the setup to:

```ts
const provider = createClaudeProvider({ findClaude: () => ({ ok: true, path: '/usr/local/bin/claude' }), checkAuth: async () => signedIn, queryFn, env });
await provider.status(); // records the CLI path, as the extension does on sign-in
const run = (ctx: NodeContext) => provider.runStep(ctx, createStepGate({ broker, runId: ctx.runId, graphId: ctx.graph.id, nodeId: ctx.node.id, nodeTitle: ctx.node.title, projectDir: ctx.cwd, privateFiles: [VALUES_FILE], signal: ctx.signal, emit: ctx.emit }));
```

Every assertion stays, including `pathToClaudeCodeExecutable`, env stripping, `allowedTools`, `disallowedTools`, `settingSources` and the `apiKeySource` refusal. Add:

```ts
it('refuses to run before the CLI has been found', async () => {
  const p = createClaudeProvider({ findClaude: () => ({ ok: false, error: 'Claude Code not found.' }), queryFn });
  expect(await p.runStep(ctx(), gateFor(ctx()))).toEqual({ ok: false, output: '', error: 'Claude Code not found.' });
  expect(calls).toHaveLength(0);
});
it('reports status through the CLI it found', async () => {
  const p = createClaudeProvider({ findClaude: () => ({ ok: true, path: '/c' }), checkAuth: async (path) => ({ provider: 'claude', ok: path === '/c', label: 'Claude Max' }) });
  expect(await p.status()).toEqual({ provider: 'claude', ok: true, label: 'Claude Max' });
  expect(p.id).toBe('claude');
  expect(p.name).toBe('Claude');
});
it('names a folder whose .claude/settings.json reroutes Claude', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cs-'));
  mkdirSync(join(dir, '.claude'));
  writeFileSync(join(dir, '.claude', 'settings.json'), JSON.stringify({ apiKeyHelper: 'x' }));
  expect(createClaudeProvider({ findClaude: () => ({ ok: true, path: '/c' }) }).folderProblem?.(dir)).toMatch(/apiKeyHelper/);
});
```

**`claudePlanTurn.test.ts`.** Move every test from `planner.test.ts` that inspects SDK `options` or SDK message handling. That covers tools, allowedTools, mcp server, systemPrompt append, hooks, resume, the auth source, unverified auth and result errors. They now call `provider.planTurn(turn)` directly. Use a turn like:

```ts
const events: PlannerEvent[] = [];
const turn = (over: Partial<PlannerTurn> = {}): PlannerTurn => ({
  prompt: 'hi', systemAppend: PLANNER_APPEND, cwd: paths.root, tools: graphTools({ graphStore, runStore, graphId, requestRun: () => null }),
  gate: createPlannerGate({ projectDir: paths.root, privateFiles: [VALUES_FILE], graphToolNames: new Set(['add_node']) }),
  signal: new AbortController().signal, onEvent: (e) => events.push(e), ...over,
});
```

Map each old expectation like this:
- An SDK option check becomes the same check on `calls[0].options`.
- A chat entry `assistant: 'x'` becomes `{ type: 'text', text: 'x' }` in `events`.
- A tool chat line becomes `{ type: 'tool', name: 'add_node', input }`. The `mcp__graph__` prefix is stripped.
- A bad `apiKeySource` becomes a result `{ ok: false, error: authSourceError('ANTHROPIC_API_KEY') }`.
- A failed resume before init becomes a result `{ ok: false, error: <detail>, resumeFailed: true }`. Without `resume`, it is `{ ok: false, error: <detail> }` with no `resumeFailed`.
- A success without init becomes `{ ok: false, error: UNVERIFIED_AUTH }`.
- A result error after init becomes `{ ok: true, sessionId: 'sess-1', error: <text> }`.
- A normal turn becomes `{ ok: true, sessionId: 'sess-1' }`.

The PreToolUse hook check now asserts that the hook denies `Read` of `VALUES_FILE` (through `turn.gate.privacy`).

- [ ] **Step 3: Run them to verify they fail**

Run: `npm test -w engine -- claude`
Expected: FAIL. `createClaudeProvider` doesn't exist yet.

- [ ] **Step 4: Implement the Claude provider**

`engine/src/providers/claude/runStep.ts`: keep `translateMessage` and `usageOf` unchanged, and replace `createAgentExecutor` with:

```ts
export function claudeRunStep(deps: { claudePath: () => string | undefined; missing: () => string; queryFn: QueryFn; env?: NodeJS.ProcessEnv }) {
  return async (ctx: NodeContext, toolGate: ToolGate): Promise<NodeOutcome> => {
    const claudePath = deps.claudePath();
    if (!claudePath) return { ok: false, output: '', error: deps.missing() };
    // Re-checked per node: the project's settings can change while VS Code runs.
    const settingsProblem = projectSettingsProblem(ctx.cwd);
    if (settingsProblem) return { ok: false, output: '', error: settingsProblem };
    // …the rest of today's executor body unchanged, except:
    //   const gate = toSdkGate(toolGate);
    //   pathToClaudeCodeExecutable: claudePath,
  };
}
```

`engine/src/providers/claude/planTurn.ts`:

```ts
import { createSdkMcpServer, tool, type Options } from '@anthropic-ai/claude-agent-sdk';
import type { GraphTool, PlannerTurn, PlannerTurnResult } from '../types';
import { authSourceError, isSubscriptionAuthSource, sanitizedEnv, UNVERIFIED_AUTH } from './auth';
import { blocksOf, type QueryFn } from './sdk';

const GRAPH_PREFIX = 'mcp__graph__';

function graphServer(tools: GraphTool[]) {
  return createSdkMcpServer({
    name: 'graph',
    version: '1.0.0',
    tools: tools.map((t) =>
      tool(t.name, t.description, t.schema, async (args) => {
        const r = await t.run(args);
        return r.isError ? { content: [{ type: 'text' as const, text: r.text }], isError: true } : { content: [{ type: 'text' as const, text: r.text }] };
      }),
    ),
  });
}

export function claudePlanTurn(deps: { claudePath: () => string | undefined; missing: () => string; queryFn: QueryFn; env?: NodeJS.ProcessEnv }) {
  return async (turn: PlannerTurn): Promise<PlannerTurnResult> => {
    const claudePath = deps.claudePath();
    if (!claudePath) return { ok: false, error: deps.missing() };
    const abortController = new AbortController();
    const onAbort = () => abortController.abort();
    turn.signal.addEventListener('abort', onAbort, { once: true });
    const options: Options = {
      cwd: turn.cwd,
      pathToClaudeCodeExecutable: claudePath,
      env: sanitizedEnv(deps.env ?? process.env),
      tools: ['Read', 'Glob', 'Grep'],
      allowedTools: ['Read', 'Glob', 'Grep', `${GRAPH_PREFIX}*`],
      permissionMode: 'dontAsk',
      settingSources: ['project'],
      mcpServers: { graph: graphServer(turn.tools) },
      systemPrompt: { type: 'preset', preset: 'claude_code', append: turn.systemAppend },
      hooks: {
        PreToolUse: [
          {
            hooks: [
              async (input) => {
                if (input.hook_event_name !== 'PreToolUse') return {};
                const reason = turn.gate.privacy(input.tool_name, input.tool_input);
                return reason ? { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } } : {};
              },
            ],
          },
        ],
      },
      abortController,
    };
    if (turn.resume) options.resume = turn.resume;
    let sessionId: string | undefined;
    let sawInit = false;
    let error: string | undefined;
    try {
      for await (const message of deps.queryFn({ prompt: turn.prompt, options })) {
        const m = message as unknown as { type: string; subtype?: string; apiKeySource?: string; session_id?: string; parent_tool_use_id?: string | null; message?: unknown };
        if (m.session_id) sessionId = m.session_id;
        if (m.type === 'system' && m.subtype === 'init') {
          sawInit = true;
          if (m.apiKeySource !== undefined && !isSubscriptionAuthSource(m.apiKeySource)) {
            abortController.abort();
            return { ok: false, error: authSourceError(m.apiKeySource) };
          }
        }
        if (message.type === 'result' && !sawInit) {
          abortController.abort();
          if (message.subtype !== 'success' || message.is_error) {
            // Failed before it started (e.g. resuming a session that no longer exists): no model turn ran.
            const detail = (message.subtype !== 'success' ? message.errors.join('\n') : message.result) || message.subtype;
            return turn.resume ? { ok: false, error: detail, resumeFailed: true } : { ok: false, error: detail };
          }
          return { ok: false, error: UNVERIFIED_AUTH };
        }
        if (message.type === 'assistant' && !m.parent_tool_use_id) {
          for (const b of blocksOf(m.message)) {
            if (b.type === 'text' && b.text?.trim()) turn.onEvent({ type: 'text', text: b.text });
            else if (b.type === 'tool_use' && b.name?.startsWith(GRAPH_PREFIX)) turn.onEvent({ type: 'tool', name: b.name.slice(GRAPH_PREFIX.length), input: b.input });
          }
        }
        if (message.type === 'result') {
          if (message.subtype !== 'success') error = message.errors.join('\n') || message.subtype;
          else if (message.is_error) error = message.result || 'The planner reported an error.';
        }
      }
      return error ? { ok: true, sessionId, error } : { ok: true, sessionId };
    } finally {
      turn.signal.removeEventListener('abort', onAbort);
    }
  };
}
```

`engine/src/providers/claude/index.ts`:

```ts
import type { ProviderStatus } from '@agent-stream/shared';
import type { Found } from '../../platform';
import type { AgentProvider } from '../types';
import { checkAuth as realCheckAuth, projectSettingsProblem } from './auth';
import { claudePlanTurn } from './planTurn';
import { claudeRunStep } from './runStep';
import { realQuery, type QueryFn } from './sdk';

export type ClaudeProviderDeps = { findClaude: () => Found; checkAuth?: (claudePath: string) => Promise<ProviderStatus>; queryFn?: QueryFn; env?: NodeJS.ProcessEnv };

/** Claude Code on the user's Claude subscription (spec §3.4); every subscription rule stays here. */
export function createClaudeProvider(d: ClaudeProviderDeps): AgentProvider {
  let path: string | undefined;
  let missing = 'Agent Stream has not checked for Claude Code yet.';
  const shared = { claudePath: () => path, missing: () => missing, queryFn: d.queryFn ?? realQuery, env: d.env };
  return {
    id: 'claude',
    name: 'Claude',
    async status() {
      const found = d.findClaude();
      if (!found.ok) {
        path = undefined;
        missing = found.error;
        return { provider: 'claude', ok: false, label: 'not signed in', error: found.error };
      }
      path = found.path;
      return (d.checkAuth ?? realCheckAuth)(found.path);
    },
    folderProblem: (dir) => projectSettingsProblem(dir) ?? undefined,
    runStep: claudeRunStep(shared),
    planTurn: claudePlanTurn(shared),
  };
}
```

- [ ] **Step 5: Make the graph tools and the planner neutral**

`engine/src/plannerTools.ts`:
- Drop the SDK import.
- Add a local `tool` helper with the same call shape, so each tool body stays untouched:

```ts
import { z, type ZodRawShape } from 'zod';
import type { GraphTool, ToolReply } from './providers/types';

const reply = (text: string, isError = false): ToolReply => (isError ? { text, isError: true } : { text });

function tool<S extends ZodRawShape>(name: string, description: string, schema: S, handler: (args: z.infer<z.ZodObject<S>>) => Promise<ToolReply>): GraphTool {
  const parser = z.object(schema);
  return {
    name,
    description,
    schema,
    async run(input) {
      const parsed = parser.safeParse(input ?? {});
      return parsed.success ? handler(parsed.data) : reply(z.prettifyError(parsed.error), true);
    },
  };
}
```

- `graphTools(d)` returns `GraphTool[]`.
- Delete `createGraphMcpServer`.
- In the `add_node` description, change "runs a separate Claude agent" to "runs a separate AI agent".
- `engine/test/plannerTools.test.ts`: the `call` helper becomes `const r = await t.run(args); return { text: r.text, isError: r.isError === true };`. All assertions are unchanged.
- Add one test: `run` with a missing required field returns `isError: true` and doesn't touch the graph.

`engine/src/planner.ts`:
- `PLANNER_APPEND`: keep the instructions, and remove anything that says "Claude Code" or names the model's vendor. The graph tools and goal text stay.
- `describeToolCall` keeps stripping `mcp__graph__`. That's harmless once names arrive bare.
- `PlannerDeps` changes as described in **Interfaces**.
- `send` keeps its busy, `add`, preamble and cursor logic, and replaces the SDK block with:

```ts
const provider = this.d.provider();
const problem = provider.folderProblem?.(this.d.projectDir);
if (problem) {
  this.add(graphId, 'error', problem);
  return;
}
const graph = this.d.graphStore.get(graphId);
const ops = this.d.graphStore.readOps(graphId);
const cursor = ops.length;
const tools = graphTools({ graphStore: this.d.graphStore, runStore: this.d.runStore, graphId, requestRun: (fromNodeId) => this.d.requestRun(graphId, fromNodeId) });
const r = await provider.planTurn({
  prompt: userEditsPreamble(ops.slice(graph.plannerOpCursor ?? 0)) + text,
  systemAppend: PLANNER_APPEND,
  cwd: this.d.projectDir,
  tools,
  resume: graph.plannerSessionId,
  gate: createPlannerGate({ projectDir: this.d.projectDir, privateFiles: this.d.privateFiles(), graphToolNames: new Set(tools.map((t) => t.name)) }),
  signal: abortController.signal,
  onEvent: (e) => (e.type === 'text' ? this.add(graphId, 'assistant', e.text) : this.add(graphId, 'tool', describeToolCall(e.name, e.input))),
});
if (!r.ok) {
  if (r.resumeFailed) this.d.graphStore.setPlannerState(graphId, { plannerSessionId: undefined });
  this.add(graphId, 'error', r.resumeFailed ? `${r.error}${SESSION_RESET_NOTE}` : r.error);
  return;
}
if (r.error) this.add(graphId, 'error', r.error);
this.d.graphStore.setPlannerState(graphId, { plannerSessionId: r.sessionId ?? graph.plannerSessionId, plannerOpCursor: cursor });
```

The `catch` block (an exception means a stale session is cleared and the note is added) and the `finally` block stay as they are.

`engine/test/planner.test.ts` keeps only the neutral tests: busy, preamble, cursor, the chat log, the error paths, and `describeOp`. Use a fake provider:

```ts
function fakeProvider(turns: ((t: PlannerTurn) => Promise<PlannerTurnResult>)[]): AgentProvider & { seen: PlannerTurn[] } {
  const seen: PlannerTurn[] = [];
  return {
    id: 'claude', name: 'Claude', seen,
    status: async () => ({ provider: 'claude', ok: true, label: 'Claude Max' }),
    runStep: async () => ({ ok: true, output: '' }),
    planTurn: async (t) => { seen.push(t); return turns.shift()!(t); },
  };
}
```

Add these tests:
- the preamble lists only user edits since the cursor;
- a `{ ok: false, resumeFailed: true }` result clears `plannerSessionId` and the error ends with the reset note;
- a folder problem stops the turn before `planTurn`;
- `gate.privacy` denies the values file;
- an `ok` result with `error` saves the cursor and shows the error.

- [ ] **Step 6: Wire the runner and the App**

`engine/src/runner.ts`:
- `StartRunInput` gains `agent?: NodeExecutor; provider?: ProviderId`.
- `start` stores `input.agent` on the `ActiveRun` and puts `...(input.provider && { provider: input.provider })` into the new `RunMeta`.
- Where it picks the executor:
  ```ts
  const executor = node.kind === 'agent' ? (run.agent ?? this.deps.executors.agent) : this.deps.executors[node.kind];
  ```
- Add a runner test: a run started with `agent` uses it, not `deps.executors.agent`, and `meta.provider` is recorded.
- `RunSummary` (`shared/src/types.ts`) gains `provider?: ProviderId`. `runStore.list` copies it from the meta (`({ id, graphId: g, status, startedAt, endedAt, provider }) => ({ id, graphId: g, status, startedAt, endedAt, ...(provider && { provider }) })`). Add a `runStore.test.ts` case where a run with `provider: 'claude'` lists it, and one without lists no `provider` key.

`engine/src/app.ts`:
- `AppDeps` as described in **Interfaces**.
- `executors` keeps its test override.
- Then:

```ts
let provider = d.provider;
let status = d.status;
const privateFiles = () => [d.valuesFile, d.legacyValuesFile].filter((f): f is string => !!f);
const agentFor = (p: AgentProvider): NodeExecutor => (ctx) =>
  p.runStep(ctx, createStepGate({ broker, runId: ctx.runId, graphId: ctx.graph.id, nodeId: ctx.node.id, nodeTitle: ctx.node.title, projectDir: ctx.cwd, privateFiles: privateFiles(), signal: ctx.signal, emit: ctx.emit }));
const executors = d.executors ?? { agent: agentFor(provider), command: createCommandExecutor({ platform, gitBashPath: d.gitBash?.ok ? d.gitBash.path : undefined }) };
```

- In `startRun`, call:
  ```ts
  runner.start({ …, provider: provider.id, ...(d.executors ? {} : { agent: agentFor(provider) }) })
  ```
- The planner gets `provider: () => provider, privateFiles`.
- Replace `setAuth` with:

```ts
/** The provider or its status changed (settings, Check again): new runs and planner turns use it; running ones keep theirs. */
function setProvider(next: AgentProvider, nextStatus: ProviderStatus): void {
  provider = next;
  status = nextStatus;
  broadcast({ type: 'auth', status });
}
```

- Return `setProvider`, `provider: () => provider` and `status: () => status`.

`engine/src/index.ts`:
- Export `createClaudeProvider` and the types `AgentProvider`, `GraphTool`, `PlannerTurn`, `PlannerTurnResult` and `ToolGate`.
- Export `createStepGate` and `createPlannerGate`.
- Change the `checkAuth`/`projectSettingsProblem`/`sanitizedEnv` export path to `./providers/claude/auth`.

Add `engine/test/helpers.ts`:

```ts
export const signedIn: ProviderStatus = { provider: 'claude', ok: true, label: 'Claude Max' };
/** A provider whose steps and planner turns are given by the test. */
export function testProvider(over: Partial<AgentProvider> = {}): AgentProvider {
  return { id: 'claude', name: 'Claude', status: async () => signedIn, runStep: async () => ({ ok: true, output: '' }), planTurn: async () => ({ ok: true }), ...over };
}
```

In `engine/test/app.test.ts`, every `createApp({ … claudePath, auth, queryFn? })` becomes `createApp({ …, provider: testProvider(), status: signedIn })`. Where a test needs SDK-level behaviour, use `createClaudeProvider({ findClaude: () => ({ ok: true, path: 'claude' }), queryFn })` and call `await provider.status()` first. Add the Review Focus test:

```ts
it('a run keeps the provider it started with', async () => {
  const first = { gate: deferred<void>(), ran: [] as string[] };
  const a = testProvider({ id: 'claude', runStep: async (ctx) => { first.ran.push(`a:${ctx.node.id}`); await first.gate.promise; return { ok: true, output: '' }; } });
  const b = testProvider({ id: 'copilot', name: 'GitHub Copilot', runStep: async (ctx) => { first.ran.push(`b:${ctx.node.id}`); return { ok: true, output: '' }; } });
  // a graph with two agent steps n1 -> n2; start it on provider a, swap to b while n1 waits, then release
  // …start via previewRun + startRun (as other app tests do)…
  app.setProvider(b, { provider: 'copilot', ok: true, label: 'Copilot' });
  first.gate.resolve();
  const run = await finished(runId);
  expect(first.ran).toEqual(['a:n1', 'a:n2']);
  expect(run.provider).toBe('claude');
});
```

Use the existing app-test helpers for the graph, preview and start, and add a `deferred()` helper if there isn't one already. `engine/test/live.test.ts` builds its App with `createClaudeProvider({ findClaude: () => findClaude({ platform: process.platform, env: process.env, home: homedir() }) })`.

- [ ] **Step 7: Adapt the extension's EngineManager**

In `extension/src/engines.ts`, the manager owns one `AgentProvider`:

```ts
private provider: AgentProvider;
constructor(private d: EngineManagerDeps) {
  this.provider = createClaudeProvider({
    findClaude: () => (d.findClaude ?? realFindClaude)({ platform: d.platform, env: d.env, home: d.home, setting: d.settings().claudePath }),
    checkAuth: d.checkAuth,
  });
}
```

- `runCheck` calls `await this.provider.status()` (with the stale-check guard as today). It then calls `e.app.setProvider(this.provider, this.folderStatus(e.folder))` for every engine.
- `folderStatus` uses `this.provider.folderProblem?.(folder.path)`.
- `get(folder)` passes `provider: this.provider, status: this.folderStatus(folder)`.
- `EngineManagerDeps.createApp` stays the test seam.
- Extension tests that build an App pass `provider` and `status` (for example `createClaudeProvider({ findClaude: () => ({ ok: true, path: '/bin/claude' }) })` or a stub object).

- [ ] **Step 8: Verify**

Run: `npm test && npm run typecheck && npm run build -w extension`
Expected: PASS everywhere. `git grep -n "claude-agent-sdk" -- engine/src` lists only files under `engine/src/providers/claude/`.

- [ ] **Step 9: Commit**

```bash
git add engine extension
git commit -m "refactor(engine): Claude behind an AgentProvider; neutral planner and graph tools"
```

---

### Task 4: Provider setting, Copilot scaffold, Select Provider

**Files:**
- Create: `extension/src/providers/copilot.ts`, `extension/src/providers/registry.ts`, `extension/src/selectProvider.ts`
- Create the tests: `extension/test/copilot.test.ts`, `extension/test/providerRegistry.test.ts`, `extension/test/selectProvider.test.ts`
- Modify: `extension/src/settings.ts`, `extension/src/engines.ts`, `extension/src/statusBar.ts`, `extension/src/graphsView.ts`, `extension/src/extension.ts`, `extension/package.json`, `extension/test/vscode.ts`, `extension/test/engines.test.ts`, `extension/test/statusBar.test.ts`, `extension/test/settings.test.ts`
- Modify: `web/src/components/NodePanel.tsx`, `web/src/App.tsx`

**Interfaces:**
- Consumes: `AgentProvider`, `createClaudeProvider` (Task 3); `ProviderStatus`, `ProviderId`, `PROVIDER_IDS` (Task 1).
- Produces:
  - `COPILOT_NOT_IMPLEMENTED`, `COPILOT_UNAVAILABLE`, and `createCopilotProvider(lm?: LmApi): AgentProvider` (`extension/src/providers/copilot.ts`).
  - `parseProviderSetting(value: unknown): { id: ProviderId; warning?: string }` (`registry.ts`).
  - `Settings.provider: string`, the raw setting.
  - `EngineManager`:
    - `checkProvider(): Promise<ProviderStatus>`, which replaces `checkSignIn`;
    - `providerFor(id): AgentProvider`, cached per ID;
    - `currentProvider(): AgentProvider`;
    - `status`.
  - `checkingStatus(p)`, `isChecking(status)`. `CHECKING` is removed.
  - The `agentStream.selectProvider` command.

- [ ] **Step 1: Write the failing tests**

`extension/test/vscode.ts`: add the fakes below. Keep the existing exports.

```ts
export const lm = { selectChatModels: vi.fn() };
export enum ConfigurationTarget { Global = 1, Workspace = 2, WorkspaceFolder = 3 }
```

`extension/test/copilot.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { COPILOT_NOT_IMPLEMENTED, COPILOT_UNAVAILABLE, createCopilotProvider } from '../src/providers/copilot';

const lm = (impl: () => Promise<{ name: string }[]>) => ({ selectChatModels: vi.fn(impl) });

describe('Copilot provider (scaffold)', () => {
  it('is a preview when VS Code reports Copilot models', async () => {
    const p = createCopilotProvider(lm(async () => [{ name: 'GPT-5' }, { name: 'Claude Sonnet' }, { name: 'GPT-5' }]));
    expect(p.id).toBe('copilot');
    expect(p.name).toBe('GitHub Copilot');
    expect(await p.status()).toEqual({
      provider: 'copilot', ok: false, preview: true, label: 'Copilot (preview)',
      detail: "Models: GPT-5, Claude Sonnet. Running steps with Copilot isn't implemented yet.", error: COPILOT_NOT_IMPLEMENTED,
    });
  });
  it('is not available without models', async () => {
    expect(await createCopilotProvider(lm(async () => [])).status()).toEqual({ provider: 'copilot', ok: false, label: 'Copilot not available', error: COPILOT_UNAVAILABLE });
  });
  it('is not available when the API is missing or throws, with the reason', async () => {
    expect((await createCopilotProvider(undefined).status()).error).toBe(`${COPILOT_UNAVAILABLE} (This version of VS Code has no Language Model API.)`);
    expect((await createCopilotProvider(lm(async () => { throw new Error('no consent'); })).status()).error).toBe(`${COPILOT_UNAVAILABLE} (no consent)`);
  });
  it('refuses steps and planner turns, and never sends a model request', async () => {
    const api = lm(async () => [{ name: 'GPT-5' }]);
    const p = createCopilotProvider(api);
    expect(await p.runStep({} as never, {} as never)).toEqual({ ok: false, output: '', error: COPILOT_NOT_IMPLEMENTED });
    expect(await p.planTurn({} as never)).toEqual({ ok: false, error: COPILOT_NOT_IMPLEMENTED });
    expect(api.selectChatModels).not.toHaveBeenCalled();
  });
});
```

`extension/test/providerRegistry.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { parseProviderSetting } from '../src/providers/registry';

describe('parseProviderSetting', () => {
  it('accepts the known providers and defaults to Claude', () => {
    expect(parseProviderSetting('copilot')).toEqual({ id: 'copilot' });
    expect(parseProviderSetting('claude')).toEqual({ id: 'claude' });
    expect(parseProviderSetting(undefined)).toEqual({ id: 'claude' });
    expect(parseProviderSetting('')).toEqual({ id: 'claude' });
  });
  it('falls back to Claude with a warning for anything else', () => {
    expect(parseProviderSetting('gemini')).toEqual({ id: 'claude', warning: "Unknown agentStream.provider 'gemini'; using Claude." });
  });
});
```

`extension/test/selectProvider.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import type { ProviderStatus } from '@agent-stream/shared';
import { selectProvider } from '../src/selectProvider';

const claude = { id: 'claude' as const, name: 'Claude', status: async (): Promise<ProviderStatus> => ({ provider: 'claude', ok: true, label: 'Claude Max', detail: 'me@example.com' }) };
const copilot = { id: 'copilot' as const, name: 'GitHub Copilot', status: async (): Promise<ProviderStatus> => ({ provider: 'copilot', ok: false, label: 'Copilot not available', error: 'x' }) };

function deps(choice: (items: { id: string }[]) => { id: string } | undefined) {
  return { providers: [claude, copilot], current: () => 'claude' as const, pick: vi.fn(async (items: { id: string }[]) => choice(items)), write: vi.fn(async () => {}), recheck: vi.fn(async () => {}) };
}

describe('selectProvider', () => {
  it('lists each provider with its fresh status, plus Check again', async () => {
    const d = deps(() => undefined);
    await selectProvider(d);
    expect(d.pick.mock.calls[0][0]).toEqual([
      { id: 'claude', label: '$(check) Claude', description: 'Claude Max', detail: 'me@example.com' },
      { id: 'copilot', label: 'GitHub Copilot', description: 'Copilot not available', detail: 'x' },
      { id: 'recheck', label: '$(refresh) Check again' },
    ]);
    expect(d.write).not.toHaveBeenCalled();
  });
  it('writes a different provider, and re-checks the same one', async () => {
    const pickCopilot = deps((items) => items[1]);
    await selectProvider(pickCopilot);
    expect(pickCopilot.write).toHaveBeenCalledWith('copilot');
    const pickSame = deps((items) => items[0]);
    await selectProvider(pickSame);
    expect(pickSame.write).not.toHaveBeenCalled();
    expect(pickSame.recheck).toHaveBeenCalled();
  });
});
```

Add these to `extension/test/engines.test.ts`. Keep every existing test, renaming `checkSignIn` to `checkProvider` and `CHECKING` to `checkingStatus(...)`/`isChecking`.

```ts
it('uses the provider named in the setting, and swaps when it changes', async () => {
  let provider = 'claude';
  const copilot = testProvider({ id: 'copilot', name: 'GitHub Copilot', status: async () => ({ provider: 'copilot', ok: false, preview: true, label: 'Copilot (preview)', error: 'nope' }) });
  const manager = new EngineManager({ ...baseDeps(), settings: () => ({ ...defaults, provider }), providers: { copilot: () => copilot } });
  const app = manager.get(folder('a'));
  await manager.checkProvider();
  expect(app.provider().id).toBe('claude');
  provider = 'copilot';
  await manager.checkProvider();
  expect(app.provider()).toBe(copilot);
  expect(app.status()).toMatchObject({ provider: 'copilot', ok: false, error: 'nope' });
});
it('warns once about an unknown provider and uses Claude', async () => {
  const warning = vi.fn();
  const manager = new EngineManager({ ...baseDeps({ warning }), settings: () => ({ ...defaults, provider: 'gemini' }) });
  await manager.checkProvider();
  await manager.checkProvider();
  expect(manager.currentProvider().id).toBe('claude');
  expect(warning.mock.calls).toEqual([["Unknown agentStream.provider 'gemini'; using Claude."]]);
});
```

Create `extension/test/helpers.ts`. Later extension tests (Tasks 8 and 9) reuse it.

```ts
import type { AgentProvider } from '@agent-stream/engine';
import type { ProviderStatus } from '@agent-stream/shared';

export const signedIn: ProviderStatus = { provider: 'claude', ok: true, label: 'Claude Max' };
export function testProvider(over: Partial<AgentProvider> = {}): AgentProvider {
  return { id: 'claude', name: 'Claude', status: async () => signedIn, runStep: async () => ({ ok: true, output: '' }), planTurn: async () => ({ ok: true }), ...over };
}
```

`baseDeps(events?)` and `defaults` are local to `engines.test.ts`:
- `baseDeps(events?)` returns a mkdtemp `home`, fake `findClaude` (`{ ok: true, path: '/bin/claude' }`) and fake `checkAuth` (resolving `signedIn`), with no-op events overridden by `events`.
- `defaults = { claudePath: '', gitBashPath: '', maxParallel: 1, provider: 'claude' }`.

- [ ] **Step 2: Run them to verify they fail**

Run: `npm test -w extension`
Expected: FAIL, because the modules are missing and `checkProvider` is undefined.

- [ ] **Step 3: Implement the Copilot scaffold** — `extension/src/providers/copilot.ts`

```ts
import * as vscode from 'vscode';
import type { AgentProvider } from '@agent-stream/engine';
import type { ProviderStatus } from '@agent-stream/shared';

export const COPILOT_NOT_IMPLEMENTED = "Copilot support isn't implemented yet. Switch to Claude with Agent Stream: Select Provider.";
export const COPILOT_UNAVAILABLE = "GitHub Copilot isn't available. Install the GitHub Copilot extension and sign in, or switch to Claude with Agent Stream: Select Provider.";

export type LmApi = { selectChatModels(selector: { vendor: string }): Thenable<readonly { name: string }[]> };

/**
 * GitHub Copilot through VS Code's Language Model API (provider spec §3.5). This round only
 * detects the models; it never sends a request, so VS Code's consent prompt doesn't appear.
 */
export function createCopilotProvider(lm: LmApi | undefined = (vscode as { lm?: LmApi }).lm): AgentProvider {
  const unavailable = (reason?: string): ProviderStatus => ({
    provider: 'copilot',
    ok: false,
    label: 'Copilot not available',
    error: reason ? `${COPILOT_UNAVAILABLE} (${reason})` : COPILOT_UNAVAILABLE,
  });
  return {
    id: 'copilot',
    name: 'GitHub Copilot',
    async status() {
      if (!lm?.selectChatModels) return unavailable('This version of VS Code has no Language Model API.');
      try {
        const models = await lm.selectChatModels({ vendor: 'copilot' });
        if (models.length === 0) return unavailable();
        const names = [...new Set(models.map((m) => m.name))].join(', ');
        return { provider: 'copilot', ok: false, preview: true, label: 'Copilot (preview)', detail: `Models: ${names}. Running steps with Copilot isn't implemented yet.`, error: COPILOT_NOT_IMPLEMENTED };
      } catch (e) {
        return unavailable(e instanceof Error ? e.message : String(e));
      }
    },
    runStep: async () => ({ ok: false, output: '', error: COPILOT_NOT_IMPLEMENTED }),
    planTurn: async () => ({ ok: false, error: COPILOT_NOT_IMPLEMENTED }),
  };
}
```

`planTurn` returns `{ ok: false }` instead of throwing. The planner shows the same message either way, and a result avoids the stale-session clearing path that a thrown error takes.

- [ ] **Step 4: Implement the registry, settings and the manager**

`extension/src/providers/registry.ts`:

```ts
import { PROVIDER_IDS, type ProviderId } from '@agent-stream/shared';

export function parseProviderSetting(value: unknown): { id: ProviderId; warning?: string } {
  if (value === undefined || value === null || value === '') return { id: 'claude' };
  if (typeof value === 'string' && (PROVIDER_IDS as readonly string[]).includes(value)) return { id: value as ProviderId };
  return { id: 'claude', warning: `Unknown agentStream.provider '${String(value)}'; using Claude.` };
}
```

`extension/src/settings.ts`: `Settings` gains `provider: string`, read with `String(config.get('provider', 'claude')).trim()`. Update `settings.test.ts`.

`extension/src/engines.ts`:

```ts
export const CHECKING_LABEL = 'checking';
export const checkingStatus = (p: { id: ProviderId; name: string }): ProviderStatus => ({ provider: p.id, ok: false, label: CHECKING_LABEL, error: `Checking ${p.name}…` });
export const isChecking = (s: ProviderStatus): boolean => !s.ok && s.label === CHECKING_LABEL;
```

`EngineManagerDeps` gains `providers?: Partial<Record<ProviderId, () => AgentProvider>>`, the test seam for building a provider. Its default is `{ claude: () => createClaudeProvider({...as in Task 3...}), copilot: () => createCopilotProvider() }`. The manager:
- `providerFor(id)` builds once per ID and caches.
- `currentProvider()` reads `parseProviderSetting(settings().provider)`. A warning is reported through `events.warning` only when it differs from the last reported one.
- `status` starts as `checkingStatus(claude)`.
- `checkProvider()` keeps the `checkSeq`/`latest` guard from Task 1. Each run:
  1. Picks `p = currentProvider()`.
  2. Sets `this.status = checkingStatus(p)` and fires `events.auth`.
  3. Awaits `p.status()`.
  4. If no newer check started, it calls `app.setProvider(p, this.folderStatus(folder))` on every engine and fires `events.auth(this.status)`.
- `get(folder)` passes `provider: this.currentProvider()`.
- `folderStatus` uses the current provider's `folderProblem`.

`extension/src/statusBar.ts`: replace `status === CHECKING` with `isChecking(status)`. `extension/src/graphsView.ts`:
- uses `isChecking`;
- `RetryItem` becomes `super('Check again', …)` with `title: 'Check again'`, and still runs `agentStream.retrySignIn`.

- [ ] **Step 5: Implement Select Provider** — `extension/src/selectProvider.ts`

```ts
import type { ProviderId, ProviderStatus } from '@agent-stream/shared';

type Choice = { id: ProviderId | 'recheck'; label: string; description?: string; detail?: string };
export type SelectProviderDeps = {
  providers: { id: ProviderId; name: string; status(): Promise<ProviderStatus> }[];
  current(): ProviderId;
  pick(items: Choice[], placeholder: string): Promise<Choice | undefined>;
  write(id: ProviderId): Promise<void>;
  recheck(): Promise<unknown>;
};

export async function selectProvider(d: SelectProviderDeps): Promise<void> {
  const current = d.current();
  const items: Choice[] = await Promise.all(
    d.providers.map(async (p) => {
      const s = await p.status();
      const detail = s.ok ? s.detail : (s.detail ?? s.error);
      return { id: p.id, label: `${p.id === current ? '$(check) ' : ''}${p.name}`, description: s.label, ...(detail !== undefined && { detail }) };
    }),
  );
  items.push({ id: 'recheck', label: '$(refresh) Check again' });
  const choice = await d.pick(items, 'Choose the AI provider Agent Stream runs on');
  if (!choice) return;
  if (choice.id === 'recheck' || choice.id === current) {
    await d.recheck();
    return;
  }
  await d.write(choice.id); // the configuration change triggers checkProvider
}
```

Wire it in `extension/src/extension.ts`:
- `status.command = 'agentStream.selectProvider'`.
- Register `agentStream.selectProvider`:
  - `providers`: `PROVIDER_IDS.map((id) => manager.providerFor(id))`.
  - `current`: `manager.currentProvider().id`.
  - `pick`: `vscode.window.showQuickPick(items, { placeHolder })`.
  - `recheck`: `manager.checkProvider()`.
  - `write`:
    ```ts
    const config = vscode.workspace.getConfiguration('agentStream');
    const target = config.inspect<string>('provider')?.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
    await config.update('provider', id, target);
    ```
- Add:
  ```ts
  vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration('agentStream.provider') || e.affectsConfiguration('agentStream.claudePath')) void manager.checkProvider();
  })
  ```
- Rename every `checkSignIn` call to `checkProvider`.

`extension/package.json`:

```json
"agentStream.provider": {
  "type": "string",
  "enum": ["claude", "copilot"],
  "default": "claude",
  "enumDescriptions": [
    "Claude: your Claude subscription through Claude Code.",
    "GitHub Copilot (preview): detected only; running steps isn't implemented yet."
  ],
  "description": "The AI provider that runs agent steps and the planner."
}
```

- Append " Claude provider only." to the `agentStream.claudePath` description.
- Add the command `{ "command": "agentStream.selectProvider", "title": "Select Provider", "category": "Agent Stream" }`.
- Retitle `agentStream.retrySignIn` to `"Check Again"`.

- [ ] **Step 6: Make the web wording neutral**

- `web/src/components/NodePanel.tsx`: `<option value="agent">Agent: an AI agent run</option>`.
- `web/src/App.tsx`: the banner text is
  ```ts
  status.preview ? status.error : `${status.error} Fix this, then use Check again in the Agent Stream sidebar.`
  ```

- [ ] **Step 7: Verify**

Run: `npm test && npm run typecheck && npm run build -w extension`
Expected: PASS. `git grep -n "a Claude agent run\|checkSignIn\|CHECKING\b" -- extension/src web/src` finds nothing.

- [ ] **Step 8: Commit**

```bash
git add extension web
git commit -m "feat(extension): choose the provider; GitHub Copilot as a selectable preview"
```

---

### Task 5: Session store and legacy migration (not wired in yet)

**Files:**
- Create: `engine/src/sessionStore.ts`, `engine/test/sessionStore.test.ts`
- Modify: `engine/src/paths.ts`, `engine/test/paths.test.ts`, `engine/src/chatLog.ts`, `engine/src/app.ts` (only the `ChatLog` constructor argument), `shared/src/types.ts`

**Interfaces:**
- Produces (`shared/src/types.ts`):
  ```ts
  export type SessionTab = { graphId: string; group: number; index: number };
  export type SessionPlannerState = { sessionId?: string; provider?: ProviderId; opCursor?: number };
  export type Session = { id: string; name: string; createdAt: string; updatedAt: string; tabs: SessionTab[]; activeGraphId?: string; planner: Record<string, SessionPlannerState> };
  export type SessionListItem = { id: string; name: string; updatedAt?: string; tabCount: number; problem?: string };
  export type SessionResult = { ok: true; session: Session } | { ok: false; error: string };
  ```
- Produces (`engine/src/paths.ts`):
  - `ProjectPaths.sessionsDir`;
  - `isSessionId(id)`, which uses the graph ID rule;
  - `ensureDataDirs` creates `sessions/` and keeps `.gitignore` = `runs/` + `sessions/`.
- Produces (`engine/src/chatLog.ts`): `new ChatLog(dir: string)` with `append(graphId, entry)`, `read(graphId)` and `clear(graphId)`.
- Produces (`engine/src/sessionStore.ts`): `class SessionStore extends EventEmitter` (event `'changed'`) with:
  - `list()`, `load(id)`, `get(id)`, `create(name)`, `ensureDefault()`;
  - `rename(id, name)`, `duplicate(id)`, `delete(id)`;
  - `saveTabs(id, tabs, activeGraphId?)`;
  - `plannerState(id, graphId)`, `setPlannerState(id, graphId, patch)`, `clearPlanner(id, graphId)`;
  - `chatLog(id)`, `removeGraph(graphId)`.

  It also exports `DEFAULT_SESSION_ID = 'default'` and `migrateLegacy(paths, store, io?): string[]`.

- [ ] **Step 1: Write the failing tests** — `engine/test/sessionStore.test.ts`

```ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SESSION_ID, migrateLegacy, SessionStore } from '../src/sessionStore';
import { fixedClock, tmpProject } from './helpers';

const entry = (text: string) => ({ at: 't', role: 'user' as const, text });

function setup() {
  const paths = tmpProject();
  return { paths, store: new SessionStore(paths, fixedClock()) };
}

describe('SessionStore', () => {
  it('creates, renames, duplicates (tabs only) and deletes sessions', () => {
    const { store } = setup();
    const a = store.create('Refactor work');
    expect(a.id).toBe('refactor-work');
    store.saveTabs(a.id, [{ graphId: 'g1', group: 1, index: 0 }], 'g1');
    store.setPlannerState(a.id, 'g1', { sessionId: 's', provider: 'claude', opCursor: 3 });
    store.chatLog(a.id).append('g1', entry('hi'));
    expect(store.rename(a.id, 'Refactor')).toMatchObject({ ok: true, session: { id: 'refactor-work', name: 'Refactor' } });
    const copy = store.duplicate(a.id);
    expect(copy).toMatchObject({ ok: true, session: { name: 'Refactor copy', tabs: [{ graphId: 'g1', group: 1, index: 0 }], activeGraphId: 'g1', planner: {} } });
    if (!copy.ok) throw new Error();
    expect(store.chatLog(copy.session.id).read('g1')).toEqual([]);
    expect(store.delete(a.id)).toEqual({ ok: true });
    expect(store.list().map((s) => s.id)).toEqual([copy.session.id]);
  });

  it('refuses blank names and unknown ids', () => {
    const { store } = setup();
    expect(() => store.create('  ')).toThrow('A session needs a name.');
    expect(store.rename('nope', 'x')).toEqual({ ok: false, error: 'session "nope" not found' });
    expect(store.delete('../x')).toEqual({ ok: false, error: 'invalid session id "../x"' });
  });

  it('lists an unreadable session with its problem and never overwrites it', () => {
    const { paths, store } = setup();
    mkdirSync(join(paths.sessionsDir, 'broken'), { recursive: true });
    writeFileSync(join(paths.sessionsDir, 'broken', 'session.json'), '{ nope');
    expect(store.list()).toEqual([{ id: 'broken', name: 'broken', tabCount: 0, problem: expect.stringMatching(/JSON/) }]);
    expect(store.saveTabs('broken', [])).toBeUndefined();
    expect(readFileSync(join(paths.sessionsDir, 'broken', 'session.json'), 'utf8')).toBe('{ nope');
  });

  it('removes a deleted graph from every session', () => {
    const { store } = setup();
    for (const name of ['A', 'B']) {
      const s = store.create(name);
      store.saveTabs(s.id, [{ graphId: 'g1', group: 1, index: 0 }, { graphId: 'g2', group: 1, index: 1 }], 'g1');
      store.setPlannerState(s.id, 'g1', { opCursor: 1 });
      store.chatLog(s.id).append('g1', entry('x'));
    }
    store.removeGraph('g1');
    for (const id of ['a', 'b']) {
      expect(store.get(id)).toMatchObject({ tabs: [{ graphId: 'g2', group: 1, index: 0 }], planner: {} });
      expect(store.get(id).activeGraphId).toBeUndefined();
      expect(store.chatLog(id).read('g1')).toEqual([]);
    }
  });

  it('keeps one default session', () => {
    const { store } = setup();
    expect(store.ensureDefault()).toMatchObject({ id: DEFAULT_SESSION_ID, name: 'Default' });
    expect(store.ensureDefault().id).toBe(DEFAULT_SESSION_ID);
    expect(store.list()).toHaveLength(1);
  });
});

describe('migrateLegacy', () => {
  function legacyGraph(paths: ReturnType<typeof tmpProject>, id: string) {
    writeFileSync(join(paths.graphsDir, `${id}.json`), JSON.stringify({ id, name: id, goal: '', instructions: '', variables: [], nodes: [], edges: [], nodeSeq: 0, updatedAt: 't', plannerSessionId: 'sess-1', plannerOpCursor: 4 }));
    writeFileSync(join(paths.graphsDir, `${id}.chat.jsonl`), `${JSON.stringify(entry('one'))}\n${JSON.stringify(entry('two'))}\n`);
  }

  it('moves planner state and chats into Default and strips the graph file', () => {
    const { paths, store } = setup();
    legacyGraph(paths, 'g1');
    expect(migrateLegacy(paths, store)).toEqual([]);
    expect(store.plannerState(DEFAULT_SESSION_ID, 'g1')).toEqual({ sessionId: 'sess-1', provider: 'claude', opCursor: 4 });
    expect(store.chatLog(DEFAULT_SESSION_ID).read('g1').map((e) => e.text)).toEqual(['one', 'two']);
    expect(existsSync(join(paths.graphsDir, 'g1.chat.jsonl'))).toBe(false);
    const raw = JSON.parse(readFileSync(join(paths.graphsDir, 'g1.json'), 'utf8'));
    expect(raw.plannerSessionId).toBeUndefined();
    expect(raw.plannerOpCursor).toBeUndefined();
    expect(migrateLegacy(paths, store)).toEqual([]); // idempotent
    expect(store.chatLog(DEFAULT_SESSION_ID).read('g1')).toHaveLength(2);
  });

  it('migration resumes after a partial run', () => {
    const { paths, store } = setup();
    legacyGraph(paths, 'g1');
    const failingWrite = () => {
      throw new Error('disk full');
    };
    const warnings = migrateLegacy(paths, store, { writeGraph: failingWrite });
    expect(warnings).toEqual([expect.stringMatching(/g1.*disk full.*retried/)]);
    expect(migrateLegacy(paths, store)).toEqual([]);
    expect(store.chatLog(DEFAULT_SESSION_ID).read('g1').map((e) => e.text)).toEqual(['one', 'two']);
    expect(JSON.parse(readFileSync(join(paths.graphsDir, 'g1.json'), 'utf8')).plannerSessionId).toBeUndefined();
    expect(store.plannerState(DEFAULT_SESSION_ID, 'g1').sessionId).toBe('sess-1');
  });

  it('appends a leftover legacy chat to one already moved, oldest first', () => {
    const { paths, store } = setup();
    legacyGraph(paths, 'g1');
    store.ensureDefault();
    store.chatLog(DEFAULT_SESSION_ID).append('g1', entry('three'));
    migrateLegacy(paths, store);
    expect(store.chatLog(DEFAULT_SESSION_ID).read('g1').map((e) => e.text)).toEqual(['one', 'two', 'three']);
  });
});
```

In `engine/test/paths.test.ts`, assert that `ensureDataDirs` writes `runs/` and `sessions/` to `.gitignore`, and keeps existing lines.

- [ ] **Step 2: Run them to verify they fail**

Run: `npm test -w engine -- sessionStore paths`
Expected: FAIL, because the module is missing and `sessions/` isn't ignored.

- [ ] **Step 3: Implement paths and the chat log**

`engine/src/paths.ts`:
- `ProjectPaths` gains `sessionsDir: join(dataDir, 'sessions')`.
- `ensureDataDirs` also creates `sessionsDir`.
- `GITIGNORE_LINES = ['runs/', 'sessions/']`, with the comment updated: "Run records and personal work sessions stay out of git."
- Add `export function isSessionId(id: string): boolean { return GRAPH_ID_RE.test(id); }`.

`engine/src/chatLog.ts`:

```ts
export class ChatLog {
  constructor(private dir: string) {}
  private file(graphId: string): string {
    return join(this.dir, `${graphId}.chat.jsonl`);
  }
  append(graphId: string, entry: ChatEntry): void {
    if (!isGraphId(graphId)) throw new Error(`invalid graph id "${graphId}"`);
    mkdirSync(this.dir, { recursive: true });
    appendFileSync(this.file(graphId), `${JSON.stringify(entry)}\n`);
  }
  read(graphId: string): ChatEntry[] {
    return isGraphId(graphId) ? readJsonLines<ChatEntry>(this.file(graphId)) : [];
  }
  clear(graphId: string): void {
    if (isGraphId(graphId)) rmSync(this.file(graphId), { force: true });
  }
}
```

In `engine/src/app.ts`, construct it as `new ChatLog(paths.graphsDir)`. Behaviour is unchanged until Task 6.

- [ ] **Step 4: Implement `engine/src/sessionStore.ts`**

```ts
import { EventEmitter } from 'node:events';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { Session, SessionListItem, SessionPlannerState, SessionResult, SessionTab } from '@agent-stream/shared';
import { ChatLog } from './chatLog';
import { systemClock, type Clock } from './clock';
import { writeFileAtomic } from './fsutil';
import { slugify } from './graphStore';
import { isGraphId, isSessionId, type ProjectPaths } from './paths';

export const DEFAULT_SESSION_ID = 'default';

const sessionSchema = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  tabs: z.array(z.object({ graphId: z.string(), group: z.number().int().min(1).max(9), index: z.number().int().min(0) })),
  activeGraphId: z.string().optional(),
  planner: z.record(z.string(), z.object({ sessionId: z.string().optional(), provider: z.enum(['claude', 'copilot']).optional(), opCursor: z.number().int().nonnegative().optional() })),
});

/** Personal work sessions (sessions spec §3): one folder each, git-ignored. Events: 'changed'. */
export class SessionStore extends EventEmitter {
  constructor(
    private paths: ProjectPaths,
    private clock: Clock = systemClock,
  ) {
    super();
  }

  private dir(id: string): string {
    return join(this.paths.sessionsDir, id);
  }
  private file(id: string): string {
    return join(this.dir(id), 'session.json');
  }

  list(): SessionListItem[] {
    if (!existsSync(this.paths.sessionsDir)) return [];
    const items = readdirSync(this.paths.sessionsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && isSessionId(d.name))
      .map((d): SessionListItem => {
        const r = this.load(d.name);
        return r.ok ? { id: r.session.id, name: r.session.name, updatedAt: r.session.updatedAt, tabCount: r.session.tabs.length } : { id: d.name, name: d.name, tabCount: 0, problem: r.error };
      });
    return items.sort((a, b) => Number(!!a.problem) - Number(!!b.problem) || (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '') || a.name.localeCompare(b.name));
  }

  load(id: string): SessionResult {
    if (!isSessionId(id)) return { ok: false, error: `invalid session id "${id}"` };
    if (!existsSync(this.file(id))) return { ok: false, error: `session "${id}" not found` };
    try {
      const parsed = sessionSchema.safeParse(JSON.parse(readFileSync(this.file(id), 'utf8')));
      if (!parsed.success) return { ok: false, error: `session.json is invalid: ${z.prettifyError(parsed.error)}` };
      return { ok: true, session: { ...parsed.data, id } as Session };
    } catch (e) {
      return { ok: false, error: `session.json is not valid JSON (${(e as Error).message})` };
    }
  }

  get(id: string): Session {
    const r = this.load(id);
    if (!r.ok) throw new Error(r.error);
    return r.session;
  }

  private save(session: Session): void {
    mkdirSync(this.dir(session.id), { recursive: true });
    writeFileAtomic(this.file(session.id), `${JSON.stringify(session, null, 2)}\n`);
  }

  private uniqueId(name: string): string {
    const base = slugify(name) === 'graph' ? 'session' : slugify(name);
    let id = base;
    for (let i = 2; existsSync(this.dir(id)); i++) id = `${base}-${i}`;
    return id;
  }

  create(name: string, id?: string): Session {
    const trimmed = name.trim();
    if (!trimmed) throw new Error('A session needs a name.');
    const at = this.clock();
    const session: Session = { id: id ?? this.uniqueId(trimmed), name: trimmed, createdAt: at, updatedAt: at, tabs: [], planner: {} };
    this.save(session);
    this.emit('changed');
    return session;
  }

  ensureDefault(): Session {
    const r = this.load(DEFAULT_SESSION_ID);
    return r.ok ? r.session : this.create('Default', DEFAULT_SESSION_ID);
  }

  rename(id: string, name: string): SessionResult {
    const r = this.load(id);
    if (!r.ok) return r;
    if (!name.trim()) return { ok: false, error: 'A session needs a name.' };
    const session = { ...r.session, name: name.trim(), updatedAt: this.clock() };
    this.save(session);
    this.emit('changed');
    return { ok: true, session };
  }

  duplicate(id: string): SessionResult {
    const r = this.load(id);
    if (!r.ok) return r;
    const names = new Set(this.list().map((s) => s.name));
    let name = `${r.session.name} copy`;
    for (let i = 2; names.has(name); i++) name = `${r.session.name} copy ${i}`;
    const copy = this.create(name);
    const session = { ...copy, tabs: r.session.tabs, ...(r.session.activeGraphId && { activeGraphId: r.session.activeGraphId }) };
    this.save(session);
    return { ok: true, session };
  }

  delete(id: string): { ok: true } | { ok: false; error: string } {
    if (!isSessionId(id)) return { ok: false, error: `invalid session id "${id}"` };
    if (!existsSync(this.dir(id))) return { ok: false, error: `session "${id}" not found` };
    rmSync(this.dir(id), { recursive: true, force: true });
    this.emit('changed');
    return { ok: true };
  }

  /** Records a session's graph tabs; an unreadable session is left untouched. */
  saveTabs(id: string, tabs: SessionTab[], activeGraphId?: string): void {
    const r = this.load(id);
    if (!r.ok) return;
    const same = JSON.stringify(r.session.tabs) === JSON.stringify(tabs) && r.session.activeGraphId === activeGraphId;
    if (same) return;
    const { activeGraphId: _old, ...rest } = r.session;
    this.save({ ...rest, tabs, ...(activeGraphId && { activeGraphId }), updatedAt: this.clock() });
    this.emit('changed');
  }

  plannerState(id: string, graphId: string): SessionPlannerState {
    const r = this.load(id);
    return r.ok ? (r.session.planner[graphId] ?? {}) : {};
  }

  setPlannerState(id: string, graphId: string, patch: SessionPlannerState): void {
    const session = this.get(id);
    const next = { ...session.planner[graphId], ...patch };
    for (const k of Object.keys(next) as (keyof SessionPlannerState)[]) if (next[k] === undefined) delete next[k];
    this.save({ ...session, planner: { ...session.planner, [graphId]: next } });
  }

  /** "New chat": forget this graph's conversation in this session. */
  clearPlanner(id: string, graphId: string): void {
    const session = this.get(id);
    const { [graphId]: _gone, ...planner } = session.planner;
    this.save({ ...session, planner });
    this.chatLog(id).clear(graphId);
  }

  chatLog(id: string): ChatLog {
    if (!isSessionId(id)) throw new Error(`invalid session id "${id}"`);
    return new ChatLog(join(this.dir(id), 'chats'));
  }

  removeGraph(graphId: string): void {
    if (!isGraphId(graphId)) return;
    for (const item of this.list()) {
      if (item.problem) continue;
      const s = this.get(item.id);
      const tabs = s.tabs.filter((t) => t.graphId !== graphId);
      const groups = new Map<number, number>();
      const reindexed = tabs.map((t) => {
        const index = groups.get(t.group) ?? 0;
        groups.set(t.group, index + 1);
        return { ...t, index };
      });
      const { [graphId]: _gone, ...planner } = s.planner;
      const { activeGraphId, ...rest } = s;
      this.save({ ...rest, tabs: reindexed, planner, ...(activeGraphId && activeGraphId !== graphId && { activeGraphId }) });
      this.chatLog(s.id).clear(graphId);
    }
    this.emit('changed');
  }
}

export type MigrationIo = { writeGraph: (path: string, content: string) => void };

/**
 * Moves pre-sessions planner state (graph-file fields) and chats (graphs/<id>.chat.jsonl) into
 * the Default session (sessions spec §3.3). Idempotent and resumable; failures become warnings.
 */
export function migrateLegacy(paths: ProjectPaths, store: SessionStore, io: MigrationIo = { writeGraph: writeFileAtomic }): string[] {
  const warnings: string[] = [];
  if (!existsSync(paths.graphsDir)) return warnings;
  store.ensureDefault();
  const ids = readdirSync(paths.graphsDir)
    .filter((f) => f.endsWith('.json') && !f.endsWith('.chat.jsonl') && !f.endsWith('.ops.jsonl'))
    .map((f) => f.slice(0, -'.json'.length))
    .filter(isGraphId);
  for (const id of ids) {
    try {
      const legacyChat = join(paths.graphsDir, `${id}.chat.jsonl`);
      if (existsSync(legacyChat)) {
        const dest = join(paths.sessionsDir, DEFAULT_SESSION_ID, 'chats', `${id}.chat.jsonl`);
        mkdirSync(join(paths.sessionsDir, DEFAULT_SESSION_ID, 'chats'), { recursive: true });
        if (!existsSync(dest)) renameSync(legacyChat, dest);
        else {
          writeFileAtomic(dest, readFileSync(legacyChat, 'utf8') + readFileSync(dest, 'utf8'));
          rmSync(legacyChat, { force: true });
        }
      }
      const graphFile = join(paths.graphsDir, `${id}.json`);
      const raw = JSON.parse(readFileSync(graphFile, 'utf8')) as Record<string, unknown>;
      if (!('plannerSessionId' in raw) && !('plannerOpCursor' in raw)) continue;
      const existing = store.plannerState(DEFAULT_SESSION_ID, id);
      if (existing.sessionId === undefined && existing.opCursor === undefined) {
        store.setPlannerState(DEFAULT_SESSION_ID, id, {
          ...(typeof raw.plannerSessionId === 'string' && { sessionId: raw.plannerSessionId }),
          provider: 'claude',
          ...(typeof raw.plannerOpCursor === 'number' && { opCursor: raw.plannerOpCursor }),
        });
      }
      const { plannerSessionId: _s, plannerOpCursor: _c, ...definition } = raw;
      io.writeGraph(graphFile, `${JSON.stringify(definition, null, 2)}\n`);
    } catch (e) {
      warnings.push(`Could not move the planner conversation of graph ${id} into the Default session (${(e as Error).message}); it stays where it is and will be retried next time.`);
    }
  }
  return warnings;
}
```

Note: the append order in the "leftover" case is legacy content first, then the moved content. The planner state is copied before the graph rewrite, so a failed rewrite leaves the graph file holding the same values. The next run sees them already copied and only strips them.

- [ ] **Step 5: Run the tests**

Run: `npm test -w engine && npm run typecheck`
Expected: PASS. The App still uses the legacy files, because nothing calls `migrateLegacy` yet.

- [ ] **Step 6: Commit**

```bash
git add shared engine
git commit -m "feat(engine): session store and legacy planner-state migration"
```

---

### Task 6: Planner per session and graph; chat and session protocol

**Files:**
- Modify: `shared/src/types.ts`, `shared/src/schemas.ts`, `shared/test/schemas.test.ts`
- Modify: `engine/src/planner.ts`, `engine/src/app.ts`, `engine/src/graphStore.ts`, `engine/test/planner.test.ts`, `engine/test/app.test.ts`, `engine/test/graphStore.test.ts`
- Modify: `web/src/state.ts`, `web/src/bridge.ts`, `web/src/components/ChatPanel.tsx`, `web/test/state.test.ts`, `web/test/bridge.test.ts` (the interim, ruling P5)
- Modify: `extension/src/engines.ts` (observe `sessions`), `extension/test/engines.test.ts`

**Interfaces:**
- Consumes: `SessionStore`, `migrateLegacy`, `DEFAULT_SESSION_ID` (Task 5); `AgentProvider`, `PlannerTurn` (Task 3).
- Produces (shared):
  - `Graph` loses `plannerSessionId`/`plannerOpCursor`, in both the type and the zod schema. Unknown keys in old files are stripped on parse.
  - `ChatRole` gains `'note'`.
  - `ServerMessage`:
    - `graphOpened` loses `chat`/`chatBusy`;
    - `chatEntry` and `chatBusy` gain `sessionId`;
    - new `{ type: 'chatOpened'; graphId: string; sessionId: string; chat: ChatEntry[]; busy: boolean }`;
    - new `{ type: 'sessions'; sessions: SessionListItem[] }`.
  - `ClientMessage`:
    - `chat` gains `sessionId`;
    - new `{ type: 'openChat'; graphId: string; sessionId: string }`;
    - new `{ type: 'newChat'; graphId: string; sessionId: string }`.
- Produces (engine): the `Planner` API.
  - `send(sessionId, graphId, text)`, `newChat(sessionId, graphId)`;
  - `isBusy(sessionId, graphId)`, `isBusyInGraph(graphId)`, `isBusyInSession(sessionId)`;
  - the events `'entry'(sessionId, graphId, entry)`, `'busy'(sessionId, graphId, busy)` and `'cleared'(sessionId, graphId)`.
- Produces (engine): the App API.
  - The store is exposed as `app.sessionStore`.
  - Session methods:
    - `listSessions()`, `createSession(name)`, `renameSession(id, name)`, `duplicateSession(id)`;
    - `deleteSession(id)`, which refuses while that session's planner is busy;
    - `saveSessionTabs(id, tabs, activeGraphId?)`.
  - Every change broadcasts `{ type: 'sessions', … }`. The `'sessions'` message reaches the extension through `connect`, which also sends it right after `hello`.
- Produces (extension): `EngineEvents.sessions(folder, sessions)`.

- [ ] **Step 1: Write the failing tests**

`engine/test/planner.test.ts`. The fake provider from Task 3 stays. Build the planner with `sessions: new SessionStore(paths, clock)`. Create sessions `a` and `b`, and keep every existing neutral assertion with `send('a', graphId, …)`. Add:

```ts
it('keeps each session’s conversation and edit cursor separate', async () => {
  const s = setup([ok('s-a'), ok('s-b'), ok('s-a2')]);
  await s.planner.send('a', s.graphId, 'first in a');
  s.graphStore.apply(s.graphId, { type: 'setGoal', goal: 'g' }, 'user');
  await s.planner.send('b', s.graphId, 'first in b');
  await s.planner.send('a', s.graphId, 'second in a');
  expect(s.sessions.chatLog('a').read(s.graphId).filter((e) => e.role === 'user').map((e) => e.text)).toEqual(['first in a', 'second in a']);
  expect(s.sessions.chatLog('b').read(s.graphId).filter((e) => e.role === 'user').map((e) => e.text)).toEqual(['first in b']);
  expect(s.provider.seen[1].prompt).toMatch(/changed the goal/);   // b has never seen the edit
  expect(s.provider.seen[2].prompt).toMatch(/changed the goal/);   // a's cursor predates it
  expect(s.provider.seen[2].resume).toBe('s-a');
});

it('runs turns for two sessions on one graph at once, but one at a time per session', async () => {
  const gate = deferred<PlannerTurnResult>();
  const s = setup([() => gate.promise, ok('s-b')]);
  const first = s.planner.send('a', s.graphId, 'slow');
  await s.planner.send('a', s.graphId, 'again');
  await s.planner.send('b', s.graphId, 'other');
  expect(s.sessions.chatLog('a').read(s.graphId).at(-1)).toMatchObject({ role: 'error', text: 'The planner is still working on your previous message.' });
  expect(s.planner.isBusyInGraph(s.graphId)).toBe(true);
  gate.resolve({ ok: true, sessionId: 's-a' });
  await first;
  expect(s.planner.isBusyInGraph(s.graphId)).toBe(false);
});

it('starts fresh with a note when the stored conversation belongs to another provider', async () => {
  const s = setup([ok('new')], { id: 'copilot', name: 'GitHub Copilot' });
  s.sessions.setPlannerState('a', s.graphId, { sessionId: 'claude-sess', provider: 'claude', opCursor: 0 });
  await s.planner.send('a', s.graphId, 'hi');
  expect(s.provider.seen[0].resume).toBeUndefined();
  expect(s.sessions.chatLog('a').read(s.graphId).map((e) => [e.role, e.text])).toContainEqual(['note', "Started a new planner conversation with GitHub Copilot; it doesn't see earlier messages."]);
  expect(s.sessions.plannerState('a', s.graphId)).toMatchObject({ sessionId: 'new', provider: 'copilot' });
});

it('New chat clears this session’s conversation for the graph only', async () => {
  const s = setup([ok('s-a'), ok('s-b')]);
  await s.planner.send('a', s.graphId, 'x');
  await s.planner.send('b', s.graphId, 'y');
  expect(s.planner.newChat('a', s.graphId)).toEqual({ ok: true });
  expect(s.sessions.chatLog('a').read(s.graphId)).toEqual([]);
  expect(s.sessions.plannerState('a', s.graphId)).toEqual({});
  expect(s.sessions.chatLog('b').read(s.graphId)).not.toEqual([]);
});
```

`ok(id)` returns `async () => ({ ok: true, sessionId: id })`. `setup` accepts the turn list plus an optional provider override.

`engine/test/app.test.ts`:

```ts
it('migrates legacy planner state and chats into the Default session on start', () => {
  const paths = tmpProject();
  writeFileSync(join(paths.graphsDir, 'g1.json'), JSON.stringify({ id: 'g1', name: 'G', goal: '', instructions: '', variables: [], nodes: [], edges: [], nodeSeq: 0, updatedAt: 't', plannerSessionId: 's', plannerOpCursor: 2 }));
  writeFileSync(join(paths.graphsDir, 'g1.chat.jsonl'), `${JSON.stringify({ at: 't', role: 'user', text: 'old' })}\n`);
  const app = createApp({ projectDir: paths.root, valuesFile: tmpValuesFile(), provider: testProvider(), status: signedIn, maxParallel: 1 });
  expect(app.sessionStore.plannerState('default', 'g1')).toEqual({ sessionId: 's', provider: 'claude', opCursor: 2 });
  expect(app.sessionStore.chatLog('default').read('g1').map((e) => e.text)).toEqual(['old']);
  expect(app.startupWarnings()).toEqual([]);
});

it('sends each chat only to the clients subscribed to that conversation', async () => {
  const { app, graphId } = setupWithGraph();
  app.createSession('B');
  const a = client(app), b = client(app);
  await app.handle(a.client, { type: 'openChat', graphId, sessionId: 'default' });
  await app.handle(b.client, { type: 'openChat', graphId, sessionId: 'b' });
  expect(a.last('chatOpened')).toEqual({ type: 'chatOpened', graphId, sessionId: 'default', chat: [], busy: false });
  await app.handle(a.client, { type: 'chat', graphId, sessionId: 'default', text: 'hello' });
  await flush();
  expect(a.all('chatEntry').map((m) => m.entry.text)).toContain('hello');
  expect(b.all('chatEntry')).toEqual([]);
});

it('refuses chat for an unknown session, and cleans every session when a graph is deleted', async () => {
  const { app, graphId } = setupWithGraph();
  const a = client(app);
  await app.handle(a.client, { type: 'chat', graphId, sessionId: 'nope', text: 'x' });
  expect(a.last('error')).toEqual({ type: 'error', message: 'session "nope" not found' });
  app.saveSessionTabs('default', [{ graphId, group: 1, index: 0 }], graphId);
  expect(app.deleteGraph(graphId)).toEqual({ ok: true });
  expect(app.sessionStore.get('default').tabs).toEqual([]);
});

it('broadcasts the session list on every change, and refuses to delete a session whose planner is busy', async () => {
  const held = deferred<PlannerTurnResult>();
  const { app, graphId } = setupWithGraph({ provider: testProvider({ planTurn: () => held.promise }) });
  const watcher = client(app);
  const b = app.createSession('B');
  expect(app.renameSession(b.id, 'Bee')).toMatchObject({ ok: true });
  const copy = app.duplicateSession(b.id);
  expect(copy).toMatchObject({ ok: true });
  expect(watcher.all('sessions').map((m) => m.sessions.map((s) => s.name).sort())).toEqual([
    ['Default'],              // on connect
    ['B', 'Default'],
    ['Bee', 'Default'],
    ['Bee', 'Bee copy', 'Default'],
  ]);
  await app.handle(watcher.client, { type: 'chat', graphId, sessionId: b.id, text: 'slow' });
  await flush();
  expect(app.deleteSession(b.id)).toEqual({ ok: false, error: "The planner is still working in this session. Try again when it's done." });
  held.resolve({ ok: true });
  await flush();
  expect(app.deleteSession(b.id)).toEqual({ ok: true });
  expect(watcher.last('sessions').sessions.map((s) => s.id).sort()).toEqual(['bee-copy', 'default']);
});
```

`setupWithGraph(over?)` creates an App with `testProvider()` (or `over.provider`) and one graph, and returns `{ app, graphId }`. `client(app)` connects a client that records messages, with `all(type)`/`last(type)` helpers. `flush()` is `new Promise((r) => setTimeout(r, 0))`. `deferred<T>()` returns `{ promise, resolve }`. Add whichever of these `app.test.ts` doesn't already have. Session IDs come from slugified names: `B` becomes `b`, and the rename keeps the ID `b`, so the copy of "Bee" is `bee-copy`.

`shared/test/schemas.test.ts`:
- `openChat`, `chat` (with `sessionId`) and `newChat` parse;
- `chat` without `sessionId` is rejected;
- an old graph file with `plannerSessionId` parses, and the field is dropped.

- [ ] **Step 2: Run them to verify they fail**

Run: `npm test -w engine -- planner app && npm test -w shared -- schemas`
Expected: FAIL.

- [ ] **Step 3: Implement the shared types and schemas**

Apply the **Interfaces** changes:
- Delete the two planner fields from `Graph` and from the graph zod schema.
- In `clientMessageSchema`:
  ```ts
  z.object({ type: z.literal('openChat'), graphId: z.string(), sessionId: z.string() }),
  z.object({ type: z.literal('chat'), graphId: z.string(), sessionId: z.string(), text: z.string().min(1) }),
  z.object({ type: z.literal('newChat'), graphId: z.string(), sessionId: z.string() }),
  ```

- [ ] **Step 4: Re-key the planner** (`engine/src/planner.ts`)

- `PlannerDeps` replaces `chatLog` with `sessions: SessionStore`.
- `busy` becomes a `Set<string>` of `${sessionId}|${graphId}`.
- `add(sessionId, graphId, role, text)` appends to `sessions.chatLog(sessionId)` and emits `'entry'`.

In `send(sessionId, graphId, text)`, after the busy check and the folder problem:

```ts
const provider = this.d.provider();
const state = this.d.sessions.plannerState(sessionId, graphId);
const sameProvider = (state.provider ?? 'claude') === provider.id;
if (state.sessionId && !sameProvider) this.add(sessionId, graphId, 'note', `Started a new planner conversation with ${provider.name}; it doesn't see earlier messages.`);
const resume = sameProvider ? state.sessionId : undefined;
const ops = this.d.graphStore.readOps(graphId);
const cursor = ops.length;
// …planTurn exactly as in Task 3, with prompt from ops.slice(state.opCursor ?? 0) and `resume`…
if (!r.ok) {
  if (r.resumeFailed) this.d.sessions.setPlannerState(sessionId, graphId, { sessionId: undefined });
  this.add(sessionId, graphId, 'error', r.resumeFailed ? `${r.error}${SESSION_RESET_NOTE}` : r.error);
  return;
}
if (r.error) this.add(sessionId, graphId, 'error', r.error);
this.d.sessions.setPlannerState(sessionId, graphId, { sessionId: r.sessionId ?? resume, provider: provider.id, opCursor: cursor });
```

- The `catch` uses `resume` as "had a session". When there was one, it clears it with `setPlannerState(sessionId, graphId, { sessionId: undefined })` and adds the note.
- `newChat(sessionId, graphId)`: if busy, return `{ ok: false, error: 'The planner is still working on your previous message.' }`. Otherwise call `sessions.clearPlanner`, emit `'cleared'` and return `{ ok: true }`.
- `isBusyInGraph(graphId)` and `isBusyInSession(sessionId)` scan the set.

- [ ] **Step 5: Wire the App** (`engine/src/app.ts`)

```ts
const sessions = new SessionStore(paths, clock);
migrationWarnings.push(...migrateLegacy(paths, sessions));
sessions.ensureDefault();
const chatSubscriptions = new Map<Client, { graphId: string; sessionId: string }>();
const toConversation = (sessionId: string, graphId: string, msg: ServerMessage) => {
  for (const [c, sub] of chatSubscriptions) if (sub.graphId === graphId && sub.sessionId === sessionId) c.send(msg);
};
const broadcastSessions = () => broadcast({ type: 'sessions', sessions: sessions.list() });
sessions.on('changed', broadcastSessions);
planner.on('entry', (sessionId: string, graphId: string, entry: ChatEntry) => toConversation(sessionId, graphId, { type: 'chatEntry', graphId, sessionId, entry }));
planner.on('busy', (sessionId: string, graphId: string, busy: boolean) => toConversation(sessionId, graphId, { type: 'chatBusy', graphId, sessionId, busy }));
planner.on('cleared', (sessionId: string, graphId: string) => toConversation(sessionId, graphId, { type: 'chatOpened', graphId, sessionId, chat: [], busy: false }));
```

- The Planner is built with `sessions` instead of `chatLog`, and `ChatLog` is no longer constructed in the App.
- `opened()` drops `chat`/`chatBusy`.
- `connect()` sends `hello`, then `{ type: 'sessions', sessions: sessions.list() }`. Its disconnect also deletes the client from `chatSubscriptions`.

In `handle`:

```ts
case 'openChat': {
  const g = graphStore.load(msg.graphId);
  if (!g.ok) return error(g.error);
  const s = sessions.load(msg.sessionId);
  if (!s.ok) return error(s.error);
  chatSubscriptions.set(client, { graphId: msg.graphId, sessionId: msg.sessionId });
  client.send({ type: 'chatOpened', graphId: msg.graphId, sessionId: msg.sessionId, chat: sessions.chatLog(msg.sessionId).read(msg.graphId), busy: planner.isBusy(msg.sessionId, msg.graphId) });
  return;
}
case 'chat': {
  if (!status.ok) return error(`Chat is disabled: ${status.error}`);
  const g = graphStore.load(msg.graphId);
  if (!g.ok) return error(g.error);
  const s = sessions.load(msg.sessionId);
  if (!s.ok) return error(s.error);
  planner.send(msg.sessionId, msg.graphId, msg.text).catch((e: unknown) => console.error('[agent-stream] planner error', e));
  return;
}
case 'newChat': {
  const s = sessions.load(msg.sessionId);
  if (!s.ok) return error(s.error);
  const r = planner.newChat(msg.sessionId, msg.graphId);
  if (!r.ok) return error(r.error);
  return;
}
```

- `deleteGraph`: replace `planner.isBusy(id)` with `planner.isBusyInGraph(id)`. After a successful delete, call `sessions.removeGraph(id)`.
- The session methods wrap the store:
  - `createSession(name)` returns `Session`; it may throw on a blank name, and the caller validates.
  - `renameSession`, `duplicateSession`, `deleteSession` and `saveSessionTabs` delegate to the store.
  - `deleteSession` refuses with `"The planner is still working in this session. Try again when it's done."` while `planner.isBusyInSession(id)`.
- The store's `'changed'` event broadcasts.
- Return `sessionStore: sessions` and the methods.

`engine/src/graphStore.ts`: delete `setPlannerState`. In `duplicate`, copy `r.graph` minus the `id`/`name`/`updatedAt` overrides. The planner fields no longer exist, so there's nothing to strip. Update `graphStore.test.ts` where it touched `setPlannerState`.

- [ ] **Step 6: Keep the graph tab's chat working (interim, ruling P5)**

- `web/src/state.ts`:
  - `graphOpened` no longer sets `chat`/`chatBusy`.
  - Add `case 'chatOpened': return msg.graphId === current && msg.sessionId === 'default' ? { ...state, chat: msg.chat, chatBusy: msg.busy } : state;`.
  - `chatEntry`/`chatBusy` also require `msg.sessionId === 'default'`.
  - `sessions` is ignored (`return state`).
- `web/src/bridge.ts`: after posting `opened`, `send({ type: 'openChat', graphId: msg.graph.id, sessionId: 'default' })`.
- `web/src/components/ChatPanel.tsx` sends `{ type: 'chat', graphId: graph.id, sessionId: 'default', text: t }`.
- Update `state.test.ts`/`bridge.test.ts` to match. Every web test fixture that builds `graphOpened` drops `chat`/`chatBusy`; today those are in `state.test.ts`, `menuModel.test.ts` and `GraphPanel.test.ts`. Task 7 replaces all of this.

`extension/src/engines.ts`: `EngineEvents` gains `sessions(folder: Folder, sessions: SessionListItem[]): void`. `observe` forwards `case 'sessions'`. `extension.ts` passes a no-op for now. Add one test in `engines.test.ts` checking that the manager reports the session list on connect.

- [ ] **Step 7: Verify**

Run: `npm test && npm run typecheck`
Expected: PASS. `git grep -n "plannerSessionId\|plannerOpCursor" -- engine/src shared/src web/src extension/src` lists only `sessionStore.ts` (the migration).

- [ ] **Step 8: Commit**

```bash
git add shared engine web extension
git commit -m "feat(engine): planner conversations per work session; chat and session protocol"
```

---

### Task 7: Web — the chat view app; the graph tab without Chat

**Files:**
- Create: `web/src/ChatApp.tsx`, `web/src/chatBridge.ts`, `web/src/viewMode.ts`, `web/test/ChatApp.test.ts`, `web/test/viewMode.test.ts`
- Modify: `web/src/main.tsx`, `web/src/state.ts`, `web/src/bridge.ts`, `web/src/components/ChatPanel.tsx`, `web/src/components/RightPanel.tsx`, `web/src/components/NodePanel.tsx`, `web/src/menuModel.ts`, `web/src/styles.css`
- Modify the tests: `web/test/state.test.ts`, `web/test/menuModel.test.ts`, `web/test/GraphPanel.test.ts`, `web/test/bridge.test.ts`, `web/test/ChatPanel.test.ts`
- Modify: `shared/src/types.ts`, `shared/src/schemas.ts`, `shared/test/schemas.test.ts`, `extension/src/graphEditor.ts` (`hostCommandArgs` for `focusChat`), `extension/test/graphEditor.test.ts`

**Interfaces:**
- Produces (shared):
  ```ts
  export type ChatTarget = { graphId: string; graphName: string; sessionId: string; sessionName: string };
  // HostMessage gains:   | { type: 'chatTarget'; target?: ChatTarget }
  // WebviewHostMessage gains:
  //   | { type: 'chatCommand'; command: 'switchSession' | 'newChat' }
  //   | { type: 'draftState'; dirty: boolean }
  // HostCommand gains 'focusChat'
  ```
- Produces (web):
  - `viewMode(dataset): 'graph' | 'chat'`;
  - `connectChat()`;
  - `<ChatApp />`;
  - `State.chatTarget?: ChatTarget`;
  - `Tab = 'node' | 'graph'`, with the initial tab `'node'`.
- The graph tab posts `draftState` whenever its Node panel's draft turns dirty or clean, and `false` on unmount.
- Produces (extension): `hostCommandArgs('focusChat', …)` returns `[]`. The command itself is registered in Task 9.

- [ ] **Step 1: Write the failing tests**

`web/test/viewMode.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { viewMode } from '../src/viewMode';

describe('viewMode', () => {
  it('is chat only when the page says so', () => {
    expect(viewMode({ view: 'chat' })).toBe('chat');
    expect(viewMode({ view: 'graph' })).toBe('graph');
    expect(viewMode({})).toBe('graph');
  });
});
```

`web/test/ChatApp.test.ts`. Use the same jsdom/act pattern as `ChatPanel.test.ts`, with `vscode` stubbed through `globalThis.acquireVsCodeApi` as `bridge.test.ts` does:

```ts
// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatApp } from '../src/ChatApp';
import { dispatch, resetStoreForTests } from '../src/store';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const posted: unknown[] = [];
(globalThis as { acquireVsCodeApi?: unknown }).acquireVsCodeApi = () => ({ postMessage: (m: unknown) => posted.push(m) });
Element.prototype.scrollIntoView = vi.fn();

const target = { graphId: 'g1', graphName: 'Orders parity', sessionId: 'default', sessionName: 'Default' };
async function render() {
  const el = document.createElement('div');
  await act(async () => createRoot(el).render(createElement(ChatApp)));
  return el;
}

describe('ChatApp', () => {
  beforeEach(() => {
    posted.length = 0;
    resetStoreForTests();
  });
  it('asks for a graph when there is none', async () => {
    const el = await render();
    expect(el.textContent).toContain('Open a graph to chat with the planner.');
  });
  it('shows the graph, the session and the conversation for its target', async () => {
    const el = await render();
    await act(async () => {
      dispatch({ kind: 'server', msg: { type: 'hello', status: { provider: 'claude', ok: true, label: 'Claude Max' }, project: '/p', graphs: [], approvals: [] } });
      dispatch({ kind: 'server', msg: { type: 'chatTarget', target } });
      dispatch({ kind: 'server', msg: { type: 'chatOpened', graphId: 'g1', sessionId: 'default', chat: [{ at: 't', role: 'user', text: 'hello' }], busy: false } });
    });
    expect(el.querySelector('.chat-head')?.textContent).toContain('Orders parity');
    expect(el.querySelector('.chat-head')?.textContent).toContain('Default');
    expect(el.textContent).toContain('hello');
  });
  it('sends chat for its target and runs the header commands through the extension', async () => {
    const el = await render();
    await act(async () => {
      dispatch({ kind: 'server', msg: { type: 'hello', status: { provider: 'claude', ok: true, label: 'Claude Max' }, project: '/p', graphs: [], approvals: [] } });
      dispatch({ kind: 'server', msg: { type: 'chatTarget', target } });
    });
    const box = el.querySelector('textarea')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
      setter.call(box, 'plan it');
      box.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    expect(posted).toContainEqual({ type: 'chat', graphId: 'g1', sessionId: 'default', text: 'plan it' });
    await act(async () => (el.querySelector('[data-action="newChat"]') as HTMLButtonElement).click());
    await act(async () => (el.querySelector('[data-action="switchSession"]') as HTMLButtonElement).click());
    expect(posted).toContainEqual({ type: 'chatCommand', command: 'newChat' });
    expect(posted).toContainEqual({ type: 'chatCommand', command: 'switchSession' });
  });
  it('disables input with the provider’s reason', async () => {
    const el = await render();
    await act(async () => {
      dispatch({ kind: 'server', msg: { type: 'hello', status: { provider: 'copilot', ok: false, preview: true, label: 'Copilot (preview)', error: "Copilot support isn't implemented yet." }, project: '/p', graphs: [], approvals: [] } });
      dispatch({ kind: 'server', msg: { type: 'chatTarget', target } });
    });
    const box = el.querySelector('textarea')!;
    expect(box.disabled).toBe(true);
    expect(box.placeholder).toBe("Copilot support isn't implemented yet.");
  });
});
```

If `store.ts` has no `resetStoreForTests`, add it as an exported function that sets the state back to `initialState`. That is test-only plumbing: name it exactly that and use it only from tests.

`web/test/state.test.ts`:

```ts
it('follows its chat target: new target clears, other conversations are ignored', () => {
  let s = reduce(initialState, server({ type: 'chatTarget', target: { graphId: 'g', graphName: 'G', sessionId: 'a', sessionName: 'A' } }));
  s = reduce(s, server({ type: 'chatOpened', graphId: 'g', sessionId: 'a', chat: [entry], busy: true }));
  expect([s.chat, s.chatBusy]).toEqual([[entry], true]);
  expect(reduce(s, server({ type: 'chatEntry', graphId: 'g', sessionId: 'b', entry })).chat).toEqual([entry]);
  expect(reduce(s, server({ type: 'chatOpened', graphId: 'h', sessionId: 'a', chat: [], busy: false })).chat).toEqual([entry]);
  const moved = reduce(s, server({ type: 'chatTarget', target: { graphId: 'g', graphName: 'G', sessionId: 'b', sessionName: 'B' } }));
  expect([moved.chat, moved.chatBusy]).toEqual([[], false]);
  expect(reduce(s, server({ type: 'chatTarget' })).chatTarget).toBeUndefined();
});
```

- `web/test/GraphPanel.test.ts`: the tabs are now `['Node', 'Graph']`.
- `web/test/menuModel.test.ts`: View has `Chat`, which runs `actions.host('focusChat')`, and no `Chat` tab item.
- Add a NodePanel test, either in `GraphPanel.test.ts` or a new `NodePanel.test.ts`. Selecting a node and editing its title posts `{ type: 'draftState', dirty: true }`. Undoing the edit posts `dirty: false`.

`shared/test/schemas.test.ts`: `chatCommand` (both commands), `draftState` and `{ type: 'host', command: 'focusChat' }` parse. `{ type: 'chatCommand', command: 'other' }` doesn't.

`extension/test/graphEditor.test.ts`: `hostCommandArgs('focusChat', panel)` is `[]`.

- [ ] **Step 2: Run them to verify they fail**

Run: `npm test -w web && npm test -w shared -- schemas && npm test -w extension -- graphEditor`
Expected: FAIL.

- [ ] **Step 3: Implement the shared types**

Add `ChatTarget`, the `HostMessage`/`WebviewHostMessage` variants and `'focusChat'` exactly as in **Interfaces**. In `schemas.ts`:
- add `'focusChat'` to `hostCommand`;
- add these to `webviewHostSchema`:
  ```ts
  z.object({ type: z.literal('chatCommand'), command: z.enum(['switchSession', 'newChat']) }),
  z.object({ type: z.literal('draftState'), dirty: z.boolean() }),
  ```

In `extension/src/graphEditor.ts`, `hostCommandArgs` returns `[]` for `'focusChat'`, as it does for `openGraph`/`showSidebar`.

- [ ] **Step 4: Implement the web**

`web/src/viewMode.ts`:

```ts
/** Which page the extension asked for: a graph tab, or the planner chat view (sessions spec §6). */
export function viewMode(dataset: { view?: string }): 'graph' | 'chat' {
  return dataset.view === 'chat' ? 'chat' : 'graph';
}
```

`web/src/main.tsx`:

```tsx
const view = viewMode(document.body.dataset);
if (view === 'graph') dispatch({ kind: 'setMinimap', value: document.body.dataset.minimap !== 'false' });
createRoot(document.getElementById('root')!).render(<StrictMode>{view === 'chat' ? <ChatApp /> : <App />}</StrictMode>);
if (view === 'chat') connectChat();
else connect();
```

`web/src/chatBridge.ts`:

```ts
import type { HostMessage } from '@agent-stream/shared';
import { post } from './bridge';
import { dispatch } from './store';

/** The chat view: the extension picks the conversation (chatTarget) and relays the engine. */
export function connectChat(): void {
  window.addEventListener('message', (event: MessageEvent) => {
    const msg: unknown = event.data;
    if (typeof msg === 'object' && msg !== null && typeof (msg as { type?: unknown }).type === 'string') dispatch({ kind: 'server', msg: msg as HostMessage });
  });
  post({ type: 'ready' });
}
```

`web/src/bridge.ts`: remove the Task 6 interim `openChat` send.

`web/src/state.ts`:
- `Tab = 'node' | 'graph'`; `initialState.tab = 'node'`; add `chatTarget?: ChatTarget`.
- Remove the Task 6 `'default'` filters.
- `revealNode` still sets `tab: 'node'`.

```ts
const sameTarget = (a?: ChatTarget, b?: ChatTarget) => !!a && !!b && a.graphId === b.graphId && a.sessionId === b.sessionId;
const forTarget = (s: State, graphId: string, sessionId: string) => s.chatTarget?.graphId === graphId && s.chatTarget.sessionId === sessionId;
// in reduceServer:
case 'chatTarget':
  return sameTarget(state.chatTarget, msg.target) ? { ...state, chatTarget: msg.target } : { ...state, chatTarget: msg.target, chat: [], chatBusy: false };
case 'chatOpened':
  return forTarget(state, msg.graphId, msg.sessionId) ? { ...state, chat: msg.chat, chatBusy: msg.busy } : state;
case 'chatEntry':
  return forTarget(state, msg.graphId, msg.sessionId) ? { ...state, chat: [...state.chat, msg.entry] } : state;
case 'chatBusy':
  return forTarget(state, msg.graphId, msg.sessionId) ? { ...state, chatBusy: msg.busy } : state;
case 'sessions':
  return state;
```

`graphDeleted` stops clearing `chat`. The chat view gets a new `chatTarget` from the extension instead.

`web/src/components/ChatPanel.tsx`: replace `graph` with `const target = useStore((s) => s.chatTarget)`. Then:
- `canType = !!target && !!status?.ok`;
- `submit` sends `{ type: 'chat', graphId: target.graphId, sessionId: target.sessionId, text: t }`;
- render `msg note` entries like assistant text. Their CSS class is `note`; style them muted.

`web/src/ChatApp.tsx`:

```tsx
import { post } from './bridge';
import { ChatPanel } from './components/ChatPanel';
import { useStore } from './store';

export function ChatApp() {
  const target = useStore((s) => s.chatTarget);
  if (!target) {
    return (
      <div className="chat-app empty">
        <p className="muted">Open a graph to chat with the planner.</p>
      </div>
    );
  }
  return (
    <div className="chat-app">
      <header className="chat-head">
        <span className="chat-graph" title={target.graphName}>
          {target.graphName}
        </span>
        <button className="link chat-session" data-action="switchSession" title="Switch session" onClick={() => post({ type: 'chatCommand', command: 'switchSession' })}>
          {target.sessionName} ▾
        </button>
        <button data-action="newChat" title="Start a new conversation" onClick={() => post({ type: 'chatCommand', command: 'newChat' })}>
          New chat
        </button>
      </header>
      <ChatPanel />
    </div>
  );
}
```

`web/src/components/RightPanel.tsx`:
- `LABELS: Record<Tab, string> = { node: 'Node', graph: 'Graph' }`;
- the body is `tab === 'node' ? <NodePanel /> : <GraphPanel />`;
- drop the `ChatPanel` import.

`web/src/menuModel.ts`: in View, replace `tab('Chat', 'chat')` with `host('Chat', 'focusChat')`.

The provider spec §5 asks for each run's provider to be shown. Import `PROVIDER_NAMES` from `@agent-stream/shared`:
- `web/src/components/TopBar.tsx`: the run picker's option text is `` `Run ${r.id} · ${statusLabel(r.status)}${r.provider ? ` · ${PROVIDER_NAMES[r.provider]}` : ''}` ``.
- `web/src/components/LogsPanel.tsx`: the header gains `` {run?.provider && ` · ${PROVIDER_NAMES[run.provider]}`} `` after the duration.

Add these tests:
- a `LogsPanel.test.ts` case: a run with `provider: 'copilot'` shows `GitHub Copilot` in the header, and one without shows no provider;
- a run-picker test (in `GraphPanel.test.ts`, or wherever the top bar is rendered today): the option text includes `Claude` for a Claude run.

`web/src/components/NodePanel.tsx`, after `const dirty = …`:

```tsx
useEffect(() => {
  post({ type: 'draftState', dirty });
}, [dirty]);
useEffect(() => () => post({ type: 'draftState', dirty: false }), []);
```

Import `post` from `../bridge`.

`web/src/styles.css`. Add the chat-app layout, using VS Code theme tokens as the rest of the file does:
- `.chat-app`: full height, column flex;
- `.chat-head`: a row with the graph name truncated with an ellipsis, then the session button and New chat on the right, with the theme border below;
- `.chat-app.empty`: centred muted text;
- `.msg.note`: muted italic.

- [ ] **Step 5: Verify**

Run: `npm test && npm run typecheck && npm run build`
Expected: PASS. The `ChatPanel.test.ts` scrollIntoView regression test is still green.

- [ ] **Step 6: Commit**

```bash
git add shared web extension
git commit -m "feat(web): planner chat as its own view; graph tab keeps Node and Graph"
```

---

### Task 8: Extension — work sessions (tabs, switching, Sessions view, status bar)

**Files:**
- Create: `extension/src/sessions.ts`, `extension/src/sessionsView.ts`, `extension/test/sessions.test.ts`, `extension/test/sessionsView.test.ts`
- Modify: `extension/src/graphEditor.ts` (`GraphPanel.dirty`, `draftState`), `extension/src/statusBar.ts` (`sessionStatusText`), `extension/src/extension.ts`, `extension/package.json`, `extension/test/graphEditor.test.ts`, `extension/test/statusBar.test.ts`

**Interfaces:**
- Consumes: the App session API and `app.sessionStore` (Task 6); `EngineEvents.sessions` (Task 6); `draftState` messages (Task 7).
- Produces:
  ```ts
  export type GraphTabInfo = { folderKey: string; graphId: string; group: number; index: number; active: boolean };
  export type SessionApp = Pick<App, 'listSessions' | 'createSession' | 'renameSession' | 'duplicateSession' | 'deleteSession' | 'saveSessionTabs' | 'sessionStore' | 'listGraphs'>;
  export type SessionsDeps = {
    folders(): Folder[];
    app(folder: Folder): SessionApp;
    graphTabs(): GraphTabInfo[];
    dirtyTabs(folderKey: string): number;
    closeGraphTabs(folderKey: string): Promise<void>;
    openGraphTab(folder: Folder, graphId: string, group: number, preserveFocus: boolean): Promise<void>;
    confirm(message: string, action: string): Promise<boolean>;
    info(message: string): void;
    memory: { get(key: string): string | undefined; update(key: string, value: string | undefined): PromiseLike<void> };
    changed(): void;
    debounceMs?: number;
  };
  export const activeSessionKey: (folderKey: string) => string; // `agentStream.activeSession:${folderKey}`
  export class SessionManager {
    active(folder: Folder): { id: string; name: string };
    scheduleCapture(): void;
    captureNow(): void;
    switchTo(folder: Folder, sessionId: string): Promise<boolean>;
    create(folder: Folder, name: string): Promise<string | undefined>;
    rename(folder: Folder, sessionId: string, name: string): { ok: true } | { ok: false; error: string };
    duplicate(folder: Folder, sessionId: string): { ok: true } | { ok: false; error: string };
    delete(folder: Folder, sessionId: string): Promise<void>;
  }
  export function sessionStatusText(name: string): { text: string; tooltip: string }; // statusBar.ts
  ```
- `GraphPanel.dirty: boolean` is set by the tab's `draftState`.
- The commands `agentStream.newSession`, `agentStream.switchSession`, `agentStream.renameSession`, `agentStream.duplicateSession` and `agentStream.deleteSession` accept a `SessionItem`, `{ folder, sessionId? }`, or no argument.
- `activate()` returns `{ engines, panels, sessions }`.

- [ ] **Step 1: Write the failing tests** — `extension/test/sessions.test.ts`

Use real engines for two temp folders (with `createApp`, `testProvider` and `signedIn`, as other extension tests do) and fakes for VS Code:

```ts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createApp, type App } from '@agent-stream/engine';
import type { Folder } from '../src/engines';
import { activeSessionKey, SessionManager, type GraphTabInfo } from '../src/sessions';
import { signedIn, testProvider } from './helpers';

function world() {
  const folders: Folder[] = ['a', 'b'].map((n) => {
    const path = mkdtempSync(join(tmpdir(), `cs-${n}-`));
    return { key: `file://${path}`, name: n, path };
  });
  const apps = new Map<string, App>(folders.map((f) => [f.key, createApp({ projectDir: f.path, valuesFile: join(mkdtempSync(join(tmpdir(), 'cs-home-')), 'values.json'), provider: testProvider(), status: signedIn, maxParallel: 1 })]));
  let tabs: GraphTabInfo[] = [];
  const calls: string[] = [];
  const memory = new Map<string, string | undefined>();
  const dirty = new Map<string, number>();
  const deps = {
    folders: () => folders,
    app: (f: Folder) => apps.get(f.key)!,
    graphTabs: () => tabs,
    dirtyTabs: (key: string) => dirty.get(key) ?? 0,
    closeGraphTabs: vi.fn(async (key: string) => {
      calls.push(`close ${key}`);
      tabs = tabs.filter((t) => t.folderKey !== key);
    }),
    openGraphTab: vi.fn(async (f: Folder, graphId: string, group: number, preserveFocus: boolean) => {
      calls.push(`open ${graphId}@${group}${preserveFocus ? '' : ' focus'}`);
      if (!tabs.some((t) => t.folderKey === f.key && t.graphId === graphId)) tabs.push({ folderKey: f.key, graphId, group, index: tabs.filter((t) => t.group === group).length, active: !preserveFocus });
    }),
    confirm: vi.fn(async () => true),
    info: vi.fn(),
    memory: { get: (k: string) => memory.get(k), update: async (k: string, v: string | undefined) => void memory.set(k, v) },
    changed: vi.fn(),
    debounceMs: 0,
  };
  const graph = (f: Folder, name: string) => apps.get(f.key)!.createGraph(name).id;
  const setTabs = (t: GraphTabInfo[]) => (tabs = t);
  return { folders, apps, deps, calls, memory, dirty, graph, setTabs, tabs: () => tabs, manager: new SessionManager(deps) };
}

describe('SessionManager', () => {
  it('starts on Default and records only graph tabs of each folder, re-indexed per group', () => {
    const w = world();
    const [a] = w.folders;
    const g1 = w.graph(a, 'One'), g2 = w.graph(a, 'Two');
    w.setTabs([{ folderKey: a.key, graphId: g2, group: 2, index: 3, active: false }, { folderKey: a.key, graphId: g1, group: 1, index: 5, active: true }]);
    w.manager.captureNow();
    expect(w.manager.active(a)).toEqual({ id: 'default', name: 'Default' });
    expect(w.apps.get(a.key)!.sessionStore.get('default')).toMatchObject({ tabs: [{ graphId: g1, group: 1, index: 0 }, { graphId: g2, group: 2, index: 0 }], activeGraphId: g1 });
  });

  it('switches: save, close, remember, open in order, then focus the active tab', async () => {
    const w = world();
    const [a] = w.folders;
    const g1 = w.graph(a, 'One'), g2 = w.graph(a, 'Two');
    const app = w.apps.get(a.key)!;
    const b = app.createSession('B');
    app.saveSessionTabs(b.id, [{ graphId: g2, group: 1, index: 0 }, { graphId: g1, group: 2, index: 0 }], g1);
    w.setTabs([{ folderKey: a.key, graphId: g1, group: 1, index: 0, active: true }]);
    expect(await w.manager.switchTo(a, b.id)).toBe(true);
    expect(w.calls).toEqual([`close ${a.key}`, `open ${g2}@1`, `open ${g1}@2`, `open ${g1}@2 focus`]);
    expect(w.memory.get(activeSessionKey(a.key))).toBe(b.id);
    expect(app.sessionStore.get('default').tabs).toEqual([{ graphId: g1, group: 1, index: 0 }]);
  });

  it('a declined unsaved-edits prompt changes nothing', async () => {
    const w = world();
    const [a] = w.folders;
    const app = w.apps.get(a.key)!;
    const b = app.createSession('B');
    w.dirty.set(a.key, 2);
    w.deps.confirm.mockResolvedValueOnce(false);
    expect(await w.manager.switchTo(a, b.id)).toBe(false);
    expect(w.deps.confirm).toHaveBeenCalledWith('Discard unsaved step edits in 2 tabs?', 'Discard');
    expect(w.calls).toEqual([]);
    expect(w.manager.active(a).id).toBe('default');
  });

  it('switching only touches its folder’s graph tabs', async () => {
    const w = world();
    const [a, bFolder] = w.folders;
    const ga = w.graph(a, 'One'), gb = w.graph(bFolder, 'One');
    w.setTabs([{ folderKey: a.key, graphId: ga, group: 1, index: 0, active: false }, { folderKey: bFolder.key, graphId: gb, group: 1, index: 1, active: true }]);
    const other = w.apps.get(a.key)!.createSession('Other');
    await w.manager.switchTo(a, other.id);
    expect(w.tabs().map((t) => `${t.folderKey === a.key ? 'a' : 'b'}:${t.graphId}`)).toEqual([`b:${gb}`]);
    expect(w.manager.active(bFolder).id).toBe('default');
  });

  it('skips graphs that no longer exist, with one notice', async () => {
    const w = world();
    const [a] = w.folders;
    const app = w.apps.get(a.key)!;
    const b = app.createSession('B');
    app.saveSessionTabs(b.id, [{ graphId: 'gone', group: 1, index: 0 }, { graphId: 'gone-too', group: 1, index: 1 }]);
    await w.manager.switchTo(a, b.id);
    expect(w.deps.info).toHaveBeenCalledWith('2 graphs in this session no longer exist and were skipped.');
    expect(app.sessionStore.get(b.id).tabs).toEqual([]);
  });

  it('deleting the active session switches first; deleting the last leaves an empty Default', async () => {
    const w = world();
    const [a] = w.folders;
    const app = w.apps.get(a.key)!;
    const b = app.createSession('B');
    await w.manager.switchTo(a, b.id);
    await w.manager.delete(a, b.id);
    expect(w.deps.confirm).toHaveBeenCalledWith('Delete B? Its planner chats are removed; graphs and runs stay.', 'Delete');
    expect(w.manager.active(a).id).toBe('default');
    expect(app.listSessions().map((s) => s.id)).toEqual(['default']);
    await w.manager.delete(a, 'default');
    expect(app.listSessions()).toEqual([expect.objectContaining({ id: 'default', name: 'Default', tabCount: 0 })]);
  });
});
```

Add `signedIn`/`testProvider` to `extension/test/helpers.ts`, mirroring the engine helpers; create the file if it doesn't exist.

`extension/test/sessionsView.test.ts`:
- One folder: sessions are listed with `$(check)`, i.e. `ThemeIcon('check')`, on the active one. The description is `1 tab`/`3 tabs`. The command is `agentStream.switchSession` with `{ folder, sessionId }`.
- An unreadable session gets contextValue `sessionBroken`, no command, and the description `Can't be read: …`.
- Two folders: the top level is the folders.

`extension/test/statusBar.test.ts`: `sessionStatusText('Default')` equals `{ text: '$(layers) Default', tooltip: 'Agent Stream session: Default. Click to switch.' }`.

`extension/test/graphEditor.test.ts`: a `draftState` message sets `panel.dirty`.

- [ ] **Step 2: Run them to verify they fail**

Run: `npm test -w extension -- sessions statusBar graphEditor`
Expected: FAIL.

- [ ] **Step 3: Implement `extension/src/sessions.ts`**

```ts
import type { App } from '@agent-stream/engine';
import type { Folder } from './engines';

export type GraphTabInfo = { folderKey: string; graphId: string; group: number; index: number; active: boolean };
export type SessionApp = Pick<App, 'listSessions' | 'createSession' | 'renameSession' | 'duplicateSession' | 'deleteSession' | 'saveSessionTabs' | 'sessionStore' | 'listGraphs'>;
export type SessionsDeps = {/* exactly as in Interfaces */};

export const activeSessionKey = (folderKey: string) => `agentStream.activeSession:${folderKey}`;
const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** Work sessions for every folder (sessions spec §5): which one is active, its tabs, and switching. */
export class SessionManager {
  private switching = false;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private d: SessionsDeps) {}

  active(folder: Folder): { id: string; name: string } {
    const app = this.d.app(folder);
    const readable = app.listSessions().filter((s) => !s.problem);
    const remembered = this.d.memory.get(activeSessionKey(folder.key));
    const hit = readable.find((s) => s.id === remembered) ?? readable[0];
    if (hit) return { id: hit.id, name: hit.name };
    const fresh = app.sessionStore.ensureDefault();
    return { id: fresh.id, name: fresh.name };
  }

  scheduleCapture(): void {
    if (this.switching) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.captureNow(), this.d.debounceMs ?? 500);
  }

  captureNow(): void {
    if (this.switching) return;
    clearTimeout(this.timer);
    const tabs = this.d.graphTabs();
    for (const folder of this.d.folders()) {
      const mine = tabs.filter((t) => t.folderKey === folder.key).sort((x, y) => x.group - y.group || x.index - y.index);
      const next = new Map<number, number>();
      const sessionTabs = mine.map((t) => {
        const index = next.get(t.group) ?? 0;
        next.set(t.group, index + 1);
        return { graphId: t.graphId, group: t.group, index };
      });
      this.d.app(folder).saveSessionTabs(this.active(folder).id, sessionTabs, mine.find((t) => t.active)?.graphId);
    }
  }

  async switchTo(folder: Folder, sessionId: string): Promise<boolean> {
    const app = this.d.app(folder);
    const target = app.sessionStore.load(sessionId);
    if (!target.ok) {
      this.d.info(target.error);
      return false;
    }
    if (!(await this.confirmDiscard(folder))) return false;
    this.captureNow();
    this.switching = true;
    let skipped = 0;
    try {
      await this.d.closeGraphTabs(folder.key);
      await this.d.memory.update(activeSessionKey(folder.key), sessionId);
      const existing = new Set(app.listGraphs().filter((g) => !g.error).map((g) => g.id));
      const tabs = [...target.session.tabs].sort((x, y) => x.group - y.group || x.index - y.index);
      for (const t of tabs) {
        if (existing.has(t.graphId)) await this.d.openGraphTab(folder, t.graphId, t.group, true);
        else skipped++;
      }
      const focus = tabs.find((t) => t.graphId === target.session.activeGraphId && existing.has(t.graphId));
      if (focus) await this.d.openGraphTab(folder, focus.graphId, focus.group, false);
    } finally {
      this.switching = false;
    }
    if (skipped) this.d.info(`${skipped} ${plural(skipped, 'graph', 'graphs')} in this session no longer ${plural(skipped, 'exists', 'exist')} and ${plural(skipped, 'was', 'were')} skipped.`);
    this.captureNow();
    this.d.changed();
    return true;
  }

  async create(folder: Folder, name: string): Promise<string | undefined> {
    const session = this.d.app(folder).createSession(name);
    return (await this.switchTo(folder, session.id)) ? session.id : undefined;
  }

  rename(folder: Folder, sessionId: string, name: string) {
    const r = this.d.app(folder).renameSession(sessionId, name);
    this.d.changed();
    return r.ok ? { ok: true as const } : r;
  }

  duplicate(folder: Folder, sessionId: string) {
    const r = this.d.app(folder).duplicateSession(sessionId);
    this.d.changed();
    return r.ok ? { ok: true as const } : r;
  }

  async delete(folder: Folder, sessionId: string): Promise<void> {
    const app = this.d.app(folder);
    const item = app.listSessions().find((s) => s.id === sessionId);
    if (!item) return;
    if (!(await this.d.confirm(`Delete ${item.name}? Its planner chats are removed; graphs and runs stay.`, 'Delete'))) return;
    const isActive = this.active(folder).id === sessionId;
    const other = app.listSessions().find((s) => s.id !== sessionId && !s.problem);
    if (isActive && other && !(await this.switchTo(folder, other.id))) return;
    if (isActive && !other) {
      if (!(await this.confirmDiscard(folder))) return;
      this.switching = true;
      try {
        await this.d.closeGraphTabs(folder.key);
      } finally {
        this.switching = false;
      }
    }
    const r = app.deleteSession(sessionId);
    if (!r.ok) this.d.info(r.error);
    if (!app.listSessions().some((s) => !s.problem)) {
      const fresh = app.sessionStore.ensureDefault();
      await this.d.memory.update(activeSessionKey(folder.key), fresh.id);
    }
    this.d.changed();
  }

  private async confirmDiscard(folder: Folder): Promise<boolean> {
    const dirty = this.d.dirtyTabs(folder.key);
    return dirty === 0 || this.d.confirm(`Discard unsaved step edits in ${dirty} ${plural(dirty, 'tab', 'tabs')}?`, 'Discard');
  }
}
```

- [ ] **Step 4: Implement the view, the status text and the wiring**

`extension/src/statusBar.ts`:

```ts
export function sessionStatusText(name: string): { text: string; tooltip: string } {
  return { text: `$(layers) ${name}`, tooltip: `Agent Stream session: ${name}. Click to switch.` };
}
```

`extension/src/sessionsView.ts`: a `TreeDataProvider` with `FolderNode` items, shown when there is more than one folder, and `SessionItem` items:
- `SessionItem(folder, session: SessionListItem, active: boolean)`;
- label `session.name`;
- description `` `${n} ${n === 1 ? 'tab' : 'tabs'}` `` or `` `Can't be read: ${problem}` ``;
- `iconPath` is `new vscode.ThemeIcon(active ? 'check' : 'layers')`;
- `contextValue` is `problem ? 'sessionBroken' : 'session'`;
- `command` is `{ command: 'agentStream.switchSession', title: 'Switch Session', arguments: [{ folder, sessionId }] }` unless the session is broken;
- `refresh()` fires `onDidChangeTreeData`.

Its source is `{ folders(), sessions(folder): SessionListItem[], active(folder): string }`.

`extension/src/graphEditor.ts`: `GraphPanel` gains `dirty = false`. `createMessageHandler` handles `case 'draftState': d.panel.dirty = msg.dirty; return;`.

In `extension/src/extension.ts`, build the `SessionManager` with VS Code deps:
- `graphTabs()` iterates `vscode.window.tabGroups.all`:
  ```ts
  for (const group of vscode.window.tabGroups.all) group.tabs.forEach((tab, index) => {
    if (!(tab.input instanceof vscode.TabInputCustom) || tab.input.viewType !== GRAPH_VIEW_TYPE) return;
    const folder = folderFor(tab.input.uri);
    const graphId = folder && graphTarget(folder.path, tab.input.uri.fsPath);
    if (folder && graphId) out.push({ folderKey: folder.key, graphId, group: group.viewColumn, index, active: group.isActive && tab.isActive });
  });
  ```
- `dirtyTabs(key)` counts `panels.all().filter((p) => p.folder.key === key && p.dirty)`.
- `closeGraphTabs(key)` collects the matching `vscode.Tab`s, then calls `await vscode.window.tabGroups.close(tabs)`.
- `openGraphTab` runs:
  ```ts
  vscode.commands.executeCommand('vscode.openWith', graphUri(folder, graphId), GRAPH_VIEW_TYPE, { viewColumn: group, preview: false, preserveFocus })
  ```
- `confirm(message, action)` is `(await vscode.window.showWarningMessage(message, { modal: true }, action)) === action`.
- `info` is `showInformationMessage`.
- `memory` is `context.workspaceState`.
- `changed` refreshes the Sessions view and the session status item.

Then:
- `vscode.window.tabGroups.onDidChangeTabs(() => sessions.scheduleCapture())` and `onDidChangeTabGroups(() => sessions.scheduleCapture())`.
- `events.sessions` calls `changed`.
- The session status bar item has priority 99 and command `agentStream.switchSession`. It shows the active session of the active graph tab's folder, or of the only folder. It is hidden when there's no folder.

The session commands each resolve `{ folder, sessionId? }` from their argument, which is a `SessionItem`, an object or nothing:
- the folder comes from the argument, else the active graph panel's folder, else the only folder, else `showQuickPick` of folders;
- the session comes from the argument, else a quick pick of `listSessions()`, plus `New Session…` for switch;
- `newSession` asks for a name with `showInputBox`. The validation rejects a blank name with "A session needs a name.";
- `renameSession` uses `showInputBox` prefilled with the current name;
- `duplicateSession` and `deleteSession` call the manager.

Add `sessions` to `activate()`'s return value.

`extension/package.json`:
- `views.agentStream` order: `agentStream.graphs`, `{ "id": "agentStream.sessions", "name": "Sessions" }`, `agentStream.approvals`.
- Five commands, each with `"category": "Agent Stream"`:
  - `newSession` "New Session", icon `$(add)`;
  - `switchSession` "Switch Session";
  - `renameSession` "Rename Session";
  - `duplicateSession` "Duplicate Session";
  - `deleteSession` "Delete Session".
- `menus.view/title`: `agentStream.newSession` when `view == agentStream.sessions`, group `navigation`.
- `menus.view/item/context`:
  - rename and duplicate when `view == agentStream.sessions && viewItem == session`;
  - delete when `view == agentStream.sessions && viewItem =~ /^session/`.

- [ ] **Step 5: Verify**

Run: `npm test && npm run typecheck && npm run build -w extension`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add extension
git commit -m "feat(extension): work sessions — tab sets, switching, Sessions view and status"
```

---

### Task 9: Extension — the chat view in the secondary side bar

**Files:**
- Create: `extension/src/chatView.ts`, `extension/test/chatView.test.ts`
- Modify: `extension/src/webviewHtml.ts`, `extension/test/webviewHtml.test.ts`, `extension/src/extension.ts`, `extension/package.json` (contribution, engines), the root `package-lock.json` (through `npm install`)

**Interfaces:**
- Consumes: `SessionManager.active` (Task 8); `chatTarget`/`chatCommand` (Task 7); `openChat`/`newChat`/`chatOpened` (Task 6).
- Produces:
  - `webviewHtml({ …, view: 'graph' | 'chat', graphId?: string })` writes `data-view`; `data-graph-id` is omitted when there's no graph ID.
  - `class ChatViewController` with `activate(active?: ChatSource, open: ChatSource[])`, `refresh(open: ChatSource[])`, `attach(post)`, `handle(raw)` and `dispose()`, where `ChatSource = { folder: Folder; graphId: string }`.
  - `class ChatViewProvider implements vscode.WebviewViewProvider`.
  - The commands `agentStream.focusChat` and `agentStream.chat.focus` (contributed by VS Code for the view).
- **Ruling P1:** `engines.vscode` becomes `^1.106.0` and `@types/vscode` becomes `~1.106.0`.

- [ ] **Step 1: Write the failing tests** — `extension/test/chatView.test.ts`

```ts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '@agent-stream/engine';
import type { HostMessage } from '@agent-stream/shared';
import { ChatViewController } from '../src/chatView';
import type { Folder } from '../src/engines';
import { signedIn, testProvider } from './helpers';

function setup() {
  const path = mkdtempSync(join(tmpdir(), 'cs-chat-'));
  const folder: Folder = { key: `file://${path}`, name: 'a', path };
  const app = createApp({ projectDir: path, valuesFile: join(mkdtempSync(join(tmpdir(), 'cs-home-')), 'values.json'), provider: testProvider(), status: signedIn, maxParallel: 1 });
  const g1 = app.createGraph('Orders').id;
  const g2 = app.createGraph('Billing').id;
  let session = { id: 'default', name: 'Default' };
  const posted: HostMessage[] = [];
  const confirm = vi.fn(async () => true);
  const switchSession = vi.fn();
  const handle = vi.spyOn(app, 'handle');
  const chat = new ChatViewController({ app: () => app, sessions: { active: () => session }, confirm, switchSession, error: vi.fn() });
  chat.attach((m) => posted.push(m));
  const targets = () => posted.filter((m) => m.type === 'chatTarget');
  return { app, folder, g1, g2, chat, posted, targets, confirm, switchSession, handle, setSession: (s: typeof session) => (session = s) };
}

describe('ChatViewController', () => {
  it('follows the active graph tab and opens its conversation in the folder’s session', async () => {
    const s = setup();
    s.chat.activate({ folder: s.folder, graphId: s.g1 }, [{ folder: s.folder, graphId: s.g1 }]);
    await vi.waitFor(() => expect(s.posted.some((m) => m.type === 'chatOpened')).toBe(true));
    expect(s.targets().at(-1)).toEqual({ type: 'chatTarget', target: { graphId: s.g1, graphName: 'Orders', sessionId: 'default', sessionName: 'Default' } });
    expect(s.posted.find((m) => m.type === 'chatOpened')).toMatchObject({ graphId: s.g1, sessionId: 'default' });
  });

  it('keeps the last graph while a non-graph editor is active', () => {
    const s = setup();
    const open = [{ folder: s.folder, graphId: s.g1 }];
    s.chat.activate({ folder: s.folder, graphId: s.g1 }, open);
    const before = s.targets().length;
    s.chat.activate(undefined, open);
    expect(s.targets()).toHaveLength(before);
  });

  it('moves to the most recent other graph tab when its tab closes, and is empty with none', () => {
    const s = setup();
    const both = [{ folder: s.folder, graphId: s.g1 }, { folder: s.folder, graphId: s.g2 }];
    s.chat.activate({ folder: s.folder, graphId: s.g2 }, both);
    s.chat.activate({ folder: s.folder, graphId: s.g1 }, both);
    s.chat.refresh([{ folder: s.folder, graphId: s.g2 }]);
    expect(s.targets().at(-1)).toMatchObject({ target: { graphId: s.g2 } });
    s.chat.refresh([]);
    expect(s.targets().at(-1)).toEqual({ type: 'chatTarget' });
  });

  it('falls back to empty when its graph goes away', async () => {
    const s = setup();
    s.chat.activate({ folder: s.folder, graphId: s.g1 }, [{ folder: s.folder, graphId: s.g1 }]);
    expect(s.app.deleteGraph(s.g1)).toEqual({ ok: true });
    s.chat.refresh([{ folder: s.folder, graphId: s.g1 }]); // the tab may still be closing
    expect(s.targets().at(-1)).toEqual({ type: 'chatTarget' });
    s.handle.mockClear();
    s.chat.handle({ type: 'chat', graphId: s.g1, sessionId: 'default', text: 'hi' });
    expect(s.handle).not.toHaveBeenCalled();
  });

  it('re-subscribes when the folder’s session changes', async () => {
    const s = setup();
    const b = s.app.createSession('B');
    const open = [{ folder: s.folder, graphId: s.g1 }];
    s.chat.activate({ folder: s.folder, graphId: s.g1 }, open);
    s.setSession({ id: b.id, name: 'B' });
    s.chat.refresh(open);
    await vi.waitFor(() => expect(s.posted.filter((m) => m.type === 'chatOpened').at(-1)).toMatchObject({ sessionId: b.id }));
  });

  it('confirms New chat and runs Switch Session for the header buttons', async () => {
    const s = setup();
    s.chat.activate({ folder: s.folder, graphId: s.g1 }, [{ folder: s.folder, graphId: s.g1 }]);
    s.chat.handle({ type: 'chatCommand', command: 'newChat' });
    await vi.waitFor(() => expect(s.handle).toHaveBeenCalledWith(expect.anything(), { type: 'newChat', graphId: s.g1, sessionId: 'default' }));
    expect(s.confirm).toHaveBeenCalledWith('Start a new conversation? This clears the planner chat for Orders in Default.', 'New chat');
    s.chat.handle({ type: 'chatCommand', command: 'switchSession' });
    expect(s.switchSession).toHaveBeenCalledWith(s.folder);
  });

  it('refuses chat for a conversation it is not showing', () => {
    const s = setup();
    s.chat.activate({ folder: s.folder, graphId: s.g1 }, [{ folder: s.folder, graphId: s.g1 }]);
    s.handle.mockClear();
    s.chat.handle({ type: 'chat', graphId: s.g2, sessionId: 'default', text: 'hi' });
    expect(s.handle).not.toHaveBeenCalled();
    expect(s.posted.at(-1)).toEqual({ type: 'error', message: 'This chat is no longer open.' });
  });
});
```

`extension/test/webviewHtml.test.ts`:
- `view: 'chat'` produces `data-view="chat"` and no `data-graph-id`;
- `view: 'graph'` keeps `data-graph-id`;
- the CSP is unchanged.

- [ ] **Step 2: Run them to verify they fail**

Run: `npm test -w extension -- chatView webviewHtml`
Expected: FAIL.

- [ ] **Step 3: Implement `extension/src/chatView.ts`**

```ts
import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import type { App, Client } from '@agent-stream/engine';
import { parseWebviewMessage, type HostMessage } from '@agent-stream/shared';
import type { Folder } from './engines';
import { webviewHtml } from './webviewHtml';

export type ChatSource = { folder: Folder; graphId: string };
export type ChatViewDeps = {
  app(folder: Folder): App;
  sessions: { active(folder: Folder): { id: string; name: string } };
  confirm(message: string, action: string): Promise<boolean>;
  switchSession(folder: Folder): void;
  error(message: string): void;
};
type Target = { folder: Folder; graphId: string; graphName: string; sessionId: string; sessionName: string };
const same = (a: ChatSource, b: ChatSource) => a.folder.key === b.folder.key && a.graphId === b.graphId;

/** What the chat view shows (sessions spec §6): the active graph tab's conversation in its folder's active session. */
export class ChatViewController {
  private post: (msg: HostMessage) => void = () => {};
  private recent: ChatSource[] = [];
  private target: Target | undefined;
  private detach: (() => void) | undefined;
  private client: Client = { send: (msg) => this.post(msg) };

  constructor(private d: ChatViewDeps) {}

  attach(post: (msg: HostMessage) => void): void {
    this.post = post;
  }

  /** A tab became active (`active` undefined: not a graph tab). `open` lists the graph tabs open now. */
  activate(active: ChatSource | undefined, open: ChatSource[]): void {
    if (active) this.recent = [active, ...this.recent.filter((r) => !same(r, active))];
    this.refresh(open);
  }

  /** Re-evaluate after tabs closed, a session switched, or a graph was renamed or deleted. */
  refresh(open: ChatSource[]): void {
    this.recent = this.recent.filter((r) => open.some((o) => same(o, r)));
    const next = this.recent.find((r) => this.d.app(r.folder).listGraphs().some((g) => g.id === r.graphId && !g.error));
    this.show(next);
  }

  /** The webview (re)loaded: send it the current conversation again. */
  ready(): void {
    const current = this.target;
    this.target = undefined;
    this.show(current && { folder: current.folder, graphId: current.graphId });
  }

  handle(raw: unknown): void {
    const parsed = parseWebviewMessage(raw);
    if (!parsed.ok) return this.post({ type: 'error', message: `Agent Stream ignored a malformed message: ${parsed.error}` });
    const msg = parsed.msg;
    if (msg.type === 'ready') return this.ready();
    const t = this.target;
    if (msg.type === 'chatCommand') {
      if (!t) return;
      if (msg.command === 'switchSession') return this.d.switchSession(t.folder);
      void this.d.confirm(`Start a new conversation? This clears the planner chat for ${t.graphName} in ${t.sessionName}.`, 'New chat').then((yes) => {
        if (yes && this.target === t) void this.d.app(t.folder).handle(this.client, { type: 'newChat', graphId: t.graphId, sessionId: t.sessionId });
      });
      return;
    }
    if (msg.type === 'chat') {
      if (!t || msg.graphId !== t.graphId || msg.sessionId !== t.sessionId) return this.post({ type: 'error', message: 'This chat is no longer open.' });
      void this.d.app(t.folder).handle(this.client, msg);
      return;
    }
    this.post({ type: 'error', message: `The chat view can't send ${msg.type}.` });
  }

  dispose(): void {
    this.detach?.();
    this.detach = undefined;
  }

  private show(source: ChatSource | undefined): void {
    const graph = source && this.d.app(source.folder).listGraphs().find((g) => g.id === source.graphId && !g.error);
    if (!source || !graph) {
      this.dispose();
      this.target = undefined;
      this.post({ type: 'chatTarget' });
      return;
    }
    const session = this.d.sessions.active(source.folder);
    const next: Target = { folder: source.folder, graphId: source.graphId, graphName: graph.name, sessionId: session.id, sessionName: session.name };
    const cur = this.target;
    const sameConversation = !!cur && cur.folder.key === next.folder.key && cur.graphId === next.graphId && cur.sessionId === next.sessionId;
    // Nothing to tell the view when the conversation and its names are unchanged.
    if (cur && sameConversation && cur.graphName === next.graphName && cur.sessionName === next.sessionName) return;
    this.target = next;
    this.post({ type: 'chatTarget', target: { graphId: next.graphId, graphName: next.graphName, sessionId: next.sessionId, sessionName: next.sessionName } });
    if (sameConversation) return;
    this.dispose();
    const app = this.d.app(next.folder);
    this.detach = app.connect(this.client);
    void app.handle(this.client, { type: 'openChat', graphId: next.graphId, sessionId: next.sessionId });
  }
}

/** The "Agent Stream Chat" view (a webview in the secondary side bar). */
export class ChatViewProvider implements vscode.WebviewViewProvider {
  constructor(
    private extensionUri: vscode.Uri,
    private controller: ChatViewController,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    const root = vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview');
    view.webview.options = { enableScripts: true, localResourceRoots: [root] };
    const asset = (name: string) => view.webview.asWebviewUri(vscode.Uri.joinPath(root, 'assets', name)).toString();
    view.webview.html = webviewHtml({ cspSource: view.webview.cspSource, scriptUri: asset('index.js'), styleUri: asset('index.css'), nonce: randomBytes(16).toString('hex'), view: 'chat', minimap: false });
    this.controller.attach((msg) => void view.webview.postMessage(msg));
    const sub = view.webview.onDidReceiveMessage((raw) => this.controller.handle(raw));
    view.onDidDispose(() => {
      sub.dispose();
      this.controller.dispose();
      this.controller.attach(() => {});
    });
  }
}
```

`extension/src/webviewHtml.ts`: `WebviewPage` gains `view: 'graph' | 'chat'`, and `graphId` becomes optional. The body tag is:

```ts
`<body data-view="${p.view}"${p.graphId !== undefined ? ` data-graph-id="${escapeHtml(p.graphId)}"` : ''} data-minimap="${p.minimap}">`
```

`GraphEditorProvider` passes `view: 'graph'`.

- [ ] **Step 4: Wire it and declare it**

`extension/src/extension.ts`:
- Build the `ChatViewController` with:
  - `app: (f) => manager.get(f)`;
  - `sessions`, the Task 8 manager;
  - `confirm`: a modal `showWarningMessage`;
  - `switchSession: (folder) => vscode.commands.executeCommand('agentStream.switchSession', { folder })`;
  - `error`: `showErrorMessage`.
- Register it with:
  ```ts
  vscode.window.registerWebviewViewProvider('agentStream.chat', new ChatViewProvider(context.extensionUri, chat), { webviewOptions: { retainContextWhenHidden: true } })
  ```
- Add a helper `graphSources()`, which returns the open graph tabs as `ChatSource[]` (reuse the Task 8 tab walk), and `activeGraphSource()`, which reads `vscode.window.tabGroups.activeTabGroup.activeTab`.
- Call `chat.activate(activeGraphSource(), graphSources())` on `tabGroups.onDidChangeTabs` and `onDidChangeTabGroups`. Call it once at activation too.
- Call `chat.refresh(graphSources())` from the session manager's `changed`, from `events.graphs` (renames) and from `events.graphDeleted`.
- Register `agentStream.focusChat` → `vscode.commands.executeCommand('agentStream.chat.focus')`.

`extension/package.json`:

```json
"engines": { "vscode": "^1.106.0" },
"viewsContainers": {
  "activitybar": [ { "id": "agentStream", "title": "Agent Stream", "icon": "media/icon.svg" } ],
  "secondarySidebar": [ { "id": "agentStreamChat", "title": "Agent Stream Chat", "icon": "media/icon.svg" } ]
},
"views": {
  "agentStream": [ "…graphs, sessions, approvals as in Task 8…" ],
  "agentStreamChat": [ { "type": "webview", "id": "agentStream.chat", "name": "Chat" } ]
}
```

Add the command `{ "command": "agentStream.focusChat", "title": "Show Chat", "category": "Agent Stream" }`. In the `extension` workspace `devDependencies`, set `"@types/vscode": "~1.106.0"`, then run `npm install` from the repo root (the lockfile changes only for `@types/vscode`). Check that `npm run package` still passes `check-vsix.mjs`.

- [ ] **Step 5: Verify**

Run: `npm test && npm run typecheck && npm run package`
Expected: PASS, and the `.vsix` is still universal.

- [ ] **Step 6: Commit**

```bash
git add extension package-lock.json
git commit -m "feat(extension): planner chat view in the secondary side bar, following the active graph"
```

---

### Task 10: Integration test and screenshots

**Files:**
- Modify: `extension/test/integration/runTest.mjs`, `extension/test/integration/suite.cjs`, `extension/scripts/screenshots.mjs`

**Interfaces:**
- Consumes: `activate()` returning `{ engines, panels, sessions }` (Task 8). It also consumes the App's `sessionStore`, `createSession`, `saveSessionTabs` (Task 6) and `EngineManager.status` (Task 4).

- [ ] **Step 1: A second graph in the test workspace**

In `runTest.mjs`, write `second.json` next to `demo.json`: same shape, `id: 'second'`, `name: 'Second'`, one command step `echo second`. In `suite.cjs`, the graph-list assertion becomes `assert.deepEqual(app.listGraphs().map((g) => g.id).sort(), ['demo', 'second']);`.

- [ ] **Step 2: Add the provider check to `suite.cjs`**

Put it after the graph tab has loaded and before the signed-in run checks:

```js
// Providers: GitHub Copilot is selectable. In CI and in this fresh profile there is no signed-in
// Copilot, so its status can't run, and a run is refused with the provider's own reason.
const config = () => vscode.workspace.getConfiguration('agentStream');
await config().update('provider', 'copilot', vscode.ConfigurationTarget.Global);
await waitFor(() => api.engines.status.provider === 'copilot' && api.engines.status.label !== 'checking', 'the Copilot status');
assert.equal(api.engines.status.ok, false);
const probe = [];
const probeClient = { send: (m) => probe.push(m) };
const detachProbe = app.connect(probeClient);
await app.handle(probeClient, { type: 'startRun', graphId: 'demo', reviewed: 'x' });
assert.equal(probe.find((m) => m.type === 'error').message, `Runs are disabled: ${api.engines.status.error}`);
detachProbe();
await config().update('provider', undefined, vscode.ConfigurationTarget.Global);
await waitFor(() => api.engines.status.provider === 'claude' && api.engines.status.label !== 'checking', 'the Claude status again');
```

- [ ] **Step 3: Add the sessions check to `suite.cjs`**

```js
// Work sessions: the tab set comes back per session, and conversations stay apart.
const uriOf = (id) => vscode.Uri.joinPath(wf.uri, '.agent-stream', 'graphs', `${id}.json`);
await vscode.commands.executeCommand('vscode.openWith', uriOf('second'), 'agentStream.graph', { viewColumn: vscode.ViewColumn.Two, preview: false });
await waitFor(() => api.panels.get(folder.key, 'second')?.isLoaded, 'the second graph tab');
api.sessions.captureNow();
const sessionB = app.createSession('Integration B');
app.saveSessionTabs(sessionB.id, [{ graphId: 'demo', group: 1, index: 0 }], 'demo');
assert.equal(await api.sessions.switchTo(folder, sessionB.id), true);
await waitFor(() => !api.panels.get(folder.key, 'second') && api.panels.get(folder.key, 'demo'), "session B's tabs");
assert.equal(await api.sessions.switchTo(folder, 'default'), true);
await waitFor(() => api.panels.get(folder.key, 'second') && api.panels.get(folder.key, 'demo'), "Default's tabs again");
const columnOf = (label) => vscode.window.tabGroups.all.find((g) => g.tabs.some((t) => t.label.startsWith(label)))?.viewColumn;
assert.equal(columnOf('second'), vscode.ViewColumn.Two);
app.sessionStore.chatLog('default').append('demo', { at: new Date().toISOString(), role: 'user', text: 'only in Default' });
const chats = [];
const chatClient = { send: (m) => chats.push(m) };
const detachChat = app.connect(chatClient);
await app.handle(chatClient, { type: 'openChat', graphId: 'demo', sessionId: sessionB.id });
assert.deepEqual(chats.find((m) => m.type === 'chatOpened').chat, []);
detachChat();
```

Tab labels are the custom editor's titles, which are the file names (`demo.json`, `second.json`), hence `startsWith`.

- [ ] **Step 4: Run it**

Run: `npm run test:integration -w extension`
Expected: exit code 0. If Claude is signed in on this machine, the existing run check executes as before. Then run it once with `AGENT_STREAM_LIVE=1` as well; the agent-step check must still pass.

- [ ] **Step 5: Screenshots**

Extend `extension/scripts/screenshots.mjs` with three more shots per theme:
1. **`chat-view`:** the graph tab with the Agent Stream Chat view open in the secondary side bar.
   - Open the side bar by clicking the "Agent Stream Chat" container in the workbench DOM, as the script already does for the activity bar.
   - If it's hidden, first write `"workbench.secondarySideBar.defaultVisibility": "visible"` into the profile's `settings.json`.
   - Type nothing into the chat.
2. **`sessions-view`:** the Agent Stream sidebar with the Sessions view showing `Default` (✓) and a second session created by the script through the engine's session store files. Write a `session.json` under the sample workspace's `.agent-stream/sessions/review/` before launching.
3. **`provider-pick`:** click the provider status bar item, so its quick pick is open.

Take all of them and Read each PNG. Check them against the specs:
- the chat header shows the graph name, the session, and New chat;
- the graph tab's right panel shows only Node · Graph;
- the Sessions view marks the active session;
- the status bar shows `$(layers) Default`;
- the quick pick lists Claude (✓) and GitHub Copilot, with their statuses, and Check again.

Fix real defects (with a test where testable) in separate `fix(…)` commits.

- [ ] **Step 6: Commit**

```bash
git add extension/test/integration extension/scripts/screenshots.mjs
git commit -m "test(extension): integration and screenshots for providers, sessions and the chat view"
```

---

### Task 11: Provider-agnostic documentation

**Files:**
- Modify: `README.md`, `extension/README.md`, `docs/windows-checklist.md`, `extension/package.json` (`description`, `keywords`)

The user asked for the README and the docs to say plainly that Agent Stream is now provider-agnostic. Check every claim against the code before committing: setting names and defaults, command titles, file layout, the minimum VS Code version, and the Claude environment rules.

- [ ] **Step 1: Rewrite the top of `README.md`**

```markdown
# Agent Stream

Agent Stream is an independent project. It is not made, endorsed or supported by Anthropic or GitHub.

A VS Code extension where you and an AI planner co-create a workflow as a graph, then run it step by step on your own AI subscription. Agent Stream is **provider-agnostic**: agent steps and the planner run on the provider you choose. Today that is **Claude** (your Claude subscription through Claude Code), with **GitHub Copilot** available as a preview. Every file edit, shell command or other non-read-only action an agent step attempts waits for your approval, whichever provider runs it, and every step keeps its own logs.
```

- [ ] **Step 2: Requirements, Use, Providers, Settings and Files**

**Requirements:**
- VS Code **1.106** or newer, on macOS or Windows. Linux works the same way as macOS.
- One provider:
  - **Claude:** Claude Code installed and signed in with your Claude account (run `claude`, then `/login`). Check with `claude auth status`.
  - **GitHub Copilot (preview):** the GitHub Copilot extension installed and signed in. Agent Stream detects your Copilot models. Running steps with Copilot comes in a later version.
- Windows only: Git for Windows, which provides Git Bash for command steps.

**Use:**
- **Agent Stream sidebar:**
  - **Graphs:** New, Import, and right-click for Open, Rename, Duplicate, Export, Delete.
  - **Sessions:** New Session, click to switch, right-click for Rename, Duplicate, Delete.
  - **Approvals:** Approve, Deny, Approve all.
- **Chat view:** the **Agent Stream Chat** view on the right, next to VS Code's own Chat. It shows the planner conversation for the graph tab you're on, in the current session. **New chat** starts over; the session button switches session.
- **Graph tab:** the canvas, the logs of the selected step underneath, and Node · Graph on the right. The menu bar has File, Edit, Run, Variables and View, with View › Chat opening the chat view.
- **Work sessions:**
  - A session is a named set of open graph tabs plus its own planner conversations.
  - Switching a session closes the current graph tabs and brings back the other session's tabs, splits and chats.
  - Sessions are personal: they stay in `.agent-stream/sessions/`, which git ignores.
- **Status bar:** the provider your steps run on (for example `Claude Max` or `Copilot (preview)`) and the current session (`Default`). Click either one to change it.
- Keep the existing **Variables**, **Run** and **Export / Import** bullets unchanged.

**Providers.** This section replaces "Your Claude subscription":

```markdown
## Providers

Choose the provider with **Agent Stream: Select Provider** (or click the provider in the status bar), or set `agentStream.provider`. Graph files never name a provider, so a graph built on one provider runs on another. A run keeps the provider it started with; the planner starts a fresh conversation when you switch providers.

### Claude

Agent Stream runs your installed, signed-in Claude Code through the Claude Agent SDK. It never reads or stores your credentials. It removes `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL` and `CLAUDE_CODE_USE_*` from every agent's environment, checks `claude auth status`, and stops any session that reports an API key instead of your subscription. It refuses to run in a project whose `.claude/settings.json` would route Claude elsewhere.

### GitHub Copilot (preview)

Agent Stream finds your Copilot models through VS Code's Language Model API and shows them in the status bar tooltip. In this version Copilot can't run steps or the planner yet: runs and chat explain that and point you back to Claude. Agent Stream sends no requests to Copilot, so VS Code doesn't ask you to allow it yet.
```

**Settings:**
- `agentStream.provider`: `claude` (default) or `copilot` (preview).
- `agentStream.claudePath`: Claude provider only. Claude Code's full path if it isn't found automatically.
- Keep `gitBashPath` and `maxParallel` as they are.

**Files it writes.** Add `sessions/<id>/` ("your work sessions: open tabs and planner chats (git-ignored)") and remove `graphs/<id>.chat.jsonl`. Add one sentence: "Older planner chats move into a session called Default the first time a folder is opened."

- [ ] **Step 3: `extension/README.md`, the checklist and the manifest**

- **`extension/README.md`** (the Marketplace page) gets the same intro, independence line, Requirements, Use, Providers, Settings and Files sections. It has no Development section.
- **`docs/windows-checklist.md`** gets three new steps, with the later steps renumbered:
  - "Run **Agent Stream: Select Provider** and choose GitHub Copilot. The status bar shows `Copilot (preview)` or `Copilot not available`, Run is refused with the Copilot message, and Chat is disabled with it. Switch back to Claude; the status bar shows your plan again."
  - "Create a second session from the Sessions view with one graph open in a split, switch back and forth: the right tabs and splits come back each time."
  - "Open the Agent Stream Chat view: it follows the active graph tab; New chat asks first, then clears that conversation only."
- **`extension/package.json`:**
  - `"description": "Co-create a workflow graph with an AI planner and run it step by step on your own AI subscription: Claude today, GitHub Copilot in preview."`
  - `"keywords": ["ai", "agent", "workflow", "planner", "claude", "copilot"]`

- [ ] **Step 4: Verify the claims and the package**

Run: `npm test && npm run typecheck && npm run package && unzip -p extension/agent-stream-0.2.0.vsix extension/readme.md | head -20`
Expected: PASS. The packaged README opens with the provider-agnostic intro. `git grep -n "your Claude subscription" -- README.md extension/README.md` matches only inside the Providers › Claude section.

- [ ] **Step 5: Commit**

```bash
git add README.md extension/README.md docs/windows-checklist.md extension/package.json
git commit -m "docs: Agent Stream is provider-agnostic; sessions and the chat view"
```
