# Agent Stream — an OpenAI Codex provider

**Date:** 2026-10-04
**Status:** Approved in conversation (approach A and section 1; the user said "do it" for the rest). Written for the record.
**Builds on:**
- the providers spec (`AgentProvider`, `ToolGate`);
- the Copilot provider spec (provider-neutral graph tools, the approval card layouts, the request-cap pattern);
- the model and effort work (`ModelChoice`, the Model and Effort menus);
- the parallel-tickets spec (read-only steps, variant workspaces).

## 1. Purpose

A third provider, **OpenAI Codex**, runs planner turns and agent steps on the user's **ChatGPT subscription**, through the user's own installed `codex` CLI. Agent Stream's rules stay the same:
- every shell command and file change waits for the user's approval;
- read-only steps can't change anything;
- private paths stay private;
- a run keeps the provider it started with.

## 2. What we verified (probe, 2026-10-04, `codex-cli 0.160.0`, macOS)

- `codex app-server` speaks newline-delimited JSON-RPC 2.0 over stdio. `codex app-server generate-ts [--experimental]` prints the protocol's TypeScript types.
- **Sign-in:** `account/read` returned `{ account: { type: "chatgpt", planType: "plus", … } }`. We started the server with `-c forced_login_method="chatgpt"` and with `OPENAI_API_KEY`, `CODEX_API_KEY` and `OPENAI_BASE_URL` removed from its environment.
- **Models:** `model/list` returned the plan's models with `supportedReasoningEfforts`. Efforts went from `low` up to `ultra`; some models stop at `max` or `xhigh`.
- **Approvals:** a thread was started with `approvalPolicy: "untrusted"` and `sandbox: "read-only"`. Both `cat <file outside the folder>` and a file write (made as `printf hi > hello.txt`) arrived as `item/commandExecution/requestApproval` server requests **before** running. We answered `{ decision: "decline" }`, so the secret never appeared and the file was not created.
- **Dynamic tools:** an experimental `dynamicTools` entry on `thread/start` was called through an `item/tool/call` server request, with the correct arguments. Our `{ contentItems: [{ type: "inputText", text }], success: true }` reached the model.
- **Events:** `item/started` and `item/completed` notifications arrived for `agentMessage`, `reasoning`, `commandExecution` (with `command` and `status`) and `dynamicToolCall`, followed by `turn/completed`.
- **Not verified:**
  - whether reads **inside** the working folder run without asking (Task 1 of the plan checks this live, see §6);
  - `thread/resume` keeping `dynamicTools`;
  - Windows.

## 3. Decisions

| Topic | Decision |
|---|---|
| Approach | A: a VS Code-free JSON-RPC client in `engine/src/providers/codex/` that spawns `codex app-server`. The SDK and `codex exec` are rejected: they have no per-action approval |
| Provider id and name | `codex`, shown as `OpenAI Codex`; the status bar shows `Codex (<Plan>)`, e.g. `Codex (Plus)` |
| Auth | ChatGPT only: `forced_login_method="chatgpt"`, API-key variables stripped, and an `account.type` other than `chatgpt` refused |
| Steps | One ephemeral thread per step, with `approvalPolicy: "untrusted"`. The sandbox is `workspace-write`, or `read-only` for read-only steps. Every approval request goes through the `ToolGate` |
| Planner | One persistent thread per planner conversation; the thread id is the planner `sessionId`. Graph tools go in as dynamic tools, and resume uses `thread/resume` |
| Models | Taken from `model/list` (hidden models excluded). Default is Codex's own default (no `model` sent) |
| Effort | Shared `EffortLevel` gains `'ultra'`. Sent as `effort` on `turn/start` when set and supported |
| Request cap | None. Codex runs its own loop; a turn is bounded by Stop |
| Path setting | `agentStream.codexPath`, for when `codex` isn't found automatically |

## 4. Engine (`engine/src/providers/codex/`)

### 4.1 Protocol types (`protocol.ts`)

