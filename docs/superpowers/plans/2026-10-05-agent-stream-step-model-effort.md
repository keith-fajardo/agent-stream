# Agent Stream — Model and Effort per Step, Save/Undo, and Attachments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Phase 1: each agent step can have its own model and effort (Node panel, canvas chip, Markdown file, planner tools), resolved once when a run starts and shown in the run dialog, the step log and the Run Report; the graph tab gets ⌘S save and ⌘Z undo with toasts. Phase 2: files and photos can be attached to a step, to the whole graph, or to one planner chat message.

**Architecture:**
- **Shared (pure):** `stepModels.ts` (parse/format a step model, resolution rules §3.2, the dialog lines); `undo.ts` (undo state, undo operations, labels); `attachments.ts` (names, types, limits). `GraphNode` gains `model`, `effort` (phase 1) and `attachments` (phase 2); `Graph` gains `attachments`; the Markdown parser/writer and `diffToOps` carry them.
- **Engine:** the App resolves `RunMeta.stepModels` at start and the Runner gives each agent step its own model/effort; providers record what they actually sent in the `start` event; the planner gets `list_models`; the App keeps per-tab undo stacks and applies batches through `GraphStore.applyBatch`. Phase 2: `AttachmentStore` (`.agent-stream/attachments/<graph>/`), run snapshot hashes, `Attached files:` prompts and images per provider, chat attachments in the session folder.
- **Web:** Node panel Model/Effort menus, the model chip, per-step lines in the run dialog, ⌘S/⌘Z, File › Save, Edit › Undo, batched edits; phase 2 attachment lists (Node panel, Graph panel) and chat attachments.
- **Extension:** Copilot records the model it ran on and never sends an effort; phase 2 Add… (VS Code file picker), Open, Copilot image parts.

**Tech Stack:** TypeScript 7 (strict, noEmit), npm workspaces (`shared`, `engine`, `web`, `extension`), Vitest 5, zod 4 (already in `shared`), React 19, VS Code extension API (`@types/vscode` 1.106.1), Claude Agent SDK 0.3.287, codex-cli 0.160 app-server protocol. No new runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-10-05-agent-stream-step-model-effort-design.md` (committed at 86ee8a0). It is the binding authority; every §n below refers to it. Phase 1 is §§2–6a, phase 2 is §6b.

**Order:**
- **Phase 1** (Tasks 1–11, shippable on its own): data model (1), Markdown and store (2), resolution rules (3), runs and providers (4), run dialog and Run Report (5), planner (6), Node panel (7), canvas chip (8), undo in the engine (9), keyboard, menus and batched edits in the tab (10), docs and full verification (11).
- **Phase 2** (Tasks 12–20): feasibility check and attachment rules (12), data model (13), Markdown (14), storage and Add/Remove/Open (15), runs (16), providers (17), chat attachments (18), tab UI (19), docs and verification (20).

**Code in this plan:** new files are given in full. Changes to existing files are unified diffs against the file as the previous task left it (`index` lines left out). Apply a diff by hand, or save the block to a file in your scratchpad (outside the repo) and run `git apply <file>` from the repo root; if `git apply` refuses a hunk, stop and report rather than editing around it. Every diff was produced from a dry run of this plan (see "Dry run" at the end).

**Planning rulings** (decided while writing this plan; each costs a small rework if wrong):

*Phase 1*
- **R1. Copilot has no effort option (§6).** The installed `@types/vscode` 1.106.1 has only `LanguageModelChatRequestOptions.modelOptions?: { [name: string]: any }`, documented as model-specific, with no effort or reasoning key, and `LanguageModelChat` reports no reasoning capability. So Copilot steps show Effort as **Not supported**, Copilot never sends an effort, and a stored effort on a Copilot step is ignored with the note `GitHub Copilot has no effort levels; running without an effort level.` Task 1 Step 1 re-checks the installed file.
- **R2. Clearing:** `NodePatch.model: null` and `effort: null` clear (§2.1). In Markdown, removing the line is the clear (`diffToOps` emits `null`).
- **R3. Field order:** `kind, access, workspace, timeout, model, effort` (phase 2 appends repeatable `attach`). The unknown-field message lists them all.
- **R4. Resolution (§3.2):** a step with neither its own model nor effort gets exactly the run's model and effort, unfiltered, as today (the provider drops an effort its model lacks, with its existing log note). A step with its own model or effort is resolved by `resolveStepModel`: rules 1–3 for the model; the effort (its own, else the run's) is checked by `effortProblem`, which mirrors the providers' rules and wording (without the `[agent-stream] ` prefix). A dropped effort adds a note only when it was the step's own. Notes are joined with a space.
- **R5. "Known" model list:** the provider's `knownModels()` at preview and at start (never waiting, as the run dialog does today). An empty list counts as unknown. `findModel` also matches a full id through an alias's `resolved` (`claude-sonnet-5` → `sonnet`).
- **R6. Copilot rule 2:** a model the known list doesn't name gets the "isn't offered" note but the stored id is still tried; Copilot's own `pick()` then falls back to Auto with its existing note. A model Copilot refuses at request time (core-only) keeps today's behaviour: that step fails with the existing message, the model is blocked for the window, and later steps fall back to Auto.
- **R7. Grammar:** the other-provider note uses "an" before a vowel: `This step is set to an OpenAI Codex model (gpt-6-astra); this run uses Claude, so it uses the default model.`
- **R8. Re-runs (§3.1 "re-runs use the snapshot"):** each step's model and effort are resolved once at start and kept in `RunMeta.stepModels`; a step the re-run reuses keeps the source run's entry (or, for a run from before this feature, the source's run-wide model and effort). A step whose model or effort changed is not reused (`reusableNodeIds`), and `contentSignature` includes both.
- **R9. Step log:** providers put the model and effort they actually send in the `start` event; the Runner logs any note as a `text` event right after `start`.
- **R10. Run dialog:** a step gets `PreviewStep.modelLine` only when it has its own model or effort and the result differs from the run's; `modelNote` becomes a `⚠` line. Both render under the step's (collapsed) prompt, outside the `<details>`, so a warning is never hidden.
- **R11. Run Report:** each agent step of a run with `stepModels` gets `Model: … · Effort: …` (the dialog's `modelLine` wording, so Copilot reads `not supported`) and `_Note:_ …`. Runs from before get no line.
- **R12. Planner:** `model` is a string `"<provider>/<id>"`; in `update_node`, `""` clears model or effort. `list_models` returns `{ provider, models: [{ id, name, efforts, default? }] }`; with no list it answers `The current provider's models can't be listed right now; leave model on Default.` Claude's `default` row is marked `default`.
- **R13. Graph tabs get the model list:** the engine sends `models` to a tab after `graphOpened`, and to every tab (and chat) when the provider or the settings change.
- **R14. Node panel:** Model and Effort are part of the panel's draft (saved by Save, one `updateNode`). Claude's `default` alias is listed like the other aliases (§4.1 names it). With the list unknown, Effort offers Default and the stored level only. **Use Default** also appears next to a disabled Effort that holds a stored level (a Copilot step from a Claude user), so it can be cleared. Picking a model drops a stored effort it doesn't offer.
- **R15. Chip:** the display name from the current list, else the id; in the warning state always the id; effort only: `· max`.
- **R16. Undo (§6a.2):** two new client messages, `ops` (several edits that are one action: applied all or none, one undo step, labelled by the tab) and `undo`; two server messages, `undoState` (Edit › Undo's label) and `undone` (the toast). Stacks are per tab (the client object) and graph, at most 50, in memory. "The graph still equals the entry's after" compares `undoState()`: content and positions, ignoring order, the name and bookkeeping. Undo applies `undoOps` (`diffToOps(current, graphAsDoc(before))` plus moves; `moveNode` with `position: null` puts a step back on the automatic layout; a lone `renameVariable` is renamed back) through `GraphStore.applyBatch` with `via: 'undo'`. Accept and Revert are not undo steps; a Revert in a tab clears that tab's stack. The tab batches: one drag, deleting a selection, Tidy (always one batch), the Graph panel's Save, the Variables dialog's Save.
- **R17. ⌘S (§6a.1):** handled on `document` in the graph tab, skipped when a field already handled it (`defaultPrevented`, the Markdown editor). The step toast shows when the save is sent (a refusal replaces it with its own toast). `Graph saved.` also re-sends unconfirmed moves. `Saved.` shows on every Markdown save that wrote without errors. ⌘Z is left to the field in `INPUT`, `TEXTAREA` and content-editable elements; ⇧⌘Z does nothing.
- **R18. Menu shortcuts** render through a `data-shortcut` attribute and CSS `::after`, so menu item text (and the menu tests) stay as they are apart from the new items.

*Phase 2* (Task 12 re-verifies the first three against the installed packages)
- **P1. Claude:** `SDKUserMessage.message` is an Anthropic `MessageParam`, so a step's or a chat message's images (`image`, base64) and a chat message's PDFs (`document`, base64) go in one user message sent as streaming input that then ends. `QueryFn`'s prompt widens to `string | AsyncIterable<SDKUserMessage>`.
- **P2. Codex:** codex-cli 0.160's generated `UserInput` has `{ type: 'localImage', path }`, so images go with `turn/start` and Codex reads them from disk. No PDF input exists: a step's PDF is listed with a note, a chat message's PDF gets `couldn't be included`.
- **P3. Copilot:** `LanguageModelDataPart` (constructor `(data, mimeType)`) is accepted in user messages in `@types/vscode` 1.106. Whether a model takes images is only known at runtime from `capabilities.supportsImageToText` (untyped, like `supportsToolCalling`): images go only to a model reporting `true`; otherwise the step's list says `This image couldn't be shown to the model.` and a chat message gets a note. Saved Copilot transcripts keep `[An image was attached here.]` instead of the bytes.
- **P4. Names:** Unicode letters and digits, `.`, `-`, `_`, space; at most 100; no leading or trailing dot or space; not a Windows device name. Clashes and duplicates compare in any letter case (macOS and Windows file systems).
- **P5. `## Attachments` is a reserved section** (like Goal). A step heading `## n1 · Attachments` stays a step.
- **P6. Files on remove and undo:** Remove deletes the file only when nothing else in the graph names it; deleting a step deletes no file. Undo of a Remove writes the removed bytes back (kept in the undo entry, in memory); undo of an Add deletes the files it wrote that nothing names any more.
- **P7. One-time notice:** sent with the first file of a graph's attachments folder.
- **P8. Chat 📎** uses the webview's own file input (the files go with the message anyway); Add… for steps and the graph uses VS Code's picker through the extension, which refuses an oversize file before reading it. A chat message still needs text.
- **P9. Privacy:** the sessions folder (chat attachments) is closed to Claude's Read/Grep/Glob too, with the agent loop's existing message. The graph attachments folder is not private (§6b.5).
- **P10. Reuse** compares a step's attachment names (its own, then the graph's) and, when both runs recorded them, their SHA-256.
- **P11. A missing file** gives a run-dialog warning and a step-log line; the prompt lists only files that are there.
- **P12. The planner** sees attachment names in `get_graph`; there is no tool to add or remove them.

## Global Constraints

- TypeScript strict everywhere. `npm run typecheck` passes after every task. `engine/` and `shared/` never import `vscode`; `shared/` has no Node APIs.
- No new runtime dependencies. Node ≥ 20.11.
- Tests use temp folders (`tmpProject()`, `mkdtempSync`), no network, no real Claude, Codex, Copilot or git. Paths in tests are built with `join`/`resolve` so they pass on Windows CI; files are written with LF.
- The repo is public: no credentials, emails or absolute home paths in code, tests or fixtures.
- Run every command from the repo root, on branch `feat/step-model-effort`. Never push, never run `npm run package`, never set `AGENT_STREAM_LIVE`. Don't touch or stage `logs/`, `.DS_Store`, `.agent-stream/` or `.superpowers/`. Stage files by name (`git add <paths>`), never `git add -A` or `git add .`.
- Every commit message ends with a `Co-Authored-By:` trailer naming the model that wrote the commit. The steps show `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; a different model writes its own name.
- Existing tests keep their assertions. The only exceptions, each forced by a new feature, are named in their task: the unknown-field message in `shared/test/graphMarkdownParse.test.ts` (Tasks 2 and 14); Copilot's start event naming its model in `extension/test/copilot.test.ts` (Task 4); the planner tool lists in `engine/test/plannerTools.test.ts` and `engine/test/planner.test.ts` (Task 6); the File menu list in `web/test/menuModel.test.ts`, the Edit menu list in `web/test/MenuBar.test.ts` and three Save assertions in `web/test/VariablesDialog.test.ts` (Task 10); type-only edits of the fake query in `engine/test/claudeModels.test.ts`, `claudePlanTurn.test.ts` and `claudeRunStep.test.ts` (Task 17). Test helpers may gain options (Tasks 17, 18). If any other existing test fails, stop and report it instead of changing it.
- New tests that wait on a run use `vi.waitFor(…, { timeout: 5000 })`: CI runners are slow.
- Exact user-facing strings (pinned by the tests in the task named):
  - `Only agent steps have a model or effort.` (1); parse: `model "<v>": the provider must be claude, codex or copilot, as in claude/opus.`, `model "<v>": write the model id after "<p>/" (1 to 200 characters, no spaces), as in claude/opus.`, `effort is "<v>"; use low, medium, high, xhigh, max or ultra.`, `step <label> is a command step, so it can't have a model or effort. Remove this line, or make it an agent step.`, `unknown field "<f>". Step fields are kind, access, workspace, timeout, model and effort.` (2; `…, effort and attach.` from 14).
  - Notes (3): `This step is set to a/an <Provider> model (<id>); this run uses <Provider>, so it uses the default model.`, `<id> isn't offered by <Provider> any more (or on this plan), so this step uses the default model.`, `<label> (<id>) has no "<level>" effort level; running without an effort level.`, `Claude has no "ultra" effort level; running without an effort level.`, `GitHub Copilot has no effort levels; running without an effort level.`
  - Run dialog (5): `Model: <label> · Effort: <label>` and `⚠ <note>`. Run Report: `Model: … · Effort: …`, `_Note:_ …`.
  - Planner (6): the two `PLANNER_APPEND` lines of §5 verbatim; `The current provider's models can't be listed right now; leave model on Default.`
  - Node panel (7): `Model`, `Effort`, `Default (the run's model)`, `Pinned versions`, `<Provider> · <id> (not the current provider)`, `<id> (not offered)`, `Use Default`, `Default`, `Not supported`, `<level> (not offered)`.
  - Toasts (9, 10): `Step <id> saved.`, `Graph saved.`, `Saved.`, `Can't save: <id>.md has errors. Fix the file first.`, `Undid <label>.`, `Nothing to undo.`, `Can't undo: the graph changed since (by the planner, a run, the file or another tab).`, `Can't undo: <id>.md has errors. Fix the file first.` Menus: File › `Save` (⌘S / Ctrl+S), Edit › `Undo <label>` / `Undo` (⌘Z / Ctrl+Z). Labels: `moved n3`, `moved 2 steps`, `deleted n3`, `deleted 3 steps`, `deleted the connection n1 → n2`, `deleted 2 steps and 1 connection`, `saved n3`, `added n3`, `connected n1 → n2`, `tidied the layout`, `saved the Markdown`, `edited the goal`, `edited the instructions`, `edited the goal and instructions`, `edited the variables`, `attached <names>`, `removed <name>`.
  - Attachments (12–19): `Only agent steps have attachments.`, `Attachments are saved with the graph (and committed) and sent to your AI provider. Don't attach secrets.`, `<name> can't be attached. Attach images (png, jpg, gif, webp), PDFs, and text files (md, txt, csv, tsv, json, yaml, sql, xml, html, log, or source code).`, `<name> is larger than 10 MB (the limit for images).`, `<name> is larger than 5 MB.`, `Attached files:`, `image, attached to this message`, `PDF: read it with the Read tool`, `PDF: the model may not be able to read PDFs`, `This image couldn't be shown to the model.`, `Attachment <name> is missing from .agent-stream/attachments/<graph>/, so this step runs without it.`, `<name> couldn't be included: <why>.`

## Review Focus

Five inputs the spec implies but the obvious tests would not exercise, most likely first. Each is pinned in the task that owns the code.

1. **Undo after someone else changed the graph.** The planner, a run, a file edit or another tab changes the graph after this tab's edit; ⌘Z must refuse and clear the stack, never discard their change. Pinned in Task 9: `engine/test/undo.test.ts` › "refuses after a change by the planner, another tab or the file, and clears the stack".
2. **A graph shared between people on different providers or plans.** A step set to `codex/gpt-6-astra` opened by a Claude user, or a model no longer offered: the file must open, the run must use the default model with a visible note (dialog, log, report, struck-through chip), and nothing may block. Pinned in Task 3 (`stepModelResolve.test.ts`), Task 5 (`stepModelReport.test.ts`) and Task 8 (`modelChip.test.ts`).
3. **The model list isn't known yet when a run starts.** Starting a run never waits for it; a step must then try its own model rather than fall back. Pinned in Task 4: `stepModelRun.test.ts` › "with no model list known yet, a step tries its own model".
4. **A step switched to a command step.** Its model, effort and attachments must go, whether switched in the panel, by the planner or by a hand edit. Pinned in Task 1 (`stepModels.test.ts` › "drops both when the step becomes a command step"), Task 2 (`stepModelsMarkdown.test.ts`) and Task 13 (`attachmentsGraph.test.ts`).
5. **A cloned graph whose attachment files aren't there yet.** The file must open, a run must warn and go on. Pinned in Task 14 (`attachmentsMarkdown.test.ts` › "a missing file is not an error") and Task 16 (`attachRun.test.ts`).

## File map

| Area | Files | Tasks |
|---|---|---|
| Shared data | `shared/src/types.ts`, `schemas.ts`, `graph.ts`, `graphDoc.ts`, `changes.ts`, `stepModels.ts` (new), `undo.ts` (new), `attachments.ts` (new), `index.ts` | 1, 3, 5, 9, 12, 13, 15, 16, 18 |
| Markdown | `shared/src/graphMarkdownParse.ts`, `graphMarkdownWrite.ts`, `graphMeta.ts`, `diffToOps.ts`, `docs/graph-format.md` | 2, 14 |
| Engine runs | `engine/src/runner.ts`, `executors.ts`, `app.ts`, `runPreview.ts`, `runReport.ts`, `attachedFiles.ts` (new) | 4, 5, 16 |
| Providers | `engine/src/providers/claude/{sdk,runStep,planTurn}.ts`, `codex/{protocol,turn,runStep,planTurn}.ts`, `extension/src/providers/{copilot,copilotModel}.ts`, `engine/src/agentLoop/{chatModel,compact,tools}.ts` | 4, 17, 18 |
| Planner | `engine/src/planner.ts`, `plannerTools.ts`, `privatePaths.ts`, `chatAttachments.ts` (new) | 6, 18 |
| Store, undo | `engine/src/graphStore.ts`, `undoStacks.ts` (new), `attachmentStore.ts` (new), `paths.ts`, `fsutil.ts` | 2, 9, 15 |
| Web | `web/src/components/{NodePanel,StepNode,Canvas,RunConfirmDialog,MenuBar,GraphPanel,VariablesDialog,ChatPanel,ChangesPanel,AttachmentList}.tsx`, `web/src/{state,actions,menuModel,flowNodes,selection,shortcuts,stepModelMenus,uploads}.ts`, `App.tsx`, `styles.css` | 7–10, 19 |
| Extension | `extension/src/graphEditor.ts` | 15 |
| Docs | `README.md`, `extension/README.md`, `docs/graph-format.md` | 2, 11, 14, 20 |

**How the pieces talk (read this before any task):**
- A step stores `model?: { provider, id }` and `effort?`. `parseStepModel('claude/opus')` and `stepModelText()` convert to and from the file and planner text.
- At `startRun`, the App calls `runStepModels(graph, { provider, model, effort }, knownModels(), reusedIds, sourceRun)` and passes the result to `Runner.start({ stepModels })`; the Runner stores it in `RunMeta.stepModels`, hands each agent step `ctx.model`/`ctx.effort` from its entry, and logs `entry.note` after the step's `start` event. `previewRun`'s caller adds the dialog lines with `withStepModelLines`.
- Undo: every `op`/`ops` from a tab records `{ before, after, label, ops }` in `UndoStacks` keyed by that tab's `Client`; `undo` compares `undoState(current)` with `undoState(entry.after)`, then applies `undoOps(current, entry.before, entry.ops)` with `GraphStore.applyBatch(…, { via: 'undo' })`.
- Phase 2: `attach`/`detach` messages write files through `AttachmentStore` and change the lists with ordinary ops; the Runner builds `ctx.attachments` (`StepAttachment[]`) from the snapshot; each provider calls `withAttachedFiles(prompt, ctx.attachments, notes)` and sends images its own way.

---

# Phase 1 — model and effort per step, save and undo

### Task 1: The step's model and effort in the data model

**Spec covered:** §2.1 (fields, refusal on command steps, kind switch drops them, null clears, `ChangedField`), §6 (the Copilot check), §7 shared `applyOp` tests.

**Files:**
- Create: `shared/src/stepModels.ts`
- Modify: `engine/src/stepGraphTools.ts`, `shared/src/changes.ts`, `shared/src/graph.ts`, `shared/src/graphDoc.ts`, `shared/src/index.ts`, `shared/src/schemas.ts`, `shared/src/types.ts`, `web/src/components/ChangesPanel.tsx`
- Test: `shared/test/stepModels.test.ts` (new)

**Interfaces:**
- Consumes: nothing new.
- Produces:
  ```ts
  // shared/src/types.ts
  export type StepModel = { provider: ProviderId; id: string };
  // GraphNode and NewNodeInput gain model?: StepModel; effort?: EffortLevel. NodePatch gains model?: StepModel | null; effort?: EffortLevel | null.
  // ChangedField gains 'model' | 'effort'.
  // shared/src/stepModels.ts
  export const MAX_MODEL_ID_CHARS = 200;
  export const ONLY_AGENT_STEPS_MODEL = 'Only agent steps have a model or effort.';
  export function isProviderId(value: string): value is ProviderId;
  export function isModelId(id: string): boolean;
  export function stepModelText(m: StepModel): string; // 'claude/opus'
  export function parseStepModel(text: string): { ok: true; model: StepModel } | { ok: false; error: string };
  export function stepModelProblem(model: StepModel | undefined, effort: EffortLevel | undefined): string | null;
  // shared/src/changes.ts
  export function changedFieldText(node: GraphNode | undefined, field: ChangedField): string;
  // contentSignature and reusableNodeIds now include model and effort (R8).
  ```

- [ ] **Step 1: Check the Copilot effort option (§6, ruling R1)**

Run: `grep -n "modelOptions" node_modules/@types/vscode/index.d.ts && grep -n '"version"' node_modules/@types/vscode/package.json`
Expected: version `1.106.1`, and `modelOptions?: { [name: string]: any };` in `LanguageModelChatRequestOptions` with the doc comment "These options are specific to the language model and need to be looked up in the respective documentation": no documented effort or reasoning option. Then ruling R1 stands (Copilot effort is **Not supported**; Task 4 pins that Copilot never sends one). If the installed types now document an effort or reasoning option, stop and report: the plan then needs a task that sends it behind the per-model rule.

- [ ] **Step 2: Write the failing tests**

Create `shared/test/stepModels.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { changedFields, changedFieldText, diffGraphs } from '../src/changes';
import { applyOp, contentSignature, emptyGraph, reusableNodeIds } from '../src/graph';
import { canonicalGraph } from '../src/graphDoc';
import { parseGraph, parseWebviewMessage } from '../src/schemas';
import { ONLY_AGENT_STEPS_MODEL, parseStepModel, stepModelProblem, stepModelText } from '../src/stepModels';
import type { Graph, GraphNode, NodeRunState, Op } from '../src/types';

const T = '2026-10-05T00:00:00.000Z';
function build(ops: Op[]): Graph {
  let g = emptyGraph('g', 'G', T);
  for (const op of ops) {
    const r = applyOp(g, op, 'user', T);
    if (!r.ok) throw new Error(r.error);
    g = r.graph;
  }
  return g;
}
function apply(g: Graph, op: Op): Graph {
  const r = applyOp(g, op, 'user', T);
  if (!r.ok) throw new Error(r.error);
  return r.graph;
}
const refused = (g: Graph, op: Op) => {
  const r = applyOp(g, op, 'user', T);
  return r.ok ? 'applied' : r.error;
};
const opus = { provider: 'claude' as const, id: 'opus' };
const agent = (over: Partial<GraphNode> = {}): Op => ({ type: 'addNode', node: { title: 'a', kind: 'agent', prompt: 'p', ...over } });

describe('step model text', () => {
  it('reads <provider>/<id>: the id is everything after the first /', () => {
    expect(parseStepModel('claude/opus')).toEqual({ ok: true, model: opus });
    expect(parseStepModel('copilot/auto')).toEqual({ ok: true, model: { provider: 'copilot', id: 'auto' } });
    expect(parseStepModel('codex/org/gpt-6-astra')).toEqual({ ok: true, model: { provider: 'codex', id: 'org/gpt-6-astra' } });
    expect(stepModelText({ provider: 'codex', id: 'org/gpt-6-astra' })).toBe('codex/org/gpt-6-astra');
  });

  it('refuses an unknown provider and an empty, spaced or too long id, saying how to write it', () => {
    expect(parseStepModel('gpt/x')).toEqual({ ok: false, error: 'model "gpt/x": the provider must be claude, codex or copilot, as in claude/opus.' });
    expect(parseStepModel('opus')).toEqual({ ok: false, error: 'model "opus": the provider must be claude, codex or copilot, as in claude/opus.' });
    const idRule = 'write the model id after "claude/" (1 to 200 characters, no spaces), as in claude/opus.';
    expect(parseStepModel('claude/')).toEqual({ ok: false, error: `model "claude/": ${idRule}` });
    expect(parseStepModel('claude/my model')).toEqual({ ok: false, error: `model "claude/my model": ${idRule}` });
    expect(parseStepModel(`claude/${'x'.repeat(200)}`).ok).toBe(true);
    expect(parseStepModel(`claude/${'x'.repeat(201)}`).ok).toBe(false);
    expect(stepModelProblem(undefined, 'turbo' as never)).toBe('effort "turbo": use low, medium, high, xhigh, max or ultra.');
    expect(stepModelProblem(opus, 'high')).toBeNull();
  });
});

describe('applyOp: model and effort', () => {
  it('stores a model and an effort on an agent step, as copies', () => {
    const model = { provider: 'claude' as const, id: 'opus' };
    const g = build([agent({ model, effort: 'high' })]);
    expect(g.nodes[0]).toMatchObject({ model: opus, effort: 'high' });
    expect(g.nodes[0].model).not.toBe(model);
  });

  it('refuses them on a command step, on add and on update', () => {
    expect(refused(emptyGraph('g', 'G', T), { type: 'addNode', node: { title: 'c', kind: 'command', command: 'ls', model: opus } })).toBe(ONLY_AGENT_STEPS_MODEL);
    expect(refused(emptyGraph('g', 'G', T), { type: 'addNode', node: { title: 'c', kind: 'command', command: 'ls', effort: 'low' } })).toBe(ONLY_AGENT_STEPS_MODEL);
    const g = build([{ type: 'addNode', node: { title: 'c', kind: 'command', command: 'ls' } }]);
    expect(refused(g, { type: 'updateNode', id: 'n1', patch: { effort: 'high' } })).toBe(ONLY_AGENT_STEPS_MODEL);
    expect(refused(build([agent()]), { type: 'updateNode', id: 'n1', patch: { kind: 'command', command: 'ls', model: opus } })).toBe(ONLY_AGENT_STEPS_MODEL);
    // Clearing on a command step is no change, so it is allowed.
    expect(refused(g, { type: 'updateNode', id: 'n1', patch: { model: null, effort: null } })).toBe('applied');
  });

  it('refuses a malformed model or effort that bypassed a schema', () => {
    expect(refused(emptyGraph('g', 'G', T), agent({ model: { provider: 'gemini' as never, id: 'x' } }))).toBe('model "gemini/x": the provider must be claude, codex or copilot, as in claude/opus.');
    expect(refused(build([agent()]), { type: 'updateNode', id: 'n1', patch: { model: { provider: 'claude', id: '' } } })).toContain('write the model id after "claude/"');
  });

  it('keeps them on other edits, changes them, and clears each with null', () => {
    let g = build([agent({ model: opus, effort: 'high' })]);
    g = apply(g, { type: 'updateNode', id: 'n1', patch: { title: 'renamed' } });
    expect(g.nodes[0]).toMatchObject({ title: 'renamed', model: opus, effort: 'high' });
    g = apply(g, { type: 'updateNode', id: 'n1', patch: { model: { provider: 'codex', id: 'gpt-6-astra' }, effort: 'ultra' } });
    expect(g.nodes[0]).toMatchObject({ model: { provider: 'codex', id: 'gpt-6-astra' }, effort: 'ultra' });
    g = apply(g, { type: 'updateNode', id: 'n1', patch: { model: null } });
    expect(g.nodes[0]).not.toHaveProperty('model');
    expect(g.nodes[0].effort).toBe('ultra');
    g = apply(g, { type: 'updateNode', id: 'n1', patch: { effort: null } });
    expect(g.nodes[0]).not.toHaveProperty('effort');
  });

  it('drops both when the step becomes a command step', () => {
    const g = apply(build([agent({ model: opus, effort: 'max' })]), { type: 'updateNode', id: 'n1', patch: { kind: 'command', command: 'ls' } });
    expect(g.nodes[0].kind).toBe('command');
    expect(g.nodes[0]).not.toHaveProperty('model');
    expect(g.nodes[0]).not.toHaveProperty('effort');
  });
});

describe('model and effort in the rest of the data model', () => {
  it('canonical form keeps them on agent steps only', () => {
    const g = build([agent({ model: opus, effort: 'low' }), { type: 'addNode', node: { title: 'c', kind: 'command', command: 'ls' } }]);
    const hidden: Graph = { ...g, nodes: [g.nodes[0], { ...g.nodes[1], model: opus, effort: 'low' }] };
    const canonical = canonicalGraph(hidden);
    expect(canonical.nodes[0]).toMatchObject({ model: opus, effort: 'low' });
    expect(canonical.nodes[1]).not.toHaveProperty('model');
    expect(canonical.nodes[1]).not.toHaveProperty('effort');
  });

  it('parseGraph reads them, refuses them on a command step, and refuses bad values', () => {
    const node = { id: 'n1', title: 'a', kind: 'agent' as const, prompt: 'p' };
    const ok = parseGraph({ id: 'g', name: 'G', nodes: [{ ...node, model: opus, effort: 'xhigh' }] });
    expect(ok.ok && ok.graph.nodes[0]).toMatchObject({ model: opus, effort: 'xhigh' });
    expect(parseGraph({ id: 'g', name: 'G', nodes: [{ ...node, kind: 'command', command: 'ls', effort: 'low' }] })).toEqual({ ok: false, error: `n1: ${ONLY_AGENT_STEPS_MODEL}` });
    expect(parseGraph({ id: 'g', name: 'G', nodes: [{ ...node, model: { provider: 'claude', id: 'two words' } }] }).ok).toBe(false);
    expect(parseGraph({ id: 'g', name: 'G', nodes: [{ ...node, effort: 'turbo' }] }).ok).toBe(false);
  });

  it('a client may set them on add, and set or clear them (null) on update', () => {
    const add = { type: 'op', graphId: 'g', op: { type: 'addNode', node: { title: 'a', kind: 'agent', model: opus, effort: 'high' } } };
    expect(parseWebviewMessage(add)).toEqual({ ok: true, kind: 'engine', msg: add });
    const clear = { type: 'op', graphId: 'g', op: { type: 'updateNode', id: 'n1', patch: { model: null, effort: null } } };
    expect(parseWebviewMessage(clear)).toEqual({ ok: true, kind: 'engine', msg: clear });
    expect(parseWebviewMessage({ type: 'op', graphId: 'g', op: { type: 'updateNode', id: 'n1', patch: { model: 'claude/opus' } } }).ok).toBe(false);
    expect(parseWebviewMessage({ type: 'op', graphId: 'g', op: { type: 'updateNode', id: 'n1', patch: { effort: 'turbo' } } }).ok).toBe(false);
  });

  it('agent-change review lists model and effort as changed fields, the model as provider/id', () => {
    const before = build([agent()]);
    const after = apply(before, { type: 'updateNode', id: 'n1', patch: { model: opus, effort: 'high' } });
    expect(changedFields(before.nodes[0], after.nodes[0])).toEqual(['model', 'effort']);
    expect(diffGraphs(before, after)).toEqual([{ kind: 'node', change: 'changed', id: 'n1', title: 'a', fields: ['model', 'effort'] }]);
    expect(changedFieldText(after.nodes[0], 'model')).toBe('claude/opus');
    expect(changedFieldText(before.nodes[0], 'model')).toBe('');
    expect(changedFields(after.nodes[0], { ...after.nodes[0], model: { ...opus } })).toEqual([]);
  });

  it('the content signature and re-run reuse follow them', () => {
    const g = build([agent(), agent(), { type: 'connect', from: 'n1', to: 'n2' }]);
    const allOk = Object.fromEntries(g.nodes.map((n) => [n.id, { status: 'succeeded' as const }])) as Record<string, NodeRunState>;
    const withModel = apply(g, { type: 'updateNode', id: 'n2', patch: { model: opus } });
    const withEffort = apply(g, { type: 'updateNode', id: 'n1', patch: { effort: 'low' } });
    expect(contentSignature(withModel)).not.toBe(contentSignature(g));
    expect(contentSignature(withEffort)).not.toBe(contentSignature(g));
    expect(reusableNodeIds(g, { snapshot: g, nodes: allOk })).toEqual(new Set(['n1', 'n2']));
    expect(reusableNodeIds(withModel, { snapshot: g, nodes: allOk })).toEqual(new Set(['n1']));
    expect(reusableNodeIds(withEffort, { snapshot: g, nodes: allOk })).toEqual(new Set());
  });
});
```

- [ ] **Step 3: Run the tests and see them fail**

Run: `npm test -w shared -- test/stepModels.test.ts`
Expected: FAIL — the new modules, exports or behaviour do not exist yet (import errors or assertion failures).

- [ ] **Step 4: Implement**

Create `shared/src/stepModels.ts`:

```ts
import { isEffortLevel } from './format';
import { PROVIDER_IDS, type EffortLevel, type ProviderId, type StepModel } from './types';

/** The longest model id a step can store. */
export const MAX_MODEL_ID_CHARS = 200;
/** applyOp's refusal for a model or effort on a command step (spec §2.1). */
export const ONLY_AGENT_STEPS_MODEL = 'Only agent steps have a model or effort.';
/** A provider's own model id: 1 to 200 characters, no whitespace; `/` is allowed (spec §2.1). */
const MODEL_ID_RE = /^\S{1,200}$/;

export const isProviderId = (value: string): value is ProviderId => (PROVIDER_IDS as readonly string[]).includes(value);
export const isModelId = (id: string): boolean => MODEL_ID_RE.test(id);
/** `claude/opus`: how the graph file, the planner and the Changes tab write a step's model. */
export const stepModelText = (m: StepModel): string => `${m.provider}/${m.id}`;

/** Why `<provider>/<id>` text can't be a step's model, without the text itself; null when it can. */
function modelTextProblem(provider: string, id: string): string | null {
  if (!isProviderId(provider)) return 'the provider must be claude, codex or copilot, as in claude/opus.';
  if (!isModelId(id)) return `write the model id after "${provider}/" (1 to ${MAX_MODEL_ID_CHARS} characters, no spaces), as in claude/opus.`;
  return null;
}

/** `claude/opus` as a step model: the provider is everything before the first `/`, the id everything after it. */
export function parseStepModel(text: string): { ok: true; model: StepModel } | { ok: false; error: string } {
  const slash = text.indexOf('/');
  const provider = slash < 0 ? text : text.slice(0, slash);
  const id = slash < 0 ? '' : text.slice(slash + 1);
  const problem = modelTextProblem(provider, id);
  if (problem) return { ok: false, error: `model "${text}": ${problem}` };
  return { ok: true, model: { provider: provider as ProviderId, id } };
}

/** Why a step can't have this model or effort, or null (applyOp's check, for input that didn't come through a schema). */
export function stepModelProblem(model: StepModel | undefined, effort: EffortLevel | undefined): string | null {
  if (model) {
    const problem = modelTextProblem(model.provider, model.id);
    if (problem) return `model "${stepModelText(model)}": ${problem}`;
  }
  if (effort !== undefined && !isEffortLevel(effort)) return `effort "${String(effort)}": use low, medium, high, xhigh, max or ultra.`;
  return null;
}
```

Change `engine/src/stepGraphTools.ts`:

```diff
diff --git a/engine/src/stepGraphTools.ts b/engine/src/stepGraphTools.ts
--- a/engine/src/stepGraphTools.ts
+++ b/engine/src/stepGraphTools.ts
@@ -28,8 +28,8 @@ const TITLE_PROBLEM = `a step title must be one line of at most ${MAX_TITLE_CHAR
 const titleProblem = (title: string | undefined) => (title !== undefined && (/[\r\n\u2028\u2029\u0085\v\f]/.test(title) || title.length > MAX_TITLE_CHARS) ? TITLE_PROBLEM : null);
 
 /** Changed fields in the order a person reads them: the text that runs first. */
-const FIELD_ORDER: ChangedField[] = ['prompt', 'command', 'title', 'description', 'kind', 'timeoutSec', 'access', 'workspace'];
-const FIELD_NAMES: Record<ChangedField, string> = { prompt: 'prompt', command: 'command', title: 'title', description: 'description', kind: 'kind', timeoutSec: 'timeout', access: 'access', workspace: 'workspace' };
+const FIELD_ORDER: ChangedField[] = ['prompt', 'command', 'title', 'description', 'kind', 'timeoutSec', 'access', 'workspace', 'model', 'effort'];
+const FIELD_NAMES: Record<ChangedField, string> = { prompt: 'prompt', command: 'command', title: 'title', description: 'description', kind: 'kind', timeoutSec: 'timeout', access: 'access', workspace: 'workspace', model: 'model', effort: 'effort' };
 /** "command", "prompt and description", "prompt, title and description". */
 const listed = (names: string[]) => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`);
 const unique = (ids: string[]) => [...new Set(ids)];
```

Change `shared/src/changes.ts`:

```diff
diff --git a/shared/src/changes.ts b/shared/src/changes.ts
--- a/shared/src/changes.ts
+++ b/shared/src/changes.ts
@@ -1,10 +1,17 @@
+import { stepModelText } from './stepModels';
 import type { AgentChange, ChangedField, Graph, GraphNode } from './types';
 
-const FIELDS: ChangedField[] = ['title', 'description', 'kind', 'prompt', 'command', 'timeoutSec', 'access', 'workspace'];
-const norm = (v: unknown) => (v === undefined || v === null ? '' : String(v));
+const FIELDS: ChangedField[] = ['title', 'description', 'kind', 'prompt', 'command', 'timeoutSec', 'access', 'workspace', 'model', 'effort'];
+
+/** A step field as text, for comparing and for the Changes tab: '' when absent, a model as `claude/opus`. */
+export function changedFieldText(node: GraphNode | undefined, field: ChangedField): string {
+  if (field === 'model') return node?.model ? stepModelText(node.model) : '';
+  const v = node?.[field];
+  return v === undefined || v === null ? '' : String(v);
+}
 
 export function changedFields(before: GraphNode, after: GraphNode): ChangedField[] {
-  return FIELDS.filter((f) => norm(before[f]) !== norm(after[f]));
+  return FIELDS.filter((f) => changedFieldText(before, f) !== changedFieldText(after, f));
 }
 
 /** What agents changed since the user's accepted baseline (agent changes spec §3.3). Positions and authorship are not content. */
```

Change `shared/src/graph.ts`:

```diff
diff --git a/shared/src/graph.ts b/shared/src/graph.ts
--- a/shared/src/graph.ts
+++ b/shared/src/graph.ts
@@ -1,4 +1,5 @@
 import { COMMAND_ALWAYS_WRITES, workspaceNameProblem } from './access';
+import { ONLY_AGENT_STEPS_MODEL, stepModelProblem, stepModelText } from './stepModels';
 import { variableNameProblem } from './variables';
 import type { Actor, Graph, GraphNode, GraphResult, NodePatch, NodeRunState, Op, RenderedRun } from './types';
 
@@ -74,6 +75,9 @@ export function applyOp(graph: Graph, op: Op, by: Actor, now: string, options: A
       if (!title) return fail('a node needs a title');
       if ((op.node.description?.length ?? 0) > MAX_DESCRIPTION_CHARS) return fail(DESCRIPTION_TOO_LONG);
       if (op.node.access === 'read' && op.node.kind === 'command') return fail(COMMAND_ALWAYS_WRITES);
+      const modelProblem = stepModelProblem(op.node.model, op.node.effort);
+      if (modelProblem) return fail(modelProblem);
+      if ((op.node.model || op.node.effort) && op.node.kind === 'command') return fail(ONLY_AGENT_STEPS_MODEL);
       const workspace = op.node.workspace?.trim() || undefined;
       const workspaceProblem = workspace === undefined ? null : workspaceNameProblem(workspace);
       if (workspaceProblem) return fail(workspaceProblem);
@@ -87,6 +91,8 @@ export function applyOp(graph: Graph, op: Op, by: Actor, now: string, options: A
         timeoutSec: op.node.timeoutSec,
         access: op.node.access === 'read' ? 'read' : undefined,
         workspace,
+        model: op.node.model && { provider: op.node.model.provider, id: op.node.model.id },
+        effort: op.node.effort,
         position: op.node.position,
         createdBy: by,
         updatedBy: by,
@@ -97,7 +103,7 @@ export function applyOp(graph: Graph, op: Op, by: Actor, now: string, options: A
     case 'updateNode': {
       const node = graph.nodes.find((n) => n.id === op.id);
       if (!node) return fail(`node ${op.id} does not exist`);
-      const { access, workspace, timeoutSec, ...patch } = definedOnly<NodePatch>(op.patch);
+      const { access, workspace, timeoutSec, model, effort, ...patch } = definedOnly<NodePatch>(op.patch);
       if (patch.title !== undefined) {
         patch.title = patch.title.trim();
         if (!patch.title) return fail('a node needs a title');
@@ -105,6 +111,9 @@ export function applyOp(graph: Graph, op: Op, by: Actor, now: string, options: A
       if ((patch.description?.length ?? 0) > MAX_DESCRIPTION_CHARS) return fail(DESCRIPTION_TOO_LONG);
       const kind = patch.kind ?? node.kind;
       if (access === 'read' && kind === 'command') return fail(COMMAND_ALWAYS_WRITES);
+      const modelProblem = stepModelProblem(model ?? undefined, effort ?? undefined);
+      if (modelProblem) return fail(modelProblem);
+      if ((model || effort) && kind === 'command') return fail(ONLY_AGENT_STEPS_MODEL);
       let nextWorkspace = node.workspace;
       if (workspace !== undefined) {
         const trimmed = workspace.trim();
@@ -116,13 +125,18 @@ export function applyOp(graph: Graph, op: Op, by: Actor, now: string, options: A
       const nextAccess = kind === 'command' ? undefined : (access ?? node.access) === 'read' ? 'read' : undefined;
       // 0 clears the timeout; a missing one keeps it.
       const nextTimeout = timeoutSec === undefined ? node.timeoutSec : timeoutSec > 0 ? timeoutSec : undefined;
-      const { access: _access, workspace: _workspace, timeoutSec: _timeoutSec, ...base } = node;
+      // Only agent steps have a model or effort, so becoming a command step drops both (spec §2.1); null clears one.
+      const nextModel = kind === 'command' || model === null ? undefined : (model ?? node.model);
+      const nextEffort = kind === 'command' || effort === null ? undefined : (effort ?? node.effort);
+      const { access: _access, workspace: _workspace, timeoutSec: _timeoutSec, model: _model, effort: _effort, ...base } = node;
       const updated: GraphNode = {
         ...base,
         ...patch,
         ...(nextTimeout !== undefined && { timeoutSec: nextTimeout }),
         ...(nextAccess && { access: nextAccess }),
         ...(nextWorkspace && { workspace: nextWorkspace }),
+        ...(nextModel && { model: { provider: nextModel.provider, id: nextModel.id } }),
+        ...(nextEffort && { effort: nextEffort }),
         updatedBy: by,
         updatedAt: now,
       };
@@ -246,7 +260,7 @@ export function contentSignature(g: Graph): string {
   return JSON.stringify({
     goal: g.goal,
     instructions: g.instructions,
-    nodes: g.nodes.map((n) => [n.id, n.kind, n.title, n.description ?? '', n.prompt ?? '', n.command ?? '', n.timeoutSec ?? null, n.access ?? 'write', n.workspace ?? '']),
+    nodes: g.nodes.map((n) => [n.id, n.kind, n.title, n.description ?? '', n.prompt ?? '', n.command ?? '', n.timeoutSec ?? null, n.access ?? 'write', n.workspace ?? '', n.model ? stepModelText(n.model) : '', n.effort ?? '']),
     edges: g.edges.map((e) => e.id).sort(),
   });
 }
@@ -271,7 +285,7 @@ function sameSet(a: string[], b: string[]): boolean {
 /**
  * Node ids a re-run may reuse from `source` (spec §7.2). A node executes again when it is
  * `fromNodeId`, did not succeed last time, changed kind or rendered prompt/command (the template,
- * for runs recorded before rendering), for an agent step changed its own description, changed access or workspace, has a workspace, or gained/lost an upstream edge — and so does everything
+ * for runs recorded before rendering), for an agent step changed its own description, model or effort, changed access or workspace, has a workspace, or gained/lost an upstream edge — and so does everything
  * downstream of it. Everything else is reused.
  */
 export function reusableNodeIds(graph: Graph, source: RunSource, fromNodeId?: string, rendered?: RenderedRun): Set<string> {
@@ -290,7 +304,9 @@ export function reusableNodeIds(graph: Graph, source: RunSource, fromNodeId?: st
     // What a step may do and where it runs are part of its definition (spec §3.1, §3.1a).
     const sameAccess = n.kind !== 'agent' || (prev?.access ?? 'write') === (n.access ?? 'write');
     const samePlace = (prev?.workspace ?? '') === (n.workspace ?? '');
-    const sameDefinition = !!prev && prev.kind === n.kind && sameText && sameDescription && sameAccess && samePlace;
+    // The model and effort a step runs with are part of its definition: comparing models is one of their uses (spec §1).
+    const sameModel = n.kind !== 'agent' || ((prev?.model ? stepModelText(prev.model) : '') === (n.model ? stepModelText(n.model) : '') && (prev?.effort ?? '') === (n.effort ?? ''));
+    const sameDefinition = !!prev && prev.kind === n.kind && sameText && sameDescription && sameAccess && samePlace && sameModel;
     const sameInputs = !!prev && sameSet(upstream(graph, n.id), upstream(source.snapshot, n.id));
     // A step with a workspace is never reused: its files lived in that run's own worktree (spec §4.3a).
     if (!succeeded || !sameDefinition || !sameInputs || n.workspace) seeds.add(n.id);
```

Change `shared/src/graphDoc.ts`:

```diff
diff --git a/shared/src/graphDoc.ts b/shared/src/graphDoc.ts
--- a/shared/src/graphDoc.ts
+++ b/shared/src/graphDoc.ts
@@ -47,8 +47,8 @@ export function formatFileErrors(errors: readonly GraphFileError[], max = 1): st
 /**
  * The graph as its files hold it (spec §4): what loading its Markdown and side file gives back. Names, titles, variable
  * descriptions and step descriptions on one line; goal and instructions trimmed; LF line endings; only the text of the
- * step's kind (a prompt or a command), absent when empty; `access` only for a read-only agent step; whole-second
- * timeouts; `nodeSeq` at least the highest n<number> id.
+ * step's kind (a prompt or a command), absent when empty; `access` only for a read-only agent step; a model and an
+ * effort only on an agent step; whole-second timeouts; `nodeSeq` at least the highest n<number> id.
  */
 export function canonicalGraph(graph: Graph): Graph {
   const nodes = graph.nodes.map(canonicalNode);
@@ -65,7 +65,7 @@ export function canonicalGraph(graph: Graph): Graph {
 }
 
 function canonicalNode(node: GraphNode): GraphNode {
-  const { prompt, command, description, timeoutSec, access, workspace, ...rest } = node;
+  const { prompt, command, description, timeoutSec, access, workspace, model, effort, ...rest } = node;
   const text = normText((node.kind === 'agent' ? prompt : command) ?? '');
   const summary = oneLine(description ?? '');
   return {
@@ -76,6 +76,8 @@ function canonicalNode(node: GraphNode): GraphNode {
     ...(timeoutSec !== undefined && { timeoutSec: timeoutValue(timeoutSec) }),
     ...(node.kind === 'agent' && access === 'read' && { access: 'read' as const }),
     ...(workspace && { workspace }),
+    ...(node.kind === 'agent' && model && { model: { provider: model.provider, id: model.id } }),
+    ...(node.kind === 'agent' && effort && { effort }),
   };
 }
 
```

Change `shared/src/index.ts`:

```diff
diff --git a/shared/src/index.ts b/shared/src/index.ts
--- a/shared/src/index.ts
+++ b/shared/src/index.ts
@@ -16,3 +16,4 @@ export * from './graphMarkdownParse';
 export * from './graphMeta';
 export * from './graphMarkdownWrite';
 export * from './diffToOps';
+export * from './stepModels';
```

Change `shared/src/schemas.ts`:

```diff
diff --git a/shared/src/schemas.ts b/shared/src/schemas.ts
--- a/shared/src/schemas.ts
+++ b/shared/src/schemas.ts
@@ -1,8 +1,9 @@
 import { z } from 'zod';
 import { COMMAND_ALWAYS_WRITES, workspaceNameProblem } from './access';
 import { legacyNodeIdProblem, topoOrder } from './graph';
+import { MAX_MODEL_ID_CHARS, ONLY_AGENT_STEPS_MODEL } from './stepModels';
 import { MAX_VARIABLE_VALUE_CHARS, variableNameProblem } from './variables';
-import { EFFORT_LEVELS, MAX_IMPORT_CHARS, type ClientMessage, type Graph, type GraphResult, type WebviewHostMessage } from './types';
+import { EFFORT_LEVELS, MAX_IMPORT_CHARS, PROVIDER_IDS, type ClientMessage, type Graph, type GraphResult, type WebviewHostMessage } from './types';
 
 const position = z.object({ x: z.number(), y: z.number() });
 const actor = z.enum(['user', 'agent']);
@@ -10,6 +11,9 @@ const nodeKind = z.enum(['agent', 'command']);
 const access = z.enum(['read', 'write']);
 const timeoutSec = z.number().positive();
 const description = z.string().max(2000).optional();
+/** A step's own model (spec §2.1): the provider and its model id, 1 to 200 characters without whitespace. */
+const stepModel = z.object({ provider: z.enum(PROVIDER_IDS), id: z.string().regex(new RegExp(`^\\S{1,${MAX_MODEL_ID_CHARS}}$`)) });
+const effort = z.enum(EFFORT_LEVELS);
 
 const graphNodeSchema = z.object({
   id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
@@ -21,6 +25,8 @@ const graphNodeSchema = z.object({
   timeoutSec: timeoutSec.optional(),
   access: access.optional(),
   workspace: z.string().optional(),
+  model: stepModel.optional(),
+  effort: effort.optional(),
   position: position.optional(),
   createdBy: actor.default('user'),
   updatedBy: actor.default('user'),
@@ -51,6 +57,7 @@ export function parseGraph(json: unknown): GraphResult {
     if (ids.has(n.id)) return { ok: false, error: `duplicate node id ${n.id}` };
     ids.add(n.id);
     if (n.access === 'read' && n.kind === 'command') return { ok: false, error: `${n.id}: ${COMMAND_ALWAYS_WRITES}` };
+    if ((n.model || n.effort) && n.kind === 'command') return { ok: false, error: `${n.id}: ${ONLY_AGENT_STEPS_MODEL}` };
     const workspaceProblem = n.workspace === undefined ? null : workspaceNameProblem(n.workspace);
     if (workspaceProblem) return { ok: false, error: `${n.id}: ${workspaceProblem}` };
   }
@@ -79,6 +86,8 @@ const newNode = z.object({
   timeoutSec: timeoutSec.optional(),
   access: access.optional(),
   workspace: z.string().optional(),
+  model: stepModel.optional(),
+  effort: effort.optional(),
   position: position.optional(),
 });
 
@@ -91,6 +100,9 @@ const nodePatch = z.object({
   timeoutSec: timeoutSec.optional(),
   access: access.optional(),
   workspace: z.string().optional(),
+  // null clears the step's own model or effort.
+  model: stepModel.nullable().optional(),
+  effort: effort.nullable().optional(),
 });
 
 const changeTarget = z.discriminatedUnion('kind', [z.object({ kind: z.literal('node'), id: z.string() }), z.object({ kind: z.literal('edge'), id: z.string() }), z.object({ kind: z.literal('all') })]);
@@ -128,7 +140,7 @@ const clientMessageSchema = z.discriminatedUnion('type', [
   z.object({ type: z.literal('splitStep'), graphId: z.string(), sessionId: z.string(), nodeId: z.string() }),
   z.object({ type: z.literal('newChat'), graphId: z.string(), sessionId: z.string() }),
   z.object({ type: z.literal('stopPlanner'), graphId: z.string(), sessionId: z.string() }),
-  z.object({ type: z.literal('setPlannerModel'), graphId: z.string(), sessionId: z.string(), model: z.string().min(1).max(200).optional(), effort: z.enum(EFFORT_LEVELS).optional() }),
+  z.object({ type: z.literal('setPlannerModel'), graphId: z.string(), sessionId: z.string(), model: z.string().min(1).max(200).optional(), effort: effort.optional() }),
   z.object({ type: z.literal('startRun'), graphId: z.string(), reviewed: z.string(), fromNodeId: z.string().optional(), sourceRunId: z.string().optional(), sequential: z.boolean().optional() }),
   z.object({ type: z.literal('inspectCheckout') }),
   z.object({ type: z.literal('previewRun'), graphId: z.string(), fromNodeId: z.string().optional(), sourceRunId: z.string().optional(), requestId: z.string().max(64).optional() }),
```

Change `shared/src/types.ts`:

```diff
diff --git a/shared/src/types.ts b/shared/src/types.ts
--- a/shared/src/types.ts
+++ b/shared/src/types.ts
@@ -17,6 +17,10 @@ export type GraphNode = {
   access?: NodeAccess;
   /** A variant workspace: steps with the same name share one worktree per run (spec §3.1a). Missing means this checkout; '' in a patch clears it. */
   workspace?: string;
+  /** Agent steps: the step's own model, within its provider (spec §2.1). Missing means the run's model. */
+  model?: StepModel;
+  /** Agent steps: the step's own effort. Missing means the run's effort. */
+  effort?: EffortLevel;
   position?: Position;
   createdBy: Actor;
   updatedBy: Actor;
@@ -53,6 +57,8 @@ export type NewNodeInput = {
   access?: NodeAccess;
   /** A variant workspace: steps with the same name share one worktree per run (spec §3.1a). Missing means this checkout; '' in a patch clears it. */
   workspace?: string;
+  model?: StepModel;
+  effort?: EffortLevel;
   position?: Position;
 };
 
@@ -68,6 +74,10 @@ export type NodePatch = {
   access?: NodeAccess;
   /** A variant workspace: steps with the same name share one worktree per run (spec §3.1a). Missing means this checkout; '' in a patch clears it. */
   workspace?: string;
+  /** null clears the step's model (back to the run's). */
+  model?: StepModel | null;
+  /** null clears the step's effort (back to the run's). */
+  effort?: EffortLevel | null;
 };
 
 export type Op =
@@ -100,7 +110,7 @@ export const MAX_IMPORT_CHARS = 1024 * 1024;
 
 export type ChangeTarget = { kind: 'node'; id: string } | { kind: 'edge'; id: string } | { kind: 'all' };
 
-export type ChangedField = 'title' | 'description' | 'kind' | 'prompt' | 'command' | 'timeoutSec' | 'access' | 'workspace';
+export type ChangedField = 'title' | 'description' | 'kind' | 'prompt' | 'command' | 'timeoutSec' | 'access' | 'workspace' | 'model' | 'effort';
 
 /** One difference between the user's baseline and the graph; `by`/`at` come from the latest agent op that touched it. */
 export type AgentChange =
@@ -278,6 +288,8 @@ export const EFFORT_LEVELS: readonly EffortLevel[] = ['low', 'medium', 'high', '
  * runs when none is chosen (Codex marks one; Claude Code has a `default` row instead).
  */
 export type ModelChoice = { value: string; label: string; description?: string; efforts: EffortLevel[]; unavailable?: boolean; resolved?: string; isDefault?: boolean };
+/** A step's own model: the provider's model id exactly as its model list reports it, tagged with the provider (spec §2.1). */
+export type StepModel = { provider: ProviderId; id: string };
 /** A model and effort choice; an absent field means Default. */
 export type ModelSelection = { model?: string; effort?: EffortLevel };
 
```

Change `web/src/components/ChangesPanel.tsx`:

```diff
diff --git a/web/src/components/ChangesPanel.tsx b/web/src/components/ChangesPanel.tsx
--- a/web/src/components/ChangesPanel.tsx
+++ b/web/src/components/ChangesPanel.tsx
@@ -1,11 +1,11 @@
-import { changedFields, relativeTime, type AgentChange, type ChangedField, type Graph, type GraphNode } from '@agent-stream/shared';
+import { changedFields, changedFieldText, relativeTime, type AgentChange, type ChangedField, type Graph, type GraphNode } from '@agent-stream/shared';
 import { actions } from '../actions';
 import { changeKey, sourceLabel } from '../changeLabels';
 import { lineDiff } from '../lineDiff';
 import { dispatch, useStore } from '../store';
 
 const ICONS: Record<AgentChange['change'], string> = { added: '＋', changed: '✎', removed: '✕' };
-const FIELD_LABELS: Record<ChangedField, string> = { title: 'Title', description: 'Description', kind: 'Kind', prompt: 'Prompt', command: 'Command', timeoutSec: 'Timeout (seconds)', access: 'Access', workspace: 'Workspace' };
+const FIELD_LABELS: Record<ChangedField, string> = { title: 'Title', description: 'Description', kind: 'Kind', prompt: 'Prompt', command: 'Command', timeoutSec: 'Timeout (seconds)', access: 'Access', workspace: 'Workspace', model: 'Model', effort: 'Effort' };
 
 const target = (c: AgentChange) => ({ kind: c.kind, id: c.id });
 const name = (c: AgentChange) => (c.kind === 'edge' ? `${c.from} → ${c.to}` : c.title);
@@ -18,7 +18,7 @@ function meta(c: AgentChange): string {
   return [what, c.by || c.change === 'changed' ? sourceLabel(c.by) : undefined, c.at ? relativeTime(c.at) : undefined].filter(Boolean).join(' · ');
 }
 
-const text = (n: GraphNode | undefined, field: ChangedField) => (n?.[field] === undefined ? '' : String(n[field]));
+const text = (n: GraphNode | undefined, field: ChangedField) => changedFieldText(n, field);
 
 /** The fields worth showing for a step: what changed, or for an added or removed step what it contains. */
 function shownFields(c: AgentChange, before?: GraphNode, after?: GraphNode): ChangedField[] {
```

- [ ] **Step 5: Run the tests and typecheck**

Run: `npm test -w shared -- test/stepModels.test.ts`
Expected: PASS.
Run: `npm run typecheck && npm test`
Expected: all workspaces pass (a test that times out only under heavy machine load is not a failure of this task: run it again).

- [ ] **Step 6: Commit**

```bash
git add engine/src/stepGraphTools.ts shared/src/changes.ts shared/src/graph.ts shared/src/graphDoc.ts shared/src/index.ts shared/src/schemas.ts shared/src/stepModels.ts shared/src/types.ts shared/test/stepModels.test.ts web/src/components/ChangesPanel.tsx
git commit -m "feat(shared): a model and effort per agent step" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 2: Model and effort in the Markdown file, the store and the docs

**Spec covered:** §2.2 (lines, order, parse errors, no existence check, round trip, `diffToOps`, docs), §7 shared Markdown tests (the 300-graph generator sets the fields), Revert and baselines keep them.

**Files:**
- Modify: `docs/graph-format.md`, `engine/src/graphStore.ts`, `shared/src/diffToOps.ts`, `shared/src/graphDoc.ts`, `shared/src/graphMarkdownParse.ts`, `shared/src/graphMarkdownWrite.ts`
- Test: `engine/test/stepModelStore.test.ts` (new), `shared/test/stepModelsMarkdown.test.ts` (new), `shared/test/graphFixtures.ts`, `shared/test/graphMarkdownParse.test.ts`

**Interfaces:**
- Consumes: Task 1's `StepModel`, `parseStepModel`, `stepModelText`.
- Produces: `DocStep.model?`, `DocStep.effort?`; the writer's `- model: <provider>/<id>` and `- effort: <level>` lines after `timeout`; `diffToOps` patches `model`/`effort` (null clears). `GraphStore`'s Revert copies them (`withContentOf`).

- [ ] **Step 1: Write the failing tests**

Create `engine/test/stepModelStore.test.ts`:

```ts
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GraphStore } from '../src/graphStore';
import { fixedClock, tmpProject } from './helpers';

const opus = { provider: 'claude' as const, id: 'opus' };

function setup() {
  const paths = tmpProject();
  const store = new GraphStore(paths, fixedClock());
  const { id } = store.create('Models');
  const file = join(paths.graphsDir, `${id}.md`);
  return { store, id, file, paths };
}

describe('GraphStore: a step model and effort', () => {
  it('saves them in the Markdown file and reads them back', () => {
    const { store, id, file, paths } = setup();
    store.apply(id, { type: 'addNode', node: { title: 'Plan', kind: 'agent', prompt: 'p', model: opus, effort: 'high' } }, 'user');
    expect(readFileSync(file, 'utf8')).toContain('- model: claude/opus\n- effort: high\n');
    const fresh = new GraphStore(paths, fixedClock());
    expect(fresh.get(id).nodes[0]).toMatchObject({ model: opus, effort: 'high' });
  });

  it('an agent change to them shows as a changed field, and Revert puts the user’s back', () => {
    const { store, id, file } = setup();
    store.apply(id, { type: 'addNode', node: { title: 'Plan', kind: 'agent', prompt: 'p', effort: 'low' } }, 'user');
    store.apply(id, { type: 'updateNode', id: 'n1', patch: { model: opus, effort: 'max' } }, 'agent', { kind: 'planner' });
    expect(store.agentChanges(id)).toMatchObject([{ kind: 'node', change: 'changed', id: 'n1', fields: ['model', 'effort'] }]);
    expect(store.apply(id, { type: 'revertChange', target: { kind: 'node', id: 'n1' } }, 'user').ok).toBe(true);
    const node = store.get(id).nodes[0];
    expect(node).not.toHaveProperty('model');
    expect(node.effort).toBe('low');
    expect(readFileSync(file, 'utf8')).not.toContain('- model:');
    expect(store.agentChanges(id)).toEqual([]);
  });

  it('keeps them in the baseline, so an agent edit to the prompt is not also a model change', () => {
    const { store, id } = setup();
    store.apply(id, { type: 'addNode', node: { title: 'Plan', kind: 'agent', prompt: 'p', model: opus, effort: 'high' } }, 'user');
    store.apply(id, { type: 'updateNode', id: 'n1', patch: { prompt: 'better' } }, 'agent', { kind: 'planner' });
    expect(store.baseline(id)).toMatchObject({ ok: true, graph: { nodes: [{ model: opus, effort: 'high' }] } });
    expect(store.agentChanges(id)).toMatchObject([{ id: 'n1', fields: ['prompt'] }]);
  });

  it('a hand edit of the lines becomes a user edit with model and effort in the patch', () => {
    const { store, id, file } = setup();
    store.apply(id, { type: 'addNode', node: { title: 'Plan', kind: 'agent', prompt: 'p' } }, 'user');
    writeFileSync(file, readFileSync(file, 'utf8').replace('- kind: agent\n', '- kind: agent\n- model: codex/gpt-6-astra\n- effort: ultra\n'));
    expect(store.graphFileChanged(id)).toBe('applied');
    expect(store.readOps(id).at(-1)).toMatchObject({ by: 'user', via: 'file', op: { type: 'updateNode', id: 'n1', patch: { model: { provider: 'codex', id: 'gpt-6-astra' }, effort: 'ultra' } } });
    writeFileSync(file, readFileSync(file, 'utf8').replace('- model: codex/gpt-6-astra\n', ''));
    expect(store.graphFileChanged(id)).toBe('applied');
    expect(store.readOps(id).at(-1)).toMatchObject({ op: { type: 'updateNode', id: 'n1', patch: { model: null } } });
    expect(store.get(id).nodes[0]).not.toHaveProperty('model');
  });
});
```

Create `shared/test/stepModelsMarkdown.test.ts`:

````ts
import { describe, expect, it } from 'vitest';
import { diffToOps } from '../src/diffToOps';
import { applyOp } from '../src/graph';
import { canonicalGraph, formatFileErrors, type GraphDoc } from '../src/graphDoc';
import { parseGraphMarkdown } from '../src/graphMarkdownParse';
import { serializeGraphMarkdown } from '../src/graphMarkdownWrite';
import { graphFromDoc, parseGraphMeta, serializeGraphMeta } from '../src/graphMeta';
import type { Graph, GraphFileError, Op } from '../src/types';
import { build, T0 } from './graphFixtures';

const md = (...lines: string[]) => lines.join('\n');
const FENCE = '```';
function doc(text: string): GraphDoc {
  const r = parseGraphMarkdown(text);
  if (!r.ok) throw new Error(formatFileErrors(r.errors, 10));
  return r.doc;
}
function errors(text: string): GraphFileError[] {
  const r = parseGraphMarkdown(text);
  if (r.ok) throw new Error('expected errors');
  return r.errors;
}
function applied(graph: Graph, ops: Op[]): Graph {
  let out = graph;
  for (const op of ops) {
    const r = applyOp(out, op, 'user', T0);
    if (!r.ok) throw new Error(`${op.type}: ${r.error}`);
    out = r.graph;
  }
  return out;
}
const opus = { provider: 'claude' as const, id: 'opus' };

/** One agent step with a model and an effort, and a command step. */
const g = build('Models', [
  { type: 'addNode', node: { title: 'Plan', kind: 'agent', prompt: 'Plan it.', timeoutSec: 60, model: opus, effort: 'high' } },
  { type: 'addNode', node: { title: 'Build', kind: 'command', command: 'make' } },
]);
const text = serializeGraphMarkdown(g);

describe('model and effort in the Markdown file', () => {
  it('writes them after timeout, model first, only when set', () => {
    expect(text).toContain(md('## n1 · Plan', '', '- kind: agent', '- timeout: 60', '- model: claude/opus', '- effort: high', '', FENCE + 'prompt'));
    expect(text).toContain(md('## n2 · Build', '', '- kind: command', '', FENCE + 'sh'));
  });

  it('reads them back exactly, the id being everything after the first /', () => {
    expect(doc(text).steps[0]).toMatchObject({ model: opus, effort: 'high' });
    const read = doc(md('# G', '## n1 · A', '- effort: ultra', '- model: codex/org/gpt-6-astra', FENCE + 'prompt', FENCE));
    expect(read.steps[0]).toMatchObject({ model: { provider: 'codex', id: 'org/gpt-6-astra' }, effort: 'ultra' });
    const reload = graphFromDoc(doc(text), parseGraphMeta(serializeGraphMeta(g)), g.id, T0);
    expect(reload).toEqual(canonicalGraph(g));
    expect(serializeGraphMarkdown(reload)).toBe(text);
  });

  it('does not check that the model exists: a graph opens on any machine', () => {
    expect(doc(md('# G', '## n1 · A', '- model: copilot/some-model-from-another-plan', FENCE + 'prompt', FENCE)).steps[0].model).toEqual({ provider: 'copilot', id: 'some-model-from-another-plan' });
  });

  it('reports each bad line with how to fix it', () => {
    const idRule = (p: string) => `write the model id after "${p}/" (1 to 200 characters, no spaces), as in claude/opus.`;
    expect(
      errors(
        md(
          '# G',
          '## n1 · A',
          '- model: gemini/flash',
          '- effort: turbo',
          FENCE + 'prompt',
          FENCE,
          '## n2 · B',
          '- model: claude/',
          FENCE + 'prompt',
          FENCE,
          '## n3 · C',
          '- model: claude/two words',
          FENCE + 'prompt',
          FENCE,
          '## n4 · D',
          '- kind: command',
          '- model: claude/opus',
          '- effort: low',
          FENCE + 'sh',
          FENCE,
          '## n5 · E',
          '- effort: low',
          '- effort: high',
          FENCE + 'prompt',
          FENCE,
        ),
      ),
    ).toEqual([
      { line: 3, message: 'model "gemini/flash": the provider must be claude, codex or copilot, as in claude/opus.' },
      { line: 4, message: 'effort is "turbo"; use low, medium, high, xhigh, max or ultra.' },
      { line: 8, message: `model "claude/": ${idRule('claude')}` },
      { line: 12, message: `model "claude/two words": ${idRule('claude')}` },
      { line: 17, message: "step n4 is a command step, so it can't have a model or effort. Remove this line, or make it an agent step." },
      { line: 18, message: "step n4 is a command step, so it can't have a model or effort. Remove this line, or make it an agent step." },
      { line: 23, message: 'the field effort appears twice in step n5. Keep one.' },
    ]);
  });

  it('a command step by its block alone is a command step too', () => {
    expect(errors(md('# G', '## n1 · A', '- effort: low', FENCE + 'sh', 'ls', FENCE))).toEqual([
      { line: 3, message: "step n1 is a command step, so it can't have a model or effort. Remove this line, or make it an agent step." },
    ]);
  });
});

describe('diffToOps: model and effort', () => {
  const edit = (from: string, to: string) => {
    if (!text.includes(from)) throw new Error(`not in the file: ${from}`);
    return diffToOps(g, doc(text.replace(from, to)));
  };

  it('changes, sets and clears them with null', () => {
    expect(edit('- model: claude/opus', '- model: codex/gpt-6-astra')).toEqual([{ type: 'updateNode', id: 'n1', patch: { model: { provider: 'codex', id: 'gpt-6-astra' } } }]);
    expect(edit('- model: claude/opus\n', '')).toEqual([{ type: 'updateNode', id: 'n1', patch: { model: null } }]);
    expect(edit('- effort: high\n', '')).toEqual([{ type: 'updateNode', id: 'n1', patch: { effort: null } }]);
    expect(edit('- effort: high', '- effort: low')).toEqual([{ type: 'updateNode', id: 'n1', patch: { effort: 'low' } }]);
    const set = edit(md('- kind: command', '', `${FENCE}sh`, 'make'), md('- kind: agent', '- effort: max', '', `${FENCE}prompt`, 'make'));
    expect(set).toEqual([{ type: 'updateNode', id: 'n2', patch: { kind: 'agent', prompt: 'make', effort: 'max' } }]);
    expect(applied(g, set).nodes[1]).toMatchObject({ kind: 'agent', prompt: 'make', effort: 'max' });
  });

  it('a step that becomes a command step loses them without a patch for them', () => {
    const ops = edit(md('- kind: agent', '- timeout: 60', '- model: claude/opus', '- effort: high', '', `${FENCE}prompt`, 'Plan it.'), md('- kind: command', '- timeout: 60', '', `${FENCE}sh`, 'plan'));
    expect(ops).toEqual([{ type: 'updateNode', id: 'n1', patch: { kind: 'command', command: 'plan' } }]);
    const after = applied(g, ops);
    expect(after.nodes[0]).not.toHaveProperty('model');
    expect(after.nodes[0]).not.toHaveProperty('effort');
  });

  it('a new step keeps them', () => {
    const ops = diffToOps(g, doc(`${text}\n## Check\n\n- model: copilot/auto\n- effort: low\n\n${FENCE}prompt\nCheck.\n${FENCE}\n`));
    expect(ops).toEqual([{ type: 'addNode', node: { title: 'Check', kind: 'agent', model: { provider: 'copilot', id: 'auto' }, effort: 'low', prompt: 'Check.' } }]);
  });
});
````

Change `shared/test/graphFixtures.ts` (the generator sets model and effort on agent steps):

`````diff
diff --git a/shared/test/graphFixtures.ts b/shared/test/graphFixtures.ts
--- a/shared/test/graphFixtures.ts
+++ b/shared/test/graphFixtures.ts
@@ -1,5 +1,5 @@
 import { applyOp, emptyGraph } from '../src/graph';
-import type { Graph, NewNodeInput, Op } from '../src/types';
+import { EFFORT_LEVELS, type Graph, type NewNodeInput, type Op, type StepModel } from '../src/types';
 
 export const T0 = '2026-10-04T00:00:00.000Z';
 
@@ -61,6 +61,13 @@ export function rng(seed: number): () => number {
 
 const TEXTS = ['', 'plain', '```', '````js\nx\n````', '{% raw %}{{ x }}{% endraw %}', '## not a heading', '# H1', '\n', ' leading space', 'trailing  ', '~~~', '> quote', '- kind: command', '\\## esc', '日本語 ✓', 'a · b', '"q"', '```\nunclosed', '\r\nwindows'];
 const TITLES = ['Build', 'Prüfen · 日本語', 'Say "hi"', '# hash', 'Goal', 'a\nb', '  padded  ', 'end'];
+const MODELS: StepModel[] = [
+  { provider: 'claude', id: 'opus' },
+  { provider: 'claude', id: 'claude-opus-4-8' },
+  { provider: 'codex', id: 'gpt-6-astra' },
+  { provider: 'copilot', id: 'auto' },
+  { provider: 'codex', id: 'org/model_1.5:beta' },
+];
 
 /** A random valid graph: steps, fields, edges (always forward, so no cycles), variables and tricky text. */
 export function randomGraph(seed: number): Graph {
@@ -83,6 +90,8 @@ export function randomGraph(seed: number): Graph {
         ...(kind === 'agent' && r() < 0.3 && { access: 'read' as const }),
         ...(r() < 0.2 && { workspace: pick(['wh_a', 'wh-b']) }),
         ...(r() < 0.3 && { position: { x: Math.floor(r() * 500), y: Math.floor(r() * 500) } }),
+        ...(kind === 'agent' && r() < 0.4 && { model: pick(MODELS) }),
+        ...(kind === 'agent' && r() < 0.4 && { effort: pick(EFFORT_LEVELS) }),
       }),
     );
   }
`````

Change `shared/test/graphMarkdownParse.test.ts` (named exception: the unknown-field message lists the new fields):

```diff
diff --git a/shared/test/graphMarkdownParse.test.ts b/shared/test/graphMarkdownParse.test.ts
--- a/shared/test/graphMarkdownParse.test.ts
+++ b/shared/test/graphMarkdownParse.test.ts
@@ -186,7 +186,7 @@ describe('parseGraphMarkdown: errors', () => {
     );
     expect(e).toEqual([
       { line: 3, message: 'kind is "robot"; use agent or command.' },
-      { line: 4, message: 'unknown field "colour". Step fields are kind, access, workspace and timeout.' },
+      { line: 4, message: 'unknown field "colour". Step fields are kind, access, workspace, timeout, model and effort.' },
       { line: 5, message: 'access is "maybe"; use read or write.' },
       { line: 6, message: `workspace "Bad Name": ${WORKSPACE_NAME_PROBLEM}` },
       { line: 7, message: 'timeout is "1.5"; use a whole number of seconds from 1 to 2147483.' },
```

- [ ] **Step 2: Run the tests and see them fail**

Run: `npm test -w shared -- test/stepModelsMarkdown.test.ts test/graphMarkdownParse.test.ts test/graphMarkdownWrite.test.ts test/diffToOps.test.ts && npm test -w engine -- test/stepModelStore.test.ts test/graphFormatDoc.test.ts`
Expected: FAIL — the new modules, exports or behaviour do not exist yet (import errors or assertion failures).

- [ ] **Step 3: Implement**

Change `docs/graph-format.md`:

`````diff
diff --git a/docs/graph-format.md b/docs/graph-format.md
--- a/docs/graph-format.md
+++ b/docs/graph-format.md
@@ -50,6 +50,8 @@ dbt run-operation table_exists --args '{table: dim_customer}'
 
 - kind: agent
 - workspace: wh_a
+- model: claude/sonnet
+- effort: low
 
 > Builds the model for the first time.
 
@@ -98,6 +100,10 @@ A step section holds, in this order:
    - `access`: `read` for an agent step that only reads and reports. Missing (or `write`) means it can change files. Command steps can always change files, so `access: read` on a command step is an error.
    - `workspace`: a variant workspace name (lowercase letters, digits, `-` and `_`, starting with a letter, at most 40 characters). Steps with the same workspace share one worktree per run. Missing means this checkout.
    - `timeout`: a whole number of seconds, from 1 to 2147483.
+   - `model`: the agent step's own model, written `<provider>/<model id>`: `claude/opus`, `codex/gpt-6-astra`, `copilot/auto`. The provider is `claude`, `codex` or `copilot`; the model id is everything after the first `/`, exactly as that provider's model list names it (1 to 200 characters, no spaces). Missing means the run's model (the `agentStream.model` setting). Agent Stream doesn't check here that the model exists, so the graph still opens on a machine with another plan or provider: a run checks it when it starts, and a step whose model isn't offered, or belongs to another provider than the run's, uses the run's model, with a warning.
+   - `effort`: the agent step's own effort, one of `low`, `medium`, `high`, `xhigh`, `max` or `ultra`. Missing means the run's effort. A level the step's model doesn't offer is left out when the step runs.
+
+   Command steps have no model or effort: either line on a command step is an error.
 2. **A description** (optional): one or more `>` lines, joined with spaces. One plain-language sentence for people: what the step does and why.
 3. **Exactly one code block:**
    - ```` ```prompt ```` (or `text`, `md`) for an agent step's prompt;
`````

Change `engine/src/graphStore.ts`:

```diff
diff --git a/engine/src/graphStore.ts b/engine/src/graphStore.ts
--- a/engine/src/graphStore.ts
+++ b/engine/src/graphStore.ts
@@ -76,8 +76,8 @@ function touches(op: Op, change: AgentChange): boolean {
 
 /** `node` with `source`'s content fields (absent ones removed), keeping its id, position and authorship. */
 function withContentOf(node: GraphNode, source: GraphNode): GraphNode {
-  const { description: _d, prompt: _p, command: _c, timeoutSec: _t, access: _a, workspace: _w, ...rest } = node;
-  const optional = { description: source.description, prompt: source.prompt, command: source.command, timeoutSec: source.timeoutSec, access: source.access, workspace: source.workspace };
+  const { description: _d, prompt: _p, command: _c, timeoutSec: _t, access: _a, workspace: _w, model: _m, effort: _e, ...rest } = node;
+  const optional = { description: source.description, prompt: source.prompt, command: source.command, timeoutSec: source.timeoutSec, access: source.access, workspace: source.workspace, model: source.model, effort: source.effort };
   return { ...rest, title: source.title, kind: source.kind, ...Object.fromEntries(Object.entries(optional).filter(([, v]) => v !== undefined)) };
 }
 
```

Change `shared/src/diffToOps.ts`:

```diff
diff --git a/shared/src/diffToOps.ts b/shared/src/diffToOps.ts
--- a/shared/src/diffToOps.ts
+++ b/shared/src/diffToOps.ts
@@ -1,5 +1,8 @@
 import type { DocStep, GraphDoc } from './graphDoc';
-import type { Graph, GraphNode, NewNodeInput, NodePatch, Op } from './types';
+import { stepModelText } from './stepModels';
+import type { Graph, GraphNode, NewNodeInput, NodePatch, Op, StepModel } from './types';
+
+const modelText = (m: StepModel | undefined) => (m ? stepModelText(m) : '');
 
 const edgeKey = (e: { from: string; to: string }) => `${e.from}->${e.to}`;
 
@@ -8,7 +11,7 @@ function newNode(step: DocStep): NewNodeInput {
   return node;
 }
 
-/** Only the fields that differ; '' clears a description, prompt, command or workspace, and 0 clears a timeout. */
+/** Only the fields that differ; '' clears a description, prompt, command or workspace, 0 a timeout, and null a model or effort. */
 function patchOf(node: GraphNode, step: DocStep): NodePatch {
   const patch: NodePatch = {};
   if (node.title !== step.title) patch.title = step.title;
@@ -19,6 +22,9 @@ function patchOf(node: GraphNode, step: DocStep): NodePatch {
   if ((node.access === 'read') !== (step.access === 'read')) patch.access = step.access ?? 'write';
   if ((node.workspace ?? '') !== (step.workspace ?? '')) patch.workspace = step.workspace ?? '';
   if ((node.timeoutSec ?? 0) !== (step.timeoutSec ?? 0)) patch.timeoutSec = step.timeoutSec ?? 0;
+  // A step that becomes a command step loses both without a patch (applyOp drops them).
+  if (step.kind === 'agent' && modelText(node.model) !== modelText(step.model)) patch.model = step.model ?? null;
+  if (step.kind === 'agent' && (node.effort ?? '') !== (step.effort ?? '')) patch.effort = step.effort ?? null;
   return patch;
 }
 
```

Change `shared/src/graphDoc.ts`:

```diff
diff --git a/shared/src/graphDoc.ts b/shared/src/graphDoc.ts
--- a/shared/src/graphDoc.ts
+++ b/shared/src/graphDoc.ts
@@ -1,6 +1,6 @@
 import { edgeId, nodeIdProblem, seqOf } from './graph';
 import type { FlowEdge } from './graphFlow';
-import type { Graph, GraphFileError, GraphNode, NodeKind } from './types';
+import type { EffortLevel, Graph, GraphFileError, GraphNode, NodeKind, StepModel } from './types';
 
 /** The longest timeout a step can have: Node's longest timer, in whole seconds. */
 export const MAX_TIMEOUT_SEC = 2_147_483;
@@ -16,6 +16,9 @@ export type DocStep = {
   access?: 'read';
   workspace?: string;
   timeoutSec?: number;
+  /** Agent steps only. */
+  model?: StepModel;
+  effort?: EffortLevel;
   description?: string;
   prompt?: string;
   command?: string;
```

Change `shared/src/graphMarkdownParse.ts`:

```diff
diff --git a/shared/src/graphMarkdownParse.ts b/shared/src/graphMarkdownParse.ts
--- a/shared/src/graphMarkdownParse.ts
+++ b/shared/src/graphMarkdownParse.ts
@@ -4,7 +4,9 @@ import { unescapeFreeTextLine } from './freeText';
 import { nodeIdProblem } from './graph';
 import { MAX_TIMEOUT_SEC, STEP_SEPARATOR, type DocStep, type DocVariable, type ParseGraphResult } from './graphDoc';
 import { parseFlow, type FlowEdge } from './graphFlow';
-import type { GraphFileError, NodeKind } from './types';
+import type { EffortLevel, GraphFileError, NodeKind, StepModel } from './types';
+import { isEffortLevel } from './format';
+import { parseStepModel } from './stepModels';
 import { variableNameProblem } from './variables';
 
 type TextItem = { kind: 'text'; line: number; text: string };
@@ -19,7 +21,7 @@ const STEP_HEADING_RE = new RegExp(`^([A-Za-z0-9_-]+)${STEP_SEPARATOR.trimEnd()}
 const FIELD_RE = /^[-*][ \t]+([A-Za-z]+)[ \t]*:[ \t]*(.*?)[ \t]*$/;
 const VARIABLE_RE = /^[-*][ \t]+`([^`]*)`(?:[ \t]*:[ \t]*(.*?))?[ \t]*$/;
 const QUOTE_RE = /^>[ \t]?(.*)$/;
-const FIELD_NAMES = ['kind', 'access', 'workspace', 'timeout'];
+const FIELD_NAMES = ['kind', 'access', 'workspace', 'timeout', 'model', 'effort'];
 const AGENT_INFOS = new Set(['prompt', 'text', 'md']);
 const COMMAND_INFOS = new Set(['sh', 'bash', 'shell']);
 const START = 'the file must start with the graph\'s name, as "# Name".';
@@ -144,7 +146,7 @@ function readStep(section: Section, errors: GraphFileError[]): DocStep | null {
     if (field) {
       const key = field[1].toLowerCase();
       if (phase !== 'fields') fail(item.line, `fields go at the top of step ${label}, before the description and the code block.`);
-      else if (!FIELD_NAMES.includes(key)) fail(item.line, `unknown field "${field[1]}". Step fields are kind, access, workspace and timeout.`);
+      else if (!FIELD_NAMES.includes(key)) fail(item.line, `unknown field "${field[1]}". Step fields are kind, access, workspace, timeout, model and effort.`);
       else if (fields.has(key)) fail(item.line, `the field ${key} appears twice in step ${label}. Keep one.`);
       else fields.set(key, { value: field[2], line: item.line });
       continue;
@@ -199,6 +201,23 @@ function readStep(section: Section, errors: GraphFileError[]): DocStep | null {
     if (sec >= 1 && sec <= MAX_TIMEOUT_SEC) timeoutSec = sec;
     else fail(t.line, `timeout is "${t.value}"; use a whole number of seconds from 1 to ${MAX_TIMEOUT_SEC}.`);
   }
+  // A step's own model and effort (step model spec §2.2). Whether the model exists is checked when a run starts, not here.
+  let model: StepModel | undefined;
+  let effort: EffortLevel | undefined;
+  for (const key of ['model', 'effort'] as const) {
+    const f = fields.get(key);
+    if (!f) continue;
+    if (finalKind === 'command') {
+      fail(f.line, `step ${label} is a command step, so it can't have a model or effort. Remove this line, or make it an agent step.`);
+      continue;
+    }
+    if (key === 'model') {
+      const r = parseStepModel(f.value);
+      if (r.ok) model = r.model;
+      else fail(f.line, r.error);
+    } else if (isEffortLevel(f.value)) effort = f.value;
+    else fail(f.line, `effort is "${f.value}"; use low, medium, high, xhigh, max or ultra.`);
+  }
   if (errors.length > before || !code || !finalKind) return null;
   const description = quote
     .map((q) => q.trim())
@@ -212,6 +231,8 @@ function readStep(section: Section, errors: GraphFileError[]): DocStep | null {
     ...(access && { access }),
     ...(workspace && { workspace }),
     ...(timeoutSec !== undefined && { timeoutSec }),
+    ...(model && { model }),
+    ...(effort && { effort }),
     ...(description && { description }),
     ...(text && (finalKind === 'agent' ? { prompt: text } : { command: text })),
     line: section.line,
```

Change `shared/src/graphMarkdownWrite.ts`:

```diff
diff --git a/shared/src/graphMarkdownWrite.ts b/shared/src/graphMarkdownWrite.ts
--- a/shared/src/graphMarkdownWrite.ts
+++ b/shared/src/graphMarkdownWrite.ts
@@ -1,6 +1,7 @@
 import { fenceFor } from './fence';
 import { escapeFreeText } from './freeText';
 import { normText, oneLine, STEP_SEPARATOR, timeoutValue } from './graphDoc';
+import { stepModelText } from './stepModels';
 import type { Graph, GraphNode } from './types';
 
 /** A Mermaid node label: quoted, `"` as #quot;, on one line (spec §4.1). */
@@ -27,6 +28,8 @@ function stepLines(node: GraphNode): string[] {
   if (node.kind === 'agent' && node.access === 'read') fields.push('- access: read');
   if (node.workspace) fields.push(`- workspace: ${node.workspace}`);
   if (node.timeoutSec !== undefined) fields.push(`- timeout: ${timeoutValue(node.timeoutSec)}`);
+  if (node.kind === 'agent' && node.model) fields.push(`- model: ${stepModelText(node.model)}`);
+  if (node.kind === 'agent' && node.effort) fields.push(`- effort: ${node.effort}`);
   const description = oneLine(node.description ?? '');
   const text = normText((node.kind === 'agent' ? node.prompt : node.command) ?? '');
   return [
```

- [ ] **Step 4: Run the tests and typecheck**

Run: `npm test -w shared -- test/stepModelsMarkdown.test.ts test/graphMarkdownParse.test.ts test/graphMarkdownWrite.test.ts test/diffToOps.test.ts && npm test -w engine -- test/stepModelStore.test.ts test/graphFormatDoc.test.ts`
Expected: PASS.
Run: `npm run typecheck && npm test`
Expected: all workspaces pass (a test that times out only under heavy machine load is not a failure of this task: run it again).

- [ ] **Step 5: Commit**

```bash
git add docs/graph-format.md engine/src/graphStore.ts engine/test/stepModelStore.test.ts shared/src/diffToOps.ts shared/src/graphDoc.ts shared/src/graphMarkdownParse.ts shared/src/graphMarkdownWrite.ts shared/test/graphFixtures.ts shared/test/graphMarkdownParse.test.ts shared/test/stepModelsMarkdown.test.ts
git commit -m "feat: model and effort lines in graph Markdown files" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 3: Which model a step uses: the resolution rules

**Spec covered:** §3.1 (`RunMeta.stepModels`), §3.2 rules 1–4 and their notes, §7 engine resolution tests (as pure shared functions).

**Files:**
- Modify: `shared/src/stepModels.ts`, `shared/src/types.ts`
- Test: `shared/test/stepModelResolve.test.ts` (new)

**Interfaces:**
- Consumes: Task 1.
- Produces:
  ```ts
  // shared/src/types.ts
  export type StepModelUse = { model?: string; effort?: EffortLevel; note?: string };
  // RunMeta.stepModels?: Record<string, StepModelUse>; NodeEventBody 'start' gains model?: string; effort?: EffortLevel.
  // shared/src/stepModels.ts
  export type RunModels = { provider: ProviderId; model?: string; effort?: EffortLevel };
  export function effortProblem(provider: ProviderId, model: string | undefined, effort: EffortLevel, known: readonly ModelChoice[] | undefined): string | null;
  export function stepModelNote(model: StepModel, provider: ProviderId, known: readonly ModelChoice[] | undefined): string | null;
  export function resolveStepModel(node: { model?: StepModel; effort?: EffortLevel }, run: RunModels, known: readonly ModelChoice[] | undefined): StepModelUse;
  export function runStepModels(graph: Graph, run: RunModels, known: readonly ModelChoice[] | undefined, reused?: ReadonlySet<string>, source?: RunMeta): Record<string, StepModelUse>;
  ```

- [ ] **Step 1: Write the failing tests**

Create `shared/test/stepModelResolve.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { emptyGraph } from '../src/graph';
import { effortProblem, resolveStepModel, runStepModels, stepModelNote, type RunModels } from '../src/stepModels';
import type { EffortLevel, Graph, GraphNode, ModelChoice, RunMeta } from '../src/types';

const all: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];
/** Claude Code's list, as the research appendix found it (spec §8), cut down. */
const CLAUDE: ModelChoice[] = [
  { value: 'default', label: 'Default (recommended)', efforts: all },
  { value: 'sonnet', label: 'Sonnet', efforts: all, resolved: 'claude-sonnet-5' },
  { value: 'opus', label: 'Opus', efforts: all, resolved: 'claude-opus-5' },
  { value: 'haiku', label: 'Haiku', efforts: [] },
  { value: 'claude-opus-4-6', label: 'Opus 4.6', efforts: ['low', 'medium', 'high', 'max'] },
];
const CODEX: ModelChoice[] = [
  { value: 'gpt-6.1-sol', label: 'GPT-6.1-Sol', efforts: [...all, 'ultra'], isDefault: true },
  { value: 'gpt-6-luna', label: 'GPT-6-Luna', efforts: all },
];
const COPILOT: ModelChoice[] = [
  { value: 'auto', label: 'Auto', efforts: [] },
  { value: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', efforts: [] },
];
const claudeRun: RunModels = { provider: 'claude', model: 'sonnet', effort: 'high' };
const opus = { provider: 'claude' as const, id: 'opus' };

describe('resolveStepModel (spec §3.2)', () => {
  it('rule 1: a step without its own gets exactly the run’s model and effort', () => {
    expect(resolveStepModel({}, claudeRun, CLAUDE)).toEqual({ model: 'sonnet', effort: 'high' });
    expect(resolveStepModel({}, { provider: 'claude' }, CLAUDE)).toEqual({});
    // As before step models: the provider drops an effort its model lacks, with its own log note.
    expect(resolveStepModel({}, { provider: 'claude', model: 'haiku', effort: 'high' }, CLAUDE)).toEqual({ model: 'haiku', effort: 'high' });
  });

  it('rule 2: the step’s own model of the run’s provider, when the list offers it or isn’t known', () => {
    expect(resolveStepModel({ model: opus }, claudeRun, CLAUDE)).toEqual({ model: 'opus', effort: 'high' });
    expect(resolveStepModel({ model: { provider: 'claude', id: 'claude-opus-5' } }, claudeRun, CLAUDE)).toEqual({ model: 'claude-opus-5', effort: 'high' });
    expect(resolveStepModel({ model: { provider: 'claude', id: 'claude-fable-9' } }, claudeRun, undefined)).toEqual({ model: 'claude-fable-9', effort: 'high' });
    expect(resolveStepModel({ model: { provider: 'claude', id: 'claude-fable-9' } }, claudeRun, [])).toEqual({ model: 'claude-fable-9', effort: 'high' });
  });

  it('rule 2: a model the known list doesn’t offer runs the run’s model, with a note', () => {
    expect(resolveStepModel({ model: { provider: 'claude', id: 'claude-opus-4-1' } }, claudeRun, CLAUDE)).toEqual({
      model: 'sonnet',
      effort: 'high',
      note: "claude-opus-4-1 isn't offered by Claude any more (or on this plan), so this step uses the default model.",
    });
  });

  it('rule 2: Copilot still tries a model its list doesn’t name, with the same note', () => {
    expect(resolveStepModel({ model: { provider: 'copilot', id: 'grok-4.7' } }, { provider: 'copilot' }, COPILOT)).toEqual({
      model: 'grok-4.7',
      note: "grok-4.7 isn't offered by GitHub Copilot any more (or on this plan), so this step uses the default model.",
    });
    expect(resolveStepModel({ model: { provider: 'copilot', id: 'gpt-5.6-sol' } }, { provider: 'copilot' }, COPILOT)).toEqual({ model: 'gpt-5.6-sol' });
  });

  it('rule 3: a model of another provider runs the run’s model, with a note', () => {
    expect(resolveStepModel({ model: { provider: 'codex', id: 'gpt-6-astra' } }, claudeRun, CLAUDE)).toEqual({
      model: 'sonnet',
      effort: 'high',
      note: 'This step is set to an OpenAI Codex model (gpt-6-astra); this run uses Claude, so it uses the default model.',
    });
    expect(resolveStepModel({ model: opus }, { provider: 'codex' }, undefined)).toEqual({
      note: 'This step is set to a Claude model (opus); this run uses OpenAI Codex, so it uses the default model.',
    });
  });

  it('rule 4: the step’s effort, else the run’s, checked against the model the step uses', () => {
    expect(resolveStepModel({ effort: 'low' }, claudeRun, CLAUDE)).toEqual({ model: 'sonnet', effort: 'low' });
    expect(resolveStepModel({ model: opus, effort: 'max' }, claudeRun, CLAUDE)).toEqual({ model: 'opus', effort: 'max' });
    // The step's own effort dropped: the provider's own wording, as a note.
    expect(resolveStepModel({ model: { provider: 'claude', id: 'claude-opus-4-6' }, effort: 'xhigh' }, claudeRun, CLAUDE)).toEqual({
      model: 'claude-opus-4-6',
      note: 'Opus 4.6 (claude-opus-4-6) has no "xhigh" effort level; running without an effort level.',
    });
    expect(resolveStepModel({ effort: 'ultra' }, claudeRun, CLAUDE)).toEqual({ model: 'sonnet', note: 'Claude has no "ultra" effort level; running without an effort level.' });
    // The run's effort dropped for the step's own model: no note, the line shows it.
    expect(resolveStepModel({ model: { provider: 'claude', id: 'haiku' } }, claudeRun, CLAUDE)).toEqual({ model: 'haiku' });
    // Codex with no model: its default model's levels.
    expect(resolveStepModel({ effort: 'ultra' }, { provider: 'codex' }, CODEX)).toEqual({ effort: 'ultra' });
    expect(resolveStepModel({ model: { provider: 'codex', id: 'gpt-6-luna' }, effort: 'ultra' }, { provider: 'codex' }, CODEX)).toEqual({
      model: 'gpt-6-luna',
      note: 'GPT-6-Luna (gpt-6-luna) has no "ultra" effort level; running without an effort level.',
    });
  });

  it('Copilot has no effort levels: a step’s own effort is ignored, with a note', () => {
    expect(resolveStepModel({ effort: 'high' }, { provider: 'copilot' }, COPILOT)).toEqual({ note: 'GitHub Copilot has no effort levels; running without an effort level.' });
    expect(effortProblem('copilot', 'auto', 'low', undefined)).toBe('GitHub Copilot has no effort levels; running without an effort level.');
  });

  it('joins a model note and an effort note', () => {
    expect(resolveStepModel({ model: { provider: 'codex', id: 'gpt-6-astra' }, effort: 'ultra' }, claudeRun, CLAUDE).note).toBe(
      'This step is set to an OpenAI Codex model (gpt-6-astra); this run uses Claude, so it uses the default model. Claude has no "ultra" effort level; running without an effort level.',
    );
  });

  it('stepModelNote is null for a model the run can use', () => {
    expect(stepModelNote(opus, 'claude', CLAUDE)).toBeNull();
    expect(stepModelNote(opus, 'claude', undefined)).toBeNull();
  });
});

describe('runStepModels (spec §3.1)', () => {
  const node = (id: string, over: Partial<GraphNode> = {}): GraphNode => ({ id, title: id, kind: 'agent', prompt: 'p', createdBy: 'user', updatedBy: 'user', updatedAt: 't', ...over });
  const graph: Graph = {
    ...emptyGraph('g', 'G', 't'),
    nodes: [node('n1', { model: opus }), node('n2', { kind: 'command', prompt: undefined, command: 'ls' }), node('n3', { effort: 'low' }), node('n4')],
  };

  it('resolves every agent step, and leaves command steps out', () => {
    expect(runStepModels(graph, claudeRun, CLAUDE)).toEqual({
      n1: { model: 'opus', effort: 'high' },
      n3: { model: 'sonnet', effort: 'low' },
      n4: { model: 'sonnet', effort: 'high' },
    });
  });

  it('a reused step keeps what it ran with: its record, or the source run’s model and effort', () => {
    const source = { id: 'r0', model: 'haiku', effort: 'medium', stepModels: { n1: { model: 'claude-opus-4-6', note: 'x' } } } as unknown as RunMeta;
    expect(runStepModels(graph, claudeRun, CLAUDE, new Set(['n1', 'n4']), source)).toEqual({
      n1: { model: 'claude-opus-4-6', note: 'x' },
      n3: { model: 'sonnet', effort: 'low' },
      n4: { model: 'haiku', effort: 'medium' },
    });
  });
});
```

- [ ] **Step 2: Run the tests and see them fail**

Run: `npm test -w shared -- test/stepModelResolve.test.ts`
Expected: FAIL — the new modules, exports or behaviour do not exist yet (import errors or assertion failures).

- [ ] **Step 3: Implement**

Change `shared/src/stepModels.ts`:

```diff
diff --git a/shared/src/stepModels.ts b/shared/src/stepModels.ts
--- a/shared/src/stepModels.ts
+++ b/shared/src/stepModels.ts
@@ -1,5 +1,6 @@
-import { isEffortLevel } from './format';
-import { PROVIDER_IDS, type EffortLevel, type ProviderId, type StepModel } from './types';
+import { isEffortLevel, supportsEffort } from './format';
+import { CLI_DEFAULT_MODEL, findModel } from './models';
+import { PROVIDER_IDS, PROVIDER_NAMES, type EffortLevel, type Graph, type ModelChoice, type ProviderId, type RunMeta, type StepModel, type StepModelUse } from './types';
 
 /** The longest model id a step can store. */
 export const MAX_MODEL_ID_CHARS = 200;
@@ -39,3 +40,78 @@ export function stepModelProblem(model: StepModel | undefined, effort: EffortLev
   if (effort !== undefined && !isEffortLevel(effort)) return `effort "${String(effort)}": use low, medium, high, xhigh, max or ultra.`;
   return null;
 }
+
+/** The run's own provider, model and effort: what a step without its own uses (spec §3.2's R, M and E). */
+export type RunModels = { provider: ProviderId; model?: string; effort?: EffortLevel };
+
+/** A list that names models; an empty one (not listed yet, or the list failed) counts as unknown. */
+const listed = (known: readonly ModelChoice[] | undefined) => (known && known.length > 0 ? known : undefined);
+
+/**
+ * Why a provider's model can't take `effort`, in the words of the provider's own log note (spec §3.2 rule 4); null when it
+ * can, or when the list doesn't say. No model means the provider's default: Claude Code's default row, Codex's default model.
+ */
+export function effortProblem(provider: ProviderId, model: string | undefined, effort: EffortLevel, known: readonly ModelChoice[] | undefined): string | null {
+  if (!supportsEffort(provider)) return `${PROVIDER_NAMES[provider]} has no effort levels; running without an effort level.`;
+  if (provider === 'claude' && effort === 'ultra') return 'Claude has no "ultra" effort level; running without an effort level.';
+  const list = listed(known);
+  const entry = model ? findModel(list, model) : provider === 'claude' ? findModel(list, CLI_DEFAULT_MODEL) : list?.find((m) => m.isDefault);
+  if (entry && !entry.efforts.includes(effort)) return `${entry.label} (${model ?? entry.value}) has no "${effort}" effort level; running without an effort level.`;
+  return null;
+}
+
+/** A step model's note when it can't be used with this run's provider and model list; null when it can (spec §3.2 rules 2 and 3). */
+export function stepModelNote(model: StepModel, provider: ProviderId, known: readonly ModelChoice[] | undefined): string | null {
+  if (model.provider !== provider) {
+    const name = PROVIDER_NAMES[model.provider];
+    return `This step is set to ${/^[aeiou]/i.test(name) ? 'an' : 'a'} ${name} model (${model.id}); this run uses ${PROVIDER_NAMES[provider]}, so it uses the default model.`;
+  }
+  const list = listed(known);
+  if (list && !findModel(list, model.id)) return `${model.id} isn't offered by ${PROVIDER_NAMES[provider]} any more (or on this plan), so this step uses the default model.`;
+  return null;
+}
+
+/**
+ * The model and effort one agent step runs with (spec §3.2). A step without its own gets exactly the run's, as before (the
+ * provider then drops an effort its model doesn't offer, with its log note). A step's own model is used when it belongs to
+ * the run's provider and the known list offers it, else the run's model with a note; Copilot still tries a model its list
+ * doesn't name, and falls back to Auto itself. The effort (the step's, else the run's) is checked against the model the
+ * step will use; one it can't take is dropped, with a note when it was the step's own.
+ */
+export function resolveStepModel(node: { model?: StepModel; effort?: EffortLevel }, run: RunModels, known: readonly ModelChoice[] | undefined): StepModelUse {
+  const ownModel = node.model;
+  const ownEffort = node.effort;
+  if (!ownModel && !ownEffort) return { ...(run.model && { model: run.model }), ...(run.effort && { effort: run.effort }) };
+  const notes: string[] = [];
+  let model = run.model;
+  if (ownModel) {
+    const note = stepModelNote(ownModel, run.provider, known);
+    if (note) notes.push(note);
+    if (!note || (ownModel.provider === run.provider && run.provider === 'copilot')) model = ownModel.id;
+  }
+  let effort = ownEffort ?? run.effort;
+  if (effort) {
+    const problem = effortProblem(run.provider, model, effort, known);
+    if (problem) {
+      if (ownEffort) notes.push(problem);
+      effort = undefined;
+    }
+  }
+  return { ...(model && { model }), ...(effort && { effort }), ...(notes.length > 0 && { note: notes.join(' ') }) };
+}
+
+/**
+ * Every agent step's model and effort for a run that starts now (spec §3.1). A step the run reuses keeps what it ran with in
+ * `source`: its own record, or that run's model and effort for a run from before step models.
+ */
+export function runStepModels(graph: Graph, run: RunModels, known: readonly ModelChoice[] | undefined, reused: ReadonlySet<string> = new Set(), source?: RunMeta): Record<string, StepModelUse> {
+  const out: Record<string, StepModelUse> = {};
+  for (const n of graph.nodes) {
+    if (n.kind !== 'agent') continue;
+    if (source && reused.has(n.id)) {
+      const before = source.stepModels?.[n.id] ?? { ...(source.model && { model: source.model }), ...(source.effort && { effort: source.effort }) };
+      out[n.id] = { ...before };
+    } else out[n.id] = resolveStepModel(n, run, known);
+  }
+  return out;
+}
```

Change `shared/src/types.ts`:

```diff
diff --git a/shared/src/types.ts b/shared/src/types.ts
--- a/shared/src/types.ts
+++ b/shared/src/types.ts
@@ -233,8 +233,13 @@ export type RunMeta = {
   /** The model and effort the run's agent steps used, captured from the settings when it started (only when set). */
   model?: string;
   effort?: EffortLevel;
+  /** Each agent step's model and effort, resolved when the run started (step model spec §3.1); absent in runs from before. */
+  stepModels?: Record<string, StepModelUse>;
 };
 
+/** What one agent step of a run uses: absent fields are the provider's own default. `note` says why it isn't the step's own choice. */
+export type StepModelUse = { model?: string; effort?: EffortLevel; note?: string };
+
 /** One approved change a step agent made to a run in progress: `byNodeId` asked, `nodeId` is the step added or changed. */
 export type RunAmendment = { at: string; byNodeId: string; nodeId: string; summary: string };
 
@@ -244,7 +249,8 @@ export type RunSummary = { id: string; graphId: string; status: RunStatus; start
 export type Decision = { decision: 'approve' } | { decision: 'deny'; note?: string } | { decision: 'cancelled' };
 
 export type NodeEventBody =
-  | { type: 'start'; kind: NodeKind; cwd: string; command?: string; prompt?: string }
+  /** `model`/`effort`: what an agent step actually ran with, as the provider sent it (absent: the provider's default). */
+  | { type: 'start'; kind: NodeKind; cwd: string; command?: string; prompt?: string; model?: string; effort?: EffortLevel }
   | { type: 'text'; text: string }
   | { type: 'tool_call'; toolUseId: string; name: string; input: unknown }
   | { type: 'tool_result'; toolUseId: string; content: string; isError: boolean }
```

- [ ] **Step 4: Run the tests and typecheck**

Run: `npm test -w shared -- test/stepModelResolve.test.ts`
Expected: PASS.
Run: `npm run typecheck && npm test`
Expected: all workspaces pass (a test that times out only under heavy machine load is not a failure of this task: run it again).

- [ ] **Step 5: Commit**

```bash
git add shared/src/stepModels.ts shared/src/types.ts shared/test/stepModelResolve.test.ts
git commit -m "feat(shared): resolve each agent step's model and effort for a run" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 4: Runs use each step's model and effort; providers log what they sent

**Spec covered:** §3.1 (resolved once at start, saved, re-runs), §3.3 step log, §6 (Copilot never sends an effort), §7 engine tests (snapshot, re-runs, executors receive the step's values) and the extension's Copilot check.

**Files:**
- Modify: `engine/src/app.ts`, `engine/src/executors.ts`, `engine/src/providers/claude/runStep.ts`, `engine/src/providers/codex/runStep.ts`, `engine/src/runner.ts`, `extension/src/providers/copilot.ts`
- Test: `engine/test/stepModelRun.test.ts` (new), `engine/test/claudeRunStep.test.ts`, `engine/test/codexRunStep.test.ts`, `extension/test/copilot.test.ts`

**Interfaces:**
- Consumes: Task 3's `runStepModels`, `StepModelUse`.
- Produces: `StartRunInput.stepModels?: Record<string, StepModelUse>` (Runner); `NodeContext.model`/`effort` now come from the step's entry (else the run's); the Runner logs `entry.note` as a `text` event right after `start`. Claude, Codex and Copilot put the model and effort they send in their `start` event.

The new tests wait for runs with `vi.waitFor(…, { timeout: 5000 })`. `extension/test/copilot.test.ts`'s existing runStep test now expects `model: 'auto'` in the start event (named exception).

- [ ] **Step 1: Write the failing tests**

Create `engine/test/stepModelRun.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { applyOp, emptyGraph, type EffortLevel, type Graph, type ModelChoice, type ModelSelection, type NodeEvent, type Op, type ServerMessage } from '@agent-stream/shared';
import { createApp, type App } from '../src/app';
import { ApprovalBroker } from '../src/approvals';
import type { NodeContext, NodeExecutor } from '../src/executors';
import { Runner } from '../src/runner';
import { RunStore } from '../src/runStore';
import { appTestDeps, signedIn, testGitBash, testLeases, testProvider, tmpProject, tmpValuesFile } from './helpers';

const all: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const MODELS: ModelChoice[] = [
  { value: 'sonnet', label: 'Sonnet', efforts: all },
  { value: 'opus', label: 'Opus', efforts: all },
  { value: 'haiku', label: 'Haiku', efforts: [] },
];
const opus = { provider: 'claude' as const, id: 'opus' };

function graphOf(ops: Op[]): Graph {
  let g = emptyGraph('g', 'G', 't');
  for (const op of ops) {
    const r = applyOp(g, op, 'user', 't');
    if (!r.ok) throw new Error(r.error);
    g = r.graph;
  }
  return g;
}

describe('Runner: each step’s model and effort', () => {
  it('gives each agent step its resolved model and effort, records them, and logs a note right after the start', async () => {
    const paths = tmpProject();
    const runStore = new RunStore(paths);
    const seen: Record<string, { model?: string; effort?: EffortLevel }> = {};
    const agent: NodeExecutor = async (ctx: NodeContext) => {
      ctx.emit({ type: 'start', kind: 'agent', cwd: ctx.cwd });
      seen[ctx.node.id] = { model: ctx.model, effort: ctx.effort };
      return { ok: true, output: '' };
    };
    const runner = new Runner({ runStore, broker: new ApprovalBroker(), executors: { agent, command: agent }, projectDir: paths.root, maxParallel: 2, leases: testLeases() });
    const graph = graphOf([
      { type: 'addNode', node: { title: 'a', kind: 'agent', prompt: 'a' } },
      { type: 'addNode', node: { title: 'b', kind: 'agent', prompt: 'b' } },
    ]);
    const rendered = { goal: '', instructions: '', nodes: { n1: 'a', n2: 'b' } };
    const stepModels = { n1: { model: 'opus', effort: 'max' as const, note: 'Why not its own.' } };
    const started = runner.start({ graph, rendered, model: 'sonnet', effort: 'high', stepModels });
    if (!started.ok) throw new Error(started.error);
    const done = await started.done;
    expect(seen).toEqual({ n1: { model: 'opus', effort: 'max' }, n2: { model: 'sonnet', effort: 'high' } });
    expect(done.stepModels).toEqual(stepModels);
    expect(done.stepModels).not.toBe(stepModels);
    expect(runStore.readEvents(done.id, 'n1').map((e) => e.type === 'text' ? `text: ${e.text}` : e.type)).toEqual(['start', 'text: Why not its own.', 'result']);
    expect(runStore.readEvents(done.id, 'n2').map((e) => e.type)).toEqual(['start', 'result']);
  });
});

describe('App: runs with step models', () => {
  type Ctx = { node: string; model?: string; effort?: EffortLevel };

  /** `listed: false`: the provider hasn't listed its models yet. */
  function setup(defaults: ModelSelection, listed = true) {
    const known = listed ? MODELS : undefined;
    const seen: Ctx[] = [];
    const provider = testProvider({
      knownModels: () => known,
      listModels: async () => known ?? [],
      runStep: async (ctx) => {
        ctx.emit({ type: 'start', kind: 'agent', cwd: ctx.cwd, ...(ctx.model && { model: ctx.model }), ...(ctx.effort && { effort: ctx.effort }) });
        seen.push({ node: ctx.node.id, model: ctx.model, effort: ctx.effort });
        return { ok: true, output: `out-${ctx.node.id}` };
      },
    });
    const paths = tmpProject();
    const app = createApp({ ...appTestDeps(), projectDir: paths.root, valuesFile: tmpValuesFile(), provider, status: signedIn, maxParallel: 1, gitBash: testGitBash, modelDefaults: () => defaults });
    const graphId = app.graphStore.create('G').id;
    const msgs: ServerMessage[] = [];
    const client = { send: (m: ServerMessage) => void msgs.push(structuredClone(m)) };
    app.connect(client);
    const last = <T extends ServerMessage['type']>(type: T) => msgs.filter((m): m is Extract<ServerMessage, { type: T }> => m.type === type).at(-1)!;
    return { app, graphId, seen, client, last };
  }

  async function run(app: App, client: { send(m: ServerMessage): void }, last: ReturnType<typeof setup>['last'], graphId: string, extra: { fromNodeId?: string; sourceRunId?: string } = {}) {
    await app.handle(client, { type: 'previewRun', graphId, ...extra });
    await app.handle(client, { type: 'startRun', graphId, reviewed: last('runPreview').preview.signature, ...extra });
    await vi.waitFor(() => expect(last('run').run.status).toBe('succeeded'), { timeout: 5000 });
    return last('run').run;
  }

  it('resolves each agent step when the run starts, saves it in the run, and runs each step with it', async () => {
    const { app, graphId, seen, client, last } = setup({ model: 'sonnet', effort: 'high' });
    app.graphStore.apply(graphId, { type: 'addNode', node: { id: 'n1', title: 'own', kind: 'agent', prompt: 'p', model: opus, effort: 'max' } }, 'user');
    app.graphStore.apply(graphId, { type: 'addNode', node: { id: 'n2', title: 'other', kind: 'agent', prompt: 'p', model: { provider: 'codex', id: 'gpt-6-astra' } } }, 'user');
    app.graphStore.apply(graphId, { type: 'addNode', node: { id: 'n3', title: 'plain', kind: 'agent', prompt: 'p' } }, 'user');
    const done = await run(app, client, last, graphId);
    const note = 'This step is set to an OpenAI Codex model (gpt-6-astra); this run uses Claude, so it uses the default model.';
    expect(done.stepModels).toEqual({ n1: { model: 'opus', effort: 'max' }, n2: { model: 'sonnet', effort: 'high', note }, n3: { model: 'sonnet', effort: 'high' } });
    expect(seen.sort((a, b) => a.node.localeCompare(b.node))).toEqual([
      { node: 'n1', model: 'opus', effort: 'max' },
      { node: 'n2', model: 'sonnet', effort: 'high' },
      { node: 'n3', model: 'sonnet', effort: 'high' },
    ]);
    const events: NodeEvent[] = app.runStore.readEvents(done.id, 'n2');
    expect(events.slice(0, 2)).toMatchObject([{ type: 'start', model: 'sonnet', effort: 'high' }, { type: 'text', text: note }]);
  });

  it('a re-run resolves the steps it runs again, and a reused step keeps what it ran with', async () => {
    const defaults: ModelSelection = { model: 'sonnet', effort: 'high' };
    const { app, graphId, client, last } = setup(defaults);
    app.graphStore.apply(graphId, { type: 'addNode', node: { id: 'n1', title: 'first', kind: 'agent', prompt: 'p' } }, 'user');
    app.graphStore.apply(graphId, { type: 'addNode', node: { id: 'n2', title: 'second', kind: 'agent', prompt: 'p', effort: 'low' } }, 'user');
    app.graphStore.apply(graphId, { type: 'connect', from: 'n1', to: 'n2' }, 'user');
    const first = await run(app, client, last, graphId);
    defaults.model = 'haiku';
    delete defaults.effort;
    const second = await run(app, client, last, graphId, { fromNodeId: 'n2', sourceRunId: first.id });
    expect(second.nodes.n1.status).toBe('reused');
    expect(second.stepModels).toEqual({ n1: { model: 'sonnet', effort: 'high' }, n2: { model: 'haiku', note: 'Haiku (haiku) has no "low" effort level; running without an effort level.' } });
  });

  it('with no model list known yet, a step tries its own model', async () => {
    const { app, graphId, client, last } = setup({}, false);
    app.graphStore.apply(graphId, { type: 'addNode', node: { id: 'n1', title: 'own', kind: 'agent', prompt: 'p', model: { provider: 'claude', id: 'claude-fable-5' } } }, 'user');
    const done = await run(app, client, last, graphId);
    expect(done.stepModels).toEqual({ n1: { model: 'claude-fable-5' } });
  });
});
```

Change `engine/test/claudeRunStep.test.ts`:

```diff
diff --git a/engine/test/claudeRunStep.test.ts b/engine/test/claudeRunStep.test.ts
--- a/engine/test/claudeRunStep.test.ts
+++ b/engine/test/claudeRunStep.test.ts
@@ -299,3 +299,23 @@ describe('Claude provider: steps', () => {
     expect(createClaudeProvider({ findClaude: () => ({ ok: true, path: '/c' }) }).folderProblem?.(mkdtempSync(join(tmpdir(), 'cs-')))).toBeUndefined();
   });
 });
+
+describe('Claude provider: the model and effort a step runs with', () => {
+  it('logs them in the start event as they are sent, an effort Claude lacks left out', async () => {
+    const script = () =>
+      fake(async function* () {
+        yield init();
+        yield success('ok');
+      });
+    const kept = script();
+    const a = ctx();
+    await runStep({ queryFn: kept.fn }, { ...a.c, model: 'opus', effort: 'high' });
+    expect(a.events[0]).toEqual({ type: 'start', kind: 'agent', cwd: '/proj', prompt: 'FULL PROMPT', model: 'opus', effort: 'high' });
+    expect(kept.calls[0].options).toMatchObject({ model: 'opus', effort: 'high' });
+    const dropped = script();
+    const b = ctx();
+    await runStep({ queryFn: dropped.fn }, { ...b.c, model: 'opus', effort: 'ultra' });
+    expect(b.events[0]).toEqual({ type: 'start', kind: 'agent', cwd: '/proj', prompt: 'FULL PROMPT', model: 'opus' });
+    expect(dropped.calls[0].options).not.toHaveProperty('effort');
+  });
+});
```

Change `engine/test/codexRunStep.test.ts`:

```diff
diff --git a/engine/test/codexRunStep.test.ts b/engine/test/codexRunStep.test.ts
--- a/engine/test/codexRunStep.test.ts
+++ b/engine/test/codexRunStep.test.ts
@@ -349,3 +349,15 @@ describe('stepItemEvents', () => {
     expect(stepItemEvents('completed', { type: 'userMessage', id: 'u1' }, none)).toEqual([]);
   });
 });
+
+describe('codexRunStep: the model and effort a step runs with', () => {
+  it('logs them in the start event as they are sent, an effort the model lacks left out', async () => {
+    const known: ModelChoice[] = [{ value: 'gpt-a', label: 'A', efforts: ['high'] }];
+    const kept = step((t) => t.end(), { model: 'gpt-a', effort: 'high', known });
+    await kept.run();
+    expect(kept.events[0]).toEqual({ type: 'start', kind: 'agent', cwd, prompt: 'FULL PROMPT', model: 'gpt-a', effort: 'high' });
+    const dropped = step((t) => t.end(), { model: 'gpt-a', effort: 'ultra', known });
+    await dropped.run();
+    expect(dropped.events[0]).toEqual({ type: 'start', kind: 'agent', cwd, prompt: 'FULL PROMPT', model: 'gpt-a' });
+  });
+});
```

Change `extension/test/copilot.test.ts` (named exception: the start event names the model; the step helper takes an effort; new §6 tests):

```diff
diff --git a/extension/test/copilot.test.ts b/extension/test/copilot.test.ts
--- a/extension/test/copilot.test.ts
+++ b/extension/test/copilot.test.ts
@@ -4,7 +4,7 @@ import { join } from 'node:path';
 import { describe, expect, it, vi } from 'vitest';
 import * as vscode from 'vscode';
 import { createPlannerGate, type ChatMessage, type GraphTool, type NodeContext, type PlannerEvent, type PlannerTurn, type RunShell, type ToolGate } from '@agent-stream/engine';
-import { emptyGraph, type GraphNode, type NodeEventBody } from '@agent-stream/shared';
+import { emptyGraph, type EffortLevel, type GraphNode, type NodeEventBody } from '@agent-stream/shared';
 import { COPILOT_CONSENT_LATER, COPILOT_RESUME_FAILED, COPILOT_UNAVAILABLE, createCopilotProvider, type CopilotLimits, type LmAccess, type LmApi } from '../src/providers/copilot';
 import { COPILOT_PERMISSION } from '../src/providers/copilotModel';
 import { fakeLmModel } from './helpers';
@@ -25,7 +25,7 @@ function provider(o: { lm?: LmApi; access?: LmAccess; limits?: Partial<CopilotLi
   return createCopilotProvider({ lm: o.lm, access: o.access, runShell: noShell, limits: () => ({ maxRequestsPerStep: 25, maxRequestsPerTurn: 10, ...o.limits }) });
 }
 
-function step(o: { model?: string; access?: 'read'; graphTools?: GraphTool[]; signal?: AbortSignal } = {}) {
+function step(o: { model?: string; effort?: EffortLevel; access?: 'read'; graphTools?: GraphTool[]; signal?: AbortSignal } = {}) {
   const events: NodeEventBody[] = [];
   const cwd = mkdtempSync(join(tmpdir(), 'copilot-step-'));
   const node: GraphNode = { id: 'n1', title: 'Step', kind: 'agent', prompt: 'p', ...(o.access && { access: o.access }), createdBy: 'user', updatedBy: 'user', updatedAt: 't' };
@@ -38,6 +38,7 @@ function step(o: { model?: string; access?: 'read'; graphTools?: GraphTool[]; si
     signal: o.signal ?? new AbortController().signal,
     emit: (e) => events.push(e),
     ...(o.model && { model: o.model }),
+    ...(o.effort && { effort: o.effort }),
     ...(o.graphTools && { graphTools: o.graphTools }),
   };
   return { ctx, events, cwd };
@@ -185,7 +186,7 @@ describe('Copilot runStep', () => {
     const m = fakeLmModel({ id: 'auto', name: 'Auto', replies: [[call('c1', 'Read', { file_path: 'a.txt' })], [text('The file says '), text('hello.')]] });
     const out = await provider({ lm: models(m.model) }).runStep(s.ctx, allowAll);
     expect(s.events).toEqual([
-      { type: 'start', kind: 'agent', cwd: s.cwd, prompt: 'Do it.' },
+      { type: 'start', kind: 'agent', cwd: s.cwd, prompt: 'Do it.', model: 'auto' },
       { type: 'tool_call', toolUseId: 'c1', name: 'Read', input: { file_path: 'a.txt' } },
       { type: 'tool_result', toolUseId: 'c1', content: '     1\thello', isError: false },
       { type: 'text', text: 'The file says hello.' },
@@ -355,3 +356,26 @@ describe('Copilot planTurn', () => {
     expect(r).toEqual({ ok: true, sessionId: expect.any(String), error: 'Stopped after 1 Copilot requests (agentStream.copilot.maxRequestsPerTurn). Raise the setting to let planner turns run longer, or type continue to pick up where it stopped.' });
   });
 });
+
+describe('Copilot effort (step model spec §6)', () => {
+  it('has no effort option for extensions: a step’s effort is never sent, and its start names the model it ran on', async () => {
+    const s = step({ model: 'gpt-4o-mini', effort: 'high' });
+    const auto = fakeLmModel({ id: 'auto', name: 'Auto' });
+    const mini = fakeLmModel({ id: 'gpt-4o-mini', name: 'GPT-4o mini' });
+    await provider({ lm: models(auto.model, mini.model) }).runStep(s.ctx, allowAll);
+    expect(s.events[0]).toEqual({ type: 'start', kind: 'agent', cwd: s.cwd, prompt: 'Do it.', model: 'gpt-4o-mini' });
+    const options = mini.requests[0].options!;
+    expect(options).not.toHaveProperty('modelOptions');
+    expect(JSON.stringify(options)).not.toContain('high');
+  });
+
+  it('names Auto in the start event of a step whose model is gone', async () => {
+    const s = step({ model: 'gpt-9' });
+    const auto = fakeLmModel({ id: 'auto', name: 'Auto' });
+    await provider({ lm: models(auto.model) }).runStep(s.ctx, allowAll);
+    expect(s.events.slice(0, 2)).toEqual([
+      { type: 'start', kind: 'agent', cwd: s.cwd, prompt: 'Do it.', model: 'auto' },
+      { type: 'text', text: 'The Copilot model gpt-9 is no longer available; using Auto.' },
+    ]);
+  });
+});
```

- [ ] **Step 2: Run the tests and see them fail**

Run: `npm test -w engine -- test/stepModelRun.test.ts test/claudeRunStep.test.ts test/codexRunStep.test.ts && npm test -w extension -- test/copilot.test.ts`
Expected: FAIL — the new modules, exports or behaviour do not exist yet (import errors or assertion failures).

- [ ] **Step 3: Implement**

Change `engine/src/app.ts`:

```diff
diff --git a/engine/src/app.ts b/engine/src/app.ts
--- a/engine/src/app.ts
+++ b/engine/src/app.ts
@@ -4,6 +4,7 @@ import {
   findModel,
   isWriteCapable,
   refinable,
+  runStepModels,
   validateRunnable,
   workspaceOf,
   type AgentChange,
@@ -682,6 +683,13 @@ export function createApp(d: AppDeps) {
             if (!removed.ok) console.error('[agent-stream] could not remove a worktree after a refused start', w.path, removed.error);
           }
         };
+        // Like the provider, fixed for the whole run: a settings change mid-run doesn't reach its later steps.
+        const defaults = modelDefaults();
+        // Each agent step's own model and effort, resolved once against the list known now (never waiting for it); a
+        // reused step keeps what it ran with (step model spec §3.1).
+        const reusedIds = new Set(p.outcome.preview.steps.filter((s) => s.reused).map((s) => s.id));
+        const source = msg.sourceRunId ? runStore.get(msg.sourceRunId) : undefined;
+        const stepModels = runStepModels(r.graph, { provider: provider.id, ...defaults }, knownModels(), reusedIds, source);
         let started: ReturnType<typeof runner.start>;
         try {
           started = runner.start({
@@ -690,8 +698,8 @@ export function createApp(d: AppDeps) {
             sourceRunId: msg.sourceRunId,
             fromNodeId: msg.fromNodeId,
             provider: provider.id,
-            // Like the provider, fixed for the whole run: a settings change mid-run doesn't reach its later steps.
-            ...modelDefaults(),
+            ...defaults,
+            stepModels,
             runId,
             checkout,
             sequential: msg.sequential,
```

Change `engine/src/executors.ts`:

```diff
diff --git a/engine/src/executors.ts b/engine/src/executors.ts
--- a/engine/src/executors.ts
+++ b/engine/src/executors.ts
@@ -14,7 +14,7 @@ export type NodeContext = {
   emit: (event: NodeEventBody) => void;
   /** Agent steps: tools to change the graph of the running run, each asking the user first (add_step, change_step). */
   graphTools?: GraphTool[];
-  /** Agent steps: the run's model and effort, captured when it started; absent: the provider's own default. */
+  /** Agent steps: the model and effort the run resolved for this step when it started; absent: the provider's own default. */
   model?: string;
   effort?: EffortLevel;
 };
```

Change `engine/src/providers/claude/runStep.ts`:

```diff
diff --git a/engine/src/providers/claude/runStep.ts b/engine/src/providers/claude/runStep.ts
--- a/engine/src/providers/claude/runStep.ts
+++ b/engine/src/providers/claude/runStep.ts
@@ -93,7 +93,9 @@ export function claudeRunStep(deps: ClaudeRunDeps) {
     // Re-checked per node: the project's settings can change while VS Code runs.
     const settingsProblem = projectSettingsProblem(ctx.cwd);
     if (settingsProblem) return { ok: false, output: '', error: settingsProblem };
-    ctx.emit({ type: 'start', kind: 'agent', cwd: ctx.cwd, prompt: ctx.prompt });
+    const chosen = sdkModelOptions(deps, ctx);
+    // The model and effort the step actually runs with: an effort the model doesn't offer is already dropped.
+    ctx.emit({ type: 'start', kind: 'agent', cwd: ctx.cwd, prompt: ctx.prompt, ...(chosen.model && { model: chosen.model }), ...(chosen.effort && { effort: chosen.effort as EffortLevel }) });
     const abortController = new AbortController();
     const onAbort = () => abortController.abort();
     ctx.signal.addEventListener('abort', onAbort, { once: true });
@@ -110,7 +112,7 @@ export function claudeRunStep(deps: ClaudeRunDeps) {
       hooks: gate.hooks,
       canUseTool: gate.canUseTool,
       abortController,
-      ...sdkModelOptions(deps, ctx),
+      ...chosen,
     };
     if (ctx.graphTools?.length) {
       // The step's own graph tools: each asks the user with the exact change (the gate lets them through).
```

Change `engine/src/providers/codex/runStep.ts`:

```diff
diff --git a/engine/src/providers/codex/runStep.ts b/engine/src/providers/codex/runStep.ts
--- a/engine/src/providers/codex/runStep.ts
+++ b/engine/src/providers/codex/runStep.ts
@@ -98,7 +98,9 @@ export function codexRunStep(deps: CodexRunDeps) {
   return async (ctx: NodeContext, gate: ToolGate): Promise<NodeOutcome> => {
     const codexPath = deps.codexPath();
     if (!codexPath) return { ok: false, output: '', error: deps.missing() };
-    ctx.emit({ type: 'start', kind: 'agent', cwd: ctx.cwd, prompt: ctx.prompt });
+    const effort = codexEffort(ctx, deps.knownModels(), deps.warnOnce);
+    // The model and effort the step actually runs with: an effort the model doesn't offer is already dropped.
+    ctx.emit({ type: 'start', kind: 'agent', cwd: ctx.cwd, prompt: ctx.prompt, ...(ctx.model && { model: ctx.model }), ...(effort && { effort }) });
     const readOnly = !isWriteCapable(ctx.node);
     const tools = readOnly ? [] : toLoopTools(ctx.graphTools ?? [], STEP_GRAPH_TOOL_PREFIX);
     /** Aborted when the step ends or Codex exits: approval cards still open are withdrawn (R18). */
@@ -140,7 +142,7 @@ export function codexRunStep(deps: CodexRunDeps) {
         conn,
         threadId: thread.thread.id,
         text: ctx.prompt,
-        effort: codexEffort(ctx, deps.knownModels(), deps.warnOnce),
+        effort,
         signal: ctx.signal,
         onItem: (phase, item) => {
           // Recorded before Codex's approval request for it arrives: notifications are handled in order (R14).
```

Change `engine/src/runner.ts`:

```diff
diff --git a/engine/src/runner.ts b/engine/src/runner.ts
--- a/engine/src/runner.ts
+++ b/engine/src/runner.ts
@@ -23,6 +23,7 @@ import {
   type ProviderId,
   type RenderedRun,
   type RunMeta,
+  type StepModelUse,
   type WaitingFor,
 } from '@agent-stream/shared';
 import type { ApprovalBroker } from './approvals';
@@ -68,6 +69,8 @@ export type StartRunInput = {
   /** The model and effort every agent step of this run gets, captured at start and recorded in the run (only when set). */
   model?: string;
   effort?: EffortLevel;
+  /** Each agent step's own model and effort, resolved at start (step model spec §3.1); a step without an entry gets `model` and `effort`. */
+  stepModels?: Record<string, StepModelUse>;
   /** The run's id, when the caller needs it before the run starts (variant worktree paths contain it). */
   runId?: string;
   /** Start even though another run holds the checkout's lease: write-capable checkout steps wait for it (spec §4.3). */
@@ -197,6 +200,7 @@ export class Runner extends EventEmitter {
       ...(input.provider && { provider: input.provider }),
       ...(input.model && { model: input.model }),
       ...(input.effort && { effort: input.effort }),
+      ...(input.stepModels && Object.keys(input.stepModels).length > 0 && { stepModels: structuredClone(input.stepModels) }),
       ...(input.checkout && { checkout: toRunCheckout(input.checkout) }),
       ...(waitFor && { waitingFor: waitingOn(waitFor.holder) }),
       ...(Object.keys(workspaces).length > 0 && { workspaces }),
@@ -434,6 +438,17 @@ export class Runner extends EventEmitter {
     this.setNode(run, nodeId, { status: 'running', startedAt: this.clock() });
     const startedAt = Date.now();
     const executor = node.kind === 'agent' ? (run.agent ?? this.deps.executors.agent) : this.deps.executors[node.kind];
+    // What the run resolved for this step when it started; a step added during the run gets the run's own (spec §3.1).
+    const use: StepModelUse | undefined = node.kind === 'agent' ? (meta.stepModels?.[nodeId] ?? { model: meta.model, effort: meta.effort }) : undefined;
+    let noted = false;
+    const emit = (event: NodeEventBody) => {
+      this.emitEvent(run, nodeId, event);
+      // Why the step doesn't run its own model or effort: a line in its log, right after it starts.
+      if (event.type === 'start' && use?.note && !noted) {
+        noted = true;
+        this.emitEvent(run, nodeId, { type: 'text', text: use.note });
+      }
+    };
     Promise.resolve()
       .then(() => {
         const workspace = workspaceOf(node);
@@ -467,9 +482,9 @@ export class Runner extends EventEmitter {
           // Agents get the variant path as their working directory; commands run there (spec §4.3a).
           cwd: place?.path ?? this.deps.projectDir,
           signal: controller.signal,
-          emit: (event) => this.emitEvent(run, nodeId, event),
-          ...(node.kind === 'agent' && meta.model && { model: meta.model }),
-          ...(node.kind === 'agent' && meta.effort && { effort: meta.effort }),
+          emit,
+          ...(use?.model && { model: use.model }),
+          ...(use?.effort && { effort: use.effort }),
         });
       })
       .catch((e: unknown): NodeOutcome => ({ ok: false, output: '', error: e instanceof Error ? e.message : String(e) }))
```

Change `extension/src/providers/copilot.ts`:

```diff
diff --git a/extension/src/providers/copilot.ts b/extension/src/providers/copilot.ts
--- a/extension/src/providers/copilot.ts
+++ b/extension/src/providers/copilot.ts
@@ -179,8 +179,9 @@ export function createCopilotProvider(d: CopilotDeps): AgentProvider {
     stepRequestCap: () => d.limits().maxRequestsPerStep,
 
     async runStep(ctx, gate): Promise<NodeOutcome> {
-      ctx.emit({ type: 'start', kind: 'agent', cwd: ctx.cwd, prompt: ctx.prompt });
       const picked = await pick(ctx.model);
+      // The model the step actually runs on (Auto for one that is gone). Copilot has no effort levels, so ctx.effort is never sent (step model spec §6).
+      ctx.emit({ type: 'start', kind: 'agent', cwd: ctx.cwd, prompt: ctx.prompt, ...('model' in picked && { model: picked.model.id }) });
       if ('error' in picked) return { ok: false, output: '', error: picked.error };
       if (picked.note) ctx.emit({ type: 'text', text: picked.note });
       const cap = d.limits().maxRequestsPerStep;
```

- [ ] **Step 4: Run the tests and typecheck**

Run: `npm test -w engine -- test/stepModelRun.test.ts test/claudeRunStep.test.ts test/codexRunStep.test.ts && npm test -w extension -- test/copilot.test.ts`
Expected: PASS.
Run: `npm run typecheck && npm test`
Expected: all workspaces pass (a test that times out only under heavy machine load is not a failure of this task: run it again).

- [ ] **Step 5: Commit**

```bash
git add engine/src/app.ts engine/src/executors.ts engine/src/providers/claude/runStep.ts engine/src/providers/codex/runStep.ts engine/src/runner.ts engine/test/claudeRunStep.test.ts engine/test/codexRunStep.test.ts engine/test/stepModelRun.test.ts extension/src/providers/copilot.ts extension/test/copilot.test.ts
git commit -m "feat: each agent step runs with its own model and effort" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 5: The run dialog's per-step lines and the Run Report

**Spec covered:** §3.3 (dialog lines and warnings, header unchanged, Run Report lines), §7 web dialog tests.

**Files:**
- Modify: `engine/src/app.ts`, `engine/src/runReport.ts`, `shared/src/stepModels.ts`, `shared/src/types.ts`, `web/src/components/RunConfirmDialog.tsx`, `web/src/styles.css`
- Test: `engine/test/stepModelReport.test.ts` (new), `shared/test/stepModelLines.test.ts` (new), `web/test/RunConfirmDialog.test.ts`

**Interfaces:**
- Consumes: Tasks 3–4.
- Produces: `PreviewStep.modelLine?`, `PreviewStep.modelNote?`; `withStepModelLines(steps, graph, run, known): PreviewStep[]` in `shared/src/stepModels.ts`; the App's `previewRun` handler fills them; `buildRunReport` writes each agent step's line.

- [ ] **Step 1: Write the failing tests**

Create `engine/test/stepModelReport.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { EffortLevel, Graph, ModelChoice, RunMeta, ServerMessage } from '@agent-stream/shared';
import { createApp } from '../src/app';
import { buildRunReport } from '../src/runReport';
import { appTestDeps, signedIn, testGitBash, testProvider, tmpProject, tmpValuesFile } from './helpers';

const all: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const MODELS: ModelChoice[] = [
  { value: 'sonnet', label: 'Sonnet', efforts: all },
  { value: 'opus', label: 'Opus', efforts: all },
];

describe('the run dialog: each step’s model', () => {
  it('sends a line for a step whose own model differs, and its note as a warning, never a problem', async () => {
    const provider = testProvider({ knownModels: () => MODELS, listModels: async () => MODELS });
    const paths = tmpProject();
    const app = createApp({ ...appTestDeps(), projectDir: paths.root, valuesFile: tmpValuesFile(), provider, status: signedIn, maxParallel: 1, gitBash: testGitBash, modelDefaults: () => ({ model: 'sonnet' }) });
    const graphId = app.graphStore.create('G').id;
    app.graphStore.apply(graphId, { type: 'addNode', node: { id: 'n1', title: 'own', kind: 'agent', prompt: 'p', model: { provider: 'claude', id: 'opus' }, effort: 'high' } }, 'user');
    app.graphStore.apply(graphId, { type: 'addNode', node: { id: 'n2', title: 'gone', kind: 'agent', prompt: 'p', model: { provider: 'claude', id: 'claude-opus-4-1' } } }, 'user');
    const msgs: ServerMessage[] = [];
    const client = { send: (m: ServerMessage) => void msgs.push(m) };
    await app.handle(client, { type: 'previewRun', graphId });
    const preview = msgs.filter((m) => m.type === 'runPreview').at(-1)!.preview;
    expect(preview.problems).toEqual([]);
    expect(preview.model).toEqual({ value: 'sonnet', label: 'Sonnet' });
    expect(preview.steps).toEqual([
      expect.objectContaining({ id: 'n1', modelLine: 'Model: Opus · Effort: high' }),
      expect.objectContaining({ id: 'n2', modelNote: "claude-opus-4-1 isn't offered by Claude any more (or on this plan), so this step uses the default model." }),
    ]);
    expect(preview.steps[1]).not.toHaveProperty('modelLine');
  });
});

describe('Run Report: each step’s model and effort', () => {
  const node = (id: string, kind: 'agent' | 'command'): Graph['nodes'][number] => ({ id, title: id, kind, ...(kind === 'agent' ? { prompt: 'p' } : { command: 'ls' }), createdBy: 'user', updatedBy: 'user', updatedAt: 't' });
  const snapshot: Graph = { id: 'g', name: 'G', goal: '', instructions: '', variables: [], nodes: [node('n1', 'agent'), node('n2', 'agent'), node('n3', 'command')], edges: [], nodeSeq: 3, updatedAt: 't' };
  const base: RunMeta = { id: 'r1', graphId: 'g', status: 'succeeded', startedAt: 't0', endedAt: 't1', snapshot, nodes: { n1: { status: 'succeeded' }, n2: { status: 'succeeded' }, n3: { status: 'succeeded' } }, provider: 'claude', model: 'sonnet' };
  const report = (run: RunMeta) => buildRunReport({ graphName: 'G', run, steps: {}, now: 't2' });

  it('writes a line under each agent step’s heading, with its note, and none for command steps', () => {
    const md = report({ ...base, stepModels: { n1: { model: 'claude-opus-4-6', effort: 'max' }, n2: { model: 'sonnet', note: 'This step is set to an OpenAI Codex model (gpt-6-astra); this run uses Claude, so it uses the default model.' } } });
    expect(md).toContain('### n1 · n1 — Succeeded\n\nModel: claude-opus-4-6 · Effort: max\n');
    expect(md).toContain('### n2 · n2 — Succeeded\n\nModel: sonnet · Effort: Default\n\n_Note:_ This step is set to an OpenAI Codex model (gpt-6-astra); this run uses Claude, so it uses the default model.\n');
    expect(md).toContain('### n3 · n3 — Succeeded\n\n**Command**');
    // The run-level lines are unchanged.
    expect(md).toContain('- Model: sonnet\n- Effort: Default\n');
  });

  it('says not supported for Copilot, and writes no line for a run from before step models', () => {
    expect(report({ ...base, provider: 'copilot', stepModels: { n1: { model: 'auto' } } })).toContain('Model: auto · Effort: not supported');
    expect(report(base)).not.toContain('Model: sonnet · Effort');
  });
});
```

Create `shared/test/stepModelLines.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { emptyGraph } from '../src/graph';
import { withStepModelLines } from '../src/stepModels';
import type { EffortLevel, Graph, GraphNode, ModelChoice, PreviewStep } from '../src/types';

const all: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const CLAUDE: ModelChoice[] = [
  { value: 'sonnet', label: 'Sonnet', efforts: all },
  { value: 'opus', label: 'Opus', efforts: all },
  { value: 'haiku', label: 'Haiku', efforts: [] },
];
const node = (id: string, over: Partial<GraphNode> = {}): GraphNode => ({ id, title: id, kind: 'agent', prompt: 'p', createdBy: 'user', updatedBy: 'user', updatedAt: 't', ...over });
const step = (id: string, over: Partial<PreviewStep> = {}): PreviewStep => ({ id, title: id, kind: 'agent', text: 'p', reused: false, ...over });

describe('withStepModelLines (spec §3.3)', () => {
  const graph: Graph = {
    ...emptyGraph('g', 'G', 't'),
    nodes: [
      node('n1', { model: { provider: 'claude', id: 'opus' }, effort: 'max' }),
      node('n2', { effort: 'high' }),
      node('n3'),
      node('n4', { model: { provider: 'codex', id: 'gpt-6-astra' } }),
      node('n5', { model: { provider: 'claude', id: 'opus' } }),
      node('n6', { kind: 'command', prompt: undefined, command: 'ls' }),
    ],
  };
  const steps = [step('n1'), step('n2'), step('n3'), step('n4'), step('n5', { reused: true }), step('n6', { kind: 'command', text: 'ls' })];

  it('gives a line to each step that differs from the run, with display names, and a warning to each note', () => {
    const out = withStepModelLines(steps, graph, { provider: 'claude', model: 'sonnet', effort: 'high' }, CLAUDE);
    expect(out[0]).toMatchObject({ modelLine: 'Model: Opus · Effort: max' });
    // Its own effort equals the run's: nothing differs, so no line.
    expect(out[1]).not.toHaveProperty('modelLine');
    expect(out[2]).toEqual(steps[2]);
    expect(out[3]).toEqual({
      ...steps[3],
      modelNote: 'This step is set to an OpenAI Codex model (gpt-6-astra); this run uses Claude, so it uses the default model.',
    });
    // A reused step and a command step run no model.
    expect(out[4]).toEqual(steps[4]);
    expect(out[5]).toEqual(steps[5]);
  });

  it('names an unlisted model by its id, Default for none, and says Copilot has no effort', () => {
    const own: Graph = { ...graph, nodes: [node('n1', { model: { provider: 'claude', id: 'claude-fable-5' } }), node('n2', { effort: 'low' })] };
    const out = withStepModelLines([step('n1'), step('n2')], own, { provider: 'claude' }, undefined);
    expect(out.map((s) => s.modelLine)).toEqual(['Model: claude-fable-5 · Effort: Default', 'Model: Default · Effort: low']);
    const copilot: Graph = { ...graph, nodes: [node('n1', { model: { provider: 'copilot', id: 'gpt-5.6-sol' } })] };
    const listed: ModelChoice[] = [{ value: 'auto', label: 'Auto', efforts: [] }, { value: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', efforts: [] }];
    expect(withStepModelLines([step('n1')], copilot, { provider: 'copilot' }, listed)[0].modelLine).toBe('Model: GPT-5.6 Sol · Effort: not supported');
  });
});
```

Change `web/test/RunConfirmDialog.test.ts`:

```diff
diff --git a/web/test/RunConfirmDialog.test.ts b/web/test/RunConfirmDialog.test.ts
--- a/web/test/RunConfirmDialog.test.ts
+++ b/web/test/RunConfirmDialog.test.ts
@@ -257,3 +257,22 @@ describe('RunConfirmDialog and the checkout', () => {
     expect(send).not.toHaveBeenCalled();
   });
 });
+
+describe('RunConfirmDialog: each step’s model', () => {
+  it('shows a step’s model line and its warning under its prompt, and still lets the run start', async () => {
+    await act(async () => dispatch({ kind: 'openConfirm', request: {} }));
+    const steps = [
+      { id: 'n2', title: 'Check', kind: 'agent' as const, text: 'Compare.', reused: false, modelLine: 'Model: Opus · Effort: high' },
+      { id: 'n3', title: 'Other', kind: 'agent' as const, text: 'Sum up.', reused: false, modelNote: 'This step is set to an OpenAI Codex model (gpt-6-astra); this run uses Claude, so it uses the default model.' },
+    ];
+    await act(async () => dispatch({ kind: 'server', msg: { type: 'runPreview', preview: preview({ steps, model: { value: 'sonnet', label: 'Sonnet' } }), requestId: lastRequestId() } }));
+    const prompts = container.querySelector('.agent-prompts')!;
+    const [first, second] = [...prompts.children];
+    expect(first.querySelector('details + .step-model-line')?.textContent).toBe('Model: Opus · Effort: high');
+    expect(second.querySelector('.step-model-line')).toBeNull();
+    expect(second.querySelector('.approval-warning')?.textContent).toBe('⚠ This step is set to an OpenAI Codex model (gpt-6-astra); this run uses Claude, so it uses the default model.');
+    // The header line still shows the run-wide values.
+    expect(container.querySelector('.model-line')?.textContent).toBe('Model: Sonnet · Effort: Default');
+    expect(button('Start run').disabled).toBe(false);
+  });
+});
```

- [ ] **Step 2: Run the tests and see them fail**

Run: `npm test -w shared -- test/stepModelLines.test.ts && npm test -w engine -- test/stepModelReport.test.ts && npm test -w web -- test/RunConfirmDialog.test.ts`
Expected: FAIL — the new modules, exports or behaviour do not exist yet (import errors or assertion failures).

- [ ] **Step 3: Implement**

Change `engine/src/app.ts`:

```diff
diff --git a/engine/src/app.ts b/engine/src/app.ts
--- a/engine/src/app.ts
+++ b/engine/src/app.ts
@@ -32,6 +32,7 @@ import {
   type SessionResult,
   type SessionTab,
   supportsEffort,
+  withStepModelLines,
 } from '@agent-stream/shared';
 import { ApprovalBroker } from './approvals';
 import { systemClock, type Clock } from './clock';
@@ -636,7 +637,9 @@ export function createApp(d: AppDeps) {
         const cap = provider.stepRequestCap?.();
         // Copilot ignores effort, so a configured level isn't previewed as if it applied.
         const shownEffort = supportsEffort(provider.id) ? effort : undefined;
-        const shown = { ...p.outcome.preview, provider: provider.id, ...(shownModel && { model: shownModel }), ...(shownEffort && { effort: shownEffort }), ...(cap !== undefined && { copilotRequestsPerStep: cap }) };
+        // Each agent step's own model and effort, as the run would resolve them now (step model spec §3.3).
+        const steps = withStepModelLines(p.outcome.preview.steps, r.graph, { provider: provider.id, model, effort }, knownModels());
+        const shown = { ...p.outcome.preview, steps, provider: provider.id, ...(shownModel && { model: shownModel }), ...(shownEffort && { effort: shownEffort }), ...(cap !== undefined && { copilotRequestsPerStep: cap }) };
         client.send({ type: 'runPreview', preview: shown, ...(msg.requestId !== undefined && { requestId: msg.requestId }) });
         return;
       }
```

Change `engine/src/runReport.ts`:

```diff
diff --git a/engine/src/runReport.ts b/engine/src/runReport.ts
--- a/engine/src/runReport.ts
+++ b/engine/src/runReport.ts
@@ -1,4 +1,4 @@
-import { fenceFor, fmtDuration, longestRun, PROVIDER_NAMES, statusLabel, supportsEffort, topoOrder, type GraphNode, type NodeEvent, type NodeRunState, type NodeUsage, type RunMeta } from '@agent-stream/shared';
+import { fenceFor, fmtDuration, longestRun, modelLine, PROVIDER_NAMES, statusLabel, supportsEffort, topoOrder, type GraphNode, type NodeEvent, type NodeRunState, type NodeUsage, type RunMeta } from '@agent-stream/shared';
 
 /** One step's records: its events in the order they happened, its output text and where the full output is kept. */
 export type RunReportStep = { events: NodeEvent[]; output?: string; outputPath?: string };
@@ -171,6 +171,9 @@ function stepSection(run: RunMeta, n: GraphNode, step: RunReportStep | undefined
   const duration = durationOf(state);
   const out: string[] = [`### ${n.id} · ${inline(n.title)} — ${statusLabel(state.status)}${duration ? `, ${duration}` : ''}`];
   const block = (lines: string[]) => lines.length && out.push('', ...lines);
+  // The model and effort the step ran with, resolved when the run started (step model spec §3.3); runs from before have none.
+  const use = n.kind === 'agent' ? run.stepModels?.[n.id] : undefined;
+  if (use) block([inline(modelLine({ model: use.model, effort: use.effort, provider: run.provider })), ...(use.note?.trim() ? ['', `_Note:_ ${inline(use.note)}`] : [])]);
   // After a label on the same line, so line-start markup in it (an agent can write descriptions) stays text.
   if (n.description?.trim()) block([`_Description:_ ${inline(n.description)}`]);
   // As it ran: the rendered text, which has the variable values filled in.
```

Change `shared/src/stepModels.ts`:

```diff
diff --git a/shared/src/stepModels.ts b/shared/src/stepModels.ts
--- a/shared/src/stepModels.ts
+++ b/shared/src/stepModels.ts
@@ -1,6 +1,6 @@
-import { isEffortLevel, supportsEffort } from './format';
+import { isEffortLevel, modelLine, supportsEffort } from './format';
 import { CLI_DEFAULT_MODEL, findModel } from './models';
-import { PROVIDER_IDS, PROVIDER_NAMES, type EffortLevel, type Graph, type ModelChoice, type ProviderId, type RunMeta, type StepModel, type StepModelUse } from './types';
+import { PROVIDER_IDS, PROVIDER_NAMES, type EffortLevel, type Graph, type ModelChoice, type PreviewStep, type ProviderId, type RunMeta, type StepModel, type StepModelUse } from './types';
 
 /** The longest model id a step can store. */
 export const MAX_MODEL_ID_CHARS = 200;
@@ -115,3 +115,24 @@ export function runStepModels(graph: Graph, run: RunModels, known: readonly Mode
   }
   return out;
 }
+
+/**
+ * The run dialog's per-step lines (spec §3.3): an agent step that will run with its own model or effort gets
+ * `Model: <label> · Effort: <label>` when that differs from the run's, and its note as a warning. Labels are the list's
+ * display names; a reused step runs nothing, so it gets no line.
+ */
+export function withStepModelLines(steps: readonly PreviewStep[], graph: Graph, run: RunModels, known: readonly ModelChoice[] | undefined): PreviewStep[] {
+  const base = resolveStepModel({}, run, known);
+  return steps.map((s) => {
+    const n = graph.nodes.find((x) => x.id === s.id);
+    if (!n || n.kind !== 'agent' || s.reused || (!n.model && !n.effort)) return s;
+    const use = resolveStepModel(n, run, known);
+    const differs = use.model !== base.model || use.effort !== base.effort;
+    const label = use.model ? findModel(listed(known), use.model)?.label : undefined;
+    return {
+      ...s,
+      ...(differs && { modelLine: modelLine({ model: use.model, label, effort: use.effort, provider: run.provider }) }),
+      ...(use.note && { modelNote: use.note }),
+    };
+  });
+}
```

Change `shared/src/types.ts`:

```diff
diff --git a/shared/src/types.ts b/shared/src/types.ts
--- a/shared/src/types.ts
+++ b/shared/src/types.ts
@@ -156,7 +156,11 @@ export type NodeRunState = {
 export type RenderedRun = { goal: string; instructions: string; nodes: Record<string, string> };
 
 /** `text` is the command or prompt as it will run; it is absent while the step can't be filled in (a variable it uses has no value, or it has a problem). */
-export type PreviewStep = { id: string; title: string; kind: NodeKind; description?: string; text?: string; reused: boolean };
+/**
+ * `modelLine`: `Model: … · Effort: …` for an agent step whose own model or effort makes it differ from the run's;
+ * `modelNote`: why it doesn't run its own (step model spec §3.3). Both are shown, neither blocks the run.
+ */
+export type PreviewStep = { id: string; title: string; kind: NodeKind; description?: string; text?: string; reused: boolean; modelLine?: string; modelNote?: string };
 
 /** The run confirmation dialog's contents, computed by the engine (spec §7.6). */
 export type RunPreview = {
```

Change `web/src/components/RunConfirmDialog.tsx`:

```diff
diff --git a/web/src/components/RunConfirmDialog.tsx b/web/src/components/RunConfirmDialog.tsx
--- a/web/src/components/RunConfirmDialog.tsx
+++ b/web/src/components/RunConfirmDialog.tsx
@@ -136,13 +136,18 @@ export function RunConfirmDialog() {
             {agents.length > 0 && (
               <div className="agent-prompts">
                 {agents.map((s) => (
-                  <details key={s.id}>
-                    <summary>
-                      {s.id} · {s.title}
-                    </summary>
-                    <StepBrief text={s.description} />
-                    <StepText text={s.text} />
-                  </details>
+                  <div key={s.id}>
+                    <details>
+                      <summary>
+                        {s.id} · {s.title}
+                      </summary>
+                      <StepBrief text={s.description} />
+                      <StepText text={s.text} />
+                    </details>
+                    {/* The step's own model and effort, under its prompt; a note never blocks the run. */}
+                    {s.modelLine && <p className="step-model-line">{s.modelLine}</p>}
+                    {s.modelNote && <p className="approval-warning">⚠ {s.modelNote}</p>}
+                  </div>
                 ))}
               </div>
             )}
```

Change `web/src/styles.css`:

```diff
diff --git a/web/src/styles.css b/web/src/styles.css
--- a/web/src/styles.css
+++ b/web/src/styles.css
@@ -189,6 +189,7 @@ pre { background: var(--code-bg); padding: 8px; border-radius: 6px; white-space:
 
 .checkout-chip { margin-left: 8px; padding: 1px 6px; border: 1px solid var(--border); border-radius: 10px; color: var(--muted); font-size: 12px; white-space: nowrap; }
 .checkout-line, .model-line, .cap-line { color: var(--muted); }
+.step-model-line { margin: 0 0 4px 16px; color: var(--muted); }
 .run-note { color: var(--info); }
 .static-note { margin: 0; color: var(--muted); }
 .read-badge { padding: 0 4px; border: 1px solid var(--border); border-radius: 8px; color: var(--muted); }
```

- [ ] **Step 4: Run the tests and typecheck**

Run: `npm test -w shared -- test/stepModelLines.test.ts && npm test -w engine -- test/stepModelReport.test.ts && npm test -w web -- test/RunConfirmDialog.test.ts`
Expected: PASS.
Run: `npm run typecheck && npm test`
Expected: all workspaces pass (a test that times out only under heavy machine load is not a failure of this task: run it again).

- [ ] **Step 5: Commit**

```bash
git add engine/src/app.ts engine/src/runReport.ts engine/test/stepModelReport.test.ts shared/src/stepModels.ts shared/src/types.ts shared/test/stepModelLines.test.ts web/src/components/RunConfirmDialog.tsx web/src/styles.css web/test/RunConfirmDialog.test.ts
git commit -m "feat: run dialog and run report show each step's model and effort" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 6: The planner: model and effort in its tools, list_models, PLANNER_APPEND

**Spec covered:** §5, §7 planner tests.

**Files:**
- Modify: `engine/src/planner.ts`, `engine/src/plannerTools.ts`
- Test: `engine/test/stepModelPlanner.test.ts` (new), `engine/test/planner.test.ts`, `engine/test/plannerTools.test.ts`

**Interfaces:**
- Consumes: Task 1's `parseStepModel`.
- Produces: `PlannerToolDeps.models?: () => Promise<{ provider: ProviderId; models: ModelChoice[] }>`; `NO_MODEL_LIST`; the `list_models` tool (after `get_graph`); `add_node`/`update_node` accept `model` and `effort` (`""` clears in `update_node`); `get_graph` shows them; the Planner passes the turn's provider's list.

- [ ] **Step 1: Write the failing tests**

Create `engine/test/stepModelPlanner.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import type { ModelChoice, ProviderId } from '@agent-stream/shared';
import { createApp } from '../src/app';
import { GraphStore } from '../src/graphStore';
import type { PlannerTurn } from '../src/providers/types';
import { PLANNER_APPEND } from '../src/planner';
import { graphTools, NO_MODEL_LIST } from '../src/plannerTools';
import { RunStore } from '../src/runStore';
import { appTestDeps, fixedClock, outsideGit, signedIn, testGitBash, testProvider, tmpProject, tmpValuesFile } from './helpers';

function setup(models?: () => Promise<{ provider: ProviderId; models: ModelChoice[] }>) {
  const paths = tmpProject();
  const graphStore = new GraphStore(paths, fixedClock());
  const graphId = graphStore.create('G').id;
  const tools = graphTools({ graphStore, runStore: new RunStore(paths), graphId, source: { kind: 'planner', sessionId: 's' }, checkout: outsideGit(paths.root), requestRun: () => null, ...(models && { models }) });
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await tools.find((t) => t.name === name)!.run(args);
    return { text: r.text, isError: r.isError === true };
  };
  return { graphStore, graphId, call };
}

describe('planner tools: a step’s model and effort (step model spec §5)', () => {
  it('add_node takes model "<provider>/<id>" and effort, and get_graph shows them', async () => {
    const s = setup();
    expect(await s.call('add_node', { kind: 'agent', title: 'Check', prompt: 'p', model: 'claude/haiku', effort: 'low' })).toEqual({ text: 'Added n1.', isError: false });
    expect(s.graphStore.get(s.graphId).nodes[0]).toMatchObject({ model: { provider: 'claude', id: 'haiku' }, effort: 'low' });
    const graph = JSON.parse((await s.call('get_graph')).text);
    expect(graph.nodes[0]).toMatchObject({ id: 'n1', model: 'claude/haiku', effort: 'low' });
    expect(s.graphStore.readOps(s.graphId)[0]).toMatchObject({ by: 'agent', source: { kind: 'planner', sessionId: 's' } });
  });

  it('refuses a bad model, a bad effort and either on a command step, changing nothing', async () => {
    const s = setup();
    expect(await s.call('add_node', { kind: 'agent', title: 'x', prompt: 'p', model: 'opus' })).toEqual({ text: 'model "opus": the provider must be claude, codex or copilot, as in claude/opus.', isError: true });
    expect((await s.call('add_node', { kind: 'agent', title: 'x', prompt: 'p', effort: 'turbo' })).isError).toBe(true);
    expect(await s.call('add_node', { kind: 'command', title: 'x', command: 'ls', effort: 'low' })).toEqual({ text: 'Only agent steps have a model or effort.', isError: true });
    expect(s.graphStore.get(s.graphId).nodes).toEqual([]);
  });

  it('update_node sets them, and "" puts each back on the run’s', async () => {
    const s = setup();
    await s.call('add_node', { kind: 'agent', title: 'Plan', prompt: 'p' });
    expect(await s.call('update_node', { id: 'n1', model: 'codex/gpt-6-astra', effort: 'ultra' })).toEqual({ text: 'Updated n1.', isError: false });
    expect(s.graphStore.get(s.graphId).nodes[0]).toMatchObject({ model: { provider: 'codex', id: 'gpt-6-astra' }, effort: 'ultra' });
    await s.call('update_node', { id: 'n1', model: '' });
    expect(s.graphStore.get(s.graphId).nodes[0]).not.toHaveProperty('model');
    expect(s.graphStore.get(s.graphId).nodes[0].effort).toBe('ultra');
    await s.call('update_node', { id: 'n1', effort: '' });
    expect(s.graphStore.get(s.graphId).nodes[0]).not.toHaveProperty('effort');
    expect((await s.call('update_node', { id: 'n1', model: 'claude/two words' })).isError).toBe(true);
  });

  it('list_models returns the current provider’s models with their levels and the default', async () => {
    const models: ModelChoice[] = [
      { value: 'default', label: 'Default (recommended)', efforts: ['low', 'high'] },
      { value: 'haiku', label: 'Haiku', efforts: [] },
    ];
    const s = setup(async () => ({ provider: 'claude', models }));
    expect(JSON.parse((await s.call('list_models')).text)).toEqual({
      provider: 'claude',
      models: [
        { id: 'default', name: 'Default (recommended)', efforts: ['low', 'high'], default: true },
        { id: 'haiku', name: 'Haiku', efforts: [] },
      ],
    });
    const codex = setup(async () => ({ provider: 'codex', models: [{ value: 'gpt-6.1-sol', label: 'GPT-6.1-Sol', efforts: ['low'], isDefault: true }] }));
    expect(JSON.parse((await codex.call('list_models')).text).models).toEqual([{ id: 'gpt-6.1-sol', name: 'GPT-6.1-Sol', efforts: ['low'], default: true }]);
  });

  it('list_models says so when there is no list', async () => {
    expect(await setup(async () => ({ provider: 'copilot', models: [] })).call('list_models')).toEqual({ text: NO_MODEL_LIST, isError: false });
    expect(await setup(async () => Promise.reject(new Error('down'))).call('list_models')).toEqual({ text: NO_MODEL_LIST, isError: false });
    expect(await setup().call('list_models')).toEqual({ text: NO_MODEL_LIST, isError: false });
  });

  it('PLANNER_APPEND tells the planner when to set them and how to compare models', () => {
    expect(PLANNER_APPEND).toContain(
      '- Each agent step can have its own model and effort (add_node/update_node: model "<provider>/<id>", effort). Leave them on Default unless the user asks, or a step is clearly simple (checks, summaries — a small model or low effort) or clearly hard. Use only models list_models returns for the current provider.',
    );
    expect(PLANNER_APPEND).toContain(
      '- To compare models, add one step per model/effort with the same prompt; let them run in parallel (read-only, or each in its own workspace when they write), then a read-only compare step that reports quality, time and tokens from their outputs.',
    );
  });
});

describe('the planner’s list_models', () => {
  it('lists the models of the provider the turn runs on', async () => {
    const models: ModelChoice[] = [{ value: 'auto', label: 'Auto', efforts: [] }];
    let reply = '';
    const provider = testProvider({
      id: 'copilot',
      name: 'GitHub Copilot',
      listModels: async () => models,
      planTurn: async (t: PlannerTurn) => {
        reply = (await t.tools.find((x) => x.name === 'list_models')!.run({})).text;
        return { ok: true };
      },
    });
    const paths = tmpProject();
    const app = createApp({ ...appTestDeps(), projectDir: paths.root, valuesFile: tmpValuesFile(), provider, status: signedIn, maxParallel: 1, gitBash: testGitBash });
    const graphId = app.graphStore.create('G').id;
    await app.handle({ send: () => {} }, { type: 'chat', graphId, sessionId: 'default', text: 'Which models?' });
    await vi.waitFor(() => expect(reply).not.toBe(''), { timeout: 5000 });
    expect(JSON.parse(reply)).toEqual({ provider: 'copilot', models: [{ id: 'auto', name: 'Auto', efforts: [] }] });
  });
});
```

Change `engine/test/planner.test.ts` (named exception: the tool list gains list_models):

```diff
diff --git a/engine/test/planner.test.ts b/engine/test/planner.test.ts
--- a/engine/test/planner.test.ts
+++ b/engine/test/planner.test.ts
@@ -111,7 +111,7 @@ describe('Planner', () => {
     expect(t).toMatchObject({ prompt: 'Plan a parity test', systemAppend: PLANNER_APPEND, cwd: s.paths.root });
     expect(t.resume).toBeUndefined();
     expect(t.tools.map((x) => x.name)).toEqual([
-      'get_graph', 'add_node', 'update_node', 'delete_node', 'connect', 'disconnect', 'set_goal', 'set_instructions', 'set_variable', 'delete_variable', 'request_run', 'get_run', 'checkout_info', 'check_tickets',
+      'get_graph', 'list_models', 'add_node', 'update_node', 'delete_node', 'connect', 'disconnect', 'set_goal', 'set_instructions', 'set_variable', 'delete_variable', 'request_run', 'get_run', 'checkout_info', 'check_tickets',
     ]);
     expect(s.chat().map((e) => [e.role, e.text])).toEqual([
       ['user', 'Plan a parity test'],
```

Change `engine/test/plannerTools.test.ts` (named exception: the tool list gains list_models):

```diff
diff --git a/engine/test/plannerTools.test.ts b/engine/test/plannerTools.test.ts
--- a/engine/test/plannerTools.test.ts
+++ b/engine/test/plannerTools.test.ts
@@ -36,7 +36,7 @@ function setup(checkout?: CheckoutSource) {
 describe('planner graph tools', () => {
   it('exposes the documented tools', () => {
     expect(setup().tools.map((t) => t.name)).toEqual([
-      'get_graph', 'add_node', 'update_node', 'delete_node', 'connect', 'disconnect', 'set_goal', 'set_instructions', 'set_variable', 'delete_variable', 'request_run', 'get_run', 'checkout_info', 'check_tickets',
+      'get_graph', 'list_models', 'add_node', 'update_node', 'delete_node', 'connect', 'disconnect', 'set_goal', 'set_instructions', 'set_variable', 'delete_variable', 'request_run', 'get_run', 'checkout_info', 'check_tickets',
     ]);
   });
 
```

- [ ] **Step 2: Run the tests and see them fail**

Run: `npm test -w engine -- test/stepModelPlanner.test.ts test/plannerTools.test.ts test/planner.test.ts`
Expected: FAIL — the new modules, exports or behaviour do not exist yet (import errors or assertion failures).

- [ ] **Step 3: Implement**

Change `engine/src/planner.ts`:

```diff
diff --git a/engine/src/planner.ts b/engine/src/planner.ts
--- a/engine/src/planner.ts
+++ b/engine/src/planner.ts
@@ -28,6 +28,8 @@ How to work:
 - Run steps in parallel (no edges between them) only when none of that applies: each starts from its own state and doesn't touch what the others read or change. When unsure, run them in sequence and say why in one chat line.
 - Test plans are often stateful sequences, for example create → update → delete; migrate → verify; deploy → smoke test; table absent → first run → new row → changed row.
 - Mark steps that only read, query or compare as read-only (access: read). That only lets them run alongside file-changing steps in the same workspace; edges still decide their order.
+- Each agent step can have its own model and effort (add_node/update_node: model "<provider>/<id>", effort). Leave them on Default unless the user asks, or a step is clearly simple (checks, summaries — a small model or low effort) or clearly hard. Use only models list_models returns for the current provider.
+- To compare models, add one step per model/effort with the same prompt; let them run in parallel (read-only, or each in its own workspace when they write), then a read-only compare step that reports quality, time and tokens from their outputs.
 - If the project doesn't contain what the user names (for example no such model yet), still build the full graph of steps that would run: add a first step that locates or creates it, and say in one chat line what is missing. Something missing never turns the plan into steps that only write documents.
 - The goal and the instructions (set_instructions) are given to every agent step. Put shared guidance there (targets, conventions, what never to touch) instead of repeating it in each step.
 - Use the read-only tools (Read, Glob, Grep) to ground the plan in the actual project.
@@ -213,6 +215,7 @@ export class Planner extends EventEmitter {
         source: { kind: 'planner', sessionId },
         requestRun: (fromNodeId) => this.d.requestRun(graphId, fromNodeId),
         checkout: this.d.checkout,
+        models: async () => ({ provider: provider.id, models: (await provider.listModels?.()) ?? [] }),
       });
       const r = await provider.planTurn({
         // Only a resumed conversation has a last turn to compare with; a fresh one starts from get_graph.
```

Change `engine/src/plannerTools.ts`:

```diff
diff --git a/engine/src/plannerTools.ts b/engine/src/plannerTools.ts
--- a/engine/src/plannerTools.ts
+++ b/engine/src/plannerTools.ts
@@ -1,5 +1,5 @@
 import { z, type ZodRawShape } from 'zod';
-import type { ChangeSource, CheckoutInfo, Graph, LeaseHolder, Op } from '@agent-stream/shared';
+import { CLI_DEFAULT_MODEL, EFFORT_LEVELS, parseStepModel, stepModelText, type ChangeSource, type CheckoutInfo, type EffortLevel, type Graph, type LeaseHolder, type ModelChoice, type NodePatch, type Op, type ProviderId, type StepModel } from '@agent-stream/shared';
 import type { GraphStore } from './graphStore';
 import { truncateHead, truncateTail } from './prompt';
 import { ALL_HAVE_WORKTREES_ADVICE, MISSING_WORKTREES_ADVICE, OUTSIDE_GIT_ADVICE } from './policy';
@@ -20,6 +20,8 @@ export type PlannerToolDeps = {
   requestRun: (fromNodeId?: string) => string | null;
   /** checkout_info and check_tickets read it. */
   checkout: CheckoutSource;
+  /** list_models reads it: the current provider and its models ([] when they can't be listed). */
+  models?: () => Promise<{ provider: ProviderId; models: ModelChoice[] }>;
 };
 
 export const reply = (text: string, isError = false): ToolReply => (isError ? { text, isError: true } : { text });
@@ -40,17 +42,30 @@ export function defineTool<S extends ZodRawShape>(name: string, description: str
 
 const kind = z.enum(['agent', 'command']);
 const access = z.enum(['read', 'write']);
+const effort = z.enum(EFFORT_LEVELS);
 const RUN_EXCERPT_CHARS = 2000;
+/** list_models when the provider can't list its models. */
+export const NO_MODEL_LIST = "The current provider's models can't be listed right now; leave model on Default.";
+
+/** The planner's `model` text ("" = Default) as a step model, or why it can't be one (step model spec §5). */
+function modelArg(text: string | undefined): { ok: true; model?: StepModel | null } | { ok: false; error: string } {
+  if (text === undefined) return { ok: true };
+  if (text === '') return { ok: true, model: null };
+  const r = parseStepModel(text);
+  return r.ok ? { ok: true, model: r.model } : r;
+}
 
 export function summarizeGraph(graph: Graph) {
   return {
     goal: graph.goal,
     instructions: graph.instructions,
     variables: graph.variables.map(({ name, description }) => ({ name, description })),
-    nodes: graph.nodes.map(({ id, title, kind: k, description, prompt, command, timeoutSec, access: a, workspace, createdBy, updatedBy }) => ({
+    nodes: graph.nodes.map(({ id, title, kind: k, description, prompt, command, timeoutSec, access: a, workspace, model, effort: e, createdBy, updatedBy }) => ({
       id, title, kind: k, description, prompt, command, timeoutSec,
       ...(a === 'read' && { access: 'read' as const }),
       ...(workspace && { workspace }),
+      ...(model && { model: stepModelText(model) }),
+      ...(e && { effort: e }),
       createdBy, updatedBy,
     })),
     edges: graph.edges.map((e) => `${e.from} -> ${e.to}`),
@@ -63,12 +78,24 @@ export function graphTools(d: PlannerToolDeps): GraphTool[] {
   const outcome = (r: { ok: true } | { ok: false; error: string }, success: string) => (r.ok ? reply(success) : reply(r.error, true));
 
   return [
-    defineTool('get_graph', 'Return the current workflow graph: goal, nodes (id, title, kind, prompt or command) and edges.', {}, async () =>
+    defineTool('get_graph', 'Return the current workflow graph: goal, nodes (id, title, kind, prompt or command, and an agent step\'s own model and effort) and edges.', {}, async () =>
       reply(JSON.stringify(summarizeGraph(d.graphStore.get(d.graphId)), null, 2)),
     ),
+    defineTool(
+      'list_models',
+      'Read-only. List the current provider\'s models as JSON: each model\'s id, name, effort levels, and which one is the default. Give a step one of them as model "<provider>/<id>" in add_node or update_node.',
+      {},
+      async () => {
+        const listed = await d.models?.().catch(() => undefined);
+        if (!listed || listed.models.length === 0) return reply(NO_MODEL_LIST);
+        const isDefault = (m: ModelChoice) => !!m.isDefault || (listed.provider === 'claude' && m.value === CLI_DEFAULT_MODEL);
+        const models = listed.models.map((m) => ({ id: m.value, name: m.label, efforts: m.efforts, ...(isDefault(m) && { default: true }) }));
+        return reply(JSON.stringify({ provider: listed.provider, models }, null, 2));
+      },
+    ),
     defineTool(
       'add_node',
-      'Add a step. kind "agent" runs a separate AI agent with `prompt`; kind "command" runs the exact shell `command` in the project root. `after` lists ids of steps this one depends on; an edge is created from each. `description` is one plain-language sentence for people saying what the step does and why. `access` "read" marks an agent step that only reads and reports: it can\'t edit files or run commands. Command steps can always change files. `workspace` names a variant workspace (lowercase letters, digits, - and _): steps with the same workspace run in their own Git worktree for each run, for A/B tests; leave it out for this checkout.',
+      'Add a step. kind "agent" runs a separate AI agent with `prompt`; kind "command" runs the exact shell `command` in the project root. `after` lists ids of steps this one depends on; an edge is created from each. `description` is one plain-language sentence for people saying what the step does and why. `access` "read" marks an agent step that only reads and reports: it can\'t edit files or run commands. Command steps can always change files. `workspace` names a variant workspace (lowercase letters, digits, - and _): steps with the same workspace run in their own Git worktree for each run, for A/B tests; leave it out for this checkout. `model` ("<provider>/<id>", an id from list_models) and `effort` give an agent step its own model and effort; leave them out for the run\'s.',
       {
         kind,
         title: z.string(),
@@ -79,9 +106,13 @@ export function graphTools(d: PlannerToolDeps): GraphTool[] {
         after: z.array(z.string()).optional(),
         access: access.optional(),
         workspace: z.string().optional(),
+        model: z.string().optional(),
+        effort: effort.optional(),
       },
       async (a) => {
-        const r = apply({ type: 'addNode', node: { title: a.title, kind: a.kind, description: a.description, prompt: a.prompt, command: a.command, timeoutSec: a.timeoutSec, access: a.access, workspace: a.workspace } });
+        const m = modelArg(a.model || undefined);
+        if (!m.ok) return reply(m.error, true);
+        const r = apply({ type: 'addNode', node: { title: a.title, kind: a.kind, description: a.description, prompt: a.prompt, command: a.command, timeoutSec: a.timeoutSec, access: a.access, workspace: a.workspace, ...(m.model && { model: m.model }), ...(a.effort && { effort: a.effort }) } });
         if (!r.ok) return reply(r.error, true);
         const id = r.graph.nodes[r.graph.nodes.length - 1].id;
         const errors: string[] = [];
@@ -94,7 +125,7 @@ export function graphTools(d: PlannerToolDeps): GraphTool[] {
     ),
     defineTool(
       'update_node',
-      'Change fields of a step. Only the fields you pass change. `description` is one plain-language sentence for people saying what the step does and why. `access` "read" or "write"; `workspace` "" puts the step back in this checkout.',
+      'Change fields of a step. Only the fields you pass change. `description` is one plain-language sentence for people saying what the step does and why. `access` "read" or "write"; `workspace` "" puts the step back in this checkout. `model` ("<provider>/<id>", an id from list_models) and `effort` set an agent step\'s own model and effort; "" puts either back on the run\'s.',
       {
         id: z.string(),
         title: z.string().optional(),
@@ -105,8 +136,15 @@ export function graphTools(d: PlannerToolDeps): GraphTool[] {
         timeoutSec: z.number().positive().optional(),
         access: access.optional(),
         workspace: z.string().optional(),
+        model: z.string().optional(),
+        effort: z.union([effort, z.literal('')]).optional(),
+      },
+      async ({ id, model, effort: e, ...rest }) => {
+        const m = modelArg(model);
+        if (!m.ok) return reply(m.error, true);
+        const patch: NodePatch = { ...rest, ...(m.model !== undefined && { model: m.model }), ...(e !== undefined && { effort: e === '' ? null : (e as EffortLevel) }) };
+        return outcome(apply({ type: 'updateNode', id, patch }), `Updated ${id}.`);
       },
-      async ({ id, ...patch }) => outcome(apply({ type: 'updateNode', id, patch }), `Updated ${id}.`),
     ),
     defineTool('delete_node', 'Delete a step and its edges.', { id: z.string() }, async ({ id }) =>
       outcome(apply({ type: 'deleteNode', id }), `Deleted ${id}.`),
```

- [ ] **Step 4: Run the tests and typecheck**

Run: `npm test -w engine -- test/stepModelPlanner.test.ts test/plannerTools.test.ts test/planner.test.ts`
Expected: PASS.
Run: `npm run typecheck && npm test`
Expected: all workspaces pass (a test that times out only under heavy machine load is not a failure of this task: run it again).

- [ ] **Step 5: Commit**

```bash
git add engine/src/planner.ts engine/src/plannerTools.ts engine/test/planner.test.ts engine/test/plannerTools.test.ts engine/test/stepModelPlanner.test.ts
git commit -m "feat(planner): step models and effort, and list_models" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 7: The Node panel's Model and Effort menus

**Spec covered:** §4.1, §7 web Node panel tests; graph tabs get the model list (R13).

**Files:**
- Create: `web/src/stepModelMenus.ts`
- Modify: `engine/src/app.ts`, `web/src/components/NodePanel.tsx`, `web/src/state.ts`, `web/src/styles.css`
- Test: `engine/test/graphTabModels.test.ts` (new), `web/test/NodePanelModel.test.ts` (new), `web/test/stepModelMenus.test.ts` (new)

**Interfaces:**
- Consumes: Tasks 1, 3.
- Produces: the engine sends `models` to a tab after `graphOpened` and on provider/settings changes; web `State.modelsProvider?: ProviderId`; `web/src/stepModelMenus.ts`: `modelMenu(provider, models, value): ModelMenu`, `effortsFor(...)`, `effortMenu(...)`, `DEFAULT_MODEL_OPTION`, `NOT_SUPPORTED`, `MenuOption`.

- [ ] **Step 1: Write the failing tests**

Create `engine/test/graphTabModels.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import type { ModelChoice, ModelSelection, ServerMessage } from '@agent-stream/shared';
import { createApp } from '../src/app';
import { appTestDeps, signedIn, testGitBash, testProvider, tmpProject, tmpValuesFile } from './helpers';

const MODELS: ModelChoice[] = [{ value: 'sonnet', label: 'Sonnet', efforts: ['low', 'high'] }];

describe('graph tabs get the provider’s models (step model spec §4.1)', () => {
  it('sends them after the graph opens, again when the provider or the settings change, and stops when the tab goes', async () => {
    const defaults: ModelSelection = {};
    const paths = tmpProject();
    const app = createApp({ ...appTestDeps(), projectDir: paths.root, valuesFile: tmpValuesFile(), provider: testProvider({ listModels: async () => MODELS }), status: signedIn, maxParallel: 1, gitBash: testGitBash, modelDefaults: () => defaults });
    const graphId = app.graphStore.create('G').id;
    const msgs: ServerMessage[] = [];
    const tab = { send: (m: ServerMessage) => void msgs.push(m) };
    const detach = app.connect(tab);
    const models = () => msgs.filter((m): m is Extract<ServerMessage, { type: 'models' }> => m.type === 'models');
    expect(models()).toEqual([]);
    await app.handle(tab, { type: 'openGraph', graphId });
    await vi.waitFor(() => expect(models()).toEqual([{ type: 'models', provider: 'claude', models: MODELS, defaultEfforts: [] }]), { timeout: 5000 });
    expect(msgs.findIndex((m) => m.type === 'graphOpened')).toBeLessThan(msgs.findIndex((m) => m.type === 'models'));
    defaults.model = 'sonnet';
    app.modelDefaultsChanged();
    await vi.waitFor(() => expect(models().at(-1)?.defaultEfforts).toEqual(['low', 'high']), { timeout: 5000 });
    app.setProvider(testProvider({ id: 'codex', name: 'OpenAI Codex', listModels: async () => [] }), signedIn);
    await vi.waitFor(() => expect(models().at(-1)).toEqual({ type: 'models', provider: 'codex', models: [], defaultEfforts: [] }), { timeout: 5000 });
    const count = models().length;
    detach();
    app.modelDefaultsChanged();
    await new Promise((r) => setTimeout(r, 10));
    expect(models()).toHaveLength(count);
  });
});
```

Create `web/test/NodePanelModel.test.ts`:

```ts
// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { emptyGraph, type EffortLevel, type Graph, type GraphNode, type ModelChoice, type ProviderId } from '@agent-stream/shared';

vi.mock('../src/bridge', () => ({ send: vi.fn(), sendHost: vi.fn(), post: vi.fn() }));
const { send } = await import('../src/bridge');
const { dispatch } = await import('../src/store');
const { NodePanel } = await import('../src/components/NodePanel');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const all: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const CLAUDE: ModelChoice[] = [
  { value: 'sonnet', label: 'Sonnet', efforts: all },
  { value: 'opus', label: 'Opus', efforts: all },
  { value: 'haiku', label: 'Haiku', efforts: [] },
  { value: 'claude-opus-4-6', label: 'Opus 4.6', efforts: ['low', 'medium', 'high', 'max'] },
];
const step: GraphNode = { id: 'n1', title: 'Plan', kind: 'agent', prompt: 'p', createdBy: 'user', updatedBy: 'user', updatedAt: 't' };

let root: Root | undefined;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
});

async function mount(node: Partial<GraphNode>, provider: ProviderId = 'claude', models: ModelChoice[] = CLAUDE, defaultEfforts: EffortLevel[] = all) {
  const graph: Graph = { ...emptyGraph('g', 'G', 't'), nodes: [{ ...step, ...node }] };
  dispatch({ kind: 'server', msg: { type: 'hello', status: { provider, ok: true, label: 'x' }, project: '/p', graphs: [], approvals: [] } });
  dispatch({ kind: 'server', msg: { type: 'graphOpened', changes: [], graph, runs: [], variableValues: {} } });
  dispatch({ kind: 'server', msg: { type: 'models', provider, models, defaultEfforts } });
  dispatch({ kind: 'selectNode', id: 'n1' });
  vi.mocked(send).mockClear();
  const el = document.createElement('div');
  root = createRoot(el);
  await act(async () => root!.render(createElement(NodePanel)));
  const select = (id: string) => el.querySelector(`select#${id}`) as HTMLSelectElement;
  const pick = async (id: string, value: string) =>
    act(async () => {
      select(id).value = value;
      select(id).dispatchEvent(new Event('change', { bubbles: true }));
    });
  const button = (label: string) => [...el.querySelectorAll('button')].find((b) => b.textContent === label) as HTMLButtonElement | undefined;
  const labels = (id: string) => [...select(id).options].map((o) => o.textContent);
  return { el, select, pick, button, labels };
}

describe('NodePanel: a step’s model and effort', () => {
  it('shows Model and Effort below Workspace, for agent steps only', async () => {
    const p = await mount({});
    const labels = [...p.el.querySelectorAll('.field label')].map((l) => l.textContent);
    expect(labels.slice(labels.indexOf('Workspace'), labels.indexOf('Workspace') + 3)).toEqual(['Workspace', 'Model', 'Effort']);
    expect(p.select('node-model').value).toBe('');
    expect(p.labels('node-model')).toEqual(["Default (the run's model)", 'Sonnet', 'Opus', 'Haiku', 'Opus 4.6']);
    expect(p.el.querySelector('optgroup')?.getAttribute('label')).toBe('Pinned versions');
    await act(async () => root!.unmount());
    root = undefined;
    const cmd = await mount({ kind: 'command', prompt: undefined, command: 'ls' });
    expect(cmd.select('node-model')).toBeNull();
    expect(cmd.select('node-effort')).toBeNull();
  });

  it('offers only the chosen model’s levels, drops a level the new model lacks, and saves both as one step edit', async () => {
    const p = await mount({ effort: 'xhigh' });
    await p.pick('node-model', 'claude/claude-opus-4-6');
    expect(p.select('node-effort').value).toBe('');
    expect(p.labels('node-effort')).toEqual(['Default', 'low', 'medium', 'high', 'max']);
    await p.pick('node-effort', 'max');
    await act(async () => p.button('Save')!.click());
    expect(vi.mocked(send).mock.calls).toEqual([[{ type: 'op', graphId: 'g', op: { type: 'updateNode', id: 'n1', patch: { model: { provider: 'claude', id: 'claude-opus-4-6' }, effort: 'max' } } }]]);
  });

  it('clears them with null when set back to Default', async () => {
    const p = await mount({ model: { provider: 'claude', id: 'opus' }, effort: 'high' });
    expect(p.select('node-model').value).toBe('claude/opus');
    await p.pick('node-model', '');
    await p.pick('node-effort', '');
    await act(async () => p.button('Save')!.click());
    expect(vi.mocked(send).mock.calls[0][0]).toEqual({ type: 'op', graphId: 'g', op: { type: 'updateNode', id: 'n1', patch: { model: null, effort: null } } });
  });

  it('shows another provider’s model disabled, with Use Default', async () => {
    const p = await mount({ model: { provider: 'codex', id: 'gpt-6-astra' } });
    const chosen = p.select('node-model').selectedOptions[0];
    expect(chosen.textContent).toBe('OpenAI Codex · gpt-6-astra (not the current provider)');
    expect(chosen.disabled).toBe(true);
    await act(async () => p.button('Use Default')!.click());
    expect(p.select('node-model').value).toBe('');
    expect(p.button('Use Default')).toBeUndefined();
  });

  it('shows a model the list doesn’t offer as not offered', async () => {
    const p = await mount({ model: { provider: 'claude', id: 'claude-opus-4-1' } });
    expect(p.select('node-model').selectedOptions[0].textContent).toBe('claude-opus-4-1 (not offered)');
  });

  it('reads Not supported, disabled, for a model with no levels and on Copilot', async () => {
    const haiku = await mount({ model: { provider: 'claude', id: 'haiku' } });
    expect(haiku.select('node-effort').disabled).toBe(true);
    expect(haiku.labels('node-effort')).toEqual(['Not supported']);
    await act(async () => root!.unmount());
    root = undefined;
    const copilot = await mount({ effort: 'high' }, 'copilot', [{ value: 'auto', label: 'Auto', efforts: [] }], []);
    expect(copilot.labels('node-model')).toEqual(["Default (the run's model)", 'Auto']);
    expect(copilot.select('node-effort').disabled).toBe(true);
    expect(copilot.labels('node-effort')).toEqual(['Not supported']);
    // A stored effort Copilot ignores can still be cleared.
    await act(async () => copilot.button('Use Default')!.click());
    await act(async () => copilot.button('Save')!.click());
    expect(vi.mocked(send).mock.calls[0][0]).toEqual({ type: 'op', graphId: 'g', op: { type: 'updateNode', id: 'n1', patch: { effort: null } } });
  });
});
```

Create `web/test/stepModelMenus.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { EffortLevel, ModelChoice } from '@agent-stream/shared';
import { DEFAULT_MODEL_OPTION, effortMenu, modelMenu, NOT_SUPPORTED } from '../src/stepModelMenus';

const all: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const CLAUDE: ModelChoice[] = [
  { value: 'default', label: 'Default (recommended)', efforts: all },
  { value: 'claude-opus-4-6', label: 'Opus 4.6', efforts: ['low', 'medium', 'high', 'max'] },
  { value: 'sonnet', label: 'Sonnet', efforts: all, resolved: 'claude-sonnet-5' },
  { value: 'opus', label: 'Opus', efforts: all },
  { value: 'haiku', label: 'Haiku', efforts: [] },
  { value: 'claude-opus-5', label: 'Opus 5', efforts: all },
];
const CODEX: ModelChoice[] = [
  { value: 'gpt-6.1-sol', label: 'GPT-6.1-Sol', efforts: [...all, 'ultra'], isDefault: true },
  { value: 'gpt-6-astra', label: 'GPT-6-Astra', efforts: [...all, 'ultra'] },
];
const COPILOT: ModelChoice[] = [{ value: 'auto', label: 'Auto', efforts: [] }, { value: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', efforts: [] }];

describe('a step’s Model menu (spec §4.1)', () => {
  it('Claude: Default, the aliases in the list’s order, then the pinned versions', () => {
    const menu = modelMenu('claude', CLAUDE, '');
    expect(menu.options.map((o) => o.label)).toEqual([DEFAULT_MODEL_OPTION, 'Default (recommended)', 'Sonnet', 'Opus', 'Haiku']);
    expect(menu.options.map((o) => o.value)).toEqual(['', 'claude/default', 'claude/sonnet', 'claude/opus', 'claude/haiku']);
    expect(menu.pinned).toEqual([
      { value: 'claude/claude-opus-4-6', label: 'Opus 4.6' },
      { value: 'claude/claude-opus-5', label: 'Opus 5' },
    ]);
    expect(menu.extra).toBeUndefined();
  });

  it('Codex and Copilot: the list’s order, no pinned group (Copilot’s Auto comes first in its list)', () => {
    expect(modelMenu('codex', CODEX, '').options.map((o) => o.value)).toEqual(['', 'codex/gpt-6.1-sol', 'codex/gpt-6-astra']);
    expect(modelMenu('copilot', COPILOT, '').options.map((o) => o.label)).toEqual([DEFAULT_MODEL_OPTION, 'Auto', 'GPT-5.6 Sol']);
    expect(modelMenu('codex', CODEX, '').pinned).toEqual([]);
  });

  it('another provider’s model shows disabled, with Use Default', () => {
    const menu = modelMenu('claude', CLAUDE, 'codex/gpt-6-astra');
    expect(menu.extra).toEqual({ value: 'codex/gpt-6-astra', label: 'OpenAI Codex · gpt-6-astra (not the current provider)', disabled: true });
    expect(menu.otherProvider).toBe(true);
  });

  it('a model the known list doesn’t contain shows as not offered; a full id an alias stands for, or any id without a list, as itself', () => {
    expect(modelMenu('claude', CLAUDE, 'claude/claude-opus-4-1').extra).toEqual({ value: 'claude/claude-opus-4-1', label: 'claude-opus-4-1 (not offered)' });
    expect(modelMenu('claude', CLAUDE, 'claude/claude-sonnet-5').extra).toEqual({ value: 'claude/claude-sonnet-5', label: 'claude-sonnet-5' });
    expect(modelMenu('claude', [], 'claude/opus')).toMatchObject({ extra: { value: 'claude/opus', label: 'opus' }, otherProvider: false });
  });
});

describe('a step’s Effort menu (spec §4.1, §6)', () => {
  it('offers Default and the levels the chosen model offers', () => {
    expect(effortMenu('claude', CLAUDE, all, 'claude/claude-opus-4-6', '').options.map((o) => o.value)).toEqual(['', 'low', 'medium', 'high', 'max']);
    expect(effortMenu('codex', CODEX, [...all, 'ultra'], 'codex/gpt-6-astra', 'ultra')).toEqual({ disabled: false, options: expect.arrayContaining([{ value: 'ultra', label: 'ultra' }]) });
  });

  it('on Default, the levels the provider reports for its default model', () => {
    expect(effortMenu('claude', CLAUDE, ['low', 'high'], '', '').options.map((o) => o.value)).toEqual(['', 'low', 'high']);
    // A model the step won't run (another provider's) also falls back to the default's levels.
    expect(effortMenu('claude', CLAUDE, ['low'], 'codex/gpt-6-astra', '').options.map((o) => o.value)).toEqual(['', 'low']);
  });

  it('is disabled and reads Not supported for a model with no levels, and on Copilot', () => {
    expect(effortMenu('claude', CLAUDE, all, 'claude/haiku', '')).toEqual({ disabled: true, options: [{ value: '', label: NOT_SUPPORTED }] });
    expect(effortMenu('copilot', COPILOT, [], 'copilot/auto', 'high')).toEqual({ disabled: true, options: [{ value: 'high', label: NOT_SUPPORTED }] });
    expect(effortMenu('copilot', [], [], '', '')).toEqual({ disabled: true, options: [{ value: '', label: NOT_SUPPORTED }] });
  });

  it('keeps a stored level the model doesn’t offer visible, and offers only Default and it while the list is unknown', () => {
    expect(effortMenu('claude', CLAUDE, all, 'claude/claude-opus-4-6', 'xhigh').options.at(-1)).toEqual({ value: 'xhigh', label: 'xhigh (not offered)' });
    expect(effortMenu('claude', [], [], 'claude/opus', 'high')).toEqual({ disabled: false, options: [{ value: '', label: 'Default' }, { value: 'high', label: 'high' }] });
  });
});
```

- [ ] **Step 2: Run the tests and see them fail**

Run: `npm test -w engine -- test/graphTabModels.test.ts && npm test -w web -- test/stepModelMenus.test.ts test/NodePanelModel.test.ts test/NodePanel.test.ts`
Expected: FAIL — the new modules, exports or behaviour do not exist yet (import errors or assertion failures).

- [ ] **Step 3: Implement**

Create `web/src/stepModelMenus.ts`:

```ts
import { findModel, parseStepModel, PROVIDER_NAMES, type EffortLevel, type ModelChoice, type ProviderId } from '@agent-stream/shared';

/** One option of a step's Model or Effort menu. Values are `<provider>/<id>` and effort levels; '' is Default. */
export type MenuOption = { value: string; label: string; disabled?: boolean };
export type ModelMenu = {
  /** Default, then the provider's models in the list's order (Claude: its aliases). */
  options: MenuOption[];
  /** Claude's pinned versions (ids starting `claude-`), shown in their own group. */
  pinned: MenuOption[];
  /** The step's own model when no option stands for it: another provider's, or one the list doesn't offer. */
  extra?: MenuOption;
  /** The step's model belongs to another provider than the current one: the panel offers Use Default. */
  otherProvider: boolean;
};
export type EffortMenu = { disabled: boolean; options: MenuOption[] };

export const DEFAULT_MODEL_OPTION = "Default (the run's model)";
export const NOT_SUPPORTED = 'Not supported';

const option = (provider: ProviderId, m: ModelChoice): MenuOption => ({
  value: `${provider}/${m.value}`,
  label: m.unavailable ? `${m.label} (unavailable)` : m.label,
  ...(m.unavailable && { disabled: true }),
});

/**
 * An agent step's Model menu (step model spec §4.1). `value` is the step's model as `<provider>/<id>`, '' for Default.
 * `models` is the current provider's list; [] while it isn't known.
 */
export function modelMenu(provider: ProviderId | undefined, models: readonly ModelChoice[], value: string): ModelMenu {
  const listed = provider ? models.map((m) => option(provider, m)) : [];
  const isPinned = (o: MenuOption) => provider === 'claude' && o.value.startsWith('claude/claude-');
  const options = [{ value: '', label: DEFAULT_MODEL_OPTION }, ...listed.filter((o) => !isPinned(o))];
  const pinned = listed.filter(isPinned);
  if (!value || listed.some((o) => o.value === value)) return { options, pinned, otherProvider: false };
  const parsed = parseStepModel(value);
  if (!parsed.ok) return { options, pinned, extra: { value, label: value }, otherProvider: false };
  const { provider: own, id } = parsed.model;
  if (provider && own !== provider) {
    return { options, pinned, extra: { value, label: `${PROVIDER_NAMES[own]} · ${id} (not the current provider)`, disabled: true }, otherProvider: true };
  }
  // A full id the list names through an alias (claude-sonnet-5 → sonnet) is offered; with no list we can't tell.
  const offered = models.length === 0 || !!findModel(models, id);
  return { options, pinned, extra: { value, label: offered ? id : `${id} (not offered)` }, otherProvider: false };
}

/**
 * The levels the step's model offers: its row's, or `defaultEfforts` (the provider's default model's) for Default and for a
 * model the step won't run (another provider's, or one not offered). Undefined while the list isn't known.
 */
export function effortsFor(provider: ProviderId | undefined, models: readonly ModelChoice[], defaultEfforts: readonly EffortLevel[], model: string): readonly EffortLevel[] | undefined {
  if (models.length === 0) return undefined;
  if (!model) return defaultEfforts;
  const parsed = parseStepModel(model);
  if (!parsed.ok || parsed.model.provider !== provider) return defaultEfforts;
  return findModel(models, parsed.model.id)?.efforts ?? defaultEfforts;
}

/**
 * An agent step's Effort menu (spec §4.1): Default and the levels the chosen model offers. Disabled, reading Not supported,
 * on Copilot (spec §6) and for a model with no levels. A stored level the menu doesn't offer still shows, so it can be seen.
 */
export function effortMenu(provider: ProviderId | undefined, models: readonly ModelChoice[], defaultEfforts: readonly EffortLevel[], model: string, effort: string): EffortMenu {
  const levels = provider === 'copilot' ? [] : effortsFor(provider, models, defaultEfforts, model);
  if (levels && levels.length === 0) return { disabled: true, options: [{ value: effort, label: NOT_SUPPORTED }] };
  const options: MenuOption[] = [{ value: '', label: 'Default' }, ...(levels ?? []).map((l) => ({ value: l, label: l }))];
  if (effort && !options.some((o) => o.value === effort)) options.push({ value: effort, label: levels ? `${effort} (not offered)` : effort });
  return { disabled: false, options };
}
```

Change `engine/src/app.ts`:

```diff
diff --git a/engine/src/app.ts b/engine/src/app.ts
--- a/engine/src/app.ts
+++ b/engine/src/app.ts
@@ -226,6 +226,10 @@ export function createApp(d: AppDeps) {
   };
   /** The one planner conversation each client shows (openChat). */
   const chatSubscriptions = new Map<Client, { graphId: string; sessionId: string }>();
+  /** Clients that opened a graph: their Node panel's Model menu needs the provider's models too (step model spec §4.1). */
+  const graphClients = new Set<Client>();
+  /** Everyone who shows a Model menu: chats and graph tabs. */
+  const modelClients = () => new Set<Client>([...chatSubscriptions.keys(), ...graphClients]);
   const toConversation = (sessionId: string, graphId: string, msg: ServerMessage) => {
     for (const [c, sub] of chatSubscriptions) if (sub.graphId === graphId && sub.sessionId === sessionId) c.send(msg);
   };
@@ -438,7 +442,7 @@ export function createApp(d: AppDeps) {
   }
   /** The settings' default model or effort changed: the chats' Default menus follow. Runs and turns read them when they start. */
   function modelDefaultsChanged(): void {
-    for (const c of chatSubscriptions.keys()) sendModels(c);
+    for (const c of modelClients()) sendModels(c);
   }
 
   async function preview(
@@ -461,6 +465,12 @@ export function createApp(d: AppDeps) {
     return { ...(base.ok && base.graph && { baseline: base.graph }), changes: graphStore.agentChanges(graphId) };
   }
 
+  /** A tab showing a graph gets the provider's models, for its Node panel, after the graph. */
+  function openedGraph(client: Client): void {
+    graphClients.add(client);
+    if (provider.listModels) sendModels(client);
+  }
+
   function opened(graph: Graph): ServerMessage {
     const runs = runStore.list(graph.id);
     const run = runner.activeFor(graph.id) ?? (runs[0] ? runStore.get(runs[0].id) : undefined);
@@ -486,7 +496,7 @@ export function createApp(d: AppDeps) {
     provider = next;
     status = nextStatus;
     broadcast({ type: 'auth', status });
-    for (const c of chatSubscriptions.keys()) sendModels(c, next);
+    for (const c of modelClients()) sendModels(c, next);
   }
 
   /** VS Code is closing: release this engine's leases and stop every run (ruling R4, spec §8). */
@@ -513,6 +523,7 @@ export function createApp(d: AppDeps) {
     return () => {
       clients.delete(client);
       chatSubscriptions.delete(client);
+      graphClients.delete(client);
     };
   }
 
@@ -523,11 +534,13 @@ export function createApp(d: AppDeps) {
         const r = graphStore.load(msg.graphId);
         if (!r.ok) return error(r.error);
         client.send(opened(r.graph));
+        openedGraph(client);
         return;
       }
       case 'createGraph': {
         const graph = createGraph(msg.name);
         client.send(opened(graph));
+        openedGraph(client);
         return;
       }
       case 'op': {
```

Change `web/src/components/NodePanel.tsx`:

```diff
diff --git a/web/src/components/NodePanel.tsx b/web/src/components/NodePanel.tsx
--- a/web/src/components/NodePanel.tsx
+++ b/web/src/components/NodePanel.tsx
@@ -1,12 +1,14 @@
 import { useEffect, useState } from 'react';
-import { refinable, type GraphNode, type NodeKind, type NodePatch } from '@agent-stream/shared';
+import { parseStepModel, refinable, stepModelText, type EffortLevel, type GraphNode, type ModelChoice, type NodeKind, type NodePatch } from '@agent-stream/shared';
 import { actions } from '../actions';
 import { changedSentence, changeKey } from '../changeLabels';
 import { send } from '../bridge';
 import { reportDraft } from '../draftState';
+import { effortMenu, effortsFor, modelMenu, type MenuOption } from '../stepModelMenus';
 import { dispatch, useStore } from '../store';
 
-type Draft = { title: string; description: string; kind: NodeKind; access: 'read' | 'write'; workspace: string; prompt: string; command: string; timeoutSec: string };
+/** `model`: `<provider>/<id>`, '' for Default; `effort`: a level, '' for Default. */
+type Draft = { title: string; description: string; kind: NodeKind; access: 'read' | 'write'; workspace: string; model: string; effort: string; prompt: string; command: string; timeoutSec: string };
 
 const toDraft = (n: GraphNode): Draft => ({
   title: n.title,
@@ -14,6 +16,8 @@ const toDraft = (n: GraphNode): Draft => ({
   kind: n.kind,
   access: n.access === 'read' ? 'read' : 'write',
   workspace: n.workspace ?? '',
+  model: n.model ? stepModelText(n.model) : '',
+  effort: n.effort ?? '',
   prompt: n.prompt ?? '',
   command: n.command ?? '',
   timeoutSec: n.timeoutSec ? String(n.timeoutSec) : '',
@@ -47,6 +51,54 @@ export function NodePanel() {
   );
 }
 
+const NO_MODELS: ModelChoice[] = [];
+const options = (list: MenuOption[]) =>
+  list.map((o) => (
+    <option key={o.value} value={o.value} disabled={o.disabled}>
+      {o.label}
+    </option>
+  ));
+
+/** An agent step's own Model and Effort (step model spec §4.1), saved with the panel's other edits. */
+function StepModelFields({ model, effort, onChange }: { model: string; effort: string; onChange(next: { model: string; effort: string }): void }) {
+  const statusProvider = useStore((s) => s.status?.provider);
+  const listProvider = useStore((s) => s.modelsProvider);
+  const provider = listProvider ?? statusProvider;
+  const models = useStore((s) => (s.modelsProvider === provider ? s.models : NO_MODELS));
+  const defaultEfforts = useStore((s) => s.defaultEfforts);
+  const menu = modelMenu(provider, models, model);
+  const efforts = effortMenu(provider, models, defaultEfforts, model, effort);
+  // An effort the new model doesn't offer goes back to Default.
+  const pickModel = (next: string) => {
+    const levels = provider === 'copilot' ? [] : effortsFor(provider, models, defaultEfforts, next);
+    onChange({ model: next, effort: effort && levels && !levels.includes(effort as EffortLevel) ? '' : effort });
+  };
+  return (
+    <>
+      <div className="field">
+        <label htmlFor="node-model">Model</label>
+        <div className="field-row">
+          <select id="node-model" value={model} onChange={(e) => pickModel(e.target.value)}>
+            {options(menu.options)}
+            {menu.pinned.length > 0 && <optgroup label="Pinned versions">{options(menu.pinned)}</optgroup>}
+            {menu.extra && options([menu.extra])}
+          </select>
+          {menu.otherProvider && <button onClick={() => pickModel('')}>Use Default</button>}
+        </div>
+      </div>
+      <div className="field">
+        <label htmlFor="node-effort">Effort</label>
+        <div className="field-row">
+          <select id="node-effort" value={effort} disabled={efforts.disabled} onChange={(e) => onChange({ model, effort: e.target.value })}>
+            {options(efforts.options)}
+          </select>
+          {efforts.disabled && effort && <button onClick={() => onChange({ model, effort: '' })}>Use Default</button>}
+        </div>
+      </div>
+    </>
+  );
+}
+
 /** Edits a local draft; if someone else changes the node meanwhile, the user decides. */
 function NodeEditor({ graphId, node, workspaces }: { graphId: string; node: GraphNode; workspaces: string[] }) {
   const run = useStore((s) => s.run);
@@ -82,6 +134,12 @@ function NodeEditor({ graphId, node, workspaces }: { graphId: string; node: Grap
     if (draft.kind !== base.draft.kind) patch.kind = draft.kind;
     if (draft.access !== base.draft.access && draft.kind === 'agent') patch.access = draft.access;
     if (draft.workspace !== base.draft.workspace) patch.workspace = draft.workspace.trim();
+    // Only agent steps have a model or effort; becoming a command step drops them in the engine.
+    if (draft.kind === 'agent' && draft.model !== base.draft.model) {
+      const parsed = draft.model ? parseStepModel(draft.model) : undefined;
+      patch.model = parsed?.ok ? parsed.model : null;
+    }
+    if (draft.kind === 'agent' && draft.effort !== base.draft.effort) patch.effort = (draft.effort || null) as EffortLevel | null;
     if (draft.prompt !== base.draft.prompt) patch.prompt = draft.prompt;
     if (draft.command !== base.draft.command) patch.command = draft.command;
     const timeout = Number(draft.timeoutSec);
@@ -147,6 +205,7 @@ function NodeEditor({ graphId, node, workspaces }: { graphId: string; node: Grap
           ))}
         </datalist>
       </div>
+      {draft.kind === 'agent' && <StepModelFields model={draft.model} effort={draft.effort} onChange={(next) => setDraft({ ...draft, ...next })} />}
       {draft.kind === 'agent' ? (
         <div className="field">
           <label>Prompt</label>
```

Change `web/src/state.ts`:

```diff
diff --git a/web/src/state.ts b/web/src/state.ts
--- a/web/src/state.ts
+++ b/web/src/state.ts
@@ -13,6 +13,7 @@ import type {
   ModelChoice,
   ModelSelection,
   NodeEvent,
+  ProviderId,
   ProviderStatus,
   RunMeta,
   RunPreview,
@@ -78,8 +79,10 @@ export type State = {
   chatBusy: boolean;
   /** The planner conversation the chat view shows; the extension picks it. */
   chatTarget?: ChatTarget;
-  /** The current provider's models, for the chat's Model menu. */
+  /** The current provider's models, for the chat's and the Node panel's Model menus. */
   models: ModelChoice[];
+  /** The provider `models` belongs to. */
+  modelsProvider?: ProviderId;
   /** The levels the chat's Default offers: the settings' model's, else Claude Code's default row's. */
   defaultEfforts: EffortLevel[];
   /** The shown conversation's own model and effort choice, as the engine last confirmed it (absent fields: Default). */
@@ -314,7 +317,7 @@ function reduceServer(state: State, msg: HostMessage): State {
     case 'plannerModel':
       return forTarget(state, msg.graphId, msg.sessionId) ? { ...state, plannerModel: selection(msg) } : state;
     case 'models':
-      return { ...state, models: msg.models, defaultEfforts: msg.defaultEfforts ?? [] };
+      return { ...state, models: msg.models, modelsProvider: msg.provider, defaultEfforts: msg.defaultEfforts ?? [] };
     case 'chatEntry':
       return forTarget(state, msg.graphId, msg.sessionId) ? { ...state, chat: [...state.chat, msg.entry] } : state;
     case 'chatBusy':
```

Change `web/src/styles.css`:

```diff
diff --git a/web/src/styles.css b/web/src/styles.css
--- a/web/src/styles.css
+++ b/web/src/styles.css
@@ -147,6 +147,8 @@ pre { background: var(--code-bg); padding: 8px; border-radius: 6px; white-space:
 .node-panel { padding: 12px; display: flex; flex-direction: column; gap: 10px; }
 .field { display: flex; flex-direction: column; gap: 4px; }
 .field label { font-size: 12px; color: var(--muted); }
+.field-row { display: flex; gap: 6px; align-items: center; }
+.field-row select { flex: 1; min-width: 0; }
 .notice { font-size: 12px; color: var(--warn); }
 .actions { display: flex; gap: 8px; flex-wrap: wrap; }
 
```

- [ ] **Step 4: Run the tests and typecheck**

Run: `npm test -w engine -- test/graphTabModels.test.ts && npm test -w web -- test/stepModelMenus.test.ts test/NodePanelModel.test.ts test/NodePanel.test.ts`
Expected: PASS.
Run: `npm run typecheck && npm test`
Expected: all workspaces pass (a test that times out only under heavy machine load is not a failure of this task: run it again).

- [ ] **Step 5: Commit**

```bash
git add engine/src/app.ts engine/test/graphTabModels.test.ts web/src/components/NodePanel.tsx web/src/state.ts web/src/stepModelMenus.ts web/src/styles.css web/test/NodePanelModel.test.ts web/test/stepModelMenus.test.ts
git commit -m "feat(web): pick a step's model and effort in the Node panel" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 8: The model chip on the canvas card

**Spec covered:** §4.2, §7 web chip tests.

**Files:**
- Modify: `web/src/components/Canvas.tsx`, `web/src/components/StepNode.tsx`, `web/src/flowNodes.ts`, `web/src/stepModelMenus.ts`, `web/src/styles.css`
- Test: `web/test/modelChip.test.ts` (new)

**Interfaces:**
- Consumes: Task 7's `stepModelMenus.ts`, Task 3's `stepModelNote`.
- Produces: `modelChip(node, provider, models): ModelChip | undefined` and `type ModelChip = { text: string; warning?: string }` in `stepModelMenus.ts`; `StepData.modelChip?`; `FlowNodesInput.provider?`, `models?`.

- [ ] **Step 1: Write the failing tests**

Create `web/test/modelChip.test.ts`:

```ts
// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { ReactFlowProvider, type NodeProps } from '@xyflow/react';
import { describe, expect, it } from 'vitest';
import { applyOp, emptyGraph, type GraphNode, type ModelChoice, type Position } from '@agent-stream/shared';
import { StepNode, type StepFlowNode } from '../src/components/StepNode';
import { buildFlowNodes } from '../src/flowNodes';
import { modelChip } from '../src/stepModelMenus';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CLAUDE: ModelChoice[] = [{ value: 'opus', label: 'Opus', efforts: ['high'] }];
const CODEX: ModelChoice[] = [{ value: 'gpt-6-astra', label: 'GPT-6-Astra', efforts: ['high'] }];
const agent = (over: Partial<GraphNode> = {}): GraphNode => ({ id: 'n1', title: 'Plan', kind: 'agent', prompt: 'p', createdBy: 'user', updatedBy: 'user', updatedAt: 't', ...over });

describe('the model chip (spec §4.2)', () => {
  it('names the model by its display name and the effort', () => {
    expect(modelChip(agent({ model: { provider: 'claude', id: 'opus' }, effort: 'high' }), 'claude', CLAUDE)).toEqual({ text: 'Opus · high' });
    expect(modelChip(agent({ model: { provider: 'codex', id: 'gpt-6-astra' } }), 'codex', CODEX)).toEqual({ text: 'GPT-6-Astra' });
    expect(modelChip(agent({ effort: 'max' }), 'claude', CLAUDE)).toEqual({ text: '· max' });
    // No list yet: the id, and no warning.
    expect(modelChip(agent({ model: { provider: 'claude', id: 'opus' } }), 'claude', [])).toEqual({ text: 'opus' });
  });

  it('has none for a step without its own, and for a command step', () => {
    expect(modelChip(agent(), 'claude', CLAUDE)).toBeUndefined();
    expect(modelChip({ kind: 'command' }, 'claude', CLAUDE)).toBeUndefined();
  });

  it('warns, with the note, for another provider’s model and one the list doesn’t offer', () => {
    expect(modelChip(agent({ model: { provider: 'codex', id: 'gpt-6-astra' }, effort: 'high' }), 'claude', CLAUDE)).toEqual({
      text: 'gpt-6-astra · high',
      warning: 'This step is set to an OpenAI Codex model (gpt-6-astra); this run uses Claude, so it uses the default model.',
    });
    expect(modelChip(agent({ model: { provider: 'claude', id: 'claude-opus-4-1' } }), 'claude', CLAUDE)).toEqual({
      text: 'claude-opus-4-1',
      warning: "claude-opus-4-1 isn't offered by Claude any more (or on this plan), so this step uses the default model.",
    });
  });

  it('reaches the card through buildFlowNodes, which shows it struck through when it warns', async () => {
    let g = emptyGraph('g', 'G', 't');
    for (const node of [{ title: 'own', model: { provider: 'claude' as const, id: 'opus' } }, { title: 'other', model: { provider: 'codex' as const, id: 'gpt-6-astra' } }]) {
      const r = applyOp(g, { type: 'addNode', node: { kind: 'agent', prompt: 'p', ...node } }, 'user', 't');
      if (!r.ok) throw new Error(r.error);
      g = r.graph;
    }
    const nodes = buildFlowNodes({ graph: g, approvals: [], selectionChanged: true, current: [], dragging: new Set(), pendingMoves: new Map<string, Position>(), provider: 'claude', models: CLAUDE });
    expect(nodes.map((n) => n.data.modelChip?.text)).toEqual(['Opus', 'gpt-6-astra']);
    const container = document.createElement('div');
    const root = createRoot(container);
    const props = { id: 'n2', data: nodes[1].data, selected: false } as unknown as NodeProps<StepFlowNode>;
    await act(async () => root.render(createElement(ReactFlowProvider, null, createElement(StepNode, props))));
    const chip = container.querySelector('.model-chip') as HTMLElement;
    expect(chip.textContent).toBe('gpt-6-astra');
    expect(chip.classList.contains('model-chip-warning')).toBe(true);
    expect(chip.title).toBe('This step is set to an OpenAI Codex model (gpt-6-astra); this run uses Claude, so it uses the default model.');
    await act(async () => root.unmount());
  });
});
```

- [ ] **Step 2: Run the tests and see them fail**

Run: `npm test -w web -- test/modelChip.test.ts test/flowNodes.test.ts test/StepNode.test.ts`
Expected: FAIL — the new modules, exports or behaviour do not exist yet (import errors or assertion failures).

- [ ] **Step 3: Implement**

Change `web/src/components/Canvas.tsx`:

```diff
diff --git a/web/src/components/Canvas.tsx b/web/src/components/Canvas.tsx
--- a/web/src/components/Canvas.tsx
+++ b/web/src/components/Canvas.tsx
@@ -37,6 +37,10 @@ export function Canvas() {
   const approvals = useStore((s) => s.approvals);
   const selectedId = useStore((s) => s.selectedNodeId);
   const minimap = useStore((s) => s.minimap);
+  const statusProvider = useStore((s) => s.status?.provider);
+  const listProvider = useStore((s) => s.modelsProvider);
+  const models = useStore((s) => s.models);
+  const provider = listProvider ?? statusProvider;
   const { screenToFlowPosition, getNodes } = useReactFlow<StepFlowNode, FlowEdge>();
   const wrapper = useRef<HTMLDivElement>(null);
   const [nodes, setNodes] = useState<StepFlowNode[]>([]);
@@ -52,11 +56,24 @@ export function Canvas() {
     lastSelected.current = selectedId;
     setNodes((current) =>
       graph
-        ? buildFlowNodes({ graph, run: runForGraph, approvals, selectedId, selectionChanged, current, dragging: dragging.current, pendingMoves: pendingMoves.current, baseline, changes: agentChanges })
+        ? buildFlowNodes({
+            graph,
+            run: runForGraph,
+            approvals,
+            selectedId,
+            selectionChanged,
+            current,
+            dragging: dragging.current,
+            pendingMoves: pendingMoves.current,
+            baseline,
+            changes: agentChanges,
+            provider,
+            models: listProvider === provider ? models : [],
+          })
         : [],
     );
     setEdges((current) => (graph ? buildFlowEdges(graph, runForGraph, current, agentChanges) : []));
-  }, [graph, baseline, agentChanges, runForGraph, approvals, selectedId]);
+  }, [graph, baseline, agentChanges, runForGraph, approvals, selectedId, provider, listProvider, models]);
 
   const onNodesChange = useCallback(
     (changes: NodeChange<StepFlowNode>[]) => setNodes((current) => applyNodeChanges(changes.filter((c) => c.type !== 'remove'), current)),
```

Change `web/src/components/StepNode.tsx`:

```diff
diff --git a/web/src/components/StepNode.tsx b/web/src/components/StepNode.tsx
--- a/web/src/components/StepNode.tsx
+++ b/web/src/components/StepNode.tsx
@@ -1,6 +1,7 @@
 import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
 import { fmtDuration, statusLabel, type ChangeSource, type ChangedField, type GraphNode, type NodeRunState } from '@agent-stream/shared';
 import { badgeText } from '../changeLabels';
+import type { ModelChip } from '../stepModelMenus';
 import { workspaceColor } from '../workspaceColor';
 
 export type StepData = {
@@ -13,6 +14,8 @@ export type StepData = {
   changeFields?: ChangedField[];
   /** A removed step drawn from the baseline: it can't be selected or edited. */
   ghost?: boolean;
+  /** The step's own model and effort (step model spec §4.2). */
+  modelChip?: ModelChip;
 };
 export type StepFlowNode = Node<StepData, 'step'>;
 
@@ -21,7 +24,7 @@ const changeTitle = (change: NonNullable<StepData['change']>, fields?: ChangedFi
   `${change[0].toUpperCase()}${change.slice(1)}${fields?.length ? `: ${fields.join(', ')}` : ''}`;
 
 export function StepNode({ data, selected }: NodeProps<StepFlowNode>) {
-  const { node, state, waiting, change, changeBy, changeFields } = data;
+  const { node, state, waiting, change, changeBy, changeFields, modelChip } = data;
   const status = state?.status;
   const classes = ['step', `kind-${node.kind}`, change ? `change-${change}` : '', status ? `status-${status}` : '', waiting ? 'waiting' : '', selected ? 'selected' : ''];
   return (
@@ -44,6 +47,12 @@ export function StepNode({ data, selected }: NodeProps<StepFlowNode>) {
             ⎇ {node.workspace}
           </span>
         )}
+        {modelChip && (
+          // Struck through, with the note as its tooltip, when the step won't run its own model.
+          <span className={`model-chip${modelChip.warning ? ' model-chip-warning' : ''}`} title={modelChip.warning ?? "This step's own model and effort"}>
+            {modelChip.text}
+          </span>
+        )}
         {change ? (
           <span className="change-badge" title={changeTitle(change, changeFields)}>
             {badgeText(change, changeBy)}
```

Change `web/src/flowNodes.ts`:

```diff
diff --git a/web/src/flowNodes.ts b/web/src/flowNodes.ts
--- a/web/src/flowNodes.ts
+++ b/web/src/flowNodes.ts
@@ -1,7 +1,8 @@
 import { MarkerType, type Edge as FlowEdge } from '@xyflow/react';
-import type { AgentChange, ApprovalRequest, Graph, Position, RunMeta } from '@agent-stream/shared';
+import type { AgentChange, ApprovalRequest, Graph, ModelChoice, Position, ProviderId, RunMeta } from '@agent-stream/shared';
 import type { StepData, StepFlowNode } from './components/StepNode';
 import { layoutPositions } from './layout';
+import { modelChip } from './stepModelMenus';
 
 export type FlowNodesInput = {
   graph: Graph;
@@ -15,11 +16,14 @@ export type FlowNodesInput = {
   /** The user's accepted version and what agents changed since: drawn as marks and ghosts. */
   baseline?: Graph;
   changes?: AgentChange[];
+  /** The current provider and its models ([] while unknown): a step's model chip names and checks its model by them. */
+  provider?: ProviderId;
+  models?: readonly ModelChoice[];
 };
 
 /** Merge the server graph into the local React Flow nodes without clobbering in-flight drags, unconfirmed moves or local selection. */
 export function buildFlowNodes(input: FlowNodesInput): StepFlowNode[] {
-  const { graph, run, approvals, selectedId, selectionChanged, current, dragging, pendingMoves, baseline, changes = [] } = input;
+  const { graph, run, approvals, selectedId, selectionChanged, current, dragging, pendingMoves, baseline, changes = [], provider, models = [] } = input;
   const auto = layoutPositions(graph, true);
   const previous = new Map(current.map((n) => [n.id, n]));
   const nodeChange = new Map(changes.flatMap((c) => (c.kind === 'node' ? [[c.id, c] as const] : [])));
@@ -43,12 +47,18 @@ export function buildFlowNodes(input: FlowNodesInput): StepFlowNode[] {
         state: run?.nodes[n.id],
         waiting: approvals.some((a) => a.nodeId === n.id && a.runId === run?.id),
         ...changeData(nodeChange.get(n.id)),
+        ...modelChipData(n, provider, models),
       },
     };
   });
   return [...real, ...ghostNodes(graph, baseline, changes, previous)];
 }
 
+const modelChipData = (n: Graph['nodes'][number], provider: ProviderId | undefined, models: readonly ModelChoice[]): Pick<StepData, 'modelChip'> => {
+  const chip = modelChip(n, provider, models);
+  return chip ? { modelChip: chip } : {};
+};
+
 const changeData = (c?: AgentChange): Pick<StepData, 'change' | 'changeBy' | 'changeFields'> =>
   c?.kind === 'node' && c.change !== 'removed' ? { change: c.change, ...(c.by && { changeBy: c.by }), ...(c.fields && { changeFields: c.fields }) } : {};
 
```

Change `web/src/stepModelMenus.ts`:

```diff
diff --git a/web/src/stepModelMenus.ts b/web/src/stepModelMenus.ts
--- a/web/src/stepModelMenus.ts
+++ b/web/src/stepModelMenus.ts
@@ -1,4 +1,4 @@
-import { findModel, parseStepModel, PROVIDER_NAMES, type EffortLevel, type ModelChoice, type ProviderId } from '@agent-stream/shared';
+import { findModel, parseStepModel, PROVIDER_NAMES, stepModelNote, type EffortLevel, type GraphNode, type ModelChoice, type ProviderId } from '@agent-stream/shared';
 
 /** One option of a step's Model or Effort menu. Values are `<provider>/<id>` and effort levels; '' is Default. */
 export type MenuOption = { value: string; label: string; disabled?: boolean };
@@ -67,3 +67,18 @@ export function effortMenu(provider: ProviderId | undefined, models: readonly Mo
   if (effort && !options.some((o) => o.value === effort)) options.push({ value: effort, label: levels ? `${effort} (not offered)` : effort });
   return { disabled: false, options };
 }
+
+/** What a step card's chip shows (spec §4.2): `opus · high`, `GPT-6-Astra`, `· max`; `warning` (the note) when it won't run as set. */
+export type ModelChip = { text: string; warning?: string };
+
+/**
+ * The chip of an agent step with its own model or effort: the model's display name from the current provider's list (else
+ * its id) and the effort. A model of another provider, or one the known list doesn't offer, is a warning.
+ */
+export function modelChip(node: Pick<GraphNode, 'kind' | 'model' | 'effort'>, provider: ProviderId | undefined, models: readonly ModelChoice[]): ModelChip | undefined {
+  if (node.kind !== 'agent' || (!node.model && !node.effort)) return undefined;
+  const warning = node.model && provider ? (stepModelNote(node.model, provider, models) ?? undefined) : undefined;
+  const label = node.model ? (warning ? node.model.id : (findModel(models, node.model.id)?.label ?? node.model.id)) : '';
+  const text = label ? `${label}${node.effort ? ` · ${node.effort}` : ''}` : `· ${node.effort}`;
+  return { text, ...(warning && { warning }) };
+}
```

Change `web/src/styles.css`:

```diff
diff --git a/web/src/styles.css b/web/src/styles.css
--- a/web/src/styles.css
+++ b/web/src/styles.css
@@ -196,6 +196,8 @@ pre { background: var(--code-bg); padding: 8px; border-radius: 6px; white-space:
 .static-note { margin: 0; color: var(--muted); }
 .read-badge { padding: 0 4px; border: 1px solid var(--border); border-radius: 8px; color: var(--muted); }
 .ws-badge { padding: 0 4px; border: 1px solid var(--ws); border-radius: 8px; color: var(--ws); }
+.model-chip { padding: 0 4px; border: 1px solid var(--border); border-radius: 8px; color: var(--muted); }
+.model-chip-warning { text-decoration: line-through; color: var(--danger); }
 .ws-color-0 { --ws: var(--vscode-charts-blue, #1d5fa8); }
 .ws-color-1 { --ws: var(--vscode-charts-green, #2e7d32); }
 .ws-color-2 { --ws: var(--vscode-charts-orange, #b26a00); }
```

- [ ] **Step 4: Run the tests and typecheck**

Run: `npm test -w web -- test/modelChip.test.ts test/flowNodes.test.ts test/StepNode.test.ts`
Expected: PASS.
Run: `npm run typecheck && npm test`
Expected: all workspaces pass (a test that times out only under heavy machine load is not a failure of this task: run it again).

- [ ] **Step 5: Commit**

```bash
git add web/src/components/Canvas.tsx web/src/components/StepNode.tsx web/src/flowNodes.ts web/src/stepModelMenus.ts web/src/styles.css web/test/modelChip.test.ts
git commit -m "feat(web): a model chip on step cards" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 9: Undo in the engine

**Spec covered:** §6a.2 (recording, undoing, refusals, toasts, 50 steps, `via: 'undo'`, baseline rules), §7 undo tests on the engine side.

**Files:**
- Create: `engine/src/undoStacks.ts`, `shared/src/undo.ts`
- Modify: `engine/src/app.ts`, `engine/src/graphStore.ts`, `shared/src/graph.ts`, `shared/src/index.ts`, `shared/src/schemas.ts`, `shared/src/types.ts`, `web/src/state.ts`
- Test: `engine/test/undo.test.ts` (new), `shared/test/undo.test.ts` (new)

**Interfaces:**
- Consumes: `diffToOps` (Task 2).
- Produces:
  ```ts
  // shared/src/undo.ts
  export const MAX_UNDO = 50, TIDY_LABEL, MARKDOWN_SAVE_LABEL, MAX_UNDO_LABEL_CHARS, NOTHING_TO_UNDO, UNDO_CHANGED;
  export const undoneMessage: (label: string) => string; export const undoFileErrors: (graphId: string) => string;
  export function undoState(g: Graph): string;
  export function graphAsDoc(g: Graph): GraphDoc;
  export function undoOps(current: Graph, before: Graph, forward?: readonly Op[]): Op[];
  export function undoLabel(op: Op): string | undefined;
  export const movedLabel: (ids: readonly string[]) => string;
  export function deletedLabel(nodeIds: readonly string[], edges: readonly { from: string; to: string }[]): string;
  // types: Op moveNode position: Position | null; OpRecord.via?: 'file' | 'undo';
  // ClientMessage 'ops' { graphId, ops, label } and 'undo' { graphId }; ServerMessage 'undoState' { graphId, label? } and 'undone' { graphId, message }.
  // engine: GraphStore.applyBatch(graphId, ops, by, o?: { via?: 'undo' }): GraphResult; engine/src/undoStacks.ts UndoStacks, UndoEntry.
  // web State.undoLabel?: string (from undoState); 'undone' shows its message as a toast.
  ```

- [ ] **Step 1: Write the failing tests**

Create `engine/test/undo.test.ts`:

````ts
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MAX_UNDO, NOTHING_TO_UNDO, UNDO_CHANGED, type Op, type ServerMessage } from '@agent-stream/shared';
import { createApp } from '../src/app';
import { appTestDeps, signedIn, testGitBash, testProvider, tmpProject, tmpValuesFile } from './helpers';

function setup() {
  const paths = tmpProject();
  const app = createApp({ ...appTestDeps(), projectDir: paths.root, valuesFile: tmpValuesFile(), provider: testProvider(), status: signedIn, maxParallel: 1, gitBash: testGitBash });
  const graphId = app.graphStore.create('G').id;
  const file = join(paths.graphsDir, `${graphId}.md`);
  /** A graph tab: a client of its own, as each webview is. */
  const tab = () => {
    const msgs: ServerMessage[] = [];
    const c = { send: (m: ServerMessage) => void msgs.push(structuredClone(m)) };
    app.connect(c);
    const all = <T extends ServerMessage['type']>(type: T) => msgs.filter((m): m is Extract<ServerMessage, { type: T }> => m.type === type);
    return {
      c,
      all,
      op: (op: Op) => app.handle(c, { type: 'op', graphId, op }),
      ops: (ops: Op[], label: string) => app.handle(c, { type: 'ops', graphId, ops, label }),
      undo: () => app.handle(c, { type: 'undo', graphId }),
      toast: () => all('undone').at(-1)?.message,
      label: () => all('undoState').at(-1)?.label,
    };
  };
  const graph = () => app.graphStore.get(graphId);
  return { app, graphId, file, tab, graph };
}
const add = (id: string, extra: object = {}): Op => ({ type: 'addNode', node: { id, title: id, kind: 'agent', prompt: 'p', position: { x: 0, y: 0 }, ...extra } });

describe('undo (step model spec §6a.2)', () => {
  it('undoes each of the tab’s own actions, newest first, one step each, with its label', async () => {
    const s = setup();
    const t = s.tab();
    await s.app.handle(t.c, { type: 'openGraph', graphId: s.graphId });
    expect(t.all('undoState')).toEqual([{ type: 'undoState', graphId: s.graphId }]);
    await t.op(add('n1'));
    await t.op(add('n2'));
    await t.op({ type: 'connect', from: 'n1', to: 'n2' });
    await t.ops([{ type: 'moveNode', id: 'n1', position: { x: 10, y: 10 } }, { type: 'moveNode', id: 'n2', position: { x: 20, y: 20 } }], 'moved 2 steps');
    await t.op({ type: 'updateNode', id: 'n2', patch: { model: { provider: 'claude', id: 'opus' }, effort: 'high' } });
    await t.ops([{ type: 'deleteNode', id: 'n1' }], 'deleted n1');
    expect(t.label()).toBe('deleted n1');
    const labels: string[] = [];
    for (let i = 0; i < 6; i++) {
      await t.undo();
      labels.push(t.toast()!);
    }
    expect(labels).toEqual(['Undid deleted n1.', 'Undid saved n2.', 'Undid moved 2 steps.', 'Undid connected n1 → n2.', 'Undid added n2.', 'Undid added n1.']);
    expect(s.graph().nodes).toEqual([]);
    await t.undo();
    expect(t.toast()).toBe(NOTHING_TO_UNDO);
    expect(t.label()).toBeUndefined();
  });

  it('restores through user edits recorded via undo, in the Markdown file too', async () => {
    const s = setup();
    const t = s.tab();
    await t.op(add('n1', { title: 'Keep me' }));
    await t.op({ type: 'deleteNode', id: 'n1' });
    expect(readFileSync(s.file, 'utf8')).not.toContain('Keep me');
    await t.undo();
    expect(s.graph().nodes[0]).toMatchObject({ id: 'n1', title: 'Keep me', position: { x: 0, y: 0 } });
    expect(readFileSync(s.file, 'utf8')).toContain('## n1 · Keep me');
    expect(s.app.graphStore.readOps(s.graphId).at(-1)).toMatchObject({ by: 'user', via: 'undo', op: { type: 'addNode', node: { id: 'n1' } } });
  });

  it('keeps at most 50 steps', async () => {
    const s = setup();
    const t = s.tab();
    await t.op(add('n1'));
    for (let i = 1; i <= MAX_UNDO + 5; i++) await t.op({ type: 'moveNode', id: 'n1', position: { x: i, y: 0 } });
    for (let i = 0; i < MAX_UNDO; i++) await t.undo();
    expect(t.toast()).toBe('Undid moved n1.');
    expect(s.graph().nodes[0].position).toEqual({ x: 5, y: 0 });
    await t.undo();
    expect(t.toast()).toBe(NOTHING_TO_UNDO);
  }, 30_000);

  it('records nothing for an action that changed nothing, and no step for a review of agent changes', async () => {
    const s = setup();
    const t = s.tab();
    await t.op(add('n1'));
    await t.ops([{ type: 'moveNode', id: 'n1', position: { x: 0, y: 0 } }], 'moved n1');
    s.app.graphStore.apply(s.graphId, { type: 'updateNode', id: 'n1', patch: { prompt: 'agent' } }, 'agent', { kind: 'planner' });
    await t.op({ type: 'acceptChange', target: { kind: 'all' } });
    expect(t.label()).toBe('added n1');
  });

  it('refuses after a change by the planner, another tab or the file, and clears the stack', async () => {
    for (const change of ['planner', 'tab', 'file'] as const) {
      const s = setup();
      const t = s.tab();
      await t.op(add('n1'));
      await t.op(add('n2'));
      if (change === 'planner') s.app.graphStore.apply(s.graphId, { type: 'updateNode', id: 'n1', patch: { prompt: 'better' } }, 'agent', { kind: 'planner' });
      if (change === 'tab') await s.tab().op({ type: 'moveNode', id: 'n1', position: { x: 9, y: 9 } });
      if (change === 'file') {
        writeFileSync(s.file, readFileSync(s.file, 'utf8').replace('## n2 · n2', '## n2 · Renamed'));
        s.app.graphFileChanged(s.graphId);
      }
      await t.undo();
      expect(t.toast(), change).toBe(UNDO_CHANGED);
      expect(t.label(), change).toBeUndefined();
      expect(s.graph().nodes.map((n) => n.id), change).toEqual(['n1', 'n2']);
      await t.undo();
      expect(t.toast(), change).toBe(NOTHING_TO_UNDO);
    }
  });

  it('refuses while the file has errors, and keeps the step for later', async () => {
    const s = setup();
    const t = s.tab();
    await t.op(add('n1'));
    const good = readFileSync(s.file, 'utf8');
    writeFileSync(s.file, `${good}\n## n2 · Broken\n`);
    s.app.graphFileChanged(s.graphId);
    await t.undo();
    expect(t.toast()).toBe(`Can't undo: ${s.graphId}.md has errors. Fix the file first.`);
    writeFileSync(s.file, good);
    s.app.graphFileChanged(s.graphId);
    await t.undo();
    expect(t.toast()).toBe('Undid added n1.');
  });

  it('a tab only undoes its own actions', async () => {
    const s = setup();
    const a = s.tab();
    const b = s.tab();
    await a.op(add('n1'));
    await b.undo();
    expect(b.toast()).toBe(NOTHING_TO_UNDO);
    expect(s.graph().nodes).toHaveLength(1);
  });

  it('follows the agent-change baseline rules of a canvas edit', async () => {
    const s = setup();
    const t = s.tab();
    await t.op(add('n1'));
    await t.op(add('n2'));
    s.app.graphStore.apply(s.graphId, { type: 'updateNode', id: 'n1', patch: { prompt: 'agent' } }, 'agent', { kind: 'planner' });
    await t.op({ type: 'deleteNode', id: 'n2' });
    await t.undo();
    expect(t.toast()).toBe('Undid deleted n2.');
    // n2 came back as the user's: still only the planner's prompt change is pending.
    expect(s.app.graphStore.agentChanges(s.graphId)).toMatchObject([{ kind: 'node', change: 'changed', id: 'n1', fields: ['prompt'] }]);
  });

  it('a Markdown save in this tab is one step', async () => {
    const s = setup();
    const t = s.tab();
    await t.op(add('n1'));
    const text = readFileSync(s.file, 'utf8');
    await s.app.handle(t.c, { type: 'saveGraphMarkdown', graphId: s.graphId, text: text.replace('## n1 · n1', '## n1 · Hand edit').replace('```prompt\np', '```prompt\nedited'), base: text });
    expect(t.label()).toBe('saved the Markdown');
    await t.undo();
    expect(t.toast()).toBe('Undid saved the Markdown.');
    expect(s.graph().nodes[0]).toMatchObject({ title: 'n1', prompt: 'p' });
  });

  it('a revert of agent changes in this tab clears its stack', async () => {
    const s = setup();
    const t = s.tab();
    await t.op(add('n1'));
    s.app.graphStore.apply(s.graphId, { type: 'updateNode', id: 'n1', patch: { prompt: 'agent' } }, 'agent', { kind: 'planner' });
    await t.op({ type: 'revertChange', target: { kind: 'all' } });
    expect(t.label()).toBeUndefined();
  });

  it('a batch applies all or none', async () => {
    const s = setup();
    const t = s.tab();
    await t.op(add('n1'));
    await t.ops([{ type: 'deleteNode', id: 'n1' }, { type: 'deleteNode', id: 'n9' }], 'deleted 2 steps');
    expect(t.all('opRejected').at(-1)).toEqual({ type: 'opRejected', graphId: s.graphId, error: 'node n9 does not exist' });
    expect(s.graph().nodes).toHaveLength(1);
    expect(t.label()).toBe('added n1');
  });
});
````

Create `shared/test/undo.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { applyOp, emptyGraph } from '../src/graph';
import { canonicalGraph } from '../src/graphDoc';
import { deletedLabel, movedLabel, undoLabel, undoOps, undoState } from '../src/undo';
import type { Graph, Op } from '../src/types';
import { FIXTURES, randomGraph } from './graphFixtures';

const T = '2026-10-05T00:00:00.000Z';
function run(g: Graph, ops: Op[]): Graph {
  let out = g;
  for (const op of ops) {
    const r = applyOp(out, op, 'user', T);
    if (!r.ok) throw new Error(`${op.type}: ${r.error}`);
    out = r.graph;
  }
  return canonicalGraph(out);
}

describe('undoOps (spec §6a.2)', () => {
  const g = canonicalGraph(FIXTURES.example);

  it('takes the graph back to before, whatever the action was', () => {
    const actions: Op[][] = [
      [{ type: 'deleteNode', id: 'n2' }],
      [{ type: 'addNode', node: { id: 'n9', title: 'New', kind: 'agent', prompt: 'p', position: { x: 1, y: 2 } } }, { type: 'connect', from: 'n3', to: 'n9' }],
      [{ type: 'updateNode', id: 'n2', patch: { title: 'Run it', prompt: 'Go.', model: { provider: 'claude', id: 'opus' }, effort: 'high' } }],
      [{ type: 'updateNode', id: 'n1', patch: { kind: 'agent', prompt: 'think' } }],
      [{ type: 'disconnect', from: 'n1', to: 'n2' }],
      [{ type: 'moveNode', id: 'n1', position: { x: 50, y: 60 } }, { type: 'moveNode', id: 'n2', position: { x: 70, y: 80 } }],
      [{ type: 'setGoal', goal: 'Other.' }, { type: 'setInstructions', instructions: '' }],
      [{ type: 'deleteVariable', name: 'target_schema' }],
      [{ type: 'setVariableDescription', name: 'target_schema', description: 'Where' }],
    ];
    for (const ops of actions) {
      const after = run(g, ops);
      expect(undoState(after), JSON.stringify(ops)).not.toBe(undoState(g));
      expect(undoState(run(after, undoOps(after, g, ops))), JSON.stringify(ops)).toBe(undoState(g));
    }
  });

  it('puts a step that had no place back on the automatic layout', () => {
    const before = run(emptyGraph('g', 'G', T), [{ type: 'addNode', node: { id: 'n1', title: 'a', kind: 'agent' } }]);
    const after = run(before, [{ type: 'moveNode', id: 'n1', position: { x: 5, y: 5 } }]);
    const ops = undoOps(after, before);
    expect(ops).toEqual([{ type: 'moveNode', id: 'n1', position: null }]);
    expect(run(after, ops).nodes[0]).not.toHaveProperty('position');
  });

  it('renames a renamed variable back, so the steps using it follow', () => {
    const before = run(emptyGraph('g', 'G', T), [{ type: 'addVariable', name: 'a' }]);
    const op: Op = { type: 'renameVariable', name: 'a', newName: 'b' };
    expect(undoOps(run(before, [op]), before, [op])).toEqual([{ type: 'renameVariable', name: 'b', newName: 'a' }]);
  });

  it('works for generated graphs: deleting every step and undoing gives the graph back', () => {
    for (let seed = 1; seed <= 100; seed++) {
      const g0 = canonicalGraph(randomGraph(seed));
      const emptied = run(g0, g0.nodes.map((n): Op => ({ type: 'deleteNode', id: n.id })));
      expect(undoState(run(emptied, undoOps(emptied, g0))), `seed ${seed}`).toBe(undoState(g0));
    }
  });
});

describe('undoState', () => {
  it('ignores order, the name and bookkeeping, and sees content and places', () => {
    const g = canonicalGraph(FIXTURES.example);
    const shuffled: Graph = { ...g, name: 'Renamed', nodeSeq: 99, updatedAt: 'x', nodes: [...g.nodes].reverse().map((n) => ({ ...n, updatedBy: 'agent', updatedAt: 'y' })), edges: [...g.edges].reverse() };
    expect(undoState(shuffled)).toBe(undoState(g));
    expect(undoState(run(g, [{ type: 'moveNode', id: 'n1', position: { x: 9, y: 9 } }]))).not.toBe(undoState(g));
  });
});

describe('undo labels', () => {
  it('name each kind of action', () => {
    expect(undoLabel({ type: 'updateNode', id: 'n3', patch: { effort: 'high' } })).toBe('saved n3');
    expect(undoLabel({ type: 'deleteNode', id: 'n3' })).toBe('deleted n3');
    expect(undoLabel({ type: 'addNode', node: { id: 'n4', title: 'x', kind: 'agent' } })).toBe('added n4');
    expect(undoLabel({ type: 'connect', from: 'n1', to: 'n2' })).toBe('connected n1 → n2');
    expect(undoLabel({ type: 'setGoal', goal: 'g' })).toBe('edited the goal');
    expect(undoLabel({ type: 'renameVariable', name: 'a', newName: 'b' })).toBe('renamed variable a');
    expect(undoLabel({ type: 'acceptChange', target: { kind: 'all' } })).toBeUndefined();
    expect(movedLabel(['n3'])).toBe('moved n3');
    expect(movedLabel(['n1', 'n2'])).toBe('moved 2 steps');
    expect(deletedLabel(['n3'], [])).toBe('deleted n3');
    expect(deletedLabel(['n1', 'n2', 'n3'], [])).toBe('deleted 3 steps');
    expect(deletedLabel([], [{ from: 'n1', to: 'n2' }])).toBe('deleted the connection n1 → n2');
    expect(deletedLabel(['n4', 'n5'], [{ from: 'n1', to: 'n2' }])).toBe('deleted 2 steps and 1 connection');
  });
});
```

- [ ] **Step 2: Run the tests and see them fail**

Run: `npm test -w shared -- test/undo.test.ts && npm test -w engine -- test/undo.test.ts`
Expected: FAIL — the new modules, exports or behaviour do not exist yet (import errors or assertion failures).

- [ ] **Step 3: Implement**

Create `engine/src/undoStacks.ts`:

```ts
import { MAX_UNDO, undoState, type Graph, type Op } from '@agent-stream/shared';

/** One user action in a tab: the graph before and after it, its label, and the edits it was made of. */
export type UndoEntry = { before: Graph; after: Graph; label: string; ops: Op[] };

/**
 * Each tab's undo stack per graph (step model spec §6a.2), newest last, at most MAX_UNDO entries. In memory only: a tab
 * that closes takes its stacks with it, and an extension reload clears them all.
 */
export class UndoStacks {
  private stacks = new WeakMap<object, Map<string, UndoEntry[]>>();

  private stack(tab: object, graphId: string): UndoEntry[] {
    let byGraph = this.stacks.get(tab);
    if (!byGraph) this.stacks.set(tab, (byGraph = new Map()));
    let entries = byGraph.get(graphId);
    if (!entries) byGraph.set(graphId, (entries = []));
    return entries;
  }

  /** Records an action; one that changed nothing (a drop where the step already was) is not an undo step. */
  record(tab: object, graphId: string, entry: UndoEntry): boolean {
    if (undoState(entry.before) === undoState(entry.after)) return false;
    const entries = this.stack(tab, graphId);
    entries.push(entry);
    if (entries.length > MAX_UNDO) entries.splice(0, entries.length - MAX_UNDO);
    return true;
  }

  top(tab: object, graphId: string): UndoEntry | undefined {
    return this.stacks.get(tab)?.get(graphId)?.at(-1);
  }

  pop(tab: object, graphId: string): void {
    this.stacks.get(tab)?.get(graphId)?.pop();
  }

  clear(tab: object, graphId: string): void {
    this.stacks.get(tab)?.delete(graphId);
  }
}
```

Create `shared/src/undo.ts`:

```ts
import { diffToOps } from './diffToOps';
import type { GraphDoc } from './graphDoc';
import type { Graph, Op } from './types';

/** The most undo steps a tab keeps per graph (spec §6a.2). */
export const MAX_UNDO = 50;
export const TIDY_LABEL = 'tidied the layout';
export const MARKDOWN_SAVE_LABEL = 'saved the Markdown';
/** The longest label a tab may send with a batch of edits. */
export const MAX_UNDO_LABEL_CHARS = 200;

/** Toasts (spec §6a.2). */
export const NOTHING_TO_UNDO = 'Nothing to undo.';
export const UNDO_CHANGED = "Can't undo: the graph changed since (by the planner, a run, the file or another tab).";
export const undoneMessage = (label: string) => `Undid ${label}.`;
export const undoFileErrors = (graphId: string) => `Can't undo: ${graphId}.md has errors. Fix the file first.`;

/** JSON with object keys sorted, so two graphs built in different ways compare equal. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined);
    return `{${entries
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
const byKey = <T>(key: (x: T) => string) => (a: T, b: T) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);

/**
 * What undo compares (spec §6a.2): the graph's content and where its steps are, ignoring order (undo re-adds a deleted step
 * at the end), the name, and bookkeeping (who changed what, when, the id counter).
 */
export function undoState(g: Graph): string {
  return stable({
    goal: g.goal,
    instructions: g.instructions,
    variables: [...g.variables].sort(byKey((v) => v.name)),
    nodes: [...g.nodes].sort(byKey((n) => n.id)).map(({ createdBy: _c, updatedBy: _u, updatedAt: _a, ...n }) => n),
    edges: g.edges.map((e) => `${e.from}->${e.to}`).sort(),
  });
}

/** A graph as its Markdown file would state it, for diffToOps. */
export function graphAsDoc(g: Graph): GraphDoc {
  return {
    name: g.name,
    goal: g.goal,
    instructions: g.instructions,
    variables: g.variables.map((v) => ({ name: v.name, description: v.description, line: 1 })),
    steps: g.nodes.map(({ id, title, kind, access, workspace, timeoutSec, model, effort, description, prompt, command }) => ({
      id,
      title,
      kind,
      ...(access === 'read' && { access }),
      ...(workspace && { workspace }),
      ...(timeoutSec !== undefined && { timeoutSec }),
      ...(model && { model }),
      ...(effort && { effort }),
      ...(description && { description }),
      ...(prompt && { prompt }),
      ...(command && { command }),
      line: 1,
    })),
    edges: g.edges.map((e) => ({ from: e.from, to: e.to, line: 1 })),
  };
}

/**
 * The operations that take `current` back to `before` (spec §6a.2): diffToOps, then a move for every step whose place
 * differs (null puts a step back on the automatic layout). A variable rename is undone by renaming it back, so its saved
 * value and the steps that use it follow.
 */
export function undoOps(current: Graph, before: Graph, forward: readonly Op[] = []): Op[] {
  const only = forward.length === 1 ? forward[0] : undefined;
  if (only?.type === 'renameVariable') return [{ type: 'renameVariable', name: only.newName, newName: only.name }];
  const ops = diffToOps(current, graphAsDoc(before));
  const now = new Map(current.nodes.map((n) => [n.id, n.position]));
  for (const n of before.nodes) {
    const at = now.get(n.id);
    if (stable(at ?? null) !== stable(n.position ?? null)) ops.push({ type: 'moveNode', id: n.id, position: n.position ?? null });
  }
  return ops;
}

/** The label of one edit, as Edit › Undo and its toast name it. Reviews of agent changes are never undo steps. */
export function undoLabel(op: Op): string | undefined {
  switch (op.type) {
    case 'addNode':
      return op.node.id ? `added ${op.node.id}` : 'added a step';
    case 'updateNode':
      return `saved ${op.id}`;
    case 'deleteNode':
      return `deleted ${op.id}`;
    case 'connect':
      return `connected ${op.from} → ${op.to}`;
    case 'disconnect':
      return `disconnected ${op.from} → ${op.to}`;
    case 'moveNode':
      return `moved ${op.id}`;
    case 'setGoal':
      return 'edited the goal';
    case 'setInstructions':
      return 'edited the instructions';
    case 'addVariable':
      return `added variable ${op.name}`;
    case 'renameVariable':
      return `renamed variable ${op.name}`;
    case 'setVariableDescription':
      return `edited variable ${op.name}`;
    case 'deleteVariable':
      return `deleted variable ${op.name}`;
    case 'acceptChange':
    case 'revertChange':
      return undefined;
  }
}

/** One drag: `moved n3`, `moved 2 steps`. */
export const movedLabel = (ids: readonly string[]): string => (ids.length === 1 ? `moved ${ids[0]}` : `moved ${ids.length} steps`);

/** One delete of a selection: `deleted n3`, `deleted 3 steps`, `deleted the connection n1 → n2`, `deleted 2 steps and 1 connection`. */
export function deletedLabel(nodeIds: readonly string[], edges: readonly { from: string; to: string }[]): string {
  const steps = nodeIds.length === 1 ? nodeIds[0] : `${nodeIds.length} steps`;
  const links = edges.length === 1 ? '1 connection' : `${edges.length} connections`;
  if (!edges.length) return `deleted ${steps}`;
  if (!nodeIds.length) return edges.length === 1 ? `deleted the connection ${edges[0].from} → ${edges[0].to}` : `deleted ${links}`;
  return `deleted ${steps} and ${links}`;
}
```

Change `engine/src/app.ts`:

```diff
diff --git a/engine/src/app.ts b/engine/src/app.ts
--- a/engine/src/app.ts
+++ b/engine/src/app.ts
@@ -32,6 +32,14 @@ import {
   type SessionResult,
   type SessionTab,
   supportsEffort,
+  MARKDOWN_SAVE_LABEL,
+  NOTHING_TO_UNDO,
+  UNDO_CHANGED,
+  undoFileErrors,
+  undoLabel,
+  undoneMessage,
+  undoOps,
+  undoState,
   withStepModelLines,
 } from '@agent-stream/shared';
 import { ApprovalBroker } from './approvals';
@@ -49,6 +57,7 @@ import { createStepGate, STEP_GRAPH_TOOL_PREFIX } from './providers/toolGate';
 import type { AgentProvider } from './providers/types';
 import { previewRun, envLookup, type PreviewOutcome } from './runPreview';
 import { needsCheckoutLease, Runner } from './runner';
+import { UndoStacks } from './undoStacks';
 import { buildRunReport } from './runReport';
 import { RunStore } from './runStore';
 import { createStepGraphTools } from './stepGraphTools';
@@ -391,6 +400,7 @@ export function createApp(d: AppDeps) {
   /** The Markdown editor's Save (Graph | Markdown toggle): the store writes the text and reads it like an outside edit. */
   function saveGraphMarkdown(client: Client, msg: Extract<ClientMessage, { type: 'saveGraphMarkdown' }>): void {
     const { graphId } = msg;
+    const before = graphStore.load(graphId);
     let r: ReturnType<GraphStore['saveMarkdown']>;
     try {
       r = graphStore.saveMarkdown(graphId, msg.text, msg.base, msg.force);
@@ -399,6 +409,9 @@ export function createApp(d: AppDeps) {
     }
     if (!r.ok) return client.send({ type: 'graphMarkdownSaved', graphId, ok: false, ...('conflict' in r ? { conflict: true } : { error: r.error }) });
     fileSynced(graphId, r.sync);
+    // A save that changed the graph is one undo step in this tab (spec §6a.2).
+    const after = r.sync === 'applied' ? graphStore.load(graphId) : undefined;
+    if (before.ok && after?.ok) recordUndo(client, graphId, before.graph, after.graph, MARKDOWN_SAVE_LABEL, []);
     const errors = graphStore.fileErrors(graphId);
     client.send({ type: 'graphMarkdownSaved', graphId, ok: errors.length === 0, text: graphStore.markdownText(graphId), ...(errors.length > 0 && { errors }) });
   }
@@ -478,6 +491,42 @@ export function createApp(d: AppDeps) {
     return { type: 'graphOpened', graph, runs, run, variableValues: values.get(graph.id), ...review(graph.id), ...(fileErrors.length > 0 && { fileErrors }) };
   }
 
+  /** Each tab's undo stacks (spec §6a.2): a tab is the client it talks through. */
+  const undo = new UndoStacks();
+  function sendUndoState(client: Client, graphId: string): void {
+    const label = undo.top(client, graphId)?.label;
+    client.send({ type: 'undoState', graphId, ...(label !== undefined && { label }) });
+  }
+  function recordUndo(client: Client, graphId: string, before: Graph, after: Graph, label: string, ops: Op[]): void {
+    if (undo.record(client, graphId, { before, after, label, ops })) sendUndoState(client, graphId);
+  }
+  /**
+   * Edit › Undo: restores the graph from before this tab's newest action, as user edits recorded `via: 'undo'` — only when
+   * the graph is still as that action left it, so nobody else's change is ever discarded; otherwise the stack is cleared.
+   */
+  function undoLast(client: Client, graphId: string): void {
+    const done = (message: string) => {
+      client.send({ type: 'undone', graphId, message });
+      sendUndoState(client, graphId);
+    };
+    const entry = undo.top(client, graphId);
+    if (!entry) return done(NOTHING_TO_UNDO);
+    if (graphStore.fileErrors(graphId).length) return done(undoFileErrors(graphId));
+    const current = graphStore.load(graphId);
+    if (!current.ok) return done(current.error);
+    if (undoState(current.graph) !== undoState(entry.after)) {
+      undo.clear(client, graphId);
+      return done(UNDO_CHANGED);
+    }
+    const r = graphStore.applyBatch(graphId, undoOps(current.graph, entry.before, entry.ops), 'user', { via: 'undo' });
+    if (!r.ok) {
+      undo.clear(client, graphId);
+      return done(`Can't undo ${entry.label}: ${r.error}`);
+    }
+    undo.pop(client, graphId);
+    done(undoneMessage(entry.label));
+  }
+
   /** A revert would change a step that a run in progress is about to run or is running. */
   function revertBlockedByRun(graphId: string, op: Op): boolean {
     if (op.type !== 'revertChange') return false;
@@ -535,6 +584,7 @@ export function createApp(d: AppDeps) {
         if (!r.ok) return error(r.error);
         client.send(opened(r.graph));
         openedGraph(client);
+        sendUndoState(client, r.graph.id);
         return;
       }
       case 'createGraph': {
@@ -545,10 +595,27 @@ export function createApp(d: AppDeps) {
       }
       case 'op': {
         if (revertBlockedByRun(msg.graphId, msg.op)) return client.send({ type: 'opRejected', graphId: msg.graphId, error: 'Stop the run first.' });
+        const before = graphStore.load(msg.graphId);
         const r = graphStore.apply(msg.graphId, msg.op, 'user');
-        if (!r.ok) client.send({ type: 'opRejected', graphId: msg.graphId, error: r.error });
+        if (!r.ok) return client.send({ type: 'opRejected', graphId: msg.graphId, error: r.error });
+        const label = undoLabel(msg.op);
+        if (label && before.ok) recordUndo(client, msg.graphId, before.graph, r.graph, label, [msg.op]);
+        // Agent changes have their own Accept and Revert; a revert here changes the graph under this tab's undo steps.
+        if (msg.op.type === 'revertChange') {
+          undo.clear(client, msg.graphId);
+          sendUndoState(client, msg.graphId);
+        }
+        return;
+      }
+      case 'ops': {
+        const before = graphStore.load(msg.graphId);
+        const r = graphStore.applyBatch(msg.graphId, msg.ops, 'user');
+        if (!r.ok) return client.send({ type: 'opRejected', graphId: msg.graphId, error: r.error });
+        if (before.ok) recordUndo(client, msg.graphId, before.graph, r.graph, msg.label, msg.ops);
         return;
       }
+      case 'undo':
+        return undoLast(client, msg.graphId);
       case 'getGraphMarkdown': {
         const text = graphStore.markdownText(msg.graphId);
         if (text === undefined) return error(`graph "${msg.graphId}" not found`);
```

Change `engine/src/graphStore.ts`:

```diff
diff --git a/engine/src/graphStore.ts b/engine/src/graphStore.ts
--- a/engine/src/graphStore.ts
+++ b/engine/src/graphStore.ts
@@ -439,6 +439,44 @@ export class GraphStore extends EventEmitter {
     return { ok: true, graph: saved };
   }
 
+  /**
+   * Several edits that are one user action (a drag of several steps, deleting a selection, Tidy) or one undo (step model
+   * spec §6a.2): checked on a copy first, so they apply all or none, then applied with the baseline rules of single edits,
+   * saved once and recorded one by one (`via: 'undo'` for an undo). Moves alone are allowed while the file has errors.
+   */
+  applyBatch(graphId: string, ops: readonly Op[], by: Actor, o: { via?: 'undo' } = {}): GraphResult {
+    if (ops.some((op) => op.type === 'acceptChange' || op.type === 'revertChange')) return { ok: false, error: 'Agent changes are accepted or reverted one review at a time.' };
+    const current = this.load(graphId);
+    if (!current.ok) return current;
+    const broken = ops.every((op) => op.type === 'moveNode') ? null : this.brokenFile(graphId);
+    if (broken) return { ok: false, error: broken };
+    if (!ops.length) return current;
+    const at = this.clock();
+    let draft = current.graph;
+    for (const op of ops) {
+      const resolved: Op = op.type === 'addNode' && !op.node.id ? { ...op, node: { ...op.node, id: nextNodeId(draft) } } : op;
+      const r = applyOp(draft, resolved, by, at, { rewriteReferences: renameReferences });
+      if (!r.ok) return r;
+      draft = r.graph;
+    }
+    let graph = current.graph;
+    const applied: Op[] = [];
+    for (const op of ops) {
+      const r = this.applyOne(graph, op, by, at);
+      // The same edits just succeeded on a copy; only I/O (writeBaseline) can fail here, and then nothing is saved.
+      if (!r.ok) throw new Error(r.error);
+      graph = r.graph;
+      applied.push(r.op);
+    }
+    const saved = this.save(graph);
+    const edits = applied.filter((op) => op.type !== 'moveNode');
+    if (edits.length) this.dropBaselineIfSame(saved);
+    for (const op of edits) this.record(graphId, { at, by, op, ...(o.via && { via: o.via }) });
+    this.emit('changed', saved);
+    for (const op of applied) this.emit('op', graphId, op, o.via);
+    return { ok: true, graph: saved };
+  }
+
   /** One edit on `current`, keeping the baseline rules; saves nothing. Returns the op as recorded: an added step gets its id. */
   private applyOne(current: Graph, op: Op, by: Actor, at: string): { ok: true; graph: Graph; op: Op } | { ok: false; error: string } {
     const resolved: Op = op.type === 'addNode' && !op.node.id ? { ...op, node: { ...op.node, id: nextNodeId(current) } } : op;
```

Change `shared/src/graph.ts`:

```diff
diff --git a/shared/src/graph.ts b/shared/src/graph.ts
--- a/shared/src/graph.ts
+++ b/shared/src/graph.ts
@@ -200,7 +200,12 @@ export function applyOp(graph: Graph, op: Op, by: Actor, now: string, options: A
     }
     case 'moveNode': {
       if (!has(op.id)) return fail(`node ${op.id} does not exist`);
-      return done({ nodes: graph.nodes.map((n) => (n.id === op.id ? { ...n, position: op.position } : n)) });
+      const place = (n: GraphNode): GraphNode => {
+        if (op.position) return { ...n, position: op.position };
+        const { position: _position, ...rest } = n;
+        return rest;
+      };
+      return done({ nodes: graph.nodes.map((n) => (n.id === op.id ? place(n) : n)) });
     }
     case 'acceptChange':
     case 'revertChange':
```

Change `shared/src/index.ts`:

```diff
diff --git a/shared/src/index.ts b/shared/src/index.ts
--- a/shared/src/index.ts
+++ b/shared/src/index.ts
@@ -17,3 +17,4 @@ export * from './graphMeta';
 export * from './graphMarkdownWrite';
 export * from './diffToOps';
 export * from './stepModels';
+export * from './undo';
```

Change `shared/src/schemas.ts`:

```diff
diff --git a/shared/src/schemas.ts b/shared/src/schemas.ts
--- a/shared/src/schemas.ts
+++ b/shared/src/schemas.ts
@@ -2,6 +2,7 @@ import { z } from 'zod';
 import { COMMAND_ALWAYS_WRITES, workspaceNameProblem } from './access';
 import { legacyNodeIdProblem, topoOrder } from './graph';
 import { MAX_MODEL_ID_CHARS, ONLY_AGENT_STEPS_MODEL } from './stepModels';
+import { MAX_UNDO_LABEL_CHARS } from './undo';
 import { MAX_VARIABLE_VALUE_CHARS, variableNameProblem } from './variables';
 import { EFFORT_LEVELS, MAX_IMPORT_CHARS, PROVIDER_IDS, type ClientMessage, type Graph, type GraphResult, type WebviewHostMessage } from './types';
 
@@ -132,6 +133,8 @@ const clientMessageSchema = z.discriminatedUnion('type', [
   z.object({ type: z.literal('openGraph'), graphId: z.string() }),
   z.object({ type: z.literal('createGraph'), name: z.string().min(1) }),
   z.object({ type: z.literal('op'), graphId: z.string(), op: opSchema }),
+  z.object({ type: z.literal('ops'), graphId: z.string(), ops: z.array(opSchema).min(1).max(500), label: z.string().min(1).max(MAX_UNDO_LABEL_CHARS) }),
+  z.object({ type: z.literal('undo'), graphId: z.string() }),
   z.object({ type: z.literal('getGraphMarkdown'), graphId: z.string() }),
   z.object({ type: z.literal('saveGraphMarkdown'), graphId: z.string(), text: markdownText, base: markdownText, force: z.boolean().optional() }),
   z.object({ type: z.literal('openChat'), graphId: z.string(), sessionId: z.string() }),
```

Change `shared/src/types.ts`:

```diff
diff --git a/shared/src/types.ts b/shared/src/types.ts
--- a/shared/src/types.ts
+++ b/shared/src/types.ts
@@ -92,7 +92,8 @@ export type Op =
   | { type: 'renameVariable'; name: string; newName: string }
   | { type: 'setVariableDescription'; name: string; description: string }
   | { type: 'deleteVariable'; name: string }
-  | { type: 'moveNode'; id: string; position: Position }
+  /** `position: null` puts the step back on the automatic layout (only undo does that; clients always send a position). */
+  | { type: 'moveNode'; id: string; position: Position | null }
   /** Review of agent changes (agent changes spec §3.4): applied by the graph store, which keeps the baseline. */
   | { type: 'acceptChange'; target: ChangeTarget }
   | { type: 'revertChange'; target: ChangeTarget };
@@ -100,8 +101,11 @@ export type Op =
 /** Which agent made an edit: the planner (in a work session) or an agent step during a run. */
 export type ChangeSource = { kind: 'planner'; sessionId?: string } | { kind: 'step'; runId: string; nodeId: string };
 
-/** `via: 'file'`: the edit came from the graph's Markdown file (Markdown graph files spec §6.3). A history label only. */
-export type OpRecord = { at: string; by: Actor; op: Op; source?: ChangeSource; via?: 'file' };
+/**
+ * `via: 'file'`: the edit came from the graph's Markdown file (Markdown graph files spec §6.3); `via: 'undo'`: Edit › Undo
+ * made it (step model spec §6a.2). A history label only.
+ */
+export type OpRecord = { at: string; by: Actor; op: Op; source?: ChangeSource; via?: 'file' | 'undo' };
 
 /** One problem in a graph's Markdown file: its 1-based line and a message that says how to fix it. */
 export type GraphFileError = { line: number; message: string };
@@ -374,12 +378,20 @@ export type ServerMessage =
   | { type: 'runBlocked'; graphId: string; message: string; holder: LeaseHolder; otherWindow: boolean; checkout: CheckoutInfo; canSetUpTickets: boolean }
   /** The Markdown run report asked for with exportRunReport, and the file name to suggest when saving it. */
   | { type: 'runReport'; runId: string; markdown: string; suggestedName: string }
+  /** What Edit › Undo would undo in this tab (absent: nothing): after the graph opens, and after each edit or undo here. */
+  | { type: 'undoState'; graphId: string; label?: string }
+  /** The answer to undo, for the toast: `Undid moved 2 steps.`, `Nothing to undo.`, or why it can't. */
+  | { type: 'undone'; graphId: string; message: string }
   | { type: 'error'; message: string };
 
 export type ClientMessage =
   | { type: 'openGraph'; graphId: string }
   | { type: 'createGraph'; name: string }
   | { type: 'op'; graphId: string; op: Op }
+  /** Several edits that are one user action (a drag of several steps, deleting a selection, Tidy): applied all or none, one undo step named `label`. */
+  | { type: 'ops'; graphId: string; ops: Op[]; label: string }
+  /** Edit › Undo (⌘Z): reverses this tab's newest graph edit, if the graph is still as that edit left it. */
+  | { type: 'undo'; graphId: string }
   /** Asks for the graph's Markdown file as it is on disk; the engine answers with graphMarkdown and keeps sending it as the text changes. */
   | { type: 'getGraphMarkdown'; graphId: string }
   /**
```

Change `web/src/state.ts`:

```diff
diff --git a/web/src/state.ts b/web/src/state.ts
--- a/web/src/state.ts
+++ b/web/src/state.ts
@@ -101,6 +101,8 @@ export type State = {
   /** Each tab keeps its own (webview state); never saved in the graph or the session. */
   canvasMode: CanvasMode;
   markdown: MarkdownEditorState;
+  /** What Edit › Undo would undo in this tab, as the engine names it; undefined: nothing (step model spec §6a.2). */
+  undoLabel?: string;
 };
 
 function confirmRequest(msg: ConfirmRequest): ConfirmRequest {
@@ -248,7 +250,7 @@ function reduceServer(state: State, msg: HostMessage): State {
         ...state,
         ...reviewing(state, msg.changes),
         // Another graph's review (a picked change, a pending Accept all) doesn't carry over.
-        ...(current !== msg.graph.id && { selectedChange: undefined, changeConfirm: undefined, blocked: undefined, markdown: initialMarkdown }),
+        ...(current !== msg.graph.id && { selectedChange: undefined, changeConfirm: undefined, blocked: undefined, markdown: initialMarkdown, undoLabel: undefined }),
         graph: msg.graph,
         graphGone: false,
         fileErrors: msg.fileErrors ?? [],
@@ -345,6 +347,10 @@ function reduceServer(state: State, msg: HostMessage): State {
     case 'runReport':
       // The extension saves the report itself; a tab has nothing to show.
       return state;
+    case 'undoState':
+      return msg.graphId === current ? { ...state, undoLabel: msg.label } : state;
+    case 'undone':
+      return msg.graphId === current ? { ...state, toast: msg.message } : state;
     case 'error':
       // A save the engine or the extension refused before it could answer (a message too large, a throw) is over too.
       return { ...state, toast: msg.message, ...(state.markdown.saving && { markdown: { ...state.markdown, saving: undefined } }) };
```

- [ ] **Step 4: Run the tests and typecheck**

Run: `npm test -w shared -- test/undo.test.ts && npm test -w engine -- test/undo.test.ts`
Expected: PASS.
Run: `npm run typecheck && npm test`
Expected: all workspaces pass (a test that times out only under heavy machine load is not a failure of this task: run it again).

- [ ] **Step 5: Commit**

```bash
git add engine/src/app.ts engine/src/graphStore.ts engine/src/undoStacks.ts engine/test/undo.test.ts shared/src/graph.ts shared/src/index.ts shared/src/schemas.ts shared/src/types.ts shared/src/undo.ts shared/test/undo.test.ts web/src/state.ts
git commit -m "feat: per-tab undo of graph edits in the engine" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 10: ⌘S and ⌘Z in the graph tab, File › Save, Edit › Undo, one action one undo step

**Spec covered:** §6a.1, §6a.2 (text fields keep their own undo, menus, batching), §7 keyboard tests.

**Files:**
- Create: `web/src/shortcuts.ts`
- Modify: `web/src/App.tsx`, `web/src/actions.ts`, `web/src/components/Canvas.tsx`, `web/src/components/GraphPanel.tsx`, `web/src/components/MenuBar.tsx`, `web/src/components/NodePanel.tsx`, `web/src/components/VariablesDialog.tsx`, `web/src/menuModel.ts`, `web/src/selection.ts`, `web/src/state.ts`, `web/src/styles.css`
- Test: `web/test/shortcuts.test.ts` (new), `web/test/MenuBar.test.ts`, `web/test/VariablesDialog.test.ts`, `web/test/menuModel.test.ts`

**Interfaces:**
- Consumes: Task 9's messages and labels.
- Produces: `actions.save()`, `actions.undo()`, `registerNodeDraft(d: NodeDraft): () => void`, `sendEdit(graphId, ops, label)`, toast constants in `web/src/actions.ts`; `CanvasActions.flushMoves()`; `web/src/shortcuts.ts` (`MOD`, `isTextField`, `onShortcutKey`); `MenuAction.shortcut?`; `deletionEdit(nodeIds, edges)` in `web/src/selection.ts`.

- [ ] **Step 1: Write the failing tests**

Create `web/test/shortcuts.test.ts`:

```ts
// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyGraph, type Graph } from '@agent-stream/shared';

vi.mock('../src/bridge', () => ({ send: vi.fn(), sendHost: vi.fn(), post: vi.fn() }));
const { send } = await import('../src/bridge');
const { dispatch, getState } = await import('../src/store');
const { NodePanel } = await import('../src/components/NodePanel');
const { onShortcutKey } = await import('../src/shortcuts');
const { buildMenus } = await import('../src/menuModel');
const { actions } = await import('../src/actions');
const { deletionEdit } = await import('../src/selection');
const { GraphPanel } = await import('../src/components/GraphPanel');
type MenuAction = import('../src/menuModel').MenuAction;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const step = { id: 'n1', title: 'Plan', kind: 'agent' as const, prompt: 'p', createdBy: 'user' as const, updatedBy: 'user' as const, updatedAt: 't', position: { x: 0, y: 0 } };
const graph: Graph = { ...emptyGraph('g', 'G', 't'), nodes: [step, { ...step, id: 'n2', title: 'Two', position: undefined }] };
let el: HTMLDivElement;
let root: Root;

/** ⌘ + key (or Ctrl), sent at `target` and bubbling to the document, as a keypress in the tab would. */
function press(key: string, target: EventTarget = document.body, o: { ctrl?: boolean; shift?: boolean } = {}): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { key, metaKey: !o.ctrl, ctrlKey: !!o.ctrl, shiftKey: !!o.shift, bubbles: true, cancelable: true });
  act(() => void target.dispatchEvent(e));
  return e;
}
function type(field: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = field instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(field, value);
  field.dispatchEvent(new Event('input', { bubbles: true }));
}
const menuItem = (menu: string, label: string) => buildMenus(getState()).find((m) => m.id === menu)!.items.find((i): i is MenuAction => 'label' in i && i.label.startsWith(label))!;

beforeEach(async () => {
  dispatch({ kind: 'server', msg: { type: 'hello', status: { provider: 'claude', ok: true, label: 'Claude Max' }, project: '/p', graphs: [], approvals: [] } });
  dispatch({ kind: 'server', msg: { type: 'graphOpened', changes: [], graph, runs: [], variableValues: {} } });
  dispatch({ kind: 'server', msg: { type: 'graphFileErrors', graphId: 'g', errors: [] } });
  dispatch({ kind: 'setCanvasMode', mode: 'graph' });
  dispatch({ kind: 'dismissToast' });
  dispatch({ kind: 'selectNode', id: 'n1' });
  document.addEventListener('keydown', onShortcutKey);
  el = document.createElement('div');
  document.body.appendChild(el);
  root = createRoot(el);
  await act(async () => root.render(createElement(NodePanel)));
  vi.mocked(send).mockClear();
});
afterEach(async () => {
  document.removeEventListener('keydown', onShortcutKey);
  await act(async () => root.unmount());
  el.remove();
});

describe('⌘S (spec §6a.1)', () => {
  it('saves the open step’s draft as Save does, from inside its text fields, with a toast', async () => {
    const title = el.querySelector('input') as HTMLInputElement;
    await act(async () => type(title, 'Plan more'));
    const e = press('s', title);
    expect(e.defaultPrevented).toBe(true);
    expect(vi.mocked(send).mock.calls).toEqual([[{ type: 'op', graphId: 'g', op: { type: 'updateNode', id: 'n1', patch: { title: 'Plan more' } } }]]);
    expect(getState().toast).toBe('Step n1 saved.');
  });

  it('with nothing unsaved, says the graph is saved; Ctrl works as ⌘ does', () => {
    press('s', document.body, { ctrl: true });
    expect(send).not.toHaveBeenCalled();
    expect(getState().toast).toBe('Graph saved.');
  });

  it('keeps the draft while the file has errors, and says why', async () => {
    dispatch({ kind: 'server', msg: { type: 'graphFileErrors', graphId: 'g', errors: [{ line: 3, message: 'x' }] } });
    const title = el.querySelector('input') as HTMLInputElement;
    await act(async () => type(title, 'Plan more'));
    press('s', title);
    expect(send).not.toHaveBeenCalled();
    expect(getState().toast).toBe("Can't save: g.md has errors. Fix the file first.");
    expect((el.querySelector('input') as HTMLInputElement).value).toBe('Plan more');
  });

  it('in Markdown mode saves the Markdown, and says Saved. when it saved without errors', () => {
    dispatch({ kind: 'setCanvasMode', mode: 'markdown' });
    dispatch({ kind: 'server', msg: { type: 'graphMarkdown', graphId: 'g', text: '# G\n' } });
    dispatch({ kind: 'markdownEdited', text: '# G2\n', from: '# G\n' });
    press('s');
    expect(vi.mocked(send).mock.calls).toEqual([[{ type: 'saveGraphMarkdown', graphId: 'g', text: '# G2\n', base: '# G\n' }]]);
    dispatch({ kind: 'server', msg: { type: 'graphMarkdownSaved', graphId: 'g', ok: true, text: '# G2\n' } });
    expect(getState().toast).toBe('Saved.');
    dispatch({ kind: 'dismissToast' });
    dispatch({ kind: 'server', msg: { type: 'graphMarkdownSaved', graphId: 'g', ok: false, text: '# G2\n', errors: [{ line: 1, message: 'x' }] } });
    expect(getState().toast).toBeUndefined();
  });

  it('File › Save does the same', async () => {
    const title = el.querySelector('input') as HTMLInputElement;
    await act(async () => type(title, 'Saved from the menu'));
    const save = menuItem('file', 'Save');
    expect(save.shortcut).toMatch(/^(⌘|Ctrl\+)S$/);
    act(() => save.run());
    expect(vi.mocked(send).mock.calls[0][0]).toMatchObject({ type: 'op', op: { type: 'updateNode', patch: { title: 'Saved from the menu' } } });
    expect(getState().toast).toBe('Step n1 saved.');
  });
});

describe('⌘Z (spec §6a.2)', () => {
  it('asks the engine to undo, and shows its answer', () => {
    const e = press('z');
    expect(e.defaultPrevented).toBe(true);
    expect(vi.mocked(send).mock.calls).toEqual([[{ type: 'undo', graphId: 'g' }]]);
    dispatch({ kind: 'server', msg: { type: 'undone', graphId: 'g', message: 'Undid moved 2 steps.' } });
    expect(getState().toast).toBe('Undid moved 2 steps.');
  });

  it('is the field’s own text undo inside a text field, and ⇧⌘Z does nothing here', () => {
    const prompt = el.querySelector('textarea') as HTMLTextAreaElement;
    expect(press('z', prompt).defaultPrevented).toBe(false);
    expect(press('z', el.querySelector('input')!).defaultPrevented).toBe(false);
    expect(press('z', document.body, { shift: true }).defaultPrevented).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it('Edit › Undo names what it undoes, and is disabled with nothing to undo', () => {
    expect(menuItem('edit', 'Undo')).toMatchObject({ label: 'Undo', enabled: false });
    dispatch({ kind: 'server', msg: { type: 'undoState', graphId: 'g', label: 'moved 2 steps' } });
    const undo = menuItem('edit', 'Undo');
    expect(undo).toMatchObject({ label: 'Undo moved 2 steps', enabled: true });
    expect(undo.shortcut).toMatch(/^(⌘|Ctrl\+)Z$/);
    act(() => undo.run());
    expect(vi.mocked(send).mock.calls).toEqual([[{ type: 'undo', graphId: 'g' }]]);
    dispatch({ kind: 'server', msg: { type: 'undoState', graphId: 'g' } });
    expect(menuItem('edit', 'Undo').enabled).toBe(false);
  });
});

describe('one action, one undo step', () => {
  it('Tidy sends its moves as one edit', () => {
    actions.tidy();
    const calls = vi.mocked(send).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toMatchObject({ type: 'ops', graphId: 'g', label: 'tidied the layout' });
  });

  it('the Graph panel’s Save of the goal and the instructions is one edit', async () => {
    const panel = document.createElement('div');
    const r = createRoot(panel);
    await act(async () => r.render(createElement(GraphPanel)));
    await act(async () => type(panel.querySelector('#graph-goal') as HTMLInputElement, 'New goal'));
    await act(async () => type(panel.querySelector('#graph-instructions') as HTMLTextAreaElement, 'New instructions'));
    await act(async () => ([...panel.querySelectorAll('button')].find((b) => b.textContent === 'Save') as HTMLButtonElement).click());
    expect(vi.mocked(send).mock.calls).toEqual([
      [{ type: 'ops', graphId: 'g', ops: [{ type: 'setGoal', goal: 'New goal' }, { type: 'setInstructions', instructions: 'New instructions' }], label: 'edited the goal and instructions' }],
    ]);
    await act(async () => r.unmount());
  });

  it('deleting a selection is one edit with its label', () => {
    expect(deletionEdit(['n1', 'n2'], [{ id: 'e', source: 'n3', target: 'n4' }])).toEqual({
      ops: [{ type: 'disconnect', from: 'n3', to: 'n4' }, { type: 'deleteNode', id: 'n1' }, { type: 'deleteNode', id: 'n2' }],
      label: 'deleted 2 steps and 1 connection',
    });
  });
});
```

Change `web/test/MenuBar.test.ts` (named exception: the Edit menu starts with Undo):

```diff
diff --git a/web/test/MenuBar.test.ts b/web/test/MenuBar.test.ts
--- a/web/test/MenuBar.test.ts
+++ b/web/test/MenuBar.test.ts
@@ -35,7 +35,7 @@ describe('MenuBar', () => {
     await act(async () => title('File').click());
     expect(openItems()).toContain('New graph…');
     await act(async () => title('Edit').dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
-    expect(openItems()).toEqual(['Add step', 'Delete selected step', 'Tidy layout', 'Refine selected step', 'Split selected step', 'Refine steps you changed (0)', 'Review agent changes…', 'Accept all agent changes', 'Revert all agent changes']);
+    expect(openItems()).toEqual(['Undo', 'Add step', 'Delete selected step', 'Tidy layout', 'Refine selected step', 'Split selected step', 'Refine steps you changed (0)', 'Review agent changes…', 'Accept all agent changes', 'Revert all agent changes']);
     await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
     expect(openItems()).toEqual([]);
     await act(async () => title('Run').click());
```

Change `web/test/VariablesDialog.test.ts` (named exception: a Save with several edits is one `ops` message):

```diff
diff --git a/web/test/VariablesDialog.test.ts b/web/test/VariablesDialog.test.ts
--- a/web/test/VariablesDialog.test.ts
+++ b/web/test/VariablesDialog.test.ts
@@ -63,8 +63,17 @@ describe('VariablesDialog', () => {
     await act(async () => typeInto(inputs('Description')[0], 'Where to build'));
     await act(async () => button('Save').click());
     expect(vi.mocked(send).mock.calls).toEqual([
-      [{ type: 'op', graphId: 'g', op: { type: 'renameVariable', name: 'schema', newName: 'target_schema' } }],
-      [{ type: 'op', graphId: 'g', op: { type: 'setVariableDescription', name: 'target_schema', description: 'Where to build' } }],
+      [
+        {
+          type: 'ops',
+          graphId: 'g',
+          ops: [
+            { type: 'renameVariable', name: 'schema', newName: 'target_schema' },
+            { type: 'setVariableDescription', name: 'target_schema', description: 'Where to build' },
+          ],
+          label: 'edited the variables',
+        },
+      ],
     ]);
   });
 
@@ -76,8 +85,7 @@ describe('VariablesDialog', () => {
     await act(async () => (container.querySelector('button[aria-label="Delete schema"]') as HTMLButtonElement).click());
     await act(async () => button('Save').click());
     expect(vi.mocked(send).mock.calls).toEqual([
-      [{ type: 'op', graphId: 'g', op: { type: 'deleteVariable', name: 'schema' } }],
-      [{ type: 'op', graphId: 'g', op: { type: 'addVariable', name: 'model' } }],
+      [{ type: 'ops', graphId: 'g', ops: [{ type: 'deleteVariable', name: 'schema' }, { type: 'addVariable', name: 'model' }], label: 'edited the variables' }],
       [{ type: 'setVariableValue', graphId: 'g', name: 'model', value: 'orders_v2' }],
     ]);
   });
@@ -125,8 +133,7 @@ describe('VariablesDialog', () => {
       await act(async () => typeInto(inputs('Value')[0], 'x'));
       await act(async () => button('Save').click());
       expect(vi.mocked(send).mock.calls).toEqual([
-        [{ type: 'op', graphId: 'g', op: { type: 'deleteVariable', name: 'schema' } }],
-        [{ type: 'op', graphId: 'g', op: { type: 'addVariable', name: 'schema' } }],
+        [{ type: 'ops', graphId: 'g', ops: [{ type: 'deleteVariable', name: 'schema' }, { type: 'addVariable', name: 'schema' }], label: 'edited the variables' }],
         [{ type: 'setVariableValue', graphId: 'g', name: 'schema', value: 'x' }],
       ]);
     });
```

Change `web/test/menuModel.test.ts` (named exception: the File menu has Save):

```diff
diff --git a/web/test/menuModel.test.ts b/web/test/menuModel.test.ts
--- a/web/test/menuModel.test.ts
+++ b/web/test/menuModel.test.ts
@@ -36,6 +36,7 @@ describe('menus', () => {
       ['New graph…', true],
       ['Open…', true],
       ['Import…', true],
+      ['Save', true],
       ['Export…', true],
       ['Open as Markdown', true],
       ['Rename…', true],
```

- [ ] **Step 2: Run the tests and see them fail**

Run: `npm test -w web -- test/shortcuts.test.ts test/MenuBar.test.ts test/menuModel.test.ts test/VariablesDialog.test.ts test/GraphPanel.test.ts`
Expected: FAIL — the new modules, exports or behaviour do not exist yet (import errors or assertion failures).

- [ ] **Step 3: Implement**

Create `web/src/shortcuts.ts`:

```ts
import { actions } from './actions';

/** ⌘ on macOS, Ctrl elsewhere: how menus show the graph tab's shortcuts. */
export const MOD = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform ?? '') ? '⌘' : 'Ctrl+';

/** A field with its own text undo: ⌘Z there undoes typing, not graph edits (spec §6a.2). */
export function isTextField(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.tagName !== 'string') return false;
  return el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA';
}

/**
 * The graph tab's ⌘S and ⌘Z (Ctrl on Windows and Linux), wherever focus is in the tab (spec §6a). A key a field already
 * handled (the Markdown editor's own ⌘S) is left alone.
 */
export function onShortcutKey(e: KeyboardEvent): void {
  if (e.defaultPrevented || e.altKey || e.shiftKey || !(e.metaKey || e.ctrlKey)) return;
  const key = e.key.toLowerCase();
  if (key === 's') {
    e.preventDefault();
    actions.save();
  } else if (key === 'z' && !isTextField(e.target)) {
    e.preventDefault();
    actions.undo();
  }
}
```

Change `web/src/App.tsx`:

```diff
diff --git a/web/src/App.tsx b/web/src/App.tsx
--- a/web/src/App.tsx
+++ b/web/src/App.tsx
@@ -1,3 +1,4 @@
+import { useEffect } from 'react';
 import { CanvasArea } from './components/CanvasArea';
 import { ChangeConfirmDialog } from './components/ChangeConfirmDialog';
 import { GraphFileNotice } from './components/GraphFileNotice';
@@ -7,10 +8,15 @@ import { RunConfirmDialog } from './components/RunConfirmDialog';
 import { Toast } from './components/Toast';
 import { TopBar } from './components/TopBar';
 import { VariablesDialog } from './components/VariablesDialog';
+import { onShortcutKey } from './shortcuts';
 import { useStore } from './store';
 
 export function App() {
   const status = useStore((s) => s.status);
+  useEffect(() => {
+    document.addEventListener('keydown', onShortcutKey);
+    return () => document.removeEventListener('keydown', onShortcutKey);
+  }, []);
   return (
     <div className="app">
       <TopBar />
```

Change `web/src/actions.ts`:

```diff
diff --git a/web/src/actions.ts b/web/src/actions.ts
--- a/web/src/actions.ts
+++ b/web/src/actions.ts
@@ -1,4 +1,4 @@
-import { MAX_IMPORT_CHARS, type ApprovalRequest, type ChangeTarget, type HostCommand } from '@agent-stream/shared';
+import { MAX_IMPORT_CHARS, TIDY_LABEL, type ApprovalRequest, type ChangeTarget, type HostCommand, type Op } from '@agent-stream/shared';
 import { post, send, sendHost } from './bridge';
 import { layoutPositions, type NodeSize } from './layout';
 import { persistLayout } from './panelLayout';
@@ -6,12 +6,35 @@ import type { CanvasMode, State, Tab } from './state';
 import { dispatch, getState } from './store';
 
 /** Actions that need the canvas viewport; the Canvas registers them while it is mounted. */
-type CanvasActions = { addStepInView(): void; measuredSizes(): Map<string, NodeSize> };
+type CanvasActions = { addStepInView(): void; measuredSizes(): Map<string, NodeSize>; flushMoves(): void };
 let canvas: CanvasActions | undefined;
 export function registerCanvas(c: CanvasActions | undefined): void {
   canvas = c;
 }
 
+/** The Node panel's open step and its unsaved edits, for ⌘S (step model spec §6a.1); the panel registers it while it shows a step. */
+export type NodeDraft = { nodeId: string; dirty(): boolean; save(): void };
+let nodeDraft: NodeDraft | undefined;
+/** Registers the open step's draft; the returned function unregisters it (if it is still the one registered). */
+export function registerNodeDraft(d: NodeDraft): () => void {
+  nodeDraft = d;
+  return () => {
+    if (nodeDraft === d) nodeDraft = undefined;
+  };
+}
+
+/** Sends edits that are one user action as one undo step (spec §6a.2); a single edit goes as it is. */
+export function sendEdit(graphId: string, ops: Op[], label: string): void {
+  if (ops.length === 1) send({ type: 'op', graphId, op: ops[0] });
+  else if (ops.length > 1) send({ type: 'ops', graphId, ops, label });
+}
+
+/** The toasts of ⌘S (spec §6a.1). */
+export const stepSavedToast = (id: string) => `Step ${id} saved.`;
+export const GRAPH_SAVED = 'Graph saved.';
+export const MARKDOWN_SAVED = 'Saved.';
+export const cantSaveToast = (graphId: string) => `Can't save: ${graphId}.md has errors. Fix the file first.`;
+
 /** This graph's pending approvals: Run › Approve all acts on these only; the sidebar's covers every graph. */
 export function graphApprovals(s: State): ApprovalRequest[] {
   const id = s.graph?.id;
@@ -35,7 +58,32 @@ export const actions = {
   tidy(): void {
     const { graph } = getState();
     if (!graph) return;
-    for (const [id, position] of layoutPositions(graph, false, canvas?.measuredSizes())) send({ type: 'op', graphId: graph.id, op: { type: 'moveNode', id, position } });
+    const ops: Op[] = [...layoutPositions(graph, false, canvas?.measuredSizes())].map(([id, position]) => ({ type: 'moveNode', id, position }));
+    // One undo step for the whole layout, even for a single step.
+    if (ops.length) send({ type: 'ops', graphId: graph.id, ops, label: TIDY_LABEL });
+  },
+  /**
+   * File › Save and ⌘S (spec §6a.1). Markdown mode saves the Markdown. Graph mode saves the open step's unsaved edits as
+   * its Save button does, or, with none, sends any move not confirmed yet: everything else is saved as it happens.
+   */
+  save(): void {
+    const s = getState();
+    if (!s.graph) return;
+    if (s.canvasMode === 'markdown') return actions.saveMarkdown();
+    if (nodeDraft?.dirty()) {
+      // The file has errors: the edit would be refused (R6), so the draft stays as it is.
+      if (s.fileErrors.length) return dispatch({ kind: 'showToast', message: cantSaveToast(s.graph.id) });
+      const id = nodeDraft.nodeId;
+      nodeDraft.save();
+      return dispatch({ kind: 'showToast', message: stepSavedToast(id) });
+    }
+    canvas?.flushMoves();
+    dispatch({ kind: 'showToast', message: GRAPH_SAVED });
+  },
+  /** Edit › Undo and ⌘Z: the engine undoes this tab's newest graph edit and answers with a toast. */
+  undo(): void {
+    const { graph } = getState();
+    if (graph) send({ type: 'undo', graphId: graph.id });
   },
   run(): void {
     dispatch({ kind: 'openConfirm', request: {} });
```

Change `web/src/components/Canvas.tsx`:

```diff
diff --git a/web/src/components/Canvas.tsx b/web/src/components/Canvas.tsx
--- a/web/src/components/Canvas.tsx
+++ b/web/src/components/Canvas.tsx
@@ -14,12 +14,12 @@ import {
   type OnDelete,
   type XYPosition,
 } from '@xyflow/react';
-import { nextNodeId, type Op, type Position } from '@agent-stream/shared';
+import { movedLabel, nextNodeId, type Op, type Position } from '@agent-stream/shared';
 import { changeKey } from '../changeLabels';
 import { buildFlowEdges, buildFlowNodes, GHOST_PREFIX } from '../flowNodes';
 import type { NodeSize } from '../layout';
-import { addsToSelection, deletionOps, MULTI_SELECT_KEYS, selectedForDelete } from '../selection';
-import { actions, registerCanvas } from '../actions';
+import { addsToSelection, deletionEdit, MULTI_SELECT_KEYS, selectedForDelete } from '../selection';
+import { actions, registerCanvas, sendEdit } from '../actions';
 import { send } from '../bridge';
 import { contentSignature } from '../state';
 import { dispatch, useStore } from '../store';
@@ -92,8 +92,10 @@ export function Canvas() {
     for (const n of getNodes()) if (n.measured?.width && n.measured.height) sizes.set(n.id, { width: n.measured.width, height: n.measured.height });
     return sizes;
   });
+  // ⌘S sends again any move the engine hasn't confirmed yet (spec §6a.1); a move that already landed changes nothing.
+  const flushMoves = useRef(() => {});
   useEffect(() => {
-    registerCanvas({ addStepInView: () => addInView.current(), measuredSizes: () => measuredSizes.current() });
+    registerCanvas({ addStepInView: () => addInView.current(), measuredSizes: () => measuredSizes.current(), flushMoves: () => flushMoves.current() });
     return () => registerCanvas(undefined);
   }, []);
 
@@ -111,9 +113,16 @@ export function Canvas() {
     if (r) addAt(screenToFlowPosition({ x: r.left + r.width / 2, y: r.top + r.height / 2 }));
   };
   addInView.current = addInCenter;
-  const onDelete: OnDelete<StepFlowNode, FlowEdge> = ({ nodes: deleted, edges: removed }) => deletionOps(deleted.map((n) => n.id), removed).forEach(op);
+  const moves = (list: [string, Position][]) => sendEdit(graphId, list.map(([id, position]): Op => ({ type: 'moveNode', id, position })), movedLabel(list.map(([id]) => id)));
+  flushMoves.current = () => moves([...pendingMoves.current]);
+  // Deleting a selection is one action, so one undo step (spec §6a.2).
+  const remove = (nodeIds: string[], removed: FlowEdge[]) => {
+    const edit = deletionEdit(nodeIds, removed);
+    sendEdit(graphId, edit.ops, edit.label);
+  };
+  const onDelete: OnDelete<StepFlowNode, FlowEdge> = ({ nodes: deleted, edges: removed }) => remove(deleted.map((n) => n.id), removed);
   const selection = selectedForDelete(nodes, edges);
-  const deleteSelection = () => deletionOps(selection.nodeIds, selection.edges).forEach(op);
+  const deleteSelection = () => remove(selection.nodeIds, selection.edges);
   const stale = runForGraph !== undefined && contentSignature(runForGraph.snapshot) !== contentSignature(graph);
 
   return (
@@ -146,14 +155,16 @@ export function Canvas() {
         onConnect={(c: Connection) => op({ type: 'connect', from: c.source, to: c.target })}
         onDelete={onDelete}
         onNodeDragStart={(_e, _n, ns) => ns.forEach((n) => dragging.current.add(n.id))}
-        onNodeDragStop={(_e, _n, ns) =>
-          ns.forEach((n) => {
+        onNodeDragStop={(_e, _n, ns) => {
+          // One drag is one action, even with several steps selected (spec §6a.2).
+          const dropped = ns.map((n): [string, Position] => {
             dragging.current.delete(n.id);
             const position = { x: Math.round(n.position.x), y: Math.round(n.position.y) };
             pendingMoves.current.set(n.id, position);
-            op({ type: 'moveNode', id: n.id, position });
-          })
-        }
+            return [n.id, position];
+          });
+          moves(dropped);
+        }}
         // A ghost (a removed step or connection) can't be edited: clicking it opens its change instead.
         onNodeClick={(e, n) => {
           if (n.data.ghost) actions.selectChange(changeKey({ kind: 'node', id: n.data.node.id }));
```

Change `web/src/components/GraphPanel.tsx`:

```diff
diff --git a/web/src/components/GraphPanel.tsx b/web/src/components/GraphPanel.tsx
--- a/web/src/components/GraphPanel.tsx
+++ b/web/src/components/GraphPanel.tsx
@@ -1,6 +1,6 @@
 import { useEffect, useState } from 'react';
-import type { Graph } from '@agent-stream/shared';
-import { send } from '../bridge';
+import type { Graph, Op } from '@agent-stream/shared';
+import { sendEdit } from '../actions';
 import { useStore } from '../store';
 
 type Draft = { goal: string; instructions: string };
@@ -33,8 +33,11 @@ function GraphEditor({ graph }: { graph: Graph }) {
     setDraft(current);
   };
   const save = () => {
-    if (draft.goal !== base.goal) send({ type: 'op', graphId: graph.id, op: { type: 'setGoal', goal: draft.goal } });
-    if (draft.instructions !== base.instructions) send({ type: 'op', graphId: graph.id, op: { type: 'setInstructions', instructions: draft.instructions } });
+    const ops: Op[] = [];
+    if (draft.goal !== base.goal) ops.push({ type: 'setGoal', goal: draft.goal });
+    if (draft.instructions !== base.instructions) ops.push({ type: 'setInstructions', instructions: draft.instructions });
+    // One Save, one undo step (step model spec §6a.2).
+    sendEdit(graph.id, ops, 'edited the goal and instructions');
     setBase(draft);
   };
 
```

Change `web/src/components/MenuBar.tsx`:

```diff
diff --git a/web/src/components/MenuBar.tsx b/web/src/components/MenuBar.tsx
--- a/web/src/components/MenuBar.tsx
+++ b/web/src/components/MenuBar.tsx
@@ -50,6 +50,8 @@ export function MenuBar() {
                     role="menuitem"
                     disabled={!entry.enabled}
                     className={entry.warn ? 'warn' : ''}
+                    data-shortcut={entry.shortcut}
+                    aria-keyshortcuts={entry.shortcut?.replace('⌘', 'Meta+')}
                     onClick={() => {
                       setOpen(undefined);
                       entry.run();
```

Change `web/src/components/NodePanel.tsx`:

```diff
diff --git a/web/src/components/NodePanel.tsx b/web/src/components/NodePanel.tsx
--- a/web/src/components/NodePanel.tsx
+++ b/web/src/components/NodePanel.tsx
@@ -1,6 +1,6 @@
-import { useEffect, useState } from 'react';
+import { useEffect, useRef, useState } from 'react';
 import { parseStepModel, refinable, stepModelText, type EffortLevel, type GraphNode, type ModelChoice, type NodeKind, type NodePatch } from '@agent-stream/shared';
-import { actions } from '../actions';
+import { actions, registerNodeDraft } from '../actions';
 import { changedSentence, changeKey } from '../changeLabels';
 import { send } from '../bridge';
 import { reportDraft } from '../draftState';
@@ -147,6 +147,10 @@ function NodeEditor({ graphId, node, workspaces }: { graphId: string; node: Grap
     send({ type: 'op', graphId, op: { type: 'updateNode', id: node.id, patch } });
     setBase({ draft, at: node.updatedAt });
   };
+  // ⌘S saves this draft exactly as the Save button does (spec §6a.1).
+  const draftRef = useRef({ dirty, save });
+  draftRef.current = { dirty, save };
+  useEffect(() => registerNodeDraft({ nodeId: node.id, dirty: () => draftRef.current.dirty, save: () => draftRef.current.save() }), [node.id]);
   const latest = runs[0];
   const running = run?.status === 'running';
 
```

Change `web/src/components/VariablesDialog.tsx`:

```diff
diff --git a/web/src/components/VariablesDialog.tsx b/web/src/components/VariablesDialog.tsx
--- a/web/src/components/VariablesDialog.tsx
+++ b/web/src/components/VariablesDialog.tsx
@@ -1,5 +1,6 @@
 import { useEffect, useRef, useState } from 'react';
 import { variableNameProblem, type Op, type VariableDef } from '@agent-stream/shared';
+import { sendEdit } from '../actions';
 import { send } from '../bridge';
 import { dispatch, useStore } from '../store';
 
@@ -57,7 +58,10 @@ function VariablesEditor(p: { graphId: string; variables: VariableDef[]; values:
   const update = (key: number, patch: Partial<Row>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
   const close = () => dispatch({ kind: 'closeVariables' });
   const save = () => {
-    const op = (o: Op) => send({ type: 'op', graphId: p.graphId, op: o });
+    // The dialog's Save is one action, so one undo step (step model spec §6a.2); values are sent after the edits they follow.
+    const ops: Op[] = [];
+    const values: { name: string; value: string }[] = [];
+    const op = (o: Op) => ops.push(o);
     const current = new Set(p.variables.map((v) => v.name));
     // A variable the planner renamed or deleted meanwhile no longer exists under its opened name: skip it.
     const stillThere = (r: Row) => r.original !== undefined && current.has(r.original);
@@ -67,12 +71,14 @@ function VariablesEditor(p: { graphId: string; variables: VariableDef[]; values:
         if (!stillThere(r)) continue;
         if (r.name !== r.original) op({ type: 'renameVariable', name: r.original, newName: r.name });
         if (r.description.trim() !== r.originalDescription) op({ type: 'setVariableDescription', name: r.name, description: r.description.trim() });
-        if (r.value !== r.originalValue) send({ type: 'setVariableValue', graphId: p.graphId, name: r.name, value: r.value });
+        if (r.value !== r.originalValue) values.push({ name: r.name, value: r.value });
       } else {
         op(r.description.trim() ? { type: 'addVariable', name: r.name, description: r.description.trim() } : { type: 'addVariable', name: r.name });
-        if (r.value !== '') send({ type: 'setVariableValue', graphId: p.graphId, name: r.name, value: r.value });
+        if (r.value !== '') values.push({ name: r.name, value: r.value });
       }
     }
+    sendEdit(p.graphId, ops, 'edited the variables');
+    for (const v of values) send({ type: 'setVariableValue', graphId: p.graphId, name: v.name, value: v.value });
     close();
   };
   const lastNew = [...live].reverse().find((r) => !r.original);
```

Change `web/src/menuModel.ts`:

```diff
diff --git a/web/src/menuModel.ts b/web/src/menuModel.ts
--- a/web/src/menuModel.ts
+++ b/web/src/menuModel.ts
@@ -1,8 +1,10 @@
 import { refinable, type HostCommand } from '@agent-stream/shared';
 import { actions, approvableApprovals } from './actions';
+import { MOD } from './shortcuts';
 import type { State, Tab } from './state';
 
-export type MenuAction = { label: string; enabled: boolean; checked?: boolean; warn?: boolean; run: () => void };
+/** `shortcut`: the key shown at the item's right, such as ⌘S. */
+export type MenuAction = { label: string; enabled: boolean; checked?: boolean; warn?: boolean; shortcut?: string; run: () => void };
 export type MenuEntry = MenuAction | { separator: true };
 export type Menu = { id: 'file' | 'edit' | 'run' | 'variables' | 'view'; label: string; items: MenuEntry[] };
 
@@ -44,6 +46,7 @@ export function buildMenus(s: State): Menu[] {
         host('Open…', 'openGraph'),
         host('Import…', 'importGraph'),
         SEPARATOR,
+        item('Save', hasGraph, actions.save, { shortcut: `${MOD}S` }),
         host('Export…', 'exportGraph', hasGraph),
         host('Open as Markdown', 'openGraphMarkdown', !s.graphGone),
         host('Rename…', 'renameGraph', hasGraph),
@@ -56,6 +59,8 @@ export function buildMenus(s: State): Menu[] {
       id: 'edit',
       label: 'Edit',
       items: [
+        item(s.undoLabel ? `Undo ${s.undoLabel}` : 'Undo', hasGraph && !!s.undoLabel, actions.undo, { shortcut: `${MOD}Z` }),
+        SEPARATOR,
         item('Add step', onCanvas, actions.addStep),
         item('Delete selected step', selected, actions.deleteSelectedStep),
         item('Tidy layout', onCanvas, actions.tidy),
```

Change `web/src/selection.ts`:

```diff
diff --git a/web/src/selection.ts b/web/src/selection.ts
--- a/web/src/selection.ts
+++ b/web/src/selection.ts
@@ -1,4 +1,4 @@
-import type { Op } from '@agent-stream/shared';
+import { deletedLabel, type Op } from '@agent-stream/shared';
 
 type SelectableNode = { id: string; selected?: boolean; data: { ghost?: boolean } };
 type SelectableEdge = { id: string; source: string; target: string; selected?: boolean; deletable?: boolean };
@@ -22,3 +22,11 @@ export function deletionOps(nodeIds: string[], edges: SelectableEdge[]): Op[] {
   for (const id of ids) ops.push({ type: 'deleteNode', id });
   return ops;
 }
+
+/** Deleting a selection as one edit, with the label Edit › Undo names it by. */
+export function deletionEdit(nodeIds: string[], edges: SelectableEdge[]): { ops: Op[]; label: string } {
+  const ops = deletionOps(nodeIds, edges);
+  const deleted = ops.flatMap((o) => (o.type === 'deleteNode' ? [o.id] : []));
+  const disconnected = ops.flatMap((o) => (o.type === 'disconnect' ? [{ from: o.from, to: o.to }] : []));
+  return { ops, label: deletedLabel(deleted, disconnected) };
+}
```

Change `web/src/state.ts`:

```diff
diff --git a/web/src/state.ts b/web/src/state.ts
--- a/web/src/state.ts
+++ b/web/src/state.ts
@@ -284,9 +284,9 @@ function reduceServer(state: State, msg: HostMessage): State {
       const m = { ...state.markdown, saving: undefined };
       if (msg.conflict) return { ...state, markdown: { ...m, conflict: true } };
       if (msg.error !== undefined) return { ...state, markdown: m, toast: msg.error };
-      // Written (with or without errors): the editor shows the file as it is now.
+      // Written (with or without errors): the editor shows the file as it is now. Saved without errors: a toast says so (spec §6a.1).
       const markdown = { ...m, disk: msg.text ?? m.disk, draft: undefined, base: undefined, conflict: false };
-      return { ...state, markdown, canvasMode: msg.ok && state.markdown.saving?.thenGraph ? 'graph' : state.canvasMode };
+      return { ...state, markdown, canvasMode: msg.ok && state.markdown.saving?.thenGraph ? 'graph' : state.canvasMode, ...(msg.ok && { toast: 'Saved.' }) };
     }
     case 'opRejected':
       return msg.graphId === current ? { ...state, toast: msg.error } : state;
```

Change `web/src/styles.css`:

```diff
diff --git a/web/src/styles.css b/web/src/styles.css
--- a/web/src/styles.css
+++ b/web/src/styles.css
@@ -47,6 +47,7 @@ pre { background: var(--code-bg); padding: 8px; border-radius: 6px; white-space:
 .menu-items button { border: none; border-radius: 0; background: none; color: inherit; text-align: left; padding: 4px 12px 4px 4px; display: flex; gap: 4px; }
 .menu-items button:not(:disabled):hover { background: var(--vscode-menu-selectionBackground, var(--accent)); color: var(--vscode-menu-selectionForeground, var(--accent-text)); }
 .menu-items button.warn { color: var(--warn); }
+.menu-items button[data-shortcut]::after { content: attr(data-shortcut); margin-left: auto; padding-left: 24px; color: var(--muted); }
 .menu-items .check { width: 16px; text-align: center; }
 .menu-items hr { border: none; border-top: 1px solid var(--vscode-menu-separatorBackground, var(--border)); margin: 4px 0; width: 100%; }
 .react-flow { --xy-background-color: var(--bg); --xy-minimap-background-color: var(--panel); --xy-minimap-mask-background-color: color-mix(in srgb, var(--bg) 70%, transparent); --xy-minimap-mask-stroke-color: var(--border); --xy-minimap-node-background-color: var(--muted); --xy-attribution-background-color: transparent; --xy-controls-button-background-color: var(--panel); --xy-controls-button-color: var(--text); --xy-controls-button-border-color: var(--border); --xy-edge-stroke: var(--muted); }
```

- [ ] **Step 4: Run the tests and typecheck**

Run: `npm test -w web -- test/shortcuts.test.ts test/MenuBar.test.ts test/menuModel.test.ts test/VariablesDialog.test.ts test/GraphPanel.test.ts`
Expected: PASS.
Run: `npm run typecheck && npm test`
Expected: all workspaces pass (a test that times out only under heavy machine load is not a failure of this task: run it again).

- [ ] **Step 5: Commit**

```bash
git add web/src/App.tsx web/src/actions.ts web/src/components/Canvas.tsx web/src/components/GraphPanel.tsx web/src/components/MenuBar.tsx web/src/components/NodePanel.tsx web/src/components/VariablesDialog.tsx web/src/menuModel.ts web/src/selection.ts web/src/shortcuts.ts web/src/state.ts web/src/styles.css web/test/MenuBar.test.ts web/test/VariablesDialog.test.ts web/test/menuModel.test.ts web/test/shortcuts.test.ts
git commit -m "feat(web): save and undo shortcuts in the graph tab" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 11: Phase 1 docs and full verification

**Spec covered:** README wording for §§2–6a; the full check of phase 1.

**Files:**
- Modify: `README.md`, `extension/README.md`

**Interfaces:**
- Consumes: Tasks 1–10.
- Produces: README sections (both copies kept identical in these paragraphs).

- [ ] **Step 1: Implement**

Change `README.md`:

```diff
diff --git a/README.md b/README.md
--- a/README.md
+++ b/README.md
@@ -41,7 +41,9 @@ Get `agent-stream-<version>.vsix` (or build it: `npm install && npm run package`
 - **Chat view:** the **Agent Stream Chat** view on the right, next to VS Code's own Chat. It shows the planner conversation for the graph tab you're on, in the current session. Describe a goal; the planner reads your repo (read-only) and draws the plan. **New chat** starts over; the session button switches session.
 - **Stop:** while the planner works, **■ Stop** takes the place of Send; it, or Esc in the chat, stops the planner's turn. The chat shows `Stopped.`, graph edits it already made stay, and you can type continue to pick up where it stopped.
 - **Runs:** the planner never starts a run. It asks to run (or test) the graph only when you ask it to; after building or changing a plan it stops so you can review it. Its request opens the run dialog headed **The planner asks to run this graph**, where **Not now** closes it.
-- **Model and effort:** the chat header's **Model** menu picks the model for this conversation (**Default**, or one the provider lists), and **Effort** its effort level when that model offers levels (for **Default**: the levels of the model in the settings, else of the provider's default model). A saved effort always shows, so it can be cleared. The choice is kept with the conversation in the session (New chat keeps it) and applies from the next message. **Default** uses the `agentStream.model` / `agentStream.effort` settings, or the provider's own default when they are empty (Claude Code's default; Auto on Copilot; Codex's default model on Codex). Runs use those settings, read once when the run starts: the run dialog and the run's tooltip show `Model: … · Effort: …`. Set them with **Agent Stream: Select Model**; the provider's status bar tooltip shows them. A model or effort is never written into a graph or an export. An effort level the chosen model doesn't offer is left out.
+- **Model and effort:** the chat header's **Model** menu picks the model for this conversation (**Default**, or one the provider lists), and **Effort** its effort level when that model offers levels (for **Default**: the levels of the model in the settings, else of the provider's default model). A saved effort always shows, so it can be cleared. The choice is kept with the conversation in the session (New chat keeps it) and applies from the next message. **Default** uses the `agentStream.model` / `agentStream.effort` settings, or the provider's own default when they are empty (Claude Code's default; Auto on Copilot; Codex's default model on Codex). Runs use those settings, read once when the run starts: the run dialog and the run's tooltip show `Model: … · Effort: …`. Set them with **Agent Stream: Select Model**; the provider's status bar tooltip shows them. These settings are never written into a graph or an export (a step's own model is, below). An effort level the chosen model doesn't offer is left out.
+- **A step's own model and effort:** an agent step can run on its own model and effort, for a cheap check, a hard step, or to compare models side by side. Pick them in the Node panel's **Model** and **Effort** menus (**Default** is the run's model and effort); the step's card shows them as a chip such as `Opus · high`. They are saved in the graph's Markdown file (`- model: claude/opus`, `- effort: high`), so teammates get them. A run uses a step's model only on the provider it runs on: a step set to another provider's model, or to one the provider no longer offers, runs the run's model instead, and the run dialog, the step's log and the Run Report say so (the chip is struck through). The planner can set them too, when you ask or for a clearly simple or clearly hard step. Copilot has no effort levels: a step's Effort reads **Not supported**.
+- **Save and undo:** in a graph tab, **⌘S** (Ctrl+S) or **File › Save** saves the open step's unsaved edits (or, in Markdown mode, the Markdown); everything else is saved as you make it. **⌘Z** (Ctrl+Z) or **Edit › Undo** undoes your own last graph edit in this tab (up to 50): a Node panel save, adding, deleting or connecting steps, a drag, Tidy, a Markdown save, a goal, instructions or variable edit. Undo is refused once the graph changed since (by the planner, a run, the file or another tab), and agent changes are reviewed in the **Changes** tab instead. Inside a text field, ⌘Z undoes your typing.
 - **Graph tab:** the canvas, the logs of the selected step underneath, and Node · Graph on the right (plus a Changes tab while agent changes wait for review). The menu bar has File, Edit, Run, Variables and View, with View › Chat opening the chat view.
 - **Markdown:** step logs (the agent's text and the prompt it was sent) and the planner's chat replies render Markdown. HTML in agent output is shown as text, never run; links open in your browser only when they are http(s).
 - **Work sessions:**
@@ -56,7 +58,7 @@ Get `agent-stream-<version>.vsix` (or build it: `npm install && npm run package`
 - **Agent changes:** the planner, and agent steps during a run, can change the graph. A step agent asks your approval first, showing the exact text that would run, and can only change steps that haven't started. That approval can't be given from a notification or with **Approve all**: you approve each request on its own, after you see its text on the step or in the Approvals view. Approved changes apply to the running run and stay marked on the canvas (`＋` added, `✎` changed, faded ghosts for removed steps) until you **Accept** them into your original graph or **Revert** them in the **Changes** tab. The tab shows each change's before and after and who made it.
 - **Variables:** use `{{ name }}` (Jinja) in steps, the goal and the instructions. Values stay on this machine, outside the project, in `~/.agent-stream/values/` (`%USERPROFILE%\.agent-stream\values\` on Windows): they are never committed or exported, and Claude's Read, Grep and Glob tools are refused access to them (a shell command an agent attempts still needs your approval first). A value can read an environment variable: `{{ env_var('DBT_SCHEMA', 'dev') }}`. In commands every value is shell-quoted; `{{ flags | unquoted }}` opts out. A value inside `'…'` or `"…"` is escaped for those quotes. Places where a value can't be quoted safely (after a backtick, `$((`, `${`, `$'`, `$"` or a heredoc, inside a `#` comment or nested quotes, or right after a `\`) are refused with a message that says how to fix the step. Wrap dbt's own Jinja in `{% raw %}…{% endraw %}`.
 - **Run:** the dialog shows every command and prompt with values filled in, plus any problem that blocks the run. Start runs exactly what you reviewed.
-- **Run report:** **Run › Export Run Report…**, the **Report** button next to the run picker, or **Agent Stream: Export Run Report** saves one Markdown audit trail of a run (`<graph-id>-run-<run-id>.md`, in the project folder by default) and opens it: where and how it ran (branch, commit, provider, model, effort), the goal, instructions and plan, then each step's prompt or command as it ran, its tool calls, every approval with its decision and note, its output (long output is cut, with the path to the full file), exit code and usage, and the changes agents made during the run. Prompts, commands and step output appear exactly as they ran, including filled-in variable and environment values and anything an agent printed. The saved variable values file is never included.
+- **Run report:** **Run › Export Run Report…**, the **Report** button next to the run picker, or **Agent Stream: Export Run Report** saves one Markdown audit trail of a run (`<graph-id>-run-<run-id>.md`, in the project folder by default) and opens it: where and how it ran (branch, commit, provider, model, effort), the goal, instructions and plan, then each step's model and effort, its prompt or command as it ran, its tool calls, every approval with its decision and note, its output (long output is cut, with the path to the full file), exit code and usage, and the changes agents made during the run. Prompts, commands and step output appear exactly as they ran, including filled-in variable and environment values and anything an agent printed. The saved variable values file is never included.
 - **Export / Import:** share a graph as its Markdown file, `<id>.md` (the same text as the stored file, so never a variable value). Import takes a graph Markdown file, or an older `<name>.agent-stream.json` export.
 
 ## Graph files
@@ -179,7 +181,7 @@ Agent Stream runs agent steps and the planner on your Copilot plan through VS Co
 - the variable values file and run records stay private.
 
 How Copilot behaves:
-- **Models:** the Model menus list the Copilot models that can call tools, with **Auto** first. Copilot's internal models (ids starting with `copilot-`) and models that can't call tools are hidden. **Default** means Auto. A model that is no longer available falls back to Auto, and the step's log says so. Copilot has no effort levels, so the Effort menu hides.
+- **Models:** the Model menus list the Copilot models that can call tools, with **Auto** first. Copilot's internal models (ids starting with `copilot-`) and models that can't call tools are hidden. **Default** means Auto. A model that is no longer available falls back to Auto, and the step's log says so. Copilot has no effort levels, so the chat's Effort menu hides and a step's Effort reads **Not supported**.
 - **Permission:** the first run or chat on Copilot shows VS Code's dialog asking whether Agent Stream may use Copilot. If you decline, the step fails and says how to allow it later (**Accounts › Manage Language Model Access**).
 - **Request cap:**
   - Each agent step may make up to `agentStream.copilot.maxRequestsPerStep` model requests (default 100), and each planner message up to `agentStream.copilot.maxRequestsPerTurn` (default 100).
```

Change `extension/README.md`:

```diff
diff --git a/extension/README.md b/extension/README.md
--- a/extension/README.md
+++ b/extension/README.md
@@ -41,7 +41,9 @@ Install Agent Stream from the VS Code Marketplace, or from an `agent-stream-<ver
 - **Chat view:** the **Agent Stream Chat** view on the right, next to VS Code's own Chat. It shows the planner conversation for the graph tab you're on, in the current session. Describe a goal; the planner reads your repo (read-only) and draws the plan. **New chat** starts over; the session button switches session.
 - **Stop:** while the planner works, **■ Stop** takes the place of Send; it, or Esc in the chat, stops the planner's turn. The chat shows `Stopped.`, graph edits it already made stay, and you can type continue to pick up where it stopped.
 - **Runs:** the planner never starts a run. It asks to run (or test) the graph only when you ask it to; after building or changing a plan it stops so you can review it. Its request opens the run dialog headed **The planner asks to run this graph**, where **Not now** closes it.
-- **Model and effort:** the chat header's **Model** menu picks the model for this conversation (**Default**, or one the provider lists), and **Effort** its effort level when that model offers levels (for **Default**: the levels of the model in the settings, else of the provider's default model). A saved effort always shows, so it can be cleared. The choice is kept with the conversation in the session (New chat keeps it) and applies from the next message. **Default** uses the `agentStream.model` / `agentStream.effort` settings, or the provider's own default when they are empty (Claude Code's default; Auto on Copilot; Codex's default model on Codex). Runs use those settings, read once when the run starts: the run dialog and the run's tooltip show `Model: … · Effort: …`. Set them with **Agent Stream: Select Model**; the provider's status bar tooltip shows them. A model or effort is never written into a graph or an export. An effort level the chosen model doesn't offer is left out.
+- **Model and effort:** the chat header's **Model** menu picks the model for this conversation (**Default**, or one the provider lists), and **Effort** its effort level when that model offers levels (for **Default**: the levels of the model in the settings, else of the provider's default model). A saved effort always shows, so it can be cleared. The choice is kept with the conversation in the session (New chat keeps it) and applies from the next message. **Default** uses the `agentStream.model` / `agentStream.effort` settings, or the provider's own default when they are empty (Claude Code's default; Auto on Copilot; Codex's default model on Codex). Runs use those settings, read once when the run starts: the run dialog and the run's tooltip show `Model: … · Effort: …`. Set them with **Agent Stream: Select Model**; the provider's status bar tooltip shows them. These settings are never written into a graph or an export (a step's own model is, below). An effort level the chosen model doesn't offer is left out.
+- **A step's own model and effort:** an agent step can run on its own model and effort, for a cheap check, a hard step, or to compare models side by side. Pick them in the Node panel's **Model** and **Effort** menus (**Default** is the run's model and effort); the step's card shows them as a chip such as `Opus · high`. They are saved in the graph's Markdown file (`- model: claude/opus`, `- effort: high`), so teammates get them. A run uses a step's model only on the provider it runs on: a step set to another provider's model, or to one the provider no longer offers, runs the run's model instead, and the run dialog, the step's log and the Run Report say so (the chip is struck through). The planner can set them too, when you ask or for a clearly simple or clearly hard step. Copilot has no effort levels: a step's Effort reads **Not supported**.
+- **Save and undo:** in a graph tab, **⌘S** (Ctrl+S) or **File › Save** saves the open step's unsaved edits (or, in Markdown mode, the Markdown); everything else is saved as you make it. **⌘Z** (Ctrl+Z) or **Edit › Undo** undoes your own last graph edit in this tab (up to 50): a Node panel save, adding, deleting or connecting steps, a drag, Tidy, a Markdown save, a goal, instructions or variable edit. Undo is refused once the graph changed since (by the planner, a run, the file or another tab), and agent changes are reviewed in the **Changes** tab instead. Inside a text field, ⌘Z undoes your typing.
 - **Graph tab:** the canvas, the logs of the selected step underneath, and Node · Graph on the right (plus a Changes tab while agent changes wait for review). The menu bar has File, Edit, Run, Variables and View, with View › Chat opening the chat view.
 - **Markdown:** step logs (the agent's text and the prompt it was sent) and the planner's chat replies render Markdown. HTML in agent output is shown as text, never run; links open in your browser only when they are http(s).
 - **Work sessions:**
@@ -56,7 +58,7 @@ Install Agent Stream from the VS Code Marketplace, or from an `agent-stream-<ver
 - **Agent changes:** the planner, and agent steps during a run, can change the graph. A step agent asks your approval first, showing the exact text that would run, and can only change steps that haven't started. That approval can't be given from a notification or with **Approve all**: you approve each request on its own, after you see its text on the step or in the Approvals view. Approved changes apply to the running run and stay marked on the canvas (`＋` added, `✎` changed, faded ghosts for removed steps) until you **Accept** them into your original graph or **Revert** them in the **Changes** tab. The tab shows each change's before and after and who made it.
 - **Variables:** use `{{ name }}` (Jinja) in steps, the goal and the instructions. Values stay on this machine, outside the project, in `~/.agent-stream/values/` (`%USERPROFILE%\.agent-stream\values\` on Windows): they are never committed or exported, and Claude's Read, Grep and Glob tools are refused access to them (a shell command an agent attempts still needs your approval first). A value can read an environment variable: `{{ env_var('DBT_SCHEMA', 'dev') }}`. In commands every value is shell-quoted; `{{ flags | unquoted }}` opts out. A value inside `'…'` or `"…"` is escaped for those quotes. Places where a value can't be quoted safely (after a backtick, `$((`, `${`, `$'`, `$"` or a heredoc, inside a `#` comment or nested quotes, or right after a `\`) are refused with a message that says how to fix the step. Wrap dbt's own Jinja in `{% raw %}…{% endraw %}`.
 - **Run:** the dialog shows every command and prompt with values filled in, plus any problem that blocks the run. Start runs exactly what you reviewed.
-- **Run report:** **Run › Export Run Report…**, the **Report** button next to the run picker, or **Agent Stream: Export Run Report** saves one Markdown audit trail of a run (`<graph-id>-run-<run-id>.md`, in the project folder by default) and opens it: where and how it ran (branch, commit, provider, model, effort), the goal, instructions and plan, then each step's prompt or command as it ran, its tool calls, every approval with its decision and note, its output (long output is cut, with the path to the full file), exit code and usage, and the changes agents made during the run. Prompts, commands and step output appear exactly as they ran, including filled-in variable and environment values and anything an agent printed. The saved variable values file is never included.
+- **Run report:** **Run › Export Run Report…**, the **Report** button next to the run picker, or **Agent Stream: Export Run Report** saves one Markdown audit trail of a run (`<graph-id>-run-<run-id>.md`, in the project folder by default) and opens it: where and how it ran (branch, commit, provider, model, effort), the goal, instructions and plan, then each step's model and effort, its prompt or command as it ran, its tool calls, every approval with its decision and note, its output (long output is cut, with the path to the full file), exit code and usage, and the changes agents made during the run. Prompts, commands and step output appear exactly as they ran, including filled-in variable and environment values and anything an agent printed. The saved variable values file is never included.
 - **Export / Import:** share a graph as its Markdown file, `<id>.md` (the same text as the stored file, so never a variable value). Import takes a graph Markdown file, or an older `<name>.agent-stream.json` export.
 
 ## Graph files
@@ -179,7 +181,7 @@ Agent Stream runs agent steps and the planner on your Copilot plan through VS Co
 - the variable values file and run records stay private.
 
 How Copilot behaves:
-- **Models:** the Model menus list the Copilot models that can call tools, with **Auto** first. Copilot's internal models (ids starting with `copilot-`) and models that can't call tools are hidden. **Default** means Auto. A model that is no longer available falls back to Auto, and the step's log says so. Copilot has no effort levels, so the Effort menu hides.
+- **Models:** the Model menus list the Copilot models that can call tools, with **Auto** first. Copilot's internal models (ids starting with `copilot-`) and models that can't call tools are hidden. **Default** means Auto. A model that is no longer available falls back to Auto, and the step's log says so. Copilot has no effort levels, so the chat's Effort menu hides and a step's Effort reads **Not supported**.
 - **Permission:** the first run or chat on Copilot shows VS Code's dialog asking whether Agent Stream may use Copilot. If you decline, the step fails and says how to allow it later (**Accounts › Manage Language Model Access**).
 - **Request cap:**
   - Each agent step may make up to `agentStream.copilot.maxRequestsPerStep` model requests (default 100), and each planner message up to `agentStream.copilot.maxRequestsPerTurn` (default 100).
```

- [ ] **Step 2: Run the tests and typecheck**

Run: `npm run typecheck && npm test && npm run build`
Expected: PASS.
Run: `npm run typecheck && npm test`
Expected: all workspaces pass (a test that times out only under heavy machine load is not a failure of this task: run it again).

- [ ] **Step 3: Commit**

```bash
git add README.md extension/README.md
git commit -m "docs: a model and effort per step, save and undo" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

# Phase 2 — attachments (§6b)

Phase 1 must be merged (or at least complete on this branch) first: phase 2 builds on its undo (attach and remove are undo steps) and on its data-model conventions. Phase 2 can ship separately.

### Task 12: Feasibility check, and the attachment rules

**Spec covered:** §6b.5's table (rules on the fallbacks: rulings P1–P3), §6b.2 (names, types, limits, clashes), §7 attachments storage tests (the pure part).

**Files:**
- Create: `shared/src/attachments.ts`
- Modify: `shared/src/index.ts`
- Test: `shared/test/attachments.test.ts` (new)

**Interfaces:**
- Consumes: nothing.
- Produces (`shared/src/attachments.ts`): `MAX_ATTACHMENT_NAME_CHARS` (100), `MAX_ATTACHMENTS` (20), `MAX_IMAGE_BYTES` (10 MB), `MAX_OTHER_BYTES` (5 MB), `MAX_INLINED_TEXT_CHARS` (100 KB), `ONLY_AGENT_STEPS_ATTACH`, `ATTACHMENT_NOTICE`, `ALLOWED_ATTACHMENTS`, `type AttachmentKind = 'image' | 'pdf' | 'text'`, `attachmentKind(name)`, `imageMediaType(name)`, `attachmentNameProblem(name)`, `attachmentListProblem(names)`, `attachmentFileProblem(name, bytes)`, `safeAttachmentName(original)`, `uniqueAttachmentName(name, taken)`.

- [ ] **Step 1: Claude: images and PDFs in a user message (ruling P1)**

Run: `grep -n "export declare type SDKUserMessage" -A 6 node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts && grep -n '"version"' node_modules/@anthropic-ai/claude-agent-sdk/package.json`
Expected: version `0.3.287` (or later) and `message: MessageParam;` with the comment naming text, image and document blocks. If `SDKUserMessage` no longer takes a `MessageParam`, stop and report: P1's fallback is then the Codex one (path plus a note).

- [ ] **Step 2: Codex: image input on turn/start (ruling P2)**

Run (writes only into your scratchpad): `codex --version && codex app-server generate-ts --experimental --out <scratchpad>/codex-ts && grep -rn "localImage" <scratchpad>/codex-ts/v2/UserInput.ts`
Expected: `codex-cli 0.160.0` and a `UserInput` variant `{ "type": "localImage", detail?: ImageDetail, path: string, }`. Without Codex installed, skip this check: Task 17 copies that variant into `engine/src/providers/codex/protocol.ts` as the generated file defines it. If the variant is missing from an installed Codex, stop and report.

- [ ] **Step 3: VS Code: image parts for extensions (ruling P3)**

Run: `grep -n "class LanguageModelDataPart\|static image(\|static User(content" node_modules/@types/vscode/index.d.ts`
Expected: `LanguageModelDataPart` with `static image(data: Uint8Array, mime: string)` and a `(data, mimeType)` constructor, and `LanguageModelChatMessage.User` accepting `LanguageModelDataPart`. No typed image capability exists on `LanguageModelChat`, so ruling P3 stands: images only to a model whose runtime `capabilities.supportsImageToText` is `true`, otherwise `This image couldn't be shown to the model.` If `LanguageModelDataPart` is missing, stop and report.

- [ ] **Step 4: Write the failing tests**

Create `shared/test/attachments.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  attachmentFileProblem,
  attachmentKind,
  attachmentListProblem,
  attachmentNameProblem,
  imageMediaType,
  MAX_ATTACHMENTS,
  safeAttachmentName,
  uniqueAttachmentName,
} from '../src/attachments';

describe('attachment types and sizes (spec §6b.2)', () => {
  it('takes images, PDFs and text-like files by extension, in any letter case', () => {
    expect(['a.png', 'b.JPG', 'c.jpeg', 'd.gif', 'e.webp'].map(attachmentKind)).toEqual(['image', 'image', 'image', 'image', 'image']);
    expect(attachmentKind('spec.PDF')).toBe('pdf');
    expect(['notes.md', 'a.txt', 'b.csv', 'c.tsv', 'd.json', 'e.yaml', 'f.yml', 'g.sql', 'h.xml', 'i.html', 'j.log', 'k.ts', 'l.py'].every((n) => attachmentKind(n) === 'text')).toBe(true);
    expect(attachmentKind('tool.exe')).toBeUndefined();
    expect(attachmentKind('Makefile')).toBeUndefined();
    expect(imageMediaType('a.JPG')).toBe('image/jpeg');
    expect(imageMediaType('a.pdf')).toBeUndefined();
  });

  it('refuses other types, naming the allowed ones, and files over the limit', () => {
    expect(attachmentFileProblem('tool.exe', 10)).toBe("tool.exe can't be attached. Attach images (png, jpg, gif, webp), PDFs, and text files (md, txt, csv, tsv, json, yaml, sql, xml, html, log, or source code).");
    expect(attachmentFileProblem('big.png', 10 * 1024 * 1024)).toBeNull();
    expect(attachmentFileProblem('big.png', 10 * 1024 * 1024 + 1)).toBe('big.png is larger than 10 MB (the limit for images).');
    expect(attachmentFileProblem('big.pdf', 5 * 1024 * 1024 + 1)).toBe('big.pdf is larger than 5 MB.');
  });
});

describe('attachment names (spec §6b.2)', () => {
  it('accepts letters, digits, . - _ and spaces, up to 100 characters', () => {
    for (const name of ['mockup.png', 'Q3 report v2.pdf', 'größe_1.csv', 'a-b.c.md', 'x'.repeat(96) + '.png']) expect(attachmentNameProblem(name), name).toBeNull();
  });

  it('refuses other characters, a leading or trailing dot or space, long names and Windows device names', () => {
    for (const name of ['', '../x.png', 'a/b.png', 'a:b.png', '.env', ' a.png', 'a.png ', 'a.', 'x'.repeat(97) + '.png', 'tab\t.md']) expect(attachmentNameProblem(name), name).toMatch(/isn't a safe attachment name/);
    expect(attachmentNameProblem('CON.png')).toBe(`"CON.png" can't be used as an attachment name on Windows. Rename the file.`);
  });

  it('makes a file’s own name safe, keeping its extension', () => {
    expect(safeAttachmentName('/Users/me/Desktop/My Mockup (final).png')).toBe('My Mockup _final_.png');
    expect(safeAttachmentName('C:\\work\\notes:v2.md')).toBe('notes_v2.md');
    expect(safeAttachmentName('.hidden.txt')).toBe('hidden.txt');
    expect(safeAttachmentName('...png')).toBe('png');
    expect(safeAttachmentName('nul.txt')).toBe('_nul.txt');
    expect(safeAttachmentName('???.pdf')).toBe('___.pdf');
    const long = safeAttachmentName(`${'a'.repeat(150)}.webp`);
    expect(long).toBe(`${'a'.repeat(95)}.webp`);
    for (const n of ['a/b/c.png', 'weird*name?.json', `${'ü'.repeat(120)}.md`]) expect(attachmentNameProblem(safeAttachmentName(n)), n).toBeNull();
  });

  it('gives a clash -2, -3, … before the extension, in any letter case', () => {
    expect(uniqueAttachmentName('mockup.png', [])).toBe('mockup.png');
    expect(uniqueAttachmentName('mockup.png', ['Mockup.PNG'])).toBe('mockup-2.png');
    expect(uniqueAttachmentName('mockup.png', ['mockup.png', 'mockup-2.png'])).toBe('mockup-3.png');
    expect(uniqueAttachmentName('README', ['readme'])).toBe('README-2');
    expect(uniqueAttachmentName(`${'a'.repeat(96)}.png`, [`${'a'.repeat(96)}.png`])).toBe(`${'a'.repeat(94)}-2.png`);
  });

  it('a list holds safe names, each once, at most 20', () => {
    expect(attachmentListProblem(['a.png', 'b.md'])).toBeNull();
    expect(attachmentListProblem(['a.png', 'A.png'])).toBe('"A.png" is attached twice. Keep one.');
    expect(attachmentListProblem(['../a.png'])).toMatch(/isn't a safe attachment name/);
    expect(attachmentListProblem(Array.from({ length: MAX_ATTACHMENTS + 1 }, (_, i) => `f${i}.md`))).toBe('at most 20 attachments; remove 1.');
  });
});
```

- [ ] **Step 5: Run the tests and see them fail**

Run: `npm test -w shared -- test/attachments.test.ts`
Expected: FAIL — the new modules, exports or behaviour do not exist yet (import errors or assertion failures).

- [ ] **Step 6: Implement**

Create `shared/src/attachments.ts`:

```ts
/** Attachments: files and photos given to agents as context (step model spec §6b). Pure rules, shared by the engine and the tab. */

export const MAX_ATTACHMENT_NAME_CHARS = 100;
/** At most this many attachments per step, per graph, and per chat message (spec §6b.2). */
export const MAX_ATTACHMENTS = 20;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_OTHER_BYTES = 5 * 1024 * 1024;
/** A chat message's text file is inlined up to this many characters (spec §6b.5: 100 KB). */
export const MAX_INLINED_TEXT_CHARS = 100 * 1024;

export const ONLY_AGENT_STEPS_ATTACH = 'Only agent steps have attachments.';
/** The one-time notice when a graph's attachments folder gets its first file (spec §6b.2). */
export const ATTACHMENT_NOTICE = "Attachments are saved with the graph (and committed) and sent to your AI provider. Don't attach secrets.";
export const ALLOWED_ATTACHMENTS = 'images (png, jpg, gif, webp), PDFs, and text files (md, txt, csv, tsv, json, yaml, sql, xml, html, log, or source code)';

export type AttachmentKind = 'image' | 'pdf' | 'text';

const IMAGE_TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
const TEXT_TYPES = new Set([
  'md', 'txt', 'csv', 'tsv', 'json', 'yaml', 'yml', 'sql', 'xml', 'html', 'htm', 'log',
  // Common source code.
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'kts', 'swift', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'php',
  'sh', 'bash', 'zsh', 'ps1', 'r', 'scala', 'lua', 'pl', 'css', 'scss', 'less', 'vue', 'svelte', 'toml', 'ini', 'cfg', 'conf', 'graphql', 'proto', 'tf', 'dart',
]);
const WINDOWS_DEVICE_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const SAFE_CHAR_RE = /[\p{L}\p{N}._\- ]/u;
const SAFE_NAME_RE = /^[\p{L}\p{N}._\- ]+$/u;

const extensionOf = (name: string): string => {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
};

/** Image, PDF or text file, by the name's extension; undefined for a type attachments don't take. */
export function attachmentKind(name: string): AttachmentKind | undefined {
  const ext = extensionOf(name);
  if (IMAGE_TYPES[ext]) return 'image';
  if (ext === 'pdf') return 'pdf';
  if (TEXT_TYPES.has(ext)) return 'text';
  return undefined;
}

/** An image's media type (`image/png`), for providers that take the bytes. */
export const imageMediaType = (name: string): string | undefined => IMAGE_TYPES[extensionOf(name)];

/**
 * Why `name` can't name an attachment, or null (spec §6b.2): letters, digits, `.`, `-`, `_` and spaces, at most 100
 * characters, not starting with `.` or a space and not ending with either (Windows), and not a Windows device name.
 */
export function attachmentNameProblem(name: string): string | null {
  const rule = `An attachment name uses letters, digits, ".", "-", "_" and spaces (at most ${MAX_ATTACHMENT_NAME_CHARS} characters), and doesn't start or end with "." or a space.`;
  if (!name || [...name].length > MAX_ATTACHMENT_NAME_CHARS || !SAFE_NAME_RE.test(name) || /^[. ]|[. ]$/.test(name)) return `"${name}" isn't a safe attachment name. ${rule}`;
  if (WINDOWS_DEVICE_RE.test(name.split('.')[0])) return `"${name}" can't be used as an attachment name on Windows. Rename the file.`;
  return null;
}

const key = (name: string) => name.toLowerCase();

/** Why a list of attachment names can't be stored, or null: each name safe, none twice (in any letter case), at most 20. */
export function attachmentListProblem(names: readonly string[]): string | null {
  if (names.length > MAX_ATTACHMENTS) return `at most ${MAX_ATTACHMENTS} attachments; remove ${names.length - MAX_ATTACHMENTS}.`;
  const seen = new Set<string>();
  for (const name of names) {
    const problem = attachmentNameProblem(name);
    if (problem) return problem;
    if (seen.has(key(name))) return `"${name}" is attached twice. Keep one.`;
    seen.add(key(name));
  }
  return null;
}

/** Why a file can't be attached (its type, or its size), or null (spec §6b.2). */
export function attachmentFileProblem(name: string, bytes: number): string | null {
  const kind = attachmentKind(name);
  if (!kind) return `${name} can't be attached. Attach ${ALLOWED_ATTACHMENTS}.`;
  const max = kind === 'image' ? MAX_IMAGE_BYTES : MAX_OTHER_BYTES;
  if (bytes > max) return `${name} is larger than ${max / (1024 * 1024)} MB${kind === 'image' ? ' (the limit for images)' : ''}.`;
  return null;
}

/**
 * A file's own name made safe (spec §6b.2): folders dropped, other characters as `_`, no leading or trailing dot or space,
 * at most 100 characters with the extension kept, and never a Windows device name.
 */
export function safeAttachmentName(original: string): string {
  const base = original.split(/[\\/]/).pop() ?? '';
  let name = [...base].map((c) => (SAFE_CHAR_RE.test(c) ? c : '_')).join('').replace(/^[. ]+|[. ]+$/g, '');
  const ext = extensionOf(name);
  const stemOf = (n: string) => (ext ? n.slice(0, n.length - ext.length - 1) : n);
  let stem = stemOf(name).replace(/[. ]+$/, '');
  if (!stem) stem = 'attachment';
  if (WINDOWS_DEVICE_RE.test(stem.split('.')[0])) stem = `_${stem}`;
  const suffix = ext ? `.${ext}` : '';
  const room = MAX_ATTACHMENT_NAME_CHARS - [...suffix].length;
  stem = [...stem].slice(0, room).join('').replace(/[. ]+$/, '') || 'attachment';
  name = `${stem}${suffix}`;
  return name;
}

/** `name`, or `name-2.png`, `name-3.png`, … when a taken name (in any letter case) has it, kept within 100 characters. */
export function uniqueAttachmentName(name: string, taken: Iterable<string>): string {
  const used = new Set([...taken].map(key));
  if (!used.has(key(name))) return name;
  const ext = extensionOf(name);
  const suffix = ext ? `.${ext}` : '';
  const stem = ext ? name.slice(0, name.length - suffix.length) : name;
  for (let i = 2; ; i++) {
    const tail = `-${i}${suffix}`;
    const candidate = `${[...stem].slice(0, MAX_ATTACHMENT_NAME_CHARS - tail.length).join('')}${tail}`;
    if (!used.has(key(candidate))) return candidate;
  }
}
```

Change `shared/src/index.ts`:

```diff
diff --git a/shared/src/index.ts b/shared/src/index.ts
--- a/shared/src/index.ts
+++ b/shared/src/index.ts
@@ -18,3 +18,4 @@ export * from './graphMarkdownWrite';
 export * from './diffToOps';
 export * from './stepModels';
 export * from './undo';
+export * from './attachments';
```

- [ ] **Step 7: Run the tests and typecheck**

Run: `npm test -w shared -- test/attachments.test.ts`
Expected: PASS.
Run: `npm run typecheck && npm test`
Expected: all workspaces pass (a test that times out only under heavy machine load is not a failure of this task: run it again).

- [ ] **Step 8: Commit**

```bash
git add shared/src/attachments.ts shared/src/index.ts shared/test/attachments.test.ts
git commit -m "feat(shared): attachment names, types and limits" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 13: Attachments in the data model

**Spec covered:** §6b.3 data model (`GraphNode.attachments`, `Graph.attachments`, `setGraphAttachments`, `ChangedField`, kind switch drops the list), §7 attachments `setGraphAttachments` tests.

**Files:**
- Modify: `engine/src/graphStore.ts`, `engine/src/planner.ts`, `engine/src/stepGraphTools.ts`, `shared/src/changes.ts`, `shared/src/graph.ts`, `shared/src/graphDoc.ts`, `shared/src/schemas.ts`, `shared/src/types.ts`, `shared/src/undo.ts`, `web/src/components/ChangesPanel.tsx`
- Test: `shared/test/attachmentsGraph.test.ts` (new)

**Interfaces:**
- Consumes: Task 12.
- Produces: `GraphNode.attachments?: string[]`, `NewNodeInput.attachments?`, `NodePatch.attachments?` (`[]` clears), `Graph.attachments?: string[]`, `Op { type: 'setGraphAttachments'; names: string[] }`, `ChangedField` gains `'attachments'`; `changedFieldText(…, 'attachments')` is one name per line; `contentSignature` and `reusableNodeIds` (names) include them; `undoLabel` and the planner's `describeOp` name the new op.

- [ ] **Step 1: Write the failing tests**

Create `shared/test/attachmentsGraph.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { ONLY_AGENT_STEPS_ATTACH } from '../src/attachments';
import { changedFields, changedFieldText } from '../src/changes';
import { applyOp, contentSignature, emptyGraph, reusableNodeIds } from '../src/graph';
import { canonicalGraph } from '../src/graphDoc';
import { parseGraph, parseWebviewMessage } from '../src/schemas';
import type { Graph, NodeRunState, Op } from '../src/types';

const T = '2026-10-05T00:00:00.000Z';
function run(g: Graph, ops: Op[]): Graph {
  let out = g;
  for (const op of ops) {
    const r = applyOp(out, op, 'user', T);
    if (!r.ok) throw new Error(`${op.type}: ${r.error}`);
    out = r.graph;
  }
  return out;
}
const refused = (g: Graph, op: Op) => {
  const r = applyOp(g, op, 'user', T);
  return r.ok ? 'applied' : r.error;
};
const empty = emptyGraph('g', 'G', T);
const agent = (attachments?: string[]): Op => ({ type: 'addNode', node: { title: 'a', kind: 'agent', prompt: 'p', ...(attachments && { attachments }) } });

describe('step attachments in the data model (spec §6b.3)', () => {
  it('a step keeps its list in order; [] clears it; other edits keep it', () => {
    let g = run(empty, [agent(['b.png', 'a.md'])]);
    expect(g.nodes[0].attachments).toEqual(['b.png', 'a.md']);
    g = run(g, [{ type: 'updateNode', id: 'n1', patch: { title: 'renamed' } }]);
    expect(g.nodes[0].attachments).toEqual(['b.png', 'a.md']);
    g = run(g, [{ type: 'updateNode', id: 'n1', patch: { attachments: ['a.md'] } }]);
    expect(g.nodes[0].attachments).toEqual(['a.md']);
    g = run(g, [{ type: 'updateNode', id: 'n1', patch: { attachments: [] } }]);
    expect(g.nodes[0]).not.toHaveProperty('attachments');
  });

  it('refuses unsafe names, duplicates and attachments on a command step; a switch to command drops them', () => {
    expect(refused(empty, agent(['../x.png']))).toMatch(/isn't a safe attachment name/);
    expect(refused(empty, agent(['a.png', 'A.png']))).toBe('"A.png" is attached twice. Keep one.');
    expect(refused(empty, { type: 'addNode', node: { title: 'c', kind: 'command', command: 'ls', attachments: ['a.md'] } })).toBe(ONLY_AGENT_STEPS_ATTACH);
    const g = run(empty, [agent(['a.md'])]);
    expect(refused(g, { type: 'updateNode', id: 'n1', patch: { kind: 'command', command: 'ls', attachments: ['a.md'] } })).toBe(ONLY_AGENT_STEPS_ATTACH);
    expect(run(g, [{ type: 'updateNode', id: 'n1', patch: { kind: 'command', command: 'ls' } }]).nodes[0]).not.toHaveProperty('attachments');
  });

  it('agent-change review lists them as a changed field, one per line', () => {
    const before = run(empty, [agent()]);
    const after = run(before, [{ type: 'updateNode', id: 'n1', patch: { attachments: ['a.png', 'b.md'] } }]);
    expect(changedFields(before.nodes[0], after.nodes[0])).toEqual(['attachments']);
    expect(changedFieldText(after.nodes[0], 'attachments')).toBe('a.png\nb.md');
  });
});

describe('graph attachments in the data model (spec §6b.3)', () => {
  it('setGraphAttachments sets the whole list, and [] removes it', () => {
    const g = run(empty, [{ type: 'setGraphAttachments', names: ['brief.pdf', 'logo.png'] }]);
    expect(g.attachments).toEqual(['brief.pdf', 'logo.png']);
    expect(run(g, [{ type: 'setGraphAttachments', names: [] }])).not.toHaveProperty('attachments');
    expect(refused(empty, { type: 'setGraphAttachments', names: ['a b/c.png'] })).toMatch(/isn't a safe attachment name/);
  });

  it('canonical form keeps non-empty lists only, and a step’s only on an agent step', () => {
    const g = run(empty, [agent(['a.md']), { type: 'addNode', node: { title: 'c', kind: 'command', command: 'ls' } }]);
    const hidden: Graph = { ...g, attachments: [], nodes: [g.nodes[0], { ...g.nodes[1], attachments: ['x.md'] }] };
    const c = canonicalGraph(hidden);
    expect(c.attachments).toBeUndefined();
    expect(c.nodes[0].attachments).toEqual(['a.md']);
    expect(c.nodes[1]).not.toHaveProperty('attachments');
  });

  it('parseGraph reads both lists and refuses bad ones; clients may send them', () => {
    const node = { id: 'n1', title: 'a', kind: 'agent' as const, prompt: 'p' };
    const ok = parseGraph({ id: 'g', name: 'G', attachments: ['a.png'], nodes: [{ ...node, attachments: ['b.md'] }] });
    expect(ok.ok && ok.graph).toMatchObject({ attachments: ['a.png'], nodes: [{ attachments: ['b.md'] }] });
    expect(parseGraph({ id: 'g', name: 'G', nodes: [{ ...node, kind: 'command', command: 'ls', attachments: ['b.md'] }] })).toEqual({ ok: false, error: `n1: ${ONLY_AGENT_STEPS_ATTACH}` });
    expect(parseGraph({ id: 'g', name: 'G', attachments: ['a.png', 'a.png'], nodes: [] })).toEqual({ ok: false, error: 'graph attachments: "a.png" is attached twice. Keep one.' });
    const msg = { type: 'op', graphId: 'g', op: { type: 'setGraphAttachments', names: ['a.png'] } };
    expect(parseWebviewMessage(msg)).toEqual({ ok: true, kind: 'engine', msg });
    expect(parseWebviewMessage({ type: 'op', graphId: 'g', op: { type: 'setGraphAttachments', names: Array.from({ length: 21 }, (_, i) => `f${i}.md`) } }).ok).toBe(false);
  });

  it('the content signature and re-run reuse follow a step’s list and the graph’s', () => {
    const g = run(empty, [agent(), agent(), { type: 'addNode', node: { title: 'c', kind: 'command', command: 'ls' } }]);
    const allOk = Object.fromEntries(g.nodes.map((n) => [n.id, { status: 'succeeded' as const }])) as Record<string, NodeRunState>;
    const own = run(g, [{ type: 'updateNode', id: 'n2', patch: { attachments: ['a.md'] } }]);
    const shared = run(g, [{ type: 'setGraphAttachments', names: ['brief.pdf'] }]);
    expect(contentSignature(own)).not.toBe(contentSignature(g));
    expect(contentSignature(shared)).not.toBe(contentSignature(g));
    expect(reusableNodeIds(own, { snapshot: g, nodes: allOk })).toEqual(new Set(['n1', 'n3']));
    // Every agent step gets the graph's attachments; a command step gets none.
    expect(reusableNodeIds(shared, { snapshot: g, nodes: allOk })).toEqual(new Set(['n3']));
  });
});
```

- [ ] **Step 2: Run the tests and see them fail**

Run: `npm test -w shared -- test/attachmentsGraph.test.ts test/stepModels.test.ts`
Expected: FAIL — the new modules, exports or behaviour do not exist yet (import errors or assertion failures).

- [ ] **Step 3: Implement**

Change `engine/src/graphStore.ts`:

```diff
diff --git a/engine/src/graphStore.ts b/engine/src/graphStore.ts
--- a/engine/src/graphStore.ts
+++ b/engine/src/graphStore.ts
@@ -76,8 +76,8 @@ function touches(op: Op, change: AgentChange): boolean {
 
 /** `node` with `source`'s content fields (absent ones removed), keeping its id, position and authorship. */
 function withContentOf(node: GraphNode, source: GraphNode): GraphNode {
-  const { description: _d, prompt: _p, command: _c, timeoutSec: _t, access: _a, workspace: _w, model: _m, effort: _e, ...rest } = node;
-  const optional = { description: source.description, prompt: source.prompt, command: source.command, timeoutSec: source.timeoutSec, access: source.access, workspace: source.workspace, model: source.model, effort: source.effort };
+  const { description: _d, prompt: _p, command: _c, timeoutSec: _t, access: _a, workspace: _w, model: _m, effort: _e, attachments: _f, ...rest } = node;
+  const optional = { description: source.description, prompt: source.prompt, command: source.command, timeoutSec: source.timeoutSec, access: source.access, workspace: source.workspace, model: source.model, effort: source.effort, attachments: source.attachments };
   return { ...rest, title: source.title, kind: source.kind, ...Object.fromEntries(Object.entries(optional).filter(([, v]) => v !== undefined)) };
 }
 
```

Change `engine/src/planner.ts`:

```diff
diff --git a/engine/src/planner.ts b/engine/src/planner.ts
--- a/engine/src/planner.ts
+++ b/engine/src/planner.ts
@@ -80,6 +80,8 @@ export function describeOp(op: Op): string {
       return `changed the description of variable ${op.name}`;
     case 'deleteVariable':
       return `deleted variable ${op.name}`;
+    case 'setGraphAttachments':
+      return op.names.length ? `set the graph's attachments to ${op.names.join(', ')}` : "removed the graph's attachments";
     case 'moveNode':
       return `moved ${op.id}`;
     case 'acceptChange':
```

Change `engine/src/stepGraphTools.ts`:

```diff
diff --git a/engine/src/stepGraphTools.ts b/engine/src/stepGraphTools.ts
--- a/engine/src/stepGraphTools.ts
+++ b/engine/src/stepGraphTools.ts
@@ -28,8 +28,8 @@ const TITLE_PROBLEM = `a step title must be one line of at most ${MAX_TITLE_CHAR
 const titleProblem = (title: string | undefined) => (title !== undefined && (/[\r\n\u2028\u2029\u0085\v\f]/.test(title) || title.length > MAX_TITLE_CHARS) ? TITLE_PROBLEM : null);
 
 /** Changed fields in the order a person reads them: the text that runs first. */
-const FIELD_ORDER: ChangedField[] = ['prompt', 'command', 'title', 'description', 'kind', 'timeoutSec', 'access', 'workspace', 'model', 'effort'];
-const FIELD_NAMES: Record<ChangedField, string> = { prompt: 'prompt', command: 'command', title: 'title', description: 'description', kind: 'kind', timeoutSec: 'timeout', access: 'access', workspace: 'workspace', model: 'model', effort: 'effort' };
+const FIELD_ORDER: ChangedField[] = ['prompt', 'command', 'title', 'description', 'kind', 'timeoutSec', 'access', 'workspace', 'model', 'effort', 'attachments'];
+const FIELD_NAMES: Record<ChangedField, string> = { prompt: 'prompt', command: 'command', title: 'title', description: 'description', kind: 'kind', timeoutSec: 'timeout', access: 'access', workspace: 'workspace', model: 'model', effort: 'effort', attachments: 'attachments' };
 /** "command", "prompt and description", "prompt, title and description". */
 const listed = (names: string[]) => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`);
 const unique = (ids: string[]) => [...new Set(ids)];
```

Change `shared/src/changes.ts`:

```diff
diff --git a/shared/src/changes.ts b/shared/src/changes.ts
--- a/shared/src/changes.ts
+++ b/shared/src/changes.ts
@@ -1,11 +1,12 @@
 import { stepModelText } from './stepModels';
 import type { AgentChange, ChangedField, Graph, GraphNode } from './types';
 
-const FIELDS: ChangedField[] = ['title', 'description', 'kind', 'prompt', 'command', 'timeoutSec', 'access', 'workspace', 'model', 'effort'];
+const FIELDS: ChangedField[] = ['title', 'description', 'kind', 'prompt', 'command', 'timeoutSec', 'access', 'workspace', 'model', 'effort', 'attachments'];
 
-/** A step field as text, for comparing and for the Changes tab: '' when absent, a model as `claude/opus`. */
+/** A step field as text, for comparing and for the Changes tab: '' when absent, a model as `claude/opus`, attachments one per line. */
 export function changedFieldText(node: GraphNode | undefined, field: ChangedField): string {
   if (field === 'model') return node?.model ? stepModelText(node.model) : '';
+  if (field === 'attachments') return (node?.attachments ?? []).join('\n');
   const v = node?.[field];
   return v === undefined || v === null ? '' : String(v);
 }
```

Change `shared/src/graph.ts`:

```diff
diff --git a/shared/src/graph.ts b/shared/src/graph.ts
--- a/shared/src/graph.ts
+++ b/shared/src/graph.ts
@@ -1,4 +1,5 @@
 import { COMMAND_ALWAYS_WRITES, workspaceNameProblem } from './access';
+import { attachmentListProblem, ONLY_AGENT_STEPS_ATTACH } from './attachments';
 import { ONLY_AGENT_STEPS_MODEL, stepModelProblem, stepModelText } from './stepModels';
 import { variableNameProblem } from './variables';
 import type { Actor, Graph, GraphNode, GraphResult, NodePatch, NodeRunState, Op, RenderedRun } from './types';
@@ -78,6 +79,9 @@ export function applyOp(graph: Graph, op: Op, by: Actor, now: string, options: A
       const modelProblem = stepModelProblem(op.node.model, op.node.effort);
       if (modelProblem) return fail(modelProblem);
       if ((op.node.model || op.node.effort) && op.node.kind === 'command') return fail(ONLY_AGENT_STEPS_MODEL);
+      const attachProblem = op.node.attachments ? attachmentListProblem(op.node.attachments) : null;
+      if (attachProblem) return fail(attachProblem);
+      if (op.node.attachments?.length && op.node.kind === 'command') return fail(ONLY_AGENT_STEPS_ATTACH);
       const workspace = op.node.workspace?.trim() || undefined;
       const workspaceProblem = workspace === undefined ? null : workspaceNameProblem(workspace);
       if (workspaceProblem) return fail(workspaceProblem);
@@ -93,6 +97,7 @@ export function applyOp(graph: Graph, op: Op, by: Actor, now: string, options: A
         workspace,
         model: op.node.model && { provider: op.node.model.provider, id: op.node.model.id },
         effort: op.node.effort,
+        attachments: op.node.attachments?.length ? [...op.node.attachments] : undefined,
         position: op.node.position,
         createdBy: by,
         updatedBy: by,
@@ -103,7 +108,7 @@ export function applyOp(graph: Graph, op: Op, by: Actor, now: string, options: A
     case 'updateNode': {
       const node = graph.nodes.find((n) => n.id === op.id);
       if (!node) return fail(`node ${op.id} does not exist`);
-      const { access, workspace, timeoutSec, model, effort, ...patch } = definedOnly<NodePatch>(op.patch);
+      const { access, workspace, timeoutSec, model, effort, attachments, ...patch } = definedOnly<NodePatch>(op.patch);
       if (patch.title !== undefined) {
         patch.title = patch.title.trim();
         if (!patch.title) return fail('a node needs a title');
@@ -114,6 +119,9 @@ export function applyOp(graph: Graph, op: Op, by: Actor, now: string, options: A
       const modelProblem = stepModelProblem(model ?? undefined, effort ?? undefined);
       if (modelProblem) return fail(modelProblem);
       if ((model || effort) && kind === 'command') return fail(ONLY_AGENT_STEPS_MODEL);
+      const attachProblem = attachments ? attachmentListProblem(attachments) : null;
+      if (attachProblem) return fail(attachProblem);
+      if (attachments?.length && kind === 'command') return fail(ONLY_AGENT_STEPS_ATTACH);
       let nextWorkspace = node.workspace;
       if (workspace !== undefined) {
         const trimmed = workspace.trim();
@@ -128,7 +136,9 @@ export function applyOp(graph: Graph, op: Op, by: Actor, now: string, options: A
       // Only agent steps have a model or effort, so becoming a command step drops both (spec §2.1); null clears one.
       const nextModel = kind === 'command' || model === null ? undefined : (model ?? node.model);
       const nextEffort = kind === 'command' || effort === null ? undefined : (effort ?? node.effort);
-      const { access: _access, workspace: _workspace, timeoutSec: _timeoutSec, model: _model, effort: _effort, ...base } = node;
+      // So do its attachments; [] clears them (spec §6b.3).
+      const nextAttachments = kind === 'command' ? undefined : (attachments ?? node.attachments);
+      const { access: _access, workspace: _workspace, timeoutSec: _timeoutSec, model: _model, effort: _effort, attachments: _attachments, ...base } = node;
       const updated: GraphNode = {
         ...base,
         ...patch,
@@ -137,6 +147,7 @@ export function applyOp(graph: Graph, op: Op, by: Actor, now: string, options: A
         ...(nextWorkspace && { workspace: nextWorkspace }),
         ...(nextModel && { model: { provider: nextModel.provider, id: nextModel.id } }),
         ...(nextEffort && { effort: nextEffort }),
+        ...(nextAttachments?.length && { attachments: [...nextAttachments] }),
         updatedBy: by,
         updatedAt: now,
       };
@@ -198,6 +209,12 @@ export function applyOp(graph: Graph, op: Op, by: Actor, now: string, options: A
       if (!graph.variables.some((v) => v.name === op.name)) return fail(`variable ${op.name} does not exist`);
       return done({ variables: graph.variables.filter((v) => v.name !== op.name) });
     }
+    case 'setGraphAttachments': {
+      const problem = attachmentListProblem(op.names);
+      if (problem) return fail(problem);
+      const { attachments: _attachments, ...rest } = graph;
+      return { ok: true, graph: { ...rest, ...(op.names.length > 0 && { attachments: [...op.names] }), updatedAt: now } };
+    }
     case 'moveNode': {
       if (!has(op.id)) return fail(`node ${op.id} does not exist`);
       const place = (n: GraphNode): GraphNode => {
@@ -265,7 +282,8 @@ export function contentSignature(g: Graph): string {
   return JSON.stringify({
     goal: g.goal,
     instructions: g.instructions,
-    nodes: g.nodes.map((n) => [n.id, n.kind, n.title, n.description ?? '', n.prompt ?? '', n.command ?? '', n.timeoutSec ?? null, n.access ?? 'write', n.workspace ?? '', n.model ? stepModelText(n.model) : '', n.effort ?? '']),
+    attachments: g.attachments ?? [],
+    nodes: g.nodes.map((n) => [n.id, n.kind, n.title, n.description ?? '', n.prompt ?? '', n.command ?? '', n.timeoutSec ?? null, n.access ?? 'write', n.workspace ?? '', n.model ? stepModelText(n.model) : '', n.effort ?? '', n.attachments ?? []]),
     edges: g.edges.map((e) => e.id).sort(),
   });
 }
@@ -311,7 +329,10 @@ export function reusableNodeIds(graph: Graph, source: RunSource, fromNodeId?: st
     const samePlace = (prev?.workspace ?? '') === (n.workspace ?? '');
     // The model and effort a step runs with are part of its definition: comparing models is one of their uses (spec §1).
     const sameModel = n.kind !== 'agent' || ((prev?.model ? stepModelText(prev.model) : '') === (n.model ? stepModelText(n.model) : '') && (prev?.effort ?? '') === (n.effort ?? ''));
-    const sameDefinition = !!prev && prev.kind === n.kind && sameText && sameDescription && sameAccess && samePlace && sameModel;
+    // An agent step gets its own attachments, then the graph's (spec §6b.5): another list is another input.
+    const files = (step: GraphNode | undefined, g: Graph) => JSON.stringify([...(step?.attachments ?? []), ...(g.attachments ?? [])]);
+    const sameFiles = n.kind !== 'agent' || files(prev, source.snapshot) === files(n, graph);
+    const sameDefinition = !!prev && prev.kind === n.kind && sameText && sameDescription && sameAccess && samePlace && sameModel && sameFiles;
     const sameInputs = !!prev && sameSet(upstream(graph, n.id), upstream(source.snapshot, n.id));
     // A step with a workspace is never reused: its files lived in that run's own worktree (spec §4.3a).
     if (!succeeded || !sameDefinition || !sameInputs || n.workspace) seeds.add(n.id);
```

Change `shared/src/graphDoc.ts`:

```diff
diff --git a/shared/src/graphDoc.ts b/shared/src/graphDoc.ts
--- a/shared/src/graphDoc.ts
+++ b/shared/src/graphDoc.ts
@@ -61,6 +61,7 @@ export function canonicalGraph(graph: Graph): Graph {
     goal: normText(graph.goal).trim(),
     instructions: normText(graph.instructions).trim(),
     variables: graph.variables.map((v) => ({ name: v.name, description: oneLine(v.description) })),
+    ...(graph.attachments?.length ? { attachments: [...graph.attachments] } : { attachments: undefined }),
     nodes,
     edges: graph.edges.map((e) => ({ id: edgeId(e.from, e.to), from: e.from, to: e.to })),
     nodeSeq: Math.max(graph.nodeSeq, ...nodes.map((n) => seqOf(n.id))),
@@ -68,7 +69,7 @@ export function canonicalGraph(graph: Graph): Graph {
 }
 
 function canonicalNode(node: GraphNode): GraphNode {
-  const { prompt, command, description, timeoutSec, access, workspace, model, effort, ...rest } = node;
+  const { prompt, command, description, timeoutSec, access, workspace, model, effort, attachments, ...rest } = node;
   const text = normText((node.kind === 'agent' ? prompt : command) ?? '');
   const summary = oneLine(description ?? '');
   return {
@@ -81,6 +82,7 @@ function canonicalNode(node: GraphNode): GraphNode {
     ...(workspace && { workspace }),
     ...(node.kind === 'agent' && model && { model: { provider: model.provider, id: model.id } }),
     ...(node.kind === 'agent' && effort && { effort }),
+    ...(node.kind === 'agent' && attachments?.length && { attachments: [...attachments] }),
   };
 }
 
```

Change `shared/src/schemas.ts`:

```diff
diff --git a/shared/src/schemas.ts b/shared/src/schemas.ts
--- a/shared/src/schemas.ts
+++ b/shared/src/schemas.ts
@@ -1,5 +1,6 @@
 import { z } from 'zod';
 import { COMMAND_ALWAYS_WRITES, workspaceNameProblem } from './access';
+import { attachmentListProblem, MAX_ATTACHMENTS, ONLY_AGENT_STEPS_ATTACH } from './attachments';
 import { legacyNodeIdProblem, topoOrder } from './graph';
 import { MAX_MODEL_ID_CHARS, ONLY_AGENT_STEPS_MODEL } from './stepModels';
 import { MAX_UNDO_LABEL_CHARS } from './undo';
@@ -15,6 +16,8 @@ const description = z.string().max(2000).optional();
 /** A step's own model (spec §2.1): the provider and its model id, 1 to 200 characters without whitespace. */
 const stepModel = z.object({ provider: z.enum(PROVIDER_IDS), id: z.string().regex(new RegExp(`^\\S{1,${MAX_MODEL_ID_CHARS}}$`)) });
 const effort = z.enum(EFFORT_LEVELS);
+/** An attachment list as a client sends it; the names are checked by attachmentListProblem in applyOp. */
+const attachmentNames = z.array(z.string().max(200)).max(MAX_ATTACHMENTS);
 
 const graphNodeSchema = z.object({
   id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
@@ -28,6 +31,7 @@ const graphNodeSchema = z.object({
   workspace: z.string().optional(),
   model: stepModel.optional(),
   effort: effort.optional(),
+  attachments: z.array(z.string()).optional(),
   position: position.optional(),
   createdBy: actor.default('user'),
   updatedBy: actor.default('user'),
@@ -40,6 +44,7 @@ const graphSchema = z.object({
   goal: z.string().default(''),
   instructions: z.string().default(''),
   variables: z.array(z.object({ name: z.string(), description: z.string().default('') })).default([]),
+  attachments: z.array(z.string()).optional(),
   nodes: z.array(graphNodeSchema).default([]),
   edges: z.array(z.object({ id: z.string(), from: z.string(), to: z.string() })).default([]),
   // A stored counter too large to count on exactly (from a huge step id) is read as 0: the step ids still count.
@@ -59,6 +64,9 @@ export function parseGraph(json: unknown): GraphResult {
     ids.add(n.id);
     if (n.access === 'read' && n.kind === 'command') return { ok: false, error: `${n.id}: ${COMMAND_ALWAYS_WRITES}` };
     if ((n.model || n.effort) && n.kind === 'command') return { ok: false, error: `${n.id}: ${ONLY_AGENT_STEPS_MODEL}` };
+    const attachProblem = n.attachments ? attachmentListProblem(n.attachments) : null;
+    if (attachProblem) return { ok: false, error: `${n.id}: ${attachProblem}` };
+    if (n.attachments?.length && n.kind === 'command') return { ok: false, error: `${n.id}: ${ONLY_AGENT_STEPS_ATTACH}` };
     const workspaceProblem = n.workspace === undefined ? null : workspaceNameProblem(n.workspace);
     if (workspaceProblem) return { ok: false, error: `${n.id}: ${workspaceProblem}` };
   }
@@ -73,6 +81,8 @@ export function parseGraph(json: unknown): GraphResult {
     const problem = variableNameProblem(graph.variables[i].name, graph.variables.slice(0, i));
     if (problem) return { ok: false, error: `invalid variable: ${problem}` };
   }
+  const graphAttachProblem = graph.attachments ? attachmentListProblem(graph.attachments) : null;
+  if (graphAttachProblem) return { ok: false, error: `graph attachments: ${graphAttachProblem}` };
   if (topoOrder(graph).length !== graph.nodes.length) return { ok: false, error: 'the graph has a cycle' };
   return { ok: true, graph };
 }
@@ -89,6 +99,7 @@ const newNode = z.object({
   workspace: z.string().optional(),
   model: stepModel.optional(),
   effort: effort.optional(),
+  attachments: attachmentNames.optional(),
   position: position.optional(),
 });
 
@@ -104,6 +115,7 @@ const nodePatch = z.object({
   // null clears the step's own model or effort.
   model: stepModel.nullable().optional(),
   effort: effort.nullable().optional(),
+  attachments: attachmentNames.optional(),
 });
 
 const changeTarget = z.discriminatedUnion('kind', [z.object({ kind: z.literal('node'), id: z.string() }), z.object({ kind: z.literal('edge'), id: z.string() }), z.object({ kind: z.literal('all') })]);
@@ -120,6 +132,7 @@ const opSchema = z.discriminatedUnion('type', [
   z.object({ type: z.literal('renameVariable'), name: z.string(), newName: z.string() }),
   z.object({ type: z.literal('setVariableDescription'), name: z.string(), description: z.string() }),
   z.object({ type: z.literal('deleteVariable'), name: z.string() }),
+  z.object({ type: z.literal('setGraphAttachments'), names: attachmentNames }),
   z.object({ type: z.literal('moveNode'), id: z.string(), position }),
   z.object({ type: z.literal('acceptChange'), target: changeTarget }),
   z.object({ type: z.literal('revertChange'), target: changeTarget }),
```

Change `shared/src/types.ts`:

```diff
diff --git a/shared/src/types.ts b/shared/src/types.ts
--- a/shared/src/types.ts
+++ b/shared/src/types.ts
@@ -21,6 +21,8 @@ export type GraphNode = {
   model?: StepModel;
   /** Agent steps: the step's own effort. Missing means the run's effort. */
   effort?: EffortLevel;
+  /** Agent steps: files the step's agent gets every time it runs, by name, in order (step model spec §6b.3). */
+  attachments?: string[];
   position?: Position;
   createdBy: Actor;
   updatedBy: Actor;
@@ -38,6 +40,8 @@ export type Graph = {
   /** Longer guidance every agent step and the planner receive after the goal. */
   instructions: string;
   variables: VariableDef[];
+  /** Files every agent step gets, after the step's own, by name, in order (step model spec §6b.3). */
+  attachments?: string[];
   nodes: GraphNode[];
   edges: Edge[];
   /** Highest node number ever issued, so ids are never reused. */
@@ -59,6 +63,7 @@ export type NewNodeInput = {
   workspace?: string;
   model?: StepModel;
   effort?: EffortLevel;
+  attachments?: string[];
   position?: Position;
 };
 
@@ -78,6 +83,8 @@ export type NodePatch = {
   model?: StepModel | null;
   /** null clears the step's effort (back to the run's). */
   effort?: EffortLevel | null;
+  /** The step's whole attachment list; [] clears it. */
+  attachments?: string[];
 };
 
 export type Op =
@@ -92,6 +99,8 @@ export type Op =
   | { type: 'renameVariable'; name: string; newName: string }
   | { type: 'setVariableDescription'; name: string; description: string }
   | { type: 'deleteVariable'; name: string }
+  /** The graph's whole attachment list; [] clears it (spec §6b.3). */
+  | { type: 'setGraphAttachments'; names: string[] }
   /** `position: null` puts the step back on the automatic layout (only undo does that; clients always send a position). */
   | { type: 'moveNode'; id: string; position: Position | null }
   /** Review of agent changes (agent changes spec §3.4): applied by the graph store, which keeps the baseline. */
@@ -114,7 +123,7 @@ export const MAX_IMPORT_CHARS = 1024 * 1024;
 
 export type ChangeTarget = { kind: 'node'; id: string } | { kind: 'edge'; id: string } | { kind: 'all' };
 
-export type ChangedField = 'title' | 'description' | 'kind' | 'prompt' | 'command' | 'timeoutSec' | 'access' | 'workspace' | 'model' | 'effort';
+export type ChangedField = 'title' | 'description' | 'kind' | 'prompt' | 'command' | 'timeoutSec' | 'access' | 'workspace' | 'model' | 'effort' | 'attachments';
 
 /** One difference between the user's baseline and the graph; `by`/`at` come from the latest agent op that touched it. */
 export type AgentChange =
```

Change `shared/src/undo.ts`:

```diff
diff --git a/shared/src/undo.ts b/shared/src/undo.ts
--- a/shared/src/undo.ts
+++ b/shared/src/undo.ts
@@ -112,6 +112,8 @@ export function undoLabel(op: Op): string | undefined {
       return `edited variable ${op.name}`;
     case 'deleteVariable':
       return `deleted variable ${op.name}`;
+    case 'setGraphAttachments':
+      return "changed the graph's attachments";
     case 'acceptChange':
     case 'revertChange':
       return undefined;
```

Change `web/src/components/ChangesPanel.tsx`:

```diff
diff --git a/web/src/components/ChangesPanel.tsx b/web/src/components/ChangesPanel.tsx
--- a/web/src/components/ChangesPanel.tsx
+++ b/web/src/components/ChangesPanel.tsx
@@ -5,7 +5,7 @@ import { lineDiff } from '../lineDiff';
 import { dispatch, useStore } from '../store';
 
 const ICONS: Record<AgentChange['change'], string> = { added: '＋', changed: '✎', removed: '✕' };
-const FIELD_LABELS: Record<ChangedField, string> = { title: 'Title', description: 'Description', kind: 'Kind', prompt: 'Prompt', command: 'Command', timeoutSec: 'Timeout (seconds)', access: 'Access', workspace: 'Workspace', model: 'Model', effort: 'Effort' };
+const FIELD_LABELS: Record<ChangedField, string> = { title: 'Title', description: 'Description', kind: 'Kind', prompt: 'Prompt', command: 'Command', timeoutSec: 'Timeout (seconds)', access: 'Access', workspace: 'Workspace', model: 'Model', effort: 'Effort', attachments: 'Attachments' };
 
 const target = (c: AgentChange) => ({ kind: c.kind, id: c.id });
 const name = (c: AgentChange) => (c.kind === 'edge' ? `${c.from} → ${c.to}` : c.title);
```

- [ ] **Step 4: Run the tests and typecheck**

Run: `npm test -w shared -- test/attachmentsGraph.test.ts test/stepModels.test.ts`
Expected: PASS.
Run: `npm run typecheck && npm test`
Expected: all workspaces pass (a test that times out only under heavy machine load is not a failure of this task: run it again).

- [ ] **Step 5: Commit**

```bash
git add engine/src/graphStore.ts engine/src/planner.ts engine/src/stepGraphTools.ts shared/src/changes.ts shared/src/graph.ts shared/src/graphDoc.ts shared/src/schemas.ts shared/src/types.ts shared/src/undo.ts shared/test/attachmentsGraph.test.ts web/src/components/ChangesPanel.tsx
git commit -m "feat(shared): step and graph attachment lists" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 14: Attachments in the Markdown file

**Spec covered:** §6b.3 (`- attach:` lines, `## Attachments`, parse errors, a missing file is not an error, round trip, `diffToOps`), docs.

**Files:**
- Modify: `docs/graph-format.md`, `shared/src/diffToOps.ts`, `shared/src/graphDoc.ts`, `shared/src/graphMarkdownParse.ts`, `shared/src/graphMarkdownWrite.ts`, `shared/src/graphMeta.ts`, `shared/src/undo.ts`
- Test: `shared/test/attachmentsMarkdown.test.ts` (new), `shared/test/graphFixtures.ts`, `shared/test/graphMarkdownParse.test.ts`

**Interfaces:**
- Consumes: Task 13.
- Produces: `DocStep.attachments?`, `DocAttachments = { names: string[]; line: number }`, `GraphDoc.attachments?`; the writer's `## Attachments` section after Variables and `- attach:` lines after `effort`; `diffToOps` emits `updateNode { attachments }` and `setGraphAttachments`; `opLine` points at the section; `graphAsDoc` carries both lists.

- [ ] **Step 1: Write the failing tests**

Create `shared/test/attachmentsMarkdown.test.ts`:

````ts
import { describe, expect, it } from 'vitest';
import { diffToOps, opLine } from '../src/diffToOps';
import { canonicalGraph, formatFileErrors, type GraphDoc } from '../src/graphDoc';
import { parseGraphMarkdown } from '../src/graphMarkdownParse';
import { serializeGraphMarkdown } from '../src/graphMarkdownWrite';
import { graphFromDoc, parseGraphMeta, serializeGraphMeta } from '../src/graphMeta';
import type { GraphFileError } from '../src/types';
import { build, T0 } from './graphFixtures';

const md = (...lines: string[]) => lines.join('\n');
const FENCE = '```';
function doc(text: string): GraphDoc {
  const r = parseGraphMarkdown(text);
  if (!r.ok) throw new Error(formatFileErrors(r.errors, 10));
  return r.doc;
}
function errors(text: string): GraphFileError[] {
  const r = parseGraphMarkdown(text);
  if (r.ok) throw new Error('expected errors');
  return r.errors;
}

const g = build('Files', [
  { type: 'addVariable', name: 'target' },
  { type: 'setGraphAttachments', names: ['brief.pdf', 'logo.png'] },
  { type: 'addNode', node: { title: 'Design', kind: 'agent', prompt: 'Build it.', effort: 'high', attachments: ['mockup.png', 'Q3 notes.md'] } },
]);
const text = serializeGraphMarkdown(g);

describe('attachments in the Markdown file (spec §6b.3)', () => {
  it('writes "## Attachments" after Variables, and a step’s attach lines after effort, in order', () => {
    expect(text).toContain(md('## Variables', '', '- `target`', '', '## Attachments', '', '- `brief.pdf`', '- `logo.png`', '', '## Flow'));
    expect(text).toContain(md('- kind: agent', '- effort: high', '- attach: mockup.png', '- attach: Q3 notes.md', '', FENCE + 'prompt'));
  });

  it('reads them back exactly', () => {
    const d = doc(text);
    expect(d.attachments).toEqual({ names: ['brief.pdf', 'logo.png'], line: expect.any(Number) });
    expect(d.steps[0].attachments).toEqual(['mockup.png', 'Q3 notes.md']);
    const reload = graphFromDoc(d, parseGraphMeta(serializeGraphMeta(g)), g.id, T0);
    expect(reload).toEqual(canonicalGraph(g));
    expect(serializeGraphMarkdown(reload)).toBe(text);
  });

  it('a missing file is not an error: the parser checks names only', () => {
    expect(doc(md('# G', '## Attachments', '- `not-pulled-yet.png`')).attachments?.names).toEqual(['not-pulled-yet.png']);
  });

  it('reports unsafe names, duplicates, attach on a command step and stray text, each with its line', () => {
    const rule = "isn't a safe attachment name.";
    const e = errors(
      md(
        '# G',
        '## Attachments',
        '- `../secret.png`',
        '- `a.png`',
        '- `A.png`',
        'some text',
        '## n1 · A',
        '- attach: b.md',
        '- attach: b.md',
        '- attach: c:d.md',
        FENCE + 'prompt',
        FENCE,
        '## n2 · B',
        '- kind: command',
        '- attach: x.md',
        FENCE + 'sh',
        FENCE,
      ),
    );
    expect(e.map((x) => x.line)).toEqual([3, 5, 6, 9, 10, 15]);
    expect(e[0].message).toContain(rule);
    expect(e[1].message).toBe('A.png is attached twice in the graph (also on line 4). Keep one.');
    expect(e[2].message).toBe('each line under "## Attachments" is one file, written as - `name`.');
    expect(e[3].message).toBe('b.md is attached twice in step n1 (also on line 8). Keep one.');
    expect(e[4].message).toContain(rule);
    expect(e[5].message).toBe("step n2 is a command step, so it can't have attachments. Remove this line, or make it an agent step.");
  });

  it('refuses more than 20 in one list', () => {
    const lines = Array.from({ length: 21 }, (_, i) => `- \`f${i}.md\``);
    expect(errors(md('# G', '## Attachments', ...lines))).toEqual([{ line: 23, message: 'the graph has 21 attachments; the most is 20. Remove 1.' }]);
  });
});

describe('diffToOps: attachments', () => {
  const edit = (from: string, to: string) => {
    if (!text.includes(from)) throw new Error(`not in the file: ${from}`);
    return diffToOps(g, doc(text.replace(from, to)));
  };

  it('sets, reorders and clears a step’s list, and the graph’s', () => {
    expect(edit('- attach: Q3 notes.md\n', '')).toEqual([{ type: 'updateNode', id: 'n1', patch: { attachments: ['mockup.png'] } }]);
    expect(edit('- attach: mockup.png\n- attach: Q3 notes.md\n', '- attach: Q3 notes.md\n- attach: mockup.png\n')).toEqual([{ type: 'updateNode', id: 'n1', patch: { attachments: ['Q3 notes.md', 'mockup.png'] } }]);
    expect(edit('- attach: mockup.png\n- attach: Q3 notes.md\n', '')).toEqual([{ type: 'updateNode', id: 'n1', patch: { attachments: [] } }]);
    const ops = edit('- `logo.png`\n', '- `logo.png`\n- `extra.md`\n');
    expect(ops).toEqual([{ type: 'setGraphAttachments', names: ['brief.pdf', 'logo.png', 'extra.md'] }]);
    expect(edit('## Attachments\n\n- `brief.pdf`\n- `logo.png`\n\n', '')).toEqual([{ type: 'setGraphAttachments', names: [] }]);
    const changed = text.replace('- `logo.png`\n', '- `logo.png`\n- `extra.md`\n');
    expect(opLine(doc(changed), ops[0])).toBe(changed.split('\n').indexOf('## Attachments') + 1);
  });
});
````

Change `shared/test/graphFixtures.ts` (the generator sets attachment lists):

`````diff
diff --git a/shared/test/graphFixtures.ts b/shared/test/graphFixtures.ts
--- a/shared/test/graphFixtures.ts
+++ b/shared/test/graphFixtures.ts
@@ -61,6 +61,7 @@ export function rng(seed: number): () => number {
 
 const TEXTS = ['', 'plain', '```', '````js\nx\n````', '{% raw %}{{ x }}{% endraw %}', '## not a heading', '# H1', '\n', ' leading space', 'trailing  ', '~~~', '> quote', '- kind: command', '\\## esc', '日本語 ✓', 'a · b', '"q"', '```\nunclosed', '\r\nwindows'];
 const TITLES = ['Build', 'Prüfen · 日本語', 'Say "hi"', '# hash', 'Goal', 'a\nb', '  padded  ', 'end'];
+const ATTACHMENT_LISTS = [['mockup.png'], ['Q3 report v2.pdf', 'notes.md'], ['größe_1.csv', 'a-b.c.json', 'b.png']];
 const MODELS: StepModel[] = [
   { provider: 'claude', id: 'opus' },
   { provider: 'claude', id: 'claude-opus-4-8' },
@@ -92,9 +93,11 @@ export function randomGraph(seed: number): Graph {
         ...(r() < 0.3 && { position: { x: Math.floor(r() * 500), y: Math.floor(r() * 500) } }),
         ...(kind === 'agent' && r() < 0.4 && { model: pick(MODELS) }),
         ...(kind === 'agent' && r() < 0.4 && { effort: pick(EFFORT_LEVELS) }),
+        ...(kind === 'agent' && r() < 0.3 && { attachments: pick(ATTACHMENT_LISTS) }),
       }),
     );
   }
   for (let a = 1; a <= count; a++) for (let b = a + 1; b <= count; b++) if (r() < 0.3) ops.push(connect(`n${a}`, `n${b}`));
+  if (r() < 0.3) ops.push({ type: 'setGraphAttachments', names: pick(ATTACHMENT_LISTS) });
   return build(pick(['G', 'Graph · 1', 'Ünïcode']), ops);
 }
`````

Change `shared/test/graphMarkdownParse.test.ts` (named exception: the unknown-field message adds attach):

```diff
diff --git a/shared/test/graphMarkdownParse.test.ts b/shared/test/graphMarkdownParse.test.ts
--- a/shared/test/graphMarkdownParse.test.ts
+++ b/shared/test/graphMarkdownParse.test.ts
@@ -186,7 +186,7 @@ describe('parseGraphMarkdown: errors', () => {
     );
     expect(e).toEqual([
       { line: 3, message: 'kind is "robot"; use agent or command.' },
-      { line: 4, message: 'unknown field "colour". Step fields are kind, access, workspace, timeout, model and effort.' },
+      { line: 4, message: 'unknown field "colour". Step fields are kind, access, workspace, timeout, model, effort and attach.' },
       { line: 5, message: 'access is "maybe"; use read or write.' },
       { line: 6, message: `workspace "Bad Name": ${WORKSPACE_NAME_PROBLEM}` },
       { line: 7, message: 'timeout is "1.5"; use a whole number of seconds from 1 to 2147483.' },
```

- [ ] **Step 2: Run the tests and see them fail**

Run: `npm test -w shared -- test/attachmentsMarkdown.test.ts test/graphMarkdownParse.test.ts test/graphMarkdownWrite.test.ts test/diffToOps.test.ts test/undo.test.ts && npm test -w engine -- test/graphFormatDoc.test.ts`
Expected: FAIL — the new modules, exports or behaviour do not exist yet (import errors or assertion failures).

- [ ] **Step 3: Implement**

Change `docs/graph-format.md`:

`````diff
diff --git a/docs/graph-format.md b/docs/graph-format.md
--- a/docs/graph-format.md
+++ b/docs/graph-format.md
@@ -27,6 +27,10 @@ Use the dev target. Never touch prod.
 
 - `target_schema`: Schema the tests write to
 
+## Attachments
+
+- `dim_customer spec.pdf`
+
 ## Flow
 
 ```mermaid
@@ -52,6 +56,7 @@ dbt run-operation table_exists --args '{table: dim_customer}'
 - workspace: wh_a
 - model: claude/sonnet
 - effort: low
+- attach: expected_rows.csv
 
 > Builds the model for the first time.
 
@@ -80,10 +85,11 @@ The file is read line by line. A `#` inside a fenced code block is never read as
   - A name can't be a reserved word: template keywords such as `true`, `none`, `if`, `for`, `set`, `raw`, `loop` and `self`, and names the template engine blocks, such as `constructor` and `__proto__`.
   - A name can't look like a step id (`n` and a number, such as `n1`): those are kept for step outputs, such as `{{ n1.model }}`.
   - A variable listed twice is an error.
+- **`## Attachments`:** files every agent step gets, one per bullet, `` - `name` ``, in order (below). Optional.
 - **`## Flow`:** exactly one ```` ```mermaid ```` block with the connections (below). Without a Flow section no step is connected.
 - **Every other `##` heading is a step.**
 
-Goal, Instructions, Variables and Flow may come in any order, before or between steps, each at most once. Their names are read in any letter case.
+Goal, Instructions, Variables, Attachments and Flow may come in any order, before or between steps, each at most once. Their names are read in any letter case.
 
 ## Steps
 
@@ -103,7 +109,9 @@ A step section holds, in this order:
    - `model`: the agent step's own model, written `<provider>/<model id>`: `claude/opus`, `codex/gpt-6-astra`, `copilot/auto`. The provider is `claude`, `codex` or `copilot`; the model id is everything after the first `/`, exactly as that provider's model list names it (1 to 200 characters, no spaces). Missing means the run's model (the `agentStream.model` setting). Agent Stream doesn't check here that the model exists, so the graph still opens on a machine with another plan or provider: a run checks it when it starts, and a step whose model isn't offered, or belongs to another provider than the run's, uses the run's model, with a warning.
    - `effort`: the agent step's own effort, one of `low`, `medium`, `high`, `xhigh`, `max` or `ultra`. Missing means the run's effort. A level the step's model doesn't offer is left out when the step runs.
 
-   Command steps have no model or effort: either line on a command step is an error.
+   - `attach`: a file the agent step gets every time it runs, by name. Repeat the line for each file; the order is kept.
+
+   Command steps have no model, effort or attachments: any of those lines on a command step is an error.
 2. **A description** (optional): one or more `>` lines, joined with spaces. One plain-language sentence for people: what the step does and why.
 3. **Exactly one code block:**
    - ```` ```prompt ```` (or `text`, `md`) for an agent step's prompt;
@@ -115,6 +123,19 @@ A step section holds, in this order:
 
 Anything else in a step section (a paragraph, a second code block, a sub-heading) is an error: nothing you write is ever dropped silently.
 
+## Attachments
+
+Attachments give agents files and photos as context: a mockup, a spec, sample data. Add them in the graph tab (the Node panel for one step, the Graph panel for every step) with **Add…**, by dragging files in, or by pasting. Agent Stream copies each file into `.agent-stream/attachments/<graph id>/`, and the Markdown file names it:
+
+- under `## Attachments` for every agent step (`` - `brief.pdf` ``), after the step's own;
+- with an `attach` line for one agent step (`- attach: mockup.png`).
+
+That folder is not ignored by Git: attachments are committed with the graph, so teammates get them. Don't attach secrets: attachments are sent to your AI provider.
+
+- **Names** are the file's own name made safe: letters, digits, `.`, `-`, `_` and spaces, at most 100 characters, not starting or ending with `.` or a space. Two files with the same name become `name.png` and `name-2.png`. A name that isn't safe, a name listed twice in one list (in any letter case), more than 20 in one list, and `attach` on a command step are errors.
+- **Types:** images (`png`, `jpg`/`jpeg`, `gif`, `webp`, up to 10 MB), PDFs and text files (`md`, `txt`, `csv`, `tsv`, `json`, `yaml`/`yml`, `sql`, `xml`, `html`, `log` and source code), up to 5 MB.
+- **A missing file** is not an error here, so a graph opens before its files are pulled. A run that starts without one warns in the run dialog and the step's log.
+
 ## The Flow
 
 ```mermaid
`````

Change `shared/src/diffToOps.ts`:

```diff
diff --git a/shared/src/diffToOps.ts b/shared/src/diffToOps.ts
--- a/shared/src/diffToOps.ts
+++ b/shared/src/diffToOps.ts
@@ -25,13 +25,15 @@ function patchOf(node: GraphNode, step: DocStep): NodePatch {
   // A step that becomes a command step loses both without a patch (applyOp drops them).
   if (step.kind === 'agent' && modelText(node.model) !== modelText(step.model)) patch.model = step.model ?? null;
   if (step.kind === 'agent' && (node.effort ?? '') !== (step.effort ?? '')) patch.effort = step.effort ?? null;
+  if (step.kind === 'agent' && JSON.stringify(node.attachments ?? []) !== JSON.stringify(step.attachments ?? [])) patch.attachments = step.attachments ?? [];
   return patch;
 }
 
 /**
  * The operations that turn `current` into what the Markdown file says (Markdown graph files spec §6.3), matching steps
- * by id, in this order: disconnect, deleteNode, addNode, updateNode, connect, setGoal and setInstructions, then
- * variables. `current` is in canonical form (the store keeps it so). The name is not an operation: the store renames.
+ * by id, in this order: disconnect, deleteNode, addNode, updateNode, connect, setGoal and setInstructions, the graph's
+ * attachments, then variables. `current` is in canonical form (the store keeps it so). The name is not an operation:
+ * the store renames.
  */
 export function diffToOps(current: Graph, doc: GraphDoc): Op[] {
   const ops: Op[] = [];
@@ -51,6 +53,8 @@ export function diffToOps(current: Graph, doc: GraphDoc): Op[] {
   for (const e of doc.edges) if (!currentEdges.has(edgeKey(e))) ops.push({ type: 'connect', from: e.from, to: e.to });
   if (doc.goal !== current.goal) ops.push({ type: 'setGoal', goal: doc.goal });
   if (doc.instructions !== current.instructions) ops.push({ type: 'setInstructions', instructions: doc.instructions });
+  const attachments = doc.attachments?.names ?? [];
+  if (JSON.stringify(attachments) !== JSON.stringify(current.attachments ?? [])) ops.push({ type: 'setGraphAttachments', names: attachments });
   const docVariables = new Map(doc.variables.map((v) => [v.name, v]));
   const variables = new Map(current.variables.map((v) => [v.name, v]));
   for (const v of current.variables) if (!docVariables.has(v.name)) ops.push({ type: 'deleteVariable', name: v.name });
@@ -74,6 +78,8 @@ export function opLine(doc: GraphDoc, op: Op): number {
     case 'addVariable':
     case 'setVariableDescription':
       return doc.variables.find((v) => v.name === op.name)?.line ?? 1;
+    case 'setGraphAttachments':
+      return doc.attachments?.line ?? 1;
     default:
       return 1;
   }
```

Change `shared/src/graphDoc.ts`:

```diff
diff --git a/shared/src/graphDoc.ts b/shared/src/graphDoc.ts
--- a/shared/src/graphDoc.ts
+++ b/shared/src/graphDoc.ts
@@ -19,6 +19,7 @@ export type DocStep = {
   /** Agent steps only. */
   model?: StepModel;
   effort?: EffortLevel;
+  attachments?: string[];
   description?: string;
   prompt?: string;
   command?: string;
@@ -26,8 +27,10 @@ export type DocStep = {
   line: number;
 };
 export type DocVariable = { name: string; description: string; line: number };
+/** The graph's "## Attachments" list, with the section's line for messages (step model spec §6b.3). */
+export type DocAttachments = { names: string[]; line: number };
 /** A graph's meaning as its Markdown file states it (Markdown graph files spec §3.1). Positions and bookkeeping are in the side file. */
-export type GraphDoc = { name: string; goal: string; instructions: string; variables: DocVariable[]; steps: DocStep[]; edges: FlowEdge[] };
+export type GraphDoc = { name: string; goal: string; instructions: string; variables: DocVariable[]; attachments?: DocAttachments; steps: DocStep[]; edges: FlowEdge[] };
 export type ParseGraphResult = { ok: true; doc: GraphDoc } | { ok: false; errors: GraphFileError[] };
 
 /** CRLF and lone CR as LF. */
```

Change `shared/src/graphMarkdownParse.ts`:

```diff
diff --git a/shared/src/graphMarkdownParse.ts b/shared/src/graphMarkdownParse.ts
--- a/shared/src/graphMarkdownParse.ts
+++ b/shared/src/graphMarkdownParse.ts
@@ -1,8 +1,9 @@
 import { COMMAND_ALWAYS_WRITES, workspaceNameProblem } from './access';
+import { attachmentNameProblem, MAX_ATTACHMENTS } from './attachments';
 import { fenceCloses, fenceOpening, type Fence } from './fence';
 import { unescapeFreeTextLine } from './freeText';
 import { nodeIdProblem } from './graph';
-import { MAX_TIMEOUT_SEC, STEP_SEPARATOR, type DocStep, type DocVariable, type ParseGraphResult } from './graphDoc';
+import { MAX_TIMEOUT_SEC, STEP_SEPARATOR, type DocAttachments, type DocStep, type DocVariable, type ParseGraphResult } from './graphDoc';
 import { parseFlow, type FlowEdge } from './graphFlow';
 import type { EffortLevel, GraphFileError, NodeKind, StepModel } from './types';
 import { isEffortLevel } from './format';
@@ -15,13 +16,17 @@ type Item = TextItem | CodeItem;
 type Section = { level: 1 | 2; title: string; line: number; items: Item[] };
 
 const HEADING_RE = /^(#{1,2})(?=[ \t]|$)[ \t]*(.*?)[ \t]*$/;
-const RESERVED = { goal: 'Goal', instructions: 'Instructions', variables: 'Variables', flow: 'Flow' } as const;
+const RESERVED = { goal: 'Goal', instructions: 'Instructions', variables: 'Variables', attachments: 'Attachments', flow: 'Flow' } as const;
 type Reserved = (typeof RESERVED)[keyof typeof RESERVED];
 const STEP_HEADING_RE = new RegExp(`^([A-Za-z0-9_-]+)${STEP_SEPARATOR.trimEnd()}(?: (.*))?$`);
 const FIELD_RE = /^[-*][ \t]+([A-Za-z]+)[ \t]*:[ \t]*(.*?)[ \t]*$/;
 const VARIABLE_RE = /^[-*][ \t]+`([^`]*)`(?:[ \t]*:[ \t]*(.*?))?[ \t]*$/;
 const QUOTE_RE = /^>[ \t]?(.*)$/;
-const FIELD_NAMES = ['kind', 'access', 'workspace', 'timeout', 'model', 'effort'];
+const FIELD_NAMES = ['kind', 'access', 'workspace', 'timeout', 'model', 'effort', 'attach'];
+/** A field a step may repeat: one line per attachment, in order (spec §6b.3). */
+const LIST_FIELDS = new Set(['attach']);
+const ATTACHMENT_RE = /^[-*][ \t]+`([^`]*)`[ \t]*$/;
+const ATTACHMENTS_FORM = 'each line under "## Attachments" is one file, written as - `name`.';
 const AGENT_INFOS = new Set(['prompt', 'text', 'md']);
 const COMMAND_INFOS = new Set(['sh', 'bash', 'shell']);
 const START = 'the file must start with the graph\'s name, as "# Name".';
@@ -98,6 +103,42 @@ function readVariables(section: Section, errors: GraphFileError[]): DocVariable[
   return out;
 }
 
+/**
+ * Names in one list (a step's attach lines, or "## Attachments"): each a safe name, none twice in any letter case, at most
+ * 20. `where` names the list in messages.
+ */
+function attachmentNames(entries: { value: string; line: number }[], where: string, errors: GraphFileError[]): string[] {
+  const names: string[] = [];
+  const seen = new Map<string, number>();
+  for (const e of entries) {
+    const problem = attachmentNameProblem(e.value);
+    if (problem) {
+      errors.push({ line: e.line, message: `${problem} Rename the file in the graph's attachments folder and here.` });
+      continue;
+    }
+    const earlier = seen.get(e.value.toLowerCase());
+    if (earlier !== undefined) {
+      errors.push({ line: e.line, message: `${e.value} is attached twice in ${where} (also on line ${earlier}). Keep one.` });
+      continue;
+    }
+    seen.set(e.value.toLowerCase(), e.line);
+    names.push(e.value);
+  }
+  if (names.length > MAX_ATTACHMENTS) errors.push({ line: entries[MAX_ATTACHMENTS].line, message: `${where} has ${names.length} attachments; the most is ${MAX_ATTACHMENTS}. Remove ${names.length - MAX_ATTACHMENTS}.` });
+  return names;
+}
+
+function readAttachments(section: Section, errors: GraphFileError[]): DocAttachments {
+  const entries: { value: string; line: number }[] = [];
+  for (const item of section.items) {
+    if (isBlank(item)) continue;
+    const m = item.kind === 'text' ? ATTACHMENT_RE.exec(item.text.trim()) : null;
+    if (!m) errors.push({ line: item.line, message: ATTACHMENTS_FORM });
+    else entries.push({ value: m[1], line: item.line });
+  }
+  return { names: attachmentNames(entries, 'the graph', errors), line: section.line };
+}
+
 function readFlow(section: Section, stepIds: ReadonlySet<string>, errors: GraphFileError[]): FlowEdge[] {
   const blocks: CodeItem[] = [];
   for (const item of section.items) {
@@ -131,6 +172,7 @@ function readStep(section: Section, errors: GraphFileError[]): DocStep | null {
   }
   if (!title) fail(section.line, id ? `step ${id} needs a title after "${STEP_SEPARATOR.trim()}".` : 'this step needs a title after "##".');
   const fields = new Map<string, { value: string; line: number }>();
+  const lists = new Map<string, { value: string; line: number }[]>();
   const quote: string[] = [];
   let code: CodeItem | undefined;
   let phase: 'fields' | 'description' | 'code' = 'fields';
@@ -146,7 +188,8 @@ function readStep(section: Section, errors: GraphFileError[]): DocStep | null {
     if (field) {
       const key = field[1].toLowerCase();
       if (phase !== 'fields') fail(item.line, `fields go at the top of step ${label}, before the description and the code block.`);
-      else if (!FIELD_NAMES.includes(key)) fail(item.line, `unknown field "${field[1]}". Step fields are kind, access, workspace, timeout, model and effort.`);
+      else if (!FIELD_NAMES.includes(key)) fail(item.line, `unknown field "${field[1]}". Step fields are kind, access, workspace, timeout, model, effort and attach.`);
+      else if (LIST_FIELDS.has(key)) lists.set(key, [...(lists.get(key) ?? []), { value: field[2], line: item.line }]);
       else if (fields.has(key)) fail(item.line, `the field ${key} appears twice in step ${label}. Keep one.`);
       else fields.set(key, { value: field[2], line: item.line });
       continue;
@@ -218,6 +261,12 @@ function readStep(section: Section, errors: GraphFileError[]): DocStep | null {
     } else if (isEffortLevel(f.value)) effort = f.value;
     else fail(f.line, `effort is "${f.value}"; use low, medium, high, xhigh, max or ultra.`);
   }
+  // Its attachments (spec §6b.3). Whether the files are there is checked when a run starts, not here.
+  const attachLines = lists.get('attach') ?? [];
+  let attachments: string[] = [];
+  if (attachLines.length && finalKind === 'command') {
+    for (const a of attachLines) fail(a.line, `step ${label} is a command step, so it can't have attachments. Remove this line, or make it an agent step.`);
+  } else attachments = attachmentNames(attachLines, `step ${label}`, errors);
   if (errors.length > before || !code || !finalKind) return null;
   const description = quote
     .map((q) => q.trim())
@@ -233,6 +282,7 @@ function readStep(section: Section, errors: GraphFileError[]): DocStep | null {
     ...(timeoutSec !== undefined && { timeoutSec }),
     ...(model && { model }),
     ...(effort && { effort }),
+    ...(attachments.length > 0 && { attachments }),
     ...(description && { description }),
     ...(text && (finalKind === 'agent' ? { prompt: text } : { command: text })),
     line: section.line,
@@ -262,6 +312,7 @@ export function parseGraphMarkdown(text: string): ParseGraphResult {
   let goal = '';
   let instructions = '';
   let variables: DocVariable[] = [];
+  let attachments: DocAttachments | undefined;
   let flow: Section | undefined;
   const reservedAt = new Map<Reserved, number>();
   const stepSections: Section[] = [];
@@ -281,6 +332,7 @@ export function parseGraphMarkdown(text: string): ParseGraphResult {
     if (reserved === 'Goal') goal = freeText(s.items);
     else if (reserved === 'Instructions') instructions = freeText(s.items);
     else if (reserved === 'Variables') variables = readVariables(s, errors);
+    else if (reserved === 'Attachments') attachments = readAttachments(s, errors);
     else flow = s;
   }
 
@@ -295,7 +347,7 @@ export function parseGraphMarkdown(text: string): ParseGraphResult {
   const steps = stepSections.map((s) => readStep(s, errors)).filter((s): s is DocStep => s !== null);
   const edges = flow ? readFlow(flow, new Set(idLines.keys()), errors) : [];
   if (errors.length) return { ok: false, errors: errors.sort((a, b) => a.line - b.line) };
-  return { ok: true, doc: { name: h1!.title, goal, instructions, variables, steps, edges } };
+  return { ok: true, doc: { name: h1!.title, goal, instructions, variables, ...(attachments?.names.length && { attachments }), steps, edges } };
 }
 
 /** The file's lines: a leading BOM dropped, CRLF and CR read as LF. */
```

Change `shared/src/graphMarkdownWrite.ts`:

```diff
diff --git a/shared/src/graphMarkdownWrite.ts b/shared/src/graphMarkdownWrite.ts
--- a/shared/src/graphMarkdownWrite.ts
+++ b/shared/src/graphMarkdownWrite.ts
@@ -30,6 +30,7 @@ function stepLines(node: GraphNode): string[] {
   if (node.timeoutSec !== undefined) fields.push(`- timeout: ${timeoutValue(node.timeoutSec)}`);
   if (node.kind === 'agent' && node.model) fields.push(`- model: ${stepModelText(node.model)}`);
   if (node.kind === 'agent' && node.effort) fields.push(`- effort: ${node.effort}`);
+  if (node.kind === 'agent') for (const name of node.attachments ?? []) fields.push(`- attach: ${name}`);
   const description = oneLine(node.description ?? '');
   const text = normText((node.kind === 'agent' ? node.prompt : node.command) ?? '');
   return [
@@ -44,8 +45,8 @@ function stepLines(node: GraphNode): string[] {
 
 /**
  * The graph's Markdown file (Markdown graph files spec §2, §4.1). Pure and deterministic: name, Goal, Instructions,
- * Variables, Flow, then the steps in canvas order; empty Goal, Instructions and Variables left out; LF line endings and
- * one trailing newline. Positions and bookkeeping go to the side file instead.
+ * Variables, Attachments, Flow, then the steps in canvas order; empty Goal, Instructions, Variables and Attachments left
+ * out; LF line endings and one trailing newline. Positions and bookkeeping go to the side file instead.
  */
 export function serializeGraphMarkdown(graph: Graph): string {
   const out = [`# ${oneLine(graph.name)}`];
@@ -63,6 +64,7 @@ export function serializeGraphMarkdown(graph: Graph): string {
       }),
     );
   }
+  if (graph.attachments?.length) section('Attachments', graph.attachments.map((name) => `- \`${name}\``));
   section('Flow', block('mermaid', flowLines(graph).join('\n')));
   for (const node of graph.nodes) out.push('', ...stepLines(node));
   return `${out.join('\n')}\n`;
```

Change `shared/src/graphMeta.ts`:

```diff
diff --git a/shared/src/graphMeta.ts b/shared/src/graphMeta.ts
--- a/shared/src/graphMeta.ts
+++ b/shared/src/graphMeta.ts
@@ -96,6 +96,7 @@ export function graphFromDoc(doc: GraphDoc, meta: GraphMeta | undefined, id: str
     goal: doc.goal,
     instructions: doc.instructions,
     variables: doc.variables.map(({ name, description }) => ({ name, description })),
+    ...(doc.attachments?.names.length && { attachments: [...doc.attachments.names] }),
     nodes,
     edges: doc.edges.map(({ from, to }) => ({ id: edgeId(from, to), from, to })),
     nodeSeq: seq,
```

Change `shared/src/undo.ts`:

```diff
diff --git a/shared/src/undo.ts b/shared/src/undo.ts
--- a/shared/src/undo.ts
+++ b/shared/src/undo.ts
@@ -50,7 +50,8 @@ export function graphAsDoc(g: Graph): GraphDoc {
     goal: g.goal,
     instructions: g.instructions,
     variables: g.variables.map((v) => ({ name: v.name, description: v.description, line: 1 })),
-    steps: g.nodes.map(({ id, title, kind, access, workspace, timeoutSec, model, effort, description, prompt, command }) => ({
+    ...(g.attachments?.length && { attachments: { names: [...g.attachments], line: 1 } }),
+    steps: g.nodes.map(({ id, title, kind, access, workspace, timeoutSec, model, effort, attachments, description, prompt, command }) => ({
       id,
       title,
       kind,
@@ -59,6 +60,7 @@ export function graphAsDoc(g: Graph): GraphDoc {
       ...(timeoutSec !== undefined && { timeoutSec }),
       ...(model && { model }),
       ...(effort && { effort }),
+      ...(attachments?.length && { attachments: [...attachments] }),
       ...(description && { description }),
       ...(prompt && { prompt }),
       ...(command && { command }),
```

- [ ] **Step 4: Run the tests and typecheck**

Run: `npm test -w shared -- test/attachmentsMarkdown.test.ts test/graphMarkdownParse.test.ts test/graphMarkdownWrite.test.ts test/diffToOps.test.ts test/undo.test.ts && npm test -w engine -- test/graphFormatDoc.test.ts`
Expected: PASS.
Run: `npm run typecheck && npm test`
Expected: all workspaces pass (a test that times out only under heavy machine load is not a failure of this task: run it again).

- [ ] **Step 5: Commit**

```bash
git add docs/graph-format.md shared/src/diffToOps.ts shared/src/graphDoc.ts shared/src/graphMarkdownParse.ts shared/src/graphMarkdownWrite.ts shared/src/graphMeta.ts shared/src/undo.ts shared/test/attachmentsMarkdown.test.ts shared/test/graphFixtures.ts shared/test/graphMarkdownParse.test.ts
git commit -m "feat: attachments in graph Markdown files" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 15: Storing attachments: Add, Remove, Open, undo, delete and duplicate

**Spec covered:** §6b.2 (storage, safe names, clashes, limits, remove when unreferenced, delete and duplicate a graph, the one-time notice), §6b.4 (Add…, Open, Remove, history, undo), §7 storage and UI-side engine tests.

**Files:**
- Create: `engine/src/attachmentStore.ts`
- Modify: `engine/src/app.ts`, `engine/src/fsutil.ts`, `engine/src/graphStore.ts`, `engine/src/paths.ts`, `engine/src/undoStacks.ts`, `extension/src/graphEditor.ts`, `shared/src/schemas.ts`, `shared/src/types.ts`, `shared/src/undo.ts`, `web/src/state.ts`
- Test: `engine/test/attachApp.test.ts` (new), `engine/test/attachmentStore.test.ts` (new), `extension/test/attachFiles.test.ts` (new)

**Interfaces:**
- Consumes: Tasks 12–14, Task 9's undo.
- Produces:
  ```ts
  // shared types: AttachTarget = { kind: 'graph' } | { kind: 'step'; nodeId: string }; AttachmentUpload = { name: string; data: string /* base64 */ };
  // ClientMessage 'attach' { graphId, target, files } and 'detach' { graphId, target, name }; ServerMessage 'attached' { graphId, target, names, notice? };
  // WebviewHostMessage 'pickAttachments' { target } and 'openAttachment' { name }.
  // engine: ProjectPaths.attachmentsDir, graphAttachmentsDir(paths, graphId); AttachmentStore (add, restore, exists, read, hash, remove, names, dir, path);
  // AttachmentFile = { name: string; bytes: Uint8Array }; UndoEntry.files?: { written?: string[]; deleted?: AttachmentFile[] }; App.attachments; GraphStore.brokenFile is public.
  // extension: MessageHandlerDeps.pickFiles?(), openPath?(); PickedFile; pickFilesToAttach().
  ```

`writeFileAtomic` now also writes bytes. `undoState` includes the graph's own attachment list (without it an attach to the graph would not be an undo step).

- [ ] **Step 1: Write the failing tests**

Create `engine/test/attachApp.test.ts`:

```ts
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ATTACHMENT_NOTICE, type AttachTarget, type ServerMessage } from '@agent-stream/shared';
import { createApp } from '../src/app';
import { appTestDeps, signedIn, testGitBash, testProvider, tmpProject, tmpValuesFile } from './helpers';

const b64 = (text: string) => Buffer.from(text).toString('base64');

function setup() {
  const paths = tmpProject();
  const app = createApp({ ...appTestDeps(), projectDir: paths.root, valuesFile: tmpValuesFile(), provider: testProvider(), status: signedIn, maxParallel: 1, gitBash: testGitBash });
  const graphId = app.graphStore.create('G').id;
  app.graphStore.apply(graphId, { type: 'addNode', node: { id: 'n1', title: 'Design', kind: 'agent', prompt: 'p' } }, 'user');
  app.graphStore.apply(graphId, { type: 'addNode', node: { id: 'n2', title: 'Build', kind: 'command', command: 'make' } }, 'user');
  const msgs: ServerMessage[] = [];
  const c = { send: (m: ServerMessage) => void msgs.push(m) };
  app.connect(c);
  const last = <T extends ServerMessage['type']>(type: T) => msgs.filter((m): m is Extract<ServerMessage, { type: T }> => m.type === type).at(-1);
  const attach = (target: AttachTarget, ...files: [string, string][]) => app.handle(c, { type: 'attach', graphId, target, files: files.map(([name, text]) => ({ name, data: b64(text) })) });
  const detach = (target: AttachTarget, name: string) => app.handle(c, { type: 'detach', graphId, target, name });
  const graph = () => app.graphStore.get(graphId);
  const file = (name: string) => join(paths.dataDir, 'attachments', graphId, name);
  const md = () => readFileSync(join(paths.graphsDir, `${graphId}.md`), 'utf8');
  return { app, graphId, c, last, attach, detach, graph, file, md, paths };
}
const step: AttachTarget = { kind: 'step', nodeId: 'n1' };
const whole: AttachTarget = { kind: 'graph' };

describe('attaching files (step model spec §6b.4)', () => {
  it('copies them in, adds them to the step or the graph as a user edit, and shows the notice once', async () => {
    const s = setup();
    await s.attach(step, ['mockup.png', 'png-bytes']);
    expect(s.last('attached')).toEqual({ type: 'attached', graphId: s.graphId, target: step, names: ['mockup.png'], notice: ATTACHMENT_NOTICE });
    expect(readFileSync(s.file('mockup.png'), 'utf8')).toBe('png-bytes');
    expect(s.graph().nodes[0].attachments).toEqual(['mockup.png']);
    expect(s.md()).toContain('- attach: mockup.png');
    expect(s.app.graphStore.readOps(s.graphId).at(-1)).toMatchObject({ by: 'user', op: { type: 'updateNode', id: 'n1', patch: { attachments: ['mockup.png'] } } });
    await s.attach(whole, ['brief.pdf', '%PDF'], ['mockup.png', 'other']);
    expect(s.last('attached')).toEqual({ type: 'attached', graphId: s.graphId, target: whole, names: ['brief.pdf', 'mockup-2.png'] });
    expect(s.graph().attachments).toEqual(['brief.pdf', 'mockup-2.png']);
    expect(s.md()).toContain('## Attachments\n\n- `brief.pdf`\n- `mockup-2.png`\n');
    expect(s.last('undoState')?.label).toBe('attached brief.pdf, mockup-2.png');
  });

  it('refuses, writing no file: a command step, an unknown step, a type it doesn’t take, more than 20, a file with errors', async () => {
    const s = setup();
    await s.attach({ kind: 'step', nodeId: 'n2' }, ['a.md', 'x']);
    expect(s.last('opRejected')?.error).toBe('Only agent steps have attachments.');
    await s.attach({ kind: 'step', nodeId: 'n9' }, ['a.md', 'x']);
    expect(s.last('opRejected')?.error).toBe('node n9 does not exist');
    await s.attach(step, ['tool.exe', 'MZ']);
    expect(s.last('opRejected')?.error).toContain("tool.exe can't be attached.");
    for (let i = 0; i < 20; i++) await s.attach(whole, [`f${i}.md`, 'x']);
    await s.attach(whole, ['one-more.md', 'x']);
    expect(s.last('opRejected')?.error).toBe('The graph can have at most 20 attachments.');
    expect(s.app.attachments.names(s.graphId)).toHaveLength(20);
    writeFileSync(join(s.paths.graphsDir, `${s.graphId}.md`), `${s.md()}\n## Broken\n`);
    s.app.graphFileChanged(s.graphId);
    await s.attach(step, ['late.md', 'x']);
    expect(s.last('opRejected')?.error).toMatch(/^The file .*\.md has errors/);
    expect(s.app.attachments.exists(s.graphId, 'late.md')).toBe(false);
  });

  it('removes a name, and its file only when nothing else in the graph uses it', async () => {
    const s = setup();
    await s.attach(step, ['mockup.png', 'png']);
    s.app.graphStore.apply(s.graphId, { type: 'setGraphAttachments', names: ['mockup.png'] }, 'user');
    await s.detach(step, 'mockup.png');
    expect(s.graph().nodes[0]).not.toHaveProperty('attachments');
    expect(s.app.attachments.exists(s.graphId, 'mockup.png')).toBe(true);
    await s.detach(whole, 'mockup.png');
    expect(s.app.attachments.exists(s.graphId, 'mockup.png')).toBe(false);
    await s.detach(whole, 'mockup.png');
    expect(s.last('opRejected')?.error).toBe("mockup.png isn't attached there.");
  });

  it('undo covers attaching and removing, files included', async () => {
    const s = setup();
    await s.attach(step, ['mockup.png', 'png']);
    await s.detach(step, 'mockup.png');
    expect(s.app.attachments.exists(s.graphId, 'mockup.png')).toBe(false);
    await s.app.handle(s.c, { type: 'undo', graphId: s.graphId });
    expect(s.last('undone')?.message).toBe('Undid removed mockup.png.');
    expect(readFileSync(s.file('mockup.png'), 'utf8')).toBe('png');
    expect(s.graph().nodes[0].attachments).toEqual(['mockup.png']);
    await s.app.handle(s.c, { type: 'undo', graphId: s.graphId });
    expect(s.last('undone')?.message).toBe('Undid attached mockup.png.');
    expect(s.app.attachments.exists(s.graphId, 'mockup.png')).toBe(false);
    expect(s.graph().nodes[0]).not.toHaveProperty('attachments');
  });

  it('deleting the graph deletes its attachments folder', async () => {
    const s = setup();
    await s.attach(step, ['mockup.png', 'png']);
    expect(s.app.deleteGraph(s.graphId)).toEqual({ ok: true });
    expect(s.app.attachments.names(s.graphId)).toEqual([]);
  });
});
```

Create `engine/test/attachmentStore.test.ts`:

```ts
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AttachmentStore } from '../src/attachmentStore';
import { GraphStore } from '../src/graphStore';
import { fixedClock, tmpProject } from './helpers';

const bytes = (text: string) => new TextEncoder().encode(text);

describe('AttachmentStore (step model spec §6b.2)', () => {
  it('copies files into .agent-stream/attachments/<graph id>/ under their own names made safe', () => {
    const paths = tmpProject();
    const store = new AttachmentStore(paths);
    const r = store.add('g', [{ name: '/Users/me/My Mockup (v2).png', bytes: bytes('png') }, { name: 'C:\\notes\\spec.md', bytes: bytes('# Spec') }]);
    expect(r).toEqual({ ok: true, names: ['My Mockup _v2_.png', 'spec.md'], firstInFolder: true });
    expect(readFileSync(join(paths.dataDir, 'attachments', 'g', 'spec.md'), 'utf8')).toBe('# Spec');
    expect(store.names('g').sort()).toEqual(['My Mockup _v2_.png', 'spec.md']);
    expect(store.add('g', [{ name: 'other.md', bytes: bytes('x') }])).toMatchObject({ ok: true, firstInFolder: false });
  });

  it('gives a clash -2, -3: with files there, names the graph uses, and the same batch', () => {
    const store = new AttachmentStore(tmpProject());
    store.add('g', [{ name: 'mockup.png', bytes: bytes('1') }]);
    const r = store.add('g', [{ name: 'Mockup.png', bytes: bytes('2') }, { name: 'mockup.png', bytes: bytes('3') }, { name: 'brief.pdf', bytes: bytes('4') }], ['brief.pdf']);
    expect(r).toMatchObject({ ok: true, names: ['Mockup-2.png', 'mockup-3.png', 'brief-2.pdf'] });
  });

  it('refuses a type it doesn’t take or a file over the limit, and then writes none of the batch', () => {
    const paths = tmpProject();
    const store = new AttachmentStore(paths);
    expect(store.add('g', [{ name: 'ok.md', bytes: bytes('x') }, { name: 'tool.exe', bytes: bytes('MZ') }])).toEqual({ ok: false, error: expect.stringContaining("tool.exe can't be attached.") });
    expect(store.add('g', [{ name: 'huge.pdf', bytes: new Uint8Array(5 * 1024 * 1024 + 1) }])).toEqual({ ok: false, error: 'huge.pdf is larger than 5 MB.' });
    expect(existsSync(join(paths.dataDir, 'attachments', 'g'))).toBe(false);
  });

  it('hashes a file, says when one is missing, removes and restores', () => {
    const store = new AttachmentStore(tmpProject());
    store.add('g', [{ name: 'a.txt', bytes: bytes('abc') }]);
    expect(store.hash('g', 'a.txt')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(store.hash('g', 'gone.txt')).toBeUndefined();
    const saved = store.read('g', 'a.txt')!;
    store.remove('g', 'a.txt');
    expect(store.exists('g', 'a.txt')).toBe(false);
    store.restore('g', { name: 'a.txt', bytes: saved });
    expect(store.hash('g', 'a.txt')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('a graph’s delete removes its folder, and its duplicate copies it', () => {
    const paths = tmpProject();
    const graphs = new GraphStore(paths, fixedClock());
    const files = new AttachmentStore(paths);
    const { id } = graphs.create('Shots');
    files.add(id, [{ name: 'a.png', bytes: bytes('png') }]);
    const copy = graphs.duplicate(id);
    if (!copy.ok) throw new Error(copy.error);
    expect(files.names(copy.graph.id)).toEqual(['a.png']);
    writeFileSync(files.path(copy.graph.id, 'a.png'), 'changed');
    expect(readFileSync(files.path(id, 'a.png'), 'utf8')).toBe('png');
    expect(graphs.delete(id)).toEqual({ ok: true });
    expect(existsSync(files.dir(id))).toBe(false);
    expect(files.names(copy.graph.id)).toEqual(['a.png']);
  });
});
```

Create `extension/test/attachFiles.test.ts`:

```ts
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createApp, createClaudeProvider } from '@agent-stream/engine';
import type { HostMessage, ServerMessage } from '@agent-stream/shared';
import type { Folder } from '../src/engines';
import { createMessageHandler, GraphPanel, type PickedFile } from '../src/graphEditor';
import { engineTestDeps } from './helpers';

function setup(picked: PickedFile[] | undefined) {
  const path = mkdtempSync(join(tmpdir(), 'cs-attach-'));
  const folder: Folder = { key: `file://${path}`, name: 'a', path };
  const done = async () => ({ ok: true, output: '' });
  const app = createApp({
    ...engineTestDeps(),
    projectDir: path,
    provider: createClaudeProvider({ findClaude: () => ({ ok: true, path: '/bin/claude' }) }),
    status: { provider: 'claude', ok: true, label: 'Claude Max' },
    maxParallel: 1,
    executors: { agent: done, command: done },
    valuesFile: join(mkdtempSync(join(tmpdir(), 'cs-home-')), 'values.json'),
  });
  const graph = app.createGraph('G');
  const posted: HostMessage[] = [];
  const panel = new GraphPanel(folder, graph.id, { post: (m) => void posted.push(m), reveal: vi.fn(), close: vi.fn(), visible: () => false, active: () => false });
  const received: ServerMessage[] = [];
  const openPath = vi.fn();
  const handler = createMessageHandler({
    app,
    panel,
    client: { send: (m) => void received.push(m) },
    runHostCommand: vi.fn(),
    setMinimap: vi.fn(),
    setUpParallelTickets: vi.fn(),
    exportRunReport: vi.fn(),
    activeSession: () => 'default',
    pickFiles: async () => picked,
    openPath,
  });
  return { app, graph, path, received, handler, openPath };
}
const file = (name: string, text: string, size = text.length): PickedFile & { read: ReturnType<typeof vi.fn> } => ({ name, size, read: vi.fn(async () => new TextEncoder().encode(text)) });

describe('Add… and Open in a graph tab (step model spec §6b.4)', () => {
  it('attaches the picked files to the graph through the engine', async () => {
    const s = setup([file('/Users/me/brief.pdf', '%PDF-1.7')]);
    s.handler.handle({ type: 'pickAttachments', target: { kind: 'graph' } });
    await vi.waitFor(() => expect(s.received.some((m) => m.type === 'attached')).toBe(true), { timeout: 5000 });
    expect(s.app.graphStore.get(s.graph.id).attachments).toEqual(['brief.pdf']);
    expect(readFileSync(join(s.path, '.agent-stream', 'attachments', s.graph.id, 'brief.pdf'), 'utf8')).toBe('%PDF-1.7');
  });

  it('refuses a file over the limit before reading it, and does nothing when cancelled', async () => {
    const huge = file('photo.png', '', 11 * 1024 * 1024);
    const s = setup([huge]);
    s.handler.handle({ type: 'pickAttachments', target: { kind: 'graph' } });
    await vi.waitFor(() => expect(s.received).toContainEqual({ type: 'opRejected', graphId: s.graph.id, error: 'photo.png is larger than 10 MB (the limit for images).' }), { timeout: 5000 });
    expect(huge.read).not.toHaveBeenCalled();
    const cancelled = setup(undefined);
    cancelled.handler.handle({ type: 'pickAttachments', target: { kind: 'graph' } });
    await new Promise((r) => setTimeout(r, 10));
    expect(cancelled.received.filter((m) => m.type === 'attached' || m.type === 'opRejected')).toEqual([]);
  });

  it('opens an attachment from the graph’s folder, and never a path outside it', () => {
    const s = setup([]);
    s.handler.handle({ type: 'openAttachment', name: 'mockup.png' });
    expect(s.openPath).toHaveBeenCalledWith(join(s.path, '.agent-stream', 'attachments', s.graph.id, 'mockup.png'));
    s.handler.handle({ type: 'openAttachment', name: '../../.ssh/id_rsa' });
    expect(s.openPath).toHaveBeenCalledTimes(1);
    expect(s.received.at(-1)).toEqual({ type: 'error', message: "Agent Stream can't open ../../.ssh/id_rsa." });
  });
});
```

- [ ] **Step 2: Run the tests and see them fail**

Run: `npm test -w engine -- test/attachmentStore.test.ts test/attachApp.test.ts test/undo.test.ts && npm test -w extension -- test/attachFiles.test.ts`
Expected: FAIL — the new modules, exports or behaviour do not exist yet (import errors or assertion failures).

- [ ] **Step 3: Implement**

Create `engine/src/attachmentStore.ts`:

```ts
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { attachmentFileProblem, MAX_ATTACHMENTS, safeAttachmentName, uniqueAttachmentName } from '@agent-stream/shared';
import { writeFileAtomic } from './fsutil';
import { graphAttachmentsDir, type ProjectPaths } from './paths';

/** A file to attach: its own name (any path, made safe here) and its bytes. */
export type AttachmentFile = { name: string; bytes: Uint8Array };
export type AddedAttachments = { ok: true; names: string[]; firstInFolder: boolean } | { ok: false; error: string };

/**
 * Each graph's attachment files (step model spec §6b.2), copied into `.agent-stream/attachments/<graph id>/`. The graph's
 * Markdown file names them; this store only keeps the bytes.
 */
export class AttachmentStore {
  constructor(private paths: ProjectPaths) {}

  dir(graphId: string): string {
    return graphAttachmentsDir(this.paths, graphId);
  }

  path(graphId: string, name: string): string {
    return join(this.dir(graphId), name);
  }

  /** The files in the graph's folder, by name. */
  names(graphId: string): string[] {
    const dir = this.dir(graphId);
    return existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name) : [];
  }

  /**
   * Copies files in under their own names made safe, `-2`, `-3`… on a clash with a file there or a name the graph uses
   * (`taken`). Every file is checked first (type, size, how many), so all are added or none.
   */
  add(graphId: string, files: readonly AttachmentFile[], taken: Iterable<string> = []): AddedAttachments {
    if (files.length > MAX_ATTACHMENTS) return { ok: false, error: `Attach at most ${MAX_ATTACHMENTS} files at a time.` };
    for (const f of files) {
      const problem = attachmentFileProblem(safeAttachmentName(f.name), f.bytes.byteLength);
      if (problem) return { ok: false, error: problem };
    }
    const dir = this.dir(graphId);
    const firstInFolder = !existsSync(dir) || this.names(graphId).length === 0;
    mkdirSync(dir, { recursive: true });
    const used = new Set([...this.names(graphId), ...taken]);
    const names: string[] = [];
    for (const f of files) {
      const name = uniqueAttachmentName(safeAttachmentName(f.name), used);
      used.add(name);
      writeFileAtomic(this.path(graphId, name), Buffer.from(f.bytes));
      names.push(name);
    }
    return { ok: true, names, firstInFolder };
  }

  /** Puts a removed file back (undo), unless one with its name is there again. */
  restore(graphId: string, file: AttachmentFile): void {
    if (this.exists(graphId, file.name)) return;
    mkdirSync(this.dir(graphId), { recursive: true });
    writeFileAtomic(this.path(graphId, file.name), Buffer.from(file.bytes));
  }

  exists(graphId: string, name: string): boolean {
    return existsSync(this.path(graphId, name));
  }

  read(graphId: string, name: string): Buffer | undefined {
    return this.exists(graphId, name) ? readFileSync(this.path(graphId, name)) : undefined;
  }

  /** The file's SHA-256 (hex), or undefined when it is missing: the run snapshot records it (spec §6b.5). */
  hash(graphId: string, name: string): string | undefined {
    const bytes = this.read(graphId, name);
    return bytes && createHash('sha256').update(bytes).digest('hex');
  }

  remove(graphId: string, name: string): void {
    rmSync(this.path(graphId, name), { force: true });
  }
}
```

Change `engine/src/app.ts`:

```diff
diff --git a/engine/src/app.ts b/engine/src/app.ts
--- a/engine/src/app.ts
+++ b/engine/src/app.ts
@@ -32,6 +32,10 @@ import {
   type SessionResult,
   type SessionTab,
   supportsEffort,
+  ATTACHMENT_NOTICE,
+  MAX_ATTACHMENTS,
+  ONLY_AGENT_STEPS_ATTACH,
+  type AttachTarget,
   MARKDOWN_SAVE_LABEL,
   NOTHING_TO_UNDO,
   UNDO_CHANGED,
@@ -43,6 +47,7 @@ import {
   withStepModelLines,
 } from '@agent-stream/shared';
 import { ApprovalBroker } from './approvals';
+import { AttachmentStore, type AttachmentFile } from './attachmentStore';
 import { systemClock, type Clock } from './clock';
 import { createCommandExecutor } from './commandExecutor';
 import type { Executors, NodeExecutor } from './executors';
@@ -154,6 +159,7 @@ export function createApp(d: AppDeps) {
   if (d.legacyValuesFile) migrationWarnings.push(...migrateValuesFile(d.valuesFile, d.legacyValuesFile, d.rename));
   ensureDataDirs(paths);
   const graphStore = new GraphStore(paths, clock);
+  const attachments = new AttachmentStore(paths);
   const sessions = new SessionStore(paths, clock);
   // Planner state and chats from before work sessions move into the Default session.
   const legacyMoveFailed = new Set<string>();
@@ -497,8 +503,8 @@ export function createApp(d: AppDeps) {
     const label = undo.top(client, graphId)?.label;
     client.send({ type: 'undoState', graphId, ...(label !== undefined && { label }) });
   }
-  function recordUndo(client: Client, graphId: string, before: Graph, after: Graph, label: string, ops: Op[]): void {
-    if (undo.record(client, graphId, { before, after, label, ops })) sendUndoState(client, graphId);
+  function recordUndo(client: Client, graphId: string, before: Graph, after: Graph, label: string, ops: Op[], files?: { written?: string[]; deleted?: AttachmentFile[] }): void {
+    if (undo.record(client, graphId, { before, after, label, ops, ...(files && { files }) })) sendUndoState(client, graphId);
   }
   /**
    * Edit › Undo: restores the graph from before this tab's newest action, as user edits recorded `via: 'undo'` — only when
@@ -518,15 +524,74 @@ export function createApp(d: AppDeps) {
       undo.clear(client, graphId);
       return done(UNDO_CHANGED);
     }
+    // A removed attachment's file comes back before the graph names it again.
+    for (const f of entry.files?.deleted ?? []) attachments.restore(graphId, f);
     const r = graphStore.applyBatch(graphId, undoOps(current.graph, entry.before, entry.ops), 'user', { via: 'undo' });
     if (!r.ok) {
       undo.clear(client, graphId);
       return done(`Can't undo ${entry.label}: ${r.error}`);
     }
+    // An attached file nothing uses any more goes again.
+    for (const name of entry.files?.written ?? []) if (!attachedNames(r.graph).includes(name)) attachments.remove(graphId, name);
     undo.pop(client, graphId);
     done(undoneMessage(entry.label));
   }
 
+  /** Every attachment name the graph uses: its own list and every step's. */
+  const attachedNames = (g: Graph): string[] => [...(g.attachments ?? []), ...g.nodes.flatMap((n) => n.attachments ?? [])];
+  /** The target's attachment list, or why it has none. */
+  function attachmentList(g: Graph, target: AttachTarget): { ok: true; names: string[] } | { ok: false; error: string } {
+    if (target.kind === 'graph') return { ok: true, names: g.attachments ?? [] };
+    const node = g.nodes.find((n) => n.id === target.nodeId);
+    if (!node) return { ok: false, error: `node ${target.nodeId} does not exist` };
+    if (node.kind !== 'agent') return { ok: false, error: ONLY_AGENT_STEPS_ATTACH };
+    return { ok: true, names: node.attachments ?? [] };
+  }
+  const listOp = (target: AttachTarget, names: string[]): Op =>
+    target.kind === 'graph' ? { type: 'setGraphAttachments', names } : { type: 'updateNode', id: target.nodeId, patch: { attachments: names } };
+  /**
+   * Attaches files (spec §6b.4): each is checked, copied into the graph's attachments folder under its own name made safe,
+   * and added to the target's list as a user edit (one undo step). Files of an edit that is refused are removed again.
+   */
+  function attach(client: Client, msg: Extract<ClientMessage, { type: 'attach' }>): void {
+    const reject = (error: string) => client.send({ type: 'opRejected', graphId: msg.graphId, error });
+    const g = graphStore.load(msg.graphId);
+    if (!g.ok) return reject(g.error);
+    const broken = graphStore.brokenFile(msg.graphId);
+    if (broken) return reject(broken);
+    const list = attachmentList(g.graph, msg.target);
+    if (!list.ok) return reject(list.error);
+    if (list.names.length + msg.files.length > MAX_ATTACHMENTS) {
+      return reject(`${msg.target.kind === 'graph' ? 'The graph' : `Step ${msg.target.nodeId}`} can have at most ${MAX_ATTACHMENTS} attachments.`);
+    }
+    const files = msg.files.map((f) => ({ name: f.name, bytes: Buffer.from(f.data, 'base64') }));
+    const added = attachments.add(msg.graphId, files, attachedNames(g.graph));
+    if (!added.ok) return reject(added.error);
+    const op = listOp(msg.target, [...list.names, ...added.names]);
+    const r = graphStore.apply(msg.graphId, op, 'user');
+    if (!r.ok) {
+      for (const name of added.names) attachments.remove(msg.graphId, name);
+      return reject(r.error);
+    }
+    recordUndo(client, msg.graphId, g.graph, r.graph, `attached ${added.names.join(', ')}`, [op], { written: added.names });
+    client.send({ type: 'attached', graphId: msg.graphId, target: msg.target, names: added.names, ...(added.firstInFolder && { notice: ATTACHMENT_NOTICE }) });
+  }
+  /** Removes a name from the target's list; its file is deleted once nothing in the graph uses it (spec §6b.2). Undo brings both back. */
+  function detach(client: Client, msg: Extract<ClientMessage, { type: 'detach' }>): void {
+    const reject = (error: string) => client.send({ type: 'opRejected', graphId: msg.graphId, error });
+    const g = graphStore.load(msg.graphId);
+    if (!g.ok) return reject(g.error);
+    const list = attachmentList(g.graph, msg.target);
+    if (!list.ok) return reject(list.error);
+    if (!list.names.includes(msg.name)) return reject(`${msg.name} isn't attached there.`);
+    const op = listOp(msg.target, list.names.filter((n) => n !== msg.name));
+    const r = graphStore.apply(msg.graphId, op, 'user');
+    if (!r.ok) return reject(r.error);
+    const bytes = attachedNames(r.graph).includes(msg.name) ? undefined : attachments.read(msg.graphId, msg.name);
+    if (bytes) attachments.remove(msg.graphId, msg.name);
+    recordUndo(client, msg.graphId, g.graph, r.graph, `removed ${msg.name}`, [op], bytes ? { deleted: [{ name: msg.name, bytes }] } : undefined);
+  }
+
   /** A revert would change a step that a run in progress is about to run or is running. */
   function revertBlockedByRun(graphId: string, op: Op): boolean {
     if (op.type !== 'revertChange') return false;
@@ -616,6 +681,10 @@ export function createApp(d: AppDeps) {
       }
       case 'undo':
         return undoLast(client, msg.graphId);
+      case 'attach':
+        return attach(client, msg);
+      case 'detach':
+        return detach(client, msg);
       case 'getGraphMarkdown': {
         const text = graphStore.markdownText(msg.graphId);
         if (text === undefined) return error(`graph "${msg.graphId}" not found`);
@@ -896,6 +965,7 @@ export function createApp(d: AppDeps) {
     handle,
     requestRun,
     graphStore,
+    attachments,
     runStore,
     sessionStore: sessions,
     runner,
```

Change `engine/src/fsutil.ts`:

```diff
diff --git a/engine/src/fsutil.ts b/engine/src/fsutil.ts
--- a/engine/src/fsutil.ts
+++ b/engine/src/fsutil.ts
@@ -2,7 +2,7 @@ import { randomBytes } from 'node:crypto';
 import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
 
 /** Write to a temp file (created with `mode`, if given), then rename, so readers never see a half-written file. */
-export function writeFileAtomic(path: string, data: string, mode?: number): void {
+export function writeFileAtomic(path: string, data: string | Uint8Array, mode?: number): void {
   const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
   try {
     writeFileSync(tmp, data, mode === undefined ? undefined : { mode });
```

Change `engine/src/graphStore.ts`:

```diff
diff --git a/engine/src/graphStore.ts b/engine/src/graphStore.ts
--- a/engine/src/graphStore.ts
+++ b/engine/src/graphStore.ts
@@ -1,5 +1,5 @@
 import { EventEmitter } from 'node:events';
-import { appendFileSync, existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
+import { appendFileSync, cpSync, existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
 import { join } from 'node:path';
 import {
   applyOp,
@@ -36,7 +36,7 @@ import {
 } from '@agent-stream/shared';
 import { systemClock, type Clock } from './clock';
 import { readJsonLines, writeFileAtomic } from './fsutil';
-import { isGraphId, type ProjectPaths } from './paths';
+import { graphAttachmentsDir, isGraphId, type ProjectPaths } from './paths';
 import { renameReferences } from './templates';
 
 export function slugify(name: string): string {
@@ -296,7 +296,7 @@ export class GraphStore extends EventEmitter {
   }
 
   /** While the Markdown file has errors, edits that would rewrite it are refused, so a half-finished hand edit is never lost. */
-  private brokenFile(id: string): string | null {
+  brokenFile(id: string): string | null {
     const errors = this.fileErrors(id);
     return errors.length ? `The file ${id}.md has errors (${formatFileErrors(errors)}). Fix it first: until then this graph can't be changed here.` : null;
   }
@@ -377,15 +377,20 @@ export class GraphStore extends EventEmitter {
     const names = new Set(this.list().map((g) => g.name));
     let name = `${r.graph.name} copy`;
     for (let i = 2; names.has(name); i++) name = `${r.graph.name} copy ${i}`;
-    const graph = this.save({ ...r.graph, id: this.uniqueId(name), name, updatedAt: this.clock() });
+    const copy = this.uniqueId(name);
+    // Its attachments come along (step model spec §6b.2), before its file names them.
+    const files = graphAttachmentsDir(this.paths, id);
+    if (existsSync(files)) cpSync(files, graphAttachmentsDir(this.paths, copy), { recursive: true });
+    const graph = this.save({ ...r.graph, id: copy, name, updatedAt: this.clock() });
     return { ok: true, graph };
   }
 
-  /** Removes the graph, its side file, its agent-change baseline, its edit history and its chat. Run logs stay on disk. */
+  /** Removes the graph, its side file, its agent-change baseline, its edit history, its chat and its attachments. Run logs stay on disk. */
   delete(id: string): { ok: true } | { ok: false; error: string } {
     if (!isGraphId(id)) return { ok: false, error: `invalid graph id "${id}"` };
     if (!existsSync(this.file(id))) return { ok: false, error: `graph "${id}" not found` };
     for (const f of [this.file(id), this.metaFile(id), this.baselineFile(id), this.opsFile(id), this.chatFile(id)]) rmSync(f, { force: true });
+    rmSync(graphAttachmentsDir(this.paths, id), { recursive: true, force: true });
     this.forget(id);
     return { ok: true };
   }
```

Change `engine/src/paths.ts`:

```diff
diff --git a/engine/src/paths.ts b/engine/src/paths.ts
--- a/engine/src/paths.ts
+++ b/engine/src/paths.ts
@@ -1,13 +1,17 @@
 import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
 import { join } from 'node:path';
 
-export type ProjectPaths = { root: string; dataDir: string; graphsDir: string; runsDir: string; sessionsDir: string };
+/** `attachmentsDir`: each graph's attachments, in a folder per graph id; not ignored by Git (step model spec §6b.2). */
+export type ProjectPaths = { root: string; dataDir: string; graphsDir: string; runsDir: string; sessionsDir: string; attachmentsDir: string };
 
 export function projectPaths(root: string): ProjectPaths {
   const dataDir = join(root, '.agent-stream');
-  return { root, dataDir, graphsDir: join(dataDir, 'graphs'), runsDir: join(dataDir, 'runs'), sessionsDir: join(dataDir, 'sessions') };
+  return { root, dataDir, graphsDir: join(dataDir, 'graphs'), runsDir: join(dataDir, 'runs'), sessionsDir: join(dataDir, 'sessions'), attachmentsDir: join(dataDir, 'attachments') };
 }
 
+/** Where a graph's attachments are: `.agent-stream/attachments/<graph id>/`. */
+export const graphAttachmentsDir = (paths: ProjectPaths, graphId: string): string => join(paths.attachmentsDir, graphId);
+
 /** Run records and personal work sessions stay out of git. */
 const GITIGNORE_LINES = ['runs/', 'sessions/'];
 
```

Change `engine/src/undoStacks.ts`:

```diff
diff --git a/engine/src/undoStacks.ts b/engine/src/undoStacks.ts
--- a/engine/src/undoStacks.ts
+++ b/engine/src/undoStacks.ts
@@ -1,7 +1,11 @@
 import { MAX_UNDO, undoState, type Graph, type Op } from '@agent-stream/shared';
+import type { AttachmentFile } from './attachmentStore';
 
-/** One user action in a tab: the graph before and after it, its label, and the edits it was made of. */
-export type UndoEntry = { before: Graph; after: Graph; label: string; ops: Op[] };
+/**
+ * One user action in a tab: the graph before and after it, its label, and the edits it was made of. `files`: attachment
+ * files it wrote (undo deletes them when nothing uses them) or deleted (undo puts them back) (step model spec §6b.4).
+ */
+export type UndoEntry = { before: Graph; after: Graph; label: string; ops: Op[]; files?: { written?: string[]; deleted?: AttachmentFile[] } };
 
 /**
  * Each tab's undo stack per graph (step model spec §6a.2), newest last, at most MAX_UNDO entries. In memory only: a tab
```

Change `extension/src/graphEditor.ts`:

```diff
diff --git a/extension/src/graphEditor.ts b/extension/src/graphEditor.ts
--- a/extension/src/graphEditor.ts
+++ b/extension/src/graphEditor.ts
@@ -1,7 +1,8 @@
 import { randomBytes } from 'node:crypto';
+import { basename, join } from 'node:path';
 import * as vscode from 'vscode';
 import { isGraphId, type App, type Client } from '@agent-stream/engine';
-import { parseWebviewMessage, type HostCommand, type HostMessage } from '@agent-stream/shared';
+import { attachmentFileProblem, attachmentNameProblem, parseWebviewMessage, safeAttachmentName, type AttachTarget, type AttachmentUpload, type HostCommand, type HostMessage } from '@agent-stream/shared';
 import type { EngineManager, Folder } from './engines';
 import { folderUri } from './folders';
 import { openExternalUrl } from './ui';
@@ -117,12 +118,40 @@ export type MessageHandlerDeps = {
   setUpParallelTickets(folder: Folder): void;
   /** Run › Export Run Report… or the Report button: save the run's report and open it. */
   exportRunReport(folder: Folder, graphId: string, runId: string): void;
+  /** Add…: VS Code's file picker (step model spec §6b.4); undefined when cancelled. */
+  pickFiles?(): Promise<PickedFile[] | undefined>;
+  /** Open: shows a file in VS Code (images in its image viewer). */
+  openPath?(path: string): void;
 };
 
+/** A file picked to attach: read only once its size is known to fit. */
+export type PickedFile = { name: string; size: number; read(): Promise<Uint8Array> };
+
+/** VS Code's file picker for Add… (step model spec §6b.4). */
+export async function pickFilesToAttach(): Promise<PickedFile[] | undefined> {
+  const uris = await vscode.window.showOpenDialog({ canSelectMany: true, openLabel: 'Attach' });
+  if (!uris?.length) return undefined;
+  return Promise.all(
+    uris.map(async (uri) => ({ name: basename(uri.fsPath), size: (await vscode.workspace.fs.stat(uri)).size, read: () => Promise.resolve(vscode.workspace.fs.readFile(uri)) })),
+  );
+}
+
 /** Routes what a tab posts: engine messages to its folder's engine, the tab's own messages to the extension. */
 export function createMessageHandler(d: MessageHandlerDeps): { handle(raw: unknown): void; dispose(): void } {
   let detach: (() => void) | undefined;
   const fail = (message: string) => d.client.send({ type: 'error', message });
+  /** Reads the picked files (each checked first, so a huge one is never read) and attaches them through the engine. */
+  async function attachPicked(target: AttachTarget): Promise<void> {
+    const picked = await d.pickFiles?.();
+    if (!picked?.length) return;
+    const files: AttachmentUpload[] = [];
+    for (const f of picked) {
+      const problem = attachmentFileProblem(safeAttachmentName(f.name), f.size);
+      if (problem) return d.client.send({ type: 'opRejected', graphId: d.panel.graphId, error: problem });
+      files.push({ name: f.name, data: Buffer.from(await f.read()).toString('base64') });
+    }
+    await d.app.handle(d.client, { type: 'attach', graphId: d.panel.graphId, target, files });
+  }
   return {
     handle(raw) {
       const parsed = parseWebviewMessage(raw);
@@ -165,6 +194,14 @@ export function createMessageHandler(d: MessageHandlerDeps): { handle(raw: unkno
         case 'refineSteps':
           d.app.handle(d.client, { type: 'refineSteps', graphId: d.panel.graphId, sessionId: d.activeSession(d.panel.folder), nodeIds: msg.nodeIds }).catch((e: unknown) => fail(e instanceof Error ? e.message : String(e)));
           return;
+        case 'pickAttachments':
+          attachPicked(msg.target).catch((e: unknown) => fail(e instanceof Error ? e.message : String(e)));
+          return;
+        case 'openAttachment':
+          // Only a safe name: never a path out of the graph's attachments folder.
+          if (attachmentNameProblem(msg.name)) return fail(`Agent Stream can't open ${msg.name}.`);
+          d.openPath?.(join(d.panel.folder.path, '.agent-stream', 'attachments', d.panel.graphId, msg.name));
+          return;
       }
     },
     dispose() {
@@ -237,6 +274,8 @@ export class GraphEditorProvider implements vscode.CustomReadonlyEditorProvider
       activeSession: (f) => this.d.activeSession(f),
       setUpParallelTickets: (f) => this.d.setUpParallelTickets(f),
       exportRunReport: (f, graphId, runId) => this.d.exportRunReport(f, graphId, runId),
+      pickFiles: pickFilesToAttach,
+      openPath: (path) => void vscode.commands.executeCommand('vscode.open', vscode.Uri.file(path)),
       setMinimap: (value) => {
         this.d.setMinimap(value);
         for (const other of this.d.panels.all()) if (other !== panel) other.send({ type: 'prefs', minimap: value });
```

Change `shared/src/schemas.ts`:

```diff
diff --git a/shared/src/schemas.ts b/shared/src/schemas.ts
--- a/shared/src/schemas.ts
+++ b/shared/src/schemas.ts
@@ -18,6 +18,9 @@ const stepModel = z.object({ provider: z.enum(PROVIDER_IDS), id: z.string().rege
 const effort = z.enum(EFFORT_LEVELS);
 /** An attachment list as a client sends it; the names are checked by attachmentListProblem in applyOp. */
 const attachmentNames = z.array(z.string().max(200)).max(MAX_ATTACHMENTS);
+const attachTarget = z.discriminatedUnion('kind', [z.object({ kind: z.literal('graph') }), z.object({ kind: z.literal('step'), nodeId: z.string() })]);
+/** A file's bytes as base64: an image of 10 MB is under 14 million characters. */
+const upload = z.object({ name: z.string().min(1).max(1000), data: z.string().max(14_000_000) });
 
 const graphNodeSchema = z.object({
   id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
@@ -148,6 +151,8 @@ const clientMessageSchema = z.discriminatedUnion('type', [
   z.object({ type: z.literal('op'), graphId: z.string(), op: opSchema }),
   z.object({ type: z.literal('ops'), graphId: z.string(), ops: z.array(opSchema).min(1).max(500), label: z.string().min(1).max(MAX_UNDO_LABEL_CHARS) }),
   z.object({ type: z.literal('undo'), graphId: z.string() }),
+  z.object({ type: z.literal('attach'), graphId: z.string(), target: attachTarget, files: z.array(upload).min(1).max(MAX_ATTACHMENTS) }),
+  z.object({ type: z.literal('detach'), graphId: z.string(), target: attachTarget, name: z.string().max(200) }),
   z.object({ type: z.literal('getGraphMarkdown'), graphId: z.string() }),
   z.object({ type: z.literal('saveGraphMarkdown'), graphId: z.string(), text: markdownText, base: markdownText, force: z.boolean().optional() }),
   z.object({ type: z.literal('openChat'), graphId: z.string(), sessionId: z.string() }),
@@ -181,6 +186,8 @@ const webviewHostSchema = z.discriminatedUnion('type', [
   z.object({ type: z.literal('exportRunReport'), runId: z.string() }),
   z.object({ type: z.literal('setUpParallelTickets') }),
   z.object({ type: z.literal('openExternal'), url: z.string().max(4096) }),
+  z.object({ type: z.literal('pickAttachments'), target: attachTarget }),
+  z.object({ type: z.literal('openAttachment'), name: z.string().max(200) }),
 ]);
 
 /** Validates what a graph tab posts: an engine message, or one of the tab's own messages for the extension. */
```

Change `shared/src/types.ts`:

```diff
diff --git a/shared/src/types.ts b/shared/src/types.ts
--- a/shared/src/types.ts
+++ b/shared/src/types.ts
@@ -311,6 +311,10 @@ export const EFFORT_LEVELS: readonly EffortLevel[] = ['low', 'medium', 'high', '
  * runs when none is chosen (Codex marks one; Claude Code has a `default` row instead).
  */
 export type ModelChoice = { value: string; label: string; description?: string; efforts: EffortLevel[]; unavailable?: boolean; resolved?: string; isDefault?: boolean };
+/** Where an attachment goes: the whole graph, or one agent step (step model spec §6b.1). */
+export type AttachTarget = { kind: 'graph' } | { kind: 'step'; nodeId: string };
+/** A file a tab sends: its own name, and its bytes as base64. */
+export type AttachmentUpload = { name: string; data: string };
 /** A step's own model: the provider's model id exactly as its model list reports it, tagged with the provider (spec §2.1). */
 export type StepModel = { provider: ProviderId; id: string };
 /** A model and effort choice; an absent field means Default. */
@@ -391,6 +395,8 @@ export type ServerMessage =
   | { type: 'undoState'; graphId: string; label?: string }
   /** The answer to undo, for the toast: `Undid moved 2 steps.`, `Nothing to undo.`, or why it can't. */
   | { type: 'undone'; graphId: string; message: string }
+  /** Files were attached under these names; `notice`: the one-time notice for a graph's first attachment (spec §6b.2). */
+  | { type: 'attached'; graphId: string; target: AttachTarget; names: string[]; notice?: string }
   | { type: 'error'; message: string };
 
 export type ClientMessage =
@@ -401,6 +407,10 @@ export type ClientMessage =
   | { type: 'ops'; graphId: string; ops: Op[]; label: string }
   /** Edit › Undo (⌘Z): reverses this tab's newest graph edit, if the graph is still as that edit left it. */
   | { type: 'undo'; graphId: string }
+  /** Copies files into the graph's attachments folder and adds them to the target's list (spec §6b.4). */
+  | { type: 'attach'; graphId: string; target: AttachTarget; files: AttachmentUpload[] }
+  /** Removes one name from the target's list; its file goes when nothing in the graph uses it any more (spec §6b.2). */
+  | { type: 'detach'; graphId: string; target: AttachTarget; name: string }
   /** Asks for the graph's Markdown file as it is on disk; the engine answers with graphMarkdown and keeps sending it as the text changes. */
   | { type: 'getGraphMarkdown'; graphId: string }
   /**
@@ -449,7 +459,11 @@ export type WebviewHostMessage =
   /** Export Run Report: the extension saves the selected run's report to a file and opens it. */
   | { type: 'exportRunReport'; runId: string }
   | { type: 'setUpParallelTickets' }
-  | { type: 'openExternal'; url: string };
+  | { type: 'openExternal'; url: string }
+  /** Add…: the extension shows VS Code's file picker and attaches the files picked (spec §6b.4). */
+  | { type: 'pickAttachments'; target: AttachTarget }
+  /** Open: the extension opens the graph's attachment in VS Code (images in its image viewer). */
+  | { type: 'openAttachment'; name: string };
 
 export type WebviewMessage = ClientMessage | WebviewHostMessage;
 
```

Change `shared/src/undo.ts`:

```diff
diff --git a/shared/src/undo.ts b/shared/src/undo.ts
--- a/shared/src/undo.ts
+++ b/shared/src/undo.ts
@@ -38,6 +38,7 @@ export function undoState(g: Graph): string {
     goal: g.goal,
     instructions: g.instructions,
     variables: [...g.variables].sort(byKey((v) => v.name)),
+    attachments: g.attachments ?? [],
     nodes: [...g.nodes].sort(byKey((n) => n.id)).map(({ createdBy: _c, updatedBy: _u, updatedAt: _a, ...n }) => n),
     edges: g.edges.map((e) => `${e.from}->${e.to}`).sort(),
   });
```

Change `web/src/state.ts`:

```diff
diff --git a/web/src/state.ts b/web/src/state.ts
--- a/web/src/state.ts
+++ b/web/src/state.ts
@@ -351,6 +351,9 @@ function reduceServer(state: State, msg: HostMessage): State {
       return msg.graphId === current ? { ...state, undoLabel: msg.label } : state;
     case 'undone':
       return msg.graphId === current ? { ...state, toast: msg.message } : state;
+    case 'attached':
+      // The graph's first attachment: the one-time notice (spec §6b.2).
+      return msg.graphId === current && msg.notice ? { ...state, toast: msg.notice } : state;
     case 'error':
       // A save the engine or the extension refused before it could answer (a message too large, a throw) is over too.
       return { ...state, toast: msg.message, ...(state.markdown.saving && { markdown: { ...state.markdown, saving: undefined } }) };
```

- [ ] **Step 4: Run the tests and typecheck**

Run: `npm test -w engine -- test/attachmentStore.test.ts test/attachApp.test.ts test/undo.test.ts && npm test -w extension -- test/attachFiles.test.ts`
Expected: PASS.
Run: `npm run typecheck && npm test`
Expected: all workspaces pass (a test that times out only under heavy machine load is not a failure of this task: run it again).

- [ ] **Step 5: Commit**

```bash
git add engine/src/app.ts engine/src/attachmentStore.ts engine/src/fsutil.ts engine/src/graphStore.ts engine/src/paths.ts engine/src/undoStacks.ts engine/test/attachApp.test.ts engine/test/attachmentStore.test.ts extension/src/graphEditor.ts extension/test/attachFiles.test.ts shared/src/schemas.ts shared/src/types.ts shared/src/undo.ts web/src/state.ts
git commit -m "feat: attach files to steps and graphs" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 16: Runs with attachments: snapshot, warnings, reuse, Run Report

**Spec covered:** §6b.5 (run snapshot hashes, missing-file warning in the dialog and the step log, Run Report), §7 runs tests (snapshot, warning, report), reuse by content (P10).

**Files:**
- Create: `engine/src/attachedFiles.ts`
- Modify: `engine/src/app.ts`, `engine/src/executors.ts`, `engine/src/runPreview.ts`, `engine/src/runReport.ts`, `engine/src/runner.ts`, `shared/src/graph.ts`, `shared/src/types.ts`
- Test: `engine/test/attachRun.test.ts` (new), `shared/test/attachmentsGraph.test.ts`

**Interfaces:**
- Consumes: Task 15's `AttachmentStore.hash`.
- Produces: `RunAttachment = { name; sha256? }`, `RunMeta.attachments?`, `RunSource.attachments?`, `reusableNodeIds(…, attachments?)`; `PreviewInput.attachments?`; `StartRunInput.attachments?`; `engine/src/attachedFiles.ts`: `StepAttachment = { name, path, shown, kind, missing }`, `attachmentNamesOf`, `runAttachments`, `stepAttachments`, `missingAttachmentLine`; `NodeContext.attachments?: StepAttachment[]` (the providers use it in Task 17).

- [ ] **Step 1: Write the failing tests**

Create `engine/test/attachRun.test.ts`:

```ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { applyOp, emptyGraph, type Graph, type NodeEvent, type Op, type RunMeta, type ServerMessage } from '@agent-stream/shared';
import { createApp } from '../src/app';
import { ApprovalBroker } from '../src/approvals';
import type { NodeContext, NodeExecutor } from '../src/executors';
import { buildRunReport } from '../src/runReport';
import { previewRun } from '../src/runPreview';
import { Runner } from '../src/runner';
import { RunStore } from '../src/runStore';
import { appTestDeps, signedIn, testGitBash, testLeases, testProvider, tmpProject, tmpValuesFile } from './helpers';

function graphOf(ops: Op[]): Graph {
  let g = emptyGraph('g', 'G', 't');
  for (const op of ops) {
    const r = applyOp(g, op, 'user', 't');
    if (!r.ok) throw new Error(r.error);
    g = r.graph;
  }
  return g;
}
const graph = graphOf([
  { type: 'setGraphAttachments', names: ['brief.pdf', 'logo.png'] },
  { type: 'addNode', node: { title: 'Design', kind: 'agent', prompt: 'p', attachments: ['mockup.png', 'logo.png'] } },
  { type: 'addNode', node: { title: 'Plain', kind: 'agent', prompt: 'p' } },
  { type: 'addNode', node: { title: 'Build', kind: 'command', command: 'make' } },
]);

describe('the run dialog: missing attachments (spec §6b.5)', () => {
  it('warns for each missing file a running step uses, and never blocks', () => {
    const { preview } = previewRun({ graph, values: {}, env: () => undefined, attachments: [{ name: 'brief.pdf', sha256: 'a' }, { name: 'logo.png' }, { name: 'mockup.png' }] });
    expect(preview.problems).toEqual([]);
    expect(preview.warnings).toEqual([
      "The graph's attachment logo.png is missing from .agent-stream/attachments/g/, so agent steps run without it.",
      "n1's attachment mockup.png is missing from .agent-stream/attachments/g/, so the step runs without it.",
      "n1's attachment logo.png is missing from .agent-stream/attachments/g/, so the step runs without it.",
    ]);
  });
});

describe('Runner: a step’s attachments (spec §6b.5)', () => {
  it('records the files’ hashes, gives each agent step its own then the graph’s, and logs a missing one', async () => {
    const paths = tmpProject();
    const dir = join(paths.dataDir, 'attachments', 'g');
    mkdirSync(dir, { recursive: true });
    for (const name of ['brief.pdf', 'logo.png']) writeFileSync(join(dir, name), name);
    const runStore = new RunStore(paths);
    const seen: Record<string, NodeContext['attachments']> = {};
    const exec: NodeExecutor = async (ctx) => {
      ctx.emit({ type: 'start', kind: ctx.node.kind, cwd: ctx.cwd });
      seen[ctx.node.id] = ctx.attachments;
      return { ok: true, output: '' };
    };
    const runner = new Runner({ runStore, broker: new ApprovalBroker(), executors: { agent: exec, command: exec }, projectDir: paths.root, maxParallel: 1, leases: testLeases() });
    const rendered = { goal: '', instructions: '', nodes: { n1: 'p', n2: 'p', n3: 'make' } };
    const files = [{ name: 'brief.pdf', sha256: 'h1' }, { name: 'logo.png', sha256: 'h2' }, { name: 'mockup.png' }];
    const started = runner.start({ graph, rendered, attachments: files });
    if (!started.ok) throw new Error(started.error);
    const done = await started.done;
    expect(done.attachments).toEqual(files);
    expect(seen.n1?.map((f) => [f.name, f.kind, f.missing, f.shown])).toEqual([
      ['mockup.png', 'image', true, join('.agent-stream', 'attachments', 'g', 'mockup.png')],
      ['logo.png', 'image', false, join('.agent-stream', 'attachments', 'g', 'logo.png')],
      ['brief.pdf', 'pdf', false, join('.agent-stream', 'attachments', 'g', 'brief.pdf')],
    ]);
    expect(seen.n1?.[1].path).toBe(join(dir, 'logo.png'));
    expect(seen.n2?.map((f) => f.name)).toEqual(['brief.pdf', 'logo.png']);
    expect(seen.n3).toBeUndefined();
    const log: NodeEvent[] = runStore.readEvents(done.id, 'n1');
    expect(log.slice(0, 2)).toMatchObject([{ type: 'start' }, { type: 'text', text: 'Attachment mockup.png is missing from .agent-stream/attachments/g/, so this step runs without it.' }]);
  });
});

describe('Run Report: attachments (spec §6b.5)', () => {
  it('lists each agent step’s files by name and hash, never their contents', () => {
    const run: RunMeta = {
      id: 'r1',
      graphId: 'g',
      status: 'succeeded',
      startedAt: 't0',
      snapshot: graph,
      nodes: { n1: { status: 'succeeded' }, n2: { status: 'succeeded' }, n3: { status: 'succeeded' } },
      attachments: [{ name: 'brief.pdf', sha256: 'a'.repeat(64) }, { name: 'logo.png', sha256: 'b'.repeat(64) }, { name: 'mockup.png' }],
    };
    const md = buildRunReport({ graphName: 'G', run, steps: {}, now: 't1' });
    expect(md).toContain(`**Attachments**\n\n- mockup.png · missing when the run started\n- logo.png · sha256 ${'b'.repeat(64)}\n- brief.pdf · sha256 ${'a'.repeat(64)}\n`);
    expect(md.split('**Attachments**')).toHaveLength(3);
  });
});

describe('App: runs with attachments', () => {
  it('runs a step again when its file changed since the run it re-runs from', async () => {
    const paths = tmpProject();
    const provider = testProvider({ runStep: async (ctx) => (ctx.emit({ type: 'start', kind: 'agent', cwd: ctx.cwd }), { ok: true, output: '' }) });
    const app = createApp({ ...appTestDeps(), projectDir: paths.root, valuesFile: tmpValuesFile(), provider, status: signedIn, maxParallel: 1, gitBash: testGitBash });
    const graphId = app.graphStore.create('G').id;
    app.graphStore.apply(graphId, { type: 'addNode', node: { id: 'n1', title: 'one', kind: 'agent', prompt: 'p' } }, 'user');
    app.graphStore.apply(graphId, { type: 'addNode', node: { id: 'n2', title: 'two', kind: 'agent', prompt: 'p' } }, 'user');
    app.graphStore.apply(graphId, { type: 'connect', from: 'n1', to: 'n2' }, 'user');
    const msgs: ServerMessage[] = [];
    const c = { send: (m: ServerMessage) => void msgs.push(m) };
    app.connect(c);
    const last = <T extends ServerMessage['type']>(type: T) => msgs.filter((m): m is Extract<ServerMessage, { type: T }> => m.type === type).at(-1)!;
    await app.handle(c, { type: 'attach', graphId, target: { kind: 'step', nodeId: 'n1' }, files: [{ name: 'data.csv', data: Buffer.from('a,b').toString('base64') }] });
    const runOnce = async (extra: { fromNodeId?: string; sourceRunId?: string } = {}) => {
      await app.handle(c, { type: 'previewRun', graphId, ...extra });
      const preview = last('runPreview').preview;
      await app.handle(c, { type: 'startRun', graphId, reviewed: preview.signature, ...extra });
      await vi.waitFor(() => expect(last('run').run.status).toBe('succeeded'), { timeout: 5000 });
      return { preview, run: last('run').run };
    };
    const first = await runOnce();
    expect(first.run.attachments).toEqual([{ name: 'data.csv', sha256: expect.stringMatching(/^[0-9a-f]{64}$/) }]);
    const same = await runOnce({ fromNodeId: 'n2', sourceRunId: first.run.id });
    expect(same.preview.steps.find((s) => s.id === 'n1')?.reused).toBe(true);
    writeFileSync(join(paths.dataDir, 'attachments', graphId, 'data.csv'), 'a,b,c');
    const changed = await runOnce({ fromNodeId: 'n2', sourceRunId: same.run.id });
    expect(changed.preview.steps.find((s) => s.id === 'n1')?.reused).toBe(false);
  });
});
```

Change `shared/test/attachmentsGraph.test.ts`:

```diff
diff --git a/shared/test/attachmentsGraph.test.ts b/shared/test/attachmentsGraph.test.ts
--- a/shared/test/attachmentsGraph.test.ts
+++ b/shared/test/attachmentsGraph.test.ts
@@ -92,3 +92,17 @@ describe('graph attachments in the data model (spec §6b.3)', () => {
     expect(reusableNodeIds(shared, { snapshot: g, nodes: allOk })).toEqual(new Set(['n3']));
   });
 });
+
+describe('re-run reuse by attachment content (spec §6b.5)', () => {
+  it('runs a step again when a file it gets changed under the same name', () => {
+    const g = run(empty, [agent(['a.md']), agent(), { type: 'setGraphAttachments', names: ['brief.pdf'] }]);
+    const allOk = Object.fromEntries(g.nodes.map((n) => [n.id, { status: 'succeeded' as const }])) as Record<string, NodeRunState>;
+    const source = { snapshot: g, nodes: allOk, attachments: [{ name: 'a.md', sha256: '1' }, { name: 'brief.pdf', sha256: '2' }] };
+    expect(reusableNodeIds(g, source, undefined, undefined, [{ name: 'a.md', sha256: '1' }, { name: 'brief.pdf', sha256: '2' }])).toEqual(new Set(['n1', 'n2']));
+    expect(reusableNodeIds(g, source, undefined, undefined, [{ name: 'a.md', sha256: 'changed' }, { name: 'brief.pdf', sha256: '2' }])).toEqual(new Set(['n2']));
+    // A missing file is a change too; the graph's file reaches every agent step.
+    expect(reusableNodeIds(g, source, undefined, undefined, [{ name: 'a.md', sha256: '1' }, { name: 'brief.pdf' }])).toEqual(new Set());
+    // A run recorded before attachments, or no hashes given: names only.
+    expect(reusableNodeIds(g, { snapshot: g, nodes: allOk }, undefined, undefined, [{ name: 'a.md', sha256: 'x' }])).toEqual(new Set(['n1', 'n2']));
+  });
+});
```

- [ ] **Step 2: Run the tests and see them fail**

Run: `npm test -w shared -- test/attachmentsGraph.test.ts && npm test -w engine -- test/attachRun.test.ts`
Expected: FAIL — the new modules, exports or behaviour do not exist yet (import errors or assertion failures).

- [ ] **Step 3: Implement**

Create `engine/src/attachedFiles.ts`:

```ts
import { isAbsolute, join, relative } from 'node:path';
import { attachmentKind, type AttachmentKind, type Graph, type GraphNode, type RunAttachment } from '@agent-stream/shared';
import { graphAttachmentsDir, projectPaths } from './paths';

/**
 * One file an agent step gets (step model spec §6b.5): its own attachments first, then the graph's. `path` is the file;
 * `shown` is how the prompt names it: relative to the step's folder, or the full path for a step in a variant worktree.
 */
export type StepAttachment = { name: string; path: string; shown: string; kind: AttachmentKind; missing: boolean };

/** Every attachment name the graph uses, once each: the graph's, then each step's. */
export function attachmentNamesOf(graph: Graph): string[] {
  return [...new Set([...(graph.attachments ?? []), ...graph.nodes.flatMap((n) => n.attachments ?? [])])];
}

/** The run snapshot's record of the attachments (spec §6b.5): each name with its SHA-256, none for a missing file. */
export function runAttachments(graph: Graph, hash: (name: string) => string | undefined): RunAttachment[] {
  return attachmentNamesOf(graph).map((name) => {
    const sha256 = hash(name);
    return { name, ...(sha256 && { sha256 }) };
  });
}

/** What an agent step gets: its own attachments, then the graph's (a name in both once), with where each file is. */
export function stepAttachments(o: { projectDir: string; graph: Graph; node: GraphNode; cwd: string; worktree: boolean; exists(path: string): boolean }): StepAttachment[] {
  if (o.node.kind !== 'agent') return [];
  const dir = graphAttachmentsDir(projectPaths(o.projectDir), o.graph.id);
  const names = [...new Set([...(o.node.attachments ?? []), ...(o.graph.attachments ?? [])])];
  return names.map((name) => {
    const path = join(dir, name);
    const rel = relative(o.cwd, path);
    return { name, path, shown: o.worktree || isAbsolute(rel) ? path : rel, kind: attachmentKind(name) ?? 'text', missing: !o.exists(path) };
  });
}

/** The step log's line for a file that isn't there (spec §6b.5). */
export const missingAttachmentLine = (graphId: string, name: string) => `Attachment ${name} is missing from .agent-stream/attachments/${graphId}/, so this step runs without it.`;
```

Change `engine/src/app.ts`:

```diff
diff --git a/engine/src/app.ts b/engine/src/app.ts
--- a/engine/src/app.ts
+++ b/engine/src/app.ts
@@ -47,6 +47,7 @@ import {
   withStepModelLines,
 } from '@agent-stream/shared';
 import { ApprovalBroker } from './approvals';
+import { runAttachments } from './attachedFiles';
 import { AttachmentStore, type AttachmentFile } from './attachmentStore';
 import { systemClock, type Clock } from './clock';
 import { createCommandExecutor } from './commandExecutor';
@@ -475,7 +476,8 @@ export function createApp(d: AppDeps) {
       if (!source || source.graphId !== graph.id) return { ok: false, error: `run ${sourceRunId} not found` };
     }
     const checkout = await inspect();
-    return { ok: true, checkout, outcome: previewRun({ graph, values: values.get(graph.id), env, source, fromNodeId, commandShellProblem, checkout }) };
+    const files = runAttachments(graph, (name) => attachments.hash(graph.id, name));
+    return { ok: true, checkout, outcome: previewRun({ graph, values: values.get(graph.id), env, source, fromNodeId, commandShellProblem, checkout, attachments: files }) };
   }
 
   /** The pending agent changes and the baseline they are against, for graphOpened and graph. */
@@ -852,6 +854,8 @@ export function createApp(d: AppDeps) {
             provider: provider.id,
             ...defaults,
             stepModels,
+            // What each attachment holds as the run starts: recorded in the run, and what reuse compares (spec §6b.5).
+            attachments: runAttachments(r.graph, (name) => attachments.hash(r.graph.id, name)),
             runId,
             checkout,
             sequential: msg.sequential,
```

Change `engine/src/executors.ts`:

```diff
diff --git a/engine/src/executors.ts b/engine/src/executors.ts
--- a/engine/src/executors.ts
+++ b/engine/src/executors.ts
@@ -1,4 +1,5 @@
 import type { EffortLevel, Graph, GraphNode, NodeEventBody, NodeUsage } from '@agent-stream/shared';
+import type { StepAttachment } from './attachedFiles';
 import type { GraphTool } from './providers/types';
 
 export type NodeOutcome = { ok: boolean; output: string; error?: string; exitCode?: number | null; usage?: NodeUsage };
@@ -17,6 +18,8 @@ export type NodeContext = {
   /** Agent steps: the model and effort the run resolved for this step when it started; absent: the provider's own default. */
   model?: string;
   effort?: EffortLevel;
+  /** Agent steps: the files the step gets, its own then the graph's (step model spec §6b.5); a missing one is marked. */
+  attachments?: StepAttachment[];
 };
 
 export type NodeExecutor = (ctx: NodeContext) => Promise<NodeOutcome>;
```

Change `engine/src/runPreview.ts`:

```diff
diff --git a/engine/src/runPreview.ts b/engine/src/runPreview.ts
--- a/engine/src/runPreview.ts
+++ b/engine/src/runPreview.ts
@@ -10,6 +10,7 @@ import {
   type Graph,
   type PreviewStep,
   type RenderedRun,
+  type RunAttachment,
   type RunMeta,
   type RunPreview,
 } from '@agent-stream/shared';
@@ -52,6 +53,8 @@ export type PreviewInput = {
   commandShellProblem?: string | null;
   /** The checkout the run will use (ruling R8): refuses workspaces outside Git or before the first commit, notes uncommitted changes. */
   checkout?: CheckoutInfo;
+  /** The attachments the steps use, with their SHA-256 now (no hash: missing): warnings for missing files, and reuse by content (step model spec §6b.5). */
+  attachments?: RunAttachment[];
 };
 export type PreviewOutcome = { preview: RunPreview; rendered?: RenderedRun };
 
@@ -173,7 +176,18 @@ export function previewRun(input: PreviewInput): PreviewOutcome {
   }
 
   const rendered: RenderedRun | undefined = problems.length === 0 ? { goal: goal ?? '', instructions: instructions ?? '', nodes } : undefined;
-  const reused = input.source && rendered ? reusableNodeIds(graph, input.source, input.fromNodeId, rendered) : new Set<string>();
+  const reused = input.source && rendered ? reusableNodeIds(graph, input.source, input.fromNodeId, rendered, input.attachments) : new Set<string>();
+  // A missing attachment never blocks: the step runs without it (spec §6b.5). Only steps that will run are named.
+  const missing = new Set((input.attachments ?? []).filter((a) => !a.sha256).map((a) => a.name));
+  const folder = `.agent-stream/attachments/${graph.id}/`;
+  const runs = (id: string) => !reused.has(id);
+  for (const name of graph.attachments ?? []) {
+    if (missing.has(name) && graph.nodes.some((n) => n.kind === 'agent' && runs(n.id))) warnings.push(`The graph's attachment ${name} is missing from ${folder}, so agent steps run without it.`);
+  }
+  for (const n of graph.nodes) {
+    if (n.kind !== 'agent' || !runs(n.id)) continue;
+    for (const name of n.attachments ?? []) if (missing.has(name)) warnings.push(`${n.id}'s attachment ${name} is missing from ${folder}, so the step runs without it.`);
+  }
   const order = topoOrder(graph);
   const ids = order.length === graph.nodes.length ? order : graph.nodes.map((n) => n.id);
   const steps: PreviewStep[] = ids.map((id) => {
```

Change `engine/src/runReport.ts`:

```diff
diff --git a/engine/src/runReport.ts b/engine/src/runReport.ts
--- a/engine/src/runReport.ts
+++ b/engine/src/runReport.ts
@@ -174,6 +174,12 @@ function stepSection(run: RunMeta, n: GraphNode, step: RunReportStep | undefined
   // The model and effort the step ran with, resolved when the run started (step model spec §3.3); runs from before have none.
   const use = n.kind === 'agent' ? run.stepModels?.[n.id] : undefined;
   if (use) block([inline(modelLine({ model: use.model, effort: use.effort, provider: run.provider })), ...(use.note?.trim() ? ['', `_Note:_ ${inline(use.note)}`] : [])]);
+  // Its attachments, its own then the graph's, by name and SHA-256 as the run started; never their contents (spec §6b.5).
+  const files = n.kind === 'agent' ? [...new Set([...(n.attachments ?? []), ...(run.snapshot.attachments ?? [])])] : [];
+  if (files.length) {
+    const hash = (name: string) => run.attachments?.find((a) => a.name === name)?.sha256;
+    block(['**Attachments**', '', ...files.map((name) => `- ${inlineStart(name)} · ${hash(name) ? `sha256 ${hash(name)}` : 'missing when the run started'}`)]);
+  }
   // After a label on the same line, so line-start markup in it (an agent can write descriptions) stays text.
   if (n.description?.trim()) block([`_Description:_ ${inline(n.description)}`]);
   // As it ran: the rendered text, which has the variable values filled in.
```

Change `engine/src/runner.ts`:

```diff
diff --git a/engine/src/runner.ts b/engine/src/runner.ts
--- a/engine/src/runner.ts
+++ b/engine/src/runner.ts
@@ -20,6 +20,7 @@ import {
   type NodeRunState,
   type NodeStatus,
   type EffortLevel,
+  type RunAttachment,
   type ProviderId,
   type RenderedRun,
   type RunMeta,
@@ -29,6 +30,7 @@ import {
 import type { ApprovalBroker } from './approvals';
 import { systemClock, type Clock } from './clock';
 import type { Executors, NodeExecutor, NodeOutcome } from './executors';
+import { missingAttachmentLine, stepAttachments } from './attachedFiles';
 import { realOrResolved } from './git';
 import { buildNodePrompt } from './prompt';
 import type { RunStore } from './runStore';
@@ -71,6 +73,8 @@ export type StartRunInput = {
   effort?: EffortLevel;
   /** Each agent step's own model and effort, resolved at start (step model spec §3.1); a step without an entry gets `model` and `effort`. */
   stepModels?: Record<string, StepModelUse>;
+  /** The attachments the steps use, with their SHA-256 now (spec §6b.5): recorded in the run, and what reuse compares. */
+  attachments?: RunAttachment[];
   /** The run's id, when the caller needs it before the run starts (variant worktree paths contain it). */
   runId?: string;
   /** Start even though another run holds the checkout's lease: write-capable checkout steps wait for it (spec §4.3). */
@@ -163,7 +167,7 @@ export class Runner extends EventEmitter {
       source = this.deps.runStore.get(input.sourceRunId);
       if (!source) return { ok: false, error: `run ${input.sourceRunId} not found` };
     }
-    const reuse = source ? reusableNodeIds(graph, source, input.fromNodeId, input.rendered) : new Set<string>();
+    const reuse = source ? reusableNodeIds(graph, source, input.fromNodeId, input.rendered, input.attachments) : new Set<string>();
 
     const runId = input.runId ?? this.makeRunId();
     const leaseRoot = input.checkout?.root ?? this.deps.projectDir;
@@ -201,6 +205,7 @@ export class Runner extends EventEmitter {
       ...(input.model && { model: input.model }),
       ...(input.effort && { effort: input.effort }),
       ...(input.stepModels && Object.keys(input.stepModels).length > 0 && { stepModels: structuredClone(input.stepModels) }),
+      ...(input.attachments && input.attachments.length > 0 && { attachments: structuredClone(input.attachments) }),
       ...(input.checkout && { checkout: toRunCheckout(input.checkout) }),
       ...(waitFor && { waitingFor: waitingOn(waitFor.holder) }),
       ...(Object.keys(workspaces).length > 0 && { workspaces }),
@@ -441,12 +446,13 @@ export class Runner extends EventEmitter {
     // What the run resolved for this step when it started; a step added during the run gets the run's own (spec §3.1).
     const use: StepModelUse | undefined = node.kind === 'agent' ? (meta.stepModels?.[nodeId] ?? { model: meta.model, effort: meta.effort }) : undefined;
     let noted = false;
+    /** Lines for the step's log right after it starts: why it doesn't run its own model, which attachments are missing. */
+    let notes: string[] = use?.note ? [use.note] : [];
     const emit = (event: NodeEventBody) => {
       this.emitEvent(run, nodeId, event);
-      // Why the step doesn't run its own model or effort: a line in its log, right after it starts.
-      if (event.type === 'start' && use?.note && !noted) {
+      if (event.type === 'start' && !noted) {
         noted = true;
-        this.emitEvent(run, nodeId, { type: 'text', text: use.note });
+        for (const text of notes) this.emitEvent(run, nodeId, { type: 'text', text });
       }
     };
     Promise.resolve()
@@ -474,17 +480,21 @@ export class Runner extends EventEmitter {
         const graph = meta.rendered ? { ...meta.snapshot, goal: meta.rendered.goal, instructions: meta.rendered.instructions } : meta.snapshot;
         const execNode = executionNode(meta, nodeId);
         const prompt = node.kind === 'agent' ? buildNodePrompt(graph, execNode, upstreamResults, place) : '';
+        const cwd = place?.path ?? this.deps.projectDir;
+        const files = stepAttachments({ projectDir: this.deps.projectDir, graph: meta.snapshot, node, cwd, worktree: !!place, exists: existsSync });
+        notes = [...notes, ...files.filter((f) => f.missing).map((f) => missingAttachmentLine(meta.graphId, f.name))];
         return executor({
           runId: meta.id,
           graph,
           node: execNode,
           prompt,
           // Agents get the variant path as their working directory; commands run there (spec §4.3a).
-          cwd: place?.path ?? this.deps.projectDir,
+          cwd,
           signal: controller.signal,
           emit,
           ...(use?.model && { model: use.model }),
           ...(use?.effort && { effort: use.effort }),
+          ...(files.length > 0 && { attachments: files }),
         });
       })
       .catch((e: unknown): NodeOutcome => ({ ok: false, output: '', error: e instanceof Error ? e.message : String(e) }))
```

Change `shared/src/graph.ts`:

```diff
diff --git a/shared/src/graph.ts b/shared/src/graph.ts
--- a/shared/src/graph.ts
+++ b/shared/src/graph.ts
@@ -2,7 +2,7 @@ import { COMMAND_ALWAYS_WRITES, workspaceNameProblem } from './access';
 import { attachmentListProblem, ONLY_AGENT_STEPS_ATTACH } from './attachments';
 import { ONLY_AGENT_STEPS_MODEL, stepModelProblem, stepModelText } from './stepModels';
 import { variableNameProblem } from './variables';
-import type { Actor, Graph, GraphNode, GraphResult, NodePatch, NodeRunState, Op, RenderedRun } from './types';
+import type { Actor, Graph, GraphNode, GraphResult, NodePatch, NodeRunState, Op, RenderedRun, RunAttachment } from './types';
 
 /** 1 to 64 letters, digits, - and _; no "--" and no trailing "-", so every id can be written in the Flow (an arrow starts at a "-"). */
 const NODE_ID_RE = /^(?!.*--)(?=.{1,64}$)[A-Za-z0-9_-]*[A-Za-z0-9_]$/;
@@ -299,7 +299,7 @@ export function validateRunnable(graph: Graph): string[] {
   return problems;
 }
 
-export type RunSource = { snapshot: Graph; nodes: Record<string, NodeRunState>; rendered?: RenderedRun };
+export type RunSource = { snapshot: Graph; nodes: Record<string, NodeRunState>; rendered?: RenderedRun; attachments?: RunAttachment[] };
 
 function sameSet(a: string[], b: string[]): boolean {
   return a.length === b.length && a.every((x) => b.includes(x));
@@ -309,9 +309,10 @@ function sameSet(a: string[], b: string[]): boolean {
  * Node ids a re-run may reuse from `source` (spec §7.2). A node executes again when it is
  * `fromNodeId`, did not succeed last time, changed kind or rendered prompt/command (the template,
  * for runs recorded before rendering), for an agent step changed its own description, model or effort, changed access or workspace, has a workspace, or gained/lost an upstream edge — and so does everything
- * downstream of it. Everything else is reused.
+ * downstream of it. An agent step also runs again when its attachments (its own, then the graph's) changed: another list,
+ * or, given `attachments` (the files now) and a source that recorded them, another file under a name. Everything else is reused.
  */
-export function reusableNodeIds(graph: Graph, source: RunSource, fromNodeId?: string, rendered?: RenderedRun): Set<string> {
+export function reusableNodeIds(graph: Graph, source: RunSource, fromNodeId?: string, rendered?: RenderedRun, attachments?: readonly RunAttachment[]): Set<string> {
   const seeds = new Set<string>(fromNodeId ? [fromNodeId] : []);
   for (const n of graph.nodes) {
     const prev = source.snapshot.nodes.find((p) => p.id === n.id);
@@ -331,7 +332,9 @@ export function reusableNodeIds(graph: Graph, source: RunSource, fromNodeId?: st
     const sameModel = n.kind !== 'agent' || ((prev?.model ? stepModelText(prev.model) : '') === (n.model ? stepModelText(n.model) : '') && (prev?.effort ?? '') === (n.effort ?? ''));
     // An agent step gets its own attachments, then the graph's (spec §6b.5): another list is another input.
     const files = (step: GraphNode | undefined, g: Graph) => JSON.stringify([...(step?.attachments ?? []), ...(g.attachments ?? [])]);
-    const sameFiles = n.kind !== 'agent' || files(prev, source.snapshot) === files(n, graph);
+    const hashOf = (list: readonly RunAttachment[] | undefined, name: string) => list?.find((a) => a.name === name)?.sha256 ?? '';
+    const sameContent = !attachments || !source.attachments || [...(n.attachments ?? []), ...(graph.attachments ?? [])].every((name) => hashOf(attachments, name) === hashOf(source.attachments, name));
+    const sameFiles = n.kind !== 'agent' || (files(prev, source.snapshot) === files(n, graph) && sameContent);
     const sameDefinition = !!prev && prev.kind === n.kind && sameText && sameDescription && sameAccess && samePlace && sameModel && sameFiles;
     const sameInputs = !!prev && sameSet(upstream(graph, n.id), upstream(source.snapshot, n.id));
     // A step with a workspace is never reused: its files lived in that run's own worktree (spec §4.3a).
```

Change `shared/src/types.ts`:

```diff
diff --git a/shared/src/types.ts b/shared/src/types.ts
--- a/shared/src/types.ts
+++ b/shared/src/types.ts
@@ -252,8 +252,13 @@ export type RunMeta = {
   effort?: EffortLevel;
   /** Each agent step's model and effort, resolved when the run started (step model spec §3.1); absent in runs from before. */
   stepModels?: Record<string, StepModelUse>;
+  /** Every attachment the run's steps use, with its SHA-256 when it started; a missing file has none (spec §6b.5). */
+  attachments?: RunAttachment[];
 };
 
+/** An attachment as a run recorded it: its name, and its SHA-256 (hex) when the file was there. */
+export type RunAttachment = { name: string; sha256?: string };
+
 /** What one agent step of a run uses: absent fields are the provider's own default. `note` says why it isn't the step's own choice. */
 export type StepModelUse = { model?: string; effort?: EffortLevel; note?: string };
 
```

- [ ] **Step 4: Run the tests and typecheck**

Run: `npm test -w shared -- test/attachmentsGraph.test.ts && npm test -w engine -- test/attachRun.test.ts`
Expected: PASS.
Run: `npm run typecheck && npm test`
Expected: all workspaces pass (a test that times out only under heavy machine load is not a failure of this task: run it again).

- [ ] **Step 5: Commit**

```bash
git add engine/src/app.ts engine/src/attachedFiles.ts engine/src/executors.ts engine/src/runPreview.ts engine/src/runReport.ts engine/src/runner.ts engine/test/attachRun.test.ts shared/src/graph.ts shared/src/types.ts shared/test/attachmentsGraph.test.ts
git commit -m "feat: runs record and check their attachments" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 17: What agents receive: the Attached files list and images per provider

**Spec covered:** §6b.5's table for steps (Claude images in the first message, PDFs and text by Read; Codex `localImage`, PDF note; Copilot image parts or the note), §7 runs tests per provider.

**Files:**
- Modify: `engine/src/agentLoop/chatModel.ts`, `engine/src/agentLoop/compact.ts`, `engine/src/attachedFiles.ts`, `engine/src/index.ts`, `engine/src/providers/claude/runStep.ts`, `engine/src/providers/claude/sdk.ts`, `engine/src/providers/codex/protocol.ts`, `engine/src/providers/codex/runStep.ts`, `engine/src/providers/codex/turn.ts`, `extension/src/providers/copilot.ts`, `extension/src/providers/copilotModel.ts`
- Test: `engine/test/attachedFiles.test.ts` (new), `engine/test/claudeModels.test.ts`, `engine/test/claudePlanTurn.test.ts`, `engine/test/claudeRunStep.test.ts`, `engine/test/codexRunStep.test.ts`, `extension/test/copilot.test.ts`

**Interfaces:**
- Consumes: Task 16's `StepAttachment`.
- Produces: `withAttachedFiles(prompt, files, notes)`, `readImages`, `readIfThere`, `ImageData`, note constants (`ATTACHED_IMAGE`, `IMAGE_NOT_SHOWN`, `PDF_READ_TOOL`, `PDF_MAY_NOT_READ`) in `attachedFiles.ts` (exported from the engine); `ImagePart` in `ChatMessage` user content (counted as `IMAGE_TOKENS`); `QueryFn` prompt `string | AsyncIterable<SDKUserMessage>`, `UserBlock`, `userMessage(blocks)` in `claude/sdk.ts`; Codex `UserInput` `localImage`, `RunTurnOptions.images?`; Copilot `takesImages(model)`.

- [ ] **Step 1: Write the failing tests**

Create `engine/test/attachedFiles.test.ts`:

```ts
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { estimateTokens, IMAGE_TOKENS } from '../src/agentLoop/compact';
import { ATTACHED_IMAGE, IMAGE_NOT_SHOWN, PDF_READ_TOOL, readIfThere, readImages, withAttachedFiles, type StepAttachment } from '../src/attachedFiles';

const dir = mkdtempSync(join(tmpdir(), 'attached-'));
writeFileSync(join(dir, 'mockup.png'), 'PNGDATA');
const file = (name: string, kind: StepAttachment['kind'], missing = false): StepAttachment => ({ name, kind, missing, path: join(dir, name), shown: `.agent-stream/attachments/g/${name}` });
const files = [file('mockup.png', 'image'), file('spec.pdf', 'pdf'), file('notes.md', 'text'), file('gone.png', 'image', true)];

describe('the Attached files list (step model spec §6b.5)', () => {
  it('lists each file that is there by path, with the provider’s note for its kind', () => {
    expect(withAttachedFiles('Do it.\n', files, { image: ATTACHED_IMAGE, pdf: PDF_READ_TOOL })).toBe(
      [
        'Do it.',
        '',
        'Attached files:',
        '- .agent-stream/attachments/g/mockup.png (image, attached to this message)',
        '- .agent-stream/attachments/g/spec.pdf (PDF: read it with the Read tool)',
        '- .agent-stream/attachments/g/notes.md',
        '',
      ].join('\n'),
    );
    expect(withAttachedFiles('Do it.', [file('mockup.png', 'image')], { image: IMAGE_NOT_SHOWN })).toContain("mockup.png (This image couldn't be shown to the model.)");
    expect(withAttachedFiles('Do it.', [file('gone.png', 'image', true)], {})).toBe('Do it.');
    expect(withAttachedFiles('Do it.', undefined, {})).toBe('Do it.');
  });

  it('reads the images that are there, as base64 with their media type', () => {
    expect(readImages(files, readIfThere)).toEqual([{ name: 'mockup.png', mediaType: 'image/png', data: Buffer.from('PNGDATA').toString('base64') }]);
    expect(readImages([file('vanished.webp', 'image')], readIfThere)).toEqual([]);
  });

  it('an image counts a fixed amount toward a conversation’s size, never its base64 length', () => {
    const big = 'A'.repeat(4_000_000);
    const t = estimateTokens('', [{ role: 'user', content: [{ type: 'text', text: 'hi' }, { type: 'image', mediaType: 'image/png', data: big }] }], []);
    expect(t).toBeLessThan(IMAGE_TOKENS + 100);
    expect(t).toBeGreaterThanOrEqual(IMAGE_TOKENS);
  });
});
```

Change `engine/test/claudeModels.test.ts` (named exception: type-only cast of the fake query's prompt):

```diff
diff --git a/engine/test/claudeModels.test.ts b/engine/test/claudeModels.test.ts
--- a/engine/test/claudeModels.test.ts
+++ b/engine/test/claudeModels.test.ts
@@ -27,7 +27,7 @@ const INFOS: ModelInfo[] = [
 function setup(o: { infos?: () => Promise<ModelInfo[]>; signIn?: boolean } = {}) {
   const calls: { prompt: string; options: Options }[] = [];
   const queryFn: QueryFn = ({ prompt, options }) => {
-    calls.push({ prompt, options: options! });
+    calls.push({ prompt: prompt as string, options: options! });
     return (async function* () {
       yield init();
       yield done();
```

Change `engine/test/claudePlanTurn.test.ts` (named exception: type-only cast of the fake query's prompt):

```diff
diff --git a/engine/test/claudePlanTurn.test.ts b/engine/test/claudePlanTurn.test.ts
--- a/engine/test/claudePlanTurn.test.ts
+++ b/engine/test/claudePlanTurn.test.ts
@@ -43,7 +43,7 @@ async function setup(script: (options: Options) => AsyncGenerator<SDKMessage>) {
   const graphId = graphStore.create('G').id;
   const calls: { prompt: string; options: Options }[] = [];
   const queryFn: QueryFn = ({ prompt, options }) => {
-    calls.push({ prompt, options: options! });
+    calls.push({ prompt: prompt as string, options: options! });
     return script(options!);
   };
   const provider = createClaudeProvider({
```

Change `engine/test/claudeRunStep.test.ts` (named exception: the fake records the wider prompt type; new tests):

```diff
diff --git a/engine/test/claudeRunStep.test.ts b/engine/test/claudeRunStep.test.ts
--- a/engine/test/claudeRunStep.test.ts
+++ b/engine/test/claudeRunStep.test.ts
@@ -2,11 +2,12 @@ import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
 import { tmpdir } from 'node:os';
 import { join, resolve } from 'node:path';
 import { describe, expect, it } from 'vitest';
-import type { HookInput, McpSdkServerConfigWithInstance, Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
+import type { HookInput, McpSdkServerConfigWithInstance, Options, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
 import { Client } from '@modelcontextprotocol/sdk/client/index.js';
 import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
 import { emptyGraph, type ApprovalRequest, type GraphNode, type NodeEventBody } from '@agent-stream/shared';
 import { ApprovalBroker } from '../src/approvals';
+import type { StepAttachment } from '../src/attachedFiles';
 import type { NodeContext } from '../src/executors';
 import type { GraphTool } from '../src/providers/types';
 import { createClaudeProvider } from '../src/providers/claude';
@@ -26,7 +27,7 @@ const failure = (errors: string[]) =>
   msg({ type: 'result', subtype: 'error_during_execution', is_error: true, errors, num_turns: 1, total_cost_usd: 0, usage, session_id: 's1' });
 
 function fake(script: (options: Options) => AsyncGenerator<SDKMessage>) {
-  const calls: { prompt: string; options?: Options }[] = [];
+  const calls: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options }[] = [];
   const fn: QueryFn = (params) => {
     calls.push(params);
     return script(params.options ?? {});
@@ -319,3 +320,40 @@ describe('Claude provider: the model and effort a step runs with', () => {
     expect(dropped.calls[0].options).not.toHaveProperty('effort');
   });
 });
+
+describe('Claude provider: attachments (step model spec §6b.5)', () => {
+  it('puts images in the step’s first message, and names PDFs and text files for the read tools', async () => {
+    const dir = mkdtempSync(join(tmpdir(), 'claude-attach-'));
+    writeFileSync(join(dir, 'mockup.png'), 'PNG');
+    const at = (name: string, kind: StepAttachment['kind']): StepAttachment => ({ name, kind, missing: false, path: join(dir, name), shown: `.agent-stream/attachments/g/${name}` });
+    const { fn, calls } = fake(async function* () {
+      yield init();
+      yield success('ok');
+    });
+    const a = ctx();
+    await runStep({ queryFn: fn }, { ...a.c, attachments: [at('mockup.png', 'image'), at('spec.pdf', 'pdf'), at('notes.md', 'text')] });
+    const text = 'FULL PROMPT\n\nAttached files:\n- .agent-stream/attachments/g/mockup.png (image, attached to this message)\n- .agent-stream/attachments/g/spec.pdf (PDF: read it with the Read tool)\n- .agent-stream/attachments/g/notes.md\n';
+    const prompt = calls[0].prompt;
+    if (typeof prompt === 'string') throw new Error('expected a message with an image');
+    const messages: SDKUserMessage[] = [];
+    for await (const m of prompt) messages.push(m);
+    expect(messages).toEqual([
+      {
+        type: 'user',
+        parent_tool_use_id: null,
+        message: { role: 'user', content: [{ type: 'text', text }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: Buffer.from('PNG').toString('base64') } }] },
+      },
+    ]);
+    expect(a.events[0]).toMatchObject({ type: 'start', prompt: text });
+  });
+
+  it('without images, the prompt stays plain text with the list', async () => {
+    const { fn, calls } = fake(async function* () {
+      yield init();
+      yield success('ok');
+    });
+    const a = ctx();
+    await runStep({ queryFn: fn }, { ...a.c, attachments: [{ name: 'notes.md', kind: 'text', missing: false, path: '/nowhere/notes.md', shown: 'notes.md' }] });
+    expect(calls[0].prompt).toBe('FULL PROMPT\n\nAttached files:\n- notes.md\n');
+  });
+});
```

Change `engine/test/codexRunStep.test.ts` (the step helper takes attachments; new test):

```diff
diff --git a/engine/test/codexRunStep.test.ts b/engine/test/codexRunStep.test.ts
--- a/engine/test/codexRunStep.test.ts
+++ b/engine/test/codexRunStep.test.ts
@@ -3,6 +3,7 @@ import { describe, expect, it, vi } from 'vitest';
 import { z } from 'zod';
 import { emptyGraph, type EffortLevel, type GraphNode, type ModelChoice, type NodeEventBody } from '@agent-stream/shared';
 import { ApprovalBroker } from '../src/approvals';
+import type { StepAttachment } from '../src/attachedFiles';
 import type { NodeContext } from '../src/executors';
 import { createStepGate, STEP_GRAPH_TOOL_PREFIX } from '../src/providers/toolGate';
 import type { GraphTool } from '../src/providers/types';
@@ -31,7 +32,7 @@ const values = resolve('/', 'h', '.agent-stream', 'values', 'abc.json');
 const zsh = (script: string) => `/bin/zsh -lc '${script}'`;
 const addStep = (): GraphTool => ({ name: 'add_step', description: 'Add a step', schema: { title: z.string() }, run: vi.fn(async () => ({ text: 'Added n5.' })) });
 
-type StepOptions = { access?: 'read'; cwd?: string; model?: string; effort?: EffortLevel; graphTools?: GraphTool[]; signal?: AbortSignal; known?: ModelChoice[]; codexPath?: string | undefined };
+type StepOptions = { access?: 'read'; cwd?: string; model?: string; effort?: EffortLevel; graphTools?: GraphTool[]; signal?: AbortSignal; known?: ModelChoice[]; codexPath?: string | undefined; attachments?: StepAttachment[] };
 
 /** A step on the fake app-server, with the gate the App builds for it (runs recorded in the folder's own .agent-stream). */
 function setup(handlers: Record<string, FakeHandler>, o: StepOptions = {}) {
@@ -52,6 +53,7 @@ function setup(handlers: Record<string, FakeHandler>, o: StepOptions = {}) {
     graphTools,
     ...(o.model && { model: o.model }),
     ...(o.effort && { effort: o.effort }),
+    ...(o.attachments && { attachments: o.attachments }),
   };
   const gate = createStepGate({
     broker,
@@ -361,3 +363,17 @@ describe('codexRunStep: the model and effort a step runs with', () => {
     expect(dropped.events[0]).toEqual({ type: 'start', kind: 'agent', cwd, prompt: 'FULL PROMPT', model: 'gpt-a' });
   });
 });
+
+describe('codexRunStep: attachments (step model spec §6b.5)', () => {
+  it('sends images with turn/start for Codex to read, and lists every file with a note for PDFs', async () => {
+    const at = (name: string, kind: StepAttachment['kind'], missing = false): StepAttachment => ({ name, kind, missing, path: resolve(cwd, '.agent-stream', 'attachments', 'g', name), shown: `.agent-stream/attachments/g/${name}` });
+    const s = step((t) => t.end(), { attachments: [at('mockup.png', 'image'), at('spec.pdf', 'pdf'), at('gone.png', 'image', true)] });
+    await s.run();
+    const text = 'FULL PROMPT\n\nAttached files:\n- .agent-stream/attachments/g/mockup.png (image, attached to this message)\n- .agent-stream/attachments/g/spec.pdf (PDF: the model may not be able to read PDFs)\n';
+    expect(s.fake.last().paramsOf('turn/start').input).toEqual([
+      { type: 'text', text, text_elements: [] },
+      { type: 'localImage', path: resolve(cwd, '.agent-stream', 'attachments', 'g', 'mockup.png') },
+    ]);
+    expect(s.events[0]).toMatchObject({ type: 'start', prompt: text });
+  });
+});
```

Change `extension/test/copilot.test.ts` (the step helper takes attachments; new tests):

```diff
diff --git a/extension/test/copilot.test.ts b/extension/test/copilot.test.ts
--- a/extension/test/copilot.test.ts
+++ b/extension/test/copilot.test.ts
@@ -3,7 +3,7 @@ import { tmpdir } from 'node:os';
 import { join } from 'node:path';
 import { describe, expect, it, vi } from 'vitest';
 import * as vscode from 'vscode';
-import { createPlannerGate, type ChatMessage, type GraphTool, type NodeContext, type PlannerEvent, type PlannerTurn, type RunShell, type ToolGate } from '@agent-stream/engine';
+import { createPlannerGate, type ChatMessage, type GraphTool, type NodeContext, type PlannerEvent, type PlannerTurn, type RunShell, type StepAttachment, type ToolGate } from '@agent-stream/engine';
 import { emptyGraph, type EffortLevel, type GraphNode, type NodeEventBody } from '@agent-stream/shared';
 import { COPILOT_CONSENT_LATER, COPILOT_RESUME_FAILED, COPILOT_UNAVAILABLE, createCopilotProvider, type CopilotLimits, type LmAccess, type LmApi } from '../src/providers/copilot';
 import { COPILOT_PERMISSION } from '../src/providers/copilotModel';
@@ -25,7 +25,7 @@ function provider(o: { lm?: LmApi; access?: LmAccess; limits?: Partial<CopilotLi
   return createCopilotProvider({ lm: o.lm, access: o.access, runShell: noShell, limits: () => ({ maxRequestsPerStep: 25, maxRequestsPerTurn: 10, ...o.limits }) });
 }
 
-function step(o: { model?: string; effort?: EffortLevel; access?: 'read'; graphTools?: GraphTool[]; signal?: AbortSignal } = {}) {
+function step(o: { model?: string; effort?: EffortLevel; access?: 'read'; graphTools?: GraphTool[]; signal?: AbortSignal; attachments?: StepAttachment[] } = {}) {
   const events: NodeEventBody[] = [];
   const cwd = mkdtempSync(join(tmpdir(), 'copilot-step-'));
   const node: GraphNode = { id: 'n1', title: 'Step', kind: 'agent', prompt: 'p', ...(o.access && { access: o.access }), createdBy: 'user', updatedBy: 'user', updatedAt: 't' };
@@ -40,6 +40,7 @@ function step(o: { model?: string; effort?: EffortLevel; access?: 'read'; graphT
     ...(o.model && { model: o.model }),
     ...(o.effort && { effort: o.effort }),
     ...(o.graphTools && { graphTools: o.graphTools }),
+    ...(o.attachments && { attachments: o.attachments }),
   };
   return { ctx, events, cwd };
 }
@@ -379,3 +380,36 @@ describe('Copilot effort (step model spec §6)', () => {
     ]);
   });
 });
+
+describe('Copilot: attachments (step model spec §6b.5)', () => {
+  const dir = mkdtempSync(join(tmpdir(), 'copilot-attach-'));
+  writeFileSync(join(dir, 'mockup.png'), 'PNG');
+  const files: StepAttachment[] = [
+    { name: 'mockup.png', kind: 'image', missing: false, path: join(dir, 'mockup.png'), shown: '.agent-stream/attachments/g/mockup.png' },
+    { name: 'spec.pdf', kind: 'pdf', missing: false, path: join(dir, 'spec.pdf'), shown: '.agent-stream/attachments/g/spec.pdf' },
+  ];
+  const withImages = (id: string, images: boolean) => {
+    const m = fakeLmModel({ id, name: id });
+    (m.model as unknown as { capabilities: Record<string, boolean> }).capabilities.supportsImageToText = images;
+    return m;
+  };
+
+  it('sends images as data parts to a model that takes them', async () => {
+    const s = step({ attachments: files });
+    const m = withImages('auto', true);
+    await provider({ lm: models(m.model) }).runStep(s.ctx, allowAll);
+    const user = m.requests[0].messages[1];
+    expect(user.content).toEqual([
+      text('Do it.\n\nAttached files:\n- .agent-stream/attachments/g/mockup.png (image, attached to this message)\n- .agent-stream/attachments/g/spec.pdf (PDF: the model may not be able to read PDFs)\n'),
+      new vscode.LanguageModelDataPart(Buffer.from('PNG'), 'image/png'),
+    ]);
+  });
+
+  it('for a model that doesn’t take images, says so in the list and sends none', async () => {
+    const s = step({ attachments: files });
+    const m = withImages('auto', false);
+    await provider({ lm: models(m.model) }).runStep(s.ctx, allowAll);
+    const user = m.requests[0].messages[1];
+    expect(user.content).toEqual([text("Do it.\n\nAttached files:\n- .agent-stream/attachments/g/mockup.png (This image couldn't be shown to the model.)\n- .agent-stream/attachments/g/spec.pdf (PDF: the model may not be able to read PDFs)\n")]);
+  });
+});
```

- [ ] **Step 2: Run the tests and see them fail**

Run: `npm test -w engine -- test/attachedFiles.test.ts test/claudeRunStep.test.ts test/codexRunStep.test.ts && npm test -w extension -- test/copilot.test.ts`
Expected: FAIL — the new modules, exports or behaviour do not exist yet (import errors or assertion failures).

- [ ] **Step 3: Implement**

Change `engine/src/agentLoop/chatModel.ts`:

```diff
diff --git a/engine/src/agentLoop/chatModel.ts b/engine/src/agentLoop/chatModel.ts
--- a/engine/src/agentLoop/chatModel.ts
+++ b/engine/src/agentLoop/chatModel.ts
@@ -1,7 +1,9 @@
 /** A provider-neutral chat model (spec §4.1): the agent loop talks to every model through this. */
 export type ChatPart = { type: 'text'; text: string } | { type: 'toolCall'; callId: string; name: string; input: unknown };
+/** An image a user message carries (an attachment, step model spec §6b.5): its media type and its bytes as base64. */
+export type ImagePart = { type: 'image'; mediaType: string; data: string };
 export type ChatMessage =
-  | { role: 'user'; content: Array<{ type: 'text'; text: string } | { type: 'toolResult'; callId: string; text: string; isError?: boolean }> }
+  | { role: 'user'; content: Array<{ type: 'text'; text: string } | { type: 'toolResult'; callId: string; text: string; isError?: boolean } | ImagePart> }
   | { role: 'assistant'; content: ChatPart[] };
 /** `inputSchema` is a JSON Schema object. */
 export type ToolSpec = { name: string; description: string; inputSchema: object };
```

Change `engine/src/agentLoop/compact.ts`:

```diff
diff --git a/engine/src/agentLoop/compact.ts b/engine/src/agentLoop/compact.ts
--- a/engine/src/agentLoop/compact.ts
+++ b/engine/src/agentLoop/compact.ts
@@ -17,9 +17,15 @@ const SUMMARY_MAX_CHARS = 2000;
 const tokens = (chars: number) => Math.ceil(chars / 4);
 const userText = (text: string): ChatMessage => ({ role: 'user', content: [{ type: 'text', text }] });
 
-/** ceil(chars / 4) over the system text, the messages and the tool specs (spec §4.6, ruling R7). */
+/** What an image counts for: about what providers charge for a large one, never its base64 length. */
+export const IMAGE_TOKENS = 1600;
+const withoutImageData = (messages: ChatMessage[]): ChatMessage[] =>
+  messages.map((m) => (m.role === 'user' && m.content.some((c) => c.type === 'image') ? { ...m, content: m.content.map((c) => (c.type === 'image' ? { ...c, data: '' } : c)) } : m));
+const imageCount = (messages: ChatMessage[]) => messages.reduce((n, m) => n + (m.role === 'user' ? m.content.filter((c) => c.type === 'image').length : 0), 0);
+
+/** ceil(chars / 4) over the system text, the messages and the tool specs (spec §4.6, ruling R7); an image counts IMAGE_TOKENS. */
 export function estimateTokens(system: string, messages: ChatMessage[], tools: ToolSpec[]): number {
-  return tokens(system.length + JSON.stringify(messages).length + JSON.stringify(tools).length);
+  return tokens(system.length + JSON.stringify(withoutImageData(messages)).length + JSON.stringify(tools).length) + imageCount(messages) * IMAGE_TOKENS;
 }
 
 /** Messages grouped so a tool call and its results stay together: an assistant message with calls and the results after it. */
@@ -43,7 +49,9 @@ function transcriptText(messages: ChatMessage[]): string {
     .map((m) =>
       m.role === 'assistant'
         ? m.content.map((p) => (p.type === 'text' ? `Assistant: ${p.text}` : `Assistant called ${p.name} ${JSON.stringify(p.input)}`)).join('\n')
-        : m.content.map((c) => (c.type === 'text' ? `User: ${c.text}` : `Tool result${c.isError ? ' (error)' : ''}: ${clipResult(c.text, RESULT_CHARS_IN_SUMMARY)}`)).join('\n'),
+        : m.content
+            .map((c) => (c.type === 'text' ? `User: ${c.text}` : c.type === 'image' ? 'User attached an image.' : `Tool result${c.isError ? ' (error)' : ''}: ${clipResult(c.text, RESULT_CHARS_IN_SUMMARY)}`))
+            .join('\n'),
     )
     .join('\n\n');
 }
```

Change `engine/src/attachedFiles.ts`:

```diff
diff --git a/engine/src/attachedFiles.ts b/engine/src/attachedFiles.ts
--- a/engine/src/attachedFiles.ts
+++ b/engine/src/attachedFiles.ts
@@ -1,5 +1,6 @@
+import { readFileSync } from 'node:fs';
 import { isAbsolute, join, relative } from 'node:path';
-import { attachmentKind, type AttachmentKind, type Graph, type GraphNode, type RunAttachment } from '@agent-stream/shared';
+import { attachmentKind, imageMediaType, type AttachmentKind, type Graph, type GraphNode, type RunAttachment } from '@agent-stream/shared';
 import { graphAttachmentsDir, projectPaths } from './paths';
 
 /**
@@ -35,3 +36,44 @@ export function stepAttachments(o: { projectDir: string; graph: Graph; node: Gra
 
 /** The step log's line for a file that isn't there (spec §6b.5). */
 export const missingAttachmentLine = (graphId: string, name: string) => `Attachment ${name} is missing from .agent-stream/attachments/${graphId}/, so this step runs without it.`;
+
+/** What a provider says after a file's path in the `Attached files:` list, by kind (spec §6b.5's table). */
+export type FileNotes = { image?: string; pdf?: string; text?: string };
+export const ATTACHED_IMAGE = 'image, attached to this message';
+export const IMAGE_NOT_SHOWN = "This image couldn't be shown to the model.";
+export const PDF_READ_TOOL = 'PDF: read it with the Read tool';
+export const PDF_MAY_NOT_READ = 'PDF: the model may not be able to read PDFs';
+
+/** The prompt with its `Attached files:` list (spec §6b.5): each file that is there, by path, with the provider's note for its kind. */
+export function withAttachedFiles(prompt: string, files: readonly StepAttachment[] | undefined, notes: FileNotes): string {
+  const present = (files ?? []).filter((f) => !f.missing);
+  if (!present.length) return prompt;
+  const lines = present.map((f) => {
+    const note = notes[f.kind];
+    return `- ${f.shown}${note ? ` (${note})` : ''}`;
+  });
+  return `${prompt.trimEnd()}\n\nAttached files:\n${lines.join('\n')}\n`;
+}
+
+/** An image to send with a message: its media type and its bytes as base64. */
+export type ImageData = { name: string; mediaType: string; data: string };
+
+/** The images among the files that are there, read now (one that vanished since is left out). */
+export function readImages(files: readonly StepAttachment[] | undefined, read: (path: string) => Buffer | undefined): ImageData[] {
+  const out: ImageData[] = [];
+  for (const f of files ?? []) {
+    const mediaType = f.kind === 'image' && !f.missing ? imageMediaType(f.name) : undefined;
+    const bytes = mediaType && read(f.path);
+    if (mediaType && bytes) out.push({ name: f.name, mediaType, data: bytes.toString('base64') });
+  }
+  return out;
+}
+
+/** Reads a file, or undefined when it can't be read. */
+export function readIfThere(path: string): Buffer | undefined {
+  try {
+    return readFileSync(path);
+  } catch {
+    return undefined;
+  }
+}
```

Change `engine/src/index.ts`:

```diff
diff --git a/engine/src/index.ts b/engine/src/index.ts
--- a/engine/src/index.ts
+++ b/engine/src/index.ts
@@ -13,7 +13,8 @@ export { CLAUDE_MISSING, findClaude, findGitBash, GIT_BASH_MISSING, type Found }
 export { envLookup } from './runPreview';
 export type { NodeContext, NodeOutcome } from './executors';
 export { createRunShell, type RunShell, type RunShellResult } from './shell';
-export { ChatModelError, type ChatMessage, type ChatModel, type ChatModelErrorCode, type ChatPart, type ToolSpec } from './agentLoop/chatModel';
+export { ChatModelError, type ChatMessage, type ChatModel, type ChatModelErrorCode, type ChatPart, type ImagePart, type ToolSpec } from './agentLoop/chatModel';
+export { ATTACHED_IMAGE, IMAGE_NOT_SHOWN, PDF_MAY_NOT_READ, readIfThere, readImages, withAttachedFiles, type ImageData, type StepAttachment } from './attachedFiles';
 export { builtinTools, type LoopTool, type ToolOutput } from './agentLoop/tools';
 export { toLoopTools } from './agentLoop/graphLoopTools';
 export { lastAssistantText, runAgentLoop, type LoopOptions, type LoopResult } from './agentLoop/loop';
```

Change `engine/src/providers/claude/runStep.ts`:

```diff
diff --git a/engine/src/providers/claude/runStep.ts b/engine/src/providers/claude/runStep.ts
--- a/engine/src/providers/claude/runStep.ts
+++ b/engine/src/providers/claude/runStep.ts
@@ -1,10 +1,11 @@
 import type { Options, SDKMessage, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
 import type { EffortLevel, ModelChoice, NodeEventBody, NodeUsage } from '@agent-stream/shared';
 import type { NodeContext, NodeOutcome } from '../../executors';
+import { ATTACHED_IMAGE, PDF_READ_TOOL, readIfThere, readImages, withAttachedFiles } from '../../attachedFiles';
 import { READ_ONLY_TOOLS, STEP_GRAPH_TOOL_PREFIX, type ToolGate } from '../toolGate';
 import { authSourceError, isSubscriptionAuthSource, projectSettingsProblem, sanitizedEnv, UNVERIFIED_AUTH } from './auth';
 import { modelOptions } from './models';
-import { blocksOf, graphServer, toolResultText, type QueryFn } from './sdk';
+import { blocksOf, graphServer, toolResultText, userMessage, type QueryFn, type UserBlock } from './sdk';
 import { toSdkGate } from './sdkGate';
 
 /** The in-process MCP server that serves a step's graph tools: they are `mcp__run_graph__<name>` (STEP_GRAPH_TOOL_PREFIX). */
@@ -94,8 +95,11 @@ export function claudeRunStep(deps: ClaudeRunDeps) {
     const settingsProblem = projectSettingsProblem(ctx.cwd);
     if (settingsProblem) return { ok: false, output: '', error: settingsProblem };
     const chosen = sdkModelOptions(deps, ctx);
+    // Its attachments (spec §6b.5): images go in the step's first message; PDFs and text files are read with the read tools.
+    const text = withAttachedFiles(ctx.prompt, ctx.attachments, { image: ATTACHED_IMAGE, pdf: PDF_READ_TOOL });
+    const images = readImages(ctx.attachments, readIfThere);
     // The model and effort the step actually runs with: an effort the model doesn't offer is already dropped.
-    ctx.emit({ type: 'start', kind: 'agent', cwd: ctx.cwd, prompt: ctx.prompt, ...(chosen.model && { model: chosen.model }), ...(chosen.effort && { effort: chosen.effort as EffortLevel }) });
+    ctx.emit({ type: 'start', kind: 'agent', cwd: ctx.cwd, prompt: text, ...(chosen.model && { model: chosen.model }), ...(chosen.effort && { effort: chosen.effort as EffortLevel }) });
     const abortController = new AbortController();
     const onAbort = () => abortController.abort();
     ctx.signal.addEventListener('abort', onAbort, { once: true });
@@ -121,7 +125,9 @@ export function claudeRunStep(deps: ClaudeRunDeps) {
     }
     try {
       let sawInit = false;
-      for await (const message of deps.queryFn({ prompt: ctx.prompt, options })) {
+      const blocks: UserBlock[] = [{ type: 'text', text }, ...images.map((i): UserBlock => ({ type: 'image', source: { type: 'base64', media_type: i.mediaType as 'image/png', data: i.data } }))];
+      const prompt = images.length ? userMessage(blocks) : text;
+      for await (const message of deps.queryFn({ prompt, options })) {
         if (message.type === 'system' && (message as { subtype?: string }).subtype === 'init') sawInit = true;
         // Fail closed: a result we cannot tie to a checked auth source is not trusted.
         if (message.type === 'result' && !sawInit) return { ok: false, output: '', error: UNVERIFIED_AUTH };
```

Change `engine/src/providers/claude/sdk.ts`:

```diff
diff --git a/engine/src/providers/claude/sdk.ts b/engine/src/providers/claude/sdk.ts
--- a/engine/src/providers/claude/sdk.ts
+++ b/engine/src/providers/claude/sdk.ts
@@ -1,8 +1,8 @@
 import { createSdkMcpServer, query, tool, type ModelInfo, type Options, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
 import type { GraphTool } from '../types';
 
-/** The slice of the SDK's `query` we use; tests substitute a fake. */
-export type QueryFn = (params: { prompt: string; options?: Options }) => AsyncIterable<SDKMessage>;
+/** The slice of the SDK's `query` we use; tests substitute a fake. A prompt with images is a stream of one user message. */
+export type QueryFn = (params: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options }) => AsyncIterable<SDKMessage>;
 
 export const realQuery: QueryFn = query;
 
@@ -12,6 +12,17 @@ export type ModelQueryFn = (params: { prompt: AsyncIterable<SDKUserMessage>; opt
 
 export const realModelQuery: ModelQueryFn = query;
 
+/** A block of a user message: text, an image, or a PDF (a document), in the Messages API's base64 form. */
+export type UserBlock =
+  | { type: 'text'; text: string }
+  | { type: 'image'; source: { type: 'base64'; media_type: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'; data: string } }
+  | { type: 'document'; source: { type: 'base64'; media_type: 'application/pdf'; data: string } };
+
+/** A prompt with images or PDFs (step model spec §6b.5): one user message, as streaming input that then ends. */
+export async function* userMessage(blocks: UserBlock[]): AsyncGenerator<SDKUserMessage> {
+  yield { type: 'user', message: { role: 'user', content: blocks }, parent_tool_use_id: null };
+}
+
 /** A loose view of message content blocks, so we don't depend on every SDK block type. */
 export type LooseBlock = {
   type: string;
```

Change `engine/src/providers/codex/protocol.ts`:

```diff
diff --git a/engine/src/providers/codex/protocol.ts b/engine/src/providers/codex/protocol.ts
--- a/engine/src/providers/codex/protocol.ts
+++ b/engine/src/providers/codex/protocol.ts
@@ -63,7 +63,8 @@ export type ThreadResponse = { thread: { id: string } };
 
 // turn/start, turn/interrupt
 export type TextElement = { byteRange: { start: number; end: number }; placeholder: string | null };
-export type UserInput = { type: 'text'; text: string; text_elements: TextElement[] };
+/** Text, or an image Codex reads from a path on this machine (`localImage`, codex-cli 0.160 generate-ts). */
+export type UserInput = { type: 'text'; text: string; text_elements: TextElement[] } | { type: 'localImage'; path: string };
 export type TurnStartParams = { threadId: string; input: UserInput[]; effort?: ReasoningEffort | null };
 export type TurnStatus = 'completed' | 'interrupted' | 'failed' | 'inProgress';
 export type TurnError = { message: string; additionalDetails: string | null };
```

Change `engine/src/providers/codex/runStep.ts`:

```diff
diff --git a/engine/src/providers/codex/runStep.ts b/engine/src/providers/codex/runStep.ts
--- a/engine/src/providers/codex/runStep.ts
+++ b/engine/src/providers/codex/runStep.ts
@@ -2,6 +2,7 @@ import { isWriteCapable, type ModelChoice, type NodeEventBody, type NodeUsage }
 import { toLoopTools } from '../../agentLoop/graphLoopTools';
 import { clipResult } from '../../agentLoop/tools';
 import type { NodeContext, NodeOutcome } from '../../executors';
+import { ATTACHED_IMAGE, PDF_MAY_NOT_READ, withAttachedFiles } from '../../attachedFiles';
 import { STEP_GRAPH_TOOL_PREFIX, type ToolGate } from '../toolGate';
 import { changePrivacyReason, createServerRequestHandler, toPatchChanges, type PatchChange } from './approvals';
 import { errorMessage, openCodexForThreads, type CodexConnection, type SpawnCodex } from './connection';
@@ -99,8 +100,11 @@ export function codexRunStep(deps: CodexRunDeps) {
     const codexPath = deps.codexPath();
     if (!codexPath) return { ok: false, output: '', error: deps.missing() };
     const effort = codexEffort(ctx, deps.knownModels(), deps.warnOnce);
+    // Its attachments (spec §6b.5): images go with turn/start, Codex reading them itself; other files by path.
+    const text = withAttachedFiles(ctx.prompt, ctx.attachments, { image: ATTACHED_IMAGE, pdf: PDF_MAY_NOT_READ });
+    const images = (ctx.attachments ?? []).filter((f) => f.kind === 'image' && !f.missing).map((f) => f.path);
     // The model and effort the step actually runs with: an effort the model doesn't offer is already dropped.
-    ctx.emit({ type: 'start', kind: 'agent', cwd: ctx.cwd, prompt: ctx.prompt, ...(ctx.model && { model: ctx.model }), ...(effort && { effort }) });
+    ctx.emit({ type: 'start', kind: 'agent', cwd: ctx.cwd, prompt: text, ...(ctx.model && { model: ctx.model }), ...(effort && { effort }) });
     const readOnly = !isWriteCapable(ctx.node);
     const tools = readOnly ? [] : toLoopTools(ctx.graphTools ?? [], STEP_GRAPH_TOOL_PREFIX);
     /** Aborted when the step ends or Codex exits: approval cards still open are withdrawn (R18). */
@@ -141,7 +145,8 @@ export function codexRunStep(deps: CodexRunDeps) {
       const outcome = await runCodexTurn({
         conn,
         threadId: thread.thread.id,
-        text: ctx.prompt,
+        text,
+        ...(images.length > 0 && { images }),
         effort,
         signal: ctx.signal,
         onItem: (phase, item) => {
```

Change `engine/src/providers/codex/turn.ts`:

```diff
diff --git a/engine/src/providers/codex/turn.ts b/engine/src/providers/codex/turn.ts
--- a/engine/src/providers/codex/turn.ts
+++ b/engine/src/providers/codex/turn.ts
@@ -13,6 +13,7 @@ import type {
   TurnCompletedNotification,
   TurnStartParams,
   TurnStartResponse,
+  UserInput,
 } from './protocol';
 
 /** How long Stop waits for the turn id, then for turn/completed, before closing anyway (spec §4.6). */
@@ -45,6 +46,8 @@ export type RunTurnOptions = {
   conn: CodexConnection;
   threadId: string;
   text: string;
+  /** Images to send with the text, as files Codex reads (step model spec §6b.5). */
+  images?: string[];
   effort?: EffortLevel;
   /** Stop. */
   signal: AbortSignal;
@@ -112,7 +115,8 @@ export async function runCodexTurn(o: RunTurnOptions): Promise<TurnOutcome> {
     started.reject(error);
   });
 
-  const params: TurnStartParams = { threadId: o.threadId, input: [{ type: 'text', text: o.text, text_elements: [] }], ...(o.effort && { effort: o.effort }) };
+  const input: UserInput[] = [{ type: 'text', text: o.text, text_elements: [] }, ...(o.images ?? []).map((path): UserInput => ({ type: 'localImage', path }))];
+  const params: TurnStartParams = { threadId: o.threadId, input, ...(o.effort && { effort: o.effort }) };
   o.conn.request<TurnStartResponse>('turn/start', params).then(
     (r) => started.resolve(r.turn.id),
     (e: unknown) => started.reject(e),
```

Change `extension/src/providers/copilot.ts`:

```diff
diff --git a/extension/src/providers/copilot.ts b/extension/src/providers/copilot.ts
--- a/extension/src/providers/copilot.ts
+++ b/extension/src/providers/copilot.ts
@@ -1,13 +1,20 @@
 import { randomUUID } from 'node:crypto';
 import * as vscode from 'vscode';
 import {
+  ATTACHED_IMAGE,
   builtinTools,
+  IMAGE_NOT_SHOWN,
   lastAssistantText,
+  PDF_MAY_NOT_READ,
+  readIfThere,
+  readImages,
   runAgentLoop,
   STEP_GRAPH_TOOL_PREFIX,
   toLoopTools,
+  withAttachedFiles,
   type AgentProvider,
   type ChatMessage,
+  type ImageData,
   type NodeOutcome,
   type RunShell,
 } from '@agent-stream/engine';
@@ -43,8 +50,10 @@ export type CopilotDeps = {
   limits: () => CopilotLimits;
 };
 
-/** Not in @types/vscode 1.106, but present at runtime (spec §2, ruling R17). */
-type ToolCalling = { capabilities?: { supportsToolCalling?: boolean } };
+/** Not in @types/vscode 1.106, but present at runtime (spec §2, ruling R17): whether a model calls tools, and takes images. */
+type ToolCalling = { capabilities?: { supportsToolCalling?: boolean; supportsImageToText?: boolean } };
+/** Whether VS Code says this model takes images (step model spec §6b.5); a model that doesn't say, doesn't. */
+export const takesImages = (m: vscode.LanguageModelChat): boolean => (m as ToolCalling).capabilities?.supportsImageToText === true;
 
 /** The models Agent Stream can run (spec §5.2): tool calling, no internal copilot-* ids, one per id, Auto first. */
 export function usableModels(models: readonly vscode.LanguageModelChat[]): vscode.LanguageModelChat[] {
@@ -67,6 +76,11 @@ const choiceOf = (m: vscode.LanguageModelChat): ModelChoice => ({ value: m.id, l
 /** Copilot reports no tokens or cost: only the request count (ruling R16). */
 const requestUsage = (requests: number): NodeUsage => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, turns: requests });
 const userText = (text: string): ChatMessage => ({ role: 'user', content: [{ type: 'text', text }] });
+/** A user message with images after its text. */
+const userWithImages = (text: string, images: readonly ImageData[]): ChatMessage => ({
+  role: 'user',
+  content: [{ type: 'text', text }, ...images.map((i) => ({ type: 'image' as const, mediaType: i.mediaType, data: i.data }))],
+});
 const reason = (e: unknown) => (e instanceof Error ? e.message : String(e));
 
 /**
@@ -180,15 +194,18 @@ export function createCopilotProvider(d: CopilotDeps): AgentProvider {
 
     async runStep(ctx, gate): Promise<NodeOutcome> {
       const picked = await pick(ctx.model);
+      // Attached images go to a model that takes them; for any other the list says so (step model spec §6b.5).
+      const images = 'model' in picked && takesImages(picked.model) ? readImages(ctx.attachments, readIfThere) : [];
+      const prompt = withAttachedFiles(ctx.prompt, ctx.attachments, { image: images.length ? ATTACHED_IMAGE : IMAGE_NOT_SHOWN, pdf: PDF_MAY_NOT_READ });
       // The model the step actually runs on (Auto for one that is gone). Copilot has no effort levels, so ctx.effort is never sent (step model spec §6).
-      ctx.emit({ type: 'start', kind: 'agent', cwd: ctx.cwd, prompt: ctx.prompt, ...('model' in picked && { model: picked.model.id }) });
+      ctx.emit({ type: 'start', kind: 'agent', cwd: ctx.cwd, prompt, ...('model' in picked && { model: picked.model.id }) });
       if ('error' in picked) return { ok: false, output: '', error: picked.error };
       if (picked.note) ctx.emit({ type: 'text', text: picked.note });
       const cap = d.limits().maxRequestsPerStep;
       const r = await runAgentLoop({
         model: chatModel(picked.model),
         system: stepPreamble(ctx.cwd),
-        messages: [userText(ctx.prompt)],
+        messages: [images.length ? userWithImages(prompt, images) : userText(prompt)],
         tools: [
           ...builtinTools({ cwd: ctx.cwd, runShell: d.runShell, readOnly: !isWriteCapable(ctx.node) }),
           ...toLoopTools(ctx.graphTools ?? [], STEP_GRAPH_TOOL_PREFIX),
```

Change `extension/src/providers/copilotModel.ts`:

```diff
diff --git a/extension/src/providers/copilotModel.ts b/extension/src/providers/copilotModel.ts
--- a/extension/src/providers/copilotModel.ts
+++ b/extension/src/providers/copilotModel.ts
@@ -52,8 +52,13 @@ export function toLanguageModelMessage(m: ChatMessage): vscode.LanguageModelChat
       m.content.map((p) => (p.type === 'text' ? new vscode.LanguageModelTextPart(p.text) : new vscode.LanguageModelToolCallPart(p.callId, p.name, asObject(p.input)))),
     );
   }
-  const parts: (vscode.LanguageModelTextPart | vscode.LanguageModelToolResultPart)[] = m.content.map((c) =>
-    c.type === 'text' ? new vscode.LanguageModelTextPart(c.text) : new vscode.LanguageModelToolResultPart(c.callId, [new vscode.LanguageModelTextPart(c.text)]),
+  const parts: (vscode.LanguageModelTextPart | vscode.LanguageModelToolResultPart | vscode.LanguageModelDataPart)[] = m.content.map((c) =>
+    c.type === 'text'
+      ? new vscode.LanguageModelTextPart(c.text)
+      : c.type === 'image'
+        ? // An attached image (step model spec §6b.5), only sent to a model that takes images.
+          new vscode.LanguageModelDataPart(Buffer.from(c.data, 'base64'), c.mediaType)
+        : new vscode.LanguageModelToolResultPart(c.callId, [new vscode.LanguageModelTextPart(c.text)]),
   );
   // Auto refuses a request whose last message has no text ("needs a prompt"); a wire-level nudge, never in the history.
   if (m.content.some((c) => c.type === 'toolResult') && !m.content.some((c) => c.type === 'text')) parts.push(new vscode.LanguageModelTextPart(TOOL_RESULTS_FOLLOW_UP));
```

- [ ] **Step 4: Run the tests and typecheck**

Run: `npm test -w engine -- test/attachedFiles.test.ts test/claudeRunStep.test.ts test/codexRunStep.test.ts && npm test -w extension -- test/copilot.test.ts`
Expected: PASS.
Run: `npm run typecheck && npm test`
Expected: all workspaces pass (a test that times out only under heavy machine load is not a failure of this task: run it again).

- [ ] **Step 5: Commit**

```bash
git add engine/src/agentLoop/chatModel.ts engine/src/agentLoop/compact.ts engine/src/attachedFiles.ts engine/src/index.ts engine/src/providers/claude/runStep.ts engine/src/providers/claude/sdk.ts engine/src/providers/codex/protocol.ts engine/src/providers/codex/runStep.ts engine/src/providers/codex/turn.ts engine/test/attachedFiles.test.ts engine/test/claudeModels.test.ts engine/test/claudePlanTurn.test.ts engine/test/claudeRunStep.test.ts engine/test/codexRunStep.test.ts extension/src/providers/copilot.ts extension/src/providers/copilotModel.ts extension/test/copilot.test.ts
git commit -m "feat: agents receive their attachments, images as images" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 18: Chat attachments, and attachment names for the planner

**Spec covered:** §6b.1 (chat attachments, the planner told names only), §6b.2 (stored in the session, never committed), §6b.5 chat (images, text inlined and cut at 100 KB, PDFs per provider, chips), §7 chat tests.

**Files:**
- Create: `engine/src/chatAttachments.ts`
- Modify: `engine/src/agentLoop/tools.ts`, `engine/src/app.ts`, `engine/src/index.ts`, `engine/src/planner.ts`, `engine/src/plannerTools.ts`, `engine/src/privatePaths.ts`, `engine/src/providers/claude/planTurn.ts`, `engine/src/providers/codex/planTurn.ts`, `engine/src/providers/types.ts`, `extension/src/providers/copilot.ts`, `shared/src/schemas.ts`, `shared/src/types.ts`
- Test: `engine/test/chatAttachments.test.ts` (new), `engine/test/codexPlanTurn.test.ts`, `extension/test/copilot.test.ts`

**Interfaces:**
- Consumes: Tasks 12, 17.
- Produces: `ChatEntry.attachments?: string[]`; `chat` message `attachments?: AttachmentUpload[]`; `PlannerTurn.files?: TurnFile[]`, `TurnFile`, `PlannerEvent` `note`; `engine/src/chatAttachments.ts` (`ChatAttachment`, `chatAttachmentsDir`, `saveChatAttachments`, `inlineTextFiles`, `turnFiles`, `notIncluded`); `Planner.send(…, { attachments })`; `PRIVATE_FOLDER` moves to `privatePaths.ts` and also closes `.agent-stream/sessions` to Claude's read tools; `get_graph` lists attachment names.

- [ ] **Step 1: Write the failing tests**

Create `engine/test/chatAttachments.test.ts`:

`````ts
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Options, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ServerMessage } from '@agent-stream/shared';
import { createApp } from '../src/app';
import { inlineTextFiles, saveChatAttachments, type ChatAttachment } from '../src/chatAttachments';
import { GraphStore } from '../src/graphStore';
import { graphTools } from '../src/plannerTools';
import { privatePathDenial, PRIVATE_FOLDER } from '../src/privatePaths';
import { createClaudeProvider } from '../src/providers/claude';
import type { PlannerTurn } from '../src/providers/types';
import { RunStore } from '../src/runStore';
import { appTestDeps, fixedClock, outsideGit, signedIn, testGitBash, testProvider, tmpProject, tmpValuesFile } from './helpers';

const b64 = (text: string) => Buffer.from(text).toString('base64');

describe('saving chat attachments (step model spec §6b.2)', () => {
  it('keeps them in the session’s attachments folder under safe, unique names', () => {
    const paths = tmpProject();
    const r = saveChatAttachments(paths, 'default', [{ name: '/tmp/shot (1).png', data: b64('PNG') }, { name: 'shot _1_.png', data: b64('PNG2') }]);
    if (!r.ok) throw new Error(r.error);
    expect(r.files.map((f) => [f.name, f.kind])).toEqual([['shot _1_.png', 'image'], ['shot _1_-2.png', 'image']]);
    expect(readFileSync(join(paths.sessionsDir, 'default', 'attachments', 'shot _1_-2.png'), 'utf8')).toBe('PNG2');
    // The sessions folder is ignored by Git, so chat attachments are never committed.
    expect(readFileSync(join(paths.dataDir, '.gitignore'), 'utf8')).toContain('sessions/');
  });

  it('refuses a type it doesn’t take, writing nothing', () => {
    const paths = tmpProject();
    expect(saveChatAttachments(paths, 'default', [{ name: 'a.md', data: b64('x') }, { name: 'tool.exe', data: b64('MZ') }])).toEqual({ ok: false, error: expect.stringContaining("tool.exe can't be attached.") });
    expect(existsSync(join(paths.sessionsDir, 'default', 'attachments'))).toBe(false);
  });

  it('inlines text files after the message, cutting each at 100 KB with a note', () => {
    const file = (name: string, text: string): ChatAttachment => ({ name, kind: 'text', path: name, bytes: Buffer.from(text) });
    expect(inlineTextFiles('Look at this.', [file('notes.md', 'Has ``` inside\n')])).toBe('Look at this.\n\nAttached to this message:\n\n### notes.md\n\n````\nHas ``` inside\n````\n');
    const big = inlineTextFiles('Big.', [file('big.log', 'x'.repeat(100 * 1024 + 5))]);
    expect(big).toContain('### big.log (cut: only its first 100 KB is included)');
    expect(big).toContain(`${'x'.repeat(100 * 1024)}\n\`\`\``);
    expect(inlineTextFiles('Plain.', [])).toBe('Plain.');
  });

  it('the read tools can’t open the sessions folder', () => {
    const root = tmpProject().root;
    expect(privatePathDenial(root, 'Read', { file_path: join(root, '.agent-stream', 'sessions', 'default', 'attachments', 'shot.png') })).toBe(PRIVATE_FOLDER);
    expect(privatePathDenial(root, 'Glob', { pattern: '*', path: '.agent-stream/sessions' })).toBe(PRIVATE_FOLDER);
    expect(privatePathDenial(root, 'Read', { file_path: join(root, '.agent-stream', 'attachments', 'g', 'a.png') })).toBeNull();
  });
});

describe('a chat message with attachments', () => {
  it('reaches the planner with that message only: text inlined, images and PDFs as files, names on the chat line', async () => {
    const turns: PlannerTurn[] = [];
    const provider = testProvider({ planTurn: async (t) => (turns.push(t), { ok: true, sessionId: 'p1' }) });
    const paths = tmpProject();
    const app = createApp({ ...appTestDeps(), projectDir: paths.root, valuesFile: tmpValuesFile(), provider, status: signedIn, maxParallel: 1, gitBash: testGitBash });
    const graphId = app.graphStore.create('G').id;
    const msgs: ServerMessage[] = [];
    const c = { send: (m: ServerMessage) => void msgs.push(m) };
    app.connect(c);
    await app.handle(c, { type: 'openChat', graphId, sessionId: 'default' });
    await app.handle(c, { type: 'chat', graphId, sessionId: 'default', text: 'Build this.', attachments: [{ name: 'notes.md', data: b64('Use dev.') }, { name: 'shot.png', data: b64('PNG') }, { name: 'spec.pdf', data: b64('%PDF') }] });
    await vi.waitFor(() => expect(turns).toHaveLength(1), { timeout: 5000 });
    expect(turns[0].prompt).toBe('Build this.\n\nAttached to this message:\n\n### notes.md\n\n```\nUse dev.\n```\n');
    expect(turns[0].files?.map((f) => [f.name, f.kind, f.mediaType, f.data])).toEqual([
      ['shot.png', 'image', 'image/png', b64('PNG')],
      ['spec.pdf', 'pdf', 'application/pdf', b64('%PDF')],
    ]);
    const user = msgs.find((m): m is Extract<ServerMessage, { type: 'chatEntry' }> => m.type === 'chatEntry' && m.entry.role === 'user');
    expect(user?.entry).toMatchObject({ text: 'Build this.', attachments: ['notes.md', 'shot.png', 'spec.pdf'] });
    await app.handle(c, { type: 'chat', graphId, sessionId: 'default', text: 'And now?' });
    await vi.waitFor(() => expect(turns).toHaveLength(2), { timeout: 5000 });
    expect(turns[1].prompt).not.toContain('notes.md');
    expect(turns[1]).not.toHaveProperty('files');
  });

  it('refuses a file it doesn’t take, and the planner gets nothing', async () => {
    const planTurn = vi.fn(async () => ({ ok: true as const }));
    const paths = tmpProject();
    const app = createApp({ ...appTestDeps(), projectDir: paths.root, valuesFile: tmpValuesFile(), provider: testProvider({ planTurn }), status: signedIn, maxParallel: 1, gitBash: testGitBash });
    const graphId = app.graphStore.create('G').id;
    const msgs: ServerMessage[] = [];
    await app.handle({ send: (m) => void msgs.push(m) }, { type: 'chat', graphId, sessionId: 'default', text: 'x', attachments: [{ name: 'tool.exe', data: b64('MZ') }] });
    expect(msgs.at(-1)).toEqual({ type: 'error', message: expect.stringContaining("tool.exe can't be attached.") });
    expect(planTurn).not.toHaveBeenCalled();
  });
});

describe('Claude planner: chat attachments', () => {
  it('sends images as images and PDFs as documents with the message', async () => {
    const prompts: (string | AsyncIterable<SDKUserMessage>)[] = [];
    const provider = createClaudeProvider({
      findClaude: () => ({ ok: true, path: '/bin/claude' }),
      checkAuth: async () => signedIn,
      queryFn: ({ prompt }: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options }) => {
        prompts.push(prompt);
        return (async function* (): AsyncGenerator<SDKMessage> {
          yield { type: 'system', subtype: 'init', apiKeySource: 'none', session_id: 's1' } as unknown as SDKMessage;
          yield { type: 'result', subtype: 'success', is_error: false, result: 'ok', num_turns: 1, total_cost_usd: 0, usage: {}, session_id: 's1' } as unknown as SDKMessage;
        })();
      },
    });
    await provider.status();
    const r = await provider.planTurn({
      prompt: 'What is this?',
      systemAppend: '',
      cwd: tmpProject().root,
      tools: [],
      files: [
        { name: 'shot.png', kind: 'image', path: 'shot.png', mediaType: 'image/png', data: 'UE5H' },
        { name: 'spec.pdf', kind: 'pdf', path: 'spec.pdf', mediaType: 'application/pdf', data: 'JVBE' },
      ],
      gate: { privacy: () => null, isReadOnly: () => true, isSelfApproving: () => false, approve: async () => ({ allow: true, by: 'user' }), decide: async () => ({ allow: true, by: 'user' }) },
      transcript: { load: () => undefined, save: () => {} },
      signal: new AbortController().signal,
      onEvent: () => {},
    });
    expect(r.ok).toBe(true);
    const prompt = prompts[0];
    if (typeof prompt === 'string') throw new Error('expected a message with files');
    const sent: SDKUserMessage[] = [];
    for await (const m of prompt) sent.push(m);
    expect(sent[0].message.content).toEqual([
      { type: 'text', text: 'What is this?' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'UE5H' } },
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'JVBE' } },
    ]);
  });
});

describe('the planner is told attachment names, never contents (spec §6b.1)', () => {
  it('get_graph lists the graph’s and each step’s attachments', async () => {
    const paths = tmpProject();
    const graphStore = new GraphStore(paths, fixedClock());
    const graphId = graphStore.create('G').id;
    graphStore.apply(graphId, { type: 'setGraphAttachments', names: ['brief.pdf'] }, 'user');
    graphStore.apply(graphId, { type: 'addNode', node: { title: 'Design', kind: 'agent', prompt: 'p', attachments: ['mockup.png'] } }, 'user');
    const tools = graphTools({ graphStore, runStore: new RunStore(paths), graphId, source: { kind: 'planner' }, requestRun: () => null, checkout: outsideGit(paths.root) });
    const summary = JSON.parse((await tools.find((t) => t.name === 'get_graph')!.run({})).text);
    expect(summary.attachments).toEqual(['brief.pdf']);
    expect(summary.nodes[0].attachments).toEqual(['mockup.png']);
    expect(tools.map((t) => t.name).filter((n) => /attach/.test(n))).toEqual([]);
  });
});
`````

Change `engine/test/codexPlanTurn.test.ts` (the plan helper takes files; new test):

```diff
diff --git a/engine/test/codexPlanTurn.test.ts b/engine/test/codexPlanTurn.test.ts
--- a/engine/test/codexPlanTurn.test.ts
+++ b/engine/test/codexPlanTurn.test.ts
@@ -3,7 +3,7 @@ import { describe, expect, it, vi } from 'vitest';
 import { z } from 'zod';
 import type { EffortLevel } from '@agent-stream/shared';
 import { createPlannerGate } from '../src/providers/toolGate';
-import type { GraphTool, PlannerEvent, PlannerTurn } from '../src/providers/types';
+import type { GraphTool, PlannerEvent, PlannerTurn, TurnFile } from '../src/providers/types';
 import { codexPlanTurn, CODEX_RESUME_FAILED } from '../src/providers/codex/planTurn';
 import type { CodexRunDeps } from '../src/providers/codex/runStep';
 import { agentMessage, approvalParams, fakeCodex, FakeRpcError, mcpConfig, readAction, toolCallItem, turnHandlers, waitFor, type FakeHandler, type Msg, type TurnScript } from './codexFake';
@@ -12,7 +12,7 @@ const cwd = resolve('/', 'work', 'proj');
 const values = resolve('/', 'h', '.agent-stream', 'values', 'abc.json');
 const zsh = (script: string) => `/bin/zsh -lc '${script}'`;
 
-type PlanOptions = { resume?: string; model?: string; effort?: EffortLevel; signal?: AbortSignal; codexPath?: string | undefined };
+type PlanOptions = { resume?: string; model?: string; effort?: EffortLevel; signal?: AbortSignal; codexPath?: string | undefined; files?: TurnFile[] };
 
 function setup(handlers: Record<string, FakeHandler>, o: PlanOptions = {}) {
   const fake = fakeCodex(handlers);
@@ -26,6 +26,7 @@ function setup(handlers: Record<string, FakeHandler>, o: PlanOptions = {}) {
     ...(o.resume && { resume: o.resume }),
     ...(o.model && { model: o.model }),
     ...(o.effort && { effort: o.effort }),
+    ...(o.files && { files: o.files }),
     gate: createPlannerGate({ projectDir: cwd, privateFiles: [values], graphToolNames: new Set(['add_step']) }),
     transcript: { load: () => undefined, save: () => {} },
     signal: o.signal ?? new AbortController().signal,
@@ -159,3 +160,17 @@ describe('codexPlanTurn', () => {
     expect(p.fake.procs).toHaveLength(0);
   });
 });
+
+describe('codexPlanTurn: chat attachments (step model spec §6b.5)', () => {
+  it('sends a message’s images with turn/start, and says a PDF couldn’t be included', async () => {
+    const image: TurnFile = { name: 'shot.png', kind: 'image', path: resolve(cwd, '.agent-stream', 'sessions', 'default', 'attachments', 'shot.png'), mediaType: 'image/png', data: 'UE5H' };
+    const pdf: TurnFile = { name: 'spec.pdf', kind: 'pdf', path: resolve(cwd, 'spec.pdf'), mediaType: 'application/pdf', data: 'JVBE' };
+    const p = plan((t) => t.end(), { files: [image, pdf] });
+    await p.run();
+    expect(p.fake.last().paramsOf('turn/start').input).toEqual([
+      { type: 'text', text: 'Add a test step', text_elements: [] },
+      { type: 'localImage', path: image.path },
+    ]);
+    expect(p.events).toContainEqual({ type: 'note', text: "spec.pdf couldn't be included: OpenAI Codex can't read PDFs in the chat." });
+  });
+});
```

Change `extension/test/copilot.test.ts` (new chat tests):

```diff
diff --git a/extension/test/copilot.test.ts b/extension/test/copilot.test.ts
--- a/extension/test/copilot.test.ts
+++ b/extension/test/copilot.test.ts
@@ -3,7 +3,7 @@ import { tmpdir } from 'node:os';
 import { join } from 'node:path';
 import { describe, expect, it, vi } from 'vitest';
 import * as vscode from 'vscode';
-import { createPlannerGate, type ChatMessage, type GraphTool, type NodeContext, type PlannerEvent, type PlannerTurn, type RunShell, type StepAttachment, type ToolGate } from '@agent-stream/engine';
+import { createPlannerGate, type ChatMessage, type GraphTool, type NodeContext, type PlannerEvent, type PlannerTurn, type RunShell, type StepAttachment, type ToolGate, type TurnFile } from '@agent-stream/engine';
 import { emptyGraph, type EffortLevel, type GraphNode, type NodeEventBody } from '@agent-stream/shared';
 import { COPILOT_CONSENT_LATER, COPILOT_RESUME_FAILED, COPILOT_UNAVAILABLE, createCopilotProvider, type CopilotLimits, type LmAccess, type LmApi } from '../src/providers/copilot';
 import { COPILOT_PERMISSION } from '../src/providers/copilotModel';
@@ -413,3 +413,49 @@ describe('Copilot: attachments (step model spec §6b.5)', () => {
     expect(user.content).toEqual([text("Do it.\n\nAttached files:\n- .agent-stream/attachments/g/mockup.png (This image couldn't be shown to the model.)\n- .agent-stream/attachments/g/spec.pdf (PDF: the model may not be able to read PDFs)\n")]);
   });
 });
+
+describe('Copilot planner: chat attachments (step model spec §6b.5)', () => {
+  const image: TurnFile = { name: 'shot.png', kind: 'image', path: 'shot.png', mediaType: 'image/png', data: Buffer.from('PNG').toString('base64') };
+  const pdf: TurnFile = { name: 'spec.pdf', kind: 'pdf', path: 'spec.pdf', mediaType: 'application/pdf', data: 'JVBE' };
+  function chatTurn(files: TurnFile[]) {
+    const events: PlannerEvent[] = [];
+    const saved = new Map<string, ChatMessage[]>();
+    const cwd = mkdtempSync(join(tmpdir(), 'copilot-chat-'));
+    const t: PlannerTurn = {
+      prompt: 'What is this?',
+      systemAppend: 'You are the planner.',
+      cwd,
+      tools: [],
+      files,
+      gate: createPlannerGate({ projectDir: cwd, privateFiles: [], graphToolNames: new Set() }),
+      signal: new AbortController().signal,
+      onEvent: (e) => events.push(e),
+      transcript: { load: (id) => saved.get(id), save: (id, messages) => void saved.set(id, structuredClone(messages)) },
+    };
+    return { t, events, saved };
+  }
+  const model = (images: boolean) => {
+    const m = fakeLmModel({ id: 'auto', name: 'Auto' });
+    (m.model as unknown as { capabilities: Record<string, boolean> }).capabilities.supportsImageToText = images;
+    return m;
+  };
+
+  it('sends images to a model that takes them, says a PDF couldn’t be included, and saves no image bytes', async () => {
+    const m = model(true);
+    const c = chatTurn([image, pdf]);
+    await provider({ lm: models(m.model) }).planTurn(c.t);
+    expect(m.requests[0].messages.at(-1)?.content).toEqual([text('What is this?'), new vscode.LanguageModelDataPart(Buffer.from('PNG'), 'image/png')]);
+    expect(c.events).toContainEqual({ type: 'note', text: "spec.pdf couldn't be included: GitHub Copilot can't read PDFs in the chat." });
+    const savedConversation = JSON.stringify([...c.saved.values()]);
+    expect(savedConversation).not.toContain(image.data);
+    expect(savedConversation).toContain('[An image was attached here.]');
+  });
+
+  it('says an image couldn’t be included for a model that doesn’t take images', async () => {
+    const m = model(false);
+    const c = chatTurn([image]);
+    await provider({ lm: models(m.model) }).planTurn(c.t);
+    expect(m.requests[0].messages.at(-1)?.content).toEqual([text('What is this?')]);
+    expect(c.events).toContainEqual({ type: 'note', text: "shot.png couldn't be included: Auto doesn't take images." });
+  });
+});
```

- [ ] **Step 2: Run the tests and see them fail**

Run: `npm test -w engine -- test/chatAttachments.test.ts test/codexPlanTurn.test.ts test/codexReadOnly.test.ts test/loopTools.test.ts test/planner.test.ts && npm test -w extension -- test/copilot.test.ts`
Expected: FAIL — the new modules, exports or behaviour do not exist yet (import errors or assertion failures).

- [ ] **Step 3: Implement**

Create `engine/src/chatAttachments.ts`:

```ts
import { mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { attachmentFileProblem, attachmentKind, fenceFor, imageMediaType, MAX_INLINED_TEXT_CHARS, safeAttachmentName, uniqueAttachmentName, type AttachmentKind, type AttachmentUpload } from '@agent-stream/shared';
import { writeFileAtomic } from './fsutil';
import type { ProjectPaths } from './paths';
import type { TurnFile } from './providers/types';

/** A file a chat message carries, as saved in the session (step model spec §6b.2). */
export type ChatAttachment = { name: string; kind: AttachmentKind; path: string; bytes: Buffer };

/** Where a session keeps its chat attachments: `.agent-stream/sessions/<session>/attachments/`, which Git ignores. */
export const chatAttachmentsDir = (paths: ProjectPaths, sessionId: string): string => join(paths.sessionsDir, sessionId, 'attachments');

/** Saves a chat message's files under their own names made safe (unique in the folder); every file is checked first. */
export function saveChatAttachments(paths: ProjectPaths, sessionId: string, uploads: readonly AttachmentUpload[]): { ok: true; files: ChatAttachment[] } | { ok: false; error: string } {
  const decoded = uploads.map((u) => ({ name: safeAttachmentName(u.name), bytes: Buffer.from(u.data, 'base64') }));
  for (const f of decoded) {
    const problem = attachmentFileProblem(f.name, f.bytes.byteLength);
    if (problem) return { ok: false, error: problem };
  }
  const dir = chatAttachmentsDir(paths, sessionId);
  mkdirSync(dir, { recursive: true });
  const used = new Set(readdirSync(dir));
  const files = decoded.map((f) => {
    const name = uniqueAttachmentName(f.name, used);
    used.add(name);
    const path = join(dir, name);
    writeFileAtomic(path, f.bytes);
    return { name, kind: attachmentKind(name)!, path, bytes: f.bytes };
  });
  return { ok: true, files };
}

/** A chat message's text files, inlined after its text, each cut at 100 KB with a note (spec §6b.5). */
export function inlineTextFiles(text: string, files: readonly ChatAttachment[]): string {
  const texts = files.filter((f) => f.kind === 'text');
  if (!texts.length) return text;
  const sections = texts.map((f) => {
    const content = f.bytes.toString('utf8');
    const cut = content.length > MAX_INLINED_TEXT_CHARS;
    const shown = cut ? content.slice(0, MAX_INLINED_TEXT_CHARS) : content;
    const fence = fenceFor(shown);
    return [`### ${f.name}${cut ? ' (cut: only its first 100 KB is included)' : ''}`, '', fence, shown.replace(/\n$/, ''), fence].join('\n');
  });
  return `${text}\n\nAttached to this message:\n\n${sections.join('\n\n')}\n`;
}

/** A chat message's images and PDFs, for the provider to send as it can. */
export function turnFiles(files: readonly ChatAttachment[]): TurnFile[] {
  return files.flatMap((f): TurnFile[] => {
    if (f.kind === 'image') return [{ name: f.name, kind: 'image', path: f.path, mediaType: imageMediaType(f.name) ?? 'image/png', data: f.bytes.toString('base64') }];
    if (f.kind === 'pdf') return [{ name: f.name, kind: 'pdf', path: f.path, mediaType: 'application/pdf', data: f.bytes.toString('base64') }];
    return [];
  });
}

/** The note for a chat attachment a provider couldn't take (spec §6b.5). */
export const notIncluded = (name: string, why: string) => `${name} couldn't be included: ${why}.`;
```

Change `engine/src/agentLoop/tools.ts`:

```diff
diff --git a/engine/src/agentLoop/tools.ts b/engine/src/agentLoop/tools.ts
--- a/engine/src/agentLoop/tools.ts
+++ b/engine/src/agentLoop/tools.ts
@@ -4,6 +4,7 @@ import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'nod
 import { Worker } from 'node:worker_threads';
 import { z } from 'zod';
 import { writeFileAtomic } from '../fsutil';
+import { PRIVATE_FOLDER } from '../privatePaths';
 import { truncateHead } from '../prompt';
 import type { RunShell } from '../shell';
 import type { ToolSpec } from './chatModel';
@@ -29,7 +30,6 @@ const MAX_GLOB_ENTRIES = 200_000;
 const GLOB_YIELD_EVERY = 2000;
 /** How long Grep may search before it is stopped: a model-supplied pattern can backtrack catastrophically. */
 export const GREP_TIMEOUT_MS = 20_000;
-const PRIVATE_FOLDER = 'That folder holds Agent Stream run records and sessions, which are private.';
 
 /** Head and tail kept, the middle cut with the existing truncateHead's note (spec §4.2). */
 export function clipResult(text: string, max: number = MAX_RESULT_CHARS): string {
```

Change `engine/src/app.ts`:

```diff
diff --git a/engine/src/app.ts b/engine/src/app.ts
--- a/engine/src/app.ts
+++ b/engine/src/app.ts
@@ -48,6 +48,7 @@ import {
 } from '@agent-stream/shared';
 import { ApprovalBroker } from './approvals';
 import { runAttachments } from './attachedFiles';
+import { saveChatAttachments, type ChatAttachment } from './chatAttachments';
 import { AttachmentStore, type AttachmentFile } from './attachmentStore';
 import { systemClock, type Clock } from './clock';
 import { createCommandExecutor } from './commandExecutor';
@@ -722,7 +723,14 @@ export function createApp(d: AppDeps) {
         if (!g.ok) return error(g.error);
         const s = sessions.load(msg.sessionId);
         if (!s.ok) return error(s.error);
-        planner.send(msg.sessionId, msg.graphId, msg.text).catch((e: unknown) => console.error('[agent-stream] planner error', e));
+        // Files for this message only, kept in the session (git-ignored, never committed) (step model spec §6b.2).
+        let files: ChatAttachment[] | undefined;
+        if (msg.attachments?.length) {
+          const saved = saveChatAttachments(paths, msg.sessionId, msg.attachments);
+          if (!saved.ok) return error(saved.error);
+          files = saved.files;
+        }
+        planner.send(msg.sessionId, msg.graphId, msg.text, files ? { attachments: files } : {}).catch((e: unknown) => console.error('[agent-stream] planner error', e));
         return;
       }
       case 'refineSteps': {
```

Change `engine/src/index.ts`:

```diff
diff --git a/engine/src/index.ts b/engine/src/index.ts
--- a/engine/src/index.ts
+++ b/engine/src/index.ts
@@ -7,7 +7,7 @@ export { createClaudeProvider } from './providers/claude';
 export { createCodexProvider, type CodexProviderDeps } from './providers/codex';
 export { CODEX_MISSING, findCodex } from './providers/codex/auth';
 export { createPlannerGate, createStepGate, STEP_GRAPH_TOOL_PREFIX, type ToolGate } from './providers/toolGate';
-export type { AgentProvider, GraphTool, PlannerEvent, PlannerTurn, PlannerTurnResult, TranscriptStore } from './providers/types';
+export type { AgentProvider, GraphTool, PlannerEvent, PlannerTurn, PlannerTurnResult, TranscriptStore, TurnFile } from './providers/types';
 export { legacyValuesFileFor, valuesFileFor } from './variableValues';
 export { CLAUDE_MISSING, findClaude, findGitBash, GIT_BASH_MISSING, type Found } from './platform';
 export { envLookup } from './runPreview';
```

Change `engine/src/planner.ts`:

```diff
diff --git a/engine/src/planner.ts b/engine/src/planner.ts
--- a/engine/src/planner.ts
+++ b/engine/src/planner.ts
@@ -1,5 +1,6 @@
 import { EventEmitter } from 'node:events';
 import type { ChatEntry, ChatRole, ModelSelection, Op, OpRecord } from '@agent-stream/shared';
+import { inlineTextFiles, turnFiles, type ChatAttachment } from './chatAttachments';
 import { systemClock, type Clock } from './clock';
 import type { GraphStore } from './graphStore';
 import { graphTools, type CheckoutSource } from './plannerTools';
@@ -151,8 +152,8 @@ export class Planner extends EventEmitter {
     return [...this.busy.keys()].some((k) => k.slice(0, k.indexOf('|')) === sessionId);
   }
 
-  private add(sessionId: string, graphId: string, role: ChatRole, text: string): void {
-    const entry: ChatEntry = { at: this.clock(), role, text };
+  private add(sessionId: string, graphId: string, role: ChatRole, text: string, attachments?: string[]): void {
+    const entry: ChatEntry = { at: this.clock(), role, text, ...(attachments?.length && { attachments }) };
     this.d.sessions.chatLog(sessionId).append(graphId, entry);
     this.emit('entry', sessionId, graphId, entry);
   }
@@ -171,8 +172,12 @@ export class Planner extends EventEmitter {
   }
 
   /** Never rejects: failures become chat errors, or are logged when even that is impossible. */
-  /** `options.display` is what the chat shows for the user's turn when it differs from `text`, the full instruction. */
-  async send(sessionId: string, graphId: string, text: string, options: { display?: string } = {}): Promise<void> {
+  /**
+   * `options.display` is what the chat shows for the user's turn when it differs from `text`, the full instruction.
+   * `options.attachments`: files sent with this message only (step model spec §6b.5): text files inlined, images and PDFs
+   * handed to the provider.
+   */
+  async send(sessionId: string, graphId: string, text: string, options: { display?: string; attachments?: ChatAttachment[] } = {}): Promise<void> {
     const k = key(sessionId, graphId);
     if (this.busy.has(k)) {
       try {
@@ -190,7 +195,8 @@ export class Planner extends EventEmitter {
     let resume: string | undefined;
     try {
       this.emit('busy', sessionId, graphId, true);
-      this.add(sessionId, graphId, 'user', options.display ?? text);
+      const files = options.attachments ?? [];
+      this.add(sessionId, graphId, 'user', options.display ?? text, files.map((f) => f.name));
       // Re-checked per turn: the project's settings can change while VS Code runs.
       const provider = this.d.provider();
       const problem = provider.folderProblem?.(this.d.projectDir);
@@ -221,7 +227,8 @@ export class Planner extends EventEmitter {
       });
       const r = await provider.planTurn({
         // Only a resumed conversation has a last turn to compare with; a fresh one starts from get_graph.
-        prompt: (resume ? userEditsPreamble(ops.slice(state.opCursor ?? 0)) : '') + text,
+        prompt: (resume ? userEditsPreamble(ops.slice(state.opCursor ?? 0)) : '') + inlineTextFiles(text, files),
+        ...(turnFiles(files).length > 0 && { files: turnFiles(files) }),
         systemAppend: PLANNER_APPEND,
         cwd: this.d.projectDir,
         tools,
@@ -231,7 +238,8 @@ export class Planner extends EventEmitter {
         gate: createPlannerGate({ projectDir: this.d.projectDir, privateFiles: this.d.privateFiles(), graphToolNames: new Set(tools.map((t) => t.name)) }),
         transcript: { load: (id) => transcripts.load(graphId, provider.id, id), save: (id, messages) => transcripts.save(graphId, provider.id, id, messages) },
         signal: abortController.signal,
-        onEvent: (e) => (e.type === 'text' ? this.add(sessionId, graphId, 'assistant', e.text) : this.add(sessionId, graphId, 'tool', describeToolCall(e.name, e.input))),
+        onEvent: (e) =>
+          e.type === 'text' ? this.add(sessionId, graphId, 'assistant', e.text) : e.type === 'note' ? this.add(sessionId, graphId, 'note', e.text) : this.add(sessionId, graphId, 'tool', describeToolCall(e.name, e.input)),
       });
       if (stopped()) {
         if (!r.ok && r.resumeFailed) this.d.sessions.setPlannerState(sessionId, graphId, { sessionId: undefined });
```

Change `engine/src/plannerTools.ts`:

```diff
diff --git a/engine/src/plannerTools.ts b/engine/src/plannerTools.ts
--- a/engine/src/plannerTools.ts
+++ b/engine/src/plannerTools.ts
@@ -60,12 +60,15 @@ export function summarizeGraph(graph: Graph) {
     goal: graph.goal,
     instructions: graph.instructions,
     variables: graph.variables.map(({ name, description }) => ({ name, description })),
-    nodes: graph.nodes.map(({ id, title, kind: k, description, prompt, command, timeoutSec, access: a, workspace, model, effort: e, createdBy, updatedBy }) => ({
+    // Names only, as context: the planner never gets their contents, and can't add or remove them (step model spec §6b.1).
+    ...(graph.attachments?.length && { attachments: graph.attachments }),
+    nodes: graph.nodes.map(({ id, title, kind: k, description, prompt, command, timeoutSec, access: a, workspace, model, effort: e, attachments, createdBy, updatedBy }) => ({
       id, title, kind: k, description, prompt, command, timeoutSec,
       ...(a === 'read' && { access: 'read' as const }),
       ...(workspace && { workspace }),
       ...(model && { model: stepModelText(model) }),
       ...(e && { effort: e }),
+      ...(attachments?.length && { attachments }),
       createdBy, updatedBy,
     })),
     edges: graph.edges.map((e) => `${e.from} -> ${e.to}`),
```

Change `engine/src/privatePaths.ts`:

```diff
diff --git a/engine/src/privatePaths.ts b/engine/src/privatePaths.ts
--- a/engine/src/privatePaths.ts
+++ b/engine/src/privatePaths.ts
@@ -3,6 +3,8 @@ import { basename, dirname, join, resolve, sep } from 'node:path';
 
 const VALUES_REASON = "Variable values are private to this machine; Agent Stream doesn't let Claude read the variable values file.";
 const RUN_REASON = "Run records contain variable values; Agent Stream doesn't let Claude read .agent-stream/runs/*/run.json or events.jsonl.";
+/** Why `.agent-stream/runs` and `.agent-stream/sessions` are closed to the agent loop's tools, and the sessions folder to Claude's too (step model spec §6b.5: a chat attachment goes with its message only). */
+export const PRIVATE_FOLDER = 'That folder holds Agent Stream run records and sessions, which are private.';
 
 /** True when `path` is `folder` or inside it (`folder` may be a root such as / or C:\). */
 function within(path: string, folder: string): boolean {
@@ -31,6 +33,7 @@ export function privatePathDenial(projectDir: string, toolName: string, input: u
   if (files.includes(full)) return VALUES_REASON;
   // A searched folder with a glob can override ripgrep's ignore rules, so searches may not aim at the file's folder or above it.
   if ((toolName === 'Grep' || toolName === 'Glob') && files.some((f) => within(full, dirname(f)) || within(f, full))) return VALUES_REASON;
+  if (within(full, norm(join(root, '.agent-stream', 'sessions')))) return PRIVATE_FOLDER;
   const runsDir = norm(join(root, '.agent-stream', 'runs'));
   // A searched directory can override ripgrep's ignore rules, so Grep may not aim at the runs tree (output.md files are fine).
   if (toolName === 'Grep' && (full === runsDir || full.startsWith(runsDir + sep)) && basename(full) !== 'output.md') return RUN_REASON;
```

Change `engine/src/providers/claude/planTurn.ts`:

```diff
diff --git a/engine/src/providers/claude/planTurn.ts b/engine/src/providers/claude/planTurn.ts
--- a/engine/src/providers/claude/planTurn.ts
+++ b/engine/src/providers/claude/planTurn.ts
@@ -3,7 +3,7 @@ import { couldNotAsk } from '../toolGate';
 import type { PlannerTurn, PlannerTurnResult } from '../types';
 import { authSourceError, isSubscriptionAuthSource, sanitizedEnv, UNVERIFIED_AUTH } from './auth';
 import { sdkModelOptions, type ClaudeRunDeps } from './runStep';
-import { blocksOf, graphServer } from './sdk';
+import { blocksOf, graphServer, userMessage, type UserBlock } from './sdk';
 
 const GRAPH_PREFIX = 'mcp__graph__';
 
@@ -50,11 +50,18 @@ export function claudePlanTurn(deps: ClaudeRunDeps) {
       ...sdkModelOptions(deps, turn),
     };
     if (turn.resume) options.resume = turn.resume;
+    // A chat message's images and PDFs go with it, as images and documents (step model spec §6b.5).
+    const fileBlocks = (turn.files ?? []).map((f): UserBlock =>
+      f.kind === 'image'
+        ? { type: 'image', source: { type: 'base64', media_type: f.mediaType as 'image/png', data: f.data } }
+        : { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: f.data } },
+    );
+    const prompt = fileBlocks.length ? userMessage([{ type: 'text', text: turn.prompt }, ...fileBlocks]) : turn.prompt;
     let sessionId: string | undefined;
     let sawInit = false;
     let error: string | undefined;
     try {
-      for await (const message of deps.queryFn({ prompt: turn.prompt, options })) {
+      for await (const message of deps.queryFn({ prompt, options })) {
         const m = message as unknown as { type: string; subtype?: string; apiKeySource?: string; session_id?: string; parent_tool_use_id?: string | null; message?: unknown };
         if (m.session_id) sessionId = m.session_id;
         if (m.type === 'system' && m.subtype === 'init') {
```

Change `engine/src/providers/codex/planTurn.ts`:

```diff
diff --git a/engine/src/providers/codex/planTurn.ts b/engine/src/providers/codex/planTurn.ts
--- a/engine/src/providers/codex/planTurn.ts
+++ b/engine/src/providers/codex/planTurn.ts
@@ -1,4 +1,5 @@
 import { toLoopTools } from '../../agentLoop/graphLoopTools';
+import { notIncluded } from '../../chatAttachments';
 import type { PlannerTurn, PlannerTurnResult } from '../types';
 import { createServerRequestHandler } from './approvals';
 import { CodexRpcError, errorMessage, openCodexForThreads, type CodexConnection } from './connection';
@@ -65,10 +66,15 @@ export function codexPlanTurn(deps: CodexRunDeps) {
         const start: ThreadStartParams = { ...settings, ephemeral: false, dynamicTools: dynamicToolSpecs(tools) };
         threadId = (await conn.request<ThreadResponse>('thread/start', start, turn.signal)).thread.id;
       }
+      // A chat message's images go with turn/start; Codex reads no PDFs here (step model spec §6b.5).
+      const files = turn.files ?? [];
+      for (const f of files) if (f.kind === 'pdf') turn.onEvent({ type: 'note', text: notIncluded(f.name, "OpenAI Codex can't read PDFs in the chat") });
+      const images = files.filter((f) => f.kind === 'image').map((f) => f.path);
       const outcome = await runCodexTurn({
         conn,
         threadId,
         text: turn.prompt,
+        ...(images.length > 0 && { images }),
         effort: codexEffort(turn, deps.knownModels(), deps.warnOnce),
         signal: turn.signal,
         onItem: (phase, item) => {
```

Change `engine/src/providers/types.ts`:

```diff
diff --git a/engine/src/providers/types.ts b/engine/src/providers/types.ts
--- a/engine/src/providers/types.ts
+++ b/engine/src/providers/types.ts
@@ -7,7 +7,10 @@ import type { ToolGate } from './toolGate';
 export type ToolReply = { text: string; isError?: boolean };
 /** A graph-editing tool the planner may call, defined once for every provider. */
 export type GraphTool = { name: string; description: string; schema: ZodRawShape; run(input: unknown): Promise<ToolReply> };
-export type PlannerEvent = { type: 'text'; text: string } | { type: 'tool'; name: string; input: unknown };
+/** `note`: something the user should know about the turn (a chat attachment the provider couldn't take), shown as a note. */
+export type PlannerEvent = { type: 'text'; text: string } | { type: 'tool'; name: string; input: unknown } | { type: 'note'; text: string };
+/** A chat message's image or PDF (step model spec §6b.5): the file, its media type and its bytes as base64. Text files are inlined in the prompt. */
+export type TurnFile = { name: string; kind: 'image' | 'pdf'; path: string; mediaType: string; data: string };
 /** A planner conversation's messages, offered to providers that have no server-side session (spec §6). Claude ignores it. */
 export interface TranscriptStore {
   load(id: string): ChatMessage[] | undefined;
@@ -24,6 +27,8 @@ export type PlannerTurn = {
   /** The model and effort for this turn; absent: the provider's own default. */
   model?: string;
   effort?: EffortLevel;
+  /** Images and PDFs attached to this message only. */
+  files?: TurnFile[];
   gate: ToolGate;
   /** This conversation's stored messages, per session, graph and provider. */
   transcript: TranscriptStore;
```

Change `extension/src/providers/copilot.ts`:

```diff
diff --git a/extension/src/providers/copilot.ts b/extension/src/providers/copilot.ts
--- a/extension/src/providers/copilot.ts
+++ b/extension/src/providers/copilot.ts
@@ -17,6 +17,7 @@ import {
   type ImageData,
   type NodeOutcome,
   type RunShell,
+  type TurnFile,
 } from '@agent-stream/engine';
 import { isWriteCapable, type ModelChoice, type NodeUsage, type ProviderStatus } from '@agent-stream/shared';
 import { COPILOT_PERMISSION, ExtensionBlockedModelError, vscodeChatModel } from './copilotModel';
@@ -82,6 +83,9 @@ const userWithImages = (text: string, images: readonly ImageData[]): ChatMessage
   content: [{ type: 'text', text }, ...images.map((i) => ({ type: 'image' as const, mediaType: i.mediaType, data: i.data }))],
 });
 const reason = (e: unknown) => (e instanceof Error ? e.message : String(e));
+/** A conversation as it is saved: each image a short text line instead of its bytes. */
+const withoutImages = (messages: ChatMessage[]): ChatMessage[] =>
+  messages.map((m) => (m.role === 'user' && m.content.some((c) => c.type === 'image') ? { ...m, content: m.content.map((c) => (c.type === 'image' ? { type: 'text' as const, text: '[An image was attached here.]' } : c)) } : m));
 
 /**
  * GitHub Copilot through VS Code's Language Model API (spec §5). Steps and planner turns run the engine's agent loop
@@ -233,12 +237,20 @@ export function createCopilotProvider(d: CopilotDeps): AgentProvider {
       }
       const picked = await pick(turn.model);
       if ('error' in picked) return { ok: false, error: picked.error };
+      // A chat message's images go to a model that takes them; PDFs can't be sent here (step model spec §6b.5).
+      const files: readonly TurnFile[] = turn.files ?? [];
+      const images = takesImages(picked.model) ? files.filter((f) => f.kind === 'image') : [];
+      for (const f of files) {
+        if (f.kind === 'pdf') turn.onEvent({ type: 'note', text: `${f.name} couldn't be included: GitHub Copilot can't read PDFs in the chat.` });
+        else if (!images.includes(f)) turn.onEvent({ type: 'note', text: `${f.name} couldn't be included: ${picked.model.name} doesn't take images.` });
+      }
+      const message = images.length ? userWithImages(turn.prompt, images.map((f) => ({ name: f.name, mediaType: f.mediaType, data: f.data }))) : userText(turn.prompt);
       const cap = d.limits().maxRequestsPerTurn;
       const graphToolNames = new Set(turn.tools.map((t) => t.name));
       const r = await runAgentLoop({
         model: chatModel(picked.model),
         system: turn.systemAppend,
-        messages: [...history, userText(turn.prompt)],
+        messages: [...history, message],
         tools: [...builtinTools({ cwd: turn.cwd, runShell: d.runShell, readOnly: true }), ...toLoopTools(turn.tools, '')],
         gate: turn.gate,
         maxRequests: cap,
@@ -254,7 +266,8 @@ export function createCopilotProvider(d: CopilotDeps): AgentProvider {
       // saved as returned, compacted when it compacted. A failed save is logged, never the turn's failure: the turn ran.
       const id = turn.resume ?? randomUUID();
       try {
-        turn.transcript.save(id, r.messages);
+        // Images are kept out of the saved conversation: the files stay in the session, the messages name them.
+        turn.transcript.save(id, withoutImages(r.messages));
       } catch (e) {
         console.error(`Agent Stream: couldn't save the Copilot conversation ${id}: ${reason(e)}`);
       }
```

Change `shared/src/schemas.ts`:

```diff
diff --git a/shared/src/schemas.ts b/shared/src/schemas.ts
--- a/shared/src/schemas.ts
+++ b/shared/src/schemas.ts
@@ -156,7 +156,7 @@ const clientMessageSchema = z.discriminatedUnion('type', [
   z.object({ type: z.literal('getGraphMarkdown'), graphId: z.string() }),
   z.object({ type: z.literal('saveGraphMarkdown'), graphId: z.string(), text: markdownText, base: markdownText, force: z.boolean().optional() }),
   z.object({ type: z.literal('openChat'), graphId: z.string(), sessionId: z.string() }),
-  z.object({ type: z.literal('chat'), graphId: z.string(), sessionId: z.string(), text: z.string().min(1) }),
+  z.object({ type: z.literal('chat'), graphId: z.string(), sessionId: z.string(), text: z.string().min(1), attachments: z.array(upload).min(1).max(MAX_ATTACHMENTS).optional() }),
   z.object({ type: z.literal('refineSteps'), graphId: z.string(), sessionId: z.string(), nodeIds: refineNodeIds }),
   z.object({ type: z.literal('splitStep'), graphId: z.string(), sessionId: z.string(), nodeId: z.string() }),
   z.object({ type: z.literal('newChat'), graphId: z.string(), sessionId: z.string() }),
```

Change `shared/src/types.ts`:

```diff
diff --git a/shared/src/types.ts b/shared/src/types.ts
--- a/shared/src/types.ts
+++ b/shared/src/types.ts
@@ -302,7 +302,8 @@ export type ApprovalRequest = {
 export type GraphChangeRequest = { summary: string; detail: string };
 
 export type ChatRole = 'user' | 'assistant' | 'tool' | 'error' | 'note';
-export type ChatEntry = { at: string; role: ChatRole; text: string };
+/** `attachments`: the names of the files a user message carried, shown as chips (step model spec §6b.5). */
+export type ChatEntry = { at: string; role: ChatRole; text: string; attachments?: string[] };
 
 export type ProviderId = 'claude' | 'copilot' | 'codex';
 export const PROVIDER_IDS: readonly ProviderId[] = ['claude', 'copilot', 'codex'];
@@ -425,7 +426,8 @@ export type ClientMessage =
   | { type: 'saveGraphMarkdown'; graphId: string; text: string; base: string; force?: boolean }
   /** Subscribes this client to one planner conversation; the engine answers with chatOpened. */
   | { type: 'openChat'; graphId: string; sessionId: string }
-  | { type: 'chat'; graphId: string; sessionId: string; text: string }
+  /** `attachments`: files sent to the planner with this message only (spec §6b.1), kept in the session, never committed. */
+  | { type: 'chat'; graphId: string; sessionId: string; text: string; attachments?: AttachmentUpload[] }
   | { type: 'refineSteps'; graphId: string; sessionId: string; nodeIds: string[] }
   | { type: 'splitStep'; graphId: string; sessionId: string; nodeId: string }
   /** Clears the conversation: its chat and the provider session. */
```

- [ ] **Step 4: Run the tests and typecheck**

Run: `npm test -w engine -- test/chatAttachments.test.ts test/codexPlanTurn.test.ts test/codexReadOnly.test.ts test/loopTools.test.ts test/planner.test.ts && npm test -w extension -- test/copilot.test.ts`
Expected: PASS.
Run: `npm run typecheck && npm test`
Expected: all workspaces pass (a test that times out only under heavy machine load is not a failure of this task: run it again).

- [ ] **Step 5: Commit**

```bash
git add engine/src/agentLoop/tools.ts engine/src/app.ts engine/src/chatAttachments.ts engine/src/index.ts engine/src/planner.ts engine/src/plannerTools.ts engine/src/privatePaths.ts engine/src/providers/claude/planTurn.ts engine/src/providers/codex/planTurn.ts engine/src/providers/types.ts engine/test/chatAttachments.test.ts engine/test/codexPlanTurn.test.ts extension/src/providers/copilot.ts extension/test/copilot.test.ts shared/src/schemas.ts shared/src/types.ts
git commit -m "feat: attach files to a planner chat message" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 19: Attachments in the graph tab and the chat

**Spec covered:** §6b.4 (Add…, drag-and-drop, paste, Open, Remove, limits checked in the tab, the one-time notice), §6b.1 chat (📎, drop, paste, chips), §7 UI tests.

**Files:**
- Create: `web/src/components/AttachmentList.tsx`, `web/src/uploads.ts`
- Modify: `web/src/components/ChatPanel.tsx`, `web/src/components/GraphPanel.tsx`, `web/src/components/NodePanel.tsx`, `web/src/styles.css`
- Test: `web/test/attachments.test.ts` (new)

**Interfaces:**
- Consumes: Tasks 15, 18.
- Produces: `web/src/uploads.ts` (`readUploads(files, room)`, `filesOf(dataTransfer)`); `AttachmentList` component (Node panel for agent steps, Graph panel); the chat box's 📎, drop, paste and pending chips; message chips.

- [ ] **Step 1: Write the failing tests**

Create `web/test/attachments.test.ts`:

```ts
// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyGraph, type Graph } from '@agent-stream/shared';

vi.mock('../src/bridge', () => ({ send: vi.fn(), sendHost: vi.fn(), post: vi.fn() }));
const { post, send } = await import('../src/bridge');
const { dispatch, getState } = await import('../src/store');
const { NodePanel } = await import('../src/components/NodePanel');
const { GraphPanel } = await import('../src/components/GraphPanel');
const { ChatPanel } = await import('../src/components/ChatPanel');
const { readUploads } = await import('../src/uploads');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// jsdom lays nothing out: the chat's scroll to its last line does nothing here.
Element.prototype.scrollIntoView = () => {};

const agent = { id: 'n1', title: 'Design', kind: 'agent' as const, prompt: 'p', attachments: ['mockup.png'], createdBy: 'user' as const, updatedBy: 'user' as const, updatedAt: 't' };
const graph: Graph = { ...emptyGraph('g', 'G', 't'), attachments: ['brief.pdf'], nodes: [agent, { ...agent, id: 'n2', kind: 'command', prompt: undefined, command: 'ls', attachments: undefined }] };
let el: HTMLDivElement | undefined;
let root: Root | undefined;
async function mount(c: () => React.ReactElement | null): Promise<HTMLDivElement> {
  const div = document.createElement('div');
  document.body.appendChild(div);
  const r = createRoot(div);
  el = div;
  root = r;
  await act(async () => r.render(createElement(c)));
  return div;
}
const button = (label: string) => [...el!.querySelectorAll('button')].find((b) => b.textContent === label || b.getAttribute('aria-label') === label) as HTMLButtonElement | undefined;
/** A drop of files, as a browser sends it. */
function drop(target: Element, files: File[]) {
  const e = new Event('drop', { bubbles: true, cancelable: true }) as Event & { dataTransfer: unknown };
  e.dataTransfer = { files, types: ['Files'] };
  target.dispatchEvent(e);
}
const flush = () => act(async () => new Promise((r) => setTimeout(r, 0)));

beforeEach(() => {
  vi.mocked(send).mockClear();
  vi.mocked(post).mockClear();
  dispatch({ kind: 'server', msg: { type: 'hello', status: { provider: 'claude', ok: true, label: 'Claude Max' }, project: '/p', graphs: [], approvals: [] } });
  dispatch({ kind: 'server', msg: { type: 'graphOpened', changes: [], graph, runs: [], variableValues: {} } });
  dispatch({ kind: 'dismissToast' });
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  el?.remove();
  root = undefined;
  el = undefined;
});

describe('files checked in the tab before sending (step model spec §6b.4)', () => {
  it('reads files as base64, and refuses a type, a size or one too many', async () => {
    expect(await readUploads([new File(['hi'], 'notes.md')], 20)).toEqual({ ok: true, uploads: [{ name: 'notes.md', data: btoa('hi') }] });
    expect(await readUploads([new File(['MZ'], 'tool.exe')], 20)).toEqual({ ok: false, error: expect.stringContaining("tool.exe can't be attached.") });
    const big = new File(['x'], 'big.pdf');
    Object.defineProperty(big, 'size', { value: 5 * 1024 * 1024 + 1 });
    expect(await readUploads([big], 20)).toEqual({ ok: false, error: 'big.pdf is larger than 5 MB.' });
    expect(await readUploads([new File(['a'], 'a.md'), new File(['b'], 'b.md')], 1)).toEqual({ ok: false, error: 'Only 1 more can be attached here (at most 20).' });
  });
});

describe('a step’s attachments in the Node panel', () => {
  it('lists them with Open and Remove, and Add… asks the extension for VS Code’s file picker', async () => {
    dispatch({ kind: 'selectNode', id: 'n1' });
    const el = await mount(NodePanel);
    expect(el.querySelector('.attachment-list')?.textContent).toContain('mockup.png');
    await act(async () => button('Open')!.click());
    expect(post).toHaveBeenCalledWith({ type: 'openAttachment', name: 'mockup.png' });
    await act(async () => button('Remove mockup.png')!.click());
    expect(send).toHaveBeenCalledWith({ type: 'detach', graphId: 'g', target: { kind: 'step', nodeId: 'n1' }, name: 'mockup.png' });
    await act(async () => button('Add…')!.click());
    expect(post).toHaveBeenCalledWith({ type: 'pickAttachments', target: { kind: 'step', nodeId: 'n1' } });
  });

  it('attaches dropped files, and refuses one it can’t take with a toast, sending nothing', async () => {
    dispatch({ kind: 'selectNode', id: 'n1' });
    const el = await mount(NodePanel);
    const list = el.querySelector('.attachments')!;
    await act(async () => drop(list, [new File(['png'], 'shot.png')]));
    await flush();
    expect(send).toHaveBeenCalledWith({ type: 'attach', graphId: 'g', target: { kind: 'step', nodeId: 'n1' }, files: [{ name: 'shot.png', data: btoa('png') }] });
    vi.mocked(send).mockClear();
    await act(async () => drop(list, [new File(['MZ'], 'tool.exe')]));
    await flush();
    expect(send).not.toHaveBeenCalled();
    expect(getState().toast).toContain("tool.exe can't be attached.");
  });

  it('has none for a command step', async () => {
    dispatch({ kind: 'selectNode', id: 'n2' });
    const el = await mount(NodePanel);
    expect(el.querySelector('.attachments')).toBeNull();
  });

  it('shows the one-time notice the engine sends with the first attachment', () => {
    dispatch({ kind: 'server', msg: { type: 'attached', graphId: 'g', target: { kind: 'graph' }, names: ['a.png'], notice: "Attachments are saved with the graph (and committed) and sent to your AI provider. Don't attach secrets." } });
    expect(getState().toast).toBe("Attachments are saved with the graph (and committed) and sent to your AI provider. Don't attach secrets.");
  });
});

describe('the graph’s attachments in the Graph panel', () => {
  it('lists them and removes one from the graph', async () => {
    const el = await mount(GraphPanel);
    expect(el.querySelector('.attachment-list')?.textContent).toContain('brief.pdf');
    await act(async () => button('Remove brief.pdf')!.click());
    expect(send).toHaveBeenCalledWith({ type: 'detach', graphId: 'g', target: { kind: 'graph' }, name: 'brief.pdf' });
  });
});

describe('chat attachments', () => {
  beforeEach(() => {
    dispatch({ kind: 'server', msg: { type: 'chatTarget', target: { graphId: 'g', graphName: 'G', sessionId: 'default', sessionName: 'Default' } } });
  });

  it('sends picked files with the next message only, and the chat shows them on it', async () => {
    const el = await mount(ChatPanel);
    const input = el.querySelector('input[type=file]') as HTMLInputElement;
    Object.defineProperty(input, 'files', { value: [new File(['png'], 'shot.png')], configurable: true });
    await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
    await flush();
    expect(el.querySelector('.chat-pending')?.textContent).toContain('shot.png');
    const box = el.querySelector('textarea') as HTMLTextAreaElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(box, 'What is this?');
      box.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => button('Send')!.click());
    expect(send).toHaveBeenCalledWith({ type: 'chat', graphId: 'g', sessionId: 'default', text: 'What is this?', attachments: [{ name: 'shot.png', data: btoa('png') }] });
    expect(el.querySelector('.chat-pending')).toBeNull();
    await act(async () => dispatch({ kind: 'server', msg: { type: 'chatEntry', graphId: 'g', sessionId: 'default', entry: { at: 't', role: 'user', text: 'What is this?', attachments: ['shot.png'] } } }));
    expect(el.querySelector('.msg.user .attachment-chip')?.textContent).toBe('📎 shot.png');
  });

  it('refuses a file it can’t take before sending, and a pending file can be removed', async () => {
    const el = await mount(ChatPanel);
    const inputArea = el.querySelector('.chat-input')!;
    await act(async () => drop(inputArea, [new File(['MZ'], 'tool.exe')]));
    await flush();
    expect(el.querySelector('.chat-pending .field-error')?.textContent).toContain("tool.exe can't be attached.");
    await act(async () => drop(inputArea, [new File(['a'], 'a.md')]));
    await flush();
    await act(async () => button('Remove a.md')!.click());
    expect(el.querySelector('.chat-pending')).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests and see them fail**

Run: `npm test -w web -- test/attachments.test.ts test/NodePanel.test.ts test/GraphPanel.test.ts test/ChatPanel.test.ts`
Expected: FAIL — the new modules, exports or behaviour do not exist yet (import errors or assertion failures).

- [ ] **Step 3: Implement**

Create `web/src/components/AttachmentList.tsx`:

```tsx
import { MAX_ATTACHMENTS, type AttachTarget } from '@agent-stream/shared';
import { useState } from 'react';
import { post, send } from '../bridge';
import { dispatch } from '../store';
import { filesOf, readUploads } from '../uploads';

/**
 * A step's or the graph's attachments (step model spec §6b.4): each name with Open and Remove, Add… (VS Code's file
 * picker), and files dropped or pasted onto the list. Every change is a graph edit, saved at once.
 */
export function AttachmentList({ graphId, target, names, hint }: { graphId: string; target: AttachTarget; names: string[]; hint: string }) {
  const [over, setOver] = useState(false);
  const attach = async (files: File[]) => {
    if (!files.length) return;
    const r = await readUploads(files, MAX_ATTACHMENTS - names.length);
    if (!r.ok) return dispatch({ kind: 'showToast', message: r.error });
    send({ type: 'attach', graphId, target, files: r.uploads });
  };
  return (
    <div
      className={`field attachments${over ? ' drop-over' : ''}`}
      onDragOver={(e) => {
        if (![...e.dataTransfer.types].includes('Files')) return;
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        void attach(filesOf(e.dataTransfer));
      }}
      onPaste={(e) => {
        const files = filesOf(e.clipboardData);
        if (!files.length) return;
        e.preventDefault();
        void attach(files);
      }}
      tabIndex={-1}
    >
      <label>Attachments</label>
      {names.length > 0 && (
        <ul className="attachment-list">
          {names.map((name) => (
            <li key={name}>
              <span className="attachment-name" title={name}>
                📎 {name}
              </span>
              <button className="link" onClick={() => post({ type: 'openAttachment', name })}>
                Open
              </button>
              <button className="link" aria-label={`Remove ${name}`} onClick={() => send({ type: 'detach', graphId, target, name })}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="field-row">
        <button disabled={names.length >= MAX_ATTACHMENTS} onClick={() => post({ type: 'pickAttachments', target })}>
          Add…
        </button>
        <span className="muted">{hint}</span>
      </div>
    </div>
  );
}
```

Create `web/src/uploads.ts`:

```ts
import { attachmentFileProblem, MAX_ATTACHMENTS, safeAttachmentName, type AttachmentUpload } from '@agent-stream/shared';

/** Bytes as base64, in chunks so a large image doesn't overflow the call stack. */
function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/**
 * Files dropped, pasted or picked in the tab, checked before anything is sent (step model spec §6b.4): the type, the size,
 * and how many the list can still take (`room`). Then read as base64 for the engine.
 */
export async function readUploads(files: readonly File[], room: number): Promise<{ ok: true; uploads: AttachmentUpload[] } | { ok: false; error: string }> {
  if (files.length > room) return { ok: false, error: room <= 0 ? `This list already has ${MAX_ATTACHMENTS} attachments, the most it can have.` : `Only ${room} more can be attached here (at most ${MAX_ATTACHMENTS}).` };
  for (const f of files) {
    const problem = attachmentFileProblem(safeAttachmentName(f.name), f.size);
    if (problem) return { ok: false, error: problem };
  }
  const uploads = await Promise.all(files.map(async (f) => ({ name: f.name, data: base64(new Uint8Array(await f.arrayBuffer())) })));
  return { ok: true, uploads };
}

/** The files a drop or a paste carries (a paste of text carries none). */
export const filesOf = (data: DataTransfer | null): File[] => (data ? [...data.files] : []);
```

Change `web/src/components/ChatPanel.tsx`:

```diff
diff --git a/web/src/components/ChatPanel.tsx b/web/src/components/ChatPanel.tsx
--- a/web/src/components/ChatPanel.tsx
+++ b/web/src/components/ChatPanel.tsx
@@ -1,7 +1,9 @@
 import { useEffect, useRef, useState } from 'react';
+import { MAX_ATTACHMENTS, type AttachmentUpload } from '@agent-stream/shared';
 import { send } from '../bridge';
 import { Markdown } from '../markdown';
 import { useStore } from '../store';
+import { filesOf, readUploads } from '../uploads';
 
 export function ChatPanel() {
   const chat = useStore((s) => s.chat);
@@ -9,6 +11,16 @@ export function ChatPanel() {
   const target = useStore((s) => s.chatTarget);
   const status = useStore((s) => s.status);
   const [text, setText] = useState('');
+  /** Files for the next message only (step model spec §6b.1), checked when added; `problem`: why some couldn't be. */
+  const [pending, setPending] = useState<AttachmentUpload[]>([]);
+  const [problem, setProblem] = useState<string | undefined>();
+  const picker = useRef<HTMLInputElement>(null);
+  const addFiles = async (files: File[]) => {
+    if (!files.length) return;
+    const r = await readUploads(files, MAX_ATTACHMENTS - pending.length);
+    setProblem(r.ok ? undefined : r.error);
+    if (r.ok) setPending((p) => [...p, ...r.uploads]);
+  };
   const end = useRef<HTMLDivElement>(null);
   const box = useRef<HTMLTextAreaElement>(null);
   const stopButton = useRef<HTMLButtonElement>(null);
@@ -57,8 +69,10 @@ export function ChatPanel() {
     const t = text.trim();
     if (!t || !target || !canType || busy) return;
     sentHere.current = true;
-    send({ type: 'chat', graphId: target.graphId, sessionId: target.sessionId, text: t });
+    send({ type: 'chat', graphId: target.graphId, sessionId: target.sessionId, text: t, ...(pending.length > 0 && { attachments: pending }) });
     setText('');
+    setPending([]);
+    setProblem(undefined);
   };
   const stop = () => {
     if (target && busy) send({ type: 'stopPlanner', graphId: target.graphId, sessionId: target.sessionId });
@@ -82,12 +96,63 @@ export function ChatPanel() {
         {chat.map((e, i) => (
           <div key={i} className={`msg ${e.role}`}>
             {e.role === 'tool' ? <code>{e.text}</code> : e.role === 'assistant' ? <Markdown text={e.text} /> : e.text}
+            {e.attachments?.length ? (
+              <div className="attachment-chips">
+                {e.attachments.map((name) => (
+                  <span key={name} className="attachment-chip">
+                    📎 {name}
+                  </span>
+                ))}
+              </div>
+            ) : null}
           </div>
         ))}
         {busy && <div className="msg busy">Planner is working…</div>}
         <div ref={end} />
       </div>
-      <div className="chat-input">
+      {(pending.length > 0 || problem) && (
+        <div className="attachment-chips chat-pending">
+          {pending.map((f, i) => (
+            <span key={`${f.name}-${i}`} className="attachment-chip">
+              📎 {f.name}{' '}
+              <button className="link" aria-label={`Remove ${f.name}`} onClick={() => setPending((p) => p.filter((_, j) => j !== i))}>
+                ×
+              </button>
+            </span>
+          ))}
+          {problem && <span className="field-error">{problem}</span>}
+        </div>
+      )}
+      <div
+        className="chat-input"
+        onDragOver={(e) => {
+          if ([...e.dataTransfer.types].includes('Files')) e.preventDefault();
+        }}
+        onDrop={(e) => {
+          e.preventDefault();
+          void addFiles(filesOf(e.dataTransfer));
+        }}
+        onPaste={(e) => {
+          const files = filesOf(e.clipboardData);
+          if (!files.length) return;
+          e.preventDefault();
+          void addFiles(files);
+        }}
+      >
+        <input
+          ref={picker}
+          type="file"
+          multiple
+          hidden
+          aria-label="Attach files"
+          onChange={(e) => {
+            void addFiles([...(e.target.files ?? [])]);
+            e.target.value = '';
+          }}
+        />
+        <button aria-label="Attach files" title="Attach files to this message" disabled={!canType} onClick={() => picker.current?.click()}>
+          📎
+        </button>
         <textarea
           ref={box}
           value={text}
```

Change `web/src/components/GraphPanel.tsx`:

```diff
diff --git a/web/src/components/GraphPanel.tsx b/web/src/components/GraphPanel.tsx
--- a/web/src/components/GraphPanel.tsx
+++ b/web/src/components/GraphPanel.tsx
@@ -2,6 +2,7 @@ import { useEffect, useState } from 'react';
 import type { Graph, Op } from '@agent-stream/shared';
 import { sendEdit } from '../actions';
 import { useStore } from '../store';
+import { AttachmentList } from './AttachmentList';
 
 type Draft = { goal: string; instructions: string };
 const draftOf = (g: Graph): Draft => ({ goal: g.goal, instructions: g.instructions });
@@ -67,6 +68,7 @@ function GraphEditor({ graph }: { graph: Graph }) {
         />
       </div>
       <p className="muted">Every agent step and the planner receive the goal and these instructions. Both can use variables, e.g. {'{{ target_schema }}'}.</p>
+      <AttachmentList graphId={graph.id} target={{ kind: 'graph' }} names={graph.attachments ?? []} hint="Drop or paste files here. Every agent step gets them, after its own." />
       <div className="actions">
         <button className="primary" disabled={!dirty} onClick={save}>
           Save
```

Change `web/src/components/NodePanel.tsx`:

```diff
diff --git a/web/src/components/NodePanel.tsx b/web/src/components/NodePanel.tsx
--- a/web/src/components/NodePanel.tsx
+++ b/web/src/components/NodePanel.tsx
@@ -1,6 +1,7 @@
 import { useEffect, useRef, useState } from 'react';
 import { parseStepModel, refinable, stepModelText, type EffortLevel, type GraphNode, type ModelChoice, type NodeKind, type NodePatch } from '@agent-stream/shared';
 import { actions, registerNodeDraft } from '../actions';
+import { AttachmentList } from './AttachmentList';
 import { changedSentence, changeKey } from '../changeLabels';
 import { send } from '../bridge';
 import { reportDraft } from '../draftState';
@@ -210,6 +211,9 @@ function NodeEditor({ graphId, node, workspaces }: { graphId: string; node: Grap
         </datalist>
       </div>
       {draft.kind === 'agent' && <StepModelFields model={draft.model} effort={draft.effort} onChange={(next) => setDraft({ ...draft, ...next })} />}
+      {node.kind === 'agent' && (
+        <AttachmentList graphId={graphId} target={{ kind: 'step', nodeId: node.id }} names={node.attachments ?? []} hint="Drop or paste files here. This step's agent gets them every time it runs." />
+      )}
       {draft.kind === 'agent' ? (
         <div className="field">
           <label>Prompt</label>
```

Change `web/src/styles.css`:

```diff
diff --git a/web/src/styles.css b/web/src/styles.css
--- a/web/src/styles.css
+++ b/web/src/styles.css
@@ -150,6 +150,12 @@ pre { background: var(--code-bg); padding: 8px; border-radius: 6px; white-space:
 .field label { font-size: 12px; color: var(--muted); }
 .field-row { display: flex; gap: 6px; align-items: center; }
 .field-row select { flex: 1; min-width: 0; }
+.attachment-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
+.attachment-list li { display: flex; gap: 8px; align-items: center; }
+.attachment-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
+.attachments.drop-over { outline: 1px dashed var(--accent); outline-offset: 2px; }
+.attachment-chips { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px; }
+.attachment-chip { font-size: 12px; padding: 0 6px; border: 1px solid var(--border); border-radius: 8px; }
 .notice { font-size: 12px; color: var(--warn); }
 .actions { display: flex; gap: 8px; flex-wrap: wrap; }
 
```

- [ ] **Step 4: Run the tests and typecheck**

Run: `npm test -w web -- test/attachments.test.ts test/NodePanel.test.ts test/GraphPanel.test.ts test/ChatPanel.test.ts`
Expected: PASS.
Run: `npm run typecheck && npm test`
Expected: all workspaces pass (a test that times out only under heavy machine load is not a failure of this task: run it again).

- [ ] **Step 5: Commit**

```bash
git add web/src/components/AttachmentList.tsx web/src/components/ChatPanel.tsx web/src/components/GraphPanel.tsx web/src/components/NodePanel.tsx web/src/styles.css web/src/uploads.ts web/test/attachments.test.ts
git commit -m "feat(web): attachment lists and chat attachments" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 20: Phase 2 docs and full verification

**Spec covered:** the README wording for §6b; the full check of phase 2. (`docs/graph-format.md` was updated in Task 14.)

**Files:**
- Modify: `README.md`, `extension/README.md`

**Interfaces:**
- Consumes: Tasks 12–19.
- Produces: nothing new.

- [ ] **Step 1: Add the Attachments paragraph to both READMEs**

In `README.md` and in `extension/README.md`, insert this bullet right after the **Save and undo** bullet that Task 11 added (the same text in both files):

```markdown
- **Attachments:** give agents files and photos as context: a mockup, a spec, sample data. In the Node panel (an agent step's own files) or the Graph panel (files every agent step gets, after its own), press **Add…**, drag files in, or paste them; **Open** shows one in VS Code and **Remove** takes it off the list. Agent Stream copies each file into `.agent-stream/attachments/<graph id>/`, which Git does not ignore, so attachments are committed with the graph; the Markdown file names them (`- attach: mockup.png`, `## Attachments`). Images (png, jpg, gif, webp, up to 10 MB), PDFs and text files (up to 5 MB) are allowed, at most 20 per step, per graph and per chat message. A step's prompt lists its files; Claude and Codex get images as images, and Copilot does when the model takes them. In the chat, 📎 (or a drop or paste) sends files with that one message: images as images, text files inlined, PDFs on Claude. Chat attachments stay in the session folder and are never committed. Attachments are sent to your AI provider: don't attach secrets. A run whose file is missing (not pulled yet) warns and runs without it; the Run Report lists each step's files with their SHA-256.
```

- [ ] **Step 2: Check the two READMEs still match where they should**

Run: `diff README.md extension/README.md`
Expected: only the differences that were there before this plan (the install paragraph, the Development section).

- [ ] **Step 3: Full verification**

Run: `npm run typecheck && npm test && npm run build`
Expected: typecheck clean, every workspace's tests pass, the web and extension bundles build. A test that times out only under heavy machine load is not a failure: run it again on its own.

Then check the spec once more against the plan's coverage (§7's list): every item has a test in Tasks 1–19; report any that doesn't instead of adding untested code.

- [ ] **Step 4: Commit**

```bash
git add README.md extension/README.md
git commit -m "docs: attachments" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Dry run

Every task's code above (Tasks 1–19) was produced by applying it, task by task, to a clone of this branch in a scratch folder outside the checkout, and running the named tests, `npm run typecheck` and `npm test` after each task; `npm run build` was run after Task 11. The diffs in this plan are `git diff` output from those commits. Task 20 (README text only) was not dry-run. The four new Phase 1 test files that Task 13's run made sturdier under machine load (`stepModelRun`, `undo`, `graphTabModels`, `stepModelPlanner`) are given in their final form in their own tasks.

## Spec coverage

| Spec | Tasks |
|---|---|
| §2.1 data | 1 |
| §2.2 Markdown, docs | 2 |
| §2.3 old graphs and exports | 1 (optional fields, `parseGraph`), 2 (round trip) |
| §3.1–3.2 resolution, snapshot, re-runs | 3, 4 |
| §3.3 dialog, step log, Run Report | 4, 5 |
| §4.1 Node panel | 7 |
| §4.2 chip | 8 |
| §5 planner | 6 |
| §6 Copilot effort | 1 (check), 4 (never sent), 7 (Not supported) |
| §6a.1 ⌘S, File › Save | 10 |
| §6a.2 ⌘Z, Edit › Undo, stacks | 9, 10 |
| §6b feasibility, rules | 12 |
| §6b.3 data, Markdown | 13, 14 |
| §6b.2, §6b.4 storage, Add/Open/Remove, undo | 15, 19 |
| §6b.5 runs, providers | 16, 17 |
| §6b.1, §6b.5 chat | 18, 19 |
| READMEs | 11, 20 |
