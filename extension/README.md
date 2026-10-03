# Agent Stream

Agent Stream is an independent project. It is not made, endorsed or supported by Anthropic or GitHub.

A VS Code extension where you and an AI planner co-create a workflow as a graph, then run it step by step on your own AI subscription. Agent Stream is **provider-agnostic**: agent steps and the planner run on the provider you choose. Today that is **Claude** (your Claude subscription through Claude Code), with **GitHub Copilot** available as a preview. Every file edit, shell command or other non-read-only action an agent step attempts waits for your approval, whichever provider runs it, and every step keeps its own logs.

## Requirements

- VS Code **1.106** or newer, on macOS or Windows. Linux works the same way as macOS.
- One provider:
  - **Claude:** Claude Code installed and signed in with your Claude account (run `claude`, then `/login`). Check with `claude auth status`.
  - **GitHub Copilot (preview):** the GitHub Copilot extension installed and signed in. Agent Stream detects your Copilot models. Running steps with Copilot comes in a later version.
- Windows only: Git for Windows, which provides Git Bash for command steps.

## Install

Install Agent Stream from the VS Code Marketplace, or from an `agent-stream-<version>.vsix` file: in VS Code run **Extensions: Install from VSIX…** and pick the file.

## Use

- **Agent Stream sidebar:**
  - **Graphs:** New, Import, and right-click for Open, Rename, Duplicate, Export, Delete.
  - **Sessions:** New Session, click to switch, right-click for Rename, Duplicate, Delete.
  - **Approvals:** Approve, Deny, Approve all.
- **Chat view:** the **Agent Stream Chat** view on the right, next to VS Code's own Chat. It shows the planner conversation for the graph tab you're on, in the current session. Describe a goal; the planner reads your repo (read-only) and draws the plan. **New chat** starts over; the session button switches session.
- **Graph tab:** the canvas, the logs of the selected step underneath, and Node · Graph on the right (plus a Changes tab while agent changes wait for review). The menu bar has File, Edit, Run, Variables and View, with View › Chat opening the chat view.
- **Work sessions:**
  - A session is a named set of open graph tabs plus its own planner conversations.
  - Switching a session closes the current graph tabs and brings back the other session's tabs, splits and chats.
  - Sessions are personal: they stay in `.agent-stream/sessions/`, which git ignores.
- **Status bar:** the provider your steps run on (for example `Claude Max` or `Copilot (preview)`) and the current session (`Default`). Click either one to change it.
- **Agent steps** run a separate AI agent with the step's prompt, the goal, the instructions and the outputs of earlier steps. **Command steps** run an exact shell command in the project folder: your login shell on macOS, Git Bash on Windows.
- **Step descriptions:** each step has a plain-language description for people. It shows on the canvas card, and agents get it as context: a step sees its own description as "In short", and later steps see earlier steps' descriptions next to their results. The planner writes one for every step it adds or changes, and you can write or edit it in the Node panel.
- **Refine with planner:** write a step in plain words, then press **Refine with planner** (Node panel, or **Edit › Refine selected step** / **Refine steps you changed**). The planner reads your repository and writes the precise prompt or command, plus a one-line description, for you to review.
- **Agent changes:** the planner, and agent steps during a run, can change the graph. A step agent asks your approval first, showing the exact text that would run, and can only change steps that haven't started. That approval can't be given from a notification or with **Approve all**: you approve each request on its own, after you see its text on the step or in the Approvals view. Approved changes apply to the running run and stay marked on the canvas (`＋` added, `✎` changed, faded ghosts for removed steps) until you **Accept** them into your original graph or **Revert** them in the **Changes** tab. The tab shows each change's before and after and who made it.
- **Variables:** use `{{ name }}` (Jinja) in steps, the goal and the instructions. Values stay on this machine, outside the project, in `~/.agent-stream/values/` (`%USERPROFILE%\.agent-stream\values\` on Windows): they are never committed or exported, and Claude's Read, Grep and Glob tools are refused access to them (a shell command an agent attempts still needs your approval first). A value can read an environment variable: `{{ env_var('DBT_SCHEMA', 'dev') }}`. In commands every value is shell-quoted; `{{ flags | unquoted }}` opts out. A value inside `'…'` or `"…"` is escaped for those quotes. Places where a value can't be quoted safely (after a backtick, `$((`, `${`, `$'`, `$"` or a heredoc, inside a `#` comment or nested quotes, or right after a `\`) are refused with a message that says how to fix the step. Wrap dbt's own Jinja in `{% raw %}…{% endraw %}`.
- **Run:** the dialog shows every command and prompt with values filled in, plus any problem that blocks the run. Start runs exactly what you reviewed.
- **Export / Import:** share a graph's definition (steps, goal, instructions, variable names) as `<name>.agent-stream.json`.

## Settings

- `agentStream.provider` — `claude` (default) or `copilot` (preview).
- `agentStream.claudePath` — Claude provider only. Claude Code's full path if it isn't found automatically.
- `agentStream.gitBashPath` — Windows: Git Bash's full path if it isn't found automatically.
- `agentStream.maxParallel` — how many steps of a run may run at once (default 3).

## Providers

Choose the provider with **Agent Stream: Select Provider** (or click the provider in the status bar), or set `agentStream.provider`. Graph files never name a provider, so a graph built on one provider runs on another. A run keeps the provider it started with; the planner starts a fresh conversation when you switch providers.

### Claude

Agent Stream runs your installed, signed-in Claude Code through the Claude Agent SDK. It never reads or stores your credentials. It removes `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL` and `CLAUDE_CODE_USE_*` from every agent's environment, checks `claude auth status`, and stops any session that reports an API key instead of your subscription. It refuses to run in a project whose `.claude/settings.json` would route Claude elsewhere.

### GitHub Copilot (preview)

Agent Stream finds your Copilot models through VS Code's Language Model API and shows them in the status bar tooltip. In this version Copilot can't run steps or the planner yet: runs and chat explain that and point you back to Claude. Agent Stream sends no requests to Copilot, so VS Code doesn't ask you to allow it yet.

## Files it writes

```
<folder>/.agent-stream/
  graphs/<id>.json            the graph (safe to commit)
  graphs/<id>.ops.jsonl       who changed what, and when
  graphs/<id>.baseline.json   your version of the graph while agent changes wait for review
  runs/<run-id>/              run snapshot, per-step events and outputs (git-ignored)
  sessions/<id>/              your work sessions: open tabs and planner chats (git-ignored)
```

Older `.claude-stream` folders and values are moved to the new names automatically the first time a folder is opened. Older planner chats move into a session called Default the first time a folder is opened.

Variable values are kept outside the project, in `~/.agent-stream/values/<hash>.json`, one file per project folder (named after a hash of the folder's path).
