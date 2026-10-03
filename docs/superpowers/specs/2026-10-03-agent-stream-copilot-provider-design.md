# Agent Stream — a working GitHub Copilot provider

**Date:** 2026-10-03
**Status:** Approved in conversation (sections 1–2); written for review
**Builds on:**
- the providers spec (`AgentProvider`, `ToolGate`, and the Copilot scaffold);
- the model/effort work (`ModelChoice`, the chat Model menu, Select Model);
- the parallel-tickets spec (read-only steps, workspaces, `parallelWriteSteps`).

**Sub-project order:** Copilot first. A Codex provider (`codex app-server`) is a separate spec later.

## 1. Purpose

Choosing **GitHub Copilot** as the provider today only shows models; runs and chat refuse. After this work, Copilot runs **planner turns** and **agent steps** on the user's Copilot plan, through VS Code's Language Model API (`vscode.lm`). Agent Stream's rules stay the same:
- every file edit or shell command waits for the user's approval;
- read-only steps can't change anything;
- private paths stay private;
- a run keeps the provider it started with.

Success:
- With Copilot selected, a graph whose agent steps edit files runs end to end. Each `Edit`, `Write` and `Bash` shows the usual approval card, and each step's log shows the model's text and tool calls.
- The planner chat works on Copilot across turns, and continues after a VS Code reload.
- A Copilot step can't make more model requests than the configured cap.
- No test needs a real Copilot account.

## 2. What we verified (probe, 2026-10-03, VS Code 1.140, Copilot Chat 0.68 built in)

- `vscode.lm.selectChatModels({ vendor: 'copilot' })` returned 6 models to a third-party extension. Each had `capabilities.supportsToolCalling: true`.
  - `auto` ("Auto", family `claude-fable-5.1`, ~936k input tokens).
  - `gpt-5.6-luna` (~922k).
  - `gpt-4o-mini` (12k).
  - Three internal ids: `copilot-utility`, `copilot-utility-small`, `copilot-dictation-cleanup-luna`.
- A `sendRequest` with one private tool returned a `LanguageModelToolCallPart` in 3.9 s.
- VS Code also registers 80 built-in tools (`copilot_readFile`, `run_in_terminal`, …). We don't use them (§3).
- **Not verified:**
  - whether these requests count against the plan's premium-request quota;
  - whether any `modelOptions` key controls reasoning effort. None is documented, so Copilot has no effort control here.

## 3. Decisions

| Topic | Decision |
|---|---|
| Approach | A provider-neutral agent loop and tools in the engine, behind a `ChatModel` interface. The extension supplies a `vscode.lm` adapter. Copilot's built-in tools are not used |
| Tools | Our own `Read`, `Grep`, `Glob`, `Edit`, `Write`, `Bash`, with Claude's tool names and input shapes, so the approval cards, read-only rules and privacy checks apply unchanged |
| Models | Models with `supportsToolCalling`, excluding ids that start with `copilot-`. **Default** means `auto` |
| Effort | Not offered for Copilot (`efforts: []`); the Effort menu hides |
| Request cap | `agentStream.copilot.maxRequestsPerStep` (default 100, range 1–200) and `agentStream.copilot.maxRequestsPerTurn` (default 100, range 1–100). Amended 2026-10-04: the first defaults (25 and 10) were too low, because a planner turn that builds a graph makes one request per tool call |
| Planner history | A per-conversation transcript file owned by the planner, offered to providers that have no server-side session |
| Long history | Compacted with one summary request when it nears the model's input limit |

## 4. Engine: the agent loop and tools (`engine/src/agentLoop/`)

### 4.1 `ChatModel` (`chatModel.ts`)

