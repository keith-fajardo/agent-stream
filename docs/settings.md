# Settings

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
