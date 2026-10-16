# Pyrycode verifier triage

Read this when your gate note says **TRIAGE MODE**, or when no gate note arrived and you run the gates yourself. The goal is to decide, mechanically where possible, whether this PR caused the red. A PR that fixes one thing while unmasking older fragility elsewhere should not be sent back for rework it cannot do. Before this procedure existed, such PRs burned three or more rework cycles.

Keep each original gate log and its exit status. Use complete paths from the injected gate note or gate report. A tail excerpt is a pointer to evidence, not a reason to repeat the whole suite. Scratch output stays under the PR-specific `$V` directory.

## Use the automatic evidence first

The dispatcher reports each configured step separately. Formatted unit and fake-daemon test failures receive named same-tree and unchanged-base comparisons. Read those results, their exact executed names and counts, their commits and the complete original logs. Reuse a completed comparison. A tracked inherited failure that the dispatcher accepted is already explained in its note.

Do not run `make check` again to obtain a longer excerpt. Read the retained complete stdout and stderr paths. Preserve the original red result even when a later focused run passes. Missing, unreadable, truncated or skipped-only evidence excuses no failure.

A raw-green prefix does not certify later steps. Confirm every required configured gate has completed before PASS. If a red or unfinished step remains, source review can continue, but this run cannot approve or advance.

## Running the gates yourself

Only when no gate note was injected. Read the current `PYRY_VERIFIER_GATES` configuration and execute those steps once in order. If that configuration is unavailable or empty, report the missing configuration and return blocked. Do not substitute an old compound gate list.

This foreground example preserves each process's real status and separate streams. Use a tool timeout long enough for the command and host admission wait. Do not pipe execution through `tee` or discard a nonzero status.

```bash
[ -n "${PYRY_VERIFIER_GATES//[[:space:]]/}" ] || exit 2
attempt=$(date -u +%Y%m%dT%H%M%SZ)-$$
IFS=';' read -r -a gates <<< "$PYRY_VERIFIER_GATES"
n=0
for gate in "${gates[@]}"; do
  [ -n "${gate//[[:space:]]/}" ] || continue
  n=$((n + 1))
  out="$V/$attempt-gate-$n.stdout.log"
  err="$V/$attempt-gate-$n.stderr.log"
  status=0
  bash -c "$gate" >"$out" 2>"$err" || status=$?
  printf '%s\t%s\t%s\t%s\n' "$status" "$gate" "$out" "$err" >> "$V/$attempt-status.tsv"
  [ "$status" -eq 0 ] || break
done
[ "$n" -gt 0 ] || exit 2
exit "$status"
```

Count the executed tests from each formatted report. An exit code alone cannot establish that tests ran. Name the missing injected note and the actual self-run statuses in the verdict.

## Classify the red

Classify the original failing step, using the complete record and any existing automatic assessment.

| Observed | Classification | Next action |
|---|---|---|
| Build failed | Build failure | Route an established PR compile regression to `needs-rework:builder`. |
| Substrate or citation guard failed | Guard failure | Use the guard's offending changed files and route to `needs-rework:builder`. A clean guard line is not a failure. |
| Documentation guard failed | Documentation failure | Inspect the changed files. Compare only that guard on the base if the automatic evidence did not settle attribution. Track an inherited failure separately. |
| Vet or staticcheck failed | Lint failure | Route findings introduced in the PR's files to the builder. If attribution is unresolved, compare only the named lint step on the base. |
| A test step has named failures | Test failure | Use the automatic partition first. Compare only unresolved names as described below. |
| Process failed without complete attributable test evidence | Infrastructure or incomplete result | Preserve the anomaly and unfinished checks. Do not infer a product regression or publish PASS. |

## Named fallback for unresolved test failures

Use this only when the automatic named comparison is absent or inconclusive. Do not repeat a complete PR or base suite.