```ts
export type ChatPart =
  | { type: 'text'; text: string }
  | { type: 'toolCall'; callId: string; name: string; input: unknown };
export type ChatMessage =
  | { role: 'user'; content: Array<{ type: 'text'; text: string } | { type: 'toolResult'; callId: string; text: string; isError?: boolean }> }
  | { role: 'assistant'; content: ChatPart[] };
export type ToolSpec = { name: string; description: string; inputSchema: object };   // JSON Schema
export interface ChatModel {
  readonly id: string;
  readonly maxInputTokens: number;
  send(messages: ChatMessage[], tools: ToolSpec[], signal: AbortSignal): AsyncIterable<ChatPart>;
}
```

`send` throws a `ChatModelError { code: 'permission' | 'blocked' | 'notFound' | 'other'; message }` for provider errors. A cancellation surfaces as an abort.

### 4.2 Built-in tools (`tools.ts`)

```ts
export type LoopTool = { spec: ToolSpec; gateName: string; run(input: unknown, signal: AbortSignal): Promise<{ text: string; isError?: boolean }> };
export function builtinTools(o: { cwd: string; runShell: RunShell; readOnly: boolean }): LoopTool[];
```

**General rules:**
- Paths are resolved with `path.resolve(cwd, p)`. A leading `~` expands to the home folder, matching `privatePathDenial`.
- Inputs are validated with zod. A bad input returns `{ isError: true }` with the zod message.
- Every result is truncated to 30,000 characters with the existing `truncateHead`/`truncateTail` (head and tail kept).

| Tool | Input | Behaviour |
|---|---|---|
| `Read` | `{ file_path, offset?, limit? }` | UTF-8 text with 1-based line numbers. Default limit 2000 lines; a line longer than 2000 characters is cut. A missing file or a folder returns an error |
| `Glob` | `{ pattern, path? }` | Walks `path` (default `cwd`) and matches relative paths with a small built-in glob matcher (`globToRegExp` in `agentLoop/glob.ts`: `**`, `*`, `?`, `{a,b}`, `[abc]`). It uses no `path.matchesGlob`, because the engine supports Node ≥ 20.11. Skips `.git`, `node_modules`, `.agent-stream/runs` and `.agent-stream/sessions`. At most 1000 results, newest first |
| `Grep` | `{ pattern, path?, glob? }` | JavaScript regex per line over text files under `path`, filtered by `glob`, with the same skips. Files over 2 MB and binary files (a NUL in the first 8 KB) are skipped. At most 500 matches, as `file:line: text` |
| `Edit` | `{ file_path, old_string, new_string, replace_all? }` | `old_string` must occur exactly once unless `replace_all`; otherwise an error says how many times it was found. Written with `writeFileAtomic` |
| `Write` | `{ file_path, content }` | Creates parent folders, then writes with `writeFileAtomic` |
| `Bash` | `{ command, description? }` | `runShell({ command, cwd, signal, timeoutSec: 600 })`. The result text is the combined output plus `exit code N`. A non-zero exit is not a tool error, just information for the model |

- **Read-only steps:** `readOnly: true` returns only `Read`, `Grep` and `Glob`.
- **Gate names:** each tool's `gateName` is its own name.

### 4.3 `runShellCommand` (`engine/src/shell.ts`)

The spawn/timeout/kill logic of `createCommandExecutor` moves into:

```ts
export type RunShell = (o: { command: string; cwd: string; signal: AbortSignal; timeoutSec: number; onChunk?: (stream: 'stdout' | 'stderr', chunk: string) => void }) =>
  Promise<{ exitCode: number | null; output: string; error?: string }>;
export function createRunShell(o: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; gitBashPath?: string }): RunShell;
```

- `createCommandExecutor` uses it, and its behaviour and tests are unchanged.
- The login shell on macOS and Linux, Git Bash on Windows, `killTree`, and the SIGTERM→SIGKILL grace all stay.

### 4.4 Graph tools as loop tools (`graphLoopTools.ts`)

`toLoopTools(tools: GraphTool[], gatePrefix: string): LoopTool[]`:
- **spec:** `{ name: t.name, description: t.description, inputSchema: z.toJSONSchema(z.object(t.schema)) }`;
- **run:** `t.run`;
- **gateName:** `gatePrefix + t.name`. Step graph tools use `mcp__run_graph__`, so `isSelfApproving` matches. Planner tools use `''`, so the planner gate's `graphToolNames` match.

