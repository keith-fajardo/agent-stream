# Agent Stream — model and effort per step, save/undo shortcuts, and attachments (design)

Date: 2026-10-05. Status: approved in conversation, awaiting review of this written spec.

## 1. Purpose and decisions

Today every agent step of a run uses the run's model and effort. Those come from `agentStream.model` and `agentStream.effort`, captured when the run starts. The user wants each step to be able to choose its own, for three reasons:

1. **Cheaper or faster steps:** a small model or low effort for simple steps, a strong one for hard steps.
2. **Comparing models (A/B):** the same step on different models or efforts in one graph.
3. **Reproducible graphs:** pinning the exact model a step was designed for.

Mixing providers inside one run is **not** a goal. A step's model always runs within the run's provider.

**Decision (approach A):** a step stores **one** model, tagged with its provider, plus an effort. Both are optional and mean Default when absent. A step whose model belongs to another provider falls back to the run's default model, with a visible warning. Rejected:

- one model per provider on every step: heavier than the use cases need;
- tiers such as "Fast/Strongest": not reproducible.

## 2. Data

### 2.1 The step

`GraphNode` gains two optional fields, valid on agent steps only:

```ts
model?: StepModel;      // { provider: ProviderId; id: string }
effort?: EffortLevel;   // 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra'
```

- `id` is the provider's own model id, exactly as its model list reports it.
  - Claude: `supportedModels()` `value`, e.g. `opus`, `sonnet`, `fable`, `haiku`, `default`, `claude-opus-5`.
  - Codex: `model/list` `id`, e.g. `gpt-6-astra`.
  - Copilot: the `vscode.lm` model id, or `auto`.
- Ids are 1–200 characters, with no whitespace, `/` allowed.
- A command step with `model` or `effort` is invalid. `applyOp` refuses it with the message `Only agent steps have a model or effort.`
- **Switching a step to `command` drops both fields.** This is part of the canonical form, like the other kind's text.
- `NewNodeInput` and `NodePatch` gain the same fields. In a patch, `model: null` and `effort: null` clear them; the patch schema uses the existing clearing convention.
- `ChangedField` gains `'model'` and `'effort'`, so agent-change review and the "changed" marks cover them.

### 2.2 The Markdown file

Two more lines in a step's field list, written in this order after `timeout`:

```
- model: claude/opus
- effort: high
```

- **`model`** is `<provider>/<id>`. The provider is `claude`, `codex` or `copilot`. The id is everything after the first `/`.
- **`effort`** is one of the levels above.
- **Parse errors** (each with its line and a fix hint):
  - an unknown provider;
  - an empty or whitespace id;
  - an unknown effort;
  - either field on a command step.
- **The parser does not check** whether the model currently exists. That is checked when a run starts (§3), so a graph still opens on a machine with another plan or provider.
- **Writing:** the serializer writes the lines only when set. The round trip and `diffToOps` cover them: a hand edit becomes `updateNode` with `model` and `effort` in the patch.
- **Docs:** `docs/graph-format.md` documents both lines.

### 2.3 Old graphs and exports

There is no migration. Graphs without the fields behave exactly as today. Old `.agent-stream.json` exports import unchanged; their nodes have no model or effort.

## 3. Which model a run uses

### 3.1 When it is decided

Each agent step's model and effort are resolved once, when the run starts, after the run's own provider, model and effort are captured as today. The result is saved in the run snapshot as `RunMeta.stepModels: Record<nodeId, { model?: string; effort?: EffortLevel; note?: string }>`. A re-run (Run from a step, or a re-run of a finished run) uses the snapshot's values. The Run Report reads them.

### 3.2 Rules

For an agent step, with `R` the run's provider, `M` the run's model (or Default) and `E` the run's effort:

1. **No `model` on the step** → the model is `M`.
2. **`model.provider === R`:**
   - If the provider's current model list (the same list the chat's Model menu uses) is **known** and doesn't contain `model.id`, the model is `M`. The note reads `<id> isn't offered by <provider name> any more (or on this plan), so this step uses the default model.`
   - Otherwise the model is `model.id`.
   - **Copilot:** the list is "known" only for the purpose of showing the warning. The step still tries the stored id. If Copilot refuses it at request time (for example a model only VS Code core can use), the existing fallback to Auto applies.
3. **`model.provider !== R`** → the model is `M`. The note reads `This step is set to a <provider name> model (<id>); this run uses <R name>, so it uses the default model.`
4. **Effort** = the step's `effort` ?? `E`. It is then filtered by the existing per-provider rule (Claude's `modelOptions`, Codex's `codexEffort`, Copilot: none): a level the resolved model doesn't offer is dropped, with the existing one-line log note.

Planner chats are unaffected. They keep using the chat header's Model and Effort.

### 3.3 Where it shows

- **Run dialog:** each agent step whose resolved model or effort differs from the run's gets a line `Model: <label> · Effort: <label>` under its prompt. Labels come from the provider list's display names. Each note from §3.2 shows as a warning line on that step.
  - Warnings don't block the run.
  - The dialog's header line (`Model: … · Effort: …`) still shows the run-wide values.
- **Step log:** the `start` event records the model and effort the step actually ran with. Any note is logged as a text line.
- **Run Report:** in each step's section, under its heading, a line `Model: <model or Default> · Effort: <effort or Default>`, plus the note if there is one. The run-level lines are unchanged.

## 4. The UI

### 4.1 The Node panel

For agent steps only, below Access and Workspace:

- **Model:** a dropdown.
  - Its first option is **Default (the run's model)**, followed by the current provider's models (display names).
  - On Claude, aliases come first (`default`, `sonnet`, `opus`, `fable`, `haiku`, in the order the list gives), then a **Pinned versions** group (ids starting `claude-`).
  - On Codex, models are listed in the list's order.
  - On Copilot, **Auto** comes first.
  - **A step whose model belongs to another provider** shows it as a disabled entry, `<Provider> · <id> (not the current provider)`, with a **Use Default** button. Picking from the list replaces it.
  - **A model id that the current provider's known list doesn't contain** shows as `<id> (not offered)`.
- **Effort:** a dropdown with **Default** plus only the levels the chosen model offers. With Model on Default, it offers the levels the provider reports for its default model (the existing `defaultEffortsFor`). It is disabled and reads **Not supported** for a model with no levels, and on Copilot (see §6).
- **Saving:** changes are saved as step edits (`updateNode`). They go into history, agent-change review and the `.md`, and count as "changed" for Refine.

### 4.2 The canvas card

An agent step with its own model or effort shows a chip next to its badges.

- **Text:** the model's short label and the effort, e.g. `opus · high`, `GPT-6-Astra`, `· max`.
- **Warning state:** the chip is struck through, with the note as its tooltip, when the model belongs to another provider or isn't offered.

### 4.3 Not included

There is no bulk "set model for selected steps". Users set each step separately, or ask the planner.

## 5. The planner

- **Graph tools:** `add_node` and `update_node` accept `model` (as `"<provider>/<id>"`) and `effort`, validated like the file.
- **Graph view:** `get_graph` shows each step's model and effort.
- **Model list:** a new read-only planner tool `list_models` returns the current provider's models (id, name, effort levels, default).
- **New lines in `PLANNER_APPEND`:**
  - *"Each agent step can have its own model and effort (add_node/update_node: model "<provider>/<id>", effort). Leave them on Default unless the user asks, or a step is clearly simple (checks, summaries — a small model or low effort) or clearly hard. Use only models list_models returns for the current provider."*
  - *"To compare models, add one step per model/effort with the same prompt; let them run in parallel (read-only, or each in its own workspace when they write), then a read-only compare step that reports quality, time and tokens from their outputs."*

## 6. Copilot effort

The research found no effort or reasoning option in the `vscode.lm` request API that extensions use. The plan's first task checks the installed `vscode.d.ts` (and `LanguageModelChatRequestOptions.modelOptions`).

- **If no supported option exists:** Copilot steps show Effort as **Not supported**, and a stored effort on a Copilot step is ignored with the existing log note.
- **If one exists:** the plan adds it behind the same per-model rule.

## 6a. Keyboard: save and undo (added on request)

These apply to the graph tab. "⌘" means Command on macOS and Ctrl on Windows and Linux. Toasts use the existing toast (it disappears after 6 s).

### 6a.1 Save: ⌘S

**What it saves:**
- **In Markdown mode,** ⌘S keeps its current behaviour (saves the Markdown). On success it now also shows the toast `Saved.`
- **In Graph mode,** ⌘S saves everything unsaved in the tab:
  - **The Node panel's draft.** If the open step has unsaved edits, they are saved exactly as the panel's Save button does.
  - **Canvas edits.** Moves, adds, connections, deletes and Tidy are already saved as they happen. ⌘S also sends any position that hasn't been confirmed yet.

**What the toast says:**
- `Step <id> saved.` when a step draft was saved.
- `Graph saved.` when the step had no unsaved edits. Nothing else needed saving, so this confirms that the graph is saved.
- `Can't save: <id>.md has errors. Fix the file first.` when the graph's file has errors and the step draft can't be saved (R6 of the Markdown graphs work). In that case the draft is kept.

