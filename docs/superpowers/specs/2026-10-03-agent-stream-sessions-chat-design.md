# Agent Stream — work sessions and a separate planner chat view

**Date:** 2026-10-03
**Status:** Approved in conversation (sections 1–4); written for review
**Builds on:** `2026-10-02-claude-stream-vscode-design.md` (the extension) and
`2026-10-03-agent-stream-providers-design.md` (providers, whose planner-state section this spec amends)

## 1. Purpose

The user works on several things at once and wants to switch between them. Two changes support this.

1. **Work sessions.**
   - A session is a named set of open graph tabs (with their split layout and order) plus its own planner
     conversations, one per graph.
   - Switching sessions closes the current set of graph tabs and brings back the other session's tabs and
     chats.
   - Sessions are personal and never committed.
2. **A separate planner chat view.** The chat moves out of each graph tab into its own view on the
   right, as Copilot Chat does. It follows the active graph tab and the current session.

Success:
- With two sessions, each holding different graph tabs, switching restores each session's tabs in their
  splits.
- A planner message sent in one session never appears in the other.
- Runs and approvals continue across switches.
- The graph tab gains canvas width, because its right panel is now Node · Graph only.
- Existing chats and planner state carry over into a "Default" session automatically.

## 2. Decisions

| Topic | Decision |
|---|---|
| What a session is | A set of open graph tabs plus its own planner chats per graph |
| Sharing | Personal: git-ignored, like `runs/` |
| Storage | Per workspace folder, in `.agent-stream/sessions/<id>/` (approach A) |
| Multi-root windows | Sessions belong to a folder. Switching affects only that folder's graph tabs |
| Chat placement | Its own "Agent Stream Chat" view on the right (secondary side bar where supported), following the active graph tab |

## 3. Data and storage

### 3.1 Files

```
<folder>/.agent-stream/
  .gitignore                          runs/  +  sessions/      (sessions/ added)
  graphs/<id>.json                    graph definition only (planner fields removed)
  graphs/<id>.ops.jsonl               edit log, shared by all sessions
  sessions/<sessionId>/session.json
  sessions/<sessionId>/chats/<graphId>.chat.jsonl
  runs/…                              unchanged
```

`session.json`:

```json
{
  "id": "default",
  "name": "Default",
  "createdAt": "2026-10-03T09:00:00.000Z",
  "updatedAt": "2026-10-03T09:30:00.000Z",
  "tabs": [{ "graphId": "dbt-parity", "group": 1, "index": 0 }, { "graphId": "release", "group": 2, "index": 0 }],
  "activeGraphId": "dbt-parity",
  "planner": { "dbt-parity": { "sessionId": "…", "provider": "claude", "opCursor": 12 } }
}
```

- **Session IDs.** They are lowercase slugs derived from the name and deduplicated, with the same rules
  as graph IDs (`isSessionId` mirrors `isGraphId`).
- **`group`.** This is the VS Code view column, 1–9. `index` is the tab's position within it.
- **`planner[graphId]`.** This holds the provider's resumable conversation ID, the provider ID and the op
  cursor, which is the length of `<graphId>.ops.jsonl` when this session's last turn started (edits made during a turn are reported in the next one).
- **Writes.** They use the existing atomic write helpers. Session files are written with the same modes as
  other project data.

### 3.2 Graph files lose planner state

`plannerSessionId` and `plannerOpCursor` leave `Graph`. The provider spec's `plannerProvider` moves into
`planner[graphId].provider` (see §8). A graph file now changes only when the graph changes.

### 3.3 Migration (once per folder, on engine start)

- If `sessions/` has no sessions, create `default` ("Default").
- For every graph whose file still holds `plannerSessionId` or `plannerOpCursor`, copy them into
  `default.planner[graphId]` with `provider: 'claude'`, then rewrite the graph file without them.
- Move `graphs/<id>.chat.jsonl` to `sessions/default/chats/<id>.chat.jsonl`.
- Any failure becomes a startup warning, and the old files are left in place. Migration is idempotent,
  so it retries on the next start.
- This runs after the `.claude-stream` → `.agent-stream` folder migration.

### 3.4 Graph operations

| Operation | Sessions |
|---|---|
| Delete graph | Remove `chats/<graphId>.chat.jsonl` and `planner[graphId]` from every session; drop its tabs |
| Rename graph | Nothing (id unchanged) |
| Duplicate / import | New graph starts with no chat in any session |
| Export | Unchanged; never includes sessions or chats |

## 4. Engine

