# Pyrycode verifier triage

Read this when your gate note says **TRIAGE MODE**, or when no gate note arrived and you run the gates yourself. The goal is to decide, mechanically where possible, whether this PR caused the red. A PR that fixes one thing while unmasking older fragility elsewhere should not be sent back for rework it cannot do. Before this procedure existed, such PRs burned three or more rework cycles.

The snippets use bash process substitution. Run them with `bash -c` if your shell is not bash. Scratch files are `$V/check.log`, `$V/build.log`, `$V/baseline-check.log`, `$V/review.md` and `$V/bug.md`.

## Running the gates yourself

Only when no gate note was injected. Run them once, in this order, then follow the matching path: green goes to judgment, red goes through this file using your own logs.

```bash
make check 2>&1 | tee "$V/check.log"
make build 2>&1 | tee "$V/build.log"
```

## Classify the red

The injected failure context names the failing gate and carries the last 4000 characters of its output. `make check` runs `go vet`, the race-enabled unit tests, staticcheck, `substrate-guard`, `cite-guard`, `docs-guard` and the fake-daemon e2e suite in that order, and stops at the first failure. `make build` runs only after `make check` passed. Classify before anything else, checking the rows in this order:

| Observed | Classification | Next action |
|---|---|---|
| `make build` failed | **red (build failure)** | Always a regression: the PR's tree does not compile. `needs-rework:builder` immediately, no baseline run. |
| `substrate-guard` or `cite-guard` reported a failure | **red (guard failure)** | Always a regression. `needs-rework:builder` immediately, no baseline run. See below. |
| `docs-guard` reported a failure | **red (docs failure)**, and almost always pre-existing | It scans only `docs/knowledge/features/`, which the builder cannot write, so this is rarely the PR's doing. Confirm at the merge-base: if `make docs-guard` is red there too, treat it as pre-existing and route it as case 2 under "Routing after the comparison", using `docs-guard` as the check name. Only a change to that folder inside the PR's own diff is a regression, and that routes to `needs-rework:builder`. On 2026-09-01 a docs red on `main` sat under pyrycode #1947 through eight verifier runs. |
| `go vet` or staticcheck reported problems, shaped `path.go:line:col: message`, with no `--- FAIL:` lines | **red (lint failure)** | A regression when the flagged files are in the PR's diff: `needs-rework:builder`, no baseline run. When none are, confirm at the merge-base and route as for `docs-guard`. |
| A test tier failed and failing tests are extractable | **red (check failure)** | Run the baseline comparison below. Routing depends on the regression versus pre-existing partition. |
| Non-zero exit with no parseable failing-test names, no guard failure and no lint lines | **infra failure** | Post the infra template. Do not route to rework on this signal alone. Go on to judgment; your verdict alone decides. |

**Guard failures** emit no `--- FAIL: TestName` lines, so without the guard rows they would be misfiled as infra and parked for a human. They are the opposite: deterministic, entirely the PR's doing, and fixable by the builder in minutes. `substrate-guard` bans Claude terminal screen literals outside tui-driver. `cite-guard` bans a comment citing a file and line where a symbol name would do, and checks only lines the branch wrote. `main` is green on both by construction, since they gate every merge, so a red on a PR can only have come from the PR. Detect them first. `substrate-guard` prints `substrate-guard: clean` when it passes, and that line is in the log of every later red, so exclude it:

```bash
grep -nE '^(substrate-guard|cite-guard): ' "$V/check.log" | grep -v 'substrate-guard: clean$'
grep -n '^docs-guard: ' "$V/check.log"
```

If the first command matches, route to `needs-rework:builder` with the guard's own output quoted. It already names each offending file, line and fix.

**Getting the PR-side log.** Prefer the injected context: if it holds the full `make check` output, save it to `$V/check.log`. If it is only an excerpt without parseable `--- FAIL:` lines on a test-tier failure, reproduce once in the PR worktree with `make check 2>&1 | tee "$V/check.log"` to capture the full log. That reproduction is triage, not a judgment-mode gate re-run, and it is the one situation where you run `make check` yourself.

Extract failing test names. Go prints `--- FAIL: TestName (...)` per failing test, and subtests as `--- FAIL: TestParent/subname`. The extraction keeps the full path, which is what `go test -run` accepts later:

```bash
grep -E '^--- FAIL: ' "$V/check.log" | awk '{print $3}' | sort -u
```

## Baseline comparison for a red test tier

Do not route a check failure to `needs-rework:builder` on sight. Re-run `make check` against the PR's merge-base in a temporary worktree, then classify each failing test as `regression` (passed on baseline, failed on PR) or `pre_existing` (failed on both). **Skip the baseline run entirely for** a build, guard or lint regression, or an infra failure.

This is the deterministic safety net for the out-of-scope question. It answers "did this PR introduce these failures?" mechanically, with no diff reasoning or call-graph guessing, so a stochastic first classification has a check of a different kind under it.

