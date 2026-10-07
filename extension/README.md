# Agent Stream

Agent Stream is an independent project. It is not made, endorsed or supported by Anthropic, GitHub or OpenAI.

A VS Code extension where you and an AI planner co-create a workflow as a graph, then run it step by step on your own AI subscription. Agent Stream is **provider-agnostic**: agent steps and the planner run on the provider you choose. That is **Claude** (your Claude subscription through Claude Code), **GitHub Copilot** (your Copilot plan through VS Code's Language Model API) or **OpenAI Codex** (your ChatGPT subscription through the Codex CLI). Every file edit, shell command or other non-read-only action an agent step attempts waits for your approval, whichever provider runs it, and every step keeps its own logs.

## Why Agent Stream

Handing a real task to an AI agent usually means one long chat: a big prompt goes in, a lot happens, and you get a result you have to take on trust. It's hard to see what the agent did, check it step by step, rerun one part, or run two pieces of work at once without them colliding.

Agent Stream turns that into a plan you can see and audit:

- **Break work into steps.** The planner turns your goal into a graph with one step per action or scenario, in the order they depend on each other. You can review, edit or split any step before anything runs.
- **Stay in control.** Every file edit or command an agent attempts waits for your approval. Steps that only read can run alongside each other.
- **Audit everything.** Each step keeps its own logs, and **Export Run Report** saves one Markdown record of a run: what ran, every approval and its decision, each step's output, and the branch, commit, provider and model.
- **Work in parallel safely.** Run separate tickets side by side, each in its own Git worktree, so their changes never collide.
- **Compare alternatives.** Run the same steps in separate workspaces and compare the results in one graph. For example, run a dbt model on two warehouses to see which is faster and cheaper.
- **Use the subscription you have.** Claude, GitHub Copilot or OpenAI Codex.

**Example:** "Test that my SCD2 model works." The planner builds steps that check the target table doesn't exist, run the model, check the table now exists, add a new source row, run again, check the row arrived, change the row, and check the old version was closed. You approve the runs and get a report you can hand to a reviewer.

## Requirements

- VS Code **1.106** or newer, on macOS or Windows. Linux works the same way as macOS.
- One provider:
  - **Claude:** Claude Code installed and signed in with your Claude account (run `claude`, then `/login`). Check with `claude auth status`.
  - **GitHub Copilot:** the GitHub Copilot extension installed and signed in to a Copilot plan. The first run or chat on Copilot asks you to allow Agent Stream to use it.
  - **OpenAI Codex:** the Codex CLI installed (from https://developers.openai.com/codex) and signed in with ChatGPT (run `codex login` in a terminal and choose ChatGPT). An API-key sign-in is refused.
- Windows only: Git for Windows, which provides Git Bash for command steps.
- For steps that use the Agent Stream browser (optional): Google Chrome, Microsoft Edge or Chromium installed. Agent Stream downloads no browser.

## Install

Install Agent Stream from the VS Code Marketplace, or from an `agent-stream-<version>.vsix` file: in VS Code run **Extensions: Install from VSIX…** and pick the file.

## Use

- **Agent Stream sidebar:**
  - **Graphs:** New, Import, and right-click for Open, Open Graph as Markdown, Rename, Duplicate, Export, Delete. A graph whose file has errors shows **Can't be read**: click it to open the file, with its problems in the Problems panel.
  - **Sessions:** New Session, click to switch, right-click for Rename, Duplicate, Delete.
  - **Approvals:** Approve, Deny, Approve all. On a step's approval card, **Allow all for this step** stops that step asking for the rest of its run (other steps and later runs still ask).
- **Chat view:** the **Agent Stream Chat** view on the right, next to VS Code's own Chat. It shows the planner conversation for the graph tab you're on, in the current session. Describe a goal; the planner reads your repo (read-only) and draws the plan. **New chat** starts over; the session button switches session.
- **Stop:** while the planner works, **■ Stop** takes the place of Send; it, or Esc in the chat, stops the planner's turn. The chat shows `Stopped.`, graph edits it already made stay, and you can type continue to pick up where it stopped.
- **Runs:** the planner never starts a run. It asks to run (or test) the graph only when you ask it to; after building or changing a plan it stops so you can review it. Its request opens the run dialog headed **The planner asks to run this graph**, where **Not now** closes it.
- **Model and effort:** the chat header's **Model** menu picks the model for this conversation (**Default**, or one the provider lists), and **Effort** its effort level when that model offers levels (for **Default**: the levels of the model in the settings, else of the provider's default model). A saved effort always shows, so it can be cleared. The choice is kept with the conversation in the session (New chat keeps it) and applies from the next message. **Default** uses the `agentStream.model` / `agentStream.effort` settings, or the provider's own default when they are empty (Claude Code's default; Auto on Copilot; Codex's default model on Codex). Runs use those settings, read once when the run starts: the run dialog and the run's tooltip show `Model: … · Effort: …`. Set them with **Agent Stream: Select Model**; the provider's status bar tooltip shows them. These settings are never written into a graph or an export (a step's own model is, below). An effort level the chosen model doesn't offer is left out.
- **A step's own model and effort:** an agent step can run on its own model and effort, for a cheap check, a hard step, or to compare models side by side. Pick them in the Node panel's **Model** and **Effort** menus (**Default** is the run's model and effort); the step's card shows them as a chip such as `Opus · high`. They are saved in the graph's Markdown file (`- model: claude/opus`, `- effort: high`), so teammates get them. A run uses a step's model only on the provider it runs on: a step set to another provider's model, or to one the provider no longer offers, runs the run's model instead (except on Copilot, below), and the run dialog, the step's log and the Run Report say so (the chip is struck through). On Copilot, a model missing from its list shows the note `<id> isn't in GitHub Copilot's model list here, so this step tries it and uses Auto if Copilot refuses it.` The planner can set them too, when you ask or for a clearly simple or clearly hard step. Copilot has no effort levels: a step's Effort reads **Not supported**.
- **Save and undo:** in a graph tab, **⌘S** (Ctrl+S) or **File › Save** saves whichever open panel has unsaved edits: the Node panel (`Step <id> saved.`) or the Graph panel's goal and instructions (`Goal and instructions saved.`). With nothing unsaved it says `Graph saved.`, and in Markdown mode it saves the Markdown (`Saved.`); everything else is saved as you make it. **⌘Z** (Ctrl+Z) or **Edit › Undo** undoes your own last graph edit in this tab (up to 50): a Node panel save, adding, deleting or connecting steps, a drag, Tidy, a Markdown save, a goal, instructions or variable edit. Undo keeps a variable's saved value through a rename and brings back a deleted variable's value; saved values are never deleted by a file edit or an undo. Undo is refused once the graph changed since (by the planner, a run, the file or another tab), and agent changes are reviewed in the **Changes** tab instead. The shortcuts do nothing while a dialog is open, and inside a text field ⌘Z is the field's own undo of your typing.
- **Attachments:** give agents files and photos as context: a mockup, a spec, sample data. In the Node panel (an agent step's own files) or the Graph panel (files every agent step gets, after its own), press **Add…**, drag files in, or paste them; **Open** shows one in VS Code and **Remove** takes it off the list. Agent Stream copies each file into `.agent-stream/attachments/<graph id>/`, which Git does not ignore, so attachments are committed with the graph; the Markdown file names them (`- attach: mockup.png`, `## Attachments`). An export names them too but doesn't include the files (send those along); Duplicate copies them, and deleting a graph deletes them. Images (png, jpg, gif, webp, up to 10 MB), PDFs and text files (up to 5 MB) are allowed, at most 20 per step, per graph and per chat message. A step's prompt lists its files; Claude and Codex get images as images, and Copilot does when the model takes them. In the chat, 📎 (or a drop or paste) sends files with that one message: images as images, text files inlined, PDFs on Claude. Claude and Copilot take images up to 3.75 MB (5 MB once encoded for sending), and one request carries at most 20 images and 20 MB of images and PDFs, filled in order: past that a Claude step reads the image from its file, a Copilot step goes without it, and a chat message leaves the file out with a note. A file a model can't take is named in the prompt with the reason. Chat attachments stay in the session folder and are never committed. Attachments are sent to your AI provider: don't attach secrets. A run whose file is missing (not pulled yet) warns and runs without it; the Run Report lists each step's files with their SHA-256.
- **Graph tab:** the canvas, the logs of the selected step underneath, and Node · Graph on the right (plus a Changes tab while agent changes wait for review). The menu bar has File, Edit, Run, Variables and View, with View › Chat opening the chat view.
- **Markdown:** step logs (the agent's text and the prompt it was sent) and the planner's chat replies render Markdown. HTML in agent output is shown as text, never run; links open in your browser only when they are http(s).
- **Work sessions:**
  - A session is a named set of open graph tabs plus its own planner conversations.
  - Switching a session closes the current graph tabs and brings back the other session's tabs, splits and chats.
  - Sessions are personal: they stay in `.agent-stream/sessions/`, which git ignores.
- **Status bar:** the provider your steps run on (for example `Claude Max`, `Copilot` or `Codex (Plus)`) and the current session (`Default`). Click either one to change it.
- **Agent steps** run a separate AI agent with the step's prompt, the goal, the instructions and the outputs of earlier steps. **Command steps** run an exact shell command in the project folder: your login shell on macOS, Git Bash on Windows.
- **Step descriptions:** each step has a plain-language description for people. It shows on the canvas card, and agents get it as context: a step sees its own description as "In short", and later steps see earlier steps' descriptions next to their results. The planner writes one for every step it adds or changes, and you can write or edit it in the Node panel.
- **Refine with planner:** write a step in plain words, then press **Refine with planner** (Node panel, or **Edit › Refine selected step** / **Refine steps you changed**). The planner reads your repository and writes the precise prompt or command, plus a one-line description, for you to review.
- **Split into steps:** press **Split into steps** (Node panel, or **Edit › Split selected step**) and the planner breaks one step into several connected steps, one per distinct action or scenario, reconnecting the original step's links. The result shows as agent changes you can review, accept or revert in the **Changes** tab.
- **Agent changes:** the planner, and agent steps during a run, can change the graph. A step agent asks your approval first, showing the exact text that would run, and can only change steps that haven't started. That approval can't be given from a notification or with **Approve all**: you approve each request on its own, after you see its text on the step or in the Approvals view, unless you press **Allow all for this step** on one of that step's cards, which also approves its graph changes for the rest of the step. Approved changes apply to the running run and stay marked on the canvas (`＋` added, `✎` changed, faded ghosts for removed steps) until you **Accept** them into your original graph or **Revert** them in the **Changes** tab. The tab shows each change's before and after and who made it.
- **Variables:** use `{{ name }}` (Jinja) in steps, the goal and the instructions. Values stay on this machine, outside the project, in `~/.agent-stream/values/` (`%USERPROFILE%\.agent-stream\values\` on Windows): they are never committed or exported, and Claude's Read, Grep and Glob tools are refused access to them (a shell command an agent attempts still needs your approval first). A value can read an environment variable: `{{ env_var('DBT_SCHEMA', 'dev') }}`. In commands every value is shell-quoted; `{{ flags | unquoted }}` opts out. A value inside `'…'` or `"…"` is escaped for those quotes. Places where a value can't be quoted safely (after a backtick, `$((`, `${`, `$'`, `$"` or a heredoc, inside a `#` comment or nested quotes, or right after a `\`) are refused with a message that says how to fix the step. Wrap dbt's own Jinja in `{% raw %}…{% endraw %}`.
- **Run:** the dialog shows every command and prompt with values filled in, plus any problem that blocks the run. Start runs exactly what you reviewed.
- **Retry:** after a run that stopped, failed or was interrupted you don't pay again for steps that already worked. Every retry starts a new run that reuses the results of the graph's latest run, and opens the run dialog listing what runs and what is reused.
  - **↻ Retry from where it stopped** (top bar, or **Run › Retry from where it stopped**, shown after a stopped, failed or interrupted run): runs the steps that didn't finish, and everything after them; reuses the rest. It is also shown after a run that succeeded but left stale steps (see below), where it refreshes those steps and everything after them.
  - **Re-run from here** (Node panel, or **Run › Re-run from selected step…**): runs that step and everything after it.
  - **Run only this step** (Node panel, or **Run › Run only selected step…**): runs just that step, reusing the latest run for everything else. It needs every step before it to have a current result; otherwise it is disabled with the reason as its tooltip, or the run dialog shows why it can't start. It is refused for a step in a workspace when an earlier step uses the same workspace, because its new worktree would lack that step's changes: use **Re-run from here** on that earlier step. Steps after it keep their old results, marked **stale** (as does a kept step you edited since): the step's logs say why (`Stale: built on an older result of n2`, or `Stale: edited since this result`), its card shows a `stale` badge, and the Run Report notes it. A stale step counts as not done: a later retry or re-run runs it again, and **Run only** won't build on it. A step built on an edited step says so, and only the edited step itself reads `edited since this result`. A run where some steps never ran is not a success, so **Retry from where it stopped** is still offered.
  - A step with a workspace always runs again when it executes, in that run's own worktree; **Run only** on another step reuses it like any other.
  - The planner's `request_run` can ask for any of the three; you still confirm in the dialog.
- **Run report:** **Run › Export Run Report…**, the **Report** button next to the run picker, or **Agent Stream: Export Run Report** saves one Markdown audit trail of a run (`<graph-id>-run-<run-id>.md`, in the project folder by default) and opens it: where and how it ran (branch, commit, provider, model, effort), the goal, instructions and plan, then each step's model and effort, its prompt or command as it ran, its tool calls, every approval with its decision and note, its output (long output is cut, with the path to the full file), exit code and usage, whether a kept result is stale, and the changes agents made during the run. Prompts, commands and step output appear exactly as they ran, including filled-in variable and environment values and anything an agent printed. The saved variable values file is never included.
- **Export / Import:** share a graph as its Markdown file, `<id>.md` (the same text as the stored file, so never a variable value). Import takes a graph Markdown file, or an older `<name>.agent-stream.json` export.

## The Agent Stream browser

Some research needs websites you log in to, or that turn automated visitors away. Agent Stream can open your own Chrome, Edge or Chromium with a profile of its own, which you log in to yourself; agent steps you allow then use that logged-in browser to search, open sites and read pages, and you can browse in it too.

- **Turn it on per step:** the Node panel's **Browser** switch on an agent step ("Lets this step use the Agent Stream browser, with your logins. Clicking and typing ask you first."). The step's card shows 🌐, and the graph's Markdown file says `- browser: on`. The planner can switch it on for steps that need websites; the planner itself never browses. Access is separate: a read-only step can still browse. Writing "use the browser" in a step does not turn it on; the step panel and the run dialog warn when a step mentions the browser, LinkedIn or logging in while Browser is off.
- **Log in first:** run **Agent Stream: Open Browser** and log in to the sites you want agents to use. Agents only see this browser, not your everyday one.
- **What agents can do:** search (`agentStream.browser.searchEngine`, Google by default), open http and https pages, read them, list their structure, inspect an element, take a screenshot, scroll, go back and switch between their own tabs. **Clicking, typing, choosing an option and pressing a key ask you first**, on a card that shows the site, the page, the element and the exact text (and `Then presses Enter` when typing also presses Enter, which can submit a form or send a message), usually with a screenshot (left out when it is too large or can't be taken): **Allow once**, **Allow on this site for this step**, **Allow all for this step**, or **Deny**. Stop cancels a pending card. An agent can also pause and wait for you (to log in, or to solve a CAPTCHA): a notification and the step's log say `Step <id> is waiting for you in the browser: <reason>` until you press **Done**. Claude Code's own limit for a tool call is about a day, so a Claude step waiting for you is not cut short unless your environment sets Claude Code's `MCP_TOOL_TIMEOUT` lower. **Done** reopens the browser if you closed it while the step was waiting.
- **Allow on this site:** it covers that site's origin (scheme, host and port), for this step in this run. It never covers an action on a page that embeds a frame from another site, or a frame whose site can't be read: those always show the card, unless you chose **Allow all for this step**. An embedded frame can't be clicked as a whole; the agent uses an element inside it.
- **Where you approve:** browser actions are approved on their card only. The notification and the sidebar offer **Show** and **Deny**. **Run › Approve all** allows each pending action once, and never "on this site" or "all for this step". **Allow all for this step** on the card covers every action the step asks about, even on a page with a frame from another site.
- **Tabs:** each step works in its own tabs, and tabs those open join them. Agent Stream never touches the tabs you open, and leaves their pop-up questions (alerts, confirmations, "Leave site?") for you to answer. In a step's own tabs it answers them itself: it accepts an alert, declines anything that asks (a confirmation, a prompt, "Leave site?"), and tells the agent what the page said. A step that succeeds closes its tabs; one that fails or is stopped leaves them open so you can see where it got to. The status bar shows `🌐 Browser` while the browser is open and `🌐 n3, n5` while steps use it; click it to bring the browser to the front. On macOS, closing the Agent Stream browser's last tab or window closes the browser.
- **Audit:** the step's log shows `🌐 opened <url>` and `🌐 searched "<query>"`, `🌐 now on <url>` when a step switches tabs, `(allowed on this site)` on an action that ran without a card because of "Allow on this site", and, after **Allow all for this step**, the line `Allowed everything for the rest of this step` and `(allowed for this step)` on each request it approved. `run.json` keeps each step's `browserPages`, and the Run Report lists them under **Pages visited**. Those `🌐` lines, `browserPages`, the Run Report's **Pages visited** list and its tool-call excerpts drop any username, password and `#…` part of an address. The step's full log shows page addresses as the agent saw them. The step's full log is in `.agent-stream/runs/` (git-ignored, on your disk) and keeps what the agent read and did, with page text, full addresses, tool inputs and typed text.
- **What is sent:** everything an agent reads in this browser, including private pages you are logged in to, goes to your AI provider. Page content is marked to the agent as information only, not instructions. Actions ask you first, unless you allowed them on that site for the step, or chose **Allow all for this step**. Screenshots are taken at the page's own size (not doubled on a high-density screen), and a whole-page screenshot stops at 8,000 pixels tall. A screenshot over 3.75 MB (5 MB once encoded for sending) is sent as text instead. A Copilot model that can't take images is told so.
- **Where your logins are:** the profile, with its cookies, is `~/.agent-stream/browser/`, outside every project, so it is never committed; the browser keeps its cookies encrypted as it normally does. Agent Stream controls the browser through a pipe, so no debugging port is opened. Downloads are off in this browser, in your own tabs too. **Agent Stream: Clear Browser Data** closes the browser and deletes that folder, logging you out of every site in it; browser steps still running then see `The browser was closed.` It refuses, and deletes nothing, while another VS Code window has the browser (`The Agent Stream browser is in use by another VS Code window. (lock: <path>)`), while a Chrome is still running on the profile, or if the browser won't close (both: `The Agent Stream browser's profile is still open in another browser window: close it and try again.`).
- **One window at a time:** one VS Code window owns the browser; a browser step in another window fails with `The Agent Stream browser is in use by another VS Code window. (lock: <path>)`, naming the lock file in `~/.agent-stream/browser/`. The browser closes when that window closes. If a browser is still running on the profile, for example after a crash, the step fails with `The Agent Stream browser's profile is still open in another browser window: close it and try again.` If you close the browser under a running step, its next browser tool says `The browser was closed.`
- **Limits:** the element name on the card comes from the page itself, so a hostile page can label a button misleadingly; the screenshot and the exact text to type are on the card too. A page that moves an embedded frame under the pointer at the moment of an approved click can redirect it. What an agent types is kept in the step's local log, as the record of what you approved.
- **Reserved names:** an MCP server Claude loads (from `.mcp.json`, your Claude settings or a plugin) named `agent_stream_browser` or `run_graph` stops a Claude step that uses the browser or the graph tools, with a message asking you to rename it.
- **No evasion:** Agent Stream adds nothing to hide automation. A real browser you logged in to gets past most login walls, but a site may still block automated use, and CAPTCHAs are yours to solve. LinkedIn's terms restrict automated access, so keep to light, human-paced reading there.
- **Not included:** running without a visible window, more than one profile, downloads and file uploads, running code in pages, the planner browsing, and the browser on command steps. Only `http:` and `https:` pages open.

## Sub-graphs

A graph you built once, such as "Company research", can be one step of another graph. Add it with **+ Sub-graph** on the canvas (or the Node panel's **Kind: Sub-graph**), and set its variables on the step: a value may use the outer graph's variables, as `{{ target_company }}`, and an empty one is asked for when the run starts (**Variables** menu). A run runs the inner graph's steps in place of the step, with the same approvals, browser and Stop as any step; the steps after it get the results of its final steps. Double-click the step to go inside: you see and edit the inner graph itself, with that run's statuses and logs, and a breadcrumb back. Editing it changes every graph that uses it. Limits: graphs of the same folder only, 3 levels of nesting, no loops, and a missing or broken inner graph blocks the run. Values you set on a sub-graph step are saved in the graph file (an empty one is asked for when the run starts, and that answer is kept on this machine); Export doesn't bundle the inner graphs, and deleting an inner graph leaves the steps that use it showing "missing graph".

## Graph files

Each graph is a Markdown file, `.agent-stream/graphs/<id>.md`: a Mermaid diagram of the connections and one section per step with its fields, description and prompt or command. It renders on GitHub, diffs cleanly in pull requests, and can be edited by hand or by another AI or script. Save it and the open graph tab follows; a file with errors shows them in the Problems panel and the last good version stays. Open it with **File › Open as Markdown** in the graph tab, the same item on a graph's right-click menu, or **Agent Stream: Open Graph as Markdown**. Positions and bookkeeping live next to it in `<id>.meta.json`. The format, every rule and a full example: [docs/graph-format.md](https://github.com/keith-fajardo/agent-stream/blob/main/docs/graph-format.md).

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
- **No reuse.** A step with a workspace always runs again when it executes in a re-run or retry, in that run's own worktree. **Run only** on another step reuses it as it would any other step.
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

## Settings

- `agentStream.provider` — `claude` (default), `copilot` or `codex`.
- `agentStream.claudePath` — Claude provider only. Claude Code's full path if it isn't found automatically.
- `agentStream.codexPath` — OpenAI Codex provider only. The Codex CLI's full path (`codex`, or `codex.exe` / `codex.cmd` on Windows) if it isn't found automatically.
- `agentStream.gitBashPath` — Windows: Git Bash's full path if it isn't found automatically.
- `agentStream.model` — the model agent steps in runs use, and planner conversations without their own choice (an alias such as `sonnet`, or a full model id). Empty (default): the provider's default (Claude Code's default; Auto on Copilot; Codex's default model on Codex).
- `agentStream.effort` — the effort level for the same: `low`, `medium`, `high`, `xhigh`, `max` or `ultra`. Empty (default): the model's own level. A level the model doesn't offer is left out.
- `agentStream.maxParallel` — how many steps of a run may run at once (default 3). Steps that can change files still take turns within each workspace.
- `agentStream.copilot.maxRequestsPerStep` — GitHub Copilot: the most model requests one agent step may make (default 100, 1–200). A step that reaches it stops with a message naming this setting.
- `agentStream.copilot.maxRequestsPerTurn` — GitHub Copilot: the most model requests one planner chat message may make (default 100, 1–100). A planner message that reaches it stops with a message naming this setting; type continue to pick up where it stopped.
- `agentStream.browser.path` — the full path to Chrome, Edge or Chromium for the Agent Stream browser. Set it in your user settings only: a workspace's value is ignored. Empty (default), relative or missing: Agent Stream looks in the standard install places, Chrome first, then Edge, then Chromium. If none is found, the step fails with `No Chrome, Edge or Chromium found: install one or set agentStream.browser.path.`
- `agentStream.browser.searchEngine` — the search page browser steps use: a web address the URL-encoded query is appended to (default `https://www.google.com/search?q=`).

## Providers

Choose the provider with **Agent Stream: Select Provider** (or click the provider in the status bar), or set `agentStream.provider`. Graph files never name a provider, so a graph built on one provider runs on another. A run keeps the provider it started with; the planner starts a fresh conversation when you switch providers.

### Claude

Agent Stream runs your installed, signed-in Claude Code through the Claude Agent SDK. It never reads or stores your credentials. It removes `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL` and `CLAUDE_CODE_USE_*` from every agent's environment, checks `claude auth status`, and stops any session that reports an API key instead of your subscription. It refuses to run in a project whose `.claude/settings.json` would route Claude elsewhere.

### GitHub Copilot

Agent Stream runs agent steps and the planner on your Copilot plan through VS Code's Language Model API. It doesn't use Copilot's own agent tools: Copilot works through Agent Stream's tools (Read, Grep, Glob, Edit, Write and Bash). So the rules are the same as with Claude:
- every file edit and shell command waits for your approval;
- read-only steps get only Read, Grep and Glob;
- the variable values file and run records stay private.

How Copilot behaves:
- **Models:** the Model menus list the Copilot models that can call tools, with **Auto** first. Copilot's internal models (ids starting with `copilot-`) and models that can't call tools are hidden. **Default** means Auto. A model that is no longer available falls back to Auto, and the step's log says so. Copilot has no effort levels, so the chat's Effort menu hides and a step's Effort reads **Not supported**.
- **Permission:** the first run or chat on Copilot shows VS Code's dialog asking whether Agent Stream may use Copilot. If you decline, the step fails and says how to allow it later (**Accounts › Manage Language Model Access**).
- **Request cap:**
  - Each agent step may make up to `agentStream.copilot.maxRequestsPerStep` model requests (default 100), and each planner message up to `agentStream.copilot.maxRequestsPerTurn` (default 100).
  - The run dialog shows `Copilot requests per step: up to <n>`, and each step's log ends with `Copilot requests: <n> of <cap>`.
  - Whether these requests count against your premium-request quota is not verified, and Agent Stream doesn't track it. Check your Copilot usage page. Each step's log shows how many Copilot requests it used.
- **Long conversations:** when a conversation nears the model's input limit, older turns are summarised in one extra request, which counts toward the cap. If that isn't possible, they are dropped with a note.
- **Planner chat:** the conversation is kept in your session (`.agent-stream/sessions/<id>/transcripts/`), so it continues after a VS Code reload. **New chat** deletes it.

### OpenAI Codex

Agent Stream runs agent steps and the planner on your ChatGPT subscription through your installed Codex CLI (`codex app-server`). It never reads or stores your credentials.

- **What you need:** the Codex CLI, and `codex login` in a terminal, signed in with ChatGPT. If Agent Stream can't find Codex, set `agentStream.codexPath`.
- **What it refuses:** an API-key sign-in. Agent Stream starts Codex with `forced_login_method="chatgpt"` and removes `OPENAI_API_KEY`, `CODEX_API_KEY` and `OPENAI_BASE_URL` from its environment. If Codex still reports an API-key account, the status bar shows `Codex: API key` and runs are refused until you run `codex logout`, then `codex login` and choose ChatGPT.
- **Status:** the status bar shows `Codex (<plan>)`, for example `Codex (Plus)`.
- **Models and effort:** the Model menus list the models Codex offers on your plan. **Default** runs Codex's own default model. The Effort menu offers the levels the model supports, up to `ultra` on some models.
- **Approvals:** Codex asks Agent Stream before every command and file change, and each approval covers that one action only, unless you press **Allow all for this step** on its card.
  - A short list of commands that only read run without asking, like Claude's Read, Grep and Glob: `cat`, `head`, `tail`, `nl`, `wc`, `ls`, `pwd`, `stat`, `grep` (and `egrep`, `fgrep`), `rg`, `find` and `sed -n`, with a few plain options (for example `-n`, `-i`, `-l`). A command with options outside that list, shell operators such as `|`, `;`, `>` or `$`, or anything that touches `.agent-stream` (other than a step reading its upstream `output.md`) asks, or is declined if it would read private files. Writes, other programs and unknown commands ask.
  - File changes show a **Patch** card with each file, what happens to it (add, update or delete) and its diff.
  - Codex's requests for extra permissions are declined, and the step's log says so.
- **Read-only steps** run in Codex's read-only sandbox. Anything that isn't a plain read is declined without asking.
- **Privacy:** reads of the variable values file and of `.agent-stream/runs` and `.agent-stream/sessions` are declined without asking (a step may read its upstream `output.md`).
- **MCP servers:** the MCP servers in your Codex config (yours or the project's) are turned off for Agent Stream's steps and planner, because their tools wouldn't go through approvals. A server named with anything other than letters, digits, `-` and `_` can't be turned off, so Codex isn't started until you rename or remove it. Anything else Codex does that Agent Stream doesn't know shows in the step's log by its type.
- **Codex's built-in extras:** Codex's own apps and plugins, web search, and browser or computer use don't go through Agent Stream's approvals. When a step uses one, its log shows it by type; planner turns don't log them. If you don't want Codex to use them, check your Codex settings.
- **Request cap:** none. Codex runs its own loop; a step is bounded by your plan and by Stop. Each step's log shows its tokens. Usage shows tokens only, with no cost, for a ChatGPT plan.
- **Planner chat:** each conversation is a Codex thread, so it continues after a VS Code reload. **New chat** starts a new thread.
- **Limitation, shell startup files:** Codex runs commands through a login shell (for example `zsh -lc`), so your shell startup files apply. If they export settings such as `RIPGREP_CONFIG_PATH` or `GREP_OPTIONS`, or define aliases, that make `rg` or `grep` search hidden or ignored folders, a search that runs without asking could read past run records. Agent Stream removes those variables from Codex's own environment but can't undo what your startup files set.
- **Windows:** not verified yet. When npm installed Codex, Agent Stream runs `codex.cmd` through `cmd.exe`. How Codex wraps commands on Windows isn't verified, so no read counts as a plain read there yet. In steps that can edit files, every read asks for approval. Read-only steps and the planner may not be able to read files at all until the wrapper is verified: their reads are declined without asking.

## Files it writes

```
<folder>/.agent-stream/
  graphs/<id>.md              the graph, as Markdown (safe to commit)
  graphs/<id>.meta.json       where each step sits on the canvas, who made and changed it (safe to commit; optional)
  graphs/<id>.ops.jsonl       who changed what, and when
  graphs/<id>.baseline.json   your version of the graph while agent changes wait for review
  runs/<run-id>/              run snapshot, per-step events and outputs (git-ignored)
  sessions/<id>/              your work sessions: open tabs, planner chats and Copilot planner transcripts (git-ignored)
```

Older `.claude-stream` folders and values are moved to the new names automatically the first time a folder is opened. Graphs saved as `<id>.json` by earlier versions are converted to `<id>.md` and `<id>.meta.json` the first time a folder is opened; the old file is kept as `<id>.json.bak`, and the Agent Stream output channel lists each conversion. Older planner chats move into a session called Default the first time a folder is opened.

Variable values are kept outside the project, in `~/.agent-stream/values/<hash>.json`, one file per project folder (named after a hash of the folder's path).

The Agent Stream browser's profile, with your logins, is `~/.agent-stream/browser/` (it also holds `agent-stream-owner.json` while a VS Code window has the browser open). Two more folders in your home folder: `~/.agent-stream/locks/` holds one lock file per checkout while a run is changing files there, and `~/.agent-stream/worktrees/<checkout hash>/<run id>/<name>/` holds the variant workspaces runs create (kept until you remove them with Manage Run Workspaces).

## Third-party software

The extension ships [playwright-core](https://github.com/microsoft/playwright) (Apache-2.0) in `dist/vendor/playwright-core/`, with its license and notices, to drive the browser you have installed. It contains no browser.

## License

MIT. See [LICENSE](LICENSE). The extension package also bundles Anthropic's Claude Agent SDK, which is not covered by this license: it is © Anthropic PBC and subject to Anthropic's own terms (https://code.claude.com/docs/en/legal-and-compliance).
