# Agent Stream — an OpenAI Codex Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** With OpenAI Codex selected, agent steps and planner turns run on the user's ChatGPT subscription through their own installed `codex` CLI (`codex app-server`), with every shell command and file change going through Agent Stream's `ToolGate`, read-only steps that can't change anything, private paths kept private, and a run that keeps the provider it started with.

**Architecture:**
- **Engine (VS Code-free), `engine/src/providers/codex/`:**
  - `protocol.ts`: hand-written types for only the app-server messages we use (codex-cli 0.160.0);
  - `connection.ts`: `openCodex`, a newline-delimited JSON-RPC 2.0 client over the spawned process's stdio, with `sanitizedCodexEnv`, Windows `.cmd` spawning and `CodexRpcError`;
  - `auth.ts`: `findCodex` and the account status;
  - `models.ts`: `model/list` → `ModelChoice`, the model-list cache, the effort check;
  - `readOnlyCommand.ts`: `classifyCommand`, the "commands that only read" rule and the private-path check;
  - `approvals.ts`: server requests → `ToolGate` decisions;
  - `turn.ts`: one `turn/start` from start to `turn/completed`, Stop and process exit;
  - `runStep.ts`, `planTurn.ts`, `index.ts` (`createCodexProvider`).
- **Shared:** `ProviderId` gains `'codex'`, `EffortLevel` gains `'ultra'`, `ModelChoice` gains `isDefault`.
- **Extension:** `EngineManager.providerFor('codex')`, the `agentStream.codexPath` setting, the manifest.
- **Web:** a `Patch` approval-card layout; the step log stops claiming `~$0.00 API-equivalent` for a provider that reports tokens but no cost.

**Tech Stack:** TypeScript 7 (strict, noEmit), npm workspaces (`shared`, `engine`, `web`, `extension`), Vitest 5, zod 4.6.5 (`z.toJSONSchema`), React 19, Node `child_process.spawn` and `node:stream` `PassThrough` (for the fake app-server), JSON-RPC 2.0 over newline-delimited stdio.

**Spec:** `docs/superpowers/specs/2026-10-04-agent-stream-codex-provider-design.md` (committed at 6f4e7de). It is the binding authority, and every section number below (§n) refers to it. The protocol shapes in this plan were checked against `codex app-server generate-ts --experimental` output for 0.160.0 and against two live probes (§2); the plan copies what it needs into `protocol.ts` and nothing reads those files at runtime.

**Order:**
- Effort `ultra` and the Default model's levels (Task 1).
- The protocol types, the fake app-server and the connection (Task 2).
- Finding Codex and its status (Task 3), models (Task 4).
- The read-only command rule (Task 5) and the approval mapping (Task 6).
- The turn lifecycle (Task 7), steps (Task 8), the planner (Task 9).
- The provider and its wiring (Task 10), the settings, Select Provider and the integration check (Task 11).
- The web approval card and usage line (Task 12), the docs and the full verification (Task 13).

**Planning rulings** (decided while writing this plan; each costs a small rework if wrong):
- **R1. "Commands that only read" is narrower than §4.5's three conditions, never wider.** Codex documents `commandActions` as "best-effort parsed command actions for friendly display", so Agent Stream reads the real `command` itself and uses the actions only as a first filter (condition 1). Every rule below only makes more commands ask:
  - **One simple command.** `command` is split into words (single and double quotes; an unbalanced quote asks). A `<shell> -c '<script>'` or `<shell> -lc '<script>'` wrapper (`sh`, `bash`, `zsh`, `dash`, `ksh`) is unwrapped once: that is how Codex sends commands (§2 probe: `/bin/zsh -lc 'cat notes.txt'`).
  - **Special characters.** The spec's list (`;` `&` `|` `>` `<` `` ` `` `$(`) becomes `;` `&` `|` `<` `>` `` ` `` `$` `~` `*` `?` `[` `]` `{` `}` `%` `(` `)` `!` and line breaks. They are checked on `command` and on every action's `command`, inside quotes too. On Windows `,` is added (PowerShell arrays). Outside Windows a backslash asks. A word starting with `=` asks (zsh expands `=name` to a path). These make the shell open files other than the words it was given, or run code: `cat $HOME/.agent-stream/values/x.json`, `cat .agent-stream/run*/r1/run.json`, zsh glob qualifiers such as `notes.txt(e:…:)`.
  - **Programs.** The first word must be exactly one of `cat head tail nl wc ls pwd stat grep egrep fgrep rg find sed`. A path such as `./cat` or `/bin/cat`, or a leading `VAR=value` (`LD_PRELOAD=…`), asks. And:
    - `find` without `-exec -execdir -ok -okdir -delete -fprint -fprint0 -fprintf -fls`;
    - `sed` only as `sed -n <N>p` or `sed -n <N>,<M>p` followed by files;
    - `rg` without `--pre`, `--pre-glob`, `--hidden`, `--no-ignore…`, `--unrestricted`, `--search-zip`, or a short-flag cluster holding `u`, `.` or `z`;
    - `grep`/`egrep`/`fgrep` without `-r`, `-R`, `-d`, `--recursive`, `--dereference-recursive` or `--directories`, because grep has no ignore rules and walks into `.agent-stream/runs`;
    - `tail` without `-f`, `-F`, `--follow` or `--retry` (it would never end).
  - **Every operand of these programs is privacy-checked,** not only the actions' `path`s: `cat notes.txt <values file>` reports one read action whose `path` is `notes.txt`. The searching programs (`ls`, `find`, `grep`, `rg`) are checked as Grep would be, including the folder they search when no folder is named. A private operand is declined without asking, like a private `path`. Other programs' words aren't checked (they ask anyway, and their words needn't be paths).
  - **`rg` or `grep` naming a `.agent-stream` folder asks.** ripgrep skips dot folders by default, so `rg foo .` stays automatic, but `rg foo .agent-stream` would search `runs/` inside it.
  - **Extra permissions:** a request with `kind` other than `command`, or with `additionalPermissions` or `networkApprovalContext`, asks.
  - **Windows:** how Codex wraps commands there isn't verified (§2). A wrapper that isn't `<shell> -c` leaves a first word that isn't a listed program, so the read asks.
- **R2. Plain reads run in read-only steps and in the planner too.** The read-only sandbox backs them. §4.5's "every request is declined" for read-only steps is read as every request that reaches the gate's `approve`, which refuses without asking.
- **R3. Declining extra permissions** answers `{ permissions: {}, scope: 'turn' }`. `PermissionsRequestApprovalResponse` has no `decision` field; an empty grant is the protocol's "no".
- **R4. `CodexConnection` gains `onExit(handler)`.** The spec's interface has no way to learn that the process ended while no request is pending (mid-turn). `SpawnCodex.onExit`'s callback also receives the spawn `Error` when the process couldn't start, so the message says why.
- **R5. `status()` checks again on every call** (startup, a setting change, Check again, Select Provider). Concurrent calls share one check, and the last found path is kept for steps, turns and the model list. This is how §4.3's "caches the result for the window" is read: a cached "not signed in" would ignore the user's `codex login` until a reload.
- **R6. The two status rows §4.3 gives no label for:** not found → label `Codex: not found`; connection error → label `Codex: not available`.
- **R7. Plan names:** underscores become spaces and the first letter is capitalised (`plus` → `Plus`, `self_serve_business_prolite` → `Self serve business prolite`).
- **R8. The Default entry's levels:** `ModelChoice` gains `isDefault?: boolean`. `defaultEffortsFor(models, undefined)` falls back to the `isDefault` model when there is no Claude-style `default` row.
- **R9. Effort:** sent when set, unless the listed model (or, for Default, the `isDefault` model) doesn't offer it. Then it is dropped with a one-time log line. It is kept when the list is unknown or doesn't name the model, as Claude's `modelOptions` does.
- **R10. `thread/resume` also sends `cwd`, `approvalPolicy: 'untrusted'`, `sandbox: 'read-only'` and `developerInstructions`** (and `model` when set). If Codex didn't persist the thread's policy, resuming would otherwise fall back to the user's own Codex config, which could be `never`. Probe 2 verified that resume keeps the dynamic tools, so §4.7's fresh-thread fallback is not built.
- **R11. Usage:** from `thread/tokenUsage/updated`'s `total`:
  - `inputTokens = inputTokens − cachedInputTokens − cacheWriteInputTokens` (never below 0);
  - `cacheReadTokens = cachedInputTokens`, `cacheWriteTokens = cacheWriteInputTokens`;
  - `outputTokens` as reported;
  - `costUsd: 0`, `turns: 1`.
  The step log and the run report then show the `~$… API-equivalent` part only when the cost is above 0.
- **R12. An `error` notification with `willRetry: true`** is logged as a `text` line `Codex: <message> (retrying)`. Only `willRetry: false` errors become the failure message.
- **R13. The reason a command or change was declined** is kept per item and shown in its `tool_result` as `declined: <reason>`. Codex's `decline` carries no message, so otherwise the log would only say `declined`.
- **R14. File-change approvals:**
  - A request whose item was never seen in `item/started` is declined without asking: `Codex asked to change files it didn't name; declined.`
  - A request with `grantRoot` (session-wide write access) is declined without asking: `Codex asked to write anywhere under <root> for the rest of the session; declined.`
  Notifications are handled in arrival order, before the request handler starts.
- **R15. Windows `.cmd`/`.bat`:** spawned as `%SystemRoot%\System32\cmd.exe /d /s /c "<line>"` with `windowsVerbatimArguments`, each argument quoted as the Microsoft C runtime reads it back. Using the full path matches `killTree`'s `taskkill`.
- **R16. Unsupported server requests** get JSON-RPC error `-32601` with `Agent Stream doesn't support this request.` That covers `item/tool/requestUserInput`, `mcpServer/elicitation/request`, the legacy `execCommandApproval`/`applyPatchApproval`, `currentTime/read`, `attestation/generate`, `account/chatgptAuthTokens/refresh` and anything new. A handler that throws something else answers `-32603`.
- **R17. Dynamic tool schemas** drop zod's `$schema` key.
- **R18. Approval cards are withdrawn when the step or turn ends.** Every gate call gets a signal that aborts when the connection ends or `runStep`/`planTurn` returns, so a card can't outlive its Codex process.
- **R19. Timeouts:** `model/list` (paginated through `nextCursor`, at most 10 pages) and `account/read` each have 30 s.
- **R20. The integration test** points `agentStream.codexPath` at a file that doesn't exist before selecting Codex, so it never starts a real Codex, even on a machine that has one.
- **R21. `clientInfo.version`** is the constant `'0.2.0'`, the engine's version (informational; Codex puts it in its user agent).
- **R22. A turn that ends `interrupted` without a Stop** fails with `Codex failed: the turn was interrupted.` A `failed` turn without an error fails with `Codex failed: the turn failed.`
- **R23. The session store** validates `provider` with `z.enum(PROVIDER_IDS)`. Its hard-coded `['claude', 'copilot']` would drop a saved Codex conversation on reload.
- **R24. Planner Stop before a thread exists** returns `{ ok: false, error: 'cancelled' }`. While resuming, it returns `{ ok: true, sessionId: turn.resume, error: 'cancelled' }`, so the conversation is kept.
- **R25. `sanitizedCodexEnv` matches names without case and also removes `ELECTRON_RUN_AS_NODE`.** Windows variable names have no case, so `openai_api_key` is removed too. `ELECTRON_RUN_AS_NODE` is VS Code's process flag, which `childEnv` and Claude's `sanitizedEnv` already remove; commands Codex runs would inherit it.
- **R26. File changes to private paths are declined without asking**, with the privacy reason. Private paths are the values files, `.agent-stream/runs/*` and `.agent-stream/sessions/*`. The agent loop's Edit and Write refuse the same paths.
- **R27. Any JSON-RPC error answering `thread/resume` counts as "not found"** (`resumeFailed`). The provider can't tell an expired thread from another refusal. Dropping the conversation is what lets the next message start fresh instead of failing the same way.
- **R28. Codex statuses come from `auth.ts` without a `provider` field** (`CodexStatus = Omit<ProviderStatus, 'provider'>`). `createCodexProvider` adds `provider: 'codex'` in Task 10, where `ProviderId` gains `'codex'`. Adding `'codex'` earlier would break the extension's exhaustive provider map until its wiring exists.
- **R29. Notifications and the Approvals view name a `Patch`'s files** (`n2 Step wants to change a.ts, b.ts`), through `approvalSentence` and `approvalSummary`. Without this they would say `wants to use Patch`.
- **R30. Retrying errors in planner turns are logged, not shown in the chat.** Steps show them as a `text` line (R12). A chat line saying "retrying" would be saved as an assistant message.
- **R31. Claude has no `ultra`.** With `ultra` set (the settings' default, or a conversation's choice made on Codex), a Claude run or chat drops it with a warning line, as for any level the model doesn't offer. The Claude SDK's `effort` option doesn't accept `ultra`, so without this the typecheck fails.

## Global Constraints

- TypeScript strict everywhere. `npm run typecheck` passes after every task.
- `engine/` and `shared/` never import `vscode`. Only `extension/` does.
- No new runtime dependencies. No Codex SDK; the client is hand-written (§3 Approach A).
- Node ≥ 20.11 (root `package.json` `engines`). `AbortSignal.timeout` and `AbortSignal.any` are available.
- Windows paths:
  - Paths are built with `path.join`/`path.resolve`, never with a hard-coded `/`.
  - Tests build expected paths with `resolve('/', …)` so they carry the drive on Windows, like `privatePaths.test.ts`.
  - Platform-specific behaviour (`findCodex`, `codexSpawnSpec`, `shellWords`) takes `platform` as a parameter, and tests pass it explicitly.
