# Agent Stream — a Working GitHub Copilot Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** With GitHub Copilot selected, agent steps and planner turns run on the user's Copilot plan through VS Code's Language Model API, with the same approvals, read-only rules and privacy checks as Claude, a per-step and per-turn request cap, and planner conversations that survive a reload.

**Architecture:**
- **Engine (VS Code-free).** A provider-neutral agent loop in `engine/src/agentLoop/`:
  - `chatModel.ts`: the `ChatModel` interface, the message types and `ChatModelError`;
  - `glob.ts`: `globToRegExp`;
  - `tools.ts`: our own `Read`, `Grep`, `Glob`, `Edit`, `Write` and `Bash`, with Claude's names and input shapes;
  - `graphLoopTools.ts`: graph tools as loop tools;
  - `loop.ts`: `runAgentLoop`;
  - `compact.ts`: history compaction.
  `engine/src/shell.ts` takes the spawn/timeout/kill logic out of the command executor, so `Bash` and command steps share it. `engine/src/transcripts.ts` stores planner transcripts per session, and `PlannerTurn` gains `transcript`.
- **Extension.** `extension/src/providers/copilotModel.ts` adapts a `vscode.LanguageModelChat` to `ChatModel`. `extension/src/providers/copilot.ts` becomes a real provider (models, status and consent, `runStep`, `planTurn`). `EngineManager` builds it with `vscode.lm`, `context.languageModelAccessInformation`, a `RunShell` and the two cap settings.
- **Web.** The run dialog shows `Copilot requests per step: up to <n>`, and its Model line names the model a step would actually run on.

**Tech Stack:** TypeScript 7 (strict, noEmit), npm workspaces (`shared`, `engine`, `web`, `extension`), Vitest 5, zod 4.6.5 (`z.toJSONSchema` and `z.prettifyError`, both verified present), React 19, esbuild, Node `child_process.spawn`, VS Code Language Model API (`vscode.lm`, `LanguageModelChat.sendRequest`, `LanguageModelError`, `LanguageModelAccessInformation`; `@types/vscode` ~1.106).

**Spec:** `docs/superpowers/specs/2026-10-03-agent-stream-copilot-provider-design.md` (committed at 9ee8cc3). It is the binding authority, and every section number below (§n) refers to it.

**Order:**
- The shell runner (Task 1).
- The engine tools (Tasks 2–4).
- The loop and compaction (Tasks 5–6).
- Planner transcripts (Task 7).
- The VS Code adapter (Task 8).
- The provider (Task 9).
- Its wiring and settings (Task 10).
- The run dialog, the docs and the full verification (Task 11).

**Planning rulings** (decided while writing this plan; each costs a small rework if wrong):
- **R1. The cap message is supplied by the caller.** `runAgentLoop` gains an optional `capMessage: string`. Its default, `` `Stopped after ${n} model requests.` ``, keeps the engine free of Copilot wording. The provider passes the §4.5 text through `copilotCapMessage(n, setting)`.
- **R2. `ChatModelError.message` is the user-facing text.** The adapter writes the §5.4 message (`copilotErrorMessage`), because it knows the model id and the provider's name. The loop returns `error: message` unchanged.
- **R3. Streamed text is joined.** `vscode.lm` streams text a few tokens at a time. The loop joins adjacent text parts of one reply into one part before recording the assistant message and calling `onText`, and skips whitespace-only text. Without this, each token would become its own log line (Review Focus 1).
- **R4. The cap check follows §4.5's order.** The tool calls of the last allowed request still run (and still ask for approval). Then the loop stops with `capped`. Their results stay in `messages`.
- **R5. Compaction never breaks the cap.** It asks for a summary only when the summary and the real request both fit: `requests + 1 < maxRequests`. Otherwise it drops older turns without a summary, so a step never makes more than `maxRequests` requests.
- **R6. The summary request carries the older turns as plain text,** in one user message (`User: …`, `Assistant: …`, `Assistant called <tool> <input>`, `Tool result: …`, each result clipped to 2,000 characters, the whole clipped to 60 % of the input limit), followed by the §4.6 prompt and no tools. Some backends reject tool-call parts in a request without tools; plain text avoids that.
- **R7. The token estimate** is `ceil((system.length + JSON.stringify(messages).length + JSON.stringify(tools).length) / 4)`.
- **R8. Truncation** keeps the first 15,000 and the last 15,000 characters, with the cut marked by the existing `truncateHead`'s note (`clipResult`).
- **R9. How results name files.** `Glob` and `Grep` show paths relative to the tool's working folder when the file is inside it, else absolute. They visit only real files and folders and don't follow symbolic links. Folder entries are walked in name order, so results are deterministic.
- **R10. Glob semantics.** A `\` in a glob is a path separator, not an escape. `Glob` matches the whole path relative to the searched folder. `Grep`'s `glob` filter matches the base name when it has no `/` or `\` (ripgrep's behaviour), else the relative path.
- **R11. Read details.**
  - Lines are numbered like `cat -n` (a 6-wide number, then a tab), and `offset` is the first 1-based line.
  - An `offset` past the end is an error.
  - An empty file reads as `(The file is empty.)`.
  - A binary file (a NUL in the first 8 KB) is refused (Review Focus 3).
- **R12. Edit details.** An empty `old_string` is refused. On a CRLF file, an `old_string` written with `\n` is matched with `\r\n` line ends (Review Focus 2).
- **R13. Bash results.** A normal exit gives the output plus `exit code N` (not a tool error). A timeout, Stop or missing Git Bash gives the output plus the reason, as a tool error.
- **R14. New chat deletes every transcript of that graph in that session, for every provider.** None of them can be resumed after New chat, so this only removes unreachable files. Removing a graph does the same in every session.
- **R15. Conversation ids** must match `/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/`. Any other id loads as missing (so the planner gets `resumeFailed`), and saving it throws. Corrupt files load as missing too (Review Focus 5).
- **R16. Copilot usage.** `NodeUsage` stays as it is. Copilot fills the token counts and cost with zeros and `turns` with its request count. The log's result line shows only `· N turns` when every token count and the cost are zero, so a Copilot step doesn't claim `~$0.00 API-equivalent`.
- **R17. Tool calling** is read structurally as `capabilities.supportsToolCalling === true`, because `@types/vscode` 1.106 doesn't declare `LanguageModelChat.capabilities`. The probe saw it at runtime (§2).
- **R18. Model list caching.** `listModels` caches only a non-empty list. An empty or failing list counts as a failure, with one retry when asked. `status()` and every step or turn re-list the models, so they refresh the cache.
- **R19. Status wording.**
  - The detail is `Models: <names>.`. While consent is unknown, the §5.2 sentence is appended after a space.
  - Refused consent gives label `Copilot not allowed`, the same detail, and the §5.4 permission message as `error`.
  - The consent check uses the model Default runs on (Auto, else the first listed).
- **R20. A model that disappeared.** The step falls back to Auto and logs `The Copilot model <id> is no longer available; using <name>.` as a `text` event. The run dialog's Model line names the model in use, through a new optional `AgentProvider.modelInUse(model)`. The status bar tooltip still names the setting (see the report: this part of §7 is only partly placed).
- **R21. The dialog's cap line.** A new optional `AgentProvider.stepRequestCap()` (Copilot: the setting) goes into the preview as `RunPreview.copilotRequestsPerStep`. The dialog shows the line when that is set and the run has agent steps.
- **R22. Step logging order.** `runStep` emits `start` first. If no Copilot model can be resolved, it fails with `COPILOT_UNAVAILABLE` and logs no request line. Otherwise it always logs `Copilot requests: <n> of <cap>` after the loop, whatever the outcome.
- **R23. `createRunShell` options** are a superset of §4.3's: they add `shell`, `killTree` and `killGraceMs`. `CommandExecutorOptions` becomes an alias of them, so the command-executor tests stay unchanged.
- **R24. The integration test** accepts any settled Copilot status. A test profile could list Copilot models, and the new status would then be `ok`. It asserts the refusal only when the status isn't `ok`, and it never sends a request.
- **R25. `planTurn` always saves the transcript** (success, error and cap), and doesn't put the model-fallback note in the chat.
- **R26. Tool error results** are sent to `vscode.lm` as plain text. `LanguageModelToolResultPart` has no error flag, and the error texts already say what failed.

## Global Constraints

- TypeScript strict everywhere. `npm run typecheck` passes after every task.
- `engine/` and `shared/` never import `vscode`. Only `extension/` does.
- No new runtime dependencies. zod 4.6.5 is already in `engine` and `shared` and provides `z.toJSONSchema` and `z.prettifyError`. Extension code and tests don't import `zod`: a test graph tool uses `schema: {}`.
- Node ≥ 20.11 (root `package.json` `engines`), so there is no `path.matchesGlob`. Globs go through `globToRegExp`.
- Windows paths:
  - Paths are built with `path.join`/`path.resolve`/`path.relative`, never with a hard-coded `/`.
  - Glob matching runs on `/`-normalised relative paths.
  - Tests build expected paths with the same functions.
  - Tests that spawn a real shell are `describe.skipIf(process.platform === 'win32')`, like `commandExecutor.test.ts`.
- **No test uses a real Copilot account or the real `vscode.lm`.** Engine tests use `fakeChatModel` (Task 5). Extension tests use `fakeLmModel` (Task 8) and the `vscode` mock in `extension/test/vscode.ts`. Every file a test writes goes in a `mkdtemp` folder.
- Existing tests keep their assertions. The exceptions are the ones the spec retires (the Copilot scaffold tests in `extension/test/copilot.test.ts`, and the preview case in `extension/test/statusBar.test.ts`), plus mechanical additions that new required fields force on test literals (`transcript` in two `PlannerTurn` helpers, and the two cap fields in `Settings` literals). Each is named in its task.
- Exact user-facing strings, verbatim from the spec:
  - Cap (§4.5): `` `Stopped after ${n} Copilot requests (agentStream.copilot.maxRequestsPerStep). Raise the setting to let steps run longer.` ``, and the same text with `maxRequestsPerTurn` for the planner.
  - Unknown tool (§4.5): `` `Unknown tool ${name}.` ``
  - Summary prompt (§4.6): `Summarise the conversation so far for yourself: decisions, files changed, open questions. Keep it under 300 words.`
  - Summary message (§4.6): `` `Summary of earlier turns: ${text}` ``
  - Drop note (§4.6): `Earlier turns were dropped to fit the model's context.`
  - Justification (§5.1): `Agent Stream runs your workflow steps on Copilot.`
  - Consent detail (§5.2): `Copilot will ask for permission the first time a run or chat uses it.`
  - Step preamble (§5.3): `` `You are an agent running one step of a workflow in ${cwd}. Use the tools to do the work; when finished, reply with a summary of what you did.` ``
  - Request line (§5.3): `` `Copilot requests: ${n} of ${cap}` ``
  - Resume failure (§5.3): `The earlier Copilot conversation was not found.`
  - Errors (§5.4):
    - `permission`: `Agent Stream isn't allowed to use Copilot. Run the step again and choose Allow, or enable it under Accounts › Manage Language Model Access.`
    - `blocked`: `` `Copilot refused the request (quota or policy): ${message}` ``
    - `notFound`: `` `The Copilot model ${id} is no longer available. Pick another model.` ``
    - `other`: `` `Copilot failed: ${message}` ``
  - Run dialog (§5.5): `` `Copilot requests per step: up to ${n}` ``
  - Status label (§5.2/§5.5): `Copilot`.
  - Kept from the scaffold, unchanged: `` COPILOT_UNAVAILABLE = "GitHub Copilot isn't available. Install the GitHub Copilot extension and sign in, or switch to Claude with Agent Stream: Select Provider." ``
- Settings (§3, §5.5): `agentStream.copilot.maxRequestsPerStep` (integer, default 25, range 1–200) and `agentStream.copilot.maxRequestsPerTurn` (integer, default 10, range 1–100). Values are clamped to the range, and a non-integer reads as the default.
- Retired (§5.5): `COPILOT_NOT_IMPLEMENTED` and `ProviderStatus.preview` are removed everywhere.
- The repo is public, so commit no personal paths, emails or machine details.
- Run every command from the repo root, on branch `feat/copilot-provider`.
  - Never push.
  - Never run `npm run package`.
  - Never run live tests: never set `AGENT_STREAM_LIVE`.
  - Don't touch the untracked `logs/` or `.DS_Store`. Stage files by name only (`git add <paths>`), never `git add -A` or `git add .`.
- Every commit message ends with a `Co-Authored-By:` trailer naming the model that wrote that commit. The commit steps below show `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; a different model writes its own name instead.

## Review Focus

These are five failure modes the spec implies but that no task's main tests would naturally exercise, most likely first. Each is pinned by a test in the task that owns the code.

1. **Streamed replies.** `vscode.lm` streams a reply as many small text parts. The step log must show one text line per reply, not one per token, and the final output must be the whole text. Pinned in Task 5: `agentLoop.test.ts` › "ends on a reply without tool calls, joining streamed text into one part".
2. **CRLF files on Windows.** `Read` shows lines without their `\r`, so the model's `old_string` uses `\n`. `Edit` must still find it in a CRLF file and keep the file's CRLF line ends, or every Copilot edit of a Windows-checked-out file fails with "not found". Pinned in Task 3: `loopTools.test.ts` › "matches an old_string written with \n in a CRLF file, keeping CRLF".
3. **Reading a binary file.** A model that `Read`s an image or a compiled file must get a short refusal, not kilobytes of mojibake in its context. Pinned in Task 2: `loopTools.test.ts` › "refuses a binary file".
4. **Compaction near the cap.** When a long history needs compacting at the last allowed request, the extra summary request must not push the step past `maxRequestsPerStep`. Pinned in Task 6: `compact.test.ts` › "never sends more than maxRequests when compaction is due at the last request".
5. **A damaged or hostile transcript reference.** A conversation id that could leave the folder (`../x`), or a transcript file that is corrupt or has the wrong shape, must read as missing. The planner then starts fresh through `resumeFailed`, and nothing crashes or writes outside `transcripts/`. Pinned in Task 7: `transcripts.test.ts` › "refuses ids that could leave the folder" and "reads a missing, unreadable or malformed file as missing".

## File map

| File | Responsibility | Task |
|---|---|---|
| `engine/src/shell.ts` | `RunShell`, `createRunShell`, `KILL_GRACE_MS` | 1 |
| `engine/src/commandExecutor.ts` | command steps on top of `createRunShell` | 1 |
| `engine/src/agentLoop/chatModel.ts` | `ChatPart`, `ChatMessage`, `ToolSpec`, `ChatModel`, `ChatModelError` | 2 |
| `engine/src/agentLoop/glob.ts` | `globToRegExp` | 2 |
| `engine/src/agentLoop/tools.ts` | `LoopTool`, `clipResult`, `toolPath`, `readOnlyTools` (2); `builtinTools`, Edit/Write/Bash (3) | 2, 3 |
| `engine/src/agentLoop/graphLoopTools.ts` | `toLoopTools` | 4 |
| `engine/src/agentLoop/loop.ts` | `runAgentLoop`, `lastAssistantText` (5); compaction call (6) | 5, 6 |
| `engine/src/agentLoop/compact.ts` | `estimateTokens`, `compactIfNeeded` | 6 |
| `engine/src/transcripts.ts` | `Transcripts` (file-backed planner transcripts) | 7 |
| `engine/src/providers/types.ts` | `TranscriptStore`, `PlannerTurn.transcript` (7); `stepRequestCap?`, `modelInUse?` (9) | 7, 9 |
| `engine/src/sessionStore.ts`, `engine/src/planner.ts` | `transcripts(id)`, clearing; the turn's store | 7 |
| `engine/src/index.ts` | exports for the extension | 5, 7 |
| `engine/src/app.ts` | preview: cap and model in use | 11 |
| `engine/test/helpers.ts` | `fakeChatModel`, parts, `allowAll`, `untilAborted` | 5 |
| `extension/test/vscode.ts` | `LanguageModel*` classes, `LanguageModelError`, `CancellationTokenSource` | 8 |
| `extension/test/helpers.ts` | `fakeLmModel` | 8 |
| `extension/src/providers/copilotModel.ts` | `vscodeChatModel`, `copilotErrorMessage`, `COPILOT_PERMISSION`, `JUSTIFICATION` | 8 |
| `extension/src/providers/copilot.ts` | the provider | 9 |
| `extension/src/settings.ts`, `extension/src/engines.ts`, `extension/src/extension.ts`, `extension/src/statusBar.ts`, `extension/package.json` | caps, wiring, consent access, status bar, manifest | 10 |
| `shared/src/types.ts` | `ProviderStatus.preview` removed (10); `RunPreview.copilotRequestsPerStep` (11) | 10, 11 |
| `web/src/App.tsx` | banner without the preview branch | 10 |
| `web/src/components/RunConfirmDialog.tsx`, `web/src/components/LogView.tsx`, `web/src/styles.css` | cap line; turns-only usage | 11 |
| `extension/test/integration/suite.cjs` | the Copilot check | 10 |
| `README.md`, `extension/README.md`, `docs/windows-checklist.md` | docs and manual steps | 11 |

---

### Task 1: The shared shell runner (`runShellCommand` extraction)

**Spec tests owned (§8):** "`runShellCommand` extraction: the existing command-executor tests still pass unchanged". It also adds the `createRunShell` half of "`Bash` through `createRunShell` (output and exit code, timeout, abort kills)"; the `Bash` half is in Task 3.

**Files:**
- Create: `engine/src/shell.ts`
- Modify: `engine/src/commandExecutor.ts` (whole file)
- Test: `engine/test/shell.test.ts` (new); `engine/test/commandExecutor.test.ts` (unchanged, must still pass)

**Interfaces:**
- Consumes: `childEnv`, `commandShell`, `killTree` from `engine/src/platform.ts`.
- Produces:
  ```ts
  // engine/src/shell.ts
  export const KILL_GRACE_MS = 5000;
  export type RunShellResult = { exitCode: number | null; output: string; error?: string };
  export type RunShell = (o: { command: string; cwd: string; signal: AbortSignal; timeoutSec: number; onChunk?: (stream: 'stdout' | 'stderr', chunk: string) => void }) => Promise<RunShellResult>;
  export type RunShellOptions = { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; gitBashPath?: string; shell?: string; killTree?: typeof killTree; killGraceMs?: number };
  export function createRunShell(options?: RunShellOptions): RunShell;
  // engine/src/commandExecutor.ts (unchanged API)
  export const DEFAULT_TIMEOUT_SEC = 1800;
  export { KILL_GRACE_MS };
  export type CommandExecutorOptions = RunShellOptions;
  export function createCommandExecutor(options?: CommandExecutorOptions): NodeExecutor;
  ```
  `error` is set only when the command didn't exit by itself: `timed out after <n> s`, `cancelled`, `killed by <signal>`, a spawn error, or `GIT_BASH_MISSING`. A non-zero exit is only `exitCode`.

- [ ] **Step 1: Write the failing test**

Create `engine/test/shell.test.ts`:

```ts
import { existsSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GIT_BASH_MISSING } from '../src/platform';
import { createRunShell } from '../src/shell';

const tmp = () => mkdtempSync(join(tmpdir(), 'shell-'));
const live = () => new AbortController().signal;
const runShell = createRunShell({ shell: '/bin/sh' });

async function waitFor(condition: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 20));
  }
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('createRunShell', () => {
  it('fails clearly on Windows without Git Bash, starting nothing', async () => {
    expect(await createRunShell({ platform: 'win32' })({ command: 'echo hi', cwd: tmp(), signal: live(), timeoutSec: 5 })).toEqual({
      exitCode: null,
      output: '',
      error: GIT_BASH_MISSING,
    });
  });
});