1. Read the original formatted output and select the exact unresolved failing names. Preserve their package and subtest identities. Read the baseline command template for that same gate from `PYRY_VERIFIER_GATE_FORMATS`. Its selection must include only those names.
2. Run that named selection once on the candidate if no usable same-tree comparison exists. Preserve the original failure and this new result separately. A newly passing test is intermittent evidence, not a replacement for the original run.
3. If a failure still reproduces and no usable base comparison exists, resolve the unchanged base with `git merge-base HEAD origin/main`. Create a detached temporary worktree with `git worktree add --detach`. Run only the same named selection there, using the same test tier and flags.
4. Keep separate stdout, stderr, exit status, selected names, actual executed/passed/failed/skipped counts and base/candidate commits. Every selected name must actually execute. Missing names, zero execution, skips, a timeout, a build failure or incomplete output leave attribution unresolved. Never classify a name as a regression merely because the base did not reach it.
5. Remove only a clean temporary worktree with ordinary `git worktree remove`. Preserve a dirty or retained worktree and report its path. Do not force removal or discard generated evidence.

The configured baseline template already quotes the selection. Do not wrap its placeholder in another shell quote. Use exact package/test names from the original report and verify the executed identities in the result. A full-suite baseline fallback is forbidden.

## Routing after the comparison

- **An established regression remains.** Post the standard-red template and add `needs-rework:builder`. Preserve any separate inherited failures and their trackers. Skip judgment because the implementation must change.
- **Failures are inherited or intermittent.** Use the search-first tracking procedure below unless the dispatcher already recorded the sighting. Keep its tracker links and original red evidence. Review the source without repeating its completed source report. PASS requires the dispatcher's complete accepted gate evidence, including every later required step. A manual named comparison cannot override a red automatic gate or unfinished steps; report blocked until the dispatcher completes them.
- **Attribution or required execution remains incomplete.** Keep the original failure and exact missing evidence. Report blocked without a speculative product-rework label. Do not publish PASS. The next dispatcher run must finish the required gates.

## Redact before quoting any log

**Every** `<redacted tail>` in the templates below, including the standard-red tail, the build-failure tail and the tracking-ticket comment, goes through this filter first. `pyrycode/pyrycode` is private, but Go test output often surfaces environment variables and the cost of a leaked credential is high, so err toward redaction.

```bash
redact() {
  sed -E \
    -e 's/(sk-ant-[A-Za-z0-9_-]{10,})/[REDACTED-ANTHROPIC-KEY]/g' \
    -e 's/(ghp_[A-Za-z0-9]{36,})/[REDACTED-GITHUB-TOKEN]/g' \
    -e 's/(ghs_[A-Za-z0-9]{36,})/[REDACTED-GITHUB-TOKEN]/g' \
    -e 's/(ANTHROPIC_API_KEY=[^[:space:]]+)/ANTHROPIC_API_KEY=[REDACTED]/g' \
    -e 's/(CLAUDE_CODE_OAUTH_TOKEN=[^[:space:]]+)/CLAUDE_CODE_OAUTH_TOKEN=[REDACTED]/g' \
    -e 's/(GITHUB_TOKEN=[^[:space:]]+)/GITHUB_TOKEN=[REDACTED]/g' \
    -e 's/([Bb]earer[[:space:]]+)[A-Za-z0-9._-]+/\1[REDACTED]/g' \
    -e 's/([Aa]uthorization:[[:space:]]*)[^[:space:]]+/\1[REDACTED]/g' \
    -e 's/\b([0-9]{1,3}\.){3}[0-9]{1,3}\b/[REDACTED-IP]/g'
}

redact < "$GATE_STDOUT" | tail -n 5
redact < "$GATE_STDERR" | tail -n 10
```

Set `GATE_STDOUT` and `GATE_STDERR` to the failing step's complete retained paths. The injected failure context goes through the same filter before any of it is quoted. It is a raw gate log until proven otherwise.

## The tracking line

The red templates below carry a `` `<TRACKING-LINE>` `` placeholder. Replace the **whole line, backticks included**, with exactly one of these shapes, chosen by the KNOWN and NEW partition from the search-first dedupe:

- **All KNOWN:** `Tracking (re-observed): #X (for check-A), #Y (for check-B)`
- **All NEW:** `Filed as separate bug ticket: #Z`
- **Mixed:** two lines, `Tracking (re-observed): #X (for check-A)` then `Filed as new ticket: #Z (for check-B)`