- **No test runs the real `codex` or touches the network.** Engine tests use the fake app-server in `engine/test/codexFake.ts` through an injected `SpawnCodex`. `realSpawnCodex` is never called in a test. CI runs on Windows, macOS and Linux without Codex.
- The repo is public: no credentials, tokens, real emails, account ids or absolute home paths in code, tests or fixtures. Fixtures use `someone@example.com`, `/w`, `/bin/codex` and `resolve('/', 'work', 'proj')`-style paths.
- Existing tests keep their assertions. The exceptions are mechanical additions that new required fields force on test literals (`codexPath: ''` in the `Settings` literals, Task 10), each named in its task.
- Exact user-facing strings, verbatim from the spec:
  - Provider name (§3): `OpenAI Codex`. Status label (§3, §4.3): `` `Codex (${plan})` ``, detail `Signed in with ChatGPT.`
  - Not found (§4.3): `Could not find Codex (codex). Install it from https://developers.openai.com/codex and sign in with ChatGPT, or set agentStream.codexPath.`
  - Not signed in (§4.3): label `Codex: not signed in`, error `Run codex login in a terminal and sign in with ChatGPT.`
  - API key (§4.3): label `Codex: API key`, error `Agent Stream uses your ChatGPT subscription for Codex. Run codex logout, then codex login and choose ChatGPT.`
  - Start failure (§4.2): `` `Codex didn't start: ${reason}` ``; process exit (§4.2): `` `Codex stopped unexpectedly (exit ${code}).` `` plus the stderr tail on the next line.
  - Codex errors (§7): `` `Codex failed: ${message}` ``.
  - Permissions (§4.5): `Codex asked for extra permissions; declined.`
  - Unsupported request (§4.5): `Agent Stream doesn't support this request.`
  - Step preamble (§4.6): `` `You are an agent running one step of a workflow in ${cwd}. Do the work, then reply with a summary of what you did.` ``
  - Reasoning (§4.6): `` `Thinking: ${summary}` ``. Command result (§4.6): output, then `` `exit ${code}` `` or `declined`.
  - Resume failure (§4.7): `The earlier Codex conversation was not found.`
  - Unknown dynamic tool (§4.5 `success: false`, text as the agent loop's): `` `Unknown tool ${name}.` ``
- Exact protocol values (§4.2, §4.6, §4.7):
  - Arguments: `app-server -c forced_login_method="chatgpt"` (the quotes are part of the argument). Removed variables: `OPENAI_API_KEY`, `CODEX_API_KEY`, `OPENAI_BASE_URL`.
  - `initialize { clientInfo: { name: "agent-stream", title: "Agent Stream", version }, capabilities: { experimentalApi: true, requestAttestation: false } }`, then the `initialized` notification. 30 s to answer.
  - Steps: `approvalPolicy: "untrusted"`, `sandbox: "workspace-write"` or `"read-only"`, `ephemeral: true`. Planner: `sandbox: "read-only"`, `ephemeral: false`. `acceptForSession` is never sent.
  - `turn/start { threadId, input: [{ type: "text", text, text_elements: [] }], effort? }`. Stop: `turn/interrupt { threadId, turnId }`, then 5 s for `turn/completed`.
  - Output truncation: 30,000 characters (`MAX_RESULT_CHARS`, through `clipResult`). Stderr tail: the last 2,000 characters, ANSI colour codes removed.
- Run every command from the repo root, on branch `feat/codex-provider`.
  - Never push.
  - Never run `npm run package`.
  - Never set `AGENT_STREAM_LIVE`.
  - Don't touch the untracked `logs/` or `.DS_Store`. Stage files by name only (`git add <paths>`), never `git add -A` or `git add .`.
- Every commit message ends with a `Co-Authored-By:` trailer naming the model that wrote that commit. The commit steps below show `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; a different model writes its own name instead.

## Review Focus

These are five failure modes the spec implies but that no task's main tests would naturally exercise, most likely first. Each is pinned by a test in the task that owns the code.

1. **A plain-looking read that opens a private file the parser didn't name.** `cat notes.txt <values file>`, `cat $HOME/.agent-stream/values/x.json`, `cat .agent-stream/run*/r1/run.json` and `cat .agent-stream/run\s/r1/run.json` all look like reads of an ordinary path. Each must be declined (if an operand is private) or ask, never run silently. Pinned in Task 5: `codexReadOnly.test.ts` › "checks every operand, not only the parsed path" and "asks when the shell could open other files than the words say".
2. **A recursive search that reaches the run records.** `grep -r secret .` walks into `.agent-stream/runs` (grep has no ignore rules), and so does `rg secret .agent-stream`. Both must ask, while `rg foo .` and `rg foo src` stay automatic. Pinned in Task 5: `codexReadOnly.test.ts` › "asks for searches that would walk into .agent-stream".
3. **A "read" program that can write or run something.** `rg --pre sh`, `find . -delete`, `sed -n '1e touch x'` and `sed -i` must ask, even though Codex may label them `search`, `listFiles` or `read`. Pinned in Task 5: `codexReadOnly.test.ts` › "asks for read programs called in ways that write or run commands".
4. **An approval card that outlives its Codex process.** If Codex exits, or the step ends, while the user is still looking at an approval card, the card must be withdrawn. Otherwise approving it later does nothing and the card never goes away. Pinned in Task 8: `codexRunStep.test.ts` › "withdraws a pending approval when Codex exits".
5. **A resumed planner conversation losing its safety settings.** After a reload, `thread/resume` must again carry `approvalPolicy: 'untrusted'` and `sandbox: 'read-only'`. Otherwise Codex could resume with the user's own config and run commands without asking. Pinned in Task 9: `codexPlanTurn.test.ts` › "resumes with the safety settings sent again".

## File map

| File | Responsibility | Task |
|---|---|---|
| `shared/src/types.ts` | `EffortLevel` `'ultra'`, `ModelChoice.isDefault` (1); `ProviderId` `'codex'`, `PROVIDER_NAMES.codex` (10) | 1, 10 |
| `shared/src/models.ts` | `defaultEffortsFor` falls back to `isDefault` | 1 |
| `engine/src/providers/claude/models.ts` | `modelOptions` drops `ultra` for Claude (R31) | 1 |
| `shared/src/format.ts` | `approvalSummary` and `approvalSentence` name a `Patch`'s files (R29) | 12 |
| `extension/package.json` | effort enum `ultra` (1); provider enum `codex`, `agentStream.codexPath`, description (11) | 1, 11 |
| `engine/src/platform.ts` | exports `envValue` and `pathDirs` | 2 |
| `engine/src/providers/codex/protocol.ts` | the app-server types we use | 2 |
| `engine/src/providers/codex/connection.ts` | `openCodex`, `CodexConnection`, `SpawnCodex`, `CodexProcess`, `realSpawnCodex`, `sanitizedCodexEnv`, `codexSpawnSpec`, `windowsQuote`, `CodexRpcError`, `CodexExitError`, `errorMessage`, `UNSUPPORTED_REQUEST` | 2 |
| `engine/test/codexFake.ts` | the fake app-server: `fakeCodex`, `FakeProc`, `FakeRpcError`, `turnHandlers`, item builders, `approvalParams`, `waitFor` | 2 |
| `engine/src/providers/codex/auth.ts` | `findCodex`, `planName`, `accountStatus`, `readCodexStatus`, `CodexStatus`, the status strings | 3 |
| `engine/src/providers/codex/models.ts` | `toModelChoice`, `fetchCodexModels`, `createModelList`, `codexEffort` | 4 |
| `engine/src/agentLoop/tools.ts` | exports `privateFolderDenial` | 5 |
| `engine/src/providers/codex/readOnlyCommand.ts` | `shellWords`, `classifyCommand`, `pathPrivacy` | 5 |
| `engine/src/providers/codex/approvals.ts` | `createServerRequestHandler`, `ApprovalContext`, `toPatchChanges`, `PatchChange` | 6 |
| `engine/src/providers/codex/turn.ts` | `runCodexTurn`, `dynamicToolSpecs`, `usageOf`, `codexFailure` | 7 |
| `engine/src/providers/codex/runStep.ts` | `codexRunStep`, `stepItemEvents`, `stepPreamble`, `CodexRunDeps` | 8 |
| `engine/src/providers/codex/planTurn.ts` | `codexPlanTurn`, `CODEX_RESUME_FAILED` | 9 |
| `engine/src/providers/codex/index.ts` | `createCodexProvider` | 10 |
| `engine/src/sessionStore.ts` | `provider: z.enum(PROVIDER_IDS)` (R23) | 10 |
| `engine/src/index.ts` | exports for the extension | 10 |
| `extension/src/settings.ts` | `Settings.codexPath` (10); `affectsProvider` (11) | 10, 11 |
| `extension/src/engines.ts` | `providerFor('codex')`, `EngineManagerDeps.findCodex` | 10 |
| `extension/src/extension.ts` | re-check on `agentStream.codexPath` | 11 |
| `extension/test/integration/suite.cjs` | the Codex check (R20) | 11 |
| `web/src/approvalView.ts`, `web/src/components/ApprovalCard.tsx`, `web/src/styles.css` | the `Patch` layout | 12 |
| `web/src/components/LogView.tsx`, `engine/src/runReport.ts` | no `~$0.00` without a cost (R11) | 12 |
| `README.md`, `extension/README.md`, `docs/windows-checklist.md` | docs and manual steps | 13 |

Test files: `engine/test/codexConnection.test.ts` (2), `codexAuth.test.ts` (3), `codexModels.test.ts` (4), `codexReadOnly.test.ts` (5), `codexApprovals.test.ts` (6), `codexTurn.test.ts` (7), `codexRunStep.test.ts` (8), `codexPlanTurn.test.ts` (9), `codexProvider.test.ts` (10), plus additions to existing test files named in each task.

**How the pieces talk (read this before any task):**
- `openCodex` spawns `codex app-server` through a `SpawnCodex` and returns a `CodexConnection` after the handshake. Each step and each planner turn opens its own connection and closes it in `finally`. `status()` and the model list open short-lived ones.
- `runStep`/`planTurn` register `createServerRequestHandler(...)` with `conn.onServerRequest`, start or resume a thread, then call `runCodexTurn`. `runCodexTurn` registers the notification handler, sends `turn/start`, and resolves on `turn/completed`, Stop, or the process exiting.
- Notifications are dispatched synchronously, in arrival order, as each line is read. So an `item/started` for a `fileChange` is recorded (in the `fileChanges` map runStep owns) before the `item/fileChange/requestApproval` that follows it is handled (R14).
- `ToolGate` is unchanged. Commands go through `classifyCommand` first: private → decline, read-only → `{ allow: true, by: 'readOnly' }`, otherwise `gate.decide('Bash', …)`. That asks the user in a write step and refuses without asking in a read-only step or the planner.

---

### Task 1: Effort `ultra` and the Default entry's levels

**Spec tests owned (§8):** the `ultra` effort in schemas and settings (the `codex` provider id comes in Task 10).

**Files:**
- Modify: `shared/src/types.ts` (`EffortLevel`, `EFFORT_LEVELS`, `ModelChoice`)
- Modify: `shared/src/models.ts` (`defaultEffortsFor`)
- Modify: `extension/package.json` (`agentStream.effort`)
- Modify: `engine/src/providers/claude/models.ts` (`modelOptions` drops `ultra`, R31)
- Test: `shared/test/models.test.ts`, `engine/test/sessionStore.test.ts`, `engine/test/claudeModels.test.ts`, `extension/test/settings.test.ts` (append)

**Interfaces:**
- Consumes: nothing new.
- Produces:
  ```ts
  // shared/src/types.ts
  export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
  export const EFFORT_LEVELS: readonly EffortLevel[]; // [..., 'max', 'ultra']
  export type ModelChoice = { value: string; label: string; description?: string; efforts: EffortLevel[]; unavailable?: boolean; resolved?: string; isDefault?: boolean };
  // shared/src/models.ts
  export function defaultEffortsFor(models: readonly ModelChoice[], defaultModel: string | undefined): EffortLevel[];
  // no defaultModel: Claude Code's `default` row, else the model marked isDefault (R8), else [].
  // engine/src/providers/claude/models.ts: modelOptions(choice, known, warn) never passes 'ultra' (R31).
  ```

- [ ] **Step 1: Write the failing tests**

In `shared/test/models.test.ts`, change the types import to:

```ts
import { EFFORT_LEVELS, type ModelChoice } from '../src/types';
```

Append:

```ts
describe('the ultra effort level', () => {
  it('is a level, after max, and a planner model choice may use it', () => {
    expect(isEffortLevel('ultra')).toBe(true);
    expect(EFFORT_LEVELS.at(-1)).toBe('ultra');
    const msg = { type: 'setPlannerModel', graphId: 'g', sessionId: 's', model: 'gpt-x', effort: 'ultra' };
    expect(parseWebviewMessage(msg)).toEqual({ ok: true, kind: 'engine', msg });
  });
});

describe('defaultEffortsFor with a provider-marked default model', () => {
  it('uses the model marked isDefault when there is no default row and no configured model (Codex)', () => {
    const models: ModelChoice[] = [
      { value: 'gpt-a', label: 'A', efforts: ['low', 'high'] },
      { value: 'gpt-b', label: 'B', efforts: ['low', 'ultra'], isDefault: true },
    ];
    expect(defaultEffortsFor(models, undefined)).toEqual(['low', 'ultra']);
    expect(defaultEffortsFor(models, 'gpt-a')).toEqual(['low', 'high']);
    expect(defaultEffortsFor([{ value: 'gpt-a', label: 'A', efforts: ['low'] }], undefined)).toEqual([]);
  });

  it("still prefers Claude Code's default row", () => {
    const models: ModelChoice[] = [
      { value: 'default', label: 'Default', efforts: ['high'] },
      { value: 'gpt-b', label: 'B', efforts: ['low'], isDefault: true },
    ];
    expect(defaultEffortsFor(models, undefined)).toEqual(['high']);
  });
});
```

In `engine/test/sessionStore.test.ts`, inside `describe('SessionStore', …)`, append:

```ts
  it('keeps an ultra effort choice across a reload', () => {
    const { paths, store } = setup();
    const a = store.create('A');
    store.setPlannerState(a.id, 'g1', { effort: 'ultra' });
    expect(new SessionStore(paths, fixedClock()).plannerState(a.id, 'g1')).toEqual({ effort: 'ultra' });
  });
```

In `engine/test/claudeModels.test.ts`, change the models import to:

```ts
import { fetchModels, modelOptions } from '../src/providers/claude/models';
```

and append:

```ts
describe("modelOptions and Codex's ultra level", () => {
  it('drops ultra for Claude with a line, even when the model list is unknown (R31)', () => {
    const warn = vi.fn();
    expect(modelOptions({ model: 'opus', effort: 'ultra' }, undefined, warn)).toEqual({ model: 'opus' });
    expect(warn).toHaveBeenCalledWith('opus|ultra', '[agent-stream] Claude has no "ultra" effort level; running without an effort level.');
    expect(modelOptions({ effort: 'ultra' }, [], warn)).toEqual({});
  });
});
```

In `extension/test/settings.test.ts`, inside `describe('readSettings', …)`, append:

```ts
  it('reads the ultra effort, and the manifest offers it with a description', () => {
    const values: Record<string, unknown> = { effort: 'ultra' };
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({ get: (key: string, fallback: unknown) => values[key] ?? fallback } as never);
    expect(readSettings().effort).toBe('ultra');
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    const effort = manifest.contributes.configuration.properties['agentStream.effort'];
    expect(effort.enum).toEqual(['', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
    expect(effort.enumDescriptions).toHaveLength(effort.enum.length);
    expect(effort.enumDescriptions.at(-1)).toBe('Ultra');
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w shared -- test/models.test.ts && npm test -w engine -- test/sessionStore.test.ts test/claudeModels.test.ts && npm test -w extension -- test/settings.test.ts`
Expected: FAIL. `isEffortLevel('ultra')` is false, `defaultEffortsFor` returns `[]` for the `isDefault` model, the session store reads the effort back as absent, Claude passes `ultra` through, and the manifest enum has no `ultra`.

- [ ] **Step 3: Write the implementation**

In `shared/src/types.ts`, replace the effort and model lines:

```ts
/** How hard the model thinks: the Claude Agent SDK's levels, plus Codex's `ultra`. A model offers only some of them. */
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
export const EFFORT_LEVELS: readonly EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
/**
 * A model a provider offers. `efforts` is empty when the model has no effort levels; `unavailable` when the provider can't
 * run it yet; `resolved` the full id an alias row stands for (sonnet → claude-sonnet-5); `isDefault` the model the provider
 * runs when none is chosen (Codex marks one; Claude Code has a `default` row instead).
 */
export type ModelChoice = { value: string; label: string; description?: string; efforts: EffortLevel[]; unavailable?: boolean; resolved?: string; isDefault?: boolean };
```

In `shared/src/models.ts`, replace `defaultEffortsFor`:

```ts
/**
 * The levels our Default offers: the configured default model's, else Claude Code's default row's, else the model the
 * provider marks as its default (Codex); [] when unknown.
 */
export function defaultEffortsFor(models: readonly ModelChoice[], defaultModel: string | undefined): EffortLevel[] {
  if (defaultModel) return findModel(models, defaultModel)?.efforts ?? [];
  return (models.find((m) => m.value === CLI_DEFAULT_MODEL) ?? models.find((m) => m.isDefault))?.efforts ?? [];
}
```

In `extension/package.json`, replace the `agentStream.effort` property's `enum` and `enumDescriptions`:

```json
          "enum": ["", "low", "medium", "high", "xhigh", "max", "ultra"],
          "default": "",
          "enumDescriptions": [
            "Default: the model's own effort level.",
            "Low", "Medium", "High", "Extra high", "Max", "Ultra"
          ],
```

In `engine/src/providers/claude/models.ts`, replace the `if (choice.effort) { … }` block in `modelOptions` with:

```ts
  if (choice.effort) {
    // No model: Claude Code's default runs, so its own default row says which levels there are.
    const id = choice.model ?? CLI_DEFAULT_MODEL;
    const effort = choice.effort;
    const entry = findModel(known, id);
    if (effort === 'ultra') {
      // Codex's level: Claude Code has none above max (R31).
      warn(`${id}|ultra`, '[agent-stream] Claude has no "ultra" effort level; running without an effort level.');
    } else if (entry && !entry.efforts.includes(effort)) {
      warn(`${id}|${effort}`, `[agent-stream] ${entry.label} (${id}) has no "${effort}" effort level; running without an effort level.`);
    } else out.effort = effort;
  }
```

`isEffortLevel`, the session store's `z.enum(EFFORT_LEVELS)` and the webview schema's effort field all read `EFFORT_LEVELS`, so they accept `ultra` with no further change.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -w shared && npm test -w engine -- test/sessionStore.test.ts test/claudeModels.test.ts && npm test -w extension -- test/settings.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck`
Expected: no errors.

```bash
git add shared/src/types.ts shared/src/models.ts extension/package.json engine/src/providers/claude/models.ts shared/test/models.test.ts engine/test/sessionStore.test.ts engine/test/claudeModels.test.ts extension/test/settings.test.ts
git commit -m "feat(shared): the ultra effort level, and Default's levels from the model a provider marks default

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: The protocol types, the fake app-server, and the connection

**Spec tests owned (§8):** Connection — the initialize handshake and the `initialized` notification; request/response matching; server requests answered or turned into errors; a malformed line ignored; a process exit rejecting pending requests with the message; `close()` killing the process; `sanitizedCodexEnv` removing the three variables; Windows `.cmd` spawning.

**Files:**
- Modify: `engine/src/platform.ts` (export `envValue` and `pathDirs`)
- Create: `engine/src/providers/codex/protocol.ts`
- Create: `engine/src/providers/codex/connection.ts`
- Create: `engine/test/codexFake.ts`
- Test: `engine/test/codexConnection.test.ts`

**Interfaces:**
- Consumes: `killTree` from `engine/src/platform.ts`.
- Produces:
  ```ts
  // engine/src/platform.ts
  export function envValue(env: NodeJS.ProcessEnv, name: string, platform: NodeJS.Platform): string | undefined;
  export function pathDirs(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[];
  // engine/src/providers/codex/connection.ts
  export const CODEX_ARGS: readonly string[];          // ['app-server', '-c', 'forced_login_method="chatgpt"']
  export const CLIENT_VERSION = '0.2.0';
  export const INIT_TIMEOUT_MS = 30_000;
  export const UNSUPPORTED_REQUEST = "Agent Stream doesn't support this request.";
  export class CodexRpcError extends Error { readonly code: number }
  export class CodexExitError extends Error { readonly code: number | null; readonly tail: string; readonly startError?: string }
  export type CodexProcess = { stdin: Writable; stdout: Readable; stderr: Readable; kill(): void; onExit(cb: (code: number | null, error?: Error) => void): void };
  export type SpawnCodex = (codexPath: string, args: readonly string[], env: NodeJS.ProcessEnv) => CodexProcess;
  export interface CodexConnection {
    request<T>(method: string, params: unknown, signal?: AbortSignal): Promise<T>;
    notify(method: string, params?: unknown): void;
    onServerRequest(handler: (method: string, params: unknown) => Promise<unknown>): void;
    onNotification(handler: (method: string, params: unknown) => void): void;
    onExit(handler: (message: string) => void): void;   // ruling R4
    close(): void;
  }
  export function sanitizedCodexEnv(env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
  export function windowsQuote(arg: string): string;
  export type SpawnSpec = { file: string; args: string[]; verbatim: boolean };
  export function codexSpawnSpec(codexPath: string, args: readonly string[], platform: NodeJS.Platform, env: NodeJS.ProcessEnv): SpawnSpec;
  export const realSpawnCodex: SpawnCodex;
  export function errorMessage(e: unknown): string;   // a timeout reads "Codex didn't answer in time."
  export function openCodex(o: { codexPath: string; spawn?: SpawnCodex; env?: NodeJS.ProcessEnv; initTimeoutMs?: number; log?: (message: string) => void }): Promise<CodexConnection>;
  // engine/test/codexFake.ts: see Step 2.
  ```

- [ ] **Step 1: Export the environment helpers from `platform.ts`**

In `engine/src/platform.ts`, add `export` to the two helpers so the Codex code can reuse them:

```ts
/** An environment variable, matched without case on Windows (`Path`, `ProgramFiles`). */
export function envValue(env: NodeJS.ProcessEnv, name: string, platform: NodeJS.Platform): string | undefined {
```

```ts
export function pathDirs(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
```

Nothing else in the file changes.

- [ ] **Step 2: Write the protocol types and the fake app-server**

Create `engine/src/providers/codex/protocol.ts`:

```ts
/**
 * The Codex app-server messages Agent Stream uses (spec §4.1), copied by hand from
 * `codex app-server generate-ts --experimental` for codex-cli 0.160.0. Only the fields we send or read: the server sends
 * more, and other item types, which are ignored. Nothing reads the generated files at runtime.
 */
export const CODEX_PROTOCOL_VERSION = '0.160.0';

// initialize / initialized
export type ClientInfo = { name: string; title: string | null; version: string };
export type InitializeParams = { clientInfo: ClientInfo; capabilities: { experimentalApi: boolean; requestAttestation: boolean } | null };

// account/read
/** "free" | "go" | "plus" | "pro" | "team" | "business" | "enterprise" | … (kept open: new plans appear). */
export type PlanType = string;
export type Account = { type: 'apiKey' } | { type: 'chatgpt'; email: string | null; planType: PlanType } | { type: 'amazonBedrock'; usesCodexManagedCredentials: boolean };
export type GetAccountResponse = { account: Account | null; requiresOpenaiAuth: boolean };

// model/list
/** "low" | "medium" | "high" | "xhigh" | "max" | "ultra", and others such as "none" or "minimal" that Agent Stream drops. */
export type ReasoningEffort = string;
export type ReasoningEffortOption = { reasoningEffort: ReasoningEffort; description: string };
export type Model = {
  id: string;
  model: string;
  displayName: string;
  description: string;
  hidden: boolean;
  supportedReasoningEfforts: ReasoningEffortOption[];
  defaultReasoningEffort: ReasoningEffort;
  isDefault: boolean;
};
export type ModelListParams = { cursor?: string | null; limit?: number | null; includeHidden?: boolean | null };
export type ModelListResponse = { data: Model[]; nextCursor: string | null };

// thread/start, thread/resume
export type AskForApproval = 'untrusted' | 'on-request' | 'never';
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';
export type DynamicToolSpec = { type: 'function'; name: string; description: string; inputSchema: unknown };
export type ThreadStartParams = {
  model?: string | null;
  cwd?: string | null;
  approvalPolicy?: AskForApproval | null;
  sandbox?: SandboxMode | null;
  developerInstructions?: string | null;
  ephemeral?: boolean | null;
  dynamicTools?: DynamicToolSpec[] | null;
};
export type ThreadResumeParams = {
  threadId: string;
  model?: string | null;
  cwd?: string | null;
  approvalPolicy?: AskForApproval | null;
  sandbox?: SandboxMode | null;
  developerInstructions?: string | null;
};
/** The part of ThreadStartResponse and ThreadResumeResponse we read. */
export type ThreadResponse = { thread: { id: string } };

// turn/start, turn/interrupt
export type TextElement = { byteRange: { start: number; end: number }; placeholder: string | null };
export type UserInput = { type: 'text'; text: string; text_elements: TextElement[] };
export type TurnStartParams = { threadId: string; input: UserInput[]; effort?: ReasoningEffort | null };
export type TurnStatus = 'completed' | 'interrupted' | 'failed' | 'inProgress';
export type TurnError = { message: string; additionalDetails: string | null };
export type Turn = { id: string; status: TurnStatus; error: TurnError | null };
export type TurnStartResponse = { turn: Turn };
export type TurnInterruptParams = { threadId: string; turnId: string };

// Items, as item/started and item/completed carry them
export type CommandAction =
  | { type: 'read'; command: string; name: string; path: string }
  | { type: 'listFiles'; command: string; path: string | null }
  | { type: 'search'; command: string; query: string | null; path: string | null }
  | { type: 'unknown'; command: string };
export type PatchChangeKind = { type: 'add' } | { type: 'delete' } | { type: 'update'; move_path: string | null };
export type FileUpdateChange = { path: string; kind: PatchChangeKind; diff: string };
export type DynamicToolContentItem = { type: 'inputText'; text: string } | { type: 'inputImage'; imageUrl: string } | { type: 'inputAudio'; audioUrl: string };
export type ThreadItem =
  | { type: 'agentMessage'; id: string; text: string }
  | { type: 'reasoning'; id: string; summary: string[]; content: string[] }
  | {
      type: 'commandExecution';
      id: string;
      command: string;
      cwd: string;
      status: 'inProgress' | 'completed' | 'failed' | 'declined';
      commandActions: CommandAction[];
      aggregatedOutput: string | null;
      exitCode: number | null;
    }
  | { type: 'fileChange'; id: string; changes: FileUpdateChange[]; status: 'inProgress' | 'completed' | 'failed' | 'declined' }
  | {
      type: 'dynamicToolCall';
      id: string;
      namespace: string | null;
      tool: string;
      arguments: unknown;
      status: 'inProgress' | 'completed' | 'failed';
      contentItems: DynamicToolContentItem[] | null;
      success: boolean | null;
    }
  | { type: 'userMessage'; id: string };

// Notifications: item/started, item/completed, turn/completed, error, thread/tokenUsage/updated
export type ItemNotification = { item: ThreadItem; threadId: string; turnId: string };
export type TurnCompletedNotification = { threadId: string; turn: Turn };
export type ErrorNotification = { error: TurnError; willRetry: boolean; threadId: string; turnId: string };
export type TokenUsageBreakdown = { totalTokens: number; inputTokens: number; cachedInputTokens: number; cacheWriteInputTokens: number; outputTokens: number; reasoningOutputTokens: number };
export type ThreadTokenUsageUpdatedNotification = { threadId: string; turnId: string; tokenUsage: { total: TokenUsageBreakdown; last: TokenUsageBreakdown } };

// Server requests: item/commandExecution/requestApproval, item/fileChange/requestApproval, item/permissions/requestApproval,
// item/tool/call; item/tool/requestUserInput and mcpServer/elicitation/request are refused without reading their params.
export type CommandExecutionRequestApprovalParams = {
  /** "command", or "writeStdin" for input to a running terminal. Older servers leave it out. */
  kind?: 'command' | 'writeStdin';
  threadId: string;
  turnId: string;
  itemId: string;
  approvalId?: string | null;
  reason?: string | null;
  networkApprovalContext?: unknown;
  command?: string | null;
  cwd?: string | null;
  /** "Best-effort parsed command actions for friendly display." */
  commandActions?: CommandAction[] | null;
  additionalPermissions?: unknown;
};
/** We never send acceptForSession or the policy-amendment forms. */
export type CommandExecutionRequestApprovalResponse = { decision: 'accept' | 'decline' };
export type FileChangeRequestApprovalParams = { threadId: string; turnId: string; itemId: string; reason?: string | null; grantRoot?: string | null };
export type FileChangeRequestApprovalResponse = { decision: 'accept' | 'decline' };
export type PermissionsRequestApprovalParams = { threadId: string; turnId: string; itemId: string; reason: string | null; permissions: unknown };
/** An empty grant is the protocol's "no" (ruling R3). */
export type PermissionsRequestApprovalResponse = { permissions: Record<string, never>; scope: 'turn' | 'session' };
export type DynamicToolCallParams = { threadId: string; turnId: string; callId: string; namespace: string | null; tool: string; arguments: unknown };
export type DynamicToolCallResponse = { contentItems: { type: 'inputText'; text: string }[]; success: boolean };
```

Create `engine/test/codexFake.ts`:

```ts
import { basename } from 'node:path';
import { PassThrough } from 'node:stream';
import type { CodexProcess, SpawnCodex } from '../src/providers/codex/connection';
import type { CommandAction, FileUpdateChange, ThreadItem, TokenUsageBreakdown, TurnStatus } from '../src/providers/codex/protocol';

/** One JSON-RPC message, either way. Params are `any` so tests can read them without casts. */
export type Msg = { jsonrpc?: string; id?: number | string; method?: string; params?: any; result?: any; error?: { code: number; message: string } };
/** Answers one client request: the return value is the result; a throw is an error answer. */
export type FakeHandler = (params: any, proc: FakeProc) => unknown;

/** A handler throws this to answer with a specific JSON-RPC error code. */
export class FakeRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

export const INIT_RESULT = { userAgent: 'fake-codex/0.160.0', codexHome: '/fake-codex-home', platformFamily: 'unix', platformOs: 'linux' };

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * The fake `codex app-server` process: in-memory stdio speaking newline-delimited JSON-RPC (spec §8). It answers the
 * client's requests from `handlers`, records everything the client sent, and lets a test send notifications and server
 * requests, write raw lines, or end the process. No real Codex, no network.
 */
export class FakeProc implements CodexProcess {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  /** Everything the client sent, in order. */
  readonly received: Msg[] = [];
  killed = false;
  exited = false;
  private exitCallbacks: ((code: number | null, error?: Error) => void)[] = [];
  private answers = new Map<number, (m: Msg) => void>();
  private nextId = 1000;

  constructor(
    readonly codexPath: string,
    readonly args: readonly string[],
    readonly env: NodeJS.ProcessEnv,
    private handlers: Record<string, FakeHandler>,
  ) {
    let buffer = '';
    this.stdin.setEncoding('utf8');
    this.stdin.on('data', (chunk: string) => {
      buffer += chunk;
      for (let i = buffer.indexOf('\n'); i >= 0; i = buffer.indexOf('\n')) {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 1);
        if (line.trim()) void this.onMessage(JSON.parse(line) as Msg);
      }
    });
  }

  private async onMessage(m: Msg): Promise<void> {
    this.received.push(m);
    if (m.method !== undefined && m.id !== undefined) {
      const handler = this.handlers[m.method];
      if (!handler) return this.send({ id: m.id, error: { code: -32601, message: `fake: no handler for ${m.method}` } });
      try {
        this.send({ id: m.id, result: (await handler(m.params, this)) ?? {} });
      } catch (e) {
        this.send({ id: m.id, error: { code: e instanceof FakeRpcError ? e.code : -32603, message: e instanceof Error ? e.message : String(e) } });
      }
      return;
    }
    if (m.method === undefined && typeof m.id === 'number') {
      this.answers.get(m.id)?.(m);
      this.answers.delete(m.id);
    }
  }

  send(m: Msg): void {
    if (!this.exited) this.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`);
  }

  notify(method: string, params: unknown): void {
    this.send({ method, params });
  }

  /** A server request; resolves with the client's answer (`result` or `error`). */
  request(method: string, params: unknown): Promise<Msg> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.answers.set(id, resolve);
      this.send({ id, method, params });
    });
  }

  writeRaw(text: string): void {
    this.stdout.write(text);
  }

  /** The process ends by itself: stderr first, then the exit, as a real process reports it. */
  async exit(code: number | null, stderr = ''): Promise<void> {
    if (this.exited) return;
    if (stderr) this.stderr.write(stderr);
    await tick();
    this.exited = true;
    for (const cb of this.exitCallbacks) cb(code);
  }

  /** The process could not be started at all (ENOENT). */
  async failToStart(error: Error): Promise<void> {
    await tick();
    this.exited = true;
    for (const cb of this.exitCallbacks) cb(null, error);
  }

  kill(): void {
    this.killed = true;
    void this.exit(null);
  }

  onExit(cb: (code: number | null, error?: Error) => void): void {
    this.exitCallbacks.push(cb);
  }

  /** The methods of the client's requests and notifications, in order. */
  methods(): string[] {
    return this.received.flatMap((m) => (m.method ? [m.method] : []));
  }

  /** The params of the client's first message with this method. */
    paramsOf(method: string): any {
    return this.received.find((m) => m.method === method)?.params;
  }
}

/** A SpawnCodex that starts a FakeProc answering `initialize` and `handlers`. */
export function fakeCodex(handlers: Record<string, FakeHandler> = {}) {
  const procs: FakeProc[] = [];
  const spawn: SpawnCodex = (codexPath, args, env) => {
    const p = new FakeProc(codexPath, args, env, { initialize: () => INIT_RESULT, ...handlers });
    procs.push(p);
    return p;
  };
  const last = (): FakeProc => {
    const p = procs.at(-1);
    if (!p) throw new Error('fakeCodex: nothing was spawned');
    return p;
  };
  return { spawn, procs, last };
}

/** What a scripted turn can do once `turn/start` was answered. */
export type TurnScript = {
  proc: FakeProc;
  threadId: string;
  turnId: string;
  /** item/started with `item`, then item/completed with `done` (default: the same item). */
  item(item: ThreadItem, done?: ThreadItem): void;
  started(item: ThreadItem): void;
  completed(item: ThreadItem): void;
  /** A server request for this turn; resolves with the client's answer. */
  ask(method: string, params: object): Promise<Msg>;
  usage(total: Partial<TokenUsageBreakdown>): void;
  error(message: string, willRetry?: boolean): void;
  /** turn/completed. */
  end(status?: TurnStatus, error?: string): void;
};

/**
 * Handlers for one scripted turn: thread/start answers `threadId`, thread/resume echoes its id, turn/start answers
 * `turnId` and then runs `script` (after the answer is written), and turn/interrupt completes the turn as interrupted
 * unless `onInterrupt` is 'ignore'.
 */
export function turnHandlers(o: { threadId?: string; turnId?: string; script?: (t: TurnScript) => unknown; onInterrupt?: 'complete' | 'ignore' }): Record<string, FakeHandler> {
  const threadId = o.threadId ?? 'thread-1';
  const turnId = o.turnId ?? 'turn-1';
  return {
    'thread/start': () => ({ thread: { id: threadId } }),
    'thread/resume': (p: { threadId: string }) => ({ thread: { id: p.threadId } }),
    'turn/start': (p: { threadId: string }, proc) => {
      const t = turnScript(proc, p.threadId, turnId);
      setImmediate(() => void o.script?.(t));
      return { turn: { id: turnId, status: 'inProgress', error: null, items: [] } };
    },
    'turn/interrupt': (p: { threadId: string; turnId: string }, proc) => {
      if (o.onInterrupt !== 'ignore') setImmediate(() => proc.notify('turn/completed', { threadId: p.threadId, turn: { id: p.turnId, status: 'interrupted', error: null, items: [] } }));
      return {};
    },
  };
}

function turnScript(proc: FakeProc, threadId: string, turnId: string): TurnScript {
  const at = { threadId, turnId };
  const t: TurnScript = {
    proc,
    threadId,
    turnId,
    started: (item) => proc.notify('item/started', { ...at, item, startedAtMs: 0 }),
    completed: (item) => proc.notify('item/completed', { ...at, item, completedAtMs: 0 }),
    item: (item, done) => {
      t.started(item);
      t.completed(done ?? item);
    },
    ask: (method, params) => proc.request(method, { ...at, ...params }),
    usage: (total) => {
      const full = { totalTokens: 0, inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, ...total };
      proc.notify('thread/tokenUsage/updated', { ...at, tokenUsage: { total: full, last: full, modelContextWindow: null } });
    },
    error: (message, willRetry = false) => proc.notify('error', { ...at, willRetry, error: { message, codexErrorInfo: null, additionalDetails: null } }),
    end: (status = 'completed', error) =>
      proc.notify('turn/completed', { threadId, turn: { id: turnId, status, error: error ? { message: error, codexErrorInfo: null, additionalDetails: null } : null, items: [] } }),
  };
  return t;
}

export const agentMessage = (text: string, id = 'msg-1'): ThreadItem => ({ type: 'agentMessage', id, text });
export const reasoning = (summary: string[], id = 'rs-1'): ThreadItem => ({ type: 'reasoning', id, summary, content: [] });
export const readAction = (command: string, path: string): CommandAction => ({ type: 'read', command, name: basename(path), path });

export function commandItem(o: {
  id?: string;
  command: string;
  cwd?: string;
  status: 'inProgress' | 'completed' | 'failed' | 'declined';
  output?: string | null;
  exitCode?: number | null;
  actions?: CommandAction[];
}): ThreadItem {
  return { type: 'commandExecution', id: o.id ?? 'cmd-1', command: o.command, cwd: o.cwd ?? '/w', status: o.status, commandActions: o.actions ?? [], aggregatedOutput: o.output ?? null, exitCode: o.exitCode ?? null };
}

export function fileChangeItem(o: { id?: string; changes: FileUpdateChange[]; status: 'inProgress' | 'completed' | 'failed' | 'declined' }): ThreadItem {
  return { type: 'fileChange', id: o.id ?? 'patch-1', changes: o.changes, status: o.status };
}

export function toolCallItem(o: { id?: string; tool: string; args: unknown; status: 'inProgress' | 'completed' | 'failed'; text?: string; success?: boolean | null }): ThreadItem {
  return {
    type: 'dynamicToolCall',
    id: o.id ?? 'tool-1',
    namespace: null,
    tool: o.tool,
    arguments: o.args,
    status: o.status,
    contentItems: o.text === undefined ? null : [{ type: 'inputText', text: o.text }],
    success: o.success ?? null,
  };
}

/** The params of an item/commandExecution/requestApproval, as Codex 0.160.0 sends them (§2 probe 2). */
export function approvalParams(o: { itemId?: string; command: string; cwd: string; actions?: CommandAction[] | null; reason?: string; kind?: 'command' | 'writeStdin'; extra?: object }) {
  return {
    kind: o.kind ?? 'command',
    threadId: 'thread-1',
    turnId: 'turn-1',
    itemId: o.itemId ?? 'cmd-1',
    startedAtMs: 0,
    environmentId: 'local',
    command: o.command,
    cwd: o.cwd,
    commandActions: o.actions === undefined ? [] : o.actions,
    ...(o.reason !== undefined && { reason: o.reason }),
    ...o.extra,
  };
}

export async function waitFor(check: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
```

- [ ] **Step 3: Write the failing connection tests**

Create `engine/test/codexConnection.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import {
  CODEX_ARGS,
  CodexRpcError,
  codexSpawnSpec,
  errorMessage,
  openCodex,
  sanitizedCodexEnv,
  UNSUPPORTED_REQUEST,
  windowsQuote,
} from '../src/providers/codex/connection';
import { fakeCodex, FakeRpcError, waitFor, type FakeHandler } from './codexFake';

const never = () => new Promise<never>(() => {});

async function connected(handlers: Record<string, FakeHandler> = {}, log: (m: string) => void = () => {}) {
  const fake = fakeCodex(handlers);
  const conn = await openCodex({ codexPath: '/bin/codex', spawn: fake.spawn, env: {}, log });
  return { conn, proc: fake.last() };
}

describe('openCodex', () => {
  it('starts codex app-server for ChatGPT sign-in, without API-key variables, and completes the handshake', async () => {
    const fake = fakeCodex();
    const conn = await openCodex({ codexPath: '/bin/codex', spawn: fake.spawn, env: { PATH: '/bin', OPENAI_API_KEY: 'placeholder' } });
    const p = fake.last();
    expect(p.codexPath).toBe('/bin/codex');
    expect(p.args).toEqual(['app-server', '-c', 'forced_login_method="chatgpt"']);
    expect(p.env).toEqual({ PATH: '/bin' });
    await waitFor(() => p.received.length === 2);
    expect(p.received[0]).toMatchObject({
      method: 'initialize',
      params: { clientInfo: { name: 'agent-stream', title: 'Agent Stream', version: '0.2.0' }, capabilities: { experimentalApi: true, requestAttestation: false } },
    });
    expect(p.received[1].method).toBe('initialized');
    expect(p.received[1].id).toBeUndefined();
    conn.close();
  });

  it("says why Codex didn't start: an error answer, no answer in time, an exit, or a failed spawn", async () => {
    const refused = fakeCodex({ initialize: () => { throw new FakeRpcError(-32600, 'bad client'); } });
    await expect(openCodex({ codexPath: '/bin/codex', spawn: refused.spawn })).rejects.toThrow("Codex didn't start: bad client");
    expect(refused.last().killed).toBe(true);

    const silent = fakeCodex({ initialize: never });
    await expect(openCodex({ codexPath: '/bin/codex', spawn: silent.spawn, initTimeoutMs: 20 })).rejects.toThrow("Codex didn't start: no answer within 0.02 s");
    expect(silent.last().killed).toBe(true);

    const exits = fakeCodex({ initialize: (_p, proc) => { void proc.exit(1, 'error: unknown option\n'); return never(); } });
    await expect(openCodex({ codexPath: '/bin/codex', spawn: exits.spawn })).rejects.toThrow("Codex didn't start: exit 1.\nerror: unknown option");

    const missing = fakeCodex({ initialize: (_p, proc) => { void proc.failToStart(new Error('spawn /bin/codex ENOENT')); return never(); } });
    await expect(openCodex({ codexPath: '/bin/codex', spawn: missing.spawn })).rejects.toThrow("Codex didn't start: spawn /bin/codex ENOENT");
  });
});

describe('CodexConnection', () => {
  it('matches each answer to its request, even out of order, and turns error answers into CodexRpcError', async () => {
    let releaseSlow!: () => void;
    const slowGate = new Promise<void>((r) => (releaseSlow = r));
    const { conn } = await connected({
      slow: async () => {
        await slowGate;
        return { n: 1 };
      },
      fast: (p: { x: number }) => ({ n: p.x }),
      bad: () => { throw new FakeRpcError(-32001, 'model refused'); },
    });
    const slow = conn.request<{ n: number }>('slow', {});
    expect(await conn.request<{ n: number }>('fast', { x: 2 })).toEqual({ n: 2 });
    releaseSlow();
    expect(await slow).toEqual({ n: 1 });
    const error = await conn.request('bad', {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CodexRpcError);
    expect(error).toMatchObject({ code: -32001, message: 'model refused' });
    conn.close();
  });

  it("answers server requests with the handler's result, or a JSON-RPC error", async () => {
    const { conn, proc } = await connected();
    expect(await proc.request('item/tool/requestUserInput', {})).toMatchObject({ error: { code: -32601, message: UNSUPPORTED_REQUEST } });
    conn.onServerRequest(async (method, params) => {
      if (method === 'echo') return { got: params };
      if (method === 'refuse') throw new CodexRpcError(-32601, UNSUPPORTED_REQUEST);
      throw new Error('boom');
    });
    expect(await proc.request('echo', { a: 1 })).toMatchObject({ result: { got: { a: 1 } } });
    expect(await proc.request('refuse', {})).toMatchObject({ error: { code: -32601, message: UNSUPPORTED_REQUEST } });
    expect(await proc.request('other', {})).toMatchObject({ error: { code: -32603, message: 'boom' } });
    conn.close();
  });

  it('delivers notifications in order, and ignores a malformed line without logging its text', async () => {
    const log = vi.fn();
    const { conn, proc } = await connected({}, log);
    const seen: [string, unknown][] = [];
    conn.onNotification((method, params) => seen.push([method, params]));
    proc.notify('a', { n: 1 });
    proc.writeRaw('SECRET-LINE not json\n');
    proc.writeRaw('42\n');
    proc.notify('b', { n: 2 });
    await waitFor(() => seen.length === 2);
    expect(seen).toEqual([['a', { n: 1 }], ['b', { n: 2 }]]);
    expect(log).toHaveBeenCalledTimes(2);
    expect(log.mock.calls[0][0]).toContain("isn't JSON-RPC");
    expect(log.mock.calls[0][0]).not.toContain('SECRET-LINE');
    conn.close();
  });

  it('rejects every pending request when Codex exits, with the exit code and the stderr tail, and tells onExit', async () => {
    const { conn, proc } = await connected({ hang: never });
    const exits: string[] = [];
    conn.onExit((message) => exits.push(message));
    const pending = conn.request('hang', {});
    await proc.exit(3, '\u001b[2m2026-10-04\u001b[0m \u001b[31mERROR\u001b[0m model refused\n');
    const message = 'Codex stopped unexpectedly (exit 3).\n2026-10-04 ERROR model refused';
    await expect(pending).rejects.toThrow(message);
    expect(exits).toEqual([message]);
    await expect(conn.request('later', {})).rejects.toThrow(message);
  });

  it('keeps only the last 2,000 characters of stderr', async () => {
    const { conn, proc } = await connected({ hang: never });
    const pending = conn.request('hang', {});
    await proc.exit(1, `${'x'.repeat(5000)}END\n`);
    const error = (await pending.catch((e: unknown) => e)) as Error;
    const tail = error.message.split('\n')[1];
    expect(tail.length).toBe(2000);
    expect(tail.endsWith('END')).toBe(true);
  });

  it('close() kills the process and rejects pending requests, without reporting an exit', async () => {
    const { conn, proc } = await connected({ hang: never });
    const exits: string[] = [];
    conn.onExit((m) => exits.push(m));
    const pending = conn.request('hang', {});
    conn.close();
    await expect(pending).rejects.toThrow('The Codex connection was closed.');
    expect(proc.killed).toBe(true);
    await new Promise((r) => setImmediate(r));
    expect(exits).toEqual([]);
    conn.close(); // twice is harmless
  });

  it("rejects a request whose signal aborts, and the connection keeps working", async () => {
    const { conn } = await connected({ hang: never, ok: () => ({ fine: true }) });
    const ac = new AbortController();
    const pending = conn.request('hang', {}, ac.signal);
    ac.abort(new Error('stopped'));
    await expect(pending).rejects.toThrow('stopped');
    expect(await conn.request('ok', {})).toEqual({ fine: true });
    conn.close();
  });
});

describe('errorMessage', () => {
  it('reads a timeout as Codex not answering', () => {
    expect(errorMessage(new DOMException('The operation was aborted due to timeout', 'TimeoutError'))).toBe("Codex didn't answer in time.");
    expect(errorMessage(new Error('x'))).toBe('x');
    expect(errorMessage('y')).toBe('y');
  });
});

describe('sanitizedCodexEnv', () => {
  it('removes the API-key and base-URL variables in any case, and VS Code’s process flag, keeping the rest', () => {
    const env = { PATH: '/bin', HOME: '/h', OPENAI_API_KEY: 'a', CODEX_API_KEY: 'b', OPENAI_BASE_URL: 'c', openai_api_key: 'd', ELECTRON_RUN_AS_NODE: '1' };
    expect(sanitizedCodexEnv(env)).toEqual({ PATH: '/bin', HOME: '/h' });
    expect(env.OPENAI_API_KEY).toBe('a');
  });
});

describe('codexSpawnSpec', () => {
  it('runs a binary directly', () => {
    expect(codexSpawnSpec('/bin/codex', CODEX_ARGS, 'darwin', {})).toEqual({ file: '/bin/codex', args: [...CODEX_ARGS], verbatim: false });
    expect(codexSpawnSpec('C:\\tools\\codex.exe', CODEX_ARGS, 'win32', {})).toEqual({ file: 'C:\\tools\\codex.exe', args: [...CODEX_ARGS], verbatim: false });
  });

  it('runs a Windows .cmd or .bat launcher through cmd.exe by its full path, each argument quoted', () => {
    expect(codexSpawnSpec('C:\\Users\\A B\\npm\\codex.cmd', CODEX_ARGS, 'win32', { SYSTEMROOT: 'D:\\Win' })).toEqual({
      file: 'D:\\Win\\System32\\cmd.exe',
      args: ['/d', '/s', '/c', '""C:\\Users\\A B\\npm\\codex.cmd" "app-server" "-c" "forced_login_method=\\"chatgpt\\"""'],
      verbatim: true,
    });
    expect(codexSpawnSpec('C:\\npm\\CODEX.BAT', ['x'], 'win32', {}).file).toBe('C:\\Windows\\System32\\cmd.exe');
    // Only on Windows: elsewhere a .cmd name is just a file name.
    expect(codexSpawnSpec('/opt/codex.cmd', ['x'], 'linux', {})).toEqual({ file: '/opt/codex.cmd', args: ['x'], verbatim: false });
  });

  it('quotes as the C runtime reads it back: quotes escaped, backslashes doubled only before a quote', () => {
    expect(windowsQuote('a b')).toBe('"a b"');
    expect(windowsQuote('x="y"')).toBe('"x=\\"y\\""');
    expect(windowsQuote('C:\\dir\\')).toBe('"C:\\dir\\\\"');
    expect(windowsQuote('a\\"b')).toBe('"a\\\\\\"b"');
    expect(windowsQuote('')).toBe('""');
  });
});
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `npm test -w engine -- test/codexConnection.test.ts`
Expected: FAIL with "Failed to load url ../src/providers/codex/connection" (the file doesn't exist yet).

- [ ] **Step 5: Write the connection**

Create `engine/src/providers/codex/connection.ts`:

```ts
import { spawn } from 'node:child_process';
import path from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { envValue, killTree } from '../../platform';
import type { InitializeParams } from './protocol';

/** `codex app-server`, signed in with ChatGPT only (spec §4.2). The quotes are part of the value Codex parses. */
export const CODEX_ARGS: readonly string[] = ['app-server', '-c', 'forced_login_method="chatgpt"'];
/** Variables that would sign Codex in with an API key or send its requests elsewhere (spec §4.2), and VS Code's process flag (R25). */
const REMOVED_VARS = new Set(['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL', 'ELECTRON_RUN_AS_NODE']);
/** The engine's version, sent as clientInfo.version (R21). */
export const CLIENT_VERSION = '0.2.0';
export const INIT_TIMEOUT_MS = 30_000;
const STDERR_TAIL_CHARS = 2000;
const CLOSED = 'The Codex connection was closed.';
export const UNSUPPORTED_REQUEST = "Agent Stream doesn't support this request.";
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

/** A JSON-RPC error: one Codex answered with, or one our server-request handler answers with. */
export class CodexRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = 'CodexRpcError';
  }
}

/** The process ended, or never started: what every pending request rejects with. */
export class CodexExitError extends Error {
  constructor(
    message: string,
    readonly code: number | null,
    readonly tail: string,
    readonly startError?: string,
  ) {
    super(message);
    this.name = 'CodexExitError';
  }
}

export type CodexProcess = { stdin: Writable; stdout: Readable; stderr: Readable; kill(): void; onExit(cb: (code: number | null, error?: Error) => void): void };
/** Starts Codex; tests substitute the fake app-server (spec §8). `onExit` also reports a spawn that failed (R4). */
export type SpawnCodex = (codexPath: string, args: readonly string[], env: NodeJS.ProcessEnv) => CodexProcess;

export interface CodexConnection {
  request<T>(method: string, params: unknown, signal?: AbortSignal): Promise<T>;
  notify(method: string, params?: unknown): void;
  /** One handler (the last one set). Its result answers; a throw answers a JSON-RPC error (a CodexRpcError keeps its code, anything else is -32603). */
  onServerRequest(handler: (method: string, params: unknown) => Promise<unknown>): void;
  onNotification(handler: (method: string, params: unknown) => void): void;
  /** Called once when the process ends by itself, not after close(), with the message pending requests got (R4). */
  onExit(handler: (message: string) => void): void;
  /** Kills the process tree; pending requests reject. */
  close(): void;
}

const isTimeout = (e: unknown) => typeof e === 'object' && e !== null && (e as { name?: unknown }).name === 'TimeoutError';

/** A message for the user: a timed-out request reads as Codex not answering. */
export function errorMessage(e: unknown): string {
  if (isTimeout(e)) return "Codex didn't answer in time.";
  return e instanceof Error ? e.message : String(e);
}

/** Copy of `env` without the variables Codex must not see (spec §4.2, R25), matched without case. */
export function sanitizedCodexEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) if (!REMOVED_VARS.has(key.toUpperCase())) out[key] = value;
  return out;
}

/** One argument quoted as the Microsoft C runtime reads it back: `"` escaped, backslashes doubled before a quote (R15). */
export function windowsQuote(arg: string): string {
  let out = '"';
  let backslashes = 0;
  for (const ch of arg) {
    if (ch === '\\') {
      backslashes++;
      continue;
    }
    out += ch === '"' ? `${'\\'.repeat(backslashes * 2 + 1)}"` : `${'\\'.repeat(backslashes)}${ch}`;
    backslashes = 0;
  }
  return `${out}${'\\'.repeat(backslashes * 2)}"`;
}

export type SpawnSpec = { file: string; args: string[]; verbatim: boolean };

/**
 * How to start Codex: directly, or (Windows) a .cmd/.bat launcher such as npm's through cmd.exe, named by its full path
 * like killTree's taskkill, with the whole line quoted for `/s` (spec §4.2, R15).
 */
export function codexSpawnSpec(codexPath: string, args: readonly string[], platform: NodeJS.Platform, env: NodeJS.ProcessEnv): SpawnSpec {
  if (platform === 'win32' && /\.(cmd|bat)$/i.test(codexPath)) {
    const cmd = path.win32.join(envValue(env, 'SystemRoot', 'win32') ?? 'C:\\Windows', 'System32', 'cmd.exe');
    return { file: cmd, args: ['/d', '/s', '/c', `"${[codexPath, ...args].map(windowsQuote).join(' ')}"`], verbatim: true };
  }
  return { file: codexPath, args: [...args], verbatim: false };
}

/** The real process. Never called in tests. */
export const realSpawnCodex: SpawnCodex = (codexPath, args, env) => {
  const platform = process.platform;
  const spec = codexSpawnSpec(codexPath, args, platform, env);
  // Its own process group outside Windows, so close() stops everything Codex started (killTree).
  const child = spawn(spec.file, spec.args, { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, windowsVerbatimArguments: spec.verbatim, detached: platform !== 'win32' });
  return {
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr,
    kill: () => {
      if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
      killTree(child.pid, { platform, signal: 'SIGTERM' });
    },
    onExit: (cb) => {
      let done = false;
      const once = (code: number | null, error?: Error) => {
        if (done) return;
        done = true;
        cb(code, error);
      };
      // 'close', not 'exit': stdout is fully read by then, so a last turn/completed isn't lost.
      child.once('close', (code) => once(code));
      child.once('error', (error) => once(null, error));
    },
  };
};

type RpcMessage = { id?: unknown; method?: unknown; params?: unknown; result?: unknown; error?: { code?: unknown; message?: unknown } };
type Pending = { resolve: (value: unknown) => void; reject: (error: unknown) => void; cleanup: () => void };

/** Newline-delimited JSON-RPC 2.0 over the process's stdio (spec §4.2). */
function connect(proc: CodexProcess, log: (message: string) => void): CodexConnection {
  let nextId = 1;
  const pending = new Map<number, Pending>();
  const notificationHandlers: ((method: string, params: unknown) => void)[] = [];
  const exitHandlers: ((message: string) => void)[] = [];
  let serverRequestHandler: ((method: string, params: unknown) => Promise<unknown>) | undefined;
  let closed = false;
  let ended: CodexExitError | undefined;
  let stderr = '';
  let buffer = '';

  const write = (message: object) => {
    if (!closed) proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  };
  const rejectAll = (error: unknown) => {
    for (const p of pending.values()) {
      p.cleanup();
      p.reject(error);
    }
    pending.clear();
  };

  async function answer(id: number | string, method: string, params: unknown): Promise<void> {
    let reply: object;
    try {
      if (!serverRequestHandler) throw new CodexRpcError(-32601, UNSUPPORTED_REQUEST);
      reply = { id, result: (await serverRequestHandler(method, params)) ?? null };
    } catch (e) {
      reply = { id, error: e instanceof CodexRpcError ? { code: e.code, message: e.message } : { code: -32603, message: e instanceof Error ? e.message : String(e) } };
    }
    write(reply);
  }

  function handle(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      parsed = undefined;
    }
    if (typeof parsed !== 'object' || parsed === null) {
      // Never the line itself: it may hold a command's output.
      log(`[agent-stream] Codex sent a line that isn't JSON-RPC (${line.length} characters); ignored.`);
      return;
    }
    const m = parsed as RpcMessage;
    const id = typeof m.id === 'number' || typeof m.id === 'string' ? m.id : undefined;
    if (typeof m.method === 'string') {
      if (id !== undefined) {
        void answer(id, m.method, m.params);
        return;
      }
      for (const h of notificationHandlers) {
        try {
          h(m.method, m.params);
        } catch (e) {
          log(`[agent-stream] Handling the Codex notification ${m.method} failed: ${errorMessage(e)}`);
        }
      }
      return;
    }
    const p = typeof id === 'number' ? pending.get(id) : undefined;
    if (!p || typeof id !== 'number') return;
    pending.delete(id);
    p.cleanup();
    if (m.error) p.reject(new CodexRpcError(typeof m.error.code === 'number' ? m.error.code : -32603, typeof m.error.message === 'string' ? m.error.message : 'Codex answered with an error.'));
    else p.resolve(m.result);
  }

  proc.stdin.on('error', () => {
    // A write after Codex exited: the exit itself is reported.
  });
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    for (let i = buffer.indexOf('\n'); i >= 0; i = buffer.indexOf('\n')) {
      const line = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 1);
      if (line) handle(line);
    }
  });
  proc.stderr.setEncoding('utf8');
  proc.stderr.on('data', (chunk: string) => {
    stderr = (stderr + chunk).slice(-4 * STDERR_TAIL_CHARS);
  });
  proc.onExit((code, error) => {
    if (closed) return;
    closed = true;
    const tail = stderr.replace(ANSI, '').trim().slice(-STDERR_TAIL_CHARS);
    const message = error ? `Codex didn't start: ${error.message}` : `Codex stopped unexpectedly (exit ${code ?? 'unknown'}).${tail ? `\n${tail}` : ''}`;
    ended = new CodexExitError(message, code, tail, error?.message);
    rejectAll(ended);
    for (const h of exitHandlers) h(message);
  });

  return {
    request<T>(method: string, params: unknown, signal?: AbortSignal): Promise<T> {
      if (ended) return Promise.reject(ended);
      if (closed) return Promise.reject(new Error(CLOSED));
      return new Promise<T>((resolve, reject) => {
        if (signal?.aborted) {
          reject(signal.reason);
          return;
        }
        const id = nextId++;
        const onAbort = () => {
          pending.delete(id);
          reject(signal?.reason);
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        pending.set(id, { resolve: resolve as (value: unknown) => void, reject, cleanup: () => signal?.removeEventListener('abort', onAbort) });
        write({ id, method, params });
      });
    },
    notify(method, params) {
      write(params === undefined ? { method } : { method, params });
    },
    onServerRequest(handler) {
      serverRequestHandler = handler;
    },
    onNotification(handler) {
      notificationHandlers.push(handler);
    },
    onExit(handler) {
      exitHandlers.push(handler);
    },
    close() {
      if (closed) return;
      closed = true;
      rejectAll(new Error(CLOSED));
      try {
        proc.stdin.end();
      } catch {
        // already gone
      }
      proc.kill();
    },
  };
}

function startReason(e: unknown, timeoutMs: number): string {
  if (e instanceof CodexExitError) return e.startError ?? `exit ${e.code ?? 'unknown'}.${e.tail ? `\n${e.tail}` : ''}`;
  if (isTimeout(e)) return `no answer within ${timeoutMs / 1000} s`;
  return errorMessage(e);
}

/**
 * Starts `codex app-server` and completes the handshake (spec §4.2): `initialize`, then `initialized`. A failure or
 * timeout rejects with `Codex didn't start: <reason>` and leaves no process behind.
 */
export async function openCodex(o: { codexPath: string; spawn?: SpawnCodex; env?: NodeJS.ProcessEnv; initTimeoutMs?: number; log?: (message: string) => void }): Promise<CodexConnection> {
  const timeoutMs = o.initTimeoutMs ?? INIT_TIMEOUT_MS;
  let conn: CodexConnection;
  try {
    conn = connect((o.spawn ?? realSpawnCodex)(o.codexPath, CODEX_ARGS, sanitizedCodexEnv(o.env ?? process.env)), o.log ?? ((m) => console.warn(m)));
  } catch (e) {
    throw new Error(`Codex didn't start: ${errorMessage(e)}`);
  }
  const params: InitializeParams = { clientInfo: { name: 'agent-stream', title: 'Agent Stream', version: CLIENT_VERSION }, capabilities: { experimentalApi: true, requestAttestation: false } };
  try {
    await conn.request('initialize', params, AbortSignal.timeout(timeoutMs));
  } catch (e) {
    conn.close();
    throw new Error(`Codex didn't start: ${startReason(e, timeoutMs)}`);
  }
  conn.notify('initialized');
  return conn;
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm test -w engine -- test/codexConnection.test.ts`
Expected: PASS.

- [ ] **Step 7: Typecheck and commit**

Run: `npm run typecheck`
Expected: no errors.

```bash
git add engine/src/platform.ts engine/src/providers/codex/protocol.ts engine/src/providers/codex/connection.ts engine/test/codexFake.ts engine/test/codexConnection.test.ts
git commit -m "feat(engine): Codex app-server protocol types, JSON-RPC connection, and a fake app-server for tests

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Finding Codex and its sign-in status

**Spec tests owned (§8):** Auth and status — each row of §4.3, and `findCodex` for each location and platform.

**Files:**
- Create: `engine/src/providers/codex/auth.ts`
- Test: `engine/test/codexAuth.test.ts`

**Interfaces:**
- Consumes: `envValue`, `pathDirs`, `realProbe`, `Probe`, `Found` (`engine/src/platform.ts`, Task 2); `openCodex`, `errorMessage`, `SpawnCodex`, `CodexConnection` (Task 2); `GetAccountResponse` (Task 2).
- Produces:
  ```ts
  // engine/src/providers/codex/auth.ts
  export const CODEX_MISSING: string;        // spec §4.3, verbatim
  export const CODEX_NOT_SIGNED_IN = 'Run codex login in a terminal and sign in with ChatGPT.';
  export const CODEX_API_KEY: string;        // spec §4.3, verbatim
  export const CODEX_SIGNED_IN = 'Signed in with ChatGPT.';
  /** A Codex status before the provider adds `provider: 'codex'` (R28). */
  export type CodexStatus = Omit<ProviderStatus, 'provider'>;
  export function findCodex(o: { platform: NodeJS.Platform; env: NodeJS.ProcessEnv; home: string; setting?: string; probe?: Probe }): Found;
  export function planName(plan: unknown): string;
  export function accountStatus(r: GetAccountResponse): CodexStatus;
  export function readCodexStatus(o: { codexPath: string; spawn?: SpawnCodex; env?: NodeJS.ProcessEnv; timeoutMs?: number }): Promise<CodexStatus>;
  ```

- [ ] **Step 1: Write the failing tests**

Create `engine/test/codexAuth.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { Probe } from '../src/platform';
import { accountStatus, CODEX_API_KEY, CODEX_MISSING, CODEX_NOT_SIGNED_IN, findCodex, planName, readCodexStatus } from '../src/providers/codex/auth';
import { fakeCodex, FakeRpcError } from './codexFake';

/** Only these files exist, and all of them can be run. */
const probe = (files: string[]): Probe => ({ exists: (p) => files.includes(p), executable: (p) => files.includes(p) });
const mac = (files: string[], o: { env?: NodeJS.ProcessEnv; setting?: string } = {}) => findCodex({ platform: 'darwin', env: o.env ?? { PATH: '/usr/bin:/opt/x/bin' }, home: '/h', setting: o.setting, probe: probe(files) });
const win = (files: string[], o: { env?: NodeJS.ProcessEnv; setting?: string } = {}) => findCodex({ platform: 'win32', env: o.env ?? { Path: 'C:\\a;C:\\b' }, home: 'C:\\h', setting: o.setting, probe: probe(files) });

describe('findCodex', () => {
  it('uses agentStream.codexPath when it can be run, and says so when it cannot', () => {
    expect(mac(['/tools/codex'], { setting: ' /tools/codex ' })).toEqual({ ok: true, path: '/tools/codex' });
    expect(mac([], { setting: '/tools/codex' })).toEqual({ ok: false, error: "agentStream.codexPath points to /tools/codex, which doesn't exist or can't be run." });
    expect(win(['C:\\npm\\codex.cmd'], { setting: 'C:\\npm\\codex.cmd' })).toEqual({ ok: true, path: 'C:\\npm\\codex.cmd' });
  });

  it('finds codex on PATH, in PATH order', () => {
    expect(mac(['/opt/x/bin/codex'])).toEqual({ ok: true, path: '/opt/x/bin/codex' });
    expect(mac(['/usr/bin/codex', '/opt/x/bin/codex'])).toEqual({ ok: true, path: '/usr/bin/codex' });
  });

  it('finds codex.exe, codex.cmd or codex.bat on the Windows Path, matching the variable without case', () => {
    expect(win(['C:\\b\\codex.cmd'])).toEqual({ ok: true, path: 'C:\\b\\codex.cmd' });
    expect(win(['C:\\b\\codex.cmd', 'C:\\b\\codex.exe'])).toEqual({ ok: true, path: 'C:\\b\\codex.exe' });
    expect(win(['C:\\a\\codex.bat'], { env: { PATH: 'C:\\a' } })).toEqual({ ok: true, path: 'C:\\a\\codex.bat' });
  });

  it('falls back to the usual npm global and Homebrew locations', () => {
    for (const p of ['/opt/homebrew/bin/codex', '/usr/local/bin/codex', '/h/.local/bin/codex', '/h/.npm-global/bin/codex']) {
      expect(mac([p], { env: {} })).toEqual({ ok: true, path: p });
    }
    expect(win(['C:\\h\\AppData\\Roaming\\npm\\codex.cmd'], { env: {} })).toEqual({ ok: true, path: 'C:\\h\\AppData\\Roaming\\npm\\codex.cmd' });
    expect(win(['D:\\roam\\npm\\codex.cmd'], { env: { APPDATA: 'D:\\roam' } })).toEqual({ ok: true, path: 'D:\\roam\\npm\\codex.cmd' });
  });

  it('says how to install Codex when it is nowhere', () => {
    expect(mac([])).toEqual({ ok: false, error: CODEX_MISSING });
    expect(win([])).toEqual({ ok: false, error: CODEX_MISSING });
    expect(CODEX_MISSING).toBe('Could not find Codex (codex). Install it from https://developers.openai.com/codex and sign in with ChatGPT, or set agentStream.codexPath.');
  });

  it('needs an executable file outside Windows', () => {
    const notExecutable: Probe = { exists: () => true, executable: () => false };
    expect(findCodex({ platform: 'linux', env: { PATH: '/usr/bin' }, home: '/h', probe: notExecutable })).toEqual({ ok: false, error: CODEX_MISSING });
  });
});

describe('accountStatus', () => {
  it('maps each account to its status (spec §4.3)', () => {
    expect(accountStatus({ account: { type: 'chatgpt', email: 'someone@example.com', planType: 'plus' }, requiresOpenaiAuth: true })).toEqual({
      ok: true,
      label: 'Codex (Plus)',
      detail: 'Signed in with ChatGPT.',
    });
    expect(accountStatus({ account: null, requiresOpenaiAuth: true })).toEqual({ ok: false, label: 'Codex: not signed in', error: CODEX_NOT_SIGNED_IN });
    expect(accountStatus({ account: { type: 'apiKey' }, requiresOpenaiAuth: true })).toEqual({ ok: false, label: 'Codex: API key', error: CODEX_API_KEY });
    expect(accountStatus({ account: { type: 'amazonBedrock', usesCodexManagedCredentials: true }, requiresOpenaiAuth: false })).toEqual({ ok: false, label: 'Codex: API key', error: CODEX_API_KEY });
    expect(CODEX_API_KEY).toBe('Agent Stream uses your ChatGPT subscription for Codex. Run codex logout, then codex login and choose ChatGPT.');
  });

  it('never shows the account email', () => {
    expect(JSON.stringify(accountStatus({ account: { type: 'chatgpt', email: 'someone@example.com', planType: 'pro' }, requiresOpenaiAuth: true }))).not.toContain('example.com');
  });
});

describe('planName', () => {
  it('capitalises the plan, with underscores as spaces (R7)', () => {
    expect(planName('plus')).toBe('Plus');
    expect(planName('self_serve_business_prolite')).toBe('Self serve business prolite');
    expect(planName('')).toBe('ChatGPT');
    expect(planName(undefined)).toBe('ChatGPT');
  });
});

describe('readCodexStatus', () => {
  it('asks account/read on a short-lived connection and closes it', async () => {
    const fake = fakeCodex({ 'account/read': () => ({ account: { type: 'chatgpt', email: null, planType: 'pro' }, requiresOpenaiAuth: true }) });
    expect(await readCodexStatus({ codexPath: '/bin/codex', spawn: fake.spawn })).toEqual({ ok: true, label: 'Codex (Pro)', detail: 'Signed in with ChatGPT.' });
    expect(fake.last().methods()).toEqual(['initialize', 'initialized', 'account/read']);
    expect(fake.last().paramsOf('account/read')).toEqual({});
    expect(fake.last().killed).toBe(true);
  });

  it('reports a connection that fails with its message (R6)', async () => {
    const fake = fakeCodex({ initialize: () => { throw new FakeRpcError(-32600, 'unsupported client'); } });
    expect(await readCodexStatus({ codexPath: '/bin/codex', spawn: fake.spawn })).toEqual({ ok: false, label: 'Codex: not available', error: "Codex didn't start: unsupported client" });
    const silent = fakeCodex({ 'account/read': () => new Promise(() => {}) });
    expect(await readCodexStatus({ codexPath: '/bin/codex', spawn: silent.spawn, timeoutMs: 20 })).toEqual({ ok: false, label: 'Codex: not available', error: "Codex didn't answer in time." });
    expect(silent.last().killed).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w engine -- test/codexAuth.test.ts`
Expected: FAIL with "Failed to load url ../src/providers/codex/auth".

- [ ] **Step 3: Write the implementation**

Create `engine/src/providers/codex/auth.ts`:

```ts
import path from 'node:path';
import type { ProviderStatus } from '@agent-stream/shared';
import { envValue, pathDirs, realProbe, type Found, type Probe } from '../../platform';
import { errorMessage, openCodex, type CodexConnection, type SpawnCodex } from './connection';
import type { GetAccountResponse } from './protocol';

export const CODEX_MISSING =
  'Could not find Codex (codex). Install it from https://developers.openai.com/codex and sign in with ChatGPT, or set agentStream.codexPath.';
export const CODEX_NOT_SIGNED_IN = 'Run codex login in a terminal and sign in with ChatGPT.';
export const CODEX_API_KEY = 'Agent Stream uses your ChatGPT subscription for Codex. Run codex logout, then codex login and choose ChatGPT.';
export const CODEX_SIGNED_IN = 'Signed in with ChatGPT.';
const STATUS_TIMEOUT_MS = 30_000;

/** A Codex status before the provider adds `provider: 'codex'` (R28). */
export type CodexStatus = Omit<ProviderStatus, 'provider'>;

/**
 * The Codex CLI (spec §4.3), like findClaude: the setting, then PATH, then the usual npm global and Homebrew places.
 * VS Code started from the Dock or Start menu may not share the terminal's PATH. On Windows npm installs codex.cmd,
 * which openCodex runs through cmd.exe.
 */
export function findCodex(o: { platform: NodeJS.Platform; env: NodeJS.ProcessEnv; home: string; setting?: string; probe?: Probe }): Found {
  const probe = o.probe ?? realProbe;
  const win = o.platform === 'win32';
  const p = win ? path.win32 : path.posix;
  const usable = (c: string) => (win ? probe.exists(c) : probe.executable(c));
  const setting = o.setting?.trim();
  if (setting) {
    return usable(setting) ? { ok: true, path: setting } : { ok: false, error: `agentStream.codexPath points to ${setting}, which doesn't exist or can't be run.` };
  }
  const names = win ? ['codex.exe', 'codex.cmd', 'codex.bat'] : ['codex'];
  for (const dir of pathDirs(o.env, o.platform)) {
    for (const name of names) {
      const c = p.join(dir, name);
      if (usable(c)) return { ok: true, path: c };
    }
  }
  const fallbacks = win
    ? [p.join(envValue(o.env, 'APPDATA', 'win32') ?? p.join(o.home, 'AppData', 'Roaming'), 'npm', 'codex.cmd')]
    : ['/opt/homebrew/bin/codex', '/usr/local/bin/codex', p.join(o.home, '.local', 'bin', 'codex'), p.join(o.home, '.npm-global', 'bin', 'codex')];
  for (const c of fallbacks) if (usable(c)) return { ok: true, path: c };
  return { ok: false, error: CODEX_MISSING };
}

/** "plus" → "Plus", "self_serve_business_prolite" → "Self serve business prolite" (R7). */
export function planName(plan: unknown): string {
  if (typeof plan !== 'string' || plan.trim() === '') return 'ChatGPT';
  const words = plan.trim().replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** account/read → the status (spec §4.3). Only a ChatGPT sign-in can run; the email is never shown. */
export function accountStatus(r: GetAccountResponse): CodexStatus {
  const account = r.account;
  if (!account) return { ok: false, label: 'Codex: not signed in', error: CODEX_NOT_SIGNED_IN };
  if (account.type !== 'chatgpt') return { ok: false, label: 'Codex: API key', error: CODEX_API_KEY };
  return { ok: true, label: `Codex (${planName(account.planType)})`, detail: CODEX_SIGNED_IN };
}

/** Opens a connection, asks account/read, closes it (spec §4.3). A failure is a status, never a throw (R6). */
export async function readCodexStatus(o: { codexPath: string; spawn?: SpawnCodex; env?: NodeJS.ProcessEnv; timeoutMs?: number }): Promise<CodexStatus> {
  let conn: CodexConnection | undefined;
  try {
    conn = await openCodex({ codexPath: o.codexPath, spawn: o.spawn, env: o.env });
    return accountStatus(await conn.request<GetAccountResponse>('account/read', {}, AbortSignal.timeout(o.timeoutMs ?? STATUS_TIMEOUT_MS)));
  } catch (e) {
    return { ok: false, label: 'Codex: not available', error: errorMessage(e) };
  } finally {
    conn?.close();
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -w engine -- test/codexAuth.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck`
Expected: no errors.

```bash
git add engine/src/providers/codex/auth.ts engine/test/codexAuth.test.ts
git commit -m "feat(engine): find the Codex CLI and read its ChatGPT sign-in

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Models and effort

**Spec tests owned (§8):** Models — the mapping, unknown efforts dropped, `ultra` kept, the cache, and the failure retry.

**Files:**
- Create: `engine/src/providers/codex/models.ts`
- Test: `engine/test/codexModels.test.ts`

**Interfaces:**
- Consumes: `CodexConnection`, `errorMessage` (Task 2); `Model`, `ModelListResponse` (Task 2); `isEffortLevel`, `findModel`, `EffortLevel`, `ModelChoice` (with `isDefault`, Task 1) from `@agent-stream/shared`.
- Produces:
  ```ts
  // engine/src/providers/codex/models.ts
  export function toModelChoice(m: Model): ModelChoice;
  export function fetchCodexModels(conn: CodexConnection, timeoutMs?: number): Promise<ModelChoice[]>; // model/list, ≤ 10 pages, hidden dropped
  export type ModelList = { list(o?: { retry?: boolean }): Promise<ModelChoice[]>; known(): ModelChoice[] | undefined };
  export function createModelList(load: () => Promise<ModelChoice[]>, log: (message: string) => void): ModelList;
  export function codexEffort(choice: { model?: string; effort?: EffortLevel }, known: ModelChoice[] | undefined, warn: (key: string, message: string) => void): EffortLevel | undefined;
  ```

- [ ] **Step 1: Write the failing tests**

Create `engine/test/codexModels.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import type { ModelChoice } from '@agent-stream/shared';
import { openCodex } from '../src/providers/codex/connection';
import { codexEffort, createModelList, fetchCodexModels, toModelChoice } from '../src/providers/codex/models';
import type { Model } from '../src/providers/codex/protocol';
import { deferred } from './helpers';
import { fakeCodex } from './codexFake';

const model = (id: string, efforts: string[], o: Partial<Model> = {}): Model => ({
  id,
  model: id,
  displayName: id.toUpperCase(),
  description: '',
  hidden: false,
  supportedReasoningEfforts: efforts.map((reasoningEffort) => ({ reasoningEffort, description: '' })),
  defaultReasoningEffort: 'medium',
  isDefault: false,
  ...o,
});

describe('toModelChoice', () => {
  it('maps a Codex model: id, display name (else id), description, known efforts, and the default mark', () => {
    expect(toModelChoice(model('gpt-a', ['none', 'minimal', 'low', 'high', 'xhigh', 'max', 'ultra'], { description: 'Fast', isDefault: true }))).toEqual({
      value: 'gpt-a',
      label: 'GPT-A',
      description: 'Fast',
      efforts: ['low', 'high', 'xhigh', 'max', 'ultra'],
      isDefault: true,
    });
    expect(toModelChoice(model('gpt-b', [], { displayName: '' }))).toEqual({ value: 'gpt-b', label: 'gpt-b', efforts: [] });
  });
});

describe('fetchCodexModels', () => {
  it('reads every page of model/list without hidden models', async () => {
    const pages: Record<string, { data: Model[]; nextCursor: string | null }> = {
      first: { data: [model('gpt-a', ['low']), model('gpt-secret', ['low'], { hidden: true })], nextCursor: 'p2' },
      p2: { data: [model('gpt-b', ['ultra'])], nextCursor: null },
    };
    const fake = fakeCodex({ 'model/list': (p: { cursor?: string }) => pages[p.cursor ?? 'first'] });
    const conn = await openCodex({ codexPath: '/bin/codex', spawn: fake.spawn });
    expect((await fetchCodexModels(conn)).map((m) => m.value)).toEqual(['gpt-a', 'gpt-b']);
    expect(fake.last().received.filter((m) => m.method === 'model/list').map((m) => m.params)).toEqual([{ includeHidden: false }, { includeHidden: false, cursor: 'p2' }]);
    conn.close();
  });

  it('stops after 10 pages', async () => {
    let n = 0;
    const fake = fakeCodex({ 'model/list': () => ({ data: [model(`m${++n}`, [])], nextCursor: 'more' }) });
    const conn = await openCodex({ codexPath: '/bin/codex', spawn: fake.spawn });
    expect(await fetchCodexModels(conn)).toHaveLength(10);
    conn.close();
  });
});

describe('createModelList', () => {
  const list: ModelChoice[] = [{ value: 'gpt-a', label: 'A', efforts: ['low'] }];

  it('loads once for concurrent callers, then answers from the cache', async () => {
    const d = deferred<ModelChoice[]>();
    const load = vi.fn(() => d.promise);
    const models = createModelList(load, () => {});
    expect(models.known()).toBeUndefined();
    const a = models.list();
    const b = models.list();
    d.resolve(list);
    expect(await a).toEqual(list);
    expect(await b).toEqual(list);
    expect(await models.list()).toEqual(list);
    expect(models.known()).toEqual(list);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('remembers a failure for the window, logs it once, and tries again once when asked', async () => {
    const load = vi.fn<() => Promise<ModelChoice[]>>().mockRejectedValueOnce(new Error('offline')).mockRejectedValueOnce(new Error('still offline')).mockResolvedValue(list);
    const log = vi.fn();
    const models = createModelList(load, log);
    expect(await models.list()).toEqual([]);
    expect(log).toHaveBeenCalledWith('[agent-stream] Could not list Codex models; the menus offer only Default (offline).');
    expect(await models.list()).toEqual([]);
    expect(load).toHaveBeenCalledTimes(1);
    expect(await models.list({ retry: true })).toEqual([]);
    expect(load).toHaveBeenCalledTimes(2);
    expect(await models.list({ retry: true })).toEqual([]);
    expect(load).toHaveBeenCalledTimes(2);
  });
});

describe('codexEffort', () => {
  const known: ModelChoice[] = [
    { value: 'gpt-a', label: 'A', efforts: ['low', 'high'] },
    { value: 'gpt-b', label: 'B', efforts: ['low', 'ultra'], isDefault: true },
  ];

  it('passes an effort the model offers, and keeps it when the list is unknown or does not name the model (R9)', () => {
    const warn = vi.fn();
    expect(codexEffort({ model: 'gpt-a', effort: 'high' }, known, warn)).toBe('high');
    expect(codexEffort({ effort: 'ultra' }, known, warn)).toBe('ultra');
    expect(codexEffort({ model: 'gpt-z', effort: 'max' }, known, warn)).toBe('max');
    expect(codexEffort({ effort: 'max' }, undefined, warn)).toBe('max');
    expect(codexEffort({ model: 'gpt-a' }, known, warn)).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it("drops an effort the model doesn't offer, with a line naming it; Default checks the model marked default", () => {
    const warn = vi.fn();
    expect(codexEffort({ model: 'gpt-a', effort: 'ultra' }, known, warn)).toBeUndefined();
    expect(warn).toHaveBeenCalledWith('gpt-a|ultra', '[agent-stream] A (gpt-a) has no "ultra" effort level; running without an effort level.');
    expect(codexEffort({ effort: 'high' }, known, warn)).toBeUndefined();
    expect(warn).toHaveBeenLastCalledWith('gpt-b|high', '[agent-stream] B (gpt-b) has no "high" effort level; running without an effort level.');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w engine -- test/codexModels.test.ts`
Expected: FAIL with "Failed to load url ../src/providers/codex/models".

- [ ] **Step 3: Write the implementation**

Create `engine/src/providers/codex/models.ts`:

```ts
import { findModel, isEffortLevel, type EffortLevel, type ModelChoice } from '@agent-stream/shared';
import { errorMessage, type CodexConnection } from './connection';
import type { Model, ModelListParams, ModelListResponse } from './protocol';

const MODELS_TIMEOUT_MS = 30_000;
const MAX_PAGES = 10;

/** A Codex model for the Model menus (spec §4.4): efforts Agent Stream doesn't know (none, minimal) are dropped. */
export function toModelChoice(m: Model): ModelChoice {
  return {
    value: m.id,
    label: m.displayName || m.id,
    ...(m.description && { description: m.description }),
    efforts: m.supportedReasoningEfforts.map((o) => o.reasoningEffort).filter(isEffortLevel),
    ...(m.isDefault && { isDefault: true }),
  };
}

/** model/list, page by page through nextCursor (at most 10 pages, 30 s in all), hidden models left out (R19). */
export async function fetchCodexModels(conn: CodexConnection, timeoutMs = MODELS_TIMEOUT_MS): Promise<ModelChoice[]> {
  const signal = AbortSignal.timeout(timeoutMs);
  const out: ModelChoice[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const params: ModelListParams = cursor ? { includeHidden: false, cursor } : { includeHidden: false };
    const r: ModelListResponse = await conn.request<ModelListResponse>('model/list', params, signal);
    for (const m of r.data) if (!m.hidden) out.push(toModelChoice(m));
    cursor = r.nextCursor;
    if (!cursor) break;
  }
  return out;
}

export type ModelList = { list(o?: { retry?: boolean }): Promise<ModelChoice[]>; known(): ModelChoice[] | undefined };

/**
 * The model list, cached like Claude's (spec §4.4): one load at a time, kept once it succeeds; a failure stands for the
 * window, bar one retry when asked (chat open, Select Model).
 */
export function createModelList(load: () => Promise<ModelChoice[]>, log: (message: string) => void): ModelList {
  let models: ModelChoice[] | undefined;
  let pending: Promise<ModelChoice[]> | undefined;
  let failed = false;
  let retried = false;
  return {
    known: () => models,
    async list(o) {
      if (models) return models;
      if (pending) return pending;
      if (failed) {
        if (!o?.retry || retried) return [];
        retried = true;
      }
      pending = load()
        .then(
          (list) => (models = list),
          (e: unknown) => {
            if (!failed) log(`[agent-stream] Could not list Codex models; the menus offer only Default (${errorMessage(e)}).`);
            failed = true;
            return [];
          },
        )
        .finally(() => (pending = undefined));
      return pending;
    },
  };
}

/**
 * The effort to send on turn/start (R9): the chosen one, unless the listed model (or, for Default, the model Codex marks
 * as its default) doesn't offer it. Then it is dropped and `warn` is told. Kept when the list is unknown or doesn't name the model.
 */
export function codexEffort(choice: { model?: string; effort?: EffortLevel }, known: ModelChoice[] | undefined, warn: (key: string, message: string) => void): EffortLevel | undefined {
  if (!choice.effort) return undefined;
  const entry = choice.model ? findModel(known, choice.model) : known?.find((m) => m.isDefault);
  if (entry && !entry.efforts.includes(choice.effort)) {
    warn(`${entry.value}|${choice.effort}`, `[agent-stream] ${entry.label} (${entry.value}) has no "${choice.effort}" effort level; running without an effort level.`);
    return undefined;
  }
  return choice.effort;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -w engine -- test/codexModels.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck`
Expected: no errors.

```bash
git add engine/src/providers/codex/models.ts engine/test/codexModels.test.ts
git commit -m "feat(engine): Codex models from model/list, cached, with efforts checked per model

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: The read-only command rule

**Spec tests owned (§8):** Approvals — private-path commands declined without asking (the classification; Task 6 wires it to the gate). It also pins Review Focus 1, 2 and 3.

**Files:**
- Modify: `engine/src/agentLoop/tools.ts` (export `privateFolderDenial`)
- Create: `engine/src/providers/codex/readOnlyCommand.ts`
- Test: `engine/test/codexReadOnly.test.ts`

**Interfaces:**
- Consumes: `ToolGate.privacy` (`engine/src/providers/toolGate.ts`, unchanged); `CommandAction`, `CommandExecutionRequestApprovalParams` (Task 2); `approvalParams` from `engine/test/codexFake.ts` (Task 2).
- Produces:
  ```ts
  // engine/src/agentLoop/tools.ts
  export function privateFolderDenial(resolved: string): string | null; // .agent-stream/runs|sessions, bar an upstream output.md
  // engine/src/providers/codex/readOnlyCommand.ts
  export type PathKind = 'read' | 'search';
  export type PathPrivacy = (absPath: string, kind: PathKind) => string | null;
  export type CommandClass = { kind: 'readOnly' } | { kind: 'private'; reason: string } | { kind: 'ask' };
  export function pathPrivacy(gate: Pick<ToolGate, 'privacy'>): PathPrivacy;
  export function shellWords(s: string, platform: NodeJS.Platform): string[] | null;
  export function classifyCommand(p: CommandExecutionRequestApprovalParams, o: { cwd: string; platform: NodeJS.Platform; privacy: PathPrivacy }): CommandClass;
  ```

- [ ] **Step 1: Write the failing tests**

Create `engine/test/codexReadOnly.test.ts`:

```ts
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createPlannerGate } from '../src/providers/toolGate';
import { classifyCommand, pathPrivacy, shellWords, type CommandClass } from '../src/providers/codex/readOnlyCommand';
import type { CommandAction } from '../src/providers/codex/protocol';
import { approvalParams } from './codexFake';

// resolve (not join) so the paths carry the current drive on Windows, as the code under test does.
const cwd = resolve('/', 'work', 'proj');
const values = resolve('/', 'h', '.agent-stream', 'values', 'abc.json');
/** The platform whose path rules match this machine's absolute paths (backslashes on Windows). */
const host: NodeJS.Platform = process.platform === 'win32' ? 'win32' : 'linux';
const VALUES_REASON = "Variable values are private to this machine; Agent Stream doesn't let Claude read the variable values file.";
const RUN_REASON = "Run records contain variable values; Agent Stream doesn't let Claude read .agent-stream/runs/*/run.json or events.jsonl.";
const PRIVATE_FOLDER = 'That folder holds Agent Stream run records and sessions, which are private.';

const privacyFor = (dir: string) => pathPrivacy(createPlannerGate({ projectDir: dir, privateFiles: [values], graphToolNames: new Set() }));
const zsh = (script: string) => `/bin/zsh -lc '${script}'`;
const read = (script: string, file = 'notes.txt', dir = cwd): CommandAction[] => [{ type: 'read', command: script, name: file, path: resolve(dir, file) }];
const search = (script: string): CommandAction[] => [{ type: 'search', command: script, query: null, path: null }];

function classify(command: string, actions: CommandAction[] | null, o: { platform?: NodeJS.Platform; kind?: 'command' | 'writeStdin'; extra?: object; dir?: string } = {}): CommandClass {
  const dir = o.dir ?? cwd;
  return classifyCommand(approvalParams({ command, cwd: dir, actions, kind: o.kind, extra: o.extra }), { cwd: dir, platform: o.platform ?? 'linux', privacy: privacyFor(dir) });
}
const kindOf = (script: string, actions: CommandAction[] = read(script)) => classify(zsh(script), actions).kind;

describe('shellWords', () => {
  it('splits words, honouring single and double quotes', () => {
    expect(shellWords(`cat 'a b' "c d" e`, 'linux')).toEqual(['cat', 'a b', 'c d', 'e']);
    expect(shellWords('  ls   -la  ', 'linux')).toEqual(['ls', '-la']);
    expect(shellWords(`cat ''`, 'linux')).toEqual(['cat', '']);
  });

  it('gives up on an unbalanced quote, and on a backslash outside Windows', () => {
    expect(shellWords(`cat 'a`, 'linux')).toBeNull();
    expect(shellWords('cat a\\ b', 'linux')).toBeNull();
    expect(shellWords('cat "a\\"b"', 'linux')).toBeNull();
    expect(shellWords('cat src\\a.txt', 'win32')).toEqual(['cat', 'src\\a.txt']);
  });
});

describe('classifyCommand', () => {
  it('lets plain reads and searches run without asking', () => {
    for (const s of ['cat notes.txt', 'head -n 5 notes.txt', 'tail -n 20 notes.txt', 'wc -l notes.txt', 'nl notes.txt', 'stat notes.txt', 'sed -n 1,20p notes.txt', 'sed -n 3p notes.txt']) {
      expect(kindOf(s), s).toBe('readOnly');
    }
    for (const s of ['ls', 'ls -la src', 'pwd', 'find src -name a.ts', 'rg foo .', 'rg -n foo src', 'grep -n foo notes.txt']) expect(kindOf(s, search(s)), s).toBe('readOnly');
    // Unwrapped, or wrapped by another POSIX shell.
    expect(classify('cat notes.txt', read('cat notes.txt')).kind).toBe('readOnly');
    expect(classify(`/bin/bash -c 'cat notes.txt'`, read('cat notes.txt')).kind).toBe('readOnly');
    expect(classify('cat src\\a.txt', read('cat src\\a.txt', 'src/a.txt'), { platform: 'win32' }).kind).toBe('readOnly');
  });

  it("declines a private path Codex names without asking, whatever the action or the command around it", () => {
    expect(classify(zsh('cat .agent-stream/runs/r1/run.json'), read('cat .agent-stream/runs/r1/run.json', '.agent-stream/runs/r1/run.json'))).toEqual({ kind: 'private', reason: RUN_REASON });
    expect(classify(zsh(`cat ${values} | head`), read(`cat ${values}`, values))).toEqual({ kind: 'private', reason: VALUES_REASON });
    expect(classify(zsh('ls .agent-stream/runs'), [{ type: 'listFiles', command: 'ls .agent-stream/runs', path: '.agent-stream/runs' }])).toEqual({ kind: 'private', reason: RUN_REASON });
    expect(classify(zsh('cat .agent-stream/sessions/s1/session.json'), [{ type: 'unknown', command: 'cat .agent-stream/sessions/s1/session.json' }])).toEqual({ kind: 'private', reason: PRIVATE_FOLDER });
  });

  it("lets a step read its upstream output.md, which is a regular file", () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-ro-'));
    mkdirSync(join(dir, '.agent-stream', 'runs', 'r1', 'nodes', 'n1'), { recursive: true });
    writeFileSync(join(dir, '.agent-stream', 'runs', 'r1', 'nodes', 'n1', 'output.md'), 'done');
    const s = 'cat .agent-stream/runs/r1/nodes/n1/output.md';
    expect(classify(zsh(s), read(s, '.agent-stream/runs/r1/nodes/n1/output.md', dir), { dir }).kind).toBe('readOnly');
  });

  it('checks every operand, not only the parsed path', () => {
    expect(classify(zsh('cat notes.txt .agent-stream/runs/r1/run.json'), read('cat notes.txt .agent-stream/runs/r1/run.json'))).toEqual({ kind: 'private', reason: RUN_REASON });
    expect(classify(zsh(`cat notes.txt ${values}`), read(`cat notes.txt ${values}`), { platform: host })).toEqual({ kind: 'private', reason: VALUES_REASON });
    expect(classify(zsh('rg secret .agent-stream/sessions'), search('rg secret .agent-stream/sessions'))).toEqual({ kind: 'private', reason: PRIVATE_FOLDER });
  });

  it('asks when the shell could open other files than the words say', () => {
    for (const s of [
      'cat $HOME/.agent-stream/values/x.json',
      'cat ~/.agent-stream/values/x.json',
      'cat .agent-stream/run*/r1/run.json',
      'cat .agent-stream/run?/r1/run.json',
      'cat .agent-stream/{runs,x}/r1/run.json',
      'cat .agent-stream/[r]uns/r1/run.json',
      'cat .agent-stream/run\\s/r1/run.json',
      'cat notes.txt(e:x:)',
      'cat notes.txt; cat other.txt',
      'cat notes.txt && cat other.txt',
      'cat notes.txt | head',
      'cat < notes.txt',
      'cat `echo notes.txt`',
      'cat %USERPROFILE%',
      'cat !$',
      'cat notes.txt\ncat other.txt',
      'cat =ls',
      'LD_PRELOAD=x.so cat notes.txt',
      './cat notes.txt',
      '/bin/cat notes.txt',
    ]) {
      expect(kindOf(s), s).toBe('ask');
    }
    expect(classify(`/bin/zsh -lc 'cat "notes.txt'`, read('cat notes.txt')).kind).toBe('ask');
    expect(classify(zsh('cat notes.txt,other.txt'), read('cat notes.txt,other.txt'), { platform: 'win32' }).kind).toBe('ask');
  });

  it('asks for searches that would walk into .agent-stream', () => {
    for (const s of [
      'grep -r secret .',
      'grep -rn secret src',
      'grep -R secret .',
      'grep --recursive secret .',
      'grep --directories=recurse secret .',
      'egrep -d recurse secret .',
      'rg secret .agent-stream',
      'rg secret ./.agent-stream/',
      'rg --hidden foo .',
      'rg -uu foo',
      'rg -. foo',
      'rg --no-ignore foo',
      'rg --no-ignore-vcs foo',
      'rg --unrestricted foo',
    ]) {
      expect(kindOf(s, search(s)), s).toBe('ask');
    }
    expect(kindOf('rg foo .', search('rg foo .'))).toBe('readOnly');
    expect(kindOf('rg foo src', search('rg foo src'))).toBe('readOnly');
  });

  it('asks for read programs called in ways that write or run commands', () => {
    for (const s of [
      'rg --pre sh foo .',
      'rg --pre=sh foo .',
      'rg --pre-glob x foo',
      'rg -z foo .',
      'rg --search-zip foo',
      'find . -delete',
      'find . -exec rm x',
      'find . -fprint out.txt',
      'find . -fls out.txt',
      'find . -okdir ls',
      'sed -n "1e touch x" notes.txt',
      'sed -i s/a/b/ notes.txt',
      'sed s/a/b/ notes.txt',
      'sed -n 1p',
      'tail -f notes.txt',
      'tail -F notes.txt',
      'tail --follow notes.txt',
    ]) {
      expect(kindOf(s, search(s)), s).toBe('ask');
    }
  });

  it('asks for writes, unknown programs, missing actions and extra permissions', () => {
    expect(classify(zsh('printf hi > hello.txt'), [{ type: 'unknown', command: 'printf hi > hello.txt' }]).kind).toBe('ask');
    expect(classify(zsh('touch hello.txt'), [{ type: 'unknown', command: 'touch hello.txt' }]).kind).toBe('ask');
    expect(classify(zsh('python notes.txt'), read('python notes.txt')).kind).toBe('ask');
    expect(classify(zsh('cat notes.txt'), []).kind).toBe('ask');
    expect(classify(zsh('cat notes.txt'), null).kind).toBe('ask');
    expect(classify(zsh('cat notes.txt'), [{ type: 'read', command: 'cat $X', name: 'x', path: resolve(cwd, 'x') }]).kind).toBe('ask');
    expect(classify(zsh('cat notes.txt'), read('cat notes.txt'), { kind: 'writeStdin' }).kind).toBe('ask');
    expect(classify(zsh('cat notes.txt'), read('cat notes.txt'), { extra: { additionalPermissions: { network: { enabled: true } } } }).kind).toBe('ask');
    expect(classify(zsh('cat notes.txt'), read('cat notes.txt'), { extra: { networkApprovalContext: { host: 'example.com' } } }).kind).toBe('ask');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w engine -- test/codexReadOnly.test.ts`
Expected: FAIL with "Failed to load url ../src/providers/codex/readOnlyCommand".

- [ ] **Step 3: Export the private-folder check**

In `engine/src/agentLoop/tools.ts`, directly after the `refusedFile` constant, add:

```ts
/** Why a resolved path in `.agent-stream/runs` or `.agent-stream/sessions` may not be read (an upstream output.md may), or null. */
export function privateFolderDenial(resolved: string): string | null {
  return refusedFile(resolved) ? PRIVATE_FOLDER : null;
}
```

- [ ] **Step 4: Write the rule**

Create `engine/src/providers/codex/readOnlyCommand.ts`:

```ts
import { resolve } from 'node:path';
import { privateFolderDenial } from '../../agentLoop/tools';
import type { ToolGate } from '../toolGate';
import type { CommandAction, CommandExecutionRequestApprovalParams } from './protocol';

export type PathKind = 'read' | 'search';
/** Why Codex may not read (or search) this absolute path, or null. */
export type PathPrivacy = (absPath: string, kind: PathKind) => string | null;
export type CommandClass = { kind: 'readOnly' } | { kind: 'private'; reason: string } | { kind: 'ask' };

const ASK: CommandClass = { kind: 'ask' };
const READ_ACTIONS: ReadonlySet<string> = new Set(['read', 'listFiles', 'search']);
const PROGRAMS: ReadonlySet<string> = new Set(['cat', 'head', 'tail', 'nl', 'wc', 'ls', 'pwd', 'stat', 'grep', 'egrep', 'fgrep', 'rg', 'find', 'sed']);
/** Programs that walk folders: their operands are checked as Grep's path is, and so is the folder they search. */
const SEARCHERS: ReadonlySet<string> = new Set(['ls', 'find', 'grep', 'egrep', 'fgrep', 'rg']);
const GREPS: ReadonlySet<string> = new Set(['grep', 'egrep', 'fgrep']);
const SHELLS: ReadonlySet<string> = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);
const FIND_ACTIONS: ReadonlySet<string> = new Set(['-exec', '-execdir', '-ok', '-okdir', '-delete', '-fprint', '-fprint0', '-fprintf', '-fls']);
/** Characters that let a shell run another command, or open other files than the words it was given (R1). */
const SPECIAL = /[;&|<>`$~*?[\]{}%()!\r\n]/;

/** The gate's privacy rule for a path, plus the run-records and sessions folders the agent loop's tools refuse (spec §4.5). */
export function pathPrivacy(gate: Pick<ToolGate, 'privacy'>): PathPrivacy {
  return (path, kind) => (kind === 'read' ? gate.privacy('Read', { file_path: path }) : gate.privacy('Grep', { path })) ?? privateFolderDenial(path);
}

/** A command line's words, with single and double quotes removed; null when it can't be read safely (R1). */
export function shellWords(s: string, platform: NodeJS.Platform): string[] | null {
  const words: string[] = [];
  let word = '';
  let inWord = false;
  let quote: '"' | "'" | null = null;
  for (const ch of s) {
    if (ch === '\\' && platform !== 'win32') return null;
    if (quote) {
      if (ch === quote) quote = null;
      else word += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      inWord = true;
      continue;
    }
    if (ch === ' ' || ch === '\t') {
      if (inWord) words.push(word);
      word = '';
      inWord = false;
      continue;
    }
    word += ch;
    inWord = true;
  }
  if (quote) return null;
  if (inWord) words.push(word);
  return words;
}

/** The words the shell will run: `<shell> -c|-lc '<script>'`, as Codex sends commands, is unwrapped once. */
function commandWords(command: string, platform: NodeJS.Platform): string[] | null {
  const words = shellWords(command, platform);
  if (words?.length === 3 && SHELLS.has(words[0].split('/').pop() ?? '') && (words[1] === '-c' || words[1] === '-lc')) return shellWords(words[2], platform);
  return words;
}

const namesAgentStream = (word: string) => word.split(/[\\/]/).some((part) => part.toLowerCase() === '.agent-stream');

/** The per-program limits of R1: nothing that writes, runs another program, never ends, or ignores ignore rules. */
function programAllows([program, ...args]: string[]): boolean {
  const flags = args.filter((a) => a.startsWith('-') && a !== '-');
  const short = (letters: string) => flags.some((f) => !f.startsWith('--') && [...f.slice(1)].some((ch) => letters.includes(ch)));
  const long = (re: RegExp) => flags.some((f) => re.test(f));
  switch (program) {
    case 'find':
      return !args.some((a) => FIND_ACTIONS.has(a));
    case 'sed':
      return args.length >= 3 && args[0] === '-n' && /^\d+(,\d+)?p$/.test(args[1]) && args.slice(2).every((a) => !a.startsWith('-'));
    case 'rg':
      return !short('u.z') && !long(/^--(pre|pre-glob|hidden|no-ignore[\w-]*|unrestricted|search-zip)(=|$)/);
    case 'grep':
    case 'egrep':
    case 'fgrep':
      return !short('rRd') && !long(/^--(recursive|dereference-recursive|directories)(=|$)/);
    case 'tail':
      return !short('fF') && !long(/^--(follow|retry)(=|$)/);
    default:
      return true;
  }
}

/**
 * How Agent Stream answers a command approval request (spec §4.5, R1):
 * - `private`: a path Codex named, or an operand of a read program, is private: declined without asking;
 * - `readOnly`: one plain read (allowed without asking, logged like Read/Grep/Glob, `by: 'readOnly'`);
 * - `ask`: everything else goes to the gate.
 */
export function classifyCommand(p: CommandExecutionRequestApprovalParams, o: { cwd: string; platform: NodeJS.Platform; privacy: PathPrivacy }): CommandClass {
  const cwd = p.cwd || o.cwd;
  const actions: CommandAction[] = p.commandActions ?? [];
  for (const a of actions) {
    const path = a.type === 'unknown' ? null : a.path;
    if (!path) continue;
    const reason = o.privacy(resolve(cwd, path), a.type === 'read' ? 'read' : 'search');
    if (reason) return { kind: 'private', reason };
  }
  const special = (text: string) => SPECIAL.test(text) || (o.platform === 'win32' ? text.includes(',') : text.includes('\\'));
  const command = p.command ?? '';
  const words = special(command) ? null : commandWords(command, o.platform);
  if (words && words.length > 0 && PROGRAMS.has(words[0])) {
    // The actions are a best-effort parse: `cat notes.txt <values file>` reports one read of notes.txt.
    const kind: PathKind = SEARCHERS.has(words[0]) ? 'search' : 'read';
    const paths = words.slice(1).filter((w) => !w.startsWith('-')).map((w) => resolve(cwd, w));
    if (kind === 'search') paths.push(resolve(cwd));
    for (const path of paths) {
      const reason = o.privacy(path, kind);
      if (reason) return { kind: 'private', reason };
    }
  }
  if ((p.kind ?? 'command') !== 'command' || p.additionalPermissions || p.networkApprovalContext) return ASK;
  if (actions.length === 0 || !actions.every((a) => READ_ACTIONS.has(a.type)) || actions.some((a) => special(a.command))) return ASK;
  if (!words || words.length === 0 || !PROGRAMS.has(words[0]) || words.some((w) => w.startsWith('='))) return ASK;
  if (!programAllows(words)) return ASK;
  if ((words[0] === 'rg' || GREPS.has(words[0])) && words.slice(1).some(namesAgentStream)) return ASK;
  return { kind: 'readOnly' };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -w engine -- test/codexReadOnly.test.ts test/loopTools.test.ts`
Expected: PASS (the loop tools' tests are unchanged).

- [ ] **Step 6: Typecheck and commit**

Run: `npm run typecheck`
Expected: no errors.

```bash
git add engine/src/agentLoop/tools.ts engine/src/providers/codex/readOnlyCommand.ts engine/test/codexReadOnly.test.ts
git commit -m "feat(engine): which Codex commands only read, and which touch private paths

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Server requests become gate decisions

**Spec tests owned (§8):** Approvals — a command allowed or denied by the gate; a file change built from its item, allowed or denied; permissions always declined; a dynamic tool call through the gate (step tools self-approve); unknown requests answered with an error; read-only steps declining without asking; private-path commands declined without asking.

**Files:**
- Create: `engine/src/providers/codex/approvals.ts`
- Test: `engine/test/codexApprovals.test.ts`

**Interfaces:**
- Consumes: `ToolGate`, `ToolDecision`, `createStepGate`, `createPlannerGate`, `STEP_GRAPH_TOOL_PREFIX` (`toolGate.ts`, unchanged); `LoopTool` (`agentLoop/tools.ts`); `CodexRpcError`, `UNSUPPORTED_REQUEST` (Task 2); `classifyCommand`, `pathPrivacy` (Task 5); protocol types (Task 2).
- Produces:
  ```ts
  // engine/src/providers/codex/approvals.ts
  export type PatchChange = { path: string; kind: 'add' | 'update' | 'delete'; diff: string; movePath?: string };
  export function toPatchChanges(changes: FileUpdateChange[]): PatchChange[];
  export const PERMISSIONS_DECLINED = 'Codex asked for extra permissions; declined.';
  export const UNNAMED_CHANGE = "Codex asked to change files it didn't name; declined.";
  export function grantRootDeclined(root: string): string;
  export type ApprovalContext = {
    gate: ToolGate;
    cwd: string;
    platform: NodeJS.Platform;
    tools: ReadonlyMap<string, LoopTool>;            // by the name Codex calls them
    signal: AbortSignal;                             // R18
    fileChanges: ReadonlyMap<string, FileUpdateChange[]>; // item id → changes, from item/started (R14)
    onDeclined(itemId: string, reason: string): void; // R13
    note(text: string): void;                         // a line for the step log
  };
  export function createServerRequestHandler(c: ApprovalContext): (method: string, params: unknown) => Promise<unknown>;
  // The `Patch` gate input (the approval card, Task 12): { description?: string; changes: PatchChange[] }
  ```

- [ ] **Step 1: Write the failing tests**

Create `engine/test/codexApprovals.test.ts`:

```ts
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Decision } from '@agent-stream/shared';
import { ApprovalBroker } from '../src/approvals';
import type { LoopTool } from '../src/agentLoop/tools';
import { createPlannerGate, createStepGate, STEP_GRAPH_TOOL_PREFIX, type ToolGate } from '../src/providers/toolGate';
import { createServerRequestHandler, grantRootDeclined, toPatchChanges, UNNAMED_CHANGE, type ApprovalContext } from '../src/providers/codex/approvals';
import { UNSUPPORTED_REQUEST } from '../src/providers/codex/connection';
import type { CommandAction, FileUpdateChange } from '../src/providers/codex/protocol';
import { approvalParams, readAction, waitFor } from './codexFake';

const cwd = resolve('/', 'work', 'proj');
const values = resolve('/', 'h', '.agent-stream', 'values', 'abc.json');
const VALUES_REASON = "Variable values are private to this machine; Agent Stream doesn't let Claude read the variable values file.";
const RUN_REASON = "Run records contain variable values; Agent Stream doesn't let Claude read .agent-stream/runs/*/run.json or events.jsonl.";
const at = { threadId: 'thread-1', turnId: 'turn-1', startedAtMs: 0 };

function stepGate(o: { readOnly?: boolean; selfApproving?: string[] } = {}) {
  const broker = new ApprovalBroker();
  const gate = createStepGate({
    broker,
    runId: 'r1',
    graphId: 'g',
    nodeId: 'n1',
    nodeTitle: 'Step',
    projectDir: cwd,
    privateFiles: [values],
    signal: new AbortController().signal,
    emit: () => {},
    readOnly: o.readOnly,
    selfApproving: new Set(o.selfApproving ?? []),
  });
  return { gate, broker };
}
const plannerGate = (graphToolNames: string[] = []) => createPlannerGate({ projectDir: cwd, privateFiles: [values], graphToolNames: new Set(graphToolNames) });

function handlerFor(gate: ToolGate, over: Partial<ApprovalContext> = {}) {
  const declined = new Map<string, string>();
  const notes: string[] = [];
  const fileChanges = new Map<string, FileUpdateChange[]>();
  const handle = createServerRequestHandler({
    gate,
    cwd,
    platform: 'linux',
    tools: new Map(),
    signal: new AbortController().signal,
    fileChanges,
    onDeclined: (id, reason) => declined.set(id, reason),
    note: (text) => notes.push(text),
    ...over,
  });
  return { handle, declined, notes, fileChanges };
}

const zsh = (script: string) => `/bin/zsh -lc '${script}'`;
const command = (script: string, actions: CommandAction[] = [{ type: 'unknown', command: script }], reason?: string) =>
  approvalParams({ command: zsh(script), cwd, actions, ...(reason !== undefined && { reason }) });
const plainRead = command('cat notes.txt', [readAction('cat notes.txt', resolve(cwd, 'notes.txt'))]);

async function decideNext(broker: ApprovalBroker, decision: Decision) {
  await waitFor(() => broker.pending().length === 1);
  const [request] = broker.pending();
  broker.decide(request.id, decision);
  return request;
}

describe('commands', () => {
  it('asks the user, showing the command and its reason, and accepts when approved', async () => {
    const { gate, broker } = stepGate();
    const { handle } = handlerFor(gate);
    const answer = handle('item/commandExecution/requestApproval', command('npm test', undefined, 'Run the tests'));
    const request = await decideNext(broker, { decision: 'approve' });
    expect(request).toMatchObject({ toolName: 'Bash', input: { command: zsh('npm test'), description: 'Run the tests' } });
    expect(await answer).toEqual({ decision: 'accept' });
  });

  it('declines a denied command and remembers why, for its log line (R13)', async () => {
    const { gate, broker } = stepGate();
    const { handle, declined } = handlerFor(gate);
    const answer = handle('item/commandExecution/requestApproval', command('rm -rf build'));
    await decideNext(broker, { decision: 'deny', note: 'not now' });
    expect(await answer).toEqual({ decision: 'decline' });
    expect(declined.get('cmd-1')).toBe('Denied by the user: not now');
  });

  it('runs a plain read without asking', async () => {
    const { gate, broker } = stepGate();
    const { handle } = handlerFor(gate);
    expect(await handle('item/commandExecution/requestApproval', plainRead)).toEqual({ decision: 'accept' });
    expect(broker.pending()).toEqual([]);
  });

  it('declines a private-path command without asking, with the privacy reason', async () => {
    const { gate, broker } = stepGate();
    const { handle, declined } = handlerFor(gate);
    expect(await handle('item/commandExecution/requestApproval', command(`cat ${values}`, [readAction(`cat ${values}`, values)]))).toEqual({ decision: 'decline' });
    expect(declined.get('cmd-1')).toBe(VALUES_REASON);
    expect(broker.pending()).toEqual([]);
  });

  it('declines everything that would change something in a read-only step without asking, but lets plain reads run (R2)', async () => {
    const { gate, broker } = stepGate({ readOnly: true });
    const { handle, declined } = handlerFor(gate);
    expect(await handle('item/commandExecution/requestApproval', command('touch x'))).toEqual({ decision: 'decline' });
    expect(declined.get('cmd-1')).toBe('This step is read-only, so Bash isn\'t allowed. Mark the step "Can edit files" if it needs to change something.');
    expect(await handle('item/commandExecution/requestApproval', plainRead)).toEqual({ decision: 'accept' });
    expect(broker.pending()).toEqual([]);
  });

  it('never asks in the planner: changes are refused, reads run', async () => {
    const { handle, declined } = handlerFor(plannerGate());
    expect(await handle('item/commandExecution/requestApproval', command('touch x'))).toEqual({ decision: 'decline' });
    expect(declined.get('cmd-1')).toBe('The planner can only read files and edit the graph.');
    expect(await handle('item/commandExecution/requestApproval', plainRead)).toEqual({ decision: 'accept' });
  });

  it('withdraws an open approval card when its signal aborts (R18)', async () => {
    const { gate, broker } = stepGate();
    const ac = new AbortController();
    const { handle, declined } = handlerFor(gate, { signal: ac.signal });
    const answer = handle('item/commandExecution/requestApproval', command('npm test'));
    await waitFor(() => broker.pending().length === 1);
    ac.abort();
    expect(await answer).toEqual({ decision: 'decline' });
    expect(broker.pending()).toEqual([]);
    expect(declined.get('cmd-1')).toBe('The approval request expired or was withdrawn.');
  });
});

describe('file changes', () => {
  const changes: FileUpdateChange[] = [
    { path: resolve(cwd, 'a.ts'), kind: { type: 'update', move_path: null }, diff: '@@ -1 +1 @@\n-old\n+new' },
    { path: resolve(cwd, 'b.ts'), kind: { type: 'add' }, diff: '+hi' },
  ];

  it('asks with the changes from the item Codex started, and answers the decision', async () => {
    const { gate, broker } = stepGate();
    const { handle, fileChanges } = handlerFor(gate);
    fileChanges.set('patch-1', changes);
    const approved = handle('item/fileChange/requestApproval', { ...at, itemId: 'patch-1', reason: 'Fix the bug' });
    const request = await decideNext(broker, { decision: 'approve' });
    expect(request).toMatchObject({
      toolName: 'Patch',
      input: {
        description: 'Fix the bug',
        changes: [
          { path: resolve(cwd, 'a.ts'), kind: 'update', diff: '@@ -1 +1 @@\n-old\n+new' },
          { path: resolve(cwd, 'b.ts'), kind: 'add', diff: '+hi' },
        ],
      },
    });
    expect(await approved).toEqual({ decision: 'accept' });
    const denied = handle('item/fileChange/requestApproval', { ...at, itemId: 'patch-1' });
    await decideNext(broker, { decision: 'deny' });
    expect(await denied).toEqual({ decision: 'decline' });
  });

  it("declines without asking a change it never saw, a request for a whole folder, and a change to a private path (R14, R26)", async () => {
    const { gate, broker } = stepGate();
    const { handle, fileChanges, declined } = handlerFor(gate);
    expect(await handle('item/fileChange/requestApproval', { ...at, itemId: 'nope' })).toEqual({ decision: 'decline' });
    expect(declined.get('nope')).toBe(UNNAMED_CHANGE);
    fileChanges.set('patch-1', changes);
    expect(await handle('item/fileChange/requestApproval', { ...at, itemId: 'patch-1', grantRoot: cwd })).toEqual({ decision: 'decline' });
    expect(declined.get('patch-1')).toBe(grantRootDeclined(cwd));
    fileChanges.set('patch-2', [{ path: resolve(cwd, '.agent-stream', 'runs', 'r1', 'run.json'), kind: { type: 'update', move_path: null }, diff: '' }]);
    expect(await handle('item/fileChange/requestApproval', { ...at, itemId: 'patch-2' })).toEqual({ decision: 'decline' });
    expect(declined.get('patch-2')).toBe(RUN_REASON);
    expect(broker.pending()).toEqual([]);
  });

  it('lists each change with its kind, and a move target', () => {
    expect(
      toPatchChanges([
        { path: 'a', kind: { type: 'update', move_path: 'b' }, diff: 'd' },
        { path: 'c', kind: { type: 'delete' }, diff: '' },
      ]),
    ).toEqual([
      { path: 'a', kind: 'update', diff: 'd', movePath: 'b' },
      { path: 'c', kind: 'delete', diff: '' },
    ]);
  });
});

describe('other requests', () => {
  it('declines extra permissions with an empty grant, and says so in the log (R3)', async () => {
    const { gate } = stepGate();
    const { handle, notes } = handlerFor(gate);
    expect(await handle('item/permissions/requestApproval', { ...at, itemId: 'p1', reason: 'network', permissions: { network: { enabled: true } } })).toEqual({ permissions: {}, scope: 'turn' });
    expect(notes).toEqual(['Codex asked for extra permissions; declined.']);
  });

  it('runs a step graph tool through the gate without a second approval, and reports its result', async () => {
    const run = vi.fn(async (_input: unknown, _signal: AbortSignal): Promise<{ text: string; isError?: boolean }> => ({ text: 'Added n5.' }));
    const tool: LoopTool = { spec: { name: 'add_step', description: 'Add a step', inputSchema: {} }, gateName: `${STEP_GRAPH_TOOL_PREFIX}add_step`, run };
    const { gate, broker } = stepGate({ selfApproving: [`${STEP_GRAPH_TOOL_PREFIX}add_step`] });
    const { handle } = handlerFor(gate, { tools: new Map([['add_step', tool]]) });
    const call = (name: string) => handle('item/tool/call', { ...at, callId: 'c1', namespace: null, tool: name, arguments: { title: 'x' } });
    expect(await call('add_step')).toEqual({ contentItems: [{ type: 'inputText', text: 'Added n5.' }], success: true });
    expect(run).toHaveBeenCalledWith({ title: 'x' }, expect.any(AbortSignal));
    expect(broker.pending()).toEqual([]);
    run.mockResolvedValueOnce({ text: 'No such step.', isError: true });
    expect(await call('add_step')).toEqual({ contentItems: [{ type: 'inputText', text: 'No such step.' }], success: false });
    expect(await call('nope')).toEqual({ contentItems: [{ type: 'inputText', text: 'Unknown tool nope.' }], success: false });
  });

  it("lets the planner gate decide on graph tools by their plain names", async () => {
    const run = vi.fn(async (_input: unknown, _signal: AbortSignal) => ({ text: 'ok' }));
    const tools = new Map<string, LoopTool>([
      ['add_step', { spec: { name: 'add_step', description: '', inputSchema: {} }, gateName: 'add_step', run }],
      ['other', { spec: { name: 'other', description: '', inputSchema: {} }, gateName: 'other', run }],
    ]);
    const { handle } = handlerFor(plannerGate(['add_step']), { tools });
    expect(await handle('item/tool/call', { ...at, callId: 'c1', namespace: null, tool: 'add_step', arguments: {} })).toEqual({ contentItems: [{ type: 'inputText', text: 'ok' }], success: true });
    expect(await handle('item/tool/call', { ...at, callId: 'c2', namespace: null, tool: 'other', arguments: {} })).toEqual({
      contentItems: [{ type: 'inputText', text: 'The planner can only read files and edit the graph.' }],
      success: false,
    });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("answers requests Agent Stream doesn't support with a JSON-RPC error (R16)", async () => {
    const { gate } = stepGate();
    const { handle } = handlerFor(gate);
    for (const method of ['item/tool/requestUserInput', 'mcpServer/elicitation/request', 'execCommandApproval', 'applyPatchApproval', 'currentTime/read', 'attestation/generate', 'account/chatgptAuthTokens/refresh', 'something/new']) {
      await expect(handle(method, {}), method).rejects.toMatchObject({ code: -32601, message: UNSUPPORTED_REQUEST });
    }
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w engine -- test/codexApprovals.test.ts`
Expected: FAIL with "Failed to load url ../src/providers/codex/approvals".

- [ ] **Step 3: Write the implementation**

Create `engine/src/providers/codex/approvals.ts`:

```ts
import { resolve } from 'node:path';
import type { LoopTool } from '../../agentLoop/tools';
import type { ToolDecision, ToolGate } from '../toolGate';
import { CodexRpcError, UNSUPPORTED_REQUEST } from './connection';
import type {
  CommandExecutionRequestApprovalParams,
  CommandExecutionRequestApprovalResponse,
  DynamicToolCallParams,
  DynamicToolCallResponse,
  FileChangeRequestApprovalParams,
  FileChangeRequestApprovalResponse,
  FileUpdateChange,
  PermissionsRequestApprovalResponse,
} from './protocol';
import { classifyCommand, pathPrivacy } from './readOnlyCommand';

/** One file in a `Patch` approval: what the card shows (spec §5). */
export type PatchChange = { path: string; kind: 'add' | 'update' | 'delete'; diff: string; movePath?: string };

export function toPatchChanges(changes: FileUpdateChange[]): PatchChange[] {
  return changes.map((c) => ({ path: c.path, kind: c.kind.type, diff: c.diff, ...(c.kind.type === 'update' && c.kind.move_path ? { movePath: c.kind.move_path } : {}) }));
}

export const PERMISSIONS_DECLINED = 'Codex asked for extra permissions; declined.';
export const UNNAMED_CHANGE = "Codex asked to change files it didn't name; declined.";
export const grantRootDeclined = (root: string) => `Codex asked to write anywhere under ${root} for the rest of the session; declined.`;

export type ApprovalContext = {
  gate: ToolGate;
  /** Where relative paths resolve when a request names no cwd: the step's or the planner's folder. */
  cwd: string;
  platform: NodeJS.Platform;
  /** The dynamic tools, by the name Codex calls them. */
  tools: ReadonlyMap<string, LoopTool>;
  /** Aborts when the step or turn ends or Codex exits, so no approval card outlives its Codex process (R18). */
  signal: AbortSignal;
  /** File changes by item id, recorded from item/started before the approval request arrives (R14). */
  fileChanges: ReadonlyMap<string, FileUpdateChange[]>;
  /** Why an item was declined, shown in its tool_result (R13). */
  onDeclined(itemId: string, reason: string): void;
  /** A line for the step log. */
  note(text: string): void;
};

/**
 * Codex's server requests as ToolGate decisions (spec §4.5). `acceptForSession` is never sent, so every action that asks
 * is approved on its own. Requests we don't support get a JSON-RPC error and the turn goes on (R16).
 */
export function createServerRequestHandler(c: ApprovalContext): (method: string, params: unknown) => Promise<unknown> {
  const privacy = pathPrivacy(c.gate);
  const settle = (itemId: string, d: ToolDecision): { decision: 'accept' | 'decline' } => {
    if (d.allow) return { decision: 'accept' };
    c.onDeclined(itemId, d.reason);
    return { decision: 'decline' };
  };

  async function command(p: CommandExecutionRequestApprovalParams): Promise<CommandExecutionRequestApprovalResponse> {
    const verdict = classifyCommand(p, { cwd: c.cwd, platform: c.platform, privacy });
    if (verdict.kind === 'private') return settle(p.itemId, { allow: false, reason: verdict.reason });
    // Like Claude's Read/Grep/Glob: allowed without asking, and logged by its tool_call and tool_result.
    if (verdict.kind === 'readOnly') return settle(p.itemId, { allow: true, by: 'readOnly' });
    const input = { command: p.command ?? '', ...(p.reason ? { description: p.reason } : {}) };
    return settle(p.itemId, await c.gate.decide('Bash', input, c.signal));
  }

  async function fileChange(p: FileChangeRequestApprovalParams): Promise<FileChangeRequestApprovalResponse> {
    if (p.grantRoot) return settle(p.itemId, { allow: false, reason: grantRootDeclined(p.grantRoot) });
    const changes = c.fileChanges.get(p.itemId);
    if (!changes) return settle(p.itemId, { allow: false, reason: UNNAMED_CHANGE });
    for (const ch of changes) {
      const paths = ch.kind.type === 'update' && ch.kind.move_path ? [ch.path, ch.kind.move_path] : [ch.path];
      for (const path of paths) {
        const reason = privacy(resolve(c.cwd, path), 'read');
        if (reason) return settle(p.itemId, { allow: false, reason });
      }
    }
    const input = { ...(p.reason ? { description: p.reason } : {}), changes: toPatchChanges(changes) };
    return settle(p.itemId, await c.gate.decide('Patch', input, c.signal));
  }

  async function toolCall(p: DynamicToolCallParams): Promise<DynamicToolCallResponse> {
    const reply = (text: string, success: boolean): DynamicToolCallResponse => ({ contentItems: [{ type: 'inputText', text }], success });
    const tool = c.tools.get(p.tool);
    if (!tool) return reply(`Unknown tool ${p.tool}.`, false);
    // Step graph tools self-approve (they ask the user with the exact change); planner graph tools pass by name.
    const d = await c.gate.decide(tool.gateName, p.arguments, c.signal);
    if (!d.allow) return reply(d.reason, false);
    try {
      const out = await tool.run(p.arguments ?? {}, c.signal);
      return reply(out.text, out.isError !== true);
    } catch (e) {
      return reply(e instanceof Error ? e.message : String(e), false);
    }
  }

  return async (method, params) => {
    switch (method) {
      case 'item/commandExecution/requestApproval':
        return command(params as CommandExecutionRequestApprovalParams);
      case 'item/fileChange/requestApproval':
        return fileChange(params as FileChangeRequestApprovalParams);
      case 'item/permissions/requestApproval': {
        c.note(PERMISSIONS_DECLINED);
        const none: PermissionsRequestApprovalResponse = { permissions: {}, scope: 'turn' };
        return none;
      }
      case 'item/tool/call':
        return toolCall(params as DynamicToolCallParams);
      default:
        throw new CodexRpcError(-32601, UNSUPPORTED_REQUEST);
    }
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -w engine -- test/codexApprovals.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck`
Expected: no errors.

```bash
git add engine/src/providers/codex/approvals.ts engine/test/codexApprovals.test.ts
git commit -m "feat(engine): Codex approval requests go through the ToolGate

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: One Codex turn, from `turn/start` to `turn/completed`

**Spec tests owned (§8):** the turn lifecycle shared by steps and the planner — Stop sending `turn/interrupt`; a server exit mid-turn; usage; Codex error notifications (§7).

**Files:**
- Create: `engine/src/providers/codex/turn.ts`
- Test: `engine/test/codexTurn.test.ts`

**Interfaces:**
- Consumes: `CodexConnection`, `openCodex` (Task 2); protocol types (Task 2); `LoopTool` (`agentLoop/tools.ts`); `EffortLevel`, `NodeUsage` from `@agent-stream/shared`; `fakeCodex`, `turnHandlers`, `agentMessage` (Task 2).
- Produces:
  ```ts
  // engine/src/providers/codex/turn.ts
  export const INTERRUPT_WAIT_MS = 5000;
  export const codexFailure: (message: string) => string;            // `Codex failed: ${message}`
  export function usageOf(t: TokenUsageBreakdown): NodeUsage;        // R11
  export function dynamicToolSpecs(tools: readonly LoopTool[]): DynamicToolSpec[]; // R17: no $schema
  export type TurnOutcome = { status: 'completed' | 'failed' | 'interrupted' | 'cancelled'; lastText: string; error?: string; usage?: NodeUsage };
  export type RunTurnOptions = {
    conn: CodexConnection;
    threadId: string;
    text: string;
    effort?: EffortLevel;
    signal: AbortSignal;                                                  // Stop
    onItem(phase: 'started' | 'completed', item: ThreadItem): void;
    onRetry?(text: string): void;                                         // R12
    interruptWaitMs?: number;
  };
  export function runCodexTurn(o: RunTurnOptions): Promise<TurnOutcome>;  // rejects with the exit message if Codex exits
  ```

- [ ] **Step 1: Write the failing tests**

Create `engine/test/codexTurn.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { LoopTool } from '../src/agentLoop/tools';
import { openCodex } from '../src/providers/codex/connection';
import type { ThreadItem } from '../src/providers/codex/protocol';
import { dynamicToolSpecs, runCodexTurn, usageOf, type RunTurnOptions } from '../src/providers/codex/turn';
import { agentMessage, fakeCodex, turnHandlers, waitFor, type FakeHandler, type TurnScript } from './codexFake';

async function turn(handlers: Record<string, FakeHandler>, o: Partial<RunTurnOptions> = {}) {
  const fake = fakeCodex(handlers);
  const conn = await openCodex({ codexPath: '/bin/codex', spawn: fake.spawn });
  const items: [string, ThreadItem][] = [];
  const retries: string[] = [];
  const outcome = runCodexTurn({
    conn,
    threadId: 'thread-1',
    text: 'Do it',
    signal: new AbortController().signal,
    onItem: (phase, item) => items.push([phase, item]),
    onRetry: (text) => retries.push(text),
    ...o,
  });
  return { outcome, items, retries, proc: fake.last(), conn };
}
const scripted = (script: (t: TurnScript) => unknown, o: Partial<RunTurnOptions> = {}) => turn(turnHandlers({ script }), o);

describe('runCodexTurn', () => {
  it('sends turn/start and ends on turn/completed with the last agent message', async () => {
    const t = await scripted((s) => {
      s.item(agentMessage('Working.', 'm1'));
      s.item(agentMessage('Done.', 'm2'));
      s.end();
    });
    expect(await t.outcome).toEqual({ status: 'completed', lastText: 'Done.' });
    expect(t.proc.paramsOf('turn/start')).toEqual({ threadId: 'thread-1', input: [{ type: 'text', text: 'Do it', text_elements: [] }] });
    expect(t.items.map(([phase, item]) => `${phase} ${item.id}`)).toEqual(['started m1', 'completed m1', 'started m2', 'completed m2']);
    t.conn.close();
  });

  it('sends the effort when one is given', async () => {
    const t = await scripted((s) => s.end(), { effort: 'ultra' });
    await t.outcome;
    expect(t.proc.paramsOf('turn/start').effort).toBe('ultra');
    t.conn.close();
  });

  it("reports the turn's tokens, with cached input counted apart (R11)", async () => {
    const t = await scripted((s) => {
      s.usage({ inputTokens: 1000, cachedInputTokens: 600, cacheWriteInputTokens: 100, outputTokens: 50 });
      s.end();
    });
    expect((await t.outcome).usage).toEqual({ inputTokens: 300, outputTokens: 50, cacheReadTokens: 600, cacheWriteTokens: 100, costUsd: 0, turns: 1 });
    expect(usageOf({ totalTokens: 0, inputTokens: 10, cachedInputTokens: 20, cacheWriteInputTokens: 0, outputTokens: 1, reasoningOutputTokens: 0 }).inputTokens).toBe(0);
    t.conn.close();
  });

  it('fails a turn that failed or was interrupted, with the reason (R22)', async () => {
    const failed = await scripted((s) => s.end('failed', 'rate limited'));
    expect(await failed.outcome).toEqual({ status: 'failed', lastText: '', error: 'Codex failed: rate limited' });
    const bare = await scripted((s) => s.end('failed'));
    expect((await bare.outcome).error).toBe('Codex failed: the turn failed.');
    const interrupted = await scripted((s) => s.end('interrupted'));
    expect(await interrupted.outcome).toEqual({ status: 'interrupted', lastText: '', error: 'Codex failed: the turn was interrupted.' });
    for (const t of [failed, bare, interrupted]) t.conn.close();
  });

  it('logs a retrying error and fails on a final one (R12)', async () => {
    const t = await scripted((s) => {
      s.error('stream dropped', true);
      s.error('model refused');
      s.end('completed');
    });
    expect(await t.outcome).toEqual({ status: 'failed', lastText: '', error: 'Codex failed: model refused' });
    expect(t.retries).toEqual(['Codex: stream dropped (retrying)']);
    t.conn.close();
  });

  it("ignores another thread's notifications", async () => {
    const t = await scripted((s) => {
      s.proc.notify('item/completed', { threadId: 'other', turnId: 'x', item: agentMessage('not mine', 'o1') });
      s.proc.notify('turn/completed', { threadId: 'other', turn: { id: 'x', status: 'failed', error: null, items: [] } });
      s.item(agentMessage('mine', 'm1'));
      s.end();
    });
    expect(await t.outcome).toEqual({ status: 'completed', lastText: 'mine' });
    expect(t.items.map(([, item]) => item.id)).toEqual(['m1', 'm1']);
    t.conn.close();
  });

  it('Stop interrupts the turn, waits for it to end, and returns cancelled', async () => {
    const ac = new AbortController();
    const t = await scripted((s) => s.item(agentMessage('Starting.')), { signal: ac.signal });
    await waitFor(() => t.items.length === 2);
    ac.abort();
    expect(await t.outcome).toEqual({ status: 'cancelled', lastText: 'Starting.' });
    expect(t.proc.paramsOf('turn/interrupt')).toEqual({ threadId: 'thread-1', turnId: 'turn-1' });
    t.conn.close();
  });

  it('Stop returns after the wait when Codex never ends the turn', async () => {
    const ac = new AbortController();
    const t = await turn(turnHandlers({ onInterrupt: 'ignore' }), { signal: ac.signal, interruptWaitMs: 30 });
    await waitFor(() => t.proc.methods().includes('turn/start'));
    ac.abort();
    expect((await t.outcome).status).toBe('cancelled');
    t.conn.close();
  });

  it('Stop before turn/start is answered interrupts the turn once its id arrives', async () => {
    let answer!: () => void;
    const answered = new Promise<void>((r) => (answer = r));
    const ac = new AbortController();
    const t = await turn(
      {
        'turn/start': async () => {
          await answered;
          return { turn: { id: 'turn-9', status: 'inProgress', error: null, items: [] } };
        },
        'turn/interrupt': (p: { threadId: string; turnId: string }, proc) => {
          setImmediate(() => proc.notify('turn/completed', { threadId: p.threadId, turn: { id: p.turnId, status: 'interrupted', error: null, items: [] } }));
          return {};
        },
      },
      { signal: ac.signal },
    );
    await waitFor(() => t.proc.methods().includes('turn/start'));
    ac.abort();
    answer();
    expect((await t.outcome).status).toBe('cancelled');
    expect(t.proc.paramsOf('turn/interrupt')).toEqual({ threadId: 'thread-1', turnId: 'turn-9' });
    t.conn.close();
  });

  it('rejects with the exit message when Codex exits mid-turn', async () => {
    const t = await scripted((s) => {
      s.item(agentMessage('Hi'));
      void s.proc.exit(2, 'panic\n');
    });
    await expect(t.outcome).rejects.toThrow('Codex stopped unexpectedly (exit 2).\npanic');
  });
});

describe('dynamicToolSpecs', () => {
  it("offers each loop tool as a function, without zod's $schema key (R17)", () => {
    const tool: LoopTool = {
      spec: { name: 'add_step', description: 'Add a step', inputSchema: { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', properties: { title: { type: 'string' } } } },
      gateName: 'add_step',
      run: async () => ({ text: '' }),
    };
    expect(dynamicToolSpecs([tool])).toEqual([{ type: 'function', name: 'add_step', description: 'Add a step', inputSchema: { type: 'object', properties: { title: { type: 'string' } } } }]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w engine -- test/codexTurn.test.ts`
Expected: FAIL with "Failed to load url ../src/providers/codex/turn".

- [ ] **Step 3: Write the implementation**

Create `engine/src/providers/codex/turn.ts`:

```ts
import { setTimeout as sleep } from 'node:timers/promises';
import type { EffortLevel, NodeUsage } from '@agent-stream/shared';
import type { LoopTool } from '../../agentLoop/tools';
import type { CodexConnection } from './connection';
import type {
  DynamicToolSpec,
  ErrorNotification,
  ItemNotification,
  ThreadItem,
  ThreadTokenUsageUpdatedNotification,
  TokenUsageBreakdown,
  Turn,
  TurnCompletedNotification,
  TurnStartParams,
  TurnStartResponse,
} from './protocol';

/** How long Stop waits for the turn id, then for turn/completed, before closing anyway (spec §4.6). */
export const INTERRUPT_WAIT_MS = 5000;
export const codexFailure = (message: string) => `Codex failed: ${message}`;

/** The thread's token totals (R11). Codex counts cached input inside inputTokens; Agent Stream counts it apart. No cost is reported. */
export function usageOf(t: TokenUsageBreakdown): NodeUsage {
  return {
    inputTokens: Math.max(0, t.inputTokens - t.cachedInputTokens - t.cacheWriteInputTokens),
    outputTokens: t.outputTokens,
    cacheReadTokens: t.cachedInputTokens,
    cacheWriteTokens: t.cacheWriteInputTokens,
    costUsd: 0,
    turns: 1,
  };
}

/** Loop tools as Codex dynamic tools (spec §4.6, §4.7); zod's `$schema` key is dropped (R17). */
export function dynamicToolSpecs(tools: readonly LoopTool[]): DynamicToolSpec[] {
  return tools.map((t) => {
    const { $schema: _schema, ...inputSchema } = t.spec.inputSchema as Record<string, unknown>;
    return { type: 'function', name: t.spec.name, description: t.spec.description, inputSchema };
  });
}

export type TurnOutcome = { status: 'completed' | 'failed' | 'interrupted' | 'cancelled'; lastText: string; error?: string; usage?: NodeUsage };

export type RunTurnOptions = {
  conn: CodexConnection;
  threadId: string;
  text: string;
  effort?: EffortLevel;
  /** Stop. */
  signal: AbortSignal;
  onItem(phase: 'started' | 'completed', item: ThreadItem): void;
  /** A Codex error it will retry (R12). */
  onRetry?(text: string): void;
  interruptWaitMs?: number;
};

function settleable<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  promise.catch(() => {}); // a rejection nobody waits for (after Stop) is not an error
  return { promise, resolve, reject };
}

/**
 * One turn (spec §4.6, §4.7): sends turn/start, passes items on as they start and complete, and resolves on
 * turn/completed. Stop sends turn/interrupt and waits up to `interruptWaitMs` for the turn to end. Codex exiting
 * rejects with the connection's message.
 */
export async function runCodexTurn(o: RunTurnOptions): Promise<TurnOutcome> {
  const waitMs = o.interruptWaitMs ?? INTERRUPT_WAIT_MS;
  let lastText = '';
  let usage: NodeUsage | undefined;
  let failure: string | undefined;
  const completed = settleable<Turn>();
  const started = settleable<string>();
  o.conn.onNotification((method, params) => {
    const threadId = (params as { threadId?: unknown } | null | undefined)?.threadId;
    if (threadId !== undefined && threadId !== o.threadId) return;
    switch (method) {
      case 'item/started':
        o.onItem('started', (params as ItemNotification).item);
        return;
      case 'item/completed': {
        const { item } = params as ItemNotification;
        if (item.type === 'agentMessage' && item.text.trim()) lastText = item.text;
        o.onItem('completed', item);
        return;
      }
      case 'thread/tokenUsage/updated':
        usage = usageOf((params as ThreadTokenUsageUpdatedNotification).tokenUsage.total);
        return;
      case 'error': {
        const e = params as ErrorNotification;
        if (e.willRetry) o.onRetry?.(`Codex: ${e.error.message} (retrying)`);
        else failure = codexFailure(e.error.message);
        return;
      }
      case 'turn/completed':
        completed.resolve((params as TurnCompletedNotification).turn);
        return;
    }
  });
  o.conn.onExit((message) => {
    const error = new Error(message);
    completed.reject(error);
    started.reject(error);
  });

  const params: TurnStartParams = { threadId: o.threadId, input: [{ type: 'text', text: o.text, text_elements: [] }], ...(o.effort && { effort: o.effort }) };
  o.conn.request<TurnStartResponse>('turn/start', params).then(
    (r) => started.resolve(r.turn.id),
    (e: unknown) => started.reject(e),
  );
  const finished = started.promise.then(() => completed.promise);
  finished.catch(() => {});
  let onAbort: (() => void) | undefined;
  const stop = new Promise<'stop'>((resolve) => {
    onAbort = () => resolve('stop');
    if (o.signal.aborted) onAbort();
    else o.signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    const first = await Promise.race([finished, stop]);
    if (first === 'stop') {
      const turnId = await Promise.race([started.promise.catch(() => undefined), sleep(waitMs, undefined, { ref: false })]);
      if (turnId) {
        o.conn.request('turn/interrupt', { threadId: o.threadId, turnId }).catch(() => {});
        await Promise.race([completed.promise.catch(() => undefined), sleep(waitMs, undefined, { ref: false })]);
      }
      return { status: 'cancelled', lastText, ...(usage && { usage }) };
    }
    if (first.status === 'completed' && !failure) return { status: 'completed', lastText, ...(usage && { usage }) };
    const error =
      failure ?? (first.error?.message ? codexFailure(first.error.message) : codexFailure(first.status === 'interrupted' ? 'the turn was interrupted.' : 'the turn failed.'));
    return { status: first.status === 'interrupted' ? 'interrupted' : 'failed', lastText, error, ...(usage && { usage }) };
  } finally {
    if (onAbort) o.signal.removeEventListener('abort', onAbort);
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -w engine -- test/codexTurn.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck`
Expected: no errors.

```bash
git add engine/src/providers/codex/turn.ts engine/test/codexTurn.test.ts
git commit -m "feat(engine): run one Codex turn, with Stop, usage and Codex's errors

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Agent steps on Codex

**Spec tests owned (§8):** Steps — the event mapping for each item type; the outcome and usage; the thread options for write and read-only steps; a variant worktree as `cwd`; effort and model passed through; Stop sending `turn/interrupt` and returning cancelled; a server exit mid-turn; the connection always closed. It also pins Review Focus 4.

**Files:**
- Create: `engine/src/providers/codex/runStep.ts`
- Test: `engine/test/codexRunStep.test.ts`

**Interfaces:**
- Consumes: `openCodex`, `errorMessage`, `SpawnCodex`, `CodexConnection` (Task 2); `codexEffort` (Task 4); `createServerRequestHandler`, `toPatchChanges` (Task 6); `runCodexTurn`, `dynamicToolSpecs` (Task 7); `toLoopTools` (`agentLoop/graphLoopTools.ts`); `clipResult` (`agentLoop/tools.ts`); `STEP_GRAPH_TOOL_PREFIX`, `ToolGate`; `NodeContext`, `NodeOutcome` (`executors.ts`); `isWriteCapable` from `@agent-stream/shared`.
- Produces:
  ```ts
  // engine/src/providers/codex/runStep.ts
  export type CodexRunDeps = {
    codexPath: () => string | undefined;
    missing: () => string;
    spawn?: SpawnCodex;
    env?: NodeJS.ProcessEnv;
    platform: NodeJS.Platform;
    knownModels: () => ModelChoice[] | undefined;
    warnOnce: (key: string, message: string) => void;
    log: (message: string) => void;
    interruptWaitMs?: number;
  };
  export const stepPreamble: (cwd: string) => string;  // spec §4.6, verbatim
  export function stepItemEvents(phase: 'started' | 'completed', item: ThreadItem, declined: ReadonlyMap<string, string>): NodeEventBody[];
  export function codexRunStep(deps: CodexRunDeps): (ctx: NodeContext, gate: ToolGate) => Promise<NodeOutcome>;
  ```

- [ ] **Step 1: Write the failing tests**

Create `engine/test/codexRunStep.test.ts`:

```ts
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { emptyGraph, type EffortLevel, type GraphNode, type ModelChoice, type NodeEventBody } from '@agent-stream/shared';
import { ApprovalBroker } from '../src/approvals';
import type { NodeContext } from '../src/executors';
import { createStepGate, STEP_GRAPH_TOOL_PREFIX } from '../src/providers/toolGate';
import type { GraphTool } from '../src/providers/types';
import { codexRunStep, stepItemEvents, stepPreamble, type CodexRunDeps } from '../src/providers/codex/runStep';
import type { CommandAction } from '../src/providers/codex/protocol';
import {
  agentMessage,
  approvalParams,
  commandItem,
  fakeCodex,
  FakeRpcError,
  fileChangeItem,
  readAction,
  reasoning,
  toolCallItem,
  turnHandlers,
  waitFor,
  type FakeHandler,
  type Msg,
  type TurnScript,
} from './codexFake';

const cwd = resolve('/', 'work', 'proj');
const values = resolve('/', 'h', '.agent-stream', 'values', 'abc.json');
const zsh = (script: string) => `/bin/zsh -lc '${script}'`;
const addStep = (): GraphTool => ({ name: 'add_step', description: 'Add a step', schema: { title: z.string() }, run: vi.fn(async () => ({ text: 'Added n5.' })) });

type StepOptions = { access?: 'read'; cwd?: string; model?: string; effort?: EffortLevel; graphTools?: GraphTool[]; signal?: AbortSignal; known?: ModelChoice[]; codexPath?: string | undefined };

/** A step on the fake app-server, with the gate the App builds for it (runs recorded in the folder's own .agent-stream). */
function setup(handlers: Record<string, FakeHandler>, o: StepOptions = {}) {
  const fake = fakeCodex(handlers);
  const broker = new ApprovalBroker();
  const events: NodeEventBody[] = [];
  const readOnly = o.access === 'read';
  const graphTools = readOnly ? [] : (o.graphTools ?? []);
  const node: GraphNode = { id: 'n2', title: 'Fix bug', kind: 'agent', prompt: 'p', createdBy: 'user', updatedBy: 'user', updatedAt: 't', ...(o.access && { access: o.access }) };
  const ctx: NodeContext = {
    runId: 'r1',
    graph: emptyGraph('g', 'G', 't'),
    node,
    prompt: 'FULL PROMPT',
    cwd: o.cwd ?? cwd,
    signal: o.signal ?? new AbortController().signal,
    emit: (e) => events.push(e),
    graphTools,
    ...(o.model && { model: o.model }),
    ...(o.effort && { effort: o.effort }),
  };
  const gate = createStepGate({
    broker,
    runId: 'r1',
    graphId: 'g',
    nodeId: 'n2',
    nodeTitle: 'Fix bug',
    projectDir: ctx.cwd,
    runsRoot: cwd,
    privateFiles: [values],
    signal: ctx.signal,
    emit: ctx.emit,
    readOnly,
    selfApproving: new Set(graphTools.map((t) => STEP_GRAPH_TOOL_PREFIX + t.name)),
  });
  const warnings: string[] = [];
  const deps: CodexRunDeps = {
    codexPath: () => ('codexPath' in o ? o.codexPath : '/bin/codex'),
    missing: () => 'Codex is missing.',
    spawn: fake.spawn,
    env: {},
    platform: 'linux',
    knownModels: () => o.known,
    warnOnce: (_key, message) => warnings.push(message),
    log: () => {},
    interruptWaitMs: 50,
  };
  return { fake, broker, events, warnings, run: () => codexRunStep(deps)(ctx, gate) };
}
const step = (script: (t: TurnScript) => unknown, o: StepOptions = {}) => setup(turnHandlers({ script }), o);
const logged = (events: NodeEventBody[]) => events.filter((e) => e.type !== 'start' && e.type !== 'approval_requested' && e.type !== 'approval_decided');

describe('codexRunStep', () => {
  it('starts an ephemeral, untrusted thread in the step folder, with the preamble and its graph tools, and closes Codex after', async () => {
    const s = step(
      (t) => {
        t.item(agentMessage('Done.'));
        t.end();
      },
      { graphTools: [addStep()] },
    );
    expect(await s.run()).toEqual({ ok: true, output: 'Done.' });
    const proc = s.fake.last();
    const start = proc.paramsOf('thread/start');
    expect(start).toMatchObject({ cwd, approvalPolicy: 'untrusted', sandbox: 'workspace-write', ephemeral: true, developerInstructions: stepPreamble(cwd) });
    expect(start).not.toHaveProperty('model');
    expect(start.dynamicTools).toHaveLength(1);
    expect(start.dynamicTools[0]).toMatchObject({ type: 'function', name: 'add_step', description: 'Add a step', inputSchema: { type: 'object', properties: { title: { type: 'string' } } } });
    expect(start.dynamicTools[0].inputSchema).not.toHaveProperty('$schema');
    expect(proc.paramsOf('turn/start')).toEqual({ threadId: 'thread-1', input: [{ type: 'text', text: 'FULL PROMPT', text_elements: [] }] });
    expect(s.events[0]).toEqual({ type: 'start', kind: 'agent', cwd, prompt: 'FULL PROMPT' });
    expect(stepPreamble(cwd)).toBe(`You are an agent running one step of a workflow in ${cwd}. Do the work, then reply with a summary of what you did.`);
    expect(proc.killed).toBe(true);
  });

  it('starts a read-only step in the read-only sandbox, without graph tools', async () => {
    const s = step((t) => t.end(), { access: 'read', graphTools: [addStep()] });
    await s.run();
    const start = s.fake.last().paramsOf('thread/start');
    expect(start.sandbox).toBe('read-only');
    expect(start).not.toHaveProperty('dynamicTools');
  });

  it('works in a variant worktree when the step does', async () => {
    const worktree = resolve('/', 'work', 'proj-wt', 'wh_small');
    const s = step((t) => t.end(), { cwd: worktree });
    await s.run();
    expect(s.fake.last().paramsOf('thread/start')).toMatchObject({ cwd: worktree, developerInstructions: stepPreamble(worktree) });
  });

  it('passes the model and effort through, dropping an effort the listed model lacks (R9)', async () => {
    const known: ModelChoice[] = [{ value: 'gpt-a', label: 'A', efforts: ['high'] }];
    const kept = step((t) => t.end(), { model: 'gpt-a', effort: 'high', known });
    await kept.run();
    expect(kept.fake.last().paramsOf('thread/start').model).toBe('gpt-a');
    expect(kept.fake.last().paramsOf('turn/start').effort).toBe('high');
    const dropped = step((t) => t.end(), { model: 'gpt-a', effort: 'ultra', known });
    await dropped.run();
    expect(dropped.fake.last().paramsOf('turn/start')).not.toHaveProperty('effort');
    expect(dropped.warnings).toEqual(['[agent-stream] A (gpt-a) has no "ultra" effort level; running without an effort level.']);
  });

  it('logs each item the way the step log shows tools and text (spec §4.6)', async () => {
    const change = { path: resolve(cwd, 'a.ts'), kind: { type: 'update' as const, move_path: null }, diff: '-old\n+new' };
    const cat = zsh('cat a.ts');
    const s = step((t) => {
      t.item(reasoning(['Looking at the bug']));
      t.started(commandItem({ id: 'c1', command: cat, status: 'inProgress' }));
      t.completed(commandItem({ id: 'c1', command: cat, status: 'completed', output: 'old\n', exitCode: 0 }));
      t.started(fileChangeItem({ id: 'p1', changes: [change], status: 'inProgress' }));
      t.completed(fileChangeItem({ id: 'p1', changes: [change], status: 'completed' }));
      t.started(toolCallItem({ id: 'd1', tool: 'add_step', args: { title: 'x' }, status: 'inProgress' }));
      t.completed(toolCallItem({ id: 'd1', tool: 'add_step', args: { title: 'x' }, status: 'completed', text: 'Added n5.', success: true }));
      t.item(agentMessage('Fixed.'));
      t.end();
    });
    expect(await s.run()).toEqual({ ok: true, output: 'Fixed.' });
    expect(logged(s.events)).toEqual([
      { type: 'text', text: 'Thinking: Looking at the bug' },
      { type: 'tool_call', toolUseId: 'c1', name: 'Bash', input: { command: cat } },
      { type: 'tool_result', toolUseId: 'c1', content: 'old\nexit 0', isError: false },
      { type: 'tool_call', toolUseId: 'p1', name: 'Patch', input: { changes: [{ path: resolve(cwd, 'a.ts'), kind: 'update', diff: '-old\n+new' }] } },
      { type: 'tool_result', toolUseId: 'p1', content: `changed ${resolve(cwd, 'a.ts')}`, isError: false },
      { type: 'tool_call', toolUseId: 'd1', name: 'add_step', input: { title: 'x' } },
      { type: 'tool_result', toolUseId: 'd1', content: 'Added n5.', isError: false },
      { type: 'text', text: 'Fixed.' },
    ]);
  });

  it('reports the usage, and a failed turn with what the agent said', async () => {
    const ok = step((t) => {
      t.usage({ inputTokens: 1000, cachedInputTokens: 600, cacheWriteInputTokens: 100, outputTokens: 50 });
      t.item(agentMessage('Done.'));
      t.end();
    });
    expect(await ok.run()).toEqual({ ok: true, output: 'Done.', usage: { inputTokens: 300, outputTokens: 50, cacheReadTokens: 600, cacheWriteTokens: 100, costUsd: 0, turns: 1 } });
    const failed = step((t) => {
      t.item(agentMessage('Partial.'));
      t.end('failed', 'rate limited');
    });
    expect(await failed.run()).toEqual({ ok: false, output: 'Partial.', error: 'Codex failed: rate limited' });
  });

  it('asks before a command, and logs why it was declined', async () => {
    const s = step(async (t) => {
      const command = zsh('npm test');
      t.started(commandItem({ id: 'c1', command, status: 'inProgress' }));
      const answer = await t.ask('item/commandExecution/requestApproval', approvalParams({ itemId: 'c1', command, cwd, actions: [{ type: 'unknown', command: 'npm test' }] }));
      t.completed(commandItem({ id: 'c1', command, status: answer.result.decision === 'accept' ? 'completed' : 'declined' }));
      t.end();
    });
    const outcome = s.run();
    await waitFor(() => s.broker.pending().length === 1);
    s.broker.decide(s.broker.pending()[0].id, { decision: 'deny' });
    expect(await outcome).toEqual({ ok: true, output: '' });
    expect(s.events.map((e) => e.type)).toEqual(['start', 'tool_call', 'approval_requested', 'approval_decided', 'tool_result']);
    expect(s.events.at(-1)).toEqual({ type: 'tool_result', toolUseId: 'c1', content: 'declined: Denied by the user.', isError: true });
  });

  it('runs plain reads without asking and declines private reads without asking', async () => {
    const answers: Msg[] = [];
    const ask = (t: TurnScript, script: string, actions: CommandAction[]) =>
      t.ask('item/commandExecution/requestApproval', approvalParams({ command: zsh(script), cwd, actions })).then((a) => answers.push(a));
    const s = step(async (t) => {
      await ask(t, 'cat notes.txt', [readAction('cat notes.txt', resolve(cwd, 'notes.txt'))]);
      await ask(t, `cat ${values}`, [readAction(`cat ${values}`, values)]);
      t.end();
    });
    const changed = vi.fn();
    s.broker.on('changed', changed);
    await s.run();
    expect(answers.map((a) => a.result.decision)).toEqual(['accept', 'decline']);
    expect(changed).not.toHaveBeenCalled();
  });

  it('declines everything but plain reads in a read-only step, without asking', async () => {
    const answers: Msg[] = [];
    const s = step(
      async (t) => {
        answers.push(await t.ask('item/commandExecution/requestApproval', approvalParams({ command: zsh('touch x'), cwd, actions: [{ type: 'unknown', command: 'touch x' }] })));
        answers.push(await t.ask('item/commandExecution/requestApproval', approvalParams({ command: zsh('cat notes.txt'), cwd, actions: [readAction('cat notes.txt', resolve(cwd, 'notes.txt'))] })));
        t.end();
      },
      { access: 'read' },
    );
    const changed = vi.fn();
    s.broker.on('changed', changed);
    await s.run();
    expect(answers.map((a) => a.result.decision)).toEqual(['decline', 'accept']);
    expect(changed).not.toHaveBeenCalled();
  });

  it('Stop interrupts the turn and returns cancelled', async () => {
    const ac = new AbortController();
    const s = step((t) => t.item(agentMessage('Working.')), { signal: ac.signal });
    const outcome = s.run();
    await waitFor(() => s.events.some((e) => e.type === 'text'));
    ac.abort();
    expect(await outcome).toEqual({ ok: false, output: '', error: 'cancelled' });
    expect(s.fake.last().methods()).toContain('turn/interrupt');
    expect(s.fake.last().killed).toBe(true);
  });

  it('fails with the exit message when Codex exits mid-turn', async () => {
    const s = step((t) => void t.proc.exit(2, 'panic\n'));
    expect(await s.run()).toEqual({ ok: false, output: '', error: 'Codex stopped unexpectedly (exit 2).\npanic' });
  });

  it('withdraws a pending approval when Codex exits', async () => {
    const s = step((t) => {
      t.started(commandItem({ id: 'c1', command: zsh('npm test'), status: 'inProgress' }));
      void t.ask('item/commandExecution/requestApproval', approvalParams({ itemId: 'c1', command: zsh('npm test'), cwd, actions: [{ type: 'unknown', command: 'npm test' }] }));
    });
    const outcome = s.run();
    await waitFor(() => s.broker.pending().length === 1);
    await s.fake.last().exit(1);
    expect(await outcome).toEqual({ ok: false, output: '', error: 'Codex stopped unexpectedly (exit 1).' });
    expect(s.broker.pending()).toEqual([]);
  });

  it("closes Codex when the thread can't start, and doesn't start Codex without a path", async () => {
    const refused = setup({ ...turnHandlers({}), 'thread/start': () => { throw new FakeRpcError(-32602, 'bad cwd'); } });
    expect(await refused.run()).toEqual({ ok: false, output: '', error: 'bad cwd' });
    expect(refused.fake.last().killed).toBe(true);
    const missing = setup(turnHandlers({}), { codexPath: undefined });
    expect(await missing.run()).toEqual({ ok: false, output: '', error: 'Codex is missing.' });
    expect(missing.fake.procs).toHaveLength(0);
    const broken = setup({ initialize: () => { throw new FakeRpcError(-32600, 'unsupported client'); } });
    expect(await broken.run()).toEqual({ ok: false, output: '', error: "Codex didn't start: unsupported client" });
  });
});

describe('stepItemEvents', () => {
  it('shows a declined or failed command, and clips long output to 30,000 characters', () => {
    const declined = new Map([['c1', 'Denied by the user.']]);
    expect(stepItemEvents('completed', commandItem({ id: 'c1', command: 'x', status: 'declined' }), declined)).toEqual([{ type: 'tool_result', toolUseId: 'c1', content: 'declined: Denied by the user.', isError: true }]);
    expect(stepItemEvents('completed', commandItem({ id: 'c2', command: 'x', status: 'declined' }), declined)).toEqual([{ type: 'tool_result', toolUseId: 'c2', content: 'declined', isError: true }]);
    expect(stepItemEvents('completed', commandItem({ id: 'c3', command: 'x', status: 'failed', output: 'boom', exitCode: 2 }), declined)).toEqual([{ type: 'tool_result', toolUseId: 'c3', content: 'boom\nexit 2', isError: true }]);
    const [long] = stepItemEvents('completed', commandItem({ id: 'c4', command: 'x', status: 'completed', output: 'x'.repeat(40_000), exitCode: 0 }), declined);
    expect(long.type === 'tool_result' && long.content.length).toBeLessThan(31_000);
  });

  it('skips empty text, other phases and item types it does not show', () => {
    const none = new Map<string, string>();
    expect(stepItemEvents('started', agentMessage('Hi'), none)).toEqual([]);
    expect(stepItemEvents('completed', agentMessage('  '), none)).toEqual([]);
    expect(stepItemEvents('completed', reasoning([]), none)).toEqual([]);
    expect(stepItemEvents('completed', { type: 'userMessage', id: 'u1' }, none)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w engine -- test/codexRunStep.test.ts`
Expected: FAIL with "Failed to load url ../src/providers/codex/runStep".

- [ ] **Step 3: Write the implementation**

Create `engine/src/providers/codex/runStep.ts`:

```ts
import { isWriteCapable, type ModelChoice, type NodeEventBody, type NodeUsage } from '@agent-stream/shared';
import { toLoopTools } from '../../agentLoop/graphLoopTools';
import { clipResult } from '../../agentLoop/tools';
import type { NodeContext, NodeOutcome } from '../../executors';
import { STEP_GRAPH_TOOL_PREFIX, type ToolGate } from '../toolGate';
import { createServerRequestHandler, toPatchChanges } from './approvals';
import { errorMessage, openCodex, type CodexConnection, type SpawnCodex } from './connection';
import { codexEffort } from './models';
import type { DynamicToolContentItem, FileUpdateChange, ThreadItem, ThreadResponse, ThreadStartParams } from './protocol';
import { dynamicToolSpecs, runCodexTurn } from './turn';

/** What the Codex provider shares with its steps and planner turns. */
export type CodexRunDeps = {
  /** The Codex found by the last status check; undefined before one, or when it wasn't found. */
  codexPath: () => string | undefined;
  missing: () => string;
  spawn?: SpawnCodex;
  env?: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  /** The models listed so far, to check an effort against (R9). */
  knownModels: () => ModelChoice[] | undefined;
  warnOnce: (key: string, message: string) => void;
  log: (message: string) => void;
  interruptWaitMs?: number;
};

export const stepPreamble = (cwd: string) => `You are an agent running one step of a workflow in ${cwd}. Do the work, then reply with a summary of what you did.`;

const declinedText = (reason: string | undefined) => (reason ? `declined: ${reason}` : 'declined');
const contentText = (items: DynamicToolContentItem[] | null) => (items ?? []).flatMap((c) => (c.type === 'inputText' ? [c.text] : [])).join('\n');

function commandResult(item: Extract<ThreadItem, { type: 'commandExecution' }>, declined: string | undefined): string {
  if (item.status === 'declined') return declinedText(declined);
  const out = clipResult(item.aggregatedOutput ?? '');
  const end = item.exitCode === null ? item.status : `exit ${item.exitCode}`;
  return out ? `${out}${out.endsWith('\n') ? '' : '\n'}${end}` : end;
}

function patchResult(item: Extract<ThreadItem, { type: 'fileChange' }>, declined: string | undefined): string {
  if (item.status === 'declined') return declinedText(declined);
  if (item.status === 'failed') return 'failed';
  return `changed ${item.changes.map((c) => c.path).join(', ')}`;
}

/** One item as step log events (spec §4.6): text when an item completes, a tool call when it starts and its result when it completes. */
export function stepItemEvents(phase: 'started' | 'completed', item: ThreadItem, declined: ReadonlyMap<string, string>): NodeEventBody[] {
  switch (item.type) {
    case 'agentMessage':
      return phase === 'completed' && item.text.trim() ? [{ type: 'text', text: item.text }] : [];
    case 'reasoning': {
      const summary = item.summary.join('\n').trim();
      return phase === 'completed' && summary ? [{ type: 'text', text: `Thinking: ${summary}` }] : [];
    }
    case 'commandExecution':
      return phase === 'started'
        ? [{ type: 'tool_call', toolUseId: item.id, name: 'Bash', input: { command: item.command } }]
        : [{ type: 'tool_result', toolUseId: item.id, content: commandResult(item, declined.get(item.id)), isError: item.status !== 'completed' }];
    case 'fileChange':
      return phase === 'started'
        ? [{ type: 'tool_call', toolUseId: item.id, name: 'Patch', input: { changes: toPatchChanges(item.changes) } }]
        : [{ type: 'tool_result', toolUseId: item.id, content: patchResult(item, declined.get(item.id)), isError: item.status !== 'completed' }];
    case 'dynamicToolCall':
      return phase === 'started'
        ? [{ type: 'tool_call', toolUseId: item.id, name: item.tool, input: item.arguments }]
        : [{ type: 'tool_result', toolUseId: item.id, content: contentText(item.contentItems), isError: item.success === false || item.status === 'failed' }];
    default:
      return [];
  }
}

/** One agent step = one ephemeral Codex thread with one turn, every action through the step's gate (spec §4.6). */
export function codexRunStep(deps: CodexRunDeps) {
  return async (ctx: NodeContext, gate: ToolGate): Promise<NodeOutcome> => {
    const codexPath = deps.codexPath();
    if (!codexPath) return { ok: false, output: '', error: deps.missing() };
    ctx.emit({ type: 'start', kind: 'agent', cwd: ctx.cwd, prompt: ctx.prompt });
    const readOnly = !isWriteCapable(ctx.node);
    const tools = readOnly ? [] : toLoopTools(ctx.graphTools ?? [], STEP_GRAPH_TOOL_PREFIX);
    /** Aborted when the step ends or Codex exits: approval cards still open are withdrawn (R18). */
    const ended = new AbortController();
    const fileChanges = new Map<string, FileUpdateChange[]>();
    const declined = new Map<string, string>();
    let conn: CodexConnection | undefined;
    let usage: NodeUsage | undefined;
    const cancelled = (): NodeOutcome => ({ ok: false, output: '', error: 'cancelled', ...(usage && { usage }) });
    try {
      if (ctx.signal.aborted) return cancelled();
      conn = await openCodex({ codexPath, spawn: deps.spawn, env: deps.env, log: deps.log });
      conn.onExit(() => ended.abort());
      conn.onServerRequest(
        createServerRequestHandler({
          gate,
          cwd: ctx.cwd,
          platform: deps.platform,
          tools: new Map(tools.map((t) => [t.spec.name, t])),
          signal: AbortSignal.any([ctx.signal, ended.signal]),
          fileChanges,
          onDeclined: (itemId, reason) => declined.set(itemId, reason),
          note: (text) => ctx.emit({ type: 'text', text }),
        }),
      );
      const start: ThreadStartParams = {
        cwd: ctx.cwd,
        approvalPolicy: 'untrusted',
        sandbox: readOnly ? 'read-only' : 'workspace-write',
        ephemeral: true,
        developerInstructions: stepPreamble(ctx.cwd),
        ...(ctx.model && { model: ctx.model }),
        ...(tools.length > 0 && { dynamicTools: dynamicToolSpecs(tools) }),
      };
      const thread = await conn.request<ThreadResponse>('thread/start', start, ctx.signal);
      const outcome = await runCodexTurn({
        conn,
        threadId: thread.thread.id,
        text: ctx.prompt,
        effort: codexEffort(ctx, deps.knownModels(), deps.warnOnce),
        signal: ctx.signal,
        onItem: (phase, item) => {
          // Recorded before Codex's approval request for it arrives: notifications are handled in order (R14).
          if (phase === 'started' && item.type === 'fileChange') fileChanges.set(item.id, item.changes);
          for (const e of stepItemEvents(phase, item, declined)) ctx.emit(e);
        },
        onRetry: (text) => ctx.emit({ type: 'text', text }),
        interruptWaitMs: deps.interruptWaitMs,
      });
      usage = outcome.usage;
      if (outcome.status === 'cancelled') return cancelled();
      if (outcome.status === 'completed') return { ok: true, output: outcome.lastText, ...(usage && { usage }) };
      return { ok: false, output: outcome.lastText, error: outcome.error, ...(usage && { usage }) };
    } catch (e) {
      if (ctx.signal.aborted) return cancelled();
      return { ok: false, output: '', error: errorMessage(e) };
    } finally {
      ended.abort();
      conn?.close();
    }
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -w engine -- test/codexRunStep.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck`
Expected: no errors.

```bash
git add engine/src/providers/codex/runStep.ts engine/test/codexRunStep.test.ts
git commit -m "feat(engine): agent steps on Codex, one ephemeral thread per step

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Planner turns on Codex

**Spec tests owned (§8):** Planner — new versus resumed threads, `resumeFailed`, events, graph tools, Stop, and the returned sessionId. It also pins Review Focus 5.

**Files:**
- Create: `engine/src/providers/codex/planTurn.ts`
- Test: `engine/test/codexPlanTurn.test.ts`

**Interfaces:**
- Consumes: `CodexRunDeps` (Task 8); `openCodex`, `CodexRpcError`, `errorMessage` (Task 2); `codexEffort` (Task 4); `createServerRequestHandler` (Task 6); `runCodexTurn`, `dynamicToolSpecs` (Task 7); `toLoopTools`; `PlannerTurn`, `PlannerTurnResult` (`providers/types.ts`); `createPlannerGate`.
- Produces:
  ```ts
  // engine/src/providers/codex/planTurn.ts
  export const CODEX_RESUME_FAILED = 'The earlier Codex conversation was not found.';
  export function codexPlanTurn(deps: CodexRunDeps): (turn: PlannerTurn) => Promise<PlannerTurnResult>;
  ```

- [ ] **Step 1: Write the failing tests**

Create `engine/test/codexPlanTurn.test.ts`:

```ts
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { EffortLevel } from '@agent-stream/shared';
import { createPlannerGate } from '../src/providers/toolGate';
import type { GraphTool, PlannerEvent, PlannerTurn } from '../src/providers/types';
import { codexPlanTurn, CODEX_RESUME_FAILED } from '../src/providers/codex/planTurn';
import type { CodexRunDeps } from '../src/providers/codex/runStep';
import { agentMessage, approvalParams, fakeCodex, FakeRpcError, readAction, toolCallItem, turnHandlers, waitFor, type FakeHandler, type Msg, type TurnScript } from './codexFake';

const cwd = resolve('/', 'work', 'proj');
const values = resolve('/', 'h', '.agent-stream', 'values', 'abc.json');
const zsh = (script: string) => `/bin/zsh -lc '${script}'`;

type PlanOptions = { resume?: string; model?: string; effort?: EffortLevel; signal?: AbortSignal; codexPath?: string | undefined };

function setup(handlers: Record<string, FakeHandler>, o: PlanOptions = {}) {
  const fake = fakeCodex(handlers);
  const addStep: GraphTool = { name: 'add_step', description: 'Add a step', schema: { title: z.string() }, run: vi.fn(async () => ({ text: 'Added n5.' })) };
  const events: PlannerEvent[] = [];
  const turn: PlannerTurn = {
    prompt: 'Add a test step',
    systemAppend: 'PLANNER RULES',
    cwd,
    tools: [addStep],
    ...(o.resume && { resume: o.resume }),
    ...(o.model && { model: o.model }),
    ...(o.effort && { effort: o.effort }),
    gate: createPlannerGate({ projectDir: cwd, privateFiles: [values], graphToolNames: new Set(['add_step']) }),
    transcript: { load: () => undefined, save: () => {} },
    signal: o.signal ?? new AbortController().signal,
    onEvent: (e) => events.push(e),
  };
  const deps: CodexRunDeps = {
    codexPath: () => ('codexPath' in o ? o.codexPath : '/bin/codex'),
    missing: () => 'Codex is missing.',
    spawn: fake.spawn,
    env: {},
    platform: 'linux',
    knownModels: () => undefined,
    warnOnce: () => {},
    log: () => {},
    interruptWaitMs: 50,
  };
  return { fake, events, addStep, run: () => codexPlanTurn(deps)(turn) };
}
const plan = (script: (t: TurnScript) => unknown, o: PlanOptions & { threadId?: string } = {}) => setup(turnHandlers({ script, threadId: o.threadId }), o);

describe('codexPlanTurn', () => {
  it('starts a persistent read-only thread with the planner instructions and graph tools, and returns its id', async () => {
    const p = plan(
      (t) => {
        t.item(agentMessage('Added it.'));
        t.end();
      },
      { threadId: 'thread-7' },
    );
    expect(await p.run()).toEqual({ ok: true, sessionId: 'thread-7' });
    const proc = p.fake.last();
    const start = proc.paramsOf('thread/start');
    expect(start).toMatchObject({ cwd, approvalPolicy: 'untrusted', sandbox: 'read-only', developerInstructions: 'PLANNER RULES', ephemeral: false });
    expect(start).not.toHaveProperty('model');
    expect(start.dynamicTools.map((d: { name: string }) => d.name)).toEqual(['add_step']);
    expect(proc.methods()).not.toContain('thread/resume');
    expect(proc.paramsOf('turn/start')).toMatchObject({ threadId: 'thread-7', input: [{ type: 'text', text: 'Add a test step', text_elements: [] }] });
    expect(p.events).toEqual([{ type: 'text', text: 'Added it.' }]);
    expect(proc.killed).toBe(true);
  });

  it('resumes with the safety settings sent again', async () => {
    const p = plan((t) => t.end(), { resume: 'thread-7', model: 'gpt-a', effort: 'high' });
    expect(await p.run()).toEqual({ ok: true, sessionId: 'thread-7' });
    const proc = p.fake.last();
    expect(proc.methods()).not.toContain('thread/start');
    expect(proc.paramsOf('thread/resume')).toEqual({ threadId: 'thread-7', cwd, approvalPolicy: 'untrusted', sandbox: 'read-only', developerInstructions: 'PLANNER RULES', model: 'gpt-a' });
    expect(proc.paramsOf('turn/start')).toMatchObject({ threadId: 'thread-7', effort: 'high' });
  });

  it('drops a conversation Codex no longer has (R27)', async () => {
    const p = setup({ ...turnHandlers({}), 'thread/resume': () => { throw new FakeRpcError(-32600, 'thread not found'); } }, { resume: 'thread-gone' });
    expect(await p.run()).toEqual({ ok: false, error: CODEX_RESUME_FAILED, resumeFailed: true });
    expect(p.fake.last().methods()).not.toContain('turn/start');
    expect(CODEX_RESUME_FAILED).toBe('The earlier Codex conversation was not found.');
  });

  it('shows graph tool calls and runs them through the planner gate', async () => {
    const answers: Msg[] = [];
    const p = plan(async (t) => {
      t.started(toolCallItem({ id: 'd1', tool: 'add_step', args: { title: 'Test' }, status: 'inProgress' }));
      answers.push(await t.ask('item/tool/call', { callId: 'd1', namespace: null, tool: 'add_step', arguments: { title: 'Test' } }));
      t.completed(toolCallItem({ id: 'd1', tool: 'add_step', args: { title: 'Test' }, status: 'completed', text: 'Added n5.', success: true }));
      t.end();
    });
    await p.run();
    expect(p.events).toEqual([{ type: 'tool', name: 'add_step', input: { title: 'Test' } }]);
    expect(answers[0].result).toEqual({ contentItems: [{ type: 'inputText', text: 'Added n5.' }], success: true });
    expect(p.addStep.run).toHaveBeenCalledWith({ title: 'Test' }, expect.any(AbortSignal));
  });

  it('refuses changes without asking, and lets reads run', async () => {
    const answers: Msg[] = [];
    const p = plan(async (t) => {
      answers.push(await t.ask('item/commandExecution/requestApproval', approvalParams({ command: zsh('touch x'), cwd, actions: [{ type: 'unknown', command: 'touch x' }] })));
      answers.push(await t.ask('item/commandExecution/requestApproval', approvalParams({ command: zsh('cat notes.txt'), cwd, actions: [readAction('cat notes.txt', resolve(cwd, 'notes.txt'))] })));
      answers.push(await t.ask('item/fileChange/requestApproval', { itemId: 'patch-1' }));
      t.end();
    });
    await p.run();
    expect(answers.map((a) => a.result.decision)).toEqual(['decline', 'accept', 'decline']);
  });

  it('keeps the conversation when the turn fails, showing why', async () => {
    const p = plan((t) => t.end('failed', 'rate limited'));
    expect(await p.run()).toEqual({ ok: true, sessionId: 'thread-1', error: 'Codex failed: rate limited' });
    const exits = plan((t) => void t.proc.exit(1));
    expect(await exits.run()).toEqual({ ok: true, sessionId: 'thread-1', error: 'Codex stopped unexpectedly (exit 1).' });
  });

  it('Stop interrupts the turn and keeps the conversation', async () => {
    const ac = new AbortController();
    const p = plan((t) => t.item(agentMessage('Thinking about it.')), { signal: ac.signal });
    const result = p.run();
    await waitFor(() => p.events.length === 1);
    ac.abort();
    expect(await result).toEqual({ ok: true, sessionId: 'thread-1', error: 'cancelled' });
    expect(p.fake.last().methods()).toContain('turn/interrupt');
  });

  it('Stop before a thread exists returns cancelled; while resuming it keeps the conversation (R24)', async () => {
    const hang = () => new Promise(() => {});
    const ac1 = new AbortController();
    const fresh = setup({ ...turnHandlers({}), 'thread/start': hang }, { signal: ac1.signal });
    const r1 = fresh.run();
    await waitFor(() => fresh.fake.procs.length === 1 && fresh.fake.last().methods().includes('thread/start'));
    ac1.abort();
    expect(await r1).toEqual({ ok: false, error: 'cancelled' });
    const ac2 = new AbortController();
    const resumed = setup({ ...turnHandlers({}), 'thread/resume': hang }, { resume: 'thread-7', signal: ac2.signal });
    const r2 = resumed.run();
    await waitFor(() => resumed.fake.procs.length === 1 && resumed.fake.last().methods().includes('thread/resume'));
    ac2.abort();
    expect(await r2).toEqual({ ok: true, sessionId: 'thread-7', error: 'cancelled' });
  });

  it("doesn't start Codex without a path", async () => {
    const p = setup(turnHandlers({}), { codexPath: undefined });
    expect(await p.run()).toEqual({ ok: false, error: 'Codex is missing.' });
    expect(p.fake.procs).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w engine -- test/codexPlanTurn.test.ts`
Expected: FAIL with "Failed to load url ../src/providers/codex/planTurn".

- [ ] **Step 3: Write the implementation**

Create `engine/src/providers/codex/planTurn.ts`:

```ts
import { toLoopTools } from '../../agentLoop/graphLoopTools';
import type { PlannerTurn, PlannerTurnResult } from '../types';
import { createServerRequestHandler } from './approvals';
import { CodexRpcError, errorMessage, openCodex, type CodexConnection } from './connection';
import { codexEffort } from './models';
import type { ThreadResponse, ThreadResumeParams, ThreadStartParams } from './protocol';
import type { CodexRunDeps } from './runStep';
import { dynamicToolSpecs, runCodexTurn } from './turn';

export const CODEX_RESUME_FAILED = 'The earlier Codex conversation was not found.';

/**
 * One planner turn (spec §4.7): one persistent Codex thread per planner conversation, whose id is the planner's
 * sessionId. Read-only sandbox, graph tools as dynamic tools, every request through the planner gate, which never asks.
 */
export function codexPlanTurn(deps: CodexRunDeps) {
  return async (turn: PlannerTurn): Promise<PlannerTurnResult> => {
    const codexPath = deps.codexPath();
    if (!codexPath) return { ok: false, error: deps.missing() };
    const tools = toLoopTools(turn.tools, '');
    const graphToolNames = new Set(turn.tools.map((t) => t.name));
    const ended = new AbortController();
    let conn: CodexConnection | undefined;
    let threadId: string | undefined;
    /** Stopped: a conversation that exists is kept, so "continue" works (R24). */
    const stopped = (): PlannerTurnResult => {
      const id = threadId ?? turn.resume;
      return id ? { ok: true, sessionId: id, error: 'cancelled' } : { ok: false, error: 'cancelled' };
    };
    try {
      if (turn.signal.aborted) return stopped();
      conn = await openCodex({ codexPath, spawn: deps.spawn, env: deps.env, log: deps.log });
      conn.onExit(() => ended.abort());
      conn.onServerRequest(
        createServerRequestHandler({
          gate: turn.gate,
          cwd: turn.cwd,
          platform: deps.platform,
          tools: new Map(tools.map((t) => [t.spec.name, t])),
          signal: AbortSignal.any([turn.signal, ended.signal]),
          fileChanges: new Map(),
          onDeclined: () => {},
          note: (text) => deps.log(`[agent-stream] ${text}`),
        }),
      );
      // Sent on resume too, so a resumed thread can't fall back to the user's own Codex settings (R10).
      const settings = {
        cwd: turn.cwd,
        approvalPolicy: 'untrusted',
        sandbox: 'read-only',
        developerInstructions: turn.systemAppend,
        ...(turn.model && { model: turn.model }),
      } satisfies ThreadStartParams;
      if (turn.resume) {
        const resume: ThreadResumeParams = { threadId: turn.resume, ...settings };
        try {
          await conn.request<ThreadResponse>('thread/resume', resume, turn.signal);
        } catch (e) {
          // Codex answered with an error: the thread is gone or refused (R27).
          if (e instanceof CodexRpcError) return { ok: false, error: CODEX_RESUME_FAILED, resumeFailed: true };
          throw e;
        }
        threadId = turn.resume;
      } else {
        const start: ThreadStartParams = { ...settings, ephemeral: false, dynamicTools: dynamicToolSpecs(tools) };
        threadId = (await conn.request<ThreadResponse>('thread/start', start, turn.signal)).thread.id;
      }
      const outcome = await runCodexTurn({
        conn,
        threadId,
        text: turn.prompt,
        effort: codexEffort(turn, deps.knownModels(), deps.warnOnce),
        signal: turn.signal,
        onItem: (phase, item) => {
          if (phase === 'completed' && item.type === 'agentMessage' && item.text.trim()) turn.onEvent({ type: 'text', text: item.text });
          else if (phase === 'started' && item.type === 'dynamicToolCall' && graphToolNames.has(item.tool)) turn.onEvent({ type: 'tool', name: item.tool, input: item.arguments });
        },
        // Not a chat line: it would be saved as the planner's answer (R30).
        onRetry: (text) => deps.log(`[agent-stream] ${text}`),
        interruptWaitMs: deps.interruptWaitMs,
      });
      if (outcome.status === 'cancelled') return stopped();
      return outcome.status === 'completed' ? { ok: true, sessionId: threadId } : { ok: true, sessionId: threadId, error: outcome.error };
    } catch (e) {
      if (turn.signal.aborted) return stopped();
      // The turn started: the conversation is kept and the error shown.
      if (threadId) return { ok: true, sessionId: threadId, error: errorMessage(e) };
      return { ok: false, error: errorMessage(e) };
    } finally {
      ended.abort();
      conn?.close();
    }
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -w engine -- test/codexPlanTurn.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck`
Expected: no errors.

```bash
git add engine/src/providers/codex/planTurn.ts engine/test/codexPlanTurn.test.ts
git commit -m "feat(engine): planner turns on Codex, one persistent thread per conversation

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: The Codex provider and its wiring

**Spec tests owned (§8):** the `codex` provider id in schemas and settings; the `codexPath` setting reaching `findCodex`. Also §4.3's status cached per R5, and the model list per §4.4.

**Files:**
- Create: `engine/src/providers/codex/index.ts`
- Modify: `shared/src/types.ts` (`ProviderId`, `PROVIDER_IDS`, `PROVIDER_NAMES`)
- Modify: `engine/src/sessionStore.ts` (`provider: z.enum(PROVIDER_IDS)`, R23)
- Modify: `engine/src/index.ts` (exports)
- Modify: `extension/src/settings.ts` (`Settings.codexPath`)
- Modify: `extension/src/engines.ts` (`providerFor('codex')`, `EngineManagerDeps.findCodex`)
- Test: `engine/test/codexProvider.test.ts` (create); `shared/test/models.test.ts`, `engine/test/sessionStore.test.ts`, `engine/test/index.test.ts`, `extension/test/settings.test.ts`, `extension/test/engines.test.ts`, `extension/test/providerRegistry.test.ts` (append)
- Mechanical: `codexPath: ''` in the `Settings` literals of `extension/test/commands.test.ts`, `engines.test.ts`, `parallelTickets.test.ts`, `runCommands.test.ts`, and in the first `toEqual` of `settings.test.ts`.

**Interfaces:**
- Consumes: `findCodex`, `readCodexStatus`, `CODEX_MISSING` (Task 3); `openCodex`, `SpawnCodex` (Task 2); `createModelList`, `fetchCodexModels` (Task 4); `codexRunStep`, `CodexRunDeps` (Task 8); `codexPlanTurn` (Task 9); `Found` (`platform.ts`); `AgentProvider` (`providers/types.ts`).
- Produces:
  ```ts
  // shared/src/types.ts
  export type ProviderId = 'claude' | 'copilot' | 'codex';
  export const PROVIDER_IDS: readonly ProviderId[]; // ['claude', 'copilot', 'codex']
  export const PROVIDER_NAMES: Record<ProviderId, string>; // codex: 'OpenAI Codex'
  // engine/src/providers/codex/index.ts
  export type CodexProviderDeps = { findCodex: () => Found; spawn?: SpawnCodex; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; log?: (message: string) => void; interruptWaitMs?: number };
  export function createCodexProvider(d: CodexProviderDeps): AgentProvider; // id 'codex', name 'OpenAI Codex'
  // engine/src/index.ts adds: createCodexProvider, CodexProviderDeps, findCodex, CODEX_MISSING
  // extension/src/settings.ts
  export type Settings = { claudePath: string; codexPath: string; gitBashPath: string; /* …unchanged */ };
  // extension/src/engines.ts
  export type EngineManagerDeps = { /* …unchanged */ findCodex?: typeof realFindCodex };
  ```

- [ ] **Step 1: Write the failing tests**

Create `engine/test/codexProvider.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { emptyGraph, type GraphNode, type NodeEventBody } from '@agent-stream/shared';
import type { NodeContext } from '../src/executors';
import type { Found } from '../src/platform';
import { createCodexProvider } from '../src/providers/codex';
import { CODEX_MISSING } from '../src/providers/codex/auth';
import type { Model } from '../src/providers/codex/protocol';
import { agentMessage, fakeCodex, turnHandlers, type FakeHandler } from './codexFake';
import { allowAll } from './helpers';

const gptA: Model = {
  id: 'gpt-a',
  model: 'gpt-a',
  displayName: 'GPT A',
  description: '',
  hidden: false,
  supportedReasoningEfforts: [{ reasoningEffort: 'low', description: '' }],
  defaultReasoningEffort: 'low',
  isDefault: true,
};
const signedIn: Record<string, FakeHandler> = {
  'account/read': () => ({ account: { type: 'chatgpt', email: null, planType: 'plus' }, requiresOpenaiAuth: true }),
  'model/list': () => ({ data: [gptA], nextCursor: null }),
  ...turnHandlers({
    script: (t) => {
      t.item(agentMessage('Done.'));
      t.end();
    },
  }),
};

function provider(found: Found, handlers: Record<string, FakeHandler> = signedIn) {
  const fake = fakeCodex(handlers);
  const findCodex = vi.fn(() => found);
  const log = vi.fn();
  const p = createCodexProvider({ findCodex, spawn: fake.spawn, env: {}, platform: 'linux', log });
  return { p, fake, findCodex, log };
}

function ctx(o: { model?: string; effort?: 'low' | 'ultra' } = {}): NodeContext {
  const events: NodeEventBody[] = [];
  const node: GraphNode = { id: 'n1', title: 'Step', kind: 'agent', prompt: 'p', createdBy: 'user', updatedBy: 'user', updatedAt: 't' };
  return { runId: 'r1', graph: emptyGraph('g', 'G', 't'), node, prompt: 'Do it', cwd: '/w', signal: new AbortController().signal, emit: (e) => events.push(e), ...o };
}

describe('createCodexProvider', () => {
  it('is OpenAI Codex', () => {
    const { p } = provider({ ok: true, path: '/bin/codex' });
    expect(p.id).toBe('codex');
    expect(p.name).toBe('OpenAI Codex');
  });

  it('reports a missing Codex without starting anything, and refuses steps with the reason (R6)', async () => {
    const { p, fake } = provider({ ok: false, error: CODEX_MISSING });
    expect(await p.runStep(ctx(), allowAll)).toEqual({ ok: false, output: '', error: 'Agent Stream has not checked for Codex yet.' });
    expect(await p.status()).toEqual({ provider: 'codex', ok: false, label: 'Codex: not found', error: CODEX_MISSING });
    expect(await p.runStep(ctx(), allowAll)).toEqual({ ok: false, output: '', error: CODEX_MISSING });
    expect(await p.listModels?.()).toEqual([]);
    expect(fake.procs).toHaveLength(0);
  });

  it('reads the sign-in with the Codex it found, again on every check, sharing a check in flight (R5)', async () => {
    const { p, fake, findCodex } = provider({ ok: true, path: '/bin/codex' });
    expect(await p.status()).toEqual({ provider: 'codex', ok: true, label: 'Codex (Plus)', detail: 'Signed in with ChatGPT.' });
    expect(fake.last().codexPath).toBe('/bin/codex');
    await Promise.all([p.status(), p.status()]);
    expect(fake.procs).toHaveLength(2);
    await p.status();
    expect(fake.procs).toHaveLength(3);
    expect(findCodex).toHaveBeenCalledTimes(3);
    expect(fake.procs.every((proc) => proc.killed)).toBe(true);
  });

  it('lists the models with the Codex it found, once', async () => {
    const { p, fake } = provider({ ok: true, path: '/bin/codex' });
    expect(await p.listModels?.()).toEqual([]);
    expect(fake.procs).toHaveLength(0);
    await p.status();
    const models = [{ value: 'gpt-a', label: 'GPT A', efforts: ['low'], isDefault: true }];
    expect(await p.listModels?.()).toEqual(models);
    expect(await p.listModels?.()).toEqual(models);
    expect(p.knownModels?.()).toEqual(models);
    expect(fake.procs).toHaveLength(2);
  });

  it('runs steps on the found Codex, dropping an effort the listed model lacks with one warning', async () => {
    const { p, fake, log } = provider({ ok: true, path: '/bin/codex' });
    await p.status();
    await p.listModels?.();
    expect(await p.runStep(ctx({ model: 'gpt-a', effort: 'ultra' }), allowAll)).toEqual({ ok: true, output: 'Done.' });
    expect(await p.runStep(ctx({ model: 'gpt-a', effort: 'ultra' }), allowAll)).toEqual({ ok: true, output: 'Done.' });
    expect(fake.last().paramsOf('turn/start')).not.toHaveProperty('effort');
    expect(log.mock.calls.filter(([m]) => String(m).includes('no "ultra" effort level'))).toHaveLength(1);
  });
});
```

In `shared/test/models.test.ts`, change the types import to:

```ts
import { EFFORT_LEVELS, PROVIDER_IDS, PROVIDER_NAMES, type ModelChoice } from '../src/types';
```

and append:

```ts
describe('the codex provider id', () => {
  it('is a provider with its display name, and honours effort', () => {
    expect(PROVIDER_IDS).toEqual(['claude', 'copilot', 'codex']);
    expect(PROVIDER_NAMES.codex).toBe('OpenAI Codex');
    expect(supportsEffort('codex')).toBe(true);
    expect(modelLine({ provider: 'codex', effort: 'ultra' })).toBe('Model: Default · Effort: ultra');
  });
});
```

In `engine/test/sessionStore.test.ts`, inside `describe('SessionStore', …)`, append:

```ts
  it('keeps a Codex conversation across a reload (R23)', () => {
    const { paths, store } = setup();
    const a = store.create('A');
    store.setPlannerState(a.id, 'g1', { sessionId: 'thread-1', provider: 'codex', opCursor: 2 });
    expect(new SessionStore(paths, fixedClock()).plannerState(a.id, 'g1')).toEqual({ sessionId: 'thread-1', provider: 'codex', opCursor: 2 });
  });
```

In `engine/test/index.test.ts`, append inside `describe('engine public API', …)`:

```ts
  it('exports the Codex provider and its finder', () => {
    expect(typeof engine.createCodexProvider).toBe('function');
    expect(typeof engine.findCodex).toBe('function');
    expect(engine.CODEX_MISSING).toContain('agentStream.codexPath');
  });
```

In `extension/test/settings.test.ts`, add `codexPath: '', ` after `claudePath: '/opt/claude', ` in the first test's `toEqual`, then append inside `describe('readSettings', …)`:

```ts
  it('reads agentStream.codexPath, trimmed', () => {
    const values: Record<string, unknown> = { codexPath: '  /opt/codex ' };
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({ get: (key: string, fallback: unknown) => values[key] ?? fallback } as never);
    expect(readSettings().codexPath).toBe('/opt/codex');
    values.codexPath = undefined;
    expect(readSettings().codexPath).toBe('');
  });
```

In `extension/test/engines.test.ts`, make the mechanical change below, then append:

```ts
describe('the Codex provider', () => {
  it('finds Codex with agentStream.codexPath and reports its status', async () => {
    const findCodex = vi.fn((): Found => ({ ok: false, error: 'no codex here' }));
    const manager = new EngineManager({ ...baseDeps(), settings: () => ({ ...defaults, provider: 'codex', codexPath: '/tools/codex' }), findCodex });
    expect(manager.providerFor('codex').name).toBe('OpenAI Codex');
    expect(await manager.checkProvider()).toEqual({ provider: 'codex', ok: false, label: 'Codex: not found', error: 'no codex here' });
    expect(findCodex).toHaveBeenCalledWith(expect.objectContaining({ platform: 'darwin', env: {}, setting: '/tools/codex' }));
  });
});
```

In `extension/test/providerRegistry.test.ts`, append:

```ts
describe('parseProviderSetting and Codex', () => {
  it('accepts codex', () => {
    expect(parseProviderSetting('codex')).toEqual({ id: 'codex' });
  });
});
```

The file already imports `describe`, `expect`, `it` and `parseProviderSetting`.

**Mechanical change.** `Settings` gains a required `codexPath`, so every `Settings` literal in the extension tests needs it. In each of these, replace `claudePath: '', gitBashPath` with `claudePath: '', codexPath: '', gitBashPath`:
- `extension/test/commands.test.ts` line 23;
- `extension/test/engines.test.ts` lines 17, 37 and 174;
- `extension/test/parallelTickets.test.ts` line 69;
- `extension/test/runCommands.test.ts` line 22.

A portable way to do all of them:

```bash
node -e "const fs=require('fs');for(const f of process.argv.slice(1)){fs.writeFileSync(f,fs.readFileSync(f,'utf8').replaceAll(\"claudePath: '', gitBashPath\",\"claudePath: '', codexPath: '', gitBashPath\"))}" extension/test/commands.test.ts extension/test/engines.test.ts extension/test/parallelTickets.test.ts extension/test/runCommands.test.ts
```

Check with `rg -n "claudePath: ''" extension/test`: every match is followed by `codexPath: ''`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w engine -- test/codexProvider.test.ts test/sessionStore.test.ts test/index.test.ts && npm test -w shared -- test/models.test.ts && npm test -w extension -- test/settings.test.ts test/engines.test.ts test/providerRegistry.test.ts`
Expected: FAIL. `../src/providers/codex` has no index, `PROVIDER_IDS` has no `codex`, the session store drops the Codex provider, and the extension has no `codexPath`.

- [ ] **Step 3: Add the provider id**

In `shared/src/types.ts`, replace the provider lines:

```ts
export type ProviderId = 'claude' | 'copilot' | 'codex';
export const PROVIDER_IDS: readonly ProviderId[] = ['claude', 'copilot', 'codex'];
```

and:

```ts
/** Display names, for places that only have a ProviderId (run records). */
export const PROVIDER_NAMES: Record<ProviderId, string> = { claude: 'Claude', copilot: 'GitHub Copilot', codex: 'OpenAI Codex' };
```

`supportsEffort` (`shared/src/format.ts`) is already true for every provider but Copilot.

In `engine/src/sessionStore.ts`, add `PROVIDER_IDS` to the `@agent-stream/shared` import and replace the planner `provider` field:

```ts
      provider: z.enum(PROVIDER_IDS).optional(),
```

- [ ] **Step 4: Write the provider**

Create `engine/src/providers/codex/index.ts`:

```ts
import { PROVIDER_NAMES, type ProviderStatus } from '@agent-stream/shared';
import type { Found } from '../../platform';
import type { AgentProvider } from '../types';
import { readCodexStatus } from './auth';
import { openCodex, type SpawnCodex } from './connection';
import { createModelList, fetchCodexModels } from './models';
import { codexPlanTurn } from './planTurn';
import { codexRunStep, type CodexRunDeps } from './runStep';

export type CodexProviderDeps = {
  findCodex: () => Found;
  /** Tests substitute the fake app-server; default: the real `codex app-server`. */
  spawn?: SpawnCodex;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** Where problems worth a line go (a model list that failed, an effort dropped). Default: console.warn. */
  log?: (message: string) => void;
  interruptWaitMs?: number;
};

/**
 * OpenAI Codex on the user's ChatGPT subscription, through their own `codex app-server` (spec §3, §4). Every
 * ChatGPT-only rule lives in auth.ts and connection.ts; every approval goes through the ToolGate.
 */
export function createCodexProvider(d: CodexProviderDeps): AgentProvider {
  let path: string | undefined;
  let missing = 'Agent Stream has not checked for Codex yet.';
  const log = d.log ?? ((message: string) => console.warn(message));
  const warned = new Set<string>();
  const warnOnce = (key: string, message: string) => {
    if (warned.has(key)) return;
    warned.add(key);
    log(message);
  };
  const models = createModelList(async () => {
    const codexPath = path;
    if (!codexPath) return [];
    const conn = await openCodex({ codexPath, spawn: d.spawn, env: d.env, log });
    try {
      return await fetchCodexModels(conn);
    } finally {
      conn.close();
    }
  }, log);
  /** Checked again on every call (startup, a setting change, Check again, Select Provider); callers at once share one check (R5). */
  let checking: Promise<ProviderStatus> | undefined;
  async function check(): Promise<ProviderStatus> {
    const found = d.findCodex();
    if (!found.ok) {
      path = undefined;
      missing = found.error;
      return { provider: 'codex', ok: false, label: 'Codex: not found', error: found.error };
    }
    path = found.path;
    return { provider: 'codex', ...(await readCodexStatus({ codexPath: found.path, spawn: d.spawn, env: d.env })) };
  }
  const shared: CodexRunDeps = {
    codexPath: () => path,
    missing: () => missing,
    spawn: d.spawn,
    env: d.env,
    platform: d.platform ?? process.platform,
    knownModels: () => models.known(),
    warnOnce,
    log,
    interruptWaitMs: d.interruptWaitMs,
  };
  return {
    id: 'codex',
    name: PROVIDER_NAMES.codex,
    status() {
      checking ??= check().finally(() => (checking = undefined));
      return checking;
    },
    runStep: codexRunStep(shared),
    planTurn: codexPlanTurn(shared),
    knownModels: () => models.known(),
    listModels: (o) => (path ? models.list(o) : Promise.resolve([])),
  };
}
```

In `engine/src/index.ts`, after the Claude provider exports, add:

```ts
export { createCodexProvider, type CodexProviderDeps } from './providers/codex';
export { CODEX_MISSING, findCodex } from './providers/codex/auth';
```

- [ ] **Step 5: Wire it into the extension**

In `extension/src/settings.ts`, add the field to `Settings` (after `claudePath`):

```ts
  /** agentStream.codexPath: the Codex CLI's full path, or '' to find it. */
  codexPath: string;
```

and to `readSettings()`'s object (after `claudePath`):

```ts
    codexPath: String(config.get('codexPath', '') ?? '').trim(),
```

In `extension/src/engines.ts`, add `createCodexProvider` and `findCodex as realFindCodex` to the `@agent-stream/engine` import, add to `EngineManagerDeps` (after `findClaude`):

```ts
  findCodex?: typeof realFindCodex;
```

and add the entry to `providerFor`'s `build` record (after `copilot`):

```ts
        codex: () =>
          createCodexProvider({
            // Found per status check, so a changed agentStream.codexPath is used from the next check on.
            findCodex: () => (d.findCodex ?? realFindCodex)({ platform: d.platform, env: d.env, home: d.home, setting: d.settings().codexPath }),
            env: d.env,
            platform: d.platform,
          }),
```

`EngineManagerDeps.env` is the extension host's `process.env`, which `openCodex` sanitizes (spec §4.2, R25).

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm test -w engine && npm test -w shared && npm test -w extension`
Expected: PASS.

- [ ] **Step 7: Typecheck and commit**

Run: `npm run typecheck`
Expected: no errors. (`engines.ts`'s `Record<ProviderId, …>` now needs and has a `codex` entry; Select Provider lists `PROVIDER_IDS`, so it offers OpenAI Codex.)

```bash
git add shared/src/types.ts engine/src/sessionStore.ts engine/src/providers/codex/index.ts engine/src/index.ts extension/src/settings.ts extension/src/engines.ts engine/test/codexProvider.test.ts shared/test/models.test.ts engine/test/sessionStore.test.ts engine/test/index.test.ts extension/test/settings.test.ts extension/test/engines.test.ts extension/test/providerRegistry.test.ts extension/test/commands.test.ts extension/test/parallelTickets.test.ts extension/test/runCommands.test.ts
git commit -m "feat: OpenAI Codex as a provider, found through agentStream.codexPath

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Settings manifest, Select Provider, status bar, and the integration check

**Spec tests owned (§8):** Select Provider listing Codex; the status bar label; the `codex` provider and `codexPath` in the settings manifest.

**Files:**
- Modify: `extension/package.json` (description, keywords, `agentStream.provider`, `agentStream.codexPath`, `agentStream.model` description)
- Modify: `extension/src/settings.ts` (`affectsProvider`)
- Modify: `extension/src/extension.ts` (re-check on `agentStream.codexPath`)
- Modify: `extension/test/integration/suite.cjs` (the Codex check, R20)
- Test: `extension/test/settings.test.ts`, `extension/test/selectProvider.test.ts`, `extension/test/statusBar.test.ts` (append)

**Interfaces:**
- Consumes: `Settings.codexPath`, `providerFor('codex')` (Task 10); `selectProvider`, `statusBarText` (unchanged).
- Produces:
  ```ts
  // extension/src/settings.ts
  export const PROVIDER_SETTINGS: readonly string[]; // agentStream.provider, .claudePath, .codexPath
  export function affectsProvider(e: { affectsConfiguration(section: string): boolean }): boolean;
  ```

- [ ] **Step 1: Write the failing tests**

In `extension/test/settings.test.ts`, change the settings import to:

```ts
import { affectsProvider, readSettings } from '../src/settings';
```

and append:

```ts
describe('the Codex settings', () => {
  it('declares OpenAI Codex as a provider, and its path setting', () => {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    const props = manifest.contributes.configuration.properties;
    expect(props['agentStream.provider'].enum).toEqual(['claude', 'copilot', 'codex']);
    expect(props['agentStream.provider'].enumDescriptions).toHaveLength(3);
    expect(props['agentStream.provider'].enumDescriptions[2]).toBe('OpenAI Codex: your ChatGPT subscription through the Codex CLI.');
    expect(props['agentStream.codexPath']).toMatchObject({ type: 'string', default: '' });
    expect(manifest.description).toContain('OpenAI Codex');
  });

  it('re-checks the provider when the provider or a CLI path changes, not for other settings', () => {
    const changed = (...keys: string[]) => ({ affectsConfiguration: (section: string) => keys.includes(section) });
    expect(affectsProvider(changed('agentStream.codexPath'))).toBe(true);
    expect(affectsProvider(changed('agentStream.claudePath'))).toBe(true);
    expect(affectsProvider(changed('agentStream.provider'))).toBe(true);
    expect(affectsProvider(changed('agentStream.model', 'agentStream.effort'))).toBe(false);
  });
});
```

In `extension/test/selectProvider.test.ts`, append:

```ts
describe('selectProvider with OpenAI Codex', () => {
  const codex = {
    id: 'codex' as const,
    name: 'OpenAI Codex',
    status: async (): Promise<ProviderStatus> => ({ provider: 'codex', ok: false, label: 'Codex: not signed in', error: 'Run codex login in a terminal and sign in with ChatGPT.' }),
  };

  it('lists Codex with its status, and writes it when picked', async () => {
    const pick = vi.fn(async (items: { id: string }[]) => items.find((i) => i.id === 'codex'));
    const write = vi.fn(async () => {});
    await selectProvider({ providers: [claude, copilot, codex], current: () => 'claude', pick, write, recheck: vi.fn(async () => {}) } as never);
    expect(pick.mock.calls[0][0][2]).toEqual({ id: 'codex', label: 'OpenAI Codex', description: 'Codex: not signed in', detail: 'Run codex login in a terminal and sign in with ChatGPT.' });
    expect(write).toHaveBeenCalledWith('codex');
  });
});
```

In `extension/test/statusBar.test.ts`, inside `describe('statusBarText', …)`, append:

```ts
  it('shows Codex with its plan, and why it cannot run', () => {
    expect(statusBarText({ provider: 'codex', ok: true, label: 'Codex (Plus)', detail: 'Signed in with ChatGPT.' })).toEqual({
      text: '$(check) Codex (Plus)',
      tooltip: 'Agent Stream runs on Codex (Plus) (Signed in with ChatGPT.).',
    });
    expect(statusBarText({ provider: 'codex', ok: false, label: 'Codex: API key', error: 'Agent Stream uses your ChatGPT subscription for Codex.' })).toEqual({
      text: '$(warning) Agent Stream: Codex: API key',
      tooltip: 'Agent Stream uses your ChatGPT subscription for Codex.',
    });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w extension -- test/settings.test.ts test/selectProvider.test.ts test/statusBar.test.ts`
Expected: FAIL. `affectsProvider` is not exported, and the manifest has no `codex` provider or `codexPath`. (The Select Provider and status bar tests may already pass: those modules need no change. They pin the behaviour.)

- [ ] **Step 3: Write the implementation**

In `extension/src/settings.ts`, append:

```ts
/** The settings that pick the provider or say where its CLI is: changing one re-checks the provider. */
export const PROVIDER_SETTINGS: readonly string[] = ['agentStream.provider', 'agentStream.claudePath', 'agentStream.codexPath'];

export function affectsProvider(e: { affectsConfiguration(section: string): boolean }): boolean {
  return PROVIDER_SETTINGS.some((section) => e.affectsConfiguration(section));
}
```

In `extension/src/extension.ts`, change the settings import to:

```ts
import { affectsProvider, readSettings } from './settings';
```

and in the `onDidChangeConfiguration` handler replace the first condition:

```ts
      if (affectsProvider(e)) void manager.checkProvider();
```

In `extension/package.json`:
- `description`: `"Co-create a workflow graph with an AI planner and run it step by step on your own AI subscription: Claude, GitHub Copilot or OpenAI Codex."`
- `keywords`: `["ai", "agent", "workflow", "planner", "claude", "copilot", "codex", "openai"]`
- replace `agentStream.provider`'s `enum` and `enumDescriptions`:

```json
          "enum": ["claude", "copilot", "codex"],
          "default": "claude",
          "enumDescriptions": [
            "Claude: your Claude subscription through Claude Code.",
            "GitHub Copilot: your Copilot plan through VS Code's Language Model API.",
            "OpenAI Codex: your ChatGPT subscription through the Codex CLI."
          ],
```

- add after `agentStream.claudePath`:

```json
        "agentStream.codexPath": {
          "type": "string",
          "default": "",
          "description": "Full path to the Codex CLI (codex, or codex.exe or codex.cmd on Windows). Leave empty to find it automatically. OpenAI Codex provider only."
        },
```

- in `agentStream.model`'s description, replace `(Claude Code's default; Auto on Copilot)` with `(Claude Code's default; Auto on Copilot; Codex's default model on Codex)`.

- [ ] **Step 4: Add the Codex check to the integration suite**

In `extension/test/integration/suite.cjs`, directly after the line that waits for `'the Claude status again'`, add:

```js
  // OpenAI Codex is selectable. agentStream.codexPath points at a file that doesn't exist, so no real Codex starts,
  // even on a machine that has one (R20): its status says so, and a run is refused with that reason.
  const noCodex = path.join(os.tmpdir(), `agent-stream-no-codex-${crypto.randomUUID()}`, process.platform === 'win32' ? 'codex.exe' : 'codex');
  await config().update('codexPath', noCodex, vscode.ConfigurationTarget.Global);
  await config().update('provider', 'codex', vscode.ConfigurationTarget.Global);
  await waitFor(() => api.engines.status.provider === 'codex' && api.engines.status.label !== 'checking', 'the Codex status');
  assert.equal(api.engines.status.label, 'Codex: not found');
  assert.equal(api.engines.status.error, `agentStream.codexPath points to ${noCodex}, which doesn't exist or can't be run.`);
  {
    const probe = [];
    const probeClient = { send: (m) => probe.push(m) };
    const detachProbe = app.connect(probeClient);
    await app.handle(probeClient, { type: 'startRun', graphId: 'demo', reviewed: 'x' });
    assert.equal(probe.find((m) => m.type === 'error').message, `Runs are disabled: ${api.engines.status.error}`);
    detachProbe();
  }
  await config().update('provider', undefined, vscode.ConfigurationTarget.Global);
  await config().update('codexPath', undefined, vscode.ConfigurationTarget.Global);
  await waitFor(() => api.engines.status.provider === 'claude' && api.engines.status.label !== 'checking', 'the Claude status after Codex');
```

The integration run itself is Task 13's full verification.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -w extension`
Expected: PASS.

- [ ] **Step 6: Typecheck and commit**

Run: `npm run typecheck`
Expected: no errors.

```bash
git add extension/package.json extension/src/settings.ts extension/src/extension.ts extension/test/integration/suite.cjs extension/test/settings.test.ts extension/test/selectProvider.test.ts extension/test/statusBar.test.ts
git commit -m "feat(extension): select OpenAI Codex, set agentStream.codexPath, re-check when it changes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: The `Patch` approval card, its notifications, and the usage line

**Spec tests owned (§8):** the `Patch` approval card rendering paths and diffs. Also R11's usage wording and R29's notification text.

**Files:**
- Modify: `web/src/approvalView.ts` (the `Patch` layout, `patchLineClass`)
- Modify: `web/src/components/ApprovalCard.tsx` (diff blocks line by line)
- Modify: `web/src/styles.css` (`.patch-add`, `.patch-del`)
- Modify: `shared/src/format.ts` (`approvalSummary`, `approvalSentence` for `Patch`)
- Modify: `web/src/components/LogView.tsx`, `engine/src/runReport.ts` (no `~$0.00` without a cost)
- Test: `web/test/approvalView.test.ts`, `web/test/ApprovalCard.test.ts`, `web/test/LogsPanel.test.ts`, `shared/test/format.test.ts`, `engine/test/runReport.test.ts` (append)

**Interfaces:**
- Consumes: the `Patch` gate input `{ description?: string; changes: PatchChange[] }` (Task 6), with `PatchChange = { path; kind: 'add' | 'update' | 'delete'; diff; movePath? }`; `PROVIDER_NAMES.codex` (Task 10).
- Produces:
  ```ts
  // web/src/approvalView.ts
  export type ApprovalBlock = { label: string; text: string; tone?: 'add' | 'del'; diff?: boolean };
  export function patchLineClass(line: string): 'patch-add' | 'patch-del' | 'patch-line';
  ```

- [ ] **Step 1: Write the failing tests**

In `web/test/approvalView.test.ts`, change the import to:

```ts
import { describeApprovalInput, patchLineClass } from '../src/approvalView';
```

and append:

```ts
describe('describeApprovalInput for a Codex Patch', () => {
  it('lays out each file with what happens to it, and its diff', () => {
    const input = {
      description: 'Fix the bug',
      changes: [
        { path: 'src/a.ts', kind: 'update', diff: '@@ -1 +1 @@\n-old\n+new' },
        { path: 'src/b.ts', kind: 'add', diff: 'hello' },
        { path: 'src/c.ts', kind: 'delete', diff: 'bye' },
        { path: 'src/d.ts', kind: 'update', diff: '', movePath: 'src/e.ts' },
      ],
    };
    expect(describeApprovalInput('Patch', input)).toEqual({
      primary: [
        { label: 'Description', text: 'Fix the bug' },
        { label: 'Update src/a.ts', text: '@@ -1 +1 @@\n-old\n+new', diff: true },
        { label: 'Add src/b.ts', text: 'hello', tone: 'add' },
        { label: 'Delete src/c.ts', text: 'bye', tone: 'del' },
        { label: 'Update src/d.ts → src/e.ts', text: '', diff: true },
      ],
      warnings: [],
    });
  });

  it('keeps other keys visible, and shows a Patch it cannot read as its full JSON', () => {
    expect(describeApprovalInput('Patch', { changes: [{ path: 'a', kind: 'add', diff: 'x' }], extra: 1 }).rest).toBe(json({ extra: 1 }));
    for (const input of [{ changes: [] }, { changes: [{ path: 'a', kind: 'rename', diff: '' }] }, { changes: 'a' }, { changes: [{ path: 'a', kind: 'add', diff: 'x' }], description: 3 }]) {
      expect(describeApprovalInput('Patch', input)).toEqual({ primary: [], warnings: [], rest: json(input) });
    }
  });

  it('marks added and removed diff lines, leaving headers and context plain', () => {
    expect(patchLineClass('+new')).toBe('patch-add');
    expect(patchLineClass('-old')).toBe('patch-del');
    expect(patchLineClass('+++ b/a.ts')).toBe('patch-line');
    expect(patchLineClass('--- a/a.ts')).toBe('patch-line');
    expect(patchLineClass('@@ -1 +1 @@')).toBe('patch-line');
    expect(patchLineClass(' same')).toBe('patch-line');
  });
});
```

In `web/test/ApprovalCard.test.ts`, inside `describe('ApprovalCard', …)`, append:

```ts
  it('shows a Patch as each file and its diff, with added and removed lines marked', async () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    const input = { changes: [{ path: 'src/a.ts', kind: 'update', diff: '@@ -1 +1 @@\n-old\n+new' }] };
    await act(async () => root.render(createElement(ApprovalCard, { request: { ...request('a3', ''), toolName: 'Patch', input } })));
    const card = container.querySelector('.approval-card') as HTMLElement;
    expect(card.querySelector('.approval-label')!.textContent).toBe('Update src/a.ts');
    expect([...card.querySelectorAll('.patch-add')].map((e) => e.textContent)).toEqual(['+new']);
    expect([...card.querySelectorAll('.patch-del')].map((e) => e.textContent)).toEqual(['-old']);
    expect(card.querySelector('.diff-block')!.textContent).toContain('@@ -1 +1 @@');
    await act(async () => root.unmount());
  });
```

In `web/test/LogsPanel.test.ts`, append inside the `describe` that holds the Copilot usage test:

```ts
  it('shows tokens but no API-equivalent cost for a step that reports no cost (Codex)', async () => {
    await act(async () => dispatch({ kind: 'selectNode', id: 'n2' }));
    const usage = { inputTokens: 300, outputTokens: 50, cacheReadTokens: 600, cacheWriteTokens: 100, costUsd: 0, turns: 1 };
    await act(async () => server({ type: 'nodeLogs', runId: run.id, nodeId: 'n2', events: [{ at: '2026-10-02T10:00:00Z', type: 'result', ok: true, durationMs: 1200, usage }] }));
    expect(text()).toContain('· 1000 in / 50 out tokens · 1 turns');
    expect(text()).not.toContain('API-equivalent');
  });
```

In `shared/test/format.test.ts`, inside `describe('approval text', …)`, append:

```ts
  it("names the files a Codex Patch would change (R29)", () => {
    const input = { changes: [{ path: 'a.ts', kind: 'update', diff: '' }, { path: 'b.ts', kind: 'add', diff: '' }] };
    expect(approvalSummary('Patch', input)).toBe('Patch: a.ts, b.ts');
    expect(approvalSentence(request('Patch', input))).toBe('n2 Build new wants to change a.ts, b.ts');
    const many = { changes: ['a', 'b', 'c', 'd', 'e'].map((p) => ({ path: `${p}.ts`, kind: 'update', diff: '' })) };
    expect(approvalSummary('Patch', many)).toBe('Patch: a.ts, b.ts, c.ts and 2 more');
    expect(approvalSummary('Patch', {})).toBe('Patch');
    expect(approvalSentence(request('Patch', {}))).toBe('n2 Build new wants to use Patch');
  });
```

In `engine/test/runReport.test.ts`, inside `describe('buildRunReport', …)`, append:

```ts
  it('leaves out the API-equivalent cost when a provider reports tokens but no cost (Codex)', () => {
    const { input } = fixture();
    const usage = { inputTokens: 300, outputTokens: 50, cacheReadTokens: 600, cacheWriteTokens: 100, costUsd: 0, turns: 1 };
    const md = buildRunReport({ ...input, run: { ...run, provider: 'codex', nodes: { ...run.nodes, n1: { ...run.nodes.n1, usage } } } });
    expect(md).toContain('- Provider: OpenAI Codex');
    expect(md).toContain('**Usage:** 1000 in / 50 out tokens · 1 turns');
    expect(md).not.toContain('API-equivalent');
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w web -- test/approvalView.test.ts test/ApprovalCard.test.ts test/LogsPanel.test.ts && npm test -w shared -- test/format.test.ts && npm test -w engine -- test/runReport.test.ts`
Expected: FAIL. `patchLineClass` doesn't exist, a Patch shows as JSON, the log and report say `~$0.00 API-equivalent`, and the summary says `Patch`.

- [ ] **Step 3: Write the `Patch` layout**

In `web/src/approvalView.ts`, replace the `ApprovalBlock` type:

```ts
/** `diff`: a unified diff, shown line by line with added and removed lines marked (patchLineClass). */
export type ApprovalBlock = { label: string; text: string; tone?: 'add' | 'del'; diff?: boolean };
```

Add, after the `json` helper:

```ts
const PATCH_VERBS: Record<string, string> = { add: 'Add', update: 'Update', delete: 'Delete' };
type PatchChangeInput = { path: string; kind: string; diff: string; movePath?: string };
const isPatchChange = (c: unknown): c is PatchChangeInput => {
  if (typeof c !== 'object' || c === null) return false;
  const r = c as Record<string, unknown>;
  return typeof r.path === 'string' && typeof r.kind === 'string' && r.kind in PATCH_VERBS && typeof r.diff === 'string' && (r.movePath === undefined || typeof r.movePath === 'string');
};

/** How a line of a unified diff is shown: added, removed, or as it is (the +++ and --- headers stay plain). */
export function patchLineClass(line: string): 'patch-add' | 'patch-del' | 'patch-line' {
  if (line.startsWith('+') && !line.startsWith('+++')) return 'patch-add';
  if (line.startsWith('-') && !line.startsWith('---')) return 'patch-del';
  return 'patch-line';
}

/** Codex's file changes (spec §5): each file with what happens to it; an update's diff line by line, added or deleted text whole. */
function describePatch(record: Record<string, unknown>, full: ApprovalView): ApprovalView {
  const { changes, description, ...rest } = record;
  if (!Array.isArray(changes) || changes.length === 0 || !changes.every(isPatchChange)) return full;
  if (description !== undefined && typeof description !== 'string') return full;
  const primary: ApprovalBlock[] = typeof description === 'string' ? [{ label: 'Description', text: description }] : [];
  for (const c of changes) {
    const label = `${PATCH_VERBS[c.kind]} ${c.path}${c.movePath ? ` → ${c.movePath}` : ''}`;
    primary.push(c.kind === 'update' ? { label, text: c.diff, diff: true } : { label, text: c.diff, tone: c.kind === 'add' ? 'add' : 'del' });
  }
  const view: ApprovalView = { primary, warnings: [] };
  if (Object.keys(rest).length) view.rest = json(rest);
  return view;
}
```

Replace the first lines of `describeApprovalInput` (up to and including the `if (!fields || …) return full;` line) with:

```ts
export function describeApprovalInput(toolName: string, input: unknown): ApprovalView {
  const full: ApprovalView = { primary: [], warnings: [], rest: json(input) };
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return full;
  if (toolName === 'Patch') return describePatch(input as Record<string, unknown>, full);
  const fields = LAYOUTS[toolName];
  if (!fields) return full;
```

The rest of the function is unchanged.

In `web/src/components/ApprovalCard.tsx`, change the import to:

```ts
import { describeApprovalInput, patchLineClass } from '../approvalView';
```

and replace the `view.primary.map(…)` block with:

```tsx
      {!a.graphChange && view.primary.map((b, i) => (
        <div key={`${i}:${b.label}`}>
          <div className="approval-label">{b.label}</div>
          {b.diff ? (
            <pre className="diff-block">
              {b.text.split('\n').map((line, j) => (
                <div key={j} className={patchLineClass(line)}>
                  {line || ' '}
                </div>
              ))}
            </pre>
          ) : (
            <pre className={b.tone ? `diff ${b.tone}` : 'mono'}>{b.text}</pre>
          )}
        </div>
      ))}
```

In `web/src/styles.css`, after the `.diff.add` rule, add:

```css
.patch-add { background: var(--vscode-diffEditor-insertedTextBackground, rgba(46, 125, 50, 0.2)); }
.patch-del { background: var(--vscode-diffEditor-removedTextBackground, rgba(180, 35, 24, 0.18)); }
```

- [ ] **Step 4: Name a Patch's files in notifications and the Approvals view (R29)**

In `shared/src/format.ts`, after the `fieldsOf` helper, add:

```ts
/** A Patch's file paths, or undefined when its input names none. */
const patchPaths = (input: unknown): string[] | undefined => {
  const changes = fieldsOf(input).changes;
  if (!Array.isArray(changes)) return undefined;
  const paths = changes.flatMap((c) => (typeof c === 'object' && c !== null && typeof (c as { path?: unknown }).path === 'string' ? [(c as { path: string }).path] : []));
  return paths.length ? paths : undefined;
};
const listPaths = (paths: string[]) => (paths.length <= 3 ? paths.join(', ') : `${paths.slice(0, 3).join(', ')} and ${paths.length - 3} more`);
```

In `approvalSummary`, before `return toolName;`, add:

```ts
  const patched = toolName === 'Patch' ? patchPaths(input) : undefined;
  if (patched) return `Patch: ${listPaths(patched)}`;
```

In `approvalSentence`, before the final `return`, add:

```ts
  const patched = a.toolName === 'Patch' ? patchPaths(a.input) : undefined;
  if (patched) return `${who} wants to change ${listPaths(patched)}`;
```

- [ ] **Step 5: Show the API-equivalent cost only when there is one (R11)**

In `web/src/components/LogView.tsx`, replace the `usage` constant in the `'result'` case with:

```tsx
      const usage = !u
        ? ''
        : counted
          ? ` · ${u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens} in / ${u.outputTokens} out tokens · ${u.turns} turns${u.costUsd > 0 ? ` · ~$${u.costUsd.toFixed(2)} API-equivalent` : ''}`
          : ` · ${u.turns} turns`;
```

and change the comment above `counted` to `// A provider that reports no tokens or cost (Copilot) shows only its request count; one that reports no cost (Codex), no cost.`

In `engine/src/runReport.ts`, replace `usageLine`:

```ts
/** The step log's usage wording: tokens, and the cost when one is reported; only the turns when a provider reports no tokens (Copilot). */
function usageLine(u: NodeUsage): string {
  const counted = u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens > 0 || u.costUsd > 0;
  if (!counted) return `${u.turns} turns`;
  const cost = u.costUsd > 0 ? ` · ~$${u.costUsd.toFixed(2)} API-equivalent` : '';
  return `${u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens} in / ${u.outputTokens} out tokens · ${u.turns} turns${cost}`;
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm test -w web && npm test -w shared && npm test -w engine -- test/runReport.test.ts`
Expected: PASS (the existing Claude usage assertion, `~$0.12 API-equivalent`, still holds).

- [ ] **Step 7: Typecheck and commit**

Run: `npm run typecheck`
Expected: no errors.

```bash
git add web/src/approvalView.ts web/src/components/ApprovalCard.tsx web/src/styles.css shared/src/format.ts web/src/components/LogView.tsx engine/src/runReport.ts web/test/approvalView.test.ts web/test/ApprovalCard.test.ts web/test/LogsPanel.test.ts shared/test/format.test.ts engine/test/runReport.test.ts
git commit -m "feat(web): the Patch approval card with its diff, and no API-equivalent cost without a cost

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: Docs, the Windows checklist, and the full verification

**Spec tests owned (§8):** the manual check before release, written down as Windows checklist steps (§8 "Manual"); §5 Docs.

**Files:**
- Modify: `README.md`, `extension/README.md` (the same edits in both: the sections below read the same in each file)
- Modify: `docs/windows-checklist.md`

**Interfaces:**
- Consumes: the user-facing strings fixed in the Global Constraints and Tasks 3, 6, 8, 11.
- Produces: documentation only.

- [ ] **Step 1: Update both READMEs**

Make each edit below in `README.md` and in `extension/README.md`.

1. The disclaimer line: replace `It is not made, endorsed or supported by Anthropic or GitHub.` with `It is not made, endorsed or supported by Anthropic, GitHub or OpenAI.`
2. The intro sentence: replace `That is **Claude** (your Claude subscription through Claude Code) or **GitHub Copilot** (your Copilot plan through VS Code's Language Model API).` with `That is **Claude** (your Claude subscription through Claude Code), **GitHub Copilot** (your Copilot plan through VS Code's Language Model API) or **OpenAI Codex** (your ChatGPT subscription through the Codex CLI).`
3. Under **Requirements › One provider**, after the GitHub Copilot line, add:

```markdown
  - **OpenAI Codex:** the Codex CLI installed (from https://developers.openai.com/codex) and signed in with ChatGPT (run `codex login` in a terminal and choose ChatGPT). An API-key sign-in is refused.
```

4. In the **Model and effort** bullet and in the `agentStream.model` setting, replace `(Claude Code's default; Auto on Copilot)` with `(Claude Code's default; Auto on Copilot; Codex's default model on Codex)`. In the same bullet, replace `else of Claude Code's default model)` with `else of the provider's default model)`.
5. In the **Status bar** bullet, replace ``(for example `Claude Max` or `Copilot`)`` with ``(for example `Claude Max`, `Copilot` or `Codex (Plus)`)``.
6. Under **Settings**, replace the `agentStream.provider` and `agentStream.effort` lines, and add `agentStream.codexPath` after `agentStream.claudePath`:

```markdown
- `agentStream.provider` — `claude` (default), `copilot` or `codex`.
- `agentStream.codexPath` — OpenAI Codex provider only. The Codex CLI's full path (`codex`, or `codex.exe` / `codex.cmd` on Windows) if it isn't found automatically.
- `agentStream.effort` — the effort level for the same: `low`, `medium`, `high`, `xhigh`, `max` or `ultra`. Empty (default): the model's own level. A level the model doesn't offer is left out.
```

7. Under **Providers**, after the whole **GitHub Copilot** subsection (before `## Files it writes`), add:

```markdown
### OpenAI Codex

Agent Stream runs agent steps and the planner on your ChatGPT subscription through your installed Codex CLI (`codex app-server`). It never reads or stores your credentials.

- **What you need:** the Codex CLI, and `codex login` in a terminal, signed in with ChatGPT. If Agent Stream can't find Codex, set `agentStream.codexPath`.
- **What it refuses:** an API-key sign-in. Agent Stream starts Codex with `forced_login_method="chatgpt"` and removes `OPENAI_API_KEY`, `CODEX_API_KEY` and `OPENAI_BASE_URL` from its environment. If Codex still reports an API-key account, the status bar shows `Codex: API key` and runs are refused until you run `codex logout`, then `codex login` and choose ChatGPT.
- **Status:** the status bar shows `Codex (<plan>)`, for example `Codex (Plus)`.
- **Models and effort:** the Model menus list the models Codex offers on your plan. **Default** runs Codex's own default model. The Effort menu offers the levels the model supports, up to `ultra` on some models.
- **Approvals:** Codex asks Agent Stream before every command and file change, and each approval covers that one action only.
  - Commands that only read, such as `cat`, `ls`, `head` or `rg`, run without asking, like Claude's Read, Grep and Glob. Anything else asks: writes, other programs, and commands with shell operators such as `|`, `;`, `>` or `$`.
  - File changes show a **Patch** card with each file, what happens to it (add, update or delete) and its diff.
  - Codex's requests for extra permissions are declined, and the step's log says so.
- **Read-only steps** run in Codex's read-only sandbox. Anything that isn't a plain read is declined without asking.
- **Privacy:** reads of the variable values file and of `.agent-stream/runs` and `.agent-stream/sessions` are declined without asking (a step may read its upstream `output.md`).
- **Request cap:** none. Codex runs its own loop; a step is bounded by your plan and by Stop. Each step's log shows its tokens. Codex reports no cost, so no API-equivalent cost is shown.
- **Planner chat:** each conversation is a Codex thread, so it continues after a VS Code reload. **New chat** starts a new thread.
- **Windows:** not verified yet. When npm installed Codex, Agent Stream runs `codex.cmd` through `cmd.exe`. How Codex wraps commands on Windows isn't known yet, so plain reads may ask for approval there.
```

- [ ] **Step 2: Add the Codex steps to the Windows checklist**

In `docs/windows-checklist.md`, insert before the final line (`Report anything that differs, …`):

```markdown
**OpenAI Codex.** Install the Codex CLI and run `codex login`, choosing ChatGPT. Use a Git repository you can change. Select OpenAI Codex with **Agent Stream: Select Provider**.

30. **Status.** The status bar shows `Codex (<your plan>)`. If it shows `Agent Stream: Codex: not found`, set `agentStream.codexPath` to the path `where codex` prints, and check that the status updates without a reload.
31. **Two-step graph.** Make a graph with an agent step "Add a line `hello` to notes.txt and a line `bye` to other.txt" (Can edit files), followed by a read-only agent step "Read notes.txt and report what it says". Run it.
    - The first step shows an approval card for each change (Patch or Bash). Approve the change to notes.txt and deny the other. notes.txt changes, other.txt doesn't, and the log shows `declined: Denied by the user.` for the denied one.
    - The second step reads notes.txt and reports it. No card offers to change anything. Note whether the read asked for approval: on Windows it may.
32. **Privacy.** Ask an agent step to run `type .agent-stream\runs\<a run id>\run.json`, or `cat` it. The log shows `declined:` with a privacy reason, or an approval card you deny. The file's contents never appear.
33. **Stop.** Ask an agent step to run `ping -n 600 127.0.0.1`, approve it, then press Stop. The step is cancelled, and Task Manager shows no `codex.exe` or `node.exe` left from it.
34. **Planner chat.** Ask the planner to add a step; it appears on the canvas. Ask for another and press Stop mid-turn: the chat shows `Stopped.` Reload the window (**Developer: Reload Window**) and ask a follow-up: the planner answers with the earlier conversation in mind.
35. **Effort.** Pick a model that offers `ultra` with **Agent Stream: Select Model**, choose `ultra`, and run a step. The run dialog's Model line shows that model and `Effort: ultra`, and the step runs.
```

- [ ] **Step 3: Commit the docs**

```bash
git add README.md extension/README.md docs/windows-checklist.md
git commit -m "docs: OpenAI Codex provider, agentStream.codexPath, ultra effort, Windows checklist steps

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 4: Full verification**

Run each from the repo root, without `AGENT_STREAM_LIVE` set:

```bash
npm test
npm run typecheck
npm run build
npm run test:integration -w extension
```

Expected: every command exits 0. `npm test` runs the shared, engine, web and extension suites; the live tests skip themselves. No test spawns a real `codex`: every Codex test uses `fakeCodex`. The integration run prints its suite passing, with the Copilot and Codex statuses settled (`Codex: not found`, from the missing `agentStream.codexPath`).

Then check what's left:

```bash
git status --short
rg -n "realSpawnCodex" engine/test extension/test
rg -n "@openai|codex-sdk" package.json engine/package.json extension/package.json
```

Expected:
- `git status --short` shows only the untracked `logs/` and `.DS_Store` (and the untracked plan, if it isn't committed yet).
- Neither search finds anything: no test uses the real spawn, and no Codex SDK was added.

Don't push, and don't run `npm run package`.

---

## Self-review (done while writing this plan)

**1. Spec coverage.** Each spec section maps to a task:

| Spec | Task |
|---|---|
| §1 purpose: ChatGPT subscription through the user's `codex`; approvals, read-only steps, privacy, a run keeps its provider | 3, 6, 8, 9, 10 (a run keeps its provider: unchanged App behaviour, provider chosen at run start) |
| §2 verified facts (handshake, sign-in, models, approvals, dynamic tools, events, reads in the folder ask, resume keeps tools) | 2, 3, 4, 5–7, 9 (R10) |
| §3 decisions: approach A, id and name, auth, steps, planner, models, effort, no cap, path setting | 2, 10, 3, 8, 9, 4, 1+4, 13 (docs), 10+11 |
| §4.1 protocol types | 2 |
| §4.2 connection (process, env, handshake, framing, exit, stderr tail, Windows .cmd) | 2 |
| §4.3 finding Codex and status (each row) | 3, 10 (R5, R6) |
| §4.4 models, cache, Default's efforts | 1 (R8), 4, 10 |
| §4.5 approval mapping, read-only commands, private paths, `acceptForSession` never, read-only steps | 5, 6 |
| §4.6 steps (start, turn, events, finish, Stop, close) | 7, 8 |
| §4.7 planner (new, resume, events, result, Stop) | 7, 9 |
| §5 shared types, settings, registry, approval card, Select Provider, docs | 1, 10, 11, 12, 13 |
| §6 privacy | 5, 6 (R26) |
| §7 error table | not installed / not signed in / API key (3, 10); start failure and exit (2, 8, 9); Codex error notification (7); model refused (7: an error answer or failed turn becomes `Codex failed: …`); Stop (7, 8, 9); unknown server request (2, 6) |
| §8 tests | named under "Spec tests owned" in every task; the fake app-server is Task 2 |
| §8 manual | 13 (Windows checklist steps 30–35; run the same steps on macOS before release) |
| §9 out of scope | nothing implemented: no sign-in flow, MCP, cloud tasks, request caps or rate-limit display |

**2. Placeholder scan.** Every code step contains its code, and every test step its test code. No step says "add tests", "handle errors" or "similar to Task N" without the code.

**3. Type consistency.** Names used in more than one task are spelled the same everywhere:
- `CodexConnection`, `CodexProcess`, `SpawnCodex`, `openCodex`, `CodexRpcError`, `CodexExitError`, `errorMessage`, `UNSUPPORTED_REQUEST`, `CODEX_ARGS` (2, 3, 4, 6–10);
- `fakeCodex`, `FakeProc`, `FakeRpcError`, `FakeHandler`, `Msg`, `turnHandlers`, `TurnScript`, `agentMessage`, `reasoning`, `commandItem`, `fileChangeItem`, `toolCallItem`, `readAction`, `approvalParams`, `waitFor` (2–10);
- `findCodex`, `CODEX_MISSING`, `readCodexStatus`, `CodexStatus` (3, 10);
- `toModelChoice`, `fetchCodexModels`, `createModelList`, `ModelList`, `codexEffort` (4, 8–10);
- `privateFolderDenial`, `pathPrivacy`, `classifyCommand`, `CommandClass`, `shellWords` (5, 6);
- `createServerRequestHandler`, `ApprovalContext` (`gate`, `cwd`, `platform`, `tools`, `signal`, `fileChanges`, `onDeclined`, `note`), `toPatchChanges`, `PatchChange` (6, 8, 9, 12);
- `runCodexTurn`, `RunTurnOptions`, `TurnOutcome`, `dynamicToolSpecs`, `usageOf`, `codexFailure`, `INTERRUPT_WAIT_MS` (7–9);
- `CodexRunDeps`, `codexRunStep`, `stepItemEvents`, `stepPreamble` (8–10);
- `codexPlanTurn`, `CODEX_RESUME_FAILED` (9, 10);
- `createCodexProvider`, `CodexProviderDeps` (10);
- `Settings.codexPath`, `EngineManagerDeps.findCodex`, `affectsProvider`, `PROVIDER_SETTINGS` (10, 11);
- `ModelChoice.isDefault`, `EffortLevel` `'ultra'` (1, 4, 10); `ProviderId` `'codex'`, `PROVIDER_NAMES.codex` (10, 12);
- `ApprovalBlock.diff`, `patchLineClass` (12).

**4. Review Focus.** Each of the five has a test in its owning task: 1, 2 and 3 in Task 5 (`codexReadOnly.test.ts`), 4 in Task 8 (`codexRunStep.test.ts`), and 5 in Task 9 (`codexPlanTurn.test.ts`).

**5. Dry run.** The code and tests of Tasks 1–12 were applied, as written here, to a scratch copy of the repo at 6f4e7de (outside this checkout). `npm run typecheck`, the shared, engine, web and extension test suites, and `npm run build` all passed; the Codex test files passed five runs in a row. The integration run and the manual Windows steps were not part of that dry run.
