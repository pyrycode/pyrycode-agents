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