Hand-written types for only the messages we use, copied from `codex app-server generate-ts --experimental` for 0.160.0. The header comment names the version:
- `initialize` and `initialized`;
- `account/read`, `model/list`;
- `thread/start`, `thread/resume`, `turn/start`, `turn/interrupt`;
- the server requests `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, `item/permissions/requestApproval`, `item/tool/call`, `item/tool/requestUserInput` and `mcpServer/elicitation/request`;
- the notifications `item/started`, `item/completed`, `turn/completed` and `error`, plus a token-usage notification if one exists.

### 4.2 Connection (`connection.ts`)

```ts
export interface CodexConnection {
  request<T>(method: string, params: unknown, signal?: AbortSignal): Promise<T>;
  notify(method: string, params?: unknown): void;
  onServerRequest(handler: (method: string, params: unknown) => Promise<unknown>): void;  // result or throws → JSON-RPC error
  onNotification(handler: (method: string, params: unknown) => void): void;
  close(): void;   // kill the process tree; pending requests reject
}
export type SpawnCodex = (codexPath: string, args: string[], env: NodeJS.ProcessEnv) => { stdin: Writable; stdout: Readable; stderr: Readable; kill(): void; onExit(cb: (code: number | null) => void): void };
export function openCodex(o: { codexPath: string; spawn?: SpawnCodex; env?: NodeJS.ProcessEnv; initTimeoutMs?: number }): Promise<CodexConnection>;
```

- **Process:** `openCodex` spawns `codexPath app-server -c forced_login_method="chatgpt"`. The environment is `sanitizedCodexEnv(env)`, without `OPENAI_API_KEY`, `CODEX_API_KEY` or `OPENAI_BASE_URL`.
- **Handshake:** it sends `initialize { clientInfo: { name: "agent-stream", title: "Agent Stream", version }, capabilities: { experimentalApi: true, requestAttestation: false } }` and then `initialized`. A failure or timeout (30 s) rejects with `Codex didn't start: <reason>`.
- **Framing and errors:**
  - Messages are newline-delimited JSON.
  - A malformed line is logged and ignored.
  - The process exiting rejects every pending request with `Codex stopped unexpectedly (exit <code>).` and fails the step or turn with that message.
  - The last 2,000 characters of stderr are kept for error messages.
- **Windows:** when `codexPath` ends in `.cmd` or `.bat`, it is spawned through `cmd.exe /d /s /c`.

### 4.3 Finding Codex and status (`auth.ts`)

- **Finding the binary:** `findCodex({ setting, env, platform, probe })`, like `findClaude`:
  1. the `agentStream.codexPath` setting;
  2. `codex` (or `codex.exe` / `codex.cmd` on Windows) on `PATH`;
  3. the usual npm global and Homebrew locations.
- **Status:** `status()` opens a connection, calls `account/read`, closes the connection, and caches the result for the window.

| Result | Status |
|---|---|
| Codex not found | `ok: false`, `Could not find Codex (codex). Install it from https://developers.openai.com/codex and sign in with ChatGPT, or set agentStream.codexPath.` |
| `account` null | `ok: false`, label `Codex: not signed in`, error `Run codex login in a terminal and sign in with ChatGPT.` |
| `account.type` is not `chatgpt` | `ok: false`, label `Codex: API key`, error `Agent Stream uses your ChatGPT subscription for Codex. Run codex logout, then codex login and choose ChatGPT.` |
| `chatgpt` | `ok: true`, label `Codex (<Plan>)`, with the plan type capitalised; detail `Signed in with ChatGPT.` |
| Connection error | `ok: false`, with the connection's message |

### 4.4 Models (`models.ts`)

- `listModels()` and `knownModels()` call `model/list { includeHidden: false }`. Each model becomes `{ value: id, label: displayName || id, description, efforts: supportedReasoningEfforts mapped to EffortLevel }`; efforts that aren't known are dropped.
- Caching follows Claude's: one background fetch, a failure cached for the window, and one retry from chat open or Select Model.
- **Default model:** with no model chosen, no `model` is sent. The Default entry's efforts are those of the model `model/list` marks as default, or none when no model is marked.

### 4.5 Approval mapping (`approvals.ts`)

Server requests become `ToolGate` decisions:

| Server request | Gate call | Answer |
|---|---|---|
| `item/commandExecution/requestApproval` | `gate.decide('Bash', { command, description: reason })` | allow → `{ decision: "accept" }`, otherwise `{ decision: "decline" }` |
| `item/fileChange/requestApproval` | `gate.decide('Patch', { changes: [{ path, kind, diff }] })`, built from the matching `fileChange` item seen in `item/started` | `accept` or `decline` |
| `item/permissions/requestApproval` | none, always declined | `{ decision: "decline" }`, and the step log notes `Codex asked for extra permissions; declined.` |
| `item/tool/call` | the matching loop/graph tool, gated under its `gateName` (step graph tools self-approve) | `{ contentItems: [{ type: "inputText", text }], success: !isError }`; an unknown tool gets `success: false` |
| `item/tool/requestUserInput`, `mcpServer/elicitation/request` | none | a JSON-RPC error `Agent Stream doesn't support this request.` |