All three use the parenthetical attribution style so the linkage is unambiguous. **The placeholder is wrapped in backticks** because GitHub Markdown silently strips unknown angle-bracket constructs. A bare `<TRACKING-LINE>` left unsubstituted renders as empty space, and an empty line looks valid. The backticks force inline-code rendering, so a forgotten marker shows up as visible text a human will catch.

## Triage templates

**Standard red, regressions present.** Post with `gh pr comment --repo pyrycode/pyrycode <PR-number> --body-file "$V/review.md"`:

````
❌ **Verification gates failed: regressions introduced by this PR**

Regressions (passed on baseline `<sha>`, fail on PR):
- TestName1
- TestName2

Pre-existing failures (fail on both baseline AND PR branch, NOT caused by this PR):
- TestName3

`<TRACKING-LINE>`

Last 5 lines of the original failing gate:
```
<redacted tail>
```
````

Then `gh issue edit --repo pyrycode/pyrycode <ticket-number> --add-label needs-rework:builder`. If `PRE_EXISTING` is empty, drop the pre-existing block and the tracking line from the template.

**Out-of-scope red, all failures pre-existing.** Run the search-first dedupe first, then post with `gh pr comment --repo pyrycode/pyrycode <PR-number> --body-file "$V/review.md"`:

```
⚠️ **Verification gates RED: pre-existing failures (PR did not cause them)**

Failing test(s): <PR_FAILS, comma-separated>

Baseline-comparison verdict (run against `git merge-base HEAD origin/main`):
- Regressions introduced by this PR: **none**
- Pre-existing failures (fail on both baseline AND PR branch): <PRE_EXISTING, comma-separated>

Attribution: inherited failures. Required gate completion remains pending.

`<TRACKING-LINE>`

Continuing source review. Approval waits for complete accepted gate evidence.
```

**No labels from the triage half on this path**, neither `needs-rework:*` nor `done:*`. The judgment verdict owns the labels from here.

**Build failure.** Post with `gh pr comment --repo pyrycode/pyrycode <PR-number> --body-file "$V/review.md"`:

````
❌ **Verification gates failed: build failure**

`make build` did not succeed on this PR. Build failures always route to rework, because they mean the PR's tree does not compile.

Last 10 lines of `make build`:
```
<redacted tail>
```
````

Then `gh issue edit --repo pyrycode/pyrycode <ticket-number> --add-label needs-rework:builder`. A **guard or lint failure** uses the same shape, with the tool's own output quoted in place of the tail, because it already names each offending file, line and fix. Same label.

**Infra failure, the gate could not produce a verdict.** Post with `gh pr comment --repo pyrycode/pyrycode <PR-number> --body-file "$V/review.md"`:

```
⚠️ **Verification gate could not produce a verdict**

The gate returned non-zero without complete attributable test evidence, a guard failure or a lint finding. Likely causes: toolchain not found, OOM during build, a fake daemon that failed to start in the e2e tier, environmental disruption.

(Name the specific anomaly visible in the log: e.g. "make: command not found", "no test output before exit", "no space left on device".)

Required gate evidence is incomplete. No PASS is published. Preserve these logs and return blocked so the dispatcher can complete the required checks after the environment is repaired.
```

No label changes from the triage half on an infra failure.

## Filing pre-existing-failure tickets: search-first dedupe

**Rule.** Before filing a new bug ticket for a pre-existing failure, search open issues for an existing tracking ticket. If one exists, comment and link instead of creating a new one.

**Why this exists.** Without dedupe, every PR cycle that meets the same unmasked failure files a fresh duplicate. On 2026-05-23, `snapshot-drift` on `pyrycode/tui-driver` was filed as #75, #83 and #92 across three PR cycles in 48 hours before this rule landed, each closed as superseded.

**Procedure.** For each check name in `PRE_EXISTING`:

```bash
# Search open issues whose title contains the check name, as a literal string.
# `--limit 100` (gh max) so a generic name matching many issues doesn't push
# the true tracking ticket beyond the inspection window.
candidates=$(gh issue list --repo pyrycode/pyrycode --state open \
               --search "\"<check-name>\" in:title" \
               --json number,title,url --limit 100)
```

