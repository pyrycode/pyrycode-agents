# Builder handbacks

Read this when the ticket leaves your hands before it is built, when you need to file a bug outside your ticket, or when the ticket requires committed live records. The label contract itself is in `CLAUDE.md` under "Labels are the contract".

Under Codex, the runtime notes appended to your instructions replace the `needs-rework:refiner` label and its routing comment with a returned status. Put the same explanation in that status. Everything else here, such as setting a blocker link or filing a bug, you still do yourself. Where the shared practice names a helper for a GitHub write, such as `add-blocker`, `issue-create`, `board-add` or `board-status`, use it in place of the raw `gh` commands below, which show what each step does.

Whatever the route, a run that hands the ticket back leaves nothing it wrote in the worktree. The dispatcher commits a dirty worktree to `feature/<ticket>` and pushes it, so a scratch note or an unused plan file becomes stale junk on the branch.

## An oversized ticket

### Check the depth first

Before proposing a split, find out whether the ticket is already a grandchild:

```bash
gh api graphql -f query='query($owner:String!,$repo:String!,$num:Int!){repository(owner:$owner,name:$repo){issue(number:$num){number parent{number parent{number}}}}}' \
  -f owner=pyrycode -f repo=pyrycode -F num=<TICKET> \
  --jq '.data.repository.issue | "parent \(.parent.number // "none") grandparent \(.parent.parent.number // "none")"'
```

The `relations` helper in the shared practice answers the same question. Use real parent links, not dependency links. The shared practice explains the difference.

If `grandparent` is anything other than `none`, do not split, and do not stop either. Add `needs-human:sizing`, comment with the split you would have made and the measurement behind it, then build the ticket as it stands: plan, implement, PR. Recursive splitting is a measured failure on this pipeline. #1925 became #1937, then #1940, then #1943 and #1944 in about seventy minutes, with no code written.

You keep building because once splitting is off the table, the only outcomes are building now or building after an interruption that ends the same way. #1938, the first ticket to reach this gate, stopped instead, added nothing to its own analysis and cost a full extra run. The label makes the judgement findable on the board. It is not a question someone has to answer before the ticket can move. So do not use it to avoid the call: state the measurement and your reading of it.

### Check the floor

A slice whose only deliverable is used by exactly one sibling in the same family is part of that sibling, not a ticket of its own. If your proposed split produces a child that nothing outside the family calls, merge it back.

When the floor and the ceiling disagree, the floor wins. Merge the one-consumer slice back even if the merged ticket goes over a line of the table, state the overage in your plan, and build. The ceiling protects against a budget miss, which costs one continuation leg. The floor protects against a ticket that cannot be verified on its own, which no continuation fixes. On the #1720 split on 2026-09-02, four one-consumer pairs were cut apart to stay under the old ceiling, and ten tickets carried what five would have.

### Propose the split

Comment on the ticket, then add `needs-rework:refiner` and end the run without writing a plan:

> **Oversized, split as follows:**
> - **A:** the first slice: what behaviour, what interfaces it introduces
> - **B:** the second slice: what it consumes from A and what it adds, and so on
>
> Each child stands alone. The refiner writes a self-contained body for each, and each child's builder run plans from its own body.

When the split comes from the re-count against your written plan, point each slice at a seam in your Design section, and delete the uncommitted plan file before you finish.

If more than five acceptance criteria is the only limit that tripped, say so in the comment. The refiner trims a body to one criterion per observable behaviour before it splits on the count.

## A real dependency on unmerged work

When the overlap check finds that your design needs what another branch adds, or both rewrite the same block:

1. Mark this ticket as blocked by each ticket you depend on:
   ```bash
   gh api graphql -f query='mutation($issueId: ID!, $blockingIssueId: ID!) {
     addBlockedBy(input: { issueId: $issueId, blockingIssueId: $blockingIssueId }) {
       issue { number }
     }
   }' -f issueId="$(gh issue view --repo pyrycode/pyrycode <THIS> --json id -q '.id')" \
      -f blockingIssueId="$(gh issue view --repo pyrycode/pyrycode <THAT> --json id -q '.id')"
   ```
