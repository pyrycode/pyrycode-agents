# Shared development practice

This file applies to every Pyrycode pipeline role and supplements the role file. It does not grant permission to edit paths the role forbids. Under Codex, the helper forms in the last section take precedence over raw Git and GitHub commands shown in role files.

## Principles

- **Keep changes simple.** Touch only what the ticket needs. Do not refactor nearby code while you are there. For a non-trivial change, ask whether there is a cleaner way, but do not over-engineer routine work.
- **Fix what has been observed.** Do not add a defence for a failure that has not happened. A prose rule is cheap and mostly followed; a code check is expensive, so escalate to one only after the failure has been seen.
- **A safety net must be a different kind of check.** A rule an agent might skip is backed by deterministic code, not by a second agent rule with the same blind spot.

## Filing follow-up tickets

When your role authorises filing a bug or follow-up, search open issues for an existing ticket first. Link an existing ticket instead of creating a duplicate. Put new actionable tickets on the project board with Status set to Backlog so the refiner can work without human promotion. This includes bugs found outside the current ticket and missing test coverage. An unknown technical cause is investigation work for Backlog. Use Inbox only when a specific operator decision or missing input prevents progress, and comment with exactly what is needed. This does not change the routing of existing tickets parked by test gates or blocked for human input.

## Knowledge

Start from the target repository's `docs/knowledge/INDEX.md` and the topic that owns the ticket's area. Search the full catalog only when needed. Claude local memory is disabled. Do not read or write it, and do not use the historical archive as current instructions.

Builders record durable discoveries in the PR's Lessons learned section. Verifiers record them in review comments. Refiners and product owners record them on the issue, including work that ends without a PR. Link the finding from any child that continues the work. The documentation stage folds product lessons into the owning topic. Workflow lessons are folded into this file or the dispatcher docs by their maintainer. Do not create a second private note.

## Sizing and planning

These apply when you size, split or plan a ticket.

Ask what the user can do differently before plumbing a descriptive identifier through the code. Do not imply capabilities the identifier does not establish.

Read a merged blocker's code and its production call sites before trusting the dependent ticket's forecast. The blocker can leave a caller unwired, or can already have completed the dependent's proof. Check for both.

Before sizing a type change, count its constructors, narrow interfaces and test doubles. Compare the nearest shipped change of the same kind, separating inserted lines from deleted ones and restricting the comparison to the new ticket's actual scope. Recalculate rather than copying old estimates, and use the current role's size limits, not thresholds from historical notes.

Dependency links and parent-child links are different. Check actual parentage for split depth. A missing parent link can hide a descendant, and several blockers do not make a root ticket a grandchild. Repair recorded lineage before using it as a gate input, then follow the current split rules.

## Issues, PRs and gates

Read security and routing labels from the issue, not the PR. Keep the two numbers apart: the PR holds the diff and comments, the issue holds the labels and the plan's identity.

The pipeline uses one GitHub identity, and GitHub refuses an author's approval or change-request review on its own PR. Post a verdict as a PR comment and apply the issue labels the role requires. Do not retry an impossible self-review.

The dispatcher owns the mechanical gates, as each role file describes. When you read a gate result, read the executed counts and the failure evidence. A one-test baseline can leave out a sibling that writes a fixture the branch's full run depends on, so compare the inputs and suite composition before blaming the change. Search existing issues before filing a new one.

## Source and evidence checks

When sizing, building or reviewing code, use the target's `docs/knowledge/features/development-verification.md`. It covers source-search limits, validation boundaries, protocol tests, capture evidence and artifact survival. Read the section you need. Current code wins over an old observation.

## GitHub API budget

Managed runs use the shared GitHub connection. Use the installed `gh` command and preserve its inherited `GH_CONFIG_DIR`. Do not clear that setting or use another API client to bypass the shared allowance. If the connection is unavailable, retain local results and report the temporary failure.

Every dispatcher, agent and interactive session shares one GitHub account and its 5000 GraphQL points an hour. When they run out, every `gh` call in the pipeline fails until the hourly reset.

- To learn a ticket's board column, read the ticket: `gh issue view --repo pyrycode/pyrycode <n> --json projectItems` costs about 2 points. Listing the board costs about 100 points a page, and repeated listings drained the budget on 2026-09-22. List it at most once a run, and only when you need every card.
- Check the budget with `gh api graphql -f query='{rateLimit{remaining resetAt}}'`. The `gh api rate_limit` endpoint misreports this bucket.

## When an operation is denied

The pipeline is non-interactive, so a question reaches no one. When the dispatcher or Codex approval review denies an operation, such as a hard reset, a force push or a delete outside the worktree, do not try another form of it, even when it looks safe. The allowlist is the source of truth. Under Claude, send one message naming the denied operation and what you were trying to achieve, then end the turn; the dispatcher records `error:<agent>:permission_denied` and routes the ticket to the operator. Under Codex, return status blocked. A denial that came before this run needs operator review before the action is tried again. Pyrycode #398 lost its work by retrying and prompting an absent operator.

## When an MCP or plugin tool is missing