### 4.5 `runAgentLoop` (`loop.ts`)

```ts
export type LoopResult =
  | { ok: true; text: string; requests: number; messages: ChatMessage[] }
  | { ok: false; error: string; requests: number; messages: ChatMessage[]; cancelled?: boolean; capped?: boolean };
export function runAgentLoop(o: {
  model: ChatModel; system: string; messages: ChatMessage[]; tools: LoopTool[]; gate: ToolGate;
  maxRequests: number; signal: AbortSignal;
  onText(text: string): void; onToolCall(callId: string, name: string, input: unknown): void; onToolResult(callId: string, text: string, isError: boolean): void;
}): Promise<LoopResult>;
```

**Each round:**
1. **Compact if needed** (§4.6).
2. **Send.** Call `model.send([system as the first user message, …messages], specs, signal)`, collect the parts, and count one request.
3. **Record.** Append the assistant message. Each text part goes to `onText`, and each tool call to `onToolCall`.
4. **Finish when there are no tool calls.** Return `ok` with the concatenated text of this final assistant message.
5. **Handle each tool call in order:**
   - An unknown name gets an error result: `Unknown tool <name>.`
   - Otherwise call `gate.decide(tool.gateName, input, signal)`. A refusal or denial gets `{ isError: true, text: reason }`; an allow runs the tool.
   - Call `onToolResult`.
   - Append one user message holding every tool result.
6. **Check the cap.** If `requests === maxRequests` and the model still wants tools, return `{ ok: false, capped: true, error: "Stopped after <n> Copilot requests (agentStream.copilot.maxRequestsPerStep). Raise the setting to let steps run longer." }`. The planner uses the same text naming `maxRequestsPerTurn`.

**Cancellation and errors:**
- An abort at any point returns `{ ok: false, cancelled: true, error: 'cancelled' }`.
- A `ChatModelError` returns `{ ok: false, error: message }` (§5.4).

### 4.6 Compaction (`compact.ts`)

- **Token estimate:** `ceil(chars / 4)` over the system text, the messages and the tool specs.
- **When:** if the estimate exceeds 75 % of `maxInputTokens`, before sending.
- **What is kept:** the first user message (the task) and the most recent messages up to 40 % of the limit.
- **What is summarised:**
  - One extra `send` with no tools asks: `Summarise the conversation so far for yourself: decisions, files changed, open questions. Keep it under 300 words.` It counts toward the cap.
  - The older messages are replaced by one user message: `Summary of earlier turns: <text>`.
  - Tool-result pairs are never split: an assistant tool-call message and its results are kept or dropped together.
- **If still too long**, or the summary request fails: drop the oldest kept pairs and leave a note `Earlier turns were dropped to fit the model's context.`

## 5. Extension: the Copilot provider (`extension/src/providers/copilot.ts`)

### 5.1 The adapter (`copilotModel.ts`)

`vscodeChatModel(model: vscode.LanguageModelChat): ChatModel`:
- **Messages:** each `ChatMessage` becomes a `LanguageModelChatMessage`:
  - user text → `LanguageModelTextPart`;
  - tool results → `LanguageModelToolResultPart(callId, [LanguageModelTextPart(text)])`;
  - assistant tool calls → `LanguageModelToolCallPart`.
- **Requests:** `sendRequest(messages, { tools, justification: 'Agent Stream runs your workflow steps on Copilot.' }, cancellation)`. The token source is cancelled from the `AbortSignal`.
- **Streaming:** text parts and tool-call parts are yielded; any other part (thinking or data parts) is ignored.
- **Errors:** a `vscode.LanguageModelError` maps by `code`: `NoPermissions` → `permission`, `Blocked` → `blocked`, `NotFound` → `notFound`, anything else → `other`.

### 5.2 Models and status

