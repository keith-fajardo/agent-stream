# Agent Stream

Agent Stream is an independent project. It is not made, endorsed or supported by Anthropic, GitHub or OpenAI.

## What Agent Stream is

Agent Stream is a VS Code extension for handing real work to AI agents without taking the result on trust. You and an AI planner build the work as a **graph**: one step per action or scenario, in the order they depend on each other. You read and edit the plan first, then run it step by step.

It is **provider-agnostic**: agent steps and the planner run on your own subscription, whichever you choose. That is **Claude** (through Claude Code), **GitHub Copilot** (through VS Code's Language Model API) or **OpenAI Codex** (through the Codex CLI). Every file edit, shell command or other non-read-only action an agent step attempts waits for your approval, and every step keeps its own logs.

How it works:

1. **Describe a goal** in the Agent Stream chat.
2. **The planner draws a graph**, with one step per action, after reading your repository (read-only).
3. **You review and edit it.** Change, split or refine any step before anything runs.
4. **The steps run on your AI subscription.** Each file edit or command waits for your approval, and every run is recorded, with a Markdown run report you can hand to someone else.

## Use cases

1. **Break a big task into auditable steps.** This is the main use. Instead of one long chat whose result you have to trust, the planner turns the task into steps you can check one at a time, rerun one at a time, and read back later. Every run and edit waits for your approval, and **Export Run Report** saves one Markdown record of what ran, each approval and its decision, each step's output, and the branch, commit, provider and model. *Example:* test a **dbt snapshot (SCD2) model**. The steps check the snapshot table doesn't exist, run `dbt snapshot`, check it now exists, add a new source row, run again, check the row arrived, change the row, and check the old version was closed. It fits migrations and refactors too.
2. **Work on several tickets at once.** Agents that can change files never work on separate tickets in the same checkout. Each ticket runs in its **own Git worktree**, so changes never collide, and each worktree has its own graphs, runs and sessions. *Example:* two bug fixes in the same repository, each in its own worktree and VS Code window, landed one at a time.
3. **Compare scenarios in one graph.** Variants run the same steps in separate **Git worktrees** (variant workspaces), side by side, and a read-only step compares the results. *Example:* run a dbt model on two warehouses and compare cost and runtime.
4. **Research along several dimensions, then synthesize.** The planner splits a question into dimensions, for example market, competitors, pricing and risks. Each dimension is its own research step, read-only steps run side by side, and a final synthesis step combines their outputs into one report. Browser steps reach sources behind a login. Each step keeps its own log, so a claim in the synthesis traces back to the step that found it.
5. **Build reusable workflows.** A graph can be one step of another graph (a sub-graph). *Example:* a "Company research" graph used by several other graphs. Reusable graphs can live in **Shared**, so every session sees them.
6. **Use sites that need a login.** Browser steps use your own logged-in Chrome, Edge or Chromium, with a profile of its own that you log in to yourself. Every click and keystroke asks you first.

## Key ideas

- **Graph:** a plan made of steps and the connections between them. It is saved as a Markdown file in your project, so it diffs cleanly and can be committed.
- **Step:** one unit of work. An **agent step** runs a separate AI agent with its prompt; a **command step** runs an exact shell command; a **sub-graph step** runs another graph.
- **Planner:** the AI that reads your repository (read-only) and draws or changes the graph. It never starts a run unless you ask it to.
- **Approval:** every file edit, shell command or other non-read-only action an agent step attempts waits for you to approve or deny it.
- **Run report:** one Markdown record of a run: what ran, every approval and its decision, each step's output, and where and how it ran.
- **Session:** a named set of open graph tabs plus its own planner conversations. Each graph belongs to one session, and the Graphs list shows the selected session's graphs. Sessions are personal and stay out of Git.
- **Shared:** a group in the Graphs list for graphs every session can see. You move a graph in or out with **Move to Session…**.
- **Provider:** the AI service your steps and the planner run on: Claude, GitHub Copilot or OpenAI Codex.

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

## Quick start

1. Open a folder in VS Code, then the **Agent Stream** sidebar. Make sure your provider is signed in: the status bar shows the provider your steps run on, and clicking it changes it.
2. In the **Agent Stream Chat** view, next to VS Code's own Chat, describe a goal. The planner reads your repo (read-only) and draws the plan in a graph tab. You can also add steps yourself, or write a step in plain words and press **Refine with planner**.
3. Review the plan. Edit a step in the Node panel, or press **Split into steps** to break one step into several.
4. Run the graph. The run dialog shows every command and prompt with its values filled in; starting runs exactly what you reviewed.
5. Approve or deny each file edit or command in the **Approvals** view as it comes. **Allow all for this step** stops one step asking for the rest of its run.
6. When it finishes, open **Run › Export Run Report…** for one Markdown record of the run. If a run stopped or failed, **↻ Retry from where it stopped** reuses the steps that already worked.

## Learn more

- [Using Agent Stream](https://github.com/keith-fajardo/agent-stream/blob/main/docs/using.md): the sidebar, chat, models and effort, attachments, work sessions, variables, runs and retries, the run report, sub-graphs and graph files.
- [The Agent Stream browser](https://github.com/keith-fajardo/agent-stream/blob/main/docs/browser.md): steps that use your own logged-in browser.
- [Parallel tickets and A/B tests](https://github.com/keith-fajardo/agent-stream/blob/main/docs/parallel-and-ab.md): Git worktrees per ticket, variant workspaces, and comparing scenarios.
- [Settings](https://github.com/keith-fajardo/agent-stream/blob/main/docs/settings.md)
- [Providers](https://github.com/keith-fajardo/agent-stream/blob/main/docs/providers.md): Claude, GitHub Copilot and OpenAI Codex.
- [Files it writes](https://github.com/keith-fajardo/agent-stream/blob/main/docs/files.md)
- [Graph file format](https://github.com/keith-fajardo/agent-stream/blob/main/docs/graph-format.md)

## Third-party software

The extension ships [playwright-core](https://github.com/microsoft/playwright) (Apache-2.0) in `dist/vendor/playwright-core/`, with its license and notices, to drive the browser you have installed. It contains no browser.

## License

MIT. See [LICENSE](LICENSE). The extension package also bundles Anthropic's Claude Agent SDK, which is not covered by this license: it is © Anthropic PBC and subject to Anthropic's own terms (https://code.claude.com/docs/en/legal-and-compliance).
