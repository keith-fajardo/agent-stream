# Agent Stream — step descriptions and Refine with planner

**Date:** 2026-10-03
**Status:** Approved in conversation (sections 1–3); written for review
**Builds on:**
- `2026-10-03-agent-stream-providers-design.md` (provider-neutral planner and graph tools)
- `2026-10-03-agent-stream-sessions-chat-design.md` (sessions, chat view)

This work joins the same implementation plan: two tasks before its integration and docs tasks.

## 1. Purpose

A step's prompt does two jobs today. It is the precise instruction an agent runs on, and it is the only text a person can read to know what the step is for. Long technical prompts make both jobs harder.

Each step gets a **description**: a short, plain-language "what this step does and why", written for the human who reviews the graph.

- **By default the planner writes it**, summarising the step's prompt or command.
- **A human can write it too.** A human can also write the prompt itself in plain language, with no technical detail.
- **Refine with planner** asks the planner to read a step written that way. It investigates the repository, then writes the detailed prompt (or the exact command) and updates the description to match.

The description is used in four places:
1. On the canvas, so the graph is readable at a glance.
2. In the step's own agent prompt, as a one-line summary above the detailed prompt.
3. In later steps' context, next to each earlier result.
4. For command steps as well as agent steps.

Success:
- A graph's purpose is readable from the canvas without opening prompts.
- Writing "compare row counts between orders and orders_v2 and flag big gaps" as a step, then pressing **Refine with planner**, produces a precise prompt that names the real models or tables, plus a one-sentence description. The user reviews both before running.
- Existing graphs without descriptions work unchanged.

## 2. Decisions

| Topic | Decision |
|---|---|
| Who the description is for | People first; agents also receive it as context |
| Where it is used | Canvas card, the step's own prompt, later steps' context, command steps too |
| Authoring | Optional. The planner writes one by default whenever it adds or changes a step; humans can write or edit it |
| Plain-language steps | **Refine with planner**, on request, per step or for every step the user last edited |
| How Refine works | A normal planner turn in the current session (approach A), using the planner's graph tools |
| Templates | Descriptions are plain text; `{{ }}` is not filled in |

## 3. Data

- **`GraphNode` gains `description?: string`.** Graph files without it load as having none. Anywhere a description would appear, a missing or blank one means "show the title only".
- **Edit operations.** `addNode` input and `updateNode` patch accept `description`, with the same validation as `title` (a string; trimmed when shown). Export/import (`ExportedNode`) and duplicate carry it. The export format version is unchanged, because the field is optional.
- **Content signature.** `contentSignature` includes each node's description, next to its title. A description change therefore invalidates a reviewed run, as a title or prompt change does today.
- **Re-run reuse.** A step whose own description changed is re-executed, not reused, for agent steps. A command step's description doesn't change what runs, so it doesn't affect reuse. Upstream descriptions appearing in later prompts follow the existing title rule.

## 4. What agents see (`engine/src/prompt.ts`)

The step's own block in `buildNodePrompt` becomes:

```
# Your step: <title>
In short: <description>
<prompt>
```

The "In short:" line appears only when the description is non-blank.

The headings of earlier results become:

```
## n2 · Build new: <description> (agent, succeeded)
## n1 · Build old: <description> (command `dbt build -s orders`, exit 0, 3.2 s)
```

When there is no description, the heading is exactly today's text.

The run confirmation dialog shows each agent step's full prompt text, because the run preview renders the step's prompt block. The description is therefore reviewed together with the prompt.

## 5. The planner

- **Graph tools.** `add_node` and `update_node` accept `description`. `get_graph` (`summarizeGraph`) includes it.
- **Standing instruction.** `PLANNER_APPEND` gains: "Every step has a short plain-language description for people: one sentence on what the step does and why, without technical detail. Write one whenever you add a step, and update it whenever you change a step's prompt or command. The user may write a step's prompt or description in plain language; when asked to refine steps, turn that into precise instructions and keep the description short and readable."

## 6. Refine with planner

### 6.1 Triggers (graph tab)

- **Node panel:** a **Refine with planner** button next to Save, for the selected step.
- **Edit menu:**
  - **Refine selected step**;
  - **Refine steps you changed (N)**, where N counts steps whose `updatedBy` is `user` and that have a description, prompt or command. These are steps the user edited and the planner hasn't touched since.
- **Disabled when:**
  - the provider can't run (the chat's rule);
  - the planner is busy in the current session;
  - for a single step, the step has no description, no prompt and no command (only a title).