2. Comment on this ticket: "Blocked by #N: this design needs <what #N adds> / rewrites <the same block> as #N. Will build once #N lands." Put any design notes the next run will need in the same comment, because the refiner is not involved.
3. Add `needs-rework:refiner` and end the run without writing a plan.

Because the ticket now has an open blocker, the dispatcher strips the label, leaves the ticket in In Development and counts no rework. When the blocker closes you run again, starting from the merged code on main.

Until 2026-09-23 any shared file was a reason to wait, after #40 collided with #38 and #39 on `internal/sessions/pool_test.go` and #182 and #187 collided on `internal/update`. The dispatcher's merge before every stage, and its handoff of conflicts to the builder, now catch those collisions, so only a real dependency waits.

## Filing a bug outside your ticket

An issue that is not on the board with a Status set is invisible to every column query the dispatcher runs, so nothing would ever pick it up. Creating the issue is only the first step.

```bash
# The body goes outside the worktree. Include the smallest reproduction,
# expected and actual behaviour, the symbol where the bug lives, and a link
# back to the test that surfaced it.
mkdir -p /tmp/builder-<ticket>
BUG=/tmp/builder-<ticket>/bug.md
url=$(gh issue create --repo pyrycode/pyrycode \
  --title "<one-line bug summary>" --label bug --body-file "$BUG")

# Add it to board 1 and set Status to Backlog. Resolve the field and option IDs
# each time, because field edits reissue them.
item_id=$(gh project item-add 1 --owner pyrycode --url "$url" --format json --jq '.id')
project_id=$(gh project view 1 --owner pyrycode --format json --jq '.id')
field_json=$(gh project field-list 1 --owner pyrycode --format json)
status_field_id=$(echo "$field_json" | jq -r '.fields[] | select(.name == "Status") | .id')
backlog_option_id=$(echo "$field_json" | jq -r '.fields[] | select(.name == "Status") | .options[] | select(.name == "Backlog") | .id')
gh project item-edit --project-id "$project_id" --id "$item_id" \
  --field-id "$status_field_id" --single-select-option-id "$backlog_option_id"
```

Put the bug in Backlog so the refiner can pick it up without human promotion. Under Codex, use `issue-create`, `board-add` and `board-status ISSUE "Backlog"`. Use Inbox only when the ticket needs a specific decision or missing input from the operator, and comment with that need. An unknown technical cause is investigation work for Backlog. Commit the test with its skip reason and the bug link in its comment, then open your PR as usual. The ticket flows through verification normally.

If even the failing test cannot be written without the bug fix, which is rare, comment on your ticket with a one-line explanation and add `needs-rework:refiner`, so the refiner can sequence the bug as a blocker.

## Live records

A test that writes a capture does not commit it, and the gate's checkout is thrown away after the run. On 2026-08-25 #1763's live gate ran green and landed none of the three captures its criteria asked for. So a ticket that requires committed live records needs two passes through you.

**Before your first handoff,** add `needs-live-artifacts` to the issue. In the PR and your summary, list the exact capture paths, the coupled reader or schema changes, and the offline checks still needed. The probe must run under plain `make e2e-realclaude`, arm when its fixture is absent, keep durable deny-scanned records, and fail loudly when no usable capture exists. A file generated in a throwaway gate checkout does not satisfy a committed-fixture criterion. Then finish your stage as usual.

**When the ticket comes back.** After a passing live run, the dispatcher returns the ticket to you with `needs-rework:builder` and a comment giving the evidence log path. Recover only the exact usable records the gate identified. Commit each capture together with its matching reader or schema changes, run the relevant offline checks, and push to the same PR. Remove `needs-live-artifacts` only after those commits are pushed. Keep `needs-real-claude`, because the verifier and the live gate run again on the final change.

This is your own work and cannot be deferred again, and a recording cannot be made up. If the records are missing or unusable after the gate, that is a real blocker. Keep the diagnostics and say exactly what is missing.