- **`SessionStore`** (`engine/src/sessionStore.ts`). It is owned by the App, one per folder. Its API:
  - `list(): SessionListItem[]`, giving `{ id, name, updatedAt, tabCount, problem? }`. An unreadable
    file is listed with `problem` set and is never overwritten.
  - `get(id)`, `create(name)`, `rename(id, name)`, `duplicate(id)` and `delete(id)`. Duplicate copies
    the tabs but not the chats or planner state.
  - `saveTabs(id, tabs, activeGraphId?)`.
  - `plannerState(id, graphId)` and `setPlannerState(id, graphId, patch)`.
  - `chatLog(id, graphId)`, which returns today's `ChatLog` pointed at the session's file.
  - `removeGraph(graphId)`.
  - `migrateLegacy(graphStore)` (§3.3).
- **`Planner`.** It is keyed by (sessionId, graphId) instead of graphId:
  - the busy state, the chat log, the op cursor and resume all come from the session;
  - "New chat" clears that session's chat file for the graph and its planner state;
  - two sessions can run planner turns on the same graph at once, while one session's turn for a graph
    is exclusive, as today;
  - the user-edits preamble uses that session's op cursor.
- **Deleting a graph while a planner turn is in progress** is refused for every session, as today's
  refusal is.

### 4.1 Protocol changes (`shared/src/types.ts`)

- `graphOpened` no longer carries `chat` or `chatBusy`.
- From the webview to the engine:
  - `openChat { graphId, sessionId }` subscribes the client to that conversation and replaces any
    earlier subscription;
  - `chat { graphId, sessionId, text }`;
  - `newChat { graphId, sessionId }`.
- From the engine to the webview:
  - `chatOpened { graphId, sessionId, chat: ChatEntry[], busy: boolean }`;
  - `chatEntry { graphId, sessionId, entry }` and `chatBusy { graphId, sessionId, busy }`, sent to the
    clients subscribed to that conversation;
  - `sessions { sessions: SessionListItem[] }`, broadcast after any session change.
- From the graph tab to the extension: `draftState { dirty: boolean }`. It is sent when the Node panel
  gains or loses unsaved edits.
- Session management (create, rename, duplicate, delete, saveTabs) goes through `App` methods called
  by the extension, not through webview messages. This is the same pattern as graph management.

## 5. Extension

### 5.1 Active session and the status bar

- **Active session.** There is one per folder, stored in `context.workspaceState` under
  `agentStream.activeSession:<folderKey>`. With nothing remembered, it is the "Default" session if that is readable, otherwise the most recently updated readable session.
- **Status bar.** The item shows `$(layers) <session name>` for the folder of the active graph tab. In a
  single-folder window it uses that folder. Clicking it runs Switch Session.

### 5.2 Tab tracking (`extension/src/sessions.ts`)

- **Listening.** The extension listens to `vscode.window.tabGroups.onDidChangeTabs` and
  `onDidChangeTabGroups`.
- **Graph tabs.** A graph tab is a `TabInputCustom` with `viewType === 'agentStream.graph'` whose URI
  passes `graphTarget`.
- **Saving.** About 500 ms after the last change, it saves each folder's current graph tabs (group,
  index, active) to that folder's active session with `saveTabs`.
- **Ignored tabs.** Non-graph tabs are ignored and never closed.

### 5.3 Switching (`agentStream.switchSession`)

1. If any of this folder's graph tabs reports `draftState.dirty`, ask once: "Discard unsaved step edits
   in N tabs?" If the user says no, stop.
