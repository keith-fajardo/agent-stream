# Files it writes

```
<folder>/.agent-stream/
  graphs/<id>.md              the graph, as Markdown (safe to commit)
  graphs/<id>.meta.json       where each step sits on the canvas, who made and changed it (safe to commit; optional)
  graphs/<id>.ops.jsonl       who changed what, and when
  graphs/<id>.baseline.json   your version of the graph while agent changes wait for review
  runs/<run-id>/              run snapshot, per-step events and outputs (git-ignored)
  sessions/<id>/              your work sessions: open tabs, planner chats and Copilot planner transcripts (git-ignored)
  sessions/graph-homes.json   which session, or Shared, each graph belongs to (git-ignored)
```

Older `.claude-stream` folders and values are moved to the new names automatically the first time a folder is opened. Graphs saved as `<id>.json` by earlier versions are converted to `<id>.md` and `<id>.meta.json` the first time a folder is opened; the old file is kept as `<id>.json.bak`, and the Agent Stream output channel lists each conversion. Older planner chats move into a session called Default the first time a folder is opened.

Variable values are kept outside the project, in `~/.agent-stream/values/<hash>.json`, one file per project folder (named after a hash of the folder's path).

The Agent Stream browser's profile, with your logins, is `~/.agent-stream/browser/` (it also holds `agent-stream-owner.json` while a VS Code window has the browser open). Two more folders in your home folder: `~/.agent-stream/locks/` holds one lock file per checkout while a run is changing files there, and `~/.agent-stream/worktrees/<checkout hash>/<run id>/<name>/` holds the variant workspaces runs create (kept until you remove them with Manage Run Workspaces).
