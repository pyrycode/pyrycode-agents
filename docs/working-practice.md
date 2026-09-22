# Shared development practice

This file applies to every Pyrycode pipeline role. It supplements the role prompt.
It does not grant permission to edit paths the role forbids.

## Knowledge

Read the target repository's `docs/knowledge/INDEX.md` and the topic relevant to
the ticket. Search the full catalog only when needed. Claude local memory is
disabled. Do not read or write it, and do not use the historical archive as
current instructions.

Builders record durable discoveries in the PR's Lessons learned section.
Verifiers record them in review comments. Refiners and product owners record them
on the issue, including work that ends without a PR. Link the finding from any
child that continues the work. Product lessons are folded into the owning topic
by the documentation stage. Workflow lessons are folded into this file or the
dispatcher docs by their maintainer. Do not create a second private note.

## Scope and sizing

Ask what the user can do differently before plumbing a descriptive identifier.
Do not imply capabilities that the identifier does not establish.

Read a merged blocker's code and its production call sites before trusting the
dependent ticket's forecast. The blocker can leave one caller unwired or already
have completed the dependent's proof. Check both possibilities.

Count constructors, narrow interfaces and test doubles before sizing a type change.
Compare the nearest shipped change of the same kind. Separate inserted lines from
deleted lines, and restrict the comparison to the new ticket's actual scope.
Recalculate measurements rather than copying old ticket estimates. Use the current
role's size limits, not thresholds in historical notes.

Dependency links and parent-child links are different. Check actual parentage for
split depth. A missing parent link can hide a descendant, while several blockers
do not make a root ticket a grandchild. Repair recorded lineage before using it as
a gate input. Follow the current split rules after that check.

## Review routing

Read security and routing labels from the issue, not the PR. Keep the two numbers
separate: PR for diff and comments, issue for labels and plan identity.

The pipeline uses one GitHub identity. GitHub cannot accept that author's approval
or change-request review on its own PR. Post the verdict as a PR comment and apply
the issue labels required by the role. Do not retry an impossible self-review.

Mechanical gates belong to the dispatcher as specified in the role prompt. Read
executed counts and failure evidence. A one-test baseline can omit a fixture-writing
sibling from the branch's full run. Compare the inputs and suite composition before
attributing a failure to the change. Search existing issues before filing another.

## Source and evidence checks

Use the target's `docs/knowledge/features/development-verification.md` when sizing,
building or reviewing code. It covers source-search limitations, validation boundaries,
protocol tests, capture evidence and artifact survival. Read the relevant section,
not the whole historical memory archive. Current code wins over an old observation.


## Codex approval rules on the MacBook

Juhana approved persistent Pyrycode reads, comment changes and any label edits
on 2026-09-11. Write helpers enforce `pyrycode/pyrycode`. Direct read rules match command prefixes only.
New Codex processes load them. Start a fresh process after a rules change.

For direct GitHub commands, put the repository option immediately after the
subcommand and before the issue or PR number. This order matches the rules:

```bash
gh issue view --repo pyrycode/pyrycode 2271 --json title,body,labels
gh pr view --repo pyrycode/pyrycode 2339 --json title,body,files
gh pr diff --repo pyrycode/pyrycode 2339
```

The same order applies to issue list/status and PR list/status/checks.
If the sandbox blocks the connection, request escalated execution for the same
repository-scoped command. These installed allow rules cover that request.
Do not override the repository with a second option or use shell substitutions.

The helper `/Users/juhanailmoniemi/.codex/bin/pyrycode-issue-action` also remains
approved. Use its absolute path with exactly three arguments:

- `comment ISSUE TEXT` posts one new comment.
- `add-label ISSUE LABEL` adds any label by name.
- `remove-label ISSUE LABEL` removes any label by name.

The helper fixes the repository and requires a numeric issue number.
There is no workflow-label whitelist. Extra arguments remain invalid.

Permission does not change role ownership. Builders return their structured
refinement outcome. The dispatcher still applies completion labels.
Other repository writes and unrelated issue edits retain their existing policy.
A prior explicit denial requires operator review before retrying the action.

### Remaining Codex pipeline actions

Juhana approved these routine operations on 2026-09-11. On this MacBook, use
`/Users/juhanailmoniemi/.codex/bin/pyrycode-pipeline-action` directly for the actions
below. These helper forms take precedence over raw Git and GitHub examples in
role prompts. Start a fresh Codex process to load the matching local allow rule.
If a sandbox call cannot reach GitHub, request escalated execution of the same
helper command. Do not wrap the helper in Python, shell substitutions or scripts.

| Arguments after the helper path | Effect |
| --- | --- |
| `push ISSUE` | Push the current `feature/ISSUE` branch normally. Requires the Pyrycode checkout or its worktree and the verified Pyrycode origin. |
| `issue-create TITLE BODY_FILE` | Create a Pyrycode issue. |
| `issue-edit ISSUE TITLE BODY_FILE` | Replace the issue title and body. Preserve the current title when only changing its body. |
| `pr-create ISSUE TITLE BODY_FILE` | Open a PR from `feature/ISSUE` into `main` after pushing. |
| `pr-edit PR TITLE BODY_FILE` | Update a PR title and body. |
| `pr-review PR VERDICT BODY_FILE` | Post `comment`, `approve` or `request-changes`. GitHub still forbids approving your own PR. Use the role's comment verdict when sharing an identity. |
| `issue-comment ISSUE BODY_FILE` or `pr-comment PR BODY_FILE` | Post a comment. |
| `issue-comment-edit-last ISSUE BODY_FILE` or `pr-comment-edit-last PR BODY_FILE` | Edit your last comment. |
| `issue-comment-delete-last ISSUE` or `pr-comment-delete-last PR` | Delete your last comment. |
| `label-edit NAME NEW_NAME COLOR DESCRIPTION` | Edit a label. Supply all fields, preserving existing values when unchanged. Color is six hexadecimal digits. |
| `board-add ISSUE` | Add the issue to Pyrycode board 1. |
| `board-status ISSUE STATUS` | Set its board status by exact name, such as `Backlog` or `In Development`. |
| `board-after ISSUE AFTER_ISSUE` | Place it after another Pyrycode issue on board 1. Use `top` instead of a number for first position. |
| `relations ISSUE` | Read parents, children and dependencies. Connection results report whether more than 100 exist. Do not treat a truncated result as complete. |
| `add-child PARENT CHILD` | Attach a child to its parent. Both are Pyrycode issue numbers. |
| `remove-child PARENT CHILD` | Remove that parent-child link. |
| `add-blocker ISSUE BLOCKER` | Mark the first issue as blocked by the second. |
| `remove-blocker ISSUE BLOCKER` | Remove that dependency. |

Pass titles and statuses as one quoted argument. Body files must have absolute
paths inside `/Users/juhanailmoniemi/.codex/publish/pyrycode/`.
Create a unique subfolder there for each task. Only put intended GitHub content
in this folder. Symbolic links, hard links and parent-directory traversal are
rejected. Direct GitHub comment and label-edit commands no longer have automatic
write approval. The helper takes no
extra flags, repository URLs, remote names, branch names or arbitrary API queries.
It resolves current project field and item IDs itself. Add an issue to the board
before setting its status or position. Existing comment and label commands above
remain available. Role ownership and the shared Git prohibitions still apply.

This approval covers sending ticket implementation, tests and workflow text to
`github.com/pyrycode/pyrycode`. The helper does not merge PRs, force-push, delete
branches, close issues or alter repository settings. Actions outside this set
retain their existing approval policy. The new permission is prospective;
previously parked tickets require a separate recovery action.
