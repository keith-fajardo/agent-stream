# Claude Stream

Claude Stream is an independent project. It is not made, endorsed or supported by Anthropic.

A VS Code extension where you and a Claude planner co-create a workflow as a graph, then run it step by step on your Claude subscription. Every file edit, shell command or other non-read-only action an agent step attempts waits for your approval, and every step keeps its own logs.

## Requirements

- VS Code 1.100 or newer, on macOS or Windows (Linux works the same way as macOS).
- Claude Code, installed and signed in with your Claude account (run `claude`, then `/login`). Check with `claude auth status`.
- Windows only: Git for Windows, which provides Git Bash for command steps.

## Install

Install Claude Stream from the VS Code Marketplace, or from a `claude-stream-<version>.vsix` file: in VS Code run **Extensions: Install from VSIX…** and pick the file.

## Use

- **Claude Stream sidebar:** Graphs (New, Import, and right-click for Open, Rename, Duplicate, Export, Delete) and Approvals (Approve, Deny, Approve all). The status bar shows which Claude plan runs your steps.
- **Graph tab:** the canvas, the logs of the selected step underneath, and Chat · Node · Graph on the right. The menu bar has File, Edit, Run, Variables and View.
- **Chat:** describe a goal; the planner reads your repo (read-only) and draws the plan.
- **Agent steps** run a separate Claude agent with the step's prompt, the goal, the instructions and the outputs of earlier steps. **Command steps** run an exact shell command in the project folder: your login shell on macOS, Git Bash on Windows.
- **Variables:** use `{{ name }}` (Jinja) in steps, the goal and the instructions. Values stay on this machine, outside the project, in `~/.claude-stream/values/` (`%USERPROFILE%\.claude-stream\values\` on Windows): they are never committed or exported, and Claude's Read, Grep and Glob tools are refused access to them (a shell command an agent attempts still needs your approval first). A value can read an environment variable: `{{ env_var('DBT_SCHEMA', 'dev') }}`. In commands every value is shell-quoted; `{{ flags | unquoted }}` opts out. A value inside `'…'` or `"…"` is escaped for those quotes. Places where a value can't be quoted safely (after a backtick, `$((`, `${`, `$'`, `$"` or a heredoc, inside a `#` comment or nested quotes, or right after a `\`) are refused with a message that says how to fix the step. Wrap dbt's own Jinja in `{% raw %}…{% endraw %}`.
- **Run:** the dialog shows every command and prompt with values filled in, plus any problem that blocks the run. Start runs exactly what you reviewed.
- **Export / Import:** share a graph's definition (steps, goal, instructions, variable names) as `<name>.claude-stream.json`.

## Settings

- `claudeStream.claudePath` — Claude Code's full path if it isn't found automatically.
- `claudeStream.gitBashPath` — Windows: Git Bash's full path if it isn't found automatically.
- `claudeStream.maxParallel` — how many steps of a run may run at once (default 3).

## Your Claude subscription

Claude Stream runs your installed, signed-in Claude Code through the Claude Agent SDK. It never reads or stores your credentials. It removes `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL` and `CLAUDE_CODE_USE_*` from every agent's environment, checks `claude auth status`, and stops any session that reports an API key instead of your subscription. It refuses to run in a project whose `.claude/settings.json` would route Claude elsewhere.

## Files it writes

```
<folder>/.claude-stream/
  graphs/<id>.json            the graph (safe to commit)
  graphs/<id>.ops.jsonl       who changed what, and when
  graphs/<id>.chat.jsonl      planner conversation
  runs/<run-id>/              run snapshot, per-step events and outputs (git-ignored)
```

Variable values are kept outside the project, in `~/.claude-stream/values/<id>.json`, one file per project folder.