**`listModels()` / `knownModels()`:**
- they list `selectChatModels({ vendor: 'copilot' })`, keeping only `capabilities.supportsToolCalling` and dropping ids that start with `copilot-`;
- each becomes `{ value: id, label: name, efforts: [] }`;
- the list is sorted with `auto` first, deduplicated by id, and cached like Claude's (one background fetch, one retry).

**`status()`:**
- no Language Model API, or no Copilot models → `ok: false` with `COPILOT_UNAVAILABLE`;
- otherwise `ok: true`, label `Copilot`;
- when `context.languageModelAccessInformation.canSendRequest(model)` is `undefined`, the detail adds `Copilot will ask for permission the first time a run or chat uses it.`; when it is `false`, the status is `ok: false` with the permission message (§5.4).

**Resolving the model:**
- `ctx.model` or `turn.model` if set and in the list; `auto` otherwise. If `auto` is missing, the first listed model.
- Effort is ignored for Copilot.

### 5.3 `runStep` and `planTurn`

**`runStep(ctx, gate)`:**
1. Emit `{ type: 'start', kind: 'agent', cwd, prompt }`.
2. Run `runAgentLoop` with:
   - **tools:** `builtinTools({ cwd: ctx.cwd, runShell, readOnly: !isWriteCapable(ctx.node) })` (`isWriteCapable` from `shared/src/access.ts`) plus `toLoopTools(ctx.graphTools ?? [], 'mcp__run_graph__')`;
   - **system:** a short Copilot preamble (`You are an agent running one step of a workflow in <cwd>. Use the tools to do the work; when finished, reply with a summary of what you did.`);
   - **messages:** `[user: ctx.prompt]`;
   - **maxRequests:** `maxRequestsPerStep`.
3. Map the callbacks to step events (`text`, `tool_call`, `tool_result`).
4. Return the outcome:
   - success: `{ ok: true, output: text, usage: { turns: requests } }`;
   - capped or error: `{ ok: false, output: <last assistant text>, error }`;
   - cancelled: `{ ok: false, output: '', error: 'cancelled' }`.
5. Log one line at the end: `Copilot requests: <n> of <cap>`, as a `text` event.

**`planTurn(turn)`:**
1. **History:** `turn.transcript.load(turn.resume)` gives the earlier messages. With `resume` set but nothing loaded, return `{ ok: false, error: 'The earlier Copilot conversation was not found.', resumeFailed: true }`.
2. **Run** `runAgentLoop` with:
   - **system:** `turn.systemAppend`;
   - **tools:** `builtinTools({ readOnly: true, cwd: turn.cwd })` plus `toLoopTools(turn.tools, '')`;
   - **gate:** `turn.gate`;
   - **maxRequests:** `maxRequestsPerTurn`;
   - **callbacks:** `onText` → `turn.onEvent({ type: 'text' })`; graph tool calls → `turn.onEvent({ type: 'tool', name, input })`.
3. **Save and return.** Save `messages` under a conversation id: `resume`, or a new `randomUUID()`. Return `{ ok: true, sessionId: id }`, or on error `{ ok: true, sessionId: id, error }` (the error shows in the chat and the conversation is kept).

### 5.4 Messages for Copilot errors

| Code | Message |
|---|---|
| `permission` | `Agent Stream isn't allowed to use Copilot. Run the step again and choose Allow, or enable it under Accounts › Manage Language Model Access.` |
| `blocked` | `Copilot refused the request (quota or policy): <message>` |
| `notFound` | `The Copilot model <id> is no longer available. Pick another model.` |
| `other` | `Copilot failed: <message>` |

### 5.5 Wiring

- `EngineManager.providerFor('copilot')` builds the provider with:
  - `vscode.lm` and `context.languageModelAccessInformation`;
  - `createRunShell({ platform, gitBashPath })`, using the same Git Bash discovery as command steps;
  - the cap settings, read in `settings.ts`.
