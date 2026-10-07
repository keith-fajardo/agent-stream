# Providers

Choose the provider with **Agent Stream: Select Provider** (or click the provider in the status bar), or set `agentStream.provider`. Graph files never name a provider, so a graph built on one provider runs on another. A run keeps the provider it started with; the planner starts a fresh conversation when you switch providers.

## Claude

Agent Stream runs your installed, signed-in Claude Code through the Claude Agent SDK. It never reads or stores your credentials. It removes `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL` and `CLAUDE_CODE_USE_*` from every agent's environment, checks `claude auth status`, and stops any session that reports an API key instead of your subscription. It refuses to run in a project whose `.claude/settings.json` would route Claude elsewhere.

## GitHub Copilot

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

## OpenAI Codex

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