**Safe naming.** The check name is wrapped in quotes for GitHub Search's exact-string syntax. Go test names and guard names are safe as they are. If a name contains GitHub search special characters (`:` `(` `)` `+` `"`), backslash-escape them before substituting. A candidate qualifies as a tracking ticket for this check if its title contains the check name as a case-insensitive substring and reads like a tracking ticket. Marker words include `pre-existing`, `unmasked`, `drift`, `flaky`, `tracking`, `regression`, `bug`, `failure`, `broken` and `intermittent`, among others.

**Cost asymmetry.** A false positive, commenting on a related but distinct issue, costs one extra notification. A false negative creates another duplicate, which is what this rule exists to prevent. **When unsure, treat it as a match and comment.** If several open issues match one check, comment on the **oldest**, the lowest number, as the canonical tracker, and link the others in the comment so they consolidate over time.

**Partition `PRE_EXISTING`:** **KNOWN** checks have a matching open tracking ticket, so record the matched number per check. **NEW** checks have none.

**For each KNOWN check**, comment on its tracking ticket. No board operations are needed, because the ticket is already on the board:

```bash
gh issue comment --repo pyrycode/pyrycode <matched-number> --body \
  "Re-observed as pre-existing failure on PR #<PR-number> (baseline-comparison
  against \`<baseline-sha>\` confirms not introduced by this PR's diff).
  Tracking continues here.

  Last 5 lines of the original failing gate on PR branch: <redacted tail, fenced>"
```

**If NEW is non-empty**, file one bundled ticket for the NEW checks only. **If NEW is empty, skip this block entirely.** The steps share `$url`, and running them without it fails.

```bash
# A. File ONE bundled bug ticket for the NEW set. Title lists ONLY the NEW checks.
#    Body: the NEW check names, the PR #, the baseline-comparison evidence (both
#    focused comparison records, redacted), and "cause not yet diagnosed" unless you've
#    identified it. If KNOWN is non-empty, note those tickets too ("see also #X, #Y").
url=$(gh issue create --repo pyrycode/pyrycode \
  --title "<NEW-names>: pre-existing failures unmasked by PR #<PR>" \
  --label "bug" \
  --body-file "$V/bug.md")

# A.1 Add to board #1; resolve project + Status field + Backlog option at runtime.
#     Never hardcode option IDs: updateProjectV2Field mutations reissue them
#     (2026-05-22 board-mutation lesson).
item_id=$(gh project item-add 1 --owner pyrycode --url "$url" --format json --jq '.id')
project_id=$(gh project view 1 --owner pyrycode --format json --jq '.id')
field_json=$(gh project field-list 1 --owner pyrycode --format json)
status_field_id=$(echo "$field_json" | jq -r '.fields[] | select(.name == "Status") | .id')
backlog_option_id=$(echo "$field_json" | jq -r '.fields[] | select(.name == "Status") | .options[] | select(.name == "Backlog") | .id')

# A.2 Set Status = Backlog. `gh project item-add` does NOT set Status on its
#     own; without this the item lands invisible to every column query.
gh project item-edit --project-id "$project_id" --id "$item_id" \
  --field-id "$status_field_id" --single-select-option-id "$backlog_option_id"

# A.3 Move to top of project (= top of Backlog when the column filters).
#     Omitting afterId sends the item to position 1.
gh api graphql -f query='mutation($projectId: ID!, $itemId: ID!) {
  updateProjectV2ItemPosition(input: { projectId: $projectId, itemId: $itemId }) {
    clientMutationId
  }
}' -f projectId="$project_id" -f itemId="$item_id" > /dev/null
```

**The ticket goes to the top of Backlog.** Backlog rather than Inbox, because the ticket already carries checked evidence, failing test names plus baseline logs showing they are not this PR's regressions, so the refiner can work on it without human pre-triage. Top, because an unmasked pre-existing failure means `main` has a real bug that just surfaced, and it deserves priority over refined work below it. This dedupe is a prompt-level fix. If duplicates appear again despite it, file a follow-up for a deterministic check in [agent-dispatcher](https://github.com/pyrycode/agent-dispatcher) that refuses to create an issue when an open one has a matching title. Do not ship both fixes at once.
