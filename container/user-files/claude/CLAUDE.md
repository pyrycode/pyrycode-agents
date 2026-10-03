# Shared Git policy

Applies to interactive Claude Code and Codex work across projects.

Do not force-push, including force-with-lease or a force refspec. Do not perform hard resets or discard uncommitted changes through checkout, switch, restore, or equivalent commands. Do not force-delete branches, drop or clear stashes, or delete untracked files with Git clean.

Use non-destructive alternatives. If a requested task requires one of these operations, explain what would be lost and let the user perform it. Do not work around the restriction with alternate flags, aliases, scripts, direct Git file edits, or another tool.

Normal commits, branch creation, non-forced deletion of merged branches, merges, and ordinary pushes remain available when authorized by the task. Unstaging changes while retaining working files is allowed. Inspecting what Git clean would remove with a dry run is allowed. Check the current branch before staging, committing or pushing.

This policy does not introduce a blanket ban on ordinary file deletion. Preserve user changes and follow the task's scope.

Keep a live checkout on main. A checkout is live when a running process reads from it, such as an agents repository whose dispatcher loads role instructions from it. Do task work for it in a separate worktree or clone. Never switch a live checkout's branch or leave uncommitted edits in it. Claude Code and Codex share one set of branches. Both branch from main for a task and merge back to main, and neither keeps a branch of its own.

Codex has additional command-prefix rules in ~/.codex/rules/git-safety.rules. They cover common forms outside the sandbox, not every equivalent invocation. The shared policy applies regardless of command spelling or execution location.