```bash
# 1. PR-side failing test names, already extracted above:
PR_FAILS=$(grep -E '^--- FAIL: ' "$V/check.log" | awk '{print $3}' | sort -u)
if [ -z "$PR_FAILS" ]; then
  # Defensive: red:check without parseable names should have classified as
  # infra-failure. If it didn't, fall through to standard red routing.
  echo "verifier: red:check with no parseable failing names; routing as standard red" >&2
else
  # 2. Resolve baseline ref: the merge-base captures where this PR diverged from main.
  BASELINE_REF=$(git merge-base HEAD origin/main 2>/dev/null)
  if [ -z "$BASELINE_REF" ]; then
    echo "verifier: merge-base unresolved; routing as standard red" >&2
  else
    # 3. Detached worktree at the baseline. `git worktree add` accepts an
    #    existing EMPTY directory, which is what mktemp -d gives us.
    BASELINE_DIR=$(mktemp -d -t baseline-verifier-XXXXXX)
    if ! git worktree add --detach "$BASELINE_DIR" "$BASELINE_REF" >/dev/null 2>&1; then
      echo "verifier: baseline worktree add failed; routing as standard red" >&2
      rmdir "$BASELINE_DIR" 2>/dev/null || true   # nothing was checked out; don't leak the dir
    else
      # 4. Run make check in the baseline worktree. `&>` captures BOTH stdout and
      #    stderr: `go vet` and staticcheck write to stderr and we need them in the
      #    log for accurate comparison. (`2>&1 > file` is wrong-ordered and would leak stderr.)
      (cd "$BASELINE_DIR" && make check) &> "$V/baseline-check.log" || true
      if [ -s "$V/baseline-check.log" ]; then
        BASELINE_FAILS=$(grep -E '^--- FAIL: ' "$V/baseline-check.log" | awk '{print $3}' | sort -u)
        # 5. Partition: comm -23 = in PR_FAILS only (regressions, PR caused them);
        #    comm -12 = in both (pre_existing, PR did not cause them).
        REGRESSIONS=$(comm -23 <(echo "$PR_FAILS") <(echo "$BASELINE_FAILS"))
        PRE_EXISTING=$(comm -12 <(echo "$PR_FAILS") <(echo "$BASELINE_FAILS"))
      else
        echo "verifier: baseline log empty or not produced; routing as standard red" >&2
        REGRESSIONS="$PR_FAILS"
        PRE_EXISTING=""
      fi
      # 6. Clean up the baseline worktree, always: leaks rot the dispatcher's worktree list.
      git worktree remove --force "$BASELINE_DIR" >/dev/null 2>&1 || true
    fi
  fi
fi
```

`make check` stops at its first failure on the baseline too. A test the baseline never reached, because an earlier tier went red there, shows up as a regression. Before routing, check that the baseline log reached the tier the PR failed in, and say so in the comment when it did not.

**Routing after the comparison** has three cases:

1. **`REGRESSIONS` non-empty.** At least one failing test passed on the baseline but fails on this PR. Post the standard-red template, add `needs-rework:builder`, and **stop there and skip judgment.** The diff you would review is about to change. If `PRE_EXISTING` is also non-empty, mention those too, flagged as "pre-existing, tracked separately", and run the search-first dedupe below before posting so the linkage is in the comment.

2. **`REGRESSIONS` empty and `PRE_EXISTING` non-empty.** Every failing test fails on the baseline too. The PR did not introduce them. Track the `PRE_EXISTING` set through the search-first dedupe, post the out-of-scope-red template, add **no labels from the triage half**, then **go on to judgment in this same run.** The PR itself is reviewable, and your judgment verdict owns the labels from here.

3. **The baseline could not run** because the merge-base was unresolved, the worktree add failed or the baseline log is missing. Fall back to standard red routing with `needs-rework:builder`. The deterministic check failed, so default to safe behaviour.

When a pre-existing red stopped `make check` early, the later steps never ran on this PR, and neither did `make build`. Name them under **Not checked** in the judgment verdict.

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

redact < "$V/check.log" | tail -n 5      # the standard-red "last 5 lines"
redact < "$V/build.log" | tail -n 10     # the build-failure "last 10 lines"
```

The injected failure context goes through the same filter before any of it is quoted. It is a raw gate log until proven otherwise.

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

Last 5 lines of `make check`:
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

Triage verdict: PASS (PR did not introduce these failures).

`<TRACKING-LINE>`

Continuing to judgment review in this run.
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

The gate returned non-zero but produced no parseable `--- FAIL:` lines, no guard failure and no lint findings. Likely causes: toolchain not found, OOM during build, a fake daemon that failed to start in the e2e tier, environmental disruption.

(Name the specific anomaly visible in the log: e.g. "make: command not found", "no test output before exit", "no space left on device".)

Proceeding to judgment review in this run; its verdict alone decides PASS/FAIL on this ticket. Operator may want to re-dispatch after addressing the environmental cause.
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

  Last 5 lines of \`make check\` on PR branch: <redacted tail, fenced>"
```

**If NEW is non-empty**, file one bundled ticket for the NEW checks only. **If NEW is empty, skip this block entirely.** The steps share `$url`, and running them without it fails.

```bash
# A. File ONE bundled bug ticket for the NEW set. Title lists ONLY the NEW checks.
#    Body: the NEW check names, the PR #, the baseline-comparison evidence (both
#    make check tails, redacted), and "cause not yet diagnosed" unless you've
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