2. Save the current session's tabs, with no debounce.
3. Close this folder's graph tabs with `tabGroups.close`.
4. Set the new active session.
5. Open the target session's tabs with `vscode.openWith(uri, 'agentStream.graph', { viewColumn: group,
   preview: false, preserveFocus: true })`, in index order per group.
6. Focus `activeGraphId`.
7. Skip tabs whose graph no longer exists, and show one notice: "N graphs in this session no longer
   exist and were skipped."

Runs keep running when their tabs close, and their approvals stay in the sidebar and notifications. A
planner turn in progress finishes in the session that started it.

### 5.4 Sessions view and commands

- **Sessions view** (`agentStream.sessions`). It sits between Graphs and Approvals in the Agent Stream
  sidebar and is grouped by folder in multi-root windows.
  - The active session has a `$(check)`. Clicking a session switches to it.
  - Each item's context menu has Rename, Duplicate and Delete.
  - The view title has a New Session button.
  - An unreadable session shows "Can't be read: <reason>" and offers only Delete.
- **Commands:**
  - `agentStream.newSession` asks for a name, creates an empty session and switches to it;
  - `agentStream.switchSession` opens a quick pick of sessions;
  - `agentStream.renameSession`;
  - `agentStream.duplicateSession`;
  - `agentStream.deleteSession`, which confirms first: "Delete <name>? Its planner chats are removed;
    graphs and runs stay."
    - Deleting the active session switches to another one first.
    - Deleting the last session leaves a new empty "Default".

## 6. The chat view

- **Where it lives.** It is a contributed `WebviewViewProvider` with ID `agentStream.chat` and title
  "Chat", in a view container "Agent Stream Chat". The container goes in the secondary side bar if the
  extension's `engines.vscode` floor allows it; the plan verifies this against 1.100. Otherwise it goes
  in the panel. VS Code remembers wherever the user moves it.
- **Following the active graph.** It follows the active graph tab, using `window.tabGroups`
  `activeTab` changes plus the graph panels registry. It sends `openChat` for (that graph, its folder's
  active session).
  - When a non-graph editor becomes active, it keeps the last graph.
  - With no graph tab open in the window, it shows "Open a graph to chat with the planner."
  - After a session switch, it re-subscribes.
- **Header.** It shows the graph name, a session picker (switch session, New Session) and **New chat**.
  New chat confirms ("Start a new conversation? This clears the planner chat for <graph> in <session>."),
  then sends `newChat`.
- **Body.** Today's `ChatPanel` behaviour: entries, tool-call lines, the busy indicator, and an input
  where Enter sends and Shift+Enter adds a new line. The input is disabled with the provider's
  `status.error` when the provider can't run (provider spec).
- **Engine connection.** It connects to the folder's engine like a graph tab: `ready` → `hello` →
  `openChat` → `chatOpened`. Host messages are queued until it has loaded, with the same bridge.
- **Web bundle.** There is still one bundle (`assets/index.js`). The host page sets
  `data-view="graph" | "chat"`, and `main.tsx` mounts the graph app or the chat app. The webview HTML
  and CSP are unchanged apart from the attribute.

### 6.1 Graph tab changes

- **Right panel.** It becomes **Node · Graph**. Chat is removed.
- **View menu.** View › Chat runs `agentStream.chat.focus`.
- **Unsaved edits.** The tab sends `draftState` when the Node panel's draft becomes dirty or clean.

## 7. Error handling

| Situation | Behaviour |
|---|---|
| `session.json` unreadable or invalid | Listed with `problem`; only Delete offered; never overwritten |
| Chat file unreadable | That conversation shows empty plus a warning; the file is left untouched until the user sends a message or starts a new chat |
| A session tab's graph was deleted | Skipped on switch with one notice; removed from the session at the next save |
| Migration (§3.3) fails | Startup warning; old files left in place; retried next start |
| Switch with unsaved step edits | One confirmation; "no" cancels the switch |
| Deleting the active or the last session | Switch first; the last one becomes a fresh "Default" |
| Planner turn in progress when switching | Continues; its reply lands in its own session |

## 8. Amendment to the provider spec

`2026-10-03-agent-stream-providers-design.md` §5 put `plannerProvider` on `Graph`. With sessions, the
planner state lives in `session.json`, as `planner[graphId] = { sessionId, provider, opCursor }`. The
resume rule is unchanged: resume only when `provider` matches the active provider; otherwise start fresh
and post the note. Its tests move to the per-session planner tests. The provider spec is updated to
point here.

## 9. Testing

- **Engine:**
  - `SessionStore`: create, rename, duplicate (tabs only) and delete; the unreadable-file listing;
    `saveTabs`; planner state; `removeGraph`.
  - Migration:
    - legacy planner fields and the chat file move into "Default";
    - the graph file is rewritten without planner fields;
    - running it twice is a no-op;
    - a failure leaves the old files and warns.
  - Planner per (session, graph):
    - separate chats;
    - a session's own op cursor and preamble;
    - concurrent turns in two sessions;
    - New chat;
    - resume only for the same provider.
  - App: delete graph cleans every session; `openChat` subscriptions receive only their conversation.
- **Extension:**
  - Tab capture with a fake `tabGroups`: graph tabs only, debounce, group and index.
  - The switch order: prompt, save, close, open, focus.
  - Multi-root isolation.
  - Skipped missing graphs.
  - Active session persistence.
  - The Sessions view items and every command, including the delete rules.
  - The status bar.
- **Chat view host:**
  - It follows the active graph tab.
  - It keeps the last graph on a non-graph editor.
  - The empty state.
  - Re-subscribing on a session switch.
- **Web:**
  - the chat app: entries, busy, disabled with the provider error, the New chat confirmation;
  - the graph tab without Chat;
  - `draftState` messages;
  - `main.tsx` mode selection.
- **Integration (real VS Code):**
  - open two graphs;
  - create session B with one graph and switch to it, checking that only that tab is open;
  - switch back and check both are restored in their groups;
  - send no real planner messages, but check through the engine that a chat entry written to session A
    isn't in session B.
- **Screenshots:** the chat view beside a graph tab; the Sessions view with two sessions.

## 10. Out of scope

- Sessions spanning several workspace folders, and saving non-graph editor tabs.
- Sharing sessions through git, and exporting sessions or chats.
- Several chat views at once, or a chat per editor group.
- Named chat history within one session (only New chat, which clears).
- Undo for session delete.
