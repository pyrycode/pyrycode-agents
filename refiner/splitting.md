# Splitting tickets: Pyrycode refiner

Read this when the sizing guide in `refiner/CLAUDE.md` says to split, or when the builder has sent back a split proposal. A split is done when the children exist, each stands alone, they sit in Backlog in the right order with every real dependency set, outside tickets that waited on the parent now wait on the right child, and the parent is closed.

The commands below show what each step does with `gh`. Under Codex on the MacBook, use the shared practice's `pyrycode-pipeline-action` helper instead: `issue-create`, `board-add`, `board-status`, `board-after`, `add-child`, `add-blocker` and `relations` cover every step here except closing the parent.

## Split depth: stop at two

Check the parent chain before you split. A ticket that is already a grandchild is not split again.

```bash
gh api graphql -f query='query($owner:String!,$repo:String!,$num:Int!){repository(owner:$owner,name:$repo){issue(number:$num){number parent{number parent{number}}}}}' \
  -f owner="$(gh repo view --json owner --jq .owner.login)" \
  -f repo="$(gh repo view --json name --jq .name)" \
  -F num=<TICKET> \
  --jq '.data.repository.issue | "parent \(.parent.number // "none") grandparent \(.parent.parent.number // "none")"'
```

If `grandparent` is anything other than `none`, do not split. Add `needs-human:sizing`, comment with the split you would have made and why, then refine the ticket in place as one ticket. Do not stop and wait for a person. Once splitting is off the table the only outcomes are refining it now or refining it after an interruption, so the label marks the ticket for later review rather than asking a question.

This gate overrides the sizing table. It exists because every prose rule against recursive splitting failed, including a warning that described the exact pattern. On 2026-09-01 #1925 became #1937, then #1940, then #1943 and #1944: three levels in about seventy minutes, no code written, each child's body longer than its parent's. The #1714 family did the same on 2026-08-24, and writing it down did not prevent the repeat.

Depth is read from the sub-issue links, so always link each child to its parent as step 3 below does. Without the links this gate goes blind. Separately, check that the links you read are real parentage and not dependencies; the shared practice covers that.

## Steps

**1. Create one issue per concern.** Use `gh issue create`, with a body file outside the checkout.

**2. Put each child on the board in Backlog, right after the parent.** Children have already been triaged, so they go to Backlog, not Inbox. `gh project item-add 1 --owner pyrycode --url <issue-url>` adds the item but does not set its status, and an item without a status is invisible to every column query, so set Status to Backlog explicitly.

Children inherit the parent's priority. Place the first child immediately after the parent and each later child after the previous one, in dependency order. That yields `[..., parent, A, B, C, ..., others]`, and when the parent moves to Done the children hold its place. Never position the first child with `afterId: null`: that puts it at the top of Backlog, ahead of tickets the parent was correctly behind.

```bash
PROJECT_ID=$(gh project view 1 --owner pyrycode --format json --jq '.id')
# Each child's item ID comes from: gh project item-add 1 --owner pyrycode --url <url> --format json --jq '.id'
OWNER=$(gh repo view --json owner --jq .owner.login)
REPO=$(gh repo view --json name --jq .name)
PARENT_ITEM_ID=$(gh api graphql -f query='
  query($owner: String!, $repo: String!, $num: Int!) {
    repository(owner: $owner, name: $repo) {
      issue(number: $num) { projectItems(first: 5) { nodes { id } } }
    }
  }' -f owner="$OWNER" -f repo="$REPO" -F num=<PARENT_NUM> \
  --jq '.data.repository.issue.projectItems.nodes[0].id')

# First child after the parent, then each child after the previous one.
gh api graphql -f query='mutation($projectId: ID!, $itemId: ID!, $afterId: ID!) {
  updateProjectV2ItemPosition(input: { projectId: $projectId, itemId: $itemId, afterId: $afterId }) {
    items { totalCount }
  }
}' -f projectId="$PROJECT_ID" -f itemId="$A_ITEM_ID" -f afterId="$PARENT_ITEM_ID"
```

**3. Link each child to the parent** with the `addSubIssue` mutation, and end each child's body with `Split from #N`.

**4. Set dependencies between children.** When a later child needs something an earlier one adds, mark the later child blocked by the earlier one:

```bash
gh api graphql -f query='mutation($issueId: ID!, $blockingIssueId: ID!) {
  addBlockedBy(input: { issueId: $issueId, blockingIssueId: $blockingIssueId }) {
    issue { number }
  }
}' -f issueId="$(gh issue view <B> --json id -q '.id')" -f blockingIssueId="$(gh issue view <A> --json id -q '.id')"
```

The dispatcher will not build a ticket with an open blocker and unblocks it when the blocker closes. Board order alone does not keep A before B, because the dispatcher can run unrelated tickets in parallel when `PYRY_MAX_CONCURRENT` allows. Without the blocker, B's builder retries against A's missing API; pyrycode #41 burned about $4 that way.

Also chain siblings that write to the same spots even when neither needs the other. When two children follow the same precedent, for example both bodies say to follow one shipped ticket's shape or name the same insertion point in the same file, each builder adds its pieces in the same places. If the second is built before the first merges, it conflicts on every one of those lines. Since 2026-09-23 the builder resolves such conflicts, but each one costs a run and risks dropping the other side's change. Chain them with the same mutation, the later child in Backlog order blocked by the earlier. On pyrycode-mobile, #801 and #802, both split from #653 and both told to follow #596, collided in 16 places across six files on 2026-09-22. Merely touching the same large file is not the trigger; a shared precedent or insertion point is.

**5. Re-point outside tickets that waited on the parent.** When the parent closes it stops counting as an open blocker, so its dependents unblock even though what they need now lives in a child. Find them:

```bash
gh api graphql -f query='
  query($num: Int!) {
    repository(owner: "pyrycode", name: "pyrycode") {
      issue(number: $num) { blocking(first: 20) { nodes { number title state } } }
    }
  }' -F num=<parent>
```

For each open dependent, find the child that holds what it actually needs, usually named in the builder's split proposal. Mark the dependent blocked by that child with the step 4 mutation, and comment on it: "Re-pointed from #<parent> to #<child> as part of #<parent>'s split. Original blocker now lives in #<child>." Leave the old parent blocker in place. The dispatcher ignores closed blockers, so removing it changes nothing. Skipping this step sends the dependent to the builder against missing code, the same retry loop as step 4.

**6. Close the parent.** Set its board status to Done, then close it with a comment summarising the split. The dispatcher's closed-ticket sweep would eventually move it, but doing it now keeps the board accurate.

## Each child stands alone

Write each child's body as if the parent never existed: full scope, full criteria, links to the upstream design docs such as `docs/multi-session.md`. Do not refer to sections of the parent's plan; that plan is discarded once the split happens. Each child gets its own builder run that plans from its body alone. The only ties to the parent are the `Split from #N` line and the sub-issue link.

Refine only the ticket you were dispatched on. The children come back to your column on later dispatch cycles.