### 6.2 Routing

- **From the graph tab.** The graph tab doesn't know the active session, so it posts a host message `{ type: 'refineSteps', nodeIds: string[] }`. The extension's message handler adds the panel's `graphId` and the folder's active session, then calls the engine with `{ type: 'refineSteps', graphId, sessionId, nodeIds }`.
- **In the engine.** It validates:
  - the graph exists;
  - the session exists;
  - every node ID exists ("node n2 does not exist");
  - every node has something to refine ("Write what the step should do first.");
  - the provider can run.
- **The planner call.** The engine calls `planner.send(sessionId, graphId, promptText, { display })`:
  - `display` is the chat line `Refine n2, n4`;
  - `promptText` is the full instruction:

> Refine step(s) n2, n4. For each, read its title, description and prompt (or command) with get_graph; the user may have written them in plain language without technical detail. Investigate the repository as needed. Then use update_node to write (1) a precise, detailed prompt for an agent step — or the exact shell command for a command step — that carries out the user's intent, and (2) a one-sentence plain-language description a non-technical reader can review. Keep the user's intent; do not change any step's kind, its connections, or other steps. Reply with one line per step saying what you changed.

- **`Planner.send` gains `options?: { display?: string }`.** The user's chat entry shows `display` when given. The provider receives the full text, after the usual user-edits preamble.

### 6.3 Review

- Refined steps carry `updatedBy: 'agent'`, so the card shows the existing "by planner" marker and the step drops out of "Refine steps you changed".
- The ops log keeps the user's original wording. There is no undo UI.
- Command steps are still shown verbatim in the run dialog before anything runs.

## 7. UI

- **Canvas card (`StepNode`).** The description shows under the title, muted, clamped to two lines, with the full text in the `title` attribute (tooltip). There's no description row when it is blank.
- **Node panel.** Field order: Title · **Description** · Kind · Prompt/Command · Timeout.
  - Description is a 3-row textarea with the placeholder "In plain words: what this step does and why".
  - It is part of the draft. The "changed underneath" notice, Save only sending changed fields, and the session-switch unsaved-edits prompt (`draftState`) all cover it.
  - **Refine with planner** follows Save. It refines the step as saved: with unsaved edits, the button reads **Save and refine** and saves first.

## 8. Error handling

| Situation | Behaviour |
|---|---|
| Provider can't run | Refine disabled, with the provider's message; the engine also refuses with `Chat is disabled: <reason>` |
| Planner busy in this session | Refine disabled; if a request still arrives, the chat shows "The planner is still working on your previous message." |
| A step with only a title | Refine disabled for it; the engine refuses "Write what the step should do first." |
| A node deleted before the request | `node <id> does not exist` |
| The planner changes something else | Visible in the chat and in the canvas markers; the prompt forbids it |

## 9. Testing

- **Shared:** `description` in `parseGraph`, the edit-operation schemas, `applyOp` (add/update), export/import round trip, duplicate, `contentSignature`.
- **Engine:**
  - `buildNodePrompt`: the "In short:" line present or absent, and the description in earlier-result headings.
  - Reuse: an agent step's own description change re-runs it; a command step's doesn't.
  - Graph tools: `add_node`/`update_node` take `description`; `get_graph` returns it.
  - `PLANNER_APPEND` contains the description rule.
  - `refineSteps`:
    - the chat shows `display`, while the provider receives the full instruction;
    - it refuses an unknown session, a missing node, a title-only step, a busy planner and a provider that can't run.
- **Web:**
  - the card shows the description, with a tooltip, and nothing when blank;
  - the Node panel edits the description within the draft, including the conflict notice and `draftState`;
  - Refine and Save and refine post `refineSteps`;
  - the Edit menu items and their enabled/disabled states, including the "(N)" count.
- **Extension:** a `refineSteps` host message reaches the engine with the panel's graph and the folder's active session.
- **Integration and screenshots** (in the plan's existing tasks):
  - a card with a description;
  - the Node panel with Description and the Refine button;
  - a check that `refineSteps` is refused for a title-only step. No real planner turn runs in CI.
- **Docs.** The README's "Use" section explains descriptions and Refine with planner.

## 10. Out of scope

- An undo UI for Refine (the ops log keeps the history).
- Rendering `{{ }}` inside descriptions.
- Refining automatically on save or before runs.
- A separate one-shot refine job outside the chat.
