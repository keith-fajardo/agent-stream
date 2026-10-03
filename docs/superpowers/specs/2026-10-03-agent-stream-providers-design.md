# Agent Stream — provider-agnostic agents (Claude now, Copilot scaffold)

**Date:** 2026-10-03
**Status:** Approved in conversation (sections 1–4); written for review
**Builds on:** `2026-10-02-claude-stream-vscode-design.md` (the VS Code extension, since renamed Agent Stream)

## 1. Purpose

Agent Stream runs every agent step and the planner on the user's Claude subscription. The user wants it to be
**provider agnostic**, so that people with other AI subscriptions can use it. GitHub Copilot is the second
provider. In this round Copilot is a **scaffold**: it is a real, selectable provider whose availability is
detected, but it can't run steps or the planner yet.

Success:
- All of today's Claude behaviour is unchanged: agent steps, the planner, approvals, privacy rules,
  subscription checks and the tests that pin them.
- Claude sits behind a provider interface that a second provider can implement without touching the
  engine's runner, approvals, variables or UI.
- A user can switch the provider to Copilot in settings or through a command. The status bar then shows
  whether Copilot models are available, and Run and Chat are refused with a clear message.

## 2. Decisions

| Topic | Decision |
|---|---|
| Copilot scope this round | Selectable, not runnable. Status detection only; steps and planner refuse. |
| Where the provider is chosen | VS Code setting `agentStream.provider` (`claude` default, `copilot`). Can be set per user or per workspace. Graph files stay provider-neutral. |
| Architecture | **Provider per agent session**. Each provider owns its agent loop behind one interface. Approvals and privacy go through a shared, provider-neutral `ToolGate`. |
| Copilot API (later rounds) | VS Code Language Model API (`vscode.lm`) with the user's Copilot subscription. The provider lives in the extension package. |
| Claude | Moves behind the interface without behaviour changes. Its subscription rules stay Claude-specific. |

## 3. Architecture

### 3.1 Provider interface (`engine/src/providers/types.ts`)

```ts
export type ProviderId = 'claude' | 'copilot';

/** Replaces AuthInfo: what the status bar, the sidebar and the webview show. */
export type ProviderStatus = {
  provider: ProviderId;
  ok: boolean;              // true = runs and chat are allowed
  label: string;            // "Claude Max", "Copilot (preview)", "Copilot not available"
  detail?: string;          // tooltip: account, or the models VS Code reports
  error?: string;           // why runs and chat are refused (shown verbatim)
};

export interface AgentProvider {
  readonly id: ProviderId;
  readonly name: string;    // "Claude", "GitHub Copilot"
  status(): Promise<ProviderStatus>;
  /** A folder-specific reason this provider can't run there (Claude: .claude/settings.json reroute). */
  folderProblem?(projectDir: string): string | undefined;
  runStep(ctx: NodeContext, gate: ToolGate): Promise<NodeOutcome>;
  planTurn(turn: PlannerTurn): Promise<PlannerTurnResult>;
}
```

- `NodeContext` and `NodeOutcome` are today's types from `executors.ts`.
- The `NodeExecutor` for agent steps becomes `(ctx) => provider.runStep(ctx, gate)`. The provider is
  captured when the run starts (§6).

### 3.2 Tool gate (`engine/src/providers/toolGate.ts`)

This is the provider-neutral core of today's `gate.ts`:

```ts
export type ToolCall = { toolName: string; input: unknown; graphId: string; runId?: string; nodeId?: string; nodeTitle?: string; signal: AbortSignal };
export type ToolDecision = { allow: true } | { allow: false; reason: string };
export interface ToolGate { decide(call: ToolCall): Promise<ToolDecision> }
export function createToolGate(o: { projectDir: string; privateFiles: () => string[]; broker: ApprovalBroker; readOnly?: boolean }): ToolGate;
```

`decide` applies today's rules, in today's order:
1. `privatePathDenial` comes first. It covers the values file (new and legacy) and run records.
2. Read-only tools (`READ_ONLY_TOOLS`) are allowed.
3. Everything else waits for an approval from the `ApprovalBroker`. With `readOnly` (the planner), it is
   denied instead.

Claude adapts the gate to the SDK in `providers/claude/sdkGate.ts`, which builds `hooks.PreToolUse` and
`canUseTool` from a `ToolGate`. The resulting SDK behaviour is identical to today's `makeApprovalGate`,
including `APPROVAL_HOOK_TIMEOUT_SEC`.

### 3.3 Planner split

- The provider-neutral `Planner` (`engine/src/planner.ts`) keeps:
  - the chat log;
  - the busy state;
  - the user-edits preamble (`userEditsPreamble`, `describeOp`);
  - the op cursor;
  - `PLANNER_APPEND`, whose wording becomes provider-neutral;
  - the graph-state bookkeeping.
- The model conversation moves into `provider.planTurn`:

```ts
export type GraphTool = { name: string; description: string; schema: ZodRawShape; run(input: unknown): Promise<string> };
export type PlannerEvent = { type: 'text'; text: string } | { type: 'tool'; name: string; input: unknown };
export type PlannerTurn = {
  graph: Graph; prompt: string; systemAppend: string; cwd: string;
  tools: GraphTool[];            // today's graph tools, defined once, neutrally
  resume?: string;               // only when the stored planner state's provider === this provider (§5)
  gate: ToolGate;                // read-only + privacy for the planner's file tools
  signal: AbortSignal;
  onEvent(e: PlannerEvent): void;
};
export type PlannerTurnResult = { sessionId?: string; resumeFailed?: boolean };
```

- `plannerTools.ts` exports `graphTools(d): GraphTool[]` with no SDK import.
- The Claude provider wraps those tools with `createSdkMcpServer`/`tool` in
  `providers/claude/plannerTurn.ts`. Today's resume-failure handling (clearing a stale session) maps to
  `resumeFailed`.

### 3.4 Claude provider (`engine/src/providers/claude/`)

Today's code moves here almost unchanged:
- `agentExecutor.ts` becomes `runStep`;
- the planner's `query` call becomes `planTurn`;
- `sdk.ts` and `auth.ts` move as-is: `sanitizedEnv`, `checkAuth`, `isSubscriptionAuthSource`,
  `authSourceError`, `projectSettingsProblem` (now `folderProblem`) and `UNVERIFIED_AUTH`;
- the subscription checks: the `apiKeySource` refusal and the env stripping.

The constructor is
`createClaudeProvider({ claudePath: () => string | undefined, checkAuth?, queryFn?, env? })`.
`status()` maps today's `AuthInfo` to a `ProviderStatus`:
- `label` is `Claude <Plan>`;
- `detail` is the account email;
- `error` is unchanged.
A missing CLI, a `.cmd` launcher and API-key billing produce the same messages as today.

### 3.5 Copilot provider scaffold (`extension/src/providers/copilot.ts`)

It lives in the extension because it needs `vscode.lm`. The engine stays free of VS Code dependencies.

- `status()` calls `vscode.lm.selectChatModels({ vendor: 'copilot' })`:
  - If it finds one or more models: `{ ok: false, label: 'Copilot (preview)', detail: 'Models: <names>.
    Running steps with Copilot isn't implemented yet.', error: "Copilot support isn't implemented yet.
    Switch to Claude with Agent Stream: Select Provider." }`.
  - If it finds no models: `{ ok: false, label: 'Copilot not available', error: 'GitHub Copilot isn't
    available. Install the GitHub Copilot extension and sign in, or switch to Claude with Agent Stream:
    Select Provider.' }`.
  - If `vscode.lm` is missing or throws: the same as "no models", with the error text added.
- `runStep` resolves `{ ok: false, output: '', error: <the not-implemented message> }`. `planTurn`
  throws an error with that message.
- It sends no model request this round, so VS Code's Copilot consent prompt never appears.

### 3.6 Wiring

- **`AppDeps`.** `provider: AgentProvider` and `status: ProviderStatus` replace `claudePath` and `auth`.
  `queryFn` moves into the Claude provider's deps.
- **`App`.**
  - `setProvider(provider, status)` replaces `setAuth(auth, claudePath)`.
  - Chat and `startRun` refuse with `status.error` when `!status.ok`. This is today's refusal path, with
    the provider's message.
  - A folder problem from `provider.folderProblem?.(projectDir)` disables that folder, as
    `projectSettingsProblem` does today.
- **`EngineManager` (extension).**
  - A provider is built for `settings().provider` from a factory map: `claude` →
    `createClaudeProvider(...)` using `findClaude` and the `agentStream.claudePath` setting; `copilot` →
    the extension's Copilot provider.
  - `checkSignIn()` becomes `checkProvider()`. It keeps the sequence-number guard against stale results.
  - On `onDidChangeConfiguration` for `agentStream.provider` or `agentStream.claudePath`, the manager
    builds and checks the provider again, then calls `setProvider` on every engine.

## 4. Settings, commands and UI

- **`agentStream.provider`:** an enum of `claude` (default) and `copilot`, with `enumDescriptions`:
  - "Claude: your Claude subscription through Claude Code."
  - "GitHub Copilot (preview): detected only; running steps isn't implemented yet."
- **`agentStream.claudePath`:** its description adds "Claude provider only."
- **New command, `agentStream.selectProvider` ("Agent Stream: Select Provider"):**
  - It opens a quick pick with one item per provider, showing its `label` and `detail` from a fresh
    `status()`, plus a "Check again" item.
  - Choosing a provider writes the setting to the user scope, or to the workspace scope if the
    workspace already sets it.
  - The status bar item runs this command.
- **Status bar:**
  - `$(check) Claude Max`, unchanged;
  - `$(beaker) Copilot (preview)` when Copilot models were found;
  - `$(warning) Agent Stream: Copilot not available`;
  - while checking, `$(sync~spin) Agent Stream`.
  - The tooltip is the status `detail` or `error`.
- **Sidebar.** The Graphs view message and the Retry item use the provider's `error`. "Retry" becomes
  "Check again".