describe.skipIf(process.platform === 'win32')('createRunShell on macOS and Linux', () => {
  it('returns the combined output and the exit code, streaming each chunk; a non-zero exit is not an error', async () => {
    const cwd = tmp();
    const chunks: [string, string][] = [];
    const r = await runShell({ command: 'pwd; echo oops >&2; exit 3', cwd, signal: live(), timeoutSec: 5, onChunk: (stream, chunk) => chunks.push([stream, chunk]) });
    expect(r.exitCode).toBe(3);
    expect(r.error).toBeUndefined();
    expect(r.output).toContain(`${realpathSync(cwd)}\n`);
    expect(r.output).toContain('oops\n');
    expect(chunks).toContainEqual(['stderr', 'oops\n']);
  });

  it('reports a clean exit without an error', async () => {
    expect(await runShell({ command: 'echo hi', cwd: tmp(), signal: live(), timeoutSec: 5 })).toEqual({ exitCode: 0, output: 'hi\n' });
  });

  it('stops a command that runs past its timeout', async () => {
    const started = Date.now();
    const r = await runShell({ command: 'sleep 5', cwd: tmp(), signal: live(), timeoutSec: 0.3 });
    expect(r.error).toBe('timed out after 0.3 s');
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('kills the whole process group on abort, background children included', async () => {
    const cwd = tmp();
    const ac = new AbortController();
    const pending = runShell({ command: 'sleep 30 & echo $! > child.pid; wait', cwd, signal: ac.signal, timeoutSec: 60 });
    const pidFile = join(cwd, 'child.pid');
    await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim() !== '');
    const childPid = Number(readFileSync(pidFile, 'utf8'));
    ac.abort();
    expect(await pending).toMatchObject({ error: 'cancelled' });
    await waitFor(() => !alive(childPid));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w engine -- test/shell.test.ts`
Expected: FAIL with "Failed to load url ../src/shell" (the module doesn't exist).

- [ ] **Step 3: Write the implementation**

Create `engine/src/shell.ts`:

```ts
import { spawn } from 'node:child_process';
import { childEnv, commandShell, killTree } from './platform';

export const KILL_GRACE_MS = 5000;

/** `error` only when the command didn't exit by itself (timeout, Stop, a signal, or it couldn't start); a non-zero exit is just `exitCode`. */
export type RunShellResult = { exitCode: number | null; output: string; error?: string };
export type RunShell = (o: {
  command: string;
  cwd: string;
  signal: AbortSignal;
  timeoutSec: number;
  onChunk?: (stream: 'stdout' | 'stderr', chunk: string) => void;
}) => Promise<RunShellResult>;

export type RunShellOptions = {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** Windows: Git Bash (see findGitBash). */
  gitBashPath?: string;
  /** macOS/Linux: the shell to use instead of $SHELL. */
  shell?: string;
  /** Replaces the process-tree kill (tests). */
  killTree?: typeof killTree;
  /** How long Stop waits before forcing the command to settle (default KILL_GRACE_MS; tests use less). */
  killGraceMs?: number;
};

/**
 * Runs one shell command (spec §4.3): `$SHELL -lc` on macOS/Linux in its own process group, Git Bash `-lc` on
 * Windows. Stop (the signal) and the timeout end everything it started: SIGTERM, then SIGKILL after the grace
 * period (one taskkill /T /F on Windows), then it settles even if something still holds the pipes.
 */
export function createRunShell(options: RunShellOptions = {}): RunShell {
  const platform = options.platform ?? process.platform;
  const kill = options.killTree ?? killTree;
  const graceMs = options.killGraceMs ?? KILL_GRACE_MS;
  return ({ command, cwd, signal, timeoutSec, onChunk }) =>
    new Promise<RunShellResult>((resolve) => {
      const env = options.env ?? process.env;
      const spec = commandShell({ platform, env, command, shell: options.shell, gitBashPath: options.gitBashPath });
      if ('error' in spec) {
        resolve({ exitCode: null, output: '', error: spec.error });
        return;
      }

      let output = '';
      let timedOut = false;
      let cancelled = false;
      let settled = false;
      let killTimer: NodeJS.Timeout | undefined;

      const child = spawn(spec.file, spec.args, {
        cwd,
        env: { ...childEnv(env, platform), ...spec.env },
        detached: spec.detached,
        windowsHide: spec.windowsHide,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const stopTree = (sig: NodeJS.Signals) => {
        if (child.pid === undefined) return;
        // On Windows a finished launcher's PID may be stale or reused: never taskkill it.
        if (platform === 'win32' && (child.exitCode !== null || child.signalCode !== null)) return;
        kill(child.pid, { platform, signal: sig });
      };
      // 'close' waits for every process holding the pipes, and a command can leave one running
      // (or escape its process group), so after the grace period it settles anyway.
      const forceSettle = () => {
        child.stdout.destroy();
        child.stderr.destroy();
        finish({ exitCode: null, output, error: timedOut ? `timed out after ${timeoutSec} s` : 'cancelled' });
      };
      let stopped = false;
      // A timeout and a Stop can both arrive; the tree is stopped once.
      const terminate = () => {
        if (stopped) return;
        stopped = true;
        stopTree('SIGTERM');
        if (platform === 'win32') {
          // taskkill /F has already ended the tree.
          killTimer = setTimeout(forceSettle, graceMs);
        } else {
          killTimer = setTimeout(() => {
            stopTree('SIGKILL');
            killTimer = setTimeout(forceSettle, Math.min(500, graceMs));
          }, graceMs);
        }
      };

      const timer = setTimeout(() => {
        timedOut = true;
        terminate();
      }, timeoutSec * 1000);
      const onAbort = () => {
        cancelled = true;
        terminate();
      };
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();

      const finish = (result: RunShellResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        signal.removeEventListener('abort', onAbort);
        resolve(result);
      };

      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        output += chunk;
        onChunk?.('stdout', chunk);
      });
      child.stderr.on('data', (chunk: string) => {
        output += chunk;
        onChunk?.('stderr', chunk);
      });
      child.on('error', (err) => finish({ exitCode: null, output, error: err.message }));
      child.on('close', (code, sig) => {
        if (timedOut) return finish({ exitCode: code, output, error: `timed out after ${timeoutSec} s` });
        if (cancelled) return finish({ exitCode: code, output, error: 'cancelled' });
        if (sig) return finish({ exitCode: code, output, error: `killed by ${sig}` });
        finish({ exitCode: code, output });
      });
    });
}
```

Replace the whole of `engine/src/commandExecutor.ts` with:

```ts
import type { NodeExecutor } from './executors';
import { createRunShell, KILL_GRACE_MS, type RunShellOptions } from './shell';

export const DEFAULT_TIMEOUT_SEC = 1800;
export { KILL_GRACE_MS };

export type CommandExecutorOptions = RunShellOptions;

/**
 * Runs a command node (spec §8.1) through the shared shell runner: `$SHELL -lc` on macOS/Linux in its own
 * process group, Git Bash `-lc` on Windows. Stop and timeout end everything it started.
 */
export function createCommandExecutor(options: CommandExecutorOptions = {}): NodeExecutor {
  const runShell = createRunShell(options);
  return async (ctx) => {
    const command = ctx.node.command ?? '';
    ctx.emit({ type: 'start', kind: 'command', cwd: ctx.cwd, command });
    const r = await runShell({
      command,
      cwd: ctx.cwd,
      signal: ctx.signal,
      timeoutSec: ctx.node.timeoutSec ?? DEFAULT_TIMEOUT_SEC,
      onChunk: (stream, chunk) => ctx.emit(stream === 'stdout' ? { type: 'stdout', chunk } : { type: 'stderr', chunk }),
    });
    if (r.error !== undefined) return { ok: false, output: r.output, exitCode: r.exitCode, error: r.error };
    if (r.exitCode === 0) return { ok: true, output: r.output, exitCode: 0 };
    return { ok: false, output: r.output, exitCode: r.exitCode, error: `exited with code ${r.exitCode}` };
  };
}
```

- [ ] **Step 4: Run the new and the existing tests**

Run: `npm test -w engine -- test/shell.test.ts test/commandExecutor.test.ts test/windows.test.ts`
Expected: PASS. `commandExecutor.test.ts` is not edited.

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck -w engine`
Expected: no errors.

```bash
git add engine/src/shell.ts engine/src/commandExecutor.ts engine/test/shell.test.ts
git commit -m "refactor(engine): one shell runner for command steps and agent tools

createRunShell holds the spawn, timeout and process-tree kill that command
steps used; the command executor now maps its result. Its tests are unchanged.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: `ChatModel` types, `globToRegExp`, and the Read, Grep and Glob tools

**Spec tests owned (§8):**
- `Read` (line numbers, offset and limit, a missing file);
- `Glob` and `Grep` (skips, caps, binary and large files, glob filter);
- `globToRegExp` (`**`, `*`, `?`, braces, classes; Windows separators).

It also pins Review Focus 3.

**Files:**
- Create: `engine/src/agentLoop/chatModel.ts`, `engine/src/agentLoop/glob.ts`, `engine/src/agentLoop/tools.ts`
- Test: `engine/test/glob.test.ts`, `engine/test/loopTools.test.ts`

**Interfaces:**
- Consumes: `truncateHead` from `engine/src/prompt.ts`.
- Produces:
  ```ts
  // engine/src/agentLoop/chatModel.ts — exactly spec §4.1, plus:
  export type ChatModelErrorCode = 'permission' | 'blocked' | 'notFound' | 'other';
  export class ChatModelError extends Error { readonly code: ChatModelErrorCode; constructor(code: ChatModelErrorCode, message: string) }
  // engine/src/agentLoop/glob.ts
  export function globToRegExp(pattern: string): RegExp;   // anchored, over '/'-separated relative paths
  // engine/src/agentLoop/tools.ts
  export type ToolOutput = { text: string; isError?: boolean };
  export type LoopTool = { spec: ToolSpec; gateName: string; run(input: unknown, signal: AbortSignal): Promise<ToolOutput> };
  export const MAX_RESULT_CHARS = 30_000;
  export function clipResult(text: string, max?: number): string;
  export function toolPath(cwd: string, p: string): string;   // ~ → home, else path.resolve(cwd, p)
  export function readOnlyTools(cwd: string): LoopTool[];      // [Read, Grep, Glob]
  ```

- [ ] **Step 1: Write the failing glob test**

Create `engine/test/glob.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { globToRegExp } from '../src/agentLoop/glob';

const matches = (pattern: string, path: string) => globToRegExp(pattern).test(path);

describe('globToRegExp', () => {
  it('matches * and ? within one name only', () => {
    expect(matches('src/*.ts', 'src/a.ts')).toBe(true);
    expect(matches('src/*.ts', 'src/x/a.ts')).toBe(false);
    expect(matches('*.ts', 'a.tsx')).toBe(false);
    expect(matches('?.md', 'a.md')).toBe(true);
    expect(matches('?.md', 'ab.md')).toBe(false);
    expect(matches('?.md', '/.md')).toBe(false);
  });

  it('matches ** across any number of folders, including none', () => {
    expect(matches('**/*.ts', 'a.ts')).toBe(true);
    expect(matches('**/*.ts', 'src/x/y.ts')).toBe(true);
    expect(matches('docs/**/README.md', 'docs/README.md')).toBe(true);
    expect(matches('docs/**/README.md', 'docs/a/b/README.md')).toBe(true);
    expect(matches('src/**', 'src/a/b.ts')).toBe(true);
    expect(matches('**', 'anything/at/all')).toBe(true);
    expect(matches('**/*.ts', 'src/a.js')).toBe(false);
  });

  it('matches {a,b} alternatives, nested globs included', () => {
    expect(matches('*.{ts,tsx}', 'a.ts')).toBe(true);
    expect(matches('*.{ts,tsx}', 'a.tsx')).toBe(true);
    expect(matches('*.{ts,tsx}', 'a.js')).toBe(false);
    expect(matches('{src,test}/**/*.ts', 'test/x/a.ts')).toBe(true);
    expect(matches('{src/*.ts,*.md}', 'README.md')).toBe(true);
  });

  it('matches [abc] and [!abc] classes', () => {
    expect(matches('file[12].txt', 'file1.txt')).toBe(true);
    expect(matches('file[12].txt', 'file3.txt')).toBe(false);
    expect(matches('file[!12].txt', 'file3.txt')).toBe(true);
    expect(matches('file[a-c].txt', 'fileb.txt')).toBe(true);
  });

  it('treats other characters literally', () => {
    expect(matches('a.b', 'aXb')).toBe(false);
    expect(matches('a+(b).ts', 'a+(b).ts')).toBe(true);
    expect(matches('price$.txt', 'price$.txt')).toBe(true);
  });

  it('reads a backslash as a Windows separator', () => {
    expect(matches('src\\**\\*.ts', 'src/a/b.ts')).toBe(true);
    expect(matches('src\\**\\*.ts', 'src/b.ts')).toBe(true);
    expect(matches('src\\*.ts', 'src/a/b.ts')).toBe(false);
  });
});
```

- [ ] **Step 2: Write the failing tools test**

Create `engine/test/loopTools.test.ts`:

```ts
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { clipResult, readOnlyTools, toolPath, type LoopTool } from '../src/agentLoop/tools';

const signal = new AbortController().signal;

/** A temp folder holding `files` ('/'-separated relative paths). */
function project(files: Record<string, string | Buffer> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'loop-tools-'));
  for (const [rel, content] of Object.entries(files)) {
    const file = join(root, ...rel.split('/'));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  return root;
}
const find = (tools: LoopTool[], name: string) => tools.find((t) => t.spec.name === name)!;
const run = (cwd: string, name: string, input: unknown) => find(readOnlyTools(cwd), name).run(input, signal);

describe('readOnlyTools', () => {
  it('are Read, Grep and Glob, each gated under its own name, with JSON Schema inputs', () => {
    const tools = readOnlyTools(project());
    expect(tools.map((t) => t.spec.name)).toEqual(['Read', 'Grep', 'Glob']);
    expect(tools.map((t) => t.gateName)).toEqual(['Read', 'Grep', 'Glob']);
    for (const t of tools) expect(t.spec.inputSchema).toMatchObject({ type: 'object' });
  });

  it('expands ~ to the home folder and resolves anything else against the working folder', () => {
    const cwd = project();
    expect(toolPath(cwd, '~/notes.txt')).toBe(join(homedir(), 'notes.txt'));
    expect(toolPath(cwd, 'src/a.ts')).toBe(join(cwd, 'src', 'a.ts'));
  });

  it('returns a bad input as an error with the validation message', async () => {
    const r = await run(project(), 'Read', { file_path: 42 });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('file_path');
  });

  it('keeps the head and tail of a long result (30,000 characters)', async () => {
    expect(clipResult(`${'a'.repeat(10)}${'b'.repeat(10)}`, 10)).toBe('aaaaa\n…[truncated 10 chars]\nbbbbb');
    const cwd = project({ 'long.txt': Array.from({ length: 2000 }, () => 'x'.repeat(20)).join('\n') });
    const r = await run(cwd, 'Read', { file_path: 'long.txt' });
    expect(r.text.startsWith(`     1\t${'x'.repeat(20)}`)).toBe(true);
    expect(r.text).toContain('…[truncated ');
    expect(r.text.endsWith(`  2000\t${'x'.repeat(20)}`)).toBe(true);
  });
});

describe('Read', () => {
  it('numbers the lines from 1', async () => {
    const cwd = project({ 'a.txt': 'alpha\nbeta\ngamma\n' });
    expect(await run(cwd, 'Read', { file_path: 'a.txt' })).toEqual({ text: '     1\talpha\n     2\tbeta\n     3\tgamma' });
  });

  it('starts at offset and reads limit lines, by absolute path too', async () => {
    const cwd = project({ 'a.txt': 'alpha\nbeta\ngamma\n' });
    expect(await run(cwd, 'Read', { file_path: join(cwd, 'a.txt'), offset: 2, limit: 1 })).toEqual({ text: '     2\tbeta' });
    expect(await run(cwd, 'Read', { file_path: 'a.txt', offset: 10 })).toEqual({ text: 'The file has 3 lines; offset 10 is past the end.', isError: true });
  });

  it('reads 2000 lines by default and cuts a line longer than 2000 characters', async () => {
    const cwd = project({ 'many.txt': Array.from({ length: 2500 }, (_, i) => String(i + 1)).join('\n'), 'wide.txt': 'y'.repeat(2100) });
    const many = (await run(cwd, 'Read', { file_path: 'many.txt' })).text.split('\n');
    expect(many).toHaveLength(2000);
    expect(many.at(-1)).toBe('  2000\t2000');
    expect(await run(cwd, 'Read', { file_path: 'wide.txt' })).toEqual({ text: `     1\t${'y'.repeat(2000)}…` });
  });

  it('reports a missing file, a folder and an empty file', async () => {
    const cwd = project({ 'src/a.ts': '', 'empty.txt': '' });
    expect(await run(cwd, 'Read', { file_path: 'nope.txt' })).toEqual({ text: `File not found: ${join(cwd, 'nope.txt')}`, isError: true });
    expect(await run(cwd, 'Read', { file_path: 'src' })).toEqual({ text: `${join(cwd, 'src')} is a folder, not a file. Use Glob to list it.`, isError: true });
    expect(await run(cwd, 'Read', { file_path: 'empty.txt' })).toEqual({ text: '(The file is empty.)' });
  });

  it('refuses a binary file', async () => {
    const cwd = project({ 'logo.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]) });
    expect(await run(cwd, 'Read', { file_path: 'logo.png' })).toEqual({ text: `${join(cwd, 'logo.png')} is a binary file.`, isError: true });
  });
});

describe('Glob', () => {
  it('matches relative paths newest first, skipping .git, node_modules and Agent Stream runs and sessions', async () => {
    const cwd = project({
      'src/old.ts': '',
      'src/new.ts': '',
      'src/deep/mid.ts': '',
      'README.md': '',
      '.git/hooks/x.ts': '',
      'node_modules/pkg/index.ts': '',
      '.agent-stream/runs/r1/out.ts': '',
      '.agent-stream/sessions/default/s.ts': '',
      '.agent-stream/graphs/g.ts': '',
    });
    utimesSync(join(cwd, 'src', 'old.ts'), 1_000, 1_000);
    utimesSync(join(cwd, 'src', 'deep', 'mid.ts'), 2_000, 2_000);
    utimesSync(join(cwd, 'src', 'new.ts'), 3_000, 3_000);
    utimesSync(join(cwd, '.agent-stream', 'graphs', 'g.ts'), 500, 500);
    expect(await run(cwd, 'Glob', { pattern: '**/*.ts' })).toEqual({
      text: [join('src', 'new.ts'), join('src', 'deep', 'mid.ts'), join('src', 'old.ts'), join('.agent-stream', 'graphs', 'g.ts')].join('\n'),
    });
  });

  it('searches under path, still naming files relative to the working folder', async () => {
    const cwd = project({ 'src/a.ts': '', 'src/deep/b.ts': '', 'c.ts': '' });
    utimesSync(join(cwd, 'src', 'a.ts'), 1_000, 1_000);
    expect(await run(cwd, 'Glob', { pattern: '*.ts', path: 'src' })).toEqual({ text: join('src', 'a.ts') });
  });

  it('says when nothing matches or the folder is missing', async () => {
    const cwd = project({ 'a.md': '' });
    expect(await run(cwd, 'Glob', { pattern: '**/*.ts' })).toEqual({ text: 'No files found.' });
    expect(await run(cwd, 'Glob', { pattern: '*', path: 'nope' })).toEqual({ text: `Folder not found: ${join(cwd, 'nope')}`, isError: true });
  });

  it('lists at most 1000 files', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 1003; i++) files[`f/${i}.txt`] = '';
    const lines = (await run(project(files), 'Glob', { pattern: '**/*.txt' })).text.split('\n');
    expect(lines).toHaveLength(1001);
    expect(lines.at(-1)).toBe('(Showing the newest 1000 of 1003 files.)');
  });
});

describe('Grep', () => {
  it('reports file:line: text for each matching line', async () => {
    const cwd = project({ 'src/a.ts': 'const x = 1;\nexport const y = 2;\n', 'src/b.js': 'export default 3;\n', 'notes.md': 'nothing' });
    expect(await run(cwd, 'Grep', { pattern: '^export' })).toEqual({
      text: [`${join('src', 'a.ts')}:2: export const y = 2;`, `${join('src', 'b.js')}:1: export default 3;`].join('\n'),
    });
  });

  it('filters files by a name glob or a path glob', async () => {
    const cwd = project({ 'src/a.ts': 'export a', 'src/lib/b.js': 'export b', 'c.ts': 'export c' });
    expect((await run(cwd, 'Grep', { pattern: 'export', glob: '*.ts' })).text).toBe([`${join('c.ts')}:1: export c`, `${join('src', 'a.ts')}:1: export a`].join('\n'));
    expect((await run(cwd, 'Grep', { pattern: 'export', glob: 'src/**/*.js' })).text).toBe(`${join('src', 'lib', 'b.js')}:1: export b`);
  });

  it('skips binary files, files over 2 MB and the skipped folders', async () => {
    const cwd = project({
      'bin.dat': Buffer.concat([Buffer.from('export\n'), Buffer.from([0])]),
      'big.txt': `export\n${'x'.repeat(2 * 1024 * 1024)}`,
      'node_modules/m.ts': 'export',
      '.git/config': 'export',
      '.agent-stream/runs/r1/run.json': 'export',
      'ok.ts': 'export',
    });
    expect(await run(cwd, 'Grep', { pattern: 'export' })).toEqual({ text: 'ok.ts:1: export' });
  });

  it('stops after 500 matches and cuts long lines', async () => {
    const cwd = project({ 'hits.txt': Array.from({ length: 600 }, () => 'hit').join('\n'), 'wide.txt': `hot ${'z'.repeat(600)}` });
    const lines = (await run(cwd, 'Grep', { pattern: 'hit' })).text.split('\n');
    expect(lines).toHaveLength(501);
    expect(lines.at(-1)).toBe('(Stopped after 500 matches.)');
    expect((await run(cwd, 'Grep', { pattern: 'hot' })).text).toBe(`wide.txt:1: hot ${'z'.repeat(496)}…`);
  });

  it('searches one file, and reports no match, a bad pattern and a missing path', async () => {
    const cwd = project({ 'src/a.ts': 'const x = 1;\nexport const y = 2;\n' });
    expect(await run(cwd, 'Grep', { pattern: 'y', path: 'src/a.ts' })).toEqual({ text: `${join('src', 'a.ts')}:2: export const y = 2;` });
    expect(await run(cwd, 'Grep', { pattern: 'nowhere' })).toEqual({ text: 'No matches found.' });
    const bad = await run(cwd, 'Grep', { pattern: '(' });
    expect(bad.isError).toBe(true);
    expect(bad.text.startsWith('Invalid regular expression:')).toBe(true);
    expect(await run(cwd, 'Grep', { pattern: 'x', path: 'nope' })).toEqual({ text: `Not found: ${join(cwd, 'nope')}`, isError: true });
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm test -w engine -- test/glob.test.ts test/loopTools.test.ts`
Expected: FAIL with "Failed to load url ../src/agentLoop/glob" and "../src/agentLoop/tools".

- [ ] **Step 4: Write the implementation**

Create `engine/src/agentLoop/chatModel.ts`:

```ts
/** A provider-neutral chat model (spec §4.1): the agent loop talks to every model through this. */
export type ChatPart = { type: 'text'; text: string } | { type: 'toolCall'; callId: string; name: string; input: unknown };
export type ChatMessage =
  | { role: 'user'; content: Array<{ type: 'text'; text: string } | { type: 'toolResult'; callId: string; text: string; isError?: boolean }> }
  | { role: 'assistant'; content: ChatPart[] };
/** `inputSchema` is a JSON Schema object. */
export type ToolSpec = { name: string; description: string; inputSchema: object };

export interface ChatModel {
  readonly id: string;
  readonly maxInputTokens: number;
  /** Throws ChatModelError for provider errors; a cancellation surfaces as an abort. */
  send(messages: ChatMessage[], tools: ToolSpec[], signal: AbortSignal): AsyncIterable<ChatPart>;
}

export type ChatModelErrorCode = 'permission' | 'blocked' | 'notFound' | 'other';

/** A provider's refusal or failure. `message` is shown to the user as it is, so the provider writes it (spec §5.4). */
export class ChatModelError extends Error {
  constructor(
    readonly code: ChatModelErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ChatModelError';
  }
}
```

Create `engine/src/agentLoop/glob.ts`:

```ts
/**
 * A glob as an anchored regular expression over `/`-separated relative paths (spec §4.2): `**` any number of folders,
 * `*` and `?` within one name, `{a,b}` alternatives, `[abc]` / `[!abc]` classes. A `\` is a Windows separator, not an
 * escape. No `path.matchesGlob`: the engine supports Node 20.11.
 */
export function globToRegExp(pattern: string): RegExp {
  return new RegExp(`^${convert(pattern.replace(/\\/g, '/'))}$`);
}

const SPECIAL = /[.+^$()|[\]{}]/;

function convert(p: string): string {
  let out = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*') {
      if (p[i + 1] === '*') {
        const atStart = i === 0 || p[i - 1] === '/';
        if (atStart && p[i + 2] === '/') {
          out += '(?:[^/]*/)*'; // `**/`: zero or more whole folders
          i += 2;
        } else if (atStart && i + 2 === p.length) {
          out += '.*'; // a trailing `**`: everything below
          i += 1;
        } else {
          out += '[^/]*'; // `a**b` acts like `*`
          i += 1;
        }
      } else out += '[^/]*';
    } else if (c === '?') out += '[^/]';
    else if (c === '[') {
      const end = p.indexOf(']', i + 1);
      if (end <= i + 1) {
        out += '\\[';
        continue;
      }
      const body = p.slice(i + 1, end);
      out += `[${body.startsWith('!') ? `^${body.slice(1)}` : body}]`;
      i = end;
    } else if (c === '{') {
      const end = closingBrace(p, i);
      if (end === -1) {
        out += '\\{';
        continue;
      }
      out += `(?:${splitTopLevel(p.slice(i + 1, end)).map(convert).join('|')})`;
      i = end;
    } else out += SPECIAL.test(c) ? `\\${c}` : c;
  }
  return out;
}

function closingBrace(p: string, open: number): number {
  let depth = 0;
  for (let i = open; i < p.length; i++) {
    if (p[i] === '{') depth++;
    else if (p[i] === '}' && --depth === 0) return i;
  }
  return -1;
}

/** `a,{b,c},d` → ['a', '{b,c}', 'd']. */
function splitTopLevel(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '{') depth++;
    else if (s[i] === '}') depth--;
    else if (s[i] === ',' && depth === 0) {
      parts.push(s.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(s.slice(start));
  return parts;
}
```

Create `engine/src/agentLoop/tools.ts`:

```ts
import { readdirSync, readFileSync, statSync, type Dirent, type Stats } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { truncateHead } from '../prompt';
import type { ToolSpec } from './chatModel';
import { globToRegExp } from './glob';

/** What a tool returns to the model. */
export type ToolOutput = { text: string; isError?: boolean };
/** A tool the agent loop offers: what the model sees, the name the gate decides on, and what it does. */
export type LoopTool = { spec: ToolSpec; gateName: string; run(input: unknown, signal: AbortSignal): Promise<ToolOutput> };

export const MAX_RESULT_CHARS = 30_000;
const READ_LIMIT = 2000;
const MAX_LINE_CHARS = 2000;
const MAX_GLOB_RESULTS = 1000;
const MAX_GREP_MATCHES = 500;
const MAX_GREP_LINE_CHARS = 500;
const MAX_GREP_FILE_BYTES = 2 * 1024 * 1024;
const BINARY_SNIFF_BYTES = 8192;

/** Head and tail kept, the middle cut with the existing truncateHead's note (spec §4.2). */
export function clipResult(text: string, max: number = MAX_RESULT_CHARS): string {
  if (text.length <= max) return text;
  const half = Math.floor(max / 2);
  return `${truncateHead(text.slice(0, text.length - half), half)}\n${text.slice(text.length - half)}`;
}

/** A leading `~` is the home folder (as privatePathDenial reads it); anything else resolves against the tool's folder. */
export function toolPath(cwd: string, p: string): string {
  return resolve(cwd, /^~(?=$|[\\/])/.test(p) ? join(homedir(), p.slice(1)) : p);
}

/** How results name a file: relative to the working folder when inside it, else absolute. */
function shown(cwd: string, file: string): string {
  const rel = relative(cwd, file);
  return rel !== '' && rel.split(sep)[0] !== '..' && !isAbsolute(rel) ? rel : file;
}

const statOf = (p: string): Stats | undefined => {
  try {
    return statSync(p);
  } catch {
    return undefined;
  }
};
const readOf = (p: string): Buffer | undefined => {
  try {
    return readFileSync(p);
  } catch {
    return undefined;
  }
};
const isBinary = (buf: Buffer) => buf.subarray(0, BINARY_SNIFF_BYTES).includes(0);
const posixRelative = (root: string, file: string) => relative(root, file).split(sep).join('/');

const SKIPPED_FOLDERS = new Set(['.git', 'node_modules']);
/** Agent Stream's own private folders, skipped wherever a `.agent-stream` folder is met. */
const AGENT_STREAM_PRIVATE = new Set(['runs', 'sessions']);

/** Every file under `dir`, in name order, not following links, skipping .git, node_modules and .agent-stream/{runs,sessions}. */
function* walk(dir: string): Generator<string> {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIPPED_FOLDERS.has(e.name) || (AGENT_STREAM_PRIVATE.has(e.name) && basename(dir) === '.agent-stream')) continue;
      yield* walk(full);
    } else if (e.isFile()) yield full;
  }
}

/** A tool whose input is checked with zod first; every result is clipped, and a throw becomes an error result. */
export function defineLoopTool<S extends z.ZodType>(
  name: string,
  description: string,
  schema: S,
  run: (input: z.infer<S>, signal: AbortSignal) => Promise<ToolOutput>,
): LoopTool {
  return {
    spec: { name, description, inputSchema: z.toJSONSchema(schema) },
    gateName: name,
    async run(input, signal) {
      const parsed = schema.safeParse(input ?? {});
      if (!parsed.success) return { text: z.prettifyError(parsed.error), isError: true };
      try {
        const out = await run(parsed.data, signal);
        return { ...out, text: clipResult(out.text) };
      } catch (e) {
        return { text: e instanceof Error ? e.message : String(e), isError: true };
      }
    },
  };
}

const readInput = z.object({
  file_path: z.string().describe('The file to read: absolute, or relative to the working folder.'),
  offset: z.number().int().positive().optional().describe('The line number to start at (1-based).'),
  limit: z.number().int().positive().optional().describe('How many lines to read (default 2000).'),
});
const grepInput = z.object({
  pattern: z.string().describe('A JavaScript regular expression, matched against each line.'),
  path: z.string().optional().describe('The folder or file to search (default: the working folder).'),
  glob: z.string().optional().describe('Only files matching this glob: a name such as *.ts, or a path such as src/**/*.ts.'),
});
const globInput = z.object({
  pattern: z.string().describe('A glob such as **/*.ts or src/*.{js,ts}, matched against paths relative to the searched folder.'),
  path: z.string().optional().describe('The folder to search (default: the working folder).'),
});

/** Read, Grep and Glob (spec §4.2): everything a read-only step or the planner gets. */
export function readOnlyTools(cwd: string): LoopTool[] {
  return [
    defineLoopTool('Read', 'Read a text file. Lines come numbered from 1; use offset and limit for long files.', readInput, async ({ file_path, offset, limit }) => {
      const file = toolPath(cwd, file_path);
      const st = statOf(file);
      if (!st) return { text: `File not found: ${file}`, isError: true };
      if (st.isDirectory()) return { text: `${file} is a folder, not a file. Use Glob to list it.`, isError: true };
      const buf = readFileSync(file);
      if (isBinary(buf)) return { text: `${file} is a binary file.`, isError: true };
      const lines = buf.toString('utf8').split(/\r?\n/);
      if (lines.at(-1) === '') lines.pop(); // a final newline doesn't start another line
      if (lines.length === 0) return { text: '(The file is empty.)' };
      const start = (offset ?? 1) - 1;
      if (start >= lines.length) return { text: `The file has ${lines.length} lines; offset ${offset} is past the end.`, isError: true };
      return {
        text: lines
          .slice(start, start + (limit ?? READ_LIMIT))
          .map((line, i) => `${String(start + i + 1).padStart(6)}\t${line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line}`)
          .join('\n'),
      };
    }),
    defineLoopTool('Grep', 'Search file contents with a JavaScript regular expression, line by line. Results are file:line: text.', grepInput, async ({ pattern, path, glob }) => {
      let re: RegExp;
      try {
        re = new RegExp(pattern);
      } catch (e) {
        return { text: `Invalid regular expression: ${(e as Error).message}`, isError: true };
      }
      const root = toolPath(cwd, path || '.');
      const st = statOf(root);
      if (!st) return { text: `Not found: ${root}`, isError: true };
      const filter = glob ? globToRegExp(glob) : undefined;
      const byPath = !!glob && /[\\/]/.test(glob);
      const files = st.isDirectory() ? walk(root) : [root];
      const out: string[] = [];
      let stopped = false;
      search: for (const file of files) {
        if (filter && st.isDirectory() && !filter.test(byPath ? posixRelative(root, file) : basename(file))) continue;
        const size = statOf(file)?.size;
        if (size === undefined || size > MAX_GREP_FILE_BYTES) continue;
        const buf = readOf(file);
        if (!buf || isBinary(buf)) continue;
        const lines = buf.toString('utf8').split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          if (!re.test(lines[i])) continue;
          if (out.length === MAX_GREP_MATCHES) {
            stopped = true;
            break search;
          }
          const line = lines[i].length > MAX_GREP_LINE_CHARS ? `${lines[i].slice(0, MAX_GREP_LINE_CHARS)}…` : lines[i];
          out.push(`${shown(cwd, file)}:${i + 1}: ${line}`);
        }
      }
      if (out.length === 0) return { text: 'No matches found.' };
      if (stopped) out.push(`(Stopped after ${MAX_GREP_MATCHES} matches.)`);
      return { text: out.join('\n') };
    }),
    defineLoopTool('Glob', 'Find files by a glob pattern such as **/*.ts. Results are newest first.', globInput, async ({ pattern, path }) => {
      const root = toolPath(cwd, path || '.');
      if (!statOf(root)?.isDirectory()) return { text: `Folder not found: ${root}`, isError: true };
      const re = globToRegExp(pattern);
      const found: { file: string; mtime: number }[] = [];
      for (const file of walk(root)) if (re.test(posixRelative(root, file))) found.push({ file, mtime: statOf(file)?.mtimeMs ?? 0 });
      if (found.length === 0) return { text: 'No files found.' };
      found.sort((a, b) => b.mtime - a.mtime);
      const lines = found.slice(0, MAX_GLOB_RESULTS).map((f) => shown(cwd, f.file));
      if (found.length > MAX_GLOB_RESULTS) lines.push(`(Showing the newest ${MAX_GLOB_RESULTS} of ${found.length} files.)`);
      return { text: lines.join('\n') };
    }),
  ];
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -w engine -- test/glob.test.ts test/loopTools.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck and commit**

Run: `npm run typecheck -w engine`
Expected: no errors.

```bash
git add engine/src/agentLoop/chatModel.ts engine/src/agentLoop/glob.ts engine/src/agentLoop/tools.ts engine/test/glob.test.ts engine/test/loopTools.test.ts
git commit -m "feat(engine): ChatModel types and the Read, Grep and Glob loop tools

Provider-neutral tools with Claude's names and input shapes, a small glob
matcher (no path.matchesGlob on Node 20.11), skips for .git, node_modules
and Agent Stream's runs and sessions, and head-and-tail truncation.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Edit, Write and Bash, and `builtinTools` with read-only steps

**Spec tests owned (§8):**
- `Edit` (unique match, zero or several matches, `replace_all`);
- `Write` (creates folders);
- `Bash` through `createRunShell` (output and exit code, timeout, abort kills);
- read-only steps get only the three read tools.

It also pins Review Focus 2.

**Files:**
- Modify: `engine/src/agentLoop/tools.ts` (imports; append the write tools and `builtinTools`)
- Test: `engine/test/loopTools.test.ts` (append)

**Interfaces:**
- Consumes: `RunShell`, `createRunShell` (Task 1); `defineLoopTool`, `readOnlyTools`, `toolPath` (Task 2); `writeFileAtomic` from `engine/src/fsutil.ts`.
- Produces:
  ```ts
  // engine/src/agentLoop/tools.ts
  export const BASH_TIMEOUT_SEC = 600;
  export function builtinTools(o: { cwd: string; runShell: RunShell; readOnly: boolean }): LoopTool[];
  // readOnly → [Read, Grep, Glob]; else [Read, Grep, Glob, Edit, Write, Bash]. gateName === spec.name.
  ```

- [ ] **Step 1: Write the failing tests**

In `engine/test/loopTools.test.ts`, change the imports to:

```ts
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { builtinTools, clipResult, readOnlyTools, toolPath, type LoopTool } from '../src/agentLoop/tools';
import { createRunShell, type RunShell, type RunShellResult } from '../src/shell';
```

Append:

```ts
/** A RunShell that records each call and answers `result`. */
function fakeShell(result: RunShellResult) {
  const calls: Parameters<RunShell>[0][] = [];
  const runShell: RunShell = async (o) => {
    calls.push(o);
    return result;
  };
  return { runShell, calls };
}
const all = (cwd: string, runShell: RunShell = fakeShell({ exitCode: 0, output: '' }).runShell) => builtinTools({ cwd, runShell, readOnly: false });
const runTool = (cwd: string, name: string, input: unknown, runShell?: RunShell, s: AbortSignal = signal) => find(all(cwd, runShell), name).run(input, s);

async function waitFor(condition: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('builtinTools', () => {
  it('offers Read, Grep, Glob, Edit, Write and Bash, each gated under its own name', () => {
    const tools = all(project());
    expect(tools.map((t) => t.spec.name)).toEqual(['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash']);
    expect(tools.map((t) => t.gateName)).toEqual(['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash']);
  });

  it('gives a read-only step only the three read tools', () => {
    const tools = builtinTools({ cwd: project(), runShell: fakeShell({ exitCode: 0, output: '' }).runShell, readOnly: true });
    expect(tools.map((t) => t.spec.name)).toEqual(['Read', 'Grep', 'Glob']);
  });
});

describe('Edit', () => {
  it('replaces a unique match, literally', async () => {
    const cwd = project({ 'a.txt': 'a = 1\nb = 2\n' });
    const file = join(cwd, 'a.txt');
    expect(await runTool(cwd, 'Edit', { file_path: 'a.txt', old_string: 'b = 2', new_string: 'b = "$&"' })).toEqual({ text: `Edited ${file} (1 replacement).` });
    expect(readFileSync(file, 'utf8')).toBe('a = 1\nb = "$&"\n');
  });

  it('refuses zero matches, and several without replace_all, saying how many', async () => {
    const cwd = project({ 'x.txt': 'x x x' });
    const file = join(cwd, 'x.txt');
    expect(await runTool(cwd, 'Edit', { file_path: 'x.txt', old_string: 'y', new_string: 'z' })).toEqual({ text: `old_string was not found in ${file}.`, isError: true });
    expect(await runTool(cwd, 'Edit', { file_path: 'x.txt', old_string: 'x', new_string: 'y' })).toEqual({
      text: `old_string was found 3 times in ${file}. Add more surrounding text to make it unique, or set replace_all.`,
      isError: true,
    });
    expect(readFileSync(file, 'utf8')).toBe('x x x');
  });

  it('replaces every match with replace_all', async () => {
    const cwd = project({ 'x.txt': 'x x x' });
    expect(await runTool(cwd, 'Edit', { file_path: 'x.txt', old_string: 'x', new_string: 'y', replace_all: true })).toEqual({ text: `Edited ${join(cwd, 'x.txt')} (3 replacements).` });
    expect(readFileSync(join(cwd, 'x.txt'), 'utf8')).toBe('y y y');
  });

  it('matches an old_string written with \\n in a CRLF file, keeping CRLF', async () => {
    const cwd = project({ 'win.txt': 'one\r\ntwo\r\nthree\r\n' });
    expect(await runTool(cwd, 'Edit', { file_path: 'win.txt', old_string: 'one\ntwo', new_string: 'uno\ndos' })).toEqual({ text: `Edited ${join(cwd, 'win.txt')} (1 replacement).` });
    expect(readFileSync(join(cwd, 'win.txt'), 'utf8')).toBe('uno\r\ndos\r\nthree\r\n');
  });

  it('refuses a missing file and an empty old_string', async () => {
    const cwd = project({ 'a.txt': 'a' });
    expect(await runTool(cwd, 'Edit', { file_path: 'nope.txt', old_string: 'a', new_string: 'b' })).toEqual({ text: `File not found: ${join(cwd, 'nope.txt')}`, isError: true });
    expect(await runTool(cwd, 'Edit', { file_path: 'a.txt', old_string: '', new_string: 'b' })).toEqual({ text: 'old_string is empty; use Write to create or replace a whole file.', isError: true });
  });
});

describe('Write', () => {
  it('creates missing folders, then writes or overwrites the file', async () => {
    const cwd = project();
    const file = join(cwd, 'a', 'b', 'c.txt');
    expect(await runTool(cwd, 'Write', { file_path: 'a/b/c.txt', content: 'hi' })).toEqual({ text: `Wrote ${file} (2 bytes).` });
    expect(readFileSync(file, 'utf8')).toBe('hi');
    await runTool(cwd, 'Write', { file_path: file, content: 'again' });
    expect(readFileSync(file, 'utf8')).toBe('again');
  });
});

describe('Bash', () => {
  it('runs the command in the working folder with a 600 s timeout and reports output and exit code', async () => {
    const cwd = project();
    const shell = fakeShell({ exitCode: 2, output: 'boom\n' });
    expect(await runTool(cwd, 'Bash', { command: 'make', description: 'Build' }, shell.runShell)).toEqual({ text: 'boom\nexit code 2' });
    expect(shell.calls[0]).toMatchObject({ command: 'make', cwd, timeoutSec: 600 });
    expect(await runTool(cwd, 'Bash', { command: 'true' }, fakeShell({ exitCode: 0, output: 'ok' }).runShell)).toEqual({ text: 'ok\nexit code 0' });
    expect(await runTool(cwd, 'Bash', { command: 'true' }, fakeShell({ exitCode: 0, output: '' }).runShell)).toEqual({ text: 'exit code 0' });
  });

  it('reports a timeout, a Stop or a missing Git Bash as an error, with the output so far', async () => {
    const shell = fakeShell({ exitCode: null, output: 'partial', error: 'timed out after 600 s' });
    expect(await runTool(project(), 'Bash', { command: 'sleep 999' }, shell.runShell)).toEqual({ text: 'partial\ntimed out after 600 s', isError: true });
  });
});

describe.skipIf(process.platform === 'win32')('Bash through createRunShell', () => {
  const real = createRunShell({ shell: '/bin/sh' });

  it('returns the real output and exit code', async () => {
    expect(await runTool(project(), 'Bash', { command: 'echo hi; exit 3' }, real)).toEqual({ text: 'hi\nexit code 3' });
  });

  it('kills the command and what it started when the step is stopped', async () => {
    const cwd = project();
    const ac = new AbortController();
    const pending = runTool(cwd, 'Bash', { command: 'sleep 30 & echo $! > child.pid; wait' }, real, ac.signal);
    const pidFile = join(cwd, 'child.pid');
    await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim() !== '');
    const childPid = Number(readFileSync(pidFile, 'utf8'));
    ac.abort();
    const r = await pending;
    expect(r.isError).toBe(true);
    expect(r.text.endsWith('cancelled')).toBe(true);
    await waitFor(() => {
      try {
        process.kill(childPid, 0);
        return false;
      } catch {
        return true;
      }
    });
  });
});
```

The timeout itself is covered by `shell.test.ts` › "stops a command that runs past its timeout" (Task 1). `Bash` always passes `timeoutSec: 600`, which the first `Bash` test asserts.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w engine -- test/loopTools.test.ts`
Expected: FAIL with "builtinTools is not a function" (the import is undefined).

- [ ] **Step 3: Write the implementation**

In `engine/src/agentLoop/tools.ts`, replace the import block with:

```ts
import { mkdirSync, readdirSync, readFileSync, statSync, type Dirent, type Stats } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { writeFileAtomic } from '../fsutil';
import { truncateHead } from '../prompt';
import type { RunShell } from '../shell';
import type { ToolSpec } from './chatModel';
import { globToRegExp } from './glob';
```

Append to the end of the file:

```ts
export const BASH_TIMEOUT_SEC = 600;

const editInput = z.object({
  file_path: z.string().describe('The file to change.'),
  old_string: z.string().describe('The exact text to replace.'),
  new_string: z.string().describe('The text to put in its place.'),
  replace_all: z.boolean().optional().describe('Replace every occurrence. Without it, old_string must occur exactly once.'),
});
const writeInput = z.object({
  file_path: z.string().describe('The file to create or overwrite.'),
  content: z.string().describe('The full content of the file.'),
});
const bashInput = z.object({
  command: z.string().describe('The shell command to run.'),
  description: z.string().optional().describe('What the command does, in a few words.'),
});

const occurrences = (text: string, s: string) => text.split(s).length - 1;

/** Edit, Write and Bash: each runs only after the gate allowed it (the loop asks first). */
function writeTools(cwd: string, runShell: RunShell): LoopTool[] {
  return [
    defineLoopTool('Edit', 'Replace text in a file. old_string must occur exactly once unless replace_all is true.', editInput, async ({ file_path, old_string, new_string, replace_all }) => {
      const file = toolPath(cwd, file_path);
      if (old_string === '') return { text: 'old_string is empty; use Write to create or replace a whole file.', isError: true };
      if (!statOf(file)?.isFile()) return { text: `File not found: ${file}`, isError: true };
      const text = readFileSync(file, 'utf8');
      let from = old_string;
      let to = new_string;
      let count = occurrences(text, from);
      if (count === 0 && text.includes('\r\n') && from.includes('\n') && !from.includes('\r')) {
        // Read shows lines without their \r, so on a CRLF file the model writes \n: match with the file's line ends.
        from = from.replace(/\n/g, '\r\n');
        to = to.replace(/\r?\n/g, '\r\n');
        count = occurrences(text, from);
      }
      if (count === 0) return { text: `old_string was not found in ${file}.`, isError: true };
      if (count > 1 && !replace_all) return { text: `old_string was found ${count} times in ${file}. Add more surrounding text to make it unique, or set replace_all.`, isError: true };
      writeFileAtomic(file, text.split(from).join(to));
      return { text: `Edited ${file} (${count} replacement${count === 1 ? '' : 's'}).` };
    }),
    defineLoopTool('Write', 'Create or overwrite a file with the given content. Missing folders are created.', writeInput, async ({ file_path, content }) => {
      const file = toolPath(cwd, file_path);
      mkdirSync(dirname(file), { recursive: true });
      writeFileAtomic(file, content);
      return { text: `Wrote ${file} (${Buffer.byteLength(content)} bytes).` };
    }),
    defineLoopTool('Bash', 'Run a shell command in the working folder (a login shell; Git Bash on Windows). Returns its output and exit code.', bashInput, async ({ command }, signal) => {
      const r = await runShell({ command, cwd, signal, timeoutSec: BASH_TIMEOUT_SEC });
      const output = r.output && !r.output.endsWith('\n') ? `${r.output}\n` : r.output;
      if (r.error !== undefined) return { text: `${output}${r.error}`, isError: true };
      // A non-zero exit is information for the model, not a tool error.
      return { text: `${output}exit code ${r.exitCode}` };
    }),
  ];
}

/** The built-in tools (spec §4.2). A read-only step gets only Read, Grep and Glob. */
export function builtinTools(o: { cwd: string; runShell: RunShell; readOnly: boolean }): LoopTool[] {
  const tools = readOnlyTools(o.cwd);
  return o.readOnly ? tools : [...tools, ...writeTools(o.cwd, o.runShell)];
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -w engine -- test/loopTools.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck -w engine`
Expected: no errors.

```bash
git add engine/src/agentLoop/tools.ts engine/test/loopTools.test.ts
git commit -m "feat(engine): Edit, Write and Bash loop tools, and builtinTools

Edit requires a unique match unless replace_all and keeps CRLF files CRLF;
Write creates folders; Bash runs through createRunShell with a 600 s
timeout. A read-only step gets only Read, Grep and Glob.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 4: Graph tools as loop tools

**Spec tests owned (§8):** the conversion half of "a step graph tool approving itself through `mcp__run_graph__` naming". The approval half runs through the loop in Task 5.

**Files:**
- Create: `engine/src/agentLoop/graphLoopTools.ts`
- Test: `engine/test/graphLoopTools.test.ts`

**Interfaces:**
- Consumes: `GraphTool` from `engine/src/providers/types.ts`; `LoopTool` (Task 2).
- Produces:
  ```ts
  // engine/src/agentLoop/graphLoopTools.ts
  export function toLoopTools(tools: GraphTool[], gatePrefix: string): LoopTool[];
  // spec: { name: t.name, description: t.description, inputSchema: z.toJSONSchema(z.object(t.schema)) }; run: t.run; gateName: gatePrefix + t.name
  ```

- [ ] **Step 1: Write the failing test**

Create `engine/test/graphLoopTools.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { toLoopTools } from '../src/agentLoop/graphLoopTools';
import { GraphStore } from '../src/graphStore';
import { defineTool, graphTools, reply } from '../src/plannerTools';
import { RunStore } from '../src/runStore';
import { fixedClock, outsideGit, tmpProject } from './helpers';

const signal = new AbortController().signal;

describe('toLoopTools', () => {
  it('turns a graph tool into a loop tool, named for the gate with the prefix', async () => {
    const addStep = defineTool('add_step', 'Add a step to this run.', { title: z.string() }, async (a) => reply(`added ${a.title}`));
    const [t] = toLoopTools([addStep], 'mcp__run_graph__');
    expect(t.spec).toEqual({ name: 'add_step', description: 'Add a step to this run.', inputSchema: z.toJSONSchema(z.object({ title: z.string() })) });
    expect(t.gateName).toBe('mcp__run_graph__add_step');
    expect(await t.run({ title: 'Lint' }, signal)).toEqual({ text: 'added Lint' });
    expect(await t.run({}, signal)).toMatchObject({ isError: true });
  });

  it("keeps the planner's tool names for its gate and converts every one to a JSON Schema object", () => {
    const paths = tmpProject();
    const graphStore = new GraphStore(paths, fixedClock());
    const graphId = graphStore.create('G').id;
    const tools = graphTools({ graphStore, runStore: new RunStore(paths), graphId, source: { kind: 'planner', sessionId: 'default' }, requestRun: () => null, checkout: outsideGit(paths.root) });
    const loop = toLoopTools(tools, '');
    expect(loop.map((t) => t.gateName)).toEqual(tools.map((t) => t.name));
    expect(loop.map((t) => t.spec.name)).toEqual(tools.map((t) => t.name));
    for (const t of loop) expect(t.spec.inputSchema).toMatchObject({ type: 'object' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w engine -- test/graphLoopTools.test.ts`
Expected: FAIL with "Failed to load url ../src/agentLoop/graphLoopTools".

- [ ] **Step 3: Write the implementation**

Create `engine/src/agentLoop/graphLoopTools.ts`:

```ts
import { z } from 'zod';
import type { GraphTool } from '../providers/types';
import type { LoopTool } from './tools';

/**
 * Graph tools for the agent loop (spec §4.4). `gatePrefix` names them for the gate: `mcp__run_graph__` for a step's
 * tools, so the step gate's self-approving set matches; '' for the planner, so its gate's graphToolNames match.
 */
export function toLoopTools(tools: GraphTool[], gatePrefix: string): LoopTool[] {
  return tools.map((t) => ({
    spec: { name: t.name, description: t.description, inputSchema: z.toJSONSchema(z.object(t.schema)) },
    gateName: gatePrefix + t.name,
    run: t.run,
  }));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -w engine -- test/graphLoopTools.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck -w engine`
Expected: no errors.

```bash
git add engine/src/agentLoop/graphLoopTools.ts engine/test/graphLoopTools.test.ts
git commit -m "feat(engine): graph tools as agent-loop tools

Step graph tools are gated as mcp__run_graph__<name>, planner tools by their
own names, so the existing gates match them unchanged.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: `runAgentLoop`

**Spec tests owned (§8):**
- the loop items:
  - a text-only reply;
  - tool call → approval → result → final reply;
  - a denied tool and its error result;
  - a read-only refusal;
  - an unknown tool;
  - a step graph tool approving itself through `mcp__run_graph__` naming;
  - the cap (exactly `maxRequests` sends, then `capped`);
  - abort during `send` and during a tool;
  - a `ChatModelError` mapping;
- privacy refusals for `Read`, `Grep` and `Glob` through a real step gate;
- §7's "malformed tool input".

It also pins Review Focus 1.

**Files:**
- Create: `engine/src/agentLoop/loop.ts`
- Modify: `engine/test/helpers.ts` (append the fake model helpers); `engine/src/index.ts` (exports); `engine/test/index.test.ts`
- Test: `engine/test/agentLoop.test.ts`

**Interfaces:**
- Consumes: `ChatModel`, `ChatMessage`, `ChatPart`, `ChatModelError` (Task 2); `LoopTool`, `ToolOutput`, `builtinTools` (Tasks 2–3); `toLoopTools` (Task 4); `ToolGate`, `createStepGate`, `withDecide`, `readOnlyRefusal` from `engine/src/providers/toolGate.ts`.
- Produces:
  ```ts
  // engine/src/agentLoop/loop.ts
  export type LoopResult =
    | { ok: true; text: string; requests: number; messages: ChatMessage[] }
    | { ok: false; error: string; requests: number; messages: ChatMessage[]; cancelled?: boolean; capped?: boolean };
  export type LoopOptions = {
    model: ChatModel; system: string; messages: ChatMessage[]; tools: LoopTool[]; gate: ToolGate;
    maxRequests: number; signal: AbortSignal;
    capMessage?: string;   // R1; default `Stopped after ${n} model requests.`
    onText(text: string): void; onToolCall(callId: string, name: string, input: unknown): void; onToolResult(callId: string, text: string, isError: boolean): void;
  };
  export function runAgentLoop(o: LoopOptions): Promise<LoopResult>;
  export function lastAssistantText(messages: ChatMessage[]): string;   // the newest assistant message with text, '' if none
  // engine/test/helpers.ts
  export type FakeReply = ChatPart[] | Error | ((messages: ChatMessage[], tools: ToolSpec[], signal: AbortSignal) => ChatPart[] | Promise<ChatPart[]>);
  export function fakeChatModel(replies: FakeReply[], o?: { maxInputTokens?: number }): { model: ChatModel; requests: { messages: ChatMessage[]; tools: ToolSpec[] }[] };
  export const textPart: (text: string) => ChatPart;
  export const toolCallPart: (callId: string, name: string, input: unknown) => ChatPart;
  export const userText: (text: string) => ChatMessage;
  export const allowAll: ToolGate;
  export const untilAborted: (signal: AbortSignal) => Promise<never>;
  // engine/src/index.ts gains: NodeContext, createRunShell, RunShell, RunShellResult, ChatModelError, ChatMessage, ChatModel,
  // ChatModelErrorCode, ChatPart, ToolSpec, builtinTools, LoopTool, ToolOutput, toLoopTools, runAgentLoop, lastAssistantText, LoopOptions, LoopResult
  ```

- [ ] **Step 1: Add the fake model helpers**

Append to `engine/test/helpers.ts` (and add the two imports at the top of the file, next to the others):

```ts
import type { ChatMessage, ChatModel, ChatPart, ToolSpec } from '../src/agentLoop/chatModel';
import { withDecide, type ToolGate } from '../src/providers/toolGate';
```

```ts
/** What a fake model answers to one request: its parts, an error to throw, or a function of the request. */
export type FakeReply = ChatPart[] | Error | ((messages: ChatMessage[], tools: ToolSpec[], signal: AbortSignal) => ChatPart[] | Promise<ChatPart[]>);

/** A ChatModel that answers from `replies` in order and records every request. No real model. */
export function fakeChatModel(replies: FakeReply[], o: { maxInputTokens?: number } = {}) {
  const requests: { messages: ChatMessage[]; tools: ToolSpec[] }[] = [];
  const model: ChatModel = {
    id: 'fake-model',
    maxInputTokens: o.maxInputTokens ?? 100_000,
    async *send(messages, tools, signal) {
      requests.push({ messages: structuredClone(messages), tools });
      const reply = replies.shift();
      if (reply === undefined) throw new Error('fakeChatModel: no reply left');
      if (reply instanceof Error) throw reply;
      const parts = typeof reply === 'function' ? await reply(messages, tools, signal) : reply;
      for (const part of parts) {
        signal.throwIfAborted();
        yield part;
      }
    },
  };
  return { model, requests };
}

export const textPart = (text: string): ChatPart => ({ type: 'text', text });
export const toolCallPart = (callId: string, name: string, input: unknown): ChatPart => ({ type: 'toolCall', callId, name, input });
export const userText = (text: string): ChatMessage => ({ role: 'user', content: [{ type: 'text', text }] });

/** A gate that allows everything without asking. */
export const allowAll: ToolGate = withDecide({ privacy: () => null, isReadOnly: () => true, approve: async () => ({ allow: true, by: 'user' }) });

/** Settles only when `signal` aborts, rejecting with its reason: a request or tool that runs until Stop. */
export const untilAborted = (signal: AbortSignal) => new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
```

- [ ] **Step 2: Write the failing test**

Create `engine/test/agentLoop.test.ts`:

```ts
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ApprovalBroker } from '../src/approvals';
import { ChatModelError } from '../src/agentLoop/chatModel';
import { toLoopTools } from '../src/agentLoop/graphLoopTools';
import { lastAssistantText, runAgentLoop } from '../src/agentLoop/loop';
import { builtinTools, type LoopTool } from '../src/agentLoop/tools';
import { defineTool, reply } from '../src/plannerTools';
import { createStepGate, readOnlyRefusal, type ToolGate } from '../src/providers/toolGate';
import type { RunShell } from '../src/shell';
import { allowAll, deferred, fakeChatModel, textPart, toolCallPart, untilAborted, userText, type FakeReply } from './helpers';

const noShell: RunShell = async () => ({ exitCode: 0, output: '' });
const tmp = () => mkdtempSync(join(tmpdir(), 'loop-'));

function loop(o: { replies: FakeReply[]; tools?: LoopTool[]; gate?: ToolGate; maxRequests?: number; signal?: AbortSignal; cwd?: string }) {
  const cwd = o.cwd ?? tmp();
  const { model, requests } = fakeChatModel(o.replies);
  const log: unknown[][] = [];
  const result = runAgentLoop({
    model,
    system: 'You are a test agent.',
    messages: [userText('Do the task.')],
    tools: o.tools ?? builtinTools({ cwd, runShell: noShell, readOnly: false }),
    gate: o.gate ?? allowAll,
    maxRequests: o.maxRequests ?? 10,
    signal: o.signal ?? new AbortController().signal,
    capMessage: 'Stopped: cap reached.',
    onText: (text) => log.push(['text', text]),
    onToolCall: (callId, name, input) => log.push(['call', callId, name, input]),
    onToolResult: (callId, text, isError) => log.push(['result', callId, text, isError]),
  });
  return { result, requests, log, cwd };
}

function stepGate(cwd: string, o: { readOnly?: boolean; selfApproving?: string[]; privateFiles?: string[] } = {}) {
  const broker = new ApprovalBroker(() => 't');
  const gate = createStepGate({
    broker,
    runId: 'r',
    graphId: 'g',
    nodeId: 'n1',
    nodeTitle: 'Step',
    projectDir: cwd,
    privateFiles: o.privateFiles ?? [],
    signal: new AbortController().signal,
    emit: () => {},
    readOnly: o.readOnly,
    selfApproving: new Set(o.selfApproving ?? []),
  });
  return { broker, gate };
}

describe('runAgentLoop', () => {
  it('ends on a reply without tool calls, joining streamed text into one part', async () => {
    const { result, requests, log } = loop({ replies: [[textPart('All '), textPart('done.'), textPart('  ')]] });
    expect(await result).toEqual({
      ok: true,
      text: 'All done.  ',
      requests: 1,
      messages: [userText('Do the task.'), { role: 'assistant', content: [textPart('All done.  ')] }],
    });
    expect(log).toEqual([['text', 'All done.  ']]);
    // The system text goes first, as a user message; the tools are offered by their specs.
    expect(requests[0].messages).toEqual([userText('You are a test agent.'), userText('Do the task.')]);
    expect(requests[0].tools.map((t) => t.name)).toEqual(['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash']);
  });

  it('asks the gate, runs an approved tool, sends its result and ends on the final reply', async () => {
    const cwd = tmp();
    const { broker, gate } = stepGate(cwd);
    const { result, requests, log } = loop({ cwd, gate, replies: [[toolCallPart('c1', 'Write', { file_path: 'out.txt', content: 'hi' })], [textPart('Wrote it.')]] });
    await vi.waitFor(() => expect(broker.pending()).toHaveLength(1));
    expect(broker.pending()[0]).toMatchObject({ toolName: 'Write', input: { file_path: 'out.txt', content: 'hi' } });
    broker.decide(broker.pending()[0].id, { decision: 'approve' });
    expect(await result).toMatchObject({ ok: true, text: 'Wrote it.', requests: 2 });
    expect(readFileSync(join(cwd, 'out.txt'), 'utf8')).toBe('hi');
    const wrote = `Wrote ${join(cwd, 'out.txt')} (2 bytes).`;
    expect(log).toEqual([['call', 'c1', 'Write', { file_path: 'out.txt', content: 'hi' }], ['result', 'c1', wrote, false], ['text', 'Wrote it.']]);
    expect(requests[1].messages.at(-1)).toEqual({ role: 'user', content: [{ type: 'toolResult', callId: 'c1', text: wrote }] });
  });

  it('sends a denial back as an error result and carries on', async () => {
    const cwd = tmp();
    const { broker, gate } = stepGate(cwd);
    const { result, requests, log } = loop({ cwd, gate, replies: [[toolCallPart('c1', 'Write', { file_path: 'out.txt', content: 'hi' })], [textPart('OK, skipped.')]] });
    await vi.waitFor(() => expect(broker.pending()).toHaveLength(1));
    broker.decide(broker.pending()[0].id, { decision: 'deny', note: 'not now' });
    expect(await result).toMatchObject({ ok: true, text: 'OK, skipped.' });
    expect(existsSync(join(cwd, 'out.txt'))).toBe(false);
    expect(log).toContainEqual(['result', 'c1', 'Denied by the user: not now', true]);
    expect(requests[1].messages.at(-1)).toEqual({ role: 'user', content: [{ type: 'toolResult', callId: 'c1', text: 'Denied by the user: not now', isError: true }] });
  });

  it('refuses a write tool in a read-only step without asking', async () => {
    const cwd = tmp();
    const { broker, gate } = stepGate(cwd, { readOnly: true });
    const { result, log } = loop({ cwd, gate, replies: [[toolCallPart('c1', 'Edit', { file_path: 'a.txt', old_string: 'a', new_string: 'b' })], [textPart('I could not edit.')]] });
    expect(await result).toMatchObject({ ok: true, text: 'I could not edit.' });
    expect(log).toContainEqual(['result', 'c1', readOnlyRefusal('Edit'), true]);
    expect(broker.pending()).toEqual([]);
  });

  it('answers an unknown tool with an error, without asking the gate', async () => {
    const decide = vi.fn(allowAll.decide);
    const { result, log } = loop({ gate: { ...allowAll, decide }, replies: [[toolCallPart('c1', 'Delete', {})], [textPart('Sorry.')]] });
    expect(await result).toMatchObject({ ok: true, text: 'Sorry.' });
    expect(log).toContainEqual(['result', 'c1', 'Unknown tool Delete.', true]);
    expect(decide).not.toHaveBeenCalled();
  });

  it('lets a step graph tool through under its mcp__run_graph__ name, without a second approval', async () => {
    const cwd = tmp();
    const ran = vi.fn(async (a: { title: string }) => reply(`added ${a.title}`));
    const tools = toLoopTools([defineTool('add_step', 'Add a step.', { title: z.string() }, ran)], 'mcp__run_graph__');
    const { broker, gate } = stepGate(cwd, { selfApproving: ['mcp__run_graph__add_step'] });
    const { result, log } = loop({ cwd, gate, tools, replies: [[toolCallPart('c1', 'add_step', { title: 'Lint' })], [textPart('Added.')]] });
    expect(await result).toMatchObject({ ok: true, text: 'Added.' });
    expect(ran).toHaveBeenCalledWith({ title: 'Lint' });
    expect(log).toContainEqual(['result', 'c1', 'added Lint', false]);
    expect(broker.pending()).toEqual([]);
  });

  it('returns a malformed tool input as a validation error and carries on', async () => {
    const { result, log } = loop({ replies: [[toolCallPart('c1', 'Read', { file_path: 42 })], [textPart('Retrying later.')]] });
    expect(await result).toMatchObject({ ok: true, text: 'Retrying later.' });
    expect(log).toContainEqual(['result', 'c1', expect.stringContaining('file_path'), true]);
  });

  it('stops after exactly maxRequests requests while the model still wants tools', async () => {
    const cwd = tmp();
    writeFileSync(join(cwd, 'a.txt'), 'x');
    const read = () => [toolCallPart('c', 'Read', { file_path: 'a.txt' })];
    const { result, requests } = loop({ cwd, maxRequests: 3, replies: [read(), read(), read(), [textPart('never sent')]] });
    expect(await result).toMatchObject({ ok: false, capped: true, error: 'Stopped: cap reached.', requests: 3 });
    expect(requests).toHaveLength(3);
  });

  it('is cancelled by a Stop during a request', async () => {
    const ac = new AbortController();
    const { result } = loop({ signal: ac.signal, replies: [(_messages, _tools, signal) => untilAborted(signal)] });
    setTimeout(() => ac.abort(), 10);
    expect(await result).toMatchObject({ ok: false, cancelled: true, error: 'cancelled', requests: 1 });
  });

  it('is cancelled by a Stop during a tool, without reporting its result', async () => {
    const ac = new AbortController();
    const started = deferred<void>();
    const slow: LoopTool = {
      spec: { name: 'Slow', description: 'Waits.', inputSchema: { type: 'object' } },
      gateName: 'Slow',
      run: async (_input, signal) => {
        started.resolve();
        return untilAborted(signal);
      },
    };
    const { result, log } = loop({ signal: ac.signal, tools: [slow], replies: [[toolCallPart('c1', 'Slow', {})]] });
    await started.promise;
    ac.abort();
    expect(await result).toMatchObject({ ok: false, cancelled: true, error: 'cancelled' });
    expect(log).toEqual([['call', 'c1', 'Slow', {}]]);
  });

  it("returns a ChatModelError's message as the error", async () => {
    const message = 'Copilot refused the request (quota or policy): monthly limit';
    const { result } = loop({ replies: [new ChatModelError('blocked', message)] });
    expect(await result).toEqual({ ok: false, error: message, requests: 1, messages: [userText('Do the task.')] });
  });

  it('refuses Read, Grep and Glob on private files through a real step gate, without asking', async () => {
    const cwd = tmp();
    const valuesDir = mkdtempSync(join(tmpdir(), 'values-'));
    const values = join(valuesDir, 'v.json');
    writeFileSync(values, '{"token":"s3cret"}');
    const { broker, gate } = stepGate(cwd, { privateFiles: [values] });
    const { result, requests, log } = loop({
      cwd,
      gate,
      replies: [
        [toolCallPart('c1', 'Read', { file_path: values }), toolCallPart('c2', 'Glob', { pattern: '*', path: valuesDir }), toolCallPart('c3', 'Grep', { pattern: 's3cret', path: dirname(valuesDir) })],
        [textPart('Nothing to see.')],
      ],
    });
    expect(await result).toMatchObject({ ok: true });
    const privateResult = (id: string) => ['result', id, expect.stringContaining('private to this machine'), true];
    expect(log.filter((e) => e[0] === 'result')).toEqual([privateResult('c1'), privateResult('c2'), privateResult('c3')]);
    // All three results travel back in one user message.
    expect(requests[1].messages.at(-1)?.content).toHaveLength(3);
    expect(broker.pending()).toEqual([]);
  });
});

describe('lastAssistantText', () => {
  it('is the newest assistant text, skipping replies that only call tools', () => {
    expect(lastAssistantText([userText('a'), { role: 'assistant', content: [textPart('first')] }, { role: 'assistant', content: [toolCallPart('c', 'Read', {})] }])).toBe('first');
    expect(lastAssistantText([userText('a')])).toBe('');
  });
});
```

Append to `engine/test/index.test.ts`, inside `describe('engine public API', …)`:

```ts
  it('exports the agent loop for providers without their own agent', () => {
    expect(typeof engine.runAgentLoop).toBe('function');
    expect(typeof engine.builtinTools).toBe('function');
    expect(typeof engine.toLoopTools).toBe('function');
    expect(typeof engine.createRunShell).toBe('function');
    expect(typeof engine.lastAssistantText).toBe('function');
    expect(new engine.ChatModelError('other', 'x')).toBeInstanceOf(Error);
  });
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm test -w engine -- test/agentLoop.test.ts test/index.test.ts`
Expected: FAIL with "Failed to load url ../src/agentLoop/loop", and `engine.runAgentLoop` undefined.

- [ ] **Step 4: Write the implementation**

Create `engine/src/agentLoop/loop.ts`:

```ts
import type { ToolGate } from '../providers/toolGate';
import type { ChatMessage, ChatModel, ChatPart } from './chatModel';
import type { LoopTool, ToolOutput } from './tools';

export type LoopResult =
  | { ok: true; text: string; requests: number; messages: ChatMessage[] }
  | { ok: false; error: string; requests: number; messages: ChatMessage[]; cancelled?: boolean; capped?: boolean };

export type LoopOptions = {
  model: ChatModel;
  system: string;
  messages: ChatMessage[];
  tools: LoopTool[];
  gate: ToolGate;
  maxRequests: number;
  signal: AbortSignal;
  /** The error when the cap is reached: the provider names its own setting (default: `Stopped after <n> model requests.`). */
  capMessage?: string;
  onText(text: string): void;
  onToolCall(callId: string, name: string, input: unknown): void;
  onToolResult(callId: string, text: string, isError: boolean): void;
};

type ToolCall = Extract<ChatPart, { type: 'toolCall' }>;
type ToolResult = { type: 'toolResult'; callId: string; text: string; isError?: boolean };

const userText = (text: string): ChatMessage => ({ role: 'user', content: [{ type: 'text', text }] });
const textOf = (parts: ChatPart[]) => parts.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('');

/** Streamed text arrives a few tokens at a time: adjacent text parts become one. */
function joinText(parts: ChatPart[]): ChatPart[] {
  const out: ChatPart[] = [];
  for (const p of parts) {
    const last = out.at(-1);
    if (p.type === 'text' && last?.type === 'text') out[out.length - 1] = { type: 'text', text: last.text + p.text };
    else out.push(p);
  }
  return out;
}

/** The newest assistant text (a step's output when it stopped early); '' when there is none. */
export function lastAssistantText(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'assistant') continue;
    const text = textOf(m.content);
    if (text.trim()) return text;
  }
  return '';
}

/**
 * The provider-neutral agent loop (spec §4.5): send, record, run each tool call through the gate, send the results,
 * until a reply has no tool calls, the request cap is reached, the model fails, or the signal aborts.
 */
export async function runAgentLoop(o: LoopOptions): Promise<LoopResult> {
  let messages = [...o.messages];
  let requests = 0;
  const specs = o.tools.map((t) => t.spec);
  const byName = new Map(o.tools.map((t) => [t.spec.name, t]));

  async function runCall(call: ToolCall): Promise<ToolOutput> {
    const tool = byName.get(call.name);
    if (!tool) return { text: `Unknown tool ${call.name}.`, isError: true };
    const decision = await o.gate.decide(tool.gateName, call.input, o.signal);
    if (!decision.allow) return { text: decision.reason, isError: true };
    try {
      return await tool.run(call.input, o.signal);
    } catch (e) {
      if (o.signal.aborted) throw e;
      return { text: e instanceof Error ? e.message : String(e), isError: true };
    }
  }

  try {
    for (;;) {
      o.signal.throwIfAborted();
      const parts: ChatPart[] = [];
      requests++;
      for await (const part of o.model.send([userText(o.system), ...messages], specs, o.signal)) parts.push(part);
      o.signal.throwIfAborted();
      const content = joinText(parts);
      messages = [...messages, { role: 'assistant', content }];
      for (const p of content) {
        if (p.type === 'toolCall') o.onToolCall(p.callId, p.name, p.input);
        else if (p.text.trim()) o.onText(p.text);
      }
      const calls = content.filter((p): p is ToolCall => p.type === 'toolCall');
      if (calls.length === 0) return { ok: true, text: textOf(content), requests, messages };
      const results: ToolResult[] = [];
      for (const call of calls) {
        const r = await runCall(call);
        o.signal.throwIfAborted();
        o.onToolResult(call.callId, r.text, r.isError === true);
        results.push(r.isError ? { type: 'toolResult', callId: call.callId, text: r.text, isError: true } : { type: 'toolResult', callId: call.callId, text: r.text });
      }
      messages = [...messages, { role: 'user', content: results }];
      if (requests >= o.maxRequests) return { ok: false, capped: true, error: o.capMessage ?? `Stopped after ${requests} model requests.`, requests, messages };
    }
  } catch (e) {
    if (o.signal.aborted) return { ok: false, cancelled: true, error: 'cancelled', requests, messages };
    return { ok: false, error: e instanceof Error ? e.message : String(e), requests, messages };
  }
}
```

In `engine/src/index.ts`, replace the line `export type { NodeOutcome } from './executors';` with:

```ts
export type { NodeContext, NodeOutcome } from './executors';
export { createRunShell, type RunShell, type RunShellResult } from './shell';
export { ChatModelError, type ChatMessage, type ChatModel, type ChatModelErrorCode, type ChatPart, type ToolSpec } from './agentLoop/chatModel';
export { builtinTools, type LoopTool, type ToolOutput } from './agentLoop/tools';
export { toLoopTools } from './agentLoop/graphLoopTools';
export { lastAssistantText, runAgentLoop, type LoopOptions, type LoopResult } from './agentLoop/loop';
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -w engine -- test/agentLoop.test.ts test/index.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the whole engine suite, typecheck and commit**

Run: `npm test -w engine && npm run typecheck -w engine && npm test -w extension -- test/bundle.test.ts`
Expected: PASS, and no type errors. The bundle test loads the engine bundle with the new modules.

```bash
git add engine/src/agentLoop/loop.ts engine/src/index.ts engine/test/helpers.ts engine/test/agentLoop.test.ts engine/test/index.test.ts
git commit -m "feat(engine): the provider-neutral agent loop

runAgentLoop sends, runs each tool call through the ToolGate (privacy,
read-only, self-approving graph tools, user approval), returns results, and
stops on a final reply, the request cap, a ChatModelError or Stop.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Compaction

**Spec tests owned (§8):** the compaction items:
- it triggers at 75 %;
- it keeps the first message and recent pairs;
- it never splits a call/result pair;
- a failed summary falls back to dropping.

It also pins Review Focus 4.

**Files:**
- Create: `engine/src/agentLoop/compact.ts`
- Modify: `engine/src/agentLoop/loop.ts` (call `compactIfNeeded` before each request)
- Test: `engine/test/compact.test.ts`

**Interfaces:**
- Consumes: `ChatModel`, `ChatMessage`, `ToolSpec` (Task 2); `clipResult` (Task 2); `runAgentLoop` (Task 5).
- Produces:
  ```ts
  // engine/src/agentLoop/compact.ts
  export const SUMMARY_PROMPT: string;   // §4.6, verbatim
  export const SUMMARY_PREFIX = 'Summary of earlier turns: ';
  export const DROPPED_NOTE = "Earlier turns were dropped to fit the model's context.";
  export function estimateTokens(system: string, messages: ChatMessage[], tools: ToolSpec[]): number;
  export function compactIfNeeded(o: { model: ChatModel; system: string; messages: ChatMessage[]; tools: ToolSpec[]; signal: AbortSignal; canSummarise: boolean }): Promise<{ messages: ChatMessage[]; requests: number }>;
  ```
  `requests` is 1 when a summary request was sent (successful or not), else 0. An abort during the summary rejects.

- [ ] **Step 1: Write the failing test**

Create `engine/test/compact.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { ChatModelError, type ChatMessage } from '../src/agentLoop/chatModel';
import { compactIfNeeded, DROPPED_NOTE, estimateTokens, SUMMARY_PREFIX, SUMMARY_PROMPT } from '../src/agentLoop/compact';
import { runAgentLoop } from '../src/agentLoop/loop';
import { allowAll, fakeChatModel, textPart, toolCallPart, untilAborted, userText } from './helpers';

const signal = new AbortController().signal;

/** The task, then `pairs` tool rounds: an assistant tool call and its result of `size` characters (about 155 tokens a round). */
function conversation(pairs: number, size = 400): ChatMessage[] {
  const out: ChatMessage[] = [userText('The task.')];
  for (let i = 1; i <= pairs; i++) {
    out.push({ role: 'assistant', content: [textPart(`Step ${i}.`), toolCallPart(`c${i}`, 'Read', { file_path: `f${i}.txt` })] });
    out.push({ role: 'user', content: [{ type: 'toolResult', callId: `c${i}`, text: String(i % 10).repeat(size) }] });
  }
  return out;
}

const callIds = (m: ChatMessage | undefined) => (m?.role === 'assistant' ? m.content.flatMap((p) => (p.type === 'toolCall' ? [p.callId] : [])) : []);
const resultIds = (m: ChatMessage | undefined) => (m?.role === 'user' ? m.content.flatMap((c) => (c.type === 'toolResult' ? [c.callId] : [])) : []);

/** Every tool call is answered right after it, and no result comes without its call. */
function pairsIntact(messages: ChatMessage[]): boolean {
  return messages.every((m, i) => {
    const calls = callIds(m);
    const results = resultIds(m);
    if (calls.length && calls.some((id) => !resultIds(messages[i + 1]).includes(id))) return false;
    if (results.length && results.some((id) => !callIds(messages[i - 1]).includes(id))) return false;
    return true;
  });
}

describe('compactIfNeeded', () => {
  it('leaves a conversation at 75 % of the input limit alone, and compacts one just over it', async () => {
    const messages = conversation(10);
    const estimate = estimateTokens('System.', messages, []);
    const under = fakeChatModel([], { maxInputTokens: Math.ceil(estimate / 0.75) });
    expect(await compactIfNeeded({ model: under.model, system: 'System.', messages, tools: [], signal, canSummarise: true })).toEqual({ messages, requests: 0 });
    expect(under.requests).toHaveLength(0);
    const over = fakeChatModel([[textPart('We read ten files.')]], { maxInputTokens: Math.floor(estimate / 0.75) - 1 });
    const r = await compactIfNeeded({ model: over.model, system: 'System.', messages, tools: [], signal, canSummarise: true });
    expect(r.requests).toBe(1);
    expect(r.messages.length).toBeLessThan(messages.length);
  });

  it('keeps the task and the most recent rounds, and replaces the older ones with one summary', async () => {
    const messages = conversation(10);
    const { model, requests } = fakeChatModel([[textPart('We read files 1 to 8.')]], { maxInputTokens: 1000 });
    const r = await compactIfNeeded({ model, system: 'System.', messages, tools: [], signal, canSummarise: true });
    // 40 % of 1,000 tokens holds the last two rounds (about 155 tokens each).
    expect(r).toEqual({ messages: [messages[0], userText(`${SUMMARY_PREFIX}We read files 1 to 8.`), ...messages.slice(-4)], requests: 1 });
    // One request with no tools: the system text, then the older turns as text with the summary prompt.
    expect(requests[0].tools).toEqual([]);
    expect(requests[0].messages[0]).toEqual(userText('System.'));
    expect(requests[0].messages[1].content[0]).toMatchObject({ type: 'text', text: expect.stringContaining(SUMMARY_PROMPT) });
    expect(requests[0].messages[1].content[0]).toMatchObject({ text: expect.stringContaining('User: The task.') });
  });

  it('never splits a tool call from its results, whatever the limit', async () => {
    const messages = conversation(12);
    for (let limit = 600; limit <= 2400; limit += 50) {
      const { model } = fakeChatModel([[textPart('Summary.')]], { maxInputTokens: limit });
      const r = await compactIfNeeded({ model, system: 'System.', messages, tools: [], signal, canSummarise: true });
      expect(pairsIntact(r.messages)).toBe(true);
      expect(r.messages[0]).toEqual(messages[0]);
    }
  });

  it('drops the oldest rounds with a note when the summary request fails', async () => {
    const messages = conversation(10);
    const { model } = fakeChatModel([new ChatModelError('other', 'Copilot failed: overloaded')], { maxInputTokens: 1000 });
    const r = await compactIfNeeded({ model, system: 'System.', messages, tools: [], signal, canSummarise: true });
    expect(r).toEqual({ messages: [messages[0], userText(DROPPED_NOTE), ...messages.slice(-4)], requests: 1 });
    expect(estimateTokens('System.', r.messages, [])).toBeLessThanOrEqual(750);
  });

  it('drops without a summary request when the cap leaves no room for one', async () => {
    const messages = conversation(10);
    const { model, requests } = fakeChatModel([], { maxInputTokens: 1000 });
    const r = await compactIfNeeded({ model, system: 'System.', messages, tools: [], signal, canSummarise: false });
    expect(r).toEqual({ messages: [messages[0], userText(DROPPED_NOTE), ...messages.slice(-4)], requests: 0 });
    expect(requests).toHaveLength(0);
  });

  it('passes a Stop during the summary request on', async () => {
    const ac = new AbortController();
    const { model } = fakeChatModel([(_m, _t, s) => untilAborted(s)], { maxInputTokens: 1000 });
    const pending = compactIfNeeded({ model, system: 'System.', messages: conversation(10), tools: [], signal: ac.signal, canSummarise: true });
    ac.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('runAgentLoop and compaction', () => {
  const quiet = { onText: () => {}, onToolCall: () => {}, onToolResult: () => {} };

  it('compacts before a request and counts the summary toward the cap', async () => {
    const { model, requests } = fakeChatModel([[textPart('Summary.')], [toolCallPart('c99', 'Read', { file_path: 'x' })]], { maxInputTokens: 1000 });
    const r = await runAgentLoop({ model, system: 'System.', messages: conversation(10), tools: [], gate: allowAll, maxRequests: 2, signal, ...quiet });
    expect(requests).toHaveLength(2);
    expect(requests[1].messages[2]).toEqual(userText(`${SUMMARY_PREFIX}Summary.`));
    expect(r).toMatchObject({ ok: false, capped: true, requests: 2, error: 'Stopped after 2 model requests.' });
  });

  it('never sends more than maxRequests when compaction is due at the last request', async () => {
    const { model, requests } = fakeChatModel([[textPart('Done.')]], { maxInputTokens: 1000 });
    const r = await runAgentLoop({ model, system: 'System.', messages: conversation(10), tools: [], gate: allowAll, maxRequests: 1, signal, ...quiet });
    expect(requests).toHaveLength(1);
    expect(requests[0].messages[2]).toEqual(userText(DROPPED_NOTE));
    expect(r).toMatchObject({ ok: true, text: 'Done.', requests: 1 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w engine -- test/compact.test.ts`
Expected: FAIL with "Failed to load url ../src/agentLoop/compact".

- [ ] **Step 3: Write the implementation**

Create `engine/src/agentLoop/compact.ts`:

```ts
import type { ChatMessage, ChatModel, ToolSpec } from './chatModel';
import { clipResult } from './tools';

export const SUMMARY_PROMPT = 'Summarise the conversation so far for yourself: decisions, files changed, open questions. Keep it under 300 words.';
export const SUMMARY_PREFIX = 'Summary of earlier turns: ';
export const DROPPED_NOTE = "Earlier turns were dropped to fit the model's context.";

const COMPACT_AT = 0.75;
const KEEP_RECENT = 0.4;
/** How much of the input limit the summary request's transcript may use (ruling R6). */
const SUMMARY_INPUT_SHARE = 0.6;
const RESULT_CHARS_IN_SUMMARY = 2000;

const tokens = (chars: number) => Math.ceil(chars / 4);
const userText = (text: string): ChatMessage => ({ role: 'user', content: [{ type: 'text', text }] });

/** ceil(chars / 4) over the system text, the messages and the tool specs (spec §4.6, ruling R7). */
export function estimateTokens(system: string, messages: ChatMessage[], tools: ToolSpec[]): number {
  return tokens(system.length + JSON.stringify(messages).length + JSON.stringify(tools).length);
}

/** Messages grouped so a tool call and its results stay together: an assistant message with calls and the results after it. */
function rounds(messages: ChatMessage[]): ChatMessage[][] {
  const out: ChatMessage[][] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const next = messages[i + 1];
    const calls = m.role === 'assistant' && m.content.some((p) => p.type === 'toolCall');
    if (calls && next?.role === 'user' && next.content.some((c) => c.type === 'toolResult')) {
      out.push([m, next]);
      i++;
    } else out.push([m]);
  }
  return out;
}

/** The older turns as plain text for the summary request (ruling R6): no tool parts, so a request without tools is valid everywhere. */
function transcriptText(messages: ChatMessage[]): string {
  return messages
    .map((m) =>
      m.role === 'assistant'
        ? m.content.map((p) => (p.type === 'text' ? `Assistant: ${p.text}` : `Assistant called ${p.name} ${JSON.stringify(p.input)}`)).join('\n')
        : m.content.map((c) => (c.type === 'text' ? `User: ${c.text}` : `Tool result${c.isError ? ' (error)' : ''}: ${clipResult(c.text, RESULT_CHARS_IN_SUMMARY)}`)).join('\n'),
    )
    .join('\n\n');
}

/** The summary text, or undefined when the request failed or came back empty. A Stop is passed on. */
async function summarise(model: ChatModel, system: string, messages: ChatMessage[], signal: AbortSignal): Promise<string | undefined> {
  const conversation = clipResult(transcriptText(messages), Math.floor(model.maxInputTokens * SUMMARY_INPUT_SHARE * 4));
  try {
    let text = '';
    for await (const part of model.send([userText(system), userText(`${conversation}\n\n${SUMMARY_PROMPT}`)], [], signal)) if (part.type === 'text') text += part.text;
    return text.trim() || undefined;
  } catch (e) {
    if (signal.aborted) throw e;
    return undefined;
  }
}

/**
 * Compaction (spec §4.6): over 75 % of the model's input limit, keep the first message (the task) and the most recent
 * rounds up to 40 % of the limit, and replace the older ones with one summary. Still too long, or no summary (it failed,
 * or `canSummarise` is false because the request cap has no room for it): drop the oldest kept rounds, with a note.
 * The newest round is always kept, and a tool call is never separated from its results.
 */
export async function compactIfNeeded(o: {
  model: ChatModel;
  system: string;
  messages: ChatMessage[];
  tools: ToolSpec[];
  signal: AbortSignal;
  canSummarise: boolean;
}): Promise<{ messages: ChatMessage[]; requests: number }> {
  const limit = o.model.maxInputTokens;
  const fits = (messages: ChatMessage[]) => estimateTokens(o.system, messages, o.tools) <= COMPACT_AT * limit;
  if (o.messages.length < 2 || fits(o.messages)) return { messages: o.messages, requests: 0 };
  const [first, ...rest] = o.messages;
  const all = rounds(rest);
  let kept = 0;
  let budget = KEEP_RECENT * limit;
  for (let i = all.length - 1; i >= 0; i--) {
    const cost = tokens(JSON.stringify(all[i]).length);
    if (kept > 0 && cost > budget) break;
    kept++;
    budget -= cost;
  }
  const older = all.slice(0, all.length - kept).flat();
  let tail = all.slice(all.length - kept);
  let requests = 0;
  let summary: string | undefined;
  if (older.length > 0 && o.canSummarise) {
    requests = 1;
    summary = await summarise(o.model, o.system, [first, ...older], o.signal);
  }
  const head: ChatMessage[] = summary === undefined ? [first] : [first, userText(SUMMARY_PREFIX + summary)];
  const build = () => [...head, ...tail.flat()];
  if (summary !== undefined && fits(build())) return { messages: build(), requests };
  head.push(userText(DROPPED_NOTE));
  while (tail.length > 1 && !fits(build())) tail = tail.slice(1);
  return { messages: build(), requests };
}
```

In `engine/src/agentLoop/loop.ts`, add the import:

```ts
import { compactIfNeeded } from './compact';
```

and in `runAgentLoop`, replace

```ts
      o.signal.throwIfAborted();
      const parts: ChatPart[] = [];
      requests++;
```

with

```ts
      o.signal.throwIfAborted();
      // A summary only when it and the real request both fit under the cap (ruling R5).
      const compacted = await compactIfNeeded({ model: o.model, system: o.system, messages, tools: specs, signal: o.signal, canSummarise: requests + 1 < o.maxRequests });
      requests += compacted.requests;
      messages = compacted.messages;
      const parts: ChatPart[] = [];
      requests++;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -w engine -- test/compact.test.ts test/agentLoop.test.ts`
Expected: PASS. The loop tests' conversations are far below the fake model's 100,000-token default, so they never compact.

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck -w engine`
Expected: no errors.

```bash
git add engine/src/agentLoop/compact.ts engine/src/agentLoop/loop.ts engine/test/compact.test.ts
git commit -m "feat(engine): compact long agent-loop histories

Over 75 % of the model's input limit, older rounds become one summary (one
request, counted toward the cap) or are dropped with a note; the task and
the newest rounds stay, and tool calls never lose their results.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Planner transcripts

**Spec tests owned (§8):**
- Transcripts: save and load, New chat clears, a missing file means `resumeFailed`. The engine half is here; the Copilot half of `resumeFailed` is in Task 9.

It also pins Review Focus 5.

**Files:**
- Create: `engine/src/transcripts.ts`
- Modify: `engine/src/providers/types.ts` (`TranscriptStore`, `PlannerTurn.transcript`); `engine/src/sessionStore.ts` (`transcripts`, `clearPlanner`, `removeGraph`); `engine/src/planner.ts` (`send`); `engine/src/index.ts` (type exports)
- Modify (mechanical, a new required field): `engine/test/claudeModels.test.ts:54-63` and `engine/test/claudePlanTurn.test.ts:57-66` (the `turn()` helpers)
- Test: `engine/test/transcripts.test.ts` (new); `engine/test/planner.test.ts`, `engine/test/sessionStore.test.ts` (append)

**Interfaces:**
- Consumes: `ChatMessage` (Task 2); `writeFileAtomic`, `isGraphId`.
- Produces:
  ```ts
  // engine/src/providers/types.ts
  export interface TranscriptStore { load(id: string): ChatMessage[] | undefined; save(id: string, messages: ChatMessage[]): void }
  // PlannerTurn gains: transcript: TranscriptStore;
  // engine/src/transcripts.ts
  export const CONVERSATION_ID_RE: RegExp;   // /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
  export class Transcripts {
    constructor(dir: string);
    load(graphId: string, provider: ProviderId, id: string): ChatMessage[] | undefined;
    save(graphId: string, provider: ProviderId, id: string, messages: ChatMessage[]): void;   // throws on a bad graph or conversation id
    clear(graphId: string): void;   // every provider's transcripts of the graph
  }
  // engine/src/sessionStore.ts
  // SessionStore.transcripts(id: string): Transcripts   — sessions/<id>/transcripts/
  // engine/src/index.ts: PlannerEvent and TranscriptStore join the provider type exports
  ```

- [ ] **Step 1: Write the failing tests**

Create `engine/test/transcripts.test.ts`:

```ts
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../src/agentLoop/chatModel';
import { Transcripts } from '../src/transcripts';
import { textPart, toolCallPart, userText } from './helpers';

const folder = () => join(mkdtempSync(join(tmpdir(), 'transcripts-')), 'transcripts');
const messages: ChatMessage[] = [
  userText('Plan a build.'),
  { role: 'assistant', content: [textPart('Reading.'), toolCallPart('c1', 'Read', { file_path: 'package.json' })] },
  { role: 'user', content: [{ type: 'toolResult', callId: 'c1', text: 'File not found', isError: true }] },
];

describe('Transcripts', () => {
  it('saves and loads a conversation per graph, provider and id, also after a reload', () => {
    const dir = folder();
    const t = new Transcripts(dir);
    t.save('g', 'copilot', 'conv-1', messages);
    expect(existsSync(join(dir, 'g.copilot.conv-1.json'))).toBe(true);
    expect(t.load('g', 'copilot', 'conv-1')).toEqual(messages);
    expect(new Transcripts(dir).load('g', 'copilot', 'conv-1')).toEqual(messages);
    expect(t.load('g', 'claude', 'conv-1')).toBeUndefined();
    expect(t.load('g', 'copilot', 'conv-2')).toBeUndefined();
  });

  it('reads a missing, unreadable or malformed file as missing', () => {
    const dir = folder();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'g.copilot.torn.json'), '[{"role":"user"');
    writeFileSync(join(dir, 'g.copilot.odd.json'), JSON.stringify([{ role: 'system', content: [] }]));
    const t = new Transcripts(dir);
    expect(t.load('g', 'copilot', 'none')).toBeUndefined();
    expect(t.load('g', 'copilot', 'torn')).toBeUndefined();
    expect(t.load('g', 'copilot', 'odd')).toBeUndefined();
  });

  it('refuses ids that could leave the folder', () => {
    const t = new Transcripts(folder());
    expect(t.load('g', 'copilot', '../escape')).toBeUndefined();
    expect(() => t.save('g', 'copilot', '../escape', messages)).toThrow('invalid conversation id "../escape"');
    expect(() => t.save('../g', 'copilot', 'c', messages)).toThrow('invalid graph id "../g"');
  });

  it("clears every provider's transcripts of one graph, and only that graph", () => {
    const dir = folder();
    const t = new Transcripts(dir);
    t.save('g', 'copilot', 'a', messages);
    t.save('g', 'claude', 'b', messages);
    t.save('g-2', 'copilot', 'c', messages);
    t.clear('g');
    expect(readdirSync(dir)).toEqual(['g-2.copilot.c.json']);
    new Transcripts(folder()).clear('g'); // no folder yet: nothing to do
  });
});
```

Append to `engine/test/sessionStore.test.ts`, inside `describe('SessionStore', …)`:

```ts
  it("keeps transcripts in the session's folder, clears them on New chat and when their graph is removed", () => {
    const { paths, store } = setup();
    const a = store.create('A');
    const hi = [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hi' }] }];
    store.transcripts(a.id).save('g1', 'copilot', 'c', hi);
    expect(existsSync(join(paths.sessionsDir, a.id, 'transcripts', 'g1.copilot.c.json'))).toBe(true);
    store.clearPlanner(a.id, 'g1');
    expect(store.transcripts(a.id).load('g1', 'copilot', 'c')).toBeUndefined();
    store.transcripts(a.id).save('g1', 'copilot', 'c', hi);
    store.removeGraph('g1');
    expect(store.transcripts(a.id).load('g1', 'copilot', 'c')).toBeUndefined();
  });
```

In `engine/test/planner.test.ts`, change the first import line to `import { join, resolve } from 'node:path';`, add `import { existsSync } from 'node:fs';`, add `userText` to the `./helpers` import, and append inside `describe('Planner', …)`:

```ts
  it('gives each turn a transcript store kept per session, graph and provider', async () => {
    const history = [userText('first'), { role: 'assistant' as const, content: [{ type: 'text' as const, text: 'ok' }] }];
    const s = setup([
      async (t) => {
        t.transcript.save('conv-1', history);
        return { ok: true, sessionId: 'conv-1' };
      },
      async (t) => ({ ok: true, sessionId: t.resume }),
      async () => ({ ok: true, sessionId: 'other' }),
    ]);
    await s.planner.send('a', s.graphId, 'one');
    expect(existsSync(join(s.paths.sessionsDir, 'a', 'transcripts', `${s.graphId}.claude.conv-1.json`))).toBe(true);
    await s.planner.send('a', s.graphId, 'two');
    expect(s.seen[1].resume).toBe('conv-1');
    expect(s.seen[1].transcript.load('conv-1')).toEqual(history);
    await s.planner.send('b', s.graphId, 'three');
    expect(s.seen[2].transcript.load('conv-1')).toBeUndefined();
  });

  it("New chat deletes the conversation's transcripts", async () => {
    const s = setup([
      async (t) => {
        t.transcript.save('conv-1', [userText('first')]);
        return { ok: true, sessionId: 'conv-1' };
      },
    ]);
    await s.planner.send('a', s.graphId, 'one');
    const file = join(s.paths.sessionsDir, 'a', 'transcripts', `${s.graphId}.claude.conv-1.json`);
    expect(existsSync(file)).toBe(true);
    expect(s.planner.newChat('a', s.graphId)).toEqual({ ok: true });
    expect(existsSync(file)).toBe(false);
  });

  it('starts fresh when the provider finds no transcript to resume', async () => {
    const s = setup([
      async () => ({ ok: true, sessionId: 'conv-1' }),
      async (t) => (t.resume && !t.transcript.load(t.resume) ? { ok: false, error: 'The earlier Copilot conversation was not found.', resumeFailed: true } : { ok: true }),
    ]);
    await s.planner.send('a', s.graphId, 'one');
    await s.planner.send('a', s.graphId, 'two');
    expect(s.chat().at(-1)).toMatchObject({ role: 'error', text: `The earlier Copilot conversation was not found.${RESET_NOTE}` });
    expect(s.state().sessionId).toBeUndefined();
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w engine -- test/transcripts.test.ts test/sessionStore.test.ts test/planner.test.ts`
Expected: FAIL with "Failed to load url ../src/transcripts", "store.transcripts is not a function", and "Cannot read properties of undefined (reading 'save')" (no `t.transcript`).

- [ ] **Step 3: Write the implementation**

Create `engine/src/transcripts.ts`:

```ts
import { mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { ProviderId } from '@agent-stream/shared';
import type { ChatMessage } from './agentLoop/chatModel';
import { writeFileAtomic } from './fsutil';
import { isGraphId } from './paths';

/** Conversation ids become file names (ruling R15). */
export const CONVERSATION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

const textPart = z.object({ type: z.literal('text'), text: z.string() });
const messagesSchema = z.array(
  z.union([
    z.object({
      role: z.literal('user'),
      content: z.array(z.union([textPart, z.object({ type: z.literal('toolResult'), callId: z.string(), text: z.string(), isError: z.boolean().optional() })])),
    }),
    z.object({
      role: z.literal('assistant'),
      content: z.array(z.union([textPart, z.object({ type: z.literal('toolCall'), callId: z.string(), name: z.string(), input: z.unknown() })])),
    }),
  ]),
);

/**
 * A session's planner transcripts (spec §6), for providers without a server-side session:
 * `<dir>/<graphId>.<providerId>.<conversationId>.json`, written atomically. Personal and git-ignored with `sessions/`.
 */
export class Transcripts {
  constructor(private dir: string) {}

  private file(graphId: string, provider: ProviderId, id: string): string {
    return join(this.dir, `${graphId}.${provider}.${id}.json`);
  }

  /** The conversation's messages; undefined when it is missing, unreadable, malformed, or its id isn't valid. */
  load(graphId: string, provider: ProviderId, id: string): ChatMessage[] | undefined {
    if (!isGraphId(graphId) || !CONVERSATION_ID_RE.test(id)) return undefined;
    try {
      const parsed = messagesSchema.safeParse(JSON.parse(readFileSync(this.file(graphId, provider, id), 'utf8')));
      return parsed.success ? (parsed.data as ChatMessage[]) : undefined;
    } catch {
      return undefined;
    }
  }

  save(graphId: string, provider: ProviderId, id: string, messages: ChatMessage[]): void {
    if (!isGraphId(graphId)) throw new Error(`invalid graph id "${graphId}"`);
    if (!CONVERSATION_ID_RE.test(id)) throw new Error(`invalid conversation id "${id}"`);
    mkdirSync(this.dir, { recursive: true });
    writeFileAtomic(this.file(graphId, provider, id), `${JSON.stringify(messages)}\n`);
  }

  /** Every transcript of the graph, for any provider (ruling R14). Graph ids have no dots, so `g.` never matches `g-2.`. */
  clear(graphId: string): void {
    if (!isGraphId(graphId)) return;
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return;
    }
    for (const name of names) if (name.startsWith(`${graphId}.`) && name.endsWith('.json')) rmSync(join(this.dir, name), { force: true });
  }
}
```

In `engine/src/providers/types.ts`, add the import `import type { ChatMessage } from '../agentLoop/chatModel';`, add before `export type PlannerTurn`:

```ts
/** A planner conversation's messages, offered to providers that have no server-side session (spec §6). Claude ignores it. */
export interface TranscriptStore {
  load(id: string): ChatMessage[] | undefined;
  save(id: string, messages: ChatMessage[]): void;
}
```

and add this field to `PlannerTurn`, after `gate: ToolGate;`:

```ts
  /** This conversation's stored messages, per session, graph and provider. */
  transcript: TranscriptStore;
```

In `engine/src/sessionStore.ts`:
- add `import { Transcripts } from './transcripts';`;
- add `this.transcripts(id).clear(graphId);` as the last line of `clearPlanner`;
- add `this.transcripts(s.id).clear(graphId);` right after `this.chatLog(s.id).clear(graphId);` in `removeGraph`;
- add this method right after `chatLog(id)`:

```ts
  /** The session's planner transcripts (spec §6): sessions/<id>/transcripts/. */
  transcripts(id: string): Transcripts {
    if (!isSessionId(id)) throw new Error(`invalid session id "${id}"`);
    return new Transcripts(join(this.dir(id), 'transcripts'));
  }
```

In `engine/src/planner.ts`, in `send`, right after `const state = this.d.sessions.plannerState(sessionId, graphId);` add:

```ts
      const transcripts = this.d.sessions.transcripts(sessionId);
```

and in the `provider.planTurn({ … })` argument, right after the `gate: createPlannerGate(…),` line add:

```ts
        transcript: { load: (id) => transcripts.load(graphId, provider.id, id), save: (id, messages) => transcripts.save(graphId, provider.id, id, messages) },
```

In `engine/src/index.ts`, replace `export type { AgentProvider, GraphTool, PlannerTurn, PlannerTurnResult } from './providers/types';` with:

```ts
export type { AgentProvider, GraphTool, PlannerEvent, PlannerTurn, PlannerTurnResult, TranscriptStore } from './providers/types';
```

In `engine/test/claudeModels.test.ts` and `engine/test/claudePlanTurn.test.ts`, add this line to the object returned by `turn()`, right before `...over,`:

```ts
  transcript: { load: () => undefined, save: () => {} },
```

(In `claudePlanTurn.test.ts` the helper is indented one level deeper. Claude ignores `transcript`; these tests change no assertion.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -w engine -- test/transcripts.test.ts test/sessionStore.test.ts test/planner.test.ts test/claudeModels.test.ts test/claudePlanTurn.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the engine suite, typecheck and commit**

Run: `npm test -w engine && npm run typecheck -w engine && npm run typecheck -w extension`
Expected: PASS, and no type errors (the extension builds no `PlannerTurn` literal).

```bash
git add engine/src/transcripts.ts engine/src/providers/types.ts engine/src/sessionStore.ts engine/src/planner.ts engine/src/index.ts engine/test/transcripts.test.ts engine/test/sessionStore.test.ts engine/test/planner.test.ts engine/test/claudeModels.test.ts engine/test/claudePlanTurn.test.ts
git commit -m "feat(engine): planner transcripts for providers without a server session

PlannerTurn.transcript loads and saves a conversation's messages under
sessions/<id>/transcripts/<graph>.<provider>.<id>.json, atomically. New chat
and removing a graph delete them; bad ids and damaged files read as missing.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: The `vscode.lm` adapter and the Copilot error messages

**Spec tests owned (§8):** "adapter conversions both ways and error-code mapping".

**Files:**
- Create: `extension/src/providers/copilotModel.ts`
- Modify: `extension/test/vscode.ts` (Language Model classes); `extension/test/helpers.ts` (`fakeLmModel`)
- Test: `extension/test/copilotModel.test.ts`

**Interfaces:**
- Consumes: `ChatModel`, `ChatMessage`, `ChatPart`, `ToolSpec`, `ChatModelError`, `ChatModelErrorCode` from `@agent-stream/engine` (exported in Task 5).
- Produces:
  ```ts
  // extension/src/providers/copilotModel.ts
  export const JUSTIFICATION = 'Agent Stream runs your workflow steps on Copilot.';
  export const COPILOT_PERMISSION: string;   // §5.4 permission text
  export function copilotErrorMessage(code: ChatModelErrorCode, detail: string, modelId: string): string;
  export function toChatModelError(e: unknown, modelId: string): ChatModelError;
  export function toLanguageModelMessage(m: ChatMessage): vscode.LanguageModelChatMessage;
  export function vscodeChatModel(model: vscode.LanguageModelChat): ChatModel;
  // extension/test/helpers.ts
  export function fakeLmModel(o: { id: string; name?: string; maxInputTokens?: number; toolCalling?: boolean; replies?: (unknown[] | Error)[] }): {
    model: vscode.LanguageModelChat;
    requests: { messages: vscode.LanguageModelChatMessage[]; options?: vscode.LanguageModelChatRequestOptions; token?: vscode.CancellationToken }[];
    sendRequest: Mock;
  };
  ```
  In a reply, an `Error` item is thrown from the stream at that point; a reply that is itself an `Error` rejects `sendRequest`; no reply left answers `[TextPart('ok')]`.

- [ ] **Step 1: Extend the `vscode` mock and add `fakeLmModel`**

Append to `extension/test/vscode.ts`:

```ts
export enum LanguageModelChatMessageRole {
  User = 1,
  Assistant = 2,
}
export class LanguageModelTextPart {
  constructor(public value: string) {}
}
export class LanguageModelToolCallPart {
  constructor(
    public callId: string,
    public name: string,
    public input: object,
  ) {}
}
export class LanguageModelToolResultPart {
  constructor(
    public callId: string,
    public content: unknown[],
  ) {}
}
export class LanguageModelDataPart {
  constructor(
    public data: Uint8Array,
    public mimeType: string,
  ) {}
}
export class LanguageModelChatMessage {
  constructor(
    public role: LanguageModelChatMessageRole,
    public content: unknown[] | string,
    public name?: string,
  ) {}
  static User(content: unknown[] | string, name?: string) {
    return new LanguageModelChatMessage(LanguageModelChatMessageRole.User, content, name);
  }
  static Assistant(content: unknown[] | string, name?: string) {
    return new LanguageModelChatMessage(LanguageModelChatMessageRole.Assistant, content, name);
  }
}
/** As in VS Code: `code` is the factory's name ('NoPermissions', 'Blocked', 'NotFound'). */
export class LanguageModelError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'LanguageModelError';
  }
  static NoPermissions(message = '') {
    return new LanguageModelError(message, 'NoPermissions');
  }
  static Blocked(message = '') {
    return new LanguageModelError(message, 'Blocked');
  }
  static NotFound(message = '') {
    return new LanguageModelError(message, 'NotFound');
  }
}
export class CancellationTokenSource {
  private listeners: (() => void)[] = [];
  readonly token = {
    isCancellationRequested: false,
    onCancellationRequested: (listener: () => void) => {
      this.listeners.push(listener);
      return { dispose: () => {} };
    },
  };
  cancel(): void {
    if (this.token.isCancellationRequested) return;
    this.token.isCancellationRequested = true;
    for (const l of this.listeners) l();
  }
  dispose(): void {
    this.listeners = [];
  }
}
```

In `extension/test/helpers.ts`, add `import { vi } from 'vitest';` and `import * as vscode from 'vscode';` to the imports, then append:

```ts
type LmRequest = { messages: vscode.LanguageModelChatMessage[]; options?: vscode.LanguageModelChatRequestOptions; token?: vscode.CancellationToken };

/**
 * A Copilot model as vscode.lm returns it (the vscode mock's classes), answering each request from `replies`:
 * parts to stream (an Error item is thrown at that point), or an Error that rejects the request. No real Copilot.
 */
export function fakeLmModel(o: { id: string; name?: string; maxInputTokens?: number; toolCalling?: boolean; replies?: (unknown[] | Error)[] }) {
  const requests: LmRequest[] = [];
  const replies = [...(o.replies ?? [])];
  const sendRequest = vi.fn(async (messages: vscode.LanguageModelChatMessage[], options?: vscode.LanguageModelChatRequestOptions, token?: vscode.CancellationToken) => {
    requests.push({ messages, options, token });
    const reply = replies.shift() ?? [new vscode.LanguageModelTextPart('ok')];
    if (reply instanceof Error) throw reply;
    async function* stream() {
      for (const part of reply as unknown[]) {
        if (part instanceof Error) throw part;
        yield part;
      }
    }
    return { stream: stream(), text: (async function* () {})() };
  });
  const model = {
    id: o.id,
    name: o.name ?? o.id,
    vendor: 'copilot',
    family: o.id,
    version: '1',
    maxInputTokens: o.maxInputTokens ?? 100_000,
    capabilities: { supportsToolCalling: o.toolCalling ?? true },
    countTokens: async () => 0,
    sendRequest,
  };
  return { model: model as unknown as vscode.LanguageModelChat, requests, sendRequest };
}
```

- [ ] **Step 2: Write the failing test**

Create `extension/test/copilotModel.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { ChatModelError, type ChatMessage, type ChatPart } from '@agent-stream/engine';
import { COPILOT_PERMISSION, JUSTIFICATION, vscodeChatModel } from '../src/providers/copilotModel';
import { fakeLmModel } from './helpers';

const live = () => new AbortController().signal;
async function collect(parts: AsyncIterable<ChatPart>, into: ChatPart[] = []): Promise<ChatPart[]> {
  for await (const p of parts) into.push(p);
  return into;
}

describe('vscodeChatModel', () => {
  it('sends our messages as Language Model messages, with the tools and the justification', async () => {
    const fake = fakeLmModel({ id: 'auto', maxInputTokens: 900_000 });
    const model = vscodeChatModel(fake.model);
    expect(model).toMatchObject({ id: 'auto', maxInputTokens: 900_000 });
    const messages: ChatMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'Do it.' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Reading.' }, { type: 'toolCall', callId: 'c1', name: 'Read', input: { file_path: 'a.txt' } }] },
      { role: 'user', content: [{ type: 'toolResult', callId: 'c1', text: '     1\thello' }] },
    ];
    const tools = [{ name: 'Read', description: 'Read a file.', inputSchema: { type: 'object' } }];
    await collect(model.send(messages, tools, live()));
    const [request] = fake.requests;
    expect(request.messages).toEqual([
      vscode.LanguageModelChatMessage.User([new vscode.LanguageModelTextPart('Do it.')]),
      vscode.LanguageModelChatMessage.Assistant([new vscode.LanguageModelTextPart('Reading.'), new vscode.LanguageModelToolCallPart('c1', 'Read', { file_path: 'a.txt' })]),
      vscode.LanguageModelChatMessage.User([new vscode.LanguageModelToolResultPart('c1', [new vscode.LanguageModelTextPart('     1\thello')])]),
    ]);
    expect(request.options).toEqual({ tools, justification: JUSTIFICATION });
    expect(JUSTIFICATION).toBe('Agent Stream runs your workflow steps on Copilot.');
  });

  it('yields text and tool-call parts and ignores every other part', async () => {
    const fake = fakeLmModel({
      id: 'auto',
      replies: [
        [
          new vscode.LanguageModelTextPart('Hel'),
          new vscode.LanguageModelTextPart('lo'),
          { kind: 'thinking', value: '…' },
          new vscode.LanguageModelDataPart(new Uint8Array([1]), 'application/json'),
          new vscode.LanguageModelToolCallPart('c1', 'Grep', { pattern: 'x' }),
        ],
      ],
    });
    expect(await collect(vscodeChatModel(fake.model).send([], [], live()))).toEqual([
      { type: 'text', text: 'Hel' },
      { type: 'text', text: 'lo' },
      { type: 'toolCall', callId: 'c1', name: 'Grep', input: { pattern: 'x' } },
    ]);
  });

  it.each([
    [vscode.LanguageModelError.NoPermissions('no consent'), 'permission', COPILOT_PERMISSION],
    [vscode.LanguageModelError.Blocked('monthly quota reached'), 'blocked', 'Copilot refused the request (quota or policy): monthly quota reached'],
    [vscode.LanguageModelError.NotFound('gone'), 'notFound', 'The Copilot model gpt-5.6-luna is no longer available. Pick another model.'],
    [new Error('socket hang up'), 'other', 'Copilot failed: socket hang up'],
  ])('maps a refused request to a ChatModelError with the user-facing message (%#)', async (error, code, message) => {
    const fake = fakeLmModel({ id: 'gpt-5.6-luna', replies: [error] });
    const sent = collect(vscodeChatModel(fake.model).send([], [], live()));
    await expect(sent).rejects.toBeInstanceOf(ChatModelError);
    await expect(sent).rejects.toMatchObject({ code, message });
  });

  it('spells the permission message as the spec does', () => {
    expect(COPILOT_PERMISSION).toBe("Agent Stream isn't allowed to use Copilot. Run the step again and choose Allow, or enable it under Accounts › Manage Language Model Access.");
  });

  it('maps an error that ends the stream midway, after the parts before it', async () => {
    const fake = fakeLmModel({ id: 'auto', replies: [[new vscode.LanguageModelTextPart('par'), vscode.LanguageModelError.Blocked('rate limited')]] });
    const parts: ChatPart[] = [];
    await expect(collect(vscodeChatModel(fake.model).send([], [], live()), parts)).rejects.toMatchObject({
      code: 'blocked',
      message: 'Copilot refused the request (quota or policy): rate limited',
    });
    expect(parts).toEqual([{ type: 'text', text: 'par' }]);
  });

  it('cancels the request when the signal aborts, and ends as an abort', async () => {
    const ac = new AbortController();
    const fake = fakeLmModel({ id: 'auto', replies: [[new vscode.LanguageModelTextPart('a'), new vscode.LanguageModelTextPart('b')]] });
    const parts: ChatPart[] = [];
    const run = (async () => {
      for await (const p of vscodeChatModel(fake.model).send([], [], ac.signal)) {
        parts.push(p);
        ac.abort();
      }
    })();
    await expect(run).rejects.toMatchObject({ name: 'AbortError' });
    expect(parts).toEqual([{ type: 'text', text: 'a' }]);
    expect(fake.requests[0].token?.isCancellationRequested).toBe(true);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -w extension -- test/copilotModel.test.ts`
Expected: FAIL with "Failed to load url ../src/providers/copilotModel".

- [ ] **Step 4: Write the implementation**

Create `extension/src/providers/copilotModel.ts`:

```ts
import * as vscode from 'vscode';
import { ChatModelError, type ChatMessage, type ChatModel, type ChatModelErrorCode, type ChatPart, type ToolSpec } from '@agent-stream/engine';

export const JUSTIFICATION = 'Agent Stream runs your workflow steps on Copilot.';
export const COPILOT_PERMISSION = "Agent Stream isn't allowed to use Copilot. Run the step again and choose Allow, or enable it under Accounts › Manage Language Model Access.";

/** The text the user sees for each Copilot error (spec §5.4). */
export function copilotErrorMessage(code: ChatModelErrorCode, detail: string, modelId: string): string {
  switch (code) {
    case 'permission':
      return COPILOT_PERMISSION;
    case 'blocked':
      return `Copilot refused the request (quota or policy): ${detail}`;
    case 'notFound':
      return `The Copilot model ${modelId} is no longer available. Pick another model.`;
    case 'other':
      return `Copilot failed: ${detail}`;
  }
}

const CODES: Record<string, ChatModelErrorCode> = { NoPermissions: 'permission', Blocked: 'blocked', NotFound: 'notFound' };

/** A vscode.LanguageModelError by its code; anything else is `other` (spec §5.1). */
export function toChatModelError(e: unknown, modelId: string): ChatModelError {
  if (e instanceof ChatModelError) return e;
  const code = e instanceof vscode.LanguageModelError ? (CODES[e.code] ?? 'other') : 'other';
  const detail = (e instanceof Error && e.message) || String(e);
  return new ChatModelError(code, copilotErrorMessage(code, detail, modelId));
}

const asObject = (input: unknown): object => (typeof input === 'object' && input !== null ? input : {});

/** One of our messages as a Language Model message (spec §5.1). Tool errors travel as plain text (ruling R26). */
export function toLanguageModelMessage(m: ChatMessage): vscode.LanguageModelChatMessage {
  if (m.role === 'assistant') {
    return vscode.LanguageModelChatMessage.Assistant(
      m.content.map((p) => (p.type === 'text' ? new vscode.LanguageModelTextPart(p.text) : new vscode.LanguageModelToolCallPart(p.callId, p.name, asObject(p.input)))),
    );
  }
  return vscode.LanguageModelChatMessage.User(
    m.content.map((c) => (c.type === 'text' ? new vscode.LanguageModelTextPart(c.text) : new vscode.LanguageModelToolResultPart(c.callId, [new vscode.LanguageModelTextPart(c.text)]))),
  );
}

/** A Copilot model behind the engine's ChatModel (spec §5.1). Thinking and data parts are ignored. */
export function vscodeChatModel(model: vscode.LanguageModelChat): ChatModel {
  return {
    id: model.id,
    maxInputTokens: model.maxInputTokens,
    async *send(messages: ChatMessage[], tools: ToolSpec[], signal: AbortSignal): AsyncGenerator<ChatPart> {
      const cancellation = new vscode.CancellationTokenSource();
      const onAbort = () => cancellation.cancel();
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
      try {
        let stream: AsyncIterable<unknown>;
        try {
          const response = await model.sendRequest(
            messages.map(toLanguageModelMessage),
            { tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })), justification: JUSTIFICATION },
            cancellation.token,
          );
          stream = response.stream;
        } catch (e) {
          signal.throwIfAborted();
          throw toChatModelError(e, model.id);
        }
        const parts = stream[Symbol.asyncIterator]();
        for (;;) {
          signal.throwIfAborted();
          let next: IteratorResult<unknown>;
          try {
            next = await parts.next();
          } catch (e) {
            signal.throwIfAborted();
            throw toChatModelError(e, model.id);
          }
          if (next.done) break;
          const part = next.value;
          if (part instanceof vscode.LanguageModelTextPart) yield { type: 'text', text: part.value };
          else if (part instanceof vscode.LanguageModelToolCallPart) yield { type: 'toolCall', callId: part.callId, name: part.name, input: part.input };
        }
        signal.throwIfAborted();
      } finally {
        signal.removeEventListener('abort', onAbort);
        cancellation.dispose();
      }
    },
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -w extension -- test/copilotModel.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck and commit**

Run: `npm run typecheck -w extension`
Expected: no errors.

```bash
git add extension/src/providers/copilotModel.ts extension/test/vscode.ts extension/test/helpers.ts extension/test/copilotModel.test.ts
git commit -m "feat(extension): a vscode.lm adapter for the agent loop

vscodeChatModel converts messages and tool parts both ways, cancels the
request on Stop, ignores thinking and data parts, and turns
LanguageModelError codes into the spec's Copilot messages.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: The Copilot provider — models, status and consent, `runStep`, `planTurn`

**Spec tests owned (§8):**
- model filtering and sorting (`auto` first, `copilot-*` hidden);
- Default resolves to Auto;
- status with the consent unknown, refused or given;
- `runStep` emits `start`, `text`, `tool_call` and `tool_result` and returns the outcome and usage;
- `planTurn` resumes from the transcript and returns `sessionId`;
- the Copilot half of "a missing file means `resumeFailed`";
- §7's rows for declined consent, the request cap and Stop.

**Files:**
- Modify: `extension/src/providers/copilot.ts` (whole file); `engine/src/providers/types.ts` (`AgentProvider.stepRequestCap?`, `modelInUse?`)
- Test: `extension/test/copilot.test.ts` (whole file: the scaffold's tests are retired with the scaffold, §5.5)

**Interfaces:**
- Consumes:
  - `runAgentLoop`, `lastAssistantText`, `builtinTools`, `toLoopTools`, `RunShell` and the types from `@agent-stream/engine` (Tasks 1–7);
  - `isWriteCapable` from `@agent-stream/shared`;
  - `vscodeChatModel`, `COPILOT_PERMISSION` (Task 8);
  - `fakeLmModel` (Task 8).
- Produces:
  ```ts
  // engine/src/providers/types.ts — AgentProvider gains:
  stepRequestCap?(): number;
  modelInUse?(model: string | undefined): ModelChoice | undefined;
  // extension/src/providers/copilot.ts
  export const COPILOT_UNAVAILABLE: string;      // unchanged text
  export const COPILOT_CONSENT_LATER = 'Copilot will ask for permission the first time a run or chat uses it.';
  export const COPILOT_RESUME_FAILED = 'The earlier Copilot conversation was not found.';
  export const AUTO_MODEL = 'auto';
  export const stepPreamble: (cwd: string) => string;
  export const copilotCapMessage: (n: number, setting: 'maxRequestsPerStep' | 'maxRequestsPerTurn') => string;
  export const requestLine: (n: number, cap: number) => string;
  export type LmApi = { selectChatModels(selector: { vendor: string }): Thenable<readonly vscode.LanguageModelChat[]> };
  export type LmAccess = { canSendRequest(model: vscode.LanguageModelChat): boolean | undefined };
  export type CopilotLimits = { maxRequestsPerStep: number; maxRequestsPerTurn: number };
  export type CopilotDeps = { lm?: LmApi; access?: LmAccess; runShell: RunShell; limits: () => CopilotLimits };
  export function usableModels(models: readonly vscode.LanguageModelChat[]): vscode.LanguageModelChat[];
  export function resolveModel<T>(items: readonly T[], idOf: (item: T) => string, chosen?: string): T | undefined;
  export function createCopilotProvider(d: CopilotDeps): AgentProvider;   // `lm` key absent: vscode.lm; present but undefined: no API
  ```
  `COPILOT_NOT_IMPLEMENTED` no longer exists.

- [ ] **Step 1: Write the failing test**

Replace the whole of `extension/test/copilot.test.ts` with:

```ts
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { createPlannerGate, type ChatMessage, type GraphTool, type NodeContext, type PlannerEvent, type PlannerTurn, type RunShell, type ToolGate } from '@agent-stream/engine';
import { emptyGraph, type GraphNode, type NodeEventBody } from '@agent-stream/shared';
import { COPILOT_CONSENT_LATER, COPILOT_RESUME_FAILED, COPILOT_UNAVAILABLE, createCopilotProvider, type CopilotLimits, type LmAccess, type LmApi } from '../src/providers/copilot';
import { COPILOT_PERMISSION } from '../src/providers/copilotModel';
import { fakeLmModel } from './helpers';

const noShell: RunShell = async () => ({ exitCode: 0, output: '' });
const models = (...list: vscode.LanguageModelChat[]) => ({ selectChatModels: vi.fn(async () => list) });
const text = (value: string) => new vscode.LanguageModelTextPart(value);
const call = (callId: string, name: string, input: object) => new vscode.LanguageModelToolCallPart(callId, name, input);
const allowAll: ToolGate = {
  privacy: () => null,
  isReadOnly: () => true,
  isSelfApproving: () => false,
  approve: async () => ({ allow: true, by: 'user' }),
  decide: async () => ({ allow: true, by: 'user' }),
};

function provider(o: { lm?: LmApi; access?: LmAccess; limits?: Partial<CopilotLimits> } = {}) {
  return createCopilotProvider({ lm: o.lm, access: o.access, runShell: noShell, limits: () => ({ maxRequestsPerStep: 25, maxRequestsPerTurn: 10, ...o.limits }) });
}

function step(o: { model?: string; access?: 'read'; graphTools?: GraphTool[]; signal?: AbortSignal } = {}) {
  const events: NodeEventBody[] = [];
  const cwd = mkdtempSync(join(tmpdir(), 'copilot-step-'));
  const node: GraphNode = { id: 'n1', title: 'Step', kind: 'agent', prompt: 'p', ...(o.access && { access: o.access }), createdBy: 'user', updatedBy: 'user', updatedAt: 't' };
  const ctx: NodeContext = {
    runId: 'r1',
    graph: emptyGraph('g', 'G', 't'),
    node,
    prompt: 'Do it.',
    cwd,
    signal: o.signal ?? new AbortController().signal,
    emit: (e) => events.push(e),
    ...(o.model && { model: o.model }),
    ...(o.graphTools && { graphTools: o.graphTools }),
  };
  return { ctx, events, cwd };
}

describe('Copilot models', () => {
  it('lists the tool-calling models, Auto first, without internal copilot-* ids or duplicates', async () => {
    const lm = models(
      fakeLmModel({ id: 'gpt-4o-mini', name: 'GPT-4o mini' }).model,
      fakeLmModel({ id: 'copilot-utility', name: 'Utility' }).model,
      fakeLmModel({ id: 'auto', name: 'Auto' }).model,
      fakeLmModel({ id: 'no-tools', name: 'No tools', toolCalling: false }).model,
      fakeLmModel({ id: 'auto', name: 'Auto' }).model,
    );
    const p = provider({ lm });
    expect(p.knownModels!()).toBeUndefined();
    const listed = [
      { value: 'auto', label: 'Auto', efforts: [] },
      { value: 'gpt-4o-mini', label: 'GPT-4o mini', efforts: [] },
    ];
    expect(await p.listModels!()).toEqual(listed);
    expect(p.knownModels!()).toEqual(listed);
  });

  it('lists nothing without the API, and retries a failed list once when asked', async () => {
    expect(await provider({ lm: undefined }).listModels!()).toEqual([]);
    const lm = { selectChatModels: vi.fn(async (): Promise<vscode.LanguageModelChat[]> => Promise.reject(new Error('not signed in'))) };
    const p = provider({ lm });
    expect(await p.listModels!()).toEqual([]);
    expect(await p.listModels!()).toEqual([]);
    expect(lm.selectChatModels).toHaveBeenCalledTimes(1);
    lm.selectChatModels.mockResolvedValue([fakeLmModel({ id: 'auto', name: 'Auto' }).model]);
    expect(await p.listModels!({ retry: true })).toEqual([{ value: 'auto', label: 'Auto', efforts: [] }]);
  });

  it('runs Default on Auto, a listed model on itself, and a vanished model on Auto with a note', async () => {
    const auto = fakeLmModel({ id: 'auto', name: 'Auto' });
    const mini = fakeLmModel({ id: 'gpt-4o-mini', name: 'GPT-4o mini' });
    const p = provider({ lm: models(mini.model, auto.model) });
    await p.runStep(step().ctx, allowAll);
    expect(auto.sendRequest).toHaveBeenCalledTimes(1);
    await p.runStep(step({ model: 'gpt-4o-mini' }).ctx, allowAll);
    expect(mini.sendRequest).toHaveBeenCalledTimes(1);
    const gone = step({ model: 'gpt-9' });
    await p.runStep(gone.ctx, allowAll);
    expect(auto.sendRequest).toHaveBeenCalledTimes(2);
    expect(gone.events).toContainEqual({ type: 'text', text: 'The Copilot model gpt-9 is no longer available; using Auto.' });
    expect(p.modelInUse!(undefined)).toEqual({ value: 'auto', label: 'Auto', efforts: [] });
    expect(p.modelInUse!('gpt-9')).toEqual({ value: 'auto', label: 'Auto', efforts: [] });
    expect(p.modelInUse!('gpt-4o-mini')).toEqual({ value: 'gpt-4o-mini', label: 'GPT-4o mini', efforts: [] });
  });
});

describe('Copilot status', () => {
  const lm = () => models(fakeLmModel({ id: 'auto', name: 'Auto' }).model, fakeLmModel({ id: 'gpt-4o-mini', name: 'GPT-4o mini' }).model);

  it('can run, and says Copilot will ask for permission while consent is unknown', async () => {
    expect(COPILOT_CONSENT_LATER).toBe('Copilot will ask for permission the first time a run or chat uses it.');
    expect(await provider({ lm: lm(), access: { canSendRequest: () => undefined } }).status()).toEqual({
      provider: 'copilot',
      ok: true,
      label: 'Copilot',
      detail: `Models: Auto, GPT-4o mini. ${COPILOT_CONSENT_LATER}`,
    });
  });

  it('can run without that sentence once consent is given', async () => {
    expect(await provider({ lm: lm(), access: { canSendRequest: () => true } }).status()).toEqual({ provider: 'copilot', ok: true, label: 'Copilot', detail: 'Models: Auto, GPT-4o mini.' });
  });

  it('cannot run when consent was refused', async () => {
    expect(await provider({ lm: lm(), access: { canSendRequest: () => false } }).status()).toEqual({
      provider: 'copilot',
      ok: false,
      label: 'Copilot not allowed',
      detail: 'Models: Auto, GPT-4o mini.',
      error: COPILOT_PERMISSION,
    });
  });

  it('asks about the model Default runs on, and never sends a request', async () => {
    const auto = fakeLmModel({ id: 'auto', name: 'Auto' });
    const canSendRequest = vi.fn(() => true);
    await provider({ lm: models(fakeLmModel({ id: 'gpt-4o-mini' }).model, auto.model), access: { canSendRequest } }).status();
    expect(canSendRequest).toHaveBeenCalledWith(auto.model);
    expect(auto.sendRequest).not.toHaveBeenCalled();
  });

  it('is not available without the API or models, or when listing fails, with the reason', async () => {
    expect(await provider({ lm: models() }).status()).toEqual({ provider: 'copilot', ok: false, label: 'Copilot not available', error: COPILOT_UNAVAILABLE });
    expect((await provider({ lm: undefined }).status()).error).toBe(`${COPILOT_UNAVAILABLE} (This version of VS Code has no Language Model API.)`);
    const failing = { selectChatModels: vi.fn(async (): Promise<vscode.LanguageModelChat[]> => Promise.reject(new Error('no consent'))) };
    expect((await provider({ lm: failing }).status()).error).toBe(`${COPILOT_UNAVAILABLE} (no consent)`);
  });
});

describe('Copilot runStep', () => {
  it('logs the start, tool calls and results, text and the request count, and returns the output with usage', async () => {
    const s = step();
    writeFileSync(join(s.cwd, 'a.txt'), 'hello\n');
    const m = fakeLmModel({ id: 'auto', name: 'Auto', replies: [[call('c1', 'Read', { file_path: 'a.txt' })], [text('The file says '), text('hello.')]] });
    const out = await provider({ lm: models(m.model) }).runStep(s.ctx, allowAll);
    expect(s.events).toEqual([
      { type: 'start', kind: 'agent', cwd: s.cwd, prompt: 'Do it.' },
      { type: 'tool_call', toolUseId: 'c1', name: 'Read', input: { file_path: 'a.txt' } },
      { type: 'tool_result', toolUseId: 'c1', content: '     1\thello', isError: false },
      { type: 'text', text: 'The file says hello.' },
      { type: 'text', text: 'Copilot requests: 2 of 25' },
    ]);
    expect(out).toEqual({ ok: true, output: 'The file says hello.', usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, turns: 2 } });
    const preamble = `You are an agent running one step of a workflow in ${s.cwd}. Use the tools to do the work; when finished, reply with a summary of what you did.`;
    expect(m.requests[0].messages).toEqual([vscode.LanguageModelChatMessage.User([text(preamble)]), vscode.LanguageModelChatMessage.User([text('Do it.')])]);
  });

  it('gives a read-only step only the read tools, and a write step the edit tools and its graph tools under mcp__run_graph__', async () => {
    const ro = fakeLmModel({ id: 'auto' });
    await provider({ lm: models(ro.model) }).runStep(step({ access: 'read' }).ctx, allowAll);
    expect(ro.requests[0].options?.tools?.map((t) => t.name)).toEqual(['Read', 'Grep', 'Glob']);
    const addStep: GraphTool = { name: 'add_step', description: 'Add a step.', schema: {}, run: async () => ({ text: 'added' }) };
    const rw = fakeLmModel({ id: 'auto', replies: [[call('c1', 'add_step', {})], [text('Added.')]] });
    const decide = vi.fn(allowAll.decide);
    await provider({ lm: models(rw.model) }).runStep(step({ graphTools: [addStep] }).ctx, { ...allowAll, decide });
    expect(rw.requests[0].options?.tools?.map((t) => t.name)).toEqual(['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash', 'add_step']);
    expect(decide).toHaveBeenCalledWith('mcp__run_graph__add_step', {}, expect.any(AbortSignal));
  });

  it('stops at agentStream.copilot.maxRequestsPerStep with the cap message and the last text', async () => {
    const s = step();
    writeFileSync(join(s.cwd, 'a.txt'), 'x');
    const read = () => [text('Looking.'), call('c', 'Read', { file_path: 'a.txt' })];
    const m = fakeLmModel({ id: 'auto', replies: [read(), read(), read()] });
    const p = provider({ lm: models(m.model), limits: { maxRequestsPerStep: 2 } });
    expect(await p.runStep(s.ctx, allowAll)).toEqual({
      ok: false,
      output: 'Looking.',
      error: 'Stopped after 2 Copilot requests (agentStream.copilot.maxRequestsPerStep). Raise the setting to let steps run longer.',
    });
    expect(m.sendRequest).toHaveBeenCalledTimes(2);
    expect(s.events.at(-1)).toEqual({ type: 'text', text: 'Copilot requests: 2 of 2' });
    expect(p.stepRequestCap!()).toBe(2);
  });

  it('fails with the permission message when consent is declined, and is cancelled by Stop', async () => {
    const m = fakeLmModel({ id: 'auto', replies: [vscode.LanguageModelError.NoPermissions('declined')] });
    expect(await provider({ lm: models(m.model) }).runStep(step().ctx, allowAll)).toEqual({ ok: false, output: '', error: COPILOT_PERMISSION });
    const ac = new AbortController();
    ac.abort();
    expect(await provider({ lm: models(fakeLmModel({ id: 'auto' }).model) }).runStep(step({ signal: ac.signal }).ctx, allowAll)).toEqual({ ok: false, output: '', error: 'cancelled' });
  });

  it('fails without models, after the start event and without a request line', async () => {
    const s = step();
    expect(await provider({ lm: models() }).runStep(s.ctx, allowAll)).toEqual({ ok: false, output: '', error: COPILOT_UNAVAILABLE });
    expect(s.events.map((e) => e.type)).toEqual(['start']);
  });
});

describe('Copilot planTurn', () => {
  function turn(o: Partial<PlannerTurn> & { store?: Map<string, ChatMessage[]> } = {}) {
    const { store: given, ...over } = o;
    const store = given ?? new Map<string, ChatMessage[]>();
    const events: PlannerEvent[] = [];
    const cwd = mkdtempSync(join(tmpdir(), 'copilot-plan-'));
    const addNode: GraphTool = { name: 'add_node', description: 'Add a step.', schema: {}, run: async () => ({ text: 'added n1' }) };
    const t: PlannerTurn = {
      prompt: 'Plan a build.',
      systemAppend: 'You are the planner.',
      cwd,
      tools: [addNode],
      gate: createPlannerGate({ projectDir: cwd, privateFiles: [], graphToolNames: new Set(['add_node']) }),
      signal: new AbortController().signal,
      onEvent: (e) => events.push(e),
      transcript: { load: (id) => store.get(id), save: (id, messages) => void store.set(id, structuredClone(messages)) },
      ...over,
    };
    return { t, events, store };
  }

  it('starts a conversation under a new id, shows text and graph tool calls, and continues it from the transcript', async () => {
    const m = fakeLmModel({
      id: 'auto',
      replies: [[call('c1', 'add_node', { title: 'Build' }), call('c2', 'Read', { file_path: 'package.json' })], [text('Added a build step.')], [text('Sure.')]],
    });
    const p = provider({ lm: models(m.model) });
    const first = turn();
    const r1 = await p.planTurn(first.t);
    expect(r1).toEqual({ ok: true, sessionId: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    const id = (r1 as { sessionId: string }).sessionId;
    expect(first.events).toEqual([{ type: 'tool', name: 'add_node', input: { title: 'Build' } }, { type: 'text', text: 'Added a build step.' }]);
    expect(m.requests[0].messages[0]).toEqual(vscode.LanguageModelChatMessage.User([text('You are the planner.')]));
    expect(m.requests[0].options?.tools?.map((t) => t.name)).toEqual(['Read', 'Grep', 'Glob', 'add_node']);
    const second = turn({ store: first.store, resume: id, prompt: 'And a test step?' });
    expect(await p.planTurn(second.t)).toEqual({ ok: true, sessionId: id });
    const sent = m.requests[2].messages;
    expect(sent[1]).toEqual(vscode.LanguageModelChatMessage.User([text('Plan a build.')]));
    expect(sent.at(-1)).toEqual(vscode.LanguageModelChatMessage.User([text('And a test step?')]));
    // Prompt, tool calls, results, reply; then the second prompt and reply.
    expect(first.store.get(id)).toHaveLength(6);
  });

  it("reports resumeFailed when the conversation's transcript is gone, without a request", async () => {
    const m = fakeLmModel({ id: 'auto' });
    expect(await provider({ lm: models(m.model) }).planTurn(turn({ resume: 'gone' }).t)).toEqual({ ok: false, error: COPILOT_RESUME_FAILED, resumeFailed: true });
    expect(COPILOT_RESUME_FAILED).toBe('The earlier Copilot conversation was not found.');
    expect(m.sendRequest).not.toHaveBeenCalled();
  });

  it('keeps the conversation when a request fails, and shows the error', async () => {
    const m = fakeLmModel({ id: 'auto', replies: [vscode.LanguageModelError.Blocked('quota')] });
    const t = turn();
    const r = await provider({ lm: models(m.model) }).planTurn(t.t);
    expect(r).toEqual({ ok: true, sessionId: expect.any(String), error: 'Copilot refused the request (quota or policy): quota' });
    expect(t.store.get((r as { sessionId: string }).sessionId)).toEqual([{ role: 'user', content: [{ type: 'text', text: 'Plan a build.' }] }]);
  });

  it('stops at agentStream.copilot.maxRequestsPerTurn', async () => {
    const m = fakeLmModel({ id: 'auto', replies: [[call('c1', 'add_node', {})]] });
    const r = await provider({ lm: models(m.model), limits: { maxRequestsPerTurn: 1 } }).planTurn(turn().t);
    expect(r).toEqual({ ok: true, sessionId: expect.any(String), error: 'Stopped after 1 Copilot requests (agentStream.copilot.maxRequestsPerTurn). Raise the setting to let steps run longer.' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w extension -- test/copilot.test.ts`
Expected: FAIL. `COPILOT_CONSENT_LATER` and `COPILOT_RESUME_FAILED` aren't exported, and the scaffold's `status()` returns `ok: false, preview: true`.

- [ ] **Step 3: Write the implementation**

In `engine/src/providers/types.ts`, add to `AgentProvider`, after `knownModels?(): ModelChoice[] | undefined;`:

```ts
  /** The most model requests one agent step may make, when the provider caps them (Copilot); the run dialog shows it. */
  stepRequestCap?(): number;
  /**
   * The model a step would run on for this choice (undefined: Default), when the provider substitutes its default for a
   * model it no longer lists (Copilot); undefined when it runs the choice as given or can't tell without waiting.
   */
  modelInUse?(model: string | undefined): ModelChoice | undefined;
```

Replace the whole of `extension/src/providers/copilot.ts` with:

```ts
import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import { builtinTools, lastAssistantText, runAgentLoop, toLoopTools, type AgentProvider, type ChatMessage, type NodeOutcome, type RunShell } from '@agent-stream/engine';
import { isWriteCapable, type ModelChoice, type NodeUsage, type ProviderStatus } from '@agent-stream/shared';
import { COPILOT_PERMISSION, vscodeChatModel } from './copilotModel';

export const COPILOT_UNAVAILABLE = "GitHub Copilot isn't available. Install the GitHub Copilot extension and sign in, or switch to Claude with Agent Stream: Select Provider.";
export const COPILOT_CONSENT_LATER = 'Copilot will ask for permission the first time a run or chat uses it.';
export const COPILOT_RESUME_FAILED = 'The earlier Copilot conversation was not found.';
/** What Default means on Copilot (spec §3). */
export const AUTO_MODEL = 'auto';

export const stepPreamble = (cwd: string) =>
  `You are an agent running one step of a workflow in ${cwd}. Use the tools to do the work; when finished, reply with a summary of what you did.`;
export const copilotCapMessage = (n: number, setting: 'maxRequestsPerStep' | 'maxRequestsPerTurn') =>
  `Stopped after ${n} Copilot requests (agentStream.copilot.${setting}). Raise the setting to let steps run longer.`;
export const requestLine = (n: number, cap: number) => `Copilot requests: ${n} of ${cap}`;

/** The slice of vscode.lm the provider uses. */
export type LmApi = { selectChatModels(selector: { vendor: string }): Thenable<readonly vscode.LanguageModelChat[]> };
/** context.languageModelAccessInformation: true allowed, false refused, undefined VS Code will ask on the first request. */
export type LmAccess = { canSendRequest(model: vscode.LanguageModelChat): boolean | undefined };
export type CopilotLimits = { maxRequestsPerStep: number; maxRequestsPerTurn: number };
export type CopilotDeps = {
  /** vscode.lm; an explicit undefined means "no Language Model API" (tests). */
  lm?: LmApi;
  access?: LmAccess;
  runShell: RunShell;
  /** The request caps, read per step and per turn. */
  limits: () => CopilotLimits;
};

/** Not in @types/vscode 1.106, but present at runtime (spec §2, ruling R17). */
type ToolCalling = { capabilities?: { supportsToolCalling?: boolean } };

/** The models Agent Stream can run (spec §5.2): tool calling, no internal copilot-* ids, one per id, Auto first. */
export function usableModels(models: readonly vscode.LanguageModelChat[]): vscode.LanguageModelChat[] {
  const seen = new Set<string>();
  const out: vscode.LanguageModelChat[] = [];
  for (const m of models) {
    if ((m as ToolCalling).capabilities?.supportsToolCalling !== true || m.id.startsWith('copilot-') || seen.has(m.id)) continue;
    seen.add(m.id);
    out.push(m);
  }
  return [...out.filter((m) => m.id === AUTO_MODEL), ...out.filter((m) => m.id !== AUTO_MODEL)];
}

/** The chosen model when listed, else Auto, else the first (spec §5.2). */
export function resolveModel<T>(items: readonly T[], idOf: (item: T) => string, chosen?: string): T | undefined {
  return (chosen ? items.find((m) => idOf(m) === chosen) : undefined) ?? items.find((m) => idOf(m) === AUTO_MODEL) ?? items[0];
}

const choiceOf = (m: vscode.LanguageModelChat): ModelChoice => ({ value: m.id, label: m.name, efforts: [] });
/** Copilot reports no tokens or cost: only the request count (ruling R16). */
const requestUsage = (requests: number): NodeUsage => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, turns: requests });
const userText = (text: string): ChatMessage => ({ role: 'user', content: [{ type: 'text', text }] });
const reason = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * GitHub Copilot through VS Code's Language Model API (spec §5). Steps and planner turns run the engine's agent loop
 * with our own tools, so approvals, read-only steps and privacy work as with Claude. Effort is ignored.
 */
export function createCopilotProvider(d: CopilotDeps): AgentProvider {
  // An explicit `lm: undefined` means "no API" (tests), so `??` can't be used here.
  const lm = 'lm' in d ? d.lm : (vscode as { lm?: LmApi }).lm;
  /** The model list once one was non-empty (ruling R18); refreshed by status, steps and turns. */
  let known: ModelChoice[] | undefined;
  let pending: Promise<ModelChoice[]> | undefined;
  let failed = false;
  let retried = false;

  const unavailable = (why?: string): ProviderStatus => ({
    provider: 'copilot',
    ok: false,
    label: 'Copilot not available',
    error: why ? `${COPILOT_UNAVAILABLE} (${why})` : COPILOT_UNAVAILABLE,
  });

  /** The usable models now ([] without the API); throws what VS Code throws. Never a model request. */
  async function select(): Promise<vscode.LanguageModelChat[]> {
    if (!lm?.selectChatModels) return [];
    const models = usableModels(await lm.selectChatModels({ vendor: 'copilot' }));
    if (models.length) {
      known = models.map(choiceOf);
      failed = false;
    }
    return models;
  }

  /** The model a step or turn runs on, with a note when the chosen one is gone (ruling R20). */
  async function pick(chosen: string | undefined): Promise<{ model: vscode.LanguageModelChat; note?: string } | { error: string }> {
    let models: vscode.LanguageModelChat[];
    try {
      models = await select();
    } catch (e) {
      return { error: `${COPILOT_UNAVAILABLE} (${reason(e)})` };
    }
    const model = resolveModel(models, (m) => m.id, chosen);
    if (!model) return { error: COPILOT_UNAVAILABLE };
    return chosen && model.id !== chosen ? { model, note: `The Copilot model ${chosen} is no longer available; using ${model.name}.` } : { model };
  }

  return {
    id: 'copilot',
    name: 'GitHub Copilot',
    async status() {
      if (!lm?.selectChatModels) return unavailable('This version of VS Code has no Language Model API.');
      let models: vscode.LanguageModelChat[];
      try {
        models = await select();
      } catch (e) {
        return unavailable(reason(e));
      }
      const model = resolveModel(models, (m) => m.id);
      if (!model) return unavailable();
      const detail = `Models: ${models.map((m) => m.name).join(', ')}.`;
      const allowed = d.access?.canSendRequest(model);
      if (allowed === false) return { provider: 'copilot', ok: false, label: 'Copilot not allowed', detail, error: COPILOT_PERMISSION };
      return { provider: 'copilot', ok: true, label: 'Copilot', detail: allowed === undefined ? `${detail} ${COPILOT_CONSENT_LATER}` : detail };
    },
    knownModels: () => known,
    async listModels(o) {
      if (known) return known;
      if (pending) return pending;
      if (failed) {
        // An empty or failing list isn't asked again for every preview or chat: one retry, and only when asked.
        if (!o?.retry || retried) return [];
        retried = true;
      }
      pending = select()
        .then(
          (models) => {
            if (!models.length) failed = true;
            return known ?? [];
          },
          () => {
            failed = true;
            return [];
          },
        )
        .finally(() => (pending = undefined));
      return pending;
    },
    modelInUse: (model) => (known ? resolveModel(known, (c) => c.value, model) : undefined),
    stepRequestCap: () => d.limits().maxRequestsPerStep,

    async runStep(ctx, gate): Promise<NodeOutcome> {
      ctx.emit({ type: 'start', kind: 'agent', cwd: ctx.cwd, prompt: ctx.prompt });
      const picked = await pick(ctx.model);
      if ('error' in picked) return { ok: false, output: '', error: picked.error };
      if (picked.note) ctx.emit({ type: 'text', text: picked.note });
      const cap = d.limits().maxRequestsPerStep;
      const r = await runAgentLoop({
        model: vscodeChatModel(picked.model),
        system: stepPreamble(ctx.cwd),
        messages: [userText(ctx.prompt)],
        tools: [
          ...builtinTools({ cwd: ctx.cwd, runShell: d.runShell, readOnly: !isWriteCapable(ctx.node) }),
          ...toLoopTools(ctx.graphTools ?? [], 'mcp__run_graph__'),
        ],
        gate,
        maxRequests: cap,
        signal: ctx.signal,
        capMessage: copilotCapMessage(cap, 'maxRequestsPerStep'),
        onText: (text) => ctx.emit({ type: 'text', text }),
        onToolCall: (callId, name, input) => ctx.emit({ type: 'tool_call', toolUseId: callId, name, input }),
        onToolResult: (callId, content, isError) => ctx.emit({ type: 'tool_result', toolUseId: callId, content, isError }),
      });
      ctx.emit({ type: 'text', text: requestLine(r.requests, cap) });
      if (r.ok) return { ok: true, output: r.text, usage: requestUsage(r.requests) };
      if (r.cancelled) return { ok: false, output: '', error: 'cancelled' };
      return { ok: false, output: lastAssistantText(r.messages), error: r.error };
    },

    async planTurn(turn) {
      let history: ChatMessage[] = [];
      if (turn.resume) {
        const loaded = turn.transcript.load(turn.resume);
        if (!loaded) return { ok: false, error: COPILOT_RESUME_FAILED, resumeFailed: true };
        history = loaded;
      }
      const picked = await pick(turn.model);
      if ('error' in picked) return { ok: false, error: picked.error };
      const cap = d.limits().maxRequestsPerTurn;
      const graphToolNames = new Set(turn.tools.map((t) => t.name));
      const r = await runAgentLoop({
        model: vscodeChatModel(picked.model),
        system: turn.systemAppend,
        messages: [...history, userText(turn.prompt)],
        tools: [...builtinTools({ cwd: turn.cwd, runShell: d.runShell, readOnly: true }), ...toLoopTools(turn.tools, '')],
        gate: turn.gate,
        maxRequests: cap,
        signal: turn.signal,
        capMessage: copilotCapMessage(cap, 'maxRequestsPerTurn'),
        onText: (text) => turn.onEvent({ type: 'text', text }),
        onToolCall: (_callId, name, input) => {
          if (graphToolNames.has(name)) turn.onEvent({ type: 'tool', name, input });
        },
        onToolResult: () => {},
      });
      // Saved whatever happened, so the conversation and its error stay (spec §5.3, ruling R25).
      const id = turn.resume ?? randomUUID();
      turn.transcript.save(id, r.messages);
      return r.ok ? { ok: true, sessionId: id } : { ok: true, sessionId: id, error: r.error };
    },
  };
}
```

`EngineManager` still calls `createCopilotProvider()` with no argument until Task 10, so the extension typecheck fails at `extension/src/engines.ts` after this task. To keep every commit compiling, also change that one line now, in `extension/src/engines.ts` `providerFor`:

```ts
        copilot: () => createCopilotProvider({ runShell: createRunShell({ platform: d.platform, env: d.env }), limits: () => ({ maxRequestsPerStep: 25, maxRequestsPerTurn: 10 }) }),
```

and add `createRunShell` to its `@agent-stream/engine` import. Task 10 replaces this line with the settings-driven wiring.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -w extension -- test/copilot.test.ts test/copilotModel.test.ts test/engines.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck -w engine && npm run typecheck -w extension`
Expected: no errors. Check that `rg -n COPILOT_NOT_IMPLEMENTED extension engine shared web` finds nothing.

```bash
git add engine/src/providers/types.ts extension/src/providers/copilot.ts extension/src/engines.ts extension/test/copilot.test.ts
git commit -m "feat(extension): a working GitHub Copilot provider

Copilot lists its tool-calling models (Auto first, copilot-* hidden),
reports consent in its status, and runs steps and planner turns through the
engine's agent loop with our own tools, capped per step and per turn.
Planner conversations persist through the transcript store.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Wiring — the cap settings, consent access, Git Bash, the status bar, and retiring the preview

**Spec tests owned (§8):** "the cap settings are read and clamped". This task also wires §5.5: `EngineManager.providerFor('copilot')` gets `vscode.lm`, `context.languageModelAccessInformation`, `createRunShell` with the same Git Bash discovery as command steps, and the caps. `preview` is retired and the status bar shows `Copilot`.

**Files:**
- Modify: `extension/src/settings.ts`; `extension/src/engines.ts` (`EngineManagerDeps.languageModelAccess`, `providerFor`, `gitBashPath`); `extension/src/extension.ts:44` (the `EngineManager` construction); `extension/src/statusBar.ts:9` (delete the preview line); `extension/package.json` (description, provider and model descriptions, two settings); `shared/src/types.ts:281-293` (`ProviderStatus`); `web/src/App.tsx:17`; `extension/test/integration/suite.cjs:81-92`
- Modify (mechanical, two new required `Settings` fields): the `settings: () => ({ … })` literals in `extension/test/commands.test.ts:23`, `extension/test/engines.test.ts:17`, `:37` and `:163`, `extension/test/parallelTickets.test.ts:69` and `extension/test/runCommands.test.ts:22`
- Test: `extension/test/settings.test.ts`, `extension/test/engines.test.ts`, `extension/test/statusBar.test.ts`

**Interfaces:**
- Consumes: `createCopilotProvider`, `LmAccess` (Task 9); `createRunShell` (Task 1); `findGitBash` (existing).
- Produces:
  ```ts
  // extension/src/settings.ts — Settings gains:
  copilotMaxRequestsPerStep: number;   // 1–200, default 25
  copilotMaxRequestsPerTurn: number;   // 1–100, default 10
  // extension/src/engines.ts — EngineManagerDeps gains:
  languageModelAccess?: LmAccess;
  // shared/src/types.ts — ProviderStatus loses `preview`
  ```

- [ ] **Step 1: Write the failing tests**

In `extension/test/settings.test.ts`, change the first test's expectation to:

```ts
    expect(readSettings()).toEqual({ claudePath: '/opt/claude', gitBashPath: '', maxParallel: 16, provider: 'copilot', model: '', effort: '', copilotMaxRequestsPerStep: 25, copilotMaxRequestsPerTurn: 10 });
```

add `import { readFileSync } from 'node:fs';` at the top, and append inside `describe('readSettings', …)`:

```ts
  it('reads the Copilot request caps, clamped to their ranges, with the defaults for anything else', () => {
    const values: Record<string, unknown> = { 'copilot.maxRequestsPerStep': 500, 'copilot.maxRequestsPerTurn': 0 };
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({ get: (key: string, fallback: unknown) => values[key] ?? fallback } as never);
    expect(readSettings()).toMatchObject({ copilotMaxRequestsPerStep: 200, copilotMaxRequestsPerTurn: 1 });
    values['copilot.maxRequestsPerStep'] = 40;
    values['copilot.maxRequestsPerTurn'] = 'lots';
    expect(readSettings()).toMatchObject({ copilotMaxRequestsPerStep: 40, copilotMaxRequestsPerTurn: 10 });
    values['copilot.maxRequestsPerStep'] = 2.5;
    delete values['copilot.maxRequestsPerTurn'];
    expect(readSettings()).toMatchObject({ copilotMaxRequestsPerStep: 25, copilotMaxRequestsPerTurn: 10 });
  });

  it('declares the Copilot request caps in the manifest with their ranges', () => {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    const props = manifest.contributes.configuration.properties;
    expect(props['agentStream.copilot.maxRequestsPerStep']).toMatchObject({ type: 'integer', default: 25, minimum: 1, maximum: 200 });
    expect(props['agentStream.copilot.maxRequestsPerTurn']).toMatchObject({ type: 'integer', default: 10, minimum: 1, maximum: 100 });
    expect(JSON.stringify(props['agentStream.provider'])).not.toContain('preview');
  });
```

In each of the six `Settings` literals listed under **Files**, replace `effort: '' as const }` with:

```ts
effort: '' as const, copilotMaxRequestsPerStep: 25, copilotMaxRequestsPerTurn: 10 }
```

Append inside `describe('EngineManager', …)` in `extension/test/engines.test.ts`:

```ts
  it('builds the Copilot provider with the request caps from the settings, read when asked', () => {
    let perStep = 7;
    const manager = new EngineManager({ ...baseDeps(), settings: () => ({ ...defaults, provider: 'copilot', copilotMaxRequestsPerStep: perStep }) });
    const copilot = manager.providerFor('copilot');
    expect(copilot).toMatchObject({ id: 'copilot', name: 'GitHub Copilot' });
    expect(copilot.stepRequestCap!()).toBe(7);
    perStep = 30;
    expect(copilot.stepRequestCap!()).toBe(30);
  });
```

In `extension/test/statusBar.test.ts`, replace the test `'marks a preview provider'` with:

```ts
  it('shows Copilot like any provider that can run', () => {
    expect(statusBarText({ provider: 'copilot', ok: true, label: 'Copilot', detail: 'Models: Auto.' })).toEqual({
      text: '$(check) Copilot',
      tooltip: 'Agent Stream runs on Copilot (Models: Auto.).',
    });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w extension -- test/settings.test.ts test/engines.test.ts test/statusBar.test.ts`
Expected: FAIL. `readSettings()` has no cap fields, the manifest has no cap settings, and `stepRequestCap()` is 25, not 7.

- [ ] **Step 3: Write the implementation**

Replace the whole of `extension/src/settings.ts` with:

```ts
import * as vscode from 'vscode';
import { isEffortLevel, type EffortLevel } from '@agent-stream/shared';

/** `model` and `effort`: the defaults for runs and for planner conversations without their own choice ('' = Default). */
export type Settings = {
  claudePath: string;
  gitBashPath: string;
  maxParallel: number;
  provider: string;
  model: string;
  effort: EffortLevel | '';
  /** agentStream.copilot.maxRequestsPerStep: 1–200, default 25. */
  copilotMaxRequestsPerStep: number;
  /** agentStream.copilot.maxRequestsPerTurn: 1–100, default 10. */
  copilotMaxRequestsPerTurn: number;
};

/** An integer setting clamped to its range; anything that isn't an integer reads as the default. */
function intSetting(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value);
  return Number.isInteger(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

export function readSettings(): Settings {
  const config = vscode.workspace.getConfiguration('agentStream');
  const model = config.get<unknown>('model', '');
  const effort = config.get<unknown>('effort', '');
  return {
    claudePath: String(config.get('claudePath', '')).trim(),
    gitBashPath: String(config.get('gitBashPath', '')).trim(),
    provider: String(config.get('provider', 'claude')).trim(),
    maxParallel: intSetting(config.get('maxParallel', 3), 1, 16, 3),
    model: typeof model === 'string' ? model.trim() : '',
    effort: isEffortLevel(effort) ? effort : '',
    copilotMaxRequestsPerStep: intSetting(config.get('copilot.maxRequestsPerStep', 25), 1, 200, 25),
    copilotMaxRequestsPerTurn: intSetting(config.get('copilot.maxRequestsPerTurn', 10), 1, 100, 10),
  };
}
```

In `extension/src/engines.ts`:
- change the provider import to `import { createCopilotProvider, type LmAccess } from './providers/copilot';`;
- add to `EngineManagerDeps`, after `findGitBash?: typeof realFindGitBash;`:

```ts
  /** context.languageModelAccessInformation: whether Copilot requests need the user's consent first. */
  languageModelAccess?: LmAccess;
```

- replace the interim `copilot:` line from Task 9 with:

```ts
        copilot: () =>
          createCopilotProvider({
            access: d.languageModelAccess,
            // Built per command, so a changed agentStream.gitBashPath reaches the next Bash call (Git Bash as for command steps).
            runShell: (o) => createRunShell({ platform: d.platform, env: d.env, gitBashPath: this.gitBashPath() })(o),
            limits: () => {
              const s = d.settings();
              return { maxRequestsPerStep: s.copilotMaxRequestsPerStep, maxRequestsPerTurn: s.copilotMaxRequestsPerTurn };
            },
          }),
```

- add this method right after `providerFor`:

```ts
  /** Windows: Git Bash for Copilot's Bash tool, found as for command steps; none is needed elsewhere. */
  private gitBashPath(): string | undefined {
    if (this.d.platform !== 'win32') return undefined;
    const found = (this.d.findGitBash ?? realFindGitBash)({ env: this.d.env, setting: this.d.settings().gitBashPath });
    return found.ok ? found.path : undefined;
  }
```

In `extension/src/extension.ts`, change the `EngineManager` construction to:

```ts
  const manager = new EngineManager({
    settings: readSettings,
    platform: process.platform,
    env: process.env,
    home: homedir(),
    git: realGit,
    events,
    languageModelAccess: context.languageModelAccessInformation,
  });
```

In `extension/src/statusBar.ts`, delete the line `if (status.preview) return { text: `$(beaker) ${status.label}`, tooltip: status.detail ?? status.error ?? status.label };`.

In `shared/src/types.ts`, in `ProviderStatus`, delete the `preview` field and its comment, and change the `label` comment to:

```ts
  /** Status-bar text: "Claude Max", "not signed in", "Copilot", "Copilot not available", "Copilot not allowed". */
```

In `web/src/App.tsx`, replace the banner line with:

```tsx
      {status && !status.ok && <div className="banner">{`${status.error} Fix this, then use Check again in the Agent Stream sidebar.`}</div>}
```

In `extension/package.json`:
- `"description"` becomes `"Co-create a workflow graph with an AI planner and run it step by step on your own AI subscription: Claude or GitHub Copilot."`;
- in `agentStream.provider`, the second `enumDescriptions` entry becomes `"GitHub Copilot: your Copilot plan through VS Code's Language Model API."`;
- in `agentStream.model`, `Leave empty for Claude Code's default.` becomes `Leave empty for the provider's default (Claude Code's default; Auto on Copilot).`;
- add after the `agentStream.maxParallel` property (mind the comma after its closing brace):

```json
        "agentStream.copilot.maxRequestsPerStep": {
          "type": "integer",
          "default": 25,
          "minimum": 1,
          "maximum": 200,
          "description": "GitHub Copilot: the most model requests one agent step may make. A step that reaches it stops and says so."
        },
        "agentStream.copilot.maxRequestsPerTurn": {
          "type": "integer",
          "default": 10,
          "minimum": 1,
          "maximum": 100,
          "description": "GitHub Copilot: the most model requests one planner chat message may make."
        }
```

In `extension/test/integration/suite.cjs`, replace the block from `// Providers: GitHub Copilot is selectable.` through `detachProbe();` with (ruling R24):

```js
  // Providers: GitHub Copilot is selectable. This fresh profile normally has no signed-in Copilot, so its status
  // can't run, and a run is refused with the provider's own reason. Nothing here sends a Copilot request.
  const config = () => vscode.workspace.getConfiguration('agentStream');
  assert.equal(config().get('copilot.maxRequestsPerStep'), 25);
  assert.equal(config().get('copilot.maxRequestsPerTurn'), 10);
  await config().update('provider', 'copilot', vscode.ConfigurationTarget.Global);
  await waitFor(() => api.engines.status.provider === 'copilot' && api.engines.status.label !== 'checking', 'the Copilot status');
  assert.ok(['Copilot', 'Copilot not available', 'Copilot not allowed'].includes(api.engines.status.label), api.engines.status.label);
  if (!api.engines.status.ok) {
    const probe = [];
    const probeClient = { send: (m) => probe.push(m) };
    const detachProbe = app.connect(probeClient);
    await app.handle(probeClient, { type: 'startRun', graphId: 'demo', reviewed: 'x' });
    assert.equal(probe.find((m) => m.type === 'error').message, `Runs are disabled: ${api.engines.status.error}`);
    detachProbe();
  }
```

The two lines after it (switching back to Claude) stay.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -w extension && npm test -w web`
Expected: PASS, the whole extension and web suites included.

- [ ] **Step 5: Typecheck everything and commit**

Run: `npm run typecheck`
Expected: no errors in any workspace. Check that `rg -n "preview\?: boolean|status\.preview|beaker" shared extension web --glob '!node_modules'` finds nothing.

```bash
git add extension/src/settings.ts extension/src/engines.ts extension/src/extension.ts extension/src/statusBar.ts extension/package.json shared/src/types.ts web/src/App.tsx extension/test/integration/suite.cjs extension/test/settings.test.ts extension/test/engines.test.ts extension/test/statusBar.test.ts extension/test/commands.test.ts extension/test/parallelTickets.test.ts extension/test/runCommands.test.ts
git commit -m "feat(extension): wire Copilot to its settings, consent and Git Bash

agentStream.copilot.maxRequestsPerStep (25, 1-200) and maxRequestsPerTurn
(10, 1-100), clamped; the provider gets VS Code's language model access
information and a RunShell that finds Git Bash like command steps. The
preview flag is gone: the status bar shows Copilot.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: The run dialog's cap line and model in use, the docs, and the full verification

**Spec tests owned (§8):**
- "the run dialog line";
- the manual steps added to `docs/windows-checklist.md`;
- the dialog half of §7's "the dialog and tooltip name the model used" (ruling R20).

It also ships ruling R16's log line.

**Files:**
- Modify: `shared/src/types.ts` (`RunPreview.copilotRequestsPerStep`); `engine/src/app.ts` (the `previewRun` case); `web/src/components/RunConfirmDialog.tsx`; `web/src/components/LogView.tsx` (the `result` case); `web/src/styles.css:174`
- Modify: `README.md`, `extension/README.md`, `docs/windows-checklist.md`
- Test: `engine/test/app.test.ts`, `web/test/RunConfirmDialog.test.ts`, `web/test/LogsPanel.test.ts` (append)

**Interfaces:**
- Consumes: `AgentProvider.stepRequestCap?()` and `modelInUse?()` (Task 9).
- Produces:
  ```ts
  // shared/src/types.ts — RunPreview gains:
  /** The run's provider caps model requests per step (Copilot): the dialog's "Copilot requests per step" line. */
  copilotRequestsPerStep?: number;
  ```

- [ ] **Step 1: Write the failing tests**

Append to `engine/test/app.test.ts`, right after the test `'never waits on the model list for a preview: the cached list names the model, else its id'`:

```ts
  it("shows the provider's per-step request cap and the model a step would run on", async () => {
    const defaults: ModelSelection = { model: 'gpt-9' };
    const auto: ModelChoice = { value: 'auto', label: 'Auto', efforts: [] };
    const provider = testProvider({ id: 'copilot', name: 'GitHub Copilot', stepRequestCap: () => 25, modelInUse: () => auto });
    const { app, graphId } = setupWithGraph({ provider, modelDefaults: () => defaults });
    app.graphStore.apply(graphId, { type: 'addNode', node: { id: 'n1', title: 'one', kind: 'agent', prompt: 'p1' } }, 'user');
    const c = client(app);
    await app.handle(c.client, { type: 'previewRun', graphId });
    expect(c.last('runPreview').preview).toMatchObject({ copilotRequestsPerStep: 25, model: { value: 'auto', label: 'Auto' } });
  });

  it('leaves the cap out for a provider without one', async () => {
    const { app, graphId } = setupWithGraph();
    const c = client(app);
    await app.handle(c.client, { type: 'previewRun', graphId });
    expect(c.last('runPreview').preview).not.toHaveProperty('copilotRequestsPerStep');
  });
```

Append inside `describe('RunConfirmDialog', …)` in `web/test/RunConfirmDialog.test.ts`:

```ts
  it("shows Copilot's per-step request cap when the run's provider has one", async () => {
    await act(async () => dispatch({ kind: 'openConfirm', request: {} }));
    await act(async () => dispatch({ kind: 'server', msg: { type: 'runPreview', preview: preview({ copilotRequestsPerStep: 25 }), requestId: lastRequestId() } }));
    expect(container.querySelector('.cap-line')?.textContent).toBe('Copilot requests per step: up to 25');
  });

  it('shows no cap line for a provider without one, or for command steps alone', async () => {
    await act(async () => dispatch({ kind: 'openConfirm', request: {} }));
    await act(async () => dispatch({ kind: 'server', msg: { type: 'runPreview', preview: preview(), requestId: lastRequestId() } }));
    expect(container.querySelector('.cap-line')).toBeNull();
    const commandsOnly = preview({ signature: 'sig-2', copilotRequestsPerStep: 25, steps: [{ id: 'n1', title: 'Build', kind: 'command', text: 'dbt build', reused: false }] });
    await act(async () => dispatch({ kind: 'server', msg: { type: 'runPreview', preview: commandsOnly, requestId: lastRequestId() } }));
    expect(container.querySelector('.cap-line')).toBeNull();
  });
```

Append inside `describe('LogsPanel', …)` in `web/test/LogsPanel.test.ts`:

```ts
  it('shows only the request count for a step that reports no tokens or cost (Copilot)', async () => {
    await act(async () => dispatch({ kind: 'selectNode', id: 'n2' }));
    const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, turns: 3 };
    await act(async () => server({ type: 'nodeLogs', runId: run.id, nodeId: 'n2', events: [{ at: '2026-10-02T10:00:00Z', type: 'result', ok: true, durationMs: 1200, usage }] }));
    expect(text()).toContain('· 3 turns');
    expect(text()).not.toContain('API-equivalent');
    expect(text()).not.toContain('0 in / 0 out');
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w engine -- test/app.test.ts && npm test -w web -- test/RunConfirmDialog.test.ts test/LogsPanel.test.ts`
Expected: FAIL. The preview has no `copilotRequestsPerStep` and its model is `gpt-9`, there's no `.cap-line`, and the log shows `0 in / 0 out tokens`.

- [ ] **Step 3: Write the implementation**

In `shared/src/types.ts`, add to `RunPreview`, after `effort?: EffortLevel;`:

```ts
  /** The run's provider caps model requests per step (Copilot): the dialog's "Copilot requests per step" line. */
  copilotRequestsPerStep?: number;
```

In `engine/src/app.ts`, in the `case 'previewRun':` block, replace

```ts
        const { model, effort } = modelDefaults();
        const label = model && (findModel(knownModels(), model)?.label ?? model);
        const shown = { ...p.outcome.preview, ...(model && label && { model: { value: model, label } }), ...(effort && { effort }) };
```

with

```ts
        const { model, effort } = modelDefaults();
        const label = model && (findModel(knownModels(), model)?.label ?? model);
        // A provider that runs its default in place of a model it no longer lists (Copilot) names the one a step would get.
        const inUse = provider.modelInUse?.(model);
        const shownModel = inUse ? { value: inUse.value, label: inUse.label } : model && label ? { value: model, label } : undefined;
        const cap = provider.stepRequestCap?.();
        const shown = { ...p.outcome.preview, ...(shownModel && { model: shownModel }), ...(effort && { effort }), ...(cap !== undefined && { copilotRequestsPerStep: cap }) };
```

In `web/src/components/RunConfirmDialog.tsx`, right after the `model-line` paragraph, add:

```tsx
            {agents.length > 0 && preview.copilotRequestsPerStep !== undefined && <p className="cap-line">Copilot requests per step: up to {preview.copilotRequestsPerStep}</p>}
```

In `web/src/components/LogView.tsx`, in `case 'result':`, replace the `const usage = …` statement with:

```tsx
      const u = e.usage;
      // A provider that reports no tokens or cost (Copilot) shows only its request count (ruling R16).
      const counted = u ? u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens > 0 || u.costUsd > 0 : false;
      const usage = !u
        ? ''
        : counted
          ? ` · ${u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens} in / ${u.outputTokens} out tokens · ${u.turns} turns · ~$${u.costUsd.toFixed(2)} API-equivalent`
          : ` · ${u.turns} turns`;
```

In `web/src/styles.css`, change `.checkout-line, .model-line { color: var(--muted); }` to `.checkout-line, .model-line, .cap-line { color: var(--muted); }`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -w engine -- test/app.test.ts && npm test -w web`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit the code**

Run: `npm run typecheck`
Expected: no errors.

```bash
git add shared/src/types.ts engine/src/app.ts engine/test/app.test.ts web/src/components/RunConfirmDialog.tsx web/src/components/LogView.tsx web/src/styles.css web/test/RunConfirmDialog.test.ts web/test/LogsPanel.test.ts
git commit -m "feat: the run dialog shows Copilot's request cap and the model in use

RunPreview.copilotRequestsPerStep comes from the provider's stepRequestCap;
the Model line names the model a step would run on when the provider swaps
a missing one for Auto. A step without token counts logs only its turns.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 6: Document Copilot in both READMEs**

Make the same edits to `README.md` and `extension/README.md`.

(a) In the intro paragraph, replace `Today that is **Claude** (your Claude subscription through Claude Code), with **GitHub Copilot** available as a preview.` with:

```markdown
That is **Claude** (your Claude subscription through Claude Code) or **GitHub Copilot** (your Copilot plan through VS Code's Language Model API).
```

(b) In "## Requirements", replace the line `  - **GitHub Copilot (preview):** the GitHub Copilot extension installed and signed in. Agent Stream detects your Copilot models. Running steps with Copilot comes in a later version.` with:

```markdown
  - **GitHub Copilot:** the GitHub Copilot extension installed and signed in to a Copilot plan. The first run or chat on Copilot asks you to allow Agent Stream to use it.
```

(c) In the **Model and effort** bullet, replace `or Claude Code's own default when they are empty` with `or the provider's own default when they are empty (Claude Code's default; Auto on Copilot)`. In the **Status bar** bullet, replace `` `Copilot (preview)` `` with `` `Copilot` ``.

(d) In "## Settings":
- the provider line becomes ``- `agentStream.provider` — `claude` (default) or `copilot`.``;
- in the `agentStream.model` line, `Empty (default): Claude Code's default.` becomes `Empty (default): the provider's default (Claude Code's default; Auto on Copilot).`;
- add after the `agentStream.maxParallel` line:

```markdown
- `agentStream.copilot.maxRequestsPerStep` — GitHub Copilot: the most model requests one agent step may make (default 25, 1–200). A step that reaches it stops with a message naming this setting.
- `agentStream.copilot.maxRequestsPerTurn` — GitHub Copilot: the most model requests one planner chat message may make (default 10, 1–100).
```

(e) In "## Providers", replace the heading `### GitHub Copilot (preview)` and its paragraph with:

```markdown
### GitHub Copilot

Agent Stream runs agent steps and the planner on your Copilot plan through VS Code's Language Model API. It doesn't use Copilot's own agent tools: Copilot works through Agent Stream's tools (Read, Grep, Glob, Edit, Write and Bash). So the rules are the same as with Claude:
- every file edit and shell command waits for your approval;
- read-only steps get only Read, Grep and Glob;
- the variable values file and run records stay private.

How Copilot behaves:
- **Models:** the Model menus list the Copilot models that can call tools, with **Auto** first. **Default** means Auto. A model that is no longer available falls back to Auto, and the step's log says so. Copilot has no effort levels, so the Effort menu hides.
- **Permission:** the first run or chat on Copilot shows VS Code's dialog asking whether Agent Stream may use Copilot. If you decline, the step fails and says how to allow it later (**Accounts › Manage Language Model Access**).
- **Request cap:**
  - Each agent step may make up to `agentStream.copilot.maxRequestsPerStep` model requests (default 25), and each planner message up to `agentStream.copilot.maxRequestsPerTurn` (default 10).
  - The run dialog shows `Copilot requests per step: up to <n>`, and each step's log ends with `Copilot requests: <n> of <cap>`.
  - Whether these requests count against your plan's premium requests depends on your Copilot plan. Agent Stream doesn't track it.
- **Long conversations:** when a conversation nears the model's input limit, older turns are summarised in one extra request, which counts toward the cap. If that isn't possible, they are dropped with a note.
- **Planner chat:** the conversation is kept in your session (`.agent-stream/sessions/<id>/transcripts/`), so it continues after a VS Code reload. **New chat** deletes it.
```

(f) In "## Files it writes", on the `sessions/<id>/` line, replace `open tabs and planner chats` with `open tabs, planner chats and Copilot planner transcripts`.

- [ ] **Step 7: Add the Copilot steps to the Windows checklist**

In `docs/windows-checklist.md`, replace step 2 with:

```markdown
2. Run **Agent Stream: Select Provider** and choose GitHub Copilot. Without a signed-in Copilot, the status bar shows `Agent Stream: Copilot not available` and Run is refused with that message. With one, it shows `Copilot`, and its tooltip lists the models. Switch back to Claude; the status bar shows your plan again.
```

Insert this block right before the final line `Report anything that differs, with the step number and a screenshot.`:

```markdown
**GitHub Copilot.** Use a VS Code signed in to GitHub Copilot, and a Git repository you can change. Select GitHub Copilot with **Agent Stream: Select Provider**.

23. **Consent.** The status bar tooltip says `Copilot will ask for permission the first time a run or chat uses it.` When you start the run in step 24, VS Code asks whether Agent Stream may use Copilot. Choose Allow.
24. **Two-step graph.** Make a graph with an agent step "Add a line `hello` to notes.txt" (Can edit files), followed by an agent step "Run `git status` with Bash and report what it says". Run it.
    - The run dialog shows `Copilot requests per step: up to 25`.
    - The first step asks for approval before its Edit or Write. Approve it, and `notes.txt` changes.
    - The second step asks before its Bash call. Approve it. Its log shows the tool call, the result ending with `exit code 0`, and the model's summary.
    - Each step's log ends with `Copilot requests: <n> of 25`.
25. **Deny.** Re-run from the first step and deny its edit. Its log shows `Denied by the user.`, and `notes.txt` is unchanged.
26. **Stop.** Ask an agent step to run `sleep 600` with Bash, approve it, then press Stop. The step is cancelled, and Task Manager shows no `bash.exe` or `sleep.exe` left from it.
27. **Planner chat.** In the chat, ask the planner to add a step; it appears on the canvas.
    - Reload the window (**Developer: Reload Window**) and ask a follow-up about that step. The planner answers with the earlier conversation in mind.
    - Press **New chat**. The next message starts fresh.
28. **Request cap.** Set `agentStream.copilot.maxRequestsPerStep` to 1 and run a step that needs to read a file. It stops with `Stopped after 1 Copilot requests (agentStream.copilot.maxRequestsPerStep). Raise the setting to let steps run longer.` Reset the setting afterwards.
```

- [ ] **Step 8: Commit the docs**

```bash
git add README.md extension/README.md docs/windows-checklist.md
git commit -m "docs: GitHub Copilot runs steps and the planner; Windows checklist steps

Providers section, the two cap settings, requirements and status bar text,
the transcripts folder, and manual Copilot steps (consent, approve and deny,
Bash and Stop, planner after a reload, the cap).

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 9: Full verification**

Run each from the repo root, without `AGENT_STREAM_LIVE` set:

```bash
npm test
npm run typecheck
npm run build
npm run test:integration -w extension
```

Expected: every command exits 0. `npm test` runs the shared, engine, web and extension suites; the live tests skip themselves. The integration run prints its suite passing, with the Copilot status settled and no Copilot request sent.

Then check what's left:

```bash
git status --short
rg -n "COPILOT_NOT_IMPLEMENTED|Copilot \(preview\)|preview: true" --glob '!docs/superpowers/**' .
```

Expected:
- `git status --short` shows only the untracked `logs/` and `.DS_Store`.
- The search finds nothing outside the plans and specs.

Don't push, and don't run `npm run package`.

---

## Self-review (done while writing this plan)

**1. Spec coverage.** Each spec section maps to a task:

| Spec | Task |
|---|---|
| §1 success: a graph with edit steps runs on Copilot with approval cards and logs | 3, 5, 9, 10 (manual: 11) |
| §1 success: the planner works across turns and after a reload | 7, 9 (manual: 11) |
| §1 success: a step can't exceed the cap | 5 (cap), 6 (R5), 9, 10 |
| §1 success: no test needs a Copilot account | Global Constraints; `fakeChatModel` (5), `fakeLmModel` (8) |
| §2 verified facts (tool calling, `auto`, internal ids) | 9 (R17, filtering) |
| §3 decisions: approach, tools, models, effort, cap, planner history, long history | 2–5, 9, 9, 9, 9–10, 7, 6 |
| §4.1 `ChatModel`, `ChatModelError` | 2 |
| §4.2 tools, general rules, read-only, gate names | 2, 3 |
| §4.3 `createRunShell`, command executor unchanged | 1 |
| §4.4 `toLoopTools` | 4 |
| §4.5 `runAgentLoop` (rounds, cap text, cancellation, errors) | 5 (cap text: 9 via R1) |
| §4.6 compaction (estimate, 75 %, keep 40 %, summary, pairs, fallback) | 6 |
| §5.1 adapter (messages, justification, cancellation, streaming, errors) | 8 |
| §5.2 models, cache, status and consent, model resolution | 9 |
| §5.3 `runStep` (start, tools, preamble, events, outcome, request line) and `planTurn` (history, resumeFailed, tools, gate, events, save) | 9 |
| §5.4 error messages | 8 |
| §5.5 wiring, settings, run dialog line, retired strings, status bar `Copilot` | 10, 11 |
| §6 transcripts (store, files, New chat, Claude ignores) | 7 |
| §7 error table | declined consent and quota (8, 9); cap (9); malformed input (5); Stop (3, 5, 9); transcript missing (7, 9); model gone (9, 11; tooltip: R20) |
| §8 tests | named under "Spec tests owned" in every task |
| §8 manual | 11 (Windows checklist steps 23–28) |
| §9 out of scope | nothing implemented; the README says premium requests aren't tracked |

**2. Placeholder scan.** Every code step contains its code, and every test step its test code. No step says "add tests", "handle errors" or "similar to Task N" without the code.

**3. Type consistency.** Names used in more than one task are spelled the same everywhere:
- `RunShell`, `RunShellResult`, `createRunShell` (1, 3, 9, 10);
- `ChatMessage`, `ChatPart`, `ToolSpec`, `ChatModel`, `ChatModelError`, `ChatModelErrorCode` (2, 5–9);
- `LoopTool`, `ToolOutput`, `builtinTools`, `readOnlyTools`, `clipResult` (2, 3, 5, 6, 9);
- `toLoopTools(tools, gatePrefix)` (4, 5, 9);
- `runAgentLoop`, `LoopOptions.capMessage`, `LoopResult`, `lastAssistantText` (5, 6, 9);
- `compactIfNeeded`, `SUMMARY_PREFIX`, `DROPPED_NOTE` (6);
- `TranscriptStore`, `PlannerTurn.transcript`, `Transcripts`, `SessionStore.transcripts` (7, 9);
- `AgentProvider.stepRequestCap`, `AgentProvider.modelInUse` (9, 10, 11);
- `vscodeChatModel`, `COPILOT_PERMISSION`, `JUSTIFICATION` (8, 9);
- `createCopilotProvider(CopilotDeps)`, `LmAccess`, `CopilotLimits` (9, 10);
- `Settings.copilotMaxRequestsPerStep`, `Settings.copilotMaxRequestsPerTurn` (10);
- `RunPreview.copilotRequestsPerStep` (11);
- test helpers `fakeChatModel`, `textPart`, `toolCallPart`, `userText`, `allowAll`, `untilAborted` (5–7) and `fakeLmModel` (8, 9).

**4. Review Focus.** Each of the five has a test in its owning task: 1 in Task 5, 2 in Task 3, 3 in Task 2, 4 in Task 6, and 5 in Task 7.