If a tool you need from an MCP server or plugin, such as Figma, is missing from your tools or fails to connect, stop at once. Do no further work and do not look for a workaround. End your final message with this line, naming the server or plugin, as its very last line: `TOOL_UNAVAILABLE: <server or plugin name>`, for example `TOOL_UNAVAILABLE: figma`. Under Codex, return status `blocked` with that line last in the summary. The dispatcher retries the run a few times, then parks the ticket. This covers only a tool that is missing or cannot be reached. A tool that answers with an error, for example for a bad argument or a node that does not exist, is not this case. Neither is a tool your instructions give a fallback for, such as command-line search when a search tool is unavailable.

## Codex on the MacBook

This section applies only when you run under Codex. Juhana approved these operations on 2026-09-11. They grant permission only; they do not change which role owns which action. A builder still returns its structured refinement outcome, and the dispatcher still applies completion labels. Each helper fixes the repository to `pyrycode/pyrycode`. New Codex processes load the matching allow rules, so a rules change needs a fresh process.

### Reads

Put the repository option immediately after the subcommand and before the number. The allow rules match command prefixes, so this order is what they accept:

```bash
gh issue view --repo pyrycode/pyrycode 2271 --json title,body,labels
gh pr view --repo pyrycode/pyrycode 2339 --json title,body,files
gh pr diff --repo pyrycode/pyrycode 2339
```

The same order applies to issue list and status, and to PR list, status and checks. Do not pass the repository twice or use shell substitutions. If the sandbox blocks the connection, request escalated execution of the same command.

### Writes

Raw `gh` comment and label commands no longer have automatic write approval. Use one of the two helpers below by absolute path, without wrapping it in Python, shell substitutions or scripts. If a sandboxed call cannot reach GitHub, request escalated execution of the same helper command.

`/Users/juhanailmoniemi/.codex/bin/pyrycode-issue-action` takes exactly three arguments and a numeric issue number:

- `comment ISSUE TEXT` posts one new comment.
- `add-label ISSUE LABEL` adds any label by name.
- `remove-label ISSUE LABEL` removes any label by name.

`/Users/juhanailmoniemi/.codex/bin/pyrycode-pipeline-action` covers the rest:

| Arguments after the helper path | Effect |
| --- | --- |
| `push ISSUE` | Push the current `feature/ISSUE` branch normally. Requires the Pyrycode checkout or its worktree and the verified Pyrycode origin. |
| `issue-create TITLE BODY_FILE` | Create a Pyrycode issue. |
| `issue-edit ISSUE TITLE BODY_FILE` | Replace the issue title and body. Pass the current title when only the body changes. |
| `pr-create ISSUE TITLE BODY_FILE` | Open a PR from `feature/ISSUE` into `main` after pushing. |
| `pr-edit PR TITLE BODY_FILE` | Update a PR title and body. |
| `pr-review PR VERDICT BODY_FILE` | Post `comment`, `approve` or `request-changes`. GitHub still refuses approval of your own PR, so use the role's comment verdict. |
| `issue-comment ISSUE BODY_FILE` or `pr-comment PR BODY_FILE` | Post a comment. |
| `issue-comment-edit-last ISSUE BODY_FILE` or `pr-comment-edit-last PR BODY_FILE` | Edit your last comment. |
| `issue-comment-delete-last ISSUE` or `pr-comment-delete-last PR` | Delete your last comment. |
| `label-edit NAME NEW_NAME COLOR DESCRIPTION` | Edit a label. Supply every field, keeping existing values when unchanged. Color is six hexadecimal digits. |
| `board-add ISSUE` | Add the issue to Pyrycode board 1. |
| `board-status ISSUE STATUS` | Set its board status by exact name, such as `Backlog` or `In Development`. |
| `board-after ISSUE AFTER_ISSUE` | Place it after another Pyrycode issue on board 1. Use `top` instead of a number for first position. |
| `relations ISSUE` | Read parents, children and dependencies. Results say whether more than 100 exist; a truncated result is not complete. |
| `add-child PARENT CHILD` | Attach a child to its parent. |
| `remove-child PARENT CHILD` | Remove that parent-child link. |
| `add-blocker ISSUE BLOCKER` | Mark the first issue as blocked by the second. |
| `remove-blocker ISSUE BLOCKER` | Remove that dependency. |

Pass titles and statuses as one quoted argument. Body files must have absolute paths inside `/Users/juhanailmoniemi/.codex/publish/pyrycode/`, in a unique subfolder per task holding only intended GitHub content. Symbolic links, hard links and parent-directory traversal are rejected. The helper takes no extra flags, repository URLs, remote names, branch names or arbitrary API queries, and resolves project field and item IDs itself. Add an issue to the board before setting its status or position.

This approval covers sending ticket implementation, tests and workflow text to `github.com/pyrycode/pyrycode`. The helpers do not merge PRs, force-push, delete branches, close issues or change repository settings. Anything outside this set keeps its existing approval policy, and the shared Git prohibitions still apply. The approval is prospective; a ticket parked before it needs a separate recovery action.
