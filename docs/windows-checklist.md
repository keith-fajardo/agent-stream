# Windows checklist

Run on a Windows machine with Claude Code installed and signed in, and Git for Windows installed. Install the `.vsix` with **Extensions: Install from VSIX…**, then open a folder.

1. The Agent Stream sidebar and the status bar show your signed-in Claude plan.
2. Run **Agent Stream: Select Provider** and choose GitHub Copilot. The status bar shows `Copilot (preview)` or `Copilot not available`, Run is refused with the Copilot message, and Chat is disabled with it. Switch back to Claude; the status bar shows your plan again.
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

Report anything that differs, with the step number and a screenshot.
