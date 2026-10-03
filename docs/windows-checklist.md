# Windows checklist

Run on a Windows machine with Claude Code installed and signed in, and Git for Windows installed. Install the `.vsix` with **Extensions: Install from VSIX…**, then open a folder.

1. The Agent Stream sidebar and the status bar show your signed-in Claude plan.
2. Run **Agent Stream: Select Provider** and choose GitHub Copilot. Without a signed-in Copilot, the status bar shows `Agent Stream: Copilot not available` and Run is refused with that message. With one, it shows `Copilot`, and its tooltip lists the models. Switch back to Claude; the status bar shows your plan again.
3. Create a second session from the Sessions view with one graph open in a split, switch back and forth: the right tabs and splits come back each time.
4. Open the Agent Stream Chat view: it follows the active graph tab; New chat asks first, then clears that conversation only.
5. Import a graph exported on a Mac (sidebar › Import). Its variables show as "not set" in the Variables menu; set them.
6. Set a value, then check it is stored in `%USERPROFILE%\.agent-stream\values\` and that the project folder has no values file.
7. Run an agent step that edits a file. The approval appears on the step, in the sidebar's Approvals, and as a notification when the tab isn't visible. Approving works.
8. Write a step in plain words and press **Refine with planner**: the planner writes a detailed prompt and a one-line description, and the step shows `✎ planner`; **Accept** it in the Changes tab and the mark goes away.
9. In a run, ask an agent step to add a workaround step: the approval shows the exact command; the notification offers no Approve and Approve all skips it, so approve it on the step; then the new step runs in this run, marked `＋ n… · run …` on the canvas.
10. Run a command step that uses a `{{ }}` value containing a space and a `'`. The run dialog shows the quoted command, and the step runs in the project folder (add `pwd` to check).
11. Use `{{ env_var('USERNAME') }}` in a step, then `{{ env_var('NOT_SET_ANYWHERE') }}`: the second shows a problem in the run dialog.
12. Run a command step `sleep 600` and press Stop. The step stops, and Task Manager shows no `bash.exe` or `sleep.exe` left from it.
13. Set `agentStream.gitBashPath` to a path that doesn't exist. The run dialog of a graph with command steps explains the problem. Clear the setting afterwards.

**Parallel tickets and workspaces.** Use a Git repository with at least one commit and no uncommitted changes.

14. **Checkout chip.** The graph tab's top bar shows `⎇ <branch>`, and its tooltip shows the repository root with the drive letter. Open a folder that isn't a Git repository: the chip says `Not a Git repository`.
15. **Set Up Parallel Tickets.** Run it with two tickets (for example `ABC-1 Fix login` and `ABC-2 Add export`) and keep **Next to the repo**.
    - Two folders appear next to the repository, `<repo>-abc-1-fix-login` and `<repo>-abc-2-add-export`.
    - `git worktree list` shows them on branches `feat/abc-1-fix-login` and `feat/abc-2-add-export`.
    - Each has a starter graph in `.agent-stream\graphs\`.
16. **Opening a ticket.** Use **Open in New VS Code Window…** to open one ticket.
    - The new window's chip shows `⎇ feat/abc-1-… · worktree <folder>`.
    - Its Sessions and runs start empty.
    - Its values file in `%USERPROFILE%\.agent-stream\values\` is separate from the main repository's.
17. **Set Up refusals.**
    - Run Set Up Parallel Tickets again with the same two tickets. It refuses, listing the existing branches and folders, and creates nothing.
    - Modify a tracked file and run it with new tickets. It refuses with the uncommitted-changes message.
    - Undo the change afterwards.
18. **Write lease.** Open the main repository in two VS Code windows. In window 1, start a graph with a command step `sleep 60`. In window 2, start a graph with a command step.
    - Window 2 shows **Can't start yet**, naming the run "in another VS Code window".
    - While window 1's run is going, a lock file exists in `%USERPROFILE%\.agent-stream\locks\`.
    - Choose **Run after it finishes**. Window 2's step starts within a few seconds of window 1's run ending, and the lock file is gone after both runs end.
19. **Read-only step.** Mark an agent step **Read-only** and ask it to edit a file. The edit is refused without an approval prompt, and the step reports it.
20. **A/B workspaces.** Run **New A/B Test Graph** with variants `wh_small` and `wh_large`.
    - Set `setup_command` to `echo setup` and `run_wh_small` / `run_wh_large` to `pwd && sleep 20`, then run it.
    - Both run steps run at the same time.
    - Each `pwd` prints its own folder under `%USERPROFILE%\.agent-stream\worktrees\`.
    - The logs header shows `workspace <name> · <path>`.
21. **Manage Run Workspaces.**
    - **Open in New VS Code Window** opens a variant.
    - **Create Branch Here** creates the branch: check with `git branch` in the main repository.
    - **Remove** removes it, so it's gone from `git worktree list`.
    - Edit a file in the other variant, then Remove it. You're asked first.
22. **Clean up.** Remove the two ticket worktrees with `git worktree remove <path>` and delete their branches with `git branch -D`.

**GitHub Copilot.** Use a VS Code signed in to GitHub Copilot, and a Git repository you can change. Select GitHub Copilot with **Agent Stream: Select Provider**.

23. **Consent.** The status bar tooltip says `Copilot will ask for permission the first time a run or chat uses it.` When you start the run in step 24, VS Code asks whether Agent Stream may use Copilot. Choose Allow.
24. **Two-step graph.** Make a graph with an agent step "Add a line `hello` to notes.txt" (Can edit files), followed by an agent step "Run `git status` with Bash and report what it says". Run it.
    - The run dialog shows `Copilot requests per step: up to 100`.
    - The first step asks for approval before its Edit or Write. Approve it, and `notes.txt` changes.
    - The second step asks before its Bash call. Approve it. Its log shows the tool call, the result ending with `exit code 0`, and the model's summary.
    - Each step's log ends with `Copilot requests: <n> of 25`.
25. **Deny.** Re-run from the first step and deny its edit. Its log shows `Denied by the user.`, and `notes.txt` is unchanged.
26. **Stop.** Ask an agent step to run `sleep 600` with Bash, approve it, then press Stop. The step is cancelled, and Task Manager shows no `bash.exe` or `sleep.exe` left from it.
27. **Planner chat.** In the chat, ask the planner to add a step; it appears on the canvas.
    - Reload the window (**Developer: Reload Window**) and ask a follow-up about that step. The planner answers with the earlier conversation in mind.
    - Press **New chat**. The next message starts fresh.
28. **Request cap.** Set `agentStream.copilot.maxRequestsPerStep` to 1 and run a step that needs to read a file. It stops with `Stopped after 1 Copilot requests (agentStream.copilot.maxRequestsPerStep). Raise the setting to let steps run longer.` Reset the setting afterwards.
29. **Effort.** The run dialog's Model line reads `Effort: not supported`, whatever `agentStream.effort` is set to.

Report anything that differs, with the step number and a screenshot.