- **`acceptForSession` is never used**, so every action is approved on its own.
- **Read-only steps:** the gate already refuses anything that isn't read-only, without asking the user, so every request is declined.

### 4.6 Steps (`runStep.ts`)

1. **Start.** Emit `start`, then open a connection and send `thread/start` with:
   - `cwd`: the step's working folder (a variant worktree when set);
   - `approvalPolicy: "untrusted"`;
   - `sandbox`: `read-only` for read-only steps, otherwise `workspace-write`;
   - `ephemeral: true`;
   - `developerInstructions`: the step preamble (`You are an agent running one step of a workflow in <cwd>. Do the work, then reply with a summary of what you did.`);
   - `model`, when set;
   - `dynamicTools`: the step graph tools, for write-capable steps only.
2. **Run the turn.** Send `turn/start { threadId, input: [{ type: "text", text: ctx.prompt, text_elements: [] }], effort? }`.
3. **Map notifications to step events:**
   - **`agentMessage` (completed):** `text`.
   - **`reasoning` (completed) with a summary:** `text`, prefixed `Thinking: `.
   - **`commandExecution`:** `tool_call` (`Bash`, `{ command }`) when it starts, and `tool_result` when it completes, holding its output (truncated to 30,000 characters) and `exit <code>` or `declined`.
   - **`fileChange`:** `tool_call` (`Patch`, `{ changes }`) and then `tool_result`.
   - **`dynamicToolCall`:** `tool_call` and `tool_result`.
4. **Finish** on `turn/completed`:
   - **ok:** `{ ok: true, output: <last agentMessage text>, usage }`, with the tokens taken from the turn's usage when reported;
   - **failed:** `{ ok: false, output, error }`.
5. **Stop.** On abort, send `turn/interrupt { threadId, turnId }`, wait up to 5 s for `turn/completed`, then close. Return `{ ok: false, output: '', error: 'cancelled', usage }`.
6. **Always** close the connection in `finally`.

### 4.7 Planner (`planTurn.ts`)

- **New conversation:** `thread/start` with:
  - `cwd: turn.cwd`;
  - `approvalPolicy: "untrusted"`, `sandbox: "read-only"`;
  - `developerInstructions: turn.systemAppend`;
  - `model`;
  - `ephemeral: false`;
  - `dynamicTools`: the planner graph tools, gated by plain name through `turn.gate`.
- **Resume:** `thread/resume { threadId: turn.resume, model? }`. If Task 1 finds that resume doesn't keep `dynamicTools`, the provider starts a fresh thread instead and returns `resumeFailed`.
  - An unknown or expired thread → `{ ok: false, error: 'The earlier Codex conversation was not found.', resumeFailed: true }`.
- **Events:** each completed `agentMessage` → `turn.onEvent({ type: 'text' })`; graph tool calls → `turn.onEvent({ type: 'tool', name, input })`.
- **Result:** `{ ok: true, sessionId: threadId }`, or on a failed turn `{ ok: true, sessionId, error }`.
- **Stop:** abort interrupts the turn and returns `{ ok: true, sessionId, error: 'cancelled' }`. The planner then shows `Stopped.`, as for Claude and Copilot.

## 5. Shared, extension and web

- **Shared types:**
  - `ProviderId` gains `'codex'`.
  - `EffortLevel` gains `'ultra'`, accepted by schemas and settings.
  - `PROVIDER_NAMES.codex = 'OpenAI Codex'`.
  - `supportsEffort('codex')` is true.
- **Settings:**
  - `agentStream.provider` enum gains `codex`;
  - new `agentStream.codexPath` (string, default empty);
  - `agentStream.effort` enum gains `ultra`.
- **Provider registry and EngineManager:** `providerFor('codex')` builds the Codex provider with the found path, re-checked when the setting changes.
- **Approval card:** a new `Patch` layout lists each change's path, its kind (add, update or delete), and the diff, with added lines styled as additions and removed lines as deletions. `Bash` uses the existing layout.
- **Select Provider:** gains **OpenAI Codex**. The status bar and run dialog show it like the other providers.
- **Docs:**
  - The README Providers section gets a Codex entry: what's needed (Codex CLI, `codex login` with ChatGPT), what's refused (API keys), models and effort, approvals, read-only steps, privacy, and Windows notes.
  - Both READMEs list `agentStream.codexPath`.
  - The Windows checklist gets Codex steps.

