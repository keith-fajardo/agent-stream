# Agent Stream — headless runner and triggers (design)

Date: 2026-10-22. Status: proposed, awaiting review. Decisions marked **(open)** still need the user's call.

## 1. Purpose and decisions

The user wants Agent Stream to work like n8n for AI agents: a graph is a workflow that runs on its own when something happens, not only when someone presses Run in VS Code.

Agent Stream already has the workflow half. A graph is a DAG of agent, command, sub-graph, condition and stop steps; the runner starts a step once its parents finish, up to `maxParallel`, and passes upstream outputs into downstream prompts. What it lacks:

1. **A host outside VS Code.** Runs only start from the extension.
2. **Triggers.** Nothing starts a run on a schedule or an event.
3. **Unattended approvals.** Every non-read-only action waits for a click in the Approvals view.
4. **Somewhere to report.** A run that nobody is watching needs to tell someone how it went.

This spec covers those four. Integrations, structured outputs, fan-out and retries are later phases (§8).

**Success:** on a Linux server with no VS Code, `agent-stream serve` reads a project's graphs. A graph with a `cron` trigger runs at that time; a graph with a `webhook` trigger runs when its URL is called with the right token, its JSON body filling the graph's variables. Approvals follow the graph's policy: allowed actions run, anything else is sent to Telegram and waits there, or is denied. Each run writes the same run report as today and posts a summary when it ends. The same graph still opens, edits and runs in VS Code unchanged.

Proposed decisions:

- **The engine is the product; VS Code and the server are two hosts of it.** The engine already has no `vscode` import. The headless host is a new package, `cli/`, that calls `createApp` the way `extension/src/engines.ts` does.
- **Triggers and approval policy live in the graph file**, so they are reviewed, diffed and committed with the steps they start. Secrets never do.
- **Unattended means the policy decides, never the model.** An action the policy doesn't cover is asked (on Telegram) or denied, never allowed by default.
- **v1 providers headless: Claude and Codex.** Copilot runs through VS Code's Language Model API and can't run outside VS Code.

## 2. Graph model and file format

### New section: `## Triggers`

One trigger per bullet. Optional; a graph without it runs only by hand, as today.

````markdown
## Triggers

- `nightly`: cron `40 1 * * *` tz `Asia/Manila`
- `new-lead`: webhook
````

- **Name:** same rules as a variable name. A name listed twice is an error.
- **cron:** a standard 5-field expression in backticks, with an optional `tz` (IANA zone). Missing `tz` means the server's zone.
- **webhook:** the server exposes `POST /hooks/<graph id>/<trigger name>`. The token is not in the file (§4).
- Graphs from before this section load unchanged. Earlier versions report `## Triggers` as a step with no code block, so a graph file that uses it needs this version.

### New section: `## Policy`

How approvals are decided when nobody is at VS Code. Ignored in VS Code, where the user decides as today.

````markdown
## Policy

- unattended: ask
- allow: command `dbt *`
- allow: edit `models/**`
- deny: command `git push*`
````

- **`unattended`**: what happens to an action no rule covers: `ask` (send it to the approval channel and wait), `deny`, or `stop` (deny it and stop the run, fail-fast). Default `deny`.
- **Rules** are `allow` or `deny`, a tool class (`command`, `edit`, `browser`, `graph-change`) and a glob on the command line or file path. The first matching rule wins. A `deny` rule always beats `unattended`.
- **No "allow everything" rule.** `allow: command *` is an error, so a graph can't quietly become fully unattended. **(open)** whether to allow it behind an explicit `- unattended: yes-i-mean-it`.
- Read-only actions need no rule, as today.

### Variables from a trigger

- **webhook:** each top-level field of the JSON body whose name is a graph variable fills that variable. Other fields are ignored. The whole body is also available as `{{ trigger.body }}`.
- **cron:** variables come from the project's values file, as a run from VS Code uses.
- A variable still empty after that fails the run before any step starts, with the variable named. The server never prompts.
- `trigger` becomes a reserved word, like a step id: `{{ trigger.name }}`, `{{ trigger.firedAt }}`, `{{ trigger.body }}`.

## 3. The headless host (`cli/` package)

Commands:

- `agent-stream run <graph> [--var k=v]…`: one run now, in the foreground; the exit code is 0 for `succeeded`, 1 for `failed`, 2 for `stopped`, 3 for `cancelled`. Useful in CI and from a plain system cron.
- `agent-stream serve [--port 8787]`: the long-running host with triggers, the webhook server and the approval channel.
- `agent-stream check`: parses every graph, lists triggers and policies and their problems, and checks the provider is signed in. Nothing runs.

