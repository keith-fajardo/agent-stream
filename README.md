# claude-stream

A local web app where you and a Claude planner co-create a workflow as a graph, then run it step by step on your Claude subscription. Every agent action waits for your approval, and every step keeps its own logs.

## Requirements

- Node.js 20.11 or newer
- Claude Code, installed and signed in with your Claude account (run `claude`, then `/login`). Check with `claude auth status`.

## Install

```bash
npm install
npm run build
npm link          # puts the `claude-stream` command on your PATH
```

## Use

```bash
claude-stream ~/path/to/your/repo            # opens the page in your browser
claude-stream . --port 4400 --max-parallel 2 --no-open
```

- **Chat (right panel):** describe a goal. The planner reads your repo (read-only) and draws the plan on the canvas.
- **Canvas:** double-click to add a step, drag between handles to connect, Delete to remove. Steps the planner wrote are marked "by agent" until you edit them.
- **Agent steps** run a separate Claude agent with the step's prompt plus the outputs of the steps before it. **Command steps** run an exact shell command in the project folder.
- **Run:** the confirmation dialog lists every command that will run. Agent steps ask before every file edit or shell command (Approvals tab).
- **Logs:** select a step, then Node → Logs. Each agent log starts with the exact prompt it received.
- **Re-run from here:** reruns a step and everything after it, reusing earlier results that are still valid.

## Your Claude subscription

claude-stream runs your installed, signed-in `claude` program through the Claude Agent SDK. It never reads or stores your credentials. It removes `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` from every agent's environment, checks `claude auth status` at startup, and stops any session that reports an API key instead of your subscription. Parallel steps use your plan's usage limits faster; `--max-parallel` (default 3) caps them.

This is a personal tool: anyone else who runs it uses their own Claude Code login on their own machine.

## Files it writes

```
<repo>/.claude-stream/
  graphs/<name>.json        the graph (safe to commit)
  graphs/<name>.ops.jsonl   who changed what, and when
  graphs/<name>.chat.jsonl  planner conversation
  runs/<run-id>/            run snapshot, per-step events and outputs (git-ignored)
```

## Safety

- The server listens on 127.0.0.1 only and requires the token in the URL it prints (exchanged for a cookie).
- Command steps run exactly as written with your shell environment, after you confirm the run.
- Agent steps can't start sub-agents and wait for you before any edit, write, or shell command.

## Development

```bash
npm test                      # all unit tests
npm run typecheck
npm run dev -w web            # rebuild the UI on change
CLAUDE_STREAM_LIVE=1 npm test -w server -- live   # real Claude, small plan usage
```
