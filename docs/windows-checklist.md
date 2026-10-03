# Windows checklist

Run on a Windows machine with Claude Code installed and signed in, and Git for Windows installed. Install the `.vsix` with **Extensions: Install from VSIX…**, then open a folder.

1. The Agent Stream sidebar and the status bar show your signed-in Claude plan.
2. Import a graph exported on a Mac (sidebar › Import). Its variables show as "not set" in the Variables menu; set them.
3. Set a value, then check it is stored in `%USERPROFILE%\.agent-stream\values\` and that the project folder has no values file.
4. Run an agent step that edits a file. The approval appears on the step, in the sidebar's Approvals, and as a notification when the tab isn't visible. Approving works.
5. Run a command step that uses a `{{ }}` value containing a space and a `'`. The run dialog shows the quoted command, and the step runs in the project folder (add `pwd` to check).
6. Use `{{ env_var('USERNAME') }}` in a step, then `{{ env_var('NOT_SET_ANYWHERE') }}`: the second shows a problem in the run dialog.
7. Run a command step `sleep 600` and press Stop. The step stops, and Task Manager shows no `bash.exe` or `sleep.exe` left from it.
8. Set `agentStream.gitBashPath` to a path that doesn't exist. The run dialog of a graph with command steps explains the problem. Clear the setting afterwards.

Report anything that differs, with the step number and a screenshot.