- **Settings:** `agentStream.copilot.maxRequestsPerStep` and `agentStream.copilot.maxRequestsPerTurn` (integers, clamped to their ranges). The run dialog shows `Copilot requests per step: up to <n>` when the run's provider is Copilot.
- **Retired strings:** `COPILOT_NOT_IMPLEMENTED` and the `preview: true` flag are removed. The status bar shows `Copilot`.

## 6. Planner transcripts (engine)

- **`PlannerTurn` gains `transcript: TranscriptStore`:**
  ```ts
  export interface TranscriptStore { load(id: string): ChatMessage[] | undefined; save(id: string, messages: ChatMessage[]): void; }
  ```
- **Implementation:** `Planner` provides it, backed by `sessions/<sessionId>/transcripts/<graphId>.<providerId>.<id>.json`, written atomically.
  - These files are personal and git-ignored, like the rest of `sessions/`.
  - **New chat** deletes the transcripts for that graph and provider. Deleting a session deletes its folder, as today.
- **Claude** ignores `transcript`.

## 7. Error handling

| Situation | Behaviour |
|---|---|
| The user declines the consent dialog | The step or turn fails with the `permission` message; nothing retries automatically |
| Quota reached mid-step | The step fails with the `blocked` message; earlier tool effects stay; the log shows the requests used |
| Request cap reached | The step fails with the cap message (§4.5) |
| The model returns malformed tool input | That tool returns a validation error and the loop continues |
| Stop during a request or a tool | Cancelled: the request is aborted, a running `Bash` is killed (`killTree`) |
| Transcript missing on resume | `resumeFailed`; the planner starts a fresh conversation with its existing note |
| The selected model disappears | Falls back to Auto at the next request; the dialog and tooltip name the model used |

## 8. Testing

No test uses a real Copilot account or `vscode.lm`. Tests use a fake `ChatModel`, a fake `lm` object and temp folders.

- **Engine tools:**
  - `Read` (line numbers, offset and limit, a missing file);
  - `Glob` and `Grep` (skips, caps, binary and large files, glob filter);
  - `globToRegExp` (`**`, `*`, `?`, braces, classes; Windows separators);
  - `Edit` (unique match, zero or several matches, `replace_all`);
  - `Write` (creates folders);
  - `Bash` through `createRunShell` (output and exit code, timeout, abort kills);
  - privacy refusals for `Read`, `Grep` and `Glob` through a real step gate;
  - read-only steps get only the three read tools.
- **`runShellCommand` extraction:** the existing command-executor tests still pass unchanged.
- **Loop:**
  - a text-only reply;
  - tool call → approval → result → final reply;
  - a denied tool and its error result;
  - a read-only refusal;
  - an unknown tool;
  - a step graph tool approving itself through `mcp__run_graph__` naming;
  - the cap (exactly `maxRequests` sends, then `capped`);
  - abort during `send` and during a tool;
  - a `ChatModelError` mapping.
- **Compaction:**
  - it triggers at 75 %;
  - it keeps the first message and recent pairs;
  - it never splits a call/result pair;
  - a failed summary falls back to dropping.
- **Transcripts:** save and load, New chat clears, a missing file means `resumeFailed`.
- **Extension:**
  - adapter conversions both ways and error-code mapping;
  - model filtering and sorting (`auto` first, `copilot-*` hidden);
  - Default resolves to Auto;
  - status with the consent unknown, refused or given;
  - `runStep` emits `start`, `text`, `tool_call` and `tool_result` and returns the outcome and usage;
  - `planTurn` resumes from the transcript and returns `sessionId`;
  - the cap settings are read and clamped;
  - the run dialog line.
- **Manual (before release):** with a signed-in Copilot account, run a two-step graph (one edit step, one `Bash` step) and a planner chat. Approve one edit and deny one. Add these steps to `docs/windows-checklist.md`.

## 9. Out of scope

- A Codex provider. It's the next sub-project, built on `codex app-server`.
- Copilot's built-in agent tools and `lm.invokeTool`.
- Effort and reasoning controls for Copilot.
- Counting or showing premium-request usage beyond the per-step request count.
- Images and other non-text parts.