**Focus:** ⌘S works wherever focus is in the tab, including the Node panel's text fields. It calls `preventDefault`. VS Code may also run its own Save on the tab, which is read-only and does nothing.

**Menu:** File › **Save** (⌘S) does the same thing.

### 6a.2 Undo: ⌘Z

**What can be undone:**
- Undo reverses **the user's own graph edits made in this tab**, newest first, up to 50 steps.
- One user action is one undo step:
  - a Node panel save;
  - adding, deleting or connecting steps, including deleting a whole selection;
  - one drag, even with several steps selected;
  - Tidy;
  - a Markdown save in this tab;
  - a model or effort change;
  - a goal, instructions or variable edit.
- **Not undone:**
  - agent changes (they have Accept and Revert in the Changes tab);
  - outside file edits (by hand in another editor, git, another AI);
  - edits from another window.
- **Text fields:** inside a text field (the Node panel's inputs, the Markdown editor, the chat box), ⌘Z is the field's own text undo, not graph undo.

**How it works:**
- **Recording.** The engine keeps an undo stack per graph and per tab. Each entry holds the graph as it was before and after one action, with a short label (`moved 2 steps`, `deleted n3`, `saved n3`, `tidied the layout`, `saved the Markdown`). The stack lives in memory and is cleared when the extension reloads.
- **Undoing:**
  - **If the graph still equals the entry's "after"**, the engine restores the entry's "before" by applying `diffToOps(current, before)` as user edits. They are recorded in history with `via: 'undo'`, follow the normal agent-change baseline rules, and are written to the `.md`.
  - **If the graph changed since then** (by the planner, an agent step, a file edit or another tab), undo is refused, so it never discards someone else's change. The stack is then cleared for that tab.
  - **If the file has errors,** undo is refused (R6).
- A running run is unaffected; it keeps its snapshot, as with any edit.

**Toasts:** `Undid <label>.`, `Nothing to undo.`, `Can't undo: the graph changed since (by the planner, a run, the file or another tab).` and `Can't undo: <id>.md has errors. Fix the file first.`

**Menu:** Edit › **Undo <label>** (⌘Z), disabled when there is nothing to undo.

**Redo** (⇧⌘Z / Ctrl+Y) is not included. It's an easy follow-up on the same stack.

## 6b. Attachments: files and photos as context (added on request; phase 2)

Built as a **second phase**, after model, effort and the shortcuts (§§2–6a), so those ship sooner. The user approved approach A: **copy into the project**.

### 6b.1 Where you can attach

1. **A planner chat message.** 📎 button, drag-and-drop, or paste in the chat box. The planner receives the files with that message only.
2. **A step.** Attachments list in the Node panel (agent steps only). The step's agent gets them every time the step runs.
3. **The whole graph.** Attachments list in the Graph panel. Every agent step gets them, after the step's own.

The planner is told the graph's and the open step's attachment names (as context), but it does not receive their contents unless they are attached to a chat message.

### 6b.2 Storage

- **Step and graph attachments** are copied into `.agent-stream/attachments/<graph-id>/<name>`.
  - This folder is **not** git-ignored, so attachments are committed with the graph and teammates get them.
  - **Names:** the original file name, made safe (letters, digits, `.`, `-`, `_`, space, at most 100 characters). A clash gets `-2`, `-3`, … before the extension.
- **Chat attachments** are copied into `.agent-stream/sessions/<session>/attachments/` (git-ignored, personal, never committed). They are not part of the graph.
- **Allowed types:**
  - images: `png`, `jpg`/`jpeg`, `gif`, `webp`;
  - PDFs;
  - text-like files: `md`, `txt`, `csv`, `tsv`, `json`, `yaml`/`yml`, `sql`, `xml`, `html`, `log`, and common source-code extensions.
  - Anything else is refused with a message naming the allowed types.
- **Limits:** images up to 10 MB, other files up to 5 MB, at most 20 attachments per step, per graph, and per chat message.
- **Removing:**
  - A step or graph attachment is removed from the list. Its file is deleted only when nothing else in the graph still references it.
  - **Deleting a graph** deletes its attachments folder.
  - **Duplicating a graph** copies it.
- **The first attachment in a folder** shows a one-time notice: `Attachments are saved with the graph (and committed) and sent to your AI provider. Don't attach secrets.` Variable values are never written into attachments.

### 6b.3 In the Markdown file

- **A step** gets one line per attachment in its field list, after `effort`: `- attach: mockup.png`. The line is repeatable and order is kept.
- **The graph** gets a reserved `## Attachments` section after `## Variables`: a bullet list, `` - `mockup.png` ``.
- **Parse errors** (each with its line and a fix hint):
  - an attachment name that isn't a safe name;
  - a duplicate name in one list;
  - `attach` on a command step.
- **A missing attachment file** is not a parse error. It is a warning when a run starts (§6b.5), so a graph still opens before the files are pulled.
- **Round trip** and `diffToOps` cover both lists.
- **Data model:**
  - `GraphNode.attachments?: string[]` and `Graph.attachments?: string[]`;
  - the node patch accepts `attachments`, and a new op `setGraphAttachments { names }`;
  - `ChangedField` gains `'attachments'`;
  - switching a step to `command` drops its list.

### 6b.4 Adding and opening files

- **Add…** opens VS Code's file picker (the extension copies the files).
- **Drag-and-drop or paste** into the Node panel, Graph panel or chat box sends the file bytes to the extension. That is subject to the same limits, checked in the tab before sending.
- **Open** opens the attachment in VS Code (images in its image viewer).
- **Remove** removes it (§6b.2).
- **History:** each change is a normal edit in history, agent-change review and the `.md`, and undo (§6a) covers it. **Agents and the planner can't add or remove attachments in v1**: no graph tool for it.

### 6b.5 What agents receive

**A step's run.** The step's prompt gets an `Attached files:` list: the step's attachments, then the graph's, each with its path (relative to the step's folder, or absolute for a variant worktree).

| | Images | PDFs | Text files |
|---|---|---|---|
| **Claude** | attached as images in the step's first message | read with Read (Claude supports PDFs) | read with the read tools (no approval needed) |
| **Codex** | attached with `turn/start` image input items | path plus a note that the model may not read PDFs | read with plain reads (no approval needed) |
| **Copilot** | sent as images if the VS Code LM API supports image parts for extensions (to be checked in the plan's first task); otherwise path plus the note `This image couldn't be shown to the model.` | path plus a note | read with Read |

- **Run snapshot:** it records each attachment's name and SHA-256, and a missing file adds a warning to the run dialog and the step log.
- **Run Report:** it lists each step's attachments (names and hashes, not contents).
- **Privacy:** the attachments folder is readable by agents like any project file. It is not a private path.

**A planner chat message.** Its files go to the planner with the message:
- **Images** as images, where the provider supports them.
- **Text files** inlined into the message, up to 100 KB each, with a note when cut.
- **PDFs** sent as documents on Claude; on Codex and Copilot, a note that they couldn't be included.

The planner can't open chat attachments with its read tools, because the sessions folder stays private. The chat shows each attachment as a chip on its message.

## 7. Testing

- **shared:**
  - the parse and write of `model` and `effort` (fields, order, every error with its line);
  - round trip, including the 300-graph generator extended to set the fields on agent steps;
  - `diffToOps` for set, change and clear;
  - `applyOp`:
    - refuses the fields on command steps;
    - a kind switch drops them;
    - null clears them;
    - agent-change fields include them.
- **engine:**
  - resolution rules 1–4: matching provider, another provider (default plus note), not offered (default plus note), Copilot tries and falls back, effort filtering;
  - the snapshot's `stepModels`;
  - re-runs use the snapshot;
  - executors receive the step's model and effort;
  - Run Report lines;
  - planner tools (`add_node` and `update_node` accepting and refusing values, `list_models`, `get_graph`);
  - `PLANNER_APPEND` lines.
- **web:**
  - the Node panel dropdowns: Default, the Claude grouping, another provider disabled with Use Default, "not offered", the effort list per model, Not supported;
  - the chip and its warning state;
  - the run dialog's per-step lines and warnings.
- **extension:** the Copilot effort check from §6. The model list wiring needs no change.
- **keyboard (6a):**
  - **Save:**
    - Graph mode with a dirty step draft saves it, with the toast `Step <id> saved.`
    - Graph mode with nothing dirty shows `Graph saved.`
    - Markdown mode saves, with the toast `Saved.`
    - It is refused while the file has errors (draft kept, toast).
    - It works from the Node panel's text fields.
    - File › Save does the same.
  - **Undo:**
    - each action kind is one step, labelled;
    - 50-step limit;
    - restores via `diffToOps` with `via: 'undo'` history;
    - refused after an agent, file or other-tab change (and the stack cleared);
    - refused while the file has errors;
    - ⌘Z inside text fields stays text undo;
    - Edit › Undo label and disabled state;
    - agent-change baseline behaviour matches a canvas edit.
- **attachments (6b):**
  - **storage:** safe names and clashes; type and size limits; delete-when-unreferenced; graph delete and duplicate;
  - **the `.md`:** `attach` lines and the `## Attachments` section (parse errors, round trip, `diffToOps`), and `setGraphAttachments`;
  - **runs:** the prompt's `Attached files:` list; images passed as images per provider (Claude, Codex; Copilot as the check in its first task decides); PDFs per provider; the snapshot hashes; a missing-file warning; Run Report;
  - **chat:** chat attachments sent with one message (images; text inlined and cut; PDF per provider), stored in the session and never committed;
  - **UI:** Add, drag/drop, paste, Open, Remove; limits checked before sending; the one-time notice; undo covers attachment edits.
- **All existing tests keep passing,** on Windows, macOS and Linux CI.

## 8. Research appendix (2026-10-05)

From live checks on the user's machine (Claude Code 2.1.289 `supportedModels()`, codex-cli 0.160 `model/list`, no model turn spent) and the providers' docs. Model lists are plan-specific and change, so Agent Stream always reads them at runtime.

- **Claude:**

  | Model | Efforts |
  |---|---|
  | `default` (Sonnet 5.5 on this account; Opus 5.5 on most plans) | low/medium/high/xhigh/max |
  | `sonnet` (Sonnet 5.5) | low/medium/high/xhigh/max |
  | `opus` (Opus 5.5) | low/medium/high/xhigh/max |
  | `fable` (Fable 5.1, most capable) | low/medium/high/xhigh/max |
  | `haiku` (Haiku 4.5, fastest) | none |
  | pinned `claude-sonnet-5`, `claude-opus-5`, `claude-fable-5`, `claude-opus-4-8`, `claude-opus-4-7` | low/medium/high/xhigh/max |
  | pinned `claude-opus-4-6`, `claude-sonnet-4-6` | low/medium/high/max (no xhigh) |

  Aliases move with Claude Code updates; pinned ids don't. Source: code.claude.com/docs/en/model-config.
- **Codex:**

  | Model | Efforts |
  |---|---|
  | `gpt-6.1-sol` (default) | low → ultra |
  | `gpt-6-astra` (most capable) | low → ultra |
  | `gpt-6-luna` (fastest) | low → max |
  | `gpt-6-sol`, `gpt-5.6-sol`, `gpt-5.6-terra` | low → ultra |
  | `gpt-5.6-luna` | low → max |
  | `gpt-5.5` (legacy; retires 2026-10-14) | low → xhigh |

  Source: learn.chatgpt.com/docs/models.
- **Copilot:**
  - Plan-dependent: OpenAI GPT-5.x and 6.x, Anthropic Claude (Haiku 4.5 → Fable 5.1), Gemini 3.7/3.8 Flash, Grok 4.5–4.7, Kimi K3, MAI-Code-1.1-Flash, plus Auto. Some listed models only work for VS Code core.
  - Billing is per token in AI credits.
  - Sources: docs.github.com/en/copilot/reference/ai-models/supported-models and …/copilot-billing/models-and-pricing.

## 9. Out of scope

- Mixing providers in one run.
- Bulk model setting.
- Per-step model for planner chats.
- Showing cost per model.
- Tier-based model names.
- Redo, and undo of agent changes or outside file edits.
- Agents or the planner adding or removing attachments; attachments in exports (an exported `.md` names them but doesn't include the files — the export toast says so); other file types; links to existing repo files instead of copies.