How it reuses the engine:

- `createApp(AppDeps)` with `projectDir`, `provider` (`createClaudeProvider` or `createCodexProvider`), `git: realGit`, `home`, `valuesFile: valuesFileFor(projectDir)` and `maxParallel` from a config file.
- **The Client** (`Client.send`) is a logger: run and step events go to stdout as JSON lines and to the run store, as now.
- **Write leases** already use lock files under the home folder, so a server run and a VS Code window on the same machine and checkout block each other correctly. On a server the checkout should be its own clone.
- **No browser in v1** (`browser` absent). A step with `browser: on` fails at start with "this host has no browser". **(open)** headless Chromium with a stored profile.
- Config: `~/.agent-stream/server.json` holds the project folders served, the port, the provider, `maxParallel`, the notification channel and its credentials. Never in the project.

## 4. Triggers at run time

- **Scheduler:** on start and whenever a graph file changes, the host reads every graph's triggers. Cron uses an in-process scheduler; a fire while the same graph is still running is **skipped and logged**, not queued. **(open)** queue-one instead.
- **Missed fires** while the host was down are not replayed.
- **Webhook:** `POST /hooks/<graph id>/<trigger name>` with header `Authorization: Bearer <token>`. Tokens are generated per trigger by `agent-stream token <graph> <trigger>` and stored hashed in `server.json`. Wrong or missing token: 401, logged. The body is limited to 1 MB of JSON. The reply is `202 { runId }` at once; the run goes on after the reply.
- **Commit pinning:** a triggered run uses the graph as it is in the working tree when it fires, and records the commit, as runs already do. **(open)** whether the server should `git pull` before each fire.

## 5. Approvals without a person at VS Code

The runner already sends every request through `ApprovalBroker.request` and waits on its decision. The host adds a **policy decider** that listens to the broker's `changed` event:

1. A rule matches → `broker.decide(id, approve | deny)`, logged on the step as `auto: true` with the rule's line, so the run report shows which rule allowed it.
2. No rule and `unattended: ask` → the card goes to the approval channel. The first answer decides it. No answer within `askTimeout` (default 30 minutes) → deny.
3. No rule and `unattended: deny` or `stop` → deny (and for `stop`, the run is stopped with fail-fast).

**Approval channel, v1: Telegram.** A message per request with the run, step, tool and input, and **Approve** / **Deny** buttons. Only the chat id in `server.json` may answer. "Allow all for this step" is not offered remotely in v1.

## 6. Notifications and the run report

- When a run ends, the host posts one message to the channel: graph, trigger, status, duration, and the steps that failed or were skipped, with the path to the run report.
- The run report gains a **Trigger** line (name, kind, fire time) and a **Policy** line per auto-decided approval.

## 7. Safety

- Graph files can come from a pull request. A triggered run therefore runs whatever is committed: the README must say a served project should only take changes the user reviewed.
- Webhook bodies fill variables, and variables go into prompts and commands. Command steps already shell-quote every variable value (`templates.ts`), which protects how the shell parses the line but not commands that re-parse it (`eval`, `sh -c`); this spec changes nothing there, and `{{ trigger.body }}` is only allowed in agent prompts, not command steps.
- **(open)** Running Claude Code unattended on a subscription: check the provider's terms for automated use before shipping, and consider an API-key provider for the server host.

## 8. Later phases (not in this spec)

1. **MCP tool step** (`kind: tool`): calls one tool of a configured MCP server with templated arguments, no model call. The cheapest path to n8n-style integrations (Slack, Sheets, HTTP, databases).
2. **Structured outputs:** an agent step may declare a JSON schema; downstream templates read fields, as in `{{ n2.json.score }}`. Conditions gain `-->|case|` labels beyond yes/no.
3. **Fan-out:** `kind: each` runs a sub-graph once per item of a list output, with `maxParallel`.
4. **Retries and error paths:** `retries` and `backoff` fields, and an `-->|error|` edge.
5. **A web UI for the server:** runs, approvals and reports in a browser, reusing `web/`.

## 9. Testing

- Engine: unchanged code paths; new tests for the `## Triggers` and `## Policy` parsers and writers, and for the `trigger.*` reserved names.
- Policy decider: unit tests with a fake broker for first-match, deny-beats-unattended, ask timeout and `stop`.
- Host: `agent-stream run` against the existing fake providers (`codexFake.ts`) and a temp git repo; webhook auth and body-to-variables with a local server; cron with a fake clock.
- Lease interplay: a VS Code-style lease held on the checkout blocks a triggered write step, which waits as today.