- **Webview.** It receives `ProviderStatus` in `hello` and `auth`, and keeps today's message names.
  - Wording that names Claude as the agent becomes neutral:
    - "Agent: a Claude agent run" becomes "Agent: an AI agent run";
    - "Chat is unavailable until you sign in to Claude." becomes `status.error`.
  - The disabled states for Run, Chat and the in-tab Run menu are unchanged. They follow `status.ok`.

## 5. Data and protocol

- **Planner state carries its provider.** *Amended by `2026-10-03-agent-stream-sessions-chat-design.md`
  §8:* planner state now lives per work session, in `session.json` as
  `planner[graphId] = { sessionId, provider, opCursor }`, not on `Graph`. State without a provider reads
  as `'claude'`.
  - The planner passes `resume` only when the stored `provider === provider.id`.
  - When the IDs differ and a provider session exists, it starts fresh and appends a chat note: "Started
    a new planner conversation with <name>; it doesn't see earlier messages."
  - After a turn it saves the provider session ID and `provider` together.
- **`RunMeta`.** It gains `provider?: ProviderId`, written at start. The run picker and the step logs
  header show the provider name. Re-run reuse rules don't change.
- **Export.** Unchanged. Exports never include planner state, so they stay provider-neutral.
- **Shared types.** `AuthInfo` is renamed `ProviderStatus`, with the fields in §3.1. `authLabel` becomes
  `providerLabel`, which returns `status.label`. The name `statusLabel` is already taken by run statuses.

## 6. Behaviour across a provider switch

- A run captures its provider at `startRun`. It finishes on that provider even if the setting changes
  mid-run.
- A planner turn already in progress finishes on its provider. The next turn uses the new one.
- Approvals that are pending stay valid, because the gate is provider-neutral.

## 7. Docs

- **README and extension README.** "Your Claude subscription" becomes **"Providers"**:
  - **Claude:** today's text — the subscription, env stripping, `claude auth status`, the API-key
    refusal and the `.claude/settings.json` check.
  - **GitHub Copilot (preview):** "Select it with Agent Stream: Select Provider. Agent Stream detects your
    Copilot models through VS Code; running steps with Copilot is coming in a later version."
- **Settings list.** It gains `agentStream.provider`.
- **`docs/windows-checklist.md`.** One new step: "Run Agent Stream: Select Provider and choose GitHub
  Copilot. The status bar shows Copilot (preview) or 'not available', and Run is refused with the
  Copilot message. Switch back to Claude."

## 8. Error handling

| Situation | Behaviour |
|---|---|
| `agentStream.provider` has an unknown value | Use Claude, plus one warning: "Unknown agentStream.provider '<v>'; using Claude." |
| Copilot chosen; no Copilot extension, not signed in, or no models | Status "Copilot not available" with the reason; Run and Chat refused with it |
| `vscode.lm` missing or throwing | As above, with the error text |
| Copilot chosen and available (scaffold) | Run and Chat refused: "Copilot support isn't implemented yet. Switch to Claude with Agent Stream: Select Provider." |
| Provider switched during a run or turn | That run or turn finishes on its original provider (§6) |
| Claude-specific problems | Unchanged messages, now produced by the Claude provider |

## 9. Testing

- **Engine:**
  - `toolGate.test.ts`: today's gate decisions, provider-neutral, covering privacy first, read-only
    allowed, approval required, and planner read-only denial.
  - `sdkGate.test.ts`: the SDK adapter matches today's hook and `canUseTool` behaviour (moved tests).
  - Claude provider tests: today's `agentExecutor`, `auth` and planner-query tests, moved and still
    green.
  - `planner.test.ts` against a fake provider:
    - the preamble and the op cursor;
    - `resume` only for the same provider;
    - the fresh-start note on a switch;
    - the provider saved with the planner state (per session; see the sessions spec).
  - `app.test.ts`:
    - runs and chat refused with `status.error` when `!ok`;
    - `setProvider` swaps for new runs only, while an active run keeps its provider;
    - `RunMeta.provider` recorded;
    - `folderProblem` disables a folder.
- **Extension:**
  - Copilot `status()` with a fake `vscode.lm` in `test/vscode.ts`: models, none, missing API, and
    throwing.
  - `EngineManager`: the provider is chosen from the setting; an unknown value falls back with a warning;
    a configuration change swaps and checks again; the stale-check guard holds.
  - Status bar texts for each state.
  - The Select Provider quick pick writes the setting at the right scope.
- **Integration (real VS Code).** Today's checks are unchanged. One new check sets
  `agentStream.provider` to `copilot` and waits for the status. With other extensions disabled, it must
  say "not available". Run is then refused with that message. The check then restores `claude`.
- **Visual.** The screenshot script adds the status bar and the quick pick with Copilot selected.

## 10. Out of scope (later rounds)

- Copilot's agent loop and tools: read, glob, grep, edit and shell through the `ToolGate`.
- Model selection, the Copilot consent flow and token or usage reporting.
- A per-step or per-graph provider override.
- Other providers, such as OpenAI-compatible endpoints or local models.
- Running both providers in one run.