## 6. Privacy: run records and values

**The requirement:** a Codex step must not read Agent Stream's run records (`.agent-stream/runs/**`, `.agent-stream/sessions/**`) or the saved values file (`~/.agent-stream/values/**`) without the user approving it.

**Task 1 checks it live** with the controller-run probe: one small turn in a temp folder. Codex is asked to `cat` a file inside the folder, a file under `.agent-stream/runs/…`, and a file under a fake values folder, and the probe records which ones arrive as approval requests.

| Probe result | What the provider does |
|---|---|
| Every read arrives as an approval request | Nothing extra: the gate's privacy rule declines private paths. The `Bash` command is checked for those paths, plus the `commandActions` read targets when present |
| Some reads run without asking | Each step's thread passes a sandbox configuration that denies reading those folders, if Codex supports read restrictions. If it doesn't, the provider passes `approvalPolicy: { granular: { sandbox_approval: true, rules: true, skill_approval: true, request_permissions: true, mcp_elicitations: true } }` (or whatever the probe shows asks for every command). The README states the limitation precisely |

In every case, an approval request whose command or read targets name a private path is declined automatically, the same as Read/Grep/Glob for the other providers. The step log names the path.

## 7. Error handling

| Situation | Behaviour |
|---|---|
| Codex not installed, not signed in, or signed in with an API key | Status message as in §4.3; runs and chat are refused with it |
| `codex app-server` fails to start or exits | The step or turn fails with `Codex didn't start: …` or `Codex stopped unexpectedly (exit N).`, plus the stderr tail |
| A Codex error notification during a turn | The step fails with `Codex failed: <message>` |
| Model refused or unknown | `Codex failed: <message>`; the user picks another model |
| Stop | The turn is interrupted, then the connection closes; the step is cancelled, the planner shows `Stopped.` |
| Unknown server request | A JSON-RPC error; the turn continues |

## 8. Testing

No test runs the real `codex`. Tests use an injectable `SpawnCodex` that returns in-memory streams, driven by a **fake app-server**: a scripted responder in `engine/test/codexFake.ts` that answers requests, sends server requests and emits notifications.

- **Connection:**
  - the initialize handshake and the `initialized` notification;
  - request/response matching;
  - server requests answered or turned into errors;
  - a malformed line ignored;
  - a process exit rejecting pending requests with the message;
  - `close()` killing the process;
  - `sanitizedCodexEnv` removing the three variables;
  - Windows `.cmd` spawning.
- **Auth and status:** each row of §4.3, and `findCodex` for each location and platform.
- **Models:** the mapping, unknown efforts dropped, `ultra` kept, the cache, and the failure retry.
- **Approvals:**
  - a command allowed or denied by the gate;
  - a file change built from its item, allowed or denied;
  - permissions always declined;
  - a dynamic tool call through the gate (step tools self-approve);
  - unknown requests answered with an error;
  - read-only steps declining without asking;
  - private-path commands declined without asking.
- **Steps:**
  - the event mapping for each item type;
  - the outcome and usage;
  - the thread options for write and read-only steps;
  - a variant worktree as `cwd`;
  - effort and model passed through;
  - Stop sending `turn/interrupt` and returning cancelled;
  - a server exit mid-turn;
  - the connection always closed.
- **Planner:** new versus resumed threads, `resumeFailed`, events, graph tools, Stop, and the returned sessionId.
- **Shared, extension and web:**
  - the `codex` provider id and `ultra` effort in schemas and settings;
  - Select Provider listing Codex;
  - the status bar label;
  - the `codexPath` setting reaching `findCodex`;
  - the `Patch` approval card rendering paths and diffs.
- **Manual, before release:** a signed-in run of a two-step graph: one edit step (approve one change, deny one) and one read-only step. Then a planner chat that builds a graph, with Stop mid-turn. Repeat on Windows.

## 9. Out of scope

- Signing in from inside Agent Stream: the user runs `codex login`.
- Codex's MCP servers, plugins, skills, images, cloud tasks and review mode.
- Request caps: Codex usage is bounded by the plan and by Stop.
- Showing Codex rate limits or usage beyond a step's token report.
